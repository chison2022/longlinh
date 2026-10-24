// "Left the guild in game but still on Discord": findDeparted (pure), the notice payload and its two admin buttons (DB / Discord stubbed).
const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { Collection, ContainerComponent, MessageFlags, PermissionsBitField, PermissionFlagsBits } = require('discord.js');
const gameRoster = require('../src/services/gameRosterService');
const departure = require('../src/services/departureService');
const guildConfigService = require('../src/services/guildConfigService');
const refresher = require('../src/bot/refresher');
const sheetSync = require('../src/bot/sheetSync');
const { clearMemberCache } = require('../src/bot/memberCache');
const { sid, vn } = require('./helpers');

let config;
guildConfigService.getConfigOrDefault = async () => config;
const panelRefreshed = [];
const synced = [];
refresher.schedulePanelRefresh = (...a) => panelRefreshed.push(a);
sheetSync.scheduleSync = (...a) => synced.push(a);
const adminHandler = require('../src/bot/interactions/admin');
const { buildDepartNotice, MAX_LINES } = require('../src/bot/ui/departNotice');

const { findDeparted } = departure;
const link = (n, gameName, source = 'admin', extra = {}) => ({ discordId: sid(n), gameName, source, displayName: `D${n}`, ...extra });
const roster = (...names) => names.map((name) => ({ name }));
const here = (...ns) => new Set(ns.map(sid));
const ids = (list) => list.map((d) => d.discordId);

describe('findDeparted', () => {
  it('flags a linked name that the roster does not have, and keeps one that it has', () => {
    const out = findDeparted([link(1, 'Kelo'), link(2, 'Đã Rời', 'self')], roster('Kelo'), here(1, 2));
    assert.deepEqual(out, [{ discordId: sid(2), gameName: 'Đã Rời', source: 'self', displayName: 'D2', gameNameAt: null }]);
  });
  it('compares by nameKey: case, accents, spacing and lookalike letters are the same name', () => {
    const roster1 = roster('Hắc Phong', 'Kelo', 'A B');
    assert.deepEqual(findDeparted([link(1, 'hac phong'), link(2, 'Кelo'), link(3, 'ab')], roster1, here(1, 2, 3)), []);
  });
  it('a roster name cut with "…" counts as the name of every linked name that starts with its stem', () => {
    assert.deepEqual(findDeparted([link(1, 'Nguyen Van Anh Tuan')], roster('Nguyễn Văn An…'), here(1)), []);
    assert.deepEqual(ids(findDeparted([link(1, 'Tran Van Binh')], roster('Nguyễn Văn An…'), here(1))), [sid(1)], 'another stem: still flagged');
  });
  it('an ambiguous cut stem keeps ALL the people it could be (never flags wrongly)', () => {
    const out = findDeparted([link(1, 'Nguyen Van Anh'), link(2, 'Nguyen Van An Khang')], roster('Nguyen Van A…'), here(1, 2));
    assert.deepEqual(out, []);
  });
  it('a linked name that is itself cut ("Abc…") is present while any roster name starts with it', () => {
    assert.deepEqual(findDeparted([link(1, 'Long Linh Đại Hiệp…')], roster('Long Linh Đại Hiệp Số Một'), here(1)), []);
    assert.deepEqual(ids(findDeparted([link(1, 'Long Linh Đại Hiệp…')], roster('Kelo'), here(1))), [sid(1)]);
  });
  it('only people still in the server; bots are skipped (by link flag or by the server member info)', () => {
    const linked = [link(1, 'Gone1'), link(2, 'Gone2'), link(3, 'Gone3'), link(4, 'Gone4', 'admin', { bot: true })];
    const inGuild = new Map([[sid(1), { name: 'Một' }], [sid(3), { name: 'Ba', bot: true }], [sid(4), { name: 'Bốn' }]]);
    assert.deepEqual(findDeparted(linked, roster('Kelo'), inGuild).map((d) => [d.discordId, d.displayName]), [[sid(1), 'Một']]);
  });
  it('guildMemberIds may be a Set or an array; the roster may be the import doc', () => {
    const linked = [link(1, 'Gone')];
    assert.equal(findDeparted(linked, { members: roster('Kelo') }, [sid(1)]).length, 1);
    assert.equal(findDeparted(linked, roster('Kelo'), new Set()).length, 0);
  });
  it('a name without a key (symbols only) is never judged; a legacy link has the admin source', () => {
    assert.deepEqual(findDeparted([link(1, '★★★')], roster('Kelo'), here(1)), []);
    assert.equal(findDeparted([{ discordId: sid(1), gameName: 'Gone' }], roster('Kelo'), here(1))[0].source, 'admin');
  });
  it('a link made AFTER the roster was imported is not judged (the roster cannot know that person)', () => {
    const at = vn(2026, 10, 8, 12);
    const before = link(1, 'Gone1', 'admin', { gameNameAt: vn(2026, 10, 8, 11) });
    const after = link(2, 'Gone2', 'self', { gameNameAt: vn(2026, 10, 8, 13) });
    const legacy = link(3, 'Gone3', 'admin', { gameNameAt: null });
    assert.deepEqual(ids(findDeparted([before, after, legacy], roster('Kelo'), here(1, 2, 3), { importedAt: at })), [sid(1), sid(3)]);
    assert.equal(findDeparted([after], roster('Kelo'), here(2)).length, 1, 'no importedAt given: nothing to compare with');
  });
  it('a selfFree (typed) name is judged only when the previous roster had it; otherwise never flagged', () => {
    const typed = link(1, 'Tự Gõ', 'selfFree');
    assert.deepEqual(findDeparted([typed], roster('Kelo'), here(1), { previous: roster('Kelo') }), [], 'never in a roster');
    assert.deepEqual(findDeparted([typed], roster('Kelo'), here(1)), [], 'no previous roster at all');
    assert.deepEqual(ids(findDeparted([typed], roster('Kelo'), here(1), { previous: roster('Kelo', 'tu go') })), [sid(1)], 'was in the previous roster, gone now');
    assert.deepEqual(ids(findDeparted([link(2, 'Tự Gõ', 'self')], roster('Kelo'), here(2))), [sid(2)], 'a checked link is judged as before');
  });
  it('a roster name cut as "..." counts as cut', () => {
    assert.deepEqual(findDeparted([link(1, 'Nguyen Van Anh Tuan')], roster('Nguyễn Văn An...'), here(1)), []);
    assert.deepEqual(findDeparted([link(1, 'Long Linh Đại Hiệp...')], roster('Long Linh Đại Hiệp Số Một'), here(1)), []);
  });
  it('sorted by the name shown', () => {
    const out = findDeparted([link(1, 'X1', 'admin', { displayName: 'Zed' }), link(2, 'X2', 'admin', { displayName: 'Anh' })], roster('Kelo'), here(1, 2));
    assert.deepEqual(ids(out), [sid(2), sid(1)]);
  });
});

describe('buildDepartNotice', () => {
  const people = (n, name = (i) => `Tên ${i}`) => Array.from({ length: n }, (_, i) => ({ discordId: sid(i + 1), gameName: name(i), source: ['admin', 'self', 'selfFree'][i % 3] }));
  const build = (departed) => buildDepartNotice({ rosterId: 'abc123', importedAt: vn(2026, 10, 8, 12), departed });
  const json = (payload) => payload.components[0].toJSON();
  const allText = (payload) => JSON.stringify(json(payload));

  it('people who still say "join" for the current war are listed apart, with a 🗑️ Gỡ báo danh button; none -> no button', () => {
    const payload = buildDepartNotice({ rosterId: 'abc123', importedAt: vn(2026, 10, 8, 12), departed: people(3), joined: [sid(2)], warTitle: 'Bang chiến T7 (24/10)' });
    const text = allText(payload);
    assert.match(text, /Vẫn đang báo danh Tham gia\*\* trận Bang chiến T7 \(24\/10\) \(1\): <@100000000000000002>/);
    assert.ok(text.includes('adm:depreg:abc123'));
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    assert.ok(!allText(build(people(3))).includes('adm:depreg'));
  });

  it('V2 container, warning accent, no mentions allowed, the wanted texts and the two buttons', () => {
    const payload = build(people(3));
    assert.equal(payload.flags & MessageFlags.IsComponentsV2, MessageFlags.IsComponentsV2);
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    const c = json(payload);
    assert.equal(c.accent_color, 0xe67e22);
    const text = allText(payload);
    assert.ok(text.includes('### 🚪 Đã rời bang trong game nhưng còn trong Discord'));
    assert.match(text, /Theo danh sách game cập nhật <t:\d+:R> \(3 người\)\./);
    assert.ok(text.includes(`• <@${sid(1)}> — tên game **Tên 0** (liên kết: admin)`));
    assert.ok(text.includes('(liên kết: tự chọn)') && text.includes('(liên kết: tự nhập)'));
    assert.ok(text.includes('-# Có thể họ chỉ đổi tên trong game — kiểm tra trước khi kick. Bot không tự kick.'));
    const row = c.components.find((x) => x.components && x.components[0] && x.components[0].custom_id);
    assert.deepEqual(row.components.map((b) => [b.custom_id, b.label]), [['adm:depok:abc123', '✅ Đã xử lý'], ['adm:depunlink:abc123', '🔗 Gỡ liên kết những người này']]);
  });
  it('at most 40 lines, then "… và K người nữa"; the subtitle still counts everybody', () => {
    const text = allText(build(people(55)));
    assert.equal((text.match(/• <@/g) || []).length, MAX_LINES);
    assert.ok(text.includes('… và 15 người nữa'));
    assert.ok(text.includes('(55 người)'));
  });
  it('long names: the lines are cut to the 4000-char text budget with a "… và K người nữa" tail, never silently', () => {
    const payload = build(people(40, (i) => `${'Ê'.repeat(28)}${i}`));
    const texts = json(payload).components.filter((x) => typeof x.content === 'string').map((x) => x.content);
    assert.ok(texts.join('').length <= 4000, `${texts.join('').length}`);
    const shown = (allText(payload).match(/• <@/g) || []).length;
    assert.ok(shown >= 25 && shown <= MAX_LINES);
    if (shown < 40) assert.ok(allText(payload).includes(`… và ${40 - shown} người nữa`));
  });
  it('a game name cannot inject a mention or markdown', () => {
    const text = allText(build([{ discordId: sid(1), gameName: '<@123456789012345678> @everyone **x**', source: 'admin' }]));
    assert.ok(!text.includes('<@123456789012345678>'));
    assert.ok(!text.includes('@everyone'));
  });
});

describe('adm:depok / adm:depunlink', () => {
  const GUILD = '800000000000000002';
  const MANAGE = new PermissionsBitField(PermissionFlagsBits.ManageGuild);
  const NOBODY = new PermissionsBitField(PermissionFlagsBits.SendMessages);
  const person = (n, bot = false) => ({ id: sid(n), displayName: `D${n}`, user: { username: `u${n}`, bot }, roles: { cache: new Collection() } });
  const R1 = { _id: 'a'.repeat(24), importedAt: vn(2026, 10, 8, 12), members: roster('Kelo') };
  const R2 = { _id: 'b'.repeat(24), importedAt: vn(2026, 10, 9, 12), members: roster('Kelo', 'Gone2') };
  let latest;
  let notice;
  let linked;
  let removed;
  let members;
  let fetchFails;

  beforeEach(() => {
    clearMemberCache();
    config = { ...guildConfigService.defaultConfig(GUILD) };
    panelRefreshed.length = 0;
    synced.length = 0;
    removed = [];
    latest = R2;
    fetchFails = false;
    linked = [link(1, 'Kelo'), link(2, 'Gone1'), link(3, 'Gone2'), link(4, 'Gone4'), link(5, 'Gone5')];
    members = new Collection([1, 2, 3, 5].map((n) => [sid(n), person(n)])); // 4 left the server too
    mock.method(gameRoster, 'latest', async () => latest);
    mock.method(gameRoster, 'byId', async (g, id) => [R1, R2].find((r) => r._id === id) || null);
    mock.method(gameRoster, 'removeMappings', async (g, list) => {
      removed.push([g, list]);
      return list.length;
    });
    notice = { rosterId: R1._id, ids: [sid(2), sid(3), sid(5)], more: 0, at: vn(2026, 10, 8, 12, 30) }; // the people notice R1 listed
    mock.method(departure, 'loadLinked', async () => linked);
    mock.method(departure, 'getNotice', async () => notice);
    mock.method(console, 'warn', () => {});
  });

  function interaction({ admin = true, message } = {}) {
    const log = [];
    const perms = admin ? MANAGE : NOBODY;
    const guild = { id: GUILD, memberCount: members.size, members: { cache: members, fetch: async () => { if (fetchFails) throw new Error('timeout'); return members; } } };
    const i = {
      guildId: GUILD,
      guild,
      client: {},
      user: { id: sid(900) },
      message,
      member: { roles: [], permissions: perms },
      memberPermissions: perms,
      deferReply: async () => log.push(['deferReply']),
      deferUpdate: async () => log.push(['deferUpdate']),
      editReply: async (o) => log.push(['editReply', o]),
      followUp: async (o) => log.push(['followUp', o]),
    };
    return { i, log };
  }
  const last = (log, kind) => log.filter((l) => l[0] === kind).pop()[1];
  const noticeMessage = () => ({ components: buildDepartNotice({ rosterId: R1._id, importedAt: R1.importedAt, departed: [{ discordId: sid(2), gameName: 'Gone1', source: 'admin' }] }).components.map((c) => new ContainerComponent(c.toJSON())) }); // real parsed components, as a received message has them

  it('adm:depok: only an admin; others get a private "no permission" and the notice is untouched', async () => {
    const { i, log } = interaction({ admin: false, message: noticeMessage() });
    await adminHandler.handle(i, ['adm', 'depok', R1._id]);
    assert.deepEqual(log.map((l) => l[0]), ['deferUpdate', 'followUp']);
    assert.match(last(log, 'followUp').content, /không có quyền/);
    assert.equal(last(log, 'followUp').flags & MessageFlags.Ephemeral, MessageFlags.Ephemeral);
  });
  it('adm:depok: the notice becomes green, loses its buttons and says who handled it', async () => {
    const { i, log } = interaction({ message: noticeMessage() });
    await adminHandler.handle(i, ['adm', 'depok', R1._id]);
    assert.deepEqual(log.map((l) => l[0]), ['deferUpdate', 'editReply']);
    const payload = last(log, 'editReply');
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    const c = payload.components[0].toJSON();
    assert.equal(c.accent_color, 0x2ecc71);
    const text = JSON.stringify(c);
    assert.ok(text.includes('Gone1') && text.includes('Bot không tự kick'), 'the original texts are kept');
    assert.match(text, new RegExp(`✅ <@${sid(900)}> đã xử lý <t:\\d+:R>`));
    assert.ok(!text.includes('custom_id'), 'no buttons');
  });
  it('adm:depunlink: only an admin (nothing is removed for anybody else)', async () => {
    const { i, log } = interaction({ admin: false });
    await adminHandler.handle(i, ['adm', 'depunlink', R2._id]);
    assert.deepEqual(log.map((l) => l[0]), ['deferReply', 'editReply']);
    assert.match(last(log, 'editReply'), /không có quyền/);
    assert.equal(removed.length, 0);
  });
  it('adm:depunlink: unlinks the listed people who are STILL departed and still here; a re-link in between is kept', async () => {
    // notice of R1: Gone1, Gone2, Gone5 (Gone4 had left the server). R2 (latest) has Gone2 again -> kept.
    const { i, log } = interaction();
    await adminHandler.handle(i, ['adm', 'depunlink', R1._id]);
    assert.deepEqual(removed, [[GUILD, [sid(2), sid(5)]]]);
    assert.match(last(log, 'editReply'), /Đã gỡ liên kết tên game của 2 người/);
    assert.equal(synced.length, 1, 'the sheet sync is scheduled');
    assert.equal(panelRefreshed.length, 1);
  });
  it('adm:depunlink: nobody left to unlink -> says so and changes nothing', async () => {
    linked = [link(1, 'Kelo')];
    const { i, log } = interaction();
    await adminHandler.handle(i, ['adm', 'depunlink', R1._id]);
    assert.equal(removed.length, 0);
    assert.match(last(log, 'editReply'), /Không còn ai cần gỡ/);
    assert.equal(synced.length, 0);
  });
  it('adm:depunlink: a notice whose import no longer exists is refused', async () => {
    const { i, log } = interaction();
    await adminHandler.handle(i, ['adm', 'depunlink', R2._id]); // the stored notice is R1's
    assert.equal(removed.length, 0);
    assert.match(last(log, 'editReply'), /đã cũ/);
  });
  it('adm:depunlink: a link made after the notice was posted is kept', async () => {
    linked = [link(1, 'Kelo'), link(2, 'Gone1'), link(3, 'Gone2'), link(5, 'Gone5', 'self', { gameNameAt: vn(2026, 10, 8, 13) })];
    const { i, log } = interaction();
    await adminHandler.handle(i, ['adm', 'depunlink', R1._id]);
    assert.deepEqual(removed, [[GUILD, [sid(2)]]], 'sid(5) re-linked after the notice; sid(3) is back in R2');
    assert.match(last(log, 'editReply'), /1 người/);
  });
  it('adm:depunlink: people the notice never listed are not touched; the hidden count is reported', async () => {
    notice = { ...notice, ids: [sid(2)], more: 2 }; // sid(5) was behind "… và 2 người nữa"
    const { i, log } = interaction();
    await adminHandler.handle(i, ['adm', 'depunlink', R1._id]);
    assert.deepEqual(removed, [[GUILD, [sid(2)]]]);
    assert.match(last(log, 'editReply'), /2 người nữa.*chưa bị đụng tới/);
  });
  it('adm:depunlink: a notice that is not the stored (last posted) one is refused', async () => {
    notice = null;
    const { i, log } = interaction();
    await adminHandler.handle(i, ['adm', 'depunlink', R1._id]);
    assert.equal(removed.length, 0);
    assert.match(last(log, 'editReply'), /đã cũ/);
  });
  it('adm:depunlink: an incomplete member list only adds a warning (it can hide people, never add one)', async () => {
    fetchFails = true;
    const { i, log } = interaction();
    await adminHandler.handle(i, ['adm', 'depunlink', R1._id]);
    assert.deepEqual(removed, [[GUILD, [sid(2), sid(5)]]]);
    assert.match(last(log, 'editReply'), /Không tải đủ danh sách/);
  });
});
