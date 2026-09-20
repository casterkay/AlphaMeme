export const TENANT_REGISTRY_SCHEMA_VERSION = 1;

const REGISTRY_SCHEMA_TABLE = 'tenant_registry_schema';
const REGISTRY_TABLE = 'tenant_registry';
const SCHEMA_SINGLETON = 1;
const PLATFORM_STORAGE_TABLES = Object.freeze(['__cf_kv', '__miniflare_do_name']);

export class TenantRegistrySchemaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TenantRegistrySchemaError';
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

export const TENANT_REGISTRY_TABLES = Object.freeze([
  table(REGISTRY_SCHEMA_TABLE, [
    ['singleton', 'INTEGER'], ['version', 'INTEGER NOT NULL']
  ], ['singleton'], ['CHECK (singleton = 1)']),
  table(REGISTRY_TABLE, [
    ['tenant_id', 'TEXT NOT NULL'], ['registered_at', 'INTEGER NOT NULL']
  ], ['tenant_id'])
]);

function createTableSql(definition) {
  const columns = definition.columns.map(column => `  ${column.name} ${column.type}`);
  return `CREATE TABLE ${definition.name} (\n${[...columns, `  PRIMARY KEY (${definition.primaryKey.join(', ')})`, ...definition.constraints.map(constraint => `  ${constraint}`)].join(',\n')}\n)`;
}

function listUserTables(sql) {
  const excludedTables = PLATFORM_STORAGE_TABLES.map(name => `'${name}'`).join(', ');
  return sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN (${excludedTables}) ORDER BY name`).toArray()
    .map(row => row.name);
}

function assertTableSet(actual) {
  const expected = TENANT_REGISTRY_TABLES.map(definition => definition.name).sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new TenantRegistrySchemaError('TENANT_REGISTRY_SCHEMA_TABLE_SET_MISMATCH', 'tenant registry table set does not match the supported schema');
  }
}

function assertTableShape(sql, definition) {
  const columns = sql.exec(`PRAGMA table_info(${definition.name})`).toArray();
  const actualNames = columns.map(column => column.name);
  const expectedNames = definition.columns.map(column => column.name);
  const actualPrimaryKey = columns.filter(column => column.pk > 0).sort((left, right) => left.pk - right.pk).map(column => column.name);
  if (actualNames.length !== expectedNames.length || actualNames.some((name, index) => name !== expectedNames[index])
    || actualPrimaryKey.length !== definition.primaryKey.length || actualPrimaryKey.some((name, index) => name !== definition.primaryKey[index])) {
    throw new TenantRegistrySchemaError('TENANT_REGISTRY_SCHEMA_TABLE_SHAPE_MISMATCH', `table ${definition.name} does not match the supported tenant registry schema`);
  }
}

function createFreshSchema(storage) {
  storage.transactionSync(() => {
    if (listUserTables(storage.sql).length !== 0) {
      throw new TenantRegistrySchemaError('TENANT_REGISTRY_SCHEMA_CONCURRENT_INITIALIZATION', 'tenant registry schema appeared while initialization was in progress');
    }
    for (const definition of TENANT_REGISTRY_TABLES) storage.sql.exec(createTableSql(definition));
    storage.sql.exec('INSERT INTO tenant_registry_schema (singleton, version) VALUES (?, ?)', SCHEMA_SINGLETON, TENANT_REGISTRY_SCHEMA_VERSION);
  });
}

function readSchemaVersion(sql) {
  const rows = sql.exec('SELECT singleton, version FROM tenant_registry_schema').toArray();
  if (rows.length !== 1 || rows[0].singleton !== SCHEMA_SINGLETON || !Number.isSafeInteger(rows[0].version)) {
    throw new TenantRegistrySchemaError('TENANT_REGISTRY_SCHEMA_VERSION_CORRUPT', 'tenant registry schema version is missing or corrupt');
  }
  return rows[0].version;
}

export function initializeTenantRegistrySchema(storage) {
  const existingTables = listUserTables(storage.sql);
  if (existingTables.length === 0) createFreshSchema(storage);
  else assertTableSet(existingTables);

  for (const definition of TENANT_REGISTRY_TABLES) assertTableShape(storage.sql, definition);
  const version = readSchemaVersion(storage.sql);
  if (version !== TENANT_REGISTRY_SCHEMA_VERSION) {
    throw new TenantRegistrySchemaError('TENANT_REGISTRY_SCHEMA_VERSION_UNSUPPORTED', `unsupported tenant registry schema version ${version}`);
  }
  return version;
}
