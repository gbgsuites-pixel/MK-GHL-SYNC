// =============================================================================
// STRUCTURED LOGGER
// Writes redacted events to console, a date-aware local file, the in-memory SSE
// buffer, and optional Supabase persistence. Existing logger.info("message")
// call sites remain compatible; callers may pass a metadata object as a second
// argument or use logger.event(level, message, metadata).
// =============================================================================

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, critical: 4 };
const configuredLevel = String(process.env.LOG_LEVEL || "info").toLowerCase();
const currentLevel = Object.prototype.hasOwnProperty.call(LEVELS, configuredLevel)
  ? LEVELS[configuredLevel]
  : LEVELS.info;

const logDir = path.join(__dirname, "../../logs");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logBuffer = [];
const MAX_BUFFER_SIZE = 5000;
let logSubscribers = [];
let supabase = null;

const SENSITIVE_KEYS = new Set([
  "password", "pass", "token", "apiKey", "api_key", "authorization", "cookie",
  "cookies", "secret", "privateKey", "private_key", "encrypted_credentials",
  "ghlApiToken", "ghl_api_token", "clientSecret", "client_secret", "sessionToken",
  "session_token", "csrfToken", "csrf_token"
]);

function isSensitiveKey(key) {
  const normalized = String(key || "").replace(/[-_]/g, "").toLowerCase();
  return [...SENSITIVE_KEYS].some(candidate =>
    candidate.replace(/[-_]/g, "").toLowerCase() === normalized
  );
}

function eventId() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
}

function maskEmail(value) {
  const text = String(value || "");
  const at = text.indexOf("@");
  if (at <= 0) return text;
  const local = text.slice(0, at);
  return `${local.slice(0, 1)}${"*".repeat(Math.max(1, Math.min(6, local.length - 1)))}${text.slice(at)}`;
}

function maskPhone(value) {
  const text = String(value || "");
  const digits = text.replace(/\D/g, "");
  if (digits.length < 7) return text;
  return `${"*".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

function redactString(value) {
  let text = String(value ?? "");
  text = text.replace(/(https?:\/\/[^\s?]+)\?[^\s]+/gi, "$1?[REDACTED_QUERY]");
  text = text.replace(/((?:raw\s+)?(?:response|body)\s+(?:preview|text)|error\s+preview)\s*[:=]\s*.+/gi, "$1: [REDACTED_PAYLOAD]");
  text = text.replace(/((?:csrf|aura|session)(?:\s+\w+){0,4}\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
  text = text.replace(/(authorization\s*[:=]\s*bearer\s+|bearer\s+)[^\s,;]+/gi, "$1[REDACTED]");
  text = text.replace(/((?:password|passwd|token|api[_-]?key|secret|cookie|csrf[_-]?token)\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1[REDACTED]");
  text = text.replace(/([A-Z0-9._%+-])[A-Z0-9._%+-]*(@[A-Z0-9.-]+\.[A-Z]{2,})/gi, "$1***$2");
  text = text.replace(/(?:\+?\d[\d().\s-]{6,}\d)/g, (match) => maskPhone(match));
  return text.slice(0, 4000);
}

function redactValue(value, key = "") {
  if (isSensitiveKey(key)) return "[REDACTED]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (/email/i.test(key)) return maskEmail(value);
    if (/phone|mobile|telephone/i.test(key)) return maskPhone(value);
    return redactString(value);
  }
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redactValue(item));
  if (typeof value === "object") {
    return Object.entries(value).slice(0, 100).reduce((result, [childKey, childValue]) => {
      result[childKey] = redactValue(childValue, childKey);
      return result;
    }, {});
  }
  return value;
}

function inferCategory(message, metadata) {
  if (metadata.category) return String(metadata.category).toLowerCase();
  const prefix = String(message).match(/^\[([^\]]+)\]/)?.[1]?.toLowerCase() || "";
  if (prefix.includes("auth") || prefix.includes("login") || prefix.includes("session")) return "auth";
  if (prefix.includes("cron") || prefix.includes("schedule")) return "schedule";
  if (prefix.includes("ghl") || prefix.includes("upload") || prefix.includes("export")) return "upload";
  if (prefix.includes("source") || prefix.includes("aura") || prefix.includes("lwr")) return "source_fetch";
  if (prefix.includes("api") || prefix.includes("config") || prefix.includes("admin")) return "admin";
  if (prefix.includes("sync") || prefix.includes("orches")) return "sync";
  return "system";
}

function normalizeStatus(value) {
  if (!value) return null;
  const status = String(value).toLowerCase();
  return ["started", "succeeded", "failed", "blocked", "partial_success", "skipped"].includes(status)
    ? status
    : status.slice(0, 40);
}

function buildEvent(level, message, metadata = {}) {
  if (message && typeof message === "object") {
    metadata = message;
    message = metadata.message || metadata.msg || metadata.error || "Operational event";
  }
  const safeMetadata = redactValue(metadata && typeof metadata === "object" ? metadata : {});
  const safeMessage = redactString(message);
  const timestamp = new Date().toISOString();

  return {
    eventId: safeMetadata.eventId || eventId(),
    timestamp,
    level,
    category: inferCategory(safeMessage, safeMetadata),
    clientId: safeMetadata.clientId || safeMetadata.client_id || null,
    executionId: safeMetadata.executionId || safeMetadata.execution_id || null,
    operation: safeMetadata.operation || null,
    status: normalizeStatus(safeMetadata.status),
    errorCode: safeMetadata.errorCode || safeMetadata.error_code || null,
    retryable: Boolean(safeMetadata.retryable),
    message: safeMessage,
    metadata: safeMetadata
  };
}

function fileForTimestamp(timestamp) {
  const date = new Date(timestamp).toISOString().split("T")[0];
  return path.join(logDir, `sync-${date}.log`);
}

function formatConsoleLine(entry) {
  const context = [
    entry.category,
    entry.clientId ? `client=${entry.clientId}` : null,
    entry.executionId ? `execution=${entry.executionId}` : null,
    entry.operation ? `operation=${entry.operation}` : null,
    entry.status ? `status=${entry.status}` : null
  ].filter(Boolean).join(" ");
  return `[${entry.timestamp}] [${entry.level.toUpperCase()}]${context ? ` [${context}]` : ""} ${entry.message}`;
}

function setSupabaseModule(sb) {
  supabase = sb;
}

function log(level, message, metadata = {}) {
  if (!(level in LEVELS) || LEVELS[level] < currentLevel) return null;
  const entry = buildEvent(level, message, metadata);
  const line = formatConsoleLine(entry);
  console.log(line);

  try {
    fs.appendFileSync(fileForTimestamp(entry.timestamp), `${JSON.stringify(entry)}\n`);
  } catch (_) {}

  logBuffer.push(entry);
  if (logBuffer.length > MAX_BUFFER_SIZE) logBuffer.shift();

  for (const subscriber of logSubscribers) {
    try { subscriber.write(`data: ${JSON.stringify(entry)}\n\n`); } catch (_) {}
  }

  if (supabase) {
    try { supabase.queueLogEntry(entry); } catch (_) {}
  }
  return entry;
}

function subscribeLogStream(res) {
  logSubscribers.push(res);
  for (const entry of logBuffer.slice(-100)) {
    try { res.write(`data: ${JSON.stringify(entry)}\n\n`); } catch (_) {}
  }
  return () => {
    logSubscribers = logSubscribers.filter(subscriber => subscriber !== res);
  };
}

function getRecentEntries(limit = 500) {
  return logBuffer.slice(-Math.min(Math.max(Number(limit) || 500, 1), MAX_BUFFER_SIZE));
}

function parseLegacyLine(line) {
  const match = String(line).match(/^\[([^\]]+)\]\s*\[(\w+)\]\s*(.*)$/);
  if (!match) return null;
  return buildEvent(match[2].toLowerCase(), match[3], { category: "system" });
}

function readRecentFileEntries({ limit = 500, level = "all", category = "all", status = "all" } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), MAX_BUFFER_SIZE);
  let files = [];
  try {
    files = fs.readdirSync(logDir)
      .filter(name => /^sync-\d{4}-\d{2}-\d{2}\.log$/.test(name))
      .sort()
      .slice(-7)
      .map(name => path.join(logDir, name));
  } catch (_) {
    return [];
  }

  const entries = [];
  for (const file of files) {
    let lines = [];
    try { lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean); } catch (_) { continue; }
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        entries.push(parsed.eventId ? parsed : buildEvent(parsed.level || "info", parsed.message || "", parsed));
      } catch (_) {
        const legacy = parseLegacyLine(line);
        if (legacy) entries.push(legacy);
      }
    }
  }

  return entries
    .filter(entry => level === "all" || entry.level === level)
    .filter(entry => category === "all" || entry.category === category)
    .filter(entry => status === "all" || entry.status === status)
    .slice(-safeLimit);
}

module.exports = {
  debug: (message, metadata) => log("debug", message, metadata),
  info: (message, metadata) => log("info", message, metadata),
  warn: (message, metadata) => log("warn", message, metadata),
  error: (message, metadata) => log("error", message, metadata),
  critical: (message, metadata) => log("critical", message, metadata),
  event: log,
  redactValue,
  redactString,
  setSupabaseModule,
  subscribeLogStream,
  getRecentEntries,
  readRecentFileEntries
};
