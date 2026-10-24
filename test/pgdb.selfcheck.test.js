const test = require('node:test');
const assert = require('node:assert/strict');
const { setupDb, resetDb } = require('./pgdb');
const db = require('../src/db');

test.before(setupDb);
test.beforeEach(resetDb);

test('pgdb: schema loaded, tx rolls back on error, nested q joins the transaction', async () => {
  await db.q("insert into guilds (id) values ('g1')");
  await assert.rejects(db.tx(async () => {
    await db.q("insert into guilds (id) values ('g2')");
    throw new Error('boom');
  }));
  assert.deepEqual((await db.q('select id from guilds order by id')).map((r) => r.id), ['g1']);
  assert.ok(db.isId(db.newId()));
});
