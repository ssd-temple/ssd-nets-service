const receiptline = require('receiptline');
let printer;
try {
    printer = require('node-printer');
} catch (e) {
    console.error('Failed to require node-printer:', e.message);
}

console.log('--- Checking Dependencies ---');
console.log('receiptline:', typeof receiptline);
console.log('node-printer loaded:', !!printer);

if (printer) {
    console.log('node-printer type:', typeof printer);
    console.log('node-printer keys:', Object.keys(printer));
}

const doc = `
{c:Test Receipt}
{c:Hello World}
{c:----------------}
^^
`; // Added cut command ^^

console.log('--- Generating Buffer ---');
const buffer = receiptline.transform(doc, { printer: 'epson' });
console.log('Buffer generated, length:', buffer.length);

console.log('--- Attempting Print ---');
const printerName = 'EPSON-TM-T82';

if (printer && typeof printer.printDirect === 'function') {
    try {
        console.log(`Printing to ${printerName}...`);
        printer.printDirect({
            data: buffer,
            printer: printerName,
            type: 'RAW',
            success: function (jobID) {
                console.log("SUCCESS: Sent to printer with ID: " + jobID);
            },
            error: function (err) {
                console.log("ERROR: " + err);
            }
        });
    } catch (e) {
        console.error('Exception during printDirect:', e.message);
    }
} else {
    console.log('WARN: printer.printDirect is not available. Cannot print RAW.');
    if (printer) {
        // Try to find if it's imported differently
        // Sometimes it requires 'node-printer/lib_os' or similar?
        // No, standardized package usually works.
    }
}
