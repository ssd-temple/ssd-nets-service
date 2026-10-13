const EscPosEncoder = require('escpos-buffer');

try {
    const encoder = new EscPosEncoder();
    const result = encoder
        .initialize()
        .align('center')
        .text('RECEIPT')
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
                ['Service Booking', '1', '1500'],
                ['Extra Accessories', '2', '500']
            ]
        )
        .newline()
        .line('--------------------------------')
        .newline()
        .table(
            [
                { width: 30, align: 'left' },
                { width: 10, align: 'right' }
            ],
            [
                ['Total', '2360']
            ]
        )
        .newline()
        .barcode('RCPT-1001', 'code128')
        .cut()
        .encode();

    console.log('Result Type:', typeof result);
    console.log('Is Buffer?', Buffer.isBuffer(result));
    console.log('Length:', result.length);
    console.log('Hex:', result.slice(0, 20).toString('hex'));

} catch (e) {
    console.error('Error:', e);
}
