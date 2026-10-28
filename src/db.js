// The one door to PostgreSQL. Services call q / one / tx; nothing else touches the driver.
// - q(sql, params) -> rows, one(sql, params) -> first row or null.
// - tx(fn): runs fn inside one transaction. Every q / one called while fn runs (also inside other services) goes through
//   that transaction (AsyncLocalStorage), so a service function can be reused inside a bigger transaction unchanged.
// - The backend is a pg Pool in the bot, a PGlite instance in tests (useBackend).
const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const als = new AsyncLocalStorage();
let backend = null; // { query(sql, params) -> { rows }, transaction(fn(client)) }
// Did the last round trip reach the server? A query that fails for a connection reason (not an SQL error) sets it false; a probe
// every RECHECK_MS then sets it back. isConnected() reads it, so /health and the dashboard see an outage.
let healthy = false;
let recheck = null;
const RECHECK_MS = 15 * 1000;

function useBackend(b) {
  backend = b;
  healthy = Boolean(b);
}

// SQLSTATE codes are 5 characters (class 08 = connection exception, 57P0x = server shutting down); anything else (ECONNRESET, a
// timeout, "Connection terminated") means the server was not reached.
function isConnectionError(err) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  if (/^[0-9A-Z]{5}$/.test(code) && !code.startsWith('E')) return code.startsWith('08') || code.startsWith('57P0');
  return true;
}

function noteResult(ok) {
  if (ok) {
    healthy = true;
    return;
  }
  healthy = false;
  if (recheck || !backend) return;
  recheck = setInterval(() => {
    if (!backend) return;
    backend.query('select 1', []).then(() => {
      healthy = true;
      clearInterval(recheck);
      recheck = null;
    }, () => {});
  }, RECHECK_MS);
  if (recheck.unref) recheck.unref();
}

// pg Pool -> backend. int8 (ids, count(*)) comes back as a JS number: every id and count here fits easily.
function poolBackend(pool) {
  require('pg').types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
  return {
    pool,
    query: (sql, params) => pool.query(sql, params),
    exec: (sql) => pool.query(sql), // several statements, no parameters
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const out = await fn(client);
        await client.query('commit');
        return out;
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    end: () => pool.end(),
  };
}

// PGlite (tests) -> backend.
function pgliteBackend(db) {
  return {
    db,
    query: (sql, params) => db.query(sql, params),
    exec: (sql) => db.exec(sql),
    transaction: (fn) => db.transaction((t) => fn(t)),
    end: () => db.close(),
  };
}

function current() {
  const client = als.getStore();
  if (client) return client;
  if (!backend) throw new Error('database not connected');
  return backend;
}

async function q(sql, params = []) {
  try {
    const rows = (await current().query(sql, params)).rows;
    if (!healthy) noteResult(true);
    return rows;
  } catch (err) {
    if (backend && isConnectionError(err)) noteResult(false);
    throw err;
  }
}

async function one(sql, params = []) {
  return (await q(sql, params))[0] || null;
}

// A nested tx joins the outer one.
function tx(fn) {
  if (als.getStore()) return fn();
  if (!backend) throw new Error('database not connected');
  return backend.transaction((client) => als.run(client, fn));
}

const UNIQUE_VIOLATION = '23505';
const isUniqueViolation = (err) => !!err && err.code === UNIQUE_VIOLATION;

// 24-hex ids for rows whose id rides in Discord customIds (wars, events, gate requests, letters): same shape as the old
// Mongo ids, so buttons on older messages keep working. 4 bytes of time + 8 random bytes.
function newId(now = Date.now()) {
  const t = Math.floor(now / 1000).toString(16).padStart(8, '0').slice(-8);
  return t + crypto.randomBytes(8).toString('hex');
}
const isId = (id) => typeof id === 'string' && /^[0-9a-f]{24}$/.test(id);

const SCHEMA_FILE = path.join(__dirname, '..', 'db', 'schema.sql');

// Creates the tables when the database is empty (a fresh service or a test database). Never alters existing tables.
// Changes to a database made from an older schema.sql, idempotent (run on every start).
const MIGRATIONS = [
  'alter table game_characters drop column if exists power', // Lực chiến dropped (2026-10-22)
  'alter table game_characters add column if not exists returned_at timestamptz', // roster status (2026-10-22)
  "alter table game_characters add column if not exists old_names text[] not null default '{}'",
  'alter table game_characters add column if not exists game_uid text', // in-game character ID (2026-10-28)
  'alter table gate_requests add column if not exists game_uid text',
  "create unique index if not exists gate_requests_pending_uid on gate_requests (guild_id, game_uid) where status = 'pending' and game_uid is not null",
  'create unique index if not exists game_characters_uid on game_characters (guild_id, game_uid) where game_uid is not null',
];

async function ensureSchema() {
  const row = await one("select to_regclass('public.guilds') as t");
  if (row && row.t) {
    for (const sql of MIGRATIONS) await q(sql);
    return false;
  }
  const c = current();
  const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
  await (c.exec ? c.exec(sql) : c.query(sql));
  return true;
}

// pg Pool from .env (PG_URL + PG_CA), checked with one round trip.
async function connectPg({ max = 5 } = {}) {
  const { pgPool } = require('../config/pg');
  const b = poolBackend(pgPool(max));
  try {
    await b.query('select 1');
  } catch (err) {
    await b.end().catch(() => {}); // a failed attempt must not leave its pool behind (the boot retries until the network is up)
    throw err;
  }
  useBackend(b);
  return b;
}

async function disconnectPg() {
  const b = backend;
  backend = null;
  healthy = false;
  if (recheck) clearInterval(recheck);
  recheck = null;
  if (b && b.end) await b.end();
}

const ping = () => q('select 1');
const isConnected = () => !!backend && healthy;

module.exports = { q, one, tx, useBackend, poolBackend, pgliteBackend, connectPg, disconnectPg, ensureSchema, ping, isConnected, newId, isId, isUniqueViolation, UNIQUE_VIOLATION };
