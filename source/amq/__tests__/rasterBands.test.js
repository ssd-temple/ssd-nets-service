/**
 * The garbled-ticket failure was a GS v 0 band bigger than the printer's
 * receive buffer: the header (first band) printed, and every later byte
 * came out as characters. These checks lock the band size and the reset
 * byte that each job now starts with.
 */
const { createCanvas } = require("canvas");
const ESCPOSBuilder = require("../ESCPOSBuilder");

function readRasters(buf) {
  const rasters = [];
  let i = 0;
  while (i < buf.length) {
    if (buf[i] === 0x1d && buf[i + 1] === 0x76 && buf[i + 2] === 0x30) {
      const widthBytes = buf[i + 4] | (buf[i + 5] << 8);
      const height = buf[i + 6] | (buf[i + 7] << 8);
      const dataLen = widthBytes * height;
      rasters.push({ widthBytes, height, dataLen, at: i });
      i += 8 + dataLen;
      continue;
    }
    if (buf[i] === 0x1b && buf[i + 1] === 0x4a && buf[i + 2] === 0x00) {
      i += 3;
      continue;
    }
    throw new Error(`unexpected byte 0x${buf[i].toString(16)} at ${i}`);
  }
  return rasters;
}

describe("ESCPOSBuilder.canvasToRaster", () => {
  test("splits a 544-dot ticket into image commands that fit a small receive buffer", () => {
    const canvas = createCanvas(544, 800);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, 544, 800);
    ctx.fillStyle = "#000000";
    ctx.fillRect(10, 400, 200, 30);

    const buf = ESCPOSBuilder.canvasToRaster(canvas);
    const rasters = readRasters(buf);

    expect(rasters.length).toBeGreaterThan(1);
    expect(rasters.reduce((sum, r) => sum + r.height, 0)).toBe(800);
    for (const r of rasters) {
      expect(r.widthBytes).toBe(68);
      expect(r.dataLen).toBeLessThanOrEqual(ESCPOSBuilder.MAX_RASTER_DATA_BYTES);
      expect(r.height % 256).not.toBe(0);
    }
  });

  test("a ticket shorter than one band is a single image command", () => {
    const canvas = createCanvas(544, 20);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, 544, 20);

    const rasters = readRasters(ESCPOSBuilder.canvasToRaster(canvas));
    expect(rasters).toHaveLength(1);
    expect(rasters[0].height).toBe(20);
  });
});

describe("ESCPOSBuilder.initialize", () => {
  test("sends ESC @ before the character-table select", () => {
    const buf = new ESCPOSBuilder().initialize().characterSet(0).codePage(0).getBuffer();
    expect(buf[0]).toBe(0x1b);
    expect(buf[1]).toBe(0x40);
  });
});
