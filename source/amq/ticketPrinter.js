// Orchestrates printing a booking's resolved ticket groups: duplicate-print
// protection, then handing the mapped receipts[] (ssdTicketBuilder.js) to
// the existing printService.printJSON pipeline (ESC/POS + physical print,
// unchanged). Kept separate from ssdTicketBuilder.js's pure mapping so the
// I/O (disk-persisted dedupe state, the actual print call) lives in exactly
// one place, easy to reason about independently of the mapping logic.
//
// Duplicate-print protection: keyed on (receiptNo, ticket identity), NOT on
// the whole booking — an API retry / duplicate backend callback / EXE
// restart mid-flow must not reprint tickets already sent to the printer,
// but a genuinely NEW ticket for the same receipt (there shouldn't be one,
// but fail safe rather than silently skip) still prints. `transactions.db`
// (the sqlite file at the project root) is NOT used for this — confirmed
// unreferenced by any code under source/ — a small JSON file next to the
// existing kiosk.netConfig (same directory configPath.js already resolves
// and treats as durable, writable storage) is simpler and sufficient here.

const fs = require('fs');
const path = require('path');
const configPath = require('../configPath');
const printService = require('./printService');
const { buildReceiptsFromTicketGroups } = require('./ssdTicketBuilder');
const logger = require("nets-service-sdk").logger(module);

const TRACKER_FILENAME = 'printed-tickets.json';
const PENDING_FILENAME = 'pending-prints.json';
const MAX_TRACKED_ENTRIES = 5000; // oldest entries drop off first — this only needs to catch near-term retries, not be a permanent audit log

function getTrackerPath() {
    return path.join(configPath.getConfigDir(), TRACKER_FILENAME);
}

function loadPrintedKeys() {
    try {
        const raw = fs.readFileSync(getTrackerPath(), 'utf8');
        const arr = JSON.parse(raw);
        return new Set(Array.isArray(arr) ? arr : []);
    } catch (e) {
        return new Set(); // missing/corrupt file — not fatal, just means nothing is known-printed yet
    }
}

function savePrintedKeys(keys) {
    try {
        const arr = Array.from(keys);
        const trimmed = arr.length > MAX_TRACKED_ENTRIES ? arr.slice(arr.length - MAX_TRACKED_ENTRIES) : arr;
        fs.writeFileSync(getTrackerPath(), JSON.stringify(trimmed), 'utf8');
    } catch (e) {
        logger.warn({ level: 'warn', message: `Failed to persist printed-ticket tracker: ${e.message}` });
    }
}

// Tickets confirmed (payment verified, booking already paid for on
// SSD-Backend) while no printer was configured yet — e.g. before real
// hardware arrives — land here instead of being silently dropped or
// wrongly marked "printed". drainPendingPrints() below sends them to the
// printer as soon as one is actually set up, without anyone having to
// manually reprint each booking.
function getPendingPath() {
    return path.join(configPath.getConfigDir(), PENDING_FILENAME);
}

function loadPending() {
    try {
        const raw = fs.readFileSync(getPendingPath(), 'utf8');
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch (e) {
        return [];
    }
}

function savePending(list) {
    try {
        fs.writeFileSync(getPendingPath(), JSON.stringify(list), 'utf8');
    } catch (e) {
        logger.warn({ level: 'warn', message: `Failed to persist pending-print queue: ${e.message}` });
    }
}

function ticketKey(receiptNo, group, index) {
    const groupKey = group.deityId || group.printGroupId || `idx${index}`;
    return `${receiptNo}::${groupKey}`;
}

/**
 * Prints every ticket group for a booking, once each. A repeat call for a
 * (receiptNo, ticket) pair already printed is a no-op unless
 * `options.isReprint` is set (mirrors printService.js's existing
 * `isReprint` field/REPRINT BANNER — a deliberate reprint always proceeds
 * and is never recorded into the dedupe tracker, so it never blocks a
 * LATER genuine reprint either).
 *
 * @param {object} ticketData  { ticketGroups, receipt, temple, customer, splitMode }
 * @param {string} printerName
 * @param {{ isReprint?: boolean, reprintNumber?: number, paymentMethod?: string, gstNumber?: string, orderId?: string, skipApprovalCheck?: boolean }} [options]
 * @returns {Promise<{ printedCount: number, skippedCount: number, totalCount: number }>}
 */
async function printTicketGroups(ticketData, printerName, options = {}) {
    const { ticketGroups, receipt } = ticketData || {};
    if (!Array.isArray(ticketGroups) || ticketGroups.length === 0) {
        throw new Error('Cannot print — no ticket groups were resolved for this booking.');
    }
    const receiptNo = receipt?.receiptNo || receipt?.bookingNumber;
    if (!receiptNo) {
        throw new Error('Cannot print — no receipt/booking number to key duplicate-print protection on.');
    }

    const printedKeys = options.isReprint ? new Set() : loadPrintedKeys();
    // Always loaded from disk, even for an explicit reprint — this is
    // appended to (never replaces the file wholesale) if the reprint itself
    // ends up skipped for lack of a printer, so an unrelated ticket some
    // earlier booking already queued is never silently discarded.
    const pendingQueue = loadPending();
    const queuedKeys = options.isReprint ? new Set() : new Set(pendingQueue.map((entry) => entry.key));
    const pending = [];
    ticketGroups.forEach((group, index) => {
        const key = ticketKey(receiptNo, group, index);
        if (!options.isReprint && printedKeys.has(key)) {
            logger.log({ level: 'info', message: `Print group generated: skipping ticket ${key} — already printed for this receipt.` });
            return;
        }
        if (!options.isReprint && queuedKeys.has(key)) {
            logger.log({ level: 'info', message: `Print group generated: ticket ${key} is already queued, waiting for a printer to be configured.` });
            return;
        }
        pending.push({ group, key });
    });

    const totalCount = ticketGroups.length;
    if (pending.length === 0) {
        logger.log({ level: 'info', message: `Print job skipped entirely for receipt ${receiptNo} — all ${totalCount} ticket(s) already printed.` });
        return { printedCount: 0, skippedCount: totalCount, totalCount };
    }

    const receiptsPayload = buildReceiptsFromTicketGroups(
        { ...ticketData, ticketGroups: pending.map((p) => p.group) },
        options
    );

    logger.log({
        level: 'info',
        message: `Print job created: ${receiptsPayload.length}/${totalCount} ticket(s) for receipt ${receiptNo} (split mode: ${ticketData.splitMode || 'unknown'}).`,
    });
    receiptsPayload.forEach((_, i) => {
        logger.log({ level: 'info', message: `Printing ticket ${i + 1}/${receiptsPayload.length} for receipt ${receiptNo}.` });
    });

    let result;
    try {
        result = await printService.printJSON({ receipts: receiptsPayload }, printerName, {
            orderId: options.orderId,
            skipApprovalCheck: options.skipApprovalCheck,
        });
    } catch (err) {
        logger.error({ level: 'error', message: `Print failed for receipt ${receiptNo}: ${err.message}` });
        throw err;
    }

    if (result && result.skipped) {
        // No printer configured — the payment is already fully verified
        // (this function is only ever reached after that), so queue the
        // rendered ticket for drainPendingPrints() to send once a printer
        // is set up, rather than marking it "printed" when nothing was
        // physically sent anywhere.
        const queuedAt = new Date().toISOString();
        pending.forEach(({ key }, i) => {
            pendingQueue.push({
                key,
                receiptNo,
                orderId: options.orderId,
                queuedAt,
                // isReprint forced true: bypasses paymentTracker's in-memory
                // approval check (assertPrintAllowed) on the later drain —
                // that check exists to stop printing unverified terminal
                // responses, but a queued entry only ever gets here via an
                // already backend-confirmed payment, and the in-memory
                // record it would otherwise need doesn't survive a service
                // restart (see paymentOutcomes.js's OUTCOME_RETENTION_MS).
                receiptPayload: { ...receiptsPayload[i], isReprint: true },
            });
        });
        savePending(pendingQueue);
        logger.log({
            level: 'info',
            message: `Print job queued (no printer configured): ${receiptsPayload.length}/${totalCount} ticket(s) for receipt ${receiptNo} — will print automatically once a printer is set up on the Configuration page.`,
        });
        return { printedCount: 0, queuedCount: receiptsPayload.length, skippedCount: totalCount - pending.length, totalCount };
    }

    if (!options.isReprint) {
        pending.forEach(({ key }) => printedKeys.add(key));
        savePrintedKeys(printedKeys);
    }

    logger.log({ level: 'info', message: `Print successful: ${receiptsPayload.length}/${totalCount} ticket(s) for receipt ${receiptNo}.` });

    return { printedCount: receiptsPayload.length, skippedCount: totalCount - pending.length, totalCount };
}

/**
 * Prints every ticket queued earlier by printTicketGroups() because no
 * printer was configured yet. Called right after a printer is saved on the
 * Configuration page (POST /api/config/printer in index.js) and once at
 * startup in case entries were left over from before a restart. An entry
 * that still fails (printer plugged in but off/out of paper/wrong name)
 * stays queued for the next attempt rather than being dropped.
 *
 * @param {string} printerName
 * @returns {Promise<{ printedCount: number, remainingCount: number }>}
 */
async function drainPendingPrints(printerName) {
    if (!printerName) return { printedCount: 0, remainingCount: 0 };

    const pendingQueue = loadPending();
    if (pendingQueue.length === 0) return { printedCount: 0, remainingCount: 0 };

    logger.log({
        level: 'info',
        message: `Draining pending-print queue: ${pendingQueue.length} ticket(s) waiting, printer now set to ${printerName}.`,
    });

    const printedKeys = loadPrintedKeys();
    const stillPending = [];
    let printedCount = 0;

    for (const entry of pendingQueue) {
        try {
            const result = await printService.printJSON({ receipts: [entry.receiptPayload] }, printerName, { orderId: entry.orderId });
            if (result && result.skipped) {
                // Still no printer name reaching printService (shouldn't
                // happen given the guard above, but fail safe) — keep queued.
                stillPending.push(entry);
                continue;
            }
            printedKeys.add(entry.key);
            printedCount += 1;
            logger.log({ level: 'info', message: `Queued ticket printed: ${entry.key} (receipt ${entry.receiptNo}).` });
        } catch (err) {
            logger.error({ level: 'error', message: `Failed to print queued ticket ${entry.key}: ${err.message} — will retry on the next drain.` });
            stillPending.push(entry);
        }
    }

    savePending(stillPending);
    if (printedCount > 0) savePrintedKeys(printedKeys);

    logger.log({
        level: 'info',
        message: `Pending-print queue drained: ${printedCount} printed, ${stillPending.length} still waiting.`,
    });

    return { printedCount, remainingCount: stillPending.length };
}

module.exports = { printTicketGroups, drainPendingPrints };
