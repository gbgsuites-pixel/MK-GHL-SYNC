// =============================================================================
// Mary Kay InTouch — GoHighLevel Sync Server (Puppeteer-Direct Architecture)
// Entry Point
// =============================================================================

require("dotenv").config();

const express = require("express");
const { loadConfig, getClients, setManagedClients } = require("./core/config");
const { startCron } = require("./scheduler/cron");
const { closeAllSessions } = require("./sessions/sessionManager");
const supabase = require("./core/supabase");
const logger = require("./utils/logger");
const routes = require("./api/routes");

const PORT = process.env.PORT || 3000;

// ── Initialize ──
logger.info("═══════════════════════════════════════════════════════");
logger.info("  Mary Kay InTouch — GoHighLevel Sync Server");
logger.info("  Version 2.1.0 (Puppeteer-Direct Architecture)");
logger.info("═══════════════════════════════════════════════════════");

// Load configuration
try {
  loadConfig();
} catch (e) {
  logger.error(`Configuration error: ${e.message}`);
  process.exit(1);
}

// Wire logger to Supabase for persistent log storage
logger.setSupabaseModule(supabase);

// Create Express app
const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});
app.use(express.json({ limit: "100kb" }));
let shuttingDown = false;
let httpServer = null;

// Render can send SIGTERM while an instance is still reachable. Stop new
// exports/syncs immediately so they cannot start a browser during shutdown.
app.use((req, res, next) => {
  if (shuttingDown) {
    return res.status(503).json({
      error: "Server is shutting down. Please retry shortly."
    });
  }
  next();
});

// ── Global Error Handlers — Prevent Puppeteer crashes from killing the process ──
// Catch unhandled promise rejections (e.g., Puppeteer ProtocolError)
process.on("unhandledRejection", (reason, promise) => {
  const errMessage = reason instanceof Error ? reason.message : String(reason);
  logger.error(`[Server] UNHANDLED REJECTION: ${errMessage}`);

  // Check if this is a Puppeteer-related error that should not kill the process
  const isPuppeteerError =
    errMessage.includes("ProtocolError") ||
    errMessage.includes("Target closed") ||
    errMessage.includes("Session closed") ||
    errMessage.includes("Network.enable timed out") ||
    errMessage.includes("CDP") ||
    errMessage.includes("NetworkManager");

  if (isPuppeteerError) {
    logger.warn(`[Server] Puppeteer error detected — logging but NOT killing the process.`);
    logger.warn(`[Server] Active syncs will be terminated gracefully by their own error handlers.`);
  } else {
    // For non-Puppeteer errors, log full stack trace and exit
    logger.error(`[Server] Fatal non-Puppeteer error — shutting down.`);
    logger.error(`[Server] Stack: ${reason instanceof Error ? reason.stack : "N/A"}`);
    process.exit(1);
  }
});

// Catch uncaught exceptions
process.on("uncaughtException", (err) => {
  const isPuppeteerError =
    err.message.includes("ProtocolError") ||
    err.message.includes("Target closed") ||
    err.message.includes("Session closed") ||
    err.message.includes("Network.enable timed out") ||
    err.message.includes("CDP");

  if (isPuppeteerError) {
    logger.error(`[Server] UNCAUGHT PUPPETEER EXCEPTION: ${err.message}`);
    logger.warn(`[Server] Puppeteer error — logging but NOT killing the process.`);
  } else {
    logger.error(`[Server] UNCAUGHT EXCEPTION: ${err.message}`);
    logger.error(`[Server] Stack: ${err.stack}`);
    process.exit(1);
  }
});

// ── Memory Monitoring — Log memory usage every 60 seconds ──
function logMemoryUsage() {
  const mem = process.memoryUsage();
  const rssMB = Math.round(mem.rss / 1024 / 1024);
  const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
  logger.info(`[Server] Memory: RSS=${rssMB}MB, Heap Used=${heapUsedMB}MB, Heap Total=${heapTotalMB}MB`);

  // ── Supabase: Record memory snapshot ──
  try {
    supabase.recordMemorySnapshot(rssMB, heapUsedMB, heapTotalMB);
  } catch (_) {}
}

// Log memory every 60 seconds to detect leaks
const memoryMonitor = setInterval(logMemoryUsage, 60000);
// Prevent the monitor from keeping the process alive
if (memoryMonitor.unref) memoryMonitor.unref();

// ── Keep-Alive Mechanism — Prevent Render from spinning down the instance ──
// Render free tier spins down after 15 minutes of inactivity.
// This self-ping keeps the process alive even when no external requests arrive.
const KEEP_ALIVE_INTERVAL_MS = parseInt(process.env.KEEP_ALIVE_INTERVAL_MS) || 300000; // 5 min
let keepAliveInterval = null;

function startKeepAlive() {
  if (process.env.RENDER === undefined && !process.env.RENDER_INSTANCE_ID) {
    // Not running on Render, skip keep-alive
    logger.info("[Server] Keep-alive not needed (not on Render).");
    return;
  }

  keepAliveInterval = setInterval(async () => {
    try {
      const http = require("http");
      await new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:${PORT}/health`, (res) => {
          res.resume();
          resolve();
        });
        req.on("error", reject);
        req.setTimeout(5000, () => {
          req.destroy();
          reject(new Error("Keep-alive ping timeout"));
        });
      });
      logger.debug(`[Server] Keep-alive ping successful.`);

      // Record keep-alive event in Supabase
      try { supabase.recordServerEvent("keep_alive", { timestamp: new Date().toISOString() }); } catch (_) {}
    } catch (e) {
      logger.warn(`[Server] Keep-alive ping failed: ${e.message}`);
    }
  }, KEEP_ALIVE_INTERVAL_MS);

  // Allow the interval to be cleared on shutdown
  if (keepAliveInterval.unref) keepAliveInterval.unref();
  logger.info(`[Server] Keep-alive enabled: pinging /health every ${KEEP_ALIVE_INTERVAL_MS / 1000}s`);
}

// Mount routes
app.use("/", routes);

// ── Start Server ──
httpServer = app.listen(PORT, () => {
  logger.info(`[Server] Listening on port ${PORT}`);

  // Initialize Supabase before starting cron so managed client status is
  // hydrated before the first scheduled execution can run.
  (async () => {
    try {
      await supabase.initialize();
      if (supabase.isEnabled()) {
        logger.info("[Supabase] Initialized successfully.");
        if (["1", "true", "yes", "on"].includes(String(process.env.MANAGED_CLIENTS_ENABLED || "").toLowerCase())) {
          try {
            const managedClients = await supabase.loadManagedClients();
            const bootstrapClientCount = getClients().length;
            if (managedClients.length === 0 && bootstrapClientCount > 0) {
              logger.error(
                `[Supabase] Managed client table is empty; retaining ${bootstrapClientCount} ` +
                "external fallback client(s) and refusing to start managed mode with zero clients."
              );
            } else {
              setManagedClients(managedClients);
              logger.info(`[Supabase] Hydrated ${managedClients.length} managed client(s).`);
            }
          } catch (error) {
            logger.error(`[Supabase] Managed client hydration failed: ${error.message}`);
          }
        }
      }
    } catch (e) {
      logger.warn(`[Supabase] Init error: ${e.message}`);
    } finally {
      startCron();
    }
  })();

  // Start keep-alive to prevent Render idle sleep
  startKeepAlive();

  logger.info("[Server] Ready.");
  logger.info(`[Server] Health check: http://localhost:${PORT}/health`);
  logger.info("[Server] Architecture: Puppeteer-Direct (browser stays alive for API calls)");
  logger.info(`[Server] Global error handlers: ACTIVE (Puppeteer errors will not kill process)`);

  // Log initial memory state
  logMemoryUsage();
});

// Graceful shutdown — stop accepting requests before closing browser sessions.
let shutdownPromise = null;
async function gracefulShutdown(signal) {
  if (shutdownPromise) return shutdownPromise;

  shutdownPromise = (async () => {
    shuttingDown = true;
    logger.info(`[Server] ${signal} received. Shutting down gracefully...`);
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    if (memoryMonitor) clearInterval(memoryMonitor);

    // Stop new connections and let any current response finish before the
    // browser session is closed underneath it.
    if (httpServer) {
      await new Promise((resolve) => httpServer.close(resolve));
    }

    await closeAllSessions();
    try { await supabase.recordServerEvent("server_shutdown", { reason: signal }); } catch (_) {}
    try { await supabase.shutdown(); } catch (_) {}
    process.exit(0);
  })();

  return shutdownPromise;
}

process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });
process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });

module.exports = app;
