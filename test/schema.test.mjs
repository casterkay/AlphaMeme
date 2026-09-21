import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RADAR_SCHEMA_VERSION,
  RADAR_TABLES,
  SchemaError,
  initializeRadarSchema
} from '../src/storage/schema.mjs';
import {
  TENANT_REGISTRY_SCHEMA_VERSION,
  TENANT_REGISTRY_TABLES,
  TenantRegistrySchemaError,
  initializeTenantRegistrySchema
} from '../src/storage/tenant-registry-schema.mjs';
import {
  GmgnAdmissionStateError,
  SqliteGmgnAdmissionStateStore,
  defaultGmgnAdmissionState,
  normalizeTenantId,
  readGmgnAdmissionState,
  writeGmgnAdmissionState
} from '../src/storage/gmgn-admission-state.mjs';

function cursor(rows) {
  return {
    toArray: () => structuredClone(rows),
    one: () => {
      if (rows.length !== 1) throw new Error(`expected one row, found ${rows.length}`);
      return structuredClone(rows[0]);
    }
  };
}

function tableSql(definition) {
  const columns = definition.columns.map(column => `  ${column.name} ${column.type}`);
  return `CREATE TABLE ${definition.name} (\n${[...columns, `  PRIMARY KEY (${definition.primaryKey.join(', ')})`, ...definition.constraints.map(constraint => `  ${constraint}`)].join(',\n')}\n)`;
}

class FakeSqlStorage {
  constructor(schemaTables) {
    this.schemaTables = new Map(schemaTables.map(table => [table.name, table]));
    this.tables = new Map();
    this.preferences = new Map();
    this.schedulerState = new Map();
    this.registrySchema = new Map();
    this.explicitIndexes = new Map();
  }

  snapshot() {
    return structuredClone({
      tables: [...this.tables.entries()],
      preferences: [...this.preferences.entries()],
      schedulerState: [...this.schedulerState.entries()],
      registrySchema: [...this.registrySchema.entries()],
      explicitIndexes: [...this.explicitIndexes.entries()]
    });
  }

  restore(snapshot) {
    this.tables = new Map(snapshot.tables);
    this.preferences = new Map(snapshot.preferences);
    this.schedulerState = new Map(snapshot.schedulerState);
    this.registrySchema = new Map(snapshot.registrySchema);
    this.explicitIndexes = new Map(snapshot.explicitIndexes);
  }

  exec(query, ...bindings) {
    const statement = query.trim().replace(/\s+/g, ' ');

    if (statement.startsWith("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")) {
      const table = this.tables.get(bindings[0]);
      return cursor(table === undefined ? [] : [{ sql: table.sql ?? tableSql(table) }]);
    }

    if (statement.startsWith("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")) {
      return cursor([...this.explicitIndexes.keys()].sort().map(name => ({ name })));
    }

    if (statement.startsWith("SELECT name FROM sqlite_master")) {
      const names = [...this.tables.keys()].filter(name => !statement.includes('name NOT IN') || !['_cf_KV', '__cf_kv', '__miniflare_do_name'].includes(name));
      return cursor(names.sort().map(name => ({ name })));
    }

    const create = /^CREATE TABLE ([a-z_]+)/.exec(statement);
    if (create) {
      const table = this.schemaTables.get(create[1]);
      if (!table) throw new Error(`unexpected table ${create[1]}`);
      if (this.tables.has(table.name)) throw new Error(`table already exists: ${table.name}`);
      this.tables.set(table.name, { ...table, sql: tableSql(table) });
      return cursor([]);
    }

    const pragma = /^PRAGMA table_info\(([a-z_]+)\)$/.exec(statement);
    if (pragma) {
      const table = this.tables.get(pragma[1]);
      if (!table) throw new Error(`missing table ${pragma[1]}`);
      return cursor(table.columns.map((column, index) => ({
        cid: index,
        name: column.name,
        type: column.type,
        notnull: 0,
        dflt_value: null,
        pk: table.primaryKey.indexOf(column.name) + 1
      })));
    }

    if (statement.startsWith('SELECT value_json FROM preferences')) {
      const valueJson = this.preferences.get(bindings.join('\u0000'));
      return cursor(valueJson === undefined ? [] : [{ value_json: valueJson }]);
    }

    if (statement.startsWith('INSERT INTO preferences')) {
      this.preferences.set(bindings.slice(0, 2).join('\u0000'), bindings[2]);
      return cursor([]);
    }

    if (statement.startsWith('SELECT value_json FROM scheduler_state')) {
      const valueJson = this.schedulerState.get(bindings.join('\u0000'));
      return cursor(valueJson === undefined ? [] : [{ value_json: valueJson }]);
    }

    if (statement.startsWith('INSERT INTO scheduler_state')) {
      this.schedulerState.set(bindings.slice(0, 2).join('\u0000'), bindings[2]);
      return cursor([]);
    }

    if (statement.startsWith('SELECT singleton, version FROM tenant_registry_schema')) {
      return cursor([...this.registrySchema.entries()].map(([singleton, version]) => ({ singleton, version })));
    }

    if (statement.startsWith('INSERT INTO tenant_registry_schema')) {
      this.registrySchema.set(bindings[0], bindings[1]);
      return cursor([]);
    }

    throw new Error(`unsupported SQL in test storage: ${statement}`);
  }
}

class FakeStorage {
  constructor(schemaTables = RADAR_TABLES) {
    this.sql = new FakeSqlStorage(schemaTables);
  }

  transactionSync(callback) {
    const snapshot = this.sql.snapshot();
    try {
      return callback();
    } catch (error) {
      this.sql.restore(snapshot);
      throw error;
    }
  }
}

test('fresh Radar schema creates every tenant-scoped table and records the explicit version', () => {
  const storage = new FakeStorage();

  assert.equal(initializeRadarSchema(storage), RADAR_SCHEMA_VERSION);
  assert.deepEqual([...storage.sql.tables.keys()].sort(), RADAR_TABLES.map(table => table.name).sort());

  for (const table of RADAR_TABLES) {
    assert.equal(table.primaryKey[0], 'tenant_id', `${table.name} primary key must start with tenant_id`);
  }

  const candidates = storage.sql.tables.get('candidates');
  for (const name of ['symbol', 'info_json', 'review_evidence', 'deep_json', 'secondary_json', 'social_json', 'audit_health_json']) {
    assert.ok(candidates.columns.some(column => column.name === name), `candidates must retain ${name}`);
  }

  const outcomes = storage.sql.tables.get('outcomes');
  for (const name of ['sampling', 'strategy_version', 'samples_json', 'sample_retries_json', 'cohort_metadata_json']) {
    assert.ok(outcomes.columns.some(column => column.name === name), `outcomes must retain ${name}`);
  }

  assert.ok(storage.sql.tables.get('scheduler_state').columns.some(column => column.name === 'value_json'));
});

test('schema initialization refuses a non-empty, versionless database instead of rebuilding it', () => {
  const storage = new FakeStorage();
  storage.sql.tables.set('candidates', RADAR_TABLES.find(table => table.name === 'candidates'));

  assert.throws(() => initializeRadarSchema(storage), error => error instanceof SchemaError && error.code === 'SCHEMA_TABLE_SET_MISMATCH');
  assert.deepEqual([...storage.sql.tables.keys()], ['candidates']);
});

test('schema initialization ignores only documented Worker and local SQLite metadata', () => {
  const storage = new FakeStorage();
  storage.sql.tables.set('_cf_KV', { name: '_cf_KV', columns: [], primaryKey: [] });
  storage.sql.tables.set('__cf_kv', { name: '__cf_kv', columns: [], primaryKey: [] });
  storage.sql.tables.set('__miniflare_do_name', { name: '__miniflare_do_name', columns: [], primaryKey: [] });

  assert.equal(initializeRadarSchema(storage), RADAR_SCHEMA_VERSION);
  assert.ok(storage.sql.tables.has('_cf_KV'));
  assert.ok(storage.sql.tables.has('__cf_kv'));
  assert.ok(storage.sql.tables.has('__miniflare_do_name'));
});

test('schema initialization fails loudly for unknown and corrupt recorded versions', () => {
  const storage = new FakeStorage();
  initializeRadarSchema(storage);
  const key = '__schema__\u0000schema.version';

  storage.sql.preferences.set(key, JSON.stringify({ version: 999 }));
  assert.throws(() => initializeRadarSchema(storage), error => error instanceof SchemaError && error.code === 'SCHEMA_VERSION_UNSUPPORTED');

  storage.sql.preferences.set(key, '{not json');
  assert.throws(() => initializeRadarSchema(storage), error => error instanceof SchemaError && error.code === 'SCHEMA_VERSION_CORRUPT');
});

test('Radar schema rejects altered types, defaults, checks, uniqueness, and indexes', () => {
  const alteredContracts = [
    ['candidates', sql => sql.replace('market_cap REAL', 'market_cap TEXT')],
    ['manual_marks', sql => sql.replace('mark_version INTEGER NOT NULL DEFAULT 0', 'mark_version INTEGER NOT NULL DEFAULT 1')],
    ['manual_marks', sql => sql.replace("decision TEXT CHECK (decision IN ('passed', 'ignored'))", 'decision TEXT')],
    ['manual_marks', sql => sql.replace("'passed', 'ignored'", "'PASSED', 'IGNORED'")],
    ['outbox', sql => sql.replace(',\n  UNIQUE (tenant_id, event_id)', '')]
  ];

  for (const [tableName, alter] of alteredContracts) {
    const storage = new FakeStorage();
    initializeRadarSchema(storage);
    const definition = storage.sql.tables.get(tableName);
    storage.sql.tables.set(tableName, { ...definition, sql: alter(tableSql(definition)) });

    assert.throws(() => initializeRadarSchema(storage), error =>
      error instanceof SchemaError && error.code === 'SCHEMA_TABLE_CONTRACT_MISMATCH');
  }

  const indexed = new FakeStorage();
  initializeRadarSchema(indexed);
  indexed.sql.explicitIndexes.set('candidates_status', 'CREATE INDEX candidates_status ON candidates (status)');
  assert.throws(() => initializeRadarSchema(indexed), error =>
    error instanceof SchemaError && error.code === 'SCHEMA_INDEX_CONTRACT_MISMATCH');
});

test('GMGN admission state persists every cross-restart field and rejects corrupt JSON', () => {
  const storage = new FakeStorage();
  initializeRadarSchema(storage);
  const tenantId = '-1001234567890';
  const state = {
    nextAllowedAt: 1_000,
    backoffFactor: 2,
    lastRequestAt: 900,
    lastWeight: 5,
    successStreak: 3,
    spacingReadyAt: 950,
    keyEpoch: 7
  };

  assert.deepEqual(writeGmgnAdmissionState(storage, tenantId, state), state);
  assert.deepEqual(readGmgnAdmissionState(storage, tenantId), state);

  storage.sql.schedulerState.set(`${tenantId}\u0000gmgn.admission.v1`, '{not json');
  assert.throws(() => readGmgnAdmissionState(storage, tenantId), error => error instanceof GmgnAdmissionStateError && error.code === 'GMGN_ADMISSION_STATE_CORRUPT');
});

test('GMGN admission adapter matches the provider state-store boundary and refuses invalid weights', async () => {
  const storage = new FakeStorage();
  initializeRadarSchema(storage);
  const adapter = new SqliteGmgnAdmissionStateStore(storage, '1001');

  assert.deepEqual(await adapter.read(), defaultGmgnAdmissionState());
  await adapter.write({
    nextAllowedAt: 1_000,
    backoffFactor: 2,
    lastRequestAt: 900,
    lastWeight: 5,
    successStreak: 3,
    spacingReadyAt: 950,
    keyEpoch: 7
  });
  assert.equal((await adapter.read()).lastWeight, 5);
  assert.throws(() => writeGmgnAdmissionState(storage, '1001', { ...defaultGmgnAdmissionState(), lastWeight: 0 }), error =>
    error instanceof GmgnAdmissionStateError && error.code === 'GMGN_ADMISSION_STATE_INVALID');
});

test('tenant IDs use the canonical decimal String(chat_id) representation', () => {
  assert.equal(normalizeTenantId('-1001234567890'), '-1001234567890');
  assert.equal(normalizeTenantId(1001), '1001');
  assert.throws(() => normalizeTenantId('001'), error =>
    error instanceof GmgnAdmissionStateError && error.code === 'GMGN_ADMISSION_TENANT_INVALID');
});

test('tenant registry creates only version metadata and tenant routes', () => {
  const storage = new FakeStorage(TENANT_REGISTRY_TABLES);

  assert.equal(initializeTenantRegistrySchema(storage), TENANT_REGISTRY_SCHEMA_VERSION);
  assert.deepEqual([...storage.sql.tables.keys()].sort(), TENANT_REGISTRY_TABLES.map(table => table.name).sort());
  const routes = storage.sql.tables.get('tenant_registry');
  assert.deepEqual(routes.columns.map(column => column.name), ['tenant_id', 'registered_at']);
  assert.deepEqual(routes.primaryKey, ['tenant_id']);
});

test('tenant registry initialization ignores Worker and local SQLite metadata', () => {
  const storage = new FakeStorage(TENANT_REGISTRY_TABLES);
  storage.sql.tables.set('_cf_KV', { name: '_cf_KV', columns: [], primaryKey: [] });
  storage.sql.tables.set('__cf_kv', { name: '__cf_kv', columns: [], primaryKey: [] });
  storage.sql.tables.set('__miniflare_do_name', { name: '__miniflare_do_name', columns: [], primaryKey: [] });

  assert.equal(initializeTenantRegistrySchema(storage), TENANT_REGISTRY_SCHEMA_VERSION);
  assert.ok(storage.sql.tables.has('_cf_KV'));
  assert.ok(storage.sql.tables.has('__cf_kv'));
  assert.ok(storage.sql.tables.has('__miniflare_do_name'));
});

test('tenant registry refuses versionless, unknown, and corrupt schemas', () => {
  const versionless = new FakeStorage(TENANT_REGISTRY_TABLES);
  versionless.sql.tables.set('tenant_registry', TENANT_REGISTRY_TABLES.find(table => table.name === 'tenant_registry'));
  assert.throws(() => initializeTenantRegistrySchema(versionless), error =>
    error instanceof TenantRegistrySchemaError && error.code === 'TENANT_REGISTRY_SCHEMA_TABLE_SET_MISMATCH');

  const storage = new FakeStorage(TENANT_REGISTRY_TABLES);
  initializeTenantRegistrySchema(storage);
  storage.sql.registrySchema.set(1, 999);
  assert.throws(() => initializeTenantRegistrySchema(storage), error =>
    error instanceof TenantRegistrySchemaError && error.code === 'TENANT_REGISTRY_SCHEMA_VERSION_UNSUPPORTED');

  storage.sql.registrySchema.set(1, 'not-an-integer');
  assert.throws(() => initializeTenantRegistrySchema(storage), error =>
    error instanceof TenantRegistrySchemaError && error.code === 'TENANT_REGISTRY_SCHEMA_VERSION_CORRUPT');
});

test('tenant registry rejects altered type or check contracts and explicit indexes', () => {
  const alteredContracts = [
    ['tenant_registry_schema', sql => sql.replace('version INTEGER NOT NULL', 'version TEXT NOT NULL')],
    ['tenant_registry_schema', sql => sql.replace(',\n  CHECK (singleton = 1)', '')]
  ];

  for (const [tableName, alter] of alteredContracts) {
    const storage = new FakeStorage(TENANT_REGISTRY_TABLES);
    initializeTenantRegistrySchema(storage);
    const definition = storage.sql.tables.get(tableName);
    storage.sql.tables.set(tableName, { ...definition, sql: alter(tableSql(definition)) });

    assert.throws(() => initializeTenantRegistrySchema(storage), error =>
      error instanceof TenantRegistrySchemaError && error.code === 'TENANT_REGISTRY_SCHEMA_TABLE_CONTRACT_MISMATCH');
  }

  const indexed = new FakeStorage(TENANT_REGISTRY_TABLES);
  initializeTenantRegistrySchema(indexed);
  indexed.sql.explicitIndexes.set('tenant_registry_registered_at', 'CREATE INDEX tenant_registry_registered_at ON tenant_registry (registered_at)');
  assert.throws(() => initializeTenantRegistrySchema(indexed), error =>
    error instanceof TenantRegistrySchemaError && error.code === 'TENANT_REGISTRY_SCHEMA_INDEX_CONTRACT_MISMATCH');
});
