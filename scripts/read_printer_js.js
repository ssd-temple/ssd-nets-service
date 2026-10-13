const fs = require('fs');
const path = require('path');
const file = path.join('node_modules', 'escpos', 'printer.js');
const content = fs.readFileSync(file, 'utf8');
console.log(content.substring(0, 500));
