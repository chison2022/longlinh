// Bot side of the Activity lineup: the PNG table, the "Xem PT của tôi" button and the publish job (fake channel, PGlite, fake Sheets).
const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { setupDb, resetDb } = require('./pgdb');
const { setupSide, resetSide } = require('./sidedb');
const side = require('../src/sideDb');
const lineupService = require('../src/services/lineupService');
const rules = require('../src/services/lineupRules');
const warService = require('../src/services/warService');
const refresher = require('../src/bot/refresher');
const gateway = require('../src/services/sheets/gateway');
const { clearConfigCache } = require('../src/services/guildConfigService');
const { renderLineupPng } = require('../src/bot/ui/lineupImage');
const { handle, mineText, NOT_PLACED, NOT_PUBLISHED } = require('../src/bot/interactions/lineup');
const publisher = require('../src/jobs/lineupPublisher');
const { buildLineupTab, LINEUP_TAB } = require('../src/services/sheets/lineupTab');
const { createFakeSheets } = require('./fakeSheets');
const { seedWar, snapshot, G } = require('./lineupFixture');

const SHAPE = { groupCount: 2, partiesPerGroup: 5, partySize: 6 };
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const CHANNEL = '810000000000000001';
const FAST = { backoffMs: 1 };

describe('lineupImage', () => {
  it('renders a PNG for a full 60-person lineup and for an empty one, with long and emoji names', async () => {
    const layout = rules.emptyLayout(SHAPE);
    const people = {};
    let n = 0;
    for (const group of layout.groups) {
      for (const party of group) {
        for (let s = 0; s < 6; s++) {
          const id = String(100000000000000000 + ++n);
          party.push(id);
          people[id] = { name: n % 7 === 0 ? 'Tên rất dài của một người chơi 😀🔥 Nguyễn Văn' : `Người ${n}`, className: ['Thiết Y', 'Tố Vấn', 'Huyết Hà', 'Chưa rõ'][n % 4] };
        }
      }
    }
    const classes = ['Thiết Y', 'Tố Vấn', 'Huyết Hà'];
    const full = await renderLineupPng({ title: 'Bang chiến T7 (05/12)', subtitle: 'T7 05/12 20:00–21:00', layout, people, classes }, { fetchFn: null });
    assert.deepEqual(full.subarray(0, 4), PNG_MAGIC);
    const empty = await renderLineupPng({ title: 'x', layout: rules.emptyLayout(SHAPE), classes }, { fetchFn: null });
    assert.deepEqual(empty.subarray(0, 4), PNG_MAGIC);
    assert.ok(full.length > empty.length);
  });
});

describe('lineupImage with tasks and notes', () => {
  it('renders taller rows with a task line and a wrapped PT note', async () => {
    const layout = rules.emptyLayout(SHAPE);
    layout.groups[0][0] = ['1', '2'];
    const people = { 1: { name: 'A', className: 'Thiết Y', task: 'Đẩy trụ' }, 2: { name: 'B', className: 'Tố Vấn', task: '' } };
    const plain = await renderLineupPng({ title: 't', layout, people, classes: [] }, { fetchFn: null });
    const withTask = await renderLineupPng({ title: 't', layout, people, notes: { '0-0': 'PT1 giữ trụ giữa, không đuổi theo địch quá xa khỏi trụ nhà nhé các bạn' }, classes: [] }, { fetchFn: null });
    assert.deepEqual(withTask.subarray(0, 4), PNG_MAGIC);
    const dim = (png) => ({ w: png.readUInt32BE(16), h: png.readUInt32BE(20) });
    assert.ok(dim(withTask).h > dim(plain).h, 'taller');
  });
});

describe('lu:mine', () => {
  before(async () => {
    await setupDb();
    await setupSide();
  });
  beforeEach(async () => {
    await resetDb();
    await resetSide();
    clearConfigCache();
  });
  const click = (userId, guildId = G) => {
    const replies = [];
    const calls = {};
    return { interaction: { guildId, user: { id: userId }, reply: async (p) => replies.push(p), deferReply: async (o) => { calls.deferred = o; }, editReply: async (p) => replies.push(p) }, replies, calls };
  };

  it('answers privately with the Nhóm, the PT and the party mates; mentions nobody', async () => {
    const w = await seedWar({ classes: ['Tố Vấn', 'Thiết Y', 'Huyết Hà'] });
    await snapshot(w);
    const layout = rules.emptyLayout(SHAPE);
    layout.groups[1][2] = [w.ids[2], w.ids[0]];
    assert.equal((await lineupService.saveLineup({ warId: w.warId, guildId: G, layout, expectedVersion: 0, userId: 'u' })).ok, true);
    const { interaction, replies, calls } = click(w.ids[0]);
    await handle(interaction, ['lu', 'mine', w.warId]);
    assert.ok(calls.deferred.flags, 'deferred as ephemeral before any database work');
    assert.equal(replies[0].content, NOT_PUBLISHED, 'saved but not published yet');
    replies.length = 0;
    await lineupService.requestPublish(w.warId, 'u');
    await lineupService.markPublished(w.warId, 1, null, null, layout);
    // an edit after the publish does not change what the button answers
    const edited = rules.emptyLayout(SHAPE);
    edited.groups[0][0] = [w.ids[0]];
    await lineupService.saveLineup({ warId: w.warId, guildId: G, layout: edited, expectedVersion: 1, userId: 'u' });
    await handle(interaction, ['lu', 'mine', w.warId]);
    assert.equal(replies.length, 1);
    assert.match(replies[0].content, /Nhóm 2 – PT 3/);
    assert.match(replies[0].content, /Người 1.*← bạn/);
    assert.match(replies[0].content, /Người 3/);
    assert.deepEqual(replies[0].allowedMentions, { parse: [] });
  });
  it('says so when the member is not placed, the war has no lineup, or it is another guild', async () => {
    const w = await seedWar({ classes: ['Tố Vấn', 'Thiết Y'] });
    await snapshot(w);
    const layout = rules.emptyLayout(SHAPE);
    layout.groups[0][0] = [w.ids[0]];
    await lineupService.saveLineup({ warId: w.warId, guildId: G, layout, expectedVersion: 0, userId: 'u' });
    await lineupService.markPublished(w.warId, 1, null, null, layout);
    const a = click(w.ids[1]);
    await handle(a.interaction, ['lu', 'mine', w.warId]);
    assert.equal(a.replies[0].content, NOT_PLACED);
    const b = click(w.ids[0], '800000000000000002');
    await handle(b.interaction, ['lu', 'mine', w.warId]);
    assert.match(b.replies[0].content, /Chưa có đội hình/);
    const c = click(w.ids[0]);
    await handle(c.interaction, ['lu', 'mine', 'not-an-id']);
    assert.match(c.replies[0].content, /Chưa có đội hình/);
  });
  it('mineText is pure', () => {
    const l = rules.emptyLayout(SHAPE);
    l.groups[0][0] = ['1', '2'];
    assert.match(mineText(l, { 1: { name: 'A', className: '🛡️ Thiết Y' }, 2: { name: 'B', className: '' } }, '1'), /Nhóm 1 – PT 1[\s\S]*A \(Thiết Y\) ← bạn[\s\S]*B/);
  });
});

describe('lineup publish job', () => {
  let w;
  let sent;
  let channel;
  let client;
  let refreshes;
  const real = { scheduleRefresh: refresher.scheduleRefresh, schedulePanelRefresh: refresher.schedulePanelRefresh };
  before(async () => {
    await setupDb();
    await setupSide();
  });
  beforeEach(async () => {
    await resetDb();
    await resetSide();
    clearConfigCache();
    gateway.setClient(null);
    refreshes = [];
    refresher.scheduleRefresh = (...a) => refreshes.push(['war', a[1]]);
    refresher.schedulePanelRefresh = (...a) => refreshes.push(['panel', a[1]]);
    w = await seedWar({ classes: ['Tố Vấn', 'Thiết Y', 'Huyết Hà'] });
    await snapshot(w);
    await db.q("update war_events set status = 'locked' where id = $1", [w.warId]); // registration is closed: the board may publish
    sent = [];
    channel = { send: async (p) => sent.push(p) };
    client = { channels: { fetch: async (id) => (id === CHANNEL ? channel : Promise.reject(new Error('Unknown Channel'))) }, guilds: { cache: new Map() } };
    await db.q('update war_events set channel_id = $2 where id = $1', [w.warId, CHANNEL]);
    const layout = rules.emptyLayout(SHAPE);
    layout.groups[0][0] = [w.ids[0], w.ids[1]];
    await lineupService.saveLineup({ warId: w.warId, guildId: G, layout, expectedVersion: 0, userId: 'u' });
  });
  afterEach(() => {
    Object.assign(refresher, real);
    gateway.setClient(null);
  });

  it('posts the image with the button, mentions nobody, publishes the war and marks the lineup', async () => {
    await lineupService.requestPublish(w.warId, 'u');
    const out = await publisher.runOnce(client, FAST);
    assert.deepEqual(out, [[w.warId, 'posted']]);
    assert.equal(sent.length, 1);
    const post = sent[0];
    assert.deepEqual(post.allowedMentions, { parse: [] });
    assert.equal(post.files.length, 1);
    assert.equal(post.components[0].components[0].data.custom_id, `lu:mine:${w.warId}`);
    assert.equal((await warService.getEvent(w.warId)).status, 'published');
    const row = await lineupService.getLineup(w.warId);
    assert.equal(row.publishedVersion, 1);
    assert.equal(row.publishError, null);
    assert.deepEqual(row.publishedLayout.layout.groups[0][0], [w.ids[0], w.ids[1]], 'the posted layout is kept');
    assert.equal(row.publishedLayout.tasks[w.ids[0]], '', 'no wish, no task');
    assert.equal(row.claimedAt, null);
    assert.deepEqual(refreshes.map((r) => r[0]).sort(), ['panel', 'war']);
    assert.deepEqual(await publisher.runOnce(client, FAST), [], 'nothing pending any more: not posted twice');
    assert.equal(sent.length, 1);
  });
  it('refuses to publish while registration is open again, with a message for the board', async () => {
    await db.q("update war_events set status = 'open' where id = $1", [w.warId]);
    await lineupService.requestPublish(w.warId, 'u');
    assert.deepEqual(await publisher.runOnce(client, FAST), [[w.warId, 'failed']]);
    assert.equal(sent.length, 0);
    assert.match((await lineupService.getLineup(w.warId)).publishError, /Đăng ký đang mở lại/);
    await db.q("update war_events set status = 'locked' where id = $1", [w.warId]); // locked again: a new request goes through
    await lineupService.requestPublish(w.warId, 'u');
    assert.deepEqual(await publisher.runOnce(client, FAST), [[w.warId, 'posted']]);
  });
  it('the post is on record right after it is sent: a restart finishes the bookkeeping and never sends it twice', async () => {
    await lineupService.requestPublish(w.warId, 'u');
    const real = lineupService.markPublished;
    lineupService.markPublished = async () => {
      throw new Error('db down');
    };
    try {
      assert.deepEqual(await publisher.runOnce(client, FAST), [[w.warId, 'posted']]);
    } finally {
      lineupService.markPublished = real;
    }
    assert.equal(sent.length, 1);
    const row = await lineupService.getLineup(w.warId);
    assert.ok(row.sentFor && row.sentSnapshot.layout, 'sent marker with the posted snapshot');
    assert.equal(row.publishedAt, null, 'the bookkeeping did not finish');
    // "restart": the in-memory memory is gone, the claim is free again
    publisher.served.clear();
    await side.q('update act_lineups set claimed_at = null where war_id = $1', [w.warId]);
    assert.deepEqual(await publisher.runOnce(client, FAST), [[w.warId, 'posted']]);
    assert.equal(sent.length, 1, 'not posted again');
    const after = await lineupService.getLineup(w.warId);
    assert.ok(after.publishedAt);
    assert.deepEqual(after.publishedLayout.layout, row.sentSnapshot.layout);
    assert.equal((await warService.getEvent(w.warId)).status, 'published');
  });
  it('overlapping runs post once', async () => {
    await lineupService.requestPublish(w.warId, 'u');
    await Promise.all([publisher.runOnce(client, FAST), publisher.runOnce(client, FAST)]);
    assert.equal(sent.length, 1);
  });
  it('falls back to the announce channel when the war has none', async () => {
    await db.q('update war_events set channel_id = null where id = $1', [w.warId]);
    await db.q('update guilds set settings = $2 where id = $1', [G, JSON.stringify({ announceChannelId: CHANNEL })]);
    clearConfigCache();
    await lineupService.requestPublish(w.warId, 'u');
    assert.deepEqual(await publisher.runOnce(client, FAST), [[w.warId, 'posted']]);
  });
  it('a channel that cannot be reached records the error and is not retried', async () => {
    await db.q('update war_events set channel_id = $2 where id = $1', [w.warId, '810000000000000009']);
    await lineupService.requestPublish(w.warId, 'u');
    assert.deepEqual(await publisher.runOnce(client, FAST), [[w.warId, 'failed']]);
    assert.match((await lineupService.getLineup(w.warId)).publishError, /Không gửi được/);
    assert.equal((await warService.getEvent(w.warId)).status, 'locked', 'the war stays as it was');
    assert.deepEqual(await publisher.runOnce(client, FAST), []);
    await db.q('update war_events set channel_id = $2 where id = $1', [w.warId, CHANNEL]);
    await lineupService.requestPublish(w.warId, 'u'); // the admin presses publish again
    assert.deepEqual(await publisher.runOnce(client, FAST), [[w.warId, 'posted']]);
  });
  it('writes the LongLinh_DoiHinh tab when the guild has a sheet', async () => {
    const fake = createFakeSheets();
    gateway.setClient(fake);
    await db.q('update guilds set settings = $2 where id = $1', [G, JSON.stringify({ sheetId: 'sheet-id-0123456789abcdef' })]);
    clearConfigCache();
    await lineupService.requestPublish(w.warId, 'u');
    assert.deepEqual(await publisher.runOnce(client, FAST), [[w.warId, 'posted']]);
    const tab = fake.sheets.get(LINEUP_TAB);
    assert.ok(tab, 'tab created');
    assert.deepEqual(tab.rows[0], ['Nhóm', 'PT', 'Vị trí', 'Tên game', 'Tên Discord', 'Phái', 'Nhiệm vụ', 'Ghi chú PT', 'Discord ID']);
    assert.deepEqual(tab.rows[1].slice(0, 6), ['1', '1', '1', '(chưa ghép)', 'Người 1', 'Tố Vấn'], 'not linked to a character: marked, Discord name in its own column');
    assert.equal((await lineupService.getLineup(w.warId)).publishError, null);
  });
  it('a sheet failure does not fail the post: the lineup is published with the warning', async () => {
    gateway.setClient(createFakeSheets({ fail: { message: 'boom', status: 403 } }));
    await db.q('update guilds set settings = $2 where id = $1', [G, JSON.stringify({ sheetId: 'sheet-id-0123456789abcdef' })]);
    clearConfigCache();
    await lineupService.requestPublish(w.warId, 'u');
    assert.deepEqual(await publisher.runOnce(client, FAST), [[w.warId, 'posted']]);
    assert.equal(sent.length, 1);
    const row = await lineupService.getLineup(w.warId);
    assert.ok(row.publishedAt);
    assert.match(row.publishError, /LongLinh_DoiHinh/);
    assert.deepEqual(await publisher.runOnce(client, FAST), [], 'no re-post because of the warning');
  });
  it('after the post went out nothing fails it: bookkeeping errors are retried, the message is never sent twice', async () => {
    const real = lineupService.markPublished;
    let calls = 0;
    lineupService.markPublished = async (...a) => {
      if (++calls <= 5) throw new Error('db down');
      return real(...a);
    };
    try {
      await lineupService.requestPublish(w.warId, 'u');
      assert.deepEqual(await publisher.runOnce(client, FAST), [[w.warId, 'posted']]);
      assert.equal(sent.length, 1);
      assert.equal((await lineupService.getLineup(w.warId)).publishError, null, 'no error recorded for a post that went out');
      assert.ok(publisher.served.size >= 1, 'remembered as posted');
      await side.q('update act_lineups set claimed_at = null where war_id = $1', [w.warId]);
      assert.deepEqual(await publisher.runOnce(client, FAST), [[w.warId, 'posted']]);
      assert.equal(sent.length, 1, 'the retry only saved the bookkeeping');
      assert.equal(publisher.served.size, 0);
      assert.ok((await lineupService.getLineup(w.warId)).publishedAt);
    } finally {
      lineupService.markPublished = real;
    }
  });
  it('a stored layout of an older shape is fitted before it is rendered', async () => {
    const wide = { groups: [rules.emptyLayout(SHAPE).groups[0], rules.emptyLayout(SHAPE).groups[0], rules.emptyLayout(SHAPE).groups[0]] };
    wide.groups[2][0] = [w.ids[2]];
    wide.groups[0][0] = [w.ids[0]];
    await side.q('update act_lineups set layout = $2 where war_id = $1', [w.warId, JSON.stringify(wide)]);
    await lineupService.requestPublish(w.warId, 'u');
    assert.deepEqual(await publisher.runOnce(client, FAST), [[w.warId, 'posted']]);
    assert.equal((await lineupService.getLineup(w.warId)).publishedLayout.layout.groups.length, 2);
  });
  it('the post carries the task of each member (own wish unless the leader chose another) and the PT notes, frozen in the snapshot', async () => {
    await side.q("update act_members set role_pref = 'daytru' where member_key = $1", [w.ids[0]]);
    await side.q("update act_members set role_pref = 'def' where member_key = $1", [w.ids[1]]);
    const custom = await lineupService.addTask(G, { label: 'Cướp cờ', emoji: '🚩' });
    const key = custom.tasks.find((t) => !t.builtin).key;
    const layout = rules.emptyLayout(SHAPE);
    layout.groups[0][0] = [w.ids[0], w.ids[1]];
    assert.equal((await lineupService.saveLineup({ warId: w.warId, guildId: G, layout, expectedVersion: 1, userId: 'u', tasks: { [w.ids[1]]: key }, partyNotes: { '0-0': 'PT1 giữ trụ @everyone' } })).ok, true);
    let renderArgs;
    await lineupService.requestPublish(w.warId, 'u');
    await publisher.runOnce(client, { backoffMs: 1, renderFn: async (d) => { renderArgs = d; return require('../src/bot/ui/lineupImage').renderLineupPng(d, { fetchFn: null }); } });
    assert.equal(renderArgs.people[w.ids[0]].task, 'Đẩy trụ');
    assert.equal(renderArgs.people[w.ids[1]].task, 'Cướp cờ');
    assert.deepEqual(renderArgs.notes, { '0-0': 'PT1 giữ trụ everyone' });
    const snap = (await lineupService.getLineup(w.warId)).publishedLayout;
    assert.deepEqual(snap.tasks, { [w.ids[0]]: 'daytru', [w.ids[1]]: key });
    assert.equal(snap.names[key].label, 'Cướp cờ');
    await lineupService.renameTask(G, key, { label: 'Đổi tên' });
    const click = (userId) => {
      const replies = [];
      return { interaction: { guildId: G, user: { id: userId }, reply: async (p) => replies.push(p), deferReply: async () => {}, editReply: async (p) => replies.push(p) }, replies };
    };
    const c = click(w.ids[1]);
    await handle(c.interaction, ['lu', 'mine', w.warId]);
    assert.match(c.replies[0].content, /Nhiệm vụ của bạn: \*\*Cướp cờ\*\*/, 'the published name, not the renamed one');
    assert.match(c.replies[0].content, /Ghi chú PT: PT1 giữ trụ everyone/);
    assert.match(c.replies[0].content, /Người 1 \(Tố Vấn · Đẩy trụ\)/);
    assert.doesNotMatch(c.replies[0].content, /@/);
  });
  it('buildLineupTab lists one row per placed person', () => {
    const l = rules.emptyLayout(SHAPE);
    l.groups[1][0] = ['9', '8'];
    const spec = buildLineupTab({ warId: 'w', layout: l, people: { 9: { name: 'N', className: 'C' } } });
    assert.deepEqual(spec.rows, [['2', '1', '1', 'N', '', 'C', '', '', '9'], ['2', '1', '2', '8', '', '', '', '', '8']]);
    const withTask = buildLineupTab({ warId: 'w', layout: l, people: { 9: { name: 'N', className: 'C', task: 'Def' } }, notes: { '1-0': 'giữ trụ giữa' } });
    assert.deepEqual(withTask.rows[0], ['2', '1', '1', 'N', '', 'C', 'Def', 'giữ trụ giữa', '9']);
    const linked = buildLineupTab({ warId: 'w', layout: l, people: { 9: { name: 'Kiếm Tâm', discordName: 'kiem_tam#1', linked: true, className: 'C' } } });
    assert.deepEqual(linked.rows[0].slice(3, 5), ['Kiếm Tâm', 'kiem_tam#1']);
    assert.equal(spec.keyOf((h) => ({ 'Discord ID': '9' })[h]), '9');
  });
});

describe('packaging', () => {
  it('the exe bundle takes src and config only: of activity/ just the schema file, and no bot module requires it', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const pkg = require('../package.json');
    assert.deepEqual(pkg.pkg.scripts, ['src/**/*.js', 'config/**/*.js']);
    assert.deepEqual(pkg.pkg.assets.filter((a) => /activity/.test(a)), ['activity/schema.sql'], 'only the side schema (the bot creates the tables) goes into the exe');
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    for (const f of walk(path.join(__dirname, '..', 'src')).filter((x) => x.endsWith('.js'))) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /require\(['"][./]+\/activity/, f);
    assert.ok(pkg.dependencies.esbuild && pkg.dependencies['@discord/embedded-app-sdk'], 'build tools are production dependencies (Render builds with npm ci)');
    assert.match(pkg.scripts['activity:build'], /esbuild activity\/client\/main\.js/);
  });
});
