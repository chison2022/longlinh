// Bot side of the Activity lineup: the PNG table, the "Xem PT của tôi" button and the publish job (fake channel, PGlite, fake Sheets).
const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { setupDb, resetDb } = require('./pgdb');
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
const { seedWar, G } = require('./lineupFixture');

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

describe('lu:mine', () => {
  before(setupDb);
  beforeEach(async () => {
    await resetDb();
    clearConfigCache();
  });
  const click = (userId, guildId = G) => {
    const replies = [];
    return { interaction: { guildId, user: { id: userId }, reply: async (p) => replies.push(p) }, replies };
  };

  it('answers privately with the Nhóm, the PT and the party mates; mentions nobody', async () => {
    const w = await seedWar({ classes: ['Tố Vấn', 'Thiết Y', 'Huyết Hà'] });
    const layout = rules.emptyLayout(SHAPE);
    layout.groups[1][2] = [w.ids[2], w.ids[0]];
    assert.equal((await lineupService.saveLineup({ warId: w.warId, guildId: G, layout, expectedVersion: 0, userId: 'u' })).ok, true);
    const { interaction, replies } = click(w.ids[0]);
    await handle(interaction, ['lu', 'mine', w.warId]);
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
    assert.ok(replies[0].flags, 'ephemeral');
    assert.deepEqual(replies[0].allowedMentions, { parse: [] });
  });
  it('says so when the member is not placed, the war has no lineup, or it is another guild', async () => {
    const w = await seedWar({ classes: ['Tố Vấn', 'Thiết Y'] });
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
  before(setupDb);
  beforeEach(async () => {
    await resetDb();
    clearConfigCache();
    gateway.setClient(null);
    refreshes = [];
    refresher.scheduleRefresh = (...a) => refreshes.push(['war', a[1]]);
    refresher.schedulePanelRefresh = (...a) => refreshes.push(['panel', a[1]]);
    w = await seedWar({ classes: ['Tố Vấn', 'Thiết Y', 'Huyết Hà'] });
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
    assert.deepEqual(row.publishedLayout.groups[0][0], [w.ids[0], w.ids[1]], 'the posted layout is kept');
    assert.equal(row.claimedAt, null);
    assert.deepEqual(refreshes.map((r) => r[0]).sort(), ['panel', 'war']);
    assert.deepEqual(await publisher.runOnce(client, FAST), [], 'nothing pending any more: not posted twice');
    assert.equal(sent.length, 1);
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
    assert.equal((await warService.getEvent(w.warId)).status, 'open', 'the war stays open');
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
    assert.deepEqual(tab.rows[0], ['Nhóm', 'PT', 'Vị trí', 'Tên Discord', 'Phái', 'Discord ID']);
    assert.deepEqual(tab.rows[1].slice(0, 5), ['1', '1', '1', 'Người 1', 'Tố Vấn']);
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
      await db.q('update war_lineups set claimed_at = null where war_id = $1', [w.warId]);
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
    await db.q('update war_lineups set layout = $2 where war_id = $1', [w.warId, JSON.stringify(wide)]);
    await lineupService.requestPublish(w.warId, 'u');
    assert.deepEqual(await publisher.runOnce(client, FAST), [[w.warId, 'posted']]);
    assert.equal((await lineupService.getLineup(w.warId)).publishedLayout.groups.length, 2);
  });
  it('buildLineupTab lists one row per placed person', () => {
    const l = rules.emptyLayout(SHAPE);
    l.groups[1][0] = ['9', '8'];
    const spec = buildLineupTab({ warId: 'w', layout: l, people: { 9: { name: 'N', className: 'C' } } });
    assert.deepEqual(spec.rows, [['2', '1', '1', 'N', 'C', '9'], ['2', '1', '2', '8', '', '8']]);
    assert.equal(spec.keyOf((h) => ({ 'Discord ID': '9' })[h]), '9');
  });
});

describe('packaging', () => {
  it('the exe bundle takes src and config only: activity/ stays out, and no bot module requires it', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const pkg = require('../package.json');
    assert.deepEqual(pkg.pkg.scripts, ['src/**/*.js', 'config/**/*.js']);
    assert.ok(!pkg.pkg.assets.some((a) => /activity/.test(a)));
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    for (const f of walk(path.join(__dirname, '..', 'src')).filter((x) => x.endsWith('.js'))) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /require\(['"][./]+\/activity/, f);
    assert.ok(pkg.dependencies.esbuild && pkg.dependencies['@discord/embedded-app-sdk'], 'build tools are production dependencies (Render builds with npm ci)');
    assert.match(pkg.scripts['activity:build'], /esbuild activity\/client\/main\.js/);
  });
});
