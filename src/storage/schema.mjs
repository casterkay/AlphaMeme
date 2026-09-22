export const RADAR_SCHEMA_VERSION = 1;

const SCHEMA_TENANT_ID = '__schema__';
const SCHEMA_VERSION_KEY = 'schema.version';

// Cloudflare reserves these Durable Object tables for its KV, alarm, and test-runtime metadata.
const PLATFORM_STORAGE_TABLES = Object.freeze(['_cf_KV', '_cf_METADATA', '__cf_kv', '__miniflare_do_name']);

export class SchemaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SchemaError';
    this.code = code;
  }
}

function table(name, columns, primaryKey, constraints = []) {
  return Object.freeze({
    name,
    columns: Object.freeze(columns.map(([columnName, type]) => Object.freeze({ name: columnName, type }))),
    primaryKey: Object.freeze([...primaryKey]),
    constraints: Object.freeze([...constraints])
  });
}

export const RADAR_TABLES = Object.freeze([
  table('tenants', [
    ['tenant_id', 'TEXT NOT NULL'], ['owner_user_id', 'TEXT NOT NULL'], ['gmgn_api_key_enc', 'TEXT'],
    ['onboard_state', 'TEXT'], ['created_at', 'INTEGER NOT NULL']
  ], ['tenant_id']),
  table('candidates', [
    ['tenant_id', 'TEXT NOT NULL'], ['chain', 'TEXT NOT NULL'], ['address', 'TEXT NOT NULL'],
    ['symbol', 'TEXT'], ['name', 'TEXT'], ['info_json', 'TEXT'], ['review_evidence', 'TEXT'],
    ['status', 'TEXT NOT NULL'], ['priority_band', 'INTEGER'], ['discovery_score', 'REAL'],
    ['market_cap', 'REAL'], ['liquidity', 'REAL'], ['price', 'REAL'], ['created_at', 'INTEGER'],
    ['age_sec', 'INTEGER'], ['holders', 'INTEGER'], ['volume_1h', 'REAL'], ['buys', 'INTEGER'],
    ['sells', 'INTEGER'], ['twitter', 'TEXT'], ['gmgn_url', 'TEXT'], ['audited_at', 'INTEGER'],
    ['stale_at', 'INTEGER'], ['review_revision', 'TEXT'], ['decision_reason', 'TEXT'],
    ['audit_error', 'TEXT'], ['deep_json', 'TEXT'], ['secondary_json', 'TEXT'], ['social_json', 'TEXT'],
    ['audit_health_json', 'TEXT'], ['metadata_json', 'TEXT']
  ], ['tenant_id', 'chain', 'address']),
  table('audit_queue', [
    ['tenant_id', 'TEXT NOT NULL'], ['chain', 'TEXT NOT NULL'], ['address', 'TEXT NOT NULL'],
    ['first_seen_at', 'INTEGER'], ['last_seen_at', 'INTEGER'], ['last_audited_at', 'INTEGER'],
    ['next_audit_at', 'INTEGER'], ['attempts', 'INTEGER'], ['status', 'TEXT'], ['priority_band', 'INTEGER'],
    ['score', 'REAL'], ['watched', 'INTEGER'], ['details_json', 'TEXT']
  ], ['tenant_id', 'chain', 'address']),
  table('outcomes', [
    ['tenant_id', 'TEXT NOT NULL'], ['chain', 'TEXT NOT NULL'], ['address', 'TEXT NOT NULL'],
    ['initial_decision', 'TEXT NOT NULL'], ['latest_decision', 'TEXT'], ['baseline_at', 'INTEGER'],
    ['baseline_price', 'REAL'], ['last_audited_at', 'INTEGER'], ['symbol', 'TEXT'],
    ['latest_failed_json', 'TEXT'], ['sampling', 'TEXT'], ['strategy_version', 'TEXT'],
    ['samples_json', 'TEXT'], ['sample_retries_json', 'TEXT'], ['cohort_metadata_json', 'TEXT']
  ], ['tenant_id', 'chain', 'address']),
  table('risk_exclusions', [
    ['tenant_id', 'TEXT NOT NULL'], ['chain', 'TEXT NOT NULL'], ['address', 'TEXT NOT NULL'],
    ['version', 'INTEGER'], ['codes_json', 'TEXT'], ['reasons_json', 'TEXT'], ['at', 'INTEGER'],
    ['details_json', 'TEXT']
  ], ['tenant_id', 'chain', 'address']),
  table('events', [
    ['tenant_id', 'TEXT NOT NULL'], ['id', 'TEXT NOT NULL'], ['at', 'INTEGER NOT NULL'], ['type', 'TEXT NOT NULL'],
    ['chain', 'TEXT'], ['address', 'TEXT'], ['message', 'TEXT'], ['data_json', 'TEXT']
  ], ['tenant_id', 'id']),
  table('annotations', [
    ['tenant_id', 'TEXT NOT NULL'], ['chain', 'TEXT NOT NULL'], ['address', 'TEXT NOT NULL'],
    ['favorite', 'INTEGER NOT NULL'], ['note', 'TEXT NOT NULL'], ['updated_at', 'INTEGER']
  ], ['tenant_id', 'chain', 'address']),
  table('manual_marks', [
    ['tenant_id', 'TEXT NOT NULL'], ['chain', 'TEXT NOT NULL'], ['address', 'TEXT NOT NULL'],
    ['decision', "TEXT CHECK (decision IN ('passed', 'ignored'))"], ['marked_at', 'INTEGER'],
    ['review_revision', 'TEXT'], ['mark_version', 'INTEGER NOT NULL DEFAULT 0']
  ], ['tenant_id', 'chain', 'address']),
  table('inbox', [
    ['tenant_id', 'TEXT NOT NULL'], ['update_id', 'TEXT NOT NULL'], ['actor_user_id', 'TEXT NOT NULL'],
    ['command_type', 'TEXT NOT NULL'], ['payload_json', 'TEXT'], ['payload_enc', 'TEXT'], ['status', 'TEXT NOT NULL'],
    ['generation', 'INTEGER'], ['received_at', 'INTEGER NOT NULL'], ['attempts', 'INTEGER NOT NULL DEFAULT 0'],
    ['next_at', 'INTEGER'], ['expires_at', 'INTEGER'], ['message_date', 'INTEGER'],
    ['source_message_id', 'TEXT'], ['result_json', 'TEXT']
  ], ['tenant_id', 'update_id']),
  table('preferences', [
    ['tenant_id', 'TEXT NOT NULL'], ['key', 'TEXT NOT NULL'], ['value_json', 'TEXT NOT NULL']
  ], ['tenant_id', 'key']),
  table('scheduler_state', [
    ['tenant_id', 'TEXT NOT NULL'], ['key', 'TEXT NOT NULL'], ['value_json', 'TEXT NOT NULL']
  ], ['tenant_id', 'key']),
  table('cycle_checkpoint', [
    ['tenant_id', 'TEXT NOT NULL'], ['cycle_id', 'TEXT NOT NULL'], ['chain', 'TEXT NOT NULL'],
    ['key_epoch', 'INTEGER NOT NULL'], ['control_epoch', 'INTEGER NOT NULL'], ['deadline_at', 'INTEGER'],
    ['phase', 'TEXT NOT NULL'], ['token_index', 'INTEGER'], ['endpoint_index', 'INTEGER'],
    ['partial_json', 'TEXT'], ['updated_at', 'INTEGER']
  ], ['tenant_id', 'cycle_id']),
  table('keys', [
    ['tenant_id', 'TEXT NOT NULL'], ['name', 'TEXT NOT NULL'], ['value_enc', 'TEXT NOT NULL'],
    ['generation', 'INTEGER NOT NULL'], ['created_at', 'INTEGER']
  ], ['tenant_id', 'name']),
  table('outbox', [
    ['tenant_id', 'TEXT NOT NULL'], ['id', 'TEXT NOT NULL'], ['event_id', 'TEXT'], ['chat_id', 'TEXT NOT NULL'],
    ['payload_json', 'TEXT NOT NULL'], ['desired_revision', 'TEXT'], ['delivery_class', 'TEXT NOT NULL'],
    ['action_reason', 'TEXT'], ['ui_session_id', 'TEXT'], ['status', 'TEXT NOT NULL'],
    ['attempts', 'INTEGER NOT NULL DEFAULT 0'], ['next_at', 'INTEGER'],
    ['ambiguous_retries', 'INTEGER NOT NULL DEFAULT 0']
  ], ['tenant_id', 'id'], ['UNIQUE (tenant_id, event_id)']),
  table('message_map', [
    ['tenant_id', 'TEXT NOT NULL'], ['chain', 'TEXT NOT NULL'], ['address', 'TEXT NOT NULL'],
    ['message_id', 'TEXT NOT NULL'], ['chat_id', 'TEXT NOT NULL'], ['rendered_revision', 'TEXT'],
    ['ui_session_id', 'TEXT']
  ], ['tenant_id', 'chat_id', 'message_id']),
  table('ui_sessions', [
    ['tenant_id', 'TEXT NOT NULL'], ['id', 'TEXT NOT NULL'], ['owner_user_id', 'TEXT NOT NULL'],
    ['chat_id', 'TEXT NOT NULL'], ['message_id', 'TEXT'], ['panel', 'TEXT NOT NULL'], ['view_chain', 'TEXT'],
    ['query_json', 'TEXT NOT NULL'], ['snapshot_at', 'INTEGER'], ['version', 'INTEGER NOT NULL DEFAULT 0'],
    ['expires_at', 'INTEGER NOT NULL']
  ], ['tenant_id', 'id']),
  table('shortlinks', [
    ['tenant_id', 'TEXT NOT NULL'], ['id', 'TEXT NOT NULL'], ['chain', 'TEXT'], ['address', 'TEXT'],
    ['action', 'TEXT NOT NULL'], ['expected_control_epoch', 'INTEGER'], ['ui_session_id', 'TEXT'],
    ['expected_ui_version', 'INTEGER'], ['params_json', 'TEXT'], ['origin_message_id', 'TEXT'],
    ['review_revision', 'TEXT'], ['expected_mark_version', 'INTEGER'],
    ['expected_connection_generation', 'INTEGER'], ['expires_at', 'INTEGER NOT NULL'], ['created_at', 'INTEGER']
  ], ['tenant_id', 'id'])
]);

// These JSON containers keep the unnormalized state/export fields intact until their
// later-owner modules replace them with dedicated behavior.
export const JSON_CONTAINERS = Object.freeze({
  candidates: Object.freeze(['info_json', 'deep_json', 'secondary_json', 'social_json', 'audit_health_json', 'metadata_json']),
  auditQueue: Object.freeze(['details_json']),
  outcomes: Object.freeze(['latest_failed_json', 'samples_json', 'sample_retries_json', 'cohort_metadata_json']),
  riskExclusions: Object.freeze(['codes_json', 'reasons_json', 'details_json']),
  events: Object.freeze(['data_json']),
  schedulerState: Object.freeze([
    'gmgn.admission.v1', 'runtime.global', 'runtime.chains', 'runtime.sourceHealth',
    'runtime.policy', 'runtime.requestMetrics', 'runtime.rejected', 'notification.baseline',
    'scheduler.instance.v1', 'scheduler.runtime.v1', 'scheduler.tasks.v1'
  ])
});

function createTableSql(definition) {
  const columns = definition.columns.map(column => `  ${column.name} ${column.type}`);
  return `CREATE TABLE ${definition.name} (\n${[...columns, `  PRIMARY KEY (${definition.primaryKey.join(', ')})`, ...definition.constraints.map(constraint => `  ${constraint}`)].join(',\n')}\n)`;
}

function listUserTables(sql) {
  const excludedTables = PLATFORM_STORAGE_TABLES.map(name => `'${name}'`).join(', ');
  return sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN (${excludedTables}) ORDER BY name`).toArray()
    .map(row => row.name);
}

function readSchemaVersion(sql) {
  const row = sql.exec('SELECT value_json FROM preferences WHERE tenant_id = ? AND key = ?', SCHEMA_TENANT_ID, SCHEMA_VERSION_KEY).toArray()[0];
  if (!row) throw new SchemaError('SCHEMA_VERSION_MISSING', 'schema version is missing from a non-empty Radar database');
  try {
    const value = JSON.parse(row.value_json);
    if (!Number.isSafeInteger(value?.version)) throw new Error('version is not an integer');
    return value.version;
  } catch (error) {
    throw new SchemaError('SCHEMA_VERSION_CORRUPT', `schema version is corrupt: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertTableSet(actual) {
  const expected = RADAR_TABLES.map(definition => definition.name).sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new SchemaError('SCHEMA_TABLE_SET_MISMATCH', 'database table set does not match the supported Radar schema');
  }
}

function normalizeDdl(value) {
  // SQLite CHECK literals are case-sensitive, so this contract is otherwise byte-exact.
  return typeof value === 'string' ? value.trim() : '';
}

function assertTableContract(sql, definition) {
  const rows = sql.exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", definition.name).toArray();
  if (rows.length !== 1 || normalizeDdl(rows[0].sql) !== normalizeDdl(createTableSql(definition))) {
    throw new SchemaError('SCHEMA_TABLE_CONTRACT_MISMATCH', `table ${definition.name} does not match the supported Radar schema contract`);
  }
}

function assertNoExplicitIndexes(sql) {
  const indexes = sql.exec("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name").toArray();
  if (indexes.length !== 0) {
    throw new SchemaError('SCHEMA_INDEX_CONTRACT_MISMATCH', 'database contains unsupported explicit indexes');
  }
}

function createFreshSchema(storage) {
  storage.transactionSync(() => {
    if (listUserTables(storage.sql).length !== 0) {
      throw new SchemaError('SCHEMA_CONCURRENT_INITIALIZATION', 'Radar schema appeared while initialization was in progress');
    }
    for (const definition of RADAR_TABLES) storage.sql.exec(createTableSql(definition));
    storage.sql.exec('INSERT INTO preferences (tenant_id, key, value_json) VALUES (?, ?, ?)', SCHEMA_TENANT_ID, SCHEMA_VERSION_KEY, JSON.stringify({ version: RADAR_SCHEMA_VERSION }));
  });
}

export function initializeRadarSchema(storage) {
  const existingTables = listUserTables(storage.sql);
  if (existingTables.length === 0) createFreshSchema(storage);
  else assertTableSet(existingTables);

  const version = readSchemaVersion(storage.sql);
  if (version !== RADAR_SCHEMA_VERSION) {
    throw new SchemaError('SCHEMA_VERSION_UNSUPPORTED', `unsupported Radar schema version ${version}`);
  }
  for (const definition of RADAR_TABLES) assertTableContract(storage.sql, definition);
  assertNoExplicitIndexes(storage.sql);
  return version;
}
