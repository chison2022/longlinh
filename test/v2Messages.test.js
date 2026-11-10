// Components V2 war message / dashboard / setup view / startup redraw / migration. DB and Discord are stubbed; the stubs on
// the services are installed BEFORE refresher / handlers are required (they destructure at load time).
const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionsBitField, PermissionFlagsBits } = require('discord.js');
const warService = require('../src/services/warService');
const registrationService = require('../src/services/registrationService');
const guildConfigService = require('../src/services/guildConfigService');
const gameRosterService = require('../src/services/gameRosterService');
const defaults = require('../config/defaults');
const { vn, oid, sid, makeRegs } = require('./helpers');
const { assertV2Message, assertMessage } = require('./discordLimits');

let config;
let regs;
let updates; // patches passed to updateConfig
let panelConfigs;
let roster;
guildConfigService.getConfig = async () => config;
guildConfigService.getConfigOrDefault = async () => config;
guildConfigService.getOrCreateConfig = async () => config;
guildConfigService.updateConfig = async (_guildId, patch) => {
  updates.push(patch);
  config = { ...config, ...patch };
  return config;
};
guildConfigService.listPanelConfigs = async () => panelConfigs;
registrationService.listRegistrations = async () => regs;
gameRosterService.latest = async () => roster;
gameRosterService.latestMeta = async () => (roster ? { count: (roster.members || []).length, importedAt: roster.importedAt, source: 'x.xlsx' } : null);
// conditional like the real one: only forgets the dashboard whose message id is the one that failed
guildConfigService.clearPanelIf = async (_guildId, messageId) => {
  if (config.panelMessageId !== messageId) return false;
  updates.push({ panelChannelId: null, panelMessageId: null });
  config = { ...config, panelChannelId: null, panelMessageId: null };
  return true;
};
const scheduled = []; // refresher.scheduleRefresh calls made by handlers
const refresher = require('../src/bot/refresher');
refresher.scheduleRefresh = (...a) => scheduled.push(a);

const adminHandler = require('../src/bot/interactions/admin');
const setupHandler = require('../src/bot/interactions/setup');
const { ensureMembers, clearMemberCache } = require('../src/bot/memberCache');
const { unregisteredCount } = require('../src/bot/eventStats');
const { buildSetupView } = require('../src/bot/ui/panel');
const { warmAndRedraw } = require('../src/bot/client');

const GUILD = '800000000000000001';
const EID = oid(7);
const MANAGE = new PermissionsBitField(PermissionFlagsBits.ManageGuild);
const NOBODY = new PermissionsBitField(PermissionFlagsBits.SendMessages);

const baseEvent = () => ({
  _id: EID,
  guildId: GUILD,
  title: 'Bang chiến T7 20:00 (10/10)',
  status: 'open',
  startAt: vn(2026, 10, 10, 20),
  deadlineAt: vn(2026, 10, 10, 18),
  channelId: 'war-chan',
  messageId: 'war-msg',
  teams: [],
});

let event;
let sent; // [channelId, payload]
let edits; // [channelId, messageId, payload]
let editError; // messageId -> error thrown by messages.edit
let deletes; // [channelId, messageId]
let deleteError; // messageId -> error thrown by messages.delete
let sendError;
let members; // GuildMember-likes of the fake guild

const memberOf = (n, roleIds = ['member-role'], bot = false) => ({
  id: sid(n),
  displayName: `Người ${n}`,
  user: { id: sid(n), username: `u${n}`, bot },
  roles: { cache: new Collection(roleIds.map((id) => [id, { id, name: id }])) },
  joinedAt: null,
});

function makeGuild(over = {}) {
  const guild = {
    id: GUILD,
    memberCount: members.length,
    roles: { cache: new Collection() },
    emojis: { cache: new Collection() },
    channels: { cache: new Collection() },
    members: { cache: new Collection(members.map((m) => [m.id, m])), me: { id: 'bot', roles: { cache: new Collection() } }, fetch: async () => guild.members.cache },
    ...over,
  };
  return guild;
}

function makeChannel(id, guild) {
  return {
    id,
    guild,
    send: async (payload) => {
      if (sendError) throw sendError;
      sent.push([id, payload]);
      return { id: `new-${sent.length}` };
    },
    messages: {
      edit: async (messageId, payload) => {
        edits.push([id, messageId, payload]);
        if (editError[messageId]) throw editError[messageId];
      },
      delete: async (messageId) => {
        deletes.push([id, messageId]);
        if (deleteError[messageId]) throw deleteError[messageId];
      },
    },
  };
}

let guild;
const clientOf = () => ({ channels: { fetch: async (id) => makeChannel(id, guild) } });

beforeEach(() => {
  refresher.cancelScheduled(); // a debounce timer left by an earlier test would swallow this test's schedule
  clearMemberCache();
  config = { ...guildConfigService.defaultConfig(GUILD), announceChannelId: 'war-chan', adminChannelId: 'adm-chan', memberRoleId: 'member-role', classes: defaults.classes };
  regs = makeRegs(6, { classOf: (i) => defaults.classes[i % 2] });
  updates = [];
  panelConfigs = [];
  roster = null;
  event = baseEvent();
  sent = [];
  edits = [];
  editError = {};
  deletes = [];
  deleteError = {};
  sendError = null;
  scheduled.length = 0;
  members = [memberOf(0), memberOf(1), memberOf(2), memberOf(3), memberOf(4), memberOf(5), memberOf(6), memberOf(7), memberOf(8, ['member-role'], true), memberOf(9, [])];
  guild = makeGuild();
  warService.getEvent = async () => event;
  warService.getCurrentEvent = async () => event;
  warService.listAllWithMessage = async () => (event ? [event] : []);
  mock.method(console, 'error', () => {});
  mock.method(console, 'warn', () => {});
  mock.method(console, 'log', () => {});
});

describe('war message: every send / edit is a V2 payload without mentions', () => {
  it('refreshNow edits the old (embed) message into a V2 message in place', async () => {
    await refresher.refreshNow(clientOf(), EID);
    assert.equal(edits.length, 1);
    const [channelId, messageId, payload] = edits[0];
    assert.equal(channelId, 'war-chan');
    assert.equal(messageId, 'war-msg');
    const v2 = assertV2Message(payload);
    assert.ok(v2.customIds.has(`war:st:${EID}:join`));
    assert.ok(!v2.customIds.has(`war:st:${EID}:reserve`));
  });
  it('postWarMessage sends a V2 create payload (no content / embeds keys)', async () => {
    warService.claimPost = async () => true;
    warService.setMessage = async () => {};
    const posted = await refresher.postWarMessage(clientOf(), config, { ...event, messageId: null, channelId: null });
    assert.equal(posted.saved, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], 'war-chan');
    assertV2Message(sent[0][1], { forCreate: true });
  });
  it('moveWarMessage sends a V2 create payload carrying the live counts', async () => {
    warService.moveMessage = async () => true;
    const res = await refresher.moveWarMessage(clientOf(), { ...config, announceChannelId: 'new-chan' }, event);
    assert.equal(res.moved, true);
    assert.equal(sent[0][0], 'new-chan');
    const v2 = assertV2Message(sent[0][1], { forCreate: true });
    assert.match(v2.text, /✅ \*\*6\*\*\/60 đi/);
  });
  it('"chưa đăng ký" shows only when the member cache is known to be complete', async () => {
    const before = assertV2Message(edits.length ? edits[0][2] : (await refresher.refreshNow(clientOf(), EID), edits[0][2]));
    assert.ok(!before.text.includes('chưa đăng ký'), 'cache not fetched yet: left out');
    edits.length = 0;
    await ensureMembers(guild); // marks the guild as fully fetched
    await refresher.refreshNow(clientOf(), EID);
    const after = assertV2Message(edits[0][2]);
    // 8 humans with the member role (ids 0-7), 6 registered -> 2 left; the bot and the role-less member never count
    assert.match(after.text, /❌ 0 vắng · ⏳ 2 chưa đăng ký/);
  });
  it('unregisteredCount: null without a member role or with an incomplete cache', async () => {
    assert.equal(unregisteredCount(guild, { memberRoleId: null }, regs), null);
    assert.equal(unregisteredCount(guild, config, regs), null);
    await ensureMembers(guild);
    assert.equal(unregisteredCount(guild, config, regs), 2);
    guild.memberCount = 50; // the cache is smaller than the guild: partial again
    assert.equal(unregisteredCount(guild, config, regs), null);
  });
});

describe('dashboard: edit vs post, forgotten ids', () => {
  const stored = (patch = {}) => {
    config = { ...config, panelChannelId: 'adm-chan', panelMessageId: 'panel-msg', ...patch };
  };

  it('no stored dashboard: posts a V2 message and stores channel + message id', async () => {
    const res = await refresher.postOrUpdatePanel(clientOf(), config);
    assert.equal(res.action, 'posted');
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], 'adm-chan');
    const v2 = assertV2Message(sent[0][1], { forCreate: true });
    assert.match(v2.text, /### 🏯 Bảng điều khiển/);
    assert.deepEqual(updates, [{ panelChannelId: 'adm-chan', panelMessageId: 'new-1' }]);
  });
  it('a stored dashboard that still exists is edited: nothing is posted, ids stay', async () => {
    stored();
    const res = await refresher.postOrUpdatePanel(clientOf(), config);
    assert.equal(res.action, 'edited');
    assert.deepEqual(sent, []);
    assert.deepEqual(updates, []);
    assert.equal(edits[0][1], 'panel-msg');
    assertV2Message(edits[0][2]);
  });
  it('a stored dashboard that was deleted (Unknown Message): posts a new one and stores the new ids', async () => {
    stored();
    editError['panel-msg'] = Object.assign(new Error('Unknown Message'), { code: 10008 });
    const res = await refresher.postOrUpdatePanel(clientOf(), config);
    assert.equal(res.action, 'posted');
    assert.equal(sent.length, 1);
    assert.deepEqual(updates, [{ panelChannelId: 'adm-chan', panelMessageId: 'new-1' }]);
  });
  it('the admin channel changed: the old dashboard is not touched, a new one is posted there', async () => {
    stored({ panelChannelId: 'old-adm' });
    await refresher.postOrUpdatePanel(clientOf(), config);
    assert.deepEqual(edits, []);
    assert.equal(sent[0][0], 'adm-chan');
  });
  it('other edit errors (no permission) are thrown, not turned into a repost', async () => {
    stored();
    editError['panel-msg'] = Object.assign(new Error('Missing Access'), { code: 50001 });
    await assert.rejects(() => refresher.postOrUpdatePanel(clientOf(), config), /Missing Access/);
    assert.deepEqual(sent, []);
  });
  it('refreshPanelNow edits the stored dashboard with the current event numbers and the game roster', async () => {
    stored();
    roster = { members: new Array(64).fill({ name: 'x' }), importedAt: new Date('2026-10-07T00:00:00Z') };
    await refresher.refreshPanelNow(clientOf(), GUILD);
    assert.equal(edits.length, 1);
    const v2 = assertV2Message(edits[0][2]);
    assert.match(v2.text, /✅ 6\/60 · ❌ 0/);
    assert.match(v2.text, /🎮 Game: 64 người · cập nhật <t:\d+:R>/);
    assert.deepEqual(sent, []);
  });
  it('refreshPanelNow without a stored dashboard does nothing', async () => {
    await refresher.refreshPanelNow(clientOf(), GUILD);
    assert.deepEqual(edits, []);
    assert.deepEqual(updates, []);
  });
  it('a deleted dashboard message or channel is forgotten silently: ids cleared, no repost, no error log', async () => {
    for (const code of [10008, 10003]) {
      updates.length = 0;
      stored();
      editError['panel-msg'] = Object.assign(new Error('gone'), { code });
      await refresher.refreshPanelNow(clientOf(), GUILD);
      assert.deepEqual(updates, [{ panelChannelId: null, panelMessageId: null }], String(code));
      assert.deepEqual(sent, []);
    }
    assert.equal(console.error.mock.calls.length, 0);
  });
  it('another failure is logged and the ids are kept', async () => {
    stored();
    editError['panel-msg'] = Object.assign(new Error('boom'), { code: 500 });
    await refresher.refreshPanelNow(clientOf(), GUILD);
    assert.deepEqual(updates, []);
    assert.ok(console.error.mock.calls.length >= 1);
  });
  it('refreshNow only SCHEDULES the (debounced) dashboard refresh: a burst of war refreshes edits the dashboard once', async (t) => {
    stored();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const flush = () => new Promise((r) => setImmediate(r)); // setImmediate is not mocked: lets the async edit finish
    const saved = defaults.refreshDebounceMs;
    defaults.refreshDebounceMs = 10;
    try {
      await Promise.all([refresher.refreshNow(clientOf(), EID), refresher.refreshNow(clientOf(), EID)]);
      await refresher.refreshNow(clientOf(), EID);
      assert.ok(!edits.some((e) => e[1] === 'panel-msg'), 'not refreshed inline');
      t.mock.timers.tick(10);
      await flush();
      assert.equal(edits.filter((e) => e[1] === 'panel-msg').length, 1);
      edits.length = 0;
      await refresher.refreshNow(clientOf(), EID, { panel: false });
      t.mock.timers.tick(10);
      await flush();
      assert.deepEqual(edits.map((e) => e[1]), ['war-msg']);
    } finally {
      defaults.refreshDebounceMs = saved;
    }
  });
  it('"Xem danh sách" lists the joins of a class in registration order', () => {
    const { buildListEmbeds } = require('../src/bot/ui/warMessage');
    const cls = defaults.classes[0];
    const rs = ['A:join', 'B:join', 'C:join'].map((x) => ({ discordId: x[0], displayName: x[0], status: x.slice(2), className: cls }));
    const value = buildListEmbeds(baseEvent(), rs, defaults.classes)[0].toJSON().fields[0].value;
    assert.ok(value.indexOf('A') < value.indexOf('B') && value.indexOf('B') < value.indexOf('C'), value);
  });
  it('the dashboard reads only the roster meta (count + date), never the member list', async () => {
    stored();
    let full = 0;
    const latest = gameRosterService.latest;
    gameRosterService.latest = async (...a) => (full++, latest(...a));
    roster = { members: new Array(3).fill({ name: 'x' }), importedAt: new Date('2026-10-07T00:00:00Z') };
    await refresher.refreshPanelNow(clientOf(), GUILD);
    gameRosterService.latest = latest;
    assert.equal(full, 0);
    assert.match(assertV2Message(edits[0][2]).text, /🎮 Game: 3 người/);
  });
  it('forgetting a dead dashboard keeps ids stored meanwhile (conditional on the failed message id)', async () => {
    stored();
    const client = {
      channels: {
        fetch: async (id) => {
          const ch = makeChannel(id, guild);
          ch.messages.edit = async () => {
            // /setup stores a new dashboard while this edit is failing
            config = { ...config, panelChannelId: 'adm-chan', panelMessageId: 'panel-new' };
            throw Object.assign(new Error('Unknown Message'), { code: 10008 });
          };
          return ch;
        },
      },
    };
    await refresher.refreshPanelNow(client, GUILD);
    assert.deepEqual(updates, [], 'nothing cleared');
    assert.equal(config.panelMessageId, 'panel-new');
  });
  it('a dashboard posted into a new admin channel deletes the previous one first (gone / forbidden is ignored)', async () => {
    stored({ panelChannelId: 'old-adm', panelMessageId: 'old-panel' });
    const res = await refresher.postOrUpdatePanel(clientOf(), config);
    assert.equal(res.action, 'posted');
    assert.deepEqual(deletes, [['old-adm', 'old-panel']]);
    assert.deepEqual(updates, [{ panelChannelId: 'adm-chan', panelMessageId: 'new-1' }]);
    for (const code of [10003, 10008, 50001, 50013]) {
      deletes.length = 0;
      updates.length = 0;
      sent.length = 0;
      stored({ panelChannelId: 'old-adm', panelMessageId: 'old-panel' });
      deleteError['old-panel'] = Object.assign(new Error('nope'), { code });
      await refresher.postOrUpdatePanel(clientOf(), config);
      assert.deepEqual(updates, [{ panelChannelId: 'adm-chan', panelMessageId: 'new-1' }], String(code));
    }
    assert.equal(console.warn.mock.calls.filter((c) => /not deleted/.test(c.arguments.join(' '))).length, 2, 'gone codes are silent, 50001/50013 are warned (never thrown)');
    // same channel, message gone: nothing to delete
    deletes.length = 0;
    stored();
    editError['panel-msg'] = Object.assign(new Error('Unknown Message'), { code: 10008 });
    await refresher.postOrUpdatePanel(clientOf(), config);
    assert.deepEqual(deletes, []);
  });
  it('schedulePanelRefresh coalesces a burst into one edit', async (t) => {
    stored();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    refresher.schedulePanelRefresh(clientOf(), GUILD, 5);
    refresher.schedulePanelRefresh(clientOf(), GUILD, 5);
    refresher.schedulePanelRefresh(clientOf(), GUILD, 5);
    t.mock.timers.tick(5);
    await new Promise((r) => setImmediate(r));
    assert.equal(edits.length, 1);
  });
});

describe('refreshes are serialized per message (dirty flag, fresh reads)', () => {
  // A client whose edits block until released; records overlap.
  function gatedClient() {
    const state = { running: 0, maxRunning: 0, started: [], release: [] };
    const client = {
      channels: {
        fetch: async (id) => ({
          id,
          guild,
          messages: {
            edit: async (messageId, payload) => {
              state.running += 1;
              state.maxRunning = Math.max(state.maxRunning, state.running);
              state.started.push([messageId, payload]);
              await new Promise((resolve) => state.release.push(resolve));
              state.running -= 1;
            },
          },
        }),
      },
    };
    const tick = () => new Promise((r) => setTimeout(r, 10));
    return { state, client, tick };
  }
  const textOf = (payload) => assertV2Message(payload).text;

  it('clicks during an edit never run in parallel: one more run follows and it reads the FRESH state', async () => {
    const { state, client, tick } = gatedClient();
    const first = refresher.refreshNow(client, EID, { panel: false });
    await tick();
    assert.equal(state.started.length, 1);
    regs = makeRegs(9, { classOf: (i) => defaults.classes[i % 2] }); // registrations change while the first edit is in flight
    const second = refresher.refreshNow(client, EID, { panel: false });
    const third = refresher.refreshNow(client, EID, { panel: false });
    await tick();
    assert.equal(state.started.length, 1, 'still waiting for the first edit');
    state.release.shift()();
    await tick();
    assert.equal(state.started.length, 2, 'a burst of waiting calls asks for ONE more run');
    state.release.shift()();
    await Promise.all([first, second, third]);
    assert.equal(state.maxRunning, 1);
    assert.match(textOf(state.started[0][1]), /✅ \*\*6\*\*\/60/);
    assert.match(textOf(state.started[1][1]), /✅ \*\*9\*\*\/60/);
  });
  it('the startup redraw goes through the same path: a click during it is not overwritten by the older read', async () => {
    const { state, client, tick } = gatedClient();
    const redraw = refresher.redrawAll(client, { delayMs: 0, sleep: async () => {} });
    await tick();
    regs = makeRegs(8, { classOf: (i) => defaults.classes[i % 2] });
    const click = refresher.refreshNow(client, EID, { panel: false });
    await tick();
    state.release.shift()(); // the redraw's edit (older read) finishes
    await tick();
    state.release.shift()(); // the re-run (fresh read)
    await tick();
    while (state.release.length) state.release.shift()();
    await Promise.all([redraw, click]);
    assert.equal(state.maxRunning, 1);
    assert.match(textOf(state.started.at(-1)[1]), /✅ \*\*8\*\*\/60/, 'the last edit carries the newest data');
  });
  it('the dashboard of a guild is serialized the same way', async () => {
    config = { ...config, panelChannelId: 'adm-chan', panelMessageId: 'panel-msg' };
    const { state, client, tick } = gatedClient();
    const a = refresher.refreshPanelNow(client, GUILD);
    await tick();
    regs = makeRegs(10, { classOf: (i) => defaults.classes[i % 2] });
    const b = refresher.refreshPanelNow(client, GUILD);
    const c = refresher.refreshPanelNow(client, GUILD);
    await tick();
    assert.equal(state.started.length, 1);
    state.release.shift()();
    await tick();
    state.release.shift()();
    await Promise.all([a, b, c]);
    assert.equal(state.started.length, 2);
    assert.equal(state.maxRunning, 1);
    assert.match(textOf(state.started[0][1]), /✅ 6\/60/);
    assert.match(textOf(state.started[1][1]), /✅ 10\/60/);
  });
  it('different events are independent (no waiting on each other)', async () => {
    const { state, client, tick } = gatedClient();
    const e2 = { ...baseEvent(), _id: oid(8), messageId: 'war-msg-2' };
    warService.getEvent = async (id) => (String(id) === EID ? event : e2);
    const a = refresher.refreshNow(client, EID, { panel: false });
    const b = refresher.refreshNow(client, oid(8), { panel: false });
    await tick();
    assert.equal(state.started.length, 2);
    state.release.splice(0).forEach((r) => r());
    await Promise.all([a, b]);
  });
  it('a failed run does not wedge the key', async () => {
    editError['war-msg'] = Object.assign(new Error('boom'), { code: 500 });
    await refresher.refreshNow(clientOf(), EID, { panel: false });
    delete editError['war-msg'];
    edits.length = 0;
    await refresher.refreshNow(clientOf(), EID, { panel: false });
    assert.equal(edits.length, 1);
  });
});

describe('war message: class line and worst case', () => {
  const { buildWarMessage } = require('../src/bot/ui/warMessage');
  const { matchClassStyles } = require('../src/bot/classStyle');

  it('a class without an emoji of its own shows its plain name after the bullet', () => {
    const classes = ['Kiếm Khách Lạ', '🛡️ Thiết Y'];
    const styles = matchClassStyles(classes, [], [], []);
    const rs = [...makeRegs(12, { classOf: () => 'Kiếm Khách Lạ' }), ...makeRegs(3, { offset: 50, classOf: () => '🛡️ Thiết Y' })];
    const v2 = assertV2Message(buildWarMessage(baseEvent(), rs, { classes, groupCount: 2, schedule: defaults.schedule }, styles));
    assert.match(v2.text, /• Kiếm Khách Lạ 12/);
    assert.match(v2.text, /🛡️ TY 3/, 'a class with an emoji shows the emoji, its initials and the count');
    assert.ok(!v2.text.includes('• Thiết Y'));
  });
  it('worst case stays inside the V2 limits: 25 classes with long custom emoji, 300-char title, 4 groups, 300 registrations', () => {
    const classes = Array.from({ length: 25 }, (_, i) => `Môn phái rất dài số ${String(i).padStart(2, '0')} ${'x'.repeat(14)}`);
    const styles = new Map(
      classes.map((c, i) => [c, { emoji: { id: String(900000000000000000n + BigInt(i)), name: 'n'.repeat(32), animated: true }, emojiText: `<a:${'n'.repeat(32)}:${900000000000000000n + BigInt(i)}>`, color: null, plain: c }])
    );
    const rs = makeRegs(300, { classOf: (i) => classes[i % 25] });
    const ev = { ...baseEvent(), title: 'T'.repeat(300) };
    const cfg = { classes, groupCount: 4, schedule: defaults.schedule };
    assertV2Message(buildWarMessage(ev, rs, cfg, styles, { unregistered: 40 }));
    // the same with no emoji at all (plain names after a bullet)
    assertV2Message(buildWarMessage(ev, rs, cfg, matchClassStyles(classes, [], [], []), { unregistered: 40 }));
  });
  it('worst-case dashboard (300-char title, 300 registrations, 4 groups) stays inside the V2 limits', async () => {
    const classes = Array.from({ length: 25 }, (_, i) => `Môn phái rất dài số ${String(i).padStart(2, '0')} ${'x'.repeat(14)}`);
    config = { ...config, classes, groupCount: 4, panelChannelId: 'adm-chan', panelMessageId: 'panel-msg' };
    regs = makeRegs(300, { classOf: (i) => classes[i % 25] });
    event = { ...baseEvent(), title: 'T'.repeat(300), teams: Array.from({ length: 20 }, (_, i) => ({ name: `N${Math.floor(i / 5) + 1}·PT${(i % 5) + 1}`, memberIds: regs.slice(i * 6, i * 6 + 6).map((r) => r.discordId) })) };
    roster = { members: new Array(300).fill({ name: 'x' }), importedAt: new Date() };
    await refresher.refreshPanelNow(clientOf(), GUILD);
    assert.equal(edits.length, 1);
    assertV2Message(edits[0][2]);
  });
});

describe('startup redraw', () => {
  it('redraws every unfinished war message, then every dashboard, one after another with a pause', async () => {
    const e2 = { ...baseEvent(), _id: oid(8), messageId: 'war-msg-2', status: 'locked' };
    warService.listAllWithMessage = async () => [event, e2];
    warService.getEvent = async (id) => (String(id) === EID ? event : e2);
    panelConfigs = [{ guildId: GUILD, panelChannelId: 'adm-chan', panelMessageId: 'panel-msg' }];
    config = { ...config, panelChannelId: 'adm-chan', panelMessageId: 'panel-msg' };
    const order = [];
    const sleeps = [];
    const res = await refresher.redrawAll(clientOf(), { delayMs: 7, sleep: async (ms) => sleeps.push(ms) });
    for (const [, messageId, payload] of edits) {
      order.push(messageId);
      assertV2Message(payload);
    }
    assert.deepEqual(order, ['war-msg', 'war-msg-2', 'panel-msg'], 'the war-message redraws do not each redraw the dashboard');
    assert.deepEqual(sleeps, [7, 7, 7]);
    assert.deepEqual(res, { events: 2, panels: 1 });
  });
  it('a failure is logged and the loop goes on; a failing listing never throws', async () => {
    const e2 = { ...baseEvent(), _id: oid(8), messageId: 'war-msg-2' };
    warService.listAllWithMessage = async () => [event, e2];
    warService.getEvent = async (id) => (String(id) === EID ? event : e2);
    editError['war-msg'] = Object.assign(new Error('Missing Access'), { code: 50001 });
    await refresher.redrawAll(clientOf(), { delayMs: 0, sleep: async () => {} });
    assert.deepEqual(edits.map((e) => e[1]), ['war-msg', 'war-msg-2']);
    warService.listAllWithMessage = async () => {
      throw new Error('db down');
    };
    edits.length = 0;
    assert.deepEqual(await refresher.redrawAll(clientOf(), { delayMs: 0, sleep: async () => {} }), { events: 0, panels: 0 });
    assert.deepEqual(edits, []);
  });
  it('ClientReady path: members are warmed first, then the redraw runs; a failing warm-up does not stop it', async () => {
    const order = [];
    const g = makeGuild();
    g.members.fetch = async () => {
      order.push('fetch');
      return g.members.cache;
    };
    guild = g;
    const origEdit = edits.push.bind(edits);
    const client = { ...clientOf(), guilds: { cache: new Collection([[GUILD, g]]) } };
    client.channels.fetch = async (id) => {
      const ch = makeChannel(id, g);
      const edit = ch.messages.edit;
      ch.messages.edit = async (...a) => {
        order.push('edit');
        return edit(...a);
      };
      return ch;
    };
    await warmAndRedraw(client, { redraw: { delayMs: 0, sleep: async () => {} } });
    assert.deepEqual(order, ['fetch', 'edit']);
    assert.ok(origEdit);
    // warm-up failure
    clearMemberCache();
    edits.length = 0;
    g.members.fetch = async () => {
      throw new Error('gateway');
    };
    await warmAndRedraw(client, { redraw: { delayMs: 0, sleep: async () => {} } });
    assert.equal(edits.length, 1);
    assert.ok(!assertV2Message(edits[0][2]).text.includes('chưa đăng ký'), 'incomplete cache: part left out');
  });
});

describe('/setup view', () => {
  const allPerms = () => new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles]);
  const chan = (perms) => ({ id: 'x', permissionsFor: () => perms });
  const guildWith = (channels) => {
    const g = makeGuild();
    g.channels.cache = new Collection(channels);
    return g;
  };

  it('✅ for a channel the bot can use, ⚠️ naming what is missing otherwise', () => {
    const g = guildWith([
      ['war-chan', chan(allPerms())],
      ['adm-chan', chan(new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))],
    ]);
    const v = buildSetupView(config, undefined, { guild: g });
    assert.match(v.content, /✅ Kênh thông báo: <#war-chan>/);
    assert.match(v.content, /⚠️ Kênh admin: <#adm-chan> — bot thiếu quyền: Nhúng liên kết, Đính kèm tệp/);
    assertMessage(v);
  });
  it('lists every missing permission; a channel the bot cannot see is flagged', () => {
    const g = guildWith([['war-chan', chan(new PermissionsBitField(0n))]]);
    const v = buildSetupView({ ...config, adminChannelId: 'ghost' }, undefined, { guild: g });
    assert.match(v.content, /⚠️ Kênh thông báo: <#war-chan> — bot thiếu quyền: Xem kênh, Gửi tin nhắn, Nhúng liên kết, Đính kèm tệp/);
    assert.match(v.content, /⚠️ Kênh admin: <#ghost> — bot không thấy kênh này/);
  });
  it('no channel chosen -> ⚠️ chưa chọn; member role: ⚠️ when missing, ✅ with the member count when known', () => {
    const empty = { ...config, announceChannelId: null, adminChannelId: null, memberRoleId: null };
    const v = buildSetupView(empty, undefined, { guild });
    assert.match(v.content, /⚠️ Kênh thông báo: _chưa chọn_/);
    assert.match(v.content, /⚠️ Role thành viên: _chưa chọn_/);
    assert.match(buildSetupView(config, undefined, { memberCount: 64 }).content, /✅ Role thành viên: <@&member-role> \(64 người\)/);
    assert.ok(!/người\)/.test(buildSetupView(config, undefined, {}).content), 'count only when the cache is complete');
  });
  it('the handler counts the member role from the cache only when it is complete', async () => {
    const calls = [];
    const make = () => ({ guild, guildId: GUILD, client: clientOf() });
    const view = await setupHandler.setupView(make(), config);
    assert.ok(!/người\)/.test(view.content), 'cache not fetched yet');
    await ensureMembers(guild);
    const full = await setupHandler.setupView(make(), config);
    assert.match(full.content, /✅ Role thành viên: <@&member-role> \(8 người\)/); // 8 humans with the role, not the bot
    assert.ok(calls);
  });
  it('an open event whose message is in another channel adds the move button (still 5 rows, ≤ 5 buttons)', async () => {
    config = { ...config, announceChannelId: 'new-chan' };
    const view = await setupHandler.setupView({ guild, guildId: GUILD }, config);
    const { rows } = assertMessage(view);
    assert.equal(rows.length, 5);
    assert.deepEqual(rows[4].components.map((c) => c.custom_id), ['setup:postall', 'setup:featview', 'setup:advview', `adm:move:${EID}`]);
    assert.match(view.content, /đang ở <#war-chan>/);
    const same = await setupHandler.setupView({ guild, guildId: GUILD }, { ...config, announceChannelId: 'war-chan' });
    assert.deepEqual(assertMessage(same).rows[4].components.map((c) => c.custom_id), ['setup:postall', 'setup:featview', 'setup:advview']);
    event = { ...event, status: 'published' };
    const published = await setupHandler.setupView({ guild, guildId: GUILD }, config);
    assert.deepEqual(assertMessage(published).rows[4].components.map((c) => c.custom_id), ['setup:postall', 'setup:featview', 'setup:advview'], 'published lineups are not moved');
  });
  it('adm:move pressed in the /setup view re-renders that view with the result as its note (not plain text)', async () => {
    config = { ...config, announceChannelId: 'new-chan' };
    warService.moveMessage = async (_id, _old, channelId, messageId) => {
      event = { ...event, channelId, messageId };
      return true;
    };
    const log = [];
    const i = {
      guild,
      guildId: GUILD,
      client: clientOf(),
      member: { roles: [], permissions: MANAGE },
      memberPermissions: MANAGE,
      message: { components: buildSetupView(config).components.map((c) => c.toJSON()).map((row) => ({ components: row.components.map((x) => ({ customId: x.custom_id })) })) },
      deferUpdate: async () => log.push(['deferUpdate']),
      editReply: async (o) => log.push(['editReply', o]),
    };
    await adminHandler.handle(i, ['adm', 'move', EID]);
    const view = log.at(-1)[1];
    assert.match(view.content, /^\*\*Cài đặt bot bang hội\*\*/);
    assert.match(view.content, /✅ Đã chuyển \*\*.*\*\* sang <#new-chan>/);
    const { customIds } = assertMessage(view);
    assert.ok(customIds.has('setup:postall') && customIds.has('setup:announce'));
    assert.ok(!customIds.has(`adm:move:${EID}`), 'the war message is in the right channel now');
    // from the "already exists" reply (no setup:post on the clicked message) it is still plain text with the buttons gone
    event = baseEvent();
    const plainLog = [];
    await adminHandler.handle({ ...i, message: { components: [] }, editReply: async (o) => plainLog.push(o) }, ['adm', 'move', EID]);
    assert.deepEqual(plainLog[0].components, []);
    assert.match(plainLog[0].content, /^✅ Đã chuyển/);
  });
  it('changing the announce channel re-renders the view with the move button', async () => {
    const log = [];
    const i = {
      guild,
      guildId: GUILD,
      client: clientOf(),
      member: { roles: [], permissions: MANAGE },
      memberPermissions: MANAGE,
      values: ['new-chan'],
      deferUpdate: async () => log.push(['deferUpdate']),
      editReply: async (o) => log.push(['editReply', o]),
      followUp: async (o) => log.push(['followUp', o]),
    };
    await setupHandler.handle(i, ['setup', 'announce']);
    assert.deepEqual(updates, [{ announceChannelId: 'new-chan' }]);
    const view = log.at(-1)[1];
    assert.ok(assertMessage(view).customIds.has(`adm:move:${EID}`));
  });
  it('"📌 Đăng / làm mới bảng điều khiển": label, edits a stored dashboard, posts when there is none', async () => {
    assert.equal(buildSetupView(config).components[4].toJSON().components[0].label, '📌 Đăng tất cả'); // the old setup:post button (on a view posted earlier) still works below
    const run = async () => {
      const log = [];
      const i = {
        guild,
        guildId: GUILD,
        client: clientOf(),
        member: { roles: [], permissions: MANAGE },
        memberPermissions: MANAGE,
        deferUpdate: async () => {},
        editReply: async (o) => log.push(o),
        followUp: async () => {},
      };
      await setupHandler.handle(i, ['setup', 'post']);
      return log[0];
    };
    assert.match((await run()).content, /✅ Đã đăng bảng điều khiển ở <#adm-chan>/);
    assert.equal(sent.length, 1);
    config = { ...config, panelChannelId: 'adm-chan', panelMessageId: 'new-1' };
    assert.match((await run()).content, /✅ Đã làm mới bảng điều khiển ở <#adm-chan>/);
    assert.equal(sent.length, 1, 'edited, not posted again');
    assert.equal(edits.at(-1)[1], 'new-1');
  });
  it('needs both channels before posting', async () => {
    config = { ...config, adminChannelId: null };
    const log = [];
    await setupHandler.handle(
      { guild, guildId: GUILD, client: clientOf(), member: { roles: [], permissions: MANAGE }, memberPermissions: MANAGE, deferUpdate: async () => {}, editReply: async (o) => log.push(o), followUp: async () => {} },
      ['setup', 'post']
    );
    assert.match(log[0].content, /Hãy chọn kênh thông báo và kênh admin trước/);
    assert.deepEqual(sent, []);
  });
});

describe('adm:lock reopen deadline', () => {
  const lockPress = async () => {
    const log = [];
    const i = {
      guild,
      guildId: GUILD,
      client: clientOf(),
      user: { id: sid(900) },
      member: { roles: [], permissions: MANAGE },
      memberPermissions: MANAGE,
      deferReply: async () => {},
      editReply: async (o) => log.push(o),
    };
    await adminHandler.handle(i, ['adm', 'lock']);
    return log.at(-1);
  };
  let reopened;
  beforeEach(() => {
    reopened = [];
    event = { ...baseEvent(), status: 'locked' };
    warService.reopenEvent = async (id, deadline) => {
      reopened.push([id, deadline]);
      return { ...event, status: 'open', deadlineAt: deadline };
    };
  });
  const at = (now, fn) => async () => {
    mock.timers.enable({ apis: ['Date'], now });
    try {
      await fn();
    } finally {
      mock.timers.reset();
    }
  };

  it('start - lockBeforeHours when that is still in the future', at(vn(2026, 10, 9, 12, 0), async () => {
    const reply = await lockPress();
    const expected = vn(2026, 10, 10, 18, 0); // 20:00 - 2h
    assert.equal(reopened[0][1].getTime(), expected.getTime());
    assert.match(reply, new RegExp(`hạn mới: <t:${expected.getTime() / 1000}:f>`));
    assert.deepEqual(scheduled.map((s) => s[1]), [EID]);
  }));
  it('inside the last lockBeforeHours: the deadline is the war start', at(vn(2026, 10, 10, 19, 0), async () => {
    const reply = await lockPress();
    assert.equal(reopened[0][1].getTime(), vn(2026, 10, 10, 20, 0).getTime());
    assert.match(reply, new RegExp(`hạn mới: <t:${vn(2026, 10, 10, 20, 0).getTime() / 1000}:f>`));
  }));
  it('uses the schedule of the guild (lockBeforeHours 5)', at(vn(2026, 10, 9, 12, 0), async () => {
    config = { ...config, schedule: { ...config.schedule, lockBeforeHours: 5 } };
    await lockPress();
    assert.equal(reopened[0][1].getTime(), vn(2026, 10, 10, 15, 0).getTime());
  }));
  it('after the war started nothing is reopened', at(vn(2026, 10, 10, 20, 30), async () => {
    assert.match(await lockPress(), /Đã quá giờ đánh/);
    assert.deepEqual(reopened, []);
  }));
  it('warService.reopenDeadline is pure', () => {
    const e = baseEvent();
    assert.equal(warService.reopenDeadline(e, { lockBeforeHours: 2 }, vn(2026, 10, 8)).getTime(), vn(2026, 10, 10, 18).getTime());
    assert.equal(warService.reopenDeadline(e, { lockBeforeHours: 2 }, vn(2026, 10, 10, 18, 0)).getTime(), vn(2026, 10, 10, 20).getTime(), 'exactly at the lock time: not in the future');
    assert.equal(warService.reopenDeadline(e, undefined, vn(2026, 10, 8)).getTime(), vn(2026, 10, 10, 18).getTime(), 'default 2h');
  });
});

