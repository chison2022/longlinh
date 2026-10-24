// Shared PostgreSQL for tests (not a test file): one in-memory PGlite per test process, with db/schema.sql loaded.
//   const { setupDb, resetDb } = require('./pgdb');
//   before(setupDb); beforeEach(resetDb);
// Nothing here reaches a real server.
const { PGlite, types } = require('@electric-sql/pglite');
const db = require('../src/db');

let instance = null;

async function setupDb() {
  if (!instance) {
    instance = new PGlite({ parsers: { [types.INT8]: (v) => (v === null ? null : Number(v)) } });
    db.useBackend(db.pgliteBackend(instance));
    await db.ensureSchema();
  } else {
    db.useBackend(db.pgliteBackend(instance));
  }
  return instance;
}

// Empties every table and restarts the identity counters.
async function resetDb() {
  await setupDb();
  const tables = (await db.q("select tablename from pg_tables where schemaname = 'public'")).map((r) => r.tablename);
  if (tables.length) await instance.exec(`truncate ${tables.join(', ')} restart identity cascade`);
}

module.exports = { setupDb, resetDb };
