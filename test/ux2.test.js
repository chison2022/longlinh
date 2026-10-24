// UX round 2: split of the unregistered, hidden "⏳" / empty member role, class codes on the war message, the list without "✅"
// and with the "❌ Vắng" section, /setup warnings, game names loaded from the DB (stubbed).
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const realIsConnected = db.isConnected;
const { Collection } = require('discord.js');
const defaults = require('../config/defaults');
const gameRoster = require('../src/services/gameRosterService');
const warService = require('../src/services/warService');
const guildConfigService = require('../src/services/guildConfigService');
const { groupUnregistered } = require('../src/services/rosterService');
const { buildUnregView, splitByGame } = require('../src/bot/ui/unreg');
const { buildWarMessage, buildListEmbeds } = require('../src/bot/ui/warMessage');
const { buildPanel, buildSetupView } = require('../src/bot/ui/panel');
const { completeInfos, unregisteredCount, roleIsEmpty, eventStats } = require('../src/bot/eventStats');
const { ensureMembers, clearMemberCache } = require('../src/bot/memberCache');
const { loadGameNames, invalidateGameNames } = require('../src/bot/gameNames');
const { initials } = require('../src/bot/classStyle');
const { setupView } = require('../src/bot/interactions/setup');
const { assertEmbed, assertV2Message, assertMessage } = require('./discordLimits');
const { sid, makeRegs, vn, oid } = require('./helpers');

const event = { _id: oid(3), title: 'Bang chiến T7', status: 'open', startAt: vn(2026, 10, 10, 20), deadlineAt: vn(2026, 10, 10, 18), teams: [] };
const CONFIG = { classes: defaults.classes, groupCount: 2, schedule: defaults.schedule, memberRoleId: 'role-m' };

const role = (id, name = id) => ({ id, name });
const member = (n, name, roleIds = ['role-m'], bot = false) => ({
  id: sid(n),
  displayName: name,
  user: { username: `u${n}`, bot },
  roles: { cache: new Collection(roleIds.map((r) => [r, role(r)])) },
  guild: { id: 'g1' },
  joinedAt: null,
});
const guildOf = (members) => {
  const cache = new Collection(members.map((m) => [m.id, m]));
  return { id: 'g1', memberCount: cache.size, members: { cache, fetch: async () => cache }, roles: { cache: new Collection() } };
};

describe('👥 Chưa đăng ký: split by the in-game roster', () => {
  const infos = [
    { id: sid(1), name: 'An', bot: false, roleIds: ['role-m'], roleNames: ['Tố Vấn'] },
    { id: sid(2), name: 'Bình', bot: false, roleIds: ['role-m'], roleNames: ['Thiết Y'] },
    { id: sid(3), name: 'Cường', bot: false, roleIds: ['role-m'], roleNames: ['Tố Vấn'] },
    { id: sid(4), name: 'Dũng', bot: false, roleIds: ['role-m'], roleNames: [] },
  ];
  const grouped = groupUnregistered(infos, [], { ...CONFIG, classes: ['Tố Vấn', 'Thiết Y'] });
  const inGame = new Set([sid(1), sid(4)]);

  it('splitByGame keeps every person in exactly one section, grouped by class', () => {
    const s = splitByGame(grouped, inGame);
    assert.equal(s.inGame.total, 2);
    assert.equal(s.notInGame.total, 2);
    assert.deepEqual(s.inGame.groups.map((x) => x.names), [['An'], ['Dũng']]);
    assert.deepEqual(s.notInGame.groups.map((x) => x.names), [['Cường'], ['Bình']]);
  });
  it('mention-like names are defanged; the role mention of the head stays', () => {
    const evil = [
      { id: sid(1), name: '<@123456> @everyone', bot: false, roleIds: ['role-m'], roleNames: ['Tố Vấn'] },
      { id: sid(2), name: 'x<#99>@here', bot: false, roleIds: ['role-m'], roleNames: ['Tố Vấn'] },
    ];
    const g = groupUnregistered(evil, [], { ...CONFIG, classes: ['Tố Vấn'] });
    const t = assertV2Message(buildUnregView(event, g, { memberRoleId: '777', gameNames: new Map([[sid(1), '<@&5>']]), inGame: new Set([sid(1)]) })).text;
    assert.doesNotMatch(t, /<@(?!&777>)|<#|@everyone|@here/);
    assert.match(t, /<@&777>/);
  });
  it('hard cap: 30 long class names never exceed the text budget; dropped classes end in "… và k phái nữa"', () => {
    const classes = Array.from({ length: 30 }, (_, k) => `Phái ${k} ${'x'.repeat(190)}`);
    const people = classes.map((c, k) => ({ id: sid(k + 1), name: `P${k}`, bot: false, roleIds: ['role-m'], roleNames: [c] }));
    const g = groupUnregistered(people, [], { ...CONFIG, classes });
    const v = assertV2Message(buildUnregView(event, g, {}));
    assert.ok(v.text.length <= 4000, `text ${v.text.length}`);
    assert.match(v.text, /… và \d+ phái nữa/);
  });
  it('with a roster: green "ĐANG Ở BANG" block before the grey "CHƯA BIẾT LÀ AI" block; both ping buttons', () => {
    const v = assertV2Message(buildUnregView(event, grouped, { inGame }));
    assert.match(v.texts[0], /\*\*4\*\* người có role/);
    assert.match(v.texts[1], /^\*\*✅ ĐANG Ở BANG – NÊN NHẮC \(2\)\*\*/);
    assert.match(v.texts[2], /^\*\*❔ CHƯA BIẾT LÀ AI TRONG GAME \(2\)\*\*/);
    assert.ok(v.texts[2].includes('Cường') && !v.texts[1].includes('Cường'));
    assert.deepEqual(v.buttons.map((b) => b.custom_id), [`adm:unregping:${event._id}:g`, `adm:unregping:${event._id}`, 'adm:gmap', 'adm:unreg:r']);
    assert.ok(v.buttons.every((b) => !b.disabled));
  });
  it('the confirm step says who is pinged: everybody (all) or only the people in the game (in)', () => {
    const all = assertV2Message(buildUnregView(event, grouped, { inGame, confirm: 'all' }));
    assert.match(all.texts[0], /Nhắc \*\*4\*\* người chưa đăng ký/);
    const only = assertV2Message(buildUnregView(event, grouped, { inGame, confirm: 'in' }));
    assert.match(only.texts[0], /Nhắc \*\*2\*\* người đang ở bang/);
  });
  it('no roster: the view is the plain list (no sections, no split text)', () => {
    const v = assertV2Message(buildUnregView(event, grouped, {}));
    assert.doesNotMatch(v.text, /ĐANG Ở BANG|CHƯA BIẾT LÀ AI/);
    assert.match(v.texts[1], /^\*\*⏳ CHƯA ĐĂNG KÝ \(4\)\*\*/);
    assert.doesNotMatch(assertV2Message(buildUnregView(event, grouped, { confirm: 'all' })).text, /trong game/);
  });
  it('a big list stays inside the V2 limits (everybody in one section, or split)', () => {
    const many = Array.from({ length: 64 }, (_, k) => ({ id: sid(100 + k), name: `Tên rất dài của người số ${k}`, bot: false, roleIds: ['role-m'], roleNames: [defaults.classes[k % 7]] }));
    const g = groupUnregistered(many, [], CONFIG);
    for (const set of [new Set(), new Set(many.map((m) => m.id)), new Set(many.slice(0, 20).map((m) => m.id))]) {
      assertV2Message(buildUnregView(event, g, { inGame: set }));
    }
  });
});

describe('"⏳ chưa đăng ký" and the empty member role', () => {
  beforeEach(() => clearMemberCache());
  const regs = [];
  it('shown with a count when the role has members and the cache is complete', async () => {
    const guild = guildOf([member(1, 'An'), member(2, 'Bình'), member(3, 'Bot', ['role-m'], true), member(4, 'Khách', [])]);
    await ensureMembers(guild);
    assert.equal(unregisteredCount(guild, CONFIG, regs), 2);
    assert.equal(roleIsEmpty(guild, CONFIG), false);
  });
  it('the dashboard builds the member list once for both numbers (completeInfos shared)', async () => {
    const guild = guildOf([member(1, 'An'), member(2, 'Bình')]);
    await ensureMembers(guild);
    const infos = completeInfos(guild, CONFIG);
    assert.equal(unregisteredCount(guild, CONFIG, regs, infos), 2);
    assert.equal(roleIsEmpty(guild, CONFIG, infos), false);
    assert.equal(roleIsEmpty(guild, CONFIG, null), false, 'null = unknown, passed through');
    assert.equal(unregisteredCount(guild, CONFIG, regs, null), null);
    let walks = 0;
    const values = guild.members.cache.values.bind(guild.members.cache);
    guild.members.cache.values = () => (walks++, values());
    const shared = completeInfos(guild, CONFIG);
    unregisteredCount(guild, CONFIG, regs, shared);
    roleIsEmpty(guild, CONFIG, shared);
    assert.equal(walks, 1);
  });
  it('hidden (null) when the role has 0 members, when no role is set, and when the cache is incomplete', async () => {
    const guild = guildOf([member(1, 'An', []), member(2, 'Bot', ['role-m'], true)]);
    await ensureMembers(guild);
    assert.equal(unregisteredCount(guild, CONFIG, regs), null);
    assert.equal(roleIsEmpty(guild, CONFIG), true, 'bots do not count');
    assert.equal(unregisteredCount(guild, { ...CONFIG, memberRoleId: null }, regs), null);
    assert.equal(roleIsEmpty(guild, { ...CONFIG, memberRoleId: null }), false);
    clearMemberCache();
    assert.equal(roleIsEmpty(guild, CONFIG), false, 'unknown (cache not complete) is not "empty"');
  });
  it('the war message leaves "⏳" out when the count is unknown and keeps it otherwise', () => {
    const rs = makeRegs(3);
    const hidden = assertV2Message(buildWarMessage(event, rs, CONFIG, undefined, { unregistered: null })).text;
    assert.doesNotMatch(hidden, /⏳/);
    assert.match(assertV2Message(buildWarMessage(event, rs, CONFIG, undefined, { unregistered: 5 })).text, /❌ 0 vắng · ⏳ 5 chưa đăng ký/);
  });
  it('the dashboard says "⚠️ Role thành viên chưa có ai" instead of the count when the role is empty', () => {
    const rs = makeRegs(3);
    const stats = eventStats(event, rs, CONFIG, { unregistered: null });
    const empty = assertV2Message(buildPanel({ event, stats, roleEmpty: true })).text;
    assert.match(empty, /⚠️ Role thành viên chưa có ai/);
    assert.doesNotMatch(empty, /⏳/);
    const ok = assertV2Message(buildPanel({ event, stats: eventStats(event, rs, CONFIG, { unregistered: 4 }), roleEmpty: false })).text;
    assert.doesNotMatch(ok, /Role thành viên chưa có ai/);
    assert.match(ok, /⏳ 4/);
    assert.doesNotMatch(assertV2Message(buildPanel({})).text, /Role thành viên/);
  });
});

describe('war message class line: "<emoji> <code> <count>"', () => {
  it('initials of the plain class name', () => {
    assert.equal(initials('Tố Vấn'), 'TV');
    assert.equal(initials('Thiết Y'), 'TY');
    assert.equal(initials('Cửu Linh'), 'CL');
    assert.equal(initials('Đại Hiệp'), 'DH');
  });
  it('💊 TV 1 ... without styles and with the custom emoji; a class without any emoji keeps "• Tên n"', () => {
    const rs = [...makeRegs(1, { classOf: () => 'Tố Vấn' }), ...makeRegs(2, { classOf: () => 'Cửu Linh', offset: 10 })];
    const text = assertV2Message(buildWarMessage(event, rs, CONFIG)).text;
    assert.match(text, /\S TV 1 {2}\S+ CL 2/);
    const styles = new Map([['Tố Vấn', { emoji: null, emojiText: '<:tv:123>', color: null, plain: 'Tố Vấn' }]]);
    assert.match(assertV2Message(buildWarMessage(event, rs, CONFIG, styles)).text, /<:tv:123> TV 1/);
    const bare = new Map([['Lạ Quá', { emoji: null, emojiText: '•', color: null, plain: 'Lạ Quá' }]]);
    const text2 = assertV2Message(buildWarMessage(event, makeRegs(2, { classOf: () => 'Lạ Quá' }), { ...CONFIG, classes: ['Lạ Quá'] }, bare)).text;
    assert.match(text2, /• Lạ Quá 2/);
    assert.doesNotMatch(text2, /• LQ/);
  });
});

describe('📋 Danh sách: names only per class, then "❌ Vắng"', () => {
  const regs = [
    ...makeRegs(3, { classOf: () => 'Tố Vấn', nameOf: (i) => `Vấn${i}` }),
    ...makeRegs(2, { classOf: () => 'Thiết Y', nameOf: (i) => `Y${i}`, offset: 10, statusOf: () => 'reserve' }),
    ...makeRegs(2, { classOf: () => 'Tố Vấn', nameOf: (i) => `Nghỉ${i}`, offset: 20, statusOf: () => 'absent' }),
  ];
  it('no "✅" prefix on the lines; the class fields hold plain names', () => {
    const embeds = buildListEmbeds(event, regs, defaults.classes);
    const fields = embeds.flatMap((e) => assertEmbed(e).fields);
    const cls = fields.find((f) => f.name.includes('Tố Vấn'));
    assert.equal(cls.value, 'Vấn0, Vấn1, Vấn2');
    assert.ok(!fields.some((f) => f.value.includes('✅')));
    assert.ok(fields.find((f) => f.name.includes('Thiết Y')).value === 'Y10, Y11', 'a legacy reserve is listed like a join');
  });
  it('the last section is "❌ Vắng (n)" with the names of those who said no; none when nobody did', () => {
    const fields = buildListEmbeds(event, regs, defaults.classes).flatMap((e) => e.toJSON().fields);
    const last = fields[fields.length - 1];
    assert.equal(last.name, '❌ Vắng (2)');
    assert.equal(last.value, 'Nghỉ20, Nghỉ21');
    assert.ok(!fields.slice(0, -1).some((f) => f.value.includes('Nghỉ')));
    const none = buildListEmbeds(event, regs.slice(0, 5), defaults.classes).flatMap((e) => e.toJSON().fields);
    assert.ok(!none.some((f) => f.name.includes('Vắng')));
  });
  it('a long absent list continues in "(tiếp)" fields within the embed limits', () => {
    const many = makeRegs(80, { statusOf: () => 'absent' });
    const embeds = buildListEmbeds(event, [...regs.slice(0, 5), ...many], defaults.classes);
    const fields = embeds.flatMap((e) => assertEmbed(e).fields);
    assert.ok(fields.some((f) => f.name === '❌ Vắng (tiếp)'));
    const shown = fields.filter((f) => f.name.startsWith('❌ Vắng')).map((f) => f.value).join(', ').split(', ');
    assert.equal(shown.length, 80);
  });
});

describe('/setup warnings', () => {
  const base = { announceChannelId: null, adminChannelId: null, adminRoleIds: ['r-bot', 'r-human'], memberRoleId: 'role-m' };
  it('buildSetupView: bot roles among the manager roles are flagged; an empty member role is flagged', () => {
    const view = buildSetupView(base, null, { botRoleIds: ['r-bot'], memberCount: 0 });
    assert.match(view.content, /⚠️ Role quản lý là role của bot: <@&r-bot>/);
    assert.doesNotMatch(view.content, /role của bot:.*<@&r-human>/);
    assert.match(view.content, /⚠️ Role thành viên chưa có ai/);
    assertMessage(view);
    const fine = buildSetupView(base, null, { botRoleIds: [], memberCount: 12 }).content;
    assert.doesNotMatch(fine, /role của bot|chưa có ai/);
    assert.match(fine, /✅ Role thành viên: <@&role-m> \(12 người\)/);
    assert.doesNotMatch(buildSetupView(base, null, {}).content, /chưa có ai/, 'unknown count (cache incomplete) is no warning');
    assert.doesNotMatch(buildSetupView(base, null, { botRoleIds: ['not-chosen'] }).content, /role của bot/);
  });
  it('setupView finds bot roles by role.managed or role.tags.botId and counts the member role only when the cache is complete', async () => {
    clearMemberCache();
    mock.method(warService, 'getCurrentEvent', async () => null);
    const guild = guildOf([member(1, 'An', []), member(2, 'Bình', [])]);
    guild.roles.cache = new Collection([
      ['r-bot', { id: 'r-bot', managed: true, tags: {} }],
      ['r-human', { id: 'r-human', managed: false }],
      ['r-tagged', { id: 'r-tagged', managed: false, tags: { botId: '999' } }],
    ]);
    const interaction = { guildId: 'g1', guild };
    const cfg = { ...guildConfigService.defaultConfig('g1'), adminRoleIds: ['r-bot', 'r-human', 'r-tagged'], memberRoleId: 'role-m' };
    let view = await setupView(interaction, cfg);
    assert.match(view.content, /role của bot: <@&r-bot> <@&r-tagged>/);
    assert.doesNotMatch(view.content, /chưa có ai/, 'cache not known to be complete yet');
    await ensureMembers(guild);
    view = await setupView(interaction, cfg);
    assert.match(view.content, /⚠️ Role thành viên chưa có ai/);
    mock.restoreAll();
  });
});

describe('loadGameNames', () => {
  beforeEach(() => {
    clearMemberCache();
    mock.method(console, 'error', () => {});
  });
  it('without a DB connection (or with no member cache) the Discord names are kept', async () => {
    assert.equal((await loadGameNames(guildOf([member(1, 'Kelo')]))).size, 0);
    assert.equal((await loadGameNames(null)).size, 0);
  });
  it('mapped people and exact matches get their game name; a failing lookup falls back to an empty map', async () => {
    db.isConnected = () => true; // pretend to be connected
    mock.method(gameRoster, 'latest', async () => ({ members: [{ name: 'Cabät' }, { name: 'Kelo' }, { name: 'Hắc Phong L…' }] }));
    mock.method(gameRoster, 'loadMappings', async () => new Map([[sid(1), 'Cabät']]));
    const names = await loadGameNames(guildOf([member(1, 'Alone(Cabat)'), member(2, 'kelo'), member(3, 'HacPhongLinh')]));
    assert.deepEqual([...names], [[sid(1), 'Cabät'], [sid(2), 'Kelo']]);
    invalidateGameNames('g1');
    mock.method(gameRoster, 'latest', async () => {
      throw new Error('db down');
    });
    assert.equal((await loadGameNames(guildOf([member(1, 'x')]))).size, 0);
    db.isConnected = realIsConnected;
    mock.restoreAll();
    invalidateGameNames();
  });
  describe('cache', () => {
    let reads;
    let maps;
    beforeEach(() => {
      invalidateGameNames();
      reads = 0;
      maps = new Map([[sid(1), 'Cabät']]);
      db.isConnected = () => true;
      mock.method(gameRoster, 'latest', async (guildId, projection) => {
        reads += 1;
        assert.equal(projection, 'members.name', 'only the names are read');
        return { members: [{ name: 'Cabät' }, { name: 'Kelo' }] };
      });
      mock.method(gameRoster, 'loadMappings', async () => maps);
    });
    afterEach(() => {
      db.isConnected = realIsConnected;
      mock.restoreAll();
      invalidateGameNames();
    });
    const guild = () => guildOf([member(1, 'Alone(Cabat)'), member(2, 'kelo')]);

    it('a second call within the TTL reuses the computed map (no DB read)', async () => {
      const g = guild();
      const first = await loadGameNames(g);
      assert.equal(reads, 1);
      assert.equal(await loadGameNames(g), first);
      assert.equal(reads, 1);
      mock.timers.enable({ apis: ['Date'], now: Date.now() + 61000 });
      try {
        await loadGameNames(g);
      } finally {
        mock.timers.reset();
      }
      assert.equal(reads, 2, 'older than 60 s: recomputed');
    });
    it('saveImport / setMappings / removeMappings and the member events drop it', async () => {
      const g = guild();
      await loadGameNames(g);
      gameRoster.bump('g1'); // what saveImport / setMappings / removeMappings do
      await loadGameNames(g);
      assert.equal(reads, 2);
      invalidateGameNames('g1'); // guildMemberUpdate / guildMemberRemove / userUpdate
      await loadGameNames(g);
      assert.equal(reads, 3);
      invalidateGameNames('other');
      await loadGameNames(g);
      assert.equal(reads, 3, 'another guild does not matter');
    });
    it('a change while a load is in flight is not cached as fresh', async () => {
      const g = guild();
      const inflight = loadGameNames(g);
      gameRoster.bump('g1');
      await inflight;
      await loadGameNames(g);
      assert.equal(reads, 2);
    });
    it('a DB state change is warned about once', async () => {
      const warn = mock.method(console, 'warn', () => {});
      db.isConnected = () => false;
      const g = guild();
      await loadGameNames(g);
      await loadGameNames(g);
      assert.equal(warn.mock.calls.filter((c) => /readyState 0/.test(c.arguments[0])).length, 1);
      db.isConnected = () => true;
      await loadGameNames(g);
      assert.equal(warn.mock.calls.filter((c) => /readyState 1/.test(c.arguments[0])).length, 1, 'the reconnect is a change too');
    });
  });
});
