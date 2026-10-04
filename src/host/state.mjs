// host.sqlite keeps what Cloudflare kept outside our tables: each object's
// key-value entries (scope `radar` or `registry`) and the host's own state
// (scope `host`: the radar's alarm time and the Telegram polling offset).
const KV_TABLE_SQL = `CREATE TABLE kv (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  PRIMARY KEY (scope, key)
)`;

export class HostSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HostSchemaError';
    this.code = 'HOST_SCHEMA_MISMATCH';
  }
}

/** Creates the host schema in an empty database, or checks an existing one is exactly it. */
export function initializeHostSchema(storage) {
  const tables = storage.sql.exec("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").toArray();
  if (tables.length === 0) {
    storage.sql.exec(KV_TABLE_SQL);
    return;
  }
  if (tables.length !== 1 || tables[0].name !== 'kv' || tables[0].sql.trim() !== KV_TABLE_SQL) {
    throw new HostSchemaError('host database does not match the supported host schema');
  }
}

/** Synchronous key-value entries of one scope; values round-trip through JSON. */
export function hostEntries(storage, scope) {
  return {
    get(key) {
      const row = storage.sql.exec('SELECT value_json FROM kv WHERE scope = ? AND key = ?', scope, key).toArray()[0];
      return row ? JSON.parse(row.value_json) : undefined;
    },
    put(key, value) {
      storage.sql.exec(
        'INSERT INTO kv (scope, key, value_json) VALUES (?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value_json = excluded.value_json',
        scope, key, JSON.stringify(value)
      );
    },
    delete(key) {
      storage.sql.exec('DELETE FROM kv WHERE scope = ? AND key = ?', scope, key);
    }
  };
}
