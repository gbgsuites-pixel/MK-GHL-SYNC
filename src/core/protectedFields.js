const PROTECTED_CUSTOM_FIELDS = [
  "Activity Status",
  "Current Wholesale",
  "Career Level",
  "Client Last Order",
  "Needed for Sapphire",
  "Needed for Ruby",
  "Needed for Diamond",
  "Needed for Emerald",
  "Needed for Pearl"
];

function normalizeFieldMap(value) {
  return value && typeof value === "object" ? value : {};
}

function normalizeFieldName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function fieldIdMap(value) {
  return Object.entries(normalizeFieldMap(value)).reduce((map, [name, id]) => {
    const normalizedName = normalizeFieldName(name);
    if (normalizedName && id) map[normalizedName] = id;
    return map;
  }, {});
}

function compareProtectedFieldMapping(storedMap, liveMap) {
  const stored = normalizeFieldMap(storedMap);
  const live = normalizeFieldMap(liveMap);
  const storedIds = fieldIdMap(stored);
  const liveIds = fieldIdMap(live);
  const missingFromStored = [];
  const missingFromLive = [];
  const changedIds = [];

  for (const fieldName of PROTECTED_CUSTOM_FIELDS) {
    const normalizedName = normalizeFieldName(fieldName);
    const storedId = storedIds[normalizedName];
    const liveId = liveIds[normalizedName];
    if (!storedId) missingFromStored.push(fieldName);
    if (!liveId) missingFromLive.push(fieldName);
    if (storedId && liveId && storedId !== liveId) {
      changedIds.push({ fieldName, storedId, liveId });
    }
  }

  const alerts = [];
  if (missingFromStored.length > 0) {
    alerts.push(`Protected fields are missing from the stored mapping: ${missingFromStored.join(", ")}.`);
  }
  if (missingFromLive.length > 0) {
    alerts.push(`Protected fields are missing from the live GHL location: ${missingFromLive.join(", ")}.`);
  }
  if (changedIds.length > 0) {
    alerts.push(`Protected field IDs changed in GHL: ${changedIds.map(item => item.fieldName).join(", ")}.`);
  }

  return {
    ok: alerts.length === 0,
    missingFromStored,
    missingFromLive,
    changedIds,
    alerts
  };
}

function inspectProtectedFieldSource(contacts, previousSyncStats = {}) {
  const rows = Array.isArray(contacts) ? contacts : [];
  const previous = previousSyncStats?.protectedFields || {};
  const protectedFields = {};
  const alerts = [];

  for (const fieldName of PROTECTED_CUSTOM_FIELDS) {
    let providedCount = 0;
    let blankCount = 0;

    for (const contact of rows) {
      const value = contact?.customFields?.[fieldName];
      if (value === undefined || value === null || String(value).trim() === "") blankCount++;
      else providedCount++;
    }

    const previousProvidedCount = Number(previous[fieldName]?.providedCount) || 0;
    const interrupted = rows.length > 0 && providedCount === 0 && previousProvidedCount > 0;
    protectedFields[fieldName] = {
      contactCount: rows.length,
      providedCount,
      blankCount,
      previousProvidedCount,
      interrupted
    };

    if (interrupted) {
      alerts.push(
        `${fieldName} returned no values for ${rows.length} contacts; the previous sync had ${previousProvidedCount} populated value(s).`
      );
    }
  }

  return {
    ok: alerts.length === 0,
    protectedFields,
    alerts
  };
}

module.exports = {
  PROTECTED_CUSTOM_FIELDS,
  compareProtectedFieldMapping,
  inspectProtectedFieldSource
};
