const axios = require("axios");

const GHL_BASE_URL = "https://services.leadconnectorhq.com";
const GHL_API_VARIANTS = [
  { version: "v3", model: "contact" },
  { version: "v3", model: "all" },
  { version: "2021-07-28", model: "contact" },
  { version: "2021-07-28", model: "all" }
];

function unwrapCustomFieldCandidates(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.customFields)) return payload.customFields;
  if (Array.isArray(payload?.custom_fields)) return payload.custom_fields;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.customFields?.customFields)) return payload.customFields.customFields;
  if (Array.isArray(payload?.data?.customFields)) return payload.data.customFields;
  return [];
}

function normalizeFieldName(value) {
  return String(value || "")
    .replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCustomFields(payload) {
  const candidates = unwrapCustomFieldCandidates(payload);

  return candidates
    .map(field => ({
      id: field.id || field.fieldId || field.field_id,
      name: normalizeFieldName(
        field.name || field.fieldName || field.field_name || field.label ||
        String(field.fieldKey || field.field_key || "").split(".").pop()
      ),
      objectKey: field.objectKey || field.object_key || field.fieldKey || field.field_key || null,
      model: String(field.model || field.object || field.objectType || "").toLowerCase(),
      type: field.dataType || field.type || null
    }))
    .filter(field => field.id && field.name);
}

async function fetchLocationCustomFields(ghlApiToken, locationId) {
  if (!ghlApiToken || !locationId) {
    const error = new Error("GoHighLevel token and location ID are required.");
    error.code = "GHL_AUTH_INPUT_MISSING";
    throw error;
  }

  const merged = new Map();
  const errors = [];

  for (const variant of GHL_API_VARIANTS) {
    try {
      const response = await axios.get(
        `${GHL_BASE_URL}/locations/${encodeURIComponent(locationId)}/customFields?model=${variant.model}`,
        {
          headers: {
            Authorization: `Bearer ${ghlApiToken}`,
            Version: variant.version,
            Accept: "application/json"
          },
          timeout: 15000,
          validateStatus: () => true
        }
      );

      if (response.status === 401 || response.status === 403) {
        const error = new Error("GoHighLevel rejected the private integration token.");
        error.code = "GHL_AUTH_FAILED";
        throw error;
      }
      if (response.status === 404) {
        const error = new Error("GoHighLevel location was not found.");
        error.code = "GHL_LOCATION_NOT_FOUND";
        throw error;
      }
      if (response.status >= 300) {
        const error = new Error(`GoHighLevel custom-field request failed with HTTP ${response.status}.`);
        error.code = "GHL_CUSTOM_FIELDS_UNAVAILABLE";
        throw error;
      }

      for (const field of normalizeCustomFields(response.data)) {
        const key = field.name.toLowerCase();
        const previous = merged.get(key);
        // Prefer a contact-model result over an all-model result, while still
        // allowing later API variants to fill fields omitted by the first one.
        if (!previous || (field.model === "contact" && previous.model !== "contact")) {
          merged.set(key, field);
        }
      }
    } catch (error) {
      errors.push(error);
      // A valid response from one variant is enough to continue. The merged
      // result is checked by the onboarding route for the required fields.
    }
  }

  const fields = [...merged.values()];
  if (fields.length > 0) return fields;

  const lastError = errors[errors.length - 1];
  if (lastError) throw lastError;
  const error = new Error("GoHighLevel returned no custom fields for this location.");
  error.code = "CUSTOM_FIELDS_UNAVAILABLE";
  throw error;
}

function customFieldMap(fields) {
  return fields.reduce((map, field) => {
    map[field.name] = field.id;
    return map;
  }, {});
}

module.exports = {
  fetchLocationCustomFields,
  normalizeCustomFields,
  customFieldMap
};
