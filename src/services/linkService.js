// "Nhất Tuyến Khiên" links (persistent per guild member). Links mirror in-game affinity (>= 3000), which is symmetric:
// ONE declaration is enough - A.links has B OR B.links has A means A-B are linked. Connected components of the links are
// "nhóm Tuyến Khiên" (only a group inside one PT benefits in game). Pure helpers first, then db.
const db = require('../db');
const memberStore = require('./members');

const defaults = require('../../config/defaults');

const MAX_LINKS = 5; // declared links kept per member = picks per panel action (a whole PT of 6 = 5 partners)
const MAX_GROUP = defaults.partySize; // a Tuyến Khiên group never exceeds one PT

const linksOf = (m) => (m && Array.isArray(m.links) ? m.links : []);

// members: [{ discordId, links }] -> [[id]] groups of >= 2 people joined by (undirected) links. `only` (Set/array of ids,
// optional) limits the people considered: a chain A-B-C without B is no group A+C. Ids are sorted inside a group and
// groups by first id, so the result never depends on input order.
function buildGroups(members, only = null) {
  const allowed = only ? new Set(only) : null;
  const adj = new Map();
  const edge = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a).add(b);
  };
  for (const m of members || []) {
    for (const b of linksOf(m)) {
      if (b === m.discordId || (allowed && !(allowed.has(m.discordId) && allowed.has(b)))) continue;
      edge(m.discordId, b);
      edge(b, m.discordId);
    }
  }
  const seen = new Set();
  const groups = [];
  for (const start of [...adj.keys()].sort()) {
    if (seen.has(start)) continue;
    const comp = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const id = stack.pop();
      comp.push(id);
      for (const n of adj.get(id) || []) {
        if (seen.has(n)) continue;
        seen.add(n);
        stack.push(n);
      }
    }
    groups.push(comp.sort());
  }
  return groups.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

// Everybody directly linked to `id` (declared by id or declaring id), sorted.
function neighborsOf(members, id) {
  const out = new Set(linksOf((members || []).find((m) => m.discordId === id)));
  for (const m of members || []) if (m.discordId !== id && linksOf(m).includes(id)) out.add(m.discordId);
  out.delete(id);
  return [...out].sort();
}

// People who declared `id` but whom `id` has not declared back ("A đã khai bạn"), sorted.
function declaredBy(members, id) {
  const mine = new Set(linksOf((members || []).find((m) => m.discordId === id)));
  return (members || [])
    .filter((m) => m.discordId !== id && linksOf(m).includes(id) && !mine.has(m.discordId))
    .map((m) => m.discordId)
    .sort();
}

// The group containing `id` (array of ids) or null.
const groupOf = (groups, id) => (groups || []).find((g) => g.includes(id)) || null;

// { groups, carriers } for the people registered join in `regs`: what the board, image and exports need.
function contextFor(members, regs) {
  const people = (regs || []).filter((r) => r.status === 'join').map((r) => r.discordId);
  const here = new Set(people);
  return {
    groups: buildGroups(members, here),
    edges: edgesOf(members, here),
    carriers: new Set((members || []).filter((m) => m.tuyenKhien && here.has(m.discordId)).map((m) => m.discordId)),
  };
}

// Undirected links [[a, b]] (a < b, unique) between people of `only` (Set).
function edgesOf(members, only) {
  const seen = new Set();
  const out = [];
  for (const m of members || []) {
    for (const b of linksOf(m)) {
      if (b === m.discordId || !only.has(m.discordId) || !only.has(b)) continue;
      const [x, y] = m.discordId < b ? [m.discordId, b] : [b, m.discordId];
      if (seen.has(`${x}|${y}`)) continue;
      seen.add(`${x}|${y}`);
      out.push([x, y]);
    }
  }
  return out;
}

// The people the panel menu shows as selected: my declared links first, then those who declared me, max MAX_LINKS.
function menuIds(members, id) {
  const mine = linksOf((members || []).find((m) => m.discordId === id)).filter((x) => x !== id);
  return [...new Set([...mine, ...declaredBy(members, id)])].slice(0, MAX_LINKS);
}

// Sanitized pick list: strings, unique, never self, at most MAX_LINKS.
const cleanIds = (ids, self) => [...new Set((ids || []).map(String))].filter((id) => id && id !== self).slice(0, MAX_LINKS);

// What a pick from the panel does. `shown` = the ids the menu really showed as selected (unknown: only MY OWN declared links, so an unseen declarer is never unlinked); one of
// them not picked any more is REMOVED (from my list and, via `unlink`, from the other person's list); picks are added.
// A pick that would make my group bigger than one PT (MAX_GROUP) is rejected (stays out of `links`).
// -> { links: new declared list of `me`, accepted: the picks taken that I had not declared before, unlink: ids whose list must drop `me`, rejected: [id] }
function planLinks(members, me, picks, shown = null) {
  const ids = cleanIds(picks, me);
  const removed = (shown ? [...new Set(shown.map(String))] : linksOf((members || []).find((m) => m.discordId === me))).filter((id) => id !== me && !ids.includes(id));
  const mine = linksOf((members || []).find((m) => m.discordId === me));
  const kept = mine.filter((id) => !removed.includes(id) && !ids.includes(id));
  // declared lists as they would be without this action's additions
  const base = (members || []).filter((m) => m.discordId !== me).map((m) => ({ discordId: m.discordId, links: linksOf(m).filter((x) => x !== me || !removed.includes(m.discordId)) }));
  const sizeWith = (mine) => (groupOf(buildGroups([...base, { discordId: me, links: mine }]), me) || [me]).length;
  const linked = new Set(neighborsOf([...base, { discordId: me, links: kept }], me));
  const accepted = [];
  const rejected = [];
  let current = [...kept];
  for (const id of [...ids.filter((x) => linked.has(x)), ...ids.filter((x) => !linked.has(x))]) {
    const next = [...current, id];
    const before = sizeWith(current);
    if (linked.has(id) || sizeWith(next) <= Math.max(MAX_GROUP, before)) {
      current = next;
      accepted.push(id);
    } else rejected.push(id);
  }
  return { links: [...ids.filter((id) => accepted.includes(id)), ...kept].slice(0, MAX_LINKS), accepted: ids.filter((id) => accepted.includes(id) && !mine.includes(id) && !linked.has(id)), unlink: removed, rejected };
}

// ---------- db ----------

// Members of the guild that carry the passive, declared somebody or stated a mission wish (all that group building and the
// mission split need; the wishes are read with missions.prefsOf).
function loadMembers(guildId) {
  return db.q(
    `select discord_id as "discordId", display_name as "displayName", tuyen_khien as "tuyenKhien", tk_partners as links, mission_pref as "missionPref"
     from discord_members where guild_id = $1 and (tuyen_khien or cardinality(tk_partners) > 0 or mission_pref <> 'any')`,
    [guildId]
  );
}

// Apply a panel pick (see planLinks; `shown` = ids the menu displayed). Returns { links, rejected }. Runs in one transaction that
// locks my row first, and my list is rebuilt from the stored one (removed ones out, new picks first, capped), so a concurrent change
// is never overwritten.
async function setLinks(guildId, discordId, picks, shown = null) {
  return db.tx(async () => {
    const mid = await memberStore.memberId(guildId, discordId);
    const mine = await db.one('select tk_partners from discord_members where id = $1 for update', [mid]);
    const plan = planLinks(await loadMembers(guildId), discordId, picks, shown);
    if (plan.unlink.length) await db.q('update discord_members set tk_partners = array_remove(tk_partners, $3) where guild_id = $1 and discord_id = any($2)', [guildId, plan.unlink, discordId]);
    // only the NEW picks are added; links kept from before come from the stored row, so a concurrent removal sticks
    const add = plan.accepted.filter((id) => !plan.unlink.includes(id));
    const keep = (mine.tk_partners || []).filter((id) => !plan.unlink.includes(id) && !add.includes(id));
    const links = [...add, ...keep].slice(0, MAX_LINKS);
    await db.q('update discord_members set tk_partners = $2 where id = $1', [mid, links]);
    return { links, rejected: plan.rejected };
  });
}

// Remove every link of `discordId` in both directions.
async function clearLinks(guildId, discordId) {
  await db.tx(async () => {
    await db.q('update discord_members set tk_partners = array_remove(tk_partners, $2) where guild_id = $1 and $2 = any(tk_partners)', [guildId, discordId]);
    await memberStore.saveMember(guildId, discordId, { links: [] });
  });
}

// Flip the passive flag atomically (no read of other members); returns the new value.
async function toggleCarries(guildId, discordId) {
  return db.tx(async () => {
    const mid = await memberStore.memberId(guildId, discordId);
    return (await db.one('update discord_members set tuyen_khien = not tuyen_khien where id = $1 returning tuyen_khien', [mid])).tuyen_khien;
  });
}

module.exports = { MAX_LINKS, MAX_GROUP, buildGroups, menuIds, neighborsOf, declaredBy, groupOf, contextFor, planLinks, loadMembers, setLinks, clearLinks,  toggleCarries };
