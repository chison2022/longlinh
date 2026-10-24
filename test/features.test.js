// Per-guild feature toggles (🧩 Tính năng): the defaults and the migration of old configs, isOn, the buttons hidden per toggle, the gate answering old
// buttons of a switched-off feature, the /setup screens (main, 🧩, ⚙️), 📌 Đăng tất cả and GuildMemberAdd with the gate off.
// All DB / Discord access is stubbed. Destructured imports are captured at require time, so the stubs are installed FIRST.
const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const defaults = require('../config/defaults');
const { vn } = require('./helpers');
const { assertMessage, assertV2Message } = require('./discordLimits');

const guildConfigService = require('../src/services/guildConfigService');

const G = '800000000000000001';
const store = new Map(); // guildId -> config (what the stubbed guildConfigService "persists")
const realDefaultConfig = guildConfigService.defaultConfig;
guildConfigService.getConfigOrDefault = async (id) => {
  if (id === 'g-throws') throw new Error('db down');
  return store.get(id) || realDefaultConfig(id);
};
guildConfigService.getConfig = async (id) => store.get(id) || null;
guildConfigService.getOrCreateConfig = async (id) => {
  if (!store.has(id)) store.set(id, realDefaultConfig(id));
  return store.get(id);
};
guildConfigService.updateConfig = async (id, patch) => {
  const next = { ...(await guildConfigService.getOrCreateConfig(id)), ...patch };
  store.set(id, next);
  return next;
};
// (these requires come AFTER the stubs above: the panel modules destructure updateConfig when they are loaded)
const warService = require('../src/services/warService');
const eventService = require('../src/services/eventService');
const gateService = require('../src/services/gateService');
const refresher = require('../src/bot/refresher');
const eventLog = require('../src/eventLog');
const refreshes = []; // [kind, id]
refresher.scheduleRefresh = (client, eventId) => refreshes.push(['war', String(eventId)]);
refresher.schedulePanelRefresh = (client, guildId) => refreshes.push(['panel', String(guildId)]);
// the dashboard builder is covered elsewhere: a fake with the same contract (edit when the stored message is in the channel, else post)
refresher.postOrUpdatePanel = async (client, config) => {
  const channel = await client.channels.fetch(config.adminChannelId);
  if (config.panelMessageId && config.panelChannelId === channel.id) {
    await channel.messages.edit(config.panelMessageId, {});
    return { action: 'edited', channelId: channel.id, messageId: config.panelMessageId };
  }
  const msg = await channel.send({});
  await guildConfigService.updateConfig(config.guildId, { panelChannelId: channel.id, panelMessageId: msg.id });
  return { action: 'posted', channelId: channel.id, messageId: msg.id };
};
warService.getCurrentEvent = async () => null;
warService.listActiveEvents = async () => [{ _id: 'e1', messageId: 'm1' }, { _id: 'e2', messageId: null }];
eventService.listManage = async () => [];
eventService.countsFor = async () => new Map();
gateService.decidePendingOf = async () => null;

// the handlers the router reaches are replaced by spies (the real /setup handler is kept for its own tests)
const setupHandler = require('../src/bot/interactions/setup');
const realSetupHandle = setupHandler.handle;
const handlerCalls = [];
for (const file of ['war', 'events', 'mailbox', 'gate', 'admin', 'teams']) {
  require(`../src/bot/interactions/${file}`).handle = async (interaction, parts) => handlerCalls.push(parts.join(':'));
}
const { routeInteraction } = require('../src/bot/interactions/router');
const { offReply, featureOf, OFF_TEXT, GATE_OFF_TEXT } = require('../src/bot/featureGate');
const { onGateMemberAdd, onGateMemberRemove } = require('../src/bot/gateEvents');
const features = require('../src/services/features');
const { isOn, featuresOf, FEATURE_KEYS, NEW_GUILD_DEFAULTS, FEATURES, enabledLine } = features;
const { buildWarMessage } = require('../src/bot/ui/warMessage');
const { buildPanel, buildSetupView } = require('../src/bot/ui/panel');
const { postAllPanels, summaryLines } = require('../src/bot/postAll');

const MANAGE = new PermissionsBitField(PermissionFlagsBits.ManageGuild);
const ALL_ON = Object.fromEntries(FEATURE_KEYS.map((k) => [k, true]));
const ALL_OFF = Object.fromEntries(FEATURE_KEYS.map((k) => [k, false]));
const cfg = (patch = {}) => ({ ...realDefaultConfig(G), ...patch });

let lines;
beforeEach(() => {
  store.clear();
  refreshes.length = 0;
  handlerCalls.length = 0;
  lines = [];
  eventLog.setSink((l) => lines.push(JSON.parse(l)));
  mock.method(console, 'error', () => {});
  mock.method(console, 'warn', () => {});
});
const logs = (area, ev) => lines.filter((l) => l.area === area && l.ev === ev);

// ---------- the model, the defaults, isOn ----------

describe('features: defaults, migration, isOn', () => {
  it('a NEW guild: tuyenKhien, offNotice, departNotice on; events, mailbox, gate, voiceHang off (leave, violations, draw: retired)', () => {
    assert.deepEqual(NEW_GUILD_DEFAULTS, { tuyenKhien: true, events: false, mailbox: false, gate: false, voiceHang: false, offNotice: true, departNotice: true });
    assert.deepEqual(featuresOf(null), NEW_GUILD_DEFAULTS, 'no config at all');
    assert.deepEqual(featuresOf(realDefaultConfig(G)), NEW_GUILD_DEFAULTS, 'an un-configured guild');
    assert.deepEqual(FEATURE_KEYS, ['tuyenKhien', 'events', 'mailbox', 'gate', 'voiceHang', 'offNotice', 'departNotice']);
  });
  it('an existing document without the field is computed from what it already uses: a posted panel (or the gate switched on) stays on', () => {
    const old = { guildId: G, announceChannelId: 'a', adminChannelId: 'd' };
    assert.deepEqual(featuresOf(old), NEW_GUILD_DEFAULTS);
    assert.equal(isOn({ ...old, eventPanelMessageId: 'm' }, 'events'), true);
    assert.equal(isOn({ ...old, mailPanelMessageId: 'm' }, 'mailbox'), true);
    assert.equal(isOn({ ...old, gatePanelMessageId: 'm' }, 'gate'), true);
    assert.equal(isOn({ ...old, gateEnabled: true }, 'gate'), true);
    const used = featuresOf({ ...old, eventPanelMessageId: 'm', mailPanelMessageId: 'm', gateEnabled: true });
    assert.deepEqual(used, { ...NEW_GUILD_DEFAULTS, events: true, mailbox: true, gate: true });
    assert.equal(isOn({ ...old, gnPanelMessageId: 'm', panelMessageId: 'm' }, 'violations'), false, 'the dashboard / name panel switch nothing on');
  });
  it('a stored toggle always wins (also over the old gateEnabled and over a posted panel); a partial object falls back per key', () => {
    assert.equal(isOn({ gateEnabled: true, features: { gate: false } }, 'gate'), false);
    assert.equal(isOn({ gateEnabled: false, features: { gate: true } }, 'gate'), true);
    assert.equal(isOn({ eventPanelMessageId: 'm', features: { events: false } }, 'events'), false);
    assert.equal(isOn({ eventPanelMessageId: 'm', features: { leave: false } }, 'events'), true, 'no stored value for events: computed');
    assert.equal(isOn({ features: { leave: false } }, 'tuyenKhien'), true);
  });
  it('🙋 leave, ⚖️ violations and 🎲 draw are retired: always off, whatever is stored; they are not toggles', () => {
    for (const key of ['leave', 'violations', 'draw']) {
      for (const config of [null, {}, { features: { [key]: true } }, { features: { [key]: false } }, { features: { ...ALL_ON, [key]: true } }, realDefaultConfig(G)]) assert.equal(isOn(config, key), false, key);
      assert.ok(!FEATURE_KEYS.includes(key) && !(key in NEW_GUILD_DEFAULTS) && !FEATURES.some((f) => f.key === key), key);
      assert.ok(!(key in featuresOf({ features: { [key]: true } })), key);
    }
    assert.ok(!/Xin nghỉ|vi phạm|Quay thưởng/.test(enabledLine({ features: { leave: true, violations: true, draw: true } })));
  });
  it('an unknown key is never on; the core has no toggle', () => {
    assert.equal(isOn(ALL_ON && { features: ALL_ON }, 'registration'), false);
    assert.equal(isOn({ features: ALL_ON }, undefined), false);
    for (const core of ['registration', 'mission', 'class', 'list', 'unregistered', 'publish', 'gameName', 'sheet', 'headcount']) assert.ok(!FEATURE_KEYS.includes(core));
    assert.equal(guildConfigService.isOn, isOn, 'also exported by guildConfigService');
  });
  it('enabledLine lists the optional features that are on, in the order of the select', () => {
    assert.equal(enabledLine({ features: { ...ALL_OFF, events: true, mailbox: true } }), '🎉 Sự kiện · 📮 Hòm thư');
    assert.equal(enabledLine({ features: ALL_OFF }), '_không có_');
    assert.equal(enabledLine(null), '🛡 Tuyến Khiên · ⏰ Báo off lâu · 👋 Báo rời game');
  });
});

// ---------- buttons ----------

describe('buttons hidden per toggle', () => {
  const EID = '652f1c2e9b1d4a0012345678';
  const event = { _id: EID, guildId: G, title: 'Bang chiến CN 20:00', startAt: vn(2026, 10, 11, 20, 0), deadlineAt: vn(2026, 10, 11, 18, 0), status: 'open', teams: [] };
  const CONFIG = { classes: defaults.classes, groupCount: 2, schedule: defaults.schedule };
  const war = (features) => assertV2Message(buildWarMessage(event, [], { ...CONFIG, ...(features ? { features } : {}) }));
  const rows = (v2) => v2.json[0].components.filter((c) => c.type === 1);

  it('the war card: everything on (and no field at all) -> 🛡 only, ONE row (🙋 is retired, even with leave: true stored)', () => {
    for (const v2 of [war(), war(ALL_ON), war({ ...ALL_ON, leave: true })]) {
      assert.ok(v2.customIds.has(`war:tk:${EID}`) && !v2.customIds.has('lv:open'));
      assert.equal(rows(v2).length, 1);
    }
  });
  it('the war card: tuyenKhien off hides 🛡 only; the other buttons stay', () => {
    const v2 = war({ tuyenKhien: false });
    assert.ok(!v2.customIds.has(`war:tk:${EID}`));
    for (const id of [`war:st:${EID}:join`, `war:st:${EID}:absent`, `war:chg:${EID}`, `war:list:${EID}`, `war:mis:${EID}`]) assert.ok(v2.customIds.has(id), id);
    assert.equal(rows(v2).length, 1);
    assert.ok(rows(v2).every((r) => r.components.length > 0), 'no empty action row');
  });
  it('the war card: 🛡 off -> one row, no 🙋 and no 🛡; still a valid V2 message', () => {
    const v2 = war({ tuyenKhien: false, leave: true });
    assert.deepEqual([...v2.customIds].filter((id) => id.startsWith('lv:') || id.startsWith('war:tk')), []);
    assert.equal(rows(v2).length, 1);
  });
  it('the dashboard: no ⚖️ / 🎲 any more, even with an old config that had them on', () => {
    const ids = (config) => assertV2Message(buildPanel(config === undefined ? {} : { config })).buttons.map((b) => b.custom_id);
    for (const config of [undefined, {}, { features: { violations: true, draw: true } }, { features: ALL_ON }]) {
      assert.ok(!ids(config).includes('vp:open') && !ids(config).includes('gc:open'));
    }
    assert.ok(ids({}).includes('adm:settings') && ids({}).includes('adm:offcfg'), 'the settings buttons never go');
  });
});

// ---------- old buttons of a switched-off feature ----------

describe('old buttons of a switched-off feature (router)', () => {
  const ix = (customId) => {
    const replies = [];
    return {
      replies,
      i: {
        customId,
        guildId: G,
        user: { id: 'u1' },
        inGuild: () => true,
        isChatInputCommand: () => false,
        isMessageComponent: () => true,
        isModalSubmit: () => false,
        isRepliable: () => true,
        replied: false,
        deferred: false,
        reply: async (p) => replies.push(p),
        followUp: async (p) => replies.push(p),
      },
    };
  };
  const click = async (customId) => {
    const x = ix(customId);
    await routeInteraction(x.i);
    return x.replies;
  };
  const MEMBER_SIDE = {
    tuyenKhien: ['war:tk:e1', 'war:tkpick:e1', 'war:tkcarry:e1', 'war:tkclear:e1'],
    events: ['ev:rp:e1:yes', 'ev:ls:e1', 'ev:rules:e1'],
    mailbox: ['mb:open', 'mb:cat', 'mb:anon:idea', 'mb:named:idea', 'mb:sendModal:a:idea', 'mb:view', 'mb:codeModal'],
  };
  const GATE_MEMBER = ['gate:member', 'gate:guest', 'gate:swguest', 'gate:back', 'gate:p:0:v', 'gate:pick:t', 'gate:free', 'gate:freeModal', 'gate:cls:t', 'gate:send:t'];

  it('each member-facing button answers ephemerally "Tính năng này đang tắt…" and its handler never runs (no side effect)', async () => {
    store.set(G, cfg({ features: ALL_OFF }));
    for (const [feature, ids] of Object.entries(MEMBER_SIDE)) {
      for (const id of ids) {
        const replies = await click(id);
        assert.equal(replies.length, 1, id);
        assert.equal(replies[0].content, OFF_TEXT, id);
        assert.equal(replies[0].flags, 64, `${id} (${feature}) is ephemeral`);
      }
    }
    assert.match(OFF_TEXT, /Tính năng này đang tắt — nhờ quản lý bật trong \/setup → 🧩 Tính năng\./);
    assert.deepEqual(handlerCalls, [], 'no handler was reached');
  });
  it('the gate buttons answer "Cổng vào đang tắt"', async () => {
    store.set(G, cfg({ features: ALL_OFF }));
    for (const id of GATE_MEMBER) {
      const replies = await click(id);
      assert.equal(replies[0].content, GATE_OFF_TEXT, id);
      assert.equal(replies[0].flags, 64);
    }
    assert.match(GATE_OFF_TEXT, /Cổng vào đang tắt/);
    assert.deepEqual(handlerCalls, []);
  });
  it('switched ON, the same buttons reach their handler and nothing is answered by the gate', async () => {
    store.set(G, cfg({ features: ALL_ON }));
    const ids = [...Object.values(MEMBER_SIDE).flat(), ...GATE_MEMBER];
    for (const id of ids) assert.deepEqual(await click(id), [], id);
    assert.deepEqual(handlerCalls, ids);
  });
  it('the core is never gated, whatever the toggles: registration, 🎭 phái, 📋, 🎯, 📢, the dashboard', async () => {
    store.set(G, cfg({ features: ALL_OFF }));
    const core = ['war:st:e1:join', 'war:st:e1:absent', 'war:chg:e1', 'war:cls:e1:x', 'war:list:e1', 'war:mis:e1', 'war:mispick:e1', 'adm:unreg', 'adm:game', 'adm:sheet', 'tm:pub:e1'];
    for (const id of core) assert.deepEqual(await click(id), [], id);
    assert.deepEqual(handlerCalls, core);
  });
  it('MANAGER cards keep working with the feature off: gate approval, letters, event notices and the event panel', async () => {
    store.set(G, cfg({ features: ALL_OFF }));
    const cards = ['gate:ok:r1', 'gate:no:r1', 'gate:noModal:r1', 'gate:tg:r1', 'mb:seen:12', 'mb:done:12', 'mb:reply:12', 'mb:replyModal:12', 'ev:mincancel:e1', 'ev:minext:e1', 'ev:minkeep:e1', 'ev:pnew', 'ev:pmanage', 'ev:pick', 'ev:lock:e1', 'adm:depok:r1', 'adm:offok:r1'];
    for (const id of cards) assert.deepEqual(await click(id), [], id);
    assert.deepEqual(handlerCalls, cards);
  });
  it('featureOf maps exactly the member entry points; an unknown id or prefix is not gated', () => {
    assert.equal(featureOf('war:tk:e1'), 'tuyenKhien');
    assert.equal(featureOf('lv:open'), null); // retired: answered by the router before any gate
    assert.equal(featureOf('ev:rp:e1:yes'), 'events');
    assert.equal(featureOf('ev:pnew'), null);
    assert.equal(featureOf('mb:open'), 'mailbox');
    assert.equal(featureOf('mb:seen:1'), null);
    assert.equal(featureOf('gate:member'), 'gate');
    assert.equal(featureOf('gate:ok:1'), null);
    assert.equal(featureOf('setup:main'), null);
    assert.equal(featureOf(undefined), null);
  });
  it('offReply: a guild with an old config (a posted event panel) still answers its event buttons; a failing config read lets the click through', async () => {
    store.set(G, { guildId: G, eventPanelMessageId: 'm' });
    assert.equal(await offReply({ customId: 'ev:rp:e1:yes', guildId: G }), null);
    assert.equal((await offReply({ customId: 'mb:open', guildId: G })).content, OFF_TEXT);
    assert.equal(await offReply({ customId: 'mb:open', guildId: 'g-throws' }), null, 'a config read that throws never blocks the handler');
  });
});

// ---------- GuildMemberAdd / Remove ----------

describe('the gate hooks', () => {
  const member = (extra = {}) => ({ id: 'newbie', guild: { id: G }, user: { bot: false }, ...extra });

  it('GuildMemberAdd with the gate OFF does nothing (no join line)', async () => {
    store.set(G, cfg({ features: { gate: false }, gateEnabled: true }));
    await onGateMemberAdd(member());
    assert.deepEqual(logs('gate', 'join'), []);
    store.set(G, cfg());
    await onGateMemberAdd(member());
    assert.deepEqual(logs('gate', 'join'), [], 'the new-guild default is off too');
  });
  it('GuildMemberAdd with the gate ON logs the join; the legacy gateEnabled still counts without a stored toggle', async () => {
    store.set(G, cfg({ features: { gate: true } }));
    await onGateMemberAdd(member());
    store.set(G, { guildId: G, gateEnabled: true });
    await onGateMemberAdd(member());
    assert.equal(logs('gate', 'join').length, 2);
  });
  it('a bot joining, or a guild without a config, is ignored', async () => {
    store.set(G, cfg({ features: { gate: true } }));
    await onGateMemberAdd(member({ user: { bot: true } }));
    store.clear();
    await onGateMemberAdd(member());
    assert.deepEqual(logs('gate', 'join'), []);
  });
  it('GuildMemberRemove still cancels a pending request when the gate is off (a pending thing can outlive the switch)', async () => {
    store.set(G, cfg({ features: { gate: false } }));
    const asked = [];
    gateService.decidePendingOf = async (...a) => (asked.push(a), null);
    await onGateMemberRemove(member());
    assert.deepEqual(asked, [[G, 'newbie', 'cancelled', { reason: 'đã rời server' }]]);
  });
});

// ---------- /setup screens ----------

describe('/setup main view', () => {
  const config = cfg({ announceChannelId: '100000000000000001', adminChannelId: '100000000000000002' });

  it('5 rows at most; rows 1-4 are the selects; row 5 has 📌 Đăng tất cả (Success), 🧩, ⚙️ (≤ 5 buttons)', () => {
    const v = buildSetupView(config);
    const { rows } = assertMessage(v);
    assert.equal(rows.length, 5);
    assert.deepEqual(rows.slice(0, 4).map((r) => r.components[0].custom_id), ['setup:announce', 'setup:admin', 'setup:roles', 'setup:member']);
    const last = rows[4].components;
    assert.deepEqual(last.map((c) => [c.custom_id, c.label]), [['setup:postall', '📌 Đăng tất cả'], ['setup:featview', '🧩 Tính năng'], ['setup:advview', '⚙️ Nâng cao']]);
    assert.equal(last[0].style, 3, 'Success');
  });
  it('the "Chuyển bài" button joins them while an event message sits in another channel: still 5 rows, 4 buttons', () => {
    const v = buildSetupView(config, null, { moveEvent: { _id: 'e9', title: 'T', channelId: 'old' } });
    const last = assertMessage(v).rows[4].components;
    assert.deepEqual(last.map((c) => c.custom_id), ['setup:postall', 'setup:featview', 'setup:advview', 'adm:move:e9']);
    assert.ok(last.length <= 5);
  });
  it('the health lines stay and one line lists the enabled features', () => {
    const v = buildSetupView({ ...config, features: { ...ALL_OFF, events: true, mailbox: true } });
    assert.match(v.content, /✅ Kênh thông báo: <#100000000000000001>/);
    assert.match(v.content, /Role thành viên: _chưa chọn_/);
    assert.match(v.content, /^Tính năng đang bật: 🎉 Sự kiện · 📮 Hòm thư$/m);
    assert.ok(v.content.length <= 2000);
  });
});

describe('/setup 🧩 Tính năng sub-view', () => {
  it('one multi-select (min 0, max 7) with the 7 toggles - emoji, label, short description - the current ones selected; ↩ Quay lại', () => {
    const v = buildSetupView(cfg({ features: { ...ALL_OFF, events: true, leave: true, violations: true } }), null, { view: 'feat' }); // a stored retired toggle is not shown
    const { rows } = assertMessage(v);
    assert.equal(rows.length, 2);
    const select = rows[0].components[0];
    assert.equal(select.custom_id, 'setup:features');
    assert.equal(select.type, 3);
    assert.equal(select.min_values, 0);
    assert.equal(select.max_values, 7);
    assert.deepEqual(select.options.map((o) => o.value), FEATURE_KEYS);
    assert.deepEqual(select.options.filter((o) => o.default).map((o) => o.value), ['events']);
    assert.ok(!select.options.some((o) => ['leave', 'violations', 'draw'].includes(o.value) || /Xin nghỉ|vi phạm|Quay thưởng/.test(o.label)));
    for (const o of select.options) {
      assert.ok(o.emoji && o.emoji.name, `${o.value} has an emoji`);
      assert.ok(o.label && o.description && o.description.length <= 100, o.value);
    }
    assert.deepEqual(rows[1].components.map((c) => [c.custom_id, c.label]), [['setup:main', '↩ Quay lại']]);
  });
  it('a guild with no stored toggles shows the computed ones (old config with a posted mailbox panel -> 📮 selected)', () => {
    const v = buildSetupView({ guildId: G, mailPanelMessageId: 'm' }, null, { view: 'feat' });
    assert.deepEqual(assertMessage(v).rows[0].components[0].options.filter((o) => o.default).map((o) => o.value), ['tuyenKhien', 'mailbox', 'offNotice', 'departNotice']);
  });

  const client = { id: 'client' };
  const adminIx = (customId, extra = {}) => {
    const log = [];
    return {
      log,
      i: {
        customId,
        guild: { id: G },
        guildId: G,
        client,
        user: { id: 'admin1' },
        member: { roles: [], permissions: MANAGE },
        memberPermissions: MANAGE,
        values: [],
        deferUpdate: async () => log.push(['deferUpdate']),
        editReply: async (o) => log.push(['editReply', o]),
        followUp: async (o) => log.push(['followUp', o]),
        ...extra,
      },
    };
  };
  const lastView = (log) => log.filter((l) => l[0] === 'editReply').at(-1)[1];

  it('🧩 opens from the main view', async () => {
    const x = adminIx('setup:featview');
    await realSetupHandle(x.i, ['setup', 'featview']);
    assert.equal(x.log[0][0], 'deferUpdate');
    assert.ok(assertMessage(lastView(x.log)).customIds.has('setup:features'));
  });
  it('saving writes all seven booleans (and gateEnabled in step), logs setup.features_set, refreshes the war cards and the dashboard', async () => {
    store.set(G, cfg({ gateEnabled: true }));
    const x = adminIx('setup:features', { values: ['events', 'gate', 'tuyenKhien'] });
    await realSetupHandle(x.i, ['setup', 'features']);
    const saved = store.get(G);
    assert.deepEqual(saved.features, { ...ALL_OFF, events: true, gate: true, tuyenKhien: true });
    assert.equal(saved.gateEnabled, true);
    const view = lastView(x.log);
    assert.match(view.content, /✅ Đã lưu/);
    assert.deepEqual(assertMessage(view).rows[0].components[0].options.filter((o) => o.default).map((o) => o.value), ['tuyenKhien', 'events', 'gate']);
    const [line] = logs('setup', 'features_set');
    assert.deepEqual(line.on, ['tuyenKhien', 'events', 'gate']);
    assert.deepEqual(line.off, ['mailbox', 'voiceHang', 'offNotice', 'departNotice']);
    assert.deepEqual(refreshes, [['war', 'e1'], ['panel', G]], 'war messages with a posted message, then the dashboard');
  });
  it('an empty selection is allowed (everything off) and turns the gate switch off too', async () => {
    store.set(G, cfg({ gateEnabled: true, features: { gate: true } }));
    const x = adminIx('setup:features', { values: [] });
    await realSetupHandle(x.i, ['setup', 'features']);
    assert.deepEqual(store.get(G).features, ALL_OFF);
    assert.equal(store.get(G).gateEnabled, false);
  });
  it('the note says what a newly turned-on feature still needs (🚪: welcome channel and the member role, in ⚙️ Nâng cao)', async () => {
    store.set(G, cfg());
    const x = adminIx('setup:features', { values: ['tuyenKhien', 'gate', 'mailbox', 'offNotice', 'departNotice'] });
    await realSetupHandle(x.i, ['setup', 'features']);
    const note = lastView(x.log).content;
    assert.match(note, /🚪 Cổng vào cần kênh welcome và role Thành viên: vào ⚙️ Nâng cao/);
    assert.match(note, /📮 Hòm thư/);
    assert.match(note, /📌 Đăng tất cả/);
    // saving again without a change: no setup reminders
    const again = adminIx('setup:features', { values: ['tuyenKhien', 'gate', 'mailbox', 'offNotice', 'departNotice'] });
    await realSetupHandle(again.i, ['setup', 'features']);
    assert.doesNotMatch(lastView(again.log).content, /Cổng vào cần kênh welcome/);
  });
  it('managers only: another member writes nothing', async () => {
    store.set(G, cfg());
    const x = adminIx('setup:features', { values: ['events'], member: { roles: [], permissions: new PermissionsBitField() }, memberPermissions: new PermissionsBitField() });
    await realSetupHandle(x.i, ['setup', 'features']);
    assert.deepEqual(store.get(G).features, undefined);
    assert.equal(x.log.at(-1)[0], 'followUp');
  });
  it('the ▶/⏸ gate button of the 🚪 sub-view writes features.gate and gateEnabled together', async () => {
    store.set(G, cfg({ features: { gate: false } }));
    const x = adminIx('setup:gatetoggle');
    await realSetupHandle(x.i, ['setup', 'gatetoggle']);
    assert.equal(store.get(G).features.gate, true);
    assert.equal(store.get(G).gateEnabled, true);
    assert.equal(isOn(store.get(G), 'gate'), true);
    assert.equal(store.get(G).features.tuyenKhien, true, 'the other toggles are kept');
  });
  it('📄 Google Doc: the button opens the link form (admin only); a bad link / a Doc the bot cannot open is refused and NOT saved; a good one is saved and written at once; empty disconnects', async () => {
    const gateway = require('../src/services/sheets/gateway');
    const DOC = '1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789';
    store.set(G, cfg({ features: { events: true } }));
    const open = adminIx('setup:evdoc', { reply: async () => {}, showModal: async (m) => open.log.push(['showModal', m]) });
    await realSetupHandle(open.i, ['setup', 'evdoc']);
    assert.equal(open.log[0][1].toJSON().custom_id, 'setup:evdocModal');
    const submit = async (link) => {
      const x = adminIx('setup:evdocModal', { fields: { getTextInputValue: () => link } });
      await realSetupHandle(x.i, ['setup', 'evdocModal']);
      return lastView(x.log).content;
    };
    assert.match(await submit('https://docs.google.com/spreadsheets/d/abc/edit'), /không phải Google Doc/);
    assert.ok(!store.get(G).eventDocId);
    const writes = [];
    let fail = { status: 403, message: 'The caller does not have permission' };
    gateway.setClient({ email: () => 'bot@x.iam.gserviceaccount.com', docsGet: async () => { if (fail) throw fail; return { title: 'T', body: { content: [{ startIndex: 0, endIndex: 1 }, { startIndex: 1, endIndex: 2 }] } }; }, docsBatchUpdate: async (id, r) => writes.push([id, r]) });
    try {
      assert.match(await submit(`https://docs.google.com/document/d/${DOC}/edit`), /Người chỉnh sửa/);
      assert.ok(!store.get(G).eventDocId, 'not saved when the bot cannot open it');
      fail = null;
      mock.method(eventService, 'listForSheet', async () => ({ items: [], any: false }));
      const ok = await submit(`https://docs.google.com/document/d/${DOC}/edit?tab=t.0`);
      assert.match(ok, /Đã nối Google Doc và ghi 0 sự kiện/);
      assert.equal(store.get(G).eventDocId, DOC);
      assert.ok(writes.length >= 1 && writes.every(([id]) => id === DOC), 'written at once');
      assert.match(ok, /📄 Google Doc: \[mở Doc\]/);
      assert.match(await submit(''), /Đã ngắt Google Doc/);
      assert.equal(store.get(G).eventDocId, null);
    } finally {
      gateway.setClient(null);
      mock.restoreAll();
    }
  });
  it('the 🤖/✋ button of the 🚪 sub-view flips gateAutoApprove (on by default) and the view shows the state', async () => {
    store.set(G, cfg({ features: { gate: true } }));
    const off = adminIx('setup:gateauto');
    await realSetupHandle(off.i, ['setup', 'gateauto']);
    assert.equal(store.get(G).gateAutoApprove, false);
    assert.ok(assertMessage(buildSetupView(store.get(G), null, { view: 'gate' })).customIds.has('setup:gateauto'));
    assert.match(buildSetupView(store.get(G), null, { view: 'gate' }).content, /Tự duyệt: \*\*TẮT\*\*/);
    const on = adminIx('setup:gateauto');
    await realSetupHandle(on.i, ['setup', 'gateauto']);
    assert.equal(store.get(G).gateAutoApprove, true);
    assert.match(buildSetupView(store.get(G), null, { view: 'gate' }).content, /Tự duyệt: \*\*BẬT\*\*/);
  });
});

describe('/setup ⚙️ Nâng cao sub-view', () => {
  const ids = (config) => assertMessage(buildSetupView(config, null, { view: 'adv' })).rows;

  it('lists 🎮 always, and 📮 / 🎉 / 🚪 / 🎧 only for the enabled features; ↩ Quay lại on its own row', () => {
    const rows = ids(cfg({ features: ALL_OFF }));
    assert.deepEqual(rows.map((r) => r.components.map((c) => c.custom_id)), [['setup:gnview'], ['setup:main']]);
    assert.deepEqual(ids(cfg({ features: { ...ALL_OFF, mailbox: true } }))[0].components.map((c) => c.custom_id), ['setup:gnview', 'setup:mbview']);
    assert.deepEqual(ids(cfg({ features: { ...ALL_OFF, events: true } }))[0].components.map((c) => c.custom_id), ['setup:gnview', 'setup:evview']);
    assert.deepEqual(ids(cfg({ features: { ...ALL_OFF, gate: true } }))[0].components.map((c) => c.custom_id), ['setup:gnview', 'setup:gateview']);
    assert.deepEqual(ids(cfg({ features: { ...ALL_OFF, voiceHang: true } }))[0].components.map((c) => c.custom_id), ['setup:gnview', 'setup:voiceview']);
    const all = ids(cfg({ features: ALL_ON }))[0].components;
    assert.deepEqual(all.map((c) => c.label), ['🎮 Bảng liên kết tên', '📮 Hòm thư', '🎉 Sự kiện', '🚪 Cổng vào', '🎧 Treo voice']);
    assert.ok(all.length <= 5);
  });
  it('opens from the main view through the handler, and the existing sub-views are unchanged', async () => {
    store.set(G, cfg({ features: { ...ALL_OFF, gate: true } }));
    const log = [];
    const i = { guild: { id: G }, guildId: G, client: {}, user: { id: 'a' }, member: { roles: [], permissions: MANAGE }, memberPermissions: MANAGE, values: [], deferUpdate: async () => log.push('d'), editReply: async (o) => log.push(o), followUp: async () => {} };
    await realSetupHandle(i, ['setup', 'advview']);
    assert.ok(assertMessage(log.at(-1)).customIds.has('setup:gateview'));
    for (const [view, marker] of [['gn', 'setup:gnchan'], ['mb', 'setup:mbchan'], ['ev', 'setup:evchan']]) {
      assert.ok(assertMessage(buildSetupView(cfg(), null, { view })).customIds.has(marker), view);
    }
    assert.ok(assertMessage(buildSetupView(cfg({ features: { gate: true } }), null, { view: 'gate' })).customIds.has('setup:gatetoggle'));
  });
});

// ---------- 📌 Đăng tất cả ----------

describe('📌 Đăng tất cả', () => {
  // A fake Discord: channels keep their messages; a deleted channel / message throws like the API (10003 / 10008).
  function world({ missing = [], noSend = [] } = {}) {
    const channels = new Map();
    let n = 0;
    const role = (id, extra = {}) => ({ id, name: id, managed: false, position: 1, permissions: { has: () => false }, ...extra });
    const guild = {
      id: G,
      name: 'Bang Thử',
      roles: { cache: new Map([['r-member', role('r-member')], ['r-high', role('r-high', { position: 10 })], ['r-managed', role('r-managed', { managed: true })]]), everyone: { id: G } },
      members: { me: { permissions: { has: () => true }, roles: { highest: { position: 10 } } } },
    };
    const channelOf = (id) => {
      if (!channels.has(id)) {
        const msgs = new Map();
        channels.set(id, {
          id,
          guild,
          msgs,
          sent: [],
          edited: [],
          send: async (p) => {
            if (noSend.includes(id)) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
            const m = { id: `m${++n}` };
            msgs.set(m.id, p);
            channels.get(id).sent.push(m.id);
            return m;
          },
          messages: {
            edit: async (mid, p) => {
              if (!msgs.has(mid)) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
              msgs.set(mid, p);
              channels.get(id).edited.push(mid);
            },
            delete: async (mid) => msgs.delete(mid),
          },
        });
      }
      return channels.get(id);
    };
    const client = {
      channels: {
        fetch: async (id) => {
          if (missing.includes(id)) throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
          return channelOf(id);
        },
      },
    };
    return { client, guild, channels, channelOf, sentTotal: () => [...channels.values()].reduce((a, c) => a + c.sent.length, 0), editedTotal: () => [...channels.values()].reduce((a, c) => a + c.edited.length, 0) };
  }
  const base = (patch = {}) => cfg({ announceChannelId: 'c-announce', adminChannelId: 'c-admin', features: ALL_ON, ...patch });
  const byKey = (results) => Object.fromEntries(results.map((r) => [r.key, r]));
  const run = async (w, config) => {
    store.set(G, config);
    return postAllPanels(w.client, store.get(G), w.guild);
  };

  it('default channels: dashboard -> admin; 🎮 -> announce; 📮 -> announce (inbox falls back to the admin channel); 🎉 -> admin; 🚪 skipped without a channel', async () => {
    const w = world();
    const r = byKey(await run(w, base()));
    assert.deepEqual(Object.keys(r), ['dashboard', 'gn', 'mailbox', 'events', 'gate']);
    assert.equal(r.dashboard.channelId, 'c-admin');
    assert.equal(r.gn.channelId, 'c-announce');
    assert.equal(r.mailbox.channelId, 'c-announce');
    assert.equal(r.events.channelId, 'c-admin');
    for (const k of ['dashboard', 'gn', 'mailbox', 'events']) assert.deepEqual([k, r[k].status, r[k].action], [k, 'ok', 'posted']);
    assert.equal(r.gate.status, 'skip');
    assert.match(r.gate.reason, /chưa chọn kênh welcome — vào ⚙️ Nâng cao → 🚪 Cổng vào/);
    const stored = store.get(G);
    assert.equal(stored.gnPanelChannelId, 'c-announce');
    assert.equal(stored.mailPanelChannelId, 'c-announce');
    assert.equal(stored.eventPanelChannelId, 'c-admin');
    assert.ok(!stored.gatePanelMessageId, 'no gate panel posted');
  });
  it('specific channels win over the defaults', async () => {
    const w = world();
    const r = byKey(await run(w, base({ gnChannelId: 'c-gn', mailChannelId: 'c-mail', mailInboxChannelId: 'c-inbox', eventAdminChannelId: 'c-evadm', eventChannelId: 'c-evcards' })));
    assert.deepEqual([r.gn.channelId, r.mailbox.channelId, r.events.channelId, r.dashboard.channelId], ['c-gn', 'c-mail', 'c-evadm', 'c-admin']);
  });
  it('📮 needs somewhere to read the letters: no inbox and no admin channel -> skipped; no channel at all -> skipped with a hint', async () => {
    const w = world();
    const r = byKey(await run(w, base({ adminChannelId: null, mailInboxChannelId: null })));
    assert.equal(r.mailbox.status, 'skip');
    assert.match(r.mailbox.reason, /kênh nhận thư/);
    assert.equal(r.dashboard.status, 'skip');
    assert.equal(r.events.status, 'skip');
    const none = byKey(await run(world(), base({ announceChannelId: null, adminChannelId: null })));
    assert.deepEqual(['dashboard', 'gn', 'mailbox', 'events'].map((k) => none[k].status), ['skip', 'skip', 'skip', 'skip']);
  });
  it('🚪: posted when the welcome channel is set AND the member role is set and manageable; no Khách / Chờ duyệt role is needed or looked at', async () => {
    const ok = byKey(await run(world(), base({ gateChannelId: 'c-gate', memberRoleId: 'r-member' })));
    assert.deepEqual([ok.gate.status, ok.gate.channelId], ['ok', 'c-gate']);
    const withLegacy = byKey(await run(world(), base({ gateChannelId: 'c-gate', memberRoleId: 'r-member', guestRoleId: 'r-deleted', pendingRoleId: 'r-high' })));
    assert.deepEqual([withLegacy.gate.status, withLegacy.gate.channelId], ['ok', 'c-gate'], 'the unused legacy fields are ignored');
    const noChannel = byKey(await run(world(), base({ memberRoleId: 'r-member' })));
    assert.equal(noChannel.gate.status, 'skip');
    assert.match(noChannel.gate.reason, /chưa chọn kênh welcome/);
    const noRole = byKey(await run(world(), base({ gateChannelId: 'c-gate' })));
    assert.equal(noRole.gate.status, 'skip');
    assert.match(noRole.gate.reason, /chưa chọn role thành viên/);
    const gone = byKey(await run(world(), base({ gateChannelId: 'c-gate', memberRoleId: 'r-deleted' })));
    assert.equal(gone.gate.status, 'skip');
    assert.match(gone.gate.reason, /role thành viên chưa hợp lệ \(role không còn trong server\)/);
    const high = byKey(await run(world(), base({ gateChannelId: 'c-gate', memberRoleId: 'r-high' })));
    assert.equal(high.gate.status, 'skip');
    assert.match(high.gate.reason, /role thành viên chưa hợp lệ \(role của bot đang nằm DƯỚI/);
    const managed = byKey(await run(world(), base({ gateChannelId: 'c-gate', memberRoleId: 'r-managed' })));
    assert.equal(managed.gate.status, 'skip');
    assert.equal(world().guild.roles.cache.get('r-member').managed, false);
  });
  it('only the enabled features are processed (the dashboard and 🎮 are core)', async () => {
    const w = world();
    const r = await run(w, base({ features: ALL_OFF }));
    assert.deepEqual(r.map((x) => x.key), ['dashboard', 'gn']);
    const some = await run(world(), base({ features: { ...ALL_OFF, events: true } }));
    assert.deepEqual(some.map((x) => x.key), ['dashboard', 'gn', 'events']);
  });
  it('a channel the bot cannot write to is an error line for that panel only; the others still go', async () => {
    const w = world({ noSend: ['c-announce'] });
    const r = byKey(await run(w, base()));
    assert.deepEqual([r.gn.status, r.mailbox.status, r.dashboard.status, r.events.status], ['error', 'error', 'ok', 'ok']);
    assert.match(r.gn.reason, /thiếu quyền/);
    const text = summaryLines(Object.values(r)).join('\n');
    assert.match(text, /❌ 🎮 Bảng liên kết tên: bot thiếu quyền ở kênh này <#c-announce>/);
    assert.match(text, /✅ 🏯 Bảng điều khiển: đã đăng ở <#c-admin>/);
  });
  it('the summary: ✅ posted / updated (channel), ⏭ skipped (reason), ❌ error', async () => {
    const w = world();
    const first = summaryLines(await run(w, base()));
    assert.equal(first[0], '**📌 Đăng tất cả**');
    assert.ok(first.includes('✅ 🏯 Bảng điều khiển: đã đăng ở <#c-admin>'));
    assert.ok(first.includes('✅ 🎮 Bảng liên kết tên: đã đăng ở <#c-announce>'));
    assert.ok(first.some((l) => l.startsWith('⏭ 🚪 Cổng vào: chưa chọn kênh welcome — vào ⚙️ Nâng cao → 🚪 Cổng vào')));
    const second = summaryLines(await postAllPanels(w.client, store.get(G), w.guild));
    assert.ok(second.includes('✅ 🏯 Bảng điều khiển: đã cập nhật ở <#c-admin>'));
  });
  it('idempotent: a second call EDITS the messages it posted - nothing new is sent, ids unchanged', async () => {
    const w = world();
    const first = await run(w, base({ gateChannelId: 'c-gate', memberRoleId: 'r-member' }));
    assert.ok(first.filter((r) => r.status === 'ok').every((r) => r.action === 'posted'));
    const sentAfterFirst = w.sentTotal();
    assert.equal(sentAfterFirst, 5);
    const ids = (c) => [c.panelMessageId, c.gnPanelMessageId, c.mailPanelMessageId, c.eventPanelMessageId, c.gatePanelMessageId];
    const idsBefore = ids(store.get(G));
    const second = await postAllPanels(w.client, store.get(G), w.guild);
    assert.ok(second.every((r) => r.status === 'ok' && r.action === 'edited'), JSON.stringify(second.map((r) => [r.key, r.action])));
    assert.equal(w.sentTotal(), sentAfterFirst, 'nothing duplicated');
    assert.equal(w.editedTotal(), 5);
    assert.deepEqual(ids(store.get(G)), idsBefore);
  });
  it('a panel somebody deleted is posted again by the next call', async () => {
    const w = world();
    await run(w, base());
    const gnChannel = w.channelOf('c-announce');
    gnChannel.msgs.delete(store.get(G).gnPanelMessageId);
    const again = byKey(await postAllPanels(w.client, store.get(G), w.guild));
    assert.equal(again.gn.action, 'posted');
    assert.equal(again.mailbox.action, 'edited');
  });

  describe('through the /setup handler', () => {
    const click = async (w) => {
      const log = [];
      const i = {
        customId: 'setup:postall',
        guild: w.guild,
        guildId: G,
        client: w.client,
        user: { id: 'a1' },
        member: { roles: [], permissions: MANAGE },
        memberPermissions: MANAGE,
        values: [],
        deferUpdate: async () => log.push(['deferUpdate']),
        editReply: async (o) => log.push(['editReply', o]),
        followUp: async (o) => log.push(['followUp', o]),
      };
      await realSetupHandle(i, ['setup', 'postall']);
      return log;
    };
    it('acknowledges first (deferUpdate), posts, then edits the main view with the summary under the health lines; logs setup.post_all', async () => {
      const w = world();
      store.set(G, base());
      const log = await click(w);
      assert.equal(log[0][0], 'deferUpdate');
      const view = log.filter((l) => l[0] === 'editReply').at(-1)[1];
      assert.match(view.content, /\*\*Cài đặt bot bang hội\*\*/);
      assert.match(view.content, /✅ 🏯 Bảng điều khiển: đã đăng ở <#c-admin>/);
      assert.match(view.content, /⏭ 🚪 Cổng vào/);
      assert.ok(view.content.length <= 2000);
      assert.equal(assertMessage(view).rows.length, 5);
      const [line] = logs('setup', 'post_all');
      assert.deepEqual(line.results.map((r) => [r.panel, r.status]), [['dashboard', 'ok'], ['gn', 'ok'], ['mailbox', 'ok'], ['events', 'ok'], ['gate', 'skip']]);
    });
    it('a second click edits the same messages: the summary says đã cập nhật and no new message is sent', async () => {
      const w = world();
      store.set(G, base());
      await click(w);
      const sent = w.sentTotal();
      const log = await click(w);
      assert.equal(w.sentTotal(), sent);
      assert.match(log.filter((l) => l[0] === 'editReply').at(-1)[1].content, /✅ 🏯 Bảng điều khiển: đã cập nhật ở <#c-admin>/);
    });
  });
});

// ---------- the old setup buttons keep working on messages posted earlier ----------

describe('older /setup messages', () => {
  it('setup:post (the former "Đăng / làm mới bảng điều khiển") and the sub-view buttons still answer', async () => {
    store.set(G, cfg({ announceChannelId: 'c-announce', adminChannelId: 'c-admin' }));
    const log = [];
    const i = { guild: { id: G }, guildId: G, client: { channels: { fetch: async () => ({ id: 'c-admin', guild: { id: G }, send: async () => ({ id: 'm1' }), messages: { edit: async () => {} } }) } }, user: { id: 'a' }, member: { roles: [], permissions: MANAGE }, memberPermissions: MANAGE, values: [], deferUpdate: async () => {}, editReply: async (o) => log.push(o), followUp: async () => {} };
    await realSetupHandle(i, ['setup', 'post']);
    assert.match(log.at(-1).content, /Đã đăng bảng điều khiển ở <#c-admin>/);
    for (const [part, marker] of [['gnview', 'setup:gnchan'], ['mbview', 'setup:mbchan'], ['evview', 'setup:evchan'], ['gateview', 'setup:gatechan']]) {
      await realSetupHandle(i, ['setup', part]);
      assert.ok(assertMessage(log.at(-1)).customIds.has(marker), part);
    }
  });
});

describe('features metadata', () => {
  it('every toggle has an emoji, a label and a short description; only the ones that need extra setup carry a note', () => {
    assert.equal(FEATURES.length, 7);
    assert.deepEqual(FEATURES.map((f) => f.key), FEATURE_KEYS);
    for (const f of FEATURES) assert.ok(f.emoji && f.label && f.desc && f.desc.length <= 100, f.key);
    assert.match(FEATURES.find((f) => f.key === 'gate').setup, /🚪 Cổng vào cần kênh welcome và role Thành viên: vào ⚙️ Nâng cao/);
    assert.equal(new Set(FEATURES.map((f) => f.emoji)).size, FEATURES.length, 'no two features share an emoji');
  });
});
