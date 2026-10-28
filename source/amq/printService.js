const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
// const receiptline = require('receiptline'); // Removed due to SVG issue
const ESCPOSBuilder = require('./ESCPOSBuilder');
const receiptImageGenerator = require('./receiptImageGenerator');
const ticketImages = require('./ticketImages');
const { renderTicketCanvas } = require('./ticketLayout');
const paymentTracker = require('./paymentOutcomes');
const { ensureScriptsExtracted } = require('../nativeAddonSetup');
const { getFormattedDateTime } = require('./receiptDateTime');
const logger = require("nets-service-sdk").logger(module);
// For pkg builds, __dirname is inside the read-only snapshot (C:\snapshot\...).
// We need the actual exe directory on disk for temp files.
const APP_DIR = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
// Send-RawPrint.ps1 is launched as a separate powershell.exe process, which
// (like canvas's DLLs and fonts) cannot read straight out of the pkg
// snapshot — ensureScriptsExtracted() guarantees a real on-disk copy.
const PS_SCRIPT_PATH = path.join(ensureScriptsExtracted(), 'Send-RawPrint.ps1');
const TEMP_DIR = path.join(APP_DIR, 'temp');

// Printed at the top of every ticket, when the printer/canvas stack is
// available — see ESCPOSBuilder.getLogoRaster() for the graceful-degradation
// story if this file is missing or canvas failed to load (logo is simply
// skipped, never a failed print job). A plain fs.readFileSync path is fine
// here even under pkg (unlike font registration/Send-RawPrint.ps1 above) —
// see that function's own comment for why.
const LOGO_PATH = path.join(__dirname, '..', 'public', 'assets', 'SSD-Full-Logo-Transparent.png');

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// WebSocket handler will be set after initialization
let wsHandler = null;

// Function to set WebSocket handler
function setWebSocketHandler(handler) {
    wsHandler = handler;
}

class PrintService {

    /**
     * Get list of all printers and their connections
     */
    async getPrinters() {
        const platform = process.platform;

        return new Promise((resolve, reject) => {
            if (platform === 'win32') {
                // Windows: Use PowerShell
                const command = 'powershell';
                const psCommand = 'Get-Printer | Select-Object Name, PortName, DriverName, Shared, ShareName | ConvertTo-Json';
                exec(`${command} -Command "${psCommand}"`, { maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
                    if (error) {
                        logger.error({
                            level: "error",
                            message: `Failed to list printers: ${error.message}`,
                        });
                        return reject(error);
                    }

                    try {
                        const printers = JSON.parse(stdout);
                        const result = Array.isArray(printers) ? printers : [printers];
                        resolve(result);
                    } catch (e) {
                        logger.error({
                            level: "error",
                            message: `Failed to parse printer list: ${e.message}`,
                        });
                        reject(e);
                    }
                });
            } else {
                // macOS/Linux: Use lpstat
                exec('lpstat -p -d', (error, stdout, stderr) => {
                    if (error) {
                        logger.error({
                            level: "error",
                            message: `Failed to list printers: ${error.message}`,
                        });
                        return reject(error);
                    }

                    try {
                        const printers = [];
                        const lines = stdout.split('\n');

                        for (const line of lines) {
                            if (line.startsWith('printer ')) {
                                const match = line.match(/^printer\s+(\S+)/);
                                if (match) {
                                    printers.push({
                                        Name: match[1],
                                        PortName: 'N/A',
                                        DriverName: 'N/A',
                                        Shared: false,
                                        ShareName: null
                                    });
                                }
                            }
                        }

                        resolve(printers);
                    } catch (e) {
                        logger.error({
                            level: "error",
                            message: `Failed to parse printer list: ${e.message}`,
                        });
                        reject(e);
                    }
                });
            }
        });
    }

    /**
     * Print buffer data
     */
    async printBuffer(buffer, printerName) {
        const timestamp = Date.now();
        const tempFilePath = path.join(TEMP_DIR, `printjob_${timestamp}.bin`);
        fs.writeFileSync(tempFilePath, buffer);
        const platform = process.platform;

        return new Promise((resolve, reject) => {
            if (platform === 'win32') {
                // Windows: Use PowerShell script
                const child = spawn('powershell', [
                    '-ExecutionPolicy', 'Bypass',
                    '-File', PS_SCRIPT_PATH,
                    printerName,
                    tempFilePath
                ]);

                let output = '';
                let errorOutput = '';

                child.stdout.on('data', (data) => {
                    output += data.toString();
                });

                child.stderr.on('data', (data) => {
                    errorOutput += data.toString();
                });

                child.on('close', (code) => {
                    // Cleanup temp file
                    try {
                        if (fs.existsSync(tempFilePath)) {
                            fs.unlinkSync(tempFilePath);
                        }
                    } catch (e) {
                        logger.warn({
                            level: "warn",
                            message: `Failed to delete temp file ${tempFilePath}: ${e.message}`,
                        });
                    }

                    if (code === 0) {
                        logger.log({
                            level: "info",
                            message: `Print job success: ${output.trim()}`,
                        });
                        resolve({ success: true, message: "Print job sent successfully" });
                    } else {
                        logger.error({
                            level: "error",
                            message: `Print job failed on printer ${printerName} (code ${code}): ${errorOutput}`,
                        });
                        reject(new Error(`Print job failed on printer ${printerName}: ${errorOutput || 'Unknown error'}`));
                    }
                });
            } else {
                // macOS/Linux: Use lp command
                const child = spawn('lp', ['-d', printerName, '-o', 'raw', tempFilePath]);

                let output = '';
                let errorOutput = '';

                child.stdout.on('data', (data) => {
                    output += data.toString();
                });

                child.stderr.on('data', (data) => {
                    errorOutput += data.toString();
                });

                child.on('close', (code) => {
                    // Cleanup temp file
                    try {
                        if (fs.existsSync(tempFilePath)) {
                            fs.unlinkSync(tempFilePath);
                        }
                    } catch (e) {
                        logger.warn({
                            level: "warn",
                            message: `Failed to delete temp file ${tempFilePath}: ${e.message}`,
                        });
                    }

                    if (code === 0) {
                        logger.log({
                            level: "info",
                            message: `Print job success: ${output.trim()}`,
                        });
                        resolve({ success: true, message: "Print job sent successfully" });
                    } else {
                        logger.error({
                            level: "error",
                            message: `Print job failed on printer ${printerName} (code ${code}): ${errorOutput}`,
                        });
                        reject(new Error(`Print job failed on printer ${printerName}: ${errorOutput || 'Unknown error'}`));
                    }
                });
            }
        });
    }

    /**
     * Refuse to print a card-payment (NETS/credit) receipt whose orderId
     * we know, from the terminal itself, was not approved. This is the
     * one place every print path (Socket.IO's terminal:receipt command,
     * POST /api/print-json, etc.) goes through, so none of them can print
     * a "paid" ticket for a payment the terminal actually declined —
     * previously this check lived only inside one caller (handleTerminalReceipt
     * in index.js), so any other route that reached printJSON() bypassed
     * it entirely.
     *
     * Reprints are exempt: a reprint reflects an order the BACKEND has
     * already confirmed paid (often hours/days after the original terminal
     * transaction, or after this service itself restarted, clearing its
     * in-memory outcome tracker) — this process has no way to attest to a
     * terminal transaction it never observed, so the live-approval check
     * only makes sense for a receipt printed right after its own terminal
     * transaction, not a reprint of an already-settled order.
     *
     * `context.skipApprovalCheck` is the same exemption for a DIFFERENT
     * reason: the Socket.IO terminal:print-ticket command (handlePrintTicket
     * in index.js) always resolves its ticket data from SSD-Backend's own
     * GET .../ticket-groups, which only ever succeeds for a booking the
     * backend has ALREADY confirmed fully paid — so there is nothing left
     * for this in-memory tracker to usefully attest to. It also can't: that
     * booking's paymentMethod may combine several installments collected
     * over several separate terminal charges (e.g. "CASH, NETS"), and/or the
     * `orderId` it carries is the booking's own stable reference, never the
     * fresh per-attempt reference beginPayment()/recordFinalOutcome() key
     * this tracker's `outcomes` map is actually indexed by (see
     * paymentOutcomes.js's own comment) — so a real terminal-confirmed NETS/
     * Credit Card payment could NEVER satisfy this check on that path, and
     * printing would be refused even though the money genuinely landed.
     * Deliberately a separate flag from `receipt.isReprint` above — unlike a
     * true reprint, this is a normal first print and must still go through
     * the duplicate-print tracker and print without a "REPRINT" banner.
     */
    assertPrintAllowed(receipt, context = {}) {
        if (!receipt) return;
        if (receipt.isReprint) return;
        if (context.skipApprovalCheck) return;
        const orderId = context.orderId || receipt.orderId;
        const paymentMethod = receipt?.payment?.method;
        paymentTracker.assertApprovedForPrint({ orderId, paymentMethod });
    }

    /**
     * Downloads and rasterises the picture of every item that has an `imageUrl` (non-enumerable
     * `_imageBuffer` / `_imageRaster` are hung off the item so the receipt stays JSON-safe). Any failure
     * just leaves that item without a picture - it never fails the ticket.
     */
    async prepareItemImages(receipts) {
        try {
            await ticketImages.attachImages(receipts);
            for (const r of receipts) {
                for (const item of (r && r.items) || []) {
                    if (!item || !item._imageBuffer) continue;
                    const raster = await ESCPOSBuilder.getImageRaster(item._imageBuffer);
                    if (raster) Object.defineProperty(item, '_imageRaster', { value: raster, enumerable: false, configurable: true });
                }
            }
        } catch (err) {
            logger.warn({ level: 'warn', message: `Ticket pictures skipped: ${err.message}` });
        }
    }

    /**
     * Print JSON data formatted with custom ESC/POS builder
     *
     * @param {object} context - Optional. { orderId } to correlate against
     *   the payment-outcome tracker when the receipt data itself doesn't
     *   carry its own orderId (e.g. the Socket.IO terminal:receipt path).
     */
    async printJSON(data, printerName, context = {}) {
        // Previously threw here when printerName was empty, before ever
        // reaching the debug-image generation below — meaning a booking
        // confirmed with no printer configured yet (exactly the situation
        // before real hardware arrives) never even got its ticket built, so
        // there was nothing to view in the images/ folder either. Now this
        // only skips the physical printBuffer() call further down; the
        // debug PNG still gets generated regardless.
        if (data && data.receipts && Array.isArray(data.receipts)) {
            data.receipts.forEach(r => this.assertPrintAllowed(r, context));
            // Download + dither any item pictures up front (the receipt builder below is synchronous).
            await this.prepareItemImages(data.receipts);
        } else if (data && data.receiptId && data.items) {
            this.assertPrintAllowed(data, context);
        }

        logger.log({
            level: `info`,
            message: `Generating receipt for printer: ${printerName}`,
        });

        const jobId = `print_${Date.now()}`;

        // Emit print started event
        if (wsHandler) {
            wsHandler.emitPrintStarted({
                jobId,
                printerName,
                timestamp: new Date().toISOString(),
            });
        }

        const builder = new ESCPOSBuilder();

        // Force the printer's character table to USA/ASCII on every job
        // instead of trusting whatever it's currently configured to — this
        // printer had drifted onto a table where byte 0x24 ("$") renders
        // as "¥". See ESCPOSBuilder.characterSet/codePage.
        builder.characterSet(0).codePage(0);

        // Resolved once (cached after the first successful decode — see
        // ESCPOSBuilder.getLogoRaster) and printed at the top of every
        // receipt below. null on any failure (missing file, canvas
        // unavailable) — buildReceipt() just skips it in that case.
        // Narrower than the full 512px print width (was printing edge-to-edge)
        // — builder.align('center') centers this smaller raster on the
        // physical line, matching receiptImageGenerator.js's own LOGO_WIDTH_RATIO.
        const logoRaster =
            (data.receipts && Array.isArray(data.receipts)) || (data.receiptId && data.items)
                ? await ESCPOSBuilder.getLogoRaster(LOGO_PATH, 360)
                : null;

        // Whole-ticket raster in the new Item/Qty/AMT layout (see ticketLayout.js),
        // rendered up front for the same reason as the logo: buildReceipt() is
        // synchronous. Absent (canvas unavailable) -> buildReceipt falls back to
        // the older text layout. Item pictures are drawn inside this render
        // (centered, only for items that downloaded one).
        const receiptList = data.receipts && Array.isArray(data.receipts)
            ? data.receipts
            : (data.receiptId && data.items ? [data] : []);
        const ticketRasters = new Map();
        for (const r of receiptList) {
            try {
                const canvas = await renderTicketCanvas(r);
                if (canvas) ticketRasters.set(r, ESCPOSBuilder.canvasToRaster(canvas));
            } catch (e) {
                logger.warn({ level: 'warn', message: `Ticket layout render failed, using text layout: ${e.message}` });
            }
        }

        if (typeof data === 'string') {
            // Raw text print
            builder.text(data).newline().feed(2).cut();
        } else if (data.content) {
            // Raw text in content
            builder.text(data.content).newline().feed(2).cut();
        } else if (data.receipts && Array.isArray(data.receipts)) {
            // Handle array of receipts
            data.receipts.forEach(r => this.buildReceipt(builder, r, logoRaster, ticketRasters.get(r)));
        } else if (data.receiptId && data.items) {
            // Handle single receipt object
            this.buildReceipt(builder, data, logoRaster, ticketRasters.get(data));
        } else {
            // Basic default formatter
            this.buildDefaultReceipt(builder, data);
        }

        const buffer = builder.getBuffer();

        // Generate full receipt image(s) for viewing/record-keeping —
        // deliberately NOT gated on the physical print below succeeding.
        // This used to run only after a successful printBuffer() call,
        // which meant a machine with no printer attached (or a printer
        // that's temporarily offline/misconfigured) had no way to see what
        // a ticket would have looked like — exactly the case for testing
        // this service before real hardware is on-site. Deferred via
        // setImmediate so it never delays the print attempt itself.
        // Written next to config.json (see IMAGES_DIR above) — check that
        // folder to view a ticket without a printer connected.
        setImmediate(() => {
            try {
                if (data.receipts && Array.isArray(data.receipts)) {
                    data.receipts.forEach(r => receiptImageGenerator.generate(r));
                } else if (data.receiptId && data.items) {
                    receiptImageGenerator.generate(data);
                }
            } catch (e) {
                logger.warn({
                    level: "warn",
                    message: `Failed to generate full receipt image: ${e.message}`,
                });
            }
        });

        if (!printerName) {
            logger.warn({
                level: "warn",
                message: `No printer configured — ticket rendered to the debug images folder only, physical printing skipped.`,
            });
            return { skipped: true, reason: "no-printer-configured" };
        }

        try {
            const result = await this.printBuffer(buffer, printerName);

            // Emit print completed event
            if (wsHandler) {
                wsHandler.emitPrintCompleted({
                    jobId,
                    printerName,
                    timestamp: new Date().toISOString(),
                });
            }

            return result;
        } catch (error) {
            // Emit print failed event
            if (wsHandler) {
                wsHandler.emitPrintFailed({
                    jobId,
                    printerName,
                    timestamp: new Date().toISOString(),
                }, error);
            }

            throw error;
        }
    }

    /**
     * Build receipt commands
     * @param {Buffer|null} [logoRaster] pre-rendered logo command from
     *   ESCPOSBuilder.getLogoRaster() (printJSON resolves this once, ahead
     *   of the synchronous per-receipt loop) — null if unavailable, in
     *   which case the ticket just prints without one.
     */
    buildReceipt(builder, receipt, logoRaster = null, ticketRaster = null) {
        // New layout: the whole ticket is one pre-rendered raster.
        if (ticketRaster) {
            builder.align('left').image(ticketRaster).feed(2).cut();
            return;
        }

        const lineWidth = 42;
        const divider = '-'.repeat(lineWidth);

        // =========================
        // LOGO (SSD)
        // =========================
        if (logoRaster) {
            builder.align('center').image(logoRaster).microFeed(10);
        }

        // =========================
        // REPRINT BANNER
        // =========================
        if (receipt.isReprint) {
            builder
                .align('center')
                .style('b')
                .text(receipt.reprintNumber ? `*** REPRINT #${receipt.reprintNumber} ***` : '*** REPRINT ***')
                .newline()
                .text(`Reprinted: ${getFormattedDateTime()}`)
                .style('normal')
                .align('left')
                .newline();
        }
        if (receipt.receiptId) {
            builder
                .align('left')
                .text(`Receipt No : ${receipt.receiptId}`)
                .newline()
                .style('normal')
                ;
        }
        if (receipt.gstNumber) {
            builder
                .align('left')
                .text(`GST no.: ${receipt.gstNumber}`)
                .newline()
                .style('normal')
                ;
        }
        if (receipt.date) {
            builder
                .align('left')
                .text(`Date: ${receipt.date}`)
                .newline();
        }
        // No temple name (Tamil/English) here on purpose — the logo printed
        // at the top of the ticket already identifies the temple, so a
        // repeated name block right underneath it was redundant.

        // builder.newline();
        // Tighter line spacing just for this gap so it doesn't look oversized
        // ahead of the category Tamil name image, then restore the default.
        builder.lineSpacing(16).text(divider).newline().defaultLineSpacing();

        // No ticket-level heading (SSD Print Group / Deity name) here on
        // purpose — each item below now shows its own deity name directly,
        // so a shared heading above them would just repeat it (and, on a
        // Print-Group-Wise ticket combining several deities, would have
        // been actively wrong to show only one of them).

        // =========================
        // SINGLE ITEM CATEGORY
        // =========================
        if (receipt.items && receipt.items.length === 1) {
            const singleItem = receipt.items[0];
            if (singleItem.categoryTamilName && singleItem.categoryTamilName.trim() && singleItem.categoryTamilName !== 'null') {
                builder
                    .textImage(singleItem.categoryTamilName, { align: 'center', bold: true, fontSize: 30 })
                    .microFeed(10);
            }
            if (singleItem.category) {
                builder
                    .align('center')
                    .style('b')
                    .text(singleItem.category)
                    .style('normal')
                    .newline();
            }

        }

        // =========================
        // ITEMS
        // =========================
        if (receipt.items && Array.isArray(receipt.items)) {
            receipt.items.forEach(item => {
                builder.align('center');

                // Tamil Name only (Centered TextImage) — no English name line.
                if (item.tamilName && item.tamilName.trim() && item.tamilName !== 'null') {
                    builder.textImage(item.tamilName, { align: 'center', bold: true, fontSize: 24 }).microFeed(14);
                }

                // Small extra feed between the item/service block above and
                // the deity block below — otherwise the deity's Tamil name
                // printed flush against the item's Tamil name, with no
                // visual break between "what" and "for which deity".
                if (item.deityTamilName) {
                    builder.microFeed(8);
                }

                // Deity name (SSD) — Tamil only, same reasoning as the item
                // name above — shown as a sub-heading directly under the
                // item so a multi-item Print-Group-Wise ticket still reads
                // which line belongs to which deity, without a separate
                // ticket-level heading repeating just one of them.
                if (item.deityTamilName && item.deityTamilName.trim() && item.deityTamilName !== 'null') {
                    builder.textImage(item.deityTamilName, { align: 'center', bold: true, fontSize: 20 }).microFeed(10);
                }

                // Picture of the item/service/general item/event, directly under its name and deity.
                // Only present when SSD-Backend sent an imageUrl for this line and it downloaded (see
                // amq/ticketImages.js + ESCPOSBuilder.getImageRaster); otherwise this is skipped and the
                // ticket looks exactly as it did before pictures existed.
                if (item._imageRaster) {
                    builder.align('center').microFeed(8).image(item._imageRaster).microFeed(10);
                }

                // qty: {quantity} — textImage same fontSize as category Tamil name (30).
                // No per-item $ amount any more — the ticket-level Total
                // below now always prints, so a repeated amount here was
                // redundant.
                builder.textImage(`Qty: ${item.quantity || ''}`, { align: 'center', bold: true, fontSize: 30 });

                // Devotee details for THIS item/deity — HEB's own
                // item.familMemberDetails shape ({name, star}), or SSD's
                // item.devotees shape ({name, nakshatra}) from
                // ssdTicketBuilder.js; a given payload only ever populates
                // one of the two. Shown nested under the item/deity they
                // belong to (previously SSD printed all of a ticket's
                // devotees in one flat list at the bottom, with no way to
                // tell which devotee went with which item).
                const devoteeList = (item.familMemberDetails && item.familMemberDetails.length > 0)
                    ? item.familMemberDetails.map((d) => ({ name: d.name, star: d.star }))
                    : (item.devotees || []).map((d) => ({ name: d.name, star: d.nakshatra }));

                if (devoteeList.length > 0) {
                    const subDivider = '-'.repeat(42);
                    builder.text(subDivider).newline();

                    builder
                        .style('b')
                        .textImage('பெயர் - நட்சத்திரம்', { align: 'left', bold: true, fontSize: 18 })
                        .style('normal');
                    builder.text(divider).newline();

                    // Sized to match the "Name - Star" header text above
                    // (was 28-32, noticeably larger than the plain-text
                    // header) — was 30/32/28.
                    const DEVOTEE_FONT_SIZE = 20;
                    // Matches textImage()'s own default receiptWidth (512)
                    // minus its 8px padding, so "fits on one line" here means
                    // the exact same thing it would inside textImage() itself.
                    const DEVOTEE_MAX_WIDTH = 512 - 8;
                    devoteeList.forEach((d) => {
                        const name = (d.name || '').trim();
                        const star = (d.star || '').trim();
                        if (!name && !star) return;

                        if (name && star) {
                            const separator = ` - ${star}`;
                            const combinedWidth = ESCPOSBuilder.measureTextWidth(`${name}${separator}`, { fontSize: DEVOTEE_FONT_SIZE, bold: true });
                            if (combinedWidth <= DEVOTEE_MAX_WIDTH) {
                                // Bold name, normal-weight " - star" — only
                                // the name is bold, not the whole line.
                                builder.textImageTwoTone(name, separator, { align: 'left', fontSize: DEVOTEE_FONT_SIZE });
                                return;
                            }
                            // Doesn't fit together — name gets its own full
                            // line, star its own line below, same as before
                            // this change (rather than letting textImage()'s
                            // space-only word-wrap split mid-name).
                            builder.textImage(name, { align: 'left', fontSize: DEVOTEE_FONT_SIZE, bold: true });
                            builder.textImage(star, { align: 'left', fontSize: DEVOTEE_FONT_SIZE });
                        } else {
                            builder.textImage(name || star, { align: 'left', fontSize: DEVOTEE_FONT_SIZE, bold: true });
                        }
                    });
                }

                // Tight double divider under this deity's block — separates
                // each deity-wise section from the next one (or from the
                // Total below, on the last item).
                builder.text(divider).newline();
                builder.microFeed(8);
                builder.text(divider).newline();
            });
        }

        // =========================
        // TICKET TOTAL (SSD)
        // =========================
        // Always shown now — items no longer print their own $ amount (see
        // the ITEMS block above), so this is the only place the ticket's
        // amount appears at all, not just on multi-item tickets. receipt.total
        // comes from ticket-grouping.js's own per-line sum (ssdTicketBuilder.js),
        // not re-summed here, so it can never disagree with the lines above it.
        if (typeof receipt.total === 'number') {
            builder
                .align('center')
                .style('b')
                .text(`Total: $${receipt.total.toFixed(2)} (GST Inc.)`)
                .style('normal')
                .newline();
        }

        builder.text(divider).newline();

        // =========================
        // TOTAL
        // =========================
        // if (receipt.summary) {
        //     builder
        //         .align('right')
        //         .style('b')
        //         .text(`GRAND TOTAL: $${receipt.summary.grandTotal || '0.00'}`)
        //         .style('normal')
        //         .newline();
        // }

        // builder.text(divider).newline();

        // =========================
        // PAYMENT METHOD
        // =========================
        if (receipt.payment) {
            builder
                .align('center')
                .text(`Payment: ${receipt.payment.method || ''}`)
                .newline();
        }

        builder.feed(2).cut();
    }

    // Helper to format unstructured JSON
    buildDefaultReceipt(builder, data) {
        builder.align('center').text('Receipt').newline().text('----------------').newline();
        builder.align('left');
        for (const [key, value] of Object.entries(data)) {
            if (typeof value !== 'object') {
                builder.text(`${key}: ${value}`).newline();
            }
        }
        builder.text('----------------').newline().feed(2).cut();
    }
}

module.exports = new PrintService();
module.exports.setWebSocketHandler = setWebSocketHandler;
