// The Activity's database (Neon) must be able to sleep: how often the bot looks at it, the catch-up that only asks about news, the
// one-statement snapshot, atomic board changes, the guard against pointing it at the main database.
const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../src/db');
const side = require('../src/sideDb');
const { setupDb, resetDb } = require('./pgdb');
const { setupSide, resetSide } = require('./sidedb');
const actBridge = require('../src/bot/actBridge');
const actSnapshot = require('../src/services/actSnapshot');
const lineupService = require('../src/services/lineupService');
const rules = require('../src/services/lineupRules');
const warService = require('../src/services/warService');
const publisher = require('../src/jobs/lineupPublisher');
const { clearConfigCache } = require('../src/services/guildConfigService');
const { seedWar, snapshot, guildSnapshot, G } = require('./lineupFixture');

const START = new Date('2026-12-05T13:00:00Z');
const DAY = 24 * 3600 * 1000;
let w;
let sideCalls;
let realQ;

before(async () => {
  await setupDb();
  await setupSide();
});
beforeEach(async () => {
  await resetDb();
  await resetSide();
  clearConfigCache();
  actBridge.resetMemory();
  publisher.resetPolling();
  w = await seedWar({ classes: ['Tố Vấn', 'Thiết Y', 'Huyết Hà'] });
  sideCalls = 0;
  realQ = side.q;
  side.q = (...a) => {
    sideCalls += 1;
    return realQ(...a);
  };
});
afterEach(() => {
  side.q = realQ;
});
const lock = () => db.q("update war_events set status = 'locked' where id = $1", [w.warId]);

describe('how often the bot looks at the Activity database', () => {
  const client = { channels: { fetch: async () => ({ send: async () => {} }) }, guilds: { cache: new Map() } };

  it('no closed war, or one that starts in more than a week: the side database is not touched, the next look is in 5 minutes', async () => {
    assert.equal(await publisher.step(client, START.getTime() - 30 * DAY), publisher.IDLE_MS);
    await lock();
    assert.equal(await publisher.step(client, START.getTime() - 30 * DAY), publisher.IDLE_MS);
    assert.equal(sideCalls, 0);
  });
  it('a closed war within a week: every 20 s, backing off to 2 minutes after 30 empty looks, back to 20 s after a hit', async () => {
    await lock();
    await snapshot(w);
    const now = START.getTime() - 3 * DAY;
    for (let i = 1; i < publisher.EMPTY_BEFORE_SLOW; i++) assert.equal(await publisher.step(client, now), publisher.FAST_MS, `look ${i}`);
    assert.equal(await publisher.step(client, now), publisher.SLOW_MS, 'the 30th empty look');
    assert.equal(await publisher.step(client, now), publisher.SLOW_MS);
    await lineupService.requestPublish(w.warId, 'u'); // a manager asked: found by the next look
    assert.equal(await publisher.step(client, now), publisher.FAST_MS, 'a hit brings the 20 s rhythm back');
    assert.ok(sideCalls > 0);
  });
});

describe('catch-up only asks about news', () => {
  it('nothing new: no side query at all; once written a war is remembered; closed wars are copied once', async () => {
    assert.equal(await actBridge.catchUp({}), 0);
    assert.equal(sideCalls, 0, 'no candidates, no side query');
    await lock();
    assert.equal(await actBridge.catchUp({ guilds: { cache: new Map() } }), 1);
    const used = sideCalls;
    assert.ok(used > 0);
    assert.equal(await actBridge.catchUp({}), 0);
    assert.equal(sideCalls, used, 'the war is remembered: not even a look');
  });
  it('a war that fails backs off (1 min, doubling) and does not starve the others', async () => {
    await lock();
    const second = await seedWar({ guildId: '800000000000000002', classes: ['Tố Vấn'] });
    await warService.publishEvent(second.warId);
    const real = actSnapshot.listJoiners;
    const tried = [];
    actSnapshot.listJoiners = async (id) => {
      tried.push(String(id));
      if (String(id) === w.warId) throw new Error('boom');
      return real(id);
    };
    try {
      const t0 = Date.now();
      assert.equal(await actBridge.catchUp({ guilds: { cache: new Map() } }, 3, t0), 1, 'the healthy war was copied');
      assert.deepEqual(tried.sort(), [w.warId, second.warId].sort());
      tried.length = 0;
      await actBridge.catchUp({}, 3, t0 + 10 * 1000);
      assert.deepEqual(tried, [], 'inside the back-off nothing is retried');
      await actBridge.catchUp({ guilds: { cache: new Map() } }, 3, t0 + 70 * 1000);
      assert.deepEqual(tried, [w.warId], 'after a minute it is tried again');
      tried.length = 0;
      await actBridge.catchUp({ guilds: { cache: new Map() } }, 3, t0 + 70 * 1000 + 90 * 1000);
      assert.deepEqual(tried, [], 'the second failure waits two minutes');
    } finally {
      actSnapshot.listJoiners = real;
    }
  });
  it('wars that finished in the main database are marked done in the side one (a missed markDone heals), once', async () => {
    await lock();
    await snapshot(w);
    await db.q("update war_events set status = 'done' where id = $1", [w.warId]);
    assert.equal((await lineupService.getWar(w.warId)).status, 'locked');
    await actBridge.catchUp({});
    assert.equal((await lineupService.getWar(w.warId)).status, 'done');
    const used = sideCalls;
    await actBridge.catchUp({});
    assert.equal(sideCalls, used, 'reconciled once, then silent');
  });
  it('reopening registration marks the war open on the board; the re-lock snapshot makes it locked again', async () => {
    await lock();
    await snapshot(w);
    await actBridge.onReopened(w.warId);
    assert.equal((await lineupService.getWar(w.warId)).status, 'open');
    await snapshot(w);
    assert.equal((await lineupService.getWar(w.warId)).status, 'locked');
  });
});

describe('the snapshot is one statement for all the people', () => {
  it('the number of side queries does not grow with the number of joiners', async () => {
    const make = (n) => Array.from({ length: n }, (_, i) => ({ id: String(300000 + i), name: `P${i}`, discordName: `d${i}`, linked: false, className: 'Tố Vấn', rolePref: 'any', createdAt: new Date(2026, 10, 1, 12, 0, i) }));
    const war = (id) => ({ _id: id, title: 'T', startAt: START, status: 'locked' });
    sideCalls = 0;
    await actSnapshot.writeSnapshot({ guild: guildSnapshot(G), war: war('a'.repeat(24)), joiners: make(3) });
    const few = sideCalls;
    sideCalls = 0;
    await actSnapshot.writeSnapshot({ guild: guildSnapshot(G), war: war('b'.repeat(24)), joiners: make(40) });
    assert.equal(sideCalls, few);
    assert.equal((await lineupService.listMembers('b'.repeat(24))).length, 40);
    await actSnapshot.writeSnapshot({ guild: guildSnapshot(G), war: war('b'.repeat(24)), joiners: make(40) }); // re-lock: same rows
    assert.equal((await lineupService.listMembers('b'.repeat(24))).length, 40);
  });
});

describe('board changes are atomic', () => {
  it('several people added at once, each with a task: none of the tasks or the version bumps is lost', async () => {
    await snapshot(w);
    const results = await Promise.all(['A', 'B', 'C', 'D'].map((n, i) => lineupService.addManualMember({ warId: w.warId, guildId: G, userId: 'u', name: `Khách ${n}`, className: 'Tố Vấn', task: ['def', 'cong', 'daytru', 'vattu'][i] })));
    assert.ok(results.every((r) => r.ok), JSON.stringify(results));
    const row = await lineupService.getLineup(w.warId);
    assert.equal(row.version, 4);
    assert.deepEqual(Object.values(row.tasks).sort(), ['cong', 'daytru', 'def', 'vattu']);
    assert.equal((await lineupService.listMembers(w.warId)).filter((m) => m.manual).length, 4);
  });
  it('a failing member change leaves nothing behind (no member without its lineup effect)', async () => {
    await snapshot(w);
    const real = side.q;
    // the lineup update (the last step of the transaction) fails: the member insert must roll back with it
    side.q = (sql, ...rest) => {
      if (/^update act_lineups set version = version \+ 1/.test(String(sql).trim())) throw new Error('boom');
      return real(sql, ...rest);
    };
    try {
      await assert.rejects(() => lineupService.addManualMember({ warId: w.warId, guildId: G, userId: 'u', name: 'Khách', className: 'Tố Vấn' }), /boom/);
    } finally {
      side.q = real;
    }
    assert.equal((await lineupService.listMembers(w.warId)).filter((m) => m.manual).length, 0);
  });
});

describe('guards', () => {
  it('a side URL on the main database host is refused; ACTIVITY_PG_URL wins over DATABASE_URL', () => {
    const env = { PG_URL: 'postgres://u:p@pg-main.aivencloud.com:1234/db', DATABASE_URL: 'postgres://u:p@PG-MAIN.aivencloud.com/other' };
    assert.equal(side.urlOf(env), null);
    assert.match(side.refusalOf(), /main database/);
    assert.equal(side.urlOf({ ...env, ACTIVITY_PG_URL: 'postgres://u:p@ep-x.neon.tech/neondb' }), 'postgres://u:p@ep-x.neon.tech/neondb');
    assert.equal(side.refusalOf(), null);
    assert.equal(side.urlOf({ DATABASE_URL: 'postgres://u:p@ep-x.neon.tech/neondb' }), 'postgres://u:p@ep-x.neon.tech/neondb', 'no PG_URL (Render): fine');
  });
  it('the side pool has deadlines, keepAlive and short idle sockets; the main pool keeps its settings', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'db.js'), 'utf8');
    const side_ = /async function connectUrl[\s\S]*?new Pool\(\{([^}]*)\}\)/.exec(src)[1];
    assert.match(side_, /idleTimeoutMillis: 30000/);
    assert.match(side_, /query_timeout: 10000/);
    assert.match(side_, /keepAlive: true/);
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'config', 'pg.js'), 'utf8'), /idleTimeoutMillis: 60000/);
  });
  it('the Neon tooling is dev-only and never part of the exe', () => {
    const pkg = require('../package.json');
    for (const k of ['@neon/config', '@neon/env']) {
      assert.ok(!(k in pkg.dependencies), k);
      assert.ok(k in pkg.devDependencies, k);
    }
    assert.ok(!pkg.pkg.scripts.some((g) => /neon/.test(g)) && !pkg.pkg.assets.some((g) => /neon/.test(g)));
  });
});
