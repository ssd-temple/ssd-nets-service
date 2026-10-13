const iconv = require('iconv-lite'); // If available, or use Buffer.from

class ESCPOSBuilder {
    constructor() {
        this.buffer = [];
    }

    add(data) {
        if (typeof data === 'string') {
            this.buffer.push(Buffer.from(data, 'latin1')); // EPSON often uses CP437 or Latin1
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

    // Simple table implementation
    // columns: [{ width: chars, align: 'left'|'right'|'center' }]
    // data: [['item', 'qty', 'price']]
    table(columns, data) {
        data.forEach(row => {
            let line = '';
            row.forEach((cell, i) => {
                const col = columns[i];
                const width = col.width;
                const align = col.align || 'left';
                let content = String(cell).substring(0, width);

                const padding = width - content.length;
                if (padding > 0) {
                    if (align === 'left') {
                        content = content + ' '.repeat(padding);
                    } else if (align === 'right') {
                        content = ' '.repeat(padding) + content;
                    } else { // center
                        const left = Math.floor(padding / 2);
                        const right = padding - left;
                        content = ' '.repeat(left) + content + ' '.repeat(right);
                    }
                }
                line += content;
            });
            this.add(line).newline();
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

module.exports = ESCPOSBuilder;
