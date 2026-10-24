// "Off quá N ngày không xin phép": the status text -> days parser, the notice (who is listed - leave requests are ignored, the 40-line cap, no pings),
// the once-per-import claim, and the admin buttons (✅ Đã xử lý, the threshold form). DB / Discord stubbed (no MongoDB needed).
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { Collection, ContainerComponent, MessageFlags, PermissionsBitField, PermissionFlagsBits } = require('discord.js');
const { vn, sid } = require('./helpers');
const { assertV2Message, assertModal } = require('./discordLimits');

const guildConfigService = require('../src/services/guildConfigService');
const refresher = require('../src/bot/refresher');
const sheetSync = require('../src/bot/sheetSync');
let config;
let savedPatch;
guildConfigService.getConfigOrDefault = async () => config;
guildConfigService.updateConfig = async (guildId, patch) => ((savedPatch = [guildId, patch]), { ...config, ...patch });
refresher.schedulePanelRefresh = () => {};
sheetSync.scheduleSync = () => {};

const gameRoster = require('../src/services/gameRosterService');
const departure = require('../src/services/departureService');
const offNotice = require('../src/bot/offNotice');
const adminHandler = require('../src/bot/interactions/admin');
const { buildOffNotice, MAX_LINES } = require('../src/bot/ui/offNotice');
const { buildOffWarnModal } = require('../src/bot/ui/settingsModal');
const { clearMemberCache } = require('../src/bot/memberCache');
const eventLog = require('../src/eventLog');

const GUILD = '800000000000000004';
const ROSTER = 'c'.repeat(24);
const IMPORTED = vn(2026, 10, 14, 9, 0);
const day = (n) => n * 24 * 3600 * 1000;
const endOf = (d) => new Date(d.getTime() + day(1) - 1000);

afterEach(() => mock.restoreAll());

describe('parseOffDays', () => {
  const cases = [
    ['Online', 0],
    ['online', 0],
    ['Trong 1 giờ', 0],
    ['Trong 12 phút', 0],
    ['5 giờ trước', 0],
    ['1 giờ trước', 0],
    ['30 phút trước', 0],
    ['1 ngày trước', 1],
    ['3 ngày trước', 3],
    ['12 ngày trước', 12],
    ['1 tuần trước', 7],
    ['1 tháng trước', 30],
    ['2 tháng trước', 60],
    ['1 năm trước', 365],
    ['  3   NGÀY  Trước ', 3],
    ['3 ngay truoc', 3],
    ['', null],
    [null, null],
    [undefined, null],
    ['Offline', null],
    ['Trong 3 ngày', null],
    ['vài ngày trước', null],
    ['-3 ngày trước', null],
    ['3 ngày', null],
  ];
  for (const [text, days] of cases) {
    it(`${JSON.stringify(text)} -> ${days}`, () => assert.equal(gameRoster.parseOffDays(text), days));
  }
});

describe('classify (pure)', () => {
  const m = (name, offDays) => ({ name, offDays, status: '' });
  const A = m('An', 6);
  const B = m('Bình', 7);
  const C = m('Chi', 8);
  const D = m('Dũng', 2);
  const E = m('Em', null);
  const F = m('Phúc', 6);
  const G = m('Giang', 5);
  const leaveOf = (discordId, from, to) => ({ discordId, from, to });
  const run = (patch = {}) =>
    offNotice.classify({
      members: [A, B, C, D, E, F, G, { name: 'NoField' }],
      links: new Map([[A, sid(1)], [C, sid(3)], [F, sid(6)]]),
      importedAt: IMPORTED,
      days: 5,
      ...patch,
    });

  it('lists the members off for at least N days, longest first; unknown / lower / missing offDays never', () => {
    assert.deepEqual(run().off.map((p) => [p.name, p.offDays]), [['Chi', 8], ['Bình', 7], ['An', 6], ['Phúc', 6], ['Giang', 5]]);
    assert.deepEqual(run({ days: 7 }).off.map((p) => p.name), ['Chi', 'Bình']);
  });
  it('linked people carry their discord id, unlinked ones do not', () => {
    const off = run().off;
    assert.equal(off.find((p) => p.name === 'An').discordId, sid(1));
    assert.ok(!('discordId' in off.find((p) => p.name === 'Bình')));
  });
  it('leave requests are ignored (the feature is retired): everybody off >= N days is listed, nobody is excused, there is no onLeave', () => {
    const leaves = [leaveOf(sid(3), vn(2026, 10, 10), endOf(vn(2026, 10, 20))), leaveOf(sid(1), vn(2026, 10, 1), endOf(vn(2026, 10, 30)))];
    const ended = [{ discordId: sid(6), to: endOf(vn(2026, 10, 3)) }];
    const r = run({ leaves, ended });
    assert.deepEqual(r.off.map((p) => p.name), ['Chi', 'Bình', 'An', 'Phúc', 'Giang']);
    assert.ok(!('onLeave' in r));
    assert.ok(r.off.every((p) => !('expired' in p)), 'no "đơn nghỉ hết hạn" marker');
    assert.deepEqual(r, run());
  });
});

describe('buildOffNotice', () => {
  const people = (n, name = (i) => `Tên ${i}`) => Array.from({ length: n }, (_, i) => ({ name: name(i), offDays: 6 + (i % 3) }));
  const build = (off, days = 5) => buildOffNotice({ rosterId: ROSTER, importedAt: IMPORTED, days, off });
  const json = (payload) => payload.components[0].toJSON();

  it('V2 container, the title / lines / law note and ONE admin button; nobody can be pinged; no leave marker or section', () => {
    const payload = build([{ name: 'Bình', offDays: 6 }, { name: 'An', offDays: 6, discordId: sid(1) }, { name: 'Phúc', offDays: 9, discordId: sid(2), expired: endOf(vn(2026, 10, 3)) }]);
    const v2 = assertV2Message(payload);
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    assert.equal(json(payload).accent_color, 0xe67e22);
    assert.ok(v2.text.includes('### 😴 Off game quá 5 ngày'));
    assert.match(v2.text, /Theo danh sách game cập nhật <t:\d+:R> \(3 người\)\./);
    assert.ok(v2.text.includes('• **Bình** — off 6 ngày\n'), 'an unlinked name: no mention');
    assert.ok(v2.text.includes(`• **An** — off 6 ngày · <@${sid(1)}>\n`));
    assert.ok(v2.text.includes(`• **Phúc** — off 9 ngày · <@${sid(2)}>`));
    assert.ok(!v2.text.includes('🙋') && !v2.text.includes('xin nghỉ') && !v2.text.includes('hết hạn'), 'no leave marker, no exclusion section');
    assert.ok(v2.text.includes('-# Theo luật bang: off không báo quá 5 ngày thì mời ra khỏi bang. Bot không tự kick — kiểm tra trước.'));
    assert.deepEqual(v2.buttons.map((b) => [b.custom_id, b.label]), [[`adm:offok:${ROSTER}`, '✅ Đã xử lý']]);
  });
  it('the title follows the threshold', () => {
    const v2 = assertV2Message(build(people(2), 3));
    assert.ok(v2.text.includes('### 😴 Off game quá 3 ngày') && v2.text.includes('quá 3 ngày thì mời ra'));
  });
  it('at most 40 lines, then "… và K người nữa"; the subtitle still counts everybody', () => {
    const v2 = assertV2Message(build(people(55)));
    assert.equal((v2.text.match(/^• /gm) || []).length, MAX_LINES);
    assert.ok(v2.text.includes('… và 15 người nữa'));
    assert.ok(v2.text.includes('(55 người)'));
  });
  it('long names and many linked people stay inside the 4000-char budget, never silently cut', () => {
    const off = Array.from({ length: 40 }, (_, i) => ({ name: `${'Ê'.repeat(40)}${i}`, offDays: 9, discordId: sid(i + 1), }));
    const payload = build(off);
    const v2 = assertV2Message(payload); // <= 4000 chars and <= 40 components
    const shown = (v2.text.match(/^• /gm) || []).length;
    assert.ok(shown >= 20 && shown <= MAX_LINES);
    if (shown < 40) assert.ok(v2.text.includes(`… và ${40 - shown} người nữa`));
  });
  it('a game name cannot inject a mention, a link or markdown', () => {
    const v2 = assertV2Message(build([{ name: '<@123456789012345678> @everyone **x** [a](http://e.vil)', offDays: 9 }, { name: '@here <#123456789012345678>', offDays: 9, discordId: sid(3) }]));
    for (const bad of ['<@123456789012345678>', '@everyone', '@here', '<#123456789012345678>', '**x**']) assert.ok(!v2.text.includes(bad), bad);
  });
});

describe('noticeGuild', () => {
  const person = (n, name, bot = false) => ({ id: sid(n), displayName: name, user: { id: sid(n), username: `u${n}`, bot }, roles: { cache: new Collection() } });
  const member = (name, offDays, extra = {}) => ({ name, rank: 'Bang Chúng', className: 'Thiết Y', daysInGuild: 1, status: '', offDays, ...extra });
  let sent;
  let channelError;
  let claims;
  let claimResult;
  let overlapping;
  let listCalls;
  let ended;
  let latestDocs;
  let lines;
  let fetchFails;
  let roster;
  let guildMembers;

  const channel = { id: 'admin-chan', send: async (p) => { if (channelError) throw channelError; sent.push(p); } };
  const guild = () => ({ id: GUILD, memberCount: guildMembers.size, members: { cache: guildMembers, fetch: async () => { if (fetchFails) throw new Error('timeout'); return guildMembers; } } });
  const client = () => ({ guilds: { cache: new Map([[GUILD, guild()]]), fetch: async () => guild() }, channels: { fetch: async () => channel } });

  beforeEach(() => {
    clearMemberCache();
    offNotice.resetWarned();
    sent = [];
    channelError = null;
    claims = [];
    claimResult = true;
    overlapping = [];
    listCalls = [];
    ended = [];
    fetchFails = false;
    lines = [];
    eventLog.setSink((l) => lines.push(JSON.parse(l)));
    config = { ...guildConfigService.defaultConfig(GUILD), adminChannelId: 'admin-chan', offWarnDays: 5 };
    guildMembers = new Collection([person(1, 'An Linked'), person(2, 'Bot', true), person(3, 'Chi Nghỉ'), person(4, 'Phúc Cũ')].map((x) => [x.id, x]));
    roster = {
      _id: ROSTER,
      importedAt: IMPORTED,
      members: [member('An Linked', 6), member('Bình Chưa Link', 9), member('Chi Nghỉ', 8), member('Dũng Online', 0), member('Em Không Rõ', null), member('Phúc Cũ', 6), member('Giang Dưới', 4)],
    };
    latestDocs = () => roster;
    mock.method(gameRoster, 'latest', async (g, projection) => (projection ? { _id: roster._id, importedAt: roster.importedAt } : latestDocs()));
    mock.method(gameRoster, 'loadMappings', async () => new Map());
    mock.method(departure, 'claimOffNotice', async (...a) => (claims.push(a), claimResult));
    mock.method(console, 'error', () => {});
    mock.method(console, 'warn', () => {});
  });
  afterEach(() => eventLog.setSink(null));
  const offLines = () => lines.filter((l) => l.area === 'roster' && l.ev === 'off_notice');
  const post = () => assertV2Message(sent[0], { forCreate: true });

  it('posts ONE card: linked names get their mention text, unlinked ones do not, leave requests are NOT looked at (an active one does not excuse), nobody can be pinged', async () => {
    overlapping = [{ discordId: sid(3), from: vn(2026, 10, 1), to: endOf(vn(2026, 10, 30)) }];
    ended = [{ discordId: sid(4), to: endOf(vn(2026, 10, 2)) }];
    const out = await offNotice.noticeGuild(client(), GUILD, { config });
    assert.deepEqual(out, { posted: true, count: 4 });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].allowedMentions, { parse: [] });
    const v2 = post();
    assert.ok(v2.text.includes('• **Bình Chưa Link** — off 9 ngày\n'));
    assert.ok(v2.text.includes(`• **An Linked** — off 6 ngày · <@${sid(1)}>\n`));
    assert.ok(v2.text.includes(`• **Chi Nghỉ** — off 8 ngày · <@${sid(3)}>\n`), 'on leave or not: listed');
    assert.ok(v2.text.includes(`• **Phúc Cũ** — off 6 ngày · <@${sid(4)}>\n`), 'no "đơn nghỉ hết hạn" marker');
    assert.ok(!v2.text.includes('🙋') && !v2.text.includes('Đang xin nghỉ'));
    for (const gone of ['Dũng Online', 'Em Không Rõ', 'Giang Dưới']) assert.ok(!v2.text.includes(gone), gone);
    assert.ok(v2.text.includes('(4 người)'));
    assert.deepEqual(listCalls, [], 'the leave requests are never read');
    assert.deepEqual(claims, [[GUILD, ROSTER, IMPORTED]], 'claimed by the import id AND its importedAt (monotonic)');
    assert.deepEqual(offLines().map((l) => [l.posted, l.count, l.onLeave]), [[true, 4, undefined]]);
  });
  it('everybody is below the threshold or unknown: the import is claimed, nothing is posted', async () => {
    roster.members = [member('Giang Dưới', 4), member('Em Không Rõ', null)];
    const out = await offNotice.noticeGuild(client(), GUILD, { config });
    assert.deepEqual(out, { posted: false, reason: 'none', count: 0 });
    assert.equal(sent.length, 0);
    assert.equal(claims.length, 1);
    assert.deepEqual(offLines().map((l) => [l.posted, l.reason]), [[false, 'none']]);
  });
  it('an import saved before offDays existed has no numbers: nothing is posted (claimed once)', async () => {
    roster.members = [{ name: 'An Linked', status: '9 ngày trước' }, { name: 'Bình', status: '' }];
    const out = await offNotice.noticeGuild(client(), GUILD, { config });
    assert.equal(out.reason, 'none');
    assert.equal(sent.length, 0);
  });
  it('the threshold is the config value (3 lists more people); a config without the field means 5', async () => {
    await offNotice.noticeGuild(client(), GUILD, { config: { ...config, offWarnDays: 3 } });
    assert.ok(post().text.includes('Giang Dưới') && post().text.includes('### 😴 Off game quá 3 ngày'));
    sent = [];
    const old = { ...config };
    delete old.offWarnDays;
    await offNotice.noticeGuild(client(), GUILD, { config: old });
    assert.ok(!post().text.includes('Giang Dưới'));
    assert.equal(offNotice.thresholdOf(old), 5);
    assert.equal(offNotice.thresholdOf({ offWarnDays: 0 }), 0);
  });
  it('threshold 0 = off: the import is claimed silently (a later switch-on waits for the next import), nothing is posted', async () => {
    const out = await offNotice.noticeGuild(client(), GUILD, { config: { ...config, offWarnDays: 0 } });
    assert.deepEqual(out, { posted: false, reason: 'disabled' });
    assert.equal(sent.length, 0);
    assert.equal(claims.length, 1);
    assert.equal(offLines()[0].reason, 'disabled');
  });
  it('the claim is lost (another tick / process / the upload got it, or a newer import was claimed) -> nothing is posted', async () => {
    claimResult = false;
    const out = await offNotice.noticeGuild(client(), GUILD, { config });
    assert.deepEqual(out, { posted: false, reason: 'claimed' });
    assert.equal(sent.length, 0);
  });
  it('an import already handled (offNoticeRosterId = latest) costs one cheap read: no members, no claim, no post', async () => {
    const out = await offNotice.noticeGuild(client(), GUILD, { config: { ...config, offNoticeRosterId: ROSTER } });
    assert.deepEqual(out, { posted: false, reason: 'handled' });
    assert.equal(claims.length, 0);
    assert.equal(gameRoster.latest.mock.callCount(), 1, 'only the id / importedAt projection was read');
  });
  it('a newer import landed while this one was being worked on: gives up WITHOUT claiming', async () => {
    let n = 0;
    gameRoster.latest.mock.mockImplementation(async (g, projection) => {
      if (!projection) return roster;
      return ++n === 1 ? { _id: ROSTER, importedAt: IMPORTED } : { _id: 'd'.repeat(24), importedAt: vn(2026, 10, 14, 9, 5) };
    });
    const out = await offNotice.noticeGuild(client(), GUILD, { config });
    assert.deepEqual(out, { posted: false, reason: 'changed' });
    assert.equal(claims.length, 0);
    assert.equal(sent.length, 0);
  });
  it('the member list cannot be fetched: NOT claimed (the next tick retries), logged once', async () => {
    fetchFails = true;
    for (let i = 0; i < 3; i++) assert.equal((await offNotice.noticeGuild(client(), GUILD, { config })).reason, 'members_incomplete');
    assert.equal(claims.length, 0);
    assert.equal(sent.length, 0);
    assert.equal(offLines().filter((l) => l.reason === 'members_incomplete').length, 1);
  });
  it('no admin channel -> nothing is read or claimed; no import -> nothing; a guild the bot left -> logged once', async () => {
    assert.equal((await offNotice.noticeGuild(client(), GUILD, { config: { ...config, adminChannelId: null } })).reason, 'no_admin_channel');
    roster = null;
    gameRoster.latest.mock.mockImplementation(async () => null);
    assert.equal((await offNotice.noticeGuild(client(), GUILD, { config })).reason, 'no_roster');
    const away = { guilds: { cache: new Map(), fetch: async () => guild() }, channels: { fetch: async () => channel } };
    assert.equal((await offNotice.noticeGuild(away, GUILD, { config })).reason, 'not_in_guild');
    await offNotice.noticeGuild(away, GUILD, { config });
    assert.equal(offLines().filter((l) => l.reason === 'not_in_guild').length, 1);
    assert.equal(claims.length, 0);
  });
  it('a failing send after the claim never throws and is not retried', async () => {
    channelError = new Error('Missing Access');
    const out = await offNotice.noticeGuild(client(), GUILD, { config });
    assert.deepEqual(out, { posted: false, reason: 'error' });
    assert.equal(claims.length, 1);
    assert.equal(offLines().pop().reason, 'error');
  });
  it('noticeDue visits every guild that has somewhere to post', async () => {
    const seen = [];
    mock.method(departure, 'listNoticeConfigs', async () => [{ guildId: 'g1' }, { guildId: 'g2' }]);
    mock.method(offNotice, 'noticeGuild', async (c, g, o) => seen.push([g, o.config.guildId]));
    await offNotice.noticeDue(client());
    assert.deepEqual(seen, [['g1', 'g1'], ['g2', 'g2']]);
  });
});

describe('adm:offok / adm:offcfg', () => {
  const MANAGE = new PermissionsBitField(PermissionFlagsBits.ManageGuild);
  const NOBODY = new PermissionsBitField(PermissionFlagsBits.SendMessages);

  function interaction({ admin = true, message, fields = {} } = {}) {
    const log = [];
    const perms = admin ? MANAGE : NOBODY;
    const i = {
      guildId: GUILD,
      guild: { id: GUILD },
      client: {},
      user: { id: sid(900) },
      message,
      member: { roles: [], permissions: perms },
      memberPermissions: perms,
      fields: { getTextInputValue: (k) => fields[k] ?? '' },
      deferReply: async (o) => log.push(['deferReply', o]),
      deferUpdate: async () => log.push(['deferUpdate']),
      editReply: async (o) => log.push(['editReply', o]),
      followUp: async (o) => log.push(['followUp', o]),
      reply: async (o) => log.push(['reply', o]),
      showModal: async (m) => log.push(['showModal', m]),
    };
    return { i, log };
  }
  const last = (log, kind) => log.filter((l) => l[0] === kind).pop()[1];
  const card = () => ({
    components: buildOffNotice({ rosterId: ROSTER, importedAt: IMPORTED, days: 5, off: [{ name: 'Bình', offDays: 9 }] }).components.map((c) => new ContainerComponent(c.toJSON())), // parsed components, as a received message has them
  });

  beforeEach(() => {
    config = { ...guildConfigService.defaultConfig(GUILD), offWarnDays: 5 };
    savedPatch = null;
    mock.method(console, 'error', () => {});
  });

  it('adm:offok by a non-admin: only they are told; the card is untouched', async () => {
    const { i, log } = interaction({ admin: false, message: card() });
    await adminHandler.handle(i, ['adm', 'offok', ROSTER]);
    assert.deepEqual(log.map((l) => l[0]), ['deferUpdate', 'followUp']);
    assert.match(last(log, 'followUp').content, /không có quyền/);
    assert.equal(last(log, 'followUp').flags & MessageFlags.Ephemeral, MessageFlags.Ephemeral);
  });
  it('adm:offok by an admin: the card turns green, loses its button and says who handled it; its texts are kept', async () => {
    const { i, log } = interaction({ message: card() });
    await adminHandler.handle(i, ['adm', 'offok', ROSTER]);
    assert.deepEqual(log.map((l) => l[0]), ['deferUpdate', 'editReply']);
    const payload = last(log, 'editReply');
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    const c = payload.components[0].toJSON();
    assert.equal(c.accent_color, 0x2ecc71);
    const text = JSON.stringify(c);
    assert.ok(text.includes('Bình') && text.includes('Bot không tự kick'));
    assert.match(text, new RegExp(`✅ <@${sid(900)}> đã xử lý <t:\\d+:R>`));
    assert.ok(!text.includes('custom_id'), 'no buttons');
  });
  it('adm:offcfg opens the threshold form with the current value (admin only)', async () => {
    let t = interaction({ admin: false });
    await adminHandler.handle(t.i, ['adm', 'offcfg']);
    assert.deepEqual(t.log.map((l) => l[0]), ['reply']);
    config.offWarnDays = 7;
    t = interaction();
    await adminHandler.handle(t.i, ['adm', 'offcfg']);
    const m = assertModal(last(t.log, 'showModal'));
    assert.equal(m.custom_id, 'adm:offcfgModal');
    assert.equal(m.components[0].component.value, '7');
    assert.equal(buildOffWarnModal({}).toJSON().components[0].component.value, '5', 'a config without the field shows the default');
  });
  it('adm:offcfgModal saves 0..60; anything else is refused and saves nothing; a non-admin saves nothing', async () => {
    for (const [raw, days] of [['7', 7], ['0', 0], [' 60 ', 60], ['05', 5]]) {
      savedPatch = null;
      const { i, log } = interaction({ fields: { days: raw } });
      await adminHandler.handle(i, ['adm', 'offcfgModal']);
      assert.deepEqual(savedPatch, [GUILD, { offWarnDays: days }], raw);
      assert.match(last(log, 'editReply'), days ? new RegExp(`${days} ngày`) : /Đã tắt cảnh báo/);
    }
    for (const raw of ['', 'abc', '61', '100', '-1', '1.5', '3 ngày']) {
      savedPatch = null;
      const { i, log } = interaction({ fields: { days: raw } });
      await adminHandler.handle(i, ['adm', 'offcfgModal']);
      assert.equal(savedPatch, null, JSON.stringify(raw));
      assert.match(last(log, 'editReply'), /từ 0 đến 60/);
    }
    savedPatch = null;
    const { i } = interaction({ admin: false, fields: { days: '3' } });
    await adminHandler.handle(i, ['adm', 'offcfgModal']);
    assert.equal(savedPatch, null);
  });
});
