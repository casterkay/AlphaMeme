import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { importExport } from '../scripts/import-export.mjs';
import { exportDurableObjectState } from '../src/storage/durable-object-export.mjs';
import { initializeRadarSchema, RADAR_TABLES } from '../src/storage/schema.mjs';
import { initializeTenantRegistrySchema, TENANT_REGISTRY_TABLES } from '../src/storage/tenant-registry-schema.mjs';

const ALARM_AT = 1_800_000_000_000;

// A Durable Object storage stand-in over node:sqlite, with its key-value entries and alarm.
function objectStorage(entries, alarmAt) {
  const db = new DatabaseSync(':memory:');
  return {
    db,
    sql: { exec: (sql, ...args) => {
      const statement = db.prepare(sql);
      const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []);
      return { toArray: () => rows };
    } },
    transactionSync: fn => {
      db.exec('BEGIN');
      try {
        const value = fn();
        db.exec('COMMIT');
        return value;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    list: async () => new Map(Object.entries(entries)),
    getAlarm: async () => alarmAt
  };
}

// One row in every table the schema defines, typed by its columns, so a table added later is covered too.
function fillEveryTable(storage, definitions) {
  const sample = { TEXT: 'passed', INTEGER: 1, REAL: 1.5 };
  for (const definition of definitions) {
    const values = definition.columns.map(column => sample[column.type.split(' ')[0]]);
    storage.sql.exec(`INSERT OR IGNORE INTO ${definition.name} (${definition.columns.map(column => column.name).join(', ')}) VALUES (${values.map(() => '?').join(', ')})`, ...values);
  }
}

async function exportedState() {
  const radar = objectStorage({ 'radar.entry': 'kept', count: 3 }, ALARM_AT);
  initializeRadarSchema(radar);
  fillEveryTable(radar, RADAR_TABLES);
  const registry = objectStorage({ 'scheduler.watchdog.cursor.v1': '1000' }, null);
  initializeTenantRegistrySchema(registry);
  fillEveryTable(registry, TENANT_REGISTRY_TABLES);
  const exported = {
    exportedAt: ALARM_AT,
    tenantId: '1000',
    idle: { idle: true, unconfirmedOutbox: [], unsettledTrades: [] },
    radar: await exportDurableObjectState(radar, RADAR_TABLES),
    registry: await exportDurableObjectState(registry, TENANT_REGISTRY_TABLES)
  };
  return JSON.parse(JSON.stringify(exported));
}

function withDirectory(run) {
  const directory = mkdtempSync(join(tmpdir(), 'import-export-'));
  return Promise.resolve(run(directory)).finally(() => rmSync(directory, { recursive: true, force: true }));
}

const rowsOf = (db, table) => db.prepare(`SELECT * FROM "${table}"`).all().map(row => ({ ...row }));

test('an export of every table round-trips into fresh databases that pass their schema checks', () => withDirectory(async directory => {
  const exported = await exportedState();
  for (const [state, definitions] of [[exported.radar, RADAR_TABLES], [exported.registry, TENANT_REGISTRY_TABLES]]) {
    assert.deepEqual(Object.keys(state.tables).sort(), definitions.map(definition => definition.name).sort());
    for (const { rows } of Object.values(state.tables)) assert.ok(rows.length > 0);
  }

  const summary = importExport(exported, directory);

  assert.deepEqual(readdirSync(directory).sort(), ['host.sqlite', 'radar.sqlite', 'registry.sqlite']);
  for (const [name, initialize] of [['radar', initializeRadarSchema], ['registry', initializeTenantRegistrySchema]]) {
    const db = new DatabaseSync(join(directory, `${name}.sqlite`));
    try {
      for (const [table, { rows }] of Object.entries(exported[name].tables)) {
        assert.deepEqual(rowsOf(db, table), rows, `${name}.${table}`);
        assert.equal(summary.counts[name][table], rows.length);
      }
      assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
      initialize({ sql: { exec: (sql, ...args) => ({ toArray: () => db.prepare(sql).all(...args) }) }, transactionSync: fn => fn() });
    } finally {
      db.close();
    }
  }
  const host = new DatabaseSync(join(directory, 'host.sqlite'));
  try {
    assert.deepEqual(rowsOf(host, 'entries').sort((left, right) => left.key.localeCompare(right.key)), [
      { object: 'radar', key: 'count', value_json: '3' },
      { object: 'radar', key: 'radar.entry', value_json: '"kept"' },
      { object: 'registry', key: 'scheduler.watchdog.cursor.v1', value_json: '"1000"' }
    ]);
    assert.deepEqual(rowsOf(host, 'alarms'), [{ object: 'radar', at: ALARM_AT }]);
  } finally {
    host.close();
  }
}));

test('an export missing a schema table fails the schema check and leaves no database behind', () => withDirectory(async directory => {
  const exported = await exportedState();
  delete exported.radar.tables.outbox;
  assert.throws(() => importExport(exported, directory), { code: 'SCHEMA_TABLE_SET_MISMATCH' });
  assert.deepEqual(readdirSync(directory), []);
}));

test('the import never overwrites an existing database', () => withDirectory(async directory => {
  const exported = await exportedState();
  importExport(exported, directory);
  assert.throws(() => importExport(exported, directory), /refusing to overwrite radar.sqlite, registry.sqlite, host.sqlite/);
  assert.ok(existsSync(join(directory, 'radar.sqlite')));
}));

test('the export refuses a value JSON cannot carry rather than altering it', async () => {
  const storage = objectStorage({}, null);
  initializeTenantRegistrySchema(storage);
  storage.sql.exec('INSERT INTO tenant_registry (tenant_id, registered_at) VALUES (?, ?)', new Uint8Array([1]), 1);
  await assert.rejects(exportDurableObjectState(storage, TENANT_REGISTRY_TABLES), /tenant_registry column tenant_id holds a value JSON cannot carry/);
  await assert.rejects(exportDurableObjectState(objectStorage({ cursor: { at: 1 } }, null), []), /entry cursor holds a value JSON cannot carry/);
});
