const receiptline = require('receiptline');

const content = `{c:Test}`;
const escposCmd = receiptline.commands.escpos;

const printerConfig = {
    cpl: 42,
    encoding: 'multilingual',
    spacing: true,
    command: escposCmd
};

console.log('--- Config: Command Object ---');
const res = receiptline.transform(content, { printer: printerConfig });
console.log('Type:', typeof res);
if (typeof res === 'string') {
    if (res.trim().startsWith('<')) {
        console.log('Result is SVG');
    } else {
        console.log('Result is String (likely binary)');
        const buf = Buffer.from(res, 'binary');
        console.log('Buffer hex:', buf.toString('hex'));
    }
}
