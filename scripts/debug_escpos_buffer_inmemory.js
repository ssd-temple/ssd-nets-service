const { InMemory, Printer, Model } = require('escpos-buffer');

(async () => {
    try {
        const connection = new InMemory();
        const printer = new Printer(connection);
        console.log('Printer keys:', Object.keys(printer));
        console.log('Printer prototype keys:', Object.getOwnPropertyNames(Object.getPrototypeOf(printer)));
        await printer.writeln('Hello World');
        await printer.cutter();
        await printer.close();

        console.log('Connection keys:', Object.keys(connection));

        // Assume 'buffer' property or method
        if (connection.buffer) {
            const buf = typeof connection.buffer === 'function' ? connection.buffer() : connection.buffer;
            console.log('Buffer found. Length:', buf.length);
            console.log('Hex:', buf.slice(0, 20).toString('hex'));
        } else {
            console.log('No buffer property found directly.');
        }

    } catch (e) {
        console.error(e);
    }
})();
