const escpos = require('escpos');

// Mock Adapter
class BufferAdapter extends escpos.Adapter {
    constructor() {
        super();
        this.buffer = [];
    }
    open(callback) {
        if (callback) callback();
    }
    write(data, callback) {
        this.buffer.push(data);
        if (callback) callback();
    }
    close(callback) {
        if (callback) callback();
    }
    getBuffer() {
        return Buffer.concat(this.buffer);
    }
}

try {
    const device = new BufferAdapter();
    const printer = new escpos.Printer(device);

    printer
        .font('a')
        .align('ct')
        .style('bu')
        .size(1, 1)
        .text('RECEIPT')
        .text('2026-01-10')
        .table(['Item', 'Qty', 'Price']) // escpos 2.x supports table?
        .cut();

    // In escpos 2.x, operations are queued. We need to wait or flush?
    // Actually printer methods usually define the buffer immediately in current implementation?
    // Let's check buffer.

    // We might need to call printer.flush() or similar logic?
    // printer.close() calls adapter.close().

    printer.close();

    const buf = device.getBuffer();
    console.log('Buffer generated. Length:', buf.length);
    console.log('Hex:', buf.slice(0, 20).toString('hex'));

} catch (e) {
    console.error('Error:', e);
}
