const receiptline = require('receiptline');
const fs = require('fs');
const path = require('path');

const printersPath = path.join(__dirname, '..', 'node_modules', 'receiptline', 'printers.json');
const printers = JSON.parse(fs.readFileSync(printersPath, 'utf8'));

// 'printer3' uses escpos. 
// Alternatively use 'tm_series1' if found.
const printerConfig = printers.tm_series1 || printers.printer3;

console.log('Using printer config:', printerConfig);

const content = '{c:Test}';
const res = receiptline.transform(content, { printer: printerConfig });

console.log('Type:', typeof res);
if (typeof res === 'string') {
    if (res.trim().startsWith('<')) {
        console.log('Result is SVG');
    } else {
        console.log('Result is String (likely binary)');
        const buf = Buffer.from(res, 'binary');
        console.log('Buffer hex:', buf.toString('hex'));
        // Check if starts with ESC (1B) or Initialize (1B 40)
        console.log('Starts with 1B?', buf[0] === 0x1B);
    }
}
