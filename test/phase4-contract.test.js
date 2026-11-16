const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Tests must not depend on the gitignored local config/clients.json (CI has
// none). Supply a minimal in-memory client config and an isolated schedule path.
process.env.CLIENTS_CONFIG_JSON = JSON.stringify({
  clients: [{
    clientName: 'Test Client',
    consultantNum: 'T00001',
    password: 'test-password',
    ghlApiToken: 'test-token',
    ghlLocationId: 'test-location',
    ghlCustomFields: {},
  }],
  _serverConfig: {},
});
process.env.SCHEDULE_CONFIG_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'mk-ghl-test-')),
  'schedule.json'
);
delete process.env.SCHEDULE_ENABLED;

const {
  encryptSecrets,
  decryptSecrets,
  safeManagedClient,
} = require('../src/security/clientSecrets');
const {
  normalizeCustomFields,
  customFieldMap,
} = require('../src/core/ghlAdmin');
const {
  PROTECTED_CUSTOM_FIELDS,
  compareProtectedFieldMapping,
  hasCompleteProtectedFieldMapping,
  missingProtectedFieldNames,
  inspectProtectedFieldSource,
} = require('../src/core/protectedFields');
const { buildCustomFieldsPayload } = require('../src/sync/ghlSync');
const config = require('../src/core/config');
const { _withSessionLock } = require('../src/sessions/sessionManager');
const cronScheduler = require('../src/scheduler/cron');

const originalEncryptionKey = process.env.CLIENT_SECRET_ENCRYPTION_KEY;

test.after(() => {
  if (originalEncryptionKey === undefined) delete process.env.CLIENT_SECRET_ENCRYPTION_KEY;
  else process.env.CLIENT_SECRET_ENCRYPTION_KEY = originalEncryptionKey;
});

test('managed client secrets round-trip without plaintext persistence', () => {
  process.env.CLIENT_SECRET_ENCRYPTION_KEY = 'phase4-test-encryption-key';
  const secrets = { password: 'fixture-password', ghlApiToken: 'fixture-token' };
  const encrypted = encryptSecrets(secrets);
  assert.ok(encrypted.startsWith('v1.'));
  assert.equal(encrypted.includes(secrets.password), false);
  assert.deepEqual(decryptSecrets(encrypted), secrets);
  assert.equal(safeManagedClient({ client_name: 'Fixture', consultant_num: 'Z02587' }).password, undefined);
});

test('custom-field normalization returns a stable name-to-ID map', () => {
  const adminSource = fs.readFileSync(path.join(__dirname, '../src/core/ghlAdmin.js'), 'utf8');
  assert.match(adminSource, /version: "v3", model: "contact"/);
  assert.match(adminSource, /version: "2021-07-28", model: "contact"/);
  assert.match(adminSource, /customFields\?model=\$\{variant\.model\}/);
  const fields = normalizeCustomFields({ customFields: [
    { id: 'field-career', name: '  Career   Level ' },
    { id: 'field-wholesale', name: 'Current Wholesale' },
  ] });
  assert.deepEqual(customFieldMap(fields), {
    'Career Level': 'field-career',
    'Current Wholesale': 'field-wholesale',
  });
});

test('custom-field normalization supports nested responses and field keys', () => {
  const fields = normalizeCustomFields({ data: { customFields: [
    { id: 'field-activity', fieldKey: 'contact.Activity Status', model: 'contact' },
  ] } });
  assert.deepEqual(customFieldMap(fields), { 'Activity Status': 'field-activity' });
});

test('onboarding can identify incomplete protected-field mappings before storage', () => {
  const incomplete = { 'Activity Status': 'field-activity' };
  assert.equal(hasCompleteProtectedFieldMapping(incomplete), false);
  assert.deepEqual(missingProtectedFieldNames(incomplete), PROTECTED_CUSTOM_FIELDS.slice(1));
});

test('managed client routes support GHL onboarding and permanent removal', () => {
  const routes = fs.readFileSync(path.join(__dirname, '../src/api/routes.js'), 'utf8');
  assert.match(routes, /fetchLocationCustomFields\(\s*input\.ghlApiToken/);
  assert.match(routes, /customFieldMap\(customFields\)/);
  assert.match(routes, /input\.ghlCustomFields = customFieldsMap/);
  assert.match(routes, /GHL_PROTECTED_FIELDS_MISSING/);
  assert.match(routes, /completeMappingFromSameLocation/);
  assert.match(routes, /router\.delete\("\/api\/v1\/clients\/\:id\/permanent"/);
  assert.match(routes, /supabase\.deleteManagedClient\(req\.params\.id\)/);
});

test('protected fields block mapping drift and detect an interrupted source field', () => {
  const stored = Object.fromEntries(PROTECTED_CUSTOM_FIELDS.map((name) => [name, `stored-${name}`]));
  assert.equal(hasCompleteProtectedFieldMapping(stored), true);
  const live = { ...stored, 'Activity Status': 'live-activity-status' };
  const mapping = compareProtectedFieldMapping(stored, live);
  assert.equal(mapping.ok, false);
  assert.equal(mapping.changedIds[0].fieldName, 'Activity Status');

  const contacts = PROTECTED_CUSTOM_FIELDS.map((fieldName) => ({ customFields: { [fieldName]: fieldName === 'Current Wholesale' ? undefined : 'current' } }));
  const source = inspectProtectedFieldSource(contacts, {
    protectedFields: { 'Current Wholesale': { providedCount: 5 } },
  });
  assert.equal(source.ok, false);
  assert.match(source.alerts[0], /Current Wholesale/);
});

test('managed client hydration accepts serialized JSONB values', () => {
  const { parseJsonObject } = require('../src/security/clientSecrets');
  assert.deepEqual(parseJsonObject('{"Activity Status":"field-activity"}'), {
    'Activity Status': 'field-activity',
  });
});

test('GHL payload keeps only mapped non-empty custom fields', () => {
  const payload = buildCustomFieldsPayload({
    customFields: {
      'Career Level': 'Ruby',
      'Current Wholesale': '',
      'Unknown Field': 'do-not-send',
    },
  }, {
    'Career Level': 'field-career',
    'Current Wholesale': 'field-wholesale',
  });
  assert.deepEqual(payload, [{ id: 'field-career', field_value: 'Ruby' }]);
});

test('active-client selection excludes paused and disconnected records', () => {
  config.setManagedClients([
    { id: 'active', consultantNum: 'A1', status: 'active' },
    { id: 'paused', consultantNum: 'B1', status: 'paused' },
    { id: 'disconnected', consultantNum: 'C1', status: 'disconnected' },
  ]);
  assert.deepEqual(config.getActiveClients().map(client => client.id), ['active']);
});

test('blocked clients are appended to execution state once', () => {
  const orchestrator = fs.readFileSync(path.join(__dirname, '../src/scheduler/orchestrator.js'), 'utf8');
  assert.equal((orchestrator.match(/currentExecution\.clients\.push\(clientEntry\)/g) || []).length, 1);
  assert.equal((orchestrator.match(/results\.push\(clientEntry\)/g) || []).length, 1);
});

test('same-consultant session operations are serialized', async () => {
  const events = [];
  const first = _withSessionLock('Z02587', async () => {
    events.push('first:start');
    await new Promise(resolve => setTimeout(resolve, 20));
    events.push('first:end');
    return 'first';
  });
  const second = _withSessionLock('Z02587', async () => {
    events.push('second:start');
    events.push('second:end');
    return 'second';
  });
  assert.equal(await first, 'first');
  assert.equal(await second, 'second');
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
});

test('cron start is idempotent for the configured schedule', () => {
  cronScheduler.stopCron();
  cronScheduler.startCron();
  const first = cronScheduler.getActiveSchedule();
  cronScheduler.startCron();
  const second = cronScheduler.getActiveSchedule();
  assert.deepEqual(second, first);
  cronScheduler.stopCron();
  assert.equal(cronScheduler.isRunning(), false);
});

test('schedule defaults to enabled when nothing has been persisted', () => {
  config.setDurableSchedule(null);
  const schedule = config.getScheduleConfig();
  assert.equal(schedule.enabled, true);
  assert.equal(schedule.cron, '30 0 * * *');
  assert.equal(schedule.timezone, 'America/Chicago');
});

test('durable schedule overrides defaults and survives a lost local file', async () => {
  const saved = [];
  config.setDurableScheduleStore({ save: async (value) => { saved.push(value); } });
  try {
    const next = await config.persistSchedule({ enabled: false, cron: '0 6 * * *' });
    assert.equal(next.enabled, false);
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0], next);

    // Simulate a Render restart: local file gone, durable value reloaded.
    fs.rmSync(process.env.SCHEDULE_CONFIG_PATH, { force: true });
    config.setDurableSchedule(saved[0]);
    assert.equal(config.getScheduleConfig().enabled, false);
    assert.equal(config.getScheduleConfig().cron, '0 6 * * *');
  } finally {
    config.setDurableScheduleStore(null);
    config.setDurableSchedule(null);
  }
});

test('a failed durable save is surfaced instead of reported as saved', async () => {
  config.setDurableScheduleStore({ save: async () => { throw new Error('settings table missing'); } });
  try {
    await assert.rejects(config.persistSchedule({ enabled: true }), /settings table missing/);
  } finally {
    config.setDurableScheduleStore(null);
  }
});

test('blocked sync keeps the previous protected-field baseline', async () => {
  const supabase = require('../src/core/supabase');
  const { _persistManagedClientSyncResult } = require('../src/scheduler/orchestrator');
  const original = supabase.updateManagedClient;
  const writes = [];
  supabase.updateManagedClient = async (id, patch) => { writes.push(patch); return {}; };
  try {
    const baseline = { 'Career Level': { providedCount: 40 } };
    const client = { id: 'c1', clientName: 'C', lastSyncStats: { protectedFields: baseline } };

    await _persistManagedClientSyncResult(client, 'blocked', {
      message: 'Mary Kay login failed', stats: { blocked: true, errorCode: 'MK_SITE_UNAVAILABLE' },
    });
    assert.deepEqual(writes[0].lastSyncStats.protectedFields, baseline);
    assert.equal(writes[0].lastSyncStats.errorCode, 'MK_SITE_UNAVAILABLE');
    // The cached client object is refreshed in place.
    assert.equal(client.lastSyncStatus, 'blocked');

    const fresh = { 'Career Level': { providedCount: 42 } };
    await _persistManagedClientSyncResult(client, 'completed', {
      stats: { protectedFieldStats: fresh },
    });
    assert.deepEqual(writes[1].lastSyncStats.protectedFields, fresh);
  } finally {
    supabase.updateManagedClient = original;
  }
});
