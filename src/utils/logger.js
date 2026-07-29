// =============================================================================
// LOGGER
// Structured logging with timestamps and levels.
// Also maintains an in-memory buffer for real-time streaming to frontend.
//
// CHANGES (v2.1.0):
// - Added Supabase log queue for persistent storage
// - Logs are written to: (1) console, (2) daily log file, (3) in-memory buffer, (4) Supabase
// - Supabase writes are batched and non-blocking to avoid I/O bottlenecks
// =============================================================================

const fs = require("fs");
const path = require("path");

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[process.env.LOG_LEVEL || "info"];

const logDir = path.join(__dirname, "../../logs");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, `sync-${new Date().toISOString().split("T")[0]}.log`);

// In-memory log buffer for real-time streaming
const logBuffer = [];
const MAX_BUFFER_SIZE = 5000;
let logSubscribers = [];

// ── Supabase Integration ──
let supabase = null;

/**
 * Set the Supabase module reference. Called once at server startup.
 */
function setSupabaseModule(sb) {
  supabase = sb;
}

function log(level, message) {
  if (LEVELS[level] < currentLevel) return;

  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  console.log(line);

  // Append to log file (existing behavior)
  try {
    fs.appendFileSync(logFile, line + "\n");
  } catch (_) {}

  // Store in memory buffer for frontend streaming (existing behavior)
  const entry = { timestamp, level, message };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_BUFFER_SIZE) {
    logBuffer.shift();
  }

  // Notify subscribers (Server-Sent Events) — existing behavior
  for (const sub of logSubscribers) {
    try { sub.write(`data: ${JSON.stringify(entry)}\n\n`); } catch (_) {}
  }

  // Queue for Supabase persistence (new behavior — non-blocking)
  if (supabase) {
    try {
      supabase.queueLogEntry(entry);
    } catch (_) {}
  }
}

/**
 * Subscribe to real-time log events.
 * Returns an unsubscribe function.
 */
function subscribeLogStream(res) {
  logSubscribers.push(res);
  // Send the last 100 log entries as initial state
  for (const entry of logBuffer.slice(-100)) {
    try { res.write(`data: ${JSON.stringify(entry)}\n\n`); } catch (_) {}
  }
  return () => {
    logSubscribers = logSubscribers.filter(s => s !== res);
  };
}

module.exports = {
  debug: (msg) => log("debug", msg),
  info:  (msg) => log("info", msg),
  warn:  (msg) => log("warn", msg),
  error: (msg) => log("error", msg),
  setSupabaseModule,
  subscribeLogStream
};
