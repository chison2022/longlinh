// The Activity's own database handle (Neon Postgres): a second, independent handle next to the main one (see db.js makeDb). The bot and
// the Activity server both use it for everything the lineup board stores; the main database never sees those tables.
const fs = require('node:fs');
const path = require('node:path');
const { makeDb } = require('./db');

const side = makeDb();
const SCHEMA_FILE = path.join(__dirname, '..', 'activity', 'schema.sql');

const hostOf = (url) => {
  try {
    return new URL(String(url).trim()).hostname.toLowerCase();
  } catch {
    return '';
  }
};

let refusal = null; // why urlOf said no (the bridge logs it once)

// ACTIVITY_PG_URL, else DATABASE_URL (the Neon URL the bot's .env already has); null = the Activity bridge is off. A URL that points at the
// bot's MAIN database (same host as PG_URL) is refused: the Activity must never write there.
function urlOf(env = process.env) {
  refusal = null;
  const url = (env.ACTIVITY_PG_URL || env.DATABASE_URL || '').trim();
  if (!url) return null;
  const main = hostOf(env.PG_URL || '');
  if (main && hostOf(url) === main) {
    refusal = 'the Activity database URL points at the main database (same host as PG_URL)';
    return null;
  }
  return url;
}

// Creates the tables (idempotent). Run by the bot; the Activity server only checks (activity/server.js).
const ensureSideSchema = () => side.execScript(fs.readFileSync(SCHEMA_FILE, 'utf8'));

module.exports = { ...side, urlOf, refusalOf: () => refusal, ensureSideSchema, SCHEMA_FILE };
