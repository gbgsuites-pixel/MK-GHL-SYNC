const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
  assert.match(adminSource, /customFields\?model=contact/);
  assert.match(adminSource, /const GHL_VERSION = "v3"/);
  const fields = normalizeCustomFields({ customFields: [
    { id: 'field-career', name: '  Career   Level ' },
    { id: 'field-wholesale', name: 'Current Wholesale' },
  ] });
  assert.deepEqual(customFieldMap(fields), {
    'Career Level': 'field-career',
    'Current Wholesale': 'field-wholesale',
  });
});

test('onboarding can identify incomplete protected-field mappings before storage', () => {
  const incomplete = { 'Activity Status': 'field-activity' };
  assert.equal(hasCompleteProtectedFieldMapping(incomplete), false);
  assert.deepEqual(missingProtectedFieldNames(incomplete), PROTECTED_CUSTOM_FIELDS.slice(1));
});

test('managed client routes support GHL onboarding and permanent removal', () => {
  const routes = fs.readFileSync(path.join(__dirname, '../src/api/routes.js'), 'utf8');
  assert.match(routes, /fetchLocationCustomFields\(\s*input\.ghlApiToken/);
  assert.match(routes, /const customFieldsMap = customFieldMap\(customFields\)/);
  assert.match(routes, /input\.ghlCustomFields = customFieldsMap/);
  assert.match(routes, /GHL_PROTECTED_FIELDS_MISSING/);
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
