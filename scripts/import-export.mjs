#!/usr/bin/env node
// Writes the Worker's migration export (GET /export) into the VPS host's three
// databases and verifies them: node scripts/import-export.mjs <export.json> <directory>
//
// radar.sqlite and registry.sqlite get each object's tables, recreated from the
// exported DDL with their rows; row counts are checked per table, then the
// object's own schema initializer runs on the file, as the host does at boot.
// host.sqlite gets each object's key-value entries and the radar's alarm time,
// in the host's own layout (src/host/state.mjs).
//
// The three files are built in a scratch directory and moved into place only
// once all are verified, and an existing file is never overwritten.
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hostEntries, initializeHostSchema } from '../src/host/state.mjs';
import { DATABASE_FILES, openDatabase, sqliteStorage } from '../src/host/storage.mjs';
import { initializeRadarSchema } from '../src/storage/schema.mjs';
import { initializeTenantRegistrySchema } from '../src/storage/tenant-registry-schema.mjs';

const OBJECT_SCHEMAS = Object.freeze({ radar: initializeRadarSchema, registry: initializeTenantRegistrySchema });

function writeObjectDatabase(path, name, state) {
  if (!state?.tables || typeof state.tables !== 'object') throw new Error(`export has no ${name} tables`);
  const db = openDatabase(path);
  try {
    const storage = sqliteStorage(db);
    const counts = {};
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
    OBJECT_SCHEMAS[name](storage);
    return counts;
  } finally {
    db.close();
  }
}

// The host keeps one alarm, the radar's; the registry never sets one.
function writeHostDatabase(path, exported) {
  if (exported.registry.alarmAt !== null) throw new Error('export holds a registry alarm, which the host has no place for');
  const db = openDatabase(path);
  try {
    const storage = sqliteStorage(db);
    initializeHostSchema(storage);
    storage.transactionSync(() => {
      for (const name of Object.keys(OBJECT_SCHEMAS)) {
        const entries = hostEntries(storage, name);
        for (const [key, value] of Object.entries(exported[name].entries)) entries.put(key, value);
      }
      if (exported.radar.alarmAt !== null) hostEntries(storage, 'host').put('radar.alarm', exported.radar.alarmAt);
    });
    return Object.fromEntries(db.prepare('SELECT scope, COUNT(*) AS count FROM kv GROUP BY scope').all().map(row => [row.scope, row.count]));
  } finally {
    db.close();
  }
}

export function importExport(exported, directory) {
  const files = Object.values(DATABASE_FILES);
  const existing = files.filter(file => existsSync(join(directory, file)));
  if (existing.length) throw new Error(`refusing to overwrite ${existing.join(', ')} in ${directory}`);

  const scratch = mkdtempSync(join(directory, '.import-'));
  try {
    const counts = Object.fromEntries(Object.keys(OBJECT_SCHEMAS).map(name => [name, writeObjectDatabase(join(scratch, DATABASE_FILES[name]), name, exported[name])]));
    const hostEntryCounts = writeHostDatabase(join(scratch, DATABASE_FILES.host), exported);
    for (const file of files) renameSync(join(scratch, file), join(directory, file));
    return { tenantId: exported.tenantId, exportedAt: exported.exportedAt, idle: exported.idle, counts, hostEntries: hostEntryCounts };
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
