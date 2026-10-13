try {
    const MutableBuffer = require('mutable-buffer');
    console.log('Type:', typeof MutableBuffer);
    console.log('Keys:', Object.keys(MutableBuffer));
    console.log('Constructor?', MutableBuffer.prototype ? 'Yes' : 'No');
    // Try to instantiate
    const mb = new MutableBuffer();
    console.log('Instantiated successfully');
} catch (e) {
    console.error('Error:', e);
}
