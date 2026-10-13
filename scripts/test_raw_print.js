const receiptline = require('receiptline');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Define printer name
const PRINTER_NAME = 'EPSON-TM-T82';
const OUTPUT_FILE = path.join(__dirname, 'test_receipt.bin');

// Sample Receipt
const doc = `
{c:Test Raw Print}
{c:Works with receiptline!}
{c:----------------}
^^
`; // ^^ is cut command in receiptline for some printers, or we might need explicit hex

console.log('--- Generating Buffer ---');
const buffer = receiptline.transform(doc, { printer: 'epson' });

// Write to file
fs.writeFileSync(OUTPUT_FILE, buffer);
console.log(`Wrote ${buffer.length} bytes to ${OUTPUT_FILE}`);

// Call PowerShell script
const psScript = path.join(__dirname, 'Send-RawPrint.ps1');
const command = 'powershell';
const args = ['-ExecutionPolicy', 'Bypass', '-File', psScript, PRINTER_NAME, OUTPUT_FILE];

console.log(`Executing: ${command} ${args.join(' ')}`);

const child = spawn(command, args);

child.stdout.on('data', (data) => {
    console.log(`PS stdout: ${data}`);
});

child.stderr.on('data', (data) => {
    console.error(`PS stderr: ${data}`);
});

child.on('close', (code) => {
    console.log(`PS process exited with code ${code}`);
    if (code === 0) {
        console.log('✅ Test Print Successfully Sent!');
    } else {
        console.log('❌ Test Print Failed.');
    }
});
