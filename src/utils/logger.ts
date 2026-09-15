import winston from "winston";
import path from "path";
import config from "../config";

const { combine, timestamp, printf, colorize, json } = winston.format;

const consoleFormat = printf(({ level, message, timestamp, requestId, ...meta }) => {
  const reqIdStr = requestId ? `[${requestId}] ` : "";
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
  return `${timestamp} ${level}: ${reqIdStr}${message}${metaStr}`;
});

const logger = winston.createLogger({
  level: config.env === "development" ? "debug" : "info",
  format: combine(
    timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    config.env === "production" ? json() : combine(colorize(), consoleFormat)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: path.join("logs", "error.log"),
      level: "error",
    }),
    new winston.transports.File({
      filename: path.join("logs", "combined.log"),
    }),
  ],
});

export default logger;
