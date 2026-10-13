const logger = require("nets-service-sdk").logger(module);

/**
 * Tracks the *actual* outcome of card payments reported by the NETS/credit
 * terminal, keyed by orderId. This is the single source of truth every
 * print path must consult before printing a "paid" receipt — independent of
 * whatever the frontend believes happened.
 *
 * Previously this lived inline in index.js and was only wired to one of
 * several ways a payment could be started or a receipt printed, so a
 * terminal decline could still result in a "paid" ticket via the other
 * paths. This module is the one shared instance every entry point
 * (Socket.IO commands, HTTP routes, AMQ messages) now goes through.
 *
 * Kiosk has a single physical terminal, so only one payment is ever
 * realistically in flight. The NETS SDK's PAYMENT_MESSAGE event does not
 * carry an orderId, so results are correlated against pendingOrderId — the
 * most recently *started* payment that hasn't resolved yet. beginPayment()
 * refuses to start a new payment while a previous one is still genuinely
 * in flight, since that's the only way to keep this correlation valid.
 */

const outcomes = new Map(); // orderId -> { status, timestamp, response }
let pendingOrderId = null;

const OUTCOME_RETENTION_MS = 15 * 60 * 1000; // 15 minutes
const PENDING_LOCK_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes — a payment stuck longer than this is treated as abandoned

function prune() {
  const now = Date.now();
  for (const [orderId, outcome] of outcomes) {
    if (now - outcome.timestamp > OUTCOME_RETENTION_MS) {
      outcomes.delete(orderId);
    }
  }
}

// Some terminal responses carry hostResponseCode "00" (normally APPROVED)
// even when the transaction did NOT actually take payment — observed twice
// in production logs as responsetext "F0058-POS is not activ[e]" on credit
// card (Visa) transactions, alongside an all-zero approvalCode ("000000")
// and retrievalReferenceNumber ("000000000000") — neither of which look
// like a real bank authorization. The SDK still reports status: "SUCCESS"
// for these, so trusting that blindly means confirming a customer's
// booking for a payment that never went through. This is a genuine
// terminal/merchant-account configuration issue (the credit facility isn't
// properly activated with the bank) that also needs escalating to
// NETS/the acquirer directly — this check only stops us from acting on a
// false "SUCCESS", it doesn't make the underlying payment actually work.
const SUSPICIOUS_RESPONSETEXT_PATTERNS = [/not\s*activ/i, /not\s*permit/i, /inactive/i, /invalid/i, /declined/i, /\berror\b/i, /\bfail/i];

// Blacklisting known-bad responsetext wording only catches decline reasons
// we've already seen misreported as "SUCCESS". A different decline reason
// (e.g. insufficient funds) could theoretically get misreported the same
// way with wording that doesn't match any pattern above. Rather than try to
// enumerate every possible bad phrase, also require POSITIVE proof of a
// real approval: a genuine bank authorization always carries a real
// (non-all-zero) approvalCode / retrievalReferenceNumber. The one false
// "SUCCESS" seen in production had approvalCode "000000" and
// retrievalReferenceNumber "000000000000" — obvious placeholders, not a
// real authorization. Fails closed: missing or all-zero is treated as NOT
// approved, same as a matched suspicious phrase.
function isAllZerosOrMissing(value) {
  const str = String(value ?? "").trim();
  return str === "" || /^0+$/.test(str);
}

function isGenuinelyApproved(data) {
  if (data.status !== "SUCCESS") return false;

  const translated = data.response?.translated || {};
  const responsetext = translated.responsetext || "";
  if (SUSPICIOUS_RESPONSETEXT_PATTERNS.some((re) => re.test(responsetext))) {
    return false;
  }

  if (isAllZerosOrMissing(translated.approvalCode)) {
    return false;
  }

  if (translated.retrievalReferenceNumber !== undefined && isAllZerosOrMissing(translated.retrievalReferenceNumber)) {
    return false;
  }

  return true;
}

/**
 * Call when a payment is about to be sent to the physical terminal, from
 * ANY trigger path (Socket.IO command, HTTP route, or AMQ message).
 * Throws if a previous payment for a different order is still genuinely
 * awaiting a terminal result — starting a second one now would make the
 * next PAYMENT_MESSAGE impossible to attribute correctly, since the SDK
 * event carries no orderId of its own.
 */
function beginPayment(orderId) {
  if (!orderId) return;
  prune();

  if (pendingOrderId && pendingOrderId !== orderId) {
    const stale = outcomes.get(pendingOrderId);
    const stillWaiting = stale && stale.status === "PENDING";

    if (stillWaiting) {
      const age = Date.now() - stale.timestamp;
      if (age < PENDING_LOCK_TIMEOUT_MS) {
        throw new Error(
          `Cannot start payment for order ${orderId}: order ${pendingOrderId} is still awaiting a terminal result (${Math.round(age / 1000)}s). ` +
          `Starting a second payment now would make it impossible to tell which order the terminal's next response belongs to.`
        );
      }

      // Previous payment never resolved and has been pending long enough
      // to be considered abandoned — record that explicitly (a status that
      // is never "SUCCESS") instead of leaving it ambiguous, then let the
      // new payment proceed.
      logger.warn({
        level: "warn",
        message: `⏱️ Payment for order ${pendingOrderId} timed out waiting for a terminal result (>${PENDING_LOCK_TIMEOUT_MS / 1000}s) — marking as ABANDONED so it can never be printed as paid.`,
      });
      outcomes.set(pendingOrderId, { status: "ABANDONED", timestamp: Date.now(), response: null });
    }
  }

  pendingOrderId = orderId;
  outcomes.set(orderId, { status: "PENDING", timestamp: Date.now(), response: null });
}

/**
 * Call when the SDK reports a final PAYMENT_MESSAGE (SUCCESS / CANCELLED /
 * FAILED). Attributes it to whichever order is currently pending.
 *
 * Returns { orderId, genuinelyApproved, resolvedStatus } so the caller (the
 * global.io.emit interception in index.js) can correct the outgoing message
 * before it reaches any frontend — see that call site for why this matters:
 * printing being refused locally doesn't stop the raw, misleading "SUCCESS"
 * from still being broadcast to every connected browser client.
 */
function recordFinalOutcome(data) {
  if (!pendingOrderId || !data || !data.status) return null;

  const FINAL_STATUSES = ["SUCCESS", "CANCELLED", "FAILED", "RETRY", "TERMINAL_ERROR", "TIME_OUT"];
  const isFinal = FINAL_STATUSES.includes(data.status);
  if (!isFinal) return null;

  const genuinelyApproved = isGenuinelyApproved(data);

  if (data.status === "SUCCESS" && !genuinelyApproved) {
    const translated = data.response?.translated || {};
    logger.error({
      level: "error",
      message: `🚨 Terminal reported SUCCESS for order ${pendingOrderId} but it doesn't look like a real approval ` +
        `(responsetext: "${translated.responsetext}", approvalCode: "${translated.approvalCode}", retrievalReferenceNumber: "${translated.retrievalReferenceNumber}") ` +
        `— treating as NOT approved and will refuse to print a paid receipt. This needs escalation to NETS/the bank (the terminal's credit facility may not be activated).`,
    });
  }

  if (data.status === "RETRY" || data.status === "TERMINAL_ERROR" || data.status === "TIME_OUT") {
    logger.warn({
      level: "warn",
      message: `⚠️ Terminal reported ${data.status} for order ${pendingOrderId} — recording as a resolved non-approved outcome so the order can no longer be printed as paid.`,
    });
  }

  const resolvedStatus = genuinelyApproved
    ? "SUCCESS"
    : data.status === "SUCCESS"
      ? "SUSPICIOUS_APPROVAL"
      : data.status;

  const resolvedOrderId = pendingOrderId;

  outcomes.set(pendingOrderId, {
    status: resolvedStatus,
    timestamp: Date.now(),
    response: data.response || null,
  });
  pendingOrderId = null;

  return { orderId: resolvedOrderId, genuinelyApproved, resolvedStatus };
}

function getOutcome(orderId) {
  return outcomes.get(orderId);
}

function isCardPaymentMethod(method) {
  const m = String(method || "").toUpperCase();
  return /NETS|CREDIT|CARD|VISA|MASTERCARD|MASTER|AMEX|DEBIT|JCB|UNIONPAY|PAYWAVE|PAYPASS/.test(m);
}

/**
 * The single choke point every print path must call before handing a
 * card-payment receipt to the physical printer. Fails CLOSED: if we can't
 * prove the terminal approved this order, printing is refused rather than
 * allowed by default (previously, a missing/unrecorded outcome fell
 * through and let the print proceed).
 */
function assertApprovedForPrint({ orderId, paymentMethod }) {
  const outcome = orderId ? outcomes.get(orderId) : null;
  // Trust an explicitly-known payment method over the tracked outcome: a
  // leftover record from an earlier, different payment attempt on the same
  // orderId (e.g. a cancelled NETS try before the customer paid via PayNow
  // instead) must not make this check misfire for the unrelated method that
  // actually succeeded. Only fall back to "does any outcome exist" when the
  // method genuinely isn't known at all, same as before.
  const isCardPayment = paymentMethod
    ? isCardPaymentMethod(paymentMethod)
    : Boolean(outcome);

  if (!isCardPayment) return; // cash/other: no terminal correlation exists or is needed

  if (!orderId) {
    throw new Error(
      `Refusing to print a ${paymentMethod || 'card'} receipt with no orderId — cannot verify the terminal actually approved this payment.`
    );
  }

  if (!outcome || outcome.status !== "SUCCESS") {
    throw new Error(
      `Refusing to print receipt for order ${orderId}: terminal payment was not confirmed approved (status: ${outcome ? outcome.status : "UNKNOWN — no result recorded for this order"}).`
    );
  }
}

module.exports = {
  beginPayment,
  recordFinalOutcome,
  getOutcome,
  isCardPaymentMethod,
  assertApprovedForPrint,
};
