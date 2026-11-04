// Rules of the war lineup board (pure: no DB, no Discord). Shared by the service, the bot image and the Activity client bundle.
// Layout shape: { groups: [ group x groupCount ] }, group = [ party x partiesPerGroup ], party = [ discordId (string) x <= partySize ].
const defaults = require('../../config/defaults');

// A person on the board: a Discord id, or 'm:<10 hex>' for somebody a manager added by hand.
const MEMBER_KEY = /^(\d{5,25}|m:[a-f0-9]{10})$/;
const { plainClass } = require('./lineupStyle');

// Class label -> comparison key ("🛡️ Thiết Y" and "Thiết Y" are the same class).
const classKey = (name) =>
  plainClass(name || '')
    .normalize('NFKC')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const sameClass = (a, b) => Boolean(a) && Boolean(b) && classKey(a) === classKey(b);

// { groupCount, partiesPerGroup, partySize } -> a layout with no one in it.
function emptyLayout(shape) {
  return { groups: Array.from({ length: shape.groupCount }, () => Array.from({ length: shape.partiesPerGroup }, () => [])) };
}

// -> { ok: true, layout } (ids as strings, nothing else kept) | { ok: false, error } (Vietnamese). Checks the shape, the party
// size and that nobody stands twice.
function validateLayout(layout, shape) {
  const bad = (error) => ({ ok: false, error });
  const groups = layout && layout.groups;
  if (!Array.isArray(groups) || groups.length !== shape.groupCount) return bad('Đội hình sai số Nhóm.');
  const seen = new Set();
  const out = [];
  for (const group of groups) {
    if (!Array.isArray(group) || group.length !== shape.partiesPerGroup) return bad('Đội hình sai số PT.');
    const parties = [];
    for (const party of group) {
      if (!Array.isArray(party)) return bad('Đội hình sai định dạng PT.');
      if (party.length > shape.partySize) return bad(`Mỗi PT tối đa ${shape.partySize} người.`);
      const ids = [];
      for (const raw of party) {
        if (typeof raw !== 'string' || !MEMBER_KEY.test(raw)) return bad('Mã người chơi không hợp lệ.');
        if (seen.has(raw)) return bad('Một người bị xếp hai lần.');
        seen.add(raw);
        ids.push(raw);
      }
      parties.push(ids);
    }
    out.push(parties);
  }
  return { ok: true, layout: { groups: out } };
}

// A stored layout fitted to the current shape (the guild changed its group count): people who still fit keep their place, the rest are
// unassigned. Tolerates a damaged value (anything that is not a layout gives an empty one).
function reshapeLayout(layout, shape) {
  const out = emptyLayout(shape);
  const seen = new Set();
  const groups = layout && Array.isArray(layout.groups) ? layout.groups : [];
  for (let g = 0; g < shape.groupCount; g++) {
    for (let p = 0; p < shape.partiesPerGroup; p++) {
      const party = groups[g] && Array.isArray(groups[g][p]) ? groups[g][p] : [];
      for (const id of party) {
        if (typeof id !== 'string' || seen.has(id) || out.groups[g][p].length >= shape.partySize) continue;
        seen.add(id);
        out.groups[g][p].push(id);
      }
    }
  }
  return out;
}

// Copy of the layout without the ids that `keep(id)` refuses.
const filterLayout = (layout, keep) => ({ groups: layout.groups.map((g) => g.map((p) => p.filter(keep))) });

// Every id standing in the layout.
const idsOf = (layout) => layout.groups.flatMap((g) => g.flat());

// Where an id stands: { group, party, slot } (0-based) or null.
function locate(layout, id) {
  for (let g = 0; g < layout.groups.length; g++) {
    for (let p = 0; p < layout.groups[g].length; p++) {
      const slot = layout.groups[g][p].indexOf(id);
      if (slot >= 0) return { group: g, party: p, slot };
    }
  }
  return null;
}

// Moves `id` to `target` ({ type: 'pool' } | { type: 'slot', group, party, slot }) in a COPY of the layout. Dropping on a filled slot
// swaps with its occupant (who takes the old place of `id`, or goes back to the pool); dropping on an empty slot appends to that
// party. -> the new layout, or the same layout object when nothing changes (a full party can only be entered by swapping).
function moveInLayout(layout, id, target, partySize = defaults.partySize) {
  const from = locate(layout, id);
  const next = { groups: layout.groups.map((g) => g.map((p) => p.slice())) };
  if (target.type === 'pool') {
    if (!from) return layout;
    next.groups[from.group][from.party].splice(from.slot, 1);
    return next;
  }
  const party = next.groups[target.group] && next.groups[target.group][target.party];
  if (!party) return layout;
  if (target.slot < party.length) {
    const occupant = party[target.slot];
    if (occupant === id) return layout;
    if (from) next.groups[from.group][from.party][from.slot] = occupant;
    party[target.slot] = id;
    return next;
  }
  if (from && from.group === target.group && from.party === target.party) {
    party.splice(from.slot, 1);
    party.push(id);
    return next;
  }
  if (party.length >= partySize) return layout;
  if (from) next.groups[from.group][from.party].splice(from.slot, 1);
  party.push(id);
  return next;
}

// party = discord ids; classes = Map or plain object id -> class name. -> { missingHealer, missingTank }; an empty party warns nothing.
function partyWarnings(party, classes, rules = defaults) {
  if (!party || !party.length) return { missingHealer: false, missingTank: false };
  const get = (id) => (classes instanceof Map ? classes.get(id) : classes && classes[id]);
  const names = party.map(get);
  return {
    missingHealer: !names.some((c) => sameClass(c, rules.healerClass)),
    missingTank: !names.some((c) => sameClass(c, rules.tankClass)),
  };
}

// ---------- tasks (nhiệm vụ) and PT notes ----------

// The four built-in tasks = the member roles (config/defaults.js roles); a guild adds custom ones ('c:<slug>').
const BUILTIN_TASKS = ['def', 'cong', 'daytru', 'vattu'].map((key) => {
  const r = defaults.roles[key];
  const [emoji] = r.label.split(' ');
  return { key, label: r.plain, emoji, builtin: true };
});
const NOTE_MAX = 80;
const TASK_LABEL_MAX = 30;
const MAX_CUSTOM_TASKS = 15;
const CUSTOM_KEY = /^c:[a-z0-9-]{1,30}$/;

// The task a member's own wish gives ('def' | 'cong' | 'daytru' | 'vattu'), or null for 'any' / unknown (older wishes mid / mobile / supply too).
function taskOfWish(pref) {
  const legacy = { mid: 'cong', mobile: 'daytru', supply: 'vattu' };
  const key = legacy[pref] || pref;
  return BUILTIN_TASKS.some((t) => t.key === key) ? key : null;
}

// Free text of a note / task name: mentions and every "@" removed (nothing the bot posts may ping), whitespace folded, cut to `max`.
function cleanText(text, max) {
  return String(text == null ? '' : text)
    .replace(/<[@#][!&]?\d+>/g, '')
    .replace(/@/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
const cleanNote = (text) => cleanText(text, NOTE_MAX);

// explicit: { discordId: taskKey | '' }; placed: ids standing in the layout; validKeys: Set of every task key of the guild.
// -> { ok: true, tasks } (only placed people; '' = explicitly none) | { ok: false, error }. An unknown key is refused.
function validateTasks(explicit, placed, validKeys) {
  if (explicit == null) return { ok: true, tasks: {} };
  if (typeof explicit !== 'object' || Array.isArray(explicit)) return { ok: false, error: 'Nhiệm vụ sai định dạng.' };
  const keep = new Set(placed);
  const tasks = {};
  for (const [id, key] of Object.entries(explicit)) {
    if (typeof key !== 'string' || (key !== '' && !validKeys.has(key))) return { ok: false, error: 'Nhiệm vụ không tồn tại.' };
    if (keep.has(id)) tasks[id] = key;
  }
  return { ok: true, tasks };
}

// notes: { 'group-party': text } (0-based) -> cleaned notes of PTs inside the shape; empty ones dropped.
function validateNotes(notes, shape) {
  if (notes == null) return { ok: true, notes: {} };
  if (typeof notes !== 'object' || Array.isArray(notes)) return { ok: false, error: 'Ghi chú PT sai định dạng.' };
  const out = {};
  for (const [k, v] of Object.entries(notes)) {
    const m = /^(\d+)-(\d+)$/.exec(k);
    if (!m || Number(m[1]) >= shape.groupCount || Number(m[2]) >= shape.partiesPerGroup) continue;
    const text = cleanNote(v);
    if (text) out[k] = text;
  }
  return { ok: true, notes: out };
}

// The task key of everyone placed: the explicit choice, else their own wish (`wishOf(id)` -> pref). '' = none.
function effectiveTasks(layout, explicit, wishOf) {
  const out = {};
  for (const id of idsOf(layout)) out[id] = Object.prototype.hasOwnProperty.call(explicit || {}, id) ? explicit[id] : taskOfWish(wishOf(id)) || '';
  return out;
}

// A stored published snapshot: { layout, tasks, notes, names } (new) or just a layout (older rows) -> the new shape, null when empty.
function readSnapshot(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value.groups)) return { layout: value, tasks: {}, notes: {}, names: {} };
  if (value.layout && Array.isArray(value.layout.groups)) return { layout: value.layout, tasks: value.tasks || {}, notes: value.notes || {}, names: value.names || {} };
  return null;
}

// tasks / notes of a lineup fitted to a (reshaped) layout and shape: only placed people, only PTs inside the shape.
function pruneExtras(layout, tasks, notes, shape) {
  const placed = new Set(idsOf(layout));
  const t = {};
  for (const [id, key] of Object.entries(tasks || {})) if (placed.has(id)) t[id] = key;
  return { tasks: t, notes: validateNotes(notes, shape).notes };
}

// ---------- Tuyến Khiên groups ----------

// groups = [[id]] (people linked to each other). -> the others of the group `id` belongs to (sorted), [] when the person has no link.
function matesOf(groups, id) {
  const grp = (groups || []).find((g) => g.includes(id));
  return grp ? grp.filter((x) => x !== id).sort() : [];
}

module.exports = { MEMBER_KEY, classKey, sameClass, emptyLayout, validateLayout, filterLayout, reshapeLayout, idsOf, locate, moveInLayout, partyWarnings,
  matesOf,
  BUILTIN_TASKS, NOTE_MAX, TASK_LABEL_MAX, MAX_CUSTOM_TASKS, CUSTOM_KEY, taskOfWish, cleanText, cleanNote, validateTasks, validateNotes, effectiveTasks, readSnapshot, pruneExtras };
