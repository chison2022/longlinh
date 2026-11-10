// Posts the war lineups the Activity asked for. Every 20 s: take the pending requests from the Activity's own database, render the PNG table, post it with
// the "Xem PT của tôi" button, mark the war published (registration closes, the war message and dashboard refresh) and write the
// Google Sheet tab. A Sheet failure never fails the post: it is kept as the lineup's publish_error. Runs inside the bot process
// (single instance), where an in-process flag keeps two overlapping runs from posting the same lineup twice.
const warService = require('../services/warService');
const lineupService = require('../services/lineupService');
const rules = require('../services/lineupRules');
const { plainClass } = require('../services/lineupStyle');
const { getConfig } = require('../services/guildConfigService');
const actBridge = require('../bot/actBridge');
const { buildLineupPost } = require('../bot/ui/lineupPost');
const { buildLineupTab, LINEUP_TAB } = require('../services/sheets/lineupTab');
const { formatWarWindow } = warService;
const refresher = require('../bot/refresher');
const gateway = require('../services/sheets/gateway');
const { writeManagedTab } = require('../services/sheets/managedTab');
const { logEvent } = require('../eventLog');

// How often the Activity's database is looked at. Neon sleeps when nothing talks to it, so the poll is as rare as it can be:
//   no war that is closed (locked / published) and starts within a week -> no look at the side database at all (only the main one, every 5 min);
//   otherwise every 20 s, backing off to 2 min after 30 empty looks (10 min); a publish request found = back to 20 s.
const FAST_MS = 20 * 1000;
const SLOW_MS = 2 * 60 * 1000;
const IDLE_MS = 5 * 60 * 1000;
const EMPTY_BEFORE_SLOW = 30;
const WINDOW_MS = 7 * 24 * 3600 * 1000;
let running = false;
let timer = null;
let empty = 0; // looks in a row that found nothing

// canvas is a native module: loaded on first use only (tests of other parts and the Activity server never load it)
let renderer = null;
const render = (data) => (renderer || (renderer = require('../bot/ui/lineupImage').renderLineupPng))(data);

function stylesFor(client, config) {
  try {
    const guild = client.guilds && client.guilds.cache && client.guilds.cache.get(config.guildId);
    if (!guild) return {};
    const { stylesOf, lineupStyles } = require('../bot/classStyle');
    // keyed by the plain class name: the people carry plain names
    return Object.fromEntries(Object.entries(lineupStyles(stylesOf(guild, config))).map(([label, v]) => [plainClass(label), v]));
  } catch {
    return {}; // the chips fall back to the palette colours
  }
}

// Posts that went out but whose bookkeeping (markPublished) has not been saved yet: `${warId}:${requestedAt ms}` -> { version, layout,
// warning }. A later run only retries the bookkeeping, it never posts again.
const served = new Map();
const keyOf = (row) => `${row.warId}:${new Date(row.publishRequestedAt).getTime()}`;

// `fn` with a few retries and growing pauses; -> { ok, value } (never throws).
async function retrying(label, fn, backoffMs, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      last = err;
      if (i < tries - 1 && backoffMs > 0) await new Promise((r) => setTimeout(r, backoffMs * 2 ** i));
    }
  }
  console.error(`[lineup] ${label}:`, last && last.message);
  return { ok: false, err: last };
}

// Everything after channel.send: nothing here may make the publish repeat, so each step has its own retries and none throws.
async function finishPost(client, row, war, config, done, { snapshotAt, backoffMs }) {
  const warId = row.warId;
  const key = keyOf(row);
  let warning = done.warning || null;
  if (!done.bookkept) {
    const pub = await retrying('publishEvent', () => warService.publishEvent(war._id, snapshotAt), backoffMs);
    refresher.scheduleRefresh(client, war._id, 0);
    refresher.schedulePanelRefresh(client, war.guildId);
    if (!pub.ok || !pub.value) warning = 'Đã đăng nhưng trạng thái bang chiến không đổi (có thể vừa kết thúc).';
    if (config.sheetId && gateway.isAvailable()) {
      const sheet = await retrying('sheet', () => writeManagedTab(gateway.getClient(), config.sheetId, buildLineupTab({ warId, layout: done.layout, people: done.people, notes: done.notes })), backoffMs, 2);
      if (!sheet.ok) warning = `Đã đăng nhưng chưa ghi được tab ${LINEUP_TAB}: ${gateway.describeError(sheet.err)}`;
    }
    done.bookkept = true;
    done.warning = warning;
  }
  const marked = await retrying('markPublished', () => lineupService.markPublished(warId, row.version, row.publishRequestedAt, warning, done.snapshot), backoffMs);
  if (marked.ok) served.delete(key);
  else logEvent('lineup', 'mark_failed', { eid: warId, guild: row.guildId, err: marked.err, lvl: 'error' }); // stays in `served`: the next run retries only this
  logEvent('lineup', 'publish', { eid: warId, guild: war.guildId, result: 'posted', version: row.version, sheet: warning ? 'warn' : config.sheetId ? 'ok' : 'off', marked: marked.ok });
}

// One pending publish. -> 'posted' | 'failed'. Throws nothing. Before the message is sent a problem is an error the admin sees; after
// it, nothing may fail the publish (it would be posted again).
async function publishOne(client, row, { renderFn = render, backoffMs = 1000 } = {}) {
  const warId = row.warId;
  const fail = async (message, extra = {}) => {
    await lineupService.markPublishError(warId, message, row.publishRequestedAt).catch(() => {});
    logEvent('lineup', 'publish', { eid: warId, guild: row.guildId, result: 'failed', reason: message, ...extra, lvl: 'warn' });
    return 'failed';
  };
  const previous = served.get(keyOf(row));
  // persisted by markSent right after the post: survives a restart
  const sentSnap = row.sentFor && row.sentSnapshot && new Date(row.sentFor).getTime() === new Date(row.publishRequestedAt).getTime() ? row.sentSnapshot : null;
  const snapshotAt = new Date();
  let war;
  let config;
  let sent = Boolean(previous);
  const done = previous || {};
  try {
    war = await warService.getEvent(warId);
    if (!previous) {
      if (!war || war.guildId !== row.guildId) return await fail('Bang chiến không còn tồn tại.');
      if (war.status === 'done') return await fail('Bang chiến đã kết thúc.');
      if (war.status === 'open' && !sentSnap) return await fail('Đăng ký đang mở lại — chốt lại rồi công bố.');
    }
    config = await getConfig(row.guildId);
    if (!previous && sentSnap) {
      // this request was already posted (the bot restarted before the bookkeeping): only the bookkeeping is left, nothing is sent again
      const members = [...(await lineupService.listMembers(warId)), ...(await lineupService.listMembers(warId, { removed: true }))];
      const people = Object.fromEntries(members.map((j) => [j.id, { name: j.name || j.id, discordName: j.discordName || '', linked: j.linked, className: j.className || '', task: (sentSnap.names[sentSnap.tasks[j.id]] || {}).label || '' }]));
      const { version: _v, ...snapshot } = sentSnap;
      sent = true;
      Object.assign(done, { layout: sentSnap.layout, people, notes: sentSnap.notes || {}, snapshot, bookkept: false });
      served.set(keyOf(row), done);
    } else if (!previous) {
      if (!config) return await fail('Server chưa cài bot.');
      const channelId = war.channelId || config.announceChannelId;
      if (!channelId) return await fail('Chưa chọn kênh thông báo.');

      // the people and the layout shape are the snapshot in the Activity's database (what the managers saw and edited), not the live registrations
      const guild = await lineupService.getGuild(row.guildId);
      const joiners = await lineupService.listMembers(warId);
      const people = Object.fromEntries(joiners.map((j) => [j.id, { name: j.name || j.id, discordName: j.discordName || '', linked: j.linked, className: j.className || '' }]));
      const shape = lineupService.shapeOfGuild(guild);
      const layout = rules.reshapeLayout(rules.filterLayout(row.layout, (id) => Boolean(people[id])), shape);
      // task of everyone placed: the leader's choice, else their own wish; the names are frozen into the snapshot
      const taskList = new Map((await lineupService.listTasks(row.guildId)).map((t) => [t.key, t]));
      const extras = rules.pruneExtras(layout, row.tasks, row.partyNotes, shape);
      const wish = Object.fromEntries(joiners.map((j) => [j.id, j.rolePref]));
      const tasks = rules.effectiveTasks(layout, extras.tasks, (id) => wish[id]);
      const names = {};
      for (const [id, key] of Object.entries(tasks)) {
        const t = taskList.get(key);
        people[id].task = t ? t.label : '';
        if (t) names[key] = { label: t.label, emoji: t.emoji };
      }
      const snapshot = { layout, tasks, notes: extras.notes, names };
      const png = await renderFn({
        title: war.title,
        subtitle: `${formatWarWindow(new Date(war.startAt), config.schedule)}  ·  Đội hình v${row.version}`,
        layout,
        people,
        notes: extras.notes,
        classes: ((guild && guild.classes) || []).map((c) => c.name),
        styles: stylesFor(client, config),
      });
      try {
        const channel = await client.channels.fetch(channelId);
        await channel.send(buildLineupPost(war, config, png));
      } catch (err) {
        return await fail(`Không gửi được vào kênh <#${channelId}>. Kiểm tra quyền của bot.`, { err });
      }
      sent = true;
      Object.assign(done, { layout, people, notes: extras.notes, snapshot, bookkept: false });
      served.set(keyOf(row), done);
      await retrying('markSent', () => lineupService.markSent(warId, row.publishRequestedAt, { ...snapshot, version: row.version }), backoffMs, 3); // the post is on record before anything else
    }
  } catch (err) {
    console.error('[lineup] publish:', err.message);
    if (!sent) return fail('Lỗi khi đăng đội hình, thử lại.', { err });
  }
  // the message is out (now or in an earlier run): only bookkeeping is left
  if (!war || !config) {
    war = war || (await warService.getEvent(warId).catch(() => null));
    config = config || (await getConfig(row.guildId).catch(() => null));
  }
  if (!war || !config) {
    logEvent('lineup', 'mark_failed', { eid: warId, guild: row.guildId, reason: 'no war / config after the post', lvl: 'error' });
    return 'posted'; // stays in `served`: retried without posting again
  }
  await finishPost(client, row, war, config, done, { snapshotAt, backoffMs });
  return 'posted';
}

// One pass over the pending requests. A second call while one runs does nothing.
async function runOnce(client, options = {}) {
  if (running) return [];
  running = true;
  try {
    if (!(await actBridge.ensureUp())) return []; // no side database (off or down): nothing to look at, tried again next tick
    const out = [];
    for (const row of await lineupService.claimPendingPublishes()) out.push([row.warId, await publishOne(client, row, options)]);
    return out;
  } catch (err) {
    console.error('[lineup] pending publishes:', err.message);
    logEvent('lineup', 'poll_error', { err });
    return [];
  } finally {
    running = false;
  }
}

// One look: -> the time to wait before the next one.
async function step(client, now = Date.now()) {
  let active = true;
  try {
    active = (await warService.listClosed()).some((w) => new Date(w.startAt).getTime() <= now + WINDOW_MS);
  } catch {
    active = true; // the main database hiccuped: look anyway
  }
  if (!active) {
    empty = 0;
    return IDLE_MS;
  }
  const out = await runOnce(client);
  empty = out.length ? 0 : empty + 1;
  return empty < EMPTY_BEFORE_SLOW ? FAST_MS : SLOW_MS;
}

function start(client) {
  if (timer) return;
  const loop = async () => {
    let wait = FAST_MS;
    try {
      wait = await step(client);
    } catch (err) {
      console.error('[lineup] poll:', err && err.message);
    }
    if (!timer) return; // stopped meanwhile
    timer = setTimeout(loop, wait);
    if (timer.unref) timer.unref();
  };
  timer = setTimeout(loop, FAST_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
}

function resetPolling() {
  empty = 0;
}

module.exports = { runOnce, step, start, stop, resetPolling, FAST_MS, SLOW_MS, IDLE_MS, EMPTY_BEFORE_SLOW, served };
