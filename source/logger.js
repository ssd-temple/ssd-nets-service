const fs = require('fs');
const path = require('path');
const configUtil = require('./configPath');

configUtil.ensureRuntimeDirs();
const logDir = configUtil.getLogDir();

function pad(value) {
  return String(value).padStart(2, '0');
}

function getSingaporeDate(now = new Date()) {
  const utcYear = now.getUTCFullYear();
  const utcMonth = now.getUTCMonth();
  const utcDate = now.getUTCDate();
  const utcHours = now.getUTCHours();
  const utcMinutes = now.getUTCMinutes();
  const utcSeconds = now.getUTCSeconds();

  const singaporeTime = new Date(Date.UTC(utcYear, utcMonth, utcDate, utcHours + 8, utcMinutes, utcSeconds));
  const year = singaporeTime.getUTCFullYear();
  const month = pad(singaporeTime.getUTCMonth() + 1);
  const day = pad(singaporeTime.getUTCDate());
  const hours = pad(singaporeTime.getUTCHours());
  const minutes = pad(singaporeTime.getUTCMinutes());
  const seconds = pad(singaporeTime.getUTCSeconds());

  return {
    date: `${year}-${month}-${day}`,
    timestamp: `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`,
  };
}

function getLogFilePath() {
  const { date } = getSingaporeDate();
  const fileName = `${date}.log`;
  return path.join(logDir, fileName);
}

function formatMessage(level, message, meta) {
  const { timestamp } = getSingaporeDate();
  const metaText = meta && Object.keys(meta).length ? ` | ${JSON.stringify(meta)}` : '';
  return `${timestamp} [${level.toUpperCase()}] ${message}${metaText}\n`;
}

// Every console line the NETS SDK prints (request/status tracing, and -
// critically - one line per raw byte read from the terminal during a
// payment, which is 100+ lines for a single EMV response) gets tee'd
// through here via teeConsole() below. A blocking fs.appendFileSync() per
// line means the app's single JS thread stops to do synchronous disk I/O
// on every single byte the terminal sends back, for however long that
// write happens to take (e.g. antivirus intercepting each new write) -
// right in the middle of the highest-stakes moment there is: reading back
// a payment's approval. A persistent, buffered stream turns that into
// normal non-blocking writes instead. Reused across calls and reopened
// only when the date rolls over, matching getLogFilePath()'s daily files.
let activeStream = null;
let activeStreamDate = null;

function getStream() {
  const { date } = getSingaporeDate();
  if (activeStream && activeStreamDate === date) {
    return activeStream;
  }
  if (activeStream) {
    activeStream.end();
  }
  activeStreamDate = date;
  activeStream = fs.createWriteStream(getLogFilePath(), { flags: 'a' });
  // A stream with no 'error' listener throws on write failure (e.g. disk
  // full, permissions) - that would itself become an uncaught exception,
  // exactly the kind of self-inflicted crash this change is meant to avoid.
  activeStream.on('error', (err) => {
    process.stderr.write(`Logger stream error: ${err.message}\n`);
  });
  return activeStream;
}

function writeToFile(entry) {
  try {
    getStream().write(entry);
  } catch (err) {
    process.stderr.write(`Logger write failed: ${err.message}\n`);
  }
}

// Used only for the uncaughtException path below: that handler calls
// process.exit(1) immediately after logging, with no chance for the
// buffered stream above to flush first. A crash's reason is the one thing
// this logger cannot afford to lose, so that specific call stays a direct,
// guaranteed-synchronous write instead of going through the stream.
function writeToFileSync(entry) {
  try {
    fs.appendFileSync(getLogFilePath(), entry, 'utf8');
  } catch (err) {
    process.stderr.write(`Logger sync write failed: ${err.message}\n`);
  }
}

function log(level, message, meta = {}) {
  const entry = formatMessage(level, message, meta);
  writeToFile(entry);
}

function info(message, meta = {}) {
  log('info', message, meta);
}

function warn(message, meta = {}) {
  log('warn', message, meta);
}

function error(message, meta = {}) {
  log('error', message, meta);
}

function debug(message, meta = {}) {
  log('debug', message, meta);
}

function serializeMeta(value) {
  try {
    const result = JSON.stringify(value);
    return result.length > 10000 ? `${result.slice(0, 10000)}... [truncated]` : result;
  } catch (err) {
    return String(value);
  }
}

function requestLogger(req, res, next) {
  const startTime = Date.now();
  const requestMeta = {
    method: req.method,
    url: req.originalUrl || req.url,
    headers: req.headers,
  };

  if (req.body) {
    requestMeta.body = serializeMeta(req.body);
  }

  let responseBody;
  const originalSend = res.send.bind(res);
  res.send = (body) => {
    responseBody = body;
    return originalSend(body);
  };

  res.on('finish', () => {
    const durationMs = Date.now() - startTime;
    const responseMeta = {
      statusCode: res.statusCode,
      durationMs,
      body: responseBody ? serializeMeta(responseBody) : undefined,
    };
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    log(level, `HTTP ${req.method} ${req.originalUrl || req.url} ${res.statusCode} ${durationMs}ms`, {
      ...requestMeta,
      ...responseMeta,
    });
  });

  next();
}

function logError(err, context = {}) {
  const message = err && err.message ? err.message : String(err);
  const meta = {
    stack: err && err.stack ? err.stack : undefined,
    ...context,
  };
  error(message, meta);
}

function teeConsole() {
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = (chunk, encoding, callback) => {
    try {
      const text = chunk instanceof Buffer ? chunk.toString('utf8') : String(chunk);
      if (text.trim()) {
        log('info', text.trim());
      }
    } catch (err) {
      stderrWrite(`Logger tee stdout failed: ${err.message}\n`);
    }
    return stdoutWrite(chunk, encoding, callback);
  };

  process.stderr.write = (chunk, encoding, callback) => {
    try {
      const text = chunk instanceof Buffer ? chunk.toString('utf8') : String(chunk);
      if (text.trim()) {
        log('error', text.trim());
      }
    } catch (err) {
      stderrWrite(`Logger tee stderr failed: ${err.message}\n`);
    }
    return stderrWrite(chunk, encoding, callback);
  };
}

function handleUncaught() {
  process.on('uncaughtException', (err) => {
    // Deliberately bypasses the buffered stream from writeToFile(): we're
    // about to process.exit(1) with no event-loop turns left for that
    // stream to flush, and losing the one log line that explains why the
    // service just crashed would defeat the entire point of this handler.
    const message = err && err.message ? err.message : String(err);
    const entry = formatMessage('error', message, {
      stack: err && err.stack ? err.stack : undefined,
      event: 'uncaughtException',
    });
    writeToFileSync(entry);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logError(reason, { event: 'unhandledRejection' });
  });
}

module.exports = {
  log,
  info,
  warn,
  error,
  debug,
  requestLogger,
  logError,
  handleUncaught,
  teeConsole,
};
