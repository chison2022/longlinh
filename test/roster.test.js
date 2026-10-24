// Live names, unregistered list, roster export, guildMemberUpdate sync, real-member seed helpers.
// Stubs are installed BEFORE the handlers are required (destructured imports).
const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits, Collection, MessageFlags, Client, Events } = require('discord.js');
const warService = require('../src/services/warService');
const registrationService = require('../src/services/registrationService');
const guildConfigService = require('../src/services/guildConfigService');
const db = require('../src/db');
const { vn, oid, sid } = require('./helpers');
const { assertMessage, assertV2Message } = require('./discordLimits');

let config;
let regs = [];
guildConfigService.getConfigOrDefault = async () => config;
registrationService.listRegistrations = async () => regs;

const { liveName, namesFor, withNames, liveRegs } = require('../src/bot/liveNames');
const roster = require('../src/services/rosterService');
const { buildUnregView } = require('../src/bot/ui/unreg');
const adminHandler = require('../src/bot/interactions/admin');
const { onMemberUpdate, onUserUpdate, warmMembers, warmAllGuilds, startBot } = require('../src/bot/client');
const { ensureMembers, clearMemberCache } = require('../src/bot/memberCache');
const ExcelJS = require('exceljs');

const GUILD = '800000000000000001';
const EID = oid(7);
const MANAGE = new PermissionsBitField(PermissionFlagsBits.ManageGuild);
const NOBODY = new PermissionsBitField(PermissionFlagsBits.SendMessages);
const CLASSES = ['Thiết Y', 'Tố Vấn', 'Huyết Hà'];
const MEMBER_ROLE = 'role-member';

const role = (id, name) => ({ id, name });
const fakeMember = (n, { roles = [], bot = false, nick, name = `Tên ${n}`, joinedAt = new Date('2025-03-04T10:00:00Z') } = {}) => ({
  id: sid(n),
  displayName: nick || name,
  guild: { id: GUILD },
  joinedAt,
  user: { id: sid(n), username: `user${n}`, globalName: name, bot },
  roles: { cache: new Collection([[GUILD, role(GUILD, '@everyone')], ...roles.map((r) => [r.id, r])]) },
});
const MEMBER = role(MEMBER_ROLE, 'Thành viên');
const cls = (name) => role(`c-${name}`, name);

describe('liveName', () => {
  const guild = (m) => ({ members: { cache: new Collection(m.map((x) => [x.id, x])) } });
  it('cached member wins over the stored name; missing member / no guild falls back', () => {
    const g = guild([fakeMember(1, { nick: 'Biệt Danh', name: 'Global' })]);
    assert.equal(liveName(g, sid(1), 'Cũ'), 'Biệt Danh');
    assert.equal(liveName(g, sid(2), 'Cũ'), 'Cũ');
    assert.equal(liveName(undefined, sid(1), 'Cũ'), 'Cũ');
    assert.equal(liveName({}, sid(1), 'Cũ'), 'Cũ');
  });
  it('nickname -> global name (discord.js displayName order) as the cached displayName', () => {
    assert.equal(liveName(guild([fakeMember(1, { name: 'Global' })]), sid(1), 'x'), 'Global');
  });
  it('withNames / liveRegs replace only known ids and never mutate', () => {
    const input = [{ discordId: sid(1), displayName: 'Cũ' }, { discordId: sid(2), displayName: 'Hai' }];
    const out = liveRegs(guild([fakeMember(1, { nick: 'Mới' })]), input);
    assert.deepEqual(out.map((r) => r.displayName), ['Mới', 'Hai']);
    assert.equal(input[0].displayName, 'Cũ');
    assert.equal(withNames(input, new Map()), input);
    assert.deepEqual([...namesFor(guild([fakeMember(1)]), [sid(1), sid(9)])], [[sid(1), 'Tên 1']]);
  });
});

describe('unregistered grouping', () => {
  const infos = (list) => list.map(roster.memberInfo);
  const cfg = { memberRoleId: MEMBER_ROLE, classes: CLASSES };
  it('filters bots / no member role / registered, groups by class from roles, unknown last', () => {
    const list = infos([
      fakeMember(1, { roles: [MEMBER, cls('Tố Vấn')], name: 'Bình' }),
      fakeMember(2, { roles: [MEMBER, cls('Tố Vấn')], name: 'An' }),
      fakeMember(3, { roles: [MEMBER], name: 'Không phái' }),
      fakeMember(4, { roles: [MEMBER, cls('Thiết Y')], name: 'Đã đk' }),
      fakeMember(5, { roles: [cls('Thiết Y')], name: 'Không role member' }),
      fakeMember(6, { roles: [MEMBER], bot: true, name: 'Bot' }),
    ]);
    const g = roster.groupUnregistered(list, new Set([sid(4)]), cfg);
    assert.equal(g.total, 3);
    assert.deepEqual(g.groups.map((x) => [x.label, x.names]), [['Tố Vấn', ['An', 'Bình']], ['Chưa có role phái', ['Không phái']]]);
  });
  it('without memberRoleId every non-bot counts', () => {
    const g = roster.groupUnregistered(infos([fakeMember(1), fakeMember(2, { bot: true })]), [], { classes: CLASSES });
    assert.equal(g.total, 1);
  });
  const EV = { _id: EID, title: 'Bang chiến T7', status: 'open', deadlineAt: new Date('2026-10-10T11:00:00Z') };
  const peopleOf = (n, name = (k) => `Người ${k}`) => infos(Array.from({ length: n }, (_, k) => fakeMember(k + 1, { roles: [MEMBER, cls(CLASSES[k % 3])], name: name(k + 1) })));
  const ids = (a) => new Set(a.map((n) => sid(n)));
  it('no roster: ONE block "CHƯA ĐĂNG KÝ", Tố Vấn / Thiết Y lines first, valid V2', () => {
    const g = roster.groupUnregistered(peopleOf(6), [], cfg); // classes cycle Thiết Y, Tố Vấn, Huyết Hà
    const v = assertV2Message(buildUnregView(EV, g, { memberRoleId: MEMBER_ROLE, trackedCount: 6 }));
    assert.match(v.texts[0], /^### 👥 Chưa đăng ký · Bang chiến T7 · chốt <t:\d+:t> \(<t:\d+:R>\)\n\*\*6\*\* người có role <@&role-member> chưa bấm Tham gia\/Vắng\.$/);
    assert.equal(v.texts.length, 2);
    assert.match(v.texts[1], /^\*\*⏳ CHƯA ĐĂNG KÝ \(6\)\*\*\n/);
    const lines = v.texts[1].split('\n').slice(1);
    assert.deepEqual(lines.map((l) => l.replace(/^\S+ /, '').split(':')[0]), ['Tố Vấn', 'Thiết Y', 'Huyết Hà']);
    assert.deepEqual(v.buttons.map((b) => b.custom_id), [`adm:unregping:${EID}`, 'adm:gmap', 'adm:unreg:r']);
    assert.equal(v.buttons[0].label, '📣 Nhắc tất cả 6');
    assert.doesNotMatch(v.text, /ĐANG Ở BANG/);
  });
  it('with a roster: green block (in game, game name in parentheses only when different) then grey block', () => {
    const g = roster.groupUnregistered(infos([
      fakeMember(1, { roles: [MEMBER, cls('Thiết Y')], name: 'Nhi' }),
      fakeMember(2, { roles: [MEMBER, cls('Tố Vấn')], name: 'Lan' }),
      fakeMember(3, { roles: [MEMBER, cls('Huyết Hà')], name: 'Hà' }),
      fakeMember(4, { roles: [MEMBER], name: 'Lạ' }),
      fakeMember(5, { roles: [MEMBER, cls('Huyết Hà')], name: 'Xa' }),
    ]), [], cfg);
    const gameNames = new Map([[sid(1), 'Bánh Bao'], [sid(2), 'lan'], [sid(3), 'Hà'], [sid(4), 'Ai Đó']]);
    const v = assertV2Message(buildUnregView(EV, g, { inGame: ids([1, 2, 3, 4]), gameNames, memberRoleId: MEMBER_ROLE, trackedCount: 5 }));
    const [, green, grey] = v.texts;
    assert.match(green, /^\*\*✅ ĐANG Ở BANG – NÊN NHẮC \(4\)\*\*\n-# Bot đã xác định được nhân vật trong game của những người này\.\n/);
    const lines = green.split('\n').slice(2);
    assert.match(lines[0], /Tố Vấn: Lan$/); // game name "lan" equals the Discord name (case folded): no parentheses
    assert.match(lines[1], /Thiết Y: Nhi \(Bánh Bao\)$/);
    assert.match(lines[2], /Huyết Hà: Hà$/);
    assert.match(lines[3], /^❔ Chưa có role phái: Lạ \(Ai Đó\)$/);
    assert.equal(grey.split('\n').slice(0, 2).join('\n'), '**❔ CHƯA BIẾT LÀ AI TRONG GAME (1)**\n-# Tên Discord không khớp ai trong bang → cần ghép tên, hoặc đã rời bang.');
    assert.match(grey.split('\n')[2], /Huyết Hà: Xa$/);
    assert.deepEqual(v.buttons.map((b) => [b.custom_id, b.label]), [
      [`adm:unregping:${EID}:g`, '📣 Nhắc 4 người ở bang'],
      [`adm:unregping:${EID}`, '📣 Nhắc tất cả 5'],
      ['adm:gmap', '🔗 Ghép tên'],
      ['adm:unreg:r', '🔄 Làm mới'],
    ]);
  });
  it('roster but nobody in game: no "ở bang" button; closed event disables the ping button', () => {
    const g = roster.groupUnregistered(peopleOf(3), [], cfg);
    const v = assertV2Message(buildUnregView({ ...EV, status: 'locked' }, g, { inGame: new Set(), memberRoleId: MEMBER_ROLE, trackedCount: 3 }));
    assert.deepEqual(v.buttons.map((b) => b.custom_id), [`adm:unregping:${EID}`, 'adm:gmap', 'adm:unreg:r']);
    assert.equal(v.buttons[0].disabled, true);
    assert.doesNotMatch(v.text, /ĐANG Ở BANG/);
  });
  it('role empty / unset (complete cache): /setup warning, never "Mọi thành viên đã đăng ký"; everybody registered keeps the 🎉', () => {
    const none = assertV2Message(buildUnregView(EV, { total: 0, groups: [] }, { trackedCount: 0 }));
    assert.match(none.text, /⚠️ Role thành viên chưa có ai — vào \/setup chọn role thành viên\./);
    assert.doesNotMatch(none.text, /Mọi thành viên đã đăng ký/);
    assert.deepEqual(none.buttons.map((b) => b.custom_id), ['adm:gmap', 'adm:unreg:r']);
    const done = assertV2Message(buildUnregView(EV, { total: 0, groups: [] }, { trackedCount: 5 }));
    assert.match(done.text, /🎉 Mọi thành viên đã đăng ký\./);
    const part = assertV2Message(buildUnregView(EV, { total: 0, groups: [] }, { trackedCount: 0, incomplete: true }));
    assert.match(part.text, /Không tải đủ danh sách/);
    assert.doesNotMatch(part.text, /Mọi thành viên đã đăng ký|Role thành viên chưa có ai/);
  });
  it('900 people: every line is cut with "… +k người", text <= 4000, components <= 40', () => {
    const g = roster.groupUnregistered(peopleOf(900, (k) => `Nguyễn Văn Người Chơi ${k}`), [], cfg);
    const half = ids(Array.from({ length: 450 }, (_, k) => k + 1));
    for (const inGame of [null, half]) {
      const v = assertV2Message(buildUnregView(EV, g, { inGame, gameNames: new Map(), memberRoleId: MEMBER_ROLE, trackedCount: 900 }));
      assert.ok(v.text.length <= 4000);
      assert.match(v.text, /, … \+\d+ người/);
      for (const t of v.texts.slice(1)) for (const line of t.split('\n').filter((l) => !l.startsWith('**') && !l.startsWith('-#'))) assert.ok(line.length <= 900);
    }
  });
  it('confirm step states who is pinged: "in" = only block 1, "all" = both; ids keep the :g suffix only for "in"', () => {
    const g = roster.groupUnregistered(peopleOf(5), [], cfg);
    const inGame = ids([1, 2]);
    const a = assertV2Message(buildUnregView(EV, g, { inGame, confirm: 'in', trackedCount: 5 }));
    assert.match(a.texts[0], /^📣 Nhắc \*\*2\*\* người đang ở bang/);
    assert.doesNotMatch(a.text, /CHƯA BIẾT LÀ AI/);
    assert.deepEqual(a.buttons.map((b) => b.custom_id), [`adm:unregok:${EID}:g`, 'adm:unreg:r']);
    const all = assertV2Message(buildUnregView(EV, g, { inGame, confirm: 'all', trackedCount: 5 }));
    assert.match(all.texts[0], /^📣 Nhắc \*\*5\*\* người chưa đăng ký/);
    assert.match(all.text, /CHƯA BIẾT LÀ AI/);
    assert.deepEqual(all.buttons.map((b) => b.custom_id), [`adm:unregok:${EID}`, 'adm:unreg:r']);
  });
});

describe('registration writes', () => {
  it('syncMemberName rewrites the one stored name of the member (lists read it from there)', async () => {
    const calls = [];
    mock.method(db, 'q', async (sql, params) => (calls.push([sql, params]), []));
    await registrationService.syncMemberName(GUILD, sid(1), 'Mới');
    mock.restoreAll();
    assert.equal(calls.length, 1);
    assert.match(calls[0][0], /update discord_members set display_name = \$3 where guild_id = \$1 and discord_id = \$2/);
    assert.deepEqual(calls[0][1], [GUILD, sid(1), 'Mới']);
  });
});

describe('guildMemberUpdate', () => {
  it('name changed -> DB sync; unchanged / bot -> nothing', async () => {
    const synced = [];
    mock.method(db, 'q', async (sql, params) => (synced.push(params), []));
    const nu = fakeMember(1, { nick: 'Mới' });
    await onMemberUpdate({ partial: false, displayName: 'Cũ' }, nu);
    assert.equal(synced.length, 1);
    assert.deepEqual(synced[0], [GUILD, sid(1), 'Mới']);
    await onMemberUpdate({ partial: false, displayName: 'Mới' }, nu);
    await onMemberUpdate({ partial: false, displayName: 'x' }, fakeMember(2, { bot: true }));
    assert.equal(synced.length, 1);
    mock.restoreAll();
  });
  it('a failing DB write is logged, not thrown, and nothing is written', async () => {
    const logged = [];
    const written = [];
    mock.method(console, 'error', (...a) => logged.push(a.join(' ')));
    mock.method(db, 'q', async () => {
      throw new Error('db');
    });
    await assert.doesNotReject(() => onMemberUpdate({ partial: false, displayName: 'a' }, fakeMember(1, { nick: 'b' })));
    assert.equal(logged.length, 1);
    assert.match(logged[0], /guildMemberUpdate: db/);
    assert.equal(written.length, 0);
    mock.restoreAll();
  });
});

describe('userUpdate (global name / username change)', () => {
  // discord.js updates the SAME User object in place, so member.displayName already reflects the change in the handler.
  const shared = (n, globalName) => {
    const user = { id: sid(n), username: `user${n}`, globalName, bot: false, displayName: globalName };
    const member = { id: sid(n), nickname: null, user, get displayName() { return this.nickname || user.globalName || user.username; } };
    return { user, member };
  };
  const setup = () => {
    const synced = [];
    mock.method(db, 'q', async (sql, params) => (synced.push([{ guildId: params[0], discordId: params[1] }, params[2]]), []));
    return synced;
  };
  it('syncs every guild where the user has no nickname; nickname holders and non-members are skipped', async () => {
    const synced = setup();
    const a = shared(1, 'Cũ');
    const nick = { id: sid(1), nickname: 'Biệt Danh', displayName: 'Biệt Danh' };
    const guilds = new Map([
      ['G1', { id: 'G1', members: { cache: new Map([[sid(1), a.member]]) } }],
      ['G2', { id: 'G2', members: { cache: new Map([[sid(1), nick]]) } }],
      ['G3', { id: 'G3', members: { cache: new Map() } }],
    ]);
    mock.method(Client.prototype, 'login', async () => 'x');
    const client = await startBot('t');
    Object.defineProperty(client, 'guilds', { value: { cache: guilds } });
    a.user.globalName = 'Mới';
    a.user.displayName = 'Mới'; // in-place update, as discord.js does
    client.emit(Events.UserUpdate, { partial: false, displayName: 'Cũ', bot: false }, a.user);
    for (let k = 0; k < 5; k++) await new Promise((r) => setImmediate(r));
    assert.deepEqual(synced, [[{ guildId: 'G1', discordId: sid(1) }, 'Mới']]);
    await client.destroy();
    mock.restoreAll();
  });
  it('unchanged display name or a bot does nothing', async () => {
    const synced = setup();
    const a = shared(1, 'Same');
    await onUserUpdate({ partial: false, displayName: 'Same' }, a.user);
    await onUserUpdate({ partial: false, displayName: 'x' }, { ...a.user, bot: true });
    assert.equal(synced.length, 0);
    mock.restoreAll();
  });
});

describe('ensureMembers / warm-up', () => {
  beforeEach(() => {
    clearMemberCache();
    mock.method(console, 'warn', () => {});
  });
  const mkGuild = (id, { size = 1, memberCount, fetch }) => ({ id, memberCount, members: { cache: new Collection(Array.from({ length: size }, (_, k) => [`m${k}`, {}])), fetch } });
  it('fetches while the guild is not known to be complete, then stops fetching', async () => {
    let n = 0;
    const g = mkGuild('F1', { size: 5, fetch: async () => (n++, g.members.cache) });
    assert.equal((await ensureMembers(g)).complete, true);
    await ensureMembers(g);
    assert.equal(n, 1);
  });
  it('a cache smaller than memberCount is fetched again even when flagged', async () => {
    let n = 0;
    const g = mkGuild('F2', { size: 3, memberCount: 3, fetch: async () => (n++, g.members.cache) });
    await ensureMembers(g);
    await ensureMembers(g);
    assert.equal(n, 1);
    g.memberCount = 10;
    await ensureMembers(g);
    assert.equal(n, 2);
  });
  it('a failed fetch is reported and never sets the flag', async () => {
    let n = 0;
    const g = mkGuild('F3', { fetch: async () => { n++; throw new Error('no intent'); } });
    const r = await ensureMembers(g);
    assert.equal(r.complete, false);
    await ensureMembers(g);
    assert.equal(n, 2, 'tried again: the guild was never marked as fetched');
  });
  it('GatewayRateLimitError is retried after retry_after (seconds), at most 3 times, then fails', async () => {
    const rl = () => Object.assign(new Error('rate'), { name: 'GatewayRateLimitError', data: { retry_after: 2 } });
    const sleeps = [];
    let n = 0;
    const g = mkGuild('F4', { fetch: async () => { n++; if (n < 3) throw rl(); return g.members.cache; } });
    const r = await ensureMembers(g, { retries: 3, sleep: async (ms) => sleeps.push(ms) });
    assert.equal(r.complete, true);
    assert.deepEqual(sleeps, [2000, 2000]);
    const h = mkGuild('F5', { fetch: async () => { throw rl(); } });
    sleeps.length = 0;
    assert.equal((await ensureMembers(h, { retries: 3, sleep: async (ms) => sleeps.push(ms) })).complete, false);
    assert.equal(sleeps.length, 3);
  });
  it('warmAllGuilds fetches one guild after another, never in parallel', async () => {
    let running = 0;
    let peak = 0;
    const mk = (id) => mkGuild(id, { fetch: async () => { peak = Math.max(peak, ++running); await new Promise((r) => setImmediate(r)); running--; return new Collection(); } });
    await warmAllGuilds([mk('W1'), mk('W2'), mk('W3')]);
    assert.equal(peak, 1);
  });
  it('warmMembers marks the guild as fetched (the admin lists then skip the fetch)', async () => {
    let n = 0;
    const g = mkGuild('W4', { size: 2, fetch: async () => (n++, g.members.cache) });
    await warmMembers(g);
    await ensureMembers(g);
    assert.equal(n, 1);
  });
});

describe('adm:unreg / adm:unregping / adm:roster handlers', () => {
  let stored;
  let sent;
  let aggregated;
  const members = (list) => new Collection(list.map((m) => [m.id, m]));
  const guild = { id: GUILD, roles: { cache: new Collection() }, emojis: { cache: new Collection() }, members: { cache: members([]), fetch: async () => {} } };

  let claimedAt;
  let leaveIds;
  beforeEach(() => {
    sent = [];
    leaveIds = new Set();
    clearMemberCache();
    claimedAt = null;
    mock.method(warService, 'claimManualRemind', async (_id, now) => {
      if (claimedAt) return { claimed: false, at: claimedAt };
      claimedAt = now;
      return { claimed: true, at: null };
    });
    mock.method(warService, 'releaseManualRemind', async () => { claimedAt = null; });
    config = { ...guildConfigService.defaultConfig(GUILD), announceChannelId: 'chan', memberRoleId: MEMBER_ROLE, classes: CLASSES };
    regs = [{ discordId: sid(0), status: 'join', displayName: 'Đã đk' }];
    stored = { _id: EID, guildId: GUILD, title: 'Bang chiến T7', status: 'open', startAt: vn(2099, 10, 10, 20), deadlineAt: vn(2099, 10, 10, 18), channelId: 'chan', messageId: '555' }; // far future: the reminder needs an open registration whatever today is
    warService.getCurrentEvent = async () => stored;
    warService.getEvent = async () => stored;
    guild.members.cache = members([
      fakeMember(0, { roles: [MEMBER, cls('Tố Vấn')] }),
      ...Array.from({ length: 119 }, (_, k) => fakeMember(k + 1, { roles: [MEMBER, cls(CLASSES[k % 3])], name: `Người ${k + 1}` })),
    ]);
    aggregated = [{ _id: sid(1), count: 2, last: new Date('2026-10-03T13:00:00Z') }];
    mock.method(db, 'q', async (sql) => (/from registrations r/.test(sql) ? aggregated : []));
    mock.method(console, 'error', () => {});
    mock.method(console, 'warn', () => {});
  });
  const interaction = (extra = {}) => {
    const log = [];
    const channel = { id: 'chan', send: async (p) => sent.push(p) };
    const i = {
      guildId: GUILD,
      guild,
      user: { id: sid(900), username: 'adm' },
      member: { roles: [], permissions: MANAGE },
      memberPermissions: MANAGE,
      client: { channels: { fetch: async () => channel } },
      deferReply: async (o) => log.push(['deferReply', o]),
      deferUpdate: async () => log.push(['deferUpdate']),
      editReply: async (o) => log.push(['editReply', o]),
      reply: async (o) => log.push(['reply', o]),
      followUp: async (o) => log.push(['followUp', o]),
      ...extra,
    };
    return { i, log };
  };
  const last = (log) => log.filter((l) => l[0] === 'editReply').pop()[1];
  const body = (v) => (typeof v === 'string' ? v : assertV2Message(v).text); // text of a reply: plain string or Components V2

  it('adm:unreg: ephemeral list of the 119 missing people with the total', async () => {
    const { i, log } = interaction();
    await adminHandler.handle(i, ['adm', 'unreg']);
    assert.equal(log[0][0], 'deferReply');
    assert.equal(log[0][1].flags, MessageFlags.Ephemeral);
    const v = assertV2Message(last(log));
    assert.match(v.texts[0], /\*\*119\*\* người có role/);
    assert.match(v.texts[1], /^\*\*⏳ CHƯA ĐĂNG KÝ \(119\)\*\*/); // no game roster: a single block
    assert.deepEqual(v.buttons.map((c) => c.custom_id), [`adm:unregping:${EID}`, 'adm:gmap', 'adm:unreg:r']);
  });
  it('adm:unreg: leave is retired - no "ĐANG XIN NGHỈ" block, people with a leave request are plain unregistered, and the leave service is not read; auto:leave rows still count as registered', async () => {
    leaveIds = new Set([sid(1), sid(2), sid(3), sid(4)]);
    regs.push({ discordId: sid(3), status: 'join', displayName: 'Tự đk' });
    regs.push({ discordId: sid(4), status: 'absent', auto: 'leave', displayName: 'Tự động' }); // an old registration the bot made: stays as it is
    const { i, log } = interaction();
    await adminHandler.handle(i, ['adm', 'unreg']);
    const v = assertV2Message(last(log));
    assert.match(v.texts[0], /\*\*117\*\* người có role/, '120 tracked - the registered (0, 3, 4)');
    assert.match(v.texts[1], /^\*\*⏳ CHƯA ĐĂNG KÝ \(117\)\*\*/);
    assert.ok(!v.texts.some((t) => t.includes('XIN NGHỈ') || t.includes('🙋')), v.texts.join('|'));
  });
  it('adm:unregok: the manual reminder pings everybody not registered, also members with a leave request', async () => {
    leaveIds = new Set([sid(1)]);
    const t = interaction();
    await adminHandler.handle(t.i, ['adm', 'unregok', EID]);
    const all = sent.map((p) => p.content).join('\n');
    assert.ok(all.includes(`<@${sid(1)}>`), 'pinged: no leave exclusion');
    assert.ok(all.includes(`<@${sid(2)}>`));
    assert.match(body(last(t.log)), /Đã nhắc 119 người/);
  });
  it('adm:unreg:r edits the list in place (deferUpdate)', async () => {
    const { i, log } = interaction();
    await adminHandler.handle(i, ['adm', 'unreg', 'r']);
    assert.equal(log[0][0], 'deferUpdate');
  });
  it('non-admin is refused; memberRoleId unset explains /setup; no event says so', async () => {
    let t = interaction({ member: { roles: [], permissions: NOBODY }, memberPermissions: NOBODY });
    await adminHandler.handle(t.i, ['adm', 'unreg']);
    assert.match(last(t.log), /không có quyền/);
    config.memberRoleId = null;
    t = interaction();
    await adminHandler.handle(t.i, ['adm', 'unreg']);
    assert.match(body(last(t.log)), /Chưa chọn role thành viên — vào \/setup/);
    assert.doesNotMatch(body(last(t.log)), /chưa có ai/);
    config.memberRoleId = MEMBER_ROLE;
    stored = null;
    t = interaction();
    await adminHandler.handle(t.i, ['adm', 'unreg']);
    assert.match(body(last(t.log)), /Chưa có bang chiến/);
  });
  it('an old message with text content is not edited to V2: plain line + a new ephemeral V2 follow-up', async () => {
    const { i, log } = interaction({ message: { content: 'Nhắc 119 người?' } });
    await adminHandler.handle(i, ['adm', 'unreg', 'r']);
    const edit = log.find((l) => l[0] === 'editReply')[1];
    assert.equal(edit.content, 'Danh sách đã được làm mới — bấm 👥 Chưa đăng ký để mở lại.');
    assert.deepEqual(edit.components, []);
    const fu = log.find((l) => l[0] === 'followUp')[1];
    assert.ok(fu.flags & MessageFlags.Ephemeral);
    assert.match(assertV2Message(fu).texts[0], /\*\*119\*\* người/);
  });
  it('sendReminder: a failing final edit still reports "đã nhắc" through a follow-up', async () => {
    const t = interaction({ editReply: async () => { throw new Error('Unknown Message'); } });
    await adminHandler.handle(t.i, ['adm', 'unregok', EID]);
    assert.ok(sent.length > 0);
    const fu = t.log.find((l) => l[0] === 'followUp')[1];
    assert.match(assertV2Message(fu).text, /Đã nhắc 119 người/);
    assert.ok(fu.flags & MessageFlags.Ephemeral);
  });
  it('unregping asks first and sends nothing; unregok posts chunked mentions (users only) with the link', async () => {
    let t = interaction();
    await adminHandler.handle(t.i, ['adm', 'unregping', EID]);
    assert.equal(sent.length, 0);
    assert.match(body(last(t.log)), /Nhắc \*\*119\*\* người/);
    assert.deepEqual(assertV2Message(last(t.log)).buttons.map((c) => c.custom_id), [`adm:unregok:${EID}`, 'adm:unreg:r']);

    t = interaction();
    await adminHandler.handle(t.i, ['adm', 'unregok', EID]);
    assert.ok(sent.length >= 2, 'a long mention list is split');
    assert.ok(sent.every((p) => p.content.length <= 2000 && p.allowedMentions.parse.length === 1 && p.allowedMentions.parse[0] === 'users'));
    assert.match(sent[0].content, /discord\.com\/channels\/800000000000000001\/chan\/555/);
    const mentioned = sent.flatMap((p) => p.content.match(/<@\d+>/g) || []);
    assert.equal(new Set(mentioned).size, 119);
    assert.ok(!mentioned.includes(`<@${sid(0)}>`), 'registered people are not pinged');
    assert.match(body(last(t.log)), /Đã nhắc 119 người/);
  });
  it('unregok on a closed event does not ping', async () => {
    stored.status = 'locked';
    const { i } = interaction();
    await adminHandler.handle(i, ['adm', 'unregok', EID]);
    assert.equal(sent.length, 0);
  });
  it('unregping/unregok after the deadline (status still open) do not ping', async () => {
    stored.deadlineAt = new Date(Date.now() - 60000);
    for (const a of ['unregping', 'unregok']) {
      const { i, log } = interaction();
      await adminHandler.handle(i, ['adm', a, EID]);
      assert.match(body(last(log)), /đã đóng/);
    }
    assert.equal(sent.length, 0);
  });
  it('an event id of another guild is refused for unregping and unregok', async () => {
    stored.guildId = '800000000000000999';
    for (const a of ['unregping', 'unregok']) {
      const { i, log } = interaction();
      await adminHandler.handle(i, ['adm', a, EID]);
      assert.match(body(last(log)), /không tồn tại/);
    }
    assert.equal(sent.length, 0);
    assert.equal(claimedAt, null, 'no claim was taken');
  });
  it('non-admin adm:unregok is refused and nothing is sent or claimed', async () => {
    const { i, log } = interaction({ member: { roles: [], permissions: NOBODY }, memberPermissions: NOBODY });
    await adminHandler.handle(i, ['adm', 'unregok', EID]);
    assert.match(body(last(log)), /không có quyền/); // an in-place V2 view gets a V2 notice, not plain text
    assert.equal(sent.length, 0);
    assert.equal(claimedAt, null);
  });
  it('a second click is refused by the claim: nothing is sent twice', async () => {
    await adminHandler.handle(interaction().i, ['adm', 'unregok', EID]);
    const first = sent.length;
    assert.ok(first > 0);
    const t = interaction();
    await adminHandler.handle(t.i, ['adm', 'unregok', EID]);
    assert.equal(sent.length, first);
    assert.match(body(last(t.log)), /Vừa nhắc lúc <t:\d+:R>, đợi 10 phút/);
  });
  it('two clicks at the same time (in-process lock) send once', async () => {
    const [a, b] = [interaction(), interaction()];
    await Promise.all([adminHandler.handle(a.i, ['adm', 'unregok', EID]), adminHandler.handle(b.i, ['adm', 'unregok', EID])]);
    const mentioned = sent.flatMap((p) => p.content.match(/<@\d+>/g) || []);
    assert.equal(new Set(mentioned).size, mentioned.length, 'nobody pinged twice');
    assert.equal(mentioned.length, 119);
    const replies = [body(last(a.log)), body(last(b.log))];
    assert.equal(replies.filter((c) => /Đã nhắc 119/.test(c)).length, 1);
  });
  it('a failure part-way reports N/M sent without suggesting a full retry', async () => {
    let n = 0;
    const t = interaction({ client: { channels: { fetch: async () => ({ send: async (p) => { if (++n === 2) throw new Error('boom'); sent.push(p); } }) } } });
    await adminHandler.handle(t.i, ['adm', 'unregok', EID]);
    const c = body(last(t.log));
    assert.match(c, /Chỉ 1\/\d+ tin đã gửi/);
    assert.doesNotMatch(c, /thử lại/);
    assert.ok(claimedAt, 'the cooldown stays: some people were already pinged');
  });
  it('nothing sent (channel unavailable) gives the claim back', async () => {
    const t = interaction({ client: { channels: { fetch: async () => { throw new Error('Missing Access'); } } } });
    await adminHandler.handle(t.i, ['adm', 'unregok', EID]);
    assert.match(body(last(t.log)), /Chưa có tin nào/);
    assert.equal(claimedAt, null);
  });
  it('a cold cache (size 1) is fetched; the list then shows the people', async () => {
    let fetched = 0;
    const full = guild.members.cache;
    guild.members.cache = members([fakeMember(0, { roles: [MEMBER] })]);
    guild.members.fetch = async () => { fetched++; guild.members.cache = full; };
    const { i, log } = interaction();
    await adminHandler.handle(i, ['adm', 'unreg']);
    guild.members.fetch = async () => {};
    assert.equal(fetched, 1);
    assert.match(body(last(log)), /CHƯA ĐĂNG KÝ \(119\)/);
  });
  it('fetch failure: the list is shown with the warning and never claims everybody registered', async () => {
    const full = guild.members.cache;
    guild.members.cache = members([fakeMember(0, { roles: [MEMBER] })]); // the only cached member is registered
    guild.members.fetch = async () => { throw new Error('Missing intent'); };
    const { i, log } = interaction();
    await adminHandler.handle(i, ['adm', 'unreg']);
    guild.members.fetch = async () => {};
    guild.members.cache = full;
    const text = body(last(log));
    assert.match(text, /Không tải đủ danh sách/);
    assert.doesNotMatch(text, /Mọi thành viên đã đăng ký/);
    assertV2Message(last(log));
  });
  it('fetch failure on unregping with nobody found: warning content, no "all registered" text', async () => {
    const full = guild.members.cache;
    guild.members.cache = members([fakeMember(0, { roles: [MEMBER] })]);
    guild.members.fetch = async () => { throw new Error('Missing intent'); };
    const { i, log } = interaction();
    await adminHandler.handle(i, ['adm', 'unregping', EID]);
    guild.members.fetch = async () => {};
    guild.members.cache = full;
    const text = body(last(log));
    assert.match(text, /Không tải đủ danh sách/);
    assert.doesNotMatch(text, /Mọi thành viên đã đăng ký|Không còn ai chưa đăng ký/);
  });
  describe('with a game roster', () => {
    const gameRosterService = require('../src/services/gameRosterService');
    let stubs;
    beforeEach(() => {
      // people 1..3 are in the game roster (person 1 under another name), the other 116 are unknown
      stubs = [
        mock.method(db, 'isConnected', () => true),
        mock.method(gameRosterService, 'matchGuild', async () => ({
          match: { matched: [1, 2, 3].map((n) => ({ discordId: sid(n), how: 'norm', manual: false, game: { name: n === 1 ? 'Bánh Bao' : `Người ${n}` } })), unlisted: [] },
        })),
      ];
    });
    const restore = () => {
      stubs.forEach((m) => m.mock.restore());
    };
    const mentionsOf = () => sent.flatMap((p) => p.content.match(/<@\d+>/g) || []);

    it('adm:unreg: green block with the 3 people in game (game name in parentheses), grey block with the rest', async () => {
      try {
        const { i, log } = interaction();
        await adminHandler.handle(i, ['adm', 'unreg']);
        const v = assertV2Message(last(log));
        assert.match(v.texts[1], /^\*\*✅ ĐANG Ở BANG – NÊN NHẮC \(3\)\*\*/);
        assert.match(v.texts[1], /Thiết Y: Người 1 \(Bánh Bao\)/);
        assert.match(v.texts[2], /^\*\*❔ CHƯA BIẾT LÀ AI TRONG GAME \(116\)\*\*/);
        assert.deepEqual(v.buttons.map((b) => b.custom_id), [`adm:unregping:${EID}:g`, `adm:unregping:${EID}`, 'adm:gmap', 'adm:unreg:r']);
      } finally {
        restore();
      }
    });
    it('a prefix-only match does not count as "in game"', async () => {
      try {
        gameRosterService.matchGuild.mock.mockImplementation(async () => ({
          match: { matched: [{ discordId: sid(1), how: 'prefix', manual: false, game: { name: 'Người 1 xyz' } }, { discordId: sid(2), how: 'fold', manual: false, game: { name: 'Người 2' } }], unlisted: [] },
        }));
        const { i, log } = interaction();
        await adminHandler.handle(i, ['adm', 'unreg']);
        const v = assertV2Message(last(log));
        assert.match(v.texts[1], /^\*\*✅ ĐANG Ở BANG – NÊN NHẮC \(1\)\*\*/);
        assert.match(v.texts[2], /^\*\*❔ CHƯA BIẾT LÀ AI TRONG GAME \(118\)\*\*/);
      } finally {
        restore();
      }
    });
    it('ping people in game only: confirm says 3, send mentions exactly those 3 (users only); cooldown is shared with "all"', async () => {
      try {
        let t = interaction();
        await adminHandler.handle(t.i, ['adm', 'unregping', EID, 'g']);
        assert.equal(sent.length, 0);
        assert.match(body(last(t.log)), /Nhắc \*\*3\*\* người đang ở bang/);
        assert.doesNotMatch(body(last(t.log)), /CHƯA BIẾT LÀ AI/);
        assert.deepEqual(assertV2Message(last(t.log)).buttons.map((b) => b.custom_id), [`adm:unregok:${EID}:g`, 'adm:unreg:r']);

        t = interaction();
        await adminHandler.handle(t.i, ['adm', 'unregok', EID, 'g']);
        assert.deepEqual(new Set(mentionsOf()), new Set([1, 2, 3].map((n) => `<@${sid(n)}>`)));
        assert.ok(sent.every((p) => p.allowedMentions.parse.length === 1 && p.allowedMentions.parse[0] === 'users'));
        assert.match(body(last(t.log)), /Đã nhắc 3 người/);

        const before = sent.length;
        t = interaction();
        await adminHandler.handle(t.i, ['adm', 'unregok', EID]); // the old id = ping everybody, but the cooldown is shared
        assert.equal(sent.length, before);
        assert.match(body(last(t.log)), /Vừa nhắc/);
        t = interaction();
        await adminHandler.handle(t.i, ['adm', 'unregok', EID, 'g']);
        assert.equal(sent.length, before);
        assert.match(body(last(t.log)), /Vừa nhắc/);
      } finally {
        restore();
      }
    });
    it('the old unregok id still pings everybody (119); "all" after "in game" is blocked the other way round too', async () => {
      try {
        const t = interaction();
        await adminHandler.handle(t.i, ['adm', 'unregok', EID]);
        assert.equal(new Set(mentionsOf()).size, 119);
        const again = interaction();
        await adminHandler.handle(again.i, ['adm', 'unregok', EID, 'g']);
        assert.match(body(last(again.log)), /Vừa nhắc/);
      } finally {
        restore();
      }
    });
    it('only-in-game with nobody in game explains and sends nothing', async () => {
      try {
        gameRosterService.matchGuild.mock.mockImplementation(async () => ({ match: { matched: [], unlisted: [] } }));
        const t = interaction();
        await adminHandler.handle(t.i, ['adm', 'unregok', EID, 'g']);
        assert.equal(sent.length, 0);
        assert.equal(claimedAt, null);
        assert.match(body(last(t.log)), /Chưa có ai xác định được/);
      } finally {
        restore();
      }
    });
    it('non-admin cannot use the new ids (:g); nothing is sent or claimed', async () => {
      try {
        for (const a of ['unregping', 'unregok']) {
          const t = interaction({ member: { roles: [], permissions: NOBODY }, memberPermissions: NOBODY });
          await adminHandler.handle(t.i, ['adm', a, EID, 'g']);
          assert.match(body(last(t.log)), /không có quyền/);
        }
        assert.equal(sent.length, 0);
        assert.equal(claimedAt, null);
      } finally {
        restore();
      }
    });
  });
  it('adm:gmap (🔗 Ghép tên) is admin-gated and opens a new ephemeral reply', async () => {
    const t = interaction({ member: { roles: [], permissions: NOBODY }, memberPermissions: NOBODY });
    await adminHandler.handle(t.i, ['adm', 'gmap']);
    assert.equal(t.log[0][0], 'deferReply');
    assert.equal(t.log[0][1].flags, MessageFlags.Ephemeral);
    assert.match(last(t.log), /không có quyền/);
  });
});
