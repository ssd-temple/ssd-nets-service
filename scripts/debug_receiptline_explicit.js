const receiptline = require('receiptline');

const content = `{c:Test}`;

const printerConfig = {
    "cpl": 42,
    "encoding": "multilingual",
    "spacing": true,
    "command": "escpos"
};

console.log('--- Config: Explicit Object ---');
const res = receiptline.transform(content, { printer: printerConfig });
console.log('Type:', typeof res);
if (typeof res === 'string') {
    console.log('Is SVG?', res.trim().startsWith('<'));
    // If it's not SVG, maybe it's binary string?
    if (!res.trim().startsWith('<')) {
        console.log('Hex:', Buffer.from(res, 'binary').toString('hex'));
    }
} else {
    console.log('Is Buffer?', Buffer.isBuffer(res));
}
