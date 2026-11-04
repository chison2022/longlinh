// Everything the lineup board stores, in the Activity's OWN database (src/sideDb.js, schema in activity/schema.sql): the snapshot taken at
// registration lock (guild, war, joiners) and what the board edits (lineup, tasks, manual members). Used by the Activity server and by the
// bot (publisher, "Xem PT của tôi"); the main database is never touched here. Saves use optimistic concurrency (version); the publish request
// is picked up by the bot (laptop), which posts the image and calls markPublished / markPublishError.
const crypto = require('node:crypto');
const db = require('../sideDb');
const defaults = require('../../config/defaults');
const rules = require('./lineupRules');
const { ROLE_PREFS } = require('./missions');

const LINEUP_COLS = `war_id as "warId", guild_id as "guildId", layout, version, updated_by as "updatedBy", updated_at as "updatedAt",
  publish_requested_at as "publishRequestedAt", publish_requested_by as "publishRequestedBy", published_version as "publishedVersion",
  published_at as "publishedAt", publish_error as "publishError", published_layout as "publishedLayout", claimed_at as "claimedAt",
  tasks, party_notes as "partyNotes", sent_for as "sentFor", sent_snapshot as "sentSnapshot"`;
const LINEUP_SQL = `select ${LINEUP_COLS} from act_lineups`;
const CLAIM_MS_SQL = "interval '2 minutes'"; // a claim older than this is dead (the bot died while posting)

// The lineup row of a war, or null when nobody has saved one yet.
function getLineup(warId) {
  if (!db.isId(String(warId))) return Promise.resolve(null);
  return db.one(`${LINEUP_SQL} where war_id = $1`, [String(warId)]);
}

// ---------- custom tasks (table act_tasks): per guild, kept across wars ----------

const slugOf = (s) =>
  String(s)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);

// [{ key, label, emoji, builtin }]: the four built-in tasks, then the guild's own in the order they were added.
async function listTasks(guildId) {
  const custom = await db.q('select key, label, emoji from act_tasks where guild_id = $1 order by position, created_at, key', [guildId]);
  return [...rules.BUILTIN_TASKS, ...custom.map((t) => ({ key: t.key, label: t.label, emoji: t.emoji, builtin: false }))];
}

// A custom task's fields from user input -> { label, emoji } | { error }.
function taskFields({ label, emoji }) {
  const text = rules.cleanText(label, rules.TASK_LABEL_MAX);
  if (!text) return { error: 'Tên nhiệm vụ không được để trống.' };
  const e = String(emoji == null ? '' : emoji).trim();
  if (e && !/^[^\p{L}\p{N}\s]{1,12}$/u.test(e)) return { error: 'Biểu tượng chỉ nhận emoji.' };
  return { label: text, emoji: e };
}

async function addTask(guildId, fields) {
  const f = taskFields(fields || {});
  if (f.error) return f;
  const tasks = await listTasks(guildId);
  const custom = tasks.filter((t) => !t.builtin);
  if (custom.length >= rules.MAX_CUSTOM_TASKS) return { error: `Tối đa ${rules.MAX_CUSTOM_TASKS} nhiệm vụ tự thêm.` };
  if (tasks.some((t) => t.label.toLowerCase() === f.label.toLowerCase())) return { error: 'Đã có nhiệm vụ trùng tên.' };
  const base = slugOf(f.label) || 'nv';
  let key = `c:${base}`;
  for (let i = 2; tasks.some((t) => t.key === key); i++) key = `c:${base.slice(0, 26)}-${i}`;
  await db.q('insert into act_tasks (guild_id, key, label, emoji, position) values ($1, $2, $3, $4, $5)', [guildId, key, f.label, f.emoji, custom.length]);
  return { ok: true, tasks: await listTasks(guildId) };
}

async function renameTask(guildId, key, fields) {
  const f = taskFields(fields || {});
  if (f.error) return f;
  const tasks = await listTasks(guildId);
  if (tasks.some((t) => t.key !== key && t.label.toLowerCase() === f.label.toLowerCase())) return { error: 'Đã có nhiệm vụ trùng tên.' };
  const rows = await db.q('update act_tasks set label = $3, emoji = $4 where guild_id = $1 and key = $2 returning key', [guildId, key, f.label, f.emoji]);
  if (!rows.length) return { error: 'Nhiệm vụ không tồn tại.' };
  return { ok: true, tasks: await listTasks(guildId) };
}

// Deletes a custom task; everyone who had it in an unpublished lineup of the guild falls back to "Chưa giao" (those lineups' version
// moves, so open boards reload). -> { ok, tasks, affected } | { error }
async function deleteTask(guildId, key) {
  return db.tx(async () => {
    const rows = await db.q('delete from act_tasks where guild_id = $1 and key = $2 returning key', [guildId, key]);
    if (!rows.length) return { error: 'Nhiệm vụ không tồn tại.' };
    const hit = await db.q(
      `update act_lineups set version = version + 1, updated_at = now(),
         tasks = (select coalesce(jsonb_object_agg(e.key, case when e.value = to_jsonb($2::text) then '""'::jsonb else e.value end), '{}'::jsonb) from jsonb_each(tasks) e)
       where guild_id = $1 and exists (select 1 from jsonb_each_text(tasks) e where e.value = $2) returning war_id`,
      [guildId, key]
    );
    return { ok: true, tasks: await listTasks(guildId), affected: hit.length };
  });
}

// ---------- the snapshot: guild, war, joiners ----------

const GUILD_COLS = `guild_id as "guildId", admin_role_ids as "adminRoleIds", manager_role_ids as "managerRoleIds", owner_id as "ownerId", classes, rules, shape`;

// The guild as the bot snapshotted it, or null.
function getGuild(guildId) {
  return db.one(`select ${GUILD_COLS} from act_guilds where guild_id = $1`, [String(guildId)]);
}

const shapeOfGuild = (guild) => {
  const sh = (guild && guild.shape) || {};
  return { groupCount: sh.groupCount || defaults.groupCount, partiesPerGroup: sh.partiesPerGroup || defaults.partiesPerGroup, partySize: sh.partySize || defaults.partySize };
};
const rulesOfGuild = (guild) => ({ healerClass: (guild && guild.rules && guild.rules.healerClass) || defaults.healerClass, tankClass: (guild && guild.rules && guild.rules.tankClass) || defaults.tankClass });

const WAR_COLS = `war_id as "warId", guild_id as "guildId", title, start_at as "startAt", status, locked_at as "lockedAt", snapshot_at as "snapshotAt", link_groups as "linkGroups"`;

function getWar(warId) {
  if (!db.isId(String(warId))) return Promise.resolve(null);
  return db.one(`select ${WAR_COLS} from act_wars where war_id = $1`, [String(warId)]);
}

// The wars of a guild the board can open (not finished), newest first.
function listWars(guildId) {
  return db.q(`select ${WAR_COLS} from act_wars where guild_id = $1 and status <> 'done' order by start_at desc limit 10`, [String(guildId)]);
}

const MEMBER_COLS = `member_key as id, discord_id as "discordId", name, discord_name as "discordName", linked, class_name as "className", role_pref as "rolePref", created_at as "createdAt", manual, removed`;

// THE joiner list of a war as the board sees it: the people who count (removed = false) in sign-up order, or the removed ones.
// [{ id (member key), discordId, name (in-game name when linked, else Discord name), discordName, linked, className, rolePref, createdAt, manual }]
function listMembers(warId, { removed = false } = {}) {
  if (!db.isId(String(warId))) return Promise.resolve([]);
  return db.q(`select ${MEMBER_COLS} from act_members where war_id = $1 and removed = $2 order by created_at, member_key`, [String(warId), removed]);
}

// An empty lineup row (version 0) when the war has none yet.
async function ensureLineup(war) {
  const guild = await getGuild(war.guildId);
  await db.q('insert into act_lineups (war_id, guild_id, layout, version) values ($1, $2, $3, 0) on conflict (war_id) do nothing', [war.warId, war.guildId, JSON.stringify(rules.emptyLayout(shapeOfGuild(guild)))]);
}

// Runs `fn(row)` in ONE transaction that holds the lineup row of the war (select ... for update): a member change and its effect on the
// lineup are all-or-nothing and a concurrent save cannot be overwritten. fn -> { layout?, tasks?, value? }; the version moves (open boards
// reload). -> the value.
function withLineup(war, userId, fn) {
  return db.tx(async () => {
    await ensureLineup(war);
    const row = await db.one(`select ${LINEUP_COLS} from act_lineups where war_id = $1 for update`, [war.warId]);
    const next = (await fn(row)) || {};
    if (next.abort) return next.value; // nothing changed: no version move
    await db.q('update act_lineups set version = version + 1, updated_by = $2, updated_at = now(), layout = coalesce($3::jsonb, layout), tasks = coalesce($4::jsonb, tasks) where war_id = $1', [
      war.warId,
      userId || null,
      next.layout ? JSON.stringify(next.layout) : null,
      next.tasks ? JSON.stringify(next.tasks) : null,
    ]);
    return next.value;
  });
}

const MAX_MANUAL = 30;

// A manager adds a person by hand (not in the registrations). -> { ok, member } | { error }
async function addManualMember({ warId, guildId, userId, name, className, rolePref = 'any', task }) {
  const war = await getWar(warId);
  if (!war || war.guildId !== guildId) return { error: 'Bang chiến không tồn tại.' };
  if (war.status === 'done') return { error: 'Bang chiến đã kết thúc.' };
  const label = rules.cleanText(name, 40);
  if (!label) return { error: 'Tên không được để trống.' };
  const guild = await getGuild(guildId);
  const cls = ((guild && guild.classes) || []).find((c) => rules.sameClass(c.name, className));
  if (!cls) return { error: 'Phái không hợp lệ.' };
  const pref = ROLE_PREFS.includes(rolePref) ? rolePref : 'any';
  let taskKey;
  if (task !== undefined && task !== null) {
    const keys = new Set((await listTasks(guildId)).map((t) => t.key));
    if (task !== '' && !keys.has(task)) return { error: 'Nhiệm vụ không tồn tại.' };
    taskKey = task;
  }
  const key = `m:${crypto.randomBytes(5).toString('hex')}`;
  return withLineup(war, userId, async (row) => {
    const manual = (await db.one('select count(*)::int as n from act_members where war_id = $1 and manual', [warId])).n;
    if (manual >= MAX_MANUAL) return { abort: true, value: { error: `Tối đa ${MAX_MANUAL} người thêm tay.` } };
    await db.q(
      "insert into act_members (war_id, member_key, discord_id, name, discord_name, linked, class_name, role_pref, manual) values ($1, $2, null, $3, '', false, $4, $5, true)",
      [warId, key, label, cls.name, pref]
    );
    return { tasks: taskKey === undefined ? undefined : { ...(row.tasks || {}), [key]: taskKey }, value: { ok: true, member: (await listMembers(warId)).find((m) => m.id === key) } };
  });
}

// A manager takes a person off the list: a hand-added person is dropped, a registered one is marked removed (it stays removed on a re-lock).
// They leave the layout and lose their task. -> { ok } | { error }
async function removeMember({ warId, guildId, userId, key }) {
  const war = await getWar(warId);
  if (!war || war.guildId !== guildId) return { error: 'Bang chiến không tồn tại.' };
  return withLineup(war, userId, async (row) => {
    const m = await db.one('select manual, removed from act_members where war_id = $1 and member_key = $2', [warId, String(key)]);
    if (!m || m.removed) return { abort: true, value: { error: 'Không có người này trong danh sách.' } };
    if (m.manual) await db.q('delete from act_members where war_id = $1 and member_key = $2', [warId, key]);
    else await db.q('update act_members set removed = true, removed_by = $3 where war_id = $1 and member_key = $2', [warId, key, userId || 'manager']);
    const tasks = { ...(row.tasks || {}) };
    delete tasks[key];
    return { layout: rules.filterLayout(row.layout, (id) => id !== key), tasks, value: { ok: true } };
  });
}

// Puts a removed (registered) person back on the list. -> { ok } | { error }
async function restoreMember({ warId, guildId, userId, key }) {
  const war = await getWar(warId);
  if (!war || war.guildId !== guildId) return { error: 'Bang chiến không tồn tại.' };
  return withLineup(war, userId, async () => {
    const rows = await db.q('update act_members set removed = false, removed_by = null where war_id = $1 and member_key = $2 and removed and not manual returning member_key', [warId, String(key)]);
    if (!rows.length) return { abort: true, value: { error: 'Không có người này trong danh sách đã bỏ.' } };
    return { value: { ok: true } };
  });
}

// -> { ok: true, lineup } | { conflict: true, current } | { error }.
// layout is validated (shape, party size, no duplicates); keys that are not on the war's list (or were removed) are dropped.
async function saveLineup({ warId, guildId, layout, expectedVersion, userId, tasks, partyNotes }) {
  const war = await getWar(warId);
  if (!war || war.guildId !== guildId) return { error: 'Bang chiến không tồn tại.' };
  if (war.status === 'done') return { error: 'Bang chiến đã kết thúc.' };
  const shape = shapeOfGuild(await getGuild(guildId));
  const checked = rules.validateLayout(layout, shape);
  if (!checked.ok) return { error: checked.error };
  const joined = new Set((await listMembers(warId)).map((j) => j.id));
  const clean = rules.filterLayout(checked.layout, (id) => joined.has(id));
  // tasks / notes: left alone when the caller sends none; unknown task keys are refused, mentions are stripped
  let taskJson = null;
  let noteJson = null;
  if (tasks !== undefined) {
    const validKeys = new Set((await listTasks(guildId)).map((t) => t.key));
    const t = rules.validateTasks(tasks, [...joined], validKeys);
    if (!t.ok) return { error: t.error };
    taskJson = JSON.stringify(t.tasks);
  }
  if (partyNotes !== undefined) {
    const n = rules.validateNotes(partyNotes, shape);
    if (!n.ok) return { error: n.error };
    noteJson = JSON.stringify(n.notes);
  }
  const expected = Number.isInteger(expectedVersion) && expectedVersion >= 0 ? expectedVersion : -1;
  const json = JSON.stringify(clean);
  let row = null;
  if (expected === 0) {
    // the first save creates the row; the primary key makes a second first-saver lose
    row = await db.one(
      "insert into act_lineups (war_id, guild_id, layout, version, updated_by, tasks, party_notes) values ($1, $2, $3, 1, $4, coalesce($5::jsonb, '{}'), coalesce($6::jsonb, '{}')) on conflict (war_id) do nothing returning version",
      [String(warId), guildId, json, userId || null, taskJson, noteJson]
    );
  }
  if (!row && expected >= 0) {
    row = await db.one(
      'update act_lineups set layout = $2, version = version + 1, updated_by = $3, updated_at = now(), tasks = coalesce($5::jsonb, tasks), party_notes = coalesce($6::jsonb, party_notes) where war_id = $1 and version = $4 returning version',
      [String(warId), json, userId || null, expected, taskJson, noteJson]
    );
  }
  if (!row) return { conflict: true, current: await getLineup(warId) };
  return { ok: true, lineup: await getLineup(warId) };
}

// Asks the bot to post the lineup. A fresh request clears an earlier error. -> the row, or null when the war is not this guild's / done.
async function requestPublish(warId, userId, guildId = null) {
  const war = await getWar(warId);
  if (!war || war.status === 'done' || (guildId && war.guildId !== guildId)) return null;
  await ensureLineup(war);
  await db.q(
    `update act_lineups set publish_requested_at = date_trunc('milliseconds', now()), publish_requested_by = $2, publish_error = null where war_id = $1`,
    [String(warId), userId || null]
  );
  return getLineup(warId);
}

// Atomically takes the publishes asked for and not done yet (an errored one waits for a new request), so two processes never both
// post one; a claim older than 2 minutes is taken over. Oldest request first. Give the claim back with markPublished / markPublishError.
async function claimPendingPublishes() {
  const rows = await db.q(
    `update act_lineups set claimed_at = now()
      where publish_requested_at is not null and publish_error is null
        and (published_at is null or publish_requested_at > published_at)
        and (claimed_at is null or claimed_at < now() - ${CLAIM_MS_SQL})
      returning ${LINEUP_COLS}`
  );
  return rows.sort((a, b) => new Date(a.publishRequestedAt) - new Date(b.publishRequestedAt));
}

// The post is out; `layout` = exactly what was rendered (kept for "Xem PT của tôi"). `requestedAt` = the request that was served: when a
// newer request arrived meanwhile it stays pending and its error / state are left alone. `warning` = a side step that failed (the
// sheet): kept as publish_error without re-posting. -> true when the row was updated.
async function markPublished(warId, version, requestedAt = null, warning = null, layout = null) {
  const rows = await db.q(
    `update act_lineups set published_version = $2, published_layout = coalesce($5::jsonb, published_layout), claimed_at = null,
       publish_error = case when $3::timestamptz is null or publish_requested_at = $3::timestamptz then $4 else publish_error end,
       published_at = case when $3::timestamptz is null or publish_requested_at = $3::timestamptz then date_trunc('milliseconds', now()) else $3::timestamptz end
     where war_id = $1 returning war_id`,
    [String(warId), version, requestedAt, warning ? String(warning).slice(0, 500) : null, layout ? JSON.stringify(layout) : null]
  );
  return rows.length === 1;
}

// The post of a request went out: remembered right away (with what was posted) so a restart finishes the bookkeeping instead of posting again.
async function markSent(warId, requestedAt, snapshot) {
  const rows = await db.q('update act_lineups set sent_for = $2, sent_at = now(), sent_snapshot = $3::jsonb where war_id = $1 returning war_id', [String(warId), requestedAt, JSON.stringify(snapshot)]);
  return rows.length === 1;
}

// The war's status as the board shows it ('open' again = registration was reopened: no publishing until it is locked again).
async function setWarStatus(warId, status) {
  const rows = await db.q('update act_wars set status = $2 where war_id = $1 returning war_id', [String(warId), status]);
  return rows.length === 1;
}

// The post failed: shown in the Activity, not retried until the admin presses publish again. Only for the request being served: a newer
// request keeps waiting (the claim is released either way).
async function markPublishError(warId, message, requestedAt = null) {
  const rows = await db.q(
    `update act_lineups set claimed_at = null,
       publish_error = case when $3::timestamptz is null or publish_requested_at = $3::timestamptz then $2 else publish_error end
     where war_id = $1 returning war_id`,
    [String(warId), String(message || 'Lỗi không rõ').slice(0, 500), requestedAt]
  );
  return rows.length === 1;
}

module.exports = {
  markSent,
  setWarStatus,
  getGuild,
  shapeOfGuild,
  rulesOfGuild,
  getWar,
  listWars,
  listMembers,
  addManualMember,
  removeMember,
  restoreMember,
  listTasks,
  addTask,
  renameTask,
  deleteTask,
  getLineup,
  saveLineup,
  requestPublish,
  claimPendingPublishes,
  markPublished,
  markPublishError,
  partyWarnings: rules.partyWarnings,
  reshapeLayout: rules.reshapeLayout,
  emptyLayout: rules.emptyLayout,
};
