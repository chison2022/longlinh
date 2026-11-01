// The Activity's lineup storage on an in-memory PostgreSQL: validation, optimistic concurrency, publish request / claim / mark.
const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { setupDb, resetDb } = require('./pgdb');
const svc = require('../src/services/lineupService');
const rules = require('../src/services/lineupRules');
const reg = require('../src/services/registrationService');
const { seedWar } = require('./lineupFixture');
const { sid } = require('./helpers');

const SHAPE = { groupCount: 2, partiesPerGroup: 5, partySize: 6 };
const layoutWith = (...parties) => {
  const l = rules.emptyLayout(SHAPE);
  parties.forEach((ids, i) => (l.groups[0][i] = ids));
  return l;
};
let w;

before(setupDb);
beforeEach(async () => {
  await resetDb();
  w = await seedWar({ classes: ['Tố Vấn', 'Thiết Y', 'Huyết Hà', 'Huyết Hà', 'Toái Mộng'] });
});
const save = (layout, expectedVersion, extra = {}) => svc.saveLineup({ warId: w.warId, guildId: w.guildId, layout, expectedVersion, userId: 'u1', ...extra });

describe('rules (pure)', () => {
  it('validateLayout checks groups, parties, size and duplicates', () => {
    assert.equal(rules.validateLayout({ groups: [] }, SHAPE).ok, false);
    assert.equal(rules.validateLayout(layoutWith([sid(1), sid(1)]), SHAPE).ok, false, 'twice');
    assert.equal(rules.validateLayout(layoutWith(Array.from({ length: 7 }, (_, i) => sid(i + 1))), SHAPE).ok, false, 'seven in a PT');
    assert.equal(rules.validateLayout(layoutWith([123]), SHAPE).ok, false, 'not a string');
    assert.equal(rules.validateLayout(layoutWith([sid(1), sid(2)]), SHAPE).ok, true);
  });
  it('partyWarnings flags a missing healer / tank, accepts Map or object, ignores an empty party', () => {
    const classes = { a: '🛡️ Thiết Y', b: 'Huyết Hà', c: 'Tố Vấn' };
    assert.deepEqual(svc.partyWarnings(['a', 'b'], classes), { missingHealer: true, missingTank: false });
    assert.deepEqual(svc.partyWarnings(['a', 'c'], new Map(Object.entries(classes))), { missingHealer: false, missingTank: false });
    assert.deepEqual(svc.partyWarnings(['b'], classes), { missingHealer: true, missingTank: true });
    assert.deepEqual(svc.partyWarnings([], classes), { missingHealer: false, missingTank: false });
  });
  it('moveInLayout: append, swap, back to the pool, full PT', () => {
    let l = rules.emptyLayout(SHAPE);
    const slot = (party, s) => ({ type: 'slot', group: 0, party, slot: s });
    l = rules.moveInLayout(l, '11111', slot(0, 0));
    l = rules.moveInLayout(l, '22222', slot(0, 5));
    assert.deepEqual(l.groups[0][0], ['11111', '22222'], 'an empty slot appends');
    l = rules.moveInLayout(l, '33333', slot(1, 0));
    l = rules.moveInLayout(l, '33333', slot(0, 0));
    assert.deepEqual(l.groups[0][0], ['33333', '22222'], 'a filled slot swaps, the occupant takes the old place');
    assert.deepEqual(l.groups[0][1], ['11111']);
    l = rules.moveInLayout(l, '22222', slot(1, 3));
    l = rules.moveInLayout(l, '33333', slot(1, 0));
    assert.deepEqual([l.groups[0][0], l.groups[0][1]], [['11111'], ['33333', '22222']], 'swapping across PTs');
    assert.deepEqual(rules.moveInLayout(l, '11111', { type: 'pool' }).groups[0][0], []);
    const same = rules.moveInLayout(l, 'nobody', { type: 'pool' });
    assert.equal(same, l, 'nothing to do returns the same object');
  });
});

describe('saveLineup', () => {
  it('first save creates version 1, the next needs the current version', async () => {
    const first = await save(layoutWith([w.ids[0], w.ids[1]]), 0);
    assert.equal(first.ok, true);
    assert.equal(first.lineup.version, 1);
    const second = await save(layoutWith([w.ids[1], w.ids[0]]), 1);
    assert.equal(second.lineup.version, 2);
    assert.deepEqual((await svc.getLineup(w.warId)).layout.groups[0][0], [w.ids[1], w.ids[0]]);
  });
  it('a stale version is a conflict that returns the current row, and changes nothing', async () => {
    await save(layoutWith([w.ids[0]]), 0);
    const stale = await save(layoutWith([w.ids[2]]), 0);
    assert.equal(stale.conflict, true);
    assert.equal(stale.current.version, 1);
    assert.deepEqual(stale.current.layout.groups[0][0], [w.ids[0]]);
    const stale2 = await save(layoutWith([w.ids[2]]), 7);
    assert.equal(stale2.conflict, true);
  });
  it('drops ids that are not joined (absent / not registered)', async () => {
    await reg.upsertRegistration({ eventId: w.warId, guildId: w.guildId, discordId: w.ids[4], displayName: 'x', status: 'absent', className: null });
    const out = await save(layoutWith([w.ids[0], w.ids[4], sid(999)]), 0);
    assert.deepEqual(out.lineup.layout.groups[0][0], [w.ids[0]]);
  });
  it('rejects a bad shape, a duplicate, another guild and a finished war', async () => {
    assert.match((await save({ groups: [] }, 0)).error, /Nhóm/);
    assert.match((await save(layoutWith([w.ids[0]], [w.ids[0]]), 0)).error, /hai lần/);
    assert.match((await save(layoutWith([w.ids[0]]), 0, { guildId: '800000000000000002' })).error, /không tồn tại/);
    await db.q("update war_events set status = 'done' where id = $1", [w.warId]);
    assert.match((await save(layoutWith([w.ids[0]]), 0)).error, /kết thúc/);
  });
  it('listJoiners is in sign-up order and only joiners', async () => {
    await reg.upsertRegistration({ eventId: w.warId, guildId: w.guildId, discordId: sid(50), displayName: 'Vắng', status: 'absent', className: 'Tố Vấn' });
    const list = await svc.listJoiners(w.warId);
    assert.deepEqual(list.map((j) => j.id), w.ids);
  });
});

describe('publish request', () => {
  it('request -> claim -> markPublished; nothing pending afterwards', async () => {
    await save(layoutWith([w.ids[0]]), 0);
    assert.deepEqual(await svc.claimPendingPublishes(), []);
    const row = await svc.requestPublish(w.warId, 'u1', w.guildId);
    assert.ok(row.publishRequestedAt);
    const pending = await svc.claimPendingPublishes();
    assert.equal(pending.length, 1);
    assert.equal(await svc.markPublished(w.warId, pending[0].version, pending[0].publishRequestedAt), true);
    assert.deepEqual(await svc.claimPendingPublishes(), []);
    const done = await svc.getLineup(w.warId);
    assert.equal(done.publishedVersion, 1);
    assert.ok(done.publishedAt >= done.publishRequestedAt);
  });
  it('a request made while the post is in flight stays pending', async () => {
    await save(layoutWith([w.ids[0]]), 0);
    await svc.requestPublish(w.warId, 'u1');
    const [claimed] = await svc.claimPendingPublishes();
    await new Promise((r) => setTimeout(r, 5));
    await svc.requestPublish(w.warId, 'u2');
    await svc.markPublished(w.warId, claimed.version, claimed.publishRequestedAt);
    assert.equal((await svc.claimPendingPublishes()).length, 1, 'the second request is still waiting');
  });
  it('an error is not retried until a new request, which clears it; a warning keeps the publish done', async () => {
    await svc.requestPublish(w.warId, 'u1');
    await svc.markPublishError(w.warId, 'không gửi được');
    assert.deepEqual(await svc.claimPendingPublishes(), []);
    assert.equal((await svc.getLineup(w.warId)).publishError, 'không gửi được');
    await svc.requestPublish(w.warId, 'u1');
    assert.equal((await svc.getLineup(w.warId)).publishError, null);
    const [row] = await svc.claimPendingPublishes();
    await svc.markPublished(w.warId, row.version, row.publishRequestedAt, 'Sheet lỗi');
    assert.deepEqual(await svc.claimPendingPublishes(), []);
    assert.equal((await svc.getLineup(w.warId)).publishError, 'Sheet lỗi');
  });
  it('refuses a finished war or another guild', async () => {
    assert.equal(await svc.requestPublish(w.warId, 'u1', '800000000000000002'), null);
    await db.q("update war_events set status = 'done' where id = $1", [w.warId]);
    assert.equal(await svc.requestPublish(w.warId, 'u1', w.guildId), null);
  });
});

describe('claim and request matching', () => {
  it('claiming is atomic: a second claim gets nothing, a claim older than 2 minutes is taken over', async () => {
    await svc.requestPublish(w.warId, 'u1');
    assert.equal((await svc.claimPendingPublishes()).length, 1);
    assert.deepEqual(await svc.claimPendingPublishes(), []);
    await db.q("update war_lineups set claimed_at = now() - interval '3 minutes' where war_id = $1", [w.warId]);
    assert.equal((await svc.claimPendingPublishes()).length, 1);
  });
  it('markPublished stores the posted layout and releases the claim', async () => {
    await svc.requestPublish(w.warId, 'u1');
    const [row] = await svc.claimPendingPublishes();
    const posted = layoutWith([w.ids[0]]);
    await svc.markPublished(w.warId, 3, row.publishRequestedAt, null, posted);
    const after = await svc.getLineup(w.warId);
    assert.deepEqual(after.publishedLayout, posted);
    assert.equal(after.claimedAt, null);
    assert.equal(after.publishedVersion, 3);
  });
  it('an error or warning of an OLD request does not stick to a newer one', async () => {
    await svc.requestPublish(w.warId, 'u1');
    const [old] = await svc.claimPendingPublishes();
    await new Promise((r) => setTimeout(r, 5));
    await svc.requestPublish(w.warId, 'u2');
    await svc.markPublishError(w.warId, 'lỗi của yêu cầu cũ', old.publishRequestedAt);
    const row = await svc.getLineup(w.warId);
    assert.equal(row.publishError, null);
    assert.equal(row.claimedAt, null);
    assert.equal((await svc.claimPendingPublishes()).length, 1, 'the newer request is still served');
    await svc.markPublished(w.warId, 1, old.publishRequestedAt, 'cảnh báo cũ');
    assert.equal((await svc.getLineup(w.warId)).publishError, null);
  });
  it('reshapeLayout keeps the people who still fit', () => {
    const wide = { groups: [[['a', 'a', 'b']], [['c']], [['d']]] };
    const out = rules.reshapeLayout(wide, { groupCount: 2, partiesPerGroup: 2, partySize: 2 });
    assert.deepEqual(out.groups, [[['a', 'b'], []], [['c'], []]]);
    assert.deepEqual(rules.reshapeLayout(null, { groupCount: 1, partiesPerGroup: 1, partySize: 1 }).groups, [[[]]]);
  });
});

describe('migration', () => {
  it('war_lineups exists and the migration is idempotent', async () => {
    await db.ensureSchema();
    await db.ensureSchema();
    assert.equal((await db.q("select to_regclass('public.war_lineups') as t"))[0].t, 'war_lineups');
  });
});
