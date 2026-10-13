// Pictures printed under an item / service / general item / event on a ticket.
//
// SSD-Backend decides whether a line gets a picture (Print Split Setting's
// "Print image on ticket" AND the offering master's own "Print Image on Ticket",
// AND the record actually has a picture) and, only then, puts an `imageUrl` on
// that ticket line (see SSD-Backend's common/utils/ticket-image.js). This
// service never decides that itself: no `imageUrl` on a line = nothing is
// downloaded and the ticket prints exactly as it always did.
//
// A picture that cannot be fetched or decoded (offline, 404, corrupt file, no
// canvas) is skipped with a log line - a missing picture must never fail or
// delay a ticket for long, so every download has a short timeout.

const http = require('http');
const https = require('https');
const axios = require('axios');
const logger = require('nets-service-sdk').logger(module);

const FETCH_TIMEOUT_MS = 6000;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_CACHED = 40;

const httpAgent = new http.Agent({ family: 4 });
const httpsAgent = new https.Agent({ family: 4 });

// url -> Buffer. The same offering is printed over and over (and every ticket of a
// multi-deity booking asks for it again), so a small in-memory cache saves the
// download. A failed fetch is not cached, so the next ticket tries again.
const cache = new Map();

function remember(url, buffer) {
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value);
  cache.set(url, buffer);
}

async function fetchImageBuffer(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) return null;
  if (cache.has(url)) return cache.get(url);
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: FETCH_TIMEOUT_MS,
    maxContentLength: MAX_IMAGE_BYTES,
    maxBodyLength: MAX_IMAGE_BYTES,
    httpAgent,
    httpsAgent,
    validateStatus: (s) => s >= 200 && s < 300,
  });
  const buffer = Buffer.from(response.data);
  if (buffer.length === 0) return null;
  remember(url, buffer);
  return buffer;
}

/**
 * Downloads (in parallel) the picture of every item that carries an `imageUrl` and hangs the bytes
 * off the item as a NON-enumerable `_imageBuffer`, so the receipt can still be JSON-serialised (the
 * pending-print queue stores receipts as JSON and only keeps the url).
 *
 * Never throws: an item whose picture fails simply has no `_imageBuffer` and prints without one.
 *
 * @param {Array<object>} receipts  receipts[] as built by ssdTicketBuilder.js
 */
async function attachImages(receipts) {
  const jobs = [];
  for (const receipt of receipts || []) {
    for (const item of (receipt && receipt.items) || []) {
      const url = item && typeof item.imageUrl === 'string' ? item.imageUrl.trim() : '';
      if (!url) continue;
      jobs.push(
        fetchImageBuffer(url)
          .then((buffer) => {
            if (buffer) Object.defineProperty(item, '_imageBuffer', { value: buffer, enumerable: false, configurable: true });
          })
          .catch((err) => {
            logger.warn({ level: 'warn', message: `Ticket image skipped for "${item.name || 'item'}": could not download ${url} (${err.message}).` });
          })
      );
    }
  }
  if (jobs.length > 0) await Promise.all(jobs);
}

module.exports = { attachImages, fetchImageBuffer };
