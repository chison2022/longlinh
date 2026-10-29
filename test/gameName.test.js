// Member self-link of the in-game name: the persistent panel, the ephemeral picker (gn:*), the nudge after ✅ Tham gia, the admin
// views (counts / labels) and the match precedence. DB access is stubbed; the uniqueness rules on a real MongoDB are in
// test/gameRosterDb.test.js (in-memory PostgreSQL).
const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const gameRoster = require('../src/services/gameRosterService');
const registrationService = require('../src/services/registrationService');
const guildConfigService = require('../src/services/guildConfigService');
const warService = require('../src/services/warService');
const { assertMessage, assertV2Message } = require('./discordLimits');
const { vn, oid, sid } = require('./helpers');

const GUILD = '800000000000000001';
const ME = sid(1);
const g = (name, extra = {}) => ({ name, rank: 'Bang Chúng', className: 'Thiết Y', daysInGuild: 1, status: '', ...extra });

let roster;
let mappings; // Map with .sources
let link;
let calls;
const makeMappings = (entries = []) => {
  const map = new Map(entries.map(([id, name]) => [id, name]));
  map.sources = new Map(entries.map(([id, , source]) => [id, source || 'admin']));
  return map;
};
gameRoster.latest = async () => roster;
gameRoster.loadMappings = async () => mappings;
gameRoster.getLink = async () => link;
gameRoster.selfLink = async (...a) => {
  calls.push(['selfLink', ...a.slice(1, 4)]);
  if (selfLinkError) throw selfLinkError;
  link = { gameName: a[2], source: a[3] && a[3].free ? 'selfFree' : 'self' };
  return link;
};
gameRoster.selfUnlink = async () => {
  calls.push(['selfUnlink']);
  if (unlinkError) throw unlinkError;
  const had = Boolean(link);
  link = null;
  return had;
};
const adminSent = [];
let selfLinkError = null;
let unlinkError = null;
const configWrites = [];
// destructured by the handlers at require time: installed BEFORE they are required
guildConfigService.getConfigOrDefault = async () => ({ ...guildConfigService.defaultConfig(GUILD), classes: ['Tố Vấn'], adminChannelId: 'adm-chan' });
let autoNames = new Map(); // what loadGameNames reports (members matched automatically)
require('../src/bot/gameNames').loadGameNames = async () => autoNames;
guildConfigService.updateConfig = async (id, patch) => configWrites.push(patch);

const gnHandler = require('../src/bot/interactions/gameName');
const warHandler = require('../src/bot/interactions/war');
const { buildPicker, buildGnPanel, LABELS } = require('../src/bot/ui/gameName');
const { buildMapView } = require('../src/bot/ui/gameMap');

const members = (list) => new Map(list.map(([id, name, username]) => [id, { id, displayName: name, user: { username: username || name, globalName: null, bot: false } }]));
// a guild whose member list can be fetched (ensureMembers marks it complete); memberCount follows the cache
function guildOf(cache) {
  return { id: GUILD, memberCount: cache.size, members: { cache, fetch: async () => cache } };
}
function interaction({ name = 'Beta Boss', username = 'betaboss', guildMembers = [], extra = {} } = {}) {
  const log = [];
  const i = {
    guildId: GUILD,
    user: { id: ME, username, globalName: null },
    member: { displayName: name },
    guild: guildOf(members([[ME, name, username], ...guildMembers])),
    client: { guilds: { cache: new Map() }, channels: { fetch: async () => ({ send: async (p) => adminSent.push(p) }) } },
    deferReply: async () => log.push(['deferReply']),
    deferUpdate: async () => log.push(['deferUpdate']),
    editReply: async (o) => log.push(['editReply', o]),
    showModal: async (m) => log.push(['showModal', m]),
    ...extra,
  };
  return { i, log };
}
const last = (log) => log.filter((l) => l[0] === 'editReply').pop()[1];
const optionsOf = (view) => view.components[0].toJSON().components[0].options;
const buttonIds = (view) => view.components.at(-1).toJSON().components.map((c) => c.custom_id);

beforeEach(() => {
  roster = { _id: '0000000000000000deadbeef', members: [g('Alpha'), g('Beta Boss'), g('Gamma'), g('Delta')] };
  mappings = makeMappings();
  link = null;
  calls = [];
  selfLinkError = null;
  unlinkError = null;
  gnHandler.resetState();
  warHandler.resetNudges();
  autoNames = new Map();
  adminSent.length = 0;
  require('../src/bot/memberCache').clearMemberCache();
  mock.method(console, 'error', () => {});
  mock.method(console, 'warn', () => {});
});

describe('the persistent panel', () => {
  it('has the three buttons with the owner wording, a short explanation, and passes the V2 limits', () => {
    const v2 = assertV2Message(buildGnPanel());
    assert.deepEqual(v2.buttons.map((b) => [b.custom_id, b.label]), [['gn:open', '🎮 Chọn nhân vật của tôi'], ['gn:me', '👤 Xem nhân vật đã liên kết'], ['gn:uid', '🆔 Nhập ID game']]);
    assert.match(v2.text, /Chọn nhân vật trong game của bạn để quản lý xếp đội đúng người\. Đổi lại lúc nào cũng được\./);
    assert.equal(LABELS.open, '🎮 Chọn nhân vật của tôi');
  });
  it('the setup sub-view: channel select + post button (disabled until a channel is chosen) + back; ≤ 5 rows', () => {
    const { buildSetupView } = require('../src/bot/ui/panel');
    const cfg = { ...guildConfigService.defaultConfig(GUILD), adminRoleIds: [] };
    const v = buildSetupView(cfg, null, { view: 'gn' });
    const { rows } = assertMessage(v);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].components[0].custom_id, 'setup:gnchan');
    assert.deepEqual(rows[1].components.map((c) => [c.custom_id, !!c.disabled]), [['setup:gnpost', true], ['setup:main', false]]);
    const set = buildSetupView({ ...cfg, gnChannelId: '123456789012345678' }, null, { view: 'gn' });
    assert.ok(!assertMessage(set).rows[1].components[0].disabled);
    assert.ok(buildSetupView(cfg, null, { view: 'adv' }).components[0].toJSON().components.some((c) => c.custom_id === 'setup:gnview'), '🎮 is always in ⚙️ Nâng cao');
  });
  it('postOrUpdateGnPanel: posts once and stores the ids, edits in place, re-posts when deleted, moves (and removes the old one) on a channel change', async () => {
    const { postOrUpdateGnPanel } = require('../src/bot/gnPanel');
    const stored = configWrites;
    const sent = [];
    const channel = (id, { editFails } = {}) => ({
      id,
      send: async (p) => (sent.push([id, p]), { id: `m-${sent.length}` }),
      messages: {
        edit: async (mid) => {
          if (editFails) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
          sent.push([id, 'edit', mid]);
        },
        delete: async (mid) => sent.push([id, 'delete', mid]),
      },
    });
    const chans = { a: channel('a'), b: channel('b'), gone: channel('a', { editFails: true }) };
    const client = (map) => ({ channels: { fetch: async (id) => map[id] } });
    let res = await postOrUpdateGnPanel(client(chans), { guildId: GUILD, gnChannelId: 'a' });
    assert.equal(res.action, 'posted');
    assert.deepEqual(stored.pop(), { gnPanelChannelId: 'a', gnPanelMessageId: 'm-1' });
    assert.equal(sent[0][1].flags !== undefined, true);
    res = await postOrUpdateGnPanel(client(chans), { guildId: GUILD, gnChannelId: 'a', gnPanelChannelId: 'a', gnPanelMessageId: 'm-1' });
    assert.equal(res.action, 'edited');
    res = await postOrUpdateGnPanel(client({ a: chans.gone }), { guildId: GUILD, gnChannelId: 'a', gnPanelChannelId: 'a', gnPanelMessageId: 'old' });
    assert.equal(res.action, 'posted');
    sent.length = 0;
    res = await postOrUpdateGnPanel(client(chans), { guildId: GUILD, gnChannelId: 'b', gnPanelChannelId: 'a', gnPanelMessageId: 'm-1' });
    assert.equal(res.action, 'posted');
    assert.deepEqual(sent.map((s) => s[1] === 'delete' ? ['delete', s[0], s[2]] : ['send', s[0]]), [['send', 'b'], ['delete', 'a', 'm-1']]);
  });
});

describe('the ephemeral picker', () => {
  it('opens ephemeral: status line + the select sorted by similarity to the server name; own link and names of others excluded', async () => {
    mappings = makeMappings([[sid(7), 'GAMMA', 'self'], [sid(8), 'Delta', 'admin']]);
    const { i, log } = interaction({ guildMembers: [[sid(9), 'Alpha']] }); // Alpha is matched automatically to another member
    await gnHandler.handle(i, ['gn', 'open']);
    assert.equal(log[0][0], 'deferReply');
    const view = last(log);
    assert.match(view.content, /chưa liên kết/);
    assert.deepEqual(optionsOf(view).map((o) => o.label), ['Beta Boss'], 'Alpha: auto-matched to another; Gamma (any case) / Delta: linked');
    assert.equal(optionsOf(view)[0].value, '1', 'value = position in the roster');
    assertMessage(view);
  });
  it('orders the names by similarity to the nickname / username (best first, ties by name)', async () => {
    roster.members = ['Zed', 'Kelo Alpha', 'Alpha', 'Kelo', 'Mira'].map((n) => g(n));
    const { i, log } = interaction({ name: 'Kelo', username: 'kelo99' });
    await gnHandler.handle(i, ['gn', 'open']);
    const labels = optionsOf(last(log)).map((o) => o.label);
    assert.deepEqual(labels.slice(0, 2), ['Kelo', 'Kelo Alpha']);
    assert.equal(labels.length, 5);
    assert.match(optionsOf(last(log))[0].description, /giống 100%/);
  });
  it('opening while linked shows only the compact view: result + source line + "Đổi nhân vật" / "Gỡ liên kết", no select', async () => {
    link = { gameName: 'Gamma', source: 'self' };
    const { i, log } = interaction();
    await gnHandler.handle(i, ['gn', 'open']);
    const v = last(log);
    assert.equal(v.content, '✅ Bạn đang là **Gamma** trong game.\n-# bạn tự chọn');
    assert.deepEqual(v.components.length, 1);
    assert.deepEqual(v.components[0].toJSON().components.map((c) => [c.custom_id, c.label]), [['gn:change', LABELS.change], ['gn:unlink', 'Gỡ liên kết']]);
    assert.equal(LABELS.change, '🔄 Đổi nhân vật');
    assert.doesNotMatch(v.content, /Chọn nhân vật|Đã liên kết/);
    assertMessage(v);
    link = { gameName: 'Tự Gõ', source: 'selfFree' };
    const again = interaction();
    await gnHandler.handle(again.i, ['gn', 'open']);
    assert.match(last(again.log).content, /bạn tự nhập/);
  });
  it('an admin-owned link: compact view without "Gỡ liên kết" (and nothing to change), with the ask-the-manager line', async () => {
    link = { gameName: 'Alpha', source: 'admin' };
    const { i, log } = interaction();
    await gnHandler.handle(i, ['gn', 'open']);
    const v = last(log);
    assert.equal(v.content, '✅ Bạn đang là **Alpha** trong game.\n-# quản lý gán\n-# Nhờ quản lý nếu cần đổi');
    assert.deepEqual(v.components, []);
  });
  it('"Đổi nhân vật" opens the full picker (select + ✏️ + Gỡ liên kết) for the linked member', async () => {
    link = { gameName: 'Gamma', source: 'self' };
    const { i, log } = interaction();
    await gnHandler.handle(i, ['gn', 'change']);
    assert.equal(log[0][0], 'deferUpdate');
    const v = last(log);
    assert.ok(optionsOf(v).length > 0);
    assert.deepEqual(buttonIds(v), ['gn:free', 'gn:unlink']);
    assert.ok(v.components.length <= 5);
    assertMessage(v);
  });
  it('25 per page with ◀ ▶: customIds carry page + roster version and stay ≤ 100; the second page is reachable and in range', async () => {
    roster.members = Array.from({ length: 60 }, (_, k) => g(`Nhân vật ${String(k).padStart(2, '0')}`));
    const { i, log } = interaction({ name: 'Nobody' });
    await gnHandler.handle(i, ['gn', 'open']);
    const view = last(log);
    assert.equal(optionsOf(view).length, 25);
    const ids = view.components.flatMap((r) => r.toJSON().components.map((c) => c.custom_id));
    assert.ok(ids.every((id) => id.length <= 100));
    assert.ok(ids.includes('gn:pick:0:deadbeef') && ids.includes('gn:p:1:deadbeef') && ids.includes('gn:p:0:deadbeef'));
    assert.equal(view.components.length <= 5, true);
    const next = interaction({ name: 'Nobody' });
    await gnHandler.handle(next.i, ['gn', 'p', '2', 'deadbeef']);
    assert.equal(next.log[0][0], 'deferUpdate');
    assert.equal(optionsOf(last(next.log)).length, 10);
    assert.match(last(next.log).content, /trang 3\/3/);
    const stale = interaction();
    await gnHandler.handle(stale.i, ['gn', 'p', '1', 'oldver000']);
    assert.match(last(stale.log).content, /vừa được cập nhật/);
  });
  it('without an imported roster only the free-text button is offered', async () => {
    roster = null;
    const { i, log } = interaction();
    await gnHandler.handle(i, ['gn', 'open']);
    assert.match(last(log).content, /chưa nhập danh sách/);
    assert.equal(last(log).components.length, 1);
    assert.deepEqual(buttonIds(last(log)), ['gn:free', 'gn:unlink']);
  });
  it('gn:me tells the current link (ephemeral)', async () => {
    link = { gameName: 'Alpha', source: 'admin' };
    const { i, log } = interaction();
    await gnHandler.handle(i, ['gn', 'me']);
    assert.equal(log[0][0], 'deferReply');
    assert.equal(last(log).content, '✅ Bạn đang là **Alpha** trong game.\n-# quản lý gán\n🆔 Chưa có ID game — bấm 🆔 Nhập ID game');
    link = { gameName: 'Alpha', source: 'self', gameUid: '123456' };
    const again = interaction();
    await gnHandler.handle(again.i, ['gn', 'me']);
    assert.equal(last(again.log).content, '✅ Bạn đang là **Alpha** trong game.\n-# bạn tự chọn\n🆔 ID game: 123456');
    link = null;
    const none = interaction();
    await gnHandler.handle(none.i, ['gn', 'me']);
    assert.equal(last(none.log).content, 'Bạn **chưa liên kết** nhân vật nào trong game.');
  });
});

describe('gn:uid: the member enters the in-game ID of the linked character', () => {
  let held; // uid -> holder text (refused by checkGameUid), as the real check would
  let claimed; // [[name, uid]]
  let claimOutcome;
  let claimOpts;
  beforeEach(() => {
    held = new Map();
    claimed = [];
    claimOutcome = { status: 'set', characterId: 7, created: false };
    gameRoster.checkGameUid = async (_g, input, { exceptName = null } = {}) => {
      const c = gameRoster.cleanGameUid(input);
      if (c.error || !c.uid) return c;
      if (link && link.gameUid && link.gameUid !== c.uid && exceptName === link.gameName) return { error: 'Nhân vật này đã có một ID game khác. Nhập đúng ID của nhân vật, hoặc báo quản lý nếu ID cũ bị nhầm.' };
      return held.has(c.uid) ? { error: held.get(c.uid) } : c;
    };
    claimOpts = [];
    gameRoster.claimGameUid = async (_g, name, uid, opts) => (claimed.push([name, uid]), claimOpts.push(opts), claimOutcome);
  });
  const submit = async (uid) => {
    const x = interaction({ extra: { fields: { getTextInputValue: () => uid } } });
    await gnHandler.handle(x.i, ['gn', 'uidModal']);
    return x;
  };

  it('the panel button opens a modal with one required field (digits, 5 to 20)', async () => {
    const { i, log } = interaction();
    await gnHandler.handle(i, ['gn', 'uid']);
    const modal = log.find((l) => l[0] === 'showModal')[1].toJSON();
    assert.equal(modal.custom_id, 'gn:uidModal');
    assert.equal(modal.components.length, 1);
    assert.equal(modal.components[0].component.required, true);
    assert.equal(modal.components[0].component.max_length, 20);
    assert.match(modal.components[0].description, /Chỉ chữ số, 5 đến 20 số/);
  });
  it('not linked: told to pick a character first, nothing saved', async () => {
    const { log } = await submit('123456');
    assert.equal(log[0][0], 'deferReply');
    assert.match(last(log).content, /Bạn chưa liên kết nhân vật — bấm 🎮 Chọn nhân vật của tôi trước\./);
    assert.deepEqual(claimed, []);
  });
  it('a bad format or an empty ID is refused with the gate wording', async () => {
    link = { gameName: 'Alpha', source: 'self' };
    assert.match(last((await submit('12ab')).log).content, /^⚠️ ID game chỉ gồm chữ số/);
    assert.match(last((await submit('   ')).log).content, /Cần nhập ID/);
    assert.deepEqual(claimed, []);
  });
  it('an ID another character holds (or a pending request reserves), and a different ID on the linked character, are refused', async () => {
    link = { gameName: 'Alpha', source: 'self' };
    held.set('555555', 'ID game này đang thuộc nhân vật **Beta**.');
    assert.match(last((await submit('555555')).log).content, /đang thuộc nhân vật \*\*Beta\*\*/);
    held.set('666666', 'ID này đang được một người khác dùng để xin vào bang. Kiểm tra lại ID của bạn.');
    assert.match(last((await submit('666666')).log).content, /xin vào bang/);
    link = { gameName: 'Alpha', source: 'self', gameUid: '111111' };
    assert.match(last((await submit('222222')).log).content, /đã có một ID game khác/);
    assert.deepEqual(claimed, []);
  });
  it('the linked character row (id) and the member are passed to the check and the claim; success tells the managers (no pings)', async () => {
    link = { gameName: 'Alpha', source: 'self', characterId: 42 };
    const seen = [];
    const realCheck = gameRoster.checkGameUid;
    gameRoster.checkGameUid = async (g1, input, opts) => (seen.push(opts), realCheck(g1, input, opts));
    await submit('123456');
    assert.deepEqual(seen, [{ exceptName: 'Alpha', exceptId: 42 }]);
    assert.deepEqual(claimOpts, [{ characterId: 42, by: ME }]);
    assert.equal(adminSent.length, 1);
    assert.equal(adminSent[0].content, `🆔 <@${ME}> tự nhập ID game 123456 cho nhân vật Alpha.`);
    assert.deepEqual(adminSent[0].allowedMentions, { parse: [] });
  });
  it('a refused ID or an unchanged one posts nothing to the managers; a closed admin channel does not break the save', async () => {
    link = { gameName: 'Alpha', source: 'self' };
    await submit('12ab');
    claimOutcome = { status: 'same', characterId: 7, created: false };
    await submit('123456');
    assert.deepEqual(adminSent, []);
    claimOutcome = { status: 'set', characterId: 7, created: false };
    const x = interaction({ extra: { fields: { getTextInputValue: () => '123456' }, client: { channels: { fetch: async () => { throw new Error('Missing Access'); } } } } });
    await gnHandler.handle(x.i, ['gn', 'uidModal']);
    assert.match(last(x.log).content, /✅ Đã lưu ID game/);
  });
  it('at most 3 saves per member per hour: the 4th is refused with the time, the hour rolls on; refused/unchanged IDs do not count', async () => {
    let now = Date.parse('2026-10-29T10:00:00Z');
    gnHandler.resetState({ now: () => now });
    link = { gameName: 'Alpha', source: 'self' };
    await submit('12ab'); // refused: not counted
    for (const uid of ['111111', '222222', '333333']) {
      assert.match(last((await submit(uid)).log).content, /✅ Đã lưu/);
      now += 60 * 1000;
    }
    const blocked = await submit('444444');
    const until = Math.ceil((Date.parse('2026-10-29T10:00:00Z') + 3600 * 1000) / 1000);
    assert.equal(last(blocked.log).content, `⏳ Bạn đã nhập ID nhiều lần, thử lại sau <t:${until}:R>.`);
    assert.equal(claimed.length, 3);
    now = Date.parse('2026-10-29T11:00:01Z');
    assert.match(last((await submit('444444')).log).content, /✅ Đã lưu/);
  });
  it('a clash found by the transactional claim saves nothing and is reported', async () => {
    link = { gameName: 'Alpha', source: 'self' };
    claimOutcome = { status: 'clash', text: 'ID game này vừa được nhân vật khác nhận.' };
    assert.match(last((await submit('123456')).log).content, /^⚠️ ID game này vừa được nhân vật khác nhận\./);
  });
  it('success: the ID goes to the linked character through the claim, the member is told, and a gn.game_uid line is logged', async () => {
    link = { gameName: 'Alpha', source: 'self' };
    const lines = [];
    const eventLog = require('../src/eventLog');
    eventLog.setSink((l) => lines.push(JSON.parse(l)));
    try {
      const { log } = await submit(' 123456 ');
      assert.deepEqual(claimed, [['Alpha', '123456']]);
      assert.equal(last(log).content, '✅ Đã lưu ID game **123456** cho nhân vật **Alpha**.');
      assert.deepEqual(lines.filter((l) => l.area === 'gn' && l.ev === 'game_uid').map((l) => [l.ok, l.result]), [[true, 'set']]);
    } finally {
      eventLog.setSink(null);
    }
  });
});

describe('picking, typing and unlinking', () => {
  it('a pick saves the roster name (source self) and redraws the picker with the new link', async () => {
    const { i, log } = interaction({ extra: { values: ['1'] } });
    await gnHandler.handle(i, ['gn', 'pick', '0', 'deadbeef']);
    assert.equal(log[0][0], 'deferUpdate');
    assert.deepEqual(calls[0].slice(0, 3), ['selfLink', ME, 'Beta Boss']);
    assert.equal(last(log).content, '✅ Bạn đang là **Beta Boss** trong game.\n-# bạn tự chọn');
    assert.deepEqual(last(log).components[0].toJSON().components.map((c) => c.custom_id), ['gn:change', 'gn:unlink']);
  });
  it('a name an admin / another member holds is refused with the owner message (also when the select value is crafted); nothing is saved', async () => {
    mappings = makeMappings([[sid(8), 'Delta', 'admin'], [sid(9), 'Gamma', 'self']]);
    for (const idx of ['3', '2']) {
      gnHandler.resetState();
      const { i, log } = interaction({ extra: { values: [idx] } });
      await gnHandler.handle(i, ['gn', 'pick', '0', 'deadbeef']);
      assert.match(last(log).content, idx === '3' ? /đã được quản lý gán cho người khác — báo quản lý nếu nhầm/ : /Đã có thành viên khác nhận tên này — báo quản lý để xác minh/);
    }
    assert.deepEqual(calls, []);
  });
  it('the service refusing (race: GAME_NAME_TAKEN) or an admin-locked member is answered, not thrown', async () => {
    selfLinkError = Object.assign(new Error('x'), { code: 'GAME_NAME_TAKEN', holder: { id: sid(8), source: 'admin' } });
    let r = interaction({ extra: { values: ['1'] } });
    await gnHandler.handle(r.i, ['gn', 'pick', '0', 'deadbeef']);
    assert.match(last(r.log).content, /đã được quản lý gán cho người khác — báo quản lý nếu nhầm/);
    selfLinkError = Object.assign(new Error('x'), { code: 'GAME_NAME_TAKEN', holder: { id: sid(8), source: 'self' } });
    gnHandler.resetState();
    r = interaction({ extra: { values: ['1'] } });
    await gnHandler.handle(r.i, ['gn', 'pick', '0', 'deadbeef']);
    assert.match(last(r.log).content, /Đã có thành viên khác nhận tên này — báo quản lý để xác minh/);
    selfLinkError = Object.assign(new Error('Quản lý đã gán tên game cho bạn — nhờ quản lý đổi nếu nhầm.'), { code: 'ADMIN_LOCKED' });
    gnHandler.resetState();
    r = interaction({ extra: { values: ['1'] } });
    await gnHandler.handle(r.i, ['gn', 'pick', '0', 'deadbeef']);
    assert.match(last(r.log).content, /Quản lý đã gán tên game cho bạn/);
  });
  it('a pick made on an older roster saves nothing', async () => {
    const { i, log } = interaction({ extra: { values: ['1'] } });
    await gnHandler.handle(i, ['gn', 'pick', '0', 'oldver000']);
    assert.deepEqual(calls, []);
    assert.match(last(log).content, /vừa được cập nhật/);
  });
  it('"Tên tôi không có trong danh sách" opens a modal with a 32-char text input', async () => {
    const { i, log } = interaction();
    await gnHandler.handle(i, ['gn', 'free']);
    const json = log[0][1].toJSON();
    assert.equal(json.custom_id, 'gn:freeModal');
    assert.equal(json.components[0].component.max_length, 32);
  });
  const submitFree = async (value, o = {}) => {
    const r = interaction({ extra: { fields: { getTextInputValue: () => value }, ...o } });
    await gnHandler.handle(r.i, ['gn', 'freeModal']);
    return r;
  };
  it('a typed name outside the roster is saved as unverified (selfFree); whitespace is collapsed', async () => {
    const r = await submitFree('  Người   Lạ  ');
    assert.equal(r.log[0][0], 'deferReply');
    assert.deepEqual(calls[0], ['selfLink', ME, 'Người Lạ', { free: true, displayName: 'Beta Boss' }]);
    assert.match(last(r.log).content, /Người Lạ.*\n-# bạn tự nhập, chờ quản lý kiểm tra/);
    assert.deepEqual(last(r.log).components[0].toJSON().components.map((c) => c.custom_id), ['gn:change', 'gn:unlink']);
  });
  it('a typed name that equals a roster name (any case / accent) is that character (source self, not free); if somebody holds it, refused', async () => {
    await submitFree('beta boss');
    assert.deepEqual(calls[0].slice(0, 3), ['selfLink', ME, 'Beta Boss']);
    assert.equal(calls[0][3].free, false);
    calls.length = 0;
    gnHandler.resetState();
    mappings = makeMappings([[sid(8), 'Beta Boss', 'self']]);
    const r = await submitFree('BETA boss');
    assert.deepEqual(calls, []);
    assert.match(last(r.log).content, /Đã có thành viên khác nhận tên này/);
  });
  it('empty or over-long names are refused without saving; a collision found by the service is reported', async () => {
    for (const bad of ['   ', 'x'.repeat(33)]) {
      gnHandler.resetState();
      const r = await submitFree(bad);
      assert.match(last(r.log).content, /từ 1 đến 32 ký tự/);
    }
    assert.deepEqual(calls, []);
    selfLinkError = Object.assign(new Error('x'), { code: 'GAME_NAME_TAKEN', holder: { id: sid(8), source: 'admin' } });
    gnHandler.resetState();
    const r = await submitFree('Trùng Tên');
    assert.match(last(r.log).content, /đã được quản lý gán cho người khác/);
  });
  it('unlink removes the member\'s own link; an admin\'s pair stays; nothing to unlink is said', async () => {
    link = { gameName: 'Alpha', source: 'self' };
    let r = interaction();
    await gnHandler.handle(r.i, ['gn', 'unlink']);
    assert.match(last(r.log).content, /Đã gỡ liên kết\./);
    assert.match(last(r.log).content, /chưa liên kết/);
    assert.ok(optionsOf(last(r.log)).length > 0, 'back to the full picker');
    gnHandler.resetState();
    r = interaction();
    await gnHandler.handle(r.i, ['gn', 'unlink']);
    assert.match(last(r.log).content, /Bạn chưa liên kết nhân vật nào/);
    link = { gameName: 'Alpha', source: 'admin' };
    unlinkError = Object.assign(new Error('Liên kết này do quản lý gán — nhờ quản lý gỡ.'), { code: 'ADMIN_LOCKED' });
    gnHandler.resetState();
    r = interaction();
    await gnHandler.handle(r.i, ['gn', 'unlink']);
    assert.match(last(r.log).content, /Nhờ quản lý nếu cần đổi/);
    assert.deepEqual(last(r.log).components, [], 'still linked by the admin: compact, no buttons');
  });
  it('picker views stay within Discord limits (long names, 4 buttons max in the last row)', () => {
    const ranked = Array.from({ length: 80 }, (_, k) => ({ game: g('Tên rất dài '.repeat(12) + k, { className: 'Thiết Y' }), score: 0.5, index: k }));
    for (const page of [0, 1, 2, 9]) assertMessage(buildPicker({ link: { gameName: 'x'.repeat(200), source: 'self' }, ranked, page, ver: 'abcdef12' }));
  });
});

describe('the nudge after ✅ Tham gia', () => {
  const open = () => ({ _id: oid(5), guildId: GUILD, title: 'W', status: 'open', startAt: vn(2026, 10, 11, 20), deadlineAt: new Date(Date.now() + 3600e3), channelId: 'c' });
  const member = (extra = {}) => ({ user: { id: ME, username: 'u' }, member: { displayName: 'u', roles: { cache: new (require('discord.js').Collection)() }, permissions: 0n }, memberPermissions: 0n, ...extra });
  function run(memberDoc, status) {
    warService.getEvent = async () => open();
    registrationService.getMember = async () => memberDoc;
    registrationService.upsertRegistration = async () => {};
    registrationService.saveMemberClass = async () => memberDoc;
    registrationService.updateRegistrationClass = async () => {};
    const { i, log } = interaction({ extra: member() });
    return warHandler.handle(i, ['war', 'st', oid(5), status]).then(() => last(log));
  }
  it('no linked name: the confirmation gets one extra line and a gn:open button (non-blocking)', async () => {
    const reply = await run({ className: 'Tố Vấn' }, 'join');
    assert.match(reply.content, /Đã ghi nhận[^]*🎮 Bạn chưa chọn nhân vật trong game/);
    assert.deepEqual(reply.components.map((r) => r.toJSON().components.map((c) => [c.custom_id, c.label])), [[['gn:open', '🎮 Chọn nhân vật của tôi']]]);
  });
  it('a linked member, or ❌ Vắng, gets the plain confirmation', async () => {
    assert.equal(typeof (await run({ className: 'Tố Vấn', gameName: 'Alpha' }, 'join')), 'string');
    assert.equal(typeof (await run({ className: 'Tố Vấn' }, 'absent')), 'string');
  });
});

describe('matching, counts and the admin views', () => {
  const infos = [ME, sid(2), sid(3)].map((id, k) => ({ id, name: ['Beta Boss', 'Alpha', 'Quan'][k], bot: false }));
  const mk = (entries) => makeMappings(entries);

  it('a self link wins over the automatic name match (like an admin pair) and is marked with its source', () => {
    const members = [g('Alpha'), g('Beta Boss')];
    const match = gameRoster.matchDiscord(members, infos, mk([[ME, 'Alpha', 'self']])); // ME is called "Beta Boss" but chose Alpha
    const mine = match.matched.find((m) => m.discordId === ME);
    assert.deepEqual([mine.game.name, mine.how, mine.manual, mine.source], ['Alpha', 'manual', true, 'self']);
    assert.equal(match.matched.find((m) => m.discordId === sid(2)), undefined, 'the person called Alpha lost the automatic match');
  });
  it('a typed name that is not in the roster is "unlisted", not stale; one that is in the roster matches with source selfFree', () => {
    const match = gameRoster.matchDiscord([g('Alpha')], infos, mk([[ME, 'Không Có', 'selfFree'], [sid(2), 'Alpha', 'selfFree'], [sid(3), 'Mất Rồi', 'self']]));
    assert.deepEqual(match.unlisted, [{ discordId: ME, gameName: 'Không Có' }]);
    assert.deepEqual(match.stale, [{ discordId: sid(3), gameName: 'Mất Rồi' }], 'a roster pick whose name left the roster stays stale');
    assert.equal(match.matched[0].source, 'selfFree');
    assert.deepEqual(gameRoster.linkCounts(match), { admin: 0, self: 0, free: 2 });
    assert.equal(gameRoster.gameNameMap(match).get(ME), 'Không Có', 'a typed name is still the person\'s name');
    assert.equal(gameRoster.nameSources(match).get(ME), 'selfFree');
  });
  it('linkCounts: ghép tay / tự liên kết / tên tự nhập', () => {
    const roster2 = [g('A1'), g('B1'), g('C1')];
    const people = ['u1', 'u2', 'u3', 'u4'].map((id) => ({ id, name: `p${id}`, bot: false }));
    const match = gameRoster.matchDiscord(roster2, people, mk([['u1', 'A1', 'admin'], ['u2', 'B1', 'self'], ['u3', 'C1', 'selfFree'], ['u4', 'Ngoài', 'selfFree']]));
    assert.deepEqual(gameRoster.linkCounts(match), { admin: 1, self: 1, free: 2 });
  });
  it('the Ghép tên view: counts line and the remove menu label self / typed links (own links listed before admin pairs)', () => {
    const members = [g('A1'), g('B1'), g('C1')];
    const people = ['u1', 'u2', 'u3', 'u4'].map((id) => ({ id, name: `p${id}`, bot: false }));
    const maps = mk([['u1', 'A1', 'admin'], ['u2', 'B1', 'self'], ['u3', 'C1', 'selfFree'], ['u4', 'Ngoài', 'selfFree']]);
    const match = gameRoster.matchDiscord(members, people, maps);
    const view = buildMapView({ roster: members, match, mappings: maps, nameOf: (id) => `p${id}`, ver: 'abcdef12' });
    assertMessage(view);
    assert.match(view.content, /ghép tay: \*\*1\*\* · tự liên kết: \*\*1\*\* · tên tự nhập: \*\*2\*\*/);
    const menu = view.components.map((r) => r.toJSON().components[0]).find((c) => c.custom_id === 'adm:gmapdel');
    const labels = menu.options.map((o) => o.label);
    assert.equal(labels.length, 4);
    assert.ok(labels.some((l) => l.includes('B1') && l.startsWith('(tự liên kết)')));
    assert.ok(labels.some((l) => l.includes('C1') && l.startsWith('(tự nhập)')));
    assert.ok(labels.some((l) => l.includes('Ngoài') && l.startsWith('(tự nhập · ngoài danh sách)')));
    assert.ok(labels.find((l) => l.includes('A1')) && !/\(tự/.test(labels.find((l) => l.includes('A1'))));
    assert.ok(labels.slice(0, 3).every((l) => /\(tự/.test(l)), 'self links come before the admin pair');
  });
  it('the 🎮 summary embed shows the three counts and lists typed names that are not in the roster', async () => {
    const { buildEmbedForTest } = require('../src/bot/interactions/gameRoster');
    const members = [g('A1'), g('B1')];
    const people = ['u1', 'u2', 'u3'].map((id) => ({ id, name: `p${id}`, bot: false }));
    const match = gameRoster.matchDiscord(members, people, mk([['u1', 'A1', 'admin'], ['u2', 'B1', 'self'], ['u3', 'Ngoài', 'selfFree']]));
    const embed = buildEmbedForTest({ roster: { importedAt: new Date(), source: 's', members }, prev: null, match, diff: null }, guildConfigService.defaultConfig(GUILD), undefined);
    const text = JSON.stringify(embed.toJSON());
    assert.match(text, /\(trong đó 1 ghép tay · 1 tự liên kết · 1 tên tự nhập\)/);
    assert.match(text, /Tên tự nhập, không có trong danh sách game \(1\): Ngoài/);
  });
});

describe('review fixes: names, messages, availability, cooldown', () => {
  const submitFree = async (value, o = {}) => {
    const r = interaction({ extra: { fields: { getTextInputValue: () => value }, ...o } });
    await gnHandler.handle(r.i, ['gn', 'freeModal']);
    return r;
  };

  it('M1 cleanFreeName: NFKC, invisible characters dropped, spaces collapsed; Latin / Vietnamese / digits / _ . - \' · allowed', () => {
    assert.deepEqual(gameRoster.cleanFreeName('  Ｋｅｌｏ\u200b\u00a0  Boa '), { name: 'Kelo Boa' });
    assert.deepEqual(gameRoster.cleanFreeName("Nguyễn_Văn.A-B'·2"), { name: "Nguyễn_Văn.A-B'·2" });
    assert.deepEqual(gameRoster.cleanFreeName('Đặng Thị Ánh'), { name: 'Đặng Thị Ánh' });
    for (const ok of ['Hắc Phong', 'Ǝnna', 'Łukasz', 'Straße', 'Ṁuỗi']) assert.deepEqual(gameRoster.cleanFreeName(ok), { name: ok });
  });
  it('M1 other scripts, mixed scripts, emoji and symbols are refused with a clear message (nothing saved)', async () => {
    for (const bad of ['Кelo', 'Kuzυ', '龍林', 'Tên😀', 'a<b>', '___', '...', 'ʙach duong', 'ꜰᴏx', 'ɑnna', 'ᴏmega', '---']) {
      assert.ok(gameRoster.cleanFreeName(bad).error, bad);
    }
    assert.match(gameRoster.cleanFreeName('Кelo').error, /chữ Latin \/ tiếng Việt/);
    const r = await submitFree('Кelo');
    assert.match(last(r.log).content, /chữ Latin/);
    assert.deepEqual(calls, []);
  });
  it('M1 lookalike letters: a typed Latin name equal to a roster name written with Cyrillic lookalikes is that roster character (roster spelling saved)', async () => {
    roster.members = [g('Кelo'), g('Zed')]; // the first letter is Cyrillic
    await submitFree('kelo');
    assert.deepEqual(calls[0].slice(0, 3), ['selfLink', ME, 'Кelo']);
    assert.equal(calls[0][3].free, false);
    assert.equal(gameRoster.nameKey('Кelo'), gameRoster.nameKey('KELO'));
  });

  it('M2 a name held by another member\'s own link: the self message AND one notice to the admin channel (no mentions, once per name per hour)', async () => {
    mappings = makeMappings([[sid(8), 'Beta Boss', 'self']]);
    let now = 1_000_000;
    gnHandler.resetState({ now: () => now });
    const r = await submitFree('beta boss');
    assert.match(last(r.log).content, /Đã có thành viên khác nhận tên này — báo quản lý để xác minh/);
    assert.equal(adminSent.length, 1);
    assert.equal(adminSent[0].content, `🎮 <@${ME}> muốn nhận **Beta Boss** nhưng <@${sid(8)}> đã tự liên kết — kiểm tra trong 🔗 Ghép tên.`);
    assert.deepEqual(adminSent[0].allowedMentions, { parse: [] });
    now += 11_000; // past the member cooldown, still inside the hour
    await submitFree('BETA BOSS');
    assert.equal(adminSent.length, 1, 'rate limited');
    now += 3_600_000;
    await submitFree('Beta Boss');
    assert.equal(adminSent.length, 2);
  });
  it('M2 a failed admin-channel send does not start the rate limit: the next try notifies again', async () => {
    mappings = makeMappings([[sid(8), 'Beta Boss', 'self']]);
    let now = 1_000_000;
    gnHandler.resetState({ now: () => now });
    await submitFree('beta boss', { client: { guilds: { cache: new Map() }, channels: { fetch: async () => ({ send: async () => { throw new Error('Missing Access'); } }) } } });
    assert.equal(adminSent.length, 0);
    now += 11_000;
    await submitFree('beta boss');
    assert.equal(adminSent.length, 1, 'the earlier failure did not suppress the notice');
  });
  it('M2 an ADMIN-held name: the admin message and no notice', async () => {
    mappings = makeMappings([[sid(8), 'Beta Boss', 'admin']]);
    const r = await submitFree('Beta Boss');
    assert.match(last(r.log).content, /đã được quản lý gán cho người khác — báo quản lý nếu nhầm/);
    assert.equal(adminSent.length, 0);
  });

  it('M3 an incomplete member list: no self pick is saved, the picker says to retry', async () => {
    const r = interaction({ extra: { values: ['1'] } });
    r.i.guild.members.fetch = async () => { throw new Error('rate limited'); };
    r.i.guild.memberCount = 500;
    await gnHandler.handle(r.i, ['gn', 'pick', '0', 'deadbeef']);
    assert.deepEqual(calls, []);
    assert.match(last(r.log).content, /đang tải danh sách thành viên/);
  });
  it('M3 a roster name that is the exact Discord name of ANOTHER member is not offered and not pickable, even when the automatic match is ambiguous', async () => {
    roster.members = [g('Gamma'), g('Beta Boss'), g('Omega')];
    const two = [[sid(5), 'Gamma'], [sid(6), 'gamma']]; // two members of that name: the automatic tiers leave both unmatched
    const open = interaction({ guildMembers: two });
    await gnHandler.handle(open.i, ['gn', 'open']);
    assert.deepEqual(optionsOf(last(open.log)).map((o) => o.label).sort(), ['Beta Boss', 'Omega']);
    const pick = interaction({ guildMembers: two, extra: { values: ['0'] } });
    await gnHandler.handle(pick.i, ['gn', 'pick', '0', 'deadbeef']);
    assert.deepEqual(calls, []);
    assert.match(last(pick.log).content, /khớp tự động với người khác/);
  });

  it('M5 a member cannot change the link twice within 10 s (pick / typed name / unlink); opening and paging are never limited', async () => {
    let now = 5_000;
    gnHandler.resetState({ now: () => now });
    const first = interaction({ extra: { values: ['1'] } });
    await gnHandler.handle(first.i, ['gn', 'pick', '0', 'deadbeef']);
    assert.equal(calls.length, 1);
    const second = interaction({ extra: { values: ['0'] } });
    await gnHandler.handle(second.i, ['gn', 'pick', '0', 'deadbeef']);
    assert.equal(calls.length, 1);
    assert.match(last(second.log).content, /đợi vài giây/);
    const un = interaction();
    await gnHandler.handle(un.i, ['gn', 'unlink']);
    assert.match(last(un.log).content, /đợi vài giây/);
    assert.ok(!calls.some((c) => c[0] === 'selfUnlink'));
    const open = interaction();
    await gnHandler.handle(open.i, ['gn', 'open']);
    await gnHandler.handle(interaction().i, ['gn', 'p', '0', 'deadbeef']);
    now += 10_000;
    const third = interaction({ extra: { values: ['0'] } });
    await gnHandler.handle(third.i, ['gn', 'pick', '0', 'deadbeef']);
    assert.equal(calls.length, 2);
  });
  it('M5 the picker loads the roster once per action (passed along instead of reloaded)', async () => {
    let loads = 0;
    const orig = gameRoster.latest;
    gameRoster.latest = async (...a) => (loads++, orig(...a));
    try {
      const { i } = interaction({ extra: { values: ['1'] } });
      await gnHandler.handle(i, ['gn', 'pick', '0', 'deadbeef']);
      assert.equal(loads, 1);
    } finally {
      gameRoster.latest = orig;
    }
  });

  it('M4 a typed name that is in the roster under another spelling is promoted to the roster spelling when matching', () => {
    const match = gameRoster.matchDiscord([g('Beta Boss')], [{ id: ME, name: 'someone', bot: false }], makeMappings([[ME, 'beta   BOSS', 'selfFree']]));
    assert.equal(match.unlisted.length, 0);
    assert.deepEqual([match.matched[0].game.name, match.matched[0].source], ['Beta Boss', 'selfFree']);
    assert.equal(gameRoster.gameNameMap(match).get(ME), 'Beta Boss');
  });

  it('L8 the nudge is skipped for a member matched automatically, and shown once per war per member', async () => {
    const press = async (memberDoc = { className: 'Tố Vấn' }) => {
      warService.getEvent = async () => ({ _id: oid(5), guildId: GUILD, title: 'W', status: 'open', startAt: vn(2026, 10, 11, 20), deadlineAt: new Date(Date.now() + 3600e3), channelId: 'c' });
      registrationService.getMember = async () => memberDoc;
      registrationService.upsertRegistration = async () => {};
      registrationService.saveMemberClass = async () => memberDoc;
      const { i, log } = interaction({ extra: { user: { id: ME, username: 'u' }, member: { displayName: 'u', roles: { cache: new (require('discord.js').Collection)() }, permissions: 0n }, memberPermissions: 0n } });
      await warHandler.handle(i, ['war', 'st', oid(5), 'join']);
      return last(log);
    };
    autoNames = new Map([[ME, 'Alpha']]);
    assert.equal(typeof (await press()), 'string', 'matched automatically: no nudge');
    autoNames = new Map();
    assert.equal(typeof (await press()), 'object', 'first time: nudge');
    assert.equal(typeof (await press()), 'string', 'second press of the same war: none');
  });

  it('L10 the typed-name modal opened from the picker updates that message in place; from elsewhere it replies', async () => {
    const inPlace = interaction({ extra: { fields: { getTextInputValue: () => 'Người Lạ' }, isFromMessage: () => true } });
    await gnHandler.handle(inPlace.i, ['gn', 'freeModal']);
    assert.equal(inPlace.log[0][0], 'deferUpdate');
    gnHandler.resetState();
    const fresh = interaction({ extra: { fields: { getTextInputValue: () => 'Người Lạ' }, isFromMessage: () => false } });
    await gnHandler.handle(fresh.i, ['gn', 'freeModal']);
    assert.equal(fresh.log[0][0], 'deferReply');
  });

  it('L11 remove-menu labels: the source tag first, the status suffix last, both names share the rest, ≤ 100', () => {
    const members = [g('G'.repeat(60)), g('H'.repeat(60))];
    const people = ['u1', 'u2'].map((id) => ({ id, name: 'D'.repeat(60), bot: false }));
    const maps = makeMappings([['u1', 'G'.repeat(60), 'self'], ['u2', 'Mất Rồi', 'selfFree']]);
    const match = gameRoster.matchDiscord(members, people, maps);
    const view = buildMapView({ roster: members, match, mappings: maps, nameOf: () => 'D'.repeat(60), ver: 'v' });
    const menu = view.components.map((r) => r.toJSON().components[0]).find((c) => c.custom_id === 'adm:gmapdel');
    for (const o of menu.options) assert.ok(o.label.length <= 100, o.label);
    const self = menu.options.find((o) => o.label.includes('GGG'));
    assert.ok(self.label.startsWith('(tự liên kết) ') && self.label.includes('⇄') && self.label.includes('DDD'));
  });

  it('L12 the member-panel setup screen warns when the bot lacks permissions in the chosen channel', () => {
    const { buildSetupView } = require('../src/bot/ui/panel');
    const { PermissionFlagsBits } = require('discord.js');
    const channel = { permissionsFor: () => ({ has: (flag) => flag === PermissionFlagsBits.ViewChannel }) };
    const guild = { channels: { cache: new Map([['123456789012345678', channel]]) }, members: { me: {} } };
    const v = buildSetupView({ ...guildConfigService.defaultConfig(GUILD), gnChannelId: '123456789012345678' }, null, { view: 'gn', guild });
    assert.match(v.content, /bot thiếu quyền: Gửi tin nhắn/);
  });
});
