const receiptline = require('receiptline');

console.log('--- Inspecting receiptline.commands.escpos ---');
const escpos = receiptline.commands.escpos;
console.log('Type:', typeof escpos);
console.log('Keys:', Object.keys(escpos));
// print a few properties
console.log('init:', escpos.init);
