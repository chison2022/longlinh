// Minute tick: finish old events, auto-lock, remind, auto-create, notice who left the game. Every step is idempotent,
// so running it once on startup also catches up on anything missed while the bot was offline.
const cron = require('node-cron');
const db = require('../db');
const defaults = require('../../config/defaults');
const warService = require('../services/warService');
const eventService = require('../services/eventService');
const { listRegistrations } = require('../services/registrationService');
const { getConfig, listScheduledConfigs, isOn } = require('../services/guildConfigService');
const { discordTs } = require('../utils/time');
const { defang } = require('../services/mailService');
const { ensureMembers } = require('../bot/memberCache');
const { scheduleRefresh, scheduleEventRefresh, schedulePanelRefresh, postWarMessage, hasPendingSave, retryPendingSaves } = require('../bot/refresher');
const { scheduleSync } = require('../bot/sheetSync');
const { scheduleDocSync } = require('../bot/eventDocSync');
const departNotice = require('../bot/departNotice');
const offNotice = require('../bot/offNotice');
const { buildMinNotice } = require('../bot/ui/eventCard');
const { v2Create } = require('../bot/ui/common');
const { logEvent } = require('../eventLog');

const POST_BACKOFF_MS = 30 * 60 * 1000;
const ORPHAN_GRACE_MS = 2 * 60 * 1000; // an event younger than this may still be mid-post (another process)
const postBackoff = new Map(); // guildId -> time until which auto-create is skipped after a failed post

let running = false;
let task = null;

async function each(label, items, fn) {
  for (const item of items) {
    try {
      await fn(item);
    } catch (err) {
      console.error(`[scheduler] ${label} ${item._id || item.guildId}:`, err.message);
      logEvent('sched', 'step_error', { step: label, id: String(item._id || item.guildId), guild: item.guildId, err });
    }
  }
}

async function finishEvents(client, now) {
  const events = await warService.findFinished(now, defaults.doneAfterHours);
  await each('done', events, async (e) => {
    if (await warService.markDone(e._id)) {
      logEvent('sched', 'done', { eid: String(e._id), guild: e.guildId });
      scheduleRefresh(client, e._id, 0);
    }
  });
}

async function lockDue(client, now) {
  const events = await warService.findDueLocks(now);
  await each('lock', events, async (e) => {
    if (await warService.lockEvent(e._id)) {
      logEvent('sched', 'lock', { eid: String(e._id), guild: e.guildId });
      scheduleRefresh(client, e._id, 0);
    }
  });
}

// Is the feature on for this guild (🧩 Tính năng)? A failed config read counts as on: it must not silence the old behaviour.
async function featureOn(guildId, key) {
  try {
    return isOn(await getConfig(guildId), key); // no config document: the new-guild defaults
  } catch (err) {
    console.warn(`[scheduler] config of ${guildId} unreadable, assuming ${key} is on:`, err.message);
    return true;
  }
}

// The events of the guilds that have `key` on (the others are skipped: nothing is claimed or changed for them).
async function whereOn(events, key) {
  const kept = [];
  const known = new Map(); // guildId -> boolean
  for (const e of events) {
    if (!known.has(e.guildId)) known.set(e.guildId, await featureOn(e.guildId, key));
    if (known.get(e.guildId)) kept.push(e);
  }
  return kept;
}

// Member ids with the member role who have not registered ; null if members cannot be fetched.
let fallbackErr = null; // why the last missingMemberIds returned null (for the sched.remind line)
async function missingMemberIds(client, event, roleId) {
  fallbackErr = null;
  try {
    const guild = await client.guilds.fetch(event.guildId);
    const { complete, members, error } = await ensureMembers(guild, { force: true });
    if (!complete) throw error;
    const registered = new Set((await listRegistrations(event._id)).map((r) => r.discordId));
    return members.filter((m) => !m.user.bot && m.roles.cache.has(roleId) && !registered.has(m.id)).map((m) => m.id);
  } catch (err) {
    console.warn(`[scheduler] cannot fetch members of ${event.guildId} (Server Members Intent on?):`, err.message);
    fallbackErr = err;
    return null;
  }
}

async function sendReminder(client, event) {
  const config = await getConfig(event.guildId);
  const channelId = (config && config.announceChannelId) || event.channelId;
  if (!channelId) {
    logEvent('sched', 'remind', { eid: String(event._id), guild: event.guildId, pinged: 0, reason: 'no_channel', lvl: 'warn' });
    return;
  }
  const channel = await client.channels.fetch(channelId);
  const link = warService.messageLink(event);
  const header = `⏰ **${event.title}** sắp hết hạn đăng ký (${discordTs(new Date(event.deadlineAt), 'R')}).${link ? ` Đăng ký tại: ${link}` : ''}`;

  const roleId = config && config.memberRoleId;
  const ids = roleId ? await missingMemberIds(client, event, roleId) : null;
  if (ids === null) {
    await channel.send({ content: header, allowedMentions: { parse: [] } });
    // no mentions: the member role is not set, or the member list could not be fetched
    logEvent('sched', 'remind', { eid: String(event._id), guild: event.guildId, fallback: true, reason: roleId ? 'members_unavailable' : 'no_member_role', err: (roleId && fallbackErr) || undefined, lvl: 'warn' }); // without a role missingMemberIds never ran: fallbackErr would be stale
    return;
  }
  if (ids.length === 0) {
    logEvent('sched', 'remind', { eid: String(event._id), guild: event.guildId, pinged: 0, reason: 'everyone_registered' });
    return;
  }
  const messages = warService.buildReminderMessages(`${header}\nChưa đăng ký:`, ids);
  for (const content of messages) {
    await channel.send({ content, allowedMentions: { parse: ['users'] } });
  }
  logEvent('sched', 'remind', { eid: String(event._id), guild: event.guildId, pinged: ids.length, messages: messages.length });
}

async function remindDue(client, now) {
  const events = await warService.findDueReminders(now);
  await each('remind', events, async (e) => {
    // Claim first so a failure part-way never causes repeated pings.
    if (await warService.claimReminder(e._id)) await sendReminder(client, e);
  });
}

function postFailureReason(err) {
  if (err && err.code === 10003) return 'kênh thông báo không tồn tại (Unknown Channel)';
  if (err && (err.code === 50001 || err.code === 50013)) return 'bot thiếu quyền trong kênh thông báo (Missing Access/Permissions)';
  return (err && err.message) || String(err);
}

// An auto event that exists without a war message (its post failed and so did the cleanup, or the process died
// in between) would leave the guild without a message and block re-creation: post it now.
// The grace period is real elapsed time since the insert (not the tick's `now`): it only protects a post in progress.
// Also skipped: an event whose last post attempt is younger than POST_CLAIM_MS (claimed, possibly still sending) and one
// whose message was sent but whose id is still being saved (retryPendingSaves) - re-posting those would double-post.
function findUnposted(events) {
  const attemptedRecently = (e) => e.postAttemptAt && Date.now() - new Date(e.postAttemptAt) < warService.POST_CLAIM_MS;
  return events.find(
    (e) =>
      e.auto &&
      e.status === 'open' &&
      !e.messageId &&
      !(e.createdAt && Date.now() - new Date(e.createdAt) < ORPHAN_GRACE_MS) &&
      !attemptedRecently(e) &&
      !hasPendingSave(e._id)
  );
}

async function autoCreate(client, now) {
  await retryPendingSaves();
  const configs = await listScheduledConfigs();
  async function post(config, event, at, verb, result) {
    let posted;
    try {
      if (event.postAttemptAt) {
        console.warn(`[scheduler] event ${event._id}: an earlier post attempt left no saved message id; an older untracked message may exist in the channel`);
      }
      posted = await postWarMessage(client, config, event);
      if (!posted) return; // another tick/process holds the claim
    } catch (err) {
      postBackoff.set(config.guildId, new Date(at.getTime() + POST_BACKOFF_MS));
      logEvent('sched', 'create', { result: 'skipped', reason: 'post_failed', why: postFailureReason(err), backoffMin: POST_BACKOFF_MS / 60000, eid: String(event._id), guild: config.guildId, err });
      console.error(`[scheduler] guild ${config.guildId}: cannot post the war message (${postFailureReason(err)}); retrying in 30 minutes`);
      return;
    }
    console.log(`[scheduler] ${verb} "${event.title}" in guild ${config.guildId}`);
    logEvent('sched', 'create', { result, eid: String(event._id), guild: config.guildId, idSaved: posted.saved !== false });
    schedulePanelRefresh(client, config.guildId); // the dashboard shows the new event
    scheduleSync(client, config.guildId, 0, 'created'); // the sheet switches to the new war
  }
  await each('create', configs, async (config) => {
    const until = postBackoff.get(config.guildId);
    if (until && now < until) return;
    const cycle = warService.computeCycle(config.schedule, now);
    const events = await warService.listActiveEvents(config.guildId);
    const unposted = findUnposted(events);
    if (unposted) {
      await post(config, unposted, now, 'posted the missing war message of', 'posted_missing');
      return;
    }
    if (!warService.shouldAutoCreate(cycle, now, events)) return;
    if (await warService.findEventByStart(config.guildId, cycle.warStart)) return; // same check as the admin path, incl. a finished (done) war
    let event;
    try {
      event = await warService.createEvent({
        guildId: config.guildId,
        title: warService.buildTitle(cycle.warStart, config.schedule),
        startAt: cycle.warStart,
        deadlineAt: cycle.deadline,
        remindAt: warService.remindAtFor(cycle.deadline, config.schedule.remindBeforeHours, now),
        auto: true,
      });
    } catch (err) {
      if (db.isUniqueViolation(err)) {
        logEvent('sched', 'create', { result: 'skipped', reason: 'duplicate', guild: config.guildId }); // another tick/process already created this war
        return;
      }
      throw err;
    }
    await post(config, event, now, 'auto-created', 'created');
  });
}

// ---------- guild events (ev:*): lock at the deadline, remind once before the start, finish after it ----------

async function lockDueEvents(client, now) {
  const events = await whereOn(await eventService.findDueLocks(now), 'events');
  await each('event_lock', events, async (e) => {
    if (await eventService.lockEvent(e._id)) {
      logEvent('event', 'lock', { eid: String(e._id), guild: e.guildId, result: 'locked', by: 'auto' });
      scheduleEventRefresh(client, e._id, 0);
      scheduleSync(client, e.guildId); // the sheet's event status
      scheduleDocSync(client, e.guildId); // ... and the events Google Doc
    }
  });
}

// Pings the ✅ and ❓ people; allowedMentions names exactly those users.
async function sendEventReminder(client, event) {
  const config = await getConfig(event.guildId);
  const channelId = event.channelId || eventService.eventChannelOf(config); // the event's own card channel first
  const ids = eventService.remindTargets(await eventService.listReplies(event._id));
  if (!channelId || !ids.length) {
    logEvent('event', 'remind', { eid: String(event._id), guild: event.guildId, mode: 'auto', pinged: 0, reason: channelId ? 'nobody' : 'no_channel', lvl: channelId ? undefined : 'warn' });
    return;
  }
  const link = eventService.messageLink(event);
  const header = `⏰ **${defang(event.title)}** bắt đầu ${discordTs(new Date(event.startAt), 'R')}.${link ? ` ${link}` : ''}`;
  const messages = eventService.buildRemindMessages(header, ids);
  const channel = await client.channels.fetch(channelId);
  for (const m of messages) await channel.send({ content: m.content, allowedMentions: { users: m.users } });
  logEvent('event', 'remind', { eid: String(event._id), guild: event.guildId, mode: 'auto', pinged: ids.length, messages: messages.length });
}

async function remindDueEvents(client, now) {
  const events = await whereOn(await eventService.findDueReminders(now), 'events');
  await each('event_remind', events, async (e) => {
    // Claim first so a failure part-way never causes repeated pings.
    if (await eventService.claimRemind(e._id, now)) await sendEventReminder(client, e);
  });
}

async function finishDueEvents(client, now) {
  const events = await whereOn(await eventService.findFinished(now), 'events');
  await each('event_done', events, async (e) => {
    if (await eventService.markDone(e._id)) {
      logEvent('event', 'done', { eid: String(e._id), guild: e.guildId });
      scheduleEventRefresh(client, e._id, 0);
      scheduleSync(client, e.guildId);
    }
  });
}

// An event with a minimum that is short at its deadline: ONE notice in the event management channel (else the admin channel; no mentions) with Huỷ / Gia hạn / Vẫn tổ chức. The
// claim (minNoticeAt) is taken first and also when the minimum was reached (nothing to say, but it is not judged again every minute); an
// extension clears it. No such channel: nothing is claimed, the notice comes once one is chosen (until an hour after the start: the deadline defaults to the start, see findDueMinNotices).
async function noticeMinShortfall(client, now) {
  const events = await whereOn(await eventService.findDueMinNotices(now), 'events');
  await each('event_min', events, async (e) => {
    const config = await getConfig(e.guildId);
    const noticeChannelId = eventService.eventAdminChannelOf(config);
    if (!noticeChannelId) return;
    const counts = await eventService.countsOf(e._id);
    const short = counts.yes < e.minParticipants;
    if (!(await eventService.claimMinNotice(e._id, now))) return; // another tick / process has it
    const base = { eid: String(e._id), guild: e.guildId, yes: counts.yes, min: e.minParticipants };
    if (!short) {
      logEvent('event', 'min_notice', { ...base, result: 'skipped', reason: 'reached' });
      return;
    }
    try {
      const channel = await client.channels.fetch(noticeChannelId);
      await channel.send(v2Create(buildMinNotice(e, counts)));
    } catch (err) {
      console.error(`[scheduler] min notice ${e._id}:`, err.message); // claimed already: not retried, no repeated notices
      logEvent('event', 'min_notice', { ...base, result: 'skipped', reason: 'post_failed', channel: noticeChannelId, err, lvl: 'warn' });
      return;
    }
    logEvent('event', 'min_notice', { ...base, result: 'posted', channel: noticeChannelId });
  });
}

// One step of the minute tick; each part is idempotent (atomic transitions / claims), so a restart simply catches up.
async function eventsStep(client, now) {
  await remindDueEvents(client, now);
  await lockDueEvents(client, now);
  await noticeMinShortfall(client, now);
  await finishDueEvents(client, now);
}

async function tick(client, now = new Date()) {
  if (running) return;
  running = true;
  try {
    for (const [label, step] of [
      ['done', finishEvents],
      ['lock', lockDue],
      ['remind', remindDue],
      ['create', autoCreate],
      ['events', eventsStep],
      ['depart', (client) => departNotice.noticeDue(client)], // a new game import: managers hear who left the game but is still on Discord
      ['offwarn', (client) => offNotice.noticeDue(client)], // ... and who has been off for N days
    ]) {
      try {
        await step(client, now);
      } catch (err) {
        console.error(`[scheduler] ${label}:`, err.message);
        logEvent('sched', 'step_error', { step: label, err });
      }
    }
  } finally {
    running = false;
  }
}

function start(client) {
  if (task) return;
  tick(client);
  task = cron.schedule('* * * * *', () => tick(client), { timezone: 'Asia/Ho_Chi_Minh', noOverlap: true });
}

function stop() {
  if (task) task.stop();
  task = null;
  postBackoff.clear();
}

module.exports = { tick, start, stop, eventsStep };
