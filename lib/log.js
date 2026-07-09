// Tiny logger: writes timestamped lines to both the console and a log file so
// you can see what the reviewer is doing (and tail it with `tail -f`).
const fs = require("fs");
const path = require("path");

const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, "..", "ranked-reviews.log");

function fmt(args) {
  return args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${fmt(args)}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // never let logging crash the app
  }
}

// Return the last `n` lines of the log file (for the /api/log endpoint).
function tail(n = 300) {
  try {
    const text = fs.readFileSync(LOG_FILE, "utf8");
    const lines = text.split("\n").filter(Boolean);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

module.exports = { log, tail, LOG_FILE };
