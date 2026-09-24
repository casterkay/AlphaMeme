// `node:sqlite` adapter for the Durable Object storage surface the ported code relies on:
//   storage.sql.exec(sql, ...args) -> { toArray() }
//   storage.transactionSync(callback)
//   storage.get / put / delete (key-value, mirrored into a reserved `_cf_KV` table)
//   storage.setAlarm / deleteAlarm (delegated to the owning host)
//
// Cloudflare hides its KV table behind `_cf_KV`; the schema modules already exclude that
// name from their table-set contracts, so reusing it keeps the schema checks byte-exact.
const KV_TABLE = '_cf_KV';

export class SqliteStorage {
  constructor({ database, alarms }) {
    this.database = database;
    this.alarms = alarms;
  }

  sql = {
    exec: (sql, ...args) => {
      const statement = this.database.prepare(sql);
      const rows = statement.columns().length
        ? statement.all(...args)
        : (statement.run(...args), []);
      return { toArray: () => rows };
    }
  };

  transactionSync(callback) {
    this.database.exec('BEGIN');
    try {
      const result = callback();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async get(key) {
    this.#ensureKvTable();
    const row = this.database.prepare(`SELECT value_json FROM ${KV_TABLE} WHERE key = ?`).get(key);
    return row ? JSON.parse(row.value_json) : undefined;
  }

  async put(key, value) {
    this.#ensureKvTable();
    this.database
      .prepare(`INSERT INTO ${KV_TABLE} (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`)
      .run(key, JSON.stringify(value));
  }

  async delete(key) {
    this.#ensureKvTable();
    this.database.prepare(`DELETE FROM ${KV_TABLE} WHERE key = ?`).run(key);
  }

  async setAlarm(at) {
    return this.alarms.setAlarm(at);
  }

  async deleteAlarm() {
    return this.alarms.deleteAlarm();
  }

  #ensureKvTable() {
    this.database.exec(`CREATE TABLE IF NOT EXISTS ${KV_TABLE} (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)`);
  }
}
