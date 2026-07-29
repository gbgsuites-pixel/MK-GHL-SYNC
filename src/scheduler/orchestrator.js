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
    status:     isRunning ? "running" : "completed",
    startTime:  currentExecution.startTime,
    clients:    currentExecution.clients.map(c => ({
      name:        c.name,
      status:      c.status,
      stats:       c.stats,
      ghlResult:   c.ghlResult
    }))
  };
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
  logger.info(`[Orchestrator] Full sync started at ${execStartTime.toISOString()}`);
  logger.info(`[Orchestrator] Processing ${clients.length} client(s)`);
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
    logger.info(`[Orchestrator] Client ${clientIndex + 1}/${clients.length}: ${client.clientName} (Memory: ${rssBefore}MB)`);

    try {
      // Phase 1: Data Fetch
      updatePhase(client.clientName, "fetching_data", { message: "Fetching Mary Kay data..." });
      logger.info(`\n>>> Phase 1: Data Fetch — ${client.clientName}`);

      // ── Supabase: Record client start ──
      try {
        await supabase.createClientResult(currentExecutionId, client, "in_progress", "fetching_data");
      } catch (_) {}

      const { contacts, stats } = await processClient(client);
      clientEntry.stats = stats;

      // Update progress with data fetch results
      updatePhase(client.clientName, "data_fetched", {
        consultants: stats.consultants,
        customers: stats.customers,
        salesVolume: stats.salesVolume,
        starConsultants: stats.starConsultants,
        totalContacts: contacts.length,
        message: `${contacts.length} contacts ready for GHL sync`
      });

      if (contacts.length === 0) {
        logger.warn(`>>> No contacts to sync for ${client.clientName}. Skipping GHL sync.`);
        clientEntry.status = "no_contacts";
        failClient(client.clientName, "No contacts to sync");

        // ── Supabase: Complete client result ──
        try {
          await supabase.completeClientResult(currentExecutionId, client.clientName, client.consultantNum, stats, null, "No contacts to sync");
        } catch (_) {}

        continue;
      }

      // Phase 2: Sync to GHL
      logger.info(`\n>>> Phase 2: GHL Sync — ${client.clientName}`);
      updatePhase(client.clientName, "ghl_sync", { message: "Syncing contacts to GoHighLevel..." });

      const ghlResult = await syncToGhl(
        {
          apiToken:    client.ghlApiToken,
          locationId:  client.ghlLocationId,
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
      clientEntry.status = "completed";

      // Update stats
      stats.ghlSynced = ghlResult.synced;
      stats.ghlErrors = ghlResult.errors.length;

      completeClient(client.clientName, stats, ghlResult);

      logger.info(`\n>>> ${client.clientName} COMPLETE:`);
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
      logger.error(`>>> ${client.clientName} FAILED: ${e.message}`);

      // ── Supabase: Record failure ──
      try {
        await supabase.completeClientResult(currentExecutionId, client.clientName, client.consultantNum, null, null, e.message);
      } catch (_) {}
    }

    currentExecution.clients.push(clientEntry);
    results.push(clientEntry);

    // ── CRITICAL: Close browser session and free memory after each client ──
    // This prevents cumulative memory growth across the multi-client sequence.
    // The session cache will be rebuilt on the next client if credentials are still valid.
    try {
      logger.info(`[Orchestrator] Closing browser session for ${client.clientName} to free memory...`);
      await invalidateSession(client.consultantNum);

      // Force garbage collection hint (if available)
      if (global.gc) {
        global.gc();
      }
    } catch (cleanupErr) {
      logger.warn(`[Orchestrator] Browser cleanup for ${client.clientName} had issues: ${cleanupErr.message}`);
    }

    // Log memory after cleanup
    const memAfter = process.memoryUsage();
    const rssAfter = Math.round(memAfter.rss / 1024 / 1024);
    const freed = rssBefore - rssAfter;
    logger.info(`[Orchestrator] Post-cleanup memory: ${rssAfter}MB (freed ${freed}MB)`);

    // ── Memory Safety: Force close ALL sessions if memory is critically high ──
    // This is a safety net for the cumulative memory leak across clients
    const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const MEMORY_LIMIT_MB = parseInt(process.env.MEMORY_LIMIT_MB) || 1500;
    if (rssMB > MEMORY_LIMIT_MB) {
      logger.warn(`[Orchestrator] WARNING: Memory at ${rssMB}MB exceeds safety limit of ${MEMORY_LIMIT_MB}MB.`);
      logger.warn(`[Orchestrator] Closing ALL browser sessions to prevent OOM crash...`);
      try {
        await closeAllSessions();
      } catch (e) {
        logger.warn(`[Orchestrator] Force close all sessions error: ${e.message}`);
      }
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
  const failCount    = results.filter(r => r.status === "failed").length;
  logger.info(`[Orchestrator] Results: ${successCount} succeeded, ${failCount} failed`);
  logger.info(`═══════════════════════════════════════════════════════\n`);

  isRunning = false;

  const summary = {
    status:    "completed",
    startTime: execStartTime.toISOString(),
    endTime:   execEndTime.toISOString(),
    durationMs,
    durationMin,
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
