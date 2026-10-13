const iconv = require('iconv-lite'); // If available, or use Buffer.from
const path = require('path');
const fs = require('fs');
const { ensureFontconfigConfigured } = require('../fontSetup');
const { ensureCanvasAddonsExtracted, ensureFontsExtracted } = require('../nativeAddonSetup');

// Load canvas with pkg-safe native addon resolution.
// ensureCanvasAddonsExtracted() self-extracts canvas.node's bundled DLL
// dependencies (Cairo/Pango/HarfBuzz/Fontconfig) to a real directory and
// adds it to PATH, so this works even when only the exe itself was shared
// (see nativeAddonSetup.js).
let createCanvas, registerFont, loadImage;
let canvasLoadError = null;
const canvasAddonsDir = ensureCanvasAddonsExtracted();
// Must run before requiring 'canvas' so Fontconfig/Pango pick up our config
// on first init (see fontSetup.js for why this matters for Tamil text).
ensureFontconfigConfigured();
try {
    ({ createCanvas, registerFont, loadImage } = require('canvas'));
} catch (e) {
    // Deliberately NOT re-thrown: if canvas fails to load on some machine
    // (missing VC++ redistributable, antivirus blocked a DLL, etc.), the
    // whole service must not crash at startup — that would take down
    // payment processing along with it. Instead every textImage() call
    // below logs a clear reason and the caller (printService.js) already
    // treats receipt-image generation as best-effort. Check logs for
    // "[ESCPOSBuilder] canvas failed to load" to diagnose the real cause.
    canvasLoadError = e;
    console.error(`[ESCPOSBuilder] canvas failed to load from ${canvasAddonsDir}: ${e.message}`);
    console.error('[ESCPOSBuilder] Tamil/image-based receipt text will not print until this is fixed. Plain ESC/POS text (English) is unaffected.');
}

// Resolve app and image directories
const APP_DIR = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
const IMAGES_DIR = path.join(APP_DIR, 'images');

// Ensure images directory exists next to log
if (!fs.existsSync(IMAGES_DIR)) {
    try {
        fs.mkdirSync(IMAGES_DIR, { recursive: true });
    } catch (e) {
        console.error(`[ESCPOSBuilder] Failed to create images directory: ${e.message}`);
    }
}

// Register Catamaran font once at module load, under an app-private family
// name (not the plain "Catamaran" Google Fonts name) — see FONT_FAMILY
// comment below for why.
let fontRegistered = false;
let registrationError = null;

// "Catamaran" is a public Google Fonts family. On a machine where anything
// else (another app, a font pack, a manual install) has ever installed a
// system-wide font also named "Catamaran" — very plausible specifically on
// a machine set up fresh for this kiosk, if that setup process installed
// other software first — Fontconfig/Pango can resolve the bare family name
// to THAT font instead of ours, silently. Most such fonts don't cover Tamil,
// so text renders as boxes despite registerFont() having "succeeded" and
// fonts.conf being configured correctly, which is why this was invisible to
// every diagnostic already in place (canvas loaded=true, font registered=true).
// Registering under a name nothing else on earth is likely to also use
// removes the ambiguity entirely, regardless of what else is installed.
const FONT_FAMILY = 'SSDKioskCatamaran';

function ensureFontRegistered() {
    if (fontRegistered) return;

    // ensureFontsExtracted() guarantees these live on real disk (native font
    // loading can't read straight out of the pkg snapshot) even when only
    // the exe itself was shared, with no external fonts/ folder provided.
    const fontsDir = ensureFontsExtracted();
    const regularPath = path.join(fontsDir, 'Catamaran-Regular.ttf');
    const boldPath = path.join(fontsDir, 'Catamaran-Bold.ttf');

    if (!fs.existsSync(regularPath)) {
        console.warn(`[ESCPOSBuilder] Catamaran font not found at ${regularPath}. Tamil text may render as squares.`);
        return;
    }

    try {
        registerFont(regularPath, { family: FONT_FAMILY, weight: '400' });
        if (fs.existsSync(boldPath)) {
            registerFont(boldPath, { family: FONT_FAMILY, weight: 'bold' });
        }
        fontRegistered = true;
        console.log(`[ESCPOSBuilder] Catamaran font registered successfully from ${regularPath} (as "${FONT_FAMILY}").`);
    } catch (e) {
        registrationError = e.message;
        console.error(`[ESCPOSBuilder] Font registration failed for ${regularPath}:`, e.message);
    }
}

// Try to register at load time
try { ensureFontRegistered(); } catch (e) { console.warn('[ESCPOSBuilder] Font registration warning:', e.message); }

/**
 * Converts a canvas's pixel data into a complete ESC/POS raster-image
 * command (GS v 0 header + 1-bit monochrome bitmap) — the same conversion
 * textImage() and the new image()/getLogoRaster() below both need, pulled
 * out once so neither has to duplicate the bit-packing math.
 */
function canvasToRasterCommand(ctx, width, height) {
    const imageData = ctx.getImageData(0, 0, width, height);
    const pixels = imageData.data; // RGBA flat array

    const widthBytes = Math.ceil(width / 8);
    const rasterData = Buffer.alloc(widthBytes * height);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const pixelIdx = (y * width + x) * 4;
            const r = pixels[pixelIdx];
            const g = pixels[pixelIdx + 1];
            const b = pixels[pixelIdx + 2];
            const alpha = pixels[pixelIdx + 3];

            // Transparent pixels (alpha near 0) count as background/white —
            // matters for a logo PNG with a transparent background, which
            // would otherwise threshold to black (RGB defaults to 0,0,0
            // where alpha is 0 in most decoders).
            const gray = alpha < 16 ? 255 : 0.299 * r + 0.587 * g + 0.114 * b;
            const isDark = gray < 128;

            if (isDark) {
                const byteIdx = y * widthBytes + Math.floor(x / 8);
                const bitIdx = 7 - (x % 8);
                rasterData[byteIdx] |= (1 << bitIdx);
            }
        }
    }

    // GS v 0 m xL xH yL yH d1...dk — m=0 (normal size)
    const xL = widthBytes & 0xFF;
    const xH = (widthBytes >> 8) & 0xFF;
    const yL = height & 0xFF;
    const yH = (height >> 8) & 0xFF;
    return Buffer.concat([Buffer.from([0x1D, 0x76, 0x30, 0, xL, xH, yL, yH]), rasterData]);
}

// Cache of already-rendered logo raster commands, keyed by "path@width" —
// the source PNG never changes at runtime, and re-decoding + re-thresholding
// it on every single print job would be pure waste. Cleared only by a
// service restart.
const logoRasterCache = new Map();

class ESCPOSBuilder {
    constructor() {
        this.buffer = [];
    }

    /**
     * Measures how wide `text` would render at the given fontSize/bold, in
     * the same font textImage() itself uses — lets a caller decide UP FRONT
     * whether two short pieces of text (e.g. a devotee's name and star) fit
     * on one combined line before committing to one textImage() call versus
     * two, rather than relying on textImage()'s own generic word-wrap (which
     * only knows how to break on spaces, and would happily split in the
     * middle of a long name instead of cleanly keeping the whole name on its
     * own line). Returns 0 (never blocks the caller) if canvas isn't
     * available on this machine.
     */
    static measureTextWidth(text, options = {}) {
        if (canvasLoadError) return 0;
        ensureFontRegistered();
        const fontSize = options.fontSize || 26;
        const fontWeight = options.bold ? 'bold' : 'normal';
        const measureCanvas = createCanvas(1, 1);
        const measureCtx = measureCanvas.getContext('2d');
        measureCtx.font = `${fontWeight} ${fontSize}px ${FONT_FAMILY}`;
        return measureCtx.measureText(text).width;
    }

    add(data) {
        if (typeof data === 'string') {
            this.buffer.push(Buffer.from(data, 'utf8')); // Use UTF-8 encoding for Unicode support
        } else if (Buffer.isBuffer(data)) {
            this.buffer.push(data);
        } else if (Array.isArray(data)) {
            this.buffer.push(Buffer.from(data));
        }
        return this;
    }

    text(str) {
        return this.add(str);
    }

    newline() {
        return this.add([0x0A]);
    }

    feed(n) {
        // ESC d n: Print and feed n lines
        return this.add([0x1B, 0x64, n || 1]);
    }

    align(align) {
        // 0: left, 1: center, 2: right
        let n = 0;
        if (align === 'center') n = 1;
        if (align === 'right') n = 2;
        return this.add([0x1B, 0x61, n]);
    }

    style(style) {
        // Simple bold
        if (style === 'b') return this.add([0x1B, 0x45, 1]);
        if (style === 'normal') return this.add([0x1B, 0x45, 0]);
        return this;
    }

    size(width, height) {
        // GS ! n
        // n = (height-1)*16 + (width-1)
        // 1,1 normal -> n=0
        // 2,2 -> n=17
        const n = ((height - 1) * 16) + (width - 1);
        return this.add([0x1D, 0x21, n]);
    }

    cut() {
        return this.add([0x1D, 0x56, 65, 0]); // Full cut
    }

    characterSet(n = 0) {
        // ESC R n: select international character set. n=0 is USA, which
        // keeps the 12 ASCII positions ($ # @ [ \ ] ^ ` { | } ~) as
        // standard ASCII. Printers persist this setting in their own
        // memory across jobs and reboots — one of ours had drifted onto a
        // table where 0x24 ("$") prints as "¥" instead. Send this
        // explicitly on every job rather than trusting whatever the
        // printer is currently configured to.
        return this.add([0x1B, 0x52, n]);
    }

    codePage(n = 0) {
        // ESC t n: select character code table. n=0 is PC437 (USA, Standard Europe).
        return this.add([0x1B, 0x74, n]);
    }

    lineSpacing(n) {
        // ESC 3 n: Set line spacing to n dots (finer than the printer default)
        return this.add([0x1B, 0x33, n]);
    }

    defaultLineSpacing() {
        // ESC 2: Restore the printer's default line spacing
        return this.add([0x1B, 0x32]);
    }

    microFeed(n) {
        // ESC J n: Print and feed paper n dots — finer control than feed()/newline()
        return this.add([0x1B, 0x4A, n || 0]);
    }

    /**
     * Render text as a bitmap image using the Catamaran font (supports Tamil + English)
     * and append ESC/POS raster image commands to the buffer.
     *
     * @param {string} text - The text to render (can contain Tamil/English mix)
     * @param {object} options - Rendering options
     * @param {number} options.fontSize - Font size in pixels (default: 20)
     * @param {string} options.align - Alignment: 'left', 'center', 'right' (default: 'left')
     * @param {boolean} options.bold - Whether to render bold (default: false)
     * @param {number} options.receiptWidth - Receipt width in pixels (default: 384 for 48mm printable on 80mm paper)
     */
    textImage(text, options = {}) {
        if (canvasLoadError) {
            // canvas never loaded on this machine — fall back to plain
            // ESC/POS text instead of crashing the whole print job. This
            // will render Tamil incorrectly (printer has no Tamil glyphs),
            // but keeps the rest of the receipt (and the service) working.
            // See "[ESCPOSBuilder] canvas failed to load" earlier in the
            // log for why.
            console.warn(`[ESCPOSBuilder] Skipping image render for "${text}" — canvas unavailable (${canvasLoadError.message}).`);
            return this.text(text).newline();
        }

        ensureFontRegistered();

        const fontSize = options.fontSize || 26;
        const align = options.align || 'left';
        const bold = options.bold || false;
        const receiptWidth = options.receiptWidth || 512; // Increased from 384 for 80mm printers

        const fontWeight = bold ? 'bold' : 'normal';
        const fontStr = `${fontWeight} ${fontSize}px ${FONT_FAMILY}`;

        // Step 1: Word-wrap text to fit receipt width
        const measureCanvas = createCanvas(1, 1);
        const measureCtx = measureCanvas.getContext('2d');
        measureCtx.font = fontStr;

        const maxTextWidth = receiptWidth - 8; // 4px padding each side
        const words = text.split(' ');
        const lines = [];
        let currentLine = '';

        for (const word of words) {
            const testLine = currentLine ? `${currentLine} ${word}` : word;
            if (measureCtx.measureText(testLine).width > maxTextWidth && currentLine) {
                lines.push(currentLine);
                currentLine = word;
            } else {
                currentLine = testLine;
            }
        }
        if (currentLine) lines.push(currentLine);

        // Calculate canvas height for all wrapped lines
        const lineHeight = Math.ceil(fontSize * 1.35);
        const canvasHeight = lineHeight * lines.length + 5; // 3px top room for Tamil top-marks + 2px bottom

        // Step 2: Create the real canvas at receipt width
        const canvas = createCanvas(receiptWidth, canvasHeight);
        const ctx = canvas.getContext('2d');

        // White background
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, receiptWidth, canvasHeight);

        // Draw each wrapped line
        ctx.fillStyle = '#000000';
        ctx.font = fontStr;
        ctx.textBaseline = 'top';

        lines.forEach((line, i) => {
            const lineWidth = measureCtx.measureText(line).width;
            let x = 0;
            if (align === 'center') {
                x = Math.max(0, (receiptWidth - lineWidth) / 2);
            } else if (align === 'right') {
                x = Math.max(0, receiptWidth - lineWidth - 4);
            } else {
                x = 4;
            }
            ctx.fillText(line, x, i * lineHeight + 3); // 3px top offset — enough for Tamil top-marks, less gap after divider
        });

        // Save generated fragment to images folder for debugging/record.
        // Opt-in only (SAVE_DEBUG_IMAGES=true) \u2014 this used to run
        // unconditionally on EVERY line of text on every receipt (temple
        // name, Tamil name, each item line, price, footer, etc.), each doing
        // a synchronous PNG encode + disk write purely for troubleshooting,
        // with zero effect on the actual printed output (the raster bytes
        // used for printing are built separately below). That was the
        // dominant cause of the delay between payment confirmation and the
        // ticket coming out. Set SAVE_DEBUG_IMAGES=true in .env to re-enable
        // when actively debugging a Tamil/font rendering issue.
        if (process.env.SAVE_DEBUG_IMAGES === 'true') {
            try {
                const timestamp = Date.now();
                const safeText = text.replace(/[^a-z0-9\u0B80-\u0BFF]/gi, '_').substring(0, 30);
                const fileName = `print_${timestamp}_${safeText}.png`;
                const outPath = path.join(IMAGES_DIR, fileName);
                fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
            } catch (e) {
                console.warn(`[ESCPOSBuilder] Failed to save debug image: ${e.message}`);
            }
        }

        // Step 3: Convert canvas to a complete ESC/POS raster command and
        // append it (shared with image()/getLogoRaster() below).
        this.add(canvasToRasterCommand(ctx, receiptWidth, canvasHeight));

        return this;
    }

    /**
     * Same idea as textImage(), for a single line that needs two different
     * font weights side by side — e.g. a devotee's bold name followed by
     * their star in normal weight ("Arun - Ardra", only "Arun" bold).
     * textImage() itself can only apply one weight to a whole call, so this
     * is a dedicated sibling rather than an option on it: draws `boldText`
     * then `normalText` immediately after it on the same line, then raster-
     * encodes the result the same way textImage() does. No word-wrap — this
     * is for short single-line labels, not paragraphs.
     */
    textImageTwoTone(boldText, normalText, options = {}) {
        if (canvasLoadError) {
            console.warn(`[ESCPOSBuilder] Skipping image render for "${boldText}${normalText}" — canvas unavailable (${canvasLoadError.message}).`);
            return this.text(`${boldText}${normalText}`).newline();
        }

        ensureFontRegistered();

        const fontSize = options.fontSize || 26;
        const align = options.align || 'left';
        const receiptWidth = options.receiptWidth || 512;
        const boldFont = `bold ${fontSize}px ${FONT_FAMILY}`;
        const normalFont = `normal ${fontSize}px ${FONT_FAMILY}`;

        const measureCanvas = createCanvas(1, 1);
        const measureCtx = measureCanvas.getContext('2d');
        measureCtx.font = boldFont;
        const boldWidth = measureCtx.measureText(boldText).width;
        measureCtx.font = normalFont;
        const normalWidth = measureCtx.measureText(normalText).width;
        const totalWidth = boldWidth + normalWidth;

        const lineHeight = Math.ceil(fontSize * 1.35);
        const canvasHeight = lineHeight + 5;

        const canvas = createCanvas(receiptWidth, canvasHeight);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, receiptWidth, canvasHeight);
        ctx.fillStyle = '#000000';
        ctx.textBaseline = 'top';

        let x;
        if (align === 'center') x = Math.max(0, (receiptWidth - totalWidth) / 2);
        else if (align === 'right') x = Math.max(0, receiptWidth - totalWidth - 4);
        else x = 4;

        ctx.font = boldFont;
        ctx.fillText(boldText, x, 3);
        ctx.font = normalFont;
        ctx.fillText(normalText, x + boldWidth, 3);

        if (process.env.SAVE_DEBUG_IMAGES === 'true') {
            try {
                const timestamp = Date.now();
                const safeText = `${boldText}${normalText}`.replace(/[^a-z0-9஀-௿]/gi, '_').substring(0, 30);
                fs.writeFileSync(path.join(IMAGES_DIR, `print_${timestamp}_${safeText}.png`), canvas.toBuffer('image/png'));
            } catch (e) {
                console.warn(`[ESCPOSBuilder] Failed to save debug image: ${e.message}`);
            }
        }

        this.add(canvasToRasterCommand(ctx, receiptWidth, canvasHeight));
        return this;
    }

    /**
     * Append an already-rendered logo raster command (from
     * ESCPOSBuilder.getLogoRaster()) to the buffer. Synchronous — the async
     * PNG decode/threshold work happens once, ahead of time, in
     * getLogoRaster(), specifically so this stays a plain chainable builder
     * method like everything else here.
     */
    image(rasterCommand) {
        if (!rasterCommand) return this;
        return this.add(rasterCommand);
    }

    // Simple table implementation
    // columns: [{ width: chars, align: 'left'|'right'|'center' }]
    // data: [['item', 'qty', 'price']]
    table(columns, data) {
        data.forEach(row => {
            // Build each cell as a Buffer with exact byte-width padding
            const cellBuffers = row.map((cell, i) => {
                const col = columns[i];
                const width = col.width;
                const align = col.align || 'left';
                const str = String(cell);

                // Truncate by byte length to fit within column width
                let truncated = str;
                while (Buffer.byteLength(truncated, 'utf8') > width && truncated.length > 0) {
                    truncated = truncated.slice(0, -1);
                }

                const byteLen = Buffer.byteLength(truncated, 'utf8');
                const padding = width - byteLen;

                let result;
                if (align === 'right') {
                    result = ' '.repeat(padding) + truncated;
                } else if (align === 'center') {
                    const left = Math.floor(padding / 2);
                    const right = padding - left;
                    result = ' '.repeat(left) + truncated + ' '.repeat(right);
                } else {
                    result = truncated + ' '.repeat(padding);
                }
                return result;
            });

            this.add(cellBuffers.join('')).newline();
        });
        return this;
    }

    // Code128 Barcode
    // GS k m n d1...dk
    // m=73 (Code128)
    barcode(data) {
        // Simple implementation for Code128 B (alphanumeric)
        // Simplified: using Subset B for everything.
        // Start Code B: { [104]
        // data bytes mapping

        // Actually, many printers support "GS k" with older syntax or "GS k" m d1...dk NUL with m=65..
        // Let's use GS k I (73)
        // Format: GS k 73 len {B data

        const len = data.length + 2; // +2 for {B
        this.add([0x1D, 0x6B, 73, len]);
        this.add([123, 66]); // {B (Start Code B)
        this.add(data);
        return this;
    }

    getBuffer() {
        return Buffer.concat(this.buffer);
    }
}

/**
 * Renders a logo image file to a ready-to-append ESC/POS raster command,
 * scaled proportionally to fit `receiptWidth`. Cached per (path, width) —
 * the source file never changes at runtime, so this only actually decodes
 * the PNG once per service run. Returns null (never throws) on any failure
 * — no canvas, missing/corrupt file, decode error — so a broken/missing
 * logo asset degrades to "no logo printed", never a failed ticket. Callers
 * pass the resolved Buffer straight into builder.image().
 *
 * @param {string} logoPath  absolute path to a PNG (a transparent
 *   background composites as white, matching how a receipt page looks).
 * @param {number} [receiptWidth]  same raster width textImage() uses.
 * @returns {Promise<Buffer|null>}
 */
ESCPOSBuilder.getLogoRaster = async function getLogoRaster(logoPath, receiptWidth = 512) {
    if (canvasLoadError) return null;
    const cacheKey = `${logoPath}@${receiptWidth}`;
    if (logoRasterCache.has(cacheKey)) return logoRasterCache.get(cacheKey);

    try {
        const fileBuffer = fs.readFileSync(logoPath); // plain Node fs read — pkg-snapshot-safe, unlike native font loading
        const img = await loadImage(fileBuffer);

        const scaledHeight = Math.max(1, Math.round((img.height / img.width) * receiptWidth));
        const canvas = createCanvas(receiptWidth, scaledHeight);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, receiptWidth, scaledHeight);
        ctx.drawImage(img, 0, 0, receiptWidth, scaledHeight);

        const command = canvasToRasterCommand(ctx, receiptWidth, scaledHeight);
        logoRasterCache.set(cacheKey, command);
        return command;
    } catch (e) {
        console.warn(`[ESCPOSBuilder] Could not render logo "${logoPath}": ${e.message} — printing will continue without it.`);
        logoRasterCache.set(cacheKey, null); // don't retry a broken file on every single print job
        return null;
    }
};

/**
 * Renders an item/service/event PICTURE (raw image bytes, as downloaded by amq/ticketImages.js) to a
 * ready-to-append ESC/POS raster command, scaled down to fit `maxWidth` x `maxHeight` and centred by
 * the caller (builder.align('center')).
 *
 * Unlike the logo (hard black/white threshold, fine for a flat logo), a photo needs dithering to keep
 * its shading on a 1-bit thermal printer, so this converts to grey and applies Floyd-Steinberg
 * error diffusion. Returns null (never throws) when canvas is unavailable or the bytes are not an
 * image, so a bad picture just means "no picture on this ticket".
 *
 * @param {Buffer} imageBuffer
 * @param {number} [maxWidth]   printable width in dots (the ticket is 512 wide; pictures print narrower)
 * @param {number} [maxHeight]  keeps one picture from eating the whole ticket
 * @returns {Promise<Buffer|null>}
 */
ESCPOSBuilder.getImageRaster = async function getImageRaster(imageBuffer, maxWidth = 200, maxHeight = 150) {
    if (canvasLoadError || !imageBuffer || imageBuffer.length === 0) return null;
    try {
        const img = await loadImage(imageBuffer);
        if (!img.width || !img.height) return null;
        const scale = Math.min(maxWidth / img.width, maxHeight / img.height, 1);
        // Whole bytes wide so the raster has no ragged edge.
        const width = Math.max(8, Math.floor((img.width * scale) / 8) * 8);
        const height = Math.max(1, Math.round((img.height * width) / img.width));

        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);

        const px = ctx.getImageData(0, 0, width, height).data;
        // Grey values, with transparent pixels counted as white.
        const grey = new Float32Array(width * height);
        for (let i = 0; i < width * height; i++) {
            const a = px[i * 4 + 3];
            grey[i] = a < 16 ? 255 : 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
        }
        // Floyd-Steinberg error diffusion.
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = y * width + x;
                const old = grey[idx];
                const val = old < 128 ? 0 : 255;
                grey[idx] = val;
                const err = old - val;
                if (x + 1 < width) grey[idx + 1] += (err * 7) / 16;
                if (y + 1 < height) {
                    if (x > 0) grey[idx + width - 1] += (err * 3) / 16;
                    grey[idx + width] += (err * 5) / 16;
                    if (x + 1 < width) grey[idx + width + 1] += (err * 1) / 16;
                }
            }
        }
        const widthBytes = width / 8;
        const raster = Buffer.alloc(widthBytes * height);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (grey[y * width + x] < 128) raster[y * widthBytes + (x >> 3)] |= 1 << (7 - (x % 8));
            }
        }
        return Buffer.concat([
            Buffer.from([0x1D, 0x76, 0x30, 0, widthBytes & 0xFF, (widthBytes >> 8) & 0xFF, height & 0xFF, (height >> 8) & 0xFF]),
            raster,
        ]);
    } catch (e) {
        console.warn(`[ESCPOSBuilder] Could not render ticket picture: ${e.message} - printing continues without it.`);
        return null;
    }
};

// Call once at service startup (see index.js) so the native Cairo/Pango/
// Fontconfig stack pays its one-time initialization cost (~8s, observed in
// production logs) before any real customer print job, not on it. Renders a
// throwaway Tamil glyph through the exact same createCanvas/fillText/
// toBuffer path textImage() uses for real tickets.
ESCPOSBuilder.warmUp = () => {
    if (canvasLoadError) return;
    try {
        ensureFontRegistered();
        const canvas = createCanvas(64, 64);
        const ctx = canvas.getContext('2d');
        ctx.font = `20px ${FONT_FAMILY}`;
        ctx.fillText('அ', 0, 20);
        canvas.toBuffer('image/png');
        console.log('[ESCPOSBuilder] Canvas/font warm-up complete.');
    } catch (e) {
        console.warn(`[ESCPOSBuilder] Warm-up failed (non-fatal): ${e.message}`);
    }
};

// Exposed for diagnostics (see index.js -> GET /api/diagnostics/native and
// the startup summary block) so canvas/font health can be checked without
// digging through log files.
ESCPOSBuilder.getCanvasStatus = () => ({
    loaded: !canvasLoadError,
    error: canvasLoadError ? canvasLoadError.message : null,
    addonsDir: canvasAddonsDir,
    fontRegistered,
    fontRegistrationError: registrationError,
});

module.exports = ESCPOSBuilder;
