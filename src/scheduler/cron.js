// =============================================================================
// CRON SCHEDULER
// Handles time-based triggering of the sync workflow using node-cron.
// =============================================================================

const cron = require("node-cron");
const { getActiveClients, getServerConfig } = require("../core/config");
const { runFullSync } = require("./orchestrator");
const logger = require("../utils/logger");

let cronJob = null;
let activeSchedule = null;

/**
 * Start the cron scheduler if configured.
 */
function startCron() {
  const config = getServerConfig();
  const schedule = config.schedule || {};

  if (!schedule.enabled) {
    stopCron();
    logger.info("[Cron] Scheduled sync is disabled.");
    return;
  }

  const cronExpression = schedule.cron || "30 0 * * *";
  const timezone = schedule.timezone || "America/Chicago";

  // Validate cron expression
  if (!cron.validate(cronExpression)) {
    logger.error(`[Cron] Invalid cron expression: "${cronExpression}". Defaulting to daily at 00:30 CT.`);
    return;
  }

  if (cronJob && activeSchedule && activeSchedule.cron === cronExpression && activeSchedule.timezone === timezone) {
    logger.debug(`[Cron] Scheduler already active: "${cronExpression}" (${timezone}).`);
    return;
  }

  if (cronJob) {
    stopCron();
  }

  logger.info(`[Cron] Starting scheduled sync: "${cronExpression}" (${timezone})`);

  cronJob = cron.schedule(cronExpression, async () => {
    logger.info(`[Cron] Scheduled sync triggered.`);
    try {
      const clients = getActiveClients();
      await runFullSync(clients);
    } catch (e) {
      logger.error(`[Cron] Scheduled sync failed: ${e.message}`);
    }
  }, {
    scheduled: true,
    timezone:  timezone
  });

  cronJob.start();
  activeSchedule = { cron: cronExpression, timezone };
}

/**
 * Stop the cron scheduler.
 */
function stopCron() {
  if (cronJob) {
    cronJob.stop();
    if (typeof cronJob.destroy === "function") cronJob.destroy();
    cronJob = null;
    activeSchedule = null;
    logger.info("[Cron] Scheduled sync stopped.");
  }
}

/**
 * Restart the cron scheduler (after config reload).
 */
function restartCron() {
  stopCron();
  startCron();
}

module.exports = {
  startCron,
  stopCron,
  restartCron,
  isRunning: () => Boolean(cronJob),
  getActiveSchedule: () => activeSchedule ? { ...activeSchedule } : null
};
