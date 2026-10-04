#!/usr/bin/env node
// Writes the Worker's migration export (GET /export) into the VPS host's three
// databases and verifies them: node scripts/import-export.mjs <export.json> <directory>
//
// radar.sqlite and registry.sqlite get each object's tables, recreated from the
// exported DDL with their rows; row counts are checked per table, then the
// object's own schema initializer runs on the file, as the host would at boot.
// host.sqlite holds what Cloudflare kept outside those tables:
//
//   CREATE TABLE entries (object TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY (object, key))
//     one row per ctx.storage.get/put entry; object is 'radar' or 'registry'
//   CREATE TABLE alarms (object TEXT NOT NULL PRIMARY KEY, at INTEGER NOT NULL)
//     the object's pending alarm time, absent when none is set
//
// The three files are built in a scratch directory and moved into place only
// once all are verified, and an existing file is never overwritten.
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { initializeRadarSchema } from '../src/storage/schema.mjs';
import { initializeTenantRegistrySchema } from '../src/storage/tenant-registry-schema.mjs';

export const HOST_SCHEMA = [
  'CREATE TABLE entries (object TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY (object, key))',
  'CREATE TABLE alarms (object TEXT NOT NULL PRIMARY KEY, at INTEGER NOT NULL)'
];

const OBJECTS = [
  { name: 'radar', file: 'radar.sqlite', initializeSchema: initializeRadarSchema },
  { name: 'registry', file: 'registry.sqlite', initializeSchema: initializeTenantRegistrySchema }
];

// The slice of the Durable Object storage API the schema initializers use.
function sqliteStorage(db) {
  return {
    sql: { exec: (sql, ...args) => {
      const statement = db.prepare(sql);
      const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []);
      return { toArray: () => rows };
    } },
    transactionSync: fn => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const value = fn();
        db.exec('COMMIT');
        return value;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  };
}

function writeObjectDatabase(path, { name, initializeSchema }, state) {
  if (!state?.tables || typeof state.tables !== 'object') throw new Error(`export has no ${name} tables`);
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    const counts = {};
    const storage = sqliteStorage(db);
    storage.transactionSync(() => {
      for (const [table, { sql, rows }] of Object.entries(state.tables)) {
        db.exec(sql);
        if (rows.length) {
          const columns = Object.keys(rows[0]);
          const insert = db.prepare(`INSERT INTO "${table}" (${columns.map(column => `"${column}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
          for (const row of rows) insert.run(...columns.map(column => row[column]));
        }
        const { count } = db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get();
        if (count !== rows.length) throw new Error(`${name} table ${table} holds ${count} rows, the export ${rows.length}`);
        counts[table] = count;
      }
    });
    initializeSchema(storage);
    return counts;
  } finally {
    db.close();
  }
}

function writeHostDatabase(path, exported) {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('BEGIN IMMEDIATE');
    for (const sql of HOST_SCHEMA) db.exec(sql);
    const entry = db.prepare('INSERT INTO entries (object, key, value_json) VALUES (?, ?, ?)');
    const alarm = db.prepare('INSERT INTO alarms (object, at) VALUES (?, ?)');
    for (const { name } of OBJECTS) {
      const { entries, alarmAt } = exported[name];
      for (const [key, value] of Object.entries(entries)) entry.run(name, key, JSON.stringify(value));
      if (alarmAt !== null) alarm.run(name, alarmAt);
    }
    db.exec('COMMIT');
    return {
      entries: db.prepare('SELECT COUNT(*) AS count FROM entries').get().count,
      alarms: Object.fromEntries(db.prepare('SELECT object, at FROM alarms').all().map(row => [row.object, row.at]))
    };
  } finally {
    db.close();
  }
}

export function importExport(exported, directory) {
  const files = [...OBJECTS.map(object => object.file), 'host.sqlite'];
  const existing = files.filter(file => existsSync(join(directory, file)));
  if (existing.length) throw new Error(`refusing to overwrite ${existing.join(', ')} in ${directory}`);

  const scratch = mkdtempSync(join(directory, '.import-'));
  try {
    const counts = Object.fromEntries(OBJECTS.map(object => [object.name, writeObjectDatabase(join(scratch, object.file), object, exported[object.name])]));
    const host = writeHostDatabase(join(scratch, 'host.sqlite'), exported);
    for (const file of files) renameSync(join(scratch, file), join(directory, file));
    return { tenantId: exported.tenantId, exportedAt: exported.exportedAt, idle: exported.idle, counts, host };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [exportPath, directory] = process.argv.slice(2);
  if (!exportPath || !directory) {
    console.error('usage: node scripts/import-export.mjs <export.json> <directory>');
    process.exit(2);
  }
  console.log(JSON.stringify(importExport(JSON.parse(readFileSync(exportPath, 'utf8')), directory), null, 2));
}
