/**
 * Pure-mapping tests for ssdTicketBuilder.js — no printer, no filesystem,
 * no network. Verifies the SSD-Backend ticket-groups shape maps correctly
 * into printService.printJSON's receipts[] shape.
 */
const { buildReceiptsFromTicketGroups } = require("../ssdTicketBuilder");

function sampleTicketData(overrides = {}) {
  return {
    ticketGroups: [
      {
        splitType: "GROUP",
        printGroupId: "gA",
        printGroupName: "Group A",
        deityId: null,
        deityName: null,
        lines: [
          {
            name: "Archana",
            tamilName: "அர்ச்சனை",
            quantity: 1,
            unitPrice: 10,
            lineTotal: 10,
            deityName: "Murugan",
            deityTamilName: "முருகன்",
            devotees: [{ name: "Arun", nakshatra: "Ardra" }],
          },
          {
            name: "Archana",
            tamilName: "அர்ச்சனை",
            quantity: 1,
            unitPrice: 10,
            lineTotal: 10,
            deityName: "Durga",
            deityTamilName: "துர்கா",
            devotees: [{ name: "Anjali", nakshatra: "Rohini" }],
          },
        ],
      },
    ],
    receipt: { receiptNo: "RCP-20260905-0001", bookingNumber: "BKG202609050001", printedAt: "2026-09-05T07:35:00.000Z" },
    temple: { name: "Sri Siva Durga Temple", tamilName: "ஸ்ரீ சிவ துர்க்கா ஆலயம்" },
    customer: { name: "Sundar" },
    splitMode: "PRINT_GROUP_WISE",
    ...overrides,
  };
}

describe("buildReceiptsFromTicketGroups", () => {
  test("maps one ticket group into one receipt entry, with no temple name or ticket heading fields", () => {
    const receipts = buildReceiptsFromTicketGroups(sampleTicketData());
    expect(receipts).toHaveLength(1);
    expect(receipts[0].receiptId).toBe("RCP-20260905-0001");
    expect(receipts[0].isReprint).toBe(false);
    // The logo already identifies the temple, and the print-group/deity
    // heading is now shown per item instead — see ssdTicketBuilder.js.
    expect(receipts[0]).not.toHaveProperty("templeName");
    expect(receipts[0]).not.toHaveProperty("templeTamilName");
    expect(receipts[0]).not.toHaveProperty("ticketHeading");
    expect(receipts[0]).not.toHaveProperty("ticketHeadingTamil");
  });

  test("keeps item name and deity name as separate fields, each with its own devotees", () => {
    const receipts = buildReceiptsFromTicketGroups(sampleTicketData());
    expect(receipts[0].items).toEqual([
      {
        name: "Archana",
        tamilName: "அர்ச்சனை",
        deityName: "Murugan",
        deityTamilName: "முருகன்",
        quantity: 1,
        total: "10.00",
        devotees: [{ name: "Arun", nakshatra: "Ardra" }],
      },
      {
        name: "Archana",
        tamilName: "அர்ச்சனை",
        deityName: "Durga",
        deityTamilName: "துர்கா",
        quantity: 1,
        total: "10.00",
        devotees: [{ name: "Anjali", nakshatra: "Rohini" }],
      },
    ]);
  });

  test("marks every receipt isReprint when options.isReprint is set", () => {
    const receipts = buildReceiptsFromTicketGroups(sampleTicketData(), { isReprint: true });
    expect(receipts[0].isReprint).toBe(true);
  });

  test("throws rather than printing nothing when there are zero ticket groups", () => {
    expect(() => buildReceiptsFromTicketGroups(sampleTicketData({ ticketGroups: [] }))).toThrow(/No ticket groups/);
  });

  test("Print Group Wise -> Deity Wise example from the spec: 2 tickets in, 2 receipts out", () => {
    const twoTicketData = sampleTicketData({
      ticketGroups: [
        { splitType: "GROUP", printGroupId: "gA", printGroupName: "Group A", lines: [{ name: "Archana", quantity: 1, unitPrice: 10, lineTotal: 10, deityName: "Murugan", devotees: [] }] },
        { splitType: "GROUP", printGroupId: "gB", printGroupName: "Group B", lines: [{ name: "Archana", quantity: 1, unitPrice: 5, lineTotal: 5, deityName: "Vinayagar", devotees: [] }] },
      ],
    });
    const receipts = buildReceiptsFromTicketGroups(twoTicketData);
    expect(receipts).toHaveLength(2);
    expect(receipts.map((r) => r.items[0].deityName)).toEqual(["Murugan", "Vinayagar"]);
  });

  test("an item with no devotees on its line gets an empty devotees array, not undefined", () => {
    const noDevoteeTicket = sampleTicketData({
      ticketGroups: [
        { splitType: "GROUP", printGroupId: "gC", printGroupName: "Group C", lines: [{ name: "Special Offering", quantity: 1, unitPrice: 5, lineTotal: 5 }] },
      ],
    });
    const receipts = buildReceiptsFromTicketGroups(noDevoteeTicket);
    expect(receipts[0].items[0].devotees).toEqual([]);
    expect(receipts[0].items[0].deityName).toBe("");
  });

  test("carries an item picture url only when the backend sent one, so a line without it is unchanged", () => {
    const data = sampleTicketData();
    data.ticketGroups[0].lines[0].imageUrl = " https://example.com/coconut.png ";
    const receipts = buildReceiptsFromTicketGroups(data);
    expect(receipts[0].items[0].imageUrl).toBe("https://example.com/coconut.png");
    expect(receipts[0].items[1]).not.toHaveProperty("imageUrl");
  });

  test("each reprinted ticket carries its own reprint number, falling back to the job-wide one", () => {
    const data = sampleTicketData();
    data.ticketGroups.push({ ...data.ticketGroups[0], lines: [data.ticketGroups[0].lines[0]] });
    data.ticketGroups[0].reprintNumber = 4;
    const receipts = buildReceiptsFromTicketGroups(data, { isReprint: true, reprintNumber: 1 });
    expect(receipts[0].reprintNumber).toBe(4);
    expect(receipts[1].reprintNumber).toBe(1);
  });

  test("a reprint carries its number for the REPRINT #n banner; a normal print carries none", () => {
    const reprint = buildReceiptsFromTicketGroups(sampleTicketData(), { isReprint: true, reprintNumber: 3 });
    expect(reprint[0].isReprint).toBe(true);
    expect(reprint[0].reprintNumber).toBe(3);
    const normal = buildReceiptsFromTicketGroups(sampleTicketData(), { reprintNumber: 3 });
    expect(normal[0].isReprint).toBe(false);
    expect(normal[0].reprintNumber).toBeNull();
  });
});
