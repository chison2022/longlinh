// The bot's side of the Activity bridge: keeps the connection to the Activity's own database (src/sideDb.js) and copies a war into it ONCE,
// when registration locks (and for wars that are already closed when the bot starts). Everything here degrades quietly: no URL = the bridge
// is off; the side database down = a log line, retried on the next tick. Nothing in this file may throw into the bot.
const { PermissionFlagsBits } = require('discord.js');
const side = require('../sideDb');
const lineupService = require('../services/lineupService');
const defaults = require('../../config/defaults');
const warService = require('../services/warService');
const actSnapshot = require('../services/actSnapshot');
const { getConfig } = require('../services/guildConfigService');
const { layoutOf } = require('../services/teamService');
const { plainClass } = require('../services/lineupStyle');
const { logEvent } = require('../eventLog');

const RETRY_LOG_MS = 10 * 60 * 1000;
let status = 'off'; // 'off' (no URL) | 'down' | 'up'
let warnedOff = false;
let lastDownLog = 0;
let connecting = null;
let enabled = false; // switched on by start(): tests and tools never open the side database by themselves

// Connects (and creates the side schema) when needed. -> true when the side database can be used.
async function ensureUp() {
  if (side.isConnected()) {
    status = 'up';
    return true;
  }
  if (!enabled) return false;
  const url = side.urlOf();
  if (!url) {
    if (!warnedOff) {
      warnedOff = true;
      const refused = side.refusalOf();
      console.log(refused ? `[activity] the Activity bridge is off: ${refused}` : '[activity] no ACTIVITY_PG_URL / DATABASE_URL: the Activity bridge is off');
      logEvent('activity', 'bridge', { result: 'off', reason: refused ? 'main_database' : 'no_url' });
    }
    status = 'off';
    return false;
  }
  if (!connecting) {
    connecting = (async () => {
      try {
        await side.disconnectPg().catch(() => {});
        await side.connectUrl(url);
        await side.ensureSideSchema();
        status = 'up';
        warnedOff = false;
        logEvent('activity', 'bridge', { result: 'up' });
      } catch (err) {
        status = 'down';
        if (Date.now() - lastDownLog > RETRY_LOG_MS) {
          lastDownLog = Date.now();
          console.error('[activity] side database unreachable:', String(err && err.message).replace(/postgres(ql)?:\/\/[^@\s/]+@/g, 'postgres$1://<redacted>@'));
          logEvent('activity', 'bridge', { result: 'down', err });
        }
      } finally {
        connecting = null;
      }
    })();
  }
  await connecting;
  return status === 'up';
}

// Called once by the scheduler's start: from now on the bridge connects when it is needed.
function start() {
  enabled = true;
}

const isUp = () => side.isConnected(); // the shared handle's own health flag (a connection error flips it until the next probe)

// Everything the Activity needs to know about the guild: who may edit, the classes with their icons, the layout.
function guildInfoOf(client, guildId, config) {
  const guild = client && client.guilds && client.guilds.cache ? client.guilds.cache.get(guildId) : null;
  const managerRoleIds = guild && guild.roles
    ? guild.roles.cache.filter((r) => r.permissions.has(PermissionFlagsBits.Administrator) || r.permissions.has(PermissionFlagsBits.ManageGuild)).map((r) => r.id)
    : [];
  let styles = null;
  let codes = new Map();
  try {
    const classStyle = require('./classStyle');
    codes = classStyle.classCodes(config.classes || []);
    styles = guild ? classStyle.stylesOf(guild, config) : null;
    const classes = (config.classes || []).map((label) => {
      const style = styles ? classStyle.styleOf(styles, label) : null;
      const name = plainClass(label);
      return { name, tag: codes.get(name) || '', emojiId: style && style.emoji ? style.emoji.id : null };
    });
    return { guildId, adminRoleIds: config.adminRoleIds || [], managerRoleIds: [...managerRoleIds], ownerId: guild ? guild.ownerId : null, classes, rules: { healerClass: defaults.healerClass, tankClass: defaults.tankClass }, shape: layoutOf(config) };
  } catch {
    return { guildId, adminRoleIds: config.adminRoleIds || [], managerRoleIds: [...managerRoleIds], ownerId: guild ? guild.ownerId : null, classes: (config.classes || []).map((l) => ({ name: plainClass(l), tag: '', emojiId: null })), rules: { healerClass: defaults.healerClass, tankClass: defaults.tankClass }, shape: layoutOf(config) };
  }
}

// Copies one war into the side database. -> true when written. Never throws.
async function snapshotWar(client, warId) {
  try {
    if (!(await ensureUp())) return false;
    const war = await warService.getEvent(warId);
    if (!war || war.status === 'open' || war.status === 'done') return false;
    const config = await getConfig(war.guildId);
    if (!config) return false;
    const joiners = await actSnapshot.listJoiners(war._id);
    await actSnapshot.writeSnapshot({ guild: guildInfoOf(client, war.guildId, config), war, joiners });
    written.add(String(war._id));
    failures.delete(String(war._id));
    logEvent('activity', 'snapshot', { eid: String(war._id), guild: war.guildId, joiners: joiners.length });
    return true;
  } catch (err) {
    console.error('[activity] snapshot failed:', err && err.message);
    logEvent('activity', 'snapshot_error', { eid: String(warId), err });
    status = side.isConnected() ? status : 'down';
    return false;
  }
}

// Registration just locked: copy the war (always: a re-lock refreshes the joiners).
function onLocked(client, warId) {
  return snapshotWar(client, warId);
}

// Registration was reopened: the board shows it cannot publish until the war is locked again (which copies the joiners again). Best effort.
async function onReopened(warId) {
  try {
    if (isUp()) await lineupService.setWarStatus(warId, 'open');
  } catch (err) {
    console.error('[activity] reopen failed:', err && err.message);
  }
}

// ---- catch-up: the Neon database is only asked about wars the main database says it may be missing. Everything already written or
// reconciled is remembered in memory, a failing war backs off (1 min, doubling, up to 1 h), and with nothing new to look at no side query is made.
const written = new Set(); // war ids known to be in the side database
const reconciled = new Set(); // finished war ids whose copy was marked done
const failures = new Map(); // war id -> { n, until }
const BACKOFF_MIN_MS = 60 * 1000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;
let catching = false;

function noteFailure(id, now = Date.now()) {
  const n = ((failures.get(id) || {}).n || 0) + 1;
  failures.set(id, { n, until: now + Math.min(BACKOFF_MIN_MS * 2 ** (n - 1), BACKOFF_MAX_MS) });
}

// Closed wars the side database does not have yet are copied (a few per call); finished wars get marked done there. -> how many were copied.
async function catchUp(client, limit = 3, now = Date.now()) {
  if (!enabled && !side.isConnected()) return 0; // the bridge was never switched on (tests, tools)
  try {
    const closed = await warService.listClosed();
    const fresh = closed.filter((w) => !written.has(String(w._id)) && !((failures.get(String(w._id)) || {}).until > now));
    const done = (await warService.listRecentDone()).filter((w) => !reconciled.has(String(w._id)));
    if (!fresh.length && !done.length) return 0; // nothing new: the side database is not touched at all
    if (!(await ensureUp())) return 0;
    let copied = 0;
    if (fresh.length) {
      const known = new Set((await side.q('select war_id from act_wars where war_id = any($1::text[])', [fresh.map((w) => String(w._id))])).map((r) => String(r.war_id).trim()));
      for (const id of known) written.add(id);
      for (const w of fresh.filter((x) => !known.has(String(x._id))).slice(0, limit)) {
        if (await snapshotWar(client, w._id)) copied++;
        else noteFailure(String(w._id), now);
      }
    }
    if (done.length) {
      await side.q("update act_wars set status = 'done' where war_id = any($1::text[]) and status <> 'done'", [done.map((w) => String(w._id))]);
      for (const w of done) reconciled.add(String(w._id));
    }
    return copied;
  } catch (err) {
    console.error('[activity] catch-up failed:', err && err.message);
    return 0;
  }
}

// The scheduler's call: runs in the background with its own in-flight guard, so the minute tick never waits for the side database.
function catchUpSoon(client) {
  if (catching) return;
  catching = true;
  catchUp(client)
    .catch((err) => console.error('[activity] catch-up failed:', err && err.message))
    .finally(() => {
      catching = false;
    });
}

// A war finished in the main database: the board stops offering it. Best effort.
async function markDone(warId) {
  try {
    reconciled.add(String(warId));
    if (isUp()) await side.q("update act_wars set status = 'done' where war_id = $1", [String(warId)]);
  } catch (err) {
    reconciled.delete(String(warId)); // retried by the catch-up
    console.error('[activity] markDone failed:', err && err.message);
  }
}

// Forget what the catch-up remembers (tests).
function resetMemory() {
  written.clear();
  reconciled.clear();
  failures.clear();
}

module.exports = { start, ensureUp, isUp, snapshotWar, onLocked, onReopened, catchUp, catchUpSoon, markDone, resetMemory };
