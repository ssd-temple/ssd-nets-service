const ESCPOSBuilder = require('../amq/ESCPOSBuilder');

const builder = new ESCPOSBuilder();
const buffer = builder
    .align('center')
    .size(2, 2)
    .text('RECEIPT')
    .newline()
    .size(1, 1)
    .newline()
    .text('2026-01-10')
    .newline()
    .align('left')
    .table(
        [
            { width: 20, align: 'left' },
            { width: 10, align: 'center' },
            { width: 10, align: 'right' }
        ],
        [
            ['Item A', '1', '100'],
            ['Item B', '2', '200']
        ]
    )
    .newline()
    .align('center')
    .barcode('123456')
    .cut()
    .getBuffer();

console.log('Buffer length:', buffer.length);
console.log('Hex:', buffer.slice(0, 50).toString('hex'));
