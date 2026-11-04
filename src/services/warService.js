const db = require('../db');
const defaults = require('../../config/defaults');
const { HOUR, DAY_NAMES, toLocalParts, nextWeekly, previousWeekly, formatDayTime, formatLocalDateTime } = require('../utils/time');

const STATUS_LABELS = {
  open: '🟢 Đang mở đăng ký',
  locked: '🔒 Đã chốt danh sách',
  published: '📢 Đã công bố đội hình',
  done: '🏁 Đã kết thúc',
};
const REG_LABELS = { join: 'Tham gia', reserve: 'Dự bị', absent: 'Vắng' };
const DUPLICATE_WINDOW = 12 * HOUR;
const POST_CLAIM_MS = 10 * 60 * 1000; // a war-message post attempt older than this is considered dead

// ---------- pure ----------

// Times of the next war cycle for a weekly schedule.
function computeCycle(schedule, now) {
  const warStart = nextWeekly(schedule.warDay, schedule.warTime, now);
  const openAt = previousWeekly(schedule.openDay, schedule.openTime, warStart);
  const deadline = new Date(warStart.getTime() - schedule.lockBeforeHours * HOUR);
  return { warStart, openAt, deadline };
}

// Reminder time for an event, or null when off or already past (avoid pinging right after posting).
function remindAtFor(deadlineAt, remindBeforeHours, now) {
  if (!(remindBeforeHours > 0)) return null;
  const at = new Date(deadlineAt.getTime() - remindBeforeHours * HOUR);
  return at > now ? at : null;
}

// True when the scheduler should create the event for this cycle now.
// `events` = non-done events of the guild.
function shouldAutoCreate(cycle, now, events) {
  if (now < cycle.openAt || now >= cycle.deadline) return false;
  const start = cycle.warStart.getTime();
  return !events.some((e) => e.status !== 'done' && Math.abs(new Date(e.startAt).getTime() - start) <= DUPLICATE_WINDOW);
}

function buildTitle(warStart, schedule) {
  return `Bang chiến ${formatDayTime(schedule.warDay, schedule.warTime)} (${formatLocalDateTime(warStart).split(' ')[0]})`;
}

// End of a war that starts at `warStart` (older saved schedules have no duration: use the default).
function warEnd(warStart, schedule) {
  const minutes = schedule?.warDurationMinutes ?? defaults.schedule.warDurationMinutes;
  return new Date(warStart.getTime() + minutes * 60 * 1000);
}

// "T7 11/10 20:00–21:00" (local time; the weekday is the one of warStart itself)
function formatWarWindow(warStart, schedule) {
  const [date, time] = formatLocalDateTime(warStart).split(' ');
  const endTime = formatLocalDateTime(warEnd(warStart, schedule)).split(' ')[1];
  return `${DAY_NAMES[toLocalParts(warStart).dow]} ${date} ${time}–${endTime}`;
}

// Error message (Vietnamese) or null.
function validateEventTimes(startAt, deadlineAt, now) {
  if (!startAt) return 'Giờ đánh không hợp lệ. Ví dụ: 25/12 20:00';
  if (!deadlineAt) return 'Hạn chốt không hợp lệ. Ví dụ: 25/12 18:00';
  if (startAt <= now) return 'Giờ đánh phải ở tương lai.';
  if (deadlineAt <= now) return 'Hạn chốt đã qua.';
  if (deadlineAt > startAt) return 'Hạn chốt phải trước hoặc bằng giờ đánh.';
  return null;
}

function canRegister(event, now) {
  return event.status === 'open' && now <= new Date(event.deadlineAt);
}

// Split mentions into messages of at most `limit` chars; header goes in the first one.
function buildReminderMessages(header, ids, limit = 1900) {
  const messages = [];
  let current = header;
  for (const id of ids) {
    const mention = `<@${id}>`;
    const next = current ? `${current} ${mention}` : mention;
    if (next.length > limit && current) {
      messages.push(current);
      current = mention;
    } else {
      current = next;
    }
  }
  if (current) messages.push(current);
  return messages;
}

// New deadline when a locked event is reopened: the regular lock time (start - lockBeforeHours) while that is still ahead,
// else the war start itself.
function reopenDeadline(event, schedule, now = new Date()) {
  const start = new Date(event.startAt);
  const hours = schedule && Number.isFinite(schedule.lockBeforeHours) ? schedule.lockBeforeHours : defaults.schedule.lockBeforeHours;
  const regular = new Date(start.getTime() - hours * HOUR);
  return regular > now ? regular : start;
}

// The war message of an open/locked event sits in another channel than the current announce channel.
const canMoveMessage = (event, config) =>
  Boolean(config.announceChannelId && event.channelId && event.messageId && event.channelId !== config.announceChannelId && (event.status === 'open' || event.status === 'locked'));

function messageLink(event) {
  return event.messageId ? `https://discord.com/channels/${event.guildId}/${event.channelId}/${event.messageId}` : '';
}

/// ---------- db ----------

// A war as the bot reads it: the old document shape (_id + camelCase fields).
const EVENT_SQL = `select w.id as "_id", w.guild_id as "guildId", w.title, w.start_at as "startAt", w.deadline_at as "deadlineAt",
  w.remind_at as "remindAt", w.reminded, w.status, w.channel_id as "channelId", w.message_id as "messageId",
  w.post_attempt_at as "postAttemptAt", w.manual_remind_at as "manualRemindAt", w.auto, w.lineup_url as "lineupUrl",
  w.lineup_note as "lineupNote", w.published_at as "publishedAt", w.open_pinged_at as "openPingedAt", w.created_at as "createdAt", w.updated_at as "updatedAt"
  from war_events w`;

const res = (n) => ({ matchedCount: n, modifiedCount: n, acknowledged: true });

function getEvent(eventId) {
  if (!db.isId(String(eventId))) return Promise.resolve(null);
  return db.one(`${EVENT_SQL} where w.id = $1`, [String(eventId)]);
}

// The first war matching a condition on `w` (with its own order by) -> event or null. For scripts that pick a war by date.
function findOneWhere(where, params = []) {
  return db.one(`${EVENT_SQL} where ${where} limit 1`, params);
}

// Wars of the guild that start at or after `since`, oldest first (the sheet's war history of the month).
function listSince(guildId, since) {
  return db.q(`${EVENT_SQL} where w.guild_id = $1 and w.start_at >= $2 order by w.start_at`, [guildId, since]);
}

function getCurrentEvent(guildId) {
  // Nearest war first: the earliest start among events that are not finished.
  return db.one(`${EVENT_SQL} where w.guild_id = $1 and w.status in ('open', 'locked', 'published') order by w.start_at limit 1`, [guildId]);
}

// The most recent event of the guild by war start, whatever its status (null when there is none).
function getLatestEvent(guildId) {
  return db.one(`${EVENT_SQL} where w.guild_id = $1 order by w.start_at desc limit 1`, [guildId]);
}

// The event of that guild for the war week of `startAt` (any status), or null: an event within DUPLICATE_WINDOW of it, so a
// changed warDay / warTime cannot open a second war the same week (the exact unique index stays as the backstop).
// Preference: the exact start, then an unfinished event, then the nearest.
async function findEventByStart(guildId, startAt) {
  const t = new Date(startAt).getTime();
  const rows = await db.q(`${EVENT_SQL} where w.guild_id = $1 and w.start_at between $2 and $3`, [guildId, new Date(t - DUPLICATE_WINDOW), new Date(t + DUPLICATE_WINDOW)]);
  const rank = (e) => [new Date(e.startAt).getTime() === t ? 0 : 1, e.status === 'done' ? 1 : 0, Math.abs(new Date(e.startAt).getTime() - t)];
  rows.sort((a, b) => {
    const x = rank(a);
    const y = rank(b);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
  return rows[0] || null;
}

// Every unfinished event that has a posted message (startup redraw).
function listAllWithMessage() {
  return db.q(`${EVENT_SQL} where w.status <> 'done' and w.message_id is not null`);
}

function listActiveEvents(guildId) {
  return db.q(`${EVENT_SQL} where w.guild_id = $1 and w.status <> 'done'`, [guildId]);
}

// A duplicate (guild, start) raises the unique violation (db.isUniqueViolation).
async function createEvent(data) {
  const id = db.newId();
  await db.q(
    `insert into war_events (id, guild_id, title, start_at, deadline_at, remind_at, auto, status) values ($1, $2, $3, $4, $5, $6, $7, coalesce($8, 'open'))`,
    [id, data.guildId, data.title, data.startAt, data.deadlineAt, data.remindAt ?? null, !!data.auto, data.status ?? null]
  );
  return getEvent(id);
}

async function deleteEvent(eventId) {
  if (!db.isId(String(eventId))) return { deletedCount: 0 };
  const rows = await db.q('delete from war_events where id = $1 returning id', [String(eventId)]);
  return { deletedCount: rows.length };
}

async function setMessage(eventId, channelId, messageId) {
  const rows = await db.q('update war_events set channel_id = $2, message_id = $3 where id = $1 returning id', [String(eventId), channelId, messageId]);
  return res(rows.length);
}

// Compare-and-set the war message location: succeeds only while the event is still open/locked and still points at
// `oldMessageId` (a second click / admin finds it already moved and gets false).
async function moveMessage(eventId, oldMessageId, channelId, messageId) {
  const rows = await db.q(
    `update war_events set channel_id = $3, message_id = $4 where id = $1 and status in ('open', 'locked') and message_id is not distinct from $2 returning id`,
    [String(eventId), oldMessageId ?? null, channelId, messageId]
  );
  return rows.length === 1;
}

// Claim the right to send the war message: true only for the caller that set postAttemptAt (no message yet and no
// attempt in the last POST_CLAIM_MS). Taken BEFORE channel.send so two ticks/processes never both send.
async function claimPost(eventId) {
  const now = Date.now();
  const rows = await db.q(
    `update war_events set post_attempt_at = $2 where id = $1 and message_id is null and (post_attempt_at is null or post_attempt_at < $3) returning id`,
    [String(eventId), new Date(now), new Date(now - POST_CLAIM_MS)]
  );
  return rows.length === 1;
}

// Column of each field a status transition may set.
const SET_COLUMNS = { status: 'status', deadlineAt: 'deadline_at', publishedAt: 'published_at' };

// Atomic status transition; returns the updated event or null if `from` did not match.
async function transition(eventId, from, set) {
  if (!db.isId(String(eventId))) return null;
  const params = [String(eventId), [].concat(from)];
  const sets = Object.entries(set).map(([k, v]) => {
    params.push(v);
    return `${SET_COLUMNS[k]} = $${params.length}`;
  });
  const row = await db.one(`update war_events set ${sets.join(', ')} where id = $1 and status = any($2) returning id`, params);
  return row ? getEvent(row.id) : null;
}

function lockEvent(eventId) {
  return transition(eventId, 'open', { status: 'locked' });
}

function reopenEvent(eventId, startAt) {
  return transition(eventId, 'locked', { status: 'open', deadlineAt: startAt });
}

// `publishedAt` = the moment the lineup was READ (snapshotAt), so an edit made while the image was rendered/sent still counts as stale.
function publishEvent(eventId, snapshotAt = new Date(), { advance = true } = {}) {
  const set = { status: 'published' };
  if (advance) set.publishedAt = snapshotAt;
  return transition(eventId, ['open', 'locked', 'published'], set);
}

// Takes the right to send the "registration is open" role ping: true only for the caller that set it (a retry / restart never pings twice).
async function claimOpenPing(eventId) {
  const rows = await db.q('update war_events set open_pinged_at = now() where id = $1 and open_pinged_at is null returning id', [String(eventId)]);
  return rows.length === 1;
}

// Wars whose registration is closed (locked / published) in every guild: the ones the Activity can show (the actSnapshot catch-up).
function listClosed() {
  return db.q(`${EVENT_SQL} where w.status in ('locked', 'published') order by w.start_at desc`);
}

// Wars that finished in the last `days` days (the Activity's copy is marked done for them when it missed it).
function listRecentDone(days = 14) {
  return db.q(`${EVENT_SQL} where w.status = 'done' and w.start_at > $1`, [new Date(Date.now() - days * 24 * HOUR)]);
}

function findDueLocks(now) {
  return db.q(`${EVENT_SQL} where w.status = 'open' and w.deadline_at <= $1`, [now]);
}

function findDueReminders(now) {
  return db.q(`${EVENT_SQL} where w.status = 'open' and not w.reminded and w.remind_at is not null and w.remind_at <= $1`, [now]);
}

// Returns true only for the caller that flipped the flag (prevents double reminders).
async function claimReminder(eventId) {
  const rows = await db.q('update war_events set reminded = true where id = $1 and not reminded returning id', [String(eventId)]);
  return rows.length === 1;
}

const MANUAL_REMIND_COOLDOWN_MS = 10 * 60 * 1000;

// Atomic claim of the manual reminder: succeeds only when none was sent in the last cooldown. -> { claimed, at } where `at` is
// the time of the reminder that blocked us (null when claimed).
async function claimManualRemind(eventId, now = new Date(), cooldownMs = MANUAL_REMIND_COOLDOWN_MS) {
  const since = new Date(now.getTime() - cooldownMs);
  const rows = await db.q('update war_events set manual_remind_at = $2 where id = $1 and (manual_remind_at is null or manual_remind_at < $3) returning id', [String(eventId), now, since]);
  if (rows.length === 1) return { claimed: true, at: null };
  const cur = await db.one('select manual_remind_at as at from war_events where id = $1', [String(eventId)]);
  return { claimed: false, at: (cur && cur.at) || null };
}

// Gives the claim back (only if it is still ours) when the reminder never went out.
async function releaseManualRemind(eventId, at) {
  const rows = await db.q('update war_events set manual_remind_at = null where id = $1 and manual_remind_at = $2 returning id', [String(eventId), at]);
  return res(rows.length);
}

function findFinished(now, doneAfterHours) {
  return db.q(`${EVENT_SQL} where w.status <> 'done' and w.start_at < $1`, [new Date(now.getTime() - doneAfterHours * HOUR)]);
}

function markDone(eventId) {
  return transition(eventId, ['open', 'locked', 'published'], { status: 'done' });
}

// The published lineup link (and the admin's note) of an event.
async function setLineupLink(eventId, url, note = '') {
  const rows = await db.q('update war_events set lineup_url = $2, lineup_note = $3 where id = $1 returning id', [String(eventId), url, note]);
  return res(rows.length);
}

module.exports = {
  STATUS_LABELS,
  REG_LABELS,
  POST_CLAIM_MS,
  computeCycle,
  remindAtFor,
  shouldAutoCreate,
  buildTitle,
  warEnd,
  formatWarWindow,
  validateEventTimes,
  canRegister,
  buildReminderMessages,
  reopenDeadline,
  canMoveMessage,
  messageLink,
  getEvent,
  findOneWhere,
  getCurrentEvent,
  listSince,
  findEventByStart,
  listActiveEvents,
  listAllWithMessage,
  createEvent,
  deleteEvent,
  setMessage,
  moveMessage,
  claimPost,
  lockEvent,
  reopenEvent,
  publishEvent,
  findDueLocks,
  listClosed,
  claimOpenPing,
  listRecentDone,
  findDueReminders,
  claimReminder,
  MANUAL_REMIND_COOLDOWN_MS,
  claimManualRemind,
  releaseManualRemind,
  findFinished,
  markDone,
  setLineupLink,
  getLatestEvent,
};
