// Guild events (ev:*): the modal form, the card, the manager view, the handlers (admin gate, capacity refusal, reminder targets),
// the seats of eventService.setReply and the scheduler step. Discord access is stubbed; the DB parts run on an in-memory
// PostgreSQL (test/pgdb.js).
// Destructured imports are captured at require time, so the stubs on refresher / sheetSync / guildConfigService are installed FIRST.
const { describe, it, before, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits, Collection, ModalSubmitFields, ComponentType } = require('discord.js');
const { vn, oid, sid } = require('./helpers');
const { assertV2Message, assertModal } = require('./discordLimits');
const defaults = require('../config/defaults');

const guildConfigService = require('../src/services/guildConfigService');
const refresher = require('../src/bot/refresher');
const sheetSync = require('../src/bot/sheetSync');
const eventLog = require('../src/eventLog');
const db = require('../src/db');
const { setupDb, resetDb } = require('./pgdb');

let config;
let configImpl = null; // a test may replace the config lookup (events.js holds the function installed here)
guildConfigService.getConfigOrDefault = async (...a) => (configImpl ? configImpl(...a) : config);
guildConfigService.getConfig = async () => config;
const refreshed = []; // scheduleEventRefresh calls
const cardNow = []; // refreshEventCardNow calls
const synced = [];
refresher.scheduleEventRefresh = (...a) => refreshed.push(a);
refresher.refreshEventCardNow = async (...a) => cardNow.push(a);
let postImpl = async (client, channelId, event) => ({ ...event, channelId, messageId: 'msg-1' });
const realPostEventCard = refresher.postEventCard; // (the handler tests below replace it)
const postCalls = []; // postEventCard calls of the handler
refresher.postEventCard = (...a) => (postCalls.push({ client: a[0], channelId: a[1], event: a[2], opts: a[3] }), postImpl(...a));
sheetSync.scheduleSync = (...a) => synced.push(a);

const eventService = require('../src/services/eventService');
const realSetReply = eventService.setReply; // (the handler tests below replace it)
const realFindDueMinNotices = eventService.findDueMinNotices;
const realCreateEvent = eventService.createEvent;
const realListReplies = eventService.listReplies;
const realCountsOf = eventService.countsOf;
const { buildEventCard, buildListMessages, buildEventsView, buildEventPreview, buildMinNotice, buildRulesMessages, fitDescription, RULES_HINT } = require('../src/bot/ui/eventCard');
const { buildEventModal, buildExtendModal } = require('../src/bot/ui/settingsModal');
const { v2Create } = require('../src/bot/ui/common');
const { buildPanel } = require('../src/bot/ui/panel');
const { discordTs, formatLocalDateTime } = require('../src/utils/time');
const events = require('../src/bot/interactions/events');
const adminHandler = require('../src/bot/interactions/admin');
const { eventsStep } = require('../src/jobs/scheduler');
const feed = require('../src/services/sheets/feed');

const GUILD = '800000000000000001';
const EID = oid(7);
const ADMIN = sid(900);
const MEMBER = sid(901);
const MANAGE = new PermissionsBitField(PermissionFlagsBits.ManageGuild);
const NOBODY = new PermissionsBitField(PermissionFlagsBits.SendMessages);
const NOW = vn(2026, 10, 13, 10, 0);
const COUNTS = { yes: 12, maybe: 3, no: 5 };

// The submitted modal as discord.js really parses it: labels around a text input / a string select (fields.getStringSelectValues reads the select).
const modalFields = (values) => {
  const all = { title: '', category: 'other', description: '', time: '', people: '', ...values };
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
  startAt: vn(2026, 10, 17, 20),
  endAt: null,
  deadlineAt: vn(2026, 10, 17, 18),
  capacity: null,
  minParticipants: null,
  allowMaybe: true,
  remindBeforeMinutes: 60,
  channelId: 'chan',
  messageId: 'msg-1',
  status: 'open',
  remindedAt: null,
  ...extra,
});

describe('parseEventForm (create / edit modal)', () => {
  const ok = (over = {}, existing = null, now = NOW) => eventService.parseEventForm({ title: 'Tiệc', category: 'other', description: '', time: '17/10 20:00', people: '', ...over }, now, existing);

  it('a minimal form: deadline defaults to the start, no limits, no end, category other', () => {
    const { value, error } = ok();
    assert.equal(error, undefined);
    assert.deepEqual(value, { title: 'Tiệc', category: 'other', description: '', startAt: vn(2026, 10, 17, 20), endAt: null, deadlineAt: vn(2026, 10, 17, 20), capacity: null, minParticipants: null });
  });
  it('full form: category, deadline in the time field, people, description trimmed', () => {
    const { value } = ok({ category: 'pvp', description: '  vui  ', time: '17/10 20:00 | hạn 17/10 18:00', people: ' 15-32 ' });
    assert.equal(value.category, 'pvp');
    assert.equal(value.description, 'vui');
    assert.deepEqual(value.deadlineAt, vn(2026, 10, 17, 18));
    assert.equal(value.minParticipants, 15);
    assert.equal(value.capacity, 32);
  });
  it('the time field: end time, deadline, both; "hạn" in any case / with a colon; an empty deadline part is the start', () => {
    assert.deepEqual(ok({ time: '17/10 20:00 - 22:30' }).value.endAt, vn(2026, 10, 17, 22, 30));
    assert.deepEqual(ok({ time: '17/10 20:00 – 01:00' }).value.endAt, vn(2026, 10, 18, 1, 0), 'an end before the start is the next day');
    assert.match(ok({ time: '17/10 20:00 - 25:99' }).error, /Thời gian bắt đầu không hợp lệ/);
    const both = ok({ time: '17/10 20:00 - 22:00 | hạn 14/10 22:00' }).value;
    assert.deepEqual([both.startAt, both.endAt, both.deadlineAt], [vn(2026, 10, 17, 20), vn(2026, 10, 17, 22), vn(2026, 10, 14, 22)]);
    assert.deepEqual(ok({ time: '17/10 20:00 | Hạn: 14/10 22:00' }).value.deadlineAt, vn(2026, 10, 14, 22));
    assert.deepEqual(ok({ time: '17/10 20:00 |hạn 14/10 22:00' }).value.deadlineAt, vn(2026, 10, 14, 22));
    assert.deepEqual(ok({ time: '17/10 20:00 | 14/10 22:00' }).value.deadlineAt, vn(2026, 10, 14, 22), 'the word "hạn" is optional');
    assert.deepEqual(ok({ time: '17/10 20:00 |' }).value.deadlineAt, vn(2026, 10, 17, 20));
  });
  it('rejects an empty / too long title, a description over 4000 chars', () => {
    assert.match(ok({ title: '   ' }).error, /Tên sự kiện/);
    assert.match(ok({ title: 'x'.repeat(101) }).error, /tối đa 100/);
    assert.match(ok({ description: 'x'.repeat(4001) }).error, /tối đa 4000/);
    assert.equal(ok({ title: 'x'.repeat(100), description: 'y'.repeat(4000) }).error, undefined);
    assert.equal(eventService.DESCRIPTION_MAX, 4000);
  });
  it('the category must be one of the known keys; missing = other', () => {
    for (const key of Object.keys(defaults.eventCategories)) assert.equal(ok({ category: key }).value.category, key);
    assert.match(ok({ category: 'gaming' }).error, /Loại sự kiện không hợp lệ/);
    assert.equal(ok({ category: undefined }).value.category, 'other');
    assert.deepEqual(Object.keys(defaults.eventCategories), ['pvp', 'mind', 'music', 'video', 'social', 'pve', 'other']);
  });
  it('the start must parse and be in the future', () => {
    assert.match(ok({ time: 'mai' }).error, /Thời gian bắt đầu không hợp lệ/);
    assert.match(ok({ time: '31/02 20:00' }).error, /không hợp lệ/);
    assert.match(ok({ time: '13/10 09:00' }).error, /ở tương lai/);
    assert.match(ok({ time: '13/10 10:00' }).error, /ở tương lai/, 'right now is not the future');
  });
  it('the deadline must parse, not be after the start, not be past', () => {
    assert.match(ok({ time: '17/10 20:00 | hạn sớm' }).error, /Hạn đăng ký không hợp lệ/);
    assert.match(ok({ time: '17/10 20:00 | hạn 17/10 20:30' }).error, /trước hoặc bằng giờ bắt đầu/);
    assert.equal(ok({ time: '17/10 20:00 | hạn 17/10 20:00' }).error, undefined, 'deadline = start is allowed');
    assert.match(ok({ time: '17/10 20:00 | hạn 12/10 18:00' }).error, /Hạn đăng ký đã qua/);
  });
  it('the people field: every form', () => {
    const people = (text) => {
      const { value, error } = ok({ people: text });
      return error ? { error } : [value.minParticipants, value.capacity];
    };
    assert.deepEqual(people(''), [null, null]);
    assert.deepEqual(people('   '), [null, null]);
    assert.deepEqual(people('20'), [null, 20], 'a lone number is the maximum, as before');
    assert.deepEqual(people('15-32'), [15, 32]);
    assert.deepEqual(people(' 15 – 32 '), [15, 32]);
    assert.deepEqual(people('15-'), [15, null]);
    assert.deepEqual(people('-20'), [null, 20]);
    assert.deepEqual(people('1000'), [null, 1000]);
    assert.deepEqual(people('7-7'), [7, 7]);
    assert.deepEqual(people('1-1000'), [1, 1000]);
  });
  it('the people field: min above max and every malformed value is an error that says the format', () => {
    assert.match(ok({ people: '15-10' }).error, /Số tối thiểu \(15\) không được lớn hơn số tối đa \(10\)/);
    for (const bad of ['0', '-', '--', '0-5', '5-0', 'abc', '2.5', '1-2-3', '1001', '15-1001', '12345', '-0', 'nhiều', '15 32']) assert.match(ok({ people: bad }).error, /Số người/, bad);
  });
  it('editing: an unchanged start / deadline may already be past, a changed one may not', () => {
    const existing = makeEvent({ startAt: vn(2026, 10, 12, 20), deadlineAt: vn(2026, 10, 12, 18) });
    assert.equal(ok({ time: '12/10 20:00 | hạn 12/10 18:00' }, existing).error, undefined);
    assert.match(ok({ time: '12/10 21:00 | hạn 12/10 18:00' }, existing).error, /ở tương lai/);
    assert.match(ok({ time: '12/10 20:00 | hạn 12/10 19:00' }, existing).error, /Hạn đăng ký đã qua/);
  });
});

describe('parseExtendDeadline (⏳ Gia hạn)', () => {
  const ev1 = makeEvent({ startAt: vn(2026, 10, 17, 20) });
  const ext = (text) => eventService.parseExtendDeadline(text, ev1, NOW);
  it('a future time strictly before the start', () => {
    assert.deepEqual(ext('15/10 20:00'), { deadlineAt: vn(2026, 10, 15, 20) });
    assert.deepEqual(ext('17/10 19:59'), { deadlineAt: vn(2026, 10, 17, 19, 59) });
  });
  it('rejects garbage, a past time, the start itself and anything later', () => {
    assert.match(ext('mai').error, /không hợp lệ/);
    assert.match(ext('').error, /không hợp lệ/);
    assert.match(ext('12/10 10:00').error, /đã qua/);
    assert.match(ext('13/10 10:00').error, /đã qua/);
    assert.match(ext('17/10 20:00').error, /trước giờ bắt đầu/);
    assert.match(ext('18/10 08:00').error, /trước giờ bắt đầu/);
  });
});

describe('buildEventModal', () => {
  const fieldsOfModal = (modal) => Object.fromEntries(modal.toJSON().components.map((l) => [l.component.custom_id, l]));
  it('create: four fields (no time: the picker follows), the category is a string select inside the modal, optional ones not required', () => {
    const modal = buildEventModal();
    assert.equal(modal.toJSON().custom_id, 'ev:newModal');
    assertModal(modal);
    const f = fieldsOfModal(modal);
    assert.deepEqual(Object.keys(f), ['title', 'category', 'description', 'people']);
    assert.match(f.title.description, /chọn ngày giờ bằng danh sách/);
    assert.equal(f.category.component.type, ComponentType.StringSelect);
    assert.equal(f.category.component.required, true);
    assert.deepEqual(f.category.component.options.map((o) => o.value), ['pvp', 'mind', 'music', 'video', 'social', 'pve', 'other']);
    assert.deepEqual(f.category.component.options.map((o) => o.label), ['⚔️ PvP / thi đấu', '♟️ Cờ / trí tuệ', '🎤 Văn nghệ / hát', '🎬 Quay video / sáng tạo', '🎉 Giao lưu / họp mặt', '🐉 Boss / phó bản', '📦 Khác']);
    assert.deepEqual(f.category.component.options.filter((o) => o.default).map((o) => o.value), ['other'], 'Khác is preselected');
    assert.equal(f.title.component.required, true);
    for (const id of ['description', 'people']) assert.equal(f[id].component.required, false, id);
    assert.equal(f.description.component.style, 2, 'a paragraph');
    assert.equal(f.description.component.max_length, 4000);
    for (const l of Object.values(f)) assert.ok(l.label.length <= 45, l.label);
  });
  it('edit: prefilled, the category preselected, min-max in the people field (the times are prefilled in the picker)', () => {
    const f = fieldsOfModal(buildEventModal(makeEvent({ category: 'music', endAt: vn(2026, 10, 17, 22), capacity: 32, minParticipants: 15, deadlineAt: vn(2026, 10, 17, 18) })));
    assert.equal(f.title.component.value, 'Tiệc bang');
    assert.deepEqual(f.category.component.options.filter((o) => o.default).map((o) => o.value), ['music']);
    assert.equal(f.time, undefined);
    assert.equal(f.people.component.value, '15-32');
    const g = fieldsOfModal(buildEventModal(makeEvent({ deadlineAt: vn(2026, 10, 17, 20), capacity: 20 })));
    assert.equal(g.people.component.value, '20', 'a lone maximum is just the number');
    assert.equal(fieldsOfModal(buildEventModal(makeEvent({ minParticipants: 15 }))).people.component.value, '15-');
    assert.equal(fieldsOfModal(buildEventModal(makeEvent())).people.component.value, undefined);
    assert.equal(buildEventModal(makeEvent()).toJSON().custom_id, `ev:editModal:${EID}`);
    assertModal(buildEventModal(makeEvent({ description: 'D'.repeat(4000), title: 'T'.repeat(100), endAt: vn(2026, 10, 17, 22), minParticipants: 1000, capacity: 1000 })));
  });
  it('an old event without a category is preselected as Khác', () => {
    const old = makeEvent();
    delete old.category;
    assert.deepEqual(fieldsOfModal(buildEventModal(old)).category.component.options.filter((o) => o.default).map((o) => o.value), ['other']);
  });
  it('the select value is read back the supported way: fields.getStringSelectValues("category") on the real ModalSubmitFields', () => {
    const fields = modalFields({ title: 'Giải Solo 1-1', category: 'pvp', description: 'x', time: '16/10 20:00', people: '15-32' });
    assert.deepEqual(fields.getStringSelectValues('category'), ['pvp']);
    assert.equal(fields.getTextInputValue('title'), 'Giải Solo 1-1');
    assert.throws(() => fields.getTextInputValue('category'), 'a select is not a text input');
  });
  it('the extend modal: one deadline field, mentions the start', () => {
    const m = assertModal(buildExtendModal(makeEvent()));
    assert.equal(m.custom_id, `ev:minextModal:${EID}`);
    assert.deepEqual(m.components.map((c) => c.component.custom_id), ['deadline']);
    assert.match(m.components[0].description, /17\/10 20:00/);
  });
});

describe('buildEventCard', () => {
  const card = (event, counts = COUNTS) => assertV2Message(buildEventCard(event, counts));
  const idsOf = (v2) => v2.buttons.map((b) => b.custom_id);
  const disabled = (v2, id) => v2.buttons.find((b) => b.custom_id === id).disabled === true;

  it('open: title, description, time, status with the deadline, counts, four buttons, a footer', () => {
    const v2 = card(makeEvent());
    assert.match(v2.text, /### 📦 Tiệc bang/);
    assert.match(v2.text, /Gặp mặt cuối tuần/);
    assert.ok(v2.text.includes(`🕗 ${discordTs(vn(2026, 10, 17, 20), 'f')} (${discordTs(vn(2026, 10, 17, 20), 'R')})`));
    assert.ok(v2.text.includes(`🟢 Đang mở · hạn ${discordTs(vn(2026, 10, 17, 18), 'R')}`));
    assert.match(v2.text, /✅ \*\*12\*\* tham gia · ❓ 3 có thể · ❌ 5 không/);
    assert.ok(v2.text.includes(`-# Đổi được tới ${discordTs(vn(2026, 10, 17, 18), 'f')}`));
    assert.deepEqual(idsOf(v2), [`ev:rp:${EID}:yes`, `ev:rp:${EID}:maybe`, `ev:rp:${EID}:no`, `ev:ls:${EID}`]);
    assert.deepEqual(v2.json[0].components.find((c) => c.type === 1).components.map((b) => b.label), ['✅ Tham gia', '❓ Có thể', '❌ Không', '📋 Danh sách']);
    for (const id of idsOf(v2)) assert.equal(disabled(v2, id), false, id);
    assert.equal(v2.json[0].accent_color, 0x1abc9c, 'open = teal');
  });
  it('a new message is posted with v2Create (no content / embeds keys)', () => {
    assertV2Message(v2Create(buildEventCard(makeEvent(), COUNTS)), { forCreate: true });
  });
  it('an end time shows after the start', () => {
    assert.ok(card(makeEvent({ endAt: vn(2026, 10, 17, 22) })).text.includes(` – ${discordTs(vn(2026, 10, 17, 22), 't')}`));
  });
  it('capacity: "12/20", and "đã đủ người" once the seats are gone', () => {
    assert.match(card(makeEvent({ capacity: 20 })).text, /✅ \*\*12\*\*\/20 tham gia/);
    assert.ok(!card(makeEvent({ capacity: 20 })).text.includes('đã đủ'));
    const full = card(makeEvent({ capacity: 12 }));
    assert.match(full.text, /\*\*12\*\*\/12/);
    assert.match(full.text, /Đang mở · hạn <t:\d+:R> · đã đủ người/);
    assert.equal(disabled(full, `ev:rp:${EID}:yes`), false, 'the ✅ button stays: the click answers "đã đủ"');
  });
  it('locked: orange, answer buttons off, 📋 still works', () => {
    const v2 = card(makeEvent({ status: 'locked' }));
    assert.match(v2.text, /🔒 Đã chốt/);
    assert.equal(v2.json[0].accent_color, 0xe67e22);
    for (const s of ['yes', 'maybe', 'no']) assert.equal(disabled(v2, `ev:rp:${EID}:${s}`), true, s);
    assert.equal(disabled(v2, `ev:ls:${EID}`), false);
    assert.ok(!v2.text.includes('Đổi được tới'));
  });
  it('cancelled: grey, struck-through title, buttons off', () => {
    const v2 = card(makeEvent({ status: 'cancelled' }));
    assert.match(v2.text, /### ~~📦 Tiệc bang~~/);
    assert.match(v2.text, /❌ Đã huỷ/);
    assert.equal(v2.json[0].accent_color, 0x7f8c8d);
    assert.equal(disabled(v2, `ev:rp:${EID}:yes`), true);
    assert.equal(disabled(v2, `ev:ls:${EID}`), false);
  });
  it('done: grey "Đã kết thúc", buttons off', () => {
    const v2 = card(makeEvent({ status: 'done' }));
    assert.match(v2.text, /⚫ Đã kết thúc/);
    assert.equal(v2.json[0].accent_color, 0x95a5a6);
    assert.equal(disabled(v2, `ev:rp:${EID}:no`), true);
  });
  it('no description / no counts yet: still a valid card', () => {
    const v2 = assertV2Message(buildEventCard(makeEvent({ description: '' }), undefined));
    assert.match(v2.text, /✅ \*\*0\*\* tham gia · ❓ 0 có thể · ❌ 0 không/);
  });
  it('the longest title and description stay within the V2 limits', () => {
    assertV2Message(buildEventCard(makeEvent({ title: 'T'.repeat(100), description: 'D'.repeat(4000), capacity: 1000, endAt: vn(2026, 10, 17, 23) }), COUNTS));
  });
});

describe('buildListMessages', () => {
  const replies = [
    { discordId: sid(1), displayName: 'An', status: 'yes' },
    { discordId: sid(2), displayName: 'Bình', status: 'maybe' },
    { discordId: sid(3), displayName: 'Chi', status: 'no' },
    { discordId: sid(4), displayName: 'Dũng', status: 'yes' },
  ];
  it('✅ then ❓ then ❌, names in order of answer, with the capacity', () => {
    const [text, ...rest] = buildListMessages(makeEvent({ capacity: 5 }), replies);
    assert.equal(rest.length, 0);
    assert.match(text, /^📋 \*\*Tiệc bang\*\* · 🟢 Đang mở\n✅ \*\*Tham gia\*\* \(2\/5\): An, Dũng\n❓ \*\*Có thể\*\* \(1\): Bình\n❌ \*\*Không\*\* \(1\): Chi$/);
  });
  it('a mention in a name is defanged; an empty event says so', () => {
    const [text] = buildListMessages(makeEvent(), [{ discordId: sid(1), displayName: '<@123> @everyone', status: 'yes' }]);
    assert.ok(!text.includes('<@123>') && !text.includes('@everyone'));
    assert.match(buildListMessages(makeEvent(), [])[0], /Chưa có ai trả lời/);
  });
  it('a long list continues in more messages (each ≤ 2000), repeating the section prefix, no name lost', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ discordId: sid(i), displayName: `Thành viên số ${i}`, status: 'yes' }));
    const messages = buildListMessages(makeEvent(), many);
    assert.ok(messages.length > 1);
    for (const m of messages) assert.ok(m.length <= 2000, `message of ${m.length}`);
    for (const m of messages.slice(1)) assert.match(m, /^✅ \*\*Tham gia\*\*/);
    assert.equal(messages.join('\n').match(/Thành viên số \d+/g).length, 400);
  });
});

describe('buildEventsView (manager)', () => {
  const e1 = makeEvent();
  const e2 = makeEvent({ _id: oid(8), title: 'Đi dã ngoại', status: 'locked', capacity: 10, startAt: vn(2026, 10, 18, 9) });
  const counts = new Map([[EID, COUNTS], [oid(8), { yes: 4, maybe: 0, no: 1 }]]);
  const view = (opts) => assertV2Message(buildEventsView({ events: [e1, e2], counts, ...opts }));
  const idsOf = (v2) => v2.buttons.map((b) => b.custom_id).filter(Boolean);

  it('lists the events (title linked, time, status, counts) with a select and ➕ Tạo sự kiện', () => {
    const v2 = view();
    assert.match(v2.text, /### 📅 Quản lý sự kiện/);
    assert.match(v2.text, new RegExp(`\\[Tiệc bang\\]\\(https://discord.com/channels/${GUILD}/chan/msg-1\\)`));
    assert.match(v2.text, /🟢 Đang mở · ✅ 12 · ❓ 3 · ❌ 5/);
    assert.match(v2.text, /🔒 Đã chốt · ✅ 4\/10 · ❓ 0 · ❌ 1/);
    assert.ok(idsOf(v2).includes('ev:new'));
    const select = v2.json[0].components.find((c) => c.type === 1 && c.components[0].type === 3).components[0];
    assert.equal(select.custom_id, 'ev:pick');
    assert.deepEqual(select.options.map((o) => o.value), [EID, oid(8)]);
    assert.ok(!idsOf(v2).some((id) => id.startsWith('ev:edit')), 'nothing selected: no per-event buttons');
  });
  it('nothing open: a hint, no select', () => {
    const v2 = assertV2Message(buildEventsView({ events: [] }));
    assert.match(v2.text, /Chưa có sự kiện nào đang mở/);
    assert.deepEqual(idsOf(v2), ['ev:new']);
  });
  it('a selected open event: ✏️ 🔒 ❌ 📣 📋 and a link button', () => {
    const v2 = view({ selectedId: EID });
    assert.deepEqual(idsOf(v2), ['ev:new', `ev:edit:${EID}`, `ev:lock:${EID}`, `ev:cancel:${EID}`, `ev:remind:${EID}`, `ev:ls:${EID}`, `ev:doc:${EID}`, `ev:maybe:${EID}`]);
    const labels = v2.json[0].components.flatMap((c) => (c.type === 1 ? c.components.map((b) => b.label) : []));
    assert.ok(labels.includes('🔒 Chốt') && labels.includes('🔗 Link bài') && labels.includes('❌ Huỷ sự kiện') && labels.includes('📣 Nhắc'));
    const link = v2.json[0].components.flatMap((c) => (c.type === 1 ? c.components : [])).find((b) => b.label === '🔗 Link bài');
    assert.equal(link.url, `https://discord.com/channels/${GUILD}/chan/msg-1`);
    const sel = v2.json[0].components.find((c) => c.type === 1 && c.components[0].type === 3).components[0];
    assert.equal(sel.options.find((o) => o.default).value, EID);
  });
  it('a locked event shows 🟢 Mở lại', () => {
    const v2 = view({ selectedId: oid(8) });
    const labels = v2.json[0].components.flatMap((c) => (c.type === 1 ? c.components.map((b) => b.label) : []));
    assert.ok(labels.includes('🟢 Mở lại') && !labels.includes('🔒 Chốt'));
  });
  it('confirm steps replace the buttons: cancel and remind (with the number of people)', () => {
    const cancel = view({ selectedId: EID, confirm: 'cancel' });
    assert.deepEqual(idsOf(cancel).slice(1), [`ev:cancelok:${EID}`, `ev:sel:${EID}`]);
    assert.match(cancel.text, /Huỷ sự kiện \*\*Tiệc bang\*\*\?/);
    const remind = view({ selectedId: EID, confirm: 'remind' });
    assert.deepEqual(idsOf(remind).slice(1), [`ev:remindok:${EID}`, `ev:sel:${EID}`]);
    assert.match(remind.text, /Nhắc \*\*15\*\* người \(✅ 12 · ❓ 3\)/);
  });
  it('25 events: the select holds them all, the text lists only the first ten', () => {
    const many = Array.from({ length: 25 }, (_, i) => makeEvent({ _id: oid(100 + i), title: `Sự kiện ${i}` }));
    const v2 = assertV2Message(buildEventsView({ events: many, counts: new Map() }));
    assert.match(v2.text, /… và 15 sự kiện nữa/);
    assert.equal(v2.json[0].components.find((c) => c.type === 1 && c.components[0].type === 3).components[0].options.length, 25);
  });
  it('a note shows at the top', () => {
    assert.match(view({ note: '✅ Đã tạo' }).text, /### 📅 Quản lý sự kiện\n✅ Đã tạo/);
  });
});

describe('war dashboard: no 🎉 Sự kiện button any more', () => {
  it('the last row is ⚙️ Cài đặt, ⚙️ Ngưỡng (the retired ⚖️ / 🎲 stay off even when an old config says on); nothing on the dashboard opens the events', () => {
    const v2 = assertV2Message(buildPanel({ config: { features: { violations: true, draw: true } } }));
    const row = v2.json[0].components.filter((c) => c.type === 1).pop();
    assert.deepEqual(row.components.map((b) => [b.custom_id, b.label]), [['adm:settings', '⚙️ Cài đặt'], ['adm:offcfg', '⚙️ Ngưỡng']]);
    assert.ok(!v2.buttons.some((b) => b.custom_id === 'adm:events' || /🎉/.test(b.label)));
  });
});

describe('reminder targets', () => {
  const replies = [
    { discordId: 'a', status: 'no' },
    { discordId: 'b', status: 'maybe' },
    { discordId: 'c', status: 'yes' },
    { discordId: 'd', status: 'yes' },
    { discordId: 'c', status: 'yes' },
  ];
  it('✅ first, then ❓, never ❌, each once', () => {
    assert.deepEqual(eventService.remindTargets(replies), ['c', 'd', 'b']);
    assert.deepEqual(eventService.remindTargets([{ discordId: 'x', status: 'no' }]), []);
  });
  it('chunked under the limit; each message names exactly the users it mentions; the header only leads the first', () => {
    const ids = Array.from({ length: 300 }, (_, i) => sid(i));
    const messages = eventService.buildRemindMessages('⏰ **Tiệc** bắt đầu', ids);
    assert.ok(messages.length > 1);
    for (const m of messages) {
      assert.ok(m.content.length <= 1900);
      assert.deepEqual(m.content.match(/<@(\d+)>/g).map((t) => t.slice(2, -1)), m.users);
      assert.ok(m.users.length < 100, 'Discord allows 100 users per allowedMentions');
    }
    assert.ok(messages[0].content.startsWith('⏰ **Tiệc** bắt đầu'));
    assert.ok(!messages[1].content.startsWith('⏰'));
    assert.deepEqual(messages.flatMap((m) => m.users), ids);
  });
});

// ---------- handlers ----------

let ev; // the stored event
let created; // the event the create flow just made
let replies;
let calls;
let sent; // channel.send payloads
let sink;
const lines = () => sink.map((l) => JSON.parse(l)).filter((l) => l.area === 'event');

function interaction(extra = {}) {
  const log = [];
  const channel = { id: 'chan', send: async (p) => sent.push(p) };
  const i = {
    guildId: GUILD,
    user: { id: ADMIN, username: 'u' },
    member: { roles: [], permissions: MANAGE, displayName: 'Quản lý' },
    memberPermissions: MANAGE,
    client: { channels: { fetch: async () => channel } },
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
const fieldsOf = (values) => ({ fields: modalFields(values) });

beforeEach(() => {
  config = { ...guildConfigService.defaultConfig(GUILD), announceChannelId: 'announce', features: { events: true } }; // 🧩 Tính năng: 🎉 on
  ev = makeEvent();
  created = null;
  replies = [];
  calls = [];
  sent = [];
  refreshed.length = 0;
  postCalls.length = 0;
  cardNow.length = 0;
  synced.length = 0;
  sink = [];
  eventLog.setSink((l) => sink.push(l));
  mock.method(console, 'error', () => {});
  mock.method(console, 'warn', () => {});
  eventService.getEvent = async (id) => (ev && String(ev._id) === String(id) ? ev : null);
  eventService.listReplies = async () => replies;
  eventService.listManage = async () => [ev, created].filter((e) => e && (e.status === 'open' || e.status === 'locked'));
  eventService.countsFor = async (ids) => new Map(ids.map((id) => [String(id), COUNTS]));
  eventService.countsOf = async () => COUNTS;
  eventService.setReply = async (a) => {
    calls.push(['setReply', a]);
    return { ok: true, reply: { ...a } };
  };
  eventService.createEvent = async (data) => {
    calls.push(['createEvent', data]);
    created = { ...makeEvent(), ...data, _id: oid(50) };
    return created;
  };
  eventService.deleteEvent = async (id) => calls.push(['deleteEvent', id]);
  eventService.updateEvent = async (id, patch, opts) => {
    calls.push(['updateEvent', patch, opts]);
    return { ...ev, ...patch };
  };
  eventService.lockEvent = async () => (calls.push(['lockEvent']), { ...ev, status: 'locked' });
  eventService.reopenEvent = async (id, deadline) => (calls.push(['reopenEvent', deadline]), { ...ev, status: 'open', deadlineAt: deadline });
  eventService.cancelEvent = async () => (calls.push(['cancelEvent']), { ...ev, status: 'cancelled' });
  eventService.claimManualRemind = async () => (calls.push(['claimManualRemind']), { claimed: true, at: null });
  eventService.releaseManualRemind = async () => calls.push(['releaseManualRemind']);
});
afterEach(() => {
  eventLog.setSink(null);
  mock.restoreAll();
});

describe('ev:rp (a member answers)', () => {
  const answer = async (status, ix = memberIx()) => {
    await events.handle(ix.i, ['ev', 'rp', EID, status]);
    return ix.log;
  };

  it('✅ is recorded, refreshes the card (debounced) and the sheet, and says until when it can be changed', async () => {
    const log = await answer('yes');
    assert.equal(log[0][0], 'deferReply');
    assert.match(lastEdit(log), /^✅ Đã ghi nhận: \*\*Tham gia\*\* — Tiệc bang\. Đổi được tới <t:\d+:f>\.$/);
    assert.ok(lastEdit(log).includes(discordTs(vn(2026, 10, 17, 18), 'f')));
    assert.equal(calls[0][1].status, 'yes');
    assert.equal(calls[0][1].discordId, MEMBER);
    assert.equal(calls[0][1].displayName, 'An');
    assert.equal(refreshed.length, 1);
    assert.equal(refreshed[0][1], ev._id, 'the card refresh is debounced (no delay argument)');
    assert.equal(refreshed[0][2], undefined);
    assert.equal(synced.length, 1);
    assert.deepEqual(lines().map((l) => [l.ev, l.status, l.result, l.eid]), [['reply', 'yes', 'ok', EID]]);
  });
  it('❓ and ❌ have their own labels', async () => {
    assert.match(lastEdit(await answer('maybe')), /\*\*Có thể\*\*/);
    assert.match(lastEdit(await answer('no')), /\*\*Không\*\*/);
  });
  it('a full ✅ is refused with "Đã đủ N người" and the member may pick ❓; the card is redrawn, nothing is synced', async () => {
    ev = makeEvent({ capacity: 20 });
    eventService.setReply = async () => ({ ok: false, reason: 'full' });
    const log = await answer('yes');
    assert.match(lastEdit(log), /^⚠️ Đã đủ 20 người tham gia\. Bạn vẫn có thể chọn ❓ Có thể\.$/);
    assert.equal(refreshed.length, 1);
    assert.equal(synced.length, 0);
    assert.deepEqual(lines().map((l) => [l.result, l.status]), [['full', 'yes']]);
  });
  it('after the deadline / lock the answer is refused as closed', async () => {
    eventService.setReply = async () => ({ ok: false, reason: 'closed' });
    assert.match(lastEdit(await answer('yes')), /Đã hết hạn đăng ký/);
    assert.deepEqual(lines().map((l) => l.result), ['closed']);
  });
  it('a cancelled event refuses without touching the data', async () => {
    ev = makeEvent({ status: 'cancelled' });
    assert.match(lastEdit(await answer('yes')), /đã huỷ/);
    assert.equal(calls.length, 0);
  });
  it('an unknown event, an event of another guild and an unknown status are "không tồn tại"', async () => {
    ev = makeEvent({ guildId: 'other' });
    assert.match(lastEdit(await answer('yes')), /không tồn tại/);
    ev = makeEvent();
    assert.match(lastEdit(await answer('definitely')), /không tồn tại/);
    const ix = memberIx();
    await events.handle(ix.i, ['ev', 'rp', oid(99), 'yes']);
    assert.match(lastEdit(ix.log), /không tồn tại/);
    assert.equal(calls.length, 0);
  });
});

describe('ev:ls (the list)', () => {
  it('ephemeral, names only, no mentions allowed', async () => {
    replies = [
      { discordId: sid(1), displayName: 'An', status: 'yes' },
      { discordId: sid(2), displayName: 'Bình', status: 'no' },
    ];
    const { i, log } = memberIx();
    await events.handle(i, ['ev', 'ls', EID]);
    const out = lastEdit(log);
    assert.match(out.content, /✅ \*\*Tham gia\*\* \(1\): An\n❌ \*\*Không\*\* \(1\): Bình/);
    assert.deepEqual(out.allowedMentions, { parse: [] });
  });
  it('works on a locked / cancelled event too', async () => {
    ev = makeEvent({ status: 'cancelled' });
    const { i, log } = memberIx();
    await events.handle(i, ['ev', 'ls', EID]);
    assert.match(lastEdit(log).content, /❌ Đã huỷ/);
  });
});

describe('the admin gate', () => {
  const deniedIx = (extra) => memberIx(extra);
  it('new / edit: a refusal is a plain reply, no modal', async () => {
    for (const parts of [['ev', 'new'], ['ev', 'edit', EID]]) {
      const { i, log } = deniedIx();
      await events.handle(i, parts);
      assert.equal(log.length, 1);
      assert.equal(log[0][0], 'reply');
      assert.match(log[0][1].content, /không có quyền/);
    }
  });
  it('every other manager action is refused after the defer and touches nothing', async () => {
    for (const action of ['pick', 'sel', 'lock', 'cancel', 'cancelok', 'remind', 'remindok']) {
      const { i, log } = deniedIx({ values: [EID] });
      await events.handle(i, ['ev', action, EID]);
      assert.deepEqual(log.map((l) => l[0]), ['deferUpdate', 'followUp'], action);
      assert.match(log[1][1].content, /không có quyền/);
    }
    for (const action of ['newModal', 'editModal']) {
      const { i, log } = deniedIx(fieldsOf({ title: 'Hack', start: '20/10 20:00' }));
      await events.handle(i, ['ev', action, EID]);
      assert.match(log.pop()[1].content, /không có quyền/, action);
    }
    assert.deepEqual(calls, [], 'no service call was made');
    assert.deepEqual(sent, []);
  });
  it('a manager role (no Manage Server) is accepted through the cached config', async () => {
    config.adminRoleIds = ['r-admin'];
    const { i, log } = interaction({ member: { roles: ['r-admin'], permissions: NOBODY }, memberPermissions: NOBODY });
    await events.handle(i, ['ev', 'new']);
    assert.equal(log[0][0], 'showModal');
  });

});

describe('manager actions', () => {
  it('ev:new opens the empty modal; ev:edit opens it prefilled, refuses a finished event', async () => {
    let r = interaction();
    await events.handle(r.i, ['ev', 'new']);
    assert.equal(r.log[0][1].toJSON().custom_id, 'ev:newModal');
    r = interaction();
    await events.handle(r.i, ['ev', 'edit', EID]);
    assert.equal(r.log[0][1].toJSON().custom_id, `ev:editModal:${EID}`);
    ev = makeEvent({ status: 'done' });
    r = interaction();
    await events.handle(r.i, ['ev', 'edit', EID]);
    assert.equal(r.log[0][0], 'reply');
    assert.match(r.log[0][1].content, /không sửa được/);
  });

  it('ev:pick and ev:sel show the selected event', async () => {
    let r = interaction({ values: [EID] });
    await events.handle(r.i, ['ev', 'pick']);
    assert.deepEqual(r.log.map((l) => l[0]), ['deferUpdate', 'editReply']);
    assert.match(JSON.stringify(lastEdit(r.log)), new RegExp(`ev:edit:${EID}`));
    r = interaction();
    await events.handle(r.i, ['ev', 'sel', EID]);
    assert.match(JSON.stringify(lastEdit(r.log)), new RegExp(`ev:cancel:${EID}`));
  });

  describe('create (ev:newModal -> preview -> 📢 Đăng)', () => {
    const submit = async (values, extra = {}) => {
      const r = interaction({ ...fieldsOf(values), ...extra });
      await events.handle(r.i, ['ev', 'newModal']);
      return r;
    };
    const inDays = (n, hhmm = '20:00') => `${formatLocalDateTime(new Date(Date.now() + n * 86400000)).split(' ')[0]} ${hhmm}`;
    const form = (over = {}) => ({ title: '  Giải Solo 1-1  ', category: 'pvp', description: 'Thể lệ', time: `${inDays(3)} | hạn ${inDays(2, '18:00')}`, people: '15-32', ...over });
    const draftOf = (r) => JSON.stringify(lastEdit(r.log)).match(/ev:drpost:([0-9a-f]+)/)[1];
    const click = async (action, draftId, extra = {}) => {
      const r = interaction(extra);
      await events.handle(r.i, ['ev', action, draftId]);
      return r;
    };
    const labelsOf = (payload) => assertV2Message(payload).buttons.map((b) => b.label);

    it('the form shows a PREVIEW only: nothing is created, posted, synced or logged as created', async () => {
      const r = await submit(form());
      assert.deepEqual(r.log.map((l) => l[0]), ['deferReply', 'editReply'], 'not from a message: a fresh ephemeral reply');
      const out = lastEdit(r.log);
      const v2 = assertV2Message(out);
      assert.match(v2.text, /Xem trước · chưa đăng/);
      assert.match(v2.text, /### ⚔️ Giải Solo 1-1/);
      assert.match(v2.text, /-# ⚔️ PvP \/ thi đấu/);
      assert.match(v2.text, /cần ít nhất 15/);
      assert.match(v2.text, /🔔 Tag role thành viên: \*\*tắt\*\*/);
      assert.match(v2.text, /❓ Có thể: \*\*bật\*\*/);
      assert.ok(!calls.some((c) => c[0] === 'createEvent'));
      assert.deepEqual(sent, []);
      assert.equal(synced.length, 0);
      assert.deepEqual(lines(), []);
      const ids = v2.buttons.map((b) => b.custom_id);
      assert.ok(ids.some((id) => id.startsWith('ev:drtag:')) && ids.some((id) => id.startsWith('ev:drmaybe:')) && ids.some((id) => id.startsWith('ev:drpost:')) && ids.some((id) => id.startsWith('ev:drcancel:')));
      for (const b of v2.buttons.filter((x) => x.custom_id.startsWith('ev:rp:') || x.custom_id.startsWith('ev:ls:'))) assert.equal(b.disabled, true, `${b.custom_id} is off in the preview`);
    });
    it('from the manager view (a message) the submit edits that message in place', async () => {
      const r = await submit(form(), { isFromMessage: () => true });
      assert.deepEqual(r.log.map((l) => l[0]), ['deferUpdate', 'editReply']);
    });
    it('the preview toggles: 🔔 and ❓ flip and show it; both labels carry the state', async () => {
      config.memberRoleId = 'role-1';
      const r0 = await submit(form());
      const id = draftOf(r0);
      const states = (r) => labelsOf(lastEdit(r.log)).filter((l) => /: (bật|tắt)$/.test(l));
      assert.deepEqual(states(r0), ['🔔 Tag role thành viên: tắt', '❓ Có thể: bật']);
      let r = await click('drtag', id);
      assert.deepEqual(r.log.map((l) => l[0]), ['deferUpdate', 'editReply']);
      assert.deepEqual(states(r), ['🔔 Tag role thành viên: bật', '❓ Có thể: bật']);
      r = await click('drmaybe', id);
      assert.deepEqual(states(r), ['🔔 Tag role thành viên: bật', '❓ Có thể: tắt']);
      assert.ok(!assertV2Message(lastEdit(r.log)).buttons.some((b) => b.custom_id === 'ev:rp:preview:maybe'), 'the card in the preview has no ❓ now');
      r = await click('drtag', id);
      assert.deepEqual(states(r), ['🔔 Tag role thành viên: tắt', '❓ Có thể: tắt']);
    });
    it('no member role configured: the tag button is off, says why, a forced toggle does nothing', async () => {
      config.memberRoleId = null;
      const r0 = await submit(form());
      const v2 = assertV2Message(lastEdit(r0.log));
      assert.equal(v2.buttons.find((b) => b.custom_id.startsWith('ev:drtag:')).disabled, true);
      assert.match(v2.text, /Chưa chọn role thành viên/);
      const id = draftOf(r0);
      await click('drtag', id);
      config.memberRoleId = 'role-1';
      await click('drpost', id);
      assert.deepEqual(postCalls.pop().opts, { tagRoleId: null });
    });
    it('📢 Đăng creates the event with the draft + toggles, posts it, selects it, syncs, logs category / min / max / tag / allowMaybe', async () => {
      config.memberRoleId = 'role-1';
      const id = draftOf(await submit(form()));
      await click('drmaybe', id);
      const r = await click('drpost', id);
      const [, data] = calls.find((c) => c[0] === 'createEvent');
      assert.deepEqual([data.guildId, data.title, data.category, data.description, data.capacity, data.minParticipants, data.allowMaybe, data.createdBy], [GUILD, 'Giải Solo 1-1', 'pvp', 'Thể lệ', 32, 15, false, ADMIN]);
      assert.ok(data.deadlineAt < data.startAt);
      assert.deepEqual(r.log.map((l) => l[0]), ['deferUpdate', 'editReply']);
      const out = lastEdit(r.log);
      assertV2Message(out);
      assert.match(JSON.stringify(out), /Đã tạo \*\*Giải Solo 1-1\*\* và đăng ở https:\/\/discord\.com\/channels\/\d+\/announce\/msg-1/);
      assert.match(JSON.stringify(out), new RegExp(`ev:edit:${oid(50)}`), 'the new event is selected');
      assert.equal(synced.length, 1);
      assert.equal(postCalls.length, 1);
      assert.deepEqual(postCalls[0].opts, { tagRoleId: null });
      const line = lines()[0];
      assert.deepEqual([line.ev, line.result, line.category, line.min, line.max, line.tag, line.allowMaybe], ['create', 'created', 'pvp', 15, 32, false, false]);
    });
    it('the tag on: the post is tagged with the member role, ONLY that role, and it is logged', async () => {
      config.memberRoleId = 'role-1';
      const id = draftOf(await submit(form()));
      await click('drtag', id);
      await click('drpost', id);
      assert.deepEqual(postCalls[0].opts, { tagRoleId: 'role-1' });
      assert.equal(lines()[0].tag, true);
    });
    it('a double click on 📢 posts once; the draft is gone afterwards', async () => {
      const id = draftOf(await submit(form()));
      await Promise.all([click('drpost', id), click('drpost', id)]);
      assert.equal(calls.filter((c) => c[0] === 'createEvent').length, 1);
      const again = await click('drpost', id);
      assert.match(JSON.stringify(lastEdit(again.log)), /Bản nháp đã hết hạn, bấm ➕ Tạo sự kiện lại\./);
      assert.equal(calls.filter((c) => c[0] === 'createEvent').length, 1);
    });
    it('Huỷ drops the draft and posts nothing', async () => {
      const id = draftOf(await submit(form()));
      const r = await click('drcancel', id);
      assert.match(JSON.stringify(lastEdit(r.log)), /Đã huỷ bản nháp/);
      const late = await click('drpost', id);
      assert.match(JSON.stringify(lastEdit(late.log)), /Bản nháp đã hết hạn/);
      assert.ok(!calls.some((c) => c[0] === 'createEvent'));
    });
    it('a draft expires after 15 minutes; an unknown id (a restart) says the same; the toggles on it too', async () => {
      mock.timers.enable({ apis: ['Date'], now: Date.now() });
      try {
        const id = draftOf(await submit(form()));
        mock.timers.tick(14 * 60 * 1000);
        const alive = await click('drmaybe', id);
        assert.match(JSON.stringify(lastEdit(alive.log)), /Xem trước/, 'still alive after 14 min');
        mock.timers.tick(16 * 60 * 1000); // (the click above kept it alive 15 more minutes: 16 without any click is too long)
        for (const action of ['drtag', 'drmaybe', 'drpost']) {
          const r = await click(action, id);
          assert.match(JSON.stringify(lastEdit(r.log)), /Bản nháp đã hết hạn, bấm ➕ Tạo sự kiện lại\./, action);
        }
        assert.ok(!calls.some((c) => c[0] === 'createEvent'));
      } finally {
        mock.timers.reset();
      }
      const gone = await click('drpost', 'deadbeef');
      assert.match(JSON.stringify(lastEdit(gone.log)), /Bản nháp đã hết hạn/);
    });
    it('a draft belongs to the admin who made it', async () => {
      const id = draftOf(await submit(form()));
      const other = await click('drpost', id, { user: { id: sid(902), username: 'o' } });
      assert.match(JSON.stringify(lastEdit(other.log)), /Bản nháp đã hết hạn/);
      assert.ok(!calls.some((c) => c[0] === 'createEvent'));
      const mine = await click('drpost', id);
      assert.match(JSON.stringify(lastEdit(mine.log)), /Đã tạo/);
    });
    it('the draft buttons are behind the admin gate', async () => {
      const id = draftOf(await submit(form()));
      for (const action of ['drtag', 'drmaybe', 'drpost', 'drcancel']) {
        const r = memberIx();
        await events.handle(r.i, ['ev', action, id]);
        assert.deepEqual(r.log.map((l) => l[0]), ['deferUpdate', 'followUp'], action);
        assert.match(r.log[1][1].content, /không có quyền/);
      }
      assert.ok(!calls.some((c) => c[0] === 'createEvent'));
    });
    it('a past start / a deadline after the start / bad people / min above max creates nothing and says why', async () => {
      for (const [values, text] of [
        [{ time: '12/10 20:00', people: '' }, /Thời gian bắt đầu phải ở tương lai|không hợp lệ/],
        [{ time: `${inDays(3)} | hạn ${inDays(4)}` }, /trước hoặc bằng giờ bắt đầu/],
        [{ people: 'nhiều' }, /Số người/],
        [{ people: '20-10' }, /không được lớn hơn/],
        [{ title: '' }, /Tên sự kiện/],
      ]) {
        const r = await submit(form(values));
        assert.match(JSON.stringify(lastEdit(r.log)), text);
        assert.ok(!JSON.stringify(lastEdit(r.log)).includes('ev:drpost'), 'no preview');
      }
      assert.ok(!calls.some((c) => c[0] === 'createEvent'));
      assert.ok(lines().every((l) => l.result === 'invalid'));
    });
    it('without an announce channel it points to /setup and shows no preview', async () => {
      config.announceChannelId = null;
      const r = await submit(form());
      assert.match(JSON.stringify(lastEdit(r.log)), /\/setup/);
      assert.ok(!JSON.stringify(lastEdit(r.log)).includes('ev:drpost'));
    });
    it('a card that cannot be posted removes the event again, keeps the draft for another try, says so', async () => {
      const id = draftOf(await submit(form()));
      postImpl = async () => {
        throw new Error('Missing Access');
      };
      try {
        const r = await click('drpost', id);
        assert.match(JSON.stringify(lastEdit(r.log)), /Không đăng được thẻ/);
        assert.match(JSON.stringify(lastEdit(r.log)), /ev:drpost/, 'the preview is back');
        assert.deepEqual(calls.filter((c) => c[0] === 'deleteEvent'), [['deleteEvent', oid(50)]]);
        assert.deepEqual([lines()[0].result, lines()[0].stage, lines()[0].category], ['error', 'post', 'pvp']);
      } finally {
        postImpl = async (client, channelId, event) => ({ ...event, channelId, messageId: 'msg-1' });
      }
      const retry = await click('drpost', id);
      assert.match(JSON.stringify(lastEdit(retry.log)), /Đã tạo/);
    });
    it('a description of 4000 chars still previews within the V2 text budget, cut with a (disabled) 📋 Thể lệ', async () => {
      const desc = `1. Thể lệ
${'Dòng luật dài. '.repeat(280)}`.slice(0, 4000);
      const r = await submit(form({ description: desc }));
      const v2 = assertV2Message(lastEdit(r.log));
      assert.match(v2.text, /xem đầy đủ: 📋 Thể lệ/);
      assert.equal(v2.buttons.find((b) => b.custom_id.startsWith('ev:rules:')).disabled, true);
    });
  });

  describe('edit (ev:editModal)', () => {
    const submit = async (values) => {
      const r = interaction({ ...fieldsOf(values), isFromMessage: () => true });
      await events.handle(r.i, ['ev', 'editModal', EID]);
      return r;
    };
    it('saves the changes, redraws the card at once, logs what changed', async () => {
      const r = await submit({ title: 'Tiệc to', description: 'Gặp mặt cuối tuần', time: '17/10 20:00 | hạn 17/10 18:00', people: '30' });
      const upd = calls.find((c) => c[0] === 'updateEvent');
      assert.equal(upd[1].title, 'Tiệc to');
      assert.equal(upd[1].capacity, 30);
      assert.deepEqual(upd[2], { startChanged: false });
      assert.deepEqual(refreshed.map((a) => a[2]), [0]);
      assert.equal(synced.length, 1);
      assert.match(JSON.stringify(lastEdit(r.log)), /Đã sửa \*\*Tiệc to\*\*/);
      const line = lines()[0];
      assert.deepEqual([line.ev, line.result, line.changed], ['edit', 'saved', ['title', 'capacity']]);
    });
    it('a moved start re-arms the automatic reminder', async () => {
      mock.timers.enable({ apis: ['Date'], now: NOW }); // the form's dates are read relative to "now": keep them in the future whatever day the tests run
      try {
        await submit({ title: 'Tiệc bang', time: '18/10 20:00 | hạn 17/10 18:00' });
      } finally {
        mock.timers.reset();
      }
      assert.deepEqual(calls.find((c) => c[0] === 'updateEvent')[2], { startChanged: true });
    });
    it('a capacity below the current ✅ is kept but flagged', async () => {
      const r = await submit({ title: 'Tiệc bang', description: 'Gặp mặt cuối tuần', time: '17/10 20:00 | hạn 17/10 18:00', people: '5' });
      assert.match(JSON.stringify(lastEdit(r.log)), /Đang có 12 người ✅, nhiều hơn số tối đa mới/);
    });
    it('invalid input / a cancelled event / a race changes nothing', async () => {
      let r = await submit({ title: 'Tiệc', time: 'mai' });
      assert.match(JSON.stringify(lastEdit(r.log)), /không hợp lệ/);
      ev = makeEvent({ status: 'cancelled' });
      r = await submit({ title: 'Tiệc', time: '17/10 20:00' });
      assert.match(JSON.stringify(lastEdit(r.log)), /không sửa được/);
      ev = makeEvent();
      eventService.updateEvent = async () => null;
      r = await submit({ title: 'Tiệc', time: '17/10 20:00 | hạn 17/10 18:00' });
      assert.match(JSON.stringify(lastEdit(r.log)), /vừa thay đổi/);
    });
  });

  describe('lock / reopen', () => {
    const click = async () => {
      const r = interaction();
      await events.handle(r.i, ['ev', 'lock', EID]);
      return r;
    };
    it('open -> locked: card redrawn, sheet synced, event.lock logged', async () => {
      const r = await click();
      assert.ok(calls.some((c) => c[0] === 'lockEvent'));
      assert.match(JSON.stringify(lastEdit(r.log)), /Đã chốt \*\*Tiệc bang\*\*/);
      assert.deepEqual(refreshed.map((a) => a[2]), [0]);
      assert.equal(synced.length, 1);
      assert.deepEqual(lines().map((l) => [l.ev, l.result, l.by]), [['lock', 'locked', 'manual']]);
    });
    it('locked -> open keeps a deadline still ahead, else falls back to the start (never an instant re-lock)', async () => {
      mock.timers.enable({ apis: ['Date'], now: vn(2026, 10, 17, 17, 0) });
      try {
        ev = makeEvent({ status: 'locked' });
        await click();
        assert.deepEqual(calls.find((c) => c[0] === 'reopenEvent')[1], vn(2026, 10, 17, 18));
        calls.length = 0;
        mock.timers.setTime(vn(2026, 10, 17, 19, 0).getTime());
        await click();
        assert.deepEqual(calls.find((c) => c[0] === 'reopenEvent')[1], vn(2026, 10, 17, 20), 'the 18:00 deadline is past: the start');
        calls.length = 0;
        mock.timers.setTime(vn(2026, 10, 17, 20, 30).getTime());
        const r = await click();
        assert.match(JSON.stringify(lastEdit(r.log)), /đã bắt đầu, không mở lại được/);
        assert.ok(!calls.some((c) => c[0] === 'reopenEvent'));
      } finally {
        mock.timers.reset();
      }
      assert.deepEqual(lines().filter((l) => l.result === 'reopened').length, 2);
    });
    it('a cancelled / finished event cannot be locked', async () => {
      ev = makeEvent({ status: 'done' });
      assert.match(JSON.stringify(lastEdit((await click()).log)), /không chốt/);
    });
  });

  describe('cancel', () => {
    it('the first click only asks; nothing changes', async () => {
      const r = interaction();
      await events.handle(r.i, ['ev', 'cancel', EID]);
      assert.match(JSON.stringify(lastEdit(r.log)), /Huỷ sự kiện \*\*Tiệc bang\*\*\?/);
      assert.ok(!calls.some((c) => c[0] === 'cancelEvent'));
      assert.deepEqual(sent, []);
    });
    it('the confirm cancels, redraws the card now and posts the notice without mentions', async () => {
      ev = makeEvent({ title: 'Tiệc <@123>' });
      const r = interaction();
      await events.handle(r.i, ['ev', 'cancelok', EID]);
      assert.ok(calls.some((c) => c[0] === 'cancelEvent'));
      assert.equal(cardNow.length, 1);
      assert.equal(sent.length, 1);
      assert.match(sent[0].content, /^❌ Sự kiện \*\*Tiệc .*\*\* đã huỷ\.$/);
      assert.ok(!sent[0].content.includes('<@123>'), 'the title cannot ping');
      assert.deepEqual(sent[0].allowedMentions, { parse: [] });
      assert.equal(synced.length, 1);
      const line = lines()[0];
      assert.deepEqual([line.ev, line.yes, line.maybe, line.no, line.notice], ['cancel', 12, 3, 5, 'sent']);
    });
    it('a failing notice does not undo the cancel and is said', async () => {
      const r = interaction({ client: { channels: { fetch: async () => { throw new Error('Missing Access'); } } } });
      await events.handle(r.i, ['ev', 'cancelok', EID]);
      assert.match(JSON.stringify(lastEdit(r.log)), /Đã huỷ.*Chưa báo được trong kênh/);
      assert.equal(lines()[0].notice, 'failed');
    });
    it('an already finished event / a lost race cancels nothing', async () => {
      ev = makeEvent({ status: 'cancelled' });
      let r = interaction();
      await events.handle(r.i, ['ev', 'cancelok', EID]);
      assert.match(JSON.stringify(lastEdit(r.log)), /rồi/);
      ev = makeEvent();
      eventService.cancelEvent = async () => null;
      r = interaction();
      await events.handle(r.i, ['ev', 'cancelok', EID]);
      assert.match(JSON.stringify(lastEdit(r.log)), /vừa thay đổi/);
      assert.deepEqual(sent, []);
    });
  });

  describe('remind (📣 Nhắc)', () => {
    beforeEach(() => {
      replies = [
        { discordId: sid(1), status: 'no' },
        { discordId: sid(2), status: 'maybe' },
        { discordId: sid(3), status: 'yes' },
        { discordId: sid(4), status: 'yes' },
      ];
    });
    it('the first click only asks', async () => {
      const r = interaction();
      await events.handle(r.i, ['ev', 'remind', EID]);
      assert.match(JSON.stringify(lastEdit(r.log)), /Nhắc \*\*15\*\* người/);
      assert.ok(!calls.some((c) => c[0] === 'claimManualRemind'));
      assert.deepEqual(sent, []);
    });
    it('pings ONLY ✅ and ❓ (never ❌), users only, in the event channel', async () => {
      const r = interaction();
      await events.handle(r.i, ['ev', 'remindok', EID]);
      assert.equal(sent.length, 1);
      const text = sent[0].content;
      assert.ok(text.includes(`<@${sid(3)}>`) && text.includes(`<@${sid(4)}>`) && text.includes(`<@${sid(2)}>`));
      assert.ok(!text.includes(`<@${sid(1)}>`), 'the ❌ person is not pinged');
      assert.deepEqual(Object.keys(sent[0].allowedMentions), ['users']);
      assert.deepEqual(sent[0].allowedMentions.users, [sid(3), sid(4), sid(2)]);
      assert.match(text, /^📣 \*\*Tiệc bang\*\* — nhắc tham gia, bắt đầu <t:\d+:R>\. https:\/\/discord\.com\/channels\//);
      const line = lines()[0];
      assert.deepEqual([line.ev, line.mode, line.result, line.pinged], ['remind', 'manual', 'sent', 3]);
      assert.match(JSON.stringify(lastEdit(r.log)), /Đã nhắc 3 người/);
    });
    it('a title cannot ping anybody: allowedMentions names exactly the targets', async () => {
      ev = makeEvent({ title: '@everyone <@999>' });
      await events.handle(interaction().i, ['ev', 'remindok', EID]);
      assert.ok(!sent[0].allowedMentions.parse, 'no parse: everyone / roles stay impossible');
      assert.ok(!sent[0].allowedMentions.users.includes('999'));
      assert.ok(!sent[0].content.includes('<@999>') && !sent[0].content.includes('@everyone'));
    });
    it('the cooldown claim blocks a second reminder', async () => {
      eventService.claimManualRemind = async () => ({ claimed: false, at: new Date(NOW) });
      const r = interaction();
      await events.handle(r.i, ['ev', 'remindok', EID]);
      assert.deepEqual(sent, []);
      assert.match(JSON.stringify(lastEdit(r.log)), /Vừa nhắc.*đợi 10 phút/);
      assert.equal(lines()[0].result, 'cooldown');
    });
    it('nobody on ✅ / ❓: nothing is sent and the cooldown is given back', async () => {
      replies = [{ discordId: sid(1), status: 'no' }];
      const r = interaction();
      await events.handle(r.i, ['ev', 'remindok', EID]);
      assert.deepEqual(sent, []);
      assert.ok(calls.some((c) => c[0] === 'releaseManualRemind'));
      assert.match(JSON.stringify(lastEdit(r.log)), /Chưa có ai bấm ✅ hoặc ❓/);
    });
    it('a send that fails before anything went out gives the cooldown back', async () => {
      const r = interaction({ client: { channels: { fetch: async () => { throw new Error('Missing Access'); } } } });
      await events.handle(r.i, ['ev', 'remindok', EID]);
      assert.ok(calls.some((c) => c[0] === 'releaseManualRemind'));
      assert.match(JSON.stringify(lastEdit(r.log)), /Không gửi được/);
      assert.equal(lines()[0].result, 'failed');
    });
    it('a finished event is not reminded', async () => {
      ev = makeEvent({ status: 'done' });
      await events.handle(interaction().i, ['ev', 'remindok', EID]);
      assert.deepEqual(sent, []);
      assert.ok(!calls.some((c) => c[0] === 'claimManualRemind'));
    });
  });
});

/// ---------- eventService.setReply: seats on a real (in-memory) PostgreSQL ----------

describe('eventService.setReply (seats, PostgreSQL)', () => {
  let event;
  before(setupDb);
  beforeEach(async () => {
    await resetDb();
    await db.q("insert into guilds (id) values ($1)", [GUILD]);
    event = await realCreateEvent({ guildId: GUILD, title: 'Tiệc bang', startAt: vn(2026, 10, 17, 20), deadlineAt: vn(2026, 10, 17, 18), capacity: 2 });
  });
  const reply = (discordId, status, over = {}) => realSetReply({ event, discordId, displayName: `N${discordId.slice(-2)}`, status, now: NOW, ...over });
  const stored = async () => (await realListReplies(event._id)).map((r) => [r.discordId, r.status]);

  it('✅ takes a seat while one is free; the next ✅ is refused as full and writes nothing', async () => {
    assert.equal((await reply(sid(1), 'yes')).ok, true);
    assert.equal((await reply(sid(2), 'yes')).ok, true);
    assert.deepEqual(await reply(sid(3), 'yes'), { ok: false, reason: 'full' });
    assert.deepEqual(await stored(), [[sid(1), 'yes'], [sid(2), 'yes']]);
  });
  it('a member already holding a ✅ keeps passing when the event is full; ❓ / ❌ never need a seat', async () => {
    await reply(sid(1), 'yes');
    await reply(sid(2), 'yes');
    assert.equal((await reply(sid(1), 'yes')).ok, true);
    assert.equal((await reply(sid(3), 'maybe')).ok, true);
    assert.equal((await reply(sid(4), 'no')).ok, true);
    assert.deepEqual(await realCountsOf(event._id), { yes: 2, maybe: 1, no: 1 });
  });
  it('leaving ✅ frees the seat for the next member', async () => {
    await reply(sid(1), 'yes');
    await reply(sid(2), 'yes');
    const left = await reply(sid(1), 'no');
    assert.deepEqual([left.ok, left.seatFreed], [true, true]);
    assert.equal((await reply(sid(3), 'yes')).ok, true);
  });
  it('one answer per member: a second click changes it', async () => {
    await reply(sid(1), 'maybe');
    await reply(sid(1), 'no');
    assert.deepEqual(await stored(), [[sid(1), 'no']]);
  });
  it('parallel ✅ for the last seat: exactly one wins (the event row is locked while counting)', async () => {
    await reply(sid(1), 'yes');
    const results = await Promise.all([reply(sid(2), 'yes'), reply(sid(3), 'yes'), reply(sid(4), 'yes')]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal((await realCountsOf(event._id)).yes, 2);
  });
  it('closed: the event passed in is locked / past the deadline / null, or the stored one was locked meanwhile', async () => {
    for (const bad of [makeEvent({ status: 'locked' }), makeEvent({ deadlineAt: vn(2026, 10, 13, 9, 0) }), null]) {
      assert.deepEqual(await reply(sid(1), 'yes', { event: bad }), { ok: false, reason: 'closed' });
    }
    await db.q("update guild_events set status = 'locked' where id = $1", [event._id]);
    assert.deepEqual(await reply(sid(1), 'maybe'), { ok: false, reason: 'closed' });
    assert.deepEqual(await stored(), []);
  });
  it('no capacity: every ✅ passes', async () => {
    await db.q('update guild_events set capacity = null where id = $1', [event._id]);
    for (let i = 1; i <= 5; i++) assert.equal((await reply(sid(i), 'yes')).ok, true);
  });
});

// ---------- scheduler step ----------

describe('scheduler: events step', () => {
  let due;
  let client;
  beforeEach(() => {
    due = { locks: [], reminders: [], finished: [] };
    sent = [];
    const channel = { id: 'chan', send: async (p) => sent.push(p) };
    client = { channels: { fetch: async () => channel } };
    eventService.findDueLocks = async () => due.locks;
    eventService.findDueReminders = async () => due.reminders;
    eventService.findFinished = async () => due.finished;
    eventService.findDueMinNotices = async () => [];
    eventService.claimMinNotice = async () => true;
    eventService.lockEvent = async (id) => (calls.push(['lockEvent', id]), { _id: id, status: 'locked' });
    eventService.markDone = async (id) => (calls.push(['markDone', id]), { _id: id, status: 'done' });
    let claimed = false;
    eventService.claimRemind = async (id) => (calls.push(['claimRemind', id]), !claimed && (claimed = true));
  });

  it('an idle minute does nothing and logs nothing', async () => {
    await eventsStep(client, NOW);
    assert.deepEqual(sink, []);
    assert.deepEqual(calls, []);
    assert.deepEqual(sent, []);
  });
  it('locks events past their deadline, redraws the card at once, logs event.lock by auto — and only those it really changed', async () => {
    due.locks = [makeEvent(), makeEvent({ _id: oid(8) })];
    eventService.lockEvent = async (id) => (id === EID ? { _id: id } : null); // the other one was locked by a manager meanwhile
    await eventsStep(client, NOW);
    assert.deepEqual(refreshed.map((a) => [a[1], a[2]]), [[EID, 0]]);
    assert.deepEqual(lines().map((l) => [l.ev, l.result, l.by, l.eid]), [['lock', 'locked', 'auto', EID]]);
    assert.equal(synced.length, 1);
  });
  it('reminds once: claims first, pings ✅ + ❓ only with exactly those users allowed, logs pinged', async () => {
    due.reminders = [makeEvent()];
    replies = [
      { discordId: sid(1), status: 'no' },
      { discordId: sid(2), status: 'maybe' },
      { discordId: sid(3), status: 'yes' },
    ];
    await eventsStep(client, NOW);
    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /^⏰ \*\*Tiệc bang\*\* bắt đầu <t:\d+:R>\. https:\/\/discord\.com\/channels\//);
    assert.ok(sent[0].content.includes(`<@${sid(3)}>`) && sent[0].content.includes(`<@${sid(2)}>`) && !sent[0].content.includes(`<@${sid(1)}>`));
    assert.deepEqual(sent[0].allowedMentions, { users: [sid(3), sid(2)] });
    assert.deepEqual(lines().map((l) => [l.ev, l.mode, l.pinged]), [['remind', 'auto', 2]]);
    // idempotent: the same due list again (a second tick / process) loses the claim and sends nothing
    await eventsStep(client, NOW);
    assert.equal(sent.length, 1);
    assert.equal(lines().length, 1);
  });
  it('a reminder with nobody to ping is logged with pinged 0 and sends nothing; a missing channel is a warning', async () => {
    due.reminders = [makeEvent()];
    replies = [{ discordId: sid(1), status: 'no' }];
    await eventsStep(client, NOW);
    assert.deepEqual(sent, []);
    assert.deepEqual(lines().map((l) => [l.pinged, l.reason]), [[0, 'nobody']]);
    sink.length = 0;
    due.reminders = [makeEvent({ channelId: null })];
    config.announceChannelId = null;
    eventService.claimRemind = async () => true;
    await eventsStep(client, NOW);
    assert.deepEqual(lines().map((l) => [l.reason, l.lvl]), [['no_channel', 'warn']]);
  });
  it('a reminder falls back to the announce channel when the event has none stored', async () => {
    due.reminders = [makeEvent({ channelId: null })];
    replies = [{ discordId: sid(3), status: 'yes' }];
    let fetched;
    client.channels.fetch = async (id) => ((fetched = id), { send: async (p) => sent.push(p) });
    await eventsStep(client, NOW);
    assert.equal(fetched, 'announce');
    assert.equal(sent.length, 1);
  });
  it('marks events done, redraws the card, logs event.done', async () => {
    due.finished = [makeEvent()];
    await eventsStep(client, NOW);
    assert.deepEqual(calls, [['markDone', EID]]);
    assert.deepEqual(refreshed.map((a) => [a[1], a[2]]), [[EID, 0]]);
    assert.deepEqual(lines().map((l) => l.ev), ['done']);
  });
  it('one failing event does not stop the others (step_error is logged)', async () => {
    due.locks = [makeEvent(), makeEvent({ _id: oid(8) })];
    eventService.lockEvent = async (id) => {
      if (id === EID) throw new Error('db blip');
      return { _id: id };
    };
    await eventsStep(client, NOW);
    assert.deepEqual(lines().map((l) => [l.ev, l.eid]), [['lock', oid(8)]]);
    assert.ok(sink.map((l) => JSON.parse(l)).some((l) => l.area === 'sched' && l.ev === 'step_error' && l.step === 'event_lock'));
  });
});

describe('pure schedule rules', () => {
  it('the reminder is due remindBeforeMinutes before the start; 0 = off', () => {
    assert.deepEqual(eventService.remindAtOf(makeEvent({ remindBeforeMinutes: 60 })), vn(2026, 10, 17, 19));
    assert.deepEqual(eventService.remindAtOf(makeEvent({ remindBeforeMinutes: 15 })), vn(2026, 10, 17, 19, 45));
    assert.equal(eventService.remindAtOf(makeEvent({ remindBeforeMinutes: 0 })), null);
  });
  it('an event is over 6 h after the start, or 1 h after its end', () => {
    assert.deepEqual(eventService.doneAtOf(makeEvent()), vn(2026, 10, 18, 2));
    assert.deepEqual(eventService.doneAtOf(makeEvent({ endAt: vn(2026, 10, 17, 22) })), vn(2026, 10, 17, 23));
  });
  it('canReply: open and not past the deadline', () => {
    assert.equal(eventService.canReply(makeEvent(), vn(2026, 10, 17, 18)), true);
    assert.equal(eventService.canReply(makeEvent(), vn(2026, 10, 17, 18, 1)), false);
    assert.equal(eventService.canReply(makeEvent({ status: 'locked' }), NOW), false);
  });
});

describe('router wiring', () => {
  it('the ev prefix reaches the events handler', async () => {
    const { routeInteraction } = require('../src/bot/interactions/router');
    const r = memberIx({
      inGuild: () => true,
      isChatInputCommand: () => false,
      isMessageComponent: () => true,
      isModalSubmit: () => false,
      customId: `ev:ls:${oid(99)}`,
    });
    await routeInteraction(r.i);
    assert.match(lastEdit(r.log), /không tồn tại/);
  });
});

describe('eventLog: the event area', () => {
  it('is a known area and the answer buttons log their status as the arg', () => {
    assert.ok(eventLog.AREAS.includes('event'));
    assert.deepEqual(eventLog.parseCustomId(`ev:rp:${EID}:maybe`), { action: 'ev:rp', arg: 'maybe', eid: EID });
  });
});


// ---------- category, minimum, long description, allowMaybe (pure UI) ----------

// A realistic announcement: numbered sections, bold, bullets, a minimum, prizes (~1.3k chars).
const SOLO_RULES = [
  '🏆 **GIẢI SOLO 1-1 — HUYẾT LONG PAN**',
  '',
  '**1. Thời gian**',
  '- Đăng ký đến tối thứ Tư 14/10.',
  '- Thi đấu thứ Sáu 16/10, 20:00 tại kênh thoại Sảnh Chính.',
  '',
  '**2. Điều kiện**',
  '- Giải đấu chỉ được tổ chức khi đạt tối thiểu 15 người đăng ký.',
  '- Thành viên bang, đã liên kết tên trong game.',
  '',
  '**3. Thể lệ**',
  '- Đấu loại trực tiếp, bốc thăm ngay trước giờ đấu.',
  '- Mỗi trận thắng 2/3 hiệp, không dùng vật phẩm hồi sinh.',
  '- Đến trễ 5 phút xử thua.',
  '',
  '**4. Giải thưởng**',
  '- Nhất: 2000 vàng + danh hiệu.',
  '- Nhì: 1000 vàng. Ba: 500 vàng.',
  '',
  '**5. Lưu ý**',
  ...Array.from({ length: 12 }, (_, i) => `- Quy định bổ sung số ${i + 1}: tôn trọng đối thủ, không chửi bới, không phá ngang.`),
].join('\n');

// n characters of line-structured text
const longText = (n) => {
  let out = '';
  for (let i = 1; out.length < n; i++) out += `${i}. Dòng luật số ${i}: người chơi phải tuân thủ quy định của ban tổ chức.\n`;
  return out.slice(0, n);
};

describe('event card: category, minimum, rules', () => {
  const card = (event, counts = COUNTS) => assertV2Message(buildEventCard(event, counts));
  const ids = (v2) => v2.buttons.map((b) => b.custom_id);
  const labelsOf = (v2) => v2.buttons.map((b) => b.label);

  it('every category puts its emoji in the title and a small line under it', () => {
    for (const [key, c] of Object.entries(defaults.eventCategories)) {
      const v2 = card(makeEvent({ title: 'Giải Solo 1-1', category: key }));
      assert.ok(v2.text.includes(`### ${c.emoji} Giải Solo 1-1\n-# ${c.emoji} ${c.label}`), key);
    }
    const pvp = card(makeEvent({ title: 'Giải Solo 1-1', category: 'pvp' })).text;
    assert.match(pvp, /### ⚔️ Giải Solo 1-1/);
    assert.match(pvp, /-# ⚔️ PvP \/ thi đấu/);
  });
  it('no category (an old event) is Khác 📦; a cancelled card strikes the title through with the emoji', () => {
    const old = makeEvent();
    delete old.category;
    assert.match(card(old).text, /### 📦 Tiệc bang\n-# 📦 Khác/);
    assert.match(card(makeEvent({ category: 'music', status: 'cancelled' })).text, /### ~~🎤 Tiệc bang~~\n-# 🎤 Văn nghệ \/ hát/);
  });
  it('the minimum: "9/32 tham gia · cần ít nhất 15" and "Còn thiếu 6 người" while short and open', () => {
    const v2 = card(makeEvent({ capacity: 32, minParticipants: 15 }), { yes: 9, maybe: 3, no: 1 });
    assert.ok(v2.text.includes('✅ **9**/32 tham gia · cần ít nhất 15 · ❓ 3 có thể · ❌ 1 không'));
    assert.ok(v2.text.includes('⚠️ Còn thiếu 6 người'));
    assert.ok(!v2.text.includes('Đã đủ tối thiểu'));
    assert.ok(card(makeEvent({ minParticipants: 15 }), { yes: 14, maybe: 0, no: 0 }).text.includes('⚠️ Còn thiếu 1 người'));
  });
  it('the minimum reached: "Đã đủ tối thiểu", no warning', () => {
    for (const yes of [15, 40]) {
      const v2 = card(makeEvent({ capacity: 32, minParticipants: 15 }), { yes, maybe: 0, no: 0 });
      assert.ok(v2.text.includes('✅ Đã đủ tối thiểu'), String(yes));
      assert.ok(!v2.text.includes('Còn thiếu'));
    }
  });
  it('no minimum: no minimum text at all; short but not open: no warning', () => {
    const none = card(makeEvent()).text;
    assert.ok(!none.includes('cần ít nhất') && !none.includes('Còn thiếu') && !none.includes('Đã đủ tối thiểu'));
    const locked = card(makeEvent({ status: 'locked', minParticipants: 15 }), { yes: 9, maybe: 0, no: 0 }).text;
    assert.ok(locked.includes('cần ít nhất 15'));
    assert.ok(!locked.includes('Còn thiếu'));
  });
  it('allowMaybe off: no ❓ button, the counts line drops ❓; on / unset: the button stays', () => {
    const off = card(makeEvent({ allowMaybe: false, minParticipants: 15 }));
    assert.deepEqual(ids(off), [`ev:rp:${EID}:yes`, `ev:rp:${EID}:no`, `ev:ls:${EID}`]);
    assert.ok(off.text.includes('✅ **12** tham gia · cần ít nhất 15 · ❌ 5 không'));
    assert.ok(!off.text.includes('❓'));
    assert.ok(ids(card(makeEvent({ allowMaybe: true }))).includes(`ev:rp:${EID}:maybe`));
    assert.ok(ids(card(makeEvent())).includes(`ev:rp:${EID}:maybe`), 'unset = on');
  });
  it('an existing ❓ still counts in the list when ❓ is off', () => {
    const [text] = buildListMessages(makeEvent({ allowMaybe: false }), [{ discordId: sid(2), displayName: 'Bình', status: 'maybe' }]);
    assert.match(text, /❓ \*\*Có thể\*\* \(1\): Bình/);
  });
  it('a ~1100+ char announcement fits whole: line breaks and markdown kept, no cut, no 📋 Thể lệ', () => {
    assert.ok(SOLO_RULES.length > 1100 && SOLO_RULES.length < 2000, String(SOLO_RULES.length));
    const v2 = card(makeEvent({ title: 'Giải Solo 1-1', category: 'pvp', description: SOLO_RULES, minParticipants: 15, capacity: 32 }), { yes: 9, maybe: 2, no: 1 });
    assert.ok(v2.text.includes('**1. Thời gian**\n- Đăng ký đến tối thứ Tư 14/10.\n- Thi đấu thứ Sáu'));
    assert.ok(v2.text.includes('- Giải đấu chỉ được tổ chức khi đạt tối thiểu 15 người đăng ký.'));
    assert.ok(!v2.text.includes(RULES_HINT));
    assert.ok(!ids(v2).some((id) => id.startsWith('ev:rules:')));
    assert.ok(v2.text.includes('⚠️ Còn thiếu 6 người'));
  });
  it('a 4000-char description is cut to fit the V2 budget, says so, and adds 📋 Thể lệ', () => {
    const description = longText(4000);
    const v2 = card(makeEvent({ title: 'T'.repeat(100), description, category: 'pvp', capacity: 1000, minParticipants: 1000, endAt: vn(2026, 10, 17, 23) }));
    assert.ok(v2.text.length <= 4000);
    assert.ok(v2.text.includes(RULES_HINT));
    assert.ok(ids(v2).includes(`ev:rules:${EID}`));
    assert.ok(labelsOf(v2).includes('📋 Thể lệ'));
    const shown = v2.texts[0].split('\n').slice(2).join('\n').replace(RULES_HINT, '');
    assert.ok(shown.length > 2500, 'most of it is still shown');
    assert.ok(description.startsWith(shown.trimEnd()), 'the shown part is the beginning of the text');
    assert.ok(v2.texts[0].endsWith(RULES_HINT));
    assert.equal(v2.json[0].components.find((c) => c.type === 1).components.length, 5, 'four buttons + Thể lệ = one full row');
  });
  it('the card is within the budget at every description length, and the hint and the button always go together', () => {
    for (const n of [0, 1, 1100, 2500, 3000, 3300, 3500, 3600, 3700, 3800, 3900, 3950, 4000]) {
      for (const extra of [{}, { allowMaybe: false }, { capacity: 1000, minParticipants: 15, endAt: vn(2026, 10, 17, 23) }]) {
        const v2 = card(makeEvent({ title: 'T'.repeat(100), description: n ? longText(n) : '', ...extra }));
        assert.equal(v2.text.includes(RULES_HINT), ids(v2).includes(`ev:rules:${EID}`), `${n} ${JSON.stringify(extra)}`);
        assert.ok(v2.text.length <= 4000 - 50, `${n}: ${v2.text.length}`);
      }
    }
    assert.equal(card(makeEvent({ description: 'a'.repeat(100) })).text.includes(RULES_HINT), false);
  });
  it('a cut inside a code block closes it; a cut never splits an emoji', () => {
    const fence = fitDescription(`\`\`\`\n${'x\n'.repeat(3000)}`, 500);
    assert.equal(fence.truncated, true);
    assert.equal((fence.text.match(/```/g) || []).length % 2, 0);
    const emoji = fitDescription('😀'.repeat(2000), 500);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji.text) && !/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emoji.text));
    assert.ok(emoji.text.length <= 500);
  });
  it('the description is defanged on the card: no @everyone / @here / user / role / channel mention, no masked link; markdown stays', () => {
    const description = '**Quan trọng** @everyone @here <@123456789012345678> <@!1234> <@&987654321098765432> <#555> [bấm vào đây](https://evil.example/x) và https://discord.gg/abc\n- gạch đầu dòng';
    const v2 = card(makeEvent({ description }));
    const text = v2.texts[0];
    assert.ok(!/@everyone|@here/.test(text), 'no live mass mention');
    assert.ok(!/<@[!&]?\d/.test(text) && !/<#\d/.test(text), 'no live user / role / channel mention');
    assert.ok(!/\]\(/.test(text), 'no masked link');
    assert.ok(text.includes('**Quan trọng**') && text.includes('\n- gạch đầu dòng'));
    assert.ok(text.includes('https://discord.gg/abc'), 'a bare link is just text');
  });
  it('📋 Thể lệ: the whole description in messages of at most 1900 chars, nothing lost, defanged', () => {
    const description = `${longText(3900)}\n@everyone <@&123456789012345678>`;
    const messages = buildRulesMessages(makeEvent({ description }));
    assert.ok(messages.length >= 2);
    for (const m of messages) assert.ok(m.length <= 1900, `message of ${m.length}`);
    const joined = messages.join('\n');
    assert.ok(joined.startsWith('📋 **Thể lệ: Tiệc bang**\n1. Dòng luật số 1'));
    assert.ok(joined.includes('Dòng luật số 50:'), 'the part the card cuts is here');
    assert.ok(!/@everyone/.test(joined) && !/<@&\d/.test(joined));
    assert.match(buildRulesMessages(makeEvent({ description: '' }))[0], /chưa có mô tả/);
  });
  it('📋 Thể lệ: one very long line is cut at the limit, in pieces that join back', () => {
    const line = 'a'.repeat(5000);
    const [first, ...rest] = buildRulesMessages(makeEvent({ title: 'x', description: line }));
    assert.equal(first, "📋 **Thể lệ: x**");
    assert.ok(rest.every((m) => m.length <= 1900));
    assert.equal(rest.join("").length, 5000);
  });
});

describe('buildEventPreview', () => {
  const draftEvent = (extra = {}) => ({ _id: 'preview', guildId: GUILD, title: 'Giải Solo 1-1', category: 'pvp', description: 'Thể lệ', startAt: vn(2026, 10, 17, 20), endAt: null, deadlineAt: vn(2026, 10, 14, 22), capacity: 32, minParticipants: 15, ...extra });
  it('card (buttons off) + the four option buttons, with the state in the labels', () => {
    const v2 = assertV2Message(buildEventPreview({ event: draftEvent(), draftId: 'abcd1234', tag: true, allowMaybe: false }));
    assert.match(v2.text, /Xem trước · chưa đăng/);
    assert.deepEqual(v2.buttons.filter((b) => b.custom_id.startsWith('ev:dr')).map((b) => [b.custom_id, b.label]), [
      ['ev:drtag:abcd1234', '🔔 Tag role thành viên: bật'],
      ['ev:drmaybe:abcd1234', '❓ Có thể: tắt'],
      ['ev:drpost:abcd1234', '📢 Đăng'],
      ['ev:drcancel:abcd1234', 'Huỷ'],
    ]);
    assert.ok(!v2.buttons.some((b) => b.custom_id.endsWith(':maybe')), 'the card has no ❓ when it is off');
    for (const b of v2.buttons.filter((x) => x.custom_id.startsWith('ev:rp:') || x.custom_id.startsWith('ev:ls:'))) assert.equal(b.disabled, true);
  });
  it('without a member role the tag button is off, the state reads "tắt" even if the draft says on, and the hint says why', () => {
    const v2 = assertV2Message(buildEventPreview({ event: draftEvent(), draftId: 'abcd1234', tag: true, hasRole: false }));
    const tag = v2.buttons.find((b) => b.custom_id === 'ev:drtag:abcd1234');
    assert.equal(tag.disabled, true);
    assert.equal(tag.label, '🔔 Tag role thành viên: tắt');
    assert.match(v2.text, /Chưa chọn role thành viên/);
  });
  it('note shows at the top; a 4000-char description plus every option still fits one V2 message', () => {
    const v2 = assertV2Message(buildEventPreview({ event: draftEvent({ description: longText(4000), title: 'T'.repeat(100), endAt: vn(2026, 10, 17, 23) }), draftId: 'abcd1234', hasRole: false, note: '❌ Không đăng được thẻ vào <#123456789012345678>. Kiểm tra quyền của bot (Xem kênh, Gửi tin nhắn).' }));
    assert.match(v2.texts[0], /^### 👁️ Xem trước · chưa đăng\n❌ Không đăng được/);
    assert.ok(v2.text.includes(RULES_HINT));
  });
});

describe('manager view: category, shortfall, ❓ toggle', () => {
  const short = makeEvent({ category: 'pvp', minParticipants: 15, capacity: 32 });
  const counts = new Map([[EID, { yes: 9, maybe: 2, no: 1 }]]);
  const view = (opts) => assertV2Message(buildEventsView({ events: [short], counts, ...opts }));
  it('the list shows the category emoji and the shortfall', () => {
    const v2 = view();
    assert.match(v2.text, /• ⚔️ \[Tiệc bang\]\(https:\/\/discord\.com\/channels\/\d+\/chan\/msg-1\) · .* · ✅ 9\/32 · ❓ 2 · ❌ 1 · ⚠️ thiếu 6/);
    const select = v2.json[0].components.find((c) => c.type === 1 && c.components[0].type === 3).components[0];
    assert.ok(select.options[0].label.startsWith('⚔️ Tiệc bang'));
  });
  it('a reached minimum shows no shortfall', () => {
    const v2 = assertV2Message(buildEventsView({ events: [short], counts: new Map([[EID, { yes: 15, maybe: 0, no: 0 }]]) }));
    assert.ok(!v2.text.includes('thiếu'));
  });
  it('the selected event shows its category, the minimum and the shortfall; the ❓ toggle sits next to 📋 Danh sách', () => {
    const v2 = view({ selectedId: EID });
    assert.ok(v2.text.includes('⚔️ PvP / thi đấu'));
    assert.ok(v2.text.includes('cần ít nhất 15'));
    assert.ok(v2.text.includes('⚠️ Còn thiếu 6 người'));
    assert.ok(v2.buttons.some((b) => b.custom_id === `ev:maybe:${EID}` && b.label === '❓ Có thể: bật'));
    const off = assertV2Message(buildEventsView({ events: [{ ...short, allowMaybe: false }], counts, selectedId: EID }));
    assert.ok(off.buttons.some((b) => b.custom_id === `ev:maybe:${EID}` && b.label === '❓ Có thể: tắt'));
    const locked = assertV2Message(buildEventsView({ events: [{ ...short, status: 'locked' }], counts, selectedId: EID }));
    assert.ok(locked.text.includes('⚠️ Còn thiếu 6 người'), 'the manager sees the shortfall of a locked event too');
  });
});

describe('shortfall notice card (buildMinNotice)', () => {
  it('title, numbers, deadline passed, link and the three buttons; no mention can ping', () => {
    const v2 = assertV2Message(buildMinNotice(makeEvent({ minParticipants: 15, deadlineAt: vn(2026, 10, 14, 22) }), { yes: 9, maybe: 2, no: 1 }));
    assert.match(v2.text, /### ⚠️ Sự kiện chưa đủ người: Tiệc bang/);
    assert.ok(v2.text.includes(`✅ 9 / cần 15 · hạn đã hết ${discordTs(vn(2026, 10, 14, 22), 'R')}`));
    assert.ok(v2.text.includes(`https://discord.com/channels/${GUILD}/chan/msg-1`));
    assert.deepEqual(v2.buttons.map((b) => [b.custom_id, b.label]), [[`ev:mincancel:${EID}`, '❌ Huỷ sự kiện'], [`ev:minext:${EID}`, '⏳ Gia hạn'], [`ev:minkeep:${EID}`, '✅ Vẫn tổ chức']]);
  });
  it('a decision replaces the buttons; a title cannot mention anybody', () => {
    const v2 = assertV2Message(buildMinNotice(makeEvent({ minParticipants: 15, title: '@everyone <@999> [x](http://e.x)' }), { yes: 9, maybe: 0, no: 0 }, '❌ Đã huỷ sự kiện · <@1>'));
    assert.deepEqual(v2.buttons, []);
    assert.ok(v2.text.includes('**❌ Đã huỷ sự kiện · <@1>**'));
    assert.ok(!/@everyone/.test(v2.text) && !v2.text.includes('<@999>') && !/\]\(/.test(v2.text));
    assert.ok(!v2.text.includes('hạn đã hết'));
  });
});

describe('eventService: minimum helpers', () => {
  it('shortfallOf: 0 without a minimum or once reached', () => {
    assert.equal(eventService.shortfallOf({ minParticipants: 15 }, { yes: 9 }), 6);
    assert.equal(eventService.shortfallOf({ minParticipants: 15 }, { yes: 15 }), 0);
    assert.equal(eventService.shortfallOf({ minParticipants: null }, { yes: 0 }), 0);
    assert.equal(eventService.shortfallOf({}, { yes: 0 }), 0);
  });
  it('categoryOf falls back to Khác for a missing / unknown key', () => {
    assert.equal(eventService.categoryOf({ category: 'pve' }).emoji, '🐉');
    assert.equal(eventService.categoryOf({}).key, 'other');
    assert.equal(eventService.categoryOf({ category: 'zzz' }).label, 'Khác');
  });
});

// ---------- handlers: rules, ❓ off, ❓ toggle, edit re-arms the notice ----------

describe('ev:rules (the full description)', () => {
  it('ephemeral, split over messages, nothing allowed to mention', async () => {
    ev = makeEvent({ description: `${longText(3800)}\n@everyone` });
    const r = memberIx();
    await events.handle(r.i, ['ev', 'rules', EID]);
    assert.equal(r.log[0][0], 'deferReply');
    assert.equal(r.log[0].length, 1);
    const edits = r.log.filter((l) => l[0] === 'editReply' || l[0] === 'followUp');
    assert.ok(edits.length >= 3);
    for (const [kind, payload] of edits) {
      assert.ok(payload.content.length <= 2000);
      assert.deepEqual(payload.allowedMentions, { parse: [] });
      if (kind === 'followUp') assert.ok(payload.flags, 'follow-ups are ephemeral');
    }
    assert.ok(!edits.some(([, p]) => /@everyone/.test(p.content)));
  });
  it('an unknown event / one of another guild is "không tồn tại"', async () => {
    const r = memberIx();
    await events.handle(r.i, ['ev', 'rules', oid(99)]);
    assert.match(lastEdit(r.log), /không tồn tại/);
  });
});

describe('ev:rp with ❓ turned off', () => {
  it('a new ❓ is refused with a hint, nothing is written; ✅ still works', async () => {
    ev = makeEvent({ allowMaybe: false });
    let r = memberIx();
    await events.handle(r.i, ['ev', 'rp', EID, 'maybe']);
    assert.match(lastEdit(r.log), /không có lựa chọn "Có thể"/);
    assert.ok(!calls.some((c) => c[0] === 'setReply'));
    assert.equal(lines()[0].result, 'no_maybe');
    r = memberIx();
    await events.handle(r.i, ['ev', 'rp', EID, 'yes']);
    assert.ok(calls.some((c) => c[0] === 'setReply'));
  });
});

describe('ev:maybe (the manager toggles ❓)', () => {
  const click = async (extra) => {
    const r = interaction(extra);
    await events.handle(r.i, ['ev', 'maybe', EID]);
    return r;
  };
  it('on -> off -> on: saves allowMaybe, redraws the card at once, logs, tells what happened', async () => {
    let r = await click();
    assert.deepEqual(calls.find((c) => c[0] === 'updateEvent').slice(1, 2), [{ allowMaybe: false }]);
    assert.deepEqual(refreshed.map((a) => a[2]), [0]);
    assert.match(JSON.stringify(lastEdit(r.log)), /Có thể: \*\*tắt\*\*/);
    assert.deepEqual([lines()[0].ev, lines()[0].changed, lines()[0].allowMaybe], ['edit', ['allowMaybe'], false]);
    ev = makeEvent({ allowMaybe: false });
    calls.length = 0;
    r = await click();
    assert.deepEqual(calls.find((c) => c[0] === 'updateEvent').slice(1, 2), [{ allowMaybe: true }]);
    assert.match(JSON.stringify(lastEdit(r.log)), /Có thể: \*\*bật\*\*/);
  });
  it('a finished event / a lost race changes nothing; a non-manager is refused', async () => {
    ev = makeEvent({ status: 'done' });
    assert.match(JSON.stringify(lastEdit((await click()).log)), /không sửa được/);
    ev = makeEvent();
    eventService.updateEvent = async () => null;
    assert.match(JSON.stringify(lastEdit((await click()).log)), /vừa thay đổi/);
    const no = memberIx();
    await events.handle(no.i, ['ev', 'maybe', EID]);
    assert.deepEqual(no.log.map((l) => l[0]), ['deferUpdate', 'followUp']);
  });
});

describe('edit: category and minimum', () => {
  const submit = async (values) => {
    const r = interaction({ ...fieldsOf({ title: 'Tiệc bang', description: 'Gặp mặt cuối tuần', time: '17/10 20:00 | hạn 17/10 18:00', ...values }), isFromMessage: () => true });
    await events.handle(r.i, ['ev', 'editModal', EID]);
    return r;
  };
  it('saves category / min / max together and logs what changed', async () => {
    await submit({ category: 'mind', people: '10-20' });
    const upd = calls.find((c) => c[0] === 'updateEvent');
    assert.deepEqual([upd[1].category, upd[1].minParticipants, upd[1].capacity], ['mind', 10, 20]);
    assert.deepEqual(lines()[0].changed, ['category', 'capacity', 'minParticipants']);
  });
  it('a changed minimum clears minNoticeAt (it is judged again at the deadline); an unchanged one leaves it', async () => {
    ev = makeEvent({ minParticipants: 15, minNoticeAt: vn(2026, 10, 14, 22) });
    await submit({ people: '12-' });
    assert.equal(calls.find((c) => c[0] === 'updateEvent')[1].minNoticeAt, null);
    calls.length = 0;
    await submit({ people: '15-' });
    assert.ok(!('minNoticeAt' in calls.find((c) => c[0] === 'updateEvent')[1]));
  });
  it('min above max is refused, nothing saved', async () => {
    const r = await submit({ people: '30-10' });
    assert.match(JSON.stringify(lastEdit(r.log)), /không được lớn hơn/);
    assert.ok(!calls.some((c) => c[0] === 'updateEvent'));
  });
});

// ---------- the shortfall notice: scheduler step ----------

describe('scheduler: shortfall notice (minimum participants)', () => {
  let due;
  let client;
  let fetched;
  let claimed;
  beforeEach(() => {
    due = { mins: [], locks: [] };
    sent = [];
    fetched = [];
    claimed = new Set();
    config.adminChannelId = 'admin-chan';
    const channel = { id: 'admin-chan', send: async (p) => sent.push(p) };
    client = { channels: { fetch: async (id) => (fetched.push(id), channel) } };
    eventService.findDueLocks = async () => due.locks;
    eventService.findDueReminders = async () => [];
    eventService.findFinished = async () => [];
    eventService.lockEvent = async (id) => (calls.push(['lockEvent', id]), { _id: id, status: 'locked' });
    eventService.findDueMinNotices = async () => due.mins;
    eventService.claimMinNotice = async (id, now) => {
      calls.push(['claimMinNotice', id, now]);
      if (claimed.has(String(id))) return false;
      claimed.add(String(id));
      return true;
    };
  });
  const short = (extra = {}) => makeEvent({ minParticipants: 15, deadlineAt: vn(2026, 10, 13, 9, 59), ...extra }); // counts: 12 ✅

  it('short at the deadline: ONE notice in the ADMIN channel (V2, no mentions) with the numbers, the link and the buttons; logged', async () => {
    due.mins = [short()];
    await eventsStep(client, NOW);
    assert.deepEqual(fetched, ['admin-chan']);
    assert.equal(sent.length, 1);
    const v2 = assertV2Message(sent[0], { forCreate: true });
    assert.match(v2.text, /### ⚠️ Sự kiện chưa đủ người: Tiệc bang/);
    assert.ok(v2.text.includes(`✅ 12 / cần 15 · hạn đã hết ${discordTs(vn(2026, 10, 13, 9, 59), 'R')}`));
    assert.ok(v2.text.includes(`https://discord.com/channels/${GUILD}/chan/msg-1`));
    assert.deepEqual(v2.buttons.map((b) => b.custom_id), [`ev:mincancel:${EID}`, `ev:minext:${EID}`, `ev:minkeep:${EID}`]);
    assert.deepEqual(sent[0].allowedMentions, { parse: [] });
    assert.deepEqual(calls.find((c) => c[0] === 'claimMinNotice').slice(1), [EID, NOW]);
    const l = lines()[0];
    assert.deepEqual([l.ev, l.result, l.yes, l.min, l.eid, l.channel], ['min_notice', 'posted', 12, 15, EID, 'admin-chan']);
  });
  it('claimed once: the same due event on the next tick / a second process sends nothing more', async () => {
    due.mins = [short()];
    await eventsStep(client, NOW);
    await eventsStep(client, NOW);
    await Promise.all([eventsStep(client, NOW), eventsStep(client, NOW)]);
    assert.equal(sent.length, 1);
    assert.equal(lines().filter((l) => l.ev === 'min_notice').length, 1);
  });
  it('only when short: a reached minimum posts nothing, is claimed (not judged every minute) and is logged as skipped', async () => {
    due.mins = [short({ minParticipants: 12 })];
    await eventsStep(client, NOW);
    await eventsStep(client, NOW);
    assert.deepEqual(sent, []);
    assert.equal(calls.filter((c) => c[0] === 'claimMinNotice').length, 2, 'asked each tick, claimed once');
    assert.deepEqual(lines().map((l) => [l.ev, l.result, l.reason, l.yes, l.min]), [['min_notice', 'skipped', 'reached', 12, 12]]);
  });
  it('no admin channel: nothing claimed, sent or logged (it comes once a channel is chosen)', async () => {
    config.adminChannelId = null;
    due.mins = [short()];
    await eventsStep(client, NOW);
    assert.deepEqual(sent, []);
    assert.ok(!calls.some((c) => c[0] === 'claimMinNotice'));
    assert.deepEqual(lines(), []);
  });
  it('a failing send is logged (warn) and not retried every minute', async () => {
    client.channels.fetch = async () => {
      throw new Error('Missing Access');
    };
    due.mins = [short()];
    await eventsStep(client, NOW);
    await eventsStep(client, NOW);
    assert.deepEqual(lines().map((l) => [l.result, l.reason, l.lvl]), [['skipped', 'post_failed', 'warn']]);
  });
  it('no mention in the text can ping: a nasty title is defanged and the payload allows nothing', async () => {
    due.mins = [short({ title: '@everyone @here <@999> <@&888> [x](http://e.x)' })];
    await eventsStep(client, NOW);
    const text = assertV2Message(sent[0], { forCreate: true }).text;
    assert.ok(!/@everyone|@here/.test(text) && !/<@[!&]?\d/.test(text) && !/\]\(/.test(text));
    assert.deepEqual(sent[0].allowedMentions, { parse: [] });
  });
  it('the lock comes first in the same tick, then the notice; a failing event does not stop the next one', async () => {
    due.locks = [short()];
    due.mins = [short(), short({ _id: oid(8) })];
    const countsOf = eventService.countsOf;
    eventService.countsOf = async (id) => {
      if (id === EID) throw new Error('db blip');
      return COUNTS;
    };
    try {
      await eventsStep(client, NOW);
    } finally {
      eventService.countsOf = countsOf;
    }
    const order = calls.map((c) => c[0]);
    assert.ok(order.indexOf('lockEvent') < order.indexOf('claimMinNotice'));
    assert.equal(sent.length, 1);
    assert.match(JSON.stringify(sent[0]), new RegExp(oid(8)));
    assert.ok(sink.map((l) => JSON.parse(l)).some((l) => l.area === 'sched' && l.step === 'event_min'));
  });
});

// ---------- the shortfall notice: buttons ----------

describe('shortfall notice buttons (admin channel)', () => {
  beforeEach(() => {
    ev = makeEvent({ minParticipants: 15 });
    config.adminChannelId = 'admin-chan';
    eventService.extendEvent = async (id, deadline) => (calls.push(['extendEvent', id, deadline]), { ...ev, status: 'open', deadlineAt: deadline, minNoticeAt: null });
  });
  const press = async (action, extra = {}) => {
    const r = interaction({ message: {}, ...extra });
    await events.handle(r.i, ['ev', action, EID]);
    return r;
  };

  it('❌ Huỷ sự kiện: reuses the cancel flow (card grey at once, public notice without mentions) and the notice shows who decided', async () => {
    const r = await press('mincancel');
    assert.deepEqual(r.log.map((l) => l[0]), ['deferUpdate', 'editReply']);
    assert.ok(calls.some((c) => c[0] === 'cancelEvent'));
    assert.equal(cardNow.length, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /^❌ Sự kiện \*\*Tiệc bang\*\* đã huỷ\.$/);
    assert.deepEqual(sent[0].allowedMentions, { parse: [] });
    const v2 = assertV2Message(lastEdit(r.log));
    assert.match(v2.text, new RegExp(`❌ Đã huỷ sự kiện · <@${ADMIN}> quyết định <t:\\d+:R>`));
    assert.deepEqual(v2.buttons, [], 'the buttons are gone');
    assert.equal(synced.length, 1);
    assert.deepEqual(lines().map((l) => [l.ev, l.via, l.decision, l.result]).filter((x) => x[0] !== undefined), [['cancel', 'min_notice', undefined, undefined], ['min_decision', undefined, 'cancel', 'ok']]);
  });
  it('❌ with a failing public notice still cancels and says it', async () => {
    const r = await press('mincancel', { client: { channels: { fetch: async () => { throw new Error('Missing Access'); } } } });
    assert.match(assertV2Message(lastEdit(r.log)).text, /chưa báo được trong kênh/);
    assert.equal(lines().find((l) => l.ev === 'min_decision').notice, 'failed');
  });
  it('✅ Vẫn tổ chức: only marks the notice handled; the event is untouched', async () => {
    const r = await press('minkeep');
    assert.match(assertV2Message(lastEdit(r.log)).text, new RegExp(`✅ Vẫn tổ chức · <@${ADMIN}>`));
    assert.deepEqual(assertV2Message(lastEdit(r.log)).buttons, []);
    assert.deepEqual(calls, []);
    assert.deepEqual(sent, []);
    assert.deepEqual(lines().map((l) => [l.ev, l.decision, l.result]), [['min_decision', 'keep', 'ok']]);
  });
  it('⏳ Gia hạn: opens the deadline modal for a live event; a finished one is refused', async () => {
    const r = await press('minext');
    assert.equal(r.log[0][0], 'showModal');
    assert.equal(r.log[0][1].toJSON().custom_id, `ev:minextModal:${EID}`);
    ev = makeEvent({ status: 'cancelled' });
    const no = await press('minext');
    assert.equal(no.log[0][0], 'reply');
    assert.match(no.log[0][1].content, /không gia hạn được/);
  });
  describe('the extend modal', () => {
    const submit = async (deadline, extra = {}) => {
      const r = interaction({ ...fieldsOf({ deadline }), isFromMessage: () => true, ...extra });
      await events.handle(r.i, ['ev', 'minextModal', EID]);
      return r;
    };
    beforeEach(() => {
      mock.timers.enable({ apis: ['Date'], now: NOW.getTime() });
      ev = makeEvent({ status: 'locked', minParticipants: 15, minNoticeAt: vn(2026, 10, 13, 9, 59), deadlineAt: vn(2026, 10, 13, 9, 59) });
    });
    afterEach(() => mock.timers.reset());

    it('reopens the event with the new deadline, redraws the card, syncs, and edits the notice to "đã gia hạn tới … · who"', async () => {
      const r = await submit('15/10 20:00');
      assert.deepEqual(calls.find((c) => c[0] === 'extendEvent'), ['extendEvent', EID, vn(2026, 10, 15, 20)]);
      assert.deepEqual(r.log.map((l) => l[0]), ['deferUpdate', 'editReply']);
      assert.equal(cardNow.length, 1);
      assert.equal(synced.length, 1);
      const v2 = assertV2Message(lastEdit(r.log));
      assert.ok(v2.text.includes(`⏳ Đã gia hạn tới ${discordTs(vn(2026, 10, 15, 20), 'f')} · <@${ADMIN}>`));
      assert.deepEqual(v2.buttons, []);
      const l = lines().find((x) => x.ev === 'min_decision');
      assert.deepEqual([l.decision, l.result, l.deadline], ['extend', 'ok', vn(2026, 10, 15, 20).toISOString()]);
    });
    it('validates: garbage, a past time, the start itself, after the start — nothing changes, the clicker is told', async () => {
      for (const [text, error] of [['mai', /không hợp lệ/], ['12/10 10:00', /đã qua/], ['17/10 20:00', /trước giờ bắt đầu/], ['18/10 09:00', /trước giờ bắt đầu/], ['', /không hợp lệ/]]) {
        const r = await submit(text);
        assert.deepEqual(r.log.map((l) => l[0]), ['deferUpdate', 'followUp'], text);
        assert.match(r.log[1][1].content, error, text);
      }
      assert.ok(!calls.some((c) => c[0] === 'extendEvent'));
      assert.equal(cardNow.length, 0);
      assert.ok(lines().every((l) => l.result === 'invalid'));
    });
    it('a lost race / a cancelled event / an unknown event say so and change nothing', async () => {
      eventService.extendEvent = async () => null;
      assert.match((await submit('15/10 20:00')).log[1][1].content, /vừa thay đổi/);
      ev = makeEvent({ status: 'cancelled', minParticipants: 15 });
      assert.match((await submit('15/10 20:00')).log[1][1].content, /không gia hạn được/);
      ev = null;
      assert.match((await submit('15/10 20:00')).log[1][1].content, /không tồn tại/);
    });
    it('the modal submit is behind the admin gate', async () => {
      const r = memberIx({ ...fieldsOf({ deadline: '15/10 20:00' }), isFromMessage: () => true });
      await events.handle(r.i, ['ev', 'minextModal', EID]);
      assert.deepEqual(r.log.map((l) => l[0]), ['deferUpdate', 'followUp']);
      assert.match(r.log[1][1].content, /không có quyền/);
      assert.ok(!calls.some((c) => c[0] === 'extendEvent'));
    });
  });
  it('every notice button is behind the admin gate and touches nothing', async () => {
    for (const action of ['mincancel', 'minkeep']) {
      const r = memberIx({ message: {} });
      await events.handle(r.i, ['ev', action, EID]);
      assert.deepEqual(r.log.map((l) => l[0]), ['deferUpdate', 'followUp'], action);
      assert.match(r.log[1][1].content, /không có quyền/);
    }
    const r = memberIx({ message: {} });
    await events.handle(r.i, ['ev', 'minext', EID]);
    assert.deepEqual(r.log.map((l) => l[0]), ['reply'], 'no modal for a non-manager');
    assert.deepEqual(calls, []);
    assert.deepEqual(sent, []);
  });
  it('a click on a notice whose event is already over just closes the notice', async () => {
    ev = makeEvent({ status: 'cancelled', minParticipants: 15 });
    const r = await press('mincancel');
    assert.match(assertV2Message(lastEdit(r.log)).text, /đã huỷ, không cần xử lý nữa/);
    assert.ok(!calls.some((c) => c[0] === 'cancelEvent'));
  });
});

// ---------- the one-time role tag of the post ----------

describe('refresher.postEventCard: the role tag', () => {
  const run = async (event, opts) => {
    const msgs = [];
    const channel = { id: 'announce', send: async (p) => (msgs.push(p), { id: 'm9' }), messages: { delete: async () => {} } };
    const saved = eventService.setMessage;
    eventService.setMessage = async (...a) => calls.push(['setMessage', ...a]);
    try {
      const posted = await realPostEventCard({ channels: { fetch: async () => channel } }, 'announce', event, opts);
      return { msgs, posted };
    } finally {
      eventService.setMessage = saved;
    }
  };
  const textLength = (payload) => {
    let n = 0;
    const walk = (c) => {
      const j = typeof c.toJSON === 'function' ? c.toJSON() : c;
      if (j.type === 10) n += j.content.length;
      (j.components || []).forEach(walk);
    };
    payload.components.forEach(walk);
    return n;
  };

  it('tagged: a text line <@&role> on top and allowedMentions limited to THAT role (a V2 message has no content)', async () => {
    const { msgs, posted } = await run(makeEvent(), { tagRoleId: '123456789012345678' });
    assert.equal(msgs.length, 1);
    assert.ok(!('content' in msgs[0]));
    assert.deepEqual(msgs[0].allowedMentions, { roles: ['123456789012345678'] });
    const top = msgs[0].components.map((c) => c.toJSON());
    assert.equal(top[0].type, 10);
    assert.equal(top[0].content, '<@&123456789012345678>');
    assert.equal(top[1].type, 17, 'the card follows');
    assert.deepEqual([posted.channelId, posted.messageId], ['announce', 'm9']);
    assert.ok(calls.some((c) => c[0] === 'setMessage'));
  });
  it('not tagged (default): the plain card, nothing allowed', async () => {
    for (const opts of [undefined, {}, { tagRoleId: null }]) {
      const { msgs } = await run(makeEvent(), opts);
      assert.deepEqual(msgs[0].allowedMentions, { parse: [] });
      assert.equal(msgs[0].components.length, 1);
      assert.ok(!JSON.stringify(msgs[0]).includes('<@&'));
    }
  });
  it('even a 4000-char description plus the tag line stays within the 4000-char V2 text limit', async () => {
    const { msgs } = await run(makeEvent({ title: 'T'.repeat(100), description: longText(4000), capacity: 1000, minParticipants: 1000, endAt: vn(2026, 10, 17, 23) }), { tagRoleId: '123456789012345678' });
    assert.ok(textLength(msgs[0]) <= 4000, String(textLength(msgs[0])));
  });
  it('edits and refreshes never carry the tag: the card is rebuilt without it and allows nothing', () => {
    const edit = buildEventCard(makeEvent(), COUNTS);
    assert.ok(!JSON.stringify(edit).includes('<@&'));
    assert.deepEqual(edit.allowedMentions, { parse: [] });
  });
});


// ---------- the event channels and the persistent panel's buttons ----------

describe('event cards go to eventChannelId, else the announce channel', () => {
  const futureTime = () => `${formatLocalDateTime(new Date(Date.now() + 3 * 86400000)).split(' ')[0]} 20:00`;
  const draftId = async () => {
    const r = interaction({ ...fieldsOf({ title: 'Tiệc', category: 'other', description: '', time: futureTime(), people: '' }) });
    await events.handle(r.i, ['ev', 'newModal']);
    return JSON.stringify(lastEdit(r.log)).match(/ev:drpost:([0-9a-f]+)/)[1];
  };
  const post = async (id) => {
    const r = interaction();
    await events.handle(r.i, ['ev', 'drpost', id]);
    return r;
  };
  it('an event channel set: the new card is posted there', async () => {
    config.eventChannelId = 'ev-chan';
    await post(await draftId());
    assert.equal(postCalls.length, 1);
    assert.equal(postCalls[0].channelId, 'ev-chan');
  });
  it('not set: the announce channel', async () => {
    await post(await draftId());
    assert.equal(postCalls[0].channelId, 'announce');
  });
  it('neither channel: the form and the post are refused, nothing is created; the event channel alone is enough', async () => {
    const id = await draftId();
    config.announceChannelId = null;
    const r = await post(id);
    assert.match(JSON.stringify(lastEdit(r.log)), /Chưa chọn kênh thông báo sự kiện/);
    assert.ok(!calls.some((c) => c[0] === 'createEvent'));
    const form = interaction({ ...fieldsOf({ title: 'Tiệc', time: futureTime() }) });
    await events.handle(form.i, ['ev', 'newModal']);
    assert.match(JSON.stringify(lastEdit(form.log)), /Chưa chọn kênh thông báo sự kiện/);
    config.eventChannelId = 'ev-chan';
    await post(id); // the refused post put the draft back
    assert.equal(postCalls.length, 1);
    assert.equal(postCalls[0].channelId, 'ev-chan');
  });
  it('the cancel notice and the reminder go to the own channel of the event, not to eventChannelId', async () => {
    config.eventChannelId = 'ev-chan';
    const fetched = [];
    const channel = { send: async (p) => sent.push(p) };
    const client = { channels: { fetch: async (id) => (fetched.push(id), channel) } };
    const r = interaction({ client });
    await events.handle(r.i, ['ev', 'cancelok', EID]);
    assert.deepEqual(fetched, ['chan']);
    assert.match(sent[0].content, /đã huỷ/);
    fetched.length = 0;
    replies = [{ discordId: sid(1), status: 'yes' }];
    eventService.findDueReminders = async () => [makeEvent()];
    eventService.claimRemind = async () => true;
    eventService.findDueLocks = async () => [];
    eventService.findDueMinNotices = async () => [];
    eventService.findFinished = async () => [];
    await eventsStep(client, NOW);
    assert.deepEqual(fetched, ['chan']);
    assert.match(sent.at(-1).content, /bắt đầu/);
  });
});

describe('the persistent panel buttons (ev:pnew / ev:pmanage)', () => {
  const futureTime = () => `${formatLocalDateTime(new Date(Date.now() + 3 * 86400000)).split(' ')[0]} 20:00`;
  it('ev:pnew opens the create form with its own submit id; a non-manager gets a plain refusal', async () => {
    const r = interaction();
    await events.handle(r.i, ['ev', 'pnew']);
    assert.equal(r.log[0][0], 'showModal');
    assert.equal(r.log[0][1].toJSON().custom_id, 'ev:pnewModal');
    const no = memberIx();
    await events.handle(no.i, ['ev', 'pnew']);
    assert.deepEqual(no.log.map((l) => l[0]), ['reply']);
    assert.match(no.log[0][1].content, /không có quyền/);
  });
  it('ev:pnewModal comes from the panel message: still a NEW ephemeral reply (never an edit of the panel), then the usual preview', async () => {
    const r = interaction({ ...fieldsOf({ title: 'Tiệc', time: futureTime() }), isFromMessage: () => true });
    await events.handle(r.i, ['ev', 'pnewModal']);
    assert.deepEqual(r.log.map((l) => l[0]), ['deferReply', 'editReply']);
    assert.match(assertV2Message(lastEdit(r.log)).text, /Xem trước · chưa đăng/);
    assert.deepEqual(sent, [], 'nothing posted before 📢 Đăng');
    const no = memberIx({ ...fieldsOf({ title: 'Hack' }), isFromMessage: () => true });
    await events.handle(no.i, ['ev', 'pnewModal']);
    assert.match(JSON.stringify(no.log.at(-1)[1]), /không có quyền/);
    assert.ok(!calls.some((c) => c[0] === 'createEvent'));
  });
  it('ev:pmanage opens the existing manager view as a new ephemeral reply and logs it; a non-manager is refused', async () => {
    const r = interaction();
    await events.handle(r.i, ['ev', 'pmanage']);
    assert.deepEqual(r.log.map((l) => l[0]), ['deferReply', 'editReply']);
    const v2 = assertV2Message(lastEdit(r.log));
    assert.match(v2.text, /Quản lý sự kiện/);
    assert.ok(v2.buttons.some((b) => b.custom_id === 'ev:new'));
    assert.ok(lines().some((l) => l.ev === 'manage_open' && l.src === 'panel'));
    const no = memberIx();
    await events.handle(no.i, ['ev', 'pmanage']);
    assert.match(JSON.stringify(no.log.at(-1)[1]), /không có quyền/);
  });

});

describe('scheduler: the shortfall notice goes to eventAdminChannelId, else adminChannelId', () => {
  let fetched;
  let client;
  beforeEach(() => {
    fetched = [];
    const channel = { send: async (p) => sent.push(p) };
    client = { channels: { fetch: async (id) => (fetched.push(id), channel) } };
    eventService.findDueLocks = async () => [];
    eventService.findDueReminders = async () => [];
    eventService.findFinished = async () => [];
    eventService.findDueMinNotices = async () => [makeEvent({ minParticipants: 15, deadlineAt: vn(2026, 10, 13, 9, 59) })];
    eventService.claimMinNotice = async () => true;
  });
  it('the event management channel is preferred (and logged)', async () => {
    config.adminChannelId = 'admin-chan';
    config.eventAdminChannelId = 'ev-admin';
    await eventsStep(client, NOW);
    assert.deepEqual(fetched, ['ev-admin']);
    assert.equal(sent.length, 1);
    assert.equal(lines().find((l) => l.ev === 'min_notice').channel, 'ev-admin');
  });
  it('not set: the admin channel', async () => {
    config.adminChannelId = 'admin-chan';
    await eventsStep(client, NOW);
    assert.deepEqual(fetched, ['admin-chan']);
  });
  it('only the event management channel set (no admin channel): still sent', async () => {
    config.adminChannelId = null;
    config.eventAdminChannelId = 'ev-admin';
    await eventsStep(client, NOW);
    assert.deepEqual(fetched, ['ev-admin']);
  });
  it('neither: nothing sent', async () => {
    config.adminChannelId = null;
    await eventsStep(client, NOW);
    assert.deepEqual(sent, []);
  });
});

// ---------- review round: year boundary, stale drafts, reopen by edit, modal gate, small fixes ----------

describe('parseLocalDateTimeNear (the year closest to an anchor)', () => {
  const near = require('../src/utils/time').parseLocalDateTimeNear;
  it('picks the year that puts the date nearest the anchor, either side of New Year', () => {
    assert.deepEqual(near('30/12 18:00', vn(2027, 1, 10, 20)), vn(2026, 12, 30, 18));
    assert.deepEqual(near('10/01 20:00', vn(2026, 12, 30, 18)), vn(2027, 1, 10, 20));
    assert.deepEqual(near('17/10 20:00', vn(2026, 10, 13)), vn(2026, 10, 17, 20));
  });
  it('an explicit year is kept; garbage and 31/02 are null; 29/02 only in a leap year', () => {
    assert.deepEqual(near('30/12/2030 18:00', vn(2027, 1, 10)), vn(2030, 12, 30, 18));
    assert.equal(near('mai', vn(2027, 1, 10)), null);
    assert.equal(near('31/02 10:00', vn(2027, 1, 10)), null);
    assert.deepEqual(near('29/02 10:00', vn(2027, 3, 1)), vn(2028, 2, 29, 10));
  });
});

describe('edit form: the year boundary (the prefill has no year)', () => {
  const ok = (time, existing, now) => eventService.parseEventForm({ title: 'Tiệc', category: 'other', description: '', time, people: '' }, now, existing);
  it('an event made in December, edited on 02/01: the unchanged "30/12" deadline and "10/01" start keep their stored dates', () => {
    const existing = makeEvent({ startAt: vn(2027, 1, 10, 20), deadlineAt: vn(2026, 12, 30, 18) });
    const { value, error } = ok('10/01 20:00 | hạn 30/12 18:00', existing, vn(2027, 1, 2, 9));
    assert.equal(error, undefined);
    assert.equal(value.startAt.getTime(), existing.startAt.getTime());
    assert.equal(value.deadlineAt.getTime(), existing.deadlineAt.getTime());
  });
  it('a CHANGED deadline in the same event is read in the year nearest the start, not "this year"', () => {
    const existing = makeEvent({ startAt: vn(2027, 1, 10, 20), deadlineAt: vn(2026, 12, 30, 18) });
    const { value, error } = ok('10/01 20:00 | hạn 05/01 18:00', existing, vn(2027, 1, 2, 9));
    assert.equal(error, undefined);
    assert.deepEqual(value.deadlineAt, vn(2027, 1, 5, 18));
    assert.match(ok('10/01 20:00 | hạn 31/12 18:00', existing, vn(2027, 1, 2, 9)).error, /Hạn đăng ký đã qua/, 'December of last year, not December of the next');
  });
  it('a New Year Eve event edited after midnight keeps its date; a changed time on it is not silently moved to next year', () => {
    const existing = makeEvent({ startAt: vn(2026, 12, 31, 23), deadlineAt: vn(2026, 12, 31, 23), endAt: vn(2027, 1, 1, 1) });
    const now = vn(2027, 1, 1, 0, 30);
    const same = ok('31/12 23:00 - 01:00', existing, now);
    assert.equal(same.error, undefined);
    assert.equal(same.value.startAt.getTime(), existing.startAt.getTime());
    assert.equal(same.value.endAt.getTime(), existing.endAt.getTime());
    assert.match(ok('31/12 23:30', existing, now).error, /ở tương lai/);
  });
  it('a new event still uses the old rule (a past date typed in late December means next year)', () => {
    assert.deepEqual(ok('02/01 20:00', null, vn(2026, 12, 28, 9)).value.startAt, vn(2027, 1, 2, 20));
  });
  it('the handler keeps the stored dates on an edit made across New Year', async () => {
    mock.timers.enable({ apis: ['Date'], now: vn(2027, 1, 2, 9).getTime() });
    try {
      ev = makeEvent({ startAt: vn(2027, 1, 10, 20), deadlineAt: vn(2026, 12, 30, 18), status: 'locked' });
      const r = interaction({ ...fieldsOf({ title: 'Tiệc bang vui', description: 'Gặp mặt cuối tuần', time: '10/01 20:00 | hạn 30/12 18:00' }), isFromMessage: () => true });
      await events.handle(r.i, ['ev', 'editModal', EID]);
      const upd = calls.find((c) => c[0] === 'updateEvent');
      assert.equal(upd[1].startAt.getTime(), ev.startAt.getTime());
      assert.equal(upd[1].deadlineAt.getTime(), ev.deadlineAt.getTime());
      assert.deepEqual(upd[2], { startChanged: false });
      assert.ok(!('status' in upd[1]), 'the deadline did not change: a locked event stays locked');
    } finally {
      mock.timers.reset();
    }
  });
});

describe('M3: editing the deadline of a locked event', () => {
  const submit = async (time, now) => {
    mock.timers.enable({ apis: ['Date'], now: now.getTime() });
    try {
      const r = interaction({ ...fieldsOf({ title: 'Tiệc bang', description: 'Gặp mặt cuối tuần', time }), isFromMessage: () => true });
      await events.handle(r.i, ['ev', 'editModal', EID]);
      return r;
    } finally {
      mock.timers.reset();
    }
  };
  it('a new deadline still ahead reopens it and clears minNoticeAt (like ⏳ Gia hạn); the card is redrawn at once', async () => {
    ev = makeEvent({ status: 'locked', minParticipants: 15, minNoticeAt: vn(2026, 10, 17, 18, 5) });
    const r = await submit('17/10 20:00 | hạn 17/10 19:30', vn(2026, 10, 17, 19));
    const upd = calls.find((c) => c[0] === 'updateEvent');
    assert.equal(upd[1].status, 'open');
    assert.equal(upd[1].minNoticeAt, null);
    assert.deepEqual(upd[1].deadlineAt, vn(2026, 10, 17, 19, 30));
    assert.deepEqual(refreshed.map((a) => a[2]), [0]);
    assert.match(JSON.stringify(lastEdit(r.log)), /Đã mở lại/);
    assert.equal(lines()[0].reopened, true);
  });
  it('an untouched deadline leaves a locked event locked; an open event is never re-stamped', async () => {
    ev = makeEvent({ status: 'locked' });
    await submit('17/10 20:00 | hạn 17/10 18:00', vn(2026, 10, 17, 19));
    assert.ok(!('status' in calls.find((c) => c[0] === 'updateEvent')[1]));
    calls.length = 0;
    ev = makeEvent();
    await submit('17/10 20:00 | hạn 17/10 19:30', vn(2026, 10, 17, 17));
    assert.ok(!('status' in calls.find((c) => c[0] === 'updateEvent')[1]));
  });
});

describe('M2: a stale preview is re-validated before posting', () => {
  const inDays = (n, hhmm = '20:00') => `${formatLocalDateTime(new Date(Date.now() + n * 86400000)).split(' ')[0]} ${hhmm}`;
  const submit = async (time) => {
    const r = interaction({ ...fieldsOf({ title: 'Giải', category: 'pvp', description: '', time, people: '' }) });
    await events.handle(r.i, ['ev', 'newModal']);
    return JSON.stringify(lastEdit(r.log)).match(/ev:drpost:([0-9a-f]+)/)[1];
  };
  const click = async (action, id) => {
    const r = interaction();
    await events.handle(r.i, ['ev', action, id]);
    return r;
  };
  it('the deadline (or the start) passed while the preview was open: back to the preview with a note, nothing created, the draft kept', async () => {
    mock.timers.enable({ apis: ['Date'], now: NOW.getTime() });
    try {
      const id = await submit('13/10 10:14 | hạn 13/10 10:10');
      mock.timers.tick(11 * 60 * 1000); // 10:11 - the deadline is past, the start is not
      let r = await click('drpost', id);
      assert.match(JSON.stringify(lastEdit(r.log)), /Hạn đăng ký đã qua/);
      assert.ok(JSON.stringify(lastEdit(r.log)).includes('ev:drpost'), 'the preview is back');
      assert.ok(!calls.some((c) => c[0] === 'createEvent'));
      assert.deepEqual(postCalls, []);
      mock.timers.tick(4 * 60 * 1000); // 10:15 - now the start too
      r = await click('drpost', id);
      assert.match(JSON.stringify(lastEdit(r.log)), /Giờ bắt đầu đã qua/);
      assert.ok(!calls.some((c) => c[0] === 'createEvent'));
    } finally {
      mock.timers.reset();
    }
  });
  it('every preview interaction keeps the draft alive for 15 more minutes', async () => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    try {
      const id = await submit(`${inDays(3)} | hạn ${inDays(2, '18:00')}`);
      for (let n = 0; n < 3; n++) {
        mock.timers.tick(10 * 60 * 1000);
        assert.match(JSON.stringify(lastEdit((await click('drmaybe', id)).log)), /Xem trước/, `after ${(n + 1) * 10} min`);
      }
    } finally {
      mock.timers.reset();
    }
  });
});

describe('M5: the modal opens without waiting on a slow DB', () => {
  const nextTick = () => new Promise((r) => setImmediate(r));
  it('Manage Server opens the empty form without touching the config or the DB', async () => {
    configImpl = async () => {
      throw new Error('must not be called');
    };
    try {
      for (const [action, id] of [['new', 'ev:newModal'], ['pnew', 'ev:pnewModal']]) {
        const r = interaction();
        await events.handle(r.i, ['ev', action]);
        assert.deepEqual(r.log.map((l) => l[0]), ['showModal']);
        assert.equal(r.log[0][1].toJSON().custom_id, id);
      }
    } finally {
      configImpl = null;
    }
  });
  it('edit: the event is fetched with a deadline; a hung DB gives an ephemeral "bấm lại" instead of an expired interaction', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      eventService.getEvent = () => new Promise(() => {});
      const r = interaction();
      const done = events.handle(r.i, ['ev', 'edit', EID]);
      await nextTick();
      assert.deepEqual(r.log, [], 'still waiting');
      mock.timers.tick(1500);
      await done;
      assert.deepEqual(r.log.map((l) => l[0]), ['reply']);
      assert.match(r.log[0][1].content, /bấm lại/);
      assert.ok(!r.log.some((l) => l[0] === 'showModal'));
    } finally {
      mock.timers.reset();
    }
  });
  it('a manager role is judged from the config within the same budget; a slow config is "bấm lại", never a modal for the wrong person', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    configImpl = () => new Promise(() => {});
    try {
      const r = memberIx();
      const done = events.handle(r.i, ['ev', 'new']);
      await nextTick();
      mock.timers.tick(1500);
      await done;
      assert.deepEqual(r.log.map((l) => l[0]), ['reply']);
      assert.match(r.log[0][1].content, /bấm lại/);
    } finally {
      mock.timers.reset();
      configImpl = null;
    }
  });
  it('a fast DB: edit still opens the prefilled modal; a manager role (cached config) opens the form; a stranger is refused', async () => {
    let r = interaction();
    await events.handle(r.i, ['ev', 'edit', EID]);
    assert.equal(r.log[0][1].toJSON().custom_id, `ev:editModal:${EID}`);
    config.adminRoleIds = ['r-admin'];
    r = interaction({ member: { roles: ['r-admin'], permissions: NOBODY }, memberPermissions: NOBODY });
    await events.handle(r.i, ['ev', 'edit', EID]);
    assert.equal(r.log[0][0], 'showModal');
    r = memberIx();
    await events.handle(r.i, ['ev', 'edit', EID]);
    assert.match(r.log[0][1].content, /không có quyền/);
    assert.ok(!r.log.some((l) => l[0] === 'showModal'));
  });
});

describe('small review fixes (L1, L3, L4, L5)', () => {
  it('L1: a reminder message holds at most 90 users even when the text is short', () => {
    const ids = Array.from({ length: 200 }, (_, i) => String(1000 + i)); // short ids: the 90-user cap binds before the 1900 chars
    const messages = eventService.buildRemindMessages('hi', ids);
    assert.deepEqual(messages.map((m) => m.users.length), [90, 90, 20]);
    assert.deepEqual(messages.flatMap((m) => m.users), ids);
  });
  it('L3: the manual reminder goes to the event card channel, else the EVENT channel (not the war announce channel)', async () => {
    replies = [{ discordId: sid(3), status: 'yes' }];
    config.eventChannelId = 'ev-chan';
    ev = makeEvent({ channelId: null });
    const asked = [];
    const r = interaction({ client: { channels: { fetch: async (id) => (asked.push(id), { id, send: async (p) => sent.push(p) }) } } });
    await events.handle(r.i, ['ev', 'remindok', EID]);
    assert.deepEqual(asked, ['ev-chan']);
    ev = makeEvent({ channelId: 'card-chan' });
    await events.handle(interaction({ client: { channels: { fetch: async (id) => (asked.push(id), { id, send: async () => {} }) } } }).i, ['ev', 'remindok', EID]);
    assert.equal(asked[1], 'card-chan');
  });
  it('L4: the "full" reply suggests ❓ only when the event has it', async () => {
    eventService.setReply = async () => ({ ok: false, reason: 'full' });
    const answer = async () => {
      const ix = memberIx();
      await events.handle(ix.i, ['ev', 'rp', EID, 'yes']);
      return lastEdit(ix.log);
    };
    ev = makeEvent({ capacity: 20 });
    assert.match(await answer(), /❓ Có thể/);
    ev = makeEvent({ capacity: 20, allowMaybe: false });
    const text = await answer();
    assert.match(text, /Đã đủ 20 người/);
    assert.ok(!text.includes('❓'));
  });
  it('L5: a seat that could not be freed is still a saved answer, and is logged as a warning', async () => {
    eventService.setReply = async (a) => ({ ok: true, reply: a, seatFreed: false });
    const ix = memberIx();
    await events.handle(ix.i, ['ev', 'rp', EID, 'no']);
    assert.match(lastEdit(ix.log), /Đã ghi nhận/);
    assert.deepEqual([lines()[0].result, lines()[0].seat, lines()[0].lvl], ['ok', 'not_freed', 'warn']);
  });
});

describe('H1: the shortfall notice also fires when the deadline equals the start', () => {
  before(setupDb);
  it('findDueMinNotices: deadline <= now, a minimum, no notice yet, and not started MORE than the grace window ago (startAt > now - 1 h)', async () => {
    await resetDb();
    await db.q('insert into guilds (id) values ($1)', [GUILD]);
    assert.equal(eventService.MIN_NOTICE_GRACE_MS, 3600 * 1000);
    const mk = (title, over) => realCreateEvent({ guildId: GUILD, title, minParticipants: 5, startAt: NOW, deadlineAt: NOW, ...over });
    await mk('due: deadline == start == now');
    await mk('due: started 59 min ago', { startAt: new Date(NOW.getTime() - 59 * 60000), deadlineAt: new Date(NOW.getTime() - 59 * 60000) });
    await mk('not: started 61 min ago', { startAt: new Date(NOW.getTime() - 61 * 60000), deadlineAt: new Date(NOW.getTime() - 61 * 60000) });
    await mk('not: deadline later', { startAt: new Date(NOW.getTime() + 3600000), deadlineAt: new Date(NOW.getTime() + 60000) });
    await mk('not: no minimum', { minParticipants: null });
    await mk('not: notice claimed', { minNoticeAt: NOW });
    const titles = (await realFindDueMinNotices(NOW)).map((e) => e.title).sort();
    assert.deepEqual(titles, ['due: deadline == start == now', 'due: started 59 min ago']);
  });
  it('the scheduler posts the notice for an event whose deadline == start the minute it starts', async () => {
    const e = makeEvent({ minParticipants: 15, startAt: NOW, deadlineAt: NOW });
    const channel = { id: 'admin-chan', send: async (p) => sent.push(p) };
    config.adminChannelId = 'admin-chan';
    eventService.findDueLocks = async () => [];
    eventService.findDueReminders = async () => [];
    eventService.findFinished = async () => [];
    eventService.findDueMinNotices = async () => [e];
    eventService.claimMinNotice = async () => true;
    await eventsStep({ channels: { fetch: async () => channel } }, NOW);
    assert.equal(sent.length, 1);
    assert.match(JSON.stringify(sent[0]), /chưa đủ người/);
  });
});

describe('📄 Xuất Word (ev:doc)', () => {
  const JSZip = require('jszip');
  const gameRoster = require('../src/services/gameRosterService');
  const { buildEventDocx } = require('../src/services/eventDocx');
  const docXml = async (buffer) => (await JSZip.loadAsync(buffer)).file('word/document.xml').async('string');

  it('builds a real .docx (content types, rels, document) with the details, escaped text and the answers grouped ✅ / ❓ / ❌', async () => {
    const event = makeEvent({ title: 'Giải <Solo> & vui', description: 'Luật 1\nLuật 2', capacity: 16, minParticipants: 3 });
    const replies = [
      { discordId: sid(1), displayName: 'An', status: 'yes', createdAt: vn(2026, 10, 14, 9) },
      { discordId: sid(2), displayName: 'Bình', status: 'maybe' },
      { discordId: sid(3), displayName: 'Chi', status: 'yes' },
    ];
    const { buffer, fileName } = await buildEventDocx({ event, replies, gameNames: new Map([[sid(1), 'Mây Chiều']]), classOf: (n) => (n === 'Mây Chiều' ? 'Tố Vấn' : ''), category: { label: 'PvP / thi đấu' }, statusLabel: 'Đang mở', guildName: 'Bang Thử Nghiệm' });
    const zip = await JSZip.loadAsync(buffer);
    assert.deepEqual(Object.keys(zip.files).filter((f) => !zip.files[f].dir).sort(), ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
    assert.match(fileName, /^su-kien-Giai-Solo-vui-\d\d-\d\d\.docx$/);
    const xml = await docXml(buffer);
    assert.ok(xml.includes('Giải &lt;Solo&gt; &amp; vui') && !xml.includes('<Solo>'), 'escaped');
    assert.ok(xml.includes('✅ Tham gia (2)') && xml.includes('❓ Có thể (1)') && xml.includes('❌ Không (0)'));
    assert.ok(xml.includes('2/16 tham gia · cần ít nhất 3 (còn thiếu 1)'));
    assert.ok(xml.includes('Mây Chiều') && xml.includes('Tố Vấn') && xml.includes('Bang Thử Nghiệm') && xml.includes('Luật 1</w:t><w:br/>'));
    assert.ok(xml.includes('<w:tblHeader/>'), 'the header row repeats on every page');
  });
  it('a manager gets the file as a new ephemeral reply (names only, no mention); a member is refused and gets nothing', async () => {
    mock.method(gameRoster, 'latest', async () => ({ members: [{ name: 'An', className: 'Thiết Y' }] }));
    replies = [{ discordId: sid(1), displayName: 'An', status: 'yes' }];
    const { i, log } = interaction();
    await events.handle(i, ['ev', 'doc', EID]);
    assert.equal(log[0][0], 'deferReply');
    const out = lastEdit(log);
    assert.equal(out.files.length, 1);
    assert.match(out.files[0].name, /\.docx$/);
    assert.deepEqual(out.allowedMentions, { parse: [] });
    assert.ok((await docXml(out.files[0].attachment)).includes('✅ Tham gia (1)'));
    assert.ok(lines().some((l) => l.ev === 'docx'));
    const denied = memberIx();
    await events.handle(denied.i, ['ev', 'doc', EID]);
    assert.match(denied.log.pop()[1].content, /không có quyền/);
    assert.ok(!denied.log.some((l) => l[1] && l[1].files));
    mock.restoreAll();
  });
});
