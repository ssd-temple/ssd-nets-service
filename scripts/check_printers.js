const printer = require('node-printer');
const escpos = require('escpos');
escpos.USB = require('escpos-usb');

console.log('--- node-printer list ---');
try {
    const printers = printer.getPrinters();
    console.log(JSON.stringify(printers, null, 2));
} catch (e) {
    console.error('node-printer error:', e.message);
}

console.log('--- escpos-usb find ---');
try {
    const device = new escpos.USB();
    console.log('USB Device found:', device);
} catch (e) {
    console.error('escpos-usb error (might mean no device found or driver needed):', e.message);
}
