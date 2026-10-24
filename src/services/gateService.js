// The new-member gate: requests (GateRequest) and the texts. No Discord client here.
// Statuses move only away from 'pending', and only through an atomic findOneAndUpdate on { _id, status: 'pending' },
// so two managers pressing ✅ at once cannot both win.
const db = require('../db');
const memberStore = require('./members');
const { nameKey } = require('./gameRosterService');
const { formatDayTime } = require('../utils/time');

const MAX_WELCOME_MEMBER = 4000;
const MAX_GUILD_NAME = 60;
const YOUNG_ACCOUNT_DAYS = 7;
const MAX_REASON = 500;
const COOLDOWN_MS = 12 * 3600 * 1000; // after a rejected / cancelled request
const REQUESTS_PER_HOUR = 3;
const CARD_FAILED_REASON = 'không gửi được thẻ tới quản lý'; // the member's fault it was not: no cooldown

// ---------- texts ----------

const guildNameOf = (config, guild) => (config && config.gateGuildName) || (guild && guild.name) || 'bang';
const link = (id) => `<#${id}>`;

// " (T7 20:00)" from the guild's war schedule; '' when it is missing.
function warWhen(config) {
  const s = config && config.schedule;
  return s && Number.isInteger(s.warDay) && s.warTime ? ` (${formatDayTime(s.warDay, s.warTime)})` : '';
}

// The built-in text for a newly approved member; mentions only the channels that are configured.
function defaultWelcomeMember(config, guild) {
  const lines = [`🎉 Chào mừng bạn đã vào **${guildNameOf(config, guild)}**! Mọi kênh của bang đã mở cho bạn.`, '', 'Vài việc nên làm ngay:'];
  if (config.announceChannelId) lines.push(`• ⚔️ Đăng ký bang chiến${warWhen(config)} ở ${link(config.announceChannelId)}: bấm Tham gia hoặc Vắng.`);
  if (config.gnChannelId) lines.push(`• 🎮 Liên kết tên nhân vật trong game ở ${link(config.gnChannelId)} để quản lý xếp đội đúng người.`);
  if (config.mailChannelId) lines.push(`• 📮 Có góp ý, thắc mắc thì gửi vào hòm thư ở ${link(config.mailChannelId)} (có thể ẩn danh).`);
  if (config.eventChannelId) lines.push(`• 🎉 Sự kiện của bang được đăng ở ${link(config.eventChannelId)}, nhớ bấm trả lời.`);
  lines.push('', 'Cần gì cứ nhờ quản lý. Chơi vui nhé!');
  return lines.join('\n');
}

const welcomeMemberText = (config, guild) => (config.gateWelcomeMember && config.gateWelcomeMember.trim()) || defaultWelcomeMember(config, guild);

// Text -> messages of at most `max` characters (a DM holds 2000), cut at line ends where possible.
function chunkText(text, max = 2000) {
  const out = [];
  let rest = String(text);
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) out.push(rest);
  return out;
}

// The channel approval cards go to.
const gateAdminChannelOf = (config) => (config && (config.gateAdminChannelId || config.adminChannelId)) || null;

// ---------- requests ----------

// A join request as the bot reads it: the old document shape (_id, discordId, displayName from the member row, camelCase fields).
const REQUEST_SQL = `select g.id as "_id", g.guild_id as "guildId", m.discord_id as "discordId", m.display_name as "displayName",
  g.game_name as "gameName", g.game_name_free as "gameNameFree", g.class_name as "className", g.status, g.decided_by as "decidedBy",
  g.decided_at as "decidedAt", g.reason, g.admin_channel_id as "adminChannelId", g.admin_message_id as "adminMessageId",
  g.created_at as "createdAt", g.updated_at as "updatedAt"
  from gate_requests g join discord_members m on m.id = g.member_id`;
const res = (n) => ({ matchedCount: n, modifiedCount: n, acknowledged: true });

// The member's pending request, or null.
function findPending(guildId, discordId) {
  return db.one(`${REQUEST_SQL} where g.guild_id = $1 and m.discord_id = $2 and g.status = 'pending'`, [guildId, discordId]);
}

// Scoped to the guild: a card id from another guild's channel finds nothing.
function getRequest(id, guildId) {
  return db.isId(String(id)) && guildId ? db.one(`${REQUEST_SQL} where g.id = $1 and g.guild_id = $2`, [String(id), String(guildId)]) : Promise.resolve(null);
}

// Writes `set` (column -> value) on the request `id` while `cond` holds -> the updated request or null.
async function updateWhere(id, cond, condParams, set) {
  const params = [String(id), ...condParams];
  const sets = Object.entries(set).map(([col, v]) => {
    params.push(v);
    return `${col} = $${params.length}`;
  });
  const row = await db.one(`update gate_requests set ${sets.join(', ')} where id = $1 and ${cond} returning id`, params);
  return row ? db.one(`${REQUEST_SQL} where g.id = $1`, [row.id]) : null;
}
const decision = (status, { by, reason, at }) => ({ status, decided_by: by, decided_at: at, reason: String(reason || '').slice(0, MAX_REASON) });

// The member's latest request that ended badly (rejected / cancelled; old 'guest' ones too) within the cooldown, or null. One findOne on decidedAt.
function recentDecision(guildId, discordId, { now = Date.now(), cooldownMs = COOLDOWN_MS } = {}) {
  return db.one(
    `${REQUEST_SQL} where g.guild_id = $1 and m.discord_id = $2 and g.status in ('rejected', 'cancelled', 'guest', 'revoked')
     and g.reason <> $3 and g.decided_at >= $4 order by g.decided_at desc limit 1`,
    [guildId, discordId, CARD_FAILED_REASON, new Date(now - cooldownMs)]
  );
}

// In-memory flood limit: at most REQUESTS_PER_HOUR new requests per member per rolling hour (a restart forgets it, which is fine).
const recentRequests = new Map(); // "guild:user" -> [timestamps]
function liveRequests(key, now) {
  const list = (recentRequests.get(key) || []).filter((t) => t > now - 3600 * 1000);
  if (list.length) recentRequests.set(key, list);
  else recentRequests.delete(key);
  return list;
}
// -> null when allowed, else the time (ms) the member may try again.
function requestBlockedUntil(guildId, discordId, now = Date.now()) {
  const list = liveRequests(`${guildId}:${discordId}`, now);
  return list.length >= REQUESTS_PER_HOUR ? list[0] + 3600 * 1000 : null;
}
function noteRequest(guildId, discordId, now = Date.now()) {
  const key = `${guildId}:${discordId}`;
  recentRequests.set(key, [...liveRequests(key, now), now]);
}
const resetRequestLimits = () => recentRequests.clear();

// Saves a pending request; a name picked from the roster points at its character. -> { request, created: true } or, when the member
// already has one pending, { request: <that one>, created: false }.
async function createPending(data) {
  try {
    const id = db.newId();
    await db.tx(async () => {
      const mid = await memberStore.memberId(data.guildId, data.discordId, data.displayName);
      const ch = data.gameNameFree
        ? null
        : await db.one('select id from game_characters where guild_id = $1 and name_key = $2 and left_at is null', [data.guildId, nameKey(data.gameName) || `#${data.gameName}`]);
      await db.q(
        `insert into gate_requests (id, guild_id, member_id, character_id, game_name, game_name_free, class_name, status) values ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
        [id, data.guildId, mid, ch ? ch.id : null, data.gameName, !!data.gameNameFree, data.className || '']
      );
    });
    return { request: await db.one(`${REQUEST_SQL} where g.id = $1`, [id]), created: true };
  } catch (err) {
    if (!db.isUniqueViolation(err)) throw err;
    const existing = await findPending(data.guildId, data.discordId);
    if (!existing) throw err; // decided in between: the caller may try again
    return { request: existing, created: false };
  }
}

// pending -> `status`, atomically. -> the updated request, or null when it was not pending any more (somebody else won).
function decide(id, status, { by = null, reason = '', at = new Date() } = {}) {
  if (!db.isId(String(id))) return Promise.resolve(null);
  return updateWhere(id, `status = 'pending'`, [], decision(status, { by, reason, at }));
}

// Undo a decide() whose follow-up failed (a role could not be changed): back to pending so a retry works.
// -> the request, or null when the member already has another pending one (then it stays as decided: 'cancelled').
async function reopen(id, from) {
  try {
    return await updateWhere(id, 'status = $2', [from], { status: 'pending', decided_by: null, decided_at: null, reason: '' });
  } catch (err) {
    if (!db.isUniqueViolation(err)) throw err;
    await updateWhere(id, 'status = $2', [from], { status: 'cancelled', reason: 'yêu cầu mới thay thế' });
    return null;
  }
}

// The member's pending request -> `status` (the member left). -> the request or null.
async function decidePendingOf(guildId, discordId, status, { by = null, reason = '', at = new Date() } = {}) {
  const pending = await findPending(guildId, discordId);
  return pending ? decide(pending._id, status, { by, reason, at }) : null;
}

// approved -> revoked, atomically (two managers pressing ↩️ at once: one wins). -> the request, or null when it is not approved any more.
function revoke(id, { by = null, reason = '', at = new Date() } = {}) {
  if (!db.isId(String(id))) return Promise.resolve(null);
  return updateWhere(id, `status = 'approved'`, [], decision('revoked', { by, reason, at }));
}

async function setCard(id, channelId, messageId) {
  return res((await db.q('update gate_requests set admin_channel_id = $2, admin_message_id = $3 where id = $1 returning id', [String(id), channelId, messageId])).length);
}

module.exports = {
  MAX_WELCOME_MEMBER,
  MAX_GUILD_NAME,
  MAX_REASON,
  COOLDOWN_MS,
  REQUESTS_PER_HOUR,
  CARD_FAILED_REASON,
  YOUNG_ACCOUNT_DAYS,
  guildNameOf,
  defaultWelcomeMember,
  welcomeMemberText,
  chunkText,
  gateAdminChannelOf,
  findPending,
  getRequest,
  recentDecision,
  requestBlockedUntil,
  noteRequest,
  resetRequestLimits,
  createPending,
  decide,
  revoke,
  reopen,
  decidePendingOf,
  setCard,
};
