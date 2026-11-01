// Entry of the Activity web server: `node activity/server.js` (Render, or locally). Env: PORT, PG_URL + PG_CA_PEM (or PG_CA),
// CLIENT_ID, CLIENT_SECRET, DISCORD_TOKEN (REST only, to read the guild's roles). It never logs in a Discord client and never changes
// the database structure: the BOT runs the migrations, so update and start the bot first.
require('dotenv').config({ quiet: true });
const db = require('../src/db');
const { createApp } = require('./app');

// Columns the Activity needs in war_lineups (the later ones came with a bot update).
const NEEDED = ['war_id', 'layout', 'version', 'publish_requested_at', 'published_at', 'publish_error', 'published_layout', 'claimed_at'];

// -> the names of what is missing from war_lineups ([] when the structure is complete; ['war_lineups'] when the table is absent).
async function schemaProblems() {
  const rows = await db.q("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'war_lineups'");
  if (!rows.length) return ['war_lineups'];
  const have = new Set(rows.map((r) => r.column_name));
  return NEEDED.filter((c) => !have.has(c)).map((c) => `war_lineups.${c}`);
}

async function main() {
  const missing = ['PG_URL', 'CLIENT_ID', 'CLIENT_SECRET'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Missing env: ${missing.join(', ')}`);
  if (!process.env.DISCORD_TOKEN) console.warn('[activity] DISCORD_TOKEN is missing: only the configured admin roles count as managers (not Manage Server / owner).');
  await db.connectPg({ max: 4 });
  const absent = await schemaProblems();
  if (absent.length) throw new Error(`Database is not up to date (missing: ${absent.join(', ')}). Cập nhật bot trước rồi mới chạy Activity. / Update and start the bot first, then run the Activity.`);
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, '0.0.0.0', () => console.log(`[activity] listening on ${port}`));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[activity] cannot start:', require('../config/pg').redactPg(err.message));
    process.exit(1);
  });
}

module.exports = { main, schemaProblems };
