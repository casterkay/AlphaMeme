import { DatabaseSync } from 'node:sqlite';

// Each schema initializer accepts only its exact table set, so each owner has its own file.
export const DATABASE_FILES = Object.freeze({ radar: 'radar.sqlite', registry: 'registry.sqlite', host: 'host.sqlite' });

/** Opens a database file for the host: WAL, and every commit durable before it returns. */
export function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  return db;
}

/**
 * The Durable Object SQL storage surface the domain code uses, over one
 * node:sqlite database: `sql.exec` and nestable `transactionSync`. The outermost
 * transaction is BEGIN IMMEDIATE … COMMIT; a nested one is a savepoint, so an
 * inner failure undoes only its own writes and still propagates.
 */
export function sqliteStorage(db) {
  let depth = 0;
  return {
    sql: {
      exec(query, ...bindings) {
        const statement = db.prepare(query);
        if (statement.columns().length) return cursor(statement.all(...bindings));
        return cursor([], statement.run(...bindings).changes);
      }
    },
    transactionSync(callback) {
      const savepoint = depth === 0 ? null : `nested_${depth}`;
      db.exec(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
      depth += 1;
      let value;
      try {
        value = callback();
      } catch (error) {
        depth -= 1;
        db.exec(savepoint ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
        throw error;
      }
      depth -= 1;
      try {
        db.exec(savepoint ? `RELEASE ${savepoint}` : 'COMMIT');
      } catch (error) {
        if (!savepoint && db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
      return value;
    }
  };
}

function cursor(rows, rowsWritten) {
  return {
    rowsWritten,
    toArray: () => rows,
    one() {
      if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`);
      return rows[0];
    }
  };
}
