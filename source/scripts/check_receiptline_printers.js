const fs = require('fs');
const path = require('path');

const printersPath = path.join(__dirname, '..', 'node_modules', 'receiptline', 'printers.json');
try {
    const data = fs.readFileSync(printersPath, 'utf8');
    const printers = JSON.parse(data);
    console.log('Keys:', Object.keys(printers));
    if (printers.epson) {
        console.log('EPSON config:', printers.epson);
    } else {
        console.log('No "epson" key found.');
    }

    // Look for anything with escpos
    for (const key in printers) {
        if (JSON.stringify(printers[key]).toLowerCase().includes('escpos')) {
            console.log(`Found escpos in ${key}:`, printers[key]);
        }
    }
} catch (e) {
    console.error(e);
}
