const path = require('path');
const fs = require('fs');
const { ensureFontconfigConfigured } = require('../fontSetup');
const { ensureCanvasAddonsExtracted, ensureFontsExtracted } = require('../nativeAddonSetup');
const { getFormattedDateTime } = require('./receiptDateTime');

// Must run before requiring 'canvas' so its DLL dependencies and
// Fontconfig/Pango config are in place on first init (see
// nativeAddonSetup.js and fontSetup.js).
ensureCanvasAddonsExtracted();
ensureFontconfigConfigured();
let createCanvas, registerFont, loadImage;
let canvasLoadError = null;
try {
    ({ createCanvas, registerFont, loadImage } = require('canvas'));
} catch (e) {
    // Same reasoning as amq/ESCPOSBuilder.js: this must not crash the
    // process at require() time — printService.js requires this module
    // unconditionally at startup. Record-keeping receipt images are
    // best-effort; actual printing must keep working regardless.
    canvasLoadError = e;
    console.error(`[receiptImageGenerator] canvas failed to load: ${e.message}`);
}

/**
 * ReceiptImageGenerator:
 * Takes a receipt object and renders it into a single PNG image.
 */

const APP_DIR = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
const IMAGES_DIR = path.join(APP_DIR, 'images');

// Unlike ESCPOSBuilder.js's own IMAGES_DIR (same path, separate constant),
// nothing else ever created this folder — on a fresh install writeFileSync()
// below threw ENOENT every time, which printService.js's caller silently
// swallows as a logged warning, so no debug PNG ever appeared and there was
// no visible error pointing at why.
if (!fs.existsSync(IMAGES_DIR)) {
    try {
        fs.mkdirSync(IMAGES_DIR, { recursive: true });
    } catch (e) {
        console.error(`[ReceiptImageGenerator] Could not create images directory ${IMAGES_DIR}: ${e.message}`);
    }
}

// Register fonts (singleton registration) under an app-private family name —
// see the matching FONT_FAMILY comment in ESCPOSBuilder.js. Plain "Catamaran"
// is a public Google Fonts name that anything else installed on the machine
// could also register system-wide; if that other copy lacks Tamil glyphs,
// Pango can silently resolve to it instead of ours, rendering Tamil as boxes
// despite this registration having "succeeded".
const FONT_FAMILY = 'SSDKioskCatamaran';
let fontsRegistered = false;
function registerFonts() {
    if (fontsRegistered || canvasLoadError) return;
    // ensureFontsExtracted() guarantees these live on real disk (native font
    // loading can't read straight out of the pkg snapshot) even when only
    // the exe itself was shared, with no external fonts/ folder provided.
    const fontsDir = ensureFontsExtracted();
    const fontPathRegular = path.join(fontsDir, 'Catamaran-Regular.ttf');
    const fontPathBold = path.join(fontsDir, 'Catamaran-Bold.ttf');
    if (fs.existsSync(fontPathRegular)) {
        registerFont(fontPathRegular, { family: FONT_FAMILY, weight: 'normal' });
    }
    if (fs.existsSync(fontPathBold)) {
        registerFont(fontPathBold, { family: FONT_FAMILY, weight: 'bold' });
    }
    fontsRegistered = true;
}

const WIDTH = 512; // Standard 80mm thermal printer approximate width inpx (at ~203dpi)
const LINE_HEIGHT = 24;
const TAMIL_LINE_HEIGHT = 32;
const MARGIN = 10;
// Was drawn edge-to-edge (WIDTH - MARGIN*2) — matches printService.js's own
// getLogoRaster(LOGO_PATH, 360) call, 360/512 ≈ this ratio, so the preview
// PNG and the physical ticket show the same logo size.
const LOGO_WIDTH_RATIO = 0.7;

// Same asset the real ESC/POS path prints — see printService.js's LOGO_PATH
// and ESCPOSBuilder.getLogoRaster() for the print pipeline's own copy of
// this. Kept as a separate constant (not a shared import) since this file
// draws it directly onto a canvas via drawImage rather than converting it
// to a raster command.
const LOGO_PATH = path.join(__dirname, '..', 'public', 'assets', 'SSD-Full-Logo-Transparent.png');
let cachedLogoImage = null;
let logoLoadAttempted = false;

async function loadLogoImage() {
    if (logoLoadAttempted) return cachedLogoImage;
    logoLoadAttempted = true;
    try {
        cachedLogoImage = await loadImage(fs.readFileSync(LOGO_PATH));
    } catch (e) {
        console.warn(`[receiptImageGenerator] Could not load logo "${LOGO_PATH}": ${e.message} — preview will render without it.`);
    }
    return cachedLogoImage;
}

class ReceiptImageGenerator {
    constructor() {
        registerFonts();
    }

    /**
     * Generates a PNG for a single receipt
     */
    async generate(receipt) {
        if (canvasLoadError) {
            // This is a record-keeping image only (see amq/printService.js,
            // which already wraps this call in try/catch) — the actual
            // ESC/POS print job is unaffected. Skip rather than throw.
            console.warn(`[receiptImageGenerator] Skipping receipt image — canvas unavailable (${canvasLoadError.message}).`);
            return null;
        }
        // Logo — loaded (and cached) up front so its real aspect-ratio
        // height is known before sizing the canvas, same asset the ESC/POS
        // path prints (see LOGO_PATH above).
        const logoImage = await loadLogoImage();
        const logoDrawWidth = logoImage ? Math.round((WIDTH - MARGIN * 2) * LOGO_WIDTH_RATIO) : 0;
        const logoDrawHeight = logoImage ? Math.round((logoImage.height / logoImage.width) * logoDrawWidth) : 0;

        // Decode each item's picture (downloaded earlier by printService.prepareItemImages) so the preview
        // shows what the real ticket prints. A picture that will not decode is just left out.
        for (const it of (receipt.items || [])) {
            if (it && it._imageBuffer && !it._pictureImage) {
                try {
                    Object.defineProperty(it, '_pictureImage', { value: await loadImage(it._imageBuffer), enumerable: false, configurable: true });
                } catch (e) {
                    console.warn(`[receiptImageGenerator] Could not decode item picture: ${e.message}`);
                }
            }
        }

        // Step 1: Preliminary height estimation
        let estimatedHeight = 200; // Base margin + reprints
        if (logoImage) estimatedHeight += logoDrawHeight + 20;
        if (receipt.reprint) estimatedHeight += 60;

        if (receipt.items && Array.isArray(receipt.items)) {
            receipt.items.forEach(item => {
                estimatedHeight += 120; // Name + Tamil Name + Qty + Price
                if (item._pictureImage) estimatedHeight += 180; // picture (max 150 tall) + gaps
                if (item.category) estimatedHeight += 60;
                if (item.deityName || item.deityTamilName) estimatedHeight += 40;
                const devoteeCount = (item.familMemberDetails && item.familMemberDetails.length) || (item.devotees && item.devotees.length) || 0;
                if (devoteeCount > 0) estimatedHeight += devoteeCount * 60 + 40;
            });
        }
        if (receipt.items && receipt.items.length > 1 && typeof receipt.total === 'number') {
            estimatedHeight += 40; // Ticket total line, multi-item tickets only
        }
        estimatedHeight += 200; // Total + Payment + Bottom Footer margin

        const canvas = createCanvas(WIDTH, estimatedHeight);
        const ctx = canvas.getContext('2d');

        // White background
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, WIDTH, estimatedHeight);
        ctx.fillStyle = '#000000';
        ctx.textBaseline = 'top';

        let y = 10;

        const drawText = (text, options = {}) => {
            const fontName = options.tamil ? FONT_FAMILY : 'monospace';
            const weight = options.bold ? 'bold' : 'normal';
            const size = options.size || 18;
            ctx.font = `${weight} ${size}px ${fontName}`;

            const textWidth = ctx.measureText(text).width;
            let x = MARGIN;

            if (options.align === 'center') {
                x = (WIDTH - textWidth) / 2;
            } else if (options.align === 'right') {
                x = WIDTH - textWidth - MARGIN;
            }

            ctx.fillText(text, x, y);
            y += options.tamil ? TAMIL_LINE_HEIGHT : LINE_HEIGHT;
        };

        const drawDivider = () => {
            ctx.font = '16px monospace';
            ctx.fillText('-'.repeat(48), MARGIN, y);
            y += LINE_HEIGHT;
        };

        // Logo — same asset/order as printService.js's buildReceipt(): first
        // thing on the ticket, before the reprint banner even.
        if (logoImage) {
            const logoX = (WIDTH - logoDrawWidth) / 2;
            ctx.drawImage(logoImage, logoX, y, logoDrawWidth, logoDrawHeight);
            y += logoDrawHeight + 10;
        }

        // Render REPRINT banner
        if (receipt.isReprint) {
            drawText(receipt.reprintNumber ? `*** REPRINT #${receipt.reprintNumber} ***` : '*** REPRINT ***', { align: 'center', bold: true });
            const reprintDate = receipt.reprintDate || getFormattedDateTime();
            drawText(`Reprinted: ${reprintDate}`, { align: 'center', size: 14 });
            y += 10;
        }

        if (receipt.receiptId) drawText(`Receipt No : ${receipt.receiptId}`, { size: 16 });
        if (receipt.gstNumber) drawText(`GST no.: ${receipt.gstNumber}`, { size: 16 });
        if (receipt.date) drawText(`Date: ${receipt.date}`, { size: 16 });

        // No temple name (Tamil/English) and no ticket-level heading here on
        // purpose — the logo above already identifies the temple, and each
        // item below now carries its own deity name instead of one shared
        // heading above them all.
        y += 10;
        drawDivider();

        // Fits "Name - Star" on one line, falls back to two lines (name,
        // then star) only when the combined text is too wide for the
        // ticket — matches printService.js's ESCPOSBuilder.measureTextWidth
        // approach for the real thermal print, so the preview and the
        // physical ticket wrap the same names the same way. Only the name is
        // bold — the " - star" part stays normal weight — and the size
        // matches the "Name - Star" header's own default (18), rather than
        // dwarfing it as the previous 22-26px sizing did.
        const DEVOTEE_FONT_SIZE = 18;
        const drawNameStar = (name, star) => {
            const trimmedName = (name || '').trim();
            const trimmedStar = (star || '').trim();
            if (!trimmedName && !trimmedStar) return;
            // Always go through drawText(..., { tamil: true }) so Tamil
            // glyphs use the same shaping path as item/deity names — the
            // previous single-line fillText path rendered Latin fine but
            // could mis-measure / mis-draw Tamil on some hosts.
            if (trimmedName && trimmedStar) {
                const separator = ` - ${trimmedStar}`;
                ctx.font = `bold ${DEVOTEE_FONT_SIZE}px ${FONT_FAMILY}`;
                const nameWidth = ctx.measureText(trimmedName).width;
                ctx.font = `normal ${DEVOTEE_FONT_SIZE}px ${FONT_FAMILY}`;
                const separatorWidth = ctx.measureText(separator).width;
                const maxWidth = WIDTH - MARGIN * 2;
                if (nameWidth + separatorWidth <= maxWidth) {
                    drawText(`${trimmedName}${separator}`, { bold: true, size: DEVOTEE_FONT_SIZE, tamil: true });
                } else {
                    drawText(trimmedName, { bold: true, size: DEVOTEE_FONT_SIZE, tamil: true });
                    drawText(trimmedStar, { size: DEVOTEE_FONT_SIZE, tamil: true });
                }
            } else {
                drawText(trimmedName || trimmedStar, { bold: true, size: DEVOTEE_FONT_SIZE, tamil: true });
            }
            y += 5;
        };

        // Items
        if (receipt.items && Array.isArray(receipt.items)) {
            receipt.items.forEach(item => {
                if (receipt.items.length === 1 && item.category) {
                    drawText(item.category, { align: 'center', bold: true, size: 20 });
                    if (item.categoryTamilName) drawText(item.categoryTamilName, { align: 'center', bold: true, size: 24, tamil: true });
                    y += 5;
                }

                // Tamil Name only — no English name line.
                if (item.tamilName) {
                    drawText(item.tamilName, { align: 'center', size: 26, tamil: true });
                }

                // Small extra gap between the item/service block above and
                // the deity block below.
                if (item.deityTamilName) y += 8;

                // Deity name (SSD) — Tamil only, same reasoning as the item
                // name above — shown right under the item so a multi-item
                // ticket still reads which line belongs to which deity.
                if (item.deityTamilName) {
                    drawText(item.deityTamilName, { align: 'center', size: 20, tamil: true });
                }

                // Picture of the item (only when one was downloaded) - same spot as the real ticket.
                if (item._pictureImage) {
                    const maxW = 200;
                    const maxH = 150;
                    const sc = Math.min(maxW / item._pictureImage.width, maxH / item._pictureImage.height, 1);
                    const dw = Math.round(item._pictureImage.width * sc);
                    const dh = Math.round(item._pictureImage.height * sc);
                    y += 8;
                    ctx.drawImage(item._pictureImage, (WIDTH - dw) / 2, y, dw, dh);
                    y += dh + 10;
                }

                // Qty stays (per item/deity) — only the per-item $ amount is
                // gone, since the ticket-level Total below now always covers
                // that.
                y += 10;
                drawText(`Qty: ${item.quantity || ''}`, { align: 'center', bold: true, size: 32 });
                y += 10;

                // Devotee details for THIS item/deity — HEB's own
                // item.familMemberDetails ({name, star}), or SSD's
                // item.devotees ({name, nakshatra}) from ssdTicketBuilder.js;
                // a given payload only ever populates one of the two.
                const devoteeList = (item.familMemberDetails && item.familMemberDetails.length > 0)
                    ? item.familMemberDetails.map((d) => ({ name: d.name, star: d.star }))
                    : (item.devotees || []).map((d) => ({ name: d.name, star: d.nakshatra }));

                if (devoteeList.length > 0) {
                    y += 10;
                    drawDivider();
                    drawText('பெயர் - நட்சத்திரம்', { bold: true, tamil: true });
                    drawDivider();
                    devoteeList.forEach(d => drawNameStar(d.name, d.star));
                }
                // Tight double divider under this deity's devotee block —
                // separates each deity-wise section from the next one (or
                // from the Total below, on the last item). Two lines close
                // together read as a stronger section break than one.
                y += 10;
                drawDivider();
                y -= LINE_HEIGHT - 8;
                drawDivider();
            });
        }

        // Ticket total — always shown now (was multi-item only), since
        // per-item pricing no longer prints at all.
        if (typeof receipt.total === 'number') {
            drawText(`Total: $${receipt.total.toFixed(2)} (GST Inc.)`, { align: 'center', bold: true, size: 20 });
            y += 10;
        }

        drawDivider();

        // Payment
        if (receipt.payment) {
            drawText(`Payment Method: ${receipt.payment.method || ''}`, { align: 'center' });
        }

        y += 30;
        drawText('--- END OF RECEIPT ---', { align: 'center', size: 14 });

        // Final Canvas (cropped to actual height)
        const finalCanvas = createCanvas(WIDTH, y + 40);
        const finalCtx = finalCanvas.getContext('2d');
        finalCtx.drawImage(canvas, 0, 0);

        // Save
        const timestamp = Date.now();
        const fileName = `full_receipt_${timestamp}.png`;
        const outPath = path.join(IMAGES_DIR, fileName);
        
        fs.writeFileSync(outPath, finalCanvas.toBuffer('image/png'));
        console.log(`[ReceiptImageGenerator] Full receipt saved: ${outPath}`);
        
        return outPath;
    }
}

module.exports = new ReceiptImageGenerator();
