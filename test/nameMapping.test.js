// Game name <-> Discord name mapping: precedence in matchDiscord, suggestions, the "🔗 Ghép tên" step view / handlers (DB stubbed),
// game names on the lineup image / xlsx / board. Persistence on a real DB: test/gameRosterDb.test.js (in-memory PostgreSQL).
const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { Collection, PermissionsBitField, PermissionFlagsBits } = require('discord.js');
const gameRoster = require('../src/services/gameRosterService');
const guildConfigService = require('../src/services/guildConfigService');
const defaults = require('../config/defaults');
const { clearMemberCache } = require('../src/bot/memberCache');
const { sid, makeRegs, vn, oid } = require('./helpers');
const { assertMessage } = require('./discordLimits');

let config;
guildConfigService.getConfigOrDefault = async () => config;
const refresher = require('../src/bot/refresher');
const panelRefreshed = [];
refresher.schedulePanelRefresh = (...a) => panelRefreshed.push(a);
const adminHandler = require('../src/bot/interactions/admin');
const { buildMapView } = require('../src/bot/ui/gameMap');
const { NO_PERMISSION } = require('../src/bot/interactions/common');

const g = (name, extra = {}) => ({ name, rank: 'Bang Chúng', className: 'Thiết Y', daysInGuild: 1, status: '', ...extra });
const p = (id, name, bot = false) => ({ id: String(id), name, bot });

describe('matchDiscord with hand-made mappings', () => {
  it('a mapped pair is matched (manual) even though the names are unrelated', () => {
    const members = [g('Cabät'), g('Kelo')];
    const res = gameRoster.matchDiscord(members, [p(1, 'Alone(Cabat)'), p(2, 'Kelo')], new Map([['1', 'Cabät']]));
    const hand = res.matched.find((m) => m.discordId === '1');
    assert.equal(hand.game.name, 'Cabät');
    assert.equal(hand.manual, true);
    assert.equal(hand.how, 'manual');
    assert.equal(res.matched.find((m) => m.discordId === '2').manual, false);
    assert.deepEqual(res.gameOnly, []);
    assert.deepEqual(res.stale, []);
  });
  it('precedence: the mapping wins over the automatic match, and a mapped game name is never offered to anyone else', () => {
    const members = [g('Kelo'), g('Boa')];
    // person 1 is called "Boa" on Discord but mapped to Kelo; person 2 is called exactly "Kelo"
    const res = gameRoster.matchDiscord(members, [p(1, 'Boa'), p(2, 'Kelo')], new Map([['1', 'Kelo']]));
    assert.equal(res.matched.find((m) => m.discordId === '1').game.name, 'Kelo');
    assert.ok(!res.matched.some((m) => m.discordId === '2'), 'the exact-name person does not take the mapped name');
    assert.deepEqual(res.discordOnly.map((x) => x.id), ['2']);
    assert.deepEqual(res.gameOnly.map((x) => x.name), ['Boa'], 'person 1 no longer takes "Boa" by name');
  });
  it('a mapping to a name the roster no longer has is stale: reported, matches nothing, the person is matched automatically again', () => {
    const res = gameRoster.matchDiscord([g('Kelo')], [p(1, 'Kelo')], new Map([['1', 'Đã Rời']]));
    assert.deepEqual(res.stale, [{ discordId: '1', gameName: 'Đã Rời' }]);
    assert.equal(res.matched.length, 1);
    assert.equal(res.matched[0].manual, false);
    const gone = gameRoster.matchDiscord([g('Kelo')], [], new Map([['9', 'Kelo']]));
    assert.deepEqual(gone.stale, [], 'a person missing from the member cache is not stale');
    assert.deepEqual(gone.uncached, [{ discordId: '9', gameName: 'Kelo' }], 'reported separately, the pairing is kept');
    assert.deepEqual(gone.gameOnly.map((x) => x.name), [], 'their game name stays taken');
  });
  it('works with no mapping argument, with a plain object, and never matches bots', () => {
    assert.equal(gameRoster.matchDiscord([g('Kelo')], [p(1, 'Kelo')]).matched.length, 1);
    assert.equal(gameRoster.matchDiscord([g('Zed')], [p(1, 'Bot', true)], { 1: 'Zed' }).matched.length, 0);
    assert.equal(gameRoster.matchDiscord([g('Zed')], [p(1, 'X')], { 1: 'Zed' }).matched[0].manual, true);
  });
  it('gameNameMap: manual and exact matches give the game name, a prefix match on a cut name does not', () => {
    const res = gameRoster.matchDiscord([g('Cabät'), g('Kelo'), g('Hắc Phong L…')], [p(1, 'Alone'), p(2, 'kelo'), p(3, 'HacPhongLinh')], new Map([['1', 'Cabät']]));
    const names = gameRoster.gameNameMap(res);
    assert.equal(names.get('1'), 'Cabät');
    assert.equal(names.get('2'), 'Kelo');
    assert.equal(names.has('3'), false);
  });
});

describe('suggestPairs', () => {
  const game = ['Cabät', 'MoaMoo', 'Xinhgggg', 'Kelo', 'Hắc Phong L…', 'Zed'].map((name) => g(name));
  const discord = [p(1, 'Alone(Cabat)'), p(2, 'Moa'), p(3, 'Xinh yêu ems'), p(4, 'Kelu'), p(5, 'HacPhong'), p(6, 'Xyz')];
  it('finds the examples of the guild: accents, brackets, extra words, a typo, a cut name', () => {
    const got = new Map(gameRoster.suggestPairs(game, discord).map((s) => [s.game.name, s.discordName]));
    assert.equal(got.get('Cabät'), 'Alone(Cabat)');
    assert.equal(got.get('MoaMoo'), 'Moa');
    assert.equal(got.get('Xinhgggg'), 'Xinh yêu ems');
    assert.equal(got.get('Kelo'), 'Kelu');
    assert.equal(got.get('Hắc Phong L…'), 'HacPhong');
    assert.equal(got.has('Zed'), false, 'unrelated names are not suggested');
  });
  it('best first, every game name and every Discord member used once, at most `limit`', () => {
    const res = gameRoster.suggestPairs([g('Kelo'), g('Kuzo')], [p(1, 'Kuru'), p(2, 'Kuza')]);
    for (let i = 1; i < res.length; i++) assert.ok(res[i - 1].score >= res[i].score);
    assert.equal(new Set(res.map((s) => s.game)).size, res.length);
    assert.equal(new Set(res.map((s) => s.discordId)).size, res.length);
    const many = Array.from({ length: 40 }, (_, k) => `Nhan${String.fromCharCode(97 + (k % 26))}${k}vat`);
    const out = gameRoster.suggestPairs(many.map((n) => g(n)), many.map((n, k) => p(k, n)), 25);
    assert.equal(out.length, 25);
    assert.equal(gameRoster.suggestPairs(many.map((n) => g(n)), many.map((n, k) => p(k, n))).length, 25, 'default limit is 25');
  });
  it('threshold: at least 60% alike, accents and case folded, very short names ignored; best first', () => {
    assert.equal(gameRoster.suggestPairs([g('abcdef')], [p(1, 'abcdxy')]).length, 1); // 4/6 alike
    assert.equal(gameRoster.suggestPairs([g('abcde')], [p(1, 'abcxy')]).length, 1); // exactly 60%
    assert.equal(gameRoster.suggestPairs([g('abcdef')], [p(1, 'abcxyz')]).length, 0); // 50% is hidden now
    assert.equal(gameRoster.suggestPairs([g('abcdef')], [p(1, 'abwxyz')]).length, 0); // 33%
    const sorted = gameRoster.suggestPairs([g('abcdefgh'), g('wxyzwxyz')], [p(1, 'abcdefxx'), p(2, 'wxyzwxyz')]);
    assert.deepEqual(sorted.map((s) => s.discordId), ['2', '1']);
    assert.ok(sorted.every((s) => s.score >= 0.6));
    assert.equal(gameRoster.suggestPairs([g('Đại Hiệp')], [p(1, 'DAI HIEP')]).length, 1);
    assert.equal(gameRoster.suggestPairs([g('Ka')], [p(1, 'Ko')]).length, 0);
    assert.ok(gameRoster.similarity('kelo', 'kelo') === 1);
    assert.equal(gameRoster.levenshtein('kitten', 'sitting'), 3);
  });
  it('rankPeople: everybody, most similar first, 0 last (ties by name)', () => {
    const ranked = gameRoster.rankPeople('Kelo', [p(1, 'Xyz'), p(2, 'Kelo Vip'), p(3, 'Kelo'), p(4, 'Anh Ba')]);
    assert.deepEqual(ranked.map((r) => r.id), ['3', '2', '4', '1']);
    assert.equal(ranked[0].score, 1);
    assert.ok(ranked[1].score > 0.6 && ranked[2].score === 0 && ranked[3].score === 0);
    assert.deepEqual(gameRoster.rankPeople('', [p(1, 'Zed')]).map((r) => r.score), [0]);
  });
  it('rankPeople also scores the username: the better of the server name and the username counts', () => {
    const ranked = gameRoster.rankPeople('Kelo', [{ id: '1', name: 'Xyz', username: 'kelo' }, { id: '2', name: 'Anh Ba', username: 'anhba' }, { id: '3', name: 'Xyz' }]);
    assert.deepEqual(ranked.map((r) => r.id), ['1', '2', '3']);
    assert.equal(ranked[0].score, 1);
    assert.equal(ranked[1].score, 0);
  });
});

describe('game names on the lineup, xlsx and board', () => {
  const regs = makeRegs(4, { classOf: () => 'Thiết Y', nameOf: (i) => ['Alone(Cabat)', 'Boa', 'Người Lạ', 'Kelo'][i] });
  const names = new Map([[regs[0].discordId, 'Cabät'], [regs[1].discordId, 'MoaMoo'], [regs[3].discordId, 'Kelo']]);
});

describe('🔗 Ghép tên (adm:gmap*)', () => {
  const GUILD = '800000000000000001';
  const MANAGE = new PermissionsBitField(PermissionFlagsBits.ManageGuild);
  const NOBODY = new PermissionsBitField(PermissionFlagsBits.SendMessages);
  const person = (n, name, bot = false) => ({ id: sid(n), displayName: name, user: { username: `u${n}`, bot }, roles: { cache: new Collection() }, guild: { id: GUILD }, joinedAt: null });
  const guild = { id: GUILD, name: 'G', memberCount: 0, roles: { cache: new Collection() }, emojis: { cache: new Collection() }, members: { cache: new Collection(), fetch: async () => {} } };
  let latest;
  let mappings;
  let setCalls;
  let removeCalls;

  beforeEach(() => {
    clearMemberCache();
    config = guildConfigService.defaultConfig(GUILD);
    panelRefreshed.length = 0;
    setCalls = [];
    removeCalls = [];
    mappings = new Map();
    latest = { _id: 'r', importedAt: vn(2026, 10, 8, 12), members: [g('Cabät'), g('Xinhgggg'), g('Chỉ Game'), g('Kelo')] };
    guild.members.cache = new Collection([person(1, 'Alone(Cabat)'), person(2, 'Xinh yêu ems'), person(3, 'Bot', true), person(4, 'Kelo'), person(5, 'Người lạ')].map((x) => [x.id, x]));
    guild.memberCount = guild.members.cache.size;
    mock.method(gameRoster, 'latest', async () => latest);
    mock.method(gameRoster, 'previous', async () => null);
    mock.method(gameRoster, 'loadMappings', async () => mappings);
    mock.method(gameRoster, 'setMappings', async (guildId, pairs) => {
      setCalls.push([guildId, pairs]);
      for (const x of pairs) mappings.set(x.discordId, x.gameName);
      return pairs.length;
    });
    mock.method(gameRoster, 'removeMappings', async (guildId, ids) => {
      removeCalls.push([guildId, ids]);
      ids.forEach((id) => mappings.delete(id));
      return ids.length;
    });
    mock.method(console, 'error', () => {});
    mock.method(console, 'warn', () => {});
  });

  function press(parts, { perms = MANAGE, ...extra } = {}) {
    const log = [];
    const i = {
      guildId: GUILD,
      guild,
      user: { id: sid(900) },
      member: { roles: [], permissions: perms },
      memberPermissions: perms,
      client: {},
      values: [],
      deferReply: async () => log.push(['deferReply']),
      deferUpdate: async () => log.push(['deferUpdate']),
      editReply: async (o) => log.push(['editReply', o]),
      reply: async (o) => log.push(['reply', o]),
      followUp: async (o) => log.push(['followUp', o]),
      ...extra,
    };
    return adminHandler.handle(i, parts).then(() => log);
  }
  const lastReply = (log) => log.filter((l) => l[0] === 'editReply').pop()[1];
  const rows = (reply) => reply.components.map((r) => r.toJSON().components);
  const ids = (reply) => rows(reply).flat().map((c) => c.custom_id);

  it('adm:gmap opens an ephemeral step view: suggestions menu (adm:gmapsug) + game-name menu (adm:gmapg:0)', async () => {
    const log = await press(['adm', 'gmap']);
    assert.deepEqual(log[0], ['deferReply']);
    const reply = lastReply(log);
    assert.deepEqual(ids(reply), ['adm:gmapsug:r', 'adm:gmapg:0:r', 'adm:gmap:r', 'adm:gmap:g']);
    const sug = rows(reply)[0][0];
    assert.equal(sug.type, 3);
    assert.deepEqual(sug.options.map((o) => o.label).sort(), ['Cabät ⇄ Alone(Cabat)', 'Xinhgggg ⇄ Xinh yêu ems']);
    assert.equal(sug.max_values, sug.options.length);
    assert.deepEqual(rows(reply)[1][0].options.map((o) => o.label), ['Cabät', 'Xinhgggg', 'Chỉ Game']);
    assertMessage({ content: reply.content, components: reply.components });
  });
  it('selecting suggestions saves those pairs, re-renders with a note and schedules a dashboard refresh', async () => {
    const log = await press(['adm', 'gmapsug', 'r'], { values: [`0:${sid(1)}`, `1:${sid(2)}`] });
    assert.deepEqual(log[0], ['deferUpdate']);
    assert.equal(setCalls.length, 1);
    assert.deepEqual(setCalls[0][1].map((x) => [x.discordId, x.gameName]), [[sid(1), 'Cabät'], [sid(2), 'Xinhgggg']]);
    const reply = lastReply(log);
    assert.match(reply.content, /✅ Đã ghép 2 cặp: Cabät ⇄ Alone\(Cabat\)/);
    assert.deepEqual(rows(reply)[0][0].custom_id, 'adm:gmapg:0:r');
    assert.ok(ids(reply).includes('adm:gmapdel'), 'the new pairs can be removed');
    assert.equal(panelRefreshed.length, 1);
  });
  it('manual: game-name menu -> members menu (unmatched only, best first) adm:gmapu:<index> -> saved with new totals', async () => {
    const step2 = lastReply(await press(['adm', 'gmapg', '0', 'r'], { values: ['2'] }));
    assert.deepEqual(ids(step2), ['adm:gmapu:2:r', 'adm:gmaps:2:r', 'adm:gmap:r']);
    assert.match(step2.content, /Chỉ Game/);
    const menu = rows(step2)[0][0];
    assert.equal(menu.type, 3);
    // Kelo (matched by name) and the bot are not offered; the three others are
    assert.deepEqual(menu.options.map((o) => o.value).sort(), [sid(1), sid(2), sid(5)].sort());
    assert.ok(menu.options.every((o) => o.label && o.description.startsWith('u')), 'label = nickname, description = username');
    const done = await press(['adm', 'gmapu', '2', 'r'], { values: [sid(5)] });
    assert.deepEqual(setCalls[0][1].map((x) => [x.discordId, x.gameName]), [[sid(5), 'Chỉ Game']]);
    const reply = lastReply(done);
    assert.match(reply.content, /Đã ghép 1 cặp: Chỉ Game ⇄ Người lạ/);
    assert.match(reply.content, /📊 Khớp \*\*2\/4\*\* \(1 ghép tay · 0 tự liên kết · 0 tên tự nhập\)/); // Kelo auto + 1 manual, of 4 game names
    assert.ok(ids(reply).includes('adm:gmap:g'));
    assert.equal(panelRefreshed.length, 1);
  });
  it('the members menu sorts by similarity to the game name and shows "giống N%" only when above 0', async () => {
    latest.members = [g('Xinh yêu'), g('Kelo'), g('Zzz')];
    const menu = rows(lastReply(await press(['adm', 'gmapg', '0', 'r'], { values: ['0'] })))[0][0];
    assert.equal(menu.options[0].value, sid(2));
    assert.equal(menu.options[0].label, 'Xinh yêu ems');
    assert.match(menu.options[0].description, /^u2 · giống \d+%$/);
    const none = buildMapView({ roster: latest.members, match: { matched: [], gameOnly: [], discordOnly: [], stale: [] }, pick: 0, candidates: [{ id: sid(9), name: 'Lạ', username: 'la', score: 0 }], ver: 'r' });
    assert.equal(none.components[0].toJSON().components[0].options[0].description, 'la');
  });
  it('more than 25 unmatched members: pages with ◀ ▶ (ids carry the roster version and stay <= 100), 🔎 opens the Discord search', async () => {
    guild.members.cache = new Collection(Array.from({ length: 60 }, (_, k) => [sid(200 + k), person(200 + k, `Nguoi ${String(k).padStart(2, '0')}`)]));
    guild.memberCount = 60;
    latest.members = [g('Nguoi 07x'), g('Chỉ Game')];
    let view = lastReply(await press(['adm', 'gmapg', '0', 'r'], { values: ['0'] }));
    assert.equal(rows(view)[0][0].options.length, 25);
    assert.equal(rows(view)[0][0].options[0].value, sid(207), 'the identical name comes first');
    assert.deepEqual(ids(view), ['adm:gmapu:0:r', 'adm:gmapm:0:0:r', 'adm:gmapm:0:1:r', 'adm:gmaps:0:r', 'adm:gmap:r']);
    assert.match(view.content, /trang 1\/3/);
    view = lastReply(await press(['adm', 'gmapm', '0', '2', 'r']));
    assert.equal(rows(view)[0][0].options.length, 10);
    assert.match(view.content, /trang 3\/3/);
    for (const id of ids(view)) assert.ok(id.length <= 100, id);
    assertMessage({ content: view.content, components: view.components });
    view = lastReply(await press(['adm', 'gmapm', '99', '0', 'r'])); // a roster index past the end: no candidates, no crash
    assert.ok(view.components, 'still renders the step view');
    view = lastReply(await press(['adm', 'gmapm', '0', '99', 'r']));
    assert.match(view.content, /trang 3\/3/, 'a page past the end is clamped');
    const search = lastReply(await press(['adm', 'gmaps', '0', 'r']));
    assert.equal(rows(search)[0][0].type, 5);
    assert.equal(rows(search)[0][0].custom_id, 'adm:gmapu:0:r');
    assert.deepEqual(ids(search).slice(1), ['adm:gmapm:0:0:r', 'adm:gmap:r']);
    const saved = await press(['adm', 'gmapu', '0', 'r'], { values: [sid(250)] });
    assert.equal(setCalls.at(-1)[1][0].discordId, sid(250));
    assert.match(lastReply(saved).content, /Đã ghép 1 cặp/);
  });
  it('the members menu is stale-roster safe: an old version on gmapm / gmaps saves and offers nothing', async () => {
    latest = { ...latest, _id: 'new-import-s' };
    const note = /Danh sách game vừa được cập nhật/;
    assert.match(lastReply(await press(['adm', 'gmapm', '2', '0', 'r'])).content, note);
    assert.match(lastReply(await press(['adm', 'gmaps', '2', 'r'])).content, note);
    assert.deepEqual(setCalls, []);
  });
  it('nobody left to offer: the Discord search is shown directly', async () => {
    guild.members.cache = new Collection([person(4, 'Kelo')].map((x) => [x.id, x]));
    const view = lastReply(await press(['adm', 'gmapg', '0', 'r'], { values: ['2'] }));
    assert.equal(rows(view)[0][0].type, 5);
    assert.deepEqual(ids(view), ['adm:gmapu:2:r', 'adm:gmap:r']);
  });
  it('after removing a pair the step view shows the new totals and the way back to 🎮 Thành viên game re-renders it fresh', async () => {
    mappings = new Map([[sid(5), 'Chỉ Game']]);
    const del = lastReply(await press(['adm', 'gmapdel'], { values: [sid(5)] }));
    assert.match(del.content, /📊 Khớp \*\*1\/4\*\* \(0 ghép tay · 0 tự liên kết · 0 tên tự nhập\)/);
    const log = await press(['adm', 'gmap', 'g']);
    assert.deepEqual(log[0], ['deferUpdate']);
    const back = lastReply(log);
    assert.equal(back.content, '');
    assert.ok(back.embeds && back.embeds.length, 'the 🎮 summary embed');
    assert.deepEqual(ids(back), ['adm:gamexlsx', 'adm:gmap', 'adm:gren', 'adm:gameadd', 'adm:gameup', 'adm:gameuid']);
  });
  it('a bot, a stranger or a stale index is not saved', async () => {
    const bot = lastReply(await press(['adm', 'gmapu', '2', 'r'], { values: [sid(3)] }));
    assert.match(bot.content, /Bỏ qua 1 cặp/);
    await press(['adm', 'gmapu', '77', 'r'], { values: [sid(5)] });
    await press(['adm', 'gmapu', 'x', 'r'], { values: [sid(5)] });
    await press(['adm', 'gmapsug', 'r'], { values: ['bad', `9:${sid(1)}`, `0:${sid(404)}`] });
    assert.deepEqual(setCalls, []);
    assert.equal(panelRefreshed.length, 0);
  });
  it('adm:gmapdel removes pairs (stale ones are marked "(cũ)")', async () => {
    mappings = new Map([[sid(1), 'Cabät'], [sid(5), 'Đã Rời']]);
    const view = lastReply(await press(['adm', 'gmap']));
    const del = rows(view).flat().find((c) => c.custom_id === 'adm:gmapdel');
    assert.deepEqual(del.options.map((o) => o.label), ['Đã Rời ⇄ Người lạ (cũ)', 'Cabät ⇄ Alone(Cabat)']);
    const log = await press(['adm', 'gmapdel'], { values: [sid(5)] });
    assert.deepEqual(removeCalls, [[GUILD, [sid(5)]]]);
    assert.match(lastReply(log).content, /Đã gỡ ghép 1 cặp/);
    assert.equal(panelRefreshed.length, 1);
  });
  it('every action is admin-gated: nobody else saves, removes or even sees the step view', async () => {
    const actions = [['gmap'], ['gmap', 'r'], ['gmap', 'g'], ['gmapp', '1'], ['gmapg', '0'], ['gmapu', '1'], ['gmapsug'], ['gmapdel'], ['gmapm', '1', '0', 'r'], ['gmaps', '1', 'r']];
    for (const a of actions) {
      const log = await press(['adm', ...a], { perms: NOBODY, values: [`0:${sid(1)}`] });
      assert.equal(lastReply(log), NO_PERMISSION, a.join(':'));
    }
    assert.deepEqual(setCalls, []);
    assert.deepEqual(removeCalls, []);
    assert.equal(panelRefreshed.length, 0);
  });
  it('a 64-member roster: pages of 25 with ◀ ▶, every customId <= 100 chars, labels within limits', async () => {
    latest.members = Array.from({ length: 64 }, (_, k) => g(`Nhân vật dài số ${k} `.repeat(4).slice(0, 40) + k, { className: 'Tố Vấn', rank: 'Học Việc' }));
    guild.members.cache = new Collection([person(1, 'Một người')].map((x) => [x.id, x]));
    guild.memberCount = 1;
    let reply = lastReply(await press(['adm', 'gmap']));
    assert.deepEqual(rows(reply)[0][0].options.length, 25);
    assert.equal(rows(reply)[0][0].custom_id, 'adm:gmapg:0:r');
    assert.deepEqual(ids(reply).slice(-4), ['adm:gmapp:0', 'adm:gmapp:1', 'adm:gmap:r', 'adm:gmap:g']);
    for (const page of [1, 2, 3, 99]) {
      reply = lastReply(await press(['adm', 'gmapp', String(page)]));
      assertMessage({ content: reply.content, components: reply.components });
      for (const id of ids(reply)) assert.ok(id.length <= 100, id);
    }
    assert.equal(rows(reply)[0][0].custom_id, 'adm:gmapg:2:r');
    assert.equal(rows(reply)[0][0].options.length, 14);
    // the longest id: a pick at index 63
    const pick = lastReply(await press(['adm', 'gmapg', '2', 'r'], { values: ['63'] }));
    assert.deepEqual(ids(pick), ['adm:gmapu:63:r', 'adm:gmaps:63:r', 'adm:gmap:r']);
  });
  it('with 25+ suggestions and 25+ pairs the menus stay at 25 options', async () => {
    const people = Array.from({ length: 30 }, (_, k) => `Nhanvat${String.fromCharCode(97 + k)}${k}x`);
    latest.members = people.map((n) => g(n));
    guild.members.cache = new Collection(people.map((n, k) => [sid(100 + k), person(100 + k, `${n}q`)]));
    guild.memberCount = people.length;
    const reply = lastReply(await press(['adm', 'gmap']));
    assert.equal(rows(reply)[0][0].options.length, 25);
    assertMessage({ content: reply.content, components: reply.components });
    mappings = new Map(people.map((n, k) => [sid(100 + k), n]));
    const del = rows(lastReply(await press(['adm', 'gmap']))).flat().find((c) => c.custom_id === 'adm:gmapdel');
    assert.equal(del.options.length, 25);
  });
  it('no roster yet: a hint instead of the step view', async () => {
    latest = null;
    const log = await press(['adm', 'gmap']);
    assert.match(lastReply(log).content, /Chưa có danh sách thành viên game/);
  });
  it('a re-upload between the render and the click saves nothing (menus carry the roster version)', async () => {
    const view = lastReply(await press(['adm', 'gmap']));
    assert.ok(ids(view).every((id) => !id.startsWith('adm:gmap') || /:r$/.test(id) || id === 'adm:gmap:g'), 'ver r in the ids');
    latest = { ...latest, _id: 'new-import-s', members: [g('Zeta'), ...latest.members] }; // indexes shifted by the re-upload
    const note = /Danh sách game vừa được cập nhật — mở lại 🔗 Ghép tên\./;
    const u = lastReply(await press(['adm', 'gmapu', '2', 'r'], { values: [sid(5)] }));
    assert.match(u.content, note);
    assert.match(lastReply(await press(['adm', 'gmapsug', 'r'], { values: [`0:${sid(1)}`] })).content, note);
    const pick = lastReply(await press(['adm', 'gmapg', '0', 'r'], { values: ['2'] }));
    assert.match(pick.content, note);
    assert.ok(!ids(pick).some((id) => id.startsWith('adm:gmapu')), 'no step 2 for an old index');
    assert.deepEqual(setCalls, []);
    assert.equal(panelRefreshed.length, 0);
    const ver = gameRoster.rosterVersion(latest);
    assert.equal(ver, 'import-s');
    assert.ok(ids(u).some((id) => id === `adm:gmapg:0:${ver}`), 'the redrawn menus carry the new version');
    const fresh = lastReply(await press(['adm', 'gmapu', '3', ver], { values: [sid(5)] }));
    assert.match(fresh.content, /Đã ghép 1 cặp: Chỉ Game/);
    assert.equal(setCalls[0][1][0].gameName, 'Chỉ Game');
  });
  it('another admin took the game name a moment ago (unique index): a note, no crash', async () => {
    gameRoster.setMappings.mock.restore();
    mock.method(gameRoster, 'setMappings', async () => {
      throw Object.assign(new Error('tên game đã được ghép cho người khác'), { code: 'GAME_NAME_TAKEN' });
    });
    const log = await press(['adm', 'gmapu', '2', 'r'], { values: [sid(5)] });
    assert.match(lastReply(log).content, /Tên game đã được ghép cho người khác/);
    assert.equal(panelRefreshed.length, 1);
  });
  it('markdown in game / Discord names is escaped in the step view and in the note', async () => {
    latest.members = [g('Chỉ *Game*_x'), g('Kelo')];
    guild.members.cache.set(sid(5), person(5, '~~Người~~ lạ'));
    const step2 = lastReply(await press(['adm', 'gmapg', '0', 'r'], { values: ['0'] }));
    assert.ok(step2.content.includes('**Chỉ \\*Game\\*\\_x**'), step2.content);
    const done = lastReply(await press(['adm', 'gmapu', '0', 'r'], { values: [sid(5)] }));
    assert.ok(done.content.includes('Chỉ \\*Game\\*\\_x ⇄ \\~\\~Người\\~\\~ lạ'), done.content);
  });
  it('gmapdel: stale pairs first, then by game name; a person missing from the cache is "(chưa thấy)", not "(cũ)"', async () => {
    mappings = new Map([[sid(4), 'Kelo'], [sid(1), 'Cabät'], [sid(5), 'Zeta'], [sid(2), 'Alpha'], [sid(404), 'Chỉ Game']]);
    const view = lastReply(await press(['adm', 'gmap']));
    const del = rows(view).flat().find((c) => c.custom_id === 'adm:gmapdel');
    assert.deepEqual(del.options.map((o) => o.value), [sid(2), sid(5), sid(1), sid(404), sid(4)]);
    assert.match(del.options[0].label, /\(cũ\)$/);
    assert.match(del.options[3].label, /\(chưa thấy\)$/);
    assert.doesNotMatch(del.options[3].label, /cũ/);
    assert.match(view.content, /2 cặp cũ/);
    assert.match(view.content, /1 người chưa thấy trong cache/);
  });
  it('🎮 view counts the hand-made pairs and reports stale ones; mapped people count as matched', async () => {
    mappings = new Map([[sid(1), 'Cabät'], [sid(5), 'Đã Rời']]);
    const log = await press(['adm', 'game']);
    const embed = JSON.stringify(lastReply(log).embeds[0].toJSON());
    assert.match(embed, /Khớp tên Discord: \*\*2\/4\*\* \(trong đó 1 ghép tay · 0 tự liên kết · 0 tên tự nhập\)/); // Cabät by hand + Kelo by name
    assert.match(embed, /Ghép tên cũ/);
    assert.match(embed, /Tên Discord khác tên game \(2\)/);
    const buttons = lastReply(log).components[0].toJSON().components.map((c) => c.custom_id);
    assert.ok(buttons.includes('adm:gmap'));
  });
});
