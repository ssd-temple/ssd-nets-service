/**
 * Integration test (real canvas, real logo file) for the debug/preview
 * receipt image generator — this is what lets the SSD Nets-Service EXE be
 * "viewed" on a machine with no thermal printer attached (see
 * printService.js's printJSON, which now generates this regardless of
 * whether the physical print itself succeeds). Verifies the same sections
 * printService.js's buildReceipt() prints (logo, per-item deity name,
 * per-item devotee block) are actually present in the generated PNG, not
 * just that it doesn't throw. No templeName/ticketHeading here — the logo
 * already identifies the temple, and there is no ticket-level heading
 * anymore (see printService.js/ssdTicketBuilder.js for why).
 */
const fs = require("fs");
const receiptImageGenerator = require("../receiptImageGenerator");

describe("receiptImageGenerator.generate", () => {
  test("produces a real PNG file containing the logo, per-item deity name, and per-item devotee block", async () => {
    const outPath = await receiptImageGenerator.generate({
      receiptId: "RCP-TEST-0001",
      items: [
        {
          name: "Fruit Archanai",
          tamilName: "பழம் அர்ச்சனை",
          deityName: "Vinayagar",
          deityTamilName: "விநாயகர்",
          quantity: 1,
          total: "10.00",
          devotees: [{ name: "Sundar", nakshatra: "Rohini" }],
        },
      ],
      payment: { method: "NETS" },
    });

    expect(outPath).toBeTruthy();
    expect(fs.existsSync(outPath)).toBe(true);
    const stat = fs.statSync(outPath);
    expect(stat.size).toBeGreaterThan(1000); // a real rendered PNG, not an empty/near-empty file
    fs.unlinkSync(outPath); // this test's own artifact, not a fixture to leave behind
  });

  test("does not throw when deityName/devotees are absent (old-style HEB payload shape)", async () => {
    const outPath = await receiptImageGenerator.generate({
      receiptId: "RCP-TEST-0002",
      items: [{ name: "Archana", quantity: 1, total: "10.00" }],
      payment: { method: "Cash" },
    });
    expect(fs.existsSync(outPath)).toBe(true);
    fs.unlinkSync(outPath);
  });

  test("does not throw with HEB's own item.familMemberDetails shape instead of SSD's item.devotees", async () => {
    const outPath = await receiptImageGenerator.generate({
      receiptId: "RCP-TEST-0003",
      items: [
        {
          name: "Archana",
          quantity: 1,
          total: "10.00",
          familMemberDetails: [{ name: "Sundar", star: "Rohini" }],
        },
      ],
      payment: { method: "Cash" },
    });
    expect(fs.existsSync(outPath)).toBe(true);
    fs.unlinkSync(outPath);
  });
});
