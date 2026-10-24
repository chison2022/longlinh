// Guild events ("Sự kiện", customIds ev:*, card in bot/ui/eventCard.js). The bot only tracks who joins: ✅ yes / ❓ maybe / ❌ no.
// Pure helpers first, then the DB layer. Every status change and claim is ONE atomic update, like warService.
const db = require('../db');
const memberStore = require('./members');
const defaults = require('../../config/defaults');
const { HOUR, parseTime, parseLocalDateTime, parseLocalDateTimeNear, formatLocalDateTime, toLocalParts, fromLocal } = require('../utils/time');

const MINUTE = 60 * 1000;
const TITLE_MAX = 100;
const DESCRIPTION_MAX = 4000; // the paragraph input of a modal
const CAPACITY_MAX = 1000;
const CATEGORIES = defaults.eventCategories;
const DONE_AFTER_START_MS = 6 * HOUR; // an event without an end time is over 6 h after it started
const DONE_AFTER_END_MS = HOUR; // ... with one, 1 h after it ended
const SHEET_DAYS = 30; // the sheet tab keeps events of the last 30 days plus the upcoming ones
const MANUAL_REMIND_COOLDOWN_MS = 10 * MINUTE;
const MIN_NOTICE_GRACE_MS = HOUR; // the shortfall notice may still fire up to 1 h after the start (deadline == start is the default)
const MAX_USERS_PER_REMIND = 90; // a reminder message pings at most this many people (Discord allows 100 allowed users)
const REPLIES = ['yes', 'maybe', 'no'];
const REPLY_LABELS = { yes: 'Tham gia', maybe: 'Có thể', no: 'Không' };
const STATUS_LABELS = { open: '🟢 Đang mở', locked: '🔒 Đã chốt', cancelled: '❌ Đã huỷ', done: '⚫ Đã kết thúc' };

// ---------- pure ----------

// A date typed in the form. `existing` = the stored event when editing:
// - the text equals what the edit form showed for the stored date (the prefill has no year) -> that very Date, unchanged;
// - else, with an `anchor` Date, the year that puts the date closest to it (never "this year" blindly);
// - else (a new event) parseLocalDateTime's rule.
function resolveDate(text, now, { keep = null, anchor = null } = {}) {
  const raw = String(text || '').trim();
  if (keep && raw === formatLocalDateTime(new Date(keep))) return new Date(keep);
  return anchor ? parseLocalDateTimeNear(raw, new Date(anchor)) : parseLocalDateTime(raw, now);
}

// The start field takes an optional end time: "25/12 20:00" or "25/12 20:00 - 22:00" (an end before the start means next day).
// `existing` (the stored event, optional): an unchanged start / end keeps its stored Date, a changed start is read in the year nearest the stored one.
function parseStartField(text, now, existing = null) {
  const raw = String(text || '').trim();
  const m = /^(.*\d)\s+[-–—]\s*(\d{1,2}[:hH]\d{2})$/.exec(raw);
  const startAt = resolveDate(m ? m[1] : raw, now, existing ? { keep: existing.startAt, anchor: existing.startAt } : {});
  if (!startAt || !m) return { startAt, endAt: null };
  const time = parseTime(m[2]);
  if (!time) return { startAt: null, endAt: null };
  if (existing && existing.endAt && startAt.getTime() === new Date(existing.startAt).getTime()) {
    const old = toLocalParts(new Date(existing.endAt));
    if (old.hour === time.hour && old.minute === time.minute) return { startAt, endAt: new Date(existing.endAt) }; // unchanged
  }
  const p = toLocalParts(startAt);
  let endAt = fromLocal(p.year, p.month, p.day, time.hour, time.minute);
  if (endAt <= startAt) endAt = new Date(endAt.getTime() + 24 * HOUR);
  return { startAt, endAt };
}

// The time field: "dd/mm HH:mm[ - HH:mm] | hạn dd/mm HH:mm" (the deadline part is optional). -> { startAt, endAt, deadlineText } (startAt null = bad).
function parseTimeField(text, now, existing = null) {
  const raw = String(text || '');
  const bar = raw.indexOf('|');
  const { startAt, endAt } = parseStartField(bar < 0 ? raw : raw.slice(0, bar), now, existing);
  const deadlineText = bar < 0 ? '' : raw.slice(bar + 1).replace(/^\s*h[aạ]n\s*:?\s*/i, '').trim();
  return { startAt, endAt, deadlineText };
}

// The people field: "15-32" (min-max) · "15-" (min only) · "-20" or "20" (max only) · empty (no limits). -> { min, max } | { error }
function parsePeopleField(text) {
  const raw = String(text || '').trim();
  const bad = { error: `Số người: nhập "tối thiểu-tối đa", ví dụ 15-32 (15- chỉ có tối thiểu, -20 hoặc 20 chỉ có tối đa, để trống = không giới hạn). Mỗi số từ 1 đến ${CAPACITY_MAX}.` };
  if (!raw) return { min: null, max: null };
  const m = /^(\d{1,4})$/.exec(raw) || /^(\d{1,4})?\s*[-–—]\s*(\d{1,4})?$/.exec(raw);
  if (!m) return bad;
  const single = !/[-–—]/.test(raw);
  const min = single ? null : m[1] === undefined ? null : Number(m[1]);
  const max = single ? Number(m[1]) : m[2] === undefined ? null : Number(m[2]);
  if (min === null && max === null) return bad;
  for (const n of [min, max]) if (n !== null && !(n >= 1 && n <= CAPACITY_MAX)) return bad;
  if (min !== null && max !== null && min > max) return { error: `Số tối thiểu (${min}) không được lớn hơn số tối đa (${max}).` };
  return { min, max };
}

// The create / edit modal values ({ title, category, description, time, people }) -> { value: { title, category, description, startAt, endAt,
// deadlineAt, capacity, minParticipants } } | { error } (Vietnamese).
// `existing` = the stored event when editing: an unchanged start / deadline may already be in the past, a changed one may not.
function parseEventForm(raw, now = new Date(), existing = null) {
  const title = String(raw.title || '').trim();
  if (!title) return { error: 'Tên sự kiện không được để trống.' };
  if (title.length > TITLE_MAX) return { error: `Tên sự kiện tối đa ${TITLE_MAX} ký tự.` };
  const category = String(raw.category || defaults.eventCategoryDefault);
  if (!CATEGORIES[category]) return { error: 'Loại sự kiện không hợp lệ.' };
  const description = String(raw.description || '').trim();
  if (description.length > DESCRIPTION_MAX) return { error: `Mô tả / thể lệ tối đa ${DESCRIPTION_MAX} ký tự.` };

  const { startAt, endAt, deadlineText } = parseTimeField(raw.time, now, existing);
  if (!startAt) return { error: 'Thời gian bắt đầu không hợp lệ. Ví dụ: 25/12 20:00 (thêm giờ kết thúc: 25/12 20:00 - 22:00, thêm hạn đăng ký: 25/12 20:00 | hạn 24/12 18:00)' };
  const startChanged = !existing || new Date(existing.startAt).getTime() !== startAt.getTime();
  if (startChanged && startAt <= now) return { error: 'Thời gian bắt đầu phải ở tương lai.' };

  let deadlineAt = startAt;
  if (deadlineText) {
    deadlineAt = resolveDate(deadlineText, now, { keep: existing && existing.deadlineAt, anchor: startAt }); // a deadline lies just before the start: nearest year to it
    if (!deadlineAt) return { error: 'Hạn đăng ký không hợp lệ. Ví dụ: | hạn 24/12 18:00 (bỏ phần hạn = đến giờ bắt đầu)' };
    if (deadlineAt > startAt) return { error: 'Hạn đăng ký phải trước hoặc bằng giờ bắt đầu.' };
    const deadlineChanged = !existing || new Date(existing.deadlineAt).getTime() !== deadlineAt.getTime();
    if (deadlineChanged && deadlineAt <= now) return { error: 'Hạn đăng ký đã qua.' };
  }

  const people = parsePeopleField(raw.people);
  if (people.error) return { error: people.error };
  return { value: { title, category, description, startAt, endAt, deadlineAt, capacity: people.max, minParticipants: people.min } };
}

// The new deadline of the "⏳ Gia hạn" modal: still ahead and strictly before the start. -> { deadlineAt } | { error }
function parseExtendDeadline(text, event, now = new Date()) {
  const deadlineAt = parseLocalDateTime(String(text || ''), now);
  if (!deadlineAt) return { error: 'Hạn mới không hợp lệ. Ví dụ: 25/12 18:00' };
  if (deadlineAt <= now) return { error: 'Hạn mới đã qua.' };
  if (deadlineAt >= new Date(event.startAt)) return { error: 'Hạn mới phải trước giờ bắt đầu.' };
  return { deadlineAt };
}

// How many ✅ are missing to reach the minimum (0: no minimum, or reached).
const shortfallOf = (event, counts) => (event.minParticipants && counts && counts.yes < event.minParticipants ? event.minParticipants - counts.yes : 0);

// { key, emoji, label } of an event (an old event without a category is "Khác").
function categoryOf(event) {
  const key = event && CATEGORIES[event.category] ? event.category : defaults.eventCategoryDefault;
  return { key, ...CATEGORIES[key] };
}

// Members can answer while the card is open and the deadline has not passed (the scheduler locks it within a minute after).
const canReply = (event, now = new Date()) => Boolean(event) && event.status === 'open' && now <= new Date(event.deadlineAt);

// When the automatic reminder is due (null: off).
function remindAtOf(event) {
  const minutes = Number(event.remindBeforeMinutes);
  return minutes > 0 ? new Date(new Date(event.startAt).getTime() - minutes * MINUTE) : null;
}

// When an unfinished event counts as over.
const doneAtOf = (event) => (event.endAt ? new Date(new Date(event.endAt).getTime() + DONE_AFTER_END_MS) : new Date(new Date(event.startAt).getTime() + DONE_AFTER_START_MS));

// The people a reminder pings: ✅ then ❓ (never ❌), each once.
function remindTargets(replies) {
  const ids = [];
  for (const status of ['yes', 'maybe']) for (const r of replies) if (r.status === status && !ids.includes(r.discordId)) ids.push(r.discordId);
  return ids;
}

// Reminder messages of at most `limit` chars; the header goes in the first. Each message carries the ids it mentions, so the send can
// allow exactly those users (a title typed by a manager can never ping anybody else).
function buildRemindMessages(header, ids, limit = 1900) {
  const messages = [];
  let content = header;
  let users = [];
  for (const id of ids) {
    const mention = `<@${id}>`;
    if (users.length && (users.length >= MAX_USERS_PER_REMIND || `${content} ${mention}`.length > limit)) {
      messages.push({ content, users });
      content = mention;
      users = [id];
    } else {
      content = content ? `${content} ${mention}` : mention;
      users.push(id);
    }
  }
  if (content) messages.push({ content, users });
  return messages;
}

// Where new event cards go / where the shortfall notice and the event panel go: the event channels when set, else the war ones.
const eventChannelOf = (config) => (config && (config.eventChannelId || config.announceChannelId)) || null;
const eventAdminChannelOf = (config) => (config && (config.eventAdminChannelId || config.adminChannelId)) || null;

const messageLink = (event) => (event.messageId ? `https://discord.com/channels/${event.guildId}/${event.channelId}/${event.messageId}` : '');

/// ---------- events ----------

// An event as the bot reads it: the old document shape (_id + camelCase fields).
const EVENT_SQL = `select e.id as "_id", e.guild_id as "guildId", e.title, e.description, e.category, e.start_at as "startAt", e.end_at as "endAt",
  e.deadline_at as "deadlineAt", e.capacity, e.min_participants as "minParticipants", e.min_notice_at as "minNoticeAt",
  e.allow_maybe as "allowMaybe", e.remind_before_minutes as "remindBeforeMinutes", e.channel_id as "channelId", e.message_id as "messageId",
  e.status, e.created_by as "createdBy", e.reminded_at as "remindedAt", e.manual_remind_at as "manualRemindAt",
  e.created_at as "createdAt", e.updated_at as "updatedAt"
  from guild_events e`;

// camelCase field -> column, for the fields a create / edit / transition may write.
const COLUMNS = {
  guildId: 'guild_id', title: 'title', description: 'description', category: 'category', startAt: 'start_at', endAt: 'end_at',
  deadlineAt: 'deadline_at', capacity: 'capacity', minParticipants: 'min_participants', minNoticeAt: 'min_notice_at',
  allowMaybe: 'allow_maybe', remindBeforeMinutes: 'remind_before_minutes', channelId: 'channel_id', messageId: 'message_id',
  status: 'status', createdBy: 'created_by', remindedAt: 'reminded_at', manualRemindAt: 'manual_remind_at',
};
const res = (n) => ({ matchedCount: n, modifiedCount: n, acknowledged: true });
const fieldsOf = (data) => Object.entries(data).filter(([k, v]) => COLUMNS[k] && v !== undefined);

function getEvent(eventId) {
  if (!db.isId(String(eventId))) return Promise.resolve(null);
  return db.one(`${EVENT_SQL} where e.id = $1`, [String(eventId)]);
}

async function createEvent(data) {
  const id = db.newId();
  const fields = fieldsOf({ category: defaults.eventCategoryDefault, ...data });
  const cols = ['id', ...fields.map(([k]) => COLUMNS[k])];
  const params = [id, ...fields.map(([, v]) => v)];
  await db.q(`insert into guild_events (${cols.join(', ')}) values (${params.map((_, i) => `$${i + 1}`).join(', ')})`, params);
  return getEvent(id);
}

async function deleteEvent(eventId) {
  if (!db.isId(String(eventId))) return { deletedCount: 0 };
  return { deletedCount: (await db.q('delete from guild_events where id = $1 returning id', [String(eventId)])).length };
}

async function setMessage(eventId, channelId, messageId) {
  return res((await db.q('update guild_events set channel_id = $2, message_id = $3 where id = $1 returning id', [String(eventId), channelId, messageId])).length);
}

// The card was deleted (Unknown Message): forget its id, but only if it is still that message.
async function clearMessage(eventId, messageId) {
  return res((await db.q('update guild_events set message_id = null where id = $1 and message_id = $2 returning id', [String(eventId), messageId])).length);
}

// The events a manager can still act on: open / locked, soonest first.
function listManage(guildId, limit = 25) {
  return db.q(`${EVENT_SQL} where e.guild_id = $1 and e.status in ('open', 'locked') order by e.start_at limit $2`, [guildId, limit]);
}

// Atomic status transition; returns the updated event or null when `from` did not match.
async function transition(eventId, from, set) {
  if (!db.isId(String(eventId))) return null;
  const params = [String(eventId), [].concat(from)];
  const sets = fieldsOf(set).map(([k, v]) => {
    params.push(v);
    return `${COLUMNS[k]} = $${params.length}`;
  });
  if (!sets.length) return null;
  const row = await db.one(`update guild_events set ${sets.join(', ')} where id = $1 and status = any($2) returning id`, params);
  return row ? getEvent(row.id) : null;
}

const lockEvent = (eventId) => transition(eventId, 'open', { status: 'locked' });
const cancelEvent = (eventId) => transition(eventId, ['open', 'locked'], { status: 'cancelled' });
const markDone = (eventId) => transition(eventId, ['open', 'locked'], { status: 'done' });
// A reopened event needs a deadline in the future, else the next minute locks it again: `deadlineAt` is the new one.
const reopenEvent = (eventId, deadlineAt) => transition(eventId, 'locked', { status: 'open', deadlineAt });

// "⏳ Gia hạn": back to open with a new deadline (a locked event is reopened), and the shortfall notice may fire again at the next one.
const extendEvent = (eventId, deadlineAt) => transition(eventId, ['open', 'locked'], { status: 'open', deadlineAt, minNoticeAt: null });

// Edit of an open / locked event (null: it was cancelled / finished meanwhile). A moved start re-arms the automatic reminder.
function updateEvent(eventId, patch, { startChanged = false } = {}) {
  const set = { ...patch };
  if (startChanged) set.remindedAt = null;
  return transition(eventId, ['open', 'locked'], set);
}

// ---------- replies ----------

const REPLY_SQL = `select r.event_id as "eventId", r.guild_id as "guildId", m.discord_id as "discordId", m.display_name as "displayName",
  r.status, r.created_at as "createdAt", r.updated_at as "updatedAt"
  from event_replies r join discord_members m on m.id = r.member_id`;

function listReplies(eventId) {
  if (!db.isId(String(eventId))) return Promise.resolve([]);
  return db.q(`${REPLY_SQL} where r.event_id = $1 order by r.created_at, m.discord_id`, [String(eventId)]);
}

// { yes, maybe, no } of one event.
async function countsOf(eventId) {
  return (await countsFor([eventId])).get(String(eventId)) || { yes: 0, maybe: 0, no: 0 };
}

// Map eventId -> { yes, maybe, no } for several events in one query.
async function countsFor(eventIds) {
  const out = new Map(eventIds.map((id) => [String(id), { yes: 0, maybe: 0, no: 0 }]));
  const ids = eventIds.map(String).filter(db.isId);
  if (!ids.length) return out;
  const rows = await db.q('select event_id, status, count(*) as n from event_replies where event_id = any($1) group by event_id, status', [ids]);
  for (const r of rows) {
    const c = out.get(r.event_id);
    if (c && REPLIES.includes(r.status)) c[r.status] = r.n;
  }
  return out;
}

// Insert or change the answer of one member.
async function upsertReply({ eventId, guildId, discordId, displayName, status }) {
  return db.tx(async () => {
    const mid = await memberStore.memberId(guildId, discordId, displayName);
    await db.q(
      `insert into event_replies (event_id, member_id, guild_id, status) values ($1, $2, $3, $4)
       on conflict (event_id, member_id) do update set status = excluded.status`,
      [String(eventId), mid, guildId, status]
    );
    return db.one(`${REPLY_SQL} where r.event_id = $1 and r.member_id = $2`, [String(eventId), mid]);
  });
}

// A member's answer, in one transaction that first locks the event row (parallel answers to one event wait for each other):
// the event must still be open (canReply), and a ✅ needs a free seat (capacity null, the member already holds a ✅, or fewer ✅ than capacity).
// -> { ok: true, reply, seatFreed? } | { ok: false, reason: 'closed' | 'full' }
async function setReply({ event, discordId, displayName, status, now = new Date() }) {
  if (!canReply(event, now)) return { ok: false, reason: 'closed' };
  return db.tx(async () => {
    const locked = await db.one(`${EVENT_SQL} where e.id = $1 for update`, [String(event._id)]);
    if (!canReply(locked, now)) return { ok: false, reason: 'closed' };
    if (status === 'yes' && locked.capacity != null) {
      const seat = await db.one(
        `select count(*) filter (where r.status = 'yes') as yes, coalesce(bool_or(m.discord_id = $2 and r.status = 'yes'), false) as mine
         from event_replies r join discord_members m on m.id = r.member_id where r.event_id = $1`,
        [String(event._id), discordId]
      );
      if (!seat.mine && seat.yes >= locked.capacity) return { ok: false, reason: 'full' };
    }
    const reply = await upsertReply({ eventId: event._id, guildId: locked.guildId, discordId, displayName, status });
    return status === 'yes' ? { ok: true, reply } : { ok: true, reply, seatFreed: true };
  });
}

// ---------- scheduler ----------

function findDueLocks(now) {
  return db.q(`${EVENT_SQL} where e.status = 'open' and e.deadline_at <= $1`, [now]);
}

// Open / locked events whose reminder time has come and that have not started yet (a started event is never reminded).
async function findDueReminders(now) {
  const rows = await db.q(`${EVENT_SQL} where e.status in ('open', 'locked') and e.reminded_at is null and e.remind_before_minutes > 0 and e.start_at > $1`, [now]);
  return rows.filter((e) => remindAtOf(e) <= now);
}

async function findFinished(now) {
  const rows = await db.q(`${EVENT_SQL} where e.status in ('open', 'locked') and e.start_at < $1`, [now]);
  return rows.filter((e) => doneAtOf(e) <= now);
}

// Open / locked events past their deadline with a minimum and no notice claimed yet (the caller counts the ✅). The deadline defaults to the
// start, so an event that has just started (up to MIN_NOTICE_GRACE_MS ago) is still due: the notice fires at the deadline, or at the start
// when deadline == start. A long-started event is never judged.
function findDueMinNotices(now) {
  return db.q(
    `${EVENT_SQL} where e.status in ('open', 'locked') and e.min_participants is not null and e.min_notice_at is null and e.deadline_at <= $1 and e.start_at > $2`,
    [now, new Date(now.getTime() - MIN_NOTICE_GRACE_MS)]
  );
}

// true only for the caller that set minNoticeAt (parallel ticks / processes never both notify).
async function claimMinNotice(eventId, now = new Date()) {
  return (await db.q('update guild_events set min_notice_at = $2 where id = $1 and min_notice_at is null returning id', [String(eventId), now])).length === 1;
}

// true only for the caller that set remindedAt (parallel ticks / processes never both remind).
async function claimRemind(eventId, now = new Date()) {
  return (await db.q('update guild_events set reminded_at = $2 where id = $1 and reminded_at is null returning id', [String(eventId), now])).length === 1;
}

// Atomic claim of the manual reminder, same shape as warService.claimManualRemind: -> { claimed, at } (`at` = the reminder that blocked us).
async function claimManualRemind(eventId, now = new Date(), cooldownMs = MANUAL_REMIND_COOLDOWN_MS) {
  const since = new Date(now.getTime() - cooldownMs);
  const rows = await db.q('update guild_events set manual_remind_at = $2 where id = $1 and (manual_remind_at is null or manual_remind_at < $3) returning id', [String(eventId), now, since]);
  if (rows.length === 1) return { claimed: true, at: null };
  const cur = await db.one('select manual_remind_at as at from guild_events where id = $1', [String(eventId)]);
  return { claimed: false, at: (cur && cur.at) || null };
}

async function releaseManualRemind(eventId, at) {
  return res((await db.q('update guild_events set manual_remind_at = null where id = $1 and manual_remind_at = $2 returning id', [String(eventId), at])).length);
}

// ---------- sheet ----------

// The tab's data: events of the last SHEET_DAYS days and the upcoming ones, newest first, each with its answers (first answer first).
// -> { items: [{ event, replies }], any } where `any` = the guild has ever had an event (a guild without any gets no tab at all).
async function listForSheet(guildId, now = new Date()) {
  const events = await db.q(`${EVENT_SQL} where e.guild_id = $1 and e.start_at >= $2 order by e.start_at desc`, [guildId, new Date(now.getTime() - SHEET_DAYS * 24 * HOUR)]);
  if (!events.length) return { items: [], any: Boolean(await db.one('select 1 as x from guild_events where guild_id = $1 limit 1', [guildId])) };
  const replies = await db.q(`${REPLY_SQL} where r.event_id = any($1) order by r.created_at, m.discord_id`, [events.map((e) => e._id)]);
  const byEvent = new Map();
  for (const r of replies) {
    const key = String(r.eventId);
    if (!byEvent.has(key)) byEvent.set(key, []);
    byEvent.get(key).push(r);
  }
  return { items: events.map((event) => ({ event, replies: byEvent.get(String(event._id)) || [] })), any: true };
}

module.exports = {
  TITLE_MAX,
  DESCRIPTION_MAX,
  CAPACITY_MAX,
  MANUAL_REMIND_COOLDOWN_MS,
  MIN_NOTICE_GRACE_MS,
  MAX_USERS_PER_REMIND,
  REPLIES,
  REPLY_LABELS,
  STATUS_LABELS,
  CATEGORIES,
  parseStartField,
  parseTimeField,
  parsePeopleField,
  parseEventForm,
  parseExtendDeadline,
  shortfallOf,
  categoryOf,
  canReply,
  remindAtOf,
  doneAtOf,
  remindTargets,
  buildRemindMessages,
  eventChannelOf,
  eventAdminChannelOf,
  messageLink,
  getEvent,
  createEvent,
  deleteEvent,
  setMessage,
  clearMessage,
  listManage,
  lockEvent,
  cancelEvent,
  markDone,
  reopenEvent,
  extendEvent,
  updateEvent,
  listReplies,
  countsOf,
  countsFor,
  upsertReply,
  setReply,
  findDueLocks,
  findDueReminders,
  findDueMinNotices,
  claimMinNotice,
  findFinished,
  claimRemind,
  claimManualRemind,
  releaseManualRemind,
  listForSheet,
};
