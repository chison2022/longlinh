// The guild-event channels (/setup -> 🎉 Sự kiện) and the persistent event management panel: the setup sub-view and its handler, the panel payload,
// post / edit / re-post, and the debounced refresh after create / answer / lock / done. DB and Discord are stubbed; the stubs on the services are
// installed BEFORE refresher / handlers / scheduler are required (they destructure at load time).
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionsBitField, PermissionFlagsBits } = require('discord.js');
const guildConfigService = require('../src/services/guildConfigService');
const eventService = require('../src/services/eventService');
const eventLog = require('../src/eventLog');
const defaults = require('../config/defaults');
const { vn, oid } = require('./helpers');
const { assertV2Message, assertMessage } = require('./discordLimits');

let config;
let updates; // patches passed to updateConfig
guildConfigService.getConfig = async () => config;
guildConfigService.getConfigOrDefault = async () => config;
guildConfigService.getOrCreateConfig = async () => config;
guildConfigService.updateConfig = async (_guildId, patch) => {
  updates.push(patch);
  config = { ...config, ...patch };
  return config;
};
const sheetSync = require('../src/bot/sheetSync');
sheetSync.scheduleSync = () => {};

const refresher = require('../src/bot/refresher');
const setupHandler = require('../src/bot/interactions/setup');
const { buildSetupView } = require('../src/bot/ui/panel');
const { buildEventPanel, EVENT_PANEL_COLOR, MAX_LISTED } = require('../src/bot/ui/eventPanel');
const { postOrUpdateEventPanel } = require('../src/bot/eventPanel');
const { eventsStep } = require('../src/jobs/scheduler');

const GUILD = '800000000000000001';
const MANAGE = new PermissionsBitField(PermissionFlagsBits.ManageGuild);
const NOBODY = new PermissionsBitField(PermissionFlagsBits.SendMessages);
const NOW = vn(2026, 10, 13, 10, 0);

const makeEvent = (n = 1, extra = {}) => ({
  _id: oid(n),
  guildId: GUILD,
  title: `Sự kiện ${n}`,
  category: 'other',
  startAt: vn(2026, 10, 17, 20),
  deadlineAt: vn(2026, 10, 17, 18),
  capacity: null,
  minParticipants: null,
  channelId: 'chan',
  messageId: `msg-${n}`,
  status: 'open',
  ...extra,
});
const flush = async () => {
  for (let n = 0; n < 12; n++) await new Promise((r) => setImmediate(r));
};

let sink;
beforeEach(() => {
  config = { ...guildConfigService.defaultConfig(GUILD), announceChannelId: 'war-chan', adminChannelId: 'adm-chan' };
  updates = [];
  sink = [];
  eventService.listManage = async () => [];
  eventService.countsFor = async () => new Map();
  eventLog.setSink((l) => sink.push(JSON.parse(l)));
  mock.method(console, 'error', () => {});
  mock.method(console, 'warn', () => {});
});
afterEach(() => {
  eventLog.setSink(null);
  refresher.cancelScheduled();
  mock.timers.reset();
  mock.restoreAll();
});

// ---------- /setup -> 🎉 Sự kiện ----------

describe('the /setup 🎉 Sự kiện sub-view', () => {
  const view = (cfg, ctx = {}) => buildSetupView(cfg, null, { view: 'ev', ...ctx });

  it('the main view has 📌 Đăng tất cả / 🧩 / ⚙️ (≤ 5 buttons); the 🎉 button lives in ⚙️ Nâng cao, only while the feature is on', () => {
    const main = buildSetupView(config);
    const last = main.components.at(-1).toJSON().components;
    assert.deepEqual(last.map((c) => c.custom_id), ['setup:postall', 'setup:featview', 'setup:advview']);
    assertMessage(main);
    const ids = (cfg) => buildSetupView(cfg, null, { view: 'adv' }).components[0].toJSON().components;
    const on = ids({ ...config, features: { events: true } });
    assert.equal(on.find((c) => c.custom_id === 'setup:evview').label, '🎉 Sự kiện');
    assert.ok(!ids({ ...config, features: { events: false } }).some((c) => c.custom_id === 'setup:evview'));
  });
  it('two channel selects + post (disabled without a resolvable channel) + back; passes the Discord limits', () => {
    const v = view({ ...config, adminChannelId: null });
    const { rows } = assertMessage(v);
    assert.deepEqual(rows.map((r) => r.components.map((c) => c.custom_id)), [['setup:evchan'], ['setup:evadmin'], ['setup:evpost', 'setup:evdoc', 'setup:main']]);
    assert.equal(rows[2].components[0].disabled, true, 'no event / admin channel to post the panel in');
    assert.equal(rows[2].components[0].label, '📌 Đăng / làm mới bảng quản lý sự kiện');
    assert.equal(rows[2].components[2].label, '↩ Quay lại');
    assert.deepEqual(v.allowedMentions, { parse: [] });
  });
  it('unset channels say they fall back to the war channels; the post button works through that fallback', () => {
    const v = view(config);
    assert.match(v.content, /✅ Kênh thông báo sự kiện \(mặc định: kênh thông báo bang chiến\): <#war-chan>/);
    assert.match(v.content, /✅ Kênh quản lý sự kiện \(mặc định: kênh admin\): <#adm-chan>/);
    assert.match(v.content, /Chưa đăng bảng quản lý/);
    assert.ok(!assertMessage(v).rows[2].components[0].disabled);
    const rows = assertMessage(v).rows;
    assert.ok(!rows[0].components[0].default_values && !rows[1].components[0].default_values, 'nothing preselected while unset');
  });
  it('chosen channels replace the fallback text and are preselected; a posted panel changes the status line', () => {
    const v = view({ ...config, eventChannelId: 'ev-chan', eventAdminChannelId: 'ev-adm', eventPanelMessageId: 'p1' });
    assert.match(v.content, /✅ Kênh thông báo sự kiện: <#ev-chan>/);
    assert.match(v.content, /✅ Kênh quản lý sự kiện: <#ev-adm>/);
    assert.ok(!/mặc định/.test(v.content));
    assert.match(v.content, /Bảng quản lý đã đăng/);
    const rows = assertMessage(v).rows;
    assert.deepEqual(rows[0].components[0].default_values.map((d) => d.id), ['ev-chan']);
    assert.deepEqual(rows[1].components[0].default_values.map((d) => d.id), ['ev-adm']);
  });
  it('nothing resolvable: both lines warn and the post button is off', () => {
    const v = view({ ...config, announceChannelId: null, adminChannelId: null });
    assert.match(v.content, /⚠️ Kênh thông báo sự kiện: _chưa chọn_/);
    assert.match(v.content, /⚠️ Kênh quản lý sự kiện: _chưa chọn_/);
    assert.equal(assertMessage(v).rows[2].components[0].disabled, true);
  });
  it('permission checks like the other views: a channel the bot cannot see / lacks rights in', () => {
    const guild = { channels: { cache: new Collection() }, members: { me: {} } };
    assert.match(view({ ...config, eventChannelId: 'ev-chan' }, { guild }).content, /⚠️ Kênh thông báo sự kiện: <#ev-chan> — bot không thấy kênh này/);
    const noSend = { permissionsFor: () => ({ has: (flag) => flag !== PermissionFlagsBits.SendMessages }) };
    guild.channels.cache.set('ev-adm', noSend);
    assert.match(view({ ...config, eventAdminChannelId: 'ev-adm' }, { guild }).content, /⚠️ Kênh quản lý sự kiện: <#ev-adm> — bot thiếu quyền: Gửi tin nhắn/);
  });
});

describe('the /setup handler for the event sub-view', () => {
  const sent = [];
  const edits = [];
  const clientOf = (channels = {}) => ({
    channels: {
      fetch: async (id) => {
        if (channels[id] instanceof Error) throw channels[id];
        return channels[id] || { id, send: async (p) => (sent.push([id, p]), { id: `new-${sent.length}` }), messages: { edit: async (mid, p) => edits.push([id, mid, p]), delete: async () => {} } };
      },
    },
  });
  const run = async (action, { values, member = { roles: [], permissions: MANAGE }, perms = MANAGE, channels } = {}) => {
    const log = [];
    const i = {
      guildId: GUILD,
      client: clientOf(channels),
      member,
      memberPermissions: perms,
      values,
      user: { id: '900' },
      deferUpdate: async () => {},
      editReply: async (o) => log.push(['editReply', o]),
      followUp: async (o) => log.push(['followUp', o]),
    };
    await setupHandler.handle(i, ['setup', action]);
    return log;
  };
  beforeEach(() => {
    sent.length = 0;
    edits.length = 0;
  });

  it('🎉 button opens the sub-view', async () => {
    const log = await run('evview');
    assert.match(log[0][1].content, /^\*\*🎉 Sự kiện\*\*/);
    assert.deepEqual(updates, []);
  });
  it('the selects save their ids, re-render the sub-view and log setup.channel_set', async () => {
    let log = await run('evchan', { values: ['ev-chan'] });
    assert.deepEqual(updates, [{ eventChannelId: 'ev-chan' }]);
    assert.match(log[0][1].content, /✅ Kênh thông báo sự kiện: <#ev-chan>/);
    log = await run('evadmin', { values: ['ev-adm'] });
    assert.deepEqual(updates.at(-1), { eventAdminChannelId: 'ev-adm' });
    assert.match(log[0][1].content, /✅ Kênh quản lý sự kiện: <#ev-adm>/);
    log = await run('evchan', { values: [] }); // cleared: back to the fallback
    assert.deepEqual(updates.at(-1), { eventChannelId: null });
    assert.match(log[0][1].content, /mặc định: kênh thông báo bang chiến/);
    const picks = sink.filter((l) => l.area === 'setup' && l.ev === 'channel_set').map((l) => [l.select, l.set]);
    assert.deepEqual(picks, [['evchan', true], ['evadmin', true], ['evchan', false]]);
  });
  it('📌 posts the panel in the management channel (event channel, else the admin channel), stores the ids, then edits it, logging each', async () => {
    let log = await run('evpost');
    assert.match(log[0][1].content, /✅ Đã đăng bảng quản lý sự kiện ở <#adm-chan>/);
    assert.deepEqual(sent.map((s) => s[0]), ['adm-chan']);
    assert.deepEqual(updates.at(-1), { eventPanelChannelId: 'adm-chan', eventPanelMessageId: 'new-1' });
    assert.match(log[0][1].content, /Bảng quản lý đã đăng/);
    log = await run('evpost');
    assert.match(log[0][1].content, /✅ Đã làm mới bảng quản lý sự kiện ở <#adm-chan>/);
    assert.equal(sent.length, 1, 'edited, not posted again');
    assert.deepEqual([edits[0][0], edits[0][1]], ['adm-chan', 'new-1']);
    assert.deepEqual(sink.filter((l) => l.ev === 'event_panel_posted').map((l) => [l.area, l.result, l.channel]), [['setup', 'posted', 'adm-chan'], ['setup', 'edited', 'adm-chan']]);
  });
  it('the event management channel wins over the admin channel', async () => {
    config.eventAdminChannelId = 'ev-adm';
    const log = await run('evpost');
    assert.match(log[0][1].content, /<#ev-adm>/);
    assert.deepEqual(sent.map((s) => s[0]), ['ev-adm']);
  });
  it('a deleted panel is posted again (new ids stored)', async () => {
    config = { ...config, eventPanelChannelId: 'adm-chan', eventPanelMessageId: 'old' };
    const channel = { id: 'adm-chan', send: async () => ({ id: 'fresh' }), messages: { edit: async () => { throw Object.assign(new Error('Unknown Message'), { code: 10008 }); } } };
    const log = await run('evpost', { channels: { 'adm-chan': channel } });
    assert.match(log[0][1].content, /✅ Đã đăng bảng quản lý sự kiện/);
    assert.deepEqual(updates.at(-1), { eventPanelChannelId: 'adm-chan', eventPanelMessageId: 'fresh' });
  });
  it('no channel to post in: a hint and nothing sent; a failing send says so and logs result "error"', async () => {
    config = { ...config, adminChannelId: null };
    let log = await run('evpost');
    assert.match(log[0][1].content, /Hãy chọn kênh quản lý sự kiện/);
    assert.deepEqual(sent, []);
    config = { ...config, adminChannelId: 'adm-chan' };
    log = await run('evpost', { channels: { 'adm-chan': new Error('Missing Access') } });
    assert.match(log[0][1].content, /❌ Không gửi được vào <#adm-chan>/);
    assert.equal(sink.find((l) => l.ev === 'event_panel_posted').result, 'error');
  });
  it('managers only: everything else is refused and writes nothing', async () => {
    const log = await run('evchan', { values: ['x'], member: { roles: [], permissions: NOBODY }, perms: NOBODY });
    assert.match(log[0][1].content, /không có quyền/);
    assert.deepEqual(updates, []);
  });
});

// ---------- the panel ----------

describe('buildEventPanel', () => {
  const countsOf = (events, c) => new Map(events.map((e) => [String(e._id), c]));

  it('empty state: heading, "Chưa có sự kiện nào sắp tới.", both buttons, the managers-only footer', () => {
    const v2 = assertV2Message(buildEventPanel());
    assert.match(v2.text, /### 📅 Quản lý sự kiện/);
    assert.match(v2.text, /Chưa có sự kiện nào sắp tới\./);
    assert.match(v2.text, /-# Chỉ quản lý dùng được các nút này\./);
    assert.deepEqual(v2.buttons.map((b) => [b.custom_id, b.label]), [['ev:pnew', '➕ Tạo sự kiện'], ['ev:pmanage', '📋 Quản lý…']]);
    assert.ok(!v2.buttons.some((b) => b.disabled));
  });
  it('one line per event: emoji, linked title, start, status, ✅ n/max; no shortfall marker without a minimum / when reached', () => {
    const events = [makeEvent(1, { category: 'pvp', capacity: 20 }), makeEvent(2, { status: 'locked', minParticipants: 5 })];
    const v2 = assertV2Message(buildEventPanel({ events, counts: countsOf(events, { yes: 7, maybe: 2, no: 1 }) }));
    const lines = v2.text.split('\n').filter((l) => l.startsWith('• '));
    assert.equal(lines.length, 2);
    assert.ok(lines[0].startsWith('• ⚔️ [Sự kiện 1](https://discord.com/channels/'));
    assert.ok(lines[0].includes('<t:') && lines[0].includes('🟢 Đang mở') && lines[0].endsWith('✅ 7/20'));
    assert.ok(lines[1].includes('🔒 Đã chốt') && lines[1].endsWith('✅ 7'));
    assert.ok(!/⚠️/.test(v2.text));
  });
  it('a minimum not reached shows "⚠️ cần <min>"; reached or no minimum does not', () => {
    const short = makeEvent(1, { minParticipants: 15 });
    assert.match(assertV2Message(buildEventPanel({ events: [short], counts: countsOf([short], { yes: 12, maybe: 0, no: 0 }) })).text, /✅ 12 · ⚠️ cần 15/);
    assert.ok(!/⚠️/.test(assertV2Message(buildEventPanel({ events: [short], counts: countsOf([short], { yes: 15, maybe: 0, no: 0 }) })).text));
    assert.ok(!/⚠️/.test(assertV2Message(buildEventPanel({ events: [makeEvent(1)], counts: new Map() })).text), 'no counts known: a plain ✅ 0');
  });
  it(`lists at most ${MAX_LISTED}, then "… và K sự kiện nữa"`, () => {
    const events = Array.from({ length: 13 }, (_, n) => makeEvent(n + 1, { title: 'T'.repeat(100) }));
    const v2 = assertV2Message(buildEventPanel({ events, counts: countsOf(events, { yes: 1, maybe: 0, no: 0 }) }));
    assert.equal(v2.text.split('\n').filter((l) => l.startsWith('• ')).length, 10);
    assert.match(v2.text, /… và 3 sự kiện nữa/);
    const exactly = buildEventPanel({ events: events.slice(0, 10) });
    assert.ok(!/và \d+ sự kiện nữa/.test(assertV2Message(exactly).text));
  });
  it('no mention can ping: a nasty title is defanged and nothing is allowed', () => {
    const events = [makeEvent(1, { title: '@everyone @here <@999> <@&888> [x](http://e.x)' })];
    const payload = buildEventPanel({ events });
    const text = assertV2Message(payload).text;
    assert.ok(!/@everyone|@here/.test(text) && !/<@[!&]?\d/.test(text) && !/\]\(http:\/\/e\.x/.test(text) && text.includes('discord.com/channels/'), 'only the link to the own card');
    assert.deepEqual(payload.allowedMentions, { parse: [] });
  });
  it('its own accent colour, not the war purple', () => {
    const container = buildEventPanel().components[0].toJSON();
    assert.equal(container.accent_color, EVENT_PANEL_COLOR);
    assert.notEqual(EVENT_PANEL_COLOR, 0x9b59b6);
  });
});

describe('postOrUpdateEventPanel', () => {
  const channel = (id, { editFails = false } = {}) => ({
    id,
    ops: [],
    send: async function (p) {
      this.ops.push(['send', p]);
      return { id: `m-${id}` };
    },
    messages: {
      edit: async (mid) => {
        if (editFails) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
        channels.ops.push(['edit', id, mid]);
      },
      delete: async (mid) => channels.ops.push(['delete', id, mid]),
    },
  });
  const channels = { ops: [] };
  const client = (map) => ({ channels: { fetch: async (id) => map[id] } });
  beforeEach(() => {
    channels.ops = [];
    eventService.listManage = async () => [makeEvent(1)];
    eventService.countsFor = async () => new Map([[String(oid(1)), { yes: 3, maybe: 0, no: 0 }]]);
  });

  it('posts once and stores the ids; carries the live list; sent as a V2 create (no content / embeds)', async () => {
    const a = channel('a');
    const res = await postOrUpdateEventPanel(client({ a }), { guildId: GUILD, adminChannelId: 'a' });
    assert.deepEqual(res, { action: 'posted', channelId: 'a', messageId: 'm-a' });
    assert.deepEqual(updates, [{ eventPanelChannelId: 'a', eventPanelMessageId: 'm-a' }]);
    const payload = a.ops[0][1];
    assert.ok(!('content' in payload) && !('embeds' in payload));
    assert.match(assertV2Message(payload, { forCreate: true }).text, /Sự kiện 1.*✅ 3/);
  });
  it('edits in place when the stored message is in that channel; the event admin channel wins over the admin channel', async () => {
    const res = await postOrUpdateEventPanel(client({ b: channel('b') }), { guildId: GUILD, adminChannelId: 'a', eventAdminChannelId: 'b', eventPanelChannelId: 'b', eventPanelMessageId: 'old' });
    assert.deepEqual(res, { action: 'edited', channelId: 'b', messageId: 'old' });
    assert.deepEqual(channels.ops, [['edit', 'b', 'old']]);
    assert.deepEqual(updates, []);
  });
  it('re-posts when the message was deleted (Unknown Message / Unknown Channel code)', async () => {
    const a = channel('a', { editFails: true });
    const res = await postOrUpdateEventPanel(client({ a }), { guildId: GUILD, adminChannelId: 'a', eventPanelChannelId: 'a', eventPanelMessageId: 'gone' });
    assert.equal(res.action, 'posted');
    assert.deepEqual(updates, [{ eventPanelChannelId: 'a', eventPanelMessageId: 'm-a' }]);
  });
  it('another edit error is thrown (nothing posted); a channel change posts the new one and deletes the old', async () => {
    const boom = { id: 'a', send: async () => { throw new Error('x'); }, messages: { edit: async () => { throw Object.assign(new Error('Missing Access'), { code: 50001 }); } } };
    await assert.rejects(postOrUpdateEventPanel(client({ a: boom }), { guildId: GUILD, adminChannelId: 'a', eventPanelChannelId: 'a', eventPanelMessageId: 'm' }), /Missing Access/);
    const b = channel('b');
    const res = await postOrUpdateEventPanel(client({ a: channel('a'), b }), { guildId: GUILD, adminChannelId: 'b', eventPanelChannelId: 'a', eventPanelMessageId: 'old' });
    assert.equal(res.action, 'posted');
    assert.deepEqual(channels.ops, [['delete', 'a', 'old']]);
  });
});

// ---------- the refresh ----------

describe('the panel follows the events (debounced, serialized)', () => {
  let edits;
  let event;
  let cardEdits;
  let client;
  beforeEach(() => {
    edits = [];
    cardEdits = [];
    event = makeEvent(1);
    config = { ...config, eventPanelChannelId: 'adm-chan', eventPanelMessageId: 'panel-1' };
    const channel = {
      id: 'adm-chan',
      send: async () => ({ id: 'sent-1' }),
      messages: {
        edit: async (mid, p) => (mid === 'panel-1' ? edits.push(p) : cardEdits.push([mid, p])),
        delete: async () => {},
      },
    };
    client = { channels: { fetch: async () => channel } };
    eventService.getEvent = async () => event;
    eventService.countsOf = async () => ({ yes: 4, maybe: 0, no: 0 });
    eventService.listManage = async () => [event];
    eventService.countsFor = async () => new Map([[String(event._id), { yes: 4, maybe: 0, no: 0 }]]);
    eventService.setMessage = async () => {};
    mock.timers.enable({ apis: ['setTimeout'] });
  });
  const settle = async () => {
    await flush();
    mock.timers.tick(defaults.refreshDebounceMs);
    await flush();
  };

  it('a card refresh (create / edit / lock / cancel / extend all end in one) redraws the panel after the debounce', async () => {
    await refresher.refreshEventCardNow(client, event._id);
    assert.equal(cardEdits.length, 1);
    assert.equal(edits.length, 0, 'not at once');
    await settle();
    assert.equal(edits.length, 1);
    assert.match(assertV2Message(edits[0]).text, /Sự kiện 1.*✅ 4/);
  });
  it('an answer: the debounced card refresh then the panel refresh (the ✅ count on the panel moves)', async () => {
    refresher.scheduleEventRefresh(client, event._id);
    mock.timers.tick(defaults.refreshDebounceMs); // the card
    await flush();
    assert.equal(cardEdits.length, 1);
    await settle(); // the panel
    assert.equal(edits.length, 1);
  });
  it('posting a new card puts the event on the panel', async () => {
    await refresher.postEventCard(client, 'ev-chan', event);
    await settle();
    assert.equal(edits.length, 1);
  });
  it('the scheduler\'s auto lock and auto done redraw it too', async () => {
    eventService.findDueLocks = async () => [event];
    eventService.findDueReminders = async () => [];
    eventService.findDueMinNotices = async () => [];
    eventService.findFinished = async () => [];
    eventService.lockEvent = async () => ({ ...event, status: 'locked' });
    await eventsStep(client, NOW);
    mock.timers.tick(0);
    await flush();
    event = { ...event, status: 'locked' };
    await settle();
    assert.equal(edits.length, 1);
    assert.match(assertV2Message(edits[0]).text, /🔒 Đã chốt/);
    eventService.findDueLocks = async () => [];
    eventService.findFinished = async () => [event];
    eventService.markDone = async () => ({ ...event, status: 'done' });
    event = { ...event, status: 'done' };
    eventService.listManage = async () => [];
    await eventsStep(client, NOW);
    mock.timers.tick(0);
    await flush();
    await settle();
    assert.equal(edits.length, 2);
    assert.match(assertV2Message(edits[1]).text, /Chưa có sự kiện nào sắp tới/);
  });
  it('L6: a deleted card (Unknown Message) forgets its id and is logged ONCE; later refreshes do not touch Discord', async () => {
    const cleared = [];
    let tries = 0;
    event = { ...event, channelId: 'ev-chan', messageId: 'card-1' };
    eventService.clearMessage = async (id, mid) => {
      cleared.push([String(id), mid]);
      event = { ...event, messageId: null };
    };
    const gone = { id: 'ev-chan', messages: { edit: async () => { tries++; throw Object.assign(new Error('Unknown Message'), { code: 10008 }); } } };
    client = { channels: { fetch: async () => gone } };
    await refresher.refreshEventCardNow(client, event._id);
    await refresher.refreshEventCardNow(client, event._id);
    await refresher.refreshEventCardNow(client, event._id);
    assert.equal(tries, 1, 'the next refreshes have no message to edit');
    assert.deepEqual(cleared, [[String(event._id), 'card-1']]);
    assert.equal(sink.filter((l) => l.area === 'refresh' && l.ev === 'card_gone').length, 1);
    assert.ok(!sink.some((l) => l.area === 'refresh' && l.kind === 'event_card'), 'not logged as a failure');
  });
  it('a burst of changes is one edit; the next burst another', async () => {
    for (let n = 0; n < 5; n++) await refresher.refreshEventCardNow(client, event._id);
    await settle();
    assert.equal(edits.length, 1);
    await refresher.refreshEventCardNow(client, event._id);
    await settle();
    assert.equal(edits.length, 2);
  });
  it('a refresh asked while one is running repeats once with fresh state (serialized, never two edits in parallel)', async () => {
    let running = 0;
    let maxRunning = 0;
    const seen = [];
    const slow = {
      id: 'adm-chan',
      messages: {
        edit: async (_mid, p) => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          await new Promise((r) => setImmediate(r));
          seen.push(assertV2Message(p).text);
          running--;
        },
      },
    };
    client = { channels: { fetch: async () => slow } };
    const first = refresher.refreshEventPanelNow(client, GUILD);
    await flush();
    event = makeEvent(1, { title: 'Đổi tên' });
    eventService.listManage = async () => [event];
    const second = refresher.refreshEventPanelNow(client, GUILD);
    await Promise.all([first, second]);
    assert.equal(maxRunning, 1);
    assert.ok(seen.length >= 1 && /Đổi tên/.test(seen.at(-1)), 'the last run read fresh state');
  });
  it('no stored panel: nothing is fetched or edited', async () => {
    config = { ...config, eventPanelChannelId: null, eventPanelMessageId: null };
    await refresher.refreshEventPanelNow(client, GUILD);
    assert.equal(edits.length, 0);
  });
  it('a deleted panel is forgotten silently (no repost); another failure is only logged', async () => {
    client = { channels: { fetch: async () => ({ messages: { edit: async () => { throw Object.assign(new Error('Unknown Message'), { code: 10008 }); } } }) } };
    await refresher.refreshEventPanelNow(client, GUILD);
    assert.deepEqual(updates, [{ eventPanelChannelId: null, eventPanelMessageId: null }]);
    config = { ...config, eventPanelChannelId: 'adm-chan', eventPanelMessageId: 'panel-1' };
    updates.length = 0;
    client = { channels: { fetch: async () => ({ messages: { edit: async () => { throw new Error('boom'); } } }) } };
    await refresher.refreshEventPanelNow(client, GUILD);
    assert.deepEqual(updates, []);
    assert.ok(sink.some((l) => l.area === 'refresh' && l.kind === 'event_panel'));
  });
});
