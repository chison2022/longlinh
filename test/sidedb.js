// The Activity's own database for tests (not a test file): one in-memory PGlite per test process with activity/schema.sql loaded.
//   before(setupSide); beforeEach(resetSide);
// Independent of test/pgdb.js (the main database): the two handles never see each other's tables.
const { PGlite, types } = require('@electric-sql/pglite');
const side = require('../src/sideDb');

let instance = null;

async function setupSide() {
  if (!instance) {
    instance = new PGlite({ parsers: { [types.INT8]: (v) => (v === null ? null : Number(v)) } });
    side.useBackend(side.pgliteBackend(instance));
    await side.ensureSideSchema();
  } else {
    side.useBackend(side.pgliteBackend(instance));
  }
  return instance;
}

// Empties every table.
async function resetSide() {
  await setupSide();
  const tables = (await side.q("select tablename from pg_tables where schemaname = 'public'")).map((r) => r.tablename);
  if (tables.length) await instance.exec(`truncate ${tables.join(', ')} restart identity cascade`);
}

module.exports = { setupSide, resetSide };
