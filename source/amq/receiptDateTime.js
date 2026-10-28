// Shared Singapore-timezone timestamp formatter for receipt printing.
//
// Pulled out of printService.js/receiptImageGenerator.js because both files
// independently computed a "Reprinted:" timestamp with `new Date()` and no
// explicit timeZone — which silently falls back to whatever timezone the
// host OS/process happens to be running in. On kiosk PCs whose OS clock is
// set to India time instead of Singapore, that produced a "Reprinted:" line
// off by the SGT/IST offset. Keeping a single implementation here means the
// two print paths can't drift out of sync on this again.
const SGT_TIMEZONE = 'Asia/Singapore';

function getFormattedDateTime() {
    const now = new Date();

    // Format Date: DD/MM/YYYY
    const datePart = new Intl.DateTimeFormat('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        timeZone: SGT_TIMEZONE
    }).format(now);

    // Format Time: hh.mmAM/PM
    const timePart = new Intl.DateTimeFormat('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
        timeZone: SGT_TIMEZONE
    }).formatToParts(now);

    const hour = timePart.find(p => p.type === 'hour')?.value ?? '12';
    const minute = timePart.find(p => p.type === 'minute')?.value ?? '00';
    const dayPeriod = (timePart.find(p => p.type === 'dayPeriod')?.value ?? 'AM').toUpperCase();

    return `${datePart} ${hour}.${minute}${dayPeriod}`;
}

// "DD/MM/YYYY hh:mm AM" in Singapore time — the "Date & Time:" line of the ticket header.
function getReceiptDateTime() {
    const parts = new Intl.DateTimeFormat('en-US', {
        month: '2-digit',
        day: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
        timeZone: SGT_TIMEZONE
    }).formatToParts(new Date());
    const get = (type) => parts.find(p => p.type === type)?.value ?? '';
    return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')} ${get('dayPeriod').toUpperCase()}`;
}

module.exports = { getFormattedDateTime, getReceiptDateTime, SGT_TIMEZONE };
