const { createLogger, format, transports } = require("winston");
const DailyRotateFile = require("winston-daily-rotate-file");

const { combine, timestamp, label, printf } = format;
const path = require("path");

const getLabel = (callingModule) => {
  if (!callingModule || !callingModule.filename) {
    return "unknown";
  }
  const parts = callingModule.filename.split(path.sep);
  return path.join(parts[parts.length - 1], parts.pop());
};

const myFormat = printf(({ level, message, label, timestamp }) => {
  const versionPrefix = global.appVersion ? `[v${global.appVersion}] ` : "";
  return `${timestamp} [${label}] ${versionPrefix}${level}: ${message}`;
});

const logger = (module) =>
  createLogger({
    format: combine(label({ label: getLabel(module) }), timestamp(), myFormat),
    transports: [
      new transports.Console(),
      new DailyRotateFile({
        filename: "log/platform-access-%DATE%.log",
        datePattern: "YYYY-MM-DD",
        zippedArchive: true,
        maxSize: "20m",
        maxFiles: "14d",
        level: "info",
      }),
      new DailyRotateFile({
        filename: "log/platform-error-%DATE%.log",
        datePattern: "YYYY-MM-DD",
        zippedArchive: true,
        maxSize: "20m",
        maxFiles: "14d",
        level: "error",
      }),
    ],
  });

module.exports = logger;
