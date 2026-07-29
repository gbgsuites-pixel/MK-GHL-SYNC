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

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";
const SUPABASE_ENABLED = !!(SUPABASE_URL && SUPABASE_KEY);

let isInitialized = false;

// In-memory queue for log writes (batched to reduce API calls)
const logWriteQueue = [];
let flushInterval = null;
const FLUSH_INTERVAL_MS = 5000;
const MAX_QUEUE_SIZE = 200;

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
  flushInterval = setInterval(async () => {
    if (logWriteQueue.length === 0) return;
    const batch = logWriteQueue.splice(0, MAX_QUEUE_SIZE);
    await batchInsertLogs(batch);
  }, FLUSH_INTERVAL_MS);
  if (flushInterval.unref) flushInterval.unref();
}

async function batchInsertLogs(entries) {
  if (!isInitialized || entries.length === 0) return;
  const client = supabaseClient();

  const rows = entries.map(e => ({
    timestamp: e.timestamp,
    level: e.level,
    message: e.message
  }));

  try {
    const res = await client.post("/rest/v1/server_logs", rows);
    if (res.status >= 300) {
      console.warn(`[Supabase] Log batch insert failed: HTTP ${res.status}`);
    }
  } catch (e) {
    console.warn(`[Supabase] Log batch insert error: ${e.message}`);
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
    // Flush immediately if queue is full
    const batch = logWriteQueue.splice(0, MAX_QUEUE_SIZE);
    batchInsertLogs(batch);
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
  if (logWriteQueue.length > 0) {
    const batch = logWriteQueue.splice(0, MAX_QUEUE_SIZE);
    await batchInsertLogs(batch);
  }
}

// ── Query Helpers (used by API routes) ──
async function queryRecentLogs(limit = 200, level = null, since = null) {
  if (!isInitialized) return [];
  const client = supabaseClient();

  let query = `/rest/v1/server_logs?select=*&order=timestamp.desc&limit=${limit}`;
  if (level) query += `&level=eq.${level}`;
  if (since) query += `&timestamp=gte.${since}`;

  const res = await client.get(query);
  if (res.status < 300 && res.data) return res.data;
  return [];
}

async function queryRecentExecutions(limit = 50) {
  if (!isInitialized) return [];
  const client = supabaseClient();

  const res = await client.get(`/rest/v1/sync_executions?select=*&order=started_at.desc&limit=${limit}`);
  if (res.status < 300 && res.data) return res.data;
  return [];
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
  queryClientResults,
  queryContactResults,
  queryMemoryHistory,
  queryServerEvents
};
