// =============================================================================
// MANAGED CLIENT SECRET ENCRYPTION
// Secrets are encrypted before they leave the backend process. The encryption
// key must be supplied at runtime through CLIENT_SECRET_ENCRYPTION_KEY and is
// never returned by API responses.
// =============================================================================

const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const VERSION = "v1";

function getEncryptionKey() {
  const raw = String(process.env.CLIENT_SECRET_ENCRYPTION_KEY || "").trim();
  if (!raw) {
    throw new Error("CLIENT_SECRET_ENCRYPTION_KEY is required for managed client credentials.");
  }

  // Accept a 64-character hex key or a 32-byte base64 key. For operational
  // convenience, any other non-empty runtime secret is deterministically
  // expanded to 32 bytes with SHA-256; the raw value is never persisted.
  if (/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  try {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length === KEY_LENGTH) return decoded;
  } catch (_) {}
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

function encryptSecrets(secrets) {
  if (!secrets || typeof secrets !== "object") {
    throw new Error("Managed client secrets must be an object.");
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(secrets), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url")
  ].join(".");
}

function decryptSecrets(payload) {
  const parts = String(payload || "").split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Managed client credentials have an unsupported encryption format.");
  }

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getEncryptionKey(),
    Buffer.from(parts[1], "base64url")
  );
  decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(parts[3], "base64url")),
    decipher.final()
  ]);
  const parsed = JSON.parse(plaintext.toString("utf8"));
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Managed client credentials are invalid.");
  }
  return parsed;
}

function mask(value, visible = 3) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= visible) return "•".repeat(text.length);
  return `${text.slice(0, visible)}${"•".repeat(Math.min(8, text.length - visible))}`;
}

function safeManagedClient(record) {
  return {
    id: record.id,
    clientName: record.client_name || record.clientName,
    consultantNum: record.consultant_num || record.consultantNum,
    consultantNumMasked: mask(record.consultant_num || record.consultantNum, 2),
    locationId: record.ghl_location_id,
    status: record.status || "active",
    validationStatus: record.validation_status || "unknown",
    validationErrorCode: record.validation_error_code || null,
    lastValidationAt: record.last_validation_at || null,
    lastSyncAt: record.last_sync_at || null,
    lastSyncStatus: record.last_sync_status || null,
    lastSyncStats: record.last_sync_stats || record.lastSyncStats || {},
    createdAt: record.created_at || null,
    updatedAt: record.updated_at || null
  };
}

module.exports = {
  encryptSecrets,
  decryptSecrets,
  mask,
  safeManagedClient,
  ENCRYPTION_VERSION: VERSION
};
