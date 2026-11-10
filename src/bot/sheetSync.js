// Feeds the admin's Google Sheet: the member sheet of feed.ALL_TABS (ThanhVien, BangChien_TuanNay, BangChien_LichSu, BaoDanh, SuKien), written
// by managedTab so the cells people edited are kept, and the tabs of the older layouts deleted. Debounced like the war message refresh:
// a burst of registrations makes ONE sync ~20 s later; "🔄 Đồng bộ ngay" (in the 📊 Google Sheet view) syncs at once. Nothing here throws:
// without a key file or a sheet id the sync is simply off, and failures are logged and returned as a Vietnamese sentence.
const { getConfig, isOn } = require('../services/guildConfigService');
const warService = require('../services/warService');
const eventService = require('../services/eventService');
const { listRegistrations } = require('../services/registrationService');
const gameRosterService = require('../services/gameRosterService');
const linkService = require('../services/linkService');
const attendanceService = require('../services/attendanceService');
const { memberInfo, isStranger } = require('../services/rosterService');
const gateway = require('../services/sheets/gateway');
const feed = require('../services/sheets/feed');
const { writeManagedTab, deleteTabs, formulaSeparator } = require('../services/sheets/managedTab');
const { ensureMembers } = require('./memberCache');
const refresher = require('./refresher');
const { logEvent } = require('../eventLog');

const SYNC_DEBOUNCE_MS = 20 * 1000;
const timers = new Map(); // guildId -> debounce timer
const flights = new Map(); // guildId -> { dirty, promise }
const statuses = new Map(); // guildId -> { at: last success Date | null, error: last failure text | null, members, week, history }: memory only
const INCOMPLETE = 'Bot chưa tải đủ danh sách thành viên Discord nên chưa ghi Sheet (sẽ thử lại ở lần đồng bộ sau).';

// The day a roster shows: the date in its file name (thanh-vien-bang-YYYY-MM-DD.xlsx = the video date), else when it was imported.
function rosterDay(roster) {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(roster.source || '');
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 5)) : roster.importedAt;
}

// -> { ok: true, members, week, history, events?, kept } (rows per tab; events only when the SuKien tab is written; kept = cells left as
// people edited them) | { ok: false, skipped: 'no-sheet'|'no-key', message } | { ok: false, message }
// `note` collects what the sheet.sync log line wants but the result does not carry (incomplete member list, the raw error).
async function runOnce(client, guildId, note = {}) {
  try {
    const config = await getConfig(guildId, { fresh: true });
    if (!config || !config.sheetId) return { ok: false, skipped: 'no-sheet', message: 'Chưa cài Google Sheet (nút 📊 Google Sheet).' };
    if (!gateway.isAvailable()) return { ok: false, skipped: 'no-key', message: gateway.NO_KEY_HINT() };
    const guild = client && client.guilds && client.guilds.cache ? client.guilds.cache.get(guildId) : null;
    const api = gateway.getClient();

    // the whole member list is needed: a half-filled cache would show real members as unlinked and drop people
    const { complete } = guild && guild.members ? await ensureMembers(guild) : { complete: false };
    if (!complete) {
      note.incomplete = true;
      return { ok: false, message: INCOMPLETE };
    }
    const infos = [...guild.members.cache.values()].map(memberInfo);
    const linked = await gameRosterService.loadMappings(guildId);
    const matchable = infos.filter((i) => !isStranger(i, config) || linked.has(i.id)); // a "Kẻ lạ mặt" is never auto-matched to a character
    const found = await gameRosterService.matchGuild(guildId, matchable.map((i) => ({ id: i.id, name: i.name, bot: i.bot })));
    const [dbMembers, departed] = await Promise.all([linkService.loadMembers(guildId), gameRosterService.departedOf(guildId)]);

    // this week's war (between wars the most recent one stays instead of wiping the tab); history = the finished wars of the month
    const weekWar = (await warService.getCurrentEvent(guildId)) || (await warService.getLatestEvent(guildId));
    const done = (await warService.listSince(guildId, feed.monthStart())).filter((w) => w.status === 'done' && !(weekWar && String(w._id) === String(weekWar._id)));
    // the attendance matrix: the last finished wars whatever the month (the registrations of a war are read once for both tabs)
    const lastDone = await warService.listLastDone(guildId, feed.MATRIX_WARS);
    const regsOf = new Map();
    const withRegs = (war) => {
      const key = String(war._id);
      if (!regsOf.has(key)) regsOf.set(key, listRegistrations(war._id));
      return regsOf.get(key).then((regs) => ({ war, regs }));
    };
    const [week, history, matrix, attendance] = await Promise.all([
      weekWar ? withRegs(weekWar) : null,
      Promise.all(done.map(withRegs)),
      Promise.all(lastDone.map(withRegs)),
      attendanceService.history(guildId),
    ]);
    let events = null; // a switched-off feature or a guild that never had an event: no SuKien tab (an existing one is left as it is)
    if (isOn(config, 'events')) {
      const { items, any } = await eventService.listForSheet(guildId);
      if (any) events = items;
    }

    const info = await api.getSpreadsheet(config.sheetId);
    const tabs = feed.buildSheet(
      { config, infos, roster: found ? found.roster.members : [], rosterAt: found ? rosterDay(found.roster) : null, match: found ? found.match : null, dbMembers, departed, week, history, matrix, attendance, events },
      { sep: formulaSeparator(info.locale) }
    );
    const out = {};
    let kept = 0;
    for (const spec of tabs) {
      const res = await writeManagedTab(api, config.sheetId, spec);
      out[spec.title] = res.rows;
      kept += res.kept;
    }
    await deleteTabs(api, config.sheetId, feed.OLD_TABS); // after the new tabs exist: a spreadsheet must keep one tab
    return {
      ok: true,
      members: out[feed.MEMBER_TAB],
      week: out[feed.WEEK_TAB],
      history: out[feed.HISTORY_TAB],
      ...(feed.EVENT_TAB in out ? { events: out[feed.EVENT_TAB] } : {}),
      kept,
    };
  } catch (err) {
    console.error(`[sheets] guild ${guildId}:`, err && err.message);
    note.err = err;
    return { ok: false, message: gateway.describeError(err) };
  }
}

// Remembers the outcome of a real attempt (not a skip for a missing sheet / key) for the dashboard and the 📊 view.
function noteResult(guildId, result) {
  if (result.skipped) return;
  const prev = statuses.get(guildId) || { at: null, members: 0, week: 0, history: 0 };
  statuses.set(guildId, result.ok ? { at: new Date(), error: null, members: result.members, week: result.week, history: result.history } : { ...prev, error: result.message });
}

// -> { at, error, members, week, history } of the last sync of a guild since the bot started, or null.
const getStatus = (guildId) => statuses.get(String(guildId)) || null;

// sheet.sync line. A skip (no sheet / no key) is quiet on the debounced path: every registration click of a guild without a sheet would log.
function logSync(guildId, trigger, result, ms, note) {
  if (result.skipped && trigger === 'debounce' && result.skipped === 'no-sheet') return;
  const { ok, skipped, members, week, history, events, kept } = result;
  const { incomplete, err } = note;
  logEvent('sheet', 'sync', {
    guild: guildId,
    trigger,
    ok,
    skipped: skipped || (incomplete ? 'members_incomplete' : undefined), // incomplete: nothing was written
    members,
    week,
    history,
    events,
    kept,
    ms,
    err: err || (ok === false && !skipped && !incomplete ? new Error(result.message) : undefined), // a failure always carries its error
    lvl: skipped || incomplete ? 'warn' : undefined,
  });
}

// One run at a time per guild; a call made meanwhile marks it dirty and the run repeats once (fresh DB state).
// `trigger` (debounce | now | created | connect) only labels the sheet.sync log line.
function syncNow(client, guildId, trigger = 'now') {
  const key = String(guildId);
  const current = flights.get(key);
  if (current) {
    current.dirty = true;
    return current.promise;
  }
  const flight = { dirty: false, promise: null };
  flight.promise = (async () => {
    const started = Date.now();
    const note = {};
    try {
      let result;
      do {
        flight.dirty = false;
        result = await runOnce(client, key, note);
      } while (flight.dirty);
      noteResult(key, result);
      logSync(key, trigger, result, Date.now() - started, note);
      return result;
    } finally {
      flights.delete(key);
    }
  })();
  flights.set(key, flight);
  return flight.promise;
}

// Coalesced: at most one sync per `delay` per guild. A no-op (no timer at all) while there is no key file.
// A call with a shorter delay than the one already waiting re-arms the timer earlier (a war created "now" is not held back by a
// registration click's 20 s).
function scheduleSync(client, guildId, delay = SYNC_DEBOUNCE_MS, trigger = 'debounce') {
  if (!gateway.isAvailable()) return;
  const key = String(guildId);
  const due = Date.now() + delay;
  const waiting = timers.get(key);
  if (waiting) {
    if (waiting.due <= due) return;
    clearTimeout(waiting.timer);
  }
  const timer = setTimeout(() => {
    timers.delete(key);
    syncNow(client, key, trigger).then(() => refresher.schedulePanelRefresh(client, key)).catch(() => {}); // the dashboard shows the sync time / error
  }, delay);
  if (timer.unref) timer.unref();
  timers.set(key, { timer, due });
}

// Tests: drop the pending timers.
function cancelScheduled() {
  for (const t of timers.values()) clearTimeout(t.timer);
  timers.clear();
  statuses.clear();
}

module.exports = { SYNC_DEBOUNCE_MS, scheduleSync, syncNow, getStatus, cancelScheduled };
