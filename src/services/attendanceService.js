// Real attendance of a war: the in-game result screen (transcribed to a text file of game names) stored per war and compared with
// the registrations. parse / compare / buildHistory are pure; resolve, saveAttendance and history use the DB.
const db = require('../db');
const memberStore = require('./members');
const gameRoster = require('./gameRosterService');
const warService = require('./warService');
const { fromLocal, DAY } = require('../utils/time');

const DEFAULT_LIMIT = 12;
const { nameKey, fold } = gameRoster;

// ---------- parse ----------

// Plain integers / decimals and "1.234" / "1,234,567" (thousand groups) become numbers; anything else stays text.
function statValue(raw) {
  const v = String(raw).trim();
  if (/^[1-9]\d{0,2}([.,]\d{3})+$/.test(v)) return Number(v.replace(/[.,]/g, '')); // before decimals: "1.234" is a thousand
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

// Lines `Tên|key=value|key=value…` or just `Tên`; blank lines and `#` comments are skipped, names are trimmed with inner spaces
// collapsed, a name seen twice (same nameKey) is kept once (the first line). -> [{ name, stats }] ({} without numbers). A broken
// line throws with its number, so a typo is not silently dropped.
function parseAttendanceText(text) {
  const out = [];
  const seen = new Set();
  String(text || '').split(/\r?\n/).forEach((line, i) => {
    const t = line.replace(/^﻿/, '').trim();
    if (!t || t.startsWith('#')) return;
    const [rawName, ...pairs] = t.split('|');
    const name = gameRoster.normalizeCut(rawName.trim().replace(/\s+/g, ' ')); // a cut written "..." is the same as "…"
    if (!name) throw new Error(`dòng ${i + 1}: thiếu tên`);
    const stats = {};
    for (const p of pairs) {
      if (!p.trim()) continue;
      const eq = p.indexOf('=');
      const key = eq > 0 ? p.slice(0, eq).trim() : '';
      if (!key) throw new Error(`dòng ${i + 1}: "${p.trim()}" không phải key=value`);
      stats[key] = statValue(p.slice(eq + 1));
    }
    const key = nameKey(name) || name.toLowerCase(); // a name of symbols only has an empty key: fall back to the text
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, stats });
  });
  return out;
}

// ---------- resolve ----------

// Discord people the automatic match can use: the members the bot has stored, plus (optionally) the names on the registrations.
// [{ id, name }]. A script has no Discord connection, so this stands in for the live member list.
async function memberInfos(guildId, regs = []) {
  const rows = await db.q('select discord_id as "discordId", display_name as "displayName" from discord_members where guild_id = $1', [guildId]);
  const byId = new Map(rows.map((r) => [r.discordId, { id: r.discordId, name: r.displayName || '' }]));
  for (const r of regs) if (r.displayName && !(byId.get(r.discordId) || {}).name) byId.set(r.discordId, { id: r.discordId, name: r.displayName });
  return [...byId.values()];
}

const { isCutName: isCut, cutStem } = gameRoster;

// Game names -> [{ gameName, discordId, how: 'link'|'auto'|'none' }], same order. Order of trust: the saved link
// (Member.gameName, any source) -> the latest roster's automatic match. A name cut with "…" never takes those lookups directly (its
// key is the bare stem, which could be somebody else's whole name): only the ONE roster name it is the start of (a roster name equal
// to the stem counts as one candidate), then that name's link / match. Several roster names (or none) behind the prefix -> 'none'.
// `members` ([{ id, name }]) is the Discord side of the automatic match; default = the members stored in the DB.
async function resolve(guildId, names, { members } = {}) {
  const links = new Map(); // nameKey -> discordId
  const rows = await memberStore.listMembers(guildId, `gc.name is not null and gc.name <> ''`);
  for (const r of rows) links.set(nameKey(r.gameName), r.discordId);

  const infos = (members || (await memberInfos(guildId))).map((m) => ({ id: m.id, name: m.name, bot: m.bot }));
  const found = await gameRoster.matchGuild(guildId, infos);
  const auto = new Map(); // nameKey of a roster name -> discordId (automatic tiers only: hand pairs are the links above)
  if (found) for (const m of found.match.matched) if (!m.manual) auto.set(nameKey(m.game.name), m.discordId);
  const rosterNames = found ? found.roster.members.map((g) => g.name) : [];

  const lookup = (name) => {
    const k = nameKey(name);
    if (links.has(k)) return { discordId: links.get(k), how: 'link' };
    if (auto.has(k)) return { discordId: auto.get(k), how: 'auto' };
    return null;
  };
  return names.map((gameName) => {
    let hit = null;
    if (!isCut(gameName)) {
      hit = lookup(gameName);
      // the result screen shows the whole name while the roster list cut it ("ĐầuHổNhấtLớp" vs "ĐầuHổNhấtL…"): the ONE cut roster name it starts with
      if (!hit) {
        const full = fold(gameName);
        const cuts = rosterNames.filter((n) => isCut(n) && cutStem(n) && full.startsWith(fold(cutStem(n))));
        if (cuts.length === 1) hit = lookup(cuts[0]);
      }
    } else {
      const stem = fold(cutStem(gameName));
      const cands = stem ? rosterNames.filter((n) => fold(n).startsWith(stem)) : [];
      // a cut candidate is only taken when it is this very name (the same cut roster entry)
      if (cands.length === 1 && (!isCut(cands[0]) || nameKey(cands[0]) === nameKey(gameName))) hit = lookup(cands[0]);
    }
    return { gameName, discordId: hit ? hit.discordId : null, how: hit ? hit.how : 'none' };
  });
}

// ---------- save ----------

// One attendance per war: the same eventId replaces the previous import. Each name seen points at its game character (same name key,
// the one still in the guild first) and at its Discord member. -> the stored attendance { eventId, guildId, importedAt, importedBy, source, entries }
async function saveAttendance({ guildId, eventId, entries, source = '', importedBy = 'script' }) {
  const id = String(eventId);
  await db.tx(async () => {
    const war = await db.one('update war_events set attendance_at = now(), attendance_source = $2 where id = $1 and guild_id = $3 returning id', [id, source, guildId]);
    if (!war) throw new Error(`no war ${id} in guild ${guildId}`);
    await db.q('delete from attendance_entries where war_id = $1', [id]);
    const seen = new Set();
    for (const e of entries) {
      if (seen.has(e.gameName)) continue;
      seen.add(e.gameName);
      const ch = await db.one(
        'select id from game_characters where guild_id = $1 and name_key = $2 order by (left_at is null) desc, left_at desc nulls first, id desc limit 1',
        [guildId, nameKey(e.gameName) || `#${e.gameName}`]
      );
      const mid = e.discordId ? await memberStore.memberId(guildId, e.discordId) : null;
      await db.q('insert into attendance_entries (war_id, seen_name, character_id, member_id, how, stats) values ($1, $2, $3, $4, $5, $6)', [
        id, e.gameName, ch ? ch.id : null, mid, e.how || 'none', e.stats ? JSON.stringify(e.stats) : null,
      ]);
    }
  });
  const saved = await getAttendance(id);
  return saved && { ...saved, importedBy };
}

// The attendance of one war (null when none was imported).
async function getAttendance(eventId) {
  if (!db.isId(String(eventId))) return null;
  const war = await db.one('select id, guild_id, attendance_at, attendance_source from war_events where id = $1 and attendance_at is not null', [String(eventId)]);
  if (!war) return null;
  const entries = await db.q(
    `select a.seen_name as "gameName", m.discord_id as "discordId", a.how, a.stats from attendance_entries a
     left join discord_members m on m.id = a.member_id where a.war_id = $1 order by a.seen_name`,
    [war.id]
  );
  return { eventId: war.id, guildId: war.guild_id, importedAt: war.attendance_at, source: war.attendance_source, entries: entries.map((e) => (e.stats ? e : { gameName: e.gameName, discordId: e.discordId, how: e.how })) };
}

// ---------- compare ----------

// Registrations vs the people who really came. `names` / `displayNames` (Maps discordId -> text) fill the game / Discord name of
// those the registrations or the screen do not carry.
// came = joined + present; noShow = joined, not present; walkIn = present without a join (saidAbsent: registered as absent);
// unknown = present names with no Discord id. Item: { discordId, gameName, displayName }.
// While names are unknown, a registrant who is not on the screen and has no game name in `names` (no link to find them by) might be
// one of the unknown names: they are 'unconfirmed' (shown "?"), not a no-show.
function compare(_event, regs, attendance, { names = new Map(), displayNames = new Map() } = {}) {
  const entries = (attendance && attendance.entries) || [];
  const present = new Map();
  const unknown = [];
  for (const e of entries) {
    if (!e.discordId) unknown.push({ discordId: null, gameName: e.gameName, displayName: '' });
    else if (!present.has(e.discordId)) present.set(e.discordId, e); // one person on the screen twice counts once
  }
  const regById = new Map((regs || []).map((r) => [r.discordId, r]));
  const item = (id, reg, entry) => ({
    discordId: id,
    gameName: (entry && entry.gameName) || names.get(id) || '',
    displayName: (reg && reg.displayName) || displayNames.get(id) || '',
  });
  const came = [];
  const noShow = [];
  const unconfirmed = [];
  const walkIn = [];
  for (const r of regs || []) {
    if (r.status === 'absent') continue;
    const target = present.has(r.discordId) ? came : unknown.length && !names.get(r.discordId) ? unconfirmed : noShow;
    target.push(item(r.discordId, r, present.get(r.discordId)));
  }
  for (const [id, e] of present) {
    const reg = regById.get(id);
    if (!reg || reg.status === 'absent') walkIn.push({ ...item(id, reg, e), saidAbsent: Boolean(reg) });
  }
  return { came, noShow, unconfirmed, walkIn, unknown };
}

// ---------- history ----------

// items: [{ war: { eventId, title, startAt }, regs, attendance }] -> { wars (oldest first), people: Map discordId -> { discordId,
// gameName, displayName, registered, came, noShow, unconfirmed, walkIn, rate (came / registered, null without a registration),
// byWar: Map eventId -> 'came' | 'noShow' | 'unconfirmed' | 'walkIn' | 'absent' } }. Someone who said absent and stayed away is 'absent'
// (not counted); an 'unconfirmed' war (see compare) is neither registered nor a no-show, so it stays out of the rate.
// items may carry `names` (Map discordId -> linked game name) for compare.
function buildHistory(items) {
  const sorted = [...items].sort((a, b) => new Date(a.war.startAt) - new Date(b.war.startAt));
  const people = new Map();
  const person = (id) => {
    if (!people.has(id)) people.set(id, { discordId: id, gameName: '', displayName: '', registered: 0, came: 0, noShow: 0, unconfirmed: 0, walkIn: 0, rate: null, byWar: new Map() });
    return people.get(id);
  };
  for (const { war, regs, attendance, names } of sorted) {
    const key = String(war.eventId);
    const cmp = compare(null, regs, attendance, { names: names || new Map() });
    for (const group of ['came', 'noShow', 'unconfirmed', 'walkIn']) {
      for (const it of cmp[group]) {
        const p = person(it.discordId);
        p.byWar.set(key, group);
        p[group] += 1;
        if (group === 'came' || group === 'noShow') p.registered += 1;
        if (it.gameName) p.gameName = it.gameName; // oldest first, so the newest war wins
        if (it.displayName) p.displayName = it.displayName;
      }
    }
    for (const r of regs || []) {
      if (r.status !== 'absent') continue;
      const p = person(r.discordId);
      if (!p.byWar.has(key)) p.byWar.set(key, 'absent');
      if (r.displayName) p.displayName = r.displayName;
    }
  }
  for (const p of people.values()) p.rate = p.registered ? p.came / p.registered : null;
  return { wars: sorted.map((i) => ({ eventId: String(i.war.eventId), title: i.war.title, startAt: i.war.startAt })), people };
}

// The last `limit` wars of the guild that HAVE an attendance, with the per-person numbers. Seeded (test) registrations are ignored.
async function history(guildId, { limit = DEFAULT_LIMIT } = {}) {
  const events = await db.q(`select id as "_id", title, start_at as "startAt" from war_events where guild_id = $1 and attendance_at is not null order by start_at desc limit $2`, [guildId, limit]);
  if (!events.length) return { wars: [], people: new Map() };
  const ids = events.map((e) => e._id);
  const entries = await db.q(
    `select a.war_id, a.seen_name as "gameName", m.discord_id as "discordId" from attendance_entries a left join discord_members m on m.id = a.member_id where a.war_id = any($1)`,
    [ids]
  ); // compare needs no stats / how / source
  const docs = events.map((e) => ({ eventId: e._id, entries: entries.filter((x) => x.war_id === e._id).map(({ gameName, discordId }) => ({ gameName, discordId })) }));
  const regs = await db.q(
    `select r.war_id as "eventId", m.discord_id as "discordId", m.display_name as "displayName", r.status from registrations r
     join discord_members m on m.id = r.member_id where r.war_id = any($1)`,
    [ids]
  );
  const regsOf = new Map();
  for (const r of regs) {
    const k = String(r.eventId);
    if (!regsOf.has(k)) regsOf.set(k, []);
    regsOf.get(k).push(r);
  }
  const docOf = new Map(docs.map((d) => [String(d.eventId), d]));
  const names = await linkedNames(guildId, regs.map((r) => r.discordId));
  return buildHistory(events.map((e) => ({ war: { eventId: e._id, title: e.title, startAt: e.startAt }, regs: regsOf.get(String(e._id)) || [], attendance: docOf.get(String(e._id)), names })));
}

// discordId -> the game name the member is linked to (any source); people without a link are not in the Map.
async function linkedNames(guildId, ids) {
  const wanted = [...new Set(ids)];
  if (!wanted.length) return new Map();
  const rows = await memberStore.listMembers(guildId, `m.discord_id = any($2) and gc.name is not null and gc.name <> ''`, [wanted]);
  return new Map(rows.map((r) => [r.discordId, r.gameName]));
}

// ---------- choosing the war ----------

// The war of the guild that starts on that local (VN) date "YYYY-MM-DD"; null when there is none, the latest when two.
function findEventOnDate(guildId, ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd));
  if (!m) throw new Error('--date phải dạng YYYY-MM-DD');
  const from = fromLocal(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0);
  return warService.findOneWhere('w.guild_id = $1 and w.start_at >= $2 and w.start_at < $3 order by w.start_at desc', [guildId, from, new Date(from.getTime() + DAY)]);
}

// The most recent war that has already started.
function latestStartedEvent(guildId, now = new Date()) {
  return warService.findOneWhere('w.guild_id = $1 and w.start_at <= $2 order by w.start_at desc', [guildId, now]);
}

module.exports = { DEFAULT_LIMIT, parseAttendanceText, memberInfos, resolve, linkedNames, saveAttendance, getAttendance, compare, buildHistory, history, findEventOnDate, latestStartedEvent };
