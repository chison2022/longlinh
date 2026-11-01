// Posts the war lineups the Activity asked for. Every 20 s: take the pending requests (war_lineups), render the PNG table, post it with
// the "Xem PT của tôi" button, mark the war published (registration closes, the war message and dashboard refresh) and write the
// Google Sheet tab. A Sheet failure never fails the post: it is kept as the lineup's publish_error. Runs inside the bot process
// (single instance), where an in-process flag keeps two overlapping runs from posting the same lineup twice.
const warService = require('../services/warService');
const lineupService = require('../services/lineupService');
const rules = require('../services/lineupRules');
const { plainClass } = require('../services/lineupStyle');
const { getConfig } = require('../services/guildConfigService');
const { layoutOf } = require('../services/teamService');
const { buildLineupPost } = require('../bot/ui/lineupPost');
const { buildLineupTab, LINEUP_TAB } = require('../services/sheets/lineupTab');
const { formatWarWindow } = warService;
const refresher = require('../bot/refresher');
const gateway = require('../services/sheets/gateway');
const { writeManagedTab } = require('../services/sheets/managedTab');
const { logEvent } = require('../eventLog');

const INTERVAL_MS = 20 * 1000;
let running = false;
let timer = null;

// canvas is a native module: loaded on first use only (tests of other parts and the Activity server never load it)
let renderer = null;
const render = (data) => (renderer || (renderer = require('../bot/ui/lineupImage').renderLineupPng))(data);

function stylesFor(client, config) {
  try {
    const guild = client.guilds && client.guilds.cache && client.guilds.cache.get(config.guildId);
    if (!guild) return {};
    const { stylesOf, lineupStyles } = require('../bot/classStyle');
    return lineupStyles(stylesOf(guild, config));
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
      const sheet = await retrying('sheet', () => writeManagedTab(gateway.getClient(), config.sheetId, buildLineupTab({ warId, layout: done.layout, people: done.people })), backoffMs, 2);
      if (!sheet.ok) warning = `Đã đăng nhưng chưa ghi được tab ${LINEUP_TAB}: ${gateway.describeError(sheet.err)}`;
    }
    done.bookkept = true;
    done.warning = warning;
  }
  const marked = await retrying('markPublished', () => lineupService.markPublished(warId, row.version, row.publishRequestedAt, warning, done.layout), backoffMs);
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
    }
    config = await getConfig(row.guildId);
    if (!previous) {
      if (!config) return await fail('Server chưa cài bot.');
      const channelId = war.channelId || config.announceChannelId;
      if (!channelId) return await fail('Chưa chọn kênh thông báo.');

      const joiners = await lineupService.listJoiners(warId);
      const people = Object.fromEntries(joiners.map((j) => [j.id, { name: j.name || j.id, className: j.className ? plainClass(j.className) : '' }]));
      const layout = rules.reshapeLayout(rules.filterLayout(row.layout, (id) => Boolean(people[id])), layoutOf(config));
      const png = await renderFn({
        title: war.title,
        subtitle: `${formatWarWindow(new Date(war.startAt), config.schedule)}  ·  Đội hình v${row.version}`,
        layout,
        people,
        classes: config.classes || [],
        styles: stylesFor(client, config),
      });
      try {
        const channel = await client.channels.fetch(channelId);
        await channel.send(buildLineupPost(war, config, png));
      } catch (err) {
        return await fail(`Không gửi được vào kênh <#${channelId}>. Kiểm tra quyền của bot.`, { err });
      }
      sent = true;
      Object.assign(done, { layout, people, bookkept: false });
      served.set(keyOf(row), done);
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

function start(client) {
  if (timer) return;
  timer = setInterval(() => runOnce(client), INTERVAL_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { runOnce, publishOne, start, stop, INTERVAL_MS, served };
