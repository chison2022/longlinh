const db = require('../db');
const memberStore = require('./members');
const { plainClass } = require('./lineupStyle');

const UNKNOWN_CLASS = 'Chưa rõ';

// ---------- pure ----------

// Role/class label -> comparison key: NFKC (fullwidth / math-bold forms fold to plain letters, NFD recomposes), leftover
// combining marks (emoji variation selector, keycap) removed, anything that is not a letter/digit/space (emoji,
// punctuation) turned into a space, spaces collapsed, lower-cased. A keycap emoji ("1️⃣ Huyết Hà" -> "huyết hà") is dropped
// as decoration, but a plain number is part of the name ("1 Kiếm" != "2 Kiếm"). Vietnamese diacritics stay significant ("Tố Vấn" != "To Van"): they are precomposed letters after NFKC.
function normalizeName(s) {
  return String(s)
    .normalize('NFKC')
    .replace(/[0-9#*]️?⃣/gu, ' ') // keycap emoji (digit + optional VS16 + U+20E3): decoration, "1️⃣Huyết" -> "Huyết"
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Class identity = the plain name, so an old stored "🛡️ Thiết Y" is the same class as the configured "Thiết Y".
const classId = (name) => normalizeName(plainClass(name));
const sameClass = (a, b) => classId(a) === classId(b);

// The configured label of a class (what to store / show), or the name unchanged when no configured class matches.
function canonicalClass(name, classes = []) {
  const id = classId(name);
  return classes.find((c) => classId(c) === id) || name;
}

// name -> one label per class identity: the configured label, else the first spelling seen.
function makeCanon(classes = []) {
  const labels = new Map();
  for (const c of classes) if (!labels.has(classId(c))) labels.set(classId(c), c);
  return (name) => {
    const id = classId(name);
    if (!labels.has(id)) labels.set(id, name);
    return labels.get(id);
  };
}

// Config classes first (in order), then any other class seen in regs (spellings of one class merge).
function orderedClasses(regs, classes) {
  const canon = makeCanon(classes);
  const seen = new Set(classes.map(classId));
  const extra = [];
  for (const r of regs) {
    const k = r.className ? canon(r.className) : UNKNOWN_CLASS;
    if (!seen.has(classId(k))) {
      seen.add(classId(k));
      extra.push(k);
    }
  }
  return [...classes, ...extra];
}

// Counts per status plus per-class join/reserve counts (classes with 0 are skipped).
function summarize(regs, classes = []) {
  const totals = { join: 0, reserve: 0, absent: 0 };
  const per = new Map();
  const canon = makeCanon(classes);
  for (const r of regs) {
    totals[r.status] = (totals[r.status] || 0) + 1;
    if (r.status === 'absent') continue;
    const k = r.className ? canon(r.className) : UNKNOWN_CLASS;
    const c = per.get(k) || { join: 0, reserve: 0 };
    c[r.status] += 1;
    per.set(k, c);
  }
  const byClass = orderedClasses(regs, classes)
    .filter((k) => per.has(k))
    .map((k) => ({ className: k, ...per.get(k) }));
  return { ...totals, byClass };
}

// Names grouped by class for the "Xem danh sách" view.
function groupNamesByClass(regs, classes = []) {
  const groups = new Map();
  const canon = makeCanon(classes);
  for (const r of regs) {
    if (r.status === 'absent') continue;
    const k = r.className ? canon(r.className) : UNKNOWN_CLASS;
    if (!groups.has(k)) groups.set(k, { className: k, join: [], reserve: [] });
    groups.get(k)[r.status].push(r.displayName || r.discordId);
  }
  return orderedClasses(regs, classes)
    .filter((k) => groups.has(k))
    .map((k) => groups.get(k));
}

// The configured class whose name equals one of the member's role names; null when none or more than one class matches.
function classFromRoles(roleNames, classes) {
  const roles = new Set(roleNames.map(normalizeName));
  const hits = classes.filter((c) => {
    const key = classId(c);
    return key && roles.has(key);
  });
  return hits.length === 1 ? hits[0] : null;
}

// ---------- db ----------

// A registration as the bot reads it: eventId / discordId / displayName / className / status (+ timestamps).
const REG_SQL = `select r.war_id as "eventId", r.guild_id as "guildId", m.discord_id as "discordId", m.display_name as "displayName",
  r.class_name as "className", r.status, r.created_at as "createdAt", r.updated_at as "updatedAt"
  from registrations r join discord_members m on m.id = r.member_id`;

function listRegistrations(eventId) {
  if (!db.isId(String(eventId))) return Promise.resolve([]);
  return db.q(`${REG_SQL} where r.war_id = $1 order by r.created_at, m.discord_id`, [String(eventId)]);
}

// Removes the "join" registrations of these people for one war (a manager's "Gỡ báo danh"); an absent answer stays. -> the Discord ids removed
async function removeRegistrations(eventId, discordIds) {
  if (!db.isId(String(eventId)) || !(discordIds || []).length) return [];
  const rows = await db.q(
    `delete from registrations r using discord_members m where r.member_id = m.id and r.war_id = $1 and m.discord_id = any($2) and r.status <> 'absent' returning m.discord_id`,
    [String(eventId), [...discordIds]]
  );
  return rows.map((r) => r.discord_id);
}

function getRegistration(eventId, discordId) {
  if (!db.isId(String(eventId))) return Promise.resolve(null);
  return db.one(`${REG_SQL} where r.war_id = $1 and m.discord_id = $2`, [String(eventId), discordId]);
}

// onlyIfOpen: the war row is locked and must still be open and before its deadline, else nothing is written and the result is null
// (a lock / publish committing at the same moment wins over the click).
async function upsertRegistration({ eventId, guildId, discordId, displayName, status, className, onlyIfOpen = false }) {
  return db.tx(async () => {
    if (onlyIfOpen) {
      const war = await db.one('select status, deadline_at from war_events where id = $1 for update', [String(eventId)]);
      if (!war || war.status !== 'open' || new Date() > new Date(war.deadline_at)) return null;
    }
    const mid = await memberStore.memberId(guildId, discordId, displayName);
    await db.q(
      `insert into registrations (war_id, member_id, guild_id, status, class_name) values ($1, $2, $3, $4, $5)
       on conflict (war_id, member_id) do update set status = excluded.status, class_name = excluded.class_name`,
      [String(eventId), mid, guildId, status, className ?? null]
    );
    return db.one(`${REG_SQL} where r.war_id = $1 and r.member_id = $2`, [String(eventId), mid]);
  });
}

async function updateRegistrationClass(eventId, discordId, className, displayName) {
  return db.tx(async () => {
    const row = await db.one(
      `update registrations r set class_name = $3 from discord_members m
       where r.member_id = m.id and r.war_id = $1 and m.discord_id = $2 returning r.member_id, r.guild_id`,
      [String(eventId), discordId, className ?? null]
    );
    if (row && displayName !== undefined) await db.q('update discord_members set display_name = $2 where id = $1', [row.member_id, String(displayName)]);
    return { matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0 };
  });
}

// The member changed their server name: names live on the member row only, so one write covers every list.
async function syncMemberName(guildId, discordId, displayName) {
  await db.q('update discord_members set display_name = $3 where guild_id = $1 and discord_id = $2', [guildId, discordId, String(displayName)]);
}

function getMember(guildId, discordId) {
  return memberStore.getMember(guildId, discordId);
}

function saveMemberClass(guildId, discordId, displayName, className) {
  return memberStore.saveMember(guildId, discordId, { displayName, className });
}

// The member's wanted party mission ('def' | 'cong' | 'daytru' | 'vattu' | 'any'), remembered for every war.
function saveMemberMission(guildId, discordId, displayName, missionPref) {
  return memberStore.saveMember(guildId, discordId, { displayName, missionPref });
}

module.exports = {
  UNKNOWN_CLASS,
  classId,
  sameClass,
  canonicalClass,
  makeCanon,
  normalizeName,
  orderedClasses,
  classFromRoles,
  summarize,
  groupNamesByClass,
  listRegistrations,
  removeRegistrations,
  getRegistration,
  upsertRegistration,
  updateRegistrationClass,
  getMember,
  syncMemberName,
  saveMemberClass,
  saveMemberMission,
};
