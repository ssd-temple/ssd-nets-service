const path = require('path');
const fs = require('fs');
const { ensureFontconfigConfigured } = require('../fontSetup');
const { ensureCanvasAddonsExtracted, ensureFontsExtracted } = require('../nativeAddonSetup');

// Same load-order requirement as receiptImageGenerator.js: native DLLs and
// Fontconfig must be ready before 'canvas' is first required, and a load
// failure must never crash the service at require() time.
ensureCanvasAddonsExtracted();
ensureFontconfigConfigured();
let createCanvas, registerFont, loadImage;
let canvasLoadError = null;
try {
    ({ createCanvas, registerFont, loadImage } = require('canvas'));
} catch (e) {
    canvasLoadError = e;
    console.error(`[ticketLayout] canvas failed to load: ${e.message}`);
}

/**
 * Renders the whole ticket (logo, header, Item/Qty/AMT table, session date,
 * deity, devotee box, total) onto ONE canvas. The same canvas is rasterised
 * for the thermal printer (ESCPOSBuilder.canvasImage) and saved as the
 * preview PNG (receiptImageGenerator), so the two can never drift apart.
 */

const FONT_FAMILY = 'SSDKioskCatamaran';
// Same look as the admin panel: Latin in the system UI font and Tamil in
// Nirmala UI (what the browser falls back to there, since Inter has no Tamil).
// Catamaran stays last so a machine without them still prints Tamil.
const FONT_STACK = `"Nirmala UI", "Segoe UI", ${FONT_FAMILY}`;
let fontsRegistered = false;
function registerFonts() {
    if (fontsRegistered || canvasLoadError) return;
    const fontsDir = ensureFontsExtracted();
    const regular = path.join(fontsDir, 'Catamaran-Regular.ttf');
    const bold = path.join(fontsDir, 'Catamaran-Bold.ttf');
    // registerFont() with an identical family/weight is harmless if
    // ESCPOSBuilder/receiptImageGenerator already did it.
    if (fs.existsSync(regular)) registerFont(regular, { family: FONT_FAMILY, weight: 'normal' });
    if (fs.existsSync(bold)) registerFont(bold, { family: FONT_FAMILY, weight: 'bold' });
    fontsRegistered = true;
}

const WIDTH = 512;           // 80mm thermal printer at ~203dpi, same as the rest of the service
const BORDER = 16;           // side margin: keeps everything clear of the paper edge (no outer frame is drawn)
const PAD = 4;               // text inset from the divider lines
const QTY_X = 372;           // left edge of the Qty column
const AMT_RIGHT = WIDTH - BORDER - PAD; // right edge of the AMT column
const LOGO_WIDTH_RATIO = 360 / 512; // same logo size as 1.0.6

const LOGO_PATH = path.join(__dirname, '..', 'public', 'assets', 'SSD-Full-Logo-Transparent.png');
let cachedLogo = null;
let logoAttempted = false;
async function loadLogo() {
    if (logoAttempted) return cachedLogo;
    logoAttempted = true;
    try {
        cachedLogo = await loadImage(fs.readFileSync(LOGO_PATH));
    } catch (e) {
        console.warn(`[ticketLayout] Could not load logo "${LOGO_PATH}": ${e.message} — ticket renders without it.`);
    }
    return cachedLogo;
}


// Photos need dithering to keep their shading on a 1-bit thermal printer (same
// Floyd-Steinberg approach ESCPOSBuilder.getImageRaster used in 1.0.6; a plain
// threshold turns them into faint blobs). Returns a pure black/white canvas that
// is later drawn 1:1 (integer position, no resampling) onto the ticket.
function ditherToCanvas(img, width, height) {
    const c = createCanvas(width, height);
    const cx = c.getContext('2d');
    cx.fillStyle = '#FFFFFF';
    cx.fillRect(0, 0, width, height);
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(img, 0, 0, width, height);
    const data = cx.getImageData(0, 0, width, height);
    const px = data.data;
    const n = width * height;
    const grey = new Float32Array(n);
    let lo = 255, hi = 0;
    for (let i = 0; i < n; i++) {
        const a = px[i * 4 + 3];
        const g = a < 16 ? 255 : 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
        grey[i] = g;
        if (g < lo) lo = g;
        if (g > hi) hi = g;
    }
    // Thermal paper darkens dots (dot gain), so a plain dither comes out muddy.
    // Stretch the contrast to the full range, then lighten the midtones a bit.
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < n; i++) {
        const v = (grey[i] - lo) / span;
        grey[i] = 255 * Math.pow(v, 1.15);
    }
    // Atkinson dithering: diffuses only 3/4 of the error, which keeps highlights
    // white and edges crisp (better than Floyd-Steinberg on 1-bit thermal output).
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;
            const old = grey[idx];
            const val = old < 128 ? 0 : 255;
            grey[idx] = val;
            const e = (old - val) / 8;
            if (x + 1 < width) grey[idx + 1] += e;
            if (x + 2 < width) grey[idx + 2] += e;
            if (y + 1 < height) {
                if (x > 0) grey[idx + width - 1] += e;
                grey[idx + width] += e;
                if (x + 1 < width) grey[idx + width + 1] += e;
            }
            if (y + 2 < height) grey[idx + 2 * width] += e;
        }
    }
    for (let i = 0; i < n; i++) {
        const v = grey[i] < 128 ? 0 : 255;
        px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v;
        px[i * 4 + 3] = 255;
    }
    cx.putImageData(data, 0, 0);
    return c;
}

// Logo: binarise with a higher threshold than the printer's own (128) so the
// thin strokes and light greys of the emblem and Tamil lettering stay solid.
// Lower threshold = thinner strokes, so the emblem's fine lines stay separate
// instead of filling in to a solid dark blob on the printer.
const LOGO_THRESHOLD = 110;
function binarizeLogo(img, width, height) {
    const c = createCanvas(width, height);
    const cx = c.getContext('2d');
    cx.fillStyle = '#FFFFFF';
    cx.fillRect(0, 0, width, height);
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(img, 0, 0, width, height);
    const data = cx.getImageData(0, 0, width, height);
    const px = data.data;
    for (let i = 0; i < width * height; i++) {
        const g = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
        const v = g < LOGO_THRESHOLD ? 0 : 255;
        px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v;
        px[i * 4 + 3] = 255;
    }
    cx.putImageData(data, 0, 0);
    return c;
}

// "CASH, NETS" -> "Cash, Nets"
function titleCase(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/(^|[\s,/-])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

function devoteesOf(item) {
    if (item.familMemberDetails && item.familMemberDetails.length > 0) {
        return item.familMemberDetails.map((d) => ({ name: d.name, star: d.star }));
    }
    return (item.devotees || []).map((d) => ({ name: d.name, star: d.nakshatra }));
}

// Same name + star entered more than once prints once.
function uniqueDevotees(item) {
    const seen = new Set();
    return devoteesOf(item)
        .filter((d) => (d.name || '').trim() || (d.star || '').trim())
        .filter((d) => {
            const key = `${(d.name || '').trim().toLowerCase()}|${(d.star || '').trim().toLowerCase()}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}
const devoteeSignature = (list) => list.map((d) => `${(d.name || '').trim()}|${(d.star || '').trim()}`).join('\n');

function isUsable(text) {
    return typeof text === 'string' && text.trim() !== '' && text !== 'null';
}

/**
 * @returns {Promise<import('canvas').Canvas|null>} null when canvas is unavailable
 */
async function renderTicketCanvas(receipt) {
    if (canvasLoadError) return null;
    registerFonts();

    const logo = await loadLogo();
    const items = Array.isArray(receipt.items) ? receipt.items : [];

    // Decode item pictures (downloaded earlier by printService.prepareItemImages).
    for (const it of items) {
        if (it && it._imageBuffer && !it._pictureImage) {
            try {
                Object.defineProperty(it, '_pictureImage', { value: await loadImage(it._imageBuffer), enumerable: false, configurable: true });
            } catch (e) {
                console.warn(`[ticketLayout] Could not decode item picture: ${e.message}`);
            }
        }
    }

    const font = (size, bold) => `${bold ? 'bold' : 'normal'} ${size}px ${FONT_STACK}`;
    const measure = createCanvas(1, 1).getContext('2d');
    const textWidth = (text, size, bold) => {
        measure.font = font(size, bold);
        return measure.measureText(text).width;
    };

    // Word-wrap on spaces so a long Tamil name never runs past its column.
    const wrap = (text, size, bold, maxWidth) => {
        const words = String(text).split(' ');
        const lines = [];
        let cur = '';
        for (const w of words) {
            const test = cur ? `${cur} ${w}` : w;
            if (cur && textWidth(test, size, bold) > maxWidth) {
                lines.push(cur);
                cur = w;
            } else {
                cur = test;
            }
        }
        if (cur) lines.push(cur);
        return lines;
    };

    // ---- Pass 1: lay everything out as a list of draw ops with a running y,
    // so the canvas can be created at its exact final height. ----
    const ops = [];
    let y = BORDER + 8;
    const lh = (size) => Math.ceil(size * 1.4);
    const add = (op, height) => { ops.push({ ...op, y }); y += height; };

    // Logo
    if (logo) {
        const w = Math.round(WIDTH * LOGO_WIDTH_RATIO);
        const h = Math.round((logo.height / logo.width) * w);
        add({ type: 'logo', w, h, img: binarizeLogo(logo, w, h) }, h + 4);
    }
    if (receipt.gstNumber) add({ type: 'text', text: `GST No: ${receipt.gstNumber}`, size: 19, align: 'center' }, lh(19));

    if (receipt.isReprint) {
        add({ type: 'text', text: receipt.reprintNumber ? `*** REPRINT #${receipt.reprintNumber} ***` : '*** REPRINT ***', size: 18, bold: true, align: 'center' }, lh(18));
    }

    y += 4;
    const page = receipt.pageNo && receipt.pageTotal ? ` (Page ${receipt.pageNo}/${receipt.pageTotal})` : '';
    if (receipt.receiptId) add({ type: 'text', text: `Receipt No: ${receipt.receiptId}${page}`, size: 19 }, lh(19));
    const dateTime = receipt.dateTime || receipt.date;
    if (dateTime) add({ type: 'text', text: `Date & Time: ${dateTime}`, size: 19 }, lh(19));
    y += 4;

    add({ type: 'hline', full: true }, 1);
    add({ type: 'headerRow' }, lh(18) + 2);
    add({ type: 'hline', full: true }, 1);

    const nameMaxWidth = QTY_X - PAD - BORDER - 10;
    let computedTotal = 0;
    const devoteeLists = items.map(uniqueDevotees);
    items.forEach((item, idx) => {
        y += 6;
        const title = isUsable(item.tamilName) ? item.tamilName : (item.name || '');
        const lines = wrap(title, 26, false, nameMaxWidth);
        const rowY = y;
        lines.forEach((line, i) => {
            add({ type: 'text', text: line, size: 26, x: PAD + BORDER }, lh(26));
            if (i === 0) {
                ops.push({ type: 'text', text: String(item.quantity ?? ''), size: 23, x: QTY_X, y: rowY + 4 });
                ops.push({ type: 'text', text: Number(item.total || 0).toFixed(2), size: 23, align: 'right', y: rowY + 4 });
            }
        });
        computedTotal += Number(item.total || 0);

        // Session date — only when this line carries one.
        if (item.sessionText) {
            add({ type: 'text', text: `Session Date: ${item.sessionText}`, size: 17, bold: true, x: PAD + BORDER }, lh(17));
        }

        if (item._pictureImage) {
            const sc = Math.min(232 / item._pictureImage.width, 168 / item._pictureImage.height, 2);
            const w = Math.max(8, Math.floor((item._pictureImage.width * sc) / 8) * 8);
            const h = Math.max(1, Math.round((item._pictureImage.height * w) / item._pictureImage.width));
            y += 4;
            add({ type: 'picture', img: ditherToCanvas(item._pictureImage, w, h), w, h }, h + 6);
        }

        // Deities — Tamil only, centred and underlined, one per line.
        const deityNames = Array.isArray(item.deityTamilNames) && item.deityTamilNames.length > 0
            ? item.deityTamilNames
            : [item.deityTamilName];
        deityNames.filter(isUsable).forEach((name, i) => {
            if (i === 0) y += 4;
            add({ type: 'text', text: name, size: 26, align: 'center', underline: true }, lh(26) + 2);
        });

        // Devotees in a bordered box — printed once for a run of consecutive
        // items that share the same devotee list (after the last of the run).
        const devotees = devoteeLists[idx];
        const nextSame = idx + 1 < items.length && devoteeSignature(devoteeLists[idx + 1]) === devoteeSignature(devotees);
        const showBox = devotees.length > 0 && !nextSame;
        if (showBox) {
            y += 6;
            const boxX = BORDER + 8;
            const boxW = WIDTH - (BORDER + 8) * 2;
            const innerMax = boxW - 20;
            const rows = [];
            devotees.forEach((d) => {
                const name = (d.name || '').trim();
                const star = (d.star || '').trim();
                const text = name && star ? `${name} - ${star}` : (name || star);
                rows.push(...wrap(text, 24, false, innerMax));
            });
            const boxH = rows.length * lh(24) + 14;
            add({ type: 'box', x: boxX, w: boxW, h: boxH, rows }, boxH);
            y += 6;
        }

        y += 6;
        // Solid line between sections; dashed between items that share one devotee box.
        add({ type: devotees.length > 0 && nextSame ? 'dash' : 'hline', full: true }, 1);
        y += 4;
    });

    // Footer: payment mode (left) + total (right).
    const total = typeof receipt.total === 'number' ? receipt.total : computedTotal;
    const payment = receipt.payment && receipt.payment.method ? titleCase(receipt.payment.method) : '';
    y += 4;
    // Payment mode and total share one line; when both together are too wide
    // (e.g. "Cash, Nets" with a large total) the payment mode gets its own line.
    const totalLabel = `Total (GST Inclusive) : S$ ${Number(total).toFixed(2)}`;
    const stacked = payment && textWidth(payment, 25, true) + textWidth(totalLabel, 25, true) + 16 > WIDTH - (BORDER + PAD) * 2;
    add({ type: 'footer', payment, total, stacked }, lh(25) * (stacked ? 2 : 1) + 4);
    add({ type: 'hline', full: true }, 1);

    // Blank space under the last line so the cutter does not slice right under the content.
    const height = y + 70;

    // ---- Pass 2: draw. ----
    const canvas = createCanvas(WIDTH, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, WIDTH, height);
    ctx.fillStyle = '#000000';
    ctx.strokeStyle = '#000000';
    ctx.textBaseline = 'top';

    ctx.lineWidth = 1.5;

    const drawText = (op) => {
        ctx.font = font(op.size, op.bold);
        const w = ctx.measureText(op.text).width;
        let x = op.x ?? BORDER + PAD;
        if (op.align === 'center') x = (WIDTH - w) / 2;
        else if (op.align === 'right') x = AMT_RIGHT - w;
        ctx.fillText(op.text, x, op.y);
        if (op.underline) {
            const uy = op.y + Math.round(op.size * 1.25);
            ctx.fillRect(x, uy, w, 2);
        }
    };

    for (const op of ops) {
        switch (op.type) {
            case 'logo':
                ctx.drawImage(op.img, Math.round((WIDTH - op.w) / 2), op.y);
                break;
            case 'picture':
                ctx.drawImage(op.img, Math.round((WIDTH - op.w) / 2), op.y);
                break;
            case 'text':
                drawText(op);
                break;
            case 'hline':
                ctx.fillRect(BORDER, op.y, WIDTH - BORDER * 2, 2);
                break;
            case 'dash':
                for (let x = BORDER; x < WIDTH - BORDER; x += 12) ctx.fillRect(x, op.y, 6, 2);
                break;
            case 'headerRow':
                drawText({ type: 'text', text: 'Item', size: 18, bold: true, y: op.y });
                drawText({ type: 'text', text: 'Qty', size: 18, bold: true, x: QTY_X, y: op.y });
                drawText({ type: 'text', text: 'AMT', size: 18, bold: true, align: 'right', y: op.y });
                break;
            case 'box': {
                ctx.strokeRect(op.x, op.y, op.w, op.h);
                op.rows.forEach((row, i) => {
                    drawText({ type: 'text', text: row, size: 24, x: op.x + 14, y: op.y + 7 + i * lh(24) });
                });
                break;
            }
            case 'footer': {
                drawText({ type: 'text', text: op.payment, size: 25, bold: true, y: op.y });
                const label = `Total (GST Inclusive) : S$ ${Number(op.total).toFixed(2)}`;
                drawText({ type: 'text', text: label, size: 25, bold: true, align: 'right', y: op.stacked ? op.y + lh(25) : op.y });
                break;
            }
            default:
                break;
        }
    }

    return canvas;
}

module.exports = { renderTicketCanvas, WIDTH, canvasUnavailable: () => canvasLoadError };
