const receiptline = require('receiptline');

console.log('receiptline keys:', Object.keys(receiptline));
if (receiptline.commands) {
    console.log('receiptline.commands keys:', Object.keys(receiptline.commands));
} else {
    console.log('receiptline.commands is undefined');
}
