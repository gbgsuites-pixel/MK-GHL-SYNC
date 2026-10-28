// =============================================================================
// API ROUTES
// HTTP endpoints for triggering syncs, checking status, and managing config.
// All endpoints are protected by the API_SECRET_KEY.
// =============================================================================

const express = require("express");
const {
  getClients,
  getActiveClients,
  getClientByNum,
  getClientById,
  setManagedClients,
  isManagedClientsLoaded,
  reloadConfig,
  getServerConfig,
  getScheduleConfig,
  persistSchedule
} = require("../core/config");
const { runFullSync, runSingleClientSync, getExecutionState, isRunning } = require("../scheduler/orchestrator");
const { getCacheStatus, getSession, invalidateSession } = require("../sessions/sessionManager");
const { fetchRawData, fetchProcessedContacts, validateAllData, exportAllLists, exportGhlReadyContacts, exportGhlReadyCsv } = require("../processors/diagnostics");
const { startCron, stopCron, restartCron } = require("../scheduler/cron");
const { getProgressStream, subscribeProgress } = require("../scheduler/progress.js");
const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");
const supabase = require("../core/supabase");
const { issueStreamTicket, validateStreamTicket } = require("../security/streamTickets");
const { fetchLocationCustomFields, customFieldMap } = require("../core/ghlAdmin");
const {
  hasCompleteProtectedFieldMapping,
  missingProtectedFieldNames
} = require("../core/protectedFields");

const router = express.Router();

// ── CORS Headers ──
const configuredOrigins = new Set(
  String(process.env.FRONTEND_ORIGINS || "")
    .split(",")
    .map(origin => origin.trim())
    .filter(Boolean)
);

router.use((req, res, next) => {
  const origin = req.headers.origin;
  const secureRuntime =
    process.env.NODE_ENV === "production" ||
    ["1", "true", "yes", "on"].includes(
      String(process.env.REQUIRE_EXTERNAL_CLIENT_CONFIG || "").toLowerCase()
    );
  const allowDevelopmentWildcard =
    !secureRuntime && configuredOrigins.size === 0;

  if (allowDevelopmentWildcard) {
    res.header("Access-Control-Allow-Origin", "*");
  } else if (origin && configuredOrigins.has(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
  }

  res.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, x-api-key");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

// ── Authentication Middleware ──
function requireAuth(req, res, next) {
  const allowQueryKey = ["1", "true", "yes", "on"].includes(
    String(process.env.ALLOW_QUERY_API_KEY_AUTH || "").toLowerCase()
  );
  const apiKey = req.headers["x-api-key"] ||
    (allowQueryKey ? req.query.apiKey : "");
  if (!apiKey || apiKey !== process.env.API_SECRET_KEY) {
    return res.status(401).json({ error: "Invalid or missing API key." });
  }
  next();
}

function requireStreamTicket(stream, req, res, next) {
  const ticket = String(req.query.ticket || "");
  if (!validateStreamTicket(ticket, stream)) {
    return res.status(401).json({ error: "Invalid or expired stream ticket." });
  }
  next();
}

function managedClientsEnabled() {
  return ["1", "true", "yes", "on"].includes(
    String(process.env.MANAGED_CLIENTS_ENABLED || "").toLowerCase()
  );
}

function requireManagedClients(req, res, next) {
  if (!managedClientsEnabled()) {
    return res.status(503).json({
      error: "Managed client storage is disabled. Set MANAGED_CLIENTS_ENABLED=true after applying the Supabase migration.",
      code: "MANAGED_CLIENTS_DISABLED"
    });
  }
  next();
}

async function refreshManagedClientCache() {
  const clients = await supabase.loadManagedClients();
  setManagedClients(clients);
  return clients;
}

async function completeMappingFromSameLocation(locationId, currentMap) {
  const missing = missingProtectedFieldNames(currentMap);
  if (missing.length === 0) return currentMap;

  try {
    const clients = await supabase.listManagedClients({ includeSecrets: false });
    const trusted = clients.find((client) =>
      String(client.locationId || "").trim() === String(locationId || "").trim() &&
      hasCompleteProtectedFieldMapping(client.ghlCustomFields)
    );
    if (!trusted) return currentMap;

    // Keep IDs returned by the live API, and fill only the names omitted by
    // that response. IDs are location-scoped, so a mapping from another
    // location is never used.
    return { ...trusted.ghlCustomFields, ...currentMap };
  } catch (error) {
    logger.warn(`[API] Same-location custom-field mapping fallback unavailable: ${error.message}`);
    return currentMap;
  }
}

function managedClientResponse(client) {
  if (!client) return null;
  return {
    id: client.id,
    clientName: client.clientName,
    consultantNum: client.consultantNum,
    locationId: client.locationId,
    customFieldCount: client.ghlCustomFields && typeof client.ghlCustomFields === "object"
      ? Object.keys(client.ghlCustomFields).length
      : 0,
    status: client.status || "active",
    validationStatus: client.validationStatus || "unknown",
    validationErrorCode: client.validationErrorCode || null,
    lastValidationAt: client.lastValidationAt || null,
    lastSyncAt: client.lastSyncAt || null,
    lastSyncStatus: client.lastSyncStatus || null,
    lastSyncStats: client.lastSyncStats || {},
    createdAt: client.createdAt || null,
    updatedAt: client.updatedAt || null
  };
}

function validateManagedClientInput(body) {
  const fields = ["clientName", "consultantNum", "password", "ghlApiToken", "ghlLocationId"];
  for (const field of fields) {
    if (!String(body?.[field] || "").trim()) {
      const error = new Error(`${field} is required.`);
      error.code = "INVALID_CLIENT_INPUT";
      throw error;
    }
  }
  return {
    clientName: String(body.clientName).trim(),
    consultantNum: String(body.consultantNum).trim().toUpperCase(),
    password: String(body.password),
    ghlApiToken: String(body.ghlApiToken),
    ghlLocationId: String(body.ghlLocationId).trim(),
    ghlCustomFields: body.ghlCustomFields && typeof body.ghlCustomFields === "object"
      ? body.ghlCustomFields
      : {}
  };
}

function parseLogFilters(query = {}) {
  const allowedLevels = new Set(["all", "debug", "info", "warn", "error", "critical"]);
  const allowedStatuses = new Set(["all", "started", "succeeded", "failed", "blocked", "partial_success", "skipped"]);
  const allowedCategories = new Set(["all", "auth", "source_fetch", "validation", "sync", "upload", "schedule", "admin", "system"]);
  const level = String(query.level || "all").toLowerCase();
  const category = String(query.category || "all").toLowerCase();
  const status = String(query.status || "all").toLowerCase();
  if (!allowedLevels.has(level)) throw new Error("Invalid log level filter.");
  if (!allowedCategories.has(category)) throw new Error("Invalid log category filter.");
  if (!allowedStatuses.has(status)) throw new Error("Invalid log status filter.");

  const limit = Number(query.limit || 200);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("Log limit must be an integer between 1 and 1000.");
  }

  const safeText = (value, label) => {
    if (!value) return null;
    const text = String(value);
    if (text.length > 120 || !/^[A-Za-z0-9._:@/-]+$/.test(text)) {
      throw new Error(`Invalid ${label} filter.`);
    }
    return text;
  };
  const timestamp = (value, label) => {
    if (!value) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid ${label} timestamp.`);
    return parsed.toISOString();
  };

  const retryable = query.retryable === undefined || query.retryable === "all"
    ? null
    : String(query.retryable).toLowerCase();
  if (retryable !== null && !["true", "false"].includes(retryable)) {
    throw new Error("retryable must be true, false, or all.");
  }

  return {
    limit,
    level: level === "all" ? null : level,
    category,
    status,
    clientId: safeText(query.clientId, "client ID"),
    executionId: safeText(query.executionId, "execution ID"),
    operation: safeText(query.operation, "operation"),
    retryable: retryable === null ? null : retryable === "true",
    since: timestamp(query.since, "since"),
    until: timestamp(query.until, "until")
  };
}

// ── Health Check (no auth required) ──
router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime()
  });
});

// ── GET /api/clients — List all configured clients ──
router.get("/api/clients", requireAuth, (req, res) => {
  if (managedClientsEnabled() && !isManagedClientsLoaded()) {
    return res.status(503).json({
      error: "Supabase managed clients are not loaded. Check backend startup logs and Supabase configuration.",
      code: "MANAGED_CLIENT_CACHE_NOT_READY"
    });
  }
  const clients = getClients();
  res.json({
      count: clients.length,
      managed: managedClientsEnabled(),
      clients: clients.map(c => ({
      id:            c.id || null,
      consultantNum: c.consultantNum,
      clientName:    c.clientName,
      locationId:    c.locationId,
      customFieldCount: c.ghlCustomFields && typeof c.ghlCustomFields === "object"
        ? Object.keys(c.ghlCustomFields).length
        : 0,
      status:        c.status || "active",
      validationStatus: c.validationStatus || "unknown",
      validationErrorCode: c.validationErrorCode || null,
      lastValidationAt: c.lastValidationAt || null,
      lastSyncAt:    c.lastSyncAt || null,
      lastSyncStatus: c.lastSyncStatus || null,
      lastSyncStats: c.lastSyncStats || {},
      createdAt:     c.createdAt || null,
      updatedAt:     c.updatedAt || null
    }))
  });
});

// ── Phase 2 managed-client API ──
router.get("/api/v1/clients", requireAuth, requireManagedClients, async (req, res) => {
  try {
    const clients = await supabase.listManagedClients({ includeSecrets: false });
    res.json({ clients: clients.map(managedClientResponse), count: clients.length });
  } catch (e) {
    res.status(e.status === 404 ? 503 : 500).json({ error: e.message, code: e.code });
  }
});

router.get("/api/v1/clients/:id", requireAuth, requireManagedClients, async (req, res) => {
  try {
    const client = await supabase.getManagedClient(req.params.id, { includeSecrets: false });
    if (!client) return res.status(404).json({ error: "Managed client not found." });
    res.json({ client: managedClientResponse(client) });
  } catch (e) {
    res.status(e.status === 404 ? 503 : 500).json({ error: e.message, code: e.code });
  }
});

router.post("/api/v1/clients", requireAuth, requireManagedClients, async (req, res) => {
  try {
    const input = validateManagedClientInput(req.body);
    const existing = getClientByNum(input.consultantNum);
    if (existing) {
      return res.status(409).json({
        error: "A client with this consultant number already exists.",
        code: "DUPLICATE_CLIENT_IDENTITY"
      });
    }
    // Fetch the location's current GHL custom fields during onboarding so the
    // mapping is stored with the encrypted client record before first sync.
    const customFields = await fetchLocationCustomFields(
      input.ghlApiToken,
      input.ghlLocationId
    );
    const customFieldsMap = await completeMappingFromSameLocation(
      input.ghlLocationId,
      customFieldMap(customFields)
    );
    const missingProtectedFields = missingProtectedFieldNames(customFieldsMap);
    if (missingProtectedFields.length > 0) {
      const error = new Error(
        `GoHighLevel returned an incomplete contact-field mapping. Missing: ${missingProtectedFields.join(", ")}.`
      );
      error.code = "GHL_PROTECTED_FIELDS_MISSING";
      error.fields = missingProtectedFields;
      throw error;
    }
    input.ghlCustomFields = customFieldsMap;
    const created = await supabase.createManagedClient(input);
    await refreshManagedClientCache();
    res.status(201).json({
      client: managedClientResponse(created),
      status: "pending_validation",
      customFieldCount: customFields.length
    });
  } catch (e) {
    const status = e.code === "DUPLICATE_CLIENT_IDENTITY"
      ? 409
      : (e.code?.startsWith("GHL_") || e.code === "CUSTOM_FIELDS_UNAVAILABLE") ? 422 : 400;
    res.status(status).json({ error: e.message, code: e.code || "CLIENT_CREATE_FAILED" });
  }
});

router.post("/api/v1/clients/:id/validate-credentials", requireAuth, requireManagedClients, async (req, res) => {
  let managedClient = null;
  try {
    managedClient = await supabase.getManagedClient(req.params.id, { includeSecrets: true });
    if (!managedClient) return res.status(404).json({ error: "Managed client not found." });

    const session = await getSession(
      managedClient.consultantNum,
      managedClient.password,
      true
    );
    const fields = await fetchLocationCustomFields(
      managedClient.ghlApiToken,
      managedClient.locationId
    );
    const fieldsMap = await completeMappingFromSameLocation(
      managedClient.locationId,
      { ...managedClient.ghlCustomFields, ...customFieldMap(fields) }
    );
    const missingProtectedFields = missingProtectedFieldNames(fieldsMap);
    if (missingProtectedFields.length > 0) {
      const error = new Error(
        `GoHighLevel returned an incomplete contact-field mapping. Missing: ${missingProtectedFields.join(", ")}.`
      );
      error.code = "GHL_PROTECTED_FIELDS_MISSING";
      error.fields = missingProtectedFields;
      throw error;
    }
    await invalidateSession(managedClient.consultantNum);

    const updated = await supabase.updateManagedClient(req.params.id, {
      status: "active",
      validationStatus: "valid",
      validationErrorCode: null,
      lastValidationAt: new Date().toISOString(),
      ghlCustomFields: fieldsMap
    });
    await refreshManagedClientCache();
    res.json({ client: managedClientResponse(updated), customFieldCount: fields.length });
  } catch (e) {
    if (managedClient) {
      try {
        await supabase.updateManagedClient(req.params.id, {
          status: "invalid",
          validationStatus: "invalid",
          validationErrorCode: e.code || "VALIDATION_FAILED",
          lastValidationAt: new Date().toISOString()
        });
        await refreshManagedClientCache();
      } catch (_) {}
      try { await invalidateSession(managedClient.consultantNum); } catch (_) {}
    }
    res.status(422).json({
      error: e.message,
      code: e.code || "VALIDATION_FAILED",
      action: "Verify the Mary Kay credentials, GHL token, location ID, and custom-field permissions."
    });
  }
});

router.patch("/api/v1/clients/:id/status", requireAuth, requireManagedClients, async (req, res) => {
  const allowed = ["active", "paused", "disconnected", "removal_pending"];
  const status = String(req.body?.status || "");
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(", ")}.`, code: "INVALID_CLIENT_STATUS" });
  }
  try {
    const client = await supabase.getManagedClient(req.params.id, { includeSecrets: true });
    if (!client) return res.status(404).json({ error: "Managed client not found." });
    if (["paused", "disconnected", "removal_pending"].includes(status)) {
      await invalidateSession(client.consultantNum);
    }
    const updated = await supabase.updateManagedClient(req.params.id, { status });
    await refreshManagedClientCache();
    res.json({ client: managedClientResponse(updated) });
  } catch (e) {
    res.status(500).json({ error: e.message, code: e.code || "CLIENT_STATUS_UPDATE_FAILED" });
  }
});

router.delete("/api/v1/clients/:id", requireAuth, requireManagedClients, async (req, res) => {
  try {
    const client = await supabase.getManagedClient(req.params.id, { includeSecrets: true });
    if (!client) return res.status(404).json({ error: "Managed client not found." });
    await invalidateSession(client.consultantNum);
    const updated = await supabase.updateManagedClient(req.params.id, { status: "disconnected" });
    await refreshManagedClientCache();
    res.json({ status: "disconnected", client: managedClientResponse(updated) });
  } catch (e) {
    res.status(500).json({ error: e.message, code: e.code || "CLIENT_DISCONNECT_FAILED" });
  }
});

// Permanently remove only the integration client row. Historical sync
// executions, contact results, logs, and audit records remain available.
router.delete("/api/v1/clients/:id/permanent", requireAuth, requireManagedClients, async (req, res) => {
  try {
    const client = await supabase.getManagedClient(req.params.id, { includeSecrets: true });
    if (!client) return res.status(404).json({ error: "Managed client not found." });
    await invalidateSession(client.consultantNum);
    await supabase.deleteManagedClient(req.params.id);
    await refreshManagedClientCache();
    logger.info(`[API] Managed client permanently removed: ${client.clientName}`);
    res.json({ status: "removed", consultantNum: client.consultantNum });
  } catch (e) {
    res.status(500).json({ error: e.message, code: e.code || "CLIENT_REMOVE_FAILED" });
  }
});

router.post("/api/v1/clients/:id/sync", requireAuth, requireManagedClients, async (req, res) => {
  if (isRunning()) return res.status(409).json({ error: "Sync already in progress." });
  const client = getClientById(req.params.id);
  if (!client) return res.status(404).json({ error: "Managed client not found." });
  if (client.status !== "active") {
    return res.status(409).json({ error: `Client is ${client.status || "inactive"}. Activate it before syncing.` });
  }
  runSingleClientSync(client).catch(err => logger.error(`[API] Managed client sync failed: ${err.message}`));
  res.json({ status: "started", client: managedClientResponse(client) });
});

// ── POST /api/stream-ticket — Exchange the API key for a short-lived SSE ticket ──
router.post("/api/stream-ticket", requireAuth, (req, res) => {
  try {
    const stream = req.body?.stream;
    if (!["logs", "progress"].includes(stream)) {
      return res.status(400).json({ error: "stream must be logs or progress." });
    }
    res.json(issueStreamTicket(stream));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST /api/sync/all — Trigger full sync for all clients ──
router.post("/api/sync/all", requireAuth, async (req, res) => {
  if (isRunning()) {
    return res.status(409).json({ error: "Sync already in progress." });
  }

  const clients = getActiveClients();
  logger.info("[API] Full sync triggered via API.");

  const syncPromise = runFullSync(clients);
  syncPromise.catch(err => {
    logger.error(`[API] Full sync failed: ${err.message}`);
  });

  res.json({
    status:  "started",
    message: `Full sync initiated for ${clients.length} client(s).`
  });
});

// ── POST /api/sync/:consultantNum — Trigger sync for a single client ──
router.post("/api/sync/:consultantNum", requireAuth, async (req, res) => {
  if (isRunning()) {
    return res.status(409).json({ error: "Sync already in progress." });
  }

  const client = getClientByNum(req.params.consultantNum);
  if (!client) {
    return res.status(404).json({ error: "Client not found." });
  }
  if (client.status && client.status !== "active") {
    return res.status(409).json({
      error: `Client is ${client.status}. Activate it before syncing.`,
      code: "CLIENT_NOT_ACTIVE"
    });
  }

  logger.info(`[API] Single client sync triggered: ${client.clientName}`);

  const syncPromise = runSingleClientSync(client);
  syncPromise.catch(err => {
    logger.error(`[API] Single client sync failed: ${err.message}`);
  });

  res.json({
    status:  "started",
    message: `Sync initiated for ${client.clientName} (${client.consultantNum}).`
  });
});

// ── GET /api/status — Get current execution state ──
router.get("/api/status", requireAuth, (req, res) => {
  const state = getExecutionState();
  if (!state) {
    return res.json({ status: "idle", message: "No sync in progress." });
  }
  res.json(state);
});

// ── GET /api/sessions — Get session cache status ──
router.get("/api/sessions", requireAuth, (req, res) => {
  res.json({ sessions: getCacheStatus() });
});

// ── POST /api/sessions/refresh/:consultantNum — Force-refresh a session ──
router.post("/api/sessions/refresh/:consultantNum", requireAuth, async (req, res) => {
  const client = getClientByNum(req.params.consultantNum);
  if (!client) {
    return res.status(404).json({ error: "Client not found." });
  }

  try {
    // invalidateSession is now async (closes the browser)
    await invalidateSession(client.consultantNum);
    const session = await getSession(client.consultantNum, client.password, true);
    res.json({
      status: "refreshed",
      consultantNum: client.consultantNum,
      hasMkPage: !!session.mkPage,
      hasAppsPage: !!session.appsPage,
      mkUrl: session.mkUrl || "",
      appsUrl: session.appsUrl || ""
    });
  } catch (e) {
    res.status(500).json({ error: `Session refresh failed: ${e.message}` });
  }
});

// ── POST /api/config/reload — Reload configuration from disk ──
router.post("/api/config/reload", requireAuth, (req, res) => {
  try {
    const config = reloadConfig();
    res.json({
      status:  "reloaded",
      clients: config.clients.length
    });
  } catch (e) {
    res.status(500).json({ error: `Config reload failed: ${e.message}` });
  }
});

// ── GET /api/config/schedule — Get schedule configuration ──
router.get("/api/config/schedule", requireAuth, (req, res) => {
  const schedule = getServerConfig().schedule || {};
  res.json(schedule);
});

// ── GET /api/diagnostic/raw/:consultantNum — Fetch raw Mary Kay data ──
router.get("/api/diagnostic/raw/:consultantNum", requireAuth, async (req, res) => {
  const client = getClientByNum(req.params.consultantNum);
  if (!client) {
    return res.status(404).json({ error: "Client not found." });
  }

  logger.info(`[API] Diagnostic: Raw data fetch requested for ${client.clientName}`);

  try {
    const data = await fetchRawData(client);
    res.json(data);
  } catch (e) {
    logger.error(`[API] Diagnostic raw fetch failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/diagnostic/processed/:consultantNum — Fetch processed GHL-ready contacts ──
router.get("/api/diagnostic/processed/:consultantNum", requireAuth, async (req, res) => {
  const client = getClientByNum(req.params.consultantNum);
  if (!client) {
    return res.status(404).json({ error: "Client not found." });
  }

  logger.info(`[API] Diagnostic: Processed contacts requested for ${client.clientName}`);

  try {
    const data = await fetchProcessedContacts(client);
    res.json(data);
  } catch (e) {
    logger.error(`[API] Diagnostic processed fetch failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/diagnostic/validate/:consultantNum — Run full data validation ──
router.get("/api/diagnostic/validate/:consultantNum", requireAuth, async (req, res) => {
  const client = getClientByNum(req.params.consultantNum);
  if (!client) {
    return res.status(404).json({ error: "Client not found." });
  }

  logger.info(`[API] Diagnostic: Validation requested for ${client.clientName}`);

  try {
    const data = await validateAllData(client);
    res.json(data);
  } catch (e) {
    logger.error(`[API] Diagnostic validation failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/export/lists/:consultantNum — Export ALL raw lists as JSON ──
router.get("/api/export/lists/:consultantNum", requireAuth, async (req, res) => {
  const client = getClientByNum(req.params.consultantNum);
  if (!client) {
    return res.status(404).json({ error: "Client not found." });
  }

  logger.info(`[API] Export: Raw lists requested for ${client.clientName}`);

  try {
    const data = await exportAllLists(client);
    res.json(data);
  } catch (e) {
    logger.error(`[API] Export lists failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/export/ghl-contacts/:consultantNum — Export GHL-ready contacts as JSON ──
router.get("/api/export/ghl-contacts/:consultantNum", requireAuth, async (req, res) => {
  const client = getClientByNum(req.params.consultantNum);
  if (!client) {
    return res.status(404).json({ error: "Client not found." });
  }

  logger.info(`[API] Export: GHL-ready contacts requested for ${client.clientName}`);

  try {
    const data = await exportGhlReadyContacts(client);
    res.json(data);
  } catch (e) {
    logger.error(`[API] Export GHL contacts failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/export/ghl-csv/:consultantNum — Export GHL-ready contacts as CSV download ──
router.get("/api/export/ghl-csv/:consultantNum", requireAuth, async (req, res) => {
  const client = getClientByNum(req.params.consultantNum);
  if (!client) {
    return res.status(404).json({ error: "Client not found." });
  }

  logger.info(`[API] Export: CSV download requested for ${client.clientName}`);

  try {
    const csv = await exportGhlReadyCsv(client);
    if (csv.error) {
      return res.status(500).json({ error: csv.error });
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${client.consultantNum}_ghl_contacts.csv"`);
    res.send(csv);
  } catch (e) {
    logger.error(`[API] Export CSV failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/logs — Server-Sent Events log stream ──
router.get("/api/logs", (req, res, next) => requireStreamTicket("logs", req, res, next), (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const unsubscribe = logger.subscribeLogStream(res);

  req.on("close", () => {
    unsubscribe();
    logger.info("[API] Log stream subscriber disconnected.");
  });
});

// ── GET /api/schedule — Get current schedule configuration ──
router.get("/api/schedule", requireAuth, (req, res) => {
  try {
    const schedule = getServerConfig().schedule || {};
    res.json({
      cron:       schedule.cron || "30 0 * * *",
      timezone:   schedule.timezone || "America/Chicago",
      enabled:    schedule.enabled !== false,
      clients:    getClients().length
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/schedule — Update schedule configuration ──
router.post("/api/schedule", requireAuth, async (req, res) => {
  try {
    const { cron, timezone, enabled } = req.body;
    const patch = {};
    if (cron !== undefined) patch.cron = cron;
    if (timezone !== undefined) patch.timezone = timezone;
    if (enabled !== undefined) patch.enabled = enabled;
    const schedule = persistSchedule(patch);
    logger.info(`[API] Schedule updated: ${schedule.cron} (${schedule.timezone}) [enabled: ${schedule.enabled}]`);

    // Restart cron with the persisted schedule. Client secrets are never
    // rewritten when configuration is supplied by the secret store.
    restartCron();

    res.json({
      status: "updated",
      schedule
    });
  } catch (e) {
    logger.error(`[API] Schedule update failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/progress — Server-Sent Events progress stream ──
router.get("/api/progress", (req, res, next) => requireStreamTicket("progress", req, res, next), (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const unsubscribe = subscribeProgress(res);

  // Send current state immediately
  const current = getProgressStream();
  if (current) {
    try { res.write(`data: ${JSON.stringify(current)}\n\n`); } catch (_) {}
  }

  req.on("close", () => {
    unsubscribe();
  });
});

// ── POST /api/cron/enable — Enable scheduled sync ──
router.post("/api/cron/enable", requireAuth, (req, res) => {
  try {
    persistSchedule({ enabled: true });
    startCron();

    res.json({ status: "enabled", message: "Scheduled sync enabled." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/cron/disable — Disable scheduled sync ──
router.post("/api/cron/disable", requireAuth, (req, res) => {
  try {
    persistSchedule({ enabled: false });
    stopCron();

    res.json({ status: "disabled", message: "Scheduled sync disabled." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function publicLogEvent(entry) {
  return {
    eventId: entry.event_id || entry.eventId || entry.id || null,
    timestamp: entry.timestamp || null,
    level: entry.level || "info",
    category: entry.category || "system",
    clientId: entry.client_id || entry.clientId || null,
    executionId: entry.execution_id || entry.executionId || null,
    operation: entry.operation || null,
    status: entry.status || null,
    errorCode: entry.error_code || entry.errorCode || null,
    retryable: Boolean(entry.retryable),
    message: entry.message || "Log event received.",
    metadata: entry.metadata || {}
  };
}

// ── GET /api/v1/log-events — Durable structured operational events ──
router.get("/api/v1/log-events", requireAuth, async (req, res) => {
  try {
    const filters = parseLogFilters(req.query);
    let events;
    let source = "local_file";
    if (supabase.isEnabled()) {
      events = await supabase.queryRecentLogs(filters.limit, filters.level, filters.since, filters);
      source = "supabase";
    } else {
      events = logger.readRecentFileEntries({
        limit: filters.limit,
        level: filters.level || "all",
        category: filters.category,
        status: filters.status
      });
    }
    res.json({ events: events.map(publicLogEvent), count: events.length, source, filters });
  } catch (e) {
    const invalid = /Invalid log|must be an integer/.test(e.message);
    res.status(invalid ? 400 : 503).json({ error: e.message, code: invalid ? "INVALID_LOG_FILTER" : "LOG_STORAGE_UNAVAILABLE" });
  }
});

// ── GET /api/logs/recent — Legacy-compatible recent log response ──
router.get("/api/logs/recent", requireAuth, async (req, res) => {
  try {
    const filters = parseLogFilters(req.query);
    let entries = supabase.isEnabled()
      ? await supabase.queryRecentLogs(filters.limit, filters.level, filters.since, filters)
      : logger.readRecentFileEntries({
        limit: filters.limit,
        level: filters.level || "all",
        category: filters.category,
        status: filters.status
      });
    entries = entries.map(publicLogEvent);
    res.json({ logs: entries, count: entries.length });
  } catch (e) {
    const invalid = /Invalid log|must be an integer/.test(e.message);
    res.status(invalid ? 400 : 503).json({ error: e.message, code: invalid ? "INVALID_LOG_FILTER" : "LOG_STORAGE_UNAVAILABLE" });
  }
});

// ── GET /api/schedule/next — Get next scheduled run time ──
router.get("/api/schedule/next", requireAuth, (req, res) => {
  const cron = require("node-cron");
  try {
    const schedule = getServerConfig().schedule || {};
    if (!schedule.enabled) {
      return res.json({ nextRun: null, message: "Scheduled sync is disabled." });
    }
    const cronExpr = schedule.cron || "30 0 * * *";
    const tz = schedule.timezone || "America/Chicago";

    // Calculate next run time manually
    const now = new Date();
    const [minute, hour] = cronExpr.split(" ");
    const min = parseInt(minute);
    const hr = parseInt(hour);

    // Use a simple calculation for daily schedule
    const nextRun = new Date(now);
    nextRun.setHours(hr, min, 0, 0);
    if (nextRun <= now) {
      nextRun.setDate(nextRun.getDate() + 1);
    }

    // Adjust for timezone (simplified)
    const utcNow = new Date();
    const tzOffset = getTzOffsetMinutes(tz);
    nextRun.setMinutes(nextRun.getMinutes() + tzOffset);

    res.json({
      nextRun: nextRun.toISOString(),
      cron: cronExpr,
      timezone: tz,
      enabled: true
    });
  } catch (e) {
    res.json({ nextRun: null, error: e.message });
  }
});

function getTzOffsetMinutes(tz) {
  const offsets = {
    "America/Chicago": -300,
    "America/New_York": -240,
    "America/Los_Angeles": -420,
    "America/Denver": -360,
    "America/Anchorage": -480,
    "Pacific/Honolulu": -600,
    "Europe/London": 60,
    "Europe/Paris": 120,
    "Asia/Kolkata": 330,
    "Asia/Tokyo": 540
  };
  return offsets[tz] || 0;
}

// ── GET /api/history/execution — Get recent sync executions from Supabase ──
router.get("/api/history/execution", requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const executions = await supabase.queryRecentExecutions(limit);
    res.json({ executions, count: executions.length });
  } catch (e) {
    res.json({ executions: [], count: 0, error: e.message });
  }
});

// ── GET /api/history/execution/:id — Get full details of a sync execution ──
router.get("/api/history/execution/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const [execution, clientResults, contactResults] = await Promise.all([
      supabase.queryExecution(id),
      supabase.queryClientResults(id),
      supabase.queryContactResults(id)
    ]);
    res.json({ execution, clients: clientResults, contacts: contactResults });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/history/errors — Get recent sync errors from Supabase ──
router.get("/api/history/errors", requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const allExecs = await supabase.queryRecentExecutions(10);
    let allErrors = [];
    for (const exec of allExecs) {
      const errors = await supabase.queryContactResults(exec.id, "failed");
      allErrors = allErrors.concat(errors);
    }
    res.json({ errors: allErrors.slice(0, limit), count: allErrors.length });
  } catch (e) {
    res.json({ errors: [], count: 0, error: e.message });
  }
});

// ── GET /api/history/memory — Get memory history from Supabase ──
router.get("/api/history/memory", requireAuth, async (req, res) => {
  try {
    const hours = Math.min(parseInt(req.query.hours) || 24, 168); // max 7 days
    const snapshots = await supabase.queryMemoryHistory(hours);
    res.json({ snapshots, count: snapshots.length, hours });
  } catch (e) {
    res.json({ snapshots: [], count: 0, error: e.message });
  }
});

// ── GET /api/history/events — Get server events from Supabase ──
router.get("/api/history/events", requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const events = await supabase.queryServerEvents(limit);
    res.json({ events, count: events.length });
  } catch (e) {
    res.json({ events: [], count: 0, error: e.message });
  }
});

// ── GET /api/history/logs — Get logs from Supabase (persistent across restarts) ──
router.get("/api/history/logs", requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    const level = req.query.level || null;
    const since = req.query.since || null;
    const logs = await supabase.queryRecentLogs(limit, level, since);
    res.json({ logs, count: logs.length });
  } catch (e) {
    res.json({ logs: [], count: 0, error: e.message });
  }
});

module.exports = router;
