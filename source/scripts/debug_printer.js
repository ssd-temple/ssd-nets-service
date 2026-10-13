const printer = require('node-printer');
console.log('Exports:', Object.keys(printer));
console.log('Type of printer:', typeof printer);
if (typeof printer === 'object') {
    console.log('Keys:', Object.keys(printer));
}
try {
    console.log('GetPrinters:', printer.getPrinters());
} catch (e) {
    console.log('getPrinters failed:', e.message);
}
