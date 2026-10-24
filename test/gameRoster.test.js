// In-game member roster: parse, diff, Discord matching, PNG pages, xlsx and the admin handlers (DB / Discord stubbed).
const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { Collection, PermissionsBitField, PermissionFlagsBits } = require('discord.js');
const gameRoster = require('../src/services/gameRosterService');
const guildConfigService = require('../src/services/guildConfigService');
const defaults = require('../config/defaults');
const { clearMemberCache } = require('../src/bot/memberCache');
const { clearClassStyles } = require('../src/bot/classStyle');
const { assertEmbed } = require('./discordLimits');
const { sid, vn } = require('./helpers');

let config;
guildConfigService.getConfigOrDefault = async () => config;
const refresher = require('../src/bot/refresher');
const panelRefreshed = []; // schedulePanelRefresh calls (stubbed before the handlers capture it)
refresher.schedulePanelRefresh = (...a) => panelRefreshed.push(a);
const departNotice = require('../src/bot/departNotice');
const offNotice = require('../src/bot/offNotice');
const adminHandler = require('../src/bot/interactions/admin');
const gameRosterHandler = require('../src/bot/interactions/gameRoster');
const { buildPanel } = require('../src/bot/ui/panel');
const { buildGameUploadModal } = require('../src/bot/ui/settingsModal');
const { renderRosterPngs } = require('../src/bot/ui/rosterImage');
const { buildGameRosterXlsx } = require('../src/services/rosterWorkbook');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEADER = ['STT', 'Tên nhân vật', 'Chức vụ', 'Phái', 'Lực chiến', 'Ngày vào bang', 'Trạng thái (lúc quay)'];
const CLASSES = defaults.classes;

async function workbook(rows, { sheet = 'Thành viên', header = HEADER } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  ws.addRow(header);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const m = (name, extra = {}) => ({ name, rank: 'Bang Chúng', className: 'Thiết Y', daysInGuild: 10, status: 'Online', ...extra });

describe('parseRosterXlsx', () => {
  it('MAX_ROWS: more than 500 member rows are rejected', async () => {
    const rows = Array.from({ length: gameRoster.MAX_ROWS + 1 }, (_, i) => [i + 1, `N${i}`, 'Bang Chúng', 'Thiết Y', 1, 1, 'Online']);
    await assert.rejects(gameRoster.parseRosterXlsx(await workbook(rows), CLASSES), /Quá nhiều dòng/);
    await gameRoster.parseRosterXlsx(await workbook(rows.slice(0, gameRoster.MAX_ROWS)), CLASSES);
  });
  it('a name cut as "..." is stored as the cut "…" of the game', async () => {
    const out = await gameRoster.parseRosterXlsx(await workbook([[1, 'Thiên Long Bá...', 'x', 'Thiết Y', 1, 1, ''], [2, 'Bình ...', 'x', 'Thiết Y', 1, 1, ''], [3, 'A.B', 'x', 'Thiết Y', 1, 1, '']]), CLASSES);
    assert.deepEqual(out.map((x) => x.name), ['Thiên Long Bá…', 'Bình…', 'A.B']);
    assert.ok(gameRoster.isCutName('Abc...') && gameRoster.isCutName('Abc…') && !gameRoster.isCutName('Abc'));
  });
  it('zip-bomb: a tiny archive that inflates far beyond the limits is rejected before exceljs reads it', async () => {
    const JSZip = require('jszip');
    const zip = new JSZip();
    zip.file('xl/worksheets/sheet1.xml', Buffer.alloc(25 * 1024 * 1024)); // 25 MB of zeros compresses to ~25 KB
    const bomb = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    assert.ok(bomb.length < 200 * 1024);
    await assert.rejects(gameRoster.parseRosterXlsx(bomb, CLASSES), /File nén bất thường/);
    const high = new JSZip();
    high.file('a.xml', Buffer.alloc(2 * 1024 * 1024)); // ratio > 100 even though the total is small
    await assert.rejects(gameRoster.parseRosterXlsx(await high.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), CLASSES), /File nén bất thường/);
  });
  it('assertZipSane relies on JSZip private entry._data sizes: fail loudly if a jszip upgrade changes that shape', async () => {
    const JSZip = require('jszip');
    const zip = new JSZip();
    zip.file('a.txt', 'x'.repeat(5000));
    const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    const entry = loaded.files['a.txt'];
    assert.ok(entry && entry._data, 'entry._data exists');
    assert.equal(entry._data.uncompressedSize, 5000);
    assert.ok(entry._data.compressedSize > 0 && entry._data.compressedSize < 5000);
    assert.equal(require('jszip/package.json').version, require('../package.json').dependencies.jszip, 'jszip is pinned exactly');
  });
  it('L7/L10: numbers are rounded, "." and error cells are rejected, echoed text is clipped; the old "Lực chiến" column is ignored', async () => {
    const [ok] = await gameRoster.parseRosterXlsx(await workbook([[1, 'A', 'x', 'Thiết Y', 'không phải số', 7.4, '']]), CLASSES);
    assert.equal(ok.daysInGuild, 7);
    assert.ok(!('power' in ok));
    await assert.rejects(gameRoster.parseRosterXlsx(await workbook([[1, 'A', 'x', 'Thiết Y', 1, '.', '']]), CLASSES), /Ngày vào bang.*phải là số/);
    await assert.rejects(gameRoster.parseRosterXlsx(await workbook([[1, 'A', 'x', 'Thiết Y', 1, { error: '#N/A' }, '']]), CLASSES), /ô lỗi \(#N\/A\)/);
    await assert.rejects(gameRoster.parseRosterXlsx(await workbook([[1, 'A', 'x', 'Thiết Y', 1, 'x'.repeat(200), '']]), CLASSES), (e) => e.message.length < 120 && /…/.test(e.message));
  });
  it('reads the rows, converts numbers, skips empty rows and normalizes class names to the configured label', async () => {
    const buf = await workbook([
      [1, 'Nhất Kiếm Thử', 'Huyết Đường Chủ', 'tố vấn', 132540, 149, 'Online'],
      [null, null, null, null, null, null, null],
      [3, '  Cabät ', 'Bang Chúng', 'Cửu Linh', '156,967', '5', '4 giờ trước'],
      [4, 'Lạ', 'Học Việc', 'Phái Lạ', 1, 1, ''],
    ]);
    const members = await gameRoster.parseRosterXlsx(buf, CLASSES);
    assert.equal(members.length, 3);
    assert.deepEqual(members[0], { name: 'Nhất Kiếm Thử', rank: 'Huyết Đường Chủ', className: 'Tố Vấn', daysInGuild: 149, status: 'Online', offDays: 0 });
    assert.equal(members[1].name, 'Cabät');
    assert.equal(members[1].daysInGuild, 5);
    assert.equal(members[2].className, 'Phái Lạ', 'an unknown class is kept as typed');
  });
  it('keeps the in-game "Trạng thái" text and the days offline worked out from it; both header spellings work; old text stays unknown', async () => {
    const statuses = ['Online', 'Trong 1 giờ', '5 giờ trước', '3 ngày trước', '1 ngày trước', '2 tháng trước', '', 'Offline', 'Trong 3 ngày'];
    const rows = statuses.map((st, i) => [i + 1, `N${i}`, 'Bang Chúng', 'Thiết Y', 1, 1, st]);
    const expected = [0, 0, 0, 3, 1, 60, null, null, null];
    for (const header of [undefined, ['STT', 'Tên nhân vật', 'Chức vụ', 'Phái', 'Lực chiến', 'Ngày vào bang', 'Trạng thái']]) {
      const out = await gameRoster.parseRosterXlsx(await workbook(rows, header ? { header } : {}), CLASSES);
      assert.deepEqual(out.map((x) => x.status), statuses);
      assert.deepEqual(out.map((x) => x.offDays), expected);
    }
  });
  it('offDaysOf: the saved number only (an import made before it was saved has none -> unknown, never warned about)', () => {
    assert.equal(gameRoster.offDaysOf({ status: '9 ngày trước', offDays: 9 }), 9);
    assert.equal(gameRoster.offDaysOf({ status: '9 ngày trước' }), null);
    assert.equal(gameRoster.offDaysOf({ status: '9 ngày trước', offDays: null }), null);
    assert.equal(gameRoster.offDaysOf(null), null);
  });
  it('finds the columns by header name, whatever their order', async () => {
    const buf = await workbook([['Online', 7, 'A', 'Thiết Y', 'Bang Chúng', 100, 1]], { header: ['Trạng thái (lúc quay)', 'Ngày vào bang', 'Tên nhân vật', 'Phái', 'Chức vụ', 'Lực chiến', 'STT'] });
    assert.deepEqual(await gameRoster.parseRosterXlsx(buf, CLASSES), [{ name: 'A', rank: 'Bang Chúng', className: 'Thiết Y', daysInGuild: 7, status: 'Online', offDays: 0 }]);
  });
  it('rejects a wrong sheet, a missing header, a non-number, an empty list and garbage', async () => {
    await assert.rejects(async () => gameRoster.parseRosterXlsx(await workbook([[1, 'A', 'x', 'y', 1, 1, 'z']], { sheet: 'Sheet1' })), /sheet "Thành viên"/);
    await assert.rejects(async () => gameRoster.parseRosterXlsx(await workbook([[1, 'A']], { header: ['STT', 'Tên nhân vật'] })), /Thiếu cột: Chức vụ, Phái, Ngày vào bang, Trạng thái/);
    await assert.rejects(async () => gameRoster.parseRosterXlsx(await workbook([[1, 'A', 'x', 'y', 1, 'abc', 'z']])), /Dòng 2.*Ngày vào bang/);
    await assert.rejects(async () => gameRoster.parseRosterXlsx(await workbook([])), /không có thành viên/);
    await assert.rejects(() => gameRoster.parseRosterXlsx(Buffer.from('not an xlsx')), /Không đọc được file/);
  });
});

describe('diff', () => {
  it('lists added, removed and rank changes', () => {
    const prev = [m('A'), m('B'), m('C', { rank: 'Học Việc' })];
    const cur = [m('A'), m('C', { rank: 'Bang Chúng' }), m('D', { className: 'Cửu Linh' })];
    const d = gameRoster.diff(prev, cur);
    assert.deepEqual(d.added.map((x) => x.name), ['D']);
    assert.deepEqual(d.removed.map((x) => x.name), ['B']);
    assert.deepEqual(d.rankChanged, [{ name: 'C', from: 'Học Việc', to: 'Bang Chúng' }]);
    assert.deepEqual(d.renamed, []);
  });
  it('a rename = same class, days in the guild kept (grown by at most 30) among the leftovers (closest first), not counted as added/removed', () => {
    const prev = [m('Old1', { daysInGuild: 100 }), m('Old2', { daysInGuild: 40 }), m('Gone', { className: 'Cửu Linh' })];
    const cur = [m('New2', { daysInGuild: 42 }), m('New1', { daysInGuild: 107 }), m('Far', { daysInGuild: 2 })];
    const d = gameRoster.diff(prev, cur);
    assert.deepEqual(d.renamed.map((r) => [r.from.name, r.to.name]).sort(), [['Old1', 'New1'], ['Old2', 'New2']]);
    assert.deepEqual(d.added.map((x) => x.name), ['Far']);
    assert.deepEqual(d.removed.map((x) => x.name), ['Gone']);
  });
  it('days grown by 30 is a rename, 31 or fewer days (a newcomer) is not; another class is never a rename', () => {
    assert.equal(gameRoster.diff([m('A', { daysInGuild: 10 })], [m('B', { daysInGuild: 40 })]).renamed.length, 1);
    assert.equal(gameRoster.diff([m('A', { daysInGuild: 10 })], [m('B', { daysInGuild: 41 })]).renamed.length, 0);
    assert.equal(gameRoster.diff([m('A', { daysInGuild: 10 })], [m('B', { daysInGuild: 3 })]).renamed.length, 0);
    assert.equal(gameRoster.diff([m('A')], [m('B', { className: 'Tố Vấn' })]).renamed.length, 0);
  });
  it('spacing / case edits of a name are not changes; no previous import = everything added', () => {
    assert.deepEqual(gameRoster.diff([m('Hắc  Phong')], [m('hắc phong')]).added, []);
    assert.equal(gameRoster.diff(null, [m('A'), m('B')]).added.length, 2);
  });
});

describe('summarize', () => {
  it('counts ranks (first seen order) and classes (config order, then others)', () => {
    const s = gameRoster.summarize([m('A', { className: 'Tố Vấn' }), m('B', { className: 'Thiết Y' }), m('C', { className: 'Tố Vấn', rank: 'Học Việc' }), m('D', { className: 'Lạ' })], CLASSES);
    assert.equal(s.total, 4);
    assert.deepEqual(s.byRank, [['Bang Chúng', 3], ['Học Việc', 1]]);
    assert.deepEqual(s.byClass, [['Thiết Y', 1], ['Tố Vấn', 2], ['Lạ', 1]]);
  });
});

describe('matchDiscord', () => {
  const game = [m('Nhất Kiếm Thử'), m('Hắc Phong L…'), m('Cabät'), m('Kelo'), m('Chỉ Game')];
  const info = (id, name, bot = false) => ({ id, name, bot });

  it('exact match after NFKC / lower-case / punctuation + spaces stripped', () => {
    const r = gameRoster.matchDiscord(game, [info('1', 'NHẤT  kiếm_thử'), info('2', '𝓚𝓮𝓵𝓸')]);
    assert.deepEqual(r.matched.map((x) => [x.game.name, x.discordId]), [['Nhất Kiếm Thử', '1'], ['Kelo', '2']]);
  });
  it('then accent-folded, then prefix for a game name cut with "…"', () => {
    const r = gameRoster.matchDiscord(game, [info('1', 'Cabat'), info('2', 'Hắc Phong Lan Anh')]);
    assert.deepEqual(r.matched.map((x) => [x.game.name, x.discordId]), [['Cabät', '1'], ['Hắc Phong L…', '2']]);
    const two = gameRoster.matchDiscord(game, [info('2', 'Hắc Phong Lan Anh'), info('3', 'hac phong l')]);
    assert.deepEqual(two.matched, [], 'a cut name that two people start with is ambiguous: nobody gets it');
    assert.deepEqual(two.discordOnly.map((x) => x.id), ['2', '3']);
  });
  it('a cut game name needs the prefix, it is not matched exactly; an empty stem matches nobody', () => {
    assert.equal(gameRoster.matchDiscord([m('A…')], [info('1', 'B')]).matched.length, 0);
    assert.equal(gameRoster.matchDiscord([m('…')], [info('1', 'Bất kỳ')]).matched.length, 0);
  });
  it('gameOnly = unmatched game members, discordOnly = unmatched humans (bots excluded)', () => {
    const r = gameRoster.matchDiscord(game, [info('1', 'Kelo'), info('2', 'Người lạ'), info('3', 'Bot', true)]);
    assert.deepEqual(r.gameOnly.map((x) => x.name), ['Nhất Kiếm Thử', 'Hắc Phong L…', 'Cabät', 'Chỉ Game']);
    assert.deepEqual(r.discordOnly.map((x) => x.id), ['2']);
  });
  it('two Discord members with the same name: ambiguous, nobody is matched automatically', () => {
    const r = gameRoster.matchDiscord([m('Kelo')], [info('1', 'Kelo'), info('2', 'kelo')]);
    assert.deepEqual(r.matched, []);
    assert.deepEqual(r.discordOnly.map((x) => x.id), ['1', '2']);
    assert.deepEqual(r.gameOnly.map((x) => x.name), ['Kelo']);
  });
  it('tiers are full passes: an exact name beats an accent-folded look-alike regardless of order', () => {
    const r = gameRoster.matchDiscord([m('An')], [info('1', 'Ân'), info('2', 'An')]);
    assert.deepEqual(r.matched.map((x) => [x.game.name, x.discordId, x.how]), [['An', '2', 'norm']]);
    assert.deepEqual(r.discordOnly.map((x) => x.id), ['1']);
    const folded = gameRoster.matchDiscord([m('An'), m('Ân')], [info('1', 'Ân'), info('2', 'an')]);
    assert.deepEqual(folded.matched.map((x) => [x.game.name, x.discordId]).sort(), [['An', '2'], ['Ân', '1']]);
  });
});

describe('renderRosterPngs', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => m(`Người ${i + 1}`, { className: CLASSES[i % CLASSES.length], inDiscord: i % 2 === 0 }));
  const size = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

  it('returns one PNG per 35 rows, 1500px wide', async () => {
    for (const [n, pages] of [[0, 1], [1, 1], [35, 1], [36, 2], [64, 2], [71, 3]]) {
      const out = await renderRosterPngs({ title: 'Thành viên', members: many(n), classes: CLASSES });
      assert.equal(out.length, pages, `${n} rows`);
      out.forEach((b) => {
        assert.deepEqual(b.subarray(0, 8), PNG);
        assert.equal(size(b).w, 1500);
      });
    }
  });
  it('the last page is shorter and a bigger pageSize means fewer pages', async () => {
    const [a, b] = await renderRosterPngs({ title: 't', members: many(40), classes: CLASSES });
    assert.ok(size(b).h < size(a).h);
    assert.equal((await renderRosterPngs({ title: 't', members: many(40), classes: CLASSES }, { pageSize: 50 })).length, 1);
  });
  it('survives long / emoji / fancy names and unknown classes', async () => {
    const odd = ['x'.repeat(60), '😀🔥', '', '𝓝𝓪𝓶𝓮 Ｆａｎｃｙ', 'Đặng Thuỳ Ngọc Hân Ưu Tiên Quyền Lực'].map((name) => m(name, { className: 'Phái Lạ', status: 'Trong 1 giờ'.repeat(5) }));
    const [png] = await renderRosterPngs({ title: 'T'.repeat(100), subtitle: 's'.repeat(300), members: odd, classes: CLASSES });
    assert.deepEqual(png.subarray(0, 8), PNG);
  });
});

describe('buildGameRosterXlsx', () => {
  it('writes the importable sheet and columns plus the Discord column', async () => {
    const buf = await buildGameRosterXlsx([m('=SUM(1)', { inDiscord: true }), m('B', { className: 'Cửu Linh' })], { classes: CLASSES });
    const members = await gameRoster.parseRosterXlsx(buf, CLASSES);
    assert.deepEqual(members.map((x) => [x.name, x.className, x.daysInGuild]), [['=SUM(1)', 'Thiết Y', 10], ['B', 'Cửu Linh', 10]]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.getWorksheet('Thành viên');
    assert.equal(ws.getRow(1).getCell(7).value, 'Discord');
    assert.equal(ws.getRow(2).getCell(7).value, 'Có');
    assert.equal(ws.getRow(2).getCell(2).value, '=SUM(1)', 'a plain string, not a formula');
  });
});

describe('panel and upload modal', () => {
  it('the panel has the adm:game button in row 2', () => {
    const v2 = require('./discordLimits').assertV2Message(buildPanel());
    assert.ok(v2.buttons.some((c) => c.custom_id === 'adm:game' && /Thành viên game/.test(c.label)));
  });
  it('the upload modal has one required FileUpload (1 file) inside a label', () => {
    const modal = buildGameUploadModal().toJSON();
    assert.ok(modal.title.length <= 45);
    assert.ok(modal.components[0].label.length <= 45 && modal.components[0].description.length <= 100);
    assert.equal(modal.custom_id, 'adm:gameupModal');
    const comp = modal.components[0].component;
    assert.equal(comp.type, 19);
    assert.equal(comp.custom_id, 'file');
    assert.equal(comp.min_values, 1);
    assert.equal(comp.max_values, 1);
    assert.notEqual(comp.required, false);
  });
});

describe('adm:game handlers', () => {
  const GUILD = '800000000000000001';
  const MANAGE = new PermissionsBitField(PermissionFlagsBits.ManageGuild);
  const NOBODY = new PermissionsBitField(PermissionFlagsBits.SendMessages);
  const person = (n, name, bot = false) => ({ id: sid(n), displayName: name, user: { username: `u${n}`, bot }, roles: { cache: new Collection() }, guild: { id: GUILD }, joinedAt: null });
  let saved;
  let latest;
  let mappings;
  let prev;
  let pngCalls;
  let noticed;
  let offNoticed;

  const guild = { id: GUILD, name: 'Bang Thử', memberCount: 4, roles: { cache: new Collection() }, emojis: { cache: new Collection() }, members: { cache: new Collection(), fetch: async () => {} } };

  beforeEach(() => {
    clearMemberCache();
    clearClassStyles();
    gameRosterHandler.setImageLoader();
    config = { ...guildConfigService.defaultConfig(GUILD), classes: CLASSES };
    saved = [];
    mappings = new Map();
    panelRefreshed.length = 0;
    pngCalls = 0;
    latest = { _id: 'r2', importedAt: vn(2026, 10, 8, 12), importedBy: 'script', source: 'thanh-vien.xlsx', members: [m('Kelo', { className: 'Tố Vấn' }), m('Mới Vào', { className: 'Cửu Linh' }), m('Chỉ Game')] };
    prev = { _id: 'r1', importedAt: vn(2026, 10, 7, 12), members: [m('Kelo', { className: 'Tố Vấn', rank: 'Học Việc' }), m('Đã Rời'), m('Chỉ Game')] };
    guild.members.cache = new Collection([person(1, 'Kelo'), person(2, 'Người lạ'), person(3, 'Bot', true)].map((x) => [x.id, x]));
    mock.method(gameRoster, 'latest', async () => latest);
    mock.method(gameRoster, 'previous', async () => prev);
    mock.method(gameRoster, 'loadMappings', async () => mappings);
    noticed = [];
    offNoticed = [];
    mock.method(departNotice, 'noticeGuild', async (...a) => noticed.push(a));
    mock.method(offNotice, 'noticeGuild', async (...a) => offNoticed.push(a));
    mock.method(gameRoster, 'saveImport', async (doc) => {
      saved.push(doc);
      return { _id: 'r3', ...doc };
    });
    mock.method(console, 'error', () => {});
    mock.method(console, 'warn', () => {});
  });

  function interaction(extra = {}) {
    const log = [];
    const i = {
      guildId: GUILD,
      guild,
      user: { id: sid(900) },
      member: { roles: [], permissions: MANAGE },
      memberPermissions: MANAGE,
      deferReply: async () => log.push(['deferReply']),
      deferUpdate: async () => log.push(['deferUpdate']),
      editReply: async (o) => log.push(['editReply', o]),
      reply: async (o) => log.push(['reply', o]),
      showModal: async (md) => log.push(['showModal', md]),
      ...extra,
    };
    return { i, log };
  }
  const reply = (log) => log.filter((l) => l[0] === 'editReply').pop()[1];
  const text = (e) => JSON.stringify(e.toJSON());

  it('adm:game: embed with totals, classes, diff and Discord match + PNG pages + the two buttons', async () => {
    const { i, log } = interaction();
    await adminHandler.handle(i, ['adm', 'game']);
    assert.deepEqual(log[0], ['deferReply']);
    const r = reply(log);
    const embed = assertEmbed(r.embeds[0]);
    const all = text(r.embeds[0]);
    assert.match(all, /\*\*3\*\* thành viên/);
    assert.match(all, /Cửu Linh/);
    assert.match(all, /➕ Mới vào \(1\): Mới Vào/);
    assert.match(all, /➖ Rời \(1\): Đã Rời/);
    assert.match(all, /🎖️ Đổi chức vụ \(1\): Kelo \(Học Việc → Bang Chúng\)/);
    assert.match(all, /Khớp tên Discord: \*\*1\/3\*\*/);
    assert.match(all, /Chỉ Game/);
    assert.match(all, /\(trong đó 0 ghép tay · 0 tự liên kết · 0 tên tự nhập\)/);
    assert.match(all, /Tên Discord khác tên game \(2\)/);
    assert.match(all, /Trên Discord nhưng không khớp ai trong game: \*\*1\*\*/);
    assert.match(all, /Ban quản lý 0 · Bang Chúng 3 · Học việc 0/);
    assert.ok(embed.fields.length >= 3);
    assert.equal(r.files.length, 1);
    assert.equal(r.files[0].name, 'thanh-vien-game-1.png');
    assert.deepEqual(r.files[0].attachment.subarray(0, 8), PNG);
    assert.deepEqual(r.components[0].toJSON().components.map((c) => c.custom_id), ['adm:gamexlsx', 'adm:gmap', 'adm:gren', 'adm:gameadd', 'adm:gameup']);
  });
  it('adm:game: linked people whose game name left the roster but who are still on Discord get a 🚪 line (no extra Discord call)', async () => {
    mappings = new Map([[sid(1), 'Kelo'], [sid(2), 'Đã Rời'], [sid(77), 'Người Đi'], [sid(3), 'Bot Cũ']]); // 77 is not in the server, 3 is a bot
    mappings.sources = new Map([[sid(2), 'self']]);
    const { i, log } = interaction();
    await adminHandler.handle(i, ['adm', 'game']);
    const all = text(reply(log).embeds[0]);
    assert.match(all, /🚪 Đã rời game nhưng còn trong Discord: \*\*1\*\* — Đã Rời ⇄ <@100000000000000002>/);
    const line = all.split('\\n').find((l) => l.includes('🚪')); // (JSON text: a newline is the two characters \n) the other names show up in the 'old pairs' line as usual
    assert.doesNotMatch(line, /Người Đi|Bot Cũ/);
  });
  it('adm:game: no 🚪 line when nobody departed', async () => {
    const { i, log } = interaction();
    await adminHandler.handle(i, ['adm', 'game']);
    assert.doesNotMatch(text(reply(log).embeds[0]), /🚪/);
  });
  it('adm:game: a 64-member list with long names stays within embed limits and 10 files', async () => {
    latest.members = Array.from({ length: 64 }, (_, k) => m(`Tên rất dài số ${k} `.repeat(3).slice(0, 40), { className: CLASSES[k % 7], rank: `Chức ${k % 16}` }));
    prev.members = Array.from({ length: 64 }, (_, k) => m(`Tên cũ rất dài số ${k}`.repeat(2).slice(0, 40), { className: CLASSES[k % 7] }));
    const { i, log } = interaction();
    await adminHandler.handle(i, ['adm', 'game']);
    const r = reply(log);
    assertEmbed(r.embeds[0]);
    assert.equal(r.files.length, 2);
  });
  it('adm:game without an import: hint + upload button', async () => {
    latest = null;
    const { i, log } = interaction();
    await adminHandler.handle(i, ['adm', 'game']);
    const r = reply(log);
    assert.match(r.content, /Cập nhật danh sách/);
    assert.equal(r.embeds, undefined);
  });
  it('adm:game: when the image cannot be drawn the reply falls back to a text table', async () => {
    gameRosterHandler.setImageLoader(() => {
      throw new Error('no canvas binary');
    });
    const { i, log } = interaction();
    await adminHandler.handle(i, ['adm', 'game']);
    const r = reply(log);
    assert.deepEqual(r.files, []);
    assert.match(r.content, /Kelo — Bang Chúng — Tố Vấn/);
    assert.ok(r.content.length <= 2000);
    assert.equal(r.embeds.length, 1);
  });
  it('adm:game: a render error also falls back to text', async () => {
    gameRosterHandler.setImageLoader(() => ({
      PAGE_SIZE: 35,
      renderRosterPngs: async () => {
        pngCalls++;
        throw new Error('boom');
      },
    }));
    const { i, log } = interaction();
    await adminHandler.handle(i, ['adm', 'game']);
    assert.equal(pngCalls, 1);
    assert.match(reply(log).content, /Kelo/);
  });
  it('adm:gamexlsx: attaches a styled .xlsx with the Discord column', async () => {
    const { i, log } = interaction();
    await adminHandler.handle(i, ['adm', 'gamexlsx']);
    const r = reply(log);
    assert.equal(r.files[0].name, 'thanh-vien-game-08-10.xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.files[0].attachment);
    const ws = wb.getWorksheet('Thành viên');
    assert.equal(ws.rowCount, 4);
    assert.equal(ws.getRow(2).getCell(7).value, 'Có');
    assert.ok(!ws.getRow(3).getCell(7).value);
  });
  it('adm:gameup opens the modal without deferring; denied for non-admins', async () => {
    const ok = interaction();
    await adminHandler.handle(ok.i, ['adm', 'gameup']);
    assert.deepEqual(ok.log.map((l) => l[0]), ['showModal']);
    const denied = interaction({ member: { roles: [], permissions: NOBODY }, memberPermissions: NOBODY });
    await adminHandler.handle(denied.i, ['adm', 'gameup']);
    assert.equal(denied.log[0][0], 'reply');
    assert.match(denied.log[0][1].content, /không có quyền/);
  });
  it('adm:game / adm:gamexlsx are admin-only', async () => {
    for (const action of ['game', 'gamexlsx', 'gameupModal']) {
      const { i, log } = interaction({ member: { roles: [], permissions: NOBODY }, memberPermissions: NOBODY });
      await adminHandler.handle(i, ['adm', action]);
      assert.match(reply(log), /không có quyền/);
    }
    assert.equal(saved.length, 0);
  });

  describe('➕ adm:gameadd / adm:gameaddModal', () => {
    it('opens a form with the name, the guild classes and the rank (Học Việc preselected); admin-only', async () => {
      const { i, log } = interaction();
      await adminHandler.handle(i, ['adm', 'gameadd']);
      const modal = log.find((l) => l[0] === 'showModal')[1].toJSON();
      assert.equal(modal.custom_id, 'adm:gameaddModal');
      const [name, cls, rank] = modal.components.map((c) => c.component);
      assert.equal(name.custom_id, 'name');
      assert.equal(cls.options.length, CLASSES.length);
      assert.deepEqual(rank.options.filter((o) => o.default).map((o) => o.value), ['Học Việc']);
      const denied = interaction({ member: { roles: [], permissions: NOBODY }, memberPermissions: NOBODY });
      await adminHandler.handle(denied.i, ['adm', 'gameadd']);
      assert.equal(denied.log[0][0], 'reply');
    });
    it('adds the character (class from the form index), refreshes the dashboard, re-draws the summary; no notice and no new import', async () => {
      const added = [];
      mock.method(gameRoster, 'addManualMember', async (g, data) => (added.push([g, data]), { member: { name: data.name, className: data.className, rank: data.rank } }));
      const fields = { getTextInputValue: () => 'Người Mới', getStringSelectValues: (id) => (id === 'cls' ? ['1'] : ['Bang Chúng']) };
      const { i, log } = interaction({ fields });
      await adminHandler.handle(i, ['adm', 'gameaddModal']);
      assert.deepEqual(added, [[GUILD, { name: 'Người Mới', className: CLASSES[1], rank: 'Bang Chúng' }]]);
      assert.match(reply(log).content, /Đã thêm \*\*Người Mới\*\*/);
      assert.deepEqual(panelRefreshed.map((a) => a[1]), [GUILD]);
      assert.equal(saved.length, 0);
      assert.equal(noticed.length + offNoticed.length, 0);
    });
    it('a refused name is reported and nothing is refreshed', async () => {
      mock.method(gameRoster, 'addManualMember', async () => ({ error: 'Tên **Kelo** đã có trong danh sách game.' }));
      const fields = { getTextInputValue: () => 'kelo', getStringSelectValues: (id) => (id === 'cls' ? ['0'] : ['Học Việc']) };
      const { i, log } = interaction({ fields });
      await adminHandler.handle(i, ['adm', 'gameaddModal']);
      assert.match(String(reply(log).content || reply(log)), /❌ Tên \*\*Kelo\*\* đã có/);
      assert.equal(panelRefreshed.length, 0);
    });
  });

  describe('adm:gameupModal', () => {
    const URL_OK = 'https://cdn.discordapp.com/attachments/1/2/thanh-vien.xlsx';
    const attachment = (extra = {}, size) => ({ name: 'thanh-vien.xlsx', url: URL_OK, size, ...extra });
    const submit = (att) => interaction({ fields: { getUploadedFiles: () => new Collection([['1', att]]) } });
    let fetched;
    let fetchInit;
    const serve = (buf, status = 200) => {
      fetched = [];
      mock.method(globalThis, 'fetch', async (url, init) => {
        fetched.push(String(url));
        fetchInit = init;
        return new Response(status === 200 ? buf : null, { status });
      });
    };

    it('downloads, parses, saves with the uploader and source, and replies with the new summary', async () => {
      const buf = await workbook([[1, 'Kelo', 'Bang Chúng', 'tố vấn', 100, 3, 'Online'], [2, 'B', 'Học Việc', 'Cửu Linh', 90, 1, 'Online']]);
      serve(buf);
      const { i, log } = submit(attachment({}, buf.length));
      await adminHandler.handle(i, ['adm', 'gameupModal']);
      assert.deepEqual(fetched, [URL_OK]);
      assert.equal(saved.length, 1);
      assert.equal(saved[0].guildId, GUILD);
      assert.equal(saved[0].importedBy, sid(900));
      assert.equal(saved[0].source, 'thanh-vien.xlsx');
      assert.equal(saved[0].members[0].className, 'Tố Vấn');
      assert.deepEqual(panelRefreshed.map((a) => a[1]), [GUILD], 'the dashboard (roster size + date) is scheduled to refresh after the import');
      assert.equal(noticed.length, 1, 'the "left the game" notice is tried right after the import');
      assert.equal(noticed[0][1], GUILD);
      assert.equal(offNoticed.length, 1, 'the "off too long" notice is tried right after the import too');
      assert.equal(offNoticed[0][1], GUILD);
      const r = reply(log);
      assert.match(r.content, /Đã cập nhật danh sách: \*\*2\*\*/);
      assert.ok(r.embeds.length === 1);
    });
    it('rejects a non-.xlsx name, an oversized file and a foreign host before fetching', async () => {
      serve(Buffer.alloc(1));
      for (const [att, re] of [
        [attachment({ name: 'a.csv' }, 10), /\.xlsx/],
        [attachment({}, gameRosterHandler.MAX_FILE_BYTES + 1), /2 MB/],
        [attachment({ url: 'https://evil.example/a.xlsx' }, 10), /từ Discord/],
        [attachment({ url: 'http://cdn.discordapp.com/a.xlsx' }, 10), /từ Discord/],
        [attachment({ url: 'https://cdn.discordapp.com.evil.example/a.xlsx' }, 10), /từ Discord/],
      ]) {
        const { i, log } = submit(att);
        await adminHandler.handle(i, ['adm', 'gameupModal']);
        assert.match(reply(log), re);
      }
      assert.deepEqual(fetched, []);
      assert.equal(saved.length, 0);
    });
    it('L6: redirects are refused, a big Content-Length or a body past 2 MB (small declared size) is cut off', async () => {
      const buf = await workbook([[1, 'Kelo', 'Bang Chúng', 'tố vấn', 100, 3, 'Online']]);
      serve(buf);
      let { i } = submit(attachment({}, buf.length));
      await adminHandler.handle(i, ['adm', 'gameupModal']);
      assert.equal(fetchInit.redirect, 'error');

      let pulled = 0;
      mock.method(globalThis, 'fetch', async () => {
        const stream = new ReadableStream({
          pull(controller) {
            pulled += 1;
            controller.enqueue(new Uint8Array(512 * 1024));
            if (pulled > 50) controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      });
      let log;
      ({ i, log } = submit(attachment({}, 10))); // declared small, really endless
      await adminHandler.handle(i, ['adm', 'gameupModal']);
      assert.match(reply(log), /2 MB/);
      assert.ok(pulled < 10, `stopped reading early (${pulled} chunks)`);

      mock.method(globalThis, 'fetch', async () => new Response(Buffer.alloc(8), { status: 200, headers: { 'content-length': String(gameRosterHandler.MAX_FILE_BYTES + 1) } }));
      ({ i, log } = submit(attachment({}, 10)));
      await adminHandler.handle(i, ['adm', 'gameupModal']);
      assert.match(reply(log), /2 MB/);
      mock.method(globalThis, 'fetch', async () => {
        throw new TypeError('redirect');
      });
      ({ i, log } = submit(attachment({}, 10)));
      await adminHandler.handle(i, ['adm', 'gameupModal']);
      assert.match(reply(log), /Không tải được/);
      assert.equal(saved.length, 1, 'only the first, valid upload was saved');
    });
    it('L6: only cdn.discordapp.com / media.discordapp.net are accepted', async () => {
      serve(Buffer.alloc(1));
      for (const host of ['discord.com', 'cdn.discordapp.com.evil.example', 'images-ext-1.discordapp.net']) {
        const { i, log } = submit(attachment({ url: `https://${host}/a.xlsx` }, 10));
        await adminHandler.handle(i, ['adm', 'gameupModal']);
        assert.match(reply(log), /từ Discord/);
      }
      assert.deepEqual(fetched, []);
    });
    it('a download failure or a file that is not a roster is reported and nothing is saved', async () => {
      serve(Buffer.alloc(1), 404);
      let { i, log } = submit(attachment({}, 10));
      await adminHandler.handle(i, ['adm', 'gameupModal']);
      assert.match(reply(log), /HTTP 404/);

      const bad = await workbook([[1, 'A']], { header: ['STT', 'Tên nhân vật'] });
      serve(bad);
      ({ i, log } = submit(attachment({}, bad.length)));
      await adminHandler.handle(i, ['adm', 'gameupModal']);
      assert.match(reply(log), /Thiếu cột/);
      assert.equal(saved.length, 0);
    });
  });
});
