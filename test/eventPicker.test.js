// The date / time picker of the event form (ev:pk / ev:pkok / ev:pkcancel): rendering, select changes, invalid combinations, create (-> preview ->
// post) and edit through the picker, expiry, the admin gate and the old modal with a typed time. Discord access and the DB are stubbed like in
// events.test.js (stubs go in BEFORE the handler is required: it destructures them).
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits, ModalSubmitFields, ComponentType } = require('discord.js');
const { vn, oid, sid } = require('./helpers');
const { assertV2Message } = require('./discordLimits');

const guildConfigService = require('../src/services/guildConfigService');
const refresher = require('../src/bot/refresher');
const sheetSync = require('../src/bot/sheetSync');
const eventDocSync = require('../src/bot/eventDocSync');
const eventLog = require('../src/eventLog');

let config;
guildConfigService.getConfigOrDefault = async () => config;
guildConfigService.getConfig = async () => config;
refresher.scheduleEventRefresh = () => {};
refresher.refreshEventCardNow = async () => {};
const postCalls = [];
refresher.postEventCard = async (client, channelId, event, opts) => (postCalls.push({ channelId, event, opts }), { ...event, channelId, messageId: 'msg-1' });
sheetSync.scheduleSync = () => {};
eventDocSync.scheduleDocSync = () => {};

const eventService = require('../src/services/eventService');
const events = require('../src/bot/interactions/events');
const { buildEventPicker } = require('../src/bot/ui/eventPicker');

const GUILD = '800000000000000001';
const EID = oid(7);
const ADMIN = sid(900);
const MEMBER = sid(901);
const MANAGE = new PermissionsBitField(PermissionFlagsBits.ManageGuild);
const NOBODY = new PermissionsBitField(PermissionFlagsBits.SendMessages);
const NOW = vn(2026, 10, 28, 10, 0); // Wednesday 28/10 (T4), 10:00 Vietnam time

const modalFields = (values) => {
  const all = { title: '', category: 'other', description: '', people: '', ...values };
  return new ModalSubmitFields(
    Object.entries(all).map(([id, v], n) => ({
      type: ComponentType.Label,
      id: n + 1,
      component: id === 'category' ? { type: ComponentType.StringSelect, id: 100 + n, customId: id, values: [v] } : { type: ComponentType.TextInput, id: 100 + n, customId: id, value: v },
    }))
  );
};

const makeEvent = (extra = {}) => ({
  _id: EID,
  guildId: GUILD,
  title: 'Tiệc bang',
  category: 'other',
  description: 'Gặp mặt cuối tuần',
  startAt: vn(2026, 10, 31, 20),
  endAt: vn(2026, 10, 31, 22),
  deadlineAt: vn(2026, 10, 31, 19),
  capacity: 32,
  minParticipants: 15,
  allowMaybe: true,
  remindBeforeMinutes: 60,
  channelId: 'chan',
  messageId: 'msg-1',
  status: 'open',
  remindedAt: null,
  ...extra,
});

let ev;
let calls;
let sink;

function interaction(extra = {}) {
  const log = [];
  const i = {
    guildId: GUILD,
    user: { id: ADMIN, username: 'u' },
    member: { roles: [], permissions: MANAGE, displayName: 'Quản lý' },
    memberPermissions: MANAGE,
    client: { channels: { fetch: async () => ({ id: 'chan', send: async () => {} }) } },
    deferReply: async () => log.push(['deferReply']),
    deferUpdate: async () => log.push(['deferUpdate']),
    editReply: async (o) => log.push(['editReply', o]),
    reply: async (o) => log.push(['reply', o]),
    followUp: async (o) => log.push(['followUp', o]),
    showModal: async (m) => log.push(['showModal', m]),
    ...extra,
  };
  return { i, log };
}
const memberIx = (extra = {}) => interaction({ user: { id: MEMBER, username: 'm' }, member: { roles: [], permissions: NOBODY, displayName: 'An' }, memberPermissions: NOBODY, ...extra });
const lastEdit = (log) => log.filter((l) => l[0] === 'editReply').pop()[1];
const textOf = (log) => assertV2Message(lastEdit(log)).text;

// Walks the V2 payload for the select menus: custom_id -> { placeholder, options }.
function selectsOf(payload) {
  const found = {};
  const walk = (c) => {
    if (c.type === 3 && c.custom_id.startsWith('ev:pk:')) found[c.custom_id] = c;
    for (const child of c.components || []) walk(child);
  };
  (payload.components || []).map((c) => (c.toJSON ? c.toJSON() : c)).forEach(walk);
  return found;
}
const selected = (select) => select.options.filter((o) => o.default).map((o) => o.value);
const selectOf = (log, field) => {
  const all = selectsOf(lastEdit(log));
  const id = Object.keys(all).find((k) => k.endsWith(`:${field}`));
  return all[id];
};
const pickerIdOf = (r) => Object.keys(selectsOf(lastEdit(r.log)))[0].split(':')[2];

// The create form submitted (no time field): the picker comes back.
async function openPicker(values = {}, extra = {}) {
  const r = interaction({ fields: modalFields({ title: 'Giải Solo', category: 'pvp', description: 'Thể lệ', people: '15-32', ...values }), ...extra });
  await events.handle(r.i, ['ev', 'newModal']);
  return r;
}
const choose = async (id, field, value, extra = {}) => {
  const r = interaction({ values: [value], ...extra });
  await events.handle(r.i, ['ev', 'pk', id, field]);
  return r;
};
const press = async (action, id, extra = {}) => {
  const r = interaction(extra);
  await events.handle(r.i, ['ev', action, id]);
  return r;
};
const buttonOf = (log, prefix) => assertV2Message(lastEdit(log)).buttons.find((b) => b.custom_id.startsWith(prefix));

beforeEach(() => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  config = { ...guildConfigService.defaultConfig(GUILD), announceChannelId: 'announce', features: { events: true } };
  ev = makeEvent();
  calls = [];
  postCalls.length = 0;
  sink = [];
  eventLog.setSink((l) => sink.push(l));
  mock.method(console, 'error', () => {});
  mock.method(console, 'warn', () => {});
  eventService.getEvent = async (id) => (ev && String(ev._id) === String(id) ? ev : null);
  eventService.listManage = async () => [ev].filter(Boolean);
  eventService.countsFor = async (ids) => new Map(ids.map((id) => [String(id), { yes: 0, maybe: 0, no: 0 }]));
  eventService.countsOf = async () => ({ yes: 0, maybe: 0, no: 0 });
  eventService.createEvent = async (data) => (calls.push(['createEvent', data]), { ...makeEvent(), ...data, _id: oid(50) });
  eventService.updateEvent = async (id, patch, opts) => (calls.push(['updateEvent', patch, opts]), { ...ev, ...patch });
  eventService.deleteEvent = async () => {};
});
afterEach(() => {
  mock.timers.reset();
  eventLog.setSink(null);
  mock.restoreAll();
});

describe('picker rendering (create)', () => {
  it('the modal submit answers with the picker only: nothing is created, the how-to opens the message', async () => {
    const r = await openPicker();
    assert.deepEqual(r.log.map((l) => l[0]), ['deferReply', 'editReply']);
    const v2 = assertV2Message(lastEdit(r.log));
    assert.ok(v2.count <= 40);
    assert.ok(v2.texts[0].startsWith('### 📅 Chọn thời gian cho sự kiện **Giải Solo**\n1. Chọn **ngày**, **giờ** và **phút** bắt đầu.\n2. Chọn sự kiện **kéo dài** bao lâu.\n3. Chọn **hạn đăng ký** (mặc định: đến lúc bắt đầu).'));
    assert.match(v2.texts[0], /Dòng → bên dưới cập nhật ngay sau mỗi lần chọn\. Kiểm tra lại rồi bấm \*\*✅ Tạo sự kiện\*\*\.\n-# Giờ Việt Nam\. Bấm ↩ Huỷ để bỏ\./);
    assert.deepEqual(calls, []);
    assert.deepEqual(postCalls, []);
  });
  it('five selects with placeholders; days start today (Hôm nay / Ngày mai), 25 of them; hours, minutes, durations, deadlines as asked', async () => {
    const r = await openPicker();
    const day = selectOf(r.log, 'day');
    assert.equal(day.placeholder, 'Chọn ngày diễn ra…');
    assert.equal(day.options.length, 25);
    assert.deepEqual(day.options.slice(0, 4).map((o) => o.label), ['Hôm nay · T4 28/10', 'Ngày mai · T5 29/10', 'T6 30/10', 'T7 31/10']);
    assert.equal(day.options[24].label, 'T7 21/11');
    assert.equal(selectOf(r.log, 'hour').placeholder, 'Chọn giờ bắt đầu…');
    const hours = selectOf(r.log, 'hour').options;
    assert.deepEqual([hours.length, hours[0].label, hours[23].label], [24, '00:00', '23:00']);
    assert.deepEqual(selectOf(r.log, 'min').options.map((o) => o.label), [':00', ':15', ':30', ':45']);
    assert.deepEqual(selectOf(r.log, 'dur').options.map((o) => o.label), ['30 phút', '1 tiếng', '1 tiếng 30', '2 tiếng', '3 tiếng', '4 tiếng', 'Cả ngày (đến 23:59)', 'Không ghi giờ kết thúc']);
    assert.deepEqual(selectOf(r.log, 'dl').options.map((o) => o.label), ['Lúc bắt đầu', 'Trước 30 phút', 'Trước 1 tiếng', 'Trước 3 tiếng', 'Trước 1 ngày', '22:00 hôm trước']);
    for (const f of ['min', 'dur', 'dl']) assert.ok(selectOf(r.log, f).placeholder.endsWith('…'), f);
  });
  it('defaults: tomorrow 20:00 :00, 2 tiếng, lúc bắt đầu; the summary says so; ✅ is on', async () => {
    const r = await openPicker();
    assert.deepEqual(selected(selectOf(r.log, 'day')), ['2026-10-29']);
    assert.deepEqual(selected(selectOf(r.log, 'hour')), ['20']);
    assert.deepEqual(selected(selectOf(r.log, 'min')), ['0']);
    assert.deepEqual(selected(selectOf(r.log, 'dur')), ['120']);
    assert.deepEqual(selected(selectOf(r.log, 'dl')), ['start']);
    assert.match(textOf(r.log), /→ T5 29\/10 20:00 – 22:00 · hạn đăng ký 20:00 \(còn 1 ngày 10 giờ\)/);
    const ok = buttonOf(r.log, 'ev:pkok:');
    assert.deepEqual([ok.label, ok.disabled], ['✅ Tạo sự kiện', false]);
    assert.equal(buttonOf(r.log, 'ev:pkcancel:').label, '↩ Huỷ');
  });
  it('the pnew panel variant gets the same picker as a new ephemeral reply; a message-bound submit edits that message', async () => {
    const r = interaction({ fields: modalFields({ title: 'T' }) });
    await events.handle(r.i, ['ev', 'pnewModal']);
    assert.deepEqual(r.log.map((l) => l[0]), ['deferReply', 'editReply']);
    assert.ok(selectOf(r.log, 'day'));
    const m = interaction({ fields: modalFields({ title: 'T' }), isFromMessage: () => true });
    await events.handle(m.i, ['ev', 'newModal']);
    assert.deepEqual(m.log.map((l) => l[0]), ['deferUpdate', 'editReply']);
  });
  it('bad texts (empty title, bad people) never reach the picker; no event channel points to /setup', async () => {
    for (const [values, text] of [[{ title: '  ' }, /Tên sự kiện/], [{ people: 'nhiều' }, /Số người/], [{ people: '20-10' }, /không được lớn hơn/]]) {
      const r = await openPicker(values);
      assert.match(JSON.stringify(lastEdit(r.log)), text);
      assert.deepEqual(selectsOf(lastEdit(r.log)), {});
    }
    config.announceChannelId = null;
    const r = await openPicker();
    assert.match(JSON.stringify(lastEdit(r.log)), /\/setup/);
    assert.deepEqual(selectsOf(lastEdit(r.log)), {});
  });
  it('a title with markdown / brackets cannot break the how-to heading; the payload fits Discord limits for the longest title', async () => {
    const r = await openPicker({ title: '**x** [a](http://b) ' + 'T'.repeat(70) });
    assert.ok(!/\[a\]/.test(textOf(r.log)));
    assert.match(textOf(r.log), /^### 📅 Chọn thời gian/);
  });
});

describe('select changes', () => {
  it('each change redraws the same message with the new summary; the other selections stay', async () => {
    const id = pickerIdOf(await openPicker());
    let r = await choose(id, 'day', '2026-10-31');
    assert.deepEqual(r.log.map((l) => l[0]), ['deferUpdate', 'editReply']);
    r = await choose(id, 'min', '30');
    r = await choose(id, 'dl', 'h1');
    assert.match(textOf(r.log), /→ T7 31\/10 20:30 – 22:30 · hạn đăng ký 19:30 \(còn 3 ngày 9 giờ\)/);
    assert.deepEqual(selected(selectOf(r.log, 'day')), ['2026-10-31']);
    assert.deepEqual(selected(selectOf(r.log, 'hour')), ['20']);
    assert.deepEqual(selected(selectOf(r.log, 'min')), ['30']);
    assert.deepEqual(selected(selectOf(r.log, 'dl')), ['h1']);
    assert.equal(buttonOf(r.log, 'ev:pkok:').disabled, false);
  });
  it('the summary: end after midnight shows its day, "cả ngày" ends 23:59, "không ghi giờ kết thúc", a deadline on another day names it', async () => {
    const id = pickerIdOf(await openPicker());
    await choose(id, 'hour', '23');
    let r = await choose(id, 'dur', '120');
    assert.match(textOf(r.log), /→ T5 29\/10 23:00 – 01:00 \(T6 30\/10\) · hạn đăng ký 23:00/);
    r = await choose(id, 'dur', 'day');
    assert.match(textOf(r.log), /23:00 – 23:59 · hạn/);
    r = await choose(id, 'dur', 'none');
    assert.match(textOf(r.log), /→ T5 29\/10 23:00 \(không ghi giờ kết thúc\) · hạn/);
    r = await choose(id, 'dl', 'prev22');
    assert.match(textOf(r.log), /hạn đăng ký T4 28\/10 22:00 \(còn 12 giờ\)/);
    r = await choose(id, 'dl', 'd1');
    assert.match(textOf(r.log), /hạn đăng ký T4 28\/10 23:00 \(còn 13 giờ\)/);
  });
  it('the spec example: "→ T7 31/10 20:30 – 22:30 · hạn đăng ký 19:30 (còn 2 ngày 3 giờ)"', () => {
    const times = eventService.pickTimes({ day: '2026-10-31', hour: 20, min: 30, dur: '120', dl: 'h1' });
    assert.equal(eventService.pickSummary(times, vn(2026, 10, 29, 16, 30)), '→ T7 31/10 20:30 – 22:30 · hạn đăng ký 19:30 (còn 2 ngày 3 giờ)');
  });
  it('a forged value is ignored (the picker is redrawn unchanged)', async () => {
    const id = pickerIdOf(await openPicker());
    for (const [field, value] of [['hour', '24'], ['min', '7'], ['dur', '999'], ['dl', 'x'], ['day', '2027-01-01'], ['day', '2026-02-31'], ['nope', '1']]) {
      const r = await choose(id, field, value);
      assert.deepEqual(selected(selectOf(r.log, 'hour')), ['20'], `${field}=${value}`);
      assert.deepEqual(selected(selectOf(r.log, 'day')), ['2026-10-29']);
    }
  });
});

describe('invalid combinations', () => {
  it('a start in the past (today 08:00) shows ⚠️ and turns ✅ off; fixing it turns ✅ on again', async () => {
    const id = pickerIdOf(await openPicker());
    await choose(id, 'day', '2026-10-28');
    let r = await choose(id, 'hour', '8');
    assert.match(textOf(r.log), /⚠️ Giờ bắt đầu đã qua/);
    assert.equal(buttonOf(r.log, 'ev:pkok:').disabled, true);
    r = await choose(id, 'hour', '21');
    assert.ok(!/⚠️/.test(textOf(r.log)));
    assert.equal(buttonOf(r.log, 'ev:pkok:').disabled, false);
  });
  it('a deadline already past (start 11:00 today, 3 hours before) shows ⚠️ and turns ✅ off', async () => {
    const id = pickerIdOf(await openPicker());
    await choose(id, 'day', '2026-10-28');
    await choose(id, 'hour', '11');
    const r = await choose(id, 'dl', 'h3');
    assert.match(textOf(r.log), /⚠️ Hạn đăng ký đã qua/);
    assert.equal(buttonOf(r.log, 'ev:pkok:').disabled, true);
  });
  it('a forced ✅ on an invalid picker creates nothing and redraws the picker with the warning', async () => {
    const id = pickerIdOf(await openPicker());
    await choose(id, 'day', '2026-10-28');
    await choose(id, 'hour', '8');
    const r = await press('pkok', id);
    assert.match(textOf(r.log), /⚠️ Giờ bắt đầu đã qua/);
    assert.deepEqual(calls, []);
    assert.ok(!sink.some((l) => /created/.test(l)));
  });
});

describe('✅ Tạo sự kiện', () => {
  it('goes to the usual preview with the picked start / end / deadline (Vietnam time); 📢 Đăng then creates with the same call as before', async () => {
    const id = pickerIdOf(await openPicker());
    await choose(id, 'day', '2026-10-31');
    await choose(id, 'min', '30');
    await choose(id, 'dl', 'prev22');
    const r = await press('pkok', id);
    assert.deepEqual(r.log.map((l) => l[0]), ['deferUpdate', 'editReply']);
    const v2 = assertV2Message(lastEdit(r.log));
    assert.match(v2.text, /Xem trước · chưa đăng/);
    assert.deepEqual(calls, [], 'the preview creates nothing');
    const draft = v2.buttons.find((b) => b.custom_id.startsWith('ev:drpost:')).custom_id.split(':')[2];
    const post = await press('drpost', draft);
    const [, data] = calls.find((c) => c[0] === 'createEvent');
    assert.deepEqual(data.startAt, vn(2026, 10, 31, 20, 30));
    assert.deepEqual(data.endAt, vn(2026, 10, 31, 22, 30));
    assert.deepEqual(data.deadlineAt, vn(2026, 10, 30, 22, 0));
    assert.deepEqual([data.title, data.category, data.description, data.capacity, data.minParticipants, data.createdBy], ['Giải Solo', 'pvp', 'Thể lệ', 32, 15, ADMIN]);
    assert.match(JSON.stringify(lastEdit(post.log)), /Đã tạo \*\*Giải Solo\*\*/);
    assert.equal(postCalls.length, 1);
  });
  it('end of day, no end time and a one-day deadline map to the right dates', async () => {
    for (const [dur, dl, end, deadline] of [
      ['day', 'd1', vn(2026, 10, 30, 23, 59), vn(2026, 10, 29, 20, 0)],
      ['none', 'm30', null, vn(2026, 10, 30, 19, 30)],
      ['30', 'h3', vn(2026, 10, 30, 20, 30), vn(2026, 10, 30, 17, 0)],
    ]) {
      calls.length = 0;
      const id = pickerIdOf(await openPicker());
      await choose(id, 'day', '2026-10-30');
      await choose(id, 'dur', dur);
      await choose(id, 'dl', dl);
      const ok = await press('pkok', id);
      const draft = assertV2Message(lastEdit(ok.log)).buttons.find((b) => b.custom_id.startsWith('ev:drpost:')).custom_id.split(':')[2];
      await press('drpost', draft);
      const data = calls.find((c) => c[0] === 'createEvent')[1];
      assert.deepEqual([data.startAt, data.endAt, data.deadlineAt], [vn(2026, 10, 30, 20, 0), end, deadline], `${dur}/${dl}`);
    }
  });
  it('a double click on ✅ makes one preview', async () => {
    const id = pickerIdOf(await openPicker());
    const [a, b] = await Promise.all([press('pkok', id), press('pkok', id)]);
    const previews = [a, b].filter((r) => r.log.some((l) => l[0] === 'editReply'));
    assert.equal(previews.length, 1);
  });
  it('the event channel removed meanwhile keeps the picker with a /setup note', async () => {
    const id = pickerIdOf(await openPicker());
    config.announceChannelId = null;
    const r = await press('pkok', id);
    assert.match(textOf(r.log), /\/setup/);
    assert.ok(selectOf(r.log, 'day'));
  });
  it('↩ Huỷ drops the picker, creates nothing, and a later ✅ says the session is gone', async () => {
    const id = pickerIdOf(await openPicker());
    const r = await press('pkcancel', id);
    assert.match(JSON.stringify(lastEdit(r.log)), /Đã huỷ, chưa tạo sự kiện nào\./);
    const late = await press('pkok', id);
    assert.match(JSON.stringify(lastEdit(late.log)), /Phiên tạo sự kiện đã hết hạn, bấm ➕ Tạo sự kiện lại\./);
    assert.deepEqual(calls, []);
  });
});

describe('edit through the picker', () => {
  const openEdit = async (values = {}) => {
    const r = interaction({ fields: modalFields({ title: 'Tiệc to', description: 'Gặp mặt cuối tuần', people: '15-32', ...values }), isFromMessage: () => true });
    await events.handle(r.i, ['ev', 'editModal', EID]);
    return r;
  };
  it('the picker pre-selects the event current values, says ✅ Lưu, shows the stored times', async () => {
    const r = await openEdit();
    assert.deepEqual(r.log.map((l) => l[0]), ['deferUpdate', 'editReply']);
    assert.deepEqual(selected(selectOf(r.log, 'day')), ['2026-10-31']);
    assert.deepEqual(selected(selectOf(r.log, 'hour')), ['20']);
    assert.deepEqual(selected(selectOf(r.log, 'min')), ['0']);
    assert.deepEqual(selected(selectOf(r.log, 'dur')), ['120']);
    assert.deepEqual(selected(selectOf(r.log, 'dl')), ['h1']);
    assert.match(textOf(r.log), /→ T7 31\/10 20:00 – 22:00 · hạn đăng ký 19:00/);
    assert.match(textOf(r.log), /Kiểm tra lại rồi bấm \*\*✅ Lưu\*\*/);
    assert.equal(buttonOf(r.log, 'ev:pkok:').label, '✅ Lưu');
    assert.ok(!/ℹ️/.test(textOf(r.log)), 'every value is in the lists: no note');
  });
  it('✅ Lưu updates through the same call; the card is redrawn; the picker message becomes the manager view', async () => {
    const id = pickerIdOf(await openEdit());
    await choose(id, 'hour', '21');
    const r = await press('pkok', id);
    const upd = calls.find((c) => c[0] === 'updateEvent');
    assert.equal(upd[1].title, 'Tiệc to');
    assert.deepEqual(upd[1].startAt, vn(2026, 10, 31, 21));
    assert.deepEqual(upd[1].endAt, vn(2026, 10, 31, 23));
    assert.deepEqual(upd[1].deadlineAt, vn(2026, 10, 31, 20), 'the deadline follows: 1 hour before the new start');
    assert.deepEqual(upd[2], { startChanged: true });
    assert.match(JSON.stringify(lastEdit(r.log)), /Đã sửa \*\*Tiệc to\*\*/);
  });
  it('a stored time the lists cannot say is pre-selected to the nearest, explained, and saved untouched when not changed', async () => {
    ev = makeEvent({ startAt: vn(2026, 10, 31, 20, 7), endAt: vn(2026, 10, 31, 22, 10), deadlineAt: vn(2026, 10, 31, 19, 40) });
    const r = await openEdit();
    assert.match(textOf(r.log), /ℹ️ Giờ hiện tại của sự kiện không có đúng trong các danh sách/);
    assert.deepEqual(selected(selectOf(r.log, 'min')), ['0']);
    assert.deepEqual(selected(selectOf(r.log, 'dur')), ['120']);
    assert.match(textOf(r.log), /20:07 – 22:10 · hạn đăng ký 19:40/);
    const id = pickerIdOf(r);
    await press('pkok', id);
    const upd = calls.find((c) => c[0] === 'updateEvent');
    assert.deepEqual(upd[1].startAt, vn(2026, 10, 31, 20, 7));
    assert.deepEqual(upd[1].endAt, vn(2026, 10, 31, 22, 10));
    assert.deepEqual(upd[1].deadlineAt, vn(2026, 10, 31, 19, 40));
    assert.deepEqual(upd[2], { startChanged: false });
  });
  it('end of day / no end time are recognised; an event far in the future keeps its day selectable', async () => {
    ev = makeEvent({ startAt: vn(2026, 12, 20, 20), endAt: vn(2026, 12, 20, 23, 59), deadlineAt: vn(2026, 12, 19, 22) });
    let r = await openEdit();
    assert.deepEqual(selected(selectOf(r.log, 'dur')), ['day']);
    assert.deepEqual(selected(selectOf(r.log, 'dl')), ['prev22']);
    assert.deepEqual(selected(selectOf(r.log, 'day')), ['2026-12-20']);
    assert.equal(selectOf(r.log, 'day').options.length, 25);
    ev = makeEvent({ endAt: null, deadlineAt: vn(2026, 10, 31, 20) });
    r = await openEdit();
    assert.deepEqual(selected(selectOf(r.log, 'dur')), ['none']);
    assert.deepEqual(selected(selectOf(r.log, 'dl')), ['start']);
  });
  it('an event whose start already passed can be saved untouched (like the typed form), but a moved start must be in the future', async () => {
    ev = makeEvent({ startAt: vn(2026, 10, 27, 20), endAt: null, deadlineAt: vn(2026, 10, 27, 20) });
    const r = await openEdit();
    assert.equal(buttonOf(r.log, 'ev:pkok:').disabled, false);
    const id = pickerIdOf(r);
    const moved = await choose(id, 'hour', '21');
    assert.equal(buttonOf(moved.log, 'ev:pkok:').disabled, true);
    await choose(id, 'hour', '20');
    await press('pkok', id);
    assert.ok(calls.some((c) => c[0] === 'updateEvent'));
  });
  it('a cancelled / vanished event on ✅ Lưu changes nothing', async () => {
    const id = pickerIdOf(await openEdit());
    ev = makeEvent({ status: 'cancelled' });
    const r = await press('pkok', id);
    assert.match(JSON.stringify(lastEdit(r.log)), /không sửa được/);
    assert.ok(!calls.some((c) => c[0] === 'updateEvent'));
  });
  it('↩ Huỷ on an edit says nothing was changed', async () => {
    const id = pickerIdOf(await openEdit());
    const r = await press('pkcancel', id);
    assert.match(JSON.stringify(lastEdit(r.log)), /Đã huỷ, chưa sửa sự kiện nào\./);
    assert.ok(!calls.some((c) => c[0] === 'updateEvent'));
  });
});

describe('expired pickers', () => {
  const EXPIRED = /Phiên tạo sự kiện đã hết hạn, bấm ➕ Tạo sự kiện lại\./;
  it('an unknown id (a restart) answers clearly on every picker control', async () => {
    for (const r of [await choose('deadbeef', 'day', '2026-10-30'), await press('pkok', 'deadbeef'), await press('pkcancel', 'deadbeef').then((x) => ({ log: x.log, skip: true }))]) {
      if (r.skip) continue;
      assert.match(JSON.stringify(lastEdit(r.log)), EXPIRED);
    }
    assert.deepEqual(calls, []);
  });
  it('30 minutes without a touch expire it; every touch keeps it alive', async () => {
    const id = pickerIdOf(await openPicker());
    mock.timers.tick(29 * 60 * 1000);
    let r = await choose(id, 'hour', '21');
    assert.ok(selectOf(r.log, 'hour'), 'alive after 29 minutes');
    mock.timers.tick(29 * 60 * 1000);
    r = await choose(id, 'hour', '22');
    assert.ok(selectOf(r.log, 'hour'), 'the touch above kept it alive');
    mock.timers.tick(31 * 60 * 1000);
    r = await press('pkok', id);
    assert.match(JSON.stringify(lastEdit(r.log)), EXPIRED);
    assert.deepEqual(calls, []);
  });
  it('a picker belongs to the manager who opened it', async () => {
    const id = pickerIdOf(await openPicker());
    const other = await press('pkok', id, { user: { id: sid(902), username: 'o' } });
    assert.match(JSON.stringify(lastEdit(other.log)), EXPIRED);
    assert.deepEqual(calls, []);
  });
});

describe('permission', () => {
  it('a member is refused on every picker control and on the modal submit: nothing opens, nothing is created', async () => {
    const id = pickerIdOf(await openPicker());
    for (const [action, extra] of [['pk', { values: ['2026-10-30'] }], ['pkok', {}], ['pkcancel', {}]]) {
      const r = memberIx(extra);
      await events.handle(r.i, ['ev', action, id, 'day']);
      assert.deepEqual(r.log.map((l) => l[0]), ['deferUpdate', 'followUp'], action);
      assert.match(r.log[1][1].content, /không có quyền/);
    }
    const m = memberIx({ fields: modalFields({ title: 'Hack' }) });
    await events.handle(m.i, ['ev', 'newModal']);
    assert.match(m.log.pop()[1].content, /không có quyền/);
    assert.deepEqual(calls, []);
    // the manager's picker is still intact
    const ok = await press('pkok', id);
    assert.match(textOf(ok.log), /Xem trước/);
  });
});

describe('the old modal with a typed time', () => {
  const inDays = (n, hhmm) => `${String(new Date(Date.now() + n * 86400000 + 7 * 3600000).getUTCDate()).padStart(2, '0')}/${String(new Date(Date.now() + n * 86400000 + 7 * 3600000).getUTCMonth() + 1).padStart(2, '0')} ${hhmm}`;
  it('a create submission that still has the time field goes straight to the preview, as before', async () => {
    const r = interaction({ fields: modalFields({ title: 'Cũ', time: `${inDays(3, '20:00')} | hạn ${inDays(2, '18:00')}`, people: '15-32' }) });
    await events.handle(r.i, ['ev', 'newModal']);
    assert.match(textOf(r.log), /Xem trước · chưa đăng/);
    assert.deepEqual(selectsOf(lastEdit(r.log)), {});
  });
  it('an edit submission with the time field saves at once; a bad typed time still says so', async () => {
    let r = interaction({ fields: modalFields({ title: 'Cũ', time: '31/10 20:00 | hạn 31/10 19:00', people: '15-32' }), isFromMessage: () => true });
    await events.handle(r.i, ['ev', 'editModal', EID]);
    assert.ok(calls.some((c) => c[0] === 'updateEvent'));
    calls.length = 0;
    r = interaction({ fields: modalFields({ title: 'Cũ', time: 'mai' }), isFromMessage: () => true });
    await events.handle(r.i, ['ev', 'editModal', EID]);
    assert.match(JSON.stringify(lastEdit(r.log)), /không hợp lệ/);
    assert.deepEqual(calls, []);
  });
});

describe('buildEventPicker limits', () => {
  it('fits Components V2 (<= 40 components, valid ids) with the biggest content', () => {
    const times = eventService.pickTimes({ day: '2026-10-31', hour: 20, min: 30, dur: 'day', dl: 'prev22' });
    const payload = buildEventPicker({ draftId: 'abcd1234', title: 'T'.repeat(100), editing: true, pick: { day: '2026-10-31', hour: 20, min: 30, dur: 'day', dl: 'prev22' }, times, error: 'x'.repeat(100), note: 'y'.repeat(200), now: NOW });
    const v2 = assertV2Message(payload);
    assert.ok(v2.count <= 40);
    assert.deepEqual(Object.keys(selectsOf(payload)), ['ev:pk:abcd1234:day', 'ev:pk:abcd1234:hour', 'ev:pk:abcd1234:min', 'ev:pk:abcd1234:dur', 'ev:pk:abcd1234:dl']);
  });
});

describe('edit with a start the lists cannot say (20:10): offsets count from the stored start', () => {
  const odd = () => makeEvent({ startAt: vn(2026, 11, 5, 20, 10), endAt: vn(2026, 11, 5, 22, 10), deadlineAt: vn(2026, 11, 4, 18, 0) });
  const open = async () => {
    ev = odd();
    const r = interaction({ fields: modalFields({ title: 'Tiệc', people: '15-32' }), isFromMessage: () => true });
    await events.handle(r.i, ['ev', 'editModal', EID]);
    return r;
  };
  it('deadline "Lúc bắt đầu" = 20:10 and ✅ stays on; 1 tiếng ends 21:10; "Trước 30 phút" = 19:40', async () => {
    const id = pickerIdOf(await open());
    let r = await choose(id, 'dl', 'start');
    assert.match(textOf(r.log), /hạn đăng ký T5 05\/11 20:10|hạn đăng ký 20:10/);
    assert.equal(buttonOf(r.log, 'ev:pkok:').disabled, false);
    r = await choose(id, 'dur', '60');
    assert.match(textOf(r.log), /20:10 – 21:10/);
    r = await choose(id, 'dl', 'm30');
    assert.match(textOf(r.log), /hạn đăng ký 19:40/);
    await press('pkok', id);
    const upd = calls.find((c) => c[0] === 'updateEvent')[1];
    assert.deepEqual([upd.startAt, upd.endAt, upd.deadlineAt], [vn(2026, 11, 5, 20, 10), vn(2026, 11, 5, 21, 10), vn(2026, 11, 5, 19, 40)]);
  });
  it('day-anchored options are unchanged: "Cả ngày" 23:59 and "22:00 hôm trước"', async () => {
    const id = pickerIdOf(await open());
    await choose(id, 'dur', 'day');
    await choose(id, 'dl', 'prev22');
    await press('pkok', id);
    const upd = calls.find((c) => c[0] === 'updateEvent')[1];
    assert.deepEqual([upd.endAt, upd.deadlineAt], [vn(2026, 11, 5, 23, 59), vn(2026, 11, 4, 22, 0)]);
  });
});
