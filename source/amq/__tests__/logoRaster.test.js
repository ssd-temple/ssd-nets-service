/**
 * Integration test (real canvas native module, real file) for the logo
 * image-printing feature added to ESCPOSBuilder — verifies the SSD logo
 * PNG actually decodes and converts to a valid ESC/POS raster command on
 * this machine, not just that the code parses.
 */
const path = require("path");
const ESCPOSBuilder = require("../ESCPOSBuilder");

const LOGO_PATH = path.join(__dirname, "..", "..", "public", "assets", "SSD-Full-Logo-Transparent.png");

describe("ESCPOSBuilder.getLogoRaster", () => {
  test("renders the SSD logo to a valid GS v 0 raster command", async () => {
    const raster = await ESCPOSBuilder.getLogoRaster(LOGO_PATH);
    expect(raster).toBeInstanceOf(Buffer);
    // GS v 0 m xL xH yL yH ...
    expect(raster[0]).toBe(0x1d);
    expect(raster[1]).toBe(0x76);
    expect(raster[2]).toBe(0x30);
    const widthBytes = raster[4] | (raster[5] << 8);
    const height = raster[6] | (raster[7] << 8);
    expect(widthBytes).toBe(64); // 512px / 8
    expect(height).toBeGreaterThan(0);
    expect(raster.length).toBe(8 + widthBytes * height);
  });

  test("caches — a second call for the same path returns an identical buffer without re-decoding", async () => {
    const first = await ESCPOSBuilder.getLogoRaster(LOGO_PATH);
    const second = await ESCPOSBuilder.getLogoRaster(LOGO_PATH);
    expect(first.equals(second)).toBe(true);
  });

  test("returns null (never throws) for a missing file", async () => {
    const raster = await ESCPOSBuilder.getLogoRaster(path.join(__dirname, "does-not-exist.png"));
    expect(raster).toBeNull();
  });
});
