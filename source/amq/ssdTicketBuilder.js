// Maps SSD-Backend's resolved ticket-groups response (the ticketGroups
// embedded in POST /payments/nets/callback's response, or a GET
// /pos/bookings/:id/ticket-groups call — see ssdBackendClient.js) into the
// receipts[] shape printService.printJSON already understands (see
// printService.js's buildReceipt). Pure mapping, no I/O and no printing
// itself — kept separate from ticketPrinter.js's actual print orchestration
// so this can be unit-tested on its own, the same split
// common/utils/ticket-grouping.js draws on the SSD-Backend side between
// "resolve the structure" and "do something with it".
//
// One entry in the returned array = one physical ticket/cut — the grouping
// itself (Deity Wise vs Print Group Wise) already happened on SSD-Backend
// (see its ticket-grouping.js); this only decides how one resolved
// TicketGroup renders on paper.

const { getFormattedDateTime, getReceiptDateTime } = require('./receiptDateTime');

const SESSION_LABEL = { AM: 'Morning', PM: 'Evening' };

// "2026-10-28" + "AM" -> "28/10/2026 (Morning)". Empty string when the line has
// no session date, so the ticket simply omits the "Session Date" line.
function formatSessionText(line) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(line.sessionDate || ''));
  if (!m) return '';
  const date = `${m[3]}/${m[2]}/${m[1]}`;
  return line.session ? `${date} (${SESSION_LABEL[line.session] || line.session})` : date;
}

// One booking line fanned out over several deities arrives as one ticket line
// per deity (each with a share of the qty/amount). Same service + session +
// devotees = one printed row: qty/amount summed back, deities listed under it.
function mergeSameService(items) {
  const merged = [];
  const byKey = new Map();
  for (const item of items) {
    const key = JSON.stringify([item.name, item.sessionText || '', item.imageUrl || '', item.devotees]);
    const existing = byKey.get(key);
    if (!existing) {
      const first = { ...item, deityTamilNames: item.deityTamilName ? [item.deityTamilName] : [], _cents: Math.round(Number(item.total) * 100) };
      byKey.set(key, first);
      merged.push(first);
      continue;
    }
    existing.quantity = Number(existing.quantity || 0) + Number(item.quantity || 0);
    existing._cents += Math.round(Number(item.total) * 100);
    if (item.deityTamilName && !existing.deityTamilNames.includes(item.deityTamilName)) existing.deityTamilNames.push(item.deityTamilName);
  }
  return merged.map(({ _cents, deityTamilNames, ...rest }) => ({
    ...rest,
    ...(deityTamilNames.length > 1 ? { deityTamilNames } : {}),
    total: (_cents / 100).toFixed(2),
  }));
}

/**
 * @param {object} ticketData  { ticketGroups, receipt, temple, customer, splitMode }
 * @param {{ isReprint?: boolean, reprintNumber?: number, paymentMethod?: string, gstNumber?: string }} [options]
 * @returns {Array<object>} receipts[] entries for printService.printJSON
 */
function buildReceiptsFromTicketGroups(ticketData, options = {}) {
  const { ticketGroups, receipt, temple } = ticketData || {};
  if (!Array.isArray(ticketGroups) || ticketGroups.length === 0) {
    throw new Error('No ticket groups to print — the backend resolved zero tickets for this booking.');
  }

  const printedAt = getFormattedDateTime();

  const dateTime = getReceiptDateTime();

  return ticketGroups.map((group, index) => {
    return {
      receiptId: receipt?.receiptNo || receipt?.bookingNumber || '',
      gstNumber: options.gstNumber || '',
      date: printedAt,
      // "Date & Time:" header line, and "(Page n/N)" after the receipt number.
      dateTime,
      // English heading printed under the Date & Time line: the Print Group name, or the deity name
      // when the split setting is Deity Wise (splitType "DEITY").
      printGroupName: String((group.splitType === 'DEITY' ? group.deityName : group.printGroupName) || group.printGroupName || group.deityName || '').trim(),
      pageNo: index + 1,
      pageTotal: ticketGroups.length,
      // No templeName/templeTamilName/ticketHeading here on purpose — the
      // logo at the top of the ticket already identifies the temple, and
      // the print-group/deity heading that used to sit above the items is
      // now shown per item instead (each item carries its own deityName
      // below), so a separate ticket-level heading would just repeat it.
      isReprint: Boolean(options.isReprint),
      // Which reprint this is (1st, 2nd, ...), printed in the banner: "*** REPRINT #2 ***".
      // Each ticket carries its OWN reprint number (group.reprintNumber, set by the Reprint popup from that ticket's
      // count); a job-wide options.reprintNumber is only the fallback.
      reprintNumber: options.isReprint
        ? Number(group.reprintNumber) > 0
          ? Number(group.reprintNumber)
          : Number(options.reprintNumber) > 0
            ? Number(options.reprintNumber)
            : null
        : null,
      // Backend-computed sum of this ticket's own lines (ticket-grouping.js's
      // groupUnitsByKey) — printed only when there's more than one item (see
      // printService.js/receiptImageGenerator.js), since a single-item
      // ticket's one line total already is the total. Carried through as a
      // plain number rather than re-summed here so a rounding edge case
      // (a line total split unevenly across several deities) can't ever
      // print a "Total" that disagrees with the line amounts above it.
      total: typeof group.total === 'number' ? group.total : null,
      items: mergeSameService((group.lines || []).map((line) => ({
        name: line.name,
        tamilName: line.tamilName || '',
        // Kept separate from `name` (previously concatenated into one
        // string) so the printed ticket can show the item/service name and
        // the specific deity it was offered to as their own lines, with
        // that deity's devotees nested directly under it — see
        // printService.js/receiptImageGenerator.js's ITEMS block.
        deityName: line.deityName || '',
        deityTamilName: line.deityTamilName || '',
        // Present only when SSD-Backend decided this offering's picture should print (both "print image"
        // switches on and a picture exists) - see amq/ticketImages.js. Absent/empty = no picture.
        ...(typeof line.imageUrl === 'string' && line.imageUrl.trim() ? { imageUrl: line.imageUrl.trim() } : {}),
        // "28/10/2026 (Morning)" — only present when the line has a session
        // date; otherwise the ticket prints no "Session Date" line for it.
        ...(formatSessionText(line) ? { sessionText: formatSessionText(line) } : {}),
        quantity: line.quantity,
        total: Number(line.lineTotal || 0).toFixed(2),
        devotees: (line.devotees || []).map((d) => ({ name: d.name, nakshatra: d.nakshatra })),
      }))),
      payment: { method: options.paymentMethod || 'NETS' },
    };
  });
}

module.exports = { buildReceiptsFromTicketGroups };
