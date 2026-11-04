// Entry of the Activity web server: `node activity/server.js` (Render, or locally). Env: PORT, DATABASE_URL (or ACTIVITY_PG_URL: the Activity's
// own Neon database), CLIENT_ID, CLIENT_SECRET. It never touches the bot's main database, never logs in a Discord client and holds no bot
// token. It never changes the database structure either: the BOT creates the tables (activity/schema.sql) and fills them when registration
// locks, so update and start the bot first.
require('dotenv').config({ quiet: true });
const side = require('../src/sideDb');
const { createApp } = require('./app');

// What the Activity needs in its database.
const NEEDED = {
  act_guilds: ['guild_id', 'admin_role_ids', 'manager_role_ids', 'owner_id', 'classes', 'rules', 'shape'],
  act_wars: ['war_id', 'guild_id', 'title', 'start_at', 'status', 'link_groups'],
  act_members: ['war_id', 'member_key', 'name', 'class_name', 'manual', 'removed', 'removed_by'],
  act_lineups: ['war_id', 'layout', 'version', 'tasks', 'party_notes', 'publish_requested_at', 'published_at', 'publish_error', 'published_layout', 'claimed_at'],
  act_tasks: ['guild_id', 'key', 'label', 'emoji', 'position'],
};

// -> what is missing: 'table' when a table is absent, 'table.column' for a missing column ([] when the structure is complete).
async function schemaProblems() {
  const rows = await side.q("select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name = any($1)", [Object.keys(NEEDED)]);
  const have = new Map();
  for (const r of rows) have.set(r.table_name, (have.get(r.table_name) || new Set()).add(r.column_name));
  const out = [];
  for (const [table, cols] of Object.entries(NEEDED)) {
    if (!have.has(table)) out.push(table);
    else for (const c of cols) if (!have.get(table).has(c)) out.push(`${table}.${c}`);
  }
  return out;
}

async function main() {
  const url = side.urlOf();
  if (!url) throw new Error('Missing env: DATABASE_URL (or ACTIVITY_PG_URL)');
  const missing = ['CLIENT_ID', 'CLIENT_SECRET'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Missing env: ${missing.join(', ')}`);
  await side.connectUrl(url, { max: 4 });
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
