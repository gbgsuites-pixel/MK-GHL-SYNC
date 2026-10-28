const axios = require("axios");

const GHL_BASE_URL = "https://services.leadconnectorhq.com";
// The current locations custom-fields endpoint expects the v3 API version.
// The legacy 2021-07-28 header can return an incomplete field collection for
// contact-model lookups, which makes a newly onboarded client fail protected
// field validation even when the fields exist in the location.
const GHL_VERSION = "v3";

function normalizeCustomFields(payload) {
  const candidates = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.customFields)
    ? payload.customFields
    : Array.isArray(payload?.custom_fields)
    ? payload.custom_fields
    : Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.customFields?.customFields)
    ? payload.customFields.customFields
    : [];

  return candidates
    .map(field => ({
      id: field.id || field.fieldId || field.field_id,
      name: String(field.name || field.fieldName || field.field_name || field.label || "").trim().replace(/\s+/g, " "),
      objectKey: field.objectKey || field.object_key || field.fieldKey || field.field_key || null,
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

  let response;
  try {
    response = await axios.get(
      `${GHL_BASE_URL}/locations/${encodeURIComponent(locationId)}/customFields?model=contact`,
      {
        headers: {
          Authorization: `Bearer ${ghlApiToken}`,
          Version: GHL_VERSION,
          Accept: "application/json"
        },
        timeout: 15000,
        validateStatus: () => true
      }
    );
  } catch (error) {
    const wrapped = new Error("Unable to reach GoHighLevel custom-field service.");
    wrapped.code = "GHL_NETWORK_ERROR";
    wrapped.cause = error;
    throw wrapped;
  }

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

  const fields = normalizeCustomFields(response.data);
  if (fields.length === 0) {
    const error = new Error("GoHighLevel returned no custom fields for this location.");
    error.code = "CUSTOM_FIELDS_UNAVAILABLE";
    throw error;
  }

  return fields;
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
