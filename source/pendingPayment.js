/**
 * Durable, on-disk marker for "a payment was just sent to the terminal and
 * we're still waiting on its result." Written just before the request goes
 * to the terminal and cleared the moment a final result is recorded.
 *
 * Exists because paymentOutcomes.js's own tracking (pendingOrderId) lives
 * only in memory — if the service process dies for any reason (crash,
 * force-kill, native module fault) while a payment is genuinely in flight,
 * that in-memory state is gone on restart even though the terminal itself
 * may have gone on to approve the payment moments later. The terminal's own
 * result then arrives at a process with no idea it was ever waiting for
 * one, and the confirmation is lost even though the customer was charged.
 *
 * This marker lets a freshly (re)started process notice "the last thing I
 * did before I came up was start a payment I never saw the result of," and
 * ask the terminal directly what actually happened via its recovery
 * function — recovering the confirmation regardless of why the process
 * restarted, without needing to know or fix that underlying cause.
 */
const fs = require('fs');
const path = require('path');
const configUtil = require('./configPath');

const MARKER_FILENAME = 'pending-payment.json';

// The auto-restart supervisor in electron/main.js brings a crashed service
// back up within seconds, so a genuinely recoverable marker is always very
// fresh. A marker older than this is far more likely to be from a normal,
// deliberate shutdown (a config change, a manual close) than an actual
// crash — and recovering against a stale marker is actively risky: the
// terminal only remembers its OWN last transaction, so if any other
// payment has gone through since, recovery would misattribute that
// unrelated transaction's result to this stale order instead.
const MAX_RECOVERABLE_AGE_MS = 5 * 60 * 1000;

function getMarkerPath() {
  return path.join(configUtil.getConfigDir(), MARKER_FILENAME);
}

/**
 * Call right before a payment request is sent to the terminal.
 */
function beginTracking(orderId, cloudUrl) {
  if (!orderId) return;
  try {
    fs.writeFileSync(
      getMarkerPath(),
      JSON.stringify({ orderId, cloudUrl: cloudUrl || null, startedAt: Date.now() }),
      'utf8',
    );
  } catch (err) {
    // Best-effort: if this can't be persisted, recovery simply won't be
    // possible for this one payment — no worse off than before this
    // feature existed.
  }
}

/**
 * Call once a payment's final result (success, decline, cancel — anything
 * conclusive) has been recorded, including a recovered one.
 */
function clear() {
  try {
    fs.unlinkSync(getMarkerPath());
  } catch (err) {
    // Already gone, or never existed — fine either way.
  }
}

/**
 * Call once at startup. Returns { orderId, cloudUrl } if there's a fresh
 * enough marker worth recovering, otherwise null (and clears out anything
 * too old to safely trust).
 */
function getRecoverable() {
  let raw;
  try {
    raw = fs.readFileSync(getMarkerPath(), 'utf8');
  } catch (err) {
    return null;
  }

  let marker;
  try {
    marker = JSON.parse(raw);
  } catch (err) {
    clear();
    return null;
  }

  if (!marker || !marker.orderId || !marker.startedAt) {
    clear();
    return null;
  }

  if (Date.now() - marker.startedAt > MAX_RECOVERABLE_AGE_MS) {
    clear();
    return null;
  }

  return marker;
}

module.exports = {
  beginTracking,
  clear,
  getRecoverable,
};
