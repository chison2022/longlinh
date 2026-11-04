// "Gợi ý chia đội": a suggested lineup (pure: no DB, no Discord; the Activity client bundles it). The rules, in order:
//   0. how many people each PT gets: PT after PT is filled to 6 (26 people -> 6, 6, 6, 6, 2), Nhóm 1 first, Nhóm 2 only once Nhóm 1 is full;
//   1. every PT that gets people has at least one healer (Tố Vấn) and one tank (Thiết Y); when there are not enough, PTs are served in order
//      (Nhóm 1 PT 1 first), so a shortage lands in the last PTs;
//   2. everyone else is placed at random (a re-run gives another layout).
// More people than slots: the earlier registrations (createdAt) are placed, the rest stay unplaced.
// To add a rule, add a step in autoSplit between the "required classes" and the "rest" steps.
const defaults = require('../../config/defaults');
const { sameClass, emptyLayout, idsOf } = require('./lineupRules');

// Seedable RNG (tests): mulberry32 -> () => [0, 1).
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, rng) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// members: [{ id, className, createdAt }]; layout: the current layout (kept when mode = 'fill');
// mode: 'fill' = only the empty slots, 'all' = start from nothing.
// -> { layout, placed: [id] (newly placed), unplaced: [id] (members who got no slot) }
function autoSplit({ members, layout = null, shape, mode = 'all', rng = Math.random, rules = defaults }) {
  const byId = new Map(members.map((m) => [m.id, m]));
  const next = mode === 'fill' && layout ? { groups: layout.groups.map((g) => g.map((p) => p.filter((id) => byId.has(id)))) } : emptyLayout(shape);
  const already = new Set(idsOf(next));
  const room = Math.max(0, shape.groupCount * shape.partiesPerGroup * shape.partySize - already.size);
  // first come, first served: the earliest registrations get the slots
  const pool = members
    .filter((m) => !already.has(m.id))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt) || (a.id < b.id ? -1 : 1))
    .slice(0, room);
  let waiting = shuffle(pool.map((m) => m.id), rng);

  const pts = [];
  next.groups.forEach((g, gi) => g.forEach((party, pi) => pts.push({ g: gi, p: pi, party })));
  const free = (pt) => shape.partySize - pt.party.length;

  // 0. how many new people each PT gets: PT after PT is topped up to a full party, Nhóm 1 first
  const size = pts.map((pt) => pt.party.length);
  const plan = pts.map(() => 0);
  for (let n = 0; n < pool.length; n++) {
    const best = size.findIndex((n) => n < shape.partySize);
    if (best < 0) break;
    size[best] += 1;
    plan[best] += 1;
  }
  const take = (id, i) => {
    pts[i].party.push(id);
    plan[i] -= 1;
    waiting = waiting.filter((x) => x !== id);
  };

  // 1. one healer and one tank in every PT that gets people, in PT order
  for (const cls of [rules.healerClass, rules.tankClass]) {
    pts.forEach((pt, i) => {
      if (plan[i] > 0 && free(pt) > 0 && !pt.party.some((id) => sameClass(byId.get(id).className, cls))) {
        const pick = waiting.find((id) => sameClass(byId.get(id).className, cls)); // the list is shuffled: a random one
        if (pick) take(pick, i);
      }
    });
  }
  // 2. the rest: random people into the places the plan left
  pts.forEach((pt, i) => {
    while (plan[i] > 0 && waiting.length) take(waiting[0], i);
  });

  const placedNow = new Set(idsOf(next));
  return {
    layout: next,
    placed: pool.filter((m) => placedNow.has(m.id)).map((m) => m.id),
    unplaced: members.filter((m) => !placedNow.has(m.id)).map((m) => m.id),
  };
}

module.exports = { autoSplit, mulberry32 };
