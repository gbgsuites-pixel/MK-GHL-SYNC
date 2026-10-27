// =============================================================================
// ORCHESTRATOR
// Coordinates the complete sync workflow across all configured clients.
// Manages state tracking, error aggregation, and progress reporting.
//
// CHANGES (v2.1.0):
// - Explicitly closes browser sessions after each client to prevent memory leaks
// - Safe error termination: Puppeteer errors no longer crash the entire process
// - Memory cleanup between clients to reduce cumulative RAM usage
// - Supabase persistence: execution history, client results, contact errors
// =============================================================================

const { processClient } = require("../processors/dataProcessor");
const { syncToGhl } = require("../sync/ghlSync");
const { invalidateSession, closeAllSessions } = require("../sessions/sessionManager");
const { startExecution, updatePhase, updateGhlProgress, completeClient, failClient, completeExecution } = require("./progress.js");
const supabase = require("../core/supabase");
const logger = require("../utils/logger");

// ── Execution State ──
let currentExecution = null;
let isRunning = false;
let currentExecutionId = null; // Supabase execution ID

/**
 * Get the current execution state.
 */
function getExecutionState() {
  if (!currentExecution) return null;
  return {
    status:     isRunning ? "running" : (currentExecution.status || "completed"),
    executionId: currentExecution.executionId || currentExecutionId,
    startTime:  currentExecution.startTime,
    clients:    currentExecution.clients.map(c => ({
      name:        c.name,
      status:      c.status,
      stats:       c.stats,
      ghlResult:   c.ghlResult
    }))
  };
}

async function cleanupClientSession(client) {
  try {
    logger.info(`[Orchestrator] Closing browser session for ${client.clientName}...`);
    await invalidateSession(client.consultantNum);
    if (global.gc) global.gc();
  } catch (cleanupErr) {
    logger.warn(`[Orchestrator] Browser cleanup for ${client.clientName} had issues: ${cleanupErr.message}`);
  }
}

async function persistManagedClientSyncResult(client, status, details = {}) {
  if (!client?.id || typeof supabase.updateManagedClient !== "function") return;
  const stats = details.stats || {};
  try {
    await supabase.updateManagedClient(client.id, {
      lastSyncAt: new Date().toISOString(),
      lastSyncStatus: status,
      lastSyncStats: {
        contacts: Number(details.contacts) || 0,
        synced: Number(details.synced) || 0,
        errors: Number(details.errors) || 0,
        skipped: Number(details.skipped) || 0,
        consultants: Number(stats.consultantListCount) || 0,
        customers: Number(stats.customerListCount) || 0,
        message: details.message || null,
        protectedFieldAlerts: details.protectedFieldAlerts || stats.protectedFieldAlerts || [],
        protectedFields: details.protectedFieldStats || stats.protectedFieldStats || {}
      }
    });
  } catch (error) {
    logger.warn(`[Orchestrator] Could not persist last-sync metrics for ${client.clientName}: ${error.message}`);
  }
}

/**
 * Safe wrapper to ensure the orchestrator never crashes from Puppeteer errors.
 * All client processing is wrapped in a try/catch that logs and continues.
 */
async function runFullSync(clients) {
  if (isRunning) {
    logger.warn(`[Orchestrator] Sync already in progress. Ignoring new trigger.`);
    return { status: "already_running" };
  }

  isRunning = true;
  const execStartTime = new Date();

  currentExecution = {
    startTime: execStartTime.toISOString(),
    clients: []
  };

  // Notify frontend that sync has started
  startExecution(clients.length);

  // ── Supabase: Create execution record ──
  try {
    currentExecutionId = await supabase.createExecution("cron", clients.length);
    currentExecution.executionId = currentExecutionId;
    if (currentExecutionId) {
      await supabase.recordServerEvent("sync_started", {
        total_clients: clients.length,
        execution_id: currentExecutionId
      });
    }
  } catch (e) {
    logger.warn(`[Orchestrator] Supabase createExecution failed: ${e.message}`);
    currentExecutionId = null;
  }

  logger.info(`\n═══════════════════════════════════════════════════════`);
  logger.info(`[Orchestrator] Full sync started at ${execStartTime.toISOString()}`, {
    category: "sync",
    operation: "full_sync",
    status: "started",
    executionId: currentExecutionId
  });
  logger.info(`[Orchestrator] Processing ${clients.length} client(s)`, {
    category: "sync",
    operation: "client_batch",
    executionId: currentExecutionId,
    metadata: { totalClients: clients.length }
  });
  logger.info(`═══════════════════════════════════════════════════════\n`);

  const results = [];

  for (let clientIndex = 0; clientIndex < clients.length; clientIndex++) {
    const client = clients[clientIndex];
    const clientEntry = {
      name:   client.clientName,
      status: "in_progress",
      stats:  null,
      ghlResult: null
    };

    // Log memory before each client to track accumulation
    const memBefore = process.memoryUsage();
    const rssBefore = Math.round(memBefore.rss / 1024 / 1024);
    logger.info(`[Orchestrator] Client ${clientIndex + 1}/${clients.length}: ${client.clientName} (Memory: ${rssBefore}MB)`, {
      category: "sync",
      operation: "client_sync",
      status: "started",
      clientId: client.id || client.consultantNum,
      executionId: currentExecutionId,
      metadata: { clientIndex: clientIndex + 1, totalClients: clients.length, rssBeforeMb: rssBefore }
    });

    try {
      // Phase 1: Data Fetch
      updatePhase(client.clientName, "fetching_data", { message: "Fetching Mary Kay data..." });
      logger.info(`\n>>> Phase 1: Data Fetch — ${client.clientName}`, {
        category: "source_fetch",
        operation: "source_fetch",
        status: "started",
        clientId: client.id || client.consultantNum,
        executionId: currentExecutionId
      });

      // ── Supabase: Record client start ──
      try {
        await supabase.createClientResult(currentExecutionId, client, "in_progress", "fetching_data");
      } catch (_) {}

      const { contacts, stats } = await processClient(client);
      clientEntry.stats = stats;

      // Update progress with data fetch results
      updatePhase(client.clientName, "data_fetched", {
        consultants: stats.consultantListCount,
        customers: stats.customerListCount,
        salesVolume: stats.salesVolumeCount,
        starConsultants: stats.starConsultantCount,
        totalContacts: contacts.length,
        message: `${contacts.length} contacts ready for GHL sync`
      });

      if (contacts.length === 0) {
        const blocked = stats.blocked === true;
        const reason = blocked
          ? (stats.errors || []).join("; ") || "Required source fetch failed"
          : "No contacts to sync";
        logger.warn(`>>> ${blocked ? "Blocking" : "No contacts"} for ${client.clientName}: ${reason}`);
        clientEntry.status = blocked ? "blocked" : "no_contacts";
        clientEntry.error = reason;
        failClient(client.clientName, reason);
        await persistManagedClientSyncResult(client, clientEntry.status, {
          contacts: 0,
          errors: blocked ? 1 : 0,
          message: reason,
          stats,
          protectedFieldAlerts: stats.protectedFieldAlerts,
          protectedFieldStats: stats.protectedFieldStats
        });

        // ── Supabase: Complete client result ──
        try {
          await supabase.completeClientResult(currentExecutionId, client.clientName, client.consultantNum, stats, null, reason);
        } catch (_) {}

        continue;
      }

      // Phase 2: Sync to GHL
      logger.info(`\n>>> Phase 2: GHL Sync — ${client.clientName}`, {
        category: "upload",
        operation: "ghl_sync",
        status: "started",
        clientId: client.id || client.consultantNum,
        executionId: currentExecutionId
      });
      updatePhase(client.clientName, "ghl_sync", { message: "Syncing contacts to GoHighLevel..." });

      const ghlResult = await syncToGhl(
        {
          apiToken:    client.ghlApiToken,
          locationId:  client.locationId,
          customFields: client.ghlCustomFields
        },
        contacts,
        client.clientName,
        { onProgress: (progress) => {
          updateGhlProgress(
            client.clientName,
            progress.cursor,
            progress.total,
            progress.synced,
            progress.skipped,
            progress.chunkErrors
          );
        }}
      );

      clientEntry.ghlResult = ghlResult;
      clientEntry.status = ghlResult.errors && ghlResult.errors.length > 0
        ? "partial_success"
        : "completed";

      // Update stats
      stats.ghlSynced = ghlResult.synced;
      stats.ghlErrors = ghlResult.errors.length;

      completeClient(client.clientName, stats, ghlResult);
      await persistManagedClientSyncResult(client, clientEntry.status, {
        contacts: contacts.length,
        synced: ghlResult.synced,
        errors: ghlResult.errors.length,
        skipped: ghlResult.skipped || stats.skipped || 0,
        stats,
        protectedFieldAlerts: stats.protectedFieldAlerts,
        protectedFieldStats: stats.protectedFieldStats
      });

      logger.info(`\n>>> ${client.clientName} ${clientEntry.status.toUpperCase()}:`, {
        category: "upload",
        operation: "ghl_sync",
        status: clientEntry.status === "partial_success" ? "partial_success" : "succeeded",
        clientId: client.id || client.consultantNum,
        executionId: currentExecutionId,
        metadata: { contacts: contacts.length, synced: ghlResult.synced, errors: ghlResult.errors.length }
      });
      logger.info(`    Contacts: ${contacts.length}`);
      logger.info(`    GHL Synced: ${ghlResult.synced}`);
      logger.info(`    GHL Errors: ${ghlResult.errors.length}`);

      // ── Supabase: Complete client result + contact errors ──
      try {
        await supabase.completeClientResult(
          currentExecutionId,
          client.clientName,
          client.consultantNum,
          stats,
          ghlResult,
          null
        );
        if (ghlResult.errors && ghlResult.errors.length > 0) {
          await supabase.batchInsertContactResults(
            currentExecutionId,
            client.clientName,
            client.consultantNum,
            ghlResult.errors,
            contacts
          );
        }
      } catch (e) {
        logger.warn(`[Orchestrator] Supabase client result error: ${e.message}`);
      }

    } catch (e) {
      // Client-specific error — log it but DO NOT crash the process
      clientEntry.status = "failed";
      clientEntry.error = e.message;
      failClient(client.clientName, e.message);
      await persistManagedClientSyncResult(client, "failed", {
        contacts: 0,
        errors: 1,
        message: e.message,
        stats: clientEntry.stats || {},
        protectedFieldAlerts: clientEntry.stats?.protectedFieldAlerts,
        protectedFieldStats: clientEntry.stats?.protectedFieldStats
      });
      logger.error(`>>> ${client.clientName} FAILED: ${e.message}`, {
        category: "sync",
        operation: "client_sync",
        status: "failed",
        errorCode: e.code || "CLIENT_SYNC_FAILED",
        clientId: client.id || client.consultantNum,
        executionId: currentExecutionId,
        retryable: Boolean(e.retryable)
      });

      // ── Supabase: Record failure
      try {
        await supabase.completeClientResult(currentExecutionId, client.clientName, client.consultantNum, null, null, e.message);
      } catch (_) {}

    } finally {
      // Always clean up this client's browser session, regardless of outcome
      await cleanupClientSession(client);
      currentExecution.clients.push(clientEntry);
      results.push(clientEntry);
    }
  }

  const execEndTime = new Date();
  const durationMs = execEndTime - execStartTime;
  const durationMin = Math.round(durationMs / 60000 * 10) / 10;

  logger.info(`\n═══════════════════════════════════════════════════════`);
  logger.info(`[Orchestrator] Full sync completed at ${execEndTime.toISOString()}`);
  logger.info(`[Orchestrator] Duration: ${durationMin} minutes`);

  // Summary
  const successCount = results.filter(r => r.status === "completed").length;
  const partialCount = results.filter(r => r.status === "partial_success").length;
  const failCount    = results.filter(r => ["failed", "blocked"].includes(r.status)).length;
  const noContactCount = results.filter(r => r.status === "no_contacts").length;
  const summaryStatus = failCount === results.length && results.length > 0
    ? "failed"
    : (failCount > 0 || partialCount > 0 ? "completed_with_errors" : "completed");
  logger.info(`[Orchestrator] Results: ${successCount} succeeded, ${partialCount} partial, ${noContactCount} no-contact, ${failCount} failed/blocked`, {
    category: "sync",
    operation: "full_sync",
    status: summaryStatus,
    executionId: currentExecutionId,
    metadata: { successCount, partialCount, noContactCount, failCount, durationMs }
  });
  logger.info(`═══════════════════════════════════════════════════════\n`);

  isRunning = false;

  const summary = {
    status:    summaryStatus,
    startTime: execStartTime.toISOString(),
    endTime:   execEndTime.toISOString(),
    durationMs,
    durationMin,
    successCount,
    partialCount,
    noContactCount,
    failCount,
    results
  };

  currentExecution = { ...currentExecution, ...summary };
  completeExecution(summary);

  // ── Supabase: Complete execution record ──
  try {
    await supabase.completeExecution(currentExecutionId, summary);
    await supabase.recordServerEvent("sync_completed", {
      execution_id: currentExecutionId,
      duration_min: durationMin,
      success_count: successCount,
      fail_count: failCount
    });
  } catch (e) {
    logger.warn(`[Orchestrator] Supabase completeExecution failed: ${e.message}`);
  }

  currentExecutionId = null;

  return summary;
}

/**
 * Run sync for a single client.
 */
async function runSingleClientSync(client) {
  return runFullSync([client]);
}

module.exports = {
  runFullSync,
  runSingleClientSync,
  getExecutionState,
  isRunning: () => isRunning
};
