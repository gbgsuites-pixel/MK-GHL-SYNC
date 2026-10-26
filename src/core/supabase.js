// =============================================================================
// SUPABASE INTEGRATION — Persistent Storage for Logs, Sync History, Errors
//
// This module provides a thin REST client for Supabase PostgREST API.
// It does NOT use the @supabase/supabase-js SDK to keep dependencies minimal.
// All operations use direct HTTP calls to the Supabase REST API.
//
// Features:
// - Durable log storage (survives process restarts)
// - Sync execution history
// - Per-client sync results
// - Per-contact GHL sync outcomes
// - Memory monitoring snapshots
// - Server event tracking (restarts, cron triggers, keep-alive)
// =============================================================================

const axios = require("axios");
const logger = require("../utils/logger");
const {
  encryptSecrets,
  decryptSecrets,
  safeManagedClient,
  ENCRYPTION_VERSION
} = require("../security/clientSecrets");

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";
const SUPABASE_ENABLED = !!(SUPABASE_URL && SUPABASE_KEY);

let isInitialized = false;

// In-memory queue for log writes (batched to reduce API calls)
const logWriteQueue = [];
let flushInterval = null;
let flushPromise = null;
const FLUSH_INTERVAL_MS = 5000;
const MAX_QUEUE_SIZE = 200;
const MAX_RETRY_QUEUE_SIZE = 5000;

// ── HTTP Client ──
function supabaseClient() {
  return axios.create({
    baseURL: SUPABASE_URL,
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal"
    },
    timeout: 10000,
    validateStatus: (s) => s < 500 // Don't throw on 4xx, only on 5xx
  });
}

// ── Initialization ──
async function initialize() {
  if (!SUPABASE_ENABLED) {
    console.log("[Supabase] Not configured (no SUPABASE_URL/SUPABASE_KEY). Storage disabled.");
    return;
  }

  if (isInitialized) return;

  try {
    const client = supabaseClient();
    const res = await client.get("/rest/v1/server_logs?select=id&limit=1");

    if (res.status < 400) {
      isInitialized = true;
      console.log("[Supabase] Connected successfully.");

      // Start background log flush
      startLogFlush();

      // Record server start event
      await recordServerEvent("server_start", {
        uptime: 0,
        processId: process.pid
      });
    } else {
      console.error(`[Supabase] Connection failed: HTTP ${res.status}`);
    }
  } catch (e) {
    console.error(`[Supabase] Connection error: ${e.message}`);
    console.error("[Supabase] Will retry on next log write.");
  }
}

function isEnabled() {
  return isInitialized;
}

// ── Batched Log Flush ──
function startLogFlush() {
  if (flushInterval) return;
  flushInterval = setInterval(() => { void flushLogQueue(); }, FLUSH_INTERVAL_MS);
  if (flushInterval.unref) flushInterval.unref();
}

async function flushLogQueue({ drain = false, deadlineMs = 5000 } = {}) {
  if (flushPromise) return flushPromise;
  flushPromise = (async () => {
    const startedAt = Date.now();
    do {
      if (logWriteQueue.length === 0) break;
      const batch = logWriteQueue.splice(0, MAX_QUEUE_SIZE);
      const succeeded = await batchInsertLogs(batch);
      if (!succeeded) break;
      if (!drain) break;
    } while (Date.now() - startedAt < deadlineMs);
  })().finally(() => {
    flushPromise = null;
  });
  return flushPromise;
}

async function batchInsertLogs(entries) {
  if (!isInitialized || entries.length === 0) return false;
  const client = supabaseClient();

  const rows = entries.map(e => ({
    event_id: e.eventId || e.id || null,
    timestamp: e.timestamp,
    level: e.level,
    message: e.message,
    category: e.category || "system",
    client_id: e.clientId || null,
    execution_id: e.executionId || null,
    operation: e.operation || null,
    status: e.status || null,
    error_code: e.errorCode || null,
    retryable: Boolean(e.retryable),
    metadata: e.metadata || {}
  }));

  try {
    const res = await client.post("/rest/v1/server_logs", rows);
    if (res.status >= 300) {
      // Allow a rolling deployment to keep persisting the legacy columns until
      // the additive structured-log migration has been applied.
      if (res.status < 500) {
        const legacyRows = entries.map(e => ({
          timestamp: e.timestamp,
          level: e.level,
          message: e.message
        }));
        const legacy = await client.post("/rest/v1/server_logs", legacyRows);
        if (legacy.status < 300) return true;
      }
      console.warn(`[Supabase] Log batch insert failed: HTTP ${res.status}; retaining ${entries.length} event(s).`);
      logWriteQueue.unshift(...entries.slice(0, MAX_RETRY_QUEUE_SIZE));
      if (logWriteQueue.length > MAX_RETRY_QUEUE_SIZE) {
        logWriteQueue.splice(MAX_RETRY_QUEUE_SIZE);
      }
      return false;
    }
    return true;
  } catch (e) {
    logWriteQueue.unshift(...entries);
    if (logWriteQueue.length > MAX_RETRY_QUEUE_SIZE) {
      logWriteQueue.splice(MAX_RETRY_QUEUE_SIZE);
    }
    console.warn(`[Supabase] Log batch insert error: ${e.message}; retaining ${entries.length} event(s).`);
    return false;
  }
}

/**
 * Write a single log entry to Supabase (queued for batched flush).
 * This is called by the logger module.
 */
function queueLogEntry(entry) {
  if (!isInitialized) return;
  logWriteQueue.push(entry);
  if (logWriteQueue.length >= MAX_QUEUE_SIZE) {
    void flushLogQueue();
  }
}

// ── Sync Execution ──
async function createExecution(triggeredBy, totalClients) {
  if (!isInitialized) return null;
  const client = supabaseClient();

  const res = await client.post("/rest/v1/sync_executions", {
    triggered_by: triggeredBy || "cron",
    total_clients: totalClients,
    status: "running"
  });

  if (res.status >= 300) {
    logger.warn(`[Supabase] createExecution failed: HTTP ${res.status}`);
    return null;
  }

  // Get the inserted ID
  const { data } = await client.get("/rest/v1/sync_executions?select=id&order=started_at.desc&limit=1");
  return data && data.length > 0 ? data[0].id : null;
}

async function completeExecution(executionId, summary) {
  if (!isInitialized || !executionId) return;
  const client = supabaseClient();

  const durationSec = Math.round((new Date(summary.endTime) - new Date(summary.startTime)) / 1000);
  const successCount = (summary.results || []).filter(r => r.status === "completed").length;
  const failCount = (summary.results || []).filter(r => r.status === "failed").length;

  const res = await client.patch(`/rest/v1/sync_executions?id=eq.${executionId}`, {
    ended_at: summary.endTime,
    duration_sec: durationSec,
    success_count: successCount,
    fail_count: failCount,
    status: "completed"
  });

  if (res.status >= 300) {
    logger.warn(`[Supabase] completeExecution failed: HTTP ${res.status}`);
  }
}

// ── Client Sync Results ──
async function createClientResult(executionId, client, status, phase) {
  if (!isInitialized || !executionId) return;
  const client2 = supabaseClient();

  const res = await client2.post("/rest/v1/client_sync_results", {
    execution_id: executionId,
    client_name: client.clientName,
    consultant_num: client.consultantNum,
    status: status || "in_progress",
    phase: phase || null
  });

  if (res.status >= 300) {
    logger.warn(`[Supabase] createClientResult failed: HTTP ${res.status}`);
  }
}

async function completeClientResult(executionId, clientName, consultantNum, stats, ghlResult, error) {
  if (!isInitialized || !executionId) return;
  const client2 = supabaseClient();

  const updates = {
    status: error ? "failed" : "completed",
    ended_at: new Date().toISOString(),
    error_message: error || null,
    consultant_count: stats?.consultantListCount || 0,
    sales_volume_count: stats?.salesVolumeCount || 0,
    star_consultant_count: stats?.starConsultantCount || 0,
    customer_list_count: stats?.customerListCount || 0,
    merged_contacts: stats?.mergedContacts || 0,
    ghl_synced: ghlResult?.synced || 0,
    ghl_errors: ghlResult?.errors?.length || 0,
    ghl_skipped: ghlResult?.skipped || 0,
    ghl_retries: ghlResult?.retryCount || 0
  };

  // Include error detail if present
  if (ghlResult?.errors?.length > 0) {
    updates.error_detail = ghlResult.errors.map(e => ({
      index: e.index,
      name: `${e.firstName} ${e.lastName}`,
      email: e.email,
      phone: e.phone,
      statusCode: e.statusCode,
      error: e.error,
      retries: e.retryAttempts
    }));
  }

  const res = await client2.patch(
    `/rest/v1/client_sync_results?execution_id=eq.${executionId}&client_name=eq.${encodeURIComponent(clientName)}`,
    updates
  );

  if (res.status >= 300) {
    logger.warn(`[Supabase] completeClientResult failed: HTTP ${res.status}`);
  }
}

// ── Contact Sync Results (batch insert) ──
async function batchInsertContactResults(executionId, clientName, consultantNum, ghlErrors, contacts) {
  if (!isInitialized || !executionId) return;
  if (ghlErrors.length === 0 && contacts.length === 0) return;
  const client2 = supabaseClient();

  const rows = [];

  // Insert errors
  for (const err of ghlErrors) {
    rows.push({
      execution_id: executionId,
      client_name: clientName,
      consultant_num: consultantNum,
      contact_index: err.index,
      first_name: err.firstName || "",
      last_name: err.lastName || "",
      email: err.email || "",
      phone: err.phone || "",
      status: "failed",
      ghl_status_code: parseInt(err.statusCode) || 0,
      error_message: err.error || "",
      retry_attempts: err.retryAttempts || 0,
      synced_at: new Date().toISOString()
    });
  }

  if (rows.length === 0) return;

  try {
    const res = await client2.post("/rest/v1/contact_sync_results", rows);
    if (res.status >= 300) {
      logger.warn(`[Supabase] batchInsertContactResults failed: HTTP ${res.status}`);
    }
  } catch (e) {
    logger.warn(`[Supabase] batchInsertContactResults error: ${e.message}`);
  }
}

// ── Memory Snapshots ──
async function recordMemorySnapshot(rssMB, heapUsedMB, heapTotalMB) {
  if (!isInitialized) return;
  const client = supabaseClient();

  const res = await client.post("/rest/v1/memory_snapshots", {
    rss_mb: rssMB,
    heap_used_mb: heapUsedMB,
    heap_total_mb: heapTotalMB
  });

  if (res.status >= 300) {
    // Don't log this as a warning — memory snapshots are low priority
  }
}

// ── Server Events ──
async function recordServerEvent(eventType, details) {
  if (!isInitialized) return;
  const client = supabaseClient();

  const res = await client.post("/rest/v1/server_events", {
    event_type: eventType,
    details: details
  });

  if (res.status >= 300) {
    logger.warn(`[Supabase] recordServerEvent failed: HTTP ${res.status}`);
  }
}

// ── Shutdown — Flush remaining logs ──
async function shutdown() {
  if (flushInterval) {
    clearInterval(flushInterval);
    flushInterval = null;
  }
  const deadline = Date.now() + 5000;
  while (logWriteQueue.length > 0 && Date.now() < deadline) {
    await flushLogQueue({ drain: true, deadlineMs: Math.max(1, deadline - Date.now()) });
    if (logWriteQueue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

// ── Query Helpers (used by API routes) ──
async function queryRecentLogs(limit = 200, level = null, since = null, filters = {}) {
  if (!isInitialized) return [];
  const client = supabaseClient();

  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000);
  const structuredSelect = "event_id,timestamp,level,message,category,client_id,execution_id,operation,status,error_code,retryable,metadata";
  let query = `/rest/v1/server_logs?select=${structuredSelect}&order=timestamp.desc&limit=${safeLimit}`;
  const equals = {
    level,
    category: filters.category,
    client_id: filters.clientId,
    execution_id: filters.executionId,
    operation: filters.operation,
    status: filters.status,
    retryable: filters.retryable
  };
  Object.entries(equals).forEach(([field, value]) => {
    if (value !== null && value !== undefined && value !== "" && value !== "all") {
      query += `&${field}=eq.${encodeURIComponent(value)}`;
    }
  });
  if (since) query += `&timestamp=gte.${encodeURIComponent(since)}`;
  if (filters.until) query += `&timestamp=lte.${encodeURIComponent(filters.until)}`;

  const res = await client.get(query);
  if (res.status < 300 && Array.isArray(res.data)) return res.data;

  // The additive migration may not be applied during a rolling deployment.
  // Fall back to legacy columns rather than taking down the logs view.
  let legacyQuery = `/rest/v1/server_logs?select=*&order=timestamp.desc&limit=${safeLimit}`;
  if (level && level !== "all") legacyQuery += `&level=eq.${encodeURIComponent(level)}`;
  if (since) legacyQuery += `&timestamp=gte.${encodeURIComponent(since)}`;
  const legacy = await client.get(legacyQuery);
  if (legacy.status < 300 && Array.isArray(legacy.data)) {
    return legacy.data.map(entry => ({
      ...entry,
      event_id: entry.event_id || null,
      category: entry.category || "system",
      retryable: Boolean(entry.retryable)
    }));
  }
  return [];
}

async function queryRecentExecutions(limit = 50) {
  if (!isInitialized) return [];
  const client = supabaseClient();

  const res = await client.get(`/rest/v1/sync_executions?select=*&order=started_at.desc&limit=${limit}`);
  if (res.status < 300 && res.data) return res.data;
  return [];
}

async function queryExecution(executionId) {
  if (!isInitialized || !executionId) return null;
  const client = supabaseClient();
  const encodedId = encodeURIComponent(String(executionId));
  const res = await client.get(`/rest/v1/sync_executions?select=*&id=eq.${encodedId}&limit=1`);
  if (res.status < 300 && Array.isArray(res.data) && res.data.length > 0) return res.data[0];
  return null;
}

async function queryClientResults(executionId) {
  if (!isInitialized || !executionId) return [];
  const client = supabaseClient();

  const res = await client.get(`/rest/v1/client_sync_results?select=*&execution_id=eq.${executionId}&order=id.asc`);
  if (res.status < 300 && res.data) return res.data;
  return [];
}

async function queryContactResults(executionId, status = null) {
  if (!isInitialized || !executionId) return [];
  const client = supabaseClient();

  let query = `/rest/v1/contact_sync_results?select=*&execution_id=eq.${executionId}&order=id.asc`;
  if (status) query += `&status=eq.${status}`;

  const res = await client.get(query);
  if (res.status < 300 && res.data) return res.data;
  return [];
}

async function queryMemoryHistory(hours = 24) {
  if (!isInitialized) return [];
  const client = supabaseClient();

  const since = new Date(Date.now() - hours * 3600000).toISOString();
  const res = await client.get(`/rest/v1/memory_snapshots?select=*&timestamp=gte.${since}&order=timestamp.desc`);
  if (res.status < 300 && res.data) return res.data;
  return [];
}

async function queryServerEvents(limit = 100) {
  if (!isInitialized) return [];
  const client = supabaseClient();

  const res = await client.get(`/rest/v1/server_events?select=*&order=timestamp.desc&limit=${limit}`);
  if (res.status < 300 && res.data) return res.data;
  return [];
}

// ── Managed integration clients ──
const MANAGED_CLIENT_SELECT = [
  "id",
  "client_name",
  "consultant_num",
  "ghl_location_id",
  "ghl_custom_fields",
  "encrypted_credentials",
  "secret_key_version",
  "status",
  "validation_status",
  "validation_error_code",
  "last_validation_at",
  "last_sync_at",
  "last_sync_status",
  "created_at",
  "updated_at"
].join(",");

function managedTableError(response) {
  const error = new Error(
    "Managed client storage is unavailable. Apply migrations/VA-3379 - integration_clients.sql in Supabase."
  );
  error.code = "MANAGED_CLIENTS_TABLE_MISSING";
  error.status = response?.status;
  return error;
}

function ensureSupabaseForManagedClients() {
  if (!isInitialized) {
    const error = new Error("Supabase is not initialized.");
    error.code = "SUPABASE_NOT_INITIALIZED";
    throw error;
  }
}

function rowToManagedClient(row, includeSecrets) {
  const metadata = safeManagedClient(row);
  const result = {
    ...metadata,
    ghlCustomFields: row.ghl_custom_fields || {}
  };

  if (includeSecrets) {
    const secrets = decryptSecrets(row.encrypted_credentials);
    return {
      ...result,
      password: secrets.password,
      ghlApiToken: secrets.ghlApiToken
    };
  }

  return result;
}

async function fetchManagedClientRows(query = "") {
  ensureSupabaseForManagedClients();
  const client = supabaseClient();
  const response = await client.get(
    `/rest/v1/integration_clients?select=${MANAGED_CLIENT_SELECT}${query}`
  );
  if (response.status === 404 || response.status === 42) {
    throw managedTableError(response);
  }
  if (response.status >= 300) {
    throw new Error(`Managed client query failed with HTTP ${response.status}.`);
  }
  return Array.isArray(response.data) ? response.data : [];
}

async function listManagedClients({ includeSecrets = false } = {}) {
  const rows = await fetchManagedClientRows("&order=created_at.asc");
  return rows.map(row => rowToManagedClient(row, includeSecrets));
}

async function getManagedClient(id, { includeSecrets = false } = {}) {
  const rows = await fetchManagedClientRows(`&id=eq.${encodeURIComponent(id)}&limit=1`);
  return rows.length ? rowToManagedClient(rows[0], includeSecrets) : null;
}

async function createManagedClient(input) {
  ensureSupabaseForManagedClients();
  const client = supabaseClient();
  const row = {
    client_name: input.clientName,
    consultant_num: input.consultantNum,
    ghl_location_id: input.ghlLocationId,
    ghl_custom_fields: input.ghlCustomFields || {},
    encrypted_credentials: encryptSecrets({
      password: input.password,
      ghlApiToken: input.ghlApiToken
    }),
    secret_key_version: ENCRYPTION_VERSION,
    status: input.status || "pending_validation",
    validation_status: input.validationStatus || "pending",
    validation_error_code: input.validationErrorCode || null
  };
  const response = await client.post("/rest/v1/integration_clients", row, {
    headers: { Prefer: "return=representation" }
  });
  if (response.status === 409) {
    const error = new Error("A managed client with this consultant number already exists.");
    error.code = "DUPLICATE_CLIENT_IDENTITY";
    throw error;
  }
  if (response.status >= 300) {
    throw new Error(`Managed client creation failed with HTTP ${response.status}.`);
  }
  const created = Array.isArray(response.data) ? response.data[0] : response.data;
  return rowToManagedClient(created || { ...row, id: null }, false);
}

async function updateManagedClient(id, patch = {}) {
  ensureSupabaseForManagedClients();
  const client = supabaseClient();
  const updates = {};
  if (patch.clientName !== undefined) updates.client_name = patch.clientName;
  if (patch.consultantNum !== undefined) updates.consultant_num = patch.consultantNum;
  if (patch.ghlLocationId !== undefined) updates.ghl_location_id = patch.ghlLocationId;
  if (patch.ghlCustomFields !== undefined) updates.ghl_custom_fields = patch.ghlCustomFields;
  if (patch.status !== undefined) updates.status = patch.status;
  if (patch.validationStatus !== undefined) updates.validation_status = patch.validationStatus;
  if (patch.validationErrorCode !== undefined) updates.validation_error_code = patch.validationErrorCode;
  if (patch.lastValidationAt !== undefined) updates.last_validation_at = patch.lastValidationAt;
  if (patch.lastSyncAt !== undefined) updates.last_sync_at = patch.lastSyncAt;
  if (patch.lastSyncStatus !== undefined) updates.last_sync_status = patch.lastSyncStatus;
  if (patch.password !== undefined || patch.ghlApiToken !== undefined) {
    const current = await getManagedClient(id, { includeSecrets: true });
    if (!current) return null;
    updates.encrypted_credentials = encryptSecrets({
      password: patch.password !== undefined ? patch.password : current.password,
      ghlApiToken: patch.ghlApiToken !== undefined ? patch.ghlApiToken : current.ghlApiToken
    });
    updates.secret_key_version = ENCRYPTION_VERSION;
  }

  if (Object.keys(updates).length === 0) return getManagedClient(id, { includeSecrets: false });
  const response = await client.patch(
    `/rest/v1/integration_clients?id=eq.${encodeURIComponent(id)}`,
    updates,
    { headers: { Prefer: "return=representation" } }
  );
  if (response.status === 409) {
    const error = new Error("A managed client with this consultant number already exists.");
    error.code = "DUPLICATE_CLIENT_IDENTITY";
    throw error;
  }
  if (response.status >= 300) {
    throw new Error(`Managed client update failed with HTTP ${response.status}.`);
  }
  const updated = Array.isArray(response.data) ? response.data[0] : response.data;
  return updated ? rowToManagedClient(updated, false) : getManagedClient(id, { includeSecrets: false });
}

async function deleteManagedClient(id) {
  ensureSupabaseForManagedClients();
  const client = supabaseClient();
  const response = await client.delete(
    `/rest/v1/integration_clients?id=eq.${encodeURIComponent(id)}`,
    { headers: { Prefer: "return=minimal" } }
  );
  if (response.status >= 300) {
    throw new Error(`Managed client removal failed with HTTP ${response.status}.`);
  }
  return true;
}

async function loadManagedClients() {
  return listManagedClients({ includeSecrets: true });
}

// ── Public API ──
module.exports = {
  initialize,
  isEnabled,
  queueLogEntry,
  shutdown,
  // Sync operations
  createExecution,
  completeExecution,
  createClientResult,
  completeClientResult,
  batchInsertContactResults,
  // Monitoring
  recordMemorySnapshot,
  recordServerEvent,
  // Queries (for API routes)
  queryRecentLogs,
  queryRecentExecutions,
  queryExecution,
  queryClientResults,
  queryContactResults,
  queryMemoryHistory,
  queryServerEvents,
  listManagedClients,
  getManagedClient,
  createManagedClient,
  updateManagedClient,
  deleteManagedClient,
  loadManagedClients,
};
