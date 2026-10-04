import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initializeRadarSchema } from '../storage/schema.mjs';
import { initializeTenantRegistrySchema } from '../storage/tenant-registry-schema.mjs';
import { initializeHostSchema } from './state.mjs';
import { DATABASE_FILES, sqliteStorage } from './storage.mjs';

export const BACKUP_SETS_KEPT = 14;
const SCHEMA_CHECKS = Object.freeze({ radar: initializeRadarSchema, registry: initializeTenantRegistrySchema, host: initializeHostSchema });
const SET_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

/**
 * Writes a consistent snapshot of each database into `dataDir/backups/<UTC time>`
 * with VACUUM INTO (safe while the host runs), checks every copy, and keeps the
 * newest sets. A set is renamed into place only once verified, so every set
 * without the `.partial` suffix passed its checks.
 */
export function backupDatabases({ dataDir, now = new Date() }) {
  const backups = join(dataDir, 'backups');
  const name = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll(':', '-');
  const partial = join(backups, `${name}.partial`);
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true });

  const databases = {};
  for (const [owner, file] of Object.entries(DATABASE_FILES)) {
    if (!existsSync(join(dataDir, file))) throw new Error(`database ${file} is missing from ${dataDir}`);
    const source = new DatabaseSync(join(dataDir, file), { timeout: 5_000 });
    try {
      source.prepare('VACUUM INTO ?').run(join(partial, file));
    } finally {
      source.close();
    }
    databases[file] = verifyCopy(join(partial, file), SCHEMA_CHECKS[owner]);
  }
  writeFileSync(join(partial, 'manifest.json'), `${JSON.stringify({ createdAt: now.toISOString(), databases }, null, 2)}\n`);
  renameSync(partial, join(backups, name));

  const entries = readdirSync(backups);
  for (const stale of entries.filter(entry => entry.endsWith('.partial'))) rmSync(join(backups, stale), { recursive: true, force: true });
  const sets = entries.filter(entry => SET_NAME.test(entry)).sort();
  for (const old of sets.slice(0, -BACKUP_SETS_KEPT)) rmSync(join(backups, old), { recursive: true, force: true });
  return { set: name, databases };
}

/** Integrity, the owner's schema check and row counts, on a read-only copy. */
function verifyCopy(path, checkSchema) {
  const copy = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = copy.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error(`backup copy ${path} failed its integrity check`);
    const storage = sqliteStorage(copy);
    checkSchema(storage);
    const tables = storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").toArray();
    return Object.fromEntries(tables.map(({ name }) => [name, storage.sql.exec(`SELECT COUNT(*) AS count FROM "${name}"`).one().count]));
  } finally {
    copy.close();
  }
}
