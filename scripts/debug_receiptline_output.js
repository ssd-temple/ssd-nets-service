const receiptline = require('receiptline');

const content = `
{c:Test Receipt}
{c:Hello World}
{c:----------------}
^^
`;

console.log('--- Config: { printer: "epson" } ---');
const res1 = receiptline.transform(content, { printer: 'epson' });
console.log('Type:', typeof res1);
console.log('Is Buffer:', Buffer.isBuffer(res1));

console.log('--- Config: { command: "epson" } ---');
const res2 = receiptline.transform(content, { command: 'epson' });
console.log('Type:', typeof res2);
console.log('Is Buffer:', Buffer.isBuffer(res2));

console.log('--- Config: { printer: "tm_series1" } ---');
const res4 = receiptline.transform(content, { printer: 'tm_series1' });
console.log('Type:', typeof res4);
console.log('Is Buffer:', Buffer.isBuffer(res4));
console.log('Content Start:', res4.substring(0, 50));
console.log('Is SVG?', res4.trim().startsWith('<'));

