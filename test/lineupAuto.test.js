// Auto-split ("Gợi ý chia đội"), Tuyến Khiên warnings and the joiner list (in-game names, links).
const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { setupDb, resetDb } = require('./pgdb');
const rules = require('../src/services/lineupRules');
const actSnapshot = require('../src/services/actSnapshot');
const { autoSplit, mulberry32 } = require('../src/services/lineupAuto');
const { seedWar, G } = require('./lineupFixture');

const SHAPE = { groupCount: 2, partiesPerGroup: 5, partySize: 6 };
const CLASSES = ['Huyết Hà', 'Thần Tương', 'Toái Mộng', 'Cửu Linh'];
// n members with ids 1..n (sign-up order); `healers` Tố Vấn and `tanks` Thiết Y first, the rest other classes
function crowd(n, { healers = 12, tanks = 12 } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    id: String(1000 + i),
    className: i < healers ? 'Tố Vấn' : i < healers + tanks ? '🛡️ Thiết Y' : CLASSES[i % CLASSES.length],
    createdAt: new Date(2026, 10, 1, 12, 0, i),
  }));
}
const classOf = (members) => Object.fromEntries(members.map((m) => [m.id, m.className]));
const parties = (layout) => layout.groups.flatMap((g, gi) => g.map((party, pi) => ({ gi, pi, party })));
const count = (party, cls, by) => party.filter((id) => rules.sameClass(by[id], cls)).length;

describe('autoSplit', () => {
  it('every PT has a healer and a tank when there are enough, whatever the seed', () => {
    const members = crowd(60, { healers: 16, tanks: 12 });
    const by = classOf(members);
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { layout, unplaced } = autoSplit({ members, shape: SHAPE, rng: mulberry32(seed) });
      assert.deepEqual(unplaced, []);
      for (const { party } of parties(layout)) {
        assert.ok(count(party, 'Tố Vấn', by) >= 1, 'healer');
        assert.ok(count(party, 'Thiết Y', by) >= 1, 'tank');
        assert.ok(party.length <= SHAPE.partySize);
      }
    }
  });
  it('too few healers / tanks: the PTs are served in order, Nhóm 1 PT 1 first', () => {
    const members = crowd(60, { healers: 7, tanks: 4 });
    const by = classOf(members);
    const { layout } = autoSplit({ members, shape: SHAPE, rng: mulberry32(2) });
    const flat = parties(layout);
    flat.forEach(({ party }, i) => {
      assert.equal(count(party, 'Tố Vấn', by) >= 1, i < 7, `healer in PT #${i + 1}`);
      assert.equal(count(party, 'Thiết Y', by) >= 1, i < 4, `tank in PT #${i + 1}`);
    });
  });
  it('PTs are filled to 6 one after another: 26 people make 6, 6, 6, 6, 2 and Nhóm 2 stays empty', () => {
    const members = crowd(26, { healers: 8, tanks: 8 });
    const by = classOf(members);
    const { layout } = autoSplit({ members, shape: SHAPE, rng: mulberry32(11) });
    assert.deepEqual(layout.groups[0].map((p) => p.length), [6, 6, 6, 6, 2]);
    assert.deepEqual(layout.groups[1].map((p) => p.length), [0, 0, 0, 0, 0]);
    for (const party of layout.groups[0]) {
      assert.ok(count(party, 'Tố Vấn', by) >= 1 && count(party, 'Thiết Y', by) >= 1);
    }
  });
  it('Nhóm 2 only gets people once Nhóm 1 is full; its PTs without people need no healer', () => {
    const members = crowd(33, { healers: 9, tanks: 9 });
    const by = classOf(members);
    const { layout } = autoSplit({ members, shape: SHAPE, rng: mulberry32(12) });
    assert.deepEqual(layout.groups[0].map((p) => p.length), [6, 6, 6, 6, 6]);
    assert.deepEqual(layout.groups[1].map((p) => p.length), [3, 0, 0, 0, 0]);
    for (const party of [...layout.groups[0], layout.groups[1][0]]) assert.ok(count(party, 'Tố Vấn', by) >= 1);
  });
  it('fewer people than a PT: they all go into PT 1', () => {
    const { layout } = autoSplit({ members: crowd(3), shape: SHAPE, rng: mulberry32(13) });
    assert.deepEqual(layout.groups[0].map((p) => p.length), [3, 0, 0, 0, 0]);
  });
  it("'fill' keeps who is placed and tops the PTs up to 6 in order", () => {
    const members = crowd(40, { healers: 10, tanks: 10 });
    const current = rules.emptyLayout(SHAPE);
    current.groups[0][0] = [members[0].id, members[1].id];
    current.groups[0][3] = [members[2].id];
    const { layout } = autoSplit({ members, layout: current, shape: SHAPE, mode: 'fill', rng: mulberry32(21) });
    assert.deepEqual(layout.groups[0].map((p) => p.length), [6, 6, 6, 6, 6]);
    assert.deepEqual(layout.groups[1].map((p) => p.length), [6, 4, 0, 0, 0]);
    assert.deepEqual(layout.groups[0][0].slice(0, 2), [members[0].id, members[1].id], 'who was placed stays first');
  });
  it('is random but seedable: the same seed gives the same layout, another seed another one', () => {
    const members = crowd(60);
    const run = (seed) => JSON.stringify(autoSplit({ members, shape: SHAPE, rng: mulberry32(seed) }).layout);
    assert.equal(run(7), run(7));
    assert.notEqual(run(7), run(8));
  });
  it('more people than slots: the first registrations are placed, the rest stay out (by createdAt, not list order)', () => {
    const members = crowd(65);
    const { layout, unplaced } = autoSplit({ members, shape: SHAPE, rng: mulberry32(3) });
    assert.equal(rules.idsOf(layout).length, 60);
    assert.deepEqual(unplaced, members.slice(60).map((m) => m.id));
    assert.deepEqual(autoSplit({ members: members.slice().reverse(), shape: SHAPE, rng: mulberry32(3) }).unplaced.sort(), unplaced.sort());
  });
  it("mode 'fill' keeps who is placed and only uses empty slots; 'all' starts over", () => {
    const members = crowd(40);
    const current = rules.emptyLayout(SHAPE);
    current.groups[1][4] = [members[39].id, members[38].id];
    const fill = autoSplit({ members, layout: current, shape: SHAPE, mode: 'fill', rng: mulberry32(4) });
    assert.deepEqual(fill.layout.groups[1][4].slice(0, 2), [members[39].id, members[38].id]);
    assert.equal(rules.idsOf(fill.layout).length, 40);
    assert.equal(fill.placed.length, 38);
    assert.equal(rules.idsOf(autoSplit({ members, layout: current, shape: SHAPE, mode: 'all', rng: mulberry32(4) }).layout).length, 40);
  });
  it("'fill' counts the healers and tanks already standing in a PT", () => {
    const members = crowd(30, { healers: 5, tanks: 5 });
    const by = classOf(members);
    const current = rules.emptyLayout(SHAPE);
    current.groups[0][0] = [members[0].id, members[5].id]; // a healer and a tank already in PT 1
    const { layout } = autoSplit({ members, layout: current, shape: SHAPE, mode: 'fill', rng: mulberry32(9) });
    assert.equal(count(layout.groups[0][0], 'Tố Vấn', by), 1, 'PT 1 needed no other healer');
    assert.equal(count(layout.groups[0][0], 'Thiết Y', by), 1);
    assert.ok(count(layout.groups[0][1], 'Tố Vấn', by) >= 1);
  });
});

describe('Tuyến Khiên (display only)', () => {
  it('matesOf lists the others of a person\'s group, sorted; nobody for an unlinked person', () => {
    const groups = [['a', 'c', 'b'], ['x', 'y']];
    assert.deepEqual(rules.matesOf(groups, 'c'), ['a', 'b']);
    assert.deepEqual(rules.matesOf(groups, 'x'), ['y']);
    assert.deepEqual(rules.matesOf(groups, 'z'), []);
    assert.deepEqual(rules.matesOf(undefined, 'a'), []);
  });
});

describe('joiner list (in-game names, links)', () => {
  before(setupDb);
  beforeEach(resetDb);
  it('uses the linked character name and class, falls back to the Discord name, and carries the declared links', async () => {
    const w = await seedWar({ classes: ['Tố Vấn', 'Thiết Y', 'Huyết Hà'] });
    await db.q("insert into game_characters (guild_id, name, name_key, class_name) values ($1, 'Kiếm Tâm', 'kiemtam', 'Tố Vấn')", [G]);
    await db.q("insert into character_links (character_id, member_id, guild_id, source) select g.id, m.id, $1, 'admin' from game_characters g, discord_members m where g.name = 'Kiếm Tâm' and m.discord_id = $2", [G, w.ids[0]]);
    await db.q('update discord_members set tk_partners = $2 where discord_id = $1', [w.ids[1], [w.ids[2]]]);
    const list = await actSnapshot.listJoiners(w.warId);
    assert.deepEqual([list[0].name, list[0].discordName, list[0].linked, list[0].gameClass], ['Kiếm Tâm', 'Người 1', true, 'Tố Vấn']);
    assert.deepEqual([list[1].name, list[1].linked], ['Người 2', false]);
    assert.deepEqual(actSnapshot.linkGroupsOf(list), [[w.ids[1], w.ids[2]].sort()]);
  });
});
