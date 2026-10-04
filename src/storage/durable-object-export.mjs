// The one-off export that moves a Durable Object's state to the VPS host
// (docs/VPS-MIGRATION-PLAN.md, "Data migration"). It reads only: every table the
// object's schema defines, with the table's DDL so the import recreates it
// exactly, its key-value entries and its pending alarm time. Ciphertext columns
// are exported as stored.

const isSqlValue = value => value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
const isEntryValue = value => typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));

export async function exportDurableObjectState(storage, tableDefinitions) {
  const tables = {};
  for (const { name } of tableDefinitions) {
    const [definition] = storage.sql.exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray();
    if (!definition) throw new Error(`table ${name} is missing from the object's database`);
    const rows = storage.sql.exec(`SELECT * FROM "${name}"`).toArray();

    // JSON carries text, finite numbers and null faithfully; a BLOB or non-finite REAL would not round-trip.
    for (const row of rows) {
      for (const [column, value] of Object.entries(row)) {
        if (!isSqlValue(value)) throw new Error(`table ${name} column ${column} holds a value JSON cannot carry`);
      }
    }
    tables[name] = { sql: definition.sql, rows };
  }
  const entries = {};
  for (const [key, value] of await storage.list()) {
    if (!isEntryValue(value)) throw new Error(`key-value entry ${key} holds a value JSON cannot carry`);
    entries[key] = value;
  }
  return { tables, entries, alarmAt: await storage.getAlarm() };
}
