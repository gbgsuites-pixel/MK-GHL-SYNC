// =============================================================================
// CONFIGURATION LOADER
// Loads and validates the multi-client configuration without requiring secrets
// to be committed to the repository.
//
// Runtime sources, in priority order:
//   1. CLIENTS_CONFIG_JSON — secret-store/runtime environment JSON
//   2. CONFIG_PATH         — externally supplied JSON file
//   3. config/clients.json  — local-development fallback only
//
// Set REQUIRE_EXTERNAL_CLIENT_CONFIG=true in production so the tracked local
// config can never be used by accident.
// =============================================================================

const fs = require("fs");
const path = require("path");

let config = null;
let configPath = null;
let configSource = null;
let managedClients = null;

const DEFAULT_CONFIG_PATH = path.join(__dirname, "../../config/clients.json");

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function getScheduleConfigPath() {
  if (process.env.SCHEDULE_CONFIG_PATH) {
    return path.resolve(process.env.SCHEDULE_CONFIG_PATH);
  }

  // When client configuration comes from a secret environment variable, keep
  // mutable schedule state outside that immutable secret value.
  if (["env", "managed"].includes(configSource?.type)) {
    return path.resolve(
      process.env.RUNTIME_DATA_DIR || path.join(process.cwd(), "runtime"),
      "schedule.json"
    );
  }

  // Preserve the existing local/file-config workflow unless an external
  // schedule path is explicitly configured.
  return configPath;
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Configuration file not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function isBundledClientConfig(filePath) {
  return path.resolve(filePath) === path.resolve(DEFAULT_CONFIG_PATH);
}

function resolveConfigSource() {
  const requireExternal = isTruthy(process.env.REQUIRE_EXTERNAL_CLIENT_CONFIG);
  const envJson = String(process.env.CLIENTS_CONFIG_JSON || "").trim();

  if (envJson) {
    return {
      type: "env",
      label: "CLIENTS_CONFIG_JSON",
      value: JSON.parse(envJson),
      path: null
    };
  }

  const configuredPath = String(process.env.CONFIG_PATH || "").trim();
  if (configuredPath) {
    const absolutePath = path.resolve(configuredPath);
    if (requireExternal && isBundledClientConfig(absolutePath)) {
      throw new Error(
        "SECURITY: CONFIG_PATH points to the repository client config. " +
        "Use CLIENTS_CONFIG_JSON or an external CONFIG_PATH instead."
      );
    }
    return {
      type: "file",
      label: absolutePath,
      value: readJsonFile(absolutePath),
      path: absolutePath
    };
  }

  if (requireExternal) {
    if (isTruthy(process.env.MANAGED_CLIENTS_ENABLED)) {
      if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
        throw new Error(
          "SECURITY: Managed client mode requires SUPABASE_URL and SUPABASE_KEY."
        );
      }
      if (!process.env.CLIENT_SECRET_ENCRYPTION_KEY) {
        throw new Error(
          "SECURITY: Managed client mode requires CLIENT_SECRET_ENCRYPTION_KEY."
        );
      }
      return {
        type: "managed",
        label: "Supabase integration_clients",
        value: loadManagedBootstrapFallback(),
        path: null
      };
    }
    throw new Error(
      "SECURITY: External client configuration is required. Set " +
      "CLIENTS_CONFIG_JSON or CONFIG_PATH to a secret-managed source."
    );
  }

  return {
    type: "local",
    label: DEFAULT_CONFIG_PATH,
    value: readJsonFile(DEFAULT_CONFIG_PATH),
    path: DEFAULT_CONFIG_PATH
  };
}

function loadManagedBootstrapFallback() {
  const fallbackPath = String(process.env.MANAGED_CLIENTS_FALLBACK_CONFIG_PATH || "").trim();
  if (!fallbackPath) return { clients: [], _serverConfig: {} };

  const absolutePath = path.resolve(fallbackPath);
  if (isBundledClientConfig(absolutePath)) {
    throw new Error(
      "SECURITY: MANAGED_CLIENTS_FALLBACK_CONFIG_PATH must point to an external backup, not the tracked repository client config."
    );
  }

  const fallback = readJsonFile(absolutePath);
  if (!fallback || !Array.isArray(fallback.clients)) {
    throw new Error("MANAGED_CLIENTS_FALLBACK_CONFIG_PATH must contain a clients array.");
  }
  return fallback;
}

function findDuplicateValues(clients, field) {
  const counts = new Map();
  for (const client of clients) {
    const value = String(client[field] || "").trim().toUpperCase();
    if (value) counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([value, count]) => ({ field, value, count }));
}

function validateConfig(parsed, allowEmpty = false, sourceType = "") {
  if (!parsed || !Array.isArray(parsed.clients) || (!allowEmpty && parsed.clients.length === 0)) {
    throw new Error("Configuration must contain a non-empty 'clients' array.");
  }

  const requiredFields = [
    "consultantNum", "password", "clientName",
    "ghlApiToken", "ghlLocationId", "ghlCustomFields"
  ];

  for (const client of parsed.clients) {
    for (const field of requiredFields) {
      if (!client[field]) {
        throw new Error(`Client "${client.clientName || "unknown"}" is missing required field: ${field}`);
      }
    }
    if (typeof client.ghlCustomFields !== "object") {
      throw new Error(`Client "${client.clientName}" ghlCustomFields must be an object.`);
    }
  }

  const duplicates = ["consultantNum", "clientName", "ghlLocationId"]
    .flatMap(field => findDuplicateValues(parsed.clients, field));
  if (duplicates.length > 0) {
    const details = duplicates.map(item => `${item.field}=${item.value} (${item.count} records)`).join(", ");
    const reject = isTruthy(process.env.REJECT_DUPLICATE_CLIENT_IDENTITIES) ||
      process.env.NODE_ENV === "production" || sourceType === "managed";
    if (reject) {
      throw new Error(`Duplicate client identities detected: ${details}`);
    }
    console.warn(`[Config] Duplicate client identities detected in local configuration: ${details}`);
  }
}

/**
 * Load the clients configuration from the secure runtime source.
 */
function loadConfig() {
  const source = resolveConfigSource();
  validateConfig(source.value, source.type === "managed", source.type);

  config = {
    clients: source.value.clients,
    server: source.value._serverConfig || {},
    rawPath: source.path,
    source: source.type,
    sourceLabel: source.label
  };

  configPath = source.path;
  configSource = source;
  console.log(`[Config] Loaded ${config.clients.length} client(s) from ${source.label}.`);

  return config;
}

/**
 * Reload configuration from disk or the runtime secret source.
 */
function reloadConfig() {
  console.log("[Config] Reloading configuration...");
  return loadConfig();
}

function readPersistedSchedule() {
  const schedulePath = getScheduleConfigPath();
  if (!schedulePath || !fs.existsSync(schedulePath)) return {};

  try {
    const parsed = JSON.parse(fs.readFileSync(schedulePath, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    throw new Error(`Schedule configuration is invalid: ${error.message}`);
  }
}

function getScheduleConfig() {
  if (!config) loadConfig();
  return {
    ...(config.server.schedule || {}),
    ...readPersistedSchedule()
  };
}

function writeJsonAtomically(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2));
  fs.renameSync(temporaryPath, filePath);
}

function persistSchedule(patch) {
  if (!config) loadConfig();
  const next = { ...getScheduleConfig(), ...patch };
  const schedulePath = getScheduleConfigPath();

  if (!schedulePath) {
    throw new Error("No writable schedule configuration path is available.");
  }

  writeJsonAtomically(schedulePath, next);
  config.server.schedule = next;
  return next;
}

function getClients() {
  if (!config) loadConfig();
  return managedClients || config.clients;
}

function getActiveClients() {
  return getClients().filter(client =>
    !client.status || client.status === "active"
  );
}

function getClientByNum(consultantNum) {
  if (!config) loadConfig();
  return getClients().find(c =>
    c.consultantNum.toUpperCase() === String(consultantNum || "").toUpperCase()
  );
}

function getClientById(id) {
  return getClients().find(client => String(client.id || "") === String(id || ""));
}

function setManagedClients(clients) {
  if (!Array.isArray(clients)) {
    throw new Error("Managed clients must be an array.");
  }
  managedClients = clients;
  return managedClients;
}

function clearManagedClients() {
  managedClients = null;
}

function isManagedClientsLoaded() {
  return Array.isArray(managedClients);
}

function getServerConfig() {
  if (!config) loadConfig();
  return {
    ...config.server,
    schedule: getScheduleConfig()
  };
}

function getConfigPath() {
  return configPath;
}

function getConfigSource() {
  return configSource ? {
    type: configSource.type,
    label: configSource.label,
    path: configSource.path
  } : null;
}

module.exports = {
  loadConfig,
  reloadConfig,
  getClients,
  getActiveClients,
  getClientByNum,
  getClientById,
  setManagedClients,
  clearManagedClients,
  isManagedClientsLoaded,
  getServerConfig,
  getConfigPath,
  getConfigSource,
  getScheduleConfig,
  persistSchedule
};
