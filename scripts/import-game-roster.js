// Import the in-game member list (.xlsx, sheet "Thành viên") for a guild; each run updates the game characters (latest values, departures get left_at).
//   npm run roster:import -- --guild <guildId> --file <path.xlsx> [--dry]
// --dry parses and prints the summary without writing. Needs PG_URL and PG_CA in .env.
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const defaults = require('../config/defaults');
const db = require('../src/db');
const gameRoster = require('../src/services/gameRosterService');
const eventLog = require('../src/eventLog');
const { logDir } = require('../src/paths');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const guildId = arg('guild');
  const file = arg('file');
  const dry = process.argv.includes('--dry');
  if (!/^\d{17,20}$/.test(String(guildId)) || !file) {
    throw new Error('usage: npm run roster:import -- --guild <guildId> --file <path.xlsx> [--dry]');
  }
  if (!process.env.PG_URL) throw new Error('PG_URL is missing in .env');

  eventLog.init(logDir()); // the same events-*.jsonl as the bot: `npm run logs:report` shows the script import too
  await db.connectPg({ max: 2 });
  try {
    if (!dry) await db.ensureSchema();
    const config = await require('../src/services/guildConfigService').getConfig(guildId);
    const members = await gameRoster.parseRosterXlsx(fs.readFileSync(file), (config && config.classes) || defaults.classes);
    const sum = gameRoster.summarize(members);
    console.log(`${members.length} members: ${sum.byClass.map(([c, n]) => `${c} ${n}`).join(', ')}`);
    const prev = await gameRoster.latest(guildId);
    let d = null;
    if (prev) {
      d = gameRoster.diff(prev.members, members);
      console.log(`vs ${new Date(prev.importedAt).toISOString()}: +${d.added.length} -${d.removed.length} renamed ${d.renamed.length} rank ${d.rankChanged.length}`);
    }
    if (dry) return console.log('dry run: nothing saved');
    const saved = await gameRoster.saveImport({ guildId, importedBy: 'script', source: path.basename(file), members });
    console.log(`saved import ${saved._id}`);
    eventLog.logEvent('roster', 'import', { source: 'script', ok: true, guild: guildId, rows: members.length, added: d ? d.added.length : members.length, removed: d ? d.removed.length : 0, renamed: d ? d.renamed.length : 0, first: !prev });
  } finally {
    await db.disconnectPg();
  }
}

main().catch((err) => {
  eventLog.logEvent('roster', 'import', { source: 'script', ok: false, err });
  console.error(require('../config/pg').redactPg(String((err && err.message) || err)));
  process.exitCode = 1;
});
