// Keeps the events Google Doc (GuildConfig.eventDocId, set in /setup → ⚙️ Nâng cao → 🎉 Sự kiện) in step with the events.
// Debounced longer than the Sheet (a rewrite costs ~2 Docs writes per event; Google allows ~60 writes a minute). Started from
// sheetSync.scheduleSync, so every place that refreshes the Sheet after an event change refreshes the Doc too. Never throws.
const { getConfig, isOn } = require('../services/guildConfigService');
const eventService = require('../services/eventService');
const gameRoster = require('../services/gameRosterService');
const gateway = require('../services/sheets/gateway');
const eventDoc = require('../services/sheets/eventDoc');
const { plainClass } = require('../services/lineupStyle');
const { liveRegs } = require('./liveNames');
const { loadGameNames } = require('./gameNames');
const { logEvent } = require('../eventLog');

const DOC_DEBOUNCE_MS = 60 * 1000;
const timers = new Map(); // guildId -> timer
const flights = new Map(); // guildId -> { dirty, promise }
const statuses = new Map(); // guildId -> { at, error } (memory only, shown in /setup)

// Google's refusals in words a manager can act on.
function docError(err) {
  const msg = String((err && err.message) || err);
  if (/has not been used|is disabled|SERVICE_DISABLED/i.test(msg)) return 'Google Docs API chưa bật trong dự án Google Cloud của bot (APIs & Services → bật Google Docs API).';
  if (err && (err.status === 403 || /permission/i.test(msg))) return `Bot chưa có quyền sửa Doc này: chia sẻ quyền **Người chỉnh sửa** cho ${gateway.accountEmail() || 'email của bot'}.`;
  if (err && err.status === 404) return 'Không tìm thấy Google Doc (link sai hoặc Doc đã bị xoá).';
  return `Không ghi được Google Doc: ${msg}`;
}

// -> { ok: true, events } | { ok: false, skipped?, message }
async function runOnce(client, guildId) {
  try {
    const config = await getConfig(guildId, { fresh: true });
    if (!config || !config.eventDocId) return { ok: false, skipped: 'no-doc', message: 'Chưa nối Google Doc.' };
    if (!isOn(config, 'events')) return { ok: false, skipped: 'off', message: 'Tính năng sự kiện đang tắt.' };
    if (!gateway.isAvailable()) return { ok: false, skipped: 'no-key', message: gateway.NO_KEY_HINT() };
    const guild = client && client.guilds && client.guilds.cache ? client.guilds.cache.get(guildId) : null;
    const { items } = await eventService.listForSheet(guildId);
    const roster = await gameRoster.latest(guildId, 'members.name members.className').catch(() => null);
    const classes = new Map(((roster && roster.members) || []).map((m) => [m.name, m.className]));
    const res = await eventDoc.writeEventDoc(gateway.getClient(), config.eventDocId, items.map(({ event, replies }) => ({ event, replies: liveRegs(guild, replies) })), {
      gameNames: await loadGameNames(guild),
      classOf: (name) => plainClass(classes.get(name) || '') || classes.get(name) || '',
      categoryOf: (e) => eventService.categoryOf(e).label,
      statusOf: (e) => (eventService.STATUS_LABELS[e.status] || e.status).replace(/^\S+\s/, ''),
      guildName: guild ? guild.name : '',
    });
    return { ok: true, events: res.events };
  } catch (err) {
    return { ok: false, message: docError(err), err };
  }
}

function syncDocNow(client, guildId, trigger = 'now') {
  const key = String(guildId);
  const current = flights.get(key);
  if (current) {
    current.dirty = true;
    return current.promise;
  }
  const flight = { dirty: false, promise: null };
  flight.promise = (async () => {
    const started = Date.now();
    try {
      let result;
      do {
        flight.dirty = false;
        result = await runOnce(client, key);
      } while (flight.dirty);
      if (!result.skipped) {
        statuses.set(key, result.ok ? { at: new Date(), error: null } : { ...(statuses.get(key) || { at: null }), error: result.message });
        logEvent('event', 'doc_sync', { guild: key, trigger, ok: result.ok, events: result.events, ms: Date.now() - started, err: result.err, lvl: result.ok ? undefined : 'warn' });
      }
      return result;
    } finally {
      flights.delete(key);
    }
  })();
  flights.set(key, flight);
  return flight.promise;
}

// Coalesced to one rewrite per DOC_DEBOUNCE_MS per guild; a no-op without the key file.
function scheduleDocSync(client, guildId, delay = DOC_DEBOUNCE_MS) {
  if (!gateway.isAvailable()) return;
  const key = String(guildId);
  if (timers.has(key)) return;
  const timer = setTimeout(() => {
    timers.delete(key);
    syncDocNow(client, key, 'debounce').catch(() => {});
  }, delay);
  if (timer.unref) timer.unref();
  timers.set(key, timer);
}

const getDocStatus = (guildId) => statuses.get(String(guildId)) || null;

function cancelScheduled() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  statuses.clear();
}

module.exports = { docError, syncDocNow, scheduleDocSync, getDocStatus, cancelScheduled };
