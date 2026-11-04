// The Activity's lineup storage on an in-memory PostgreSQL: validation, optimistic concurrency, publish request / claim / mark.
const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { setupDb, resetDb } = require('./pgdb');
const { setupSide, resetSide } = require('./sidedb');
const side = require('../src/sideDb');
const svc = require('../src/services/lineupService');
const rules = require('../src/services/lineupRules');
const reg = require('../src/services/registrationService');
const { seedWar, snapshot } = require('./lineupFixture');
const { sid } = require('./helpers');

const SHAPE = { groupCount: 2, partiesPerGroup: 5, partySize: 6 };
const layoutWith = (...parties) => {
  const l = rules.emptyLayout(SHAPE);
  parties.forEach((ids, i) => (l.groups[0][i] = ids));
  return l;
};
let w;

before(async () => {
  await setupDb();
  await setupSide();
});
beforeEach(async () => {
  await resetDb();
  await resetSide();
  w = await seedWar({ classes: ['Tố Vấn', 'Thiết Y', 'Huyết Hà', 'Huyết Hà', 'Toái Mộng'] });
  await snapshot(w);
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
    await svc.removeMember({ warId: w.warId, guildId: w.guildId, userId: 'u1', key: w.ids[4] });
    const out = await save(layoutWith([w.ids[0], w.ids[4], sid(999)]), 1); // removing a person moved the version to 1
    assert.deepEqual(out.lineup.layout.groups[0][0], [w.ids[0]]);
  });
  it('rejects a bad shape, a duplicate, another guild and a finished war', async () => {
    assert.match((await save({ groups: [] }, 0)).error, /Nhóm/);
    assert.match((await save(layoutWith([w.ids[0]], [w.ids[0]]), 0)).error, /hai lần/);
    assert.match((await save(layoutWith([w.ids[0]]), 0, { guildId: '800000000000000002' })).error, /không tồn tại/);
    await side.q("update act_wars set status = 'done' where war_id = $1", [w.warId]);
    assert.match((await save(layoutWith([w.ids[0]]), 0)).error, /kết thúc/);
  });
  it('listMembers is in sign-up order and holds only the people who count', async () => {
    await svc.removeMember({ warId: w.warId, guildId: w.guildId, userId: 'u1', key: w.ids[1] });
    assert.deepEqual((await svc.listMembers(w.warId)).map((j) => j.id), w.ids.filter((id) => id !== w.ids[1]));
    assert.deepEqual((await svc.listMembers(w.warId, { removed: true })).map((j) => j.id), [w.ids[1]]);
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
    await side.q("update act_wars set status = 'done' where war_id = $1", [w.warId]);
    assert.equal(await svc.requestPublish(w.warId, 'u1', w.guildId), null);
  });
});

describe('claim and request matching', () => {
  it('claiming is atomic: a second claim gets nothing, a claim older than 2 minutes is taken over', async () => {
    await svc.requestPublish(w.warId, 'u1');
    assert.equal((await svc.claimPendingPublishes()).length, 1);
    assert.deepEqual(await svc.claimPendingPublishes(), []);
    await side.q("update act_lineups set claimed_at = now() - interval '3 minutes' where war_id = $1", [w.warId]);
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

describe('tasks and PT notes', () => {
  const keysOf = async () => new Set((await svc.listTasks(w.guildId)).map((t) => t.key));
  it('validateTasks: only placed people, unknown keys refused, "" kept as an explicit none', () => {
    const valid = new Set(['def', 'c:x']);
    assert.deepEqual(rules.validateTasks({ a: 'def', b: '', z: 'c:x' }, ['a', 'b'], valid), { ok: true, tasks: { a: 'def', b: '' } });
    assert.equal(rules.validateTasks({ a: 'nope' }, ['a'], valid).ok, false);
    assert.equal(rules.validateTasks([], ['a'], valid).ok, false);
    assert.deepEqual(rules.validateTasks(undefined, ['a'], valid), { ok: true, tasks: {} });
  });
  it('notes are trimmed, capped at 80 chars, mentions and @ stripped, strange keys dropped', () => {
    const out = rules.validateNotes({ '0-0': '  hi   @everyone <@123456> @here  ', '1-4': 'x'.repeat(200), '5-0': 'out', '0-9': 'out', bad: 'x', '0-1': '   ' }, SHAPE).notes;
    assert.deepEqual(Object.keys(out).sort(), ['0-0', '1-4']);
    assert.equal(out['0-0'], 'hi everyone here');
    assert.equal(out['1-4'].length, 80);
  });
  it('taskOfWish / effectiveTasks: the own wish is the default, any = none, an explicit choice wins', () => {
    assert.equal(rules.taskOfWish('daytru'), 'daytru');
    assert.equal(rules.taskOfWish('mobile'), 'daytru');
    assert.equal(rules.taskOfWish('any'), null);
    const l = layoutWith(['a', 'b', 'c']);
    assert.deepEqual(rules.effectiveTasks(l, { b: 'vattu', c: '' }, (id) => ({ a: 'def', b: 'cong', c: 'cong' })[id]), { a: 'def', b: 'vattu', c: '' });
  });
  it('readSnapshot reads old layout-only snapshots and the new shape', () => {
    const l = layoutWith(['a']);
    assert.deepEqual(rules.readSnapshot(l), { layout: l, tasks: {}, notes: {}, names: {} });
    assert.deepEqual(rules.readSnapshot({ layout: l, tasks: { a: 'def' }, notes: { '0-0': 'n' }, names: { def: { label: 'Def' } } }).tasks, { a: 'def' });
    assert.equal(rules.readSnapshot(null), null);
    assert.equal(rules.readSnapshot({}), null);
  });
  it('pruneExtras follows a reshaped layout', () => {
    const l = layoutWith(['a']);
    assert.deepEqual(rules.pruneExtras(l, { a: 'def', gone: 'cong' }, { '0-0': 'n', '1-1': 'm', '7-0': 'x' }, SHAPE), { tasks: { a: 'def' }, notes: { '0-0': 'n', '1-1': 'm' } });
    assert.deepEqual(rules.pruneExtras(l, {}, { '1-0': 'm' }, { groupCount: 1, partiesPerGroup: 5, partySize: 6 }).notes, {});
  });
  it('saveLineup stores tasks and notes under the same version; stale versions still conflict; unknown tasks are refused', async () => {
    const l = layoutWith([w.ids[0], w.ids[1]]);
    const ok = await save(l, 0, { tasks: { [w.ids[0]]: 'cong', [w.ids[1]]: '', [w.ids[3]]: 'def' }, partyNotes: { '0-0': 'PT1 giữ trụ' } });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.lineup.tasks, { [w.ids[0]]: 'cong', [w.ids[1]]: '', [w.ids[3]]: 'def' }, 'a listed person keeps his task even when not placed; keys not on the list are dropped');
    assert.deepEqual(ok.lineup.partyNotes, { '0-0': 'PT1 giữ trụ' });
    assert.equal((await save(l, 0, { tasks: {} })).conflict, true);
    assert.match((await save(l, 1, { tasks: { [w.ids[0]]: 'c:khong-co' } })).error, /Nhiệm vụ/);
    const keep = await save(l, 1, {}); // nothing sent: tasks and notes are left alone
    assert.deepEqual(keep.lineup.tasks, { [w.ids[0]]: 'cong', [w.ids[1]]: '', [w.ids[3]]: 'def' });
    assert.equal((await save(l, 2, { tasks: {}, partyNotes: {} })).lineup.partyNotes['0-0'], undefined);
  });
  it('custom tasks: add, rename, limits, duplicates; a custom key is accepted by saveLineup', async () => {
    const added = await svc.addTask(w.guildId, { label: '  Thủ trụ giữa @all ', emoji: '🏰' });
    assert.equal(added.ok, true);
    const mine = added.tasks.find((t) => !t.builtin);
    assert.deepEqual([mine.key, mine.label, mine.emoji], ['c:thu-tru-giua-all', 'Thủ trụ giữa all', '🏰']);
    assert.equal(added.tasks.length, 5);
    assert.match((await svc.addTask(w.guildId, { label: 'thủ trụ giữa all' })).error, /trùng/);
    assert.match((await svc.addTask(w.guildId, { label: '' })).error, /trống/);
    assert.match((await svc.addTask(w.guildId, { label: 'abc', emoji: 'chữ' })).error, /emoji/);
    assert.equal((await svc.renameTask(w.guildId, mine.key, { label: 'Giữ trụ', emoji: '' })).tasks[4].label, 'Giữ trụ');
    assert.match((await svc.renameTask(w.guildId, 'c:khong', { label: 'x' })).error, /không tồn tại/);
    for (let i = 0; i < 14; i++) await svc.addTask(w.guildId, { label: `Việc ${i}` });
    assert.match((await svc.addTask(w.guildId, { label: 'Quá nhiều' })).error, /Tối đa 15/);
    assert.equal((await save(layoutWith([w.ids[0]]), 0, { tasks: { [w.ids[0]]: mine.key } })).ok, true);
  });
  it('deleting a task in use sends its holders back to "Chưa giao" and moves the version; the other guild is untouched', async () => {
    const t = (await svc.addTask(w.guildId, { label: 'Gọi boss' })).tasks.find((x) => !x.builtin);
    await save(layoutWith([w.ids[0], w.ids[1]]), 0, { tasks: { [w.ids[0]]: t.key, [w.ids[1]]: 'cong' } });
    const out = await svc.deleteTask(w.guildId, t.key);
    assert.equal(out.affected, 1);
    assert.equal(out.tasks.length, 4);
    const row = await svc.getLineup(w.warId);
    assert.deepEqual(row.tasks, { [w.ids[0]]: '', [w.ids[1]]: 'cong' });
    assert.equal(row.version, 2);
    assert.match((await svc.deleteTask(w.guildId, t.key)).error, /không tồn tại/);
    assert.ok(!(await keysOf()).has(t.key));
  });
});

describe('side schema', () => {
  it('act_* tables exist and the schema script is idempotent', async () => {
    await side.ensureSideSchema();
    await side.ensureSideSchema();
    assert.equal((await side.q("select to_regclass('public.act_lineups') as t"))[0].t, 'act_lineups');
  });
  it('the main database has no lineup tables any more', async () => {
    assert.equal((await db.q("select to_regclass('public.war_lineups') as a, to_regclass('public.lineup_tasks') as b"))[0].a, null);
    assert.equal((await db.q("select to_regclass('public.lineup_tasks') as b"))[0].b, null);
  });
});
