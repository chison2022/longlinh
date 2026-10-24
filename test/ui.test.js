const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const defaults = require('../config/defaults');
const { buildWarMessage, buildListEmbeds, buildClassSelect } = require('../src/bot/ui/warMessage');
const { buildPanel, buildSetupView } = require('../src/bot/ui/panel');
const { eventStats, progressBar } = require('../src/bot/eventStats');
const { buildSettingsModal, buildCreateModal } = require('../src/bot/ui/settingsModal');
const { truncate, packGroups, paginateFields, toMessages, v2Create } = require('../src/bot/ui/common');
const { assertMessage, assertEmbed, assertModal, assertV2Message, hasLoneSurrogate } = require('./discordLimits');
const { vn, sid, makeRegs } = require('./helpers');

const EID = '652f1c2e9b1d4a0012345678';
const CLASSES = defaults.classes; // emoji-prefixed Vietnamese names
const BIG = CLASSES[1]; // 'Tố Vấn'
const EMO = (c) => defaults.classFallbackEmoji[c]; // unicode fallback shown in embeds without server emojis

const makeEvent = (patch = {}) => ({
  _id: EID,
  guildId: '111111111111111111',
  title: 'Bang chiến CN 20:00 (11/10)',
  startAt: vn(2026, 10, 11, 20, 0),
  deadlineAt: vn(2026, 10, 11, 18, 0),
  status: 'open',
  teams: [],
  ...patch,
});

// 80 registrations: 35 in one class, others spread, 4 with no class, mixed status.
function eightyRegs() {
  const statuses = ['join', 'join', 'join', 'reserve', 'absent'];
  return makeRegs(80, {
    classOf: (i) => (i < 35 ? BIG : i >= 76 ? null : CLASSES[i % CLASSES.length]),
    statusOf: (i) => (i < 35 ? (i % 7 === 6 ? 'reserve' : 'join') : statuses[i % statuses.length]),
  });
}

const CONFIG = { classes: CLASSES, groupCount: 2, schedule: defaults.schedule };
const TS = (d) => Math.floor(d.getTime() / 1000);

describe('buildWarMessage (Components V2)', () => {
  it('open event with 80 regs: one container, V2 flag, no mentions, sections + 3 buttons, customIds with the event id', () => {
    const msg = buildWarMessage(makeEvent(), eightyRegs(), CONFIG);
    const v2 = assertV2Message(msg);
    assert.equal(v2.json.length, 1);
    assert.equal(v2.json[0].type, 17);
    assert.equal(v2.json[0].accent_color, 0x2ecc71);
    assert.deepEqual([...v2.customIds], [`war:st:${EID}:join`, `war:st:${EID}:absent`, `war:chg:${EID}`, `war:list:${EID}`, `war:tk:${EID}`, `war:mis:${EID}`]);
    assert.ok(v2.buttons.every((b) => !b.disabled));
    assert.ok(!v2.customIds.has(`war:st:${EID}:reserve`), 'no Dự bị button any more');
    assert.match(v2.text, /^### ⚔️ Bang chiến CN 20:00/);
    assert.match(v2.text, /🟢 Đang mở · chốt <t:\d+:R>/);
    assert.match(v2.text, /-# Đổi được tới <t:\d+:t> <t:\d+:d>/);
  });
  it('time line: start + warDurationMinutes (default 60)', () => {
    const start = vn(2026, 10, 10, 20, 0);
    const line = (schedule) => assertV2Message(buildWarMessage(makeEvent({ startAt: start }), [], { ...CONFIG, schedule })).text.split('\n').find((l) => l.startsWith('🕗'));
    assert.equal(line(defaults.schedule), `🕗 <t:${TS(start)}:f> – <t:${TS(vn(2026, 10, 10, 21, 0))}:t>`);
    assert.ok(line(undefined).endsWith(`– <t:${TS(vn(2026, 10, 10, 21, 0))}:t>`), 'no schedule -> default duration');
    assert.ok(line({ warDurationMinutes: 90 }).endsWith(`– <t:${TS(vn(2026, 10, 10, 21, 30))}:t>`));
  });
  it('join count / capacity / bar, absent and unregistered (only when known)', () => {
    const regs = makeRegs(9, { statusOf: (i) => (i < 5 ? 'join' : i < 7 ? 'reserve' : i === 7 ? 'join' : 'absent') });
    const withUnreg = assertV2Message(buildWarMessage(makeEvent(), regs, CONFIG, undefined, { unregistered: 47 })).text;
    assert.match(withUnreg, /✅ \*\*8\*\*\/60 đi  ▰▱▱▱▱▱▱▱▱▱/); // join + legacy reserve, 2 groups x 5 PT x 6
    assert.match(withUnreg, /❌ 1 vắng · ⏳ 47 chưa đăng ký/);
    const unknown = assertV2Message(buildWarMessage(makeEvent(), regs, CONFIG)).text;
    assert.match(unknown, /❌ 1 vắng/);
    assert.ok(!unknown.includes('chưa đăng ký'), 'unknown unregistered count is left out');
  });
  it('the bar shows at least one segment once somebody joined (1/60 is not empty), none for 0', () => {
    assert.equal(progressBar(1, 60), '▰▱▱▱▱▱▱▱▱▱');
    assert.equal(progressBar(0, 60), '▱▱▱▱▱▱▱▱▱▱');
    assert.equal(progressBar(3, 60), '▰▱▱▱▱▱▱▱▱▱');
    assert.equal(progressBar(30, 60), '▰▰▰▰▰▱▱▱▱▱');
    assert.equal(progressBar(60, 60), '▰'.repeat(10));
    assert.equal(progressBar(1, 0), '▱'.repeat(10));
    const text = assertV2Message(buildWarMessage(makeEvent(), makeRegs(1), CONFIG)).text;
    assert.match(text, /✅ \*\*1\*\*\/60 đi  ▰▱▱▱▱▱▱▱▱▱/);
  });
  it('capacity follows groupCount; the bar is full above capacity', () => {
    const regs = makeRegs(40);
    const text = assertV2Message(buildWarMessage(makeEvent(), regs, { ...CONFIG, groupCount: 1 })).text;
    assert.match(text, /\*\*40\*\*\/30 đi  ▰{10}/);
  });
  it('classes with at least one join on one line, in config order; reserve counts like join', () => {
    const regs = [
      ...makeRegs(2, { classOf: () => CLASSES[2] }),
      ...makeRegs(3, { classOf: () => CLASSES[0], offset: 10, statusOf: () => 'reserve' }),
      ...makeRegs(1, { classOf: () => CLASSES[1], offset: 20, statusOf: () => 'absent' }),
    ];
    const line = assertV2Message(buildWarMessage(makeEvent(), regs, CONFIG)).text.split('\n').find((l) => /\d/.test(l) && l.includes(EMO(CLASSES[0])));
    assert.equal(line, `${EMO(CLASSES[0])} TY 3  ${EMO(CLASSES[2])} HH 2`); // emoji + initials of the plain name + count
  });
  it('warns when a role is short of the PTs needed: ceil(join / 6)', () => {
    const regs = [
      ...makeRegs(10, { classOf: () => CLASSES[2] }), // 10 -> 2 PT
      ...makeRegs(1, { classOf: () => CLASSES[1], offset: 100 }), // 1 Tố Vấn
      ...makeRegs(2, { classOf: () => CLASSES[0], offset: 200 }), // 2 Thiết Y
    ];
    const text = assertV2Message(buildWarMessage(makeEvent(), regs, CONFIG)).text; // 13 join -> 3 PT
    assert.match(text, /⚠️ Thiếu Tố Vấn: 1\/3 PT/);
    assert.match(text, /⚠️ Thiếu Thiết Y: 2\/3 PT/);
    const enough = assertV2Message(buildWarMessage(makeEvent(), makeRegs(6, { classOf: (i) => CLASSES[i % 2] }), CONFIG)).text; // 1 PT, 3+3
    assert.ok(!enough.includes('Thiếu'));
  });
  it('locked event: the two registration buttons are disabled, the lookup buttons are not; accent orange', () => {
    const msg = buildWarMessage(makeEvent({ status: 'locked' }), [], CONFIG);
    const v2 = assertV2Message(msg);
    assert.equal(v2.json[0].accent_color, 0xe67e22);
    const by = (id) => v2.buttons.find((b) => b.custom_id === id);
    assert.equal(by(`war:st:${EID}:join`).disabled, true);
    assert.equal(by(`war:st:${EID}:absent`).disabled, true);
    assert.ok(!by(`war:list:${EID}`).disabled);
    assert.ok(!by(`war:tk:${EID}`).disabled, 'links are persistent: allowed after the deadline');
    assert.match(v2.text, /🔒 Đã chốt/);
    assert.ok(!v2.text.includes('-#'), 'footer only while open');
  });
  it('status lines and accent colours: open green, locked orange, published blue, done grey', () => {
    const expect = { open: [0x2ecc71, '🟢 Đang mở'], locked: [0xe67e22, '🔒 Đã chốt'], published: [0x3498db, '📢 Đã công bố'], done: [0x95a5a6, '⚫ Đã kết thúc'] };
    for (const [status, [color, label]] of Object.entries(expect)) {
      const v2 = assertV2Message(buildWarMessage(makeEvent({ status }), [], CONFIG));
      assert.equal(v2.json[0].accent_color, color, status);
      assert.ok(v2.text.includes(label), status);
    }
  });
  it('"📊 Đội hình" link button appears only once a lineup link is published; "Xem PT của tôi" is gone', () => {
    const URL_OK = 'https://docs.google.com/spreadsheets/d/abc';
    for (const status of ['open', 'locked']) {
      const v2 = assertV2Message(buildWarMessage(makeEvent({ status, lineupUrl: URL_OK }), [], CONFIG));
      assert.ok(!v2.buttons.some((c) => c.url), status);
    }
    assert.ok(!assertV2Message(buildWarMessage(makeEvent({ status: 'published' }), [], CONFIG)).buttons.some((c) => c.url), 'published without a link');
    for (const status of ['published', 'done']) {
      const v2 = assertV2Message(buildWarMessage(makeEvent({ status, lineupUrl: URL_OK }), eightyRegs(), CONFIG));
      const link = v2.buttons.find((c) => c.url);
      assert.deepEqual([link.label, link.url, link.style], ['📊 Đội hình', URL_OK, 5]);
      assert.ok(!v2.customIds.has(`war:mypt:${EID}`));
    }
  });
  it('60 registrations over every class stay far below 4000 chars of text and 40 components', () => {
    const regs = makeRegs(60, { classOf: (i) => CLASSES[i % CLASSES.length], nameOf: (i) => 'Tên rất dài ' + i });
    for (const status of ['open', 'locked', 'published', 'done']) {
      const v2 = assertV2Message(buildWarMessage(makeEvent({ status, title: 'Đ'.repeat(400) }), regs, CONFIG, undefined, { unregistered: 20 }));
      assert.ok(v2.text.length < 1200, `${status}: ${v2.text.length} chars`);
      assert.ok(v2.count <= 20, `${status}: ${v2.count} components`);
    }
  });
  it('with 25 custom-emoji classes the text is still within 4000', () => {
    const classes = Array.from({ length: 25 }, (_, i) => `Phái ${i}`);
    const styles = new Map(classes.map((c, i) => [c, { emoji: { name: 'e' + i, id: '1234567890123456' + String(i).padStart(2, '0') }, emojiText: `<:e${i}:1234567890123456${String(i).padStart(2, '0')}>`, plain: c }]));
    const regs = makeRegs(60, { classOf: (i) => classes[i % 25] });
    assertV2Message(buildWarMessage(makeEvent(), regs, { classes, groupCount: 2 }, styles));
  });
  it('empty registrations show a placeholder; unknown status still renders', () => {
    assert.match(assertV2Message(buildWarMessage(makeEvent(), [], CONFIG)).text, /Chưa có ai đăng ký/);
    assertV2Message(buildWarMessage(makeEvent({ status: 'weird' }), [], CONFIG));
  });
  it('the edit payload clears embeds and the create payload carries neither content nor embeds', () => {
    const msg = buildWarMessage(makeEvent(), [], CONFIG);
    assertV2Message(msg);
    assertV2Message(v2Create(msg), { forCreate: true });
  });
});

describe('buildClassSelect', () => {
  it('25 options max, default marks current class', () => {
    const many = Array.from({ length: 30 }, (_, i) => `Phái ${i}`);
    const row = buildClassSelect(`war:cls:${EID}:join`, many, 'Phái 3').toJSON();
    assertMessage({ components: [row] });
    const sel = row.components[0];
    assert.equal(sel.options.length, 25);
    assert.deepEqual(sel.options.filter((o) => o.default).map((o) => o.value), ['Phái 3']);
  });
});

// Embeds of one logical list -> every embed valid, and as messages (<=10 embeds, <=6000 chars) valid too.
function assertAllEmbeds(embeds) {
  const out = embeds.map((e) => assertEmbed(e));
  for (const group of toMessages(embeds)) assertMessage({ embeds: group });
  return out;
}
const allText = (embeds) => embeds.flatMap((e) => (e.toJSON().fields || []).map((f) => f.value)).join('\n');

describe('buildListEmbeds', () => {
  it('80 regs (35 in one class, long Vietnamese names) respects embed limits', () => {
    const embeds = assertAllEmbeds(buildListEmbeds(makeEvent(), eightyRegs(), CLASSES));
    const fields = embeds.flatMap((e) => e.fields);
    assert.ok(fields.length >= 1);
    // config order: first configured class comes first; unknown class ("Chưa rõ") comes last
    assert.ok(fields[0].name.startsWith(`${EMO(CLASSES[0])} ${CLASSES[0]}`));
    const classFields = fields.filter((f) => !f.name.startsWith('❌ Vắng'));
    assert.ok(classFields[classFields.length - 1].name.includes('Chưa rõ'));
  });
  it('lists every registered (join/reserve) member for a realistic 80-person guild', () => {
    const regs = eightyRegs();
    const text = allText(buildListEmbeds(makeEvent(), regs, CLASSES));
    const missing = regs.filter((r) => r.status !== 'absent' && !text.includes(r.displayName));
    assert.deepEqual(missing.map((r) => r.displayName), [], `${missing.length} names hidden by truncation`);
  });
  it('a long class continues in "<class> (tiếp)" fields', () => {
    const regs = makeRegs(80, { classOf: () => BIG });
    const embeds = buildListEmbeds(makeEvent(), regs, CLASSES);
    const names = embeds.flatMap((e) => e.toJSON().fields.map((f) => f.name));
    assert.ok(names[0].startsWith(`${EMO(BIG)} ${BIG}`) && !names[0].includes('(tiếp)'));
    assert.ok(names.length > 1 && names.slice(1).every((n) => n === `${EMO(BIG)} ${BIG} (tiếp)`), JSON.stringify(names));
    const text = allText(embeds);
    assert.deepEqual(regs.filter((r) => !text.includes(r.displayName)), []);
  });
  it('200 members across 30 classes spill into several embeds, nothing dropped', () => {
    const regs = makeRegs(200, { classOf: (i) => `Phái ${i % 30}` });
    const embeds = buildListEmbeds(makeEvent(), regs, []);
    assert.ok(embeds.length > 1, 'expected more than one embed');
    assertAllEmbeds(embeds);
    const text = allText(embeds);
    assert.deepEqual(regs.filter((r) => !text.includes(r.displayName)).map((r) => r.displayName), []);
  });
  it('no regs -> no fields, still valid', () => {
    const embeds = buildListEmbeds(makeEvent(), [], CLASSES);
    assert.equal(embeds.length, 1);
    assert.equal((assertEmbed(embeds[0]).fields || []).length, 0);
  });
  it('30 classes with members -> at most 25 fields per embed', () => {
    const regs = makeRegs(60, { classOf: (i) => `Phái ${i % 30}` });
    const embeds = assertAllEmbeds(buildListEmbeds(makeEvent(), regs, []));
    assert.ok(embeds.every((e) => e.fields.length <= 25));
  });
  it('names containing emoji are never cut in the middle of a surrogate pair and never dropped', () => {
    // 200 emoji-heavy names overflow the 1024 cap; varying the prefix moves the cut point
    // across emoji boundaries (pad 0, 1 and 4 land inside a surrogate pair).
    for (let pad = 0; pad < 6; pad++) {
      const name = `${'x'.repeat(pad)}🐉🐉🐉🐉🐉🐉🐉🐉`;
      const regs = makeRegs(200, { classOf: () => 'A', nameOf: () => name });
      const embeds = buildListEmbeds(makeEvent(), regs, ['A']);
      assertAllEmbeds(embeds);
      const count = allText(embeds).split(name).length - 1;
      assert.equal(count, 200, `pad ${pad}: ${count} names listed`);
    }
  });
});

describe('common helpers', () => {
  it('truncate keeps short text and caps long text with ellipsis', () => {
    assert.equal(truncate('abc', 5), 'abc');
    assert.equal(truncate('abcdef', 5), 'abcd…');
    assert.equal(truncate('abcdef', 5).length, 5);
  });
  it('truncate does not split a surrogate pair', () => {
    const out = truncate('ab🐉cd', 4); // slice(0,3) would leave a lone high surrogate
    assert.ok(!hasLoneSurrogate(out), JSON.stringify(out));
    assert.ok(out.length <= 4);
  });
  it('truncate with an ellipsis counts UTF-16 length and keeps whole emoji', () => {
    for (let max = 3; max < 12; max++) {
      const out = truncate('🐉🐉🐉🐉🐉🐉🐉🐉', max);
      assert.ok(out.length <= max && !hasLoneSurrogate(out), `max ${max}: ${JSON.stringify(out)}`);
    }
  });
  it('packGroups keeps every item, chunks <= max, repeats the prefix on continuation', () => {
    const items = Array.from({ length: 60 }, (_, i) => `Người số ${i}`);
    const chunks = packGroups([{ prefix: '✅ ', items }, { prefix: '🕐 ', items: ['Dự bị 1', 'Dự bị 2'] }], 200);
    assert.ok(chunks.length > 1);
    for (const c of chunks) {
      assert.ok(c.text.length <= 200);
      assert.ok(c.text.startsWith('✅ ') || c.text.startsWith('🕐 '));
    }
    assert.equal(chunks.reduce((n, c) => n + c.count, 0), 62);
    const all = chunks.map((c) => c.text).join('\n');
    for (const it of [...items, 'Dự bị 1', 'Dự bị 2']) assert.ok(all.includes(it), it);
  });
  it('paginateFields splits on 25 fields and on the 6000-char budget', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ name: `F${i}`, value: 'v' }));
    assert.deepEqual(paginateFields(many).map((p) => p.length), [25, 25, 10]);
    const big = Array.from({ length: 12 }, (_, i) => ({ name: `F${i}`, value: 'v'.repeat(1000) }));
    const pages = paginateFields(big, 100, 20);
    assert.ok(pages.length > 1);
    assert.equal(pages.flat().length, 12);
    pages.forEach((p, i) => assert.ok((i ? 20 : 100) + p.reduce((n, f) => n + f.name.length + f.value.length, 0) <= 6000));
  });
});

describe('buildPanel (live V2 dashboard)', () => {
  const NOW = new Date('2026-10-08T03:00:00Z');
  const regsOf = (n) => makeRegs(n, { classOf: (i) => CLASSES[i % CLASSES.length] });
  const statsFor = (event, regs, extra) => eventStats(event, regs, { classes: CLASSES, groupCount: 2 }, extra);
  const idsOf = (v2) => v2.buttons.map((b) => b.custom_id);

  it('no event: "Chưa có bang chiến", create enabled, lock / publish disabled', () => {
    const v2 = assertV2Message(buildPanel({ config: { features: { violations: true, draw: true } } }));
    assert.match(v2.text, /### 🏯 Bảng điều khiển/);
    assert.match(v2.text, /Chưa có bang chiến tuần này/);
    assert.match(v2.text, /-# Chỉ quản lý dùng được các nút này\./);
    assert.deepEqual(idsOf(v2), ['adm:create', 'adm:lock', 'tm:pub', 'adm:unreg', 'adm:game', 'adm:sheet', 'adm:settings', 'adm:offcfg']);
    for (const gone of ['adm:export', 'adm:roster', 'adm:sheetsync']) assert.ok(!idsOf(v2).includes(gone), `${gone} left the dashboard`);
    assert.deepEqual(v2.json[0].components.filter((c) => c.type === 1).map((r) => r.components.map((b) => b.label)), [['⚔️ Tạo bang chiến', '🔒 Chốt', '📢 Công bố'], ['👥 Chưa đăng ký', '🎮 Thành viên game', '📊 Google Sheet'], ['⚙️ Cài đặt', '⚙️ Ngưỡng']], 'rows of at most 4 buttons (the retired ⚖️ / 🎲 stay off even with an old config)');
    assert.match(v2.text, /📊 Sheet: chưa nối/);
    assert.ok(!idsOf(v2).includes('adm:teams'), 'no Chia đội button any more');
    assert.ok(!v2.text.includes('Chia đội') && !v2.text.includes('Tự chia'));
    const disabled = (id) => v2.buttons.find((b) => b.custom_id === id).disabled === true;
    assert.equal(disabled('adm:create'), false);
    for (const id of ['adm:lock', 'tm:pub']) assert.equal(disabled(id), true, id);
    assert.equal(disabled('adm:sheet'), false);
    assert.ok(!v2.text.includes('Game:'), 'no roster import -> no game line');
  });
  it('open event: title, status, deadline, counts, warnings; "Chốt" enabled', () => {
    const event = makeEvent();
    const regs = regsOf(40);
    const v2 = assertV2Message(buildPanel({ event, stats: statsFor(event, regs, { unregistered: 20 }) }));
    assert.match(v2.text, /⚔️ \*\*Bang chiến CN 20:00 \(11\/10\)\*\* · 🟢 Đang mở đăng ký · chốt <t:\d+:R>/);
    assert.match(v2.text, /✅ 40\/60 · ❌ 0 · ⏳ 20/);
    const lock = v2.buttons.find((b) => b.custom_id === 'adm:lock');
    assert.equal(lock.label, '🔒 Chốt');
    assert.ok(!lock.disabled);
    const pub = v2.buttons.find((b) => b.custom_id === `tm:pub:${event._id}`);
    assert.equal(pub.label, '📢 Công bố');
    assert.ok(!pub.disabled);
    const sheetText = (sheet) => assertV2Message(buildPanel({ event, stats: statsFor(event, regs), sheet })).text;
    assert.match(sheetText({ configured: true }), /📊 Sheet: chưa đồng bộ/);
    assert.match(sheetText({ configured: true, at: NOW }), /📊 Sheet: đồng bộ <t:\d+:R>/);
    assert.match(sheetText({ configured: true, at: NOW, error: 'Chưa chia sẻ quyền\nEditor' }), /📊 Sheet: lỗi: Chưa chia sẻ quyền Editor/);
    assert.match(sheetText({ configured: false }), /📊 Sheet: chưa nối/);
    assert.ok(sheetText({ configured: true, error: 'x'.repeat(500) }).length < 900, 'a long error is cut');
    const done = assertV2Message(buildPanel({ event: makeEvent({ status: 'done' }), stats: statsFor(makeEvent({ status: 'done' }), regs) }));
    assert.ok(done.buttons.find((b) => b.custom_id === `tm:pub:${event._id}`).disabled, 'a finished war cannot be published');
  });
  it('locked event: the lock button becomes "🟢 Mở lại"; published event: it is disabled', () => {
    const locked = makeEvent({ status: 'locked' });
    const l = assertV2Message(buildPanel({ event: locked, stats: statsFor(locked, regsOf(3)) }));
    const reopen = l.buttons.find((b) => b.custom_id === 'adm:lock');
    assert.equal(reopen.label, '🟢 Mở lại');
    assert.ok(!reopen.disabled);
    assert.ok(!l.text.includes('chốt <t:'), 'deadline only while open');
    const published = makeEvent({ status: 'published' });
    const p = assertV2Message(buildPanel({ event: published, stats: statsFor(published, regsOf(3)) }));
    assert.equal(p.buttons.find((b) => b.custom_id === 'adm:lock').disabled, true);
  });
  it('missing healer / tank warnings and the unregistered part is left out when unknown', () => {
    const event = makeEvent();
    const regs = makeRegs(12, { classOf: () => CLASSES[2] });
    const v2 = assertV2Message(buildPanel({ event, stats: statsFor(event, regs) }));
    assert.match(v2.text, /⚠️ Thiếu Tố Vấn: 0\/2 PT/);
    assert.match(v2.text, /⚠️ Thiếu Thiết Y: 0\/2 PT/);
    assert.ok(!v2.text.includes('⏳'));
  });
  it('member section shows the in-game roster count and import time when there is one', () => {
    const v2 = assertV2Message(buildPanel({ game: { count: 64, at: NOW } }));
    assert.match(v2.text, /👥 \*\*Thành viên\*\*\n🎮 Game: 64 người · cập nhật <t:1791428400:R>/);
  });
});

describe('buildSetupView', () => {
  const empty = { announceChannelId: null, adminChannelId: null, adminRoleIds: [], memberRoleId: null };
  it('fresh config: 5 rows, no defaults, placeholder text', () => {
    const v = buildSetupView(empty);
    const { rows } = assertMessage(v);
    assert.equal(rows.length, 5);
    assert.ok(rows.slice(0, 4).every((r) => !r.components[0].default_values));
    assert.match(v.content, /_chưa chọn_/);
    assert.deepEqual(v.allowedMentions, { parse: [] });
  });
  it('full config shows current values as defaults, admin roles capped at 10', () => {
    const roles = Array.from({ length: 12 }, (_, i) => sid(500 + i));
    const v = buildSetupView({ announceChannelId: sid(1), adminChannelId: sid(2), adminRoleIds: roles, memberRoleId: sid(3) }, '✅ Đã lưu.');
    const { rows } = assertMessage(v);
    assert.deepEqual(rows[0].components[0].default_values, [{ id: sid(1), type: 'channel' }]);
    assert.deepEqual(rows[1].components[0].default_values, [{ id: sid(2), type: 'channel' }]);
    assert.equal(rows[2].components[0].default_values.length, 10);
    assert.deepEqual(rows[3].components[0].default_values, [{ id: sid(3), type: 'role' }]);
    assert.ok(v.content.endsWith('✅ Đã lưu.'));
  });
});

describe('buildSettingsModal', () => {
  const cfg = (patch = {}) => ({
    classes: CLASSES,
    groupCount: 2,
    schedule: { ...defaults.schedule, enabled: true },
    ...patch,
  });
  it('defaults config prefill passes modal limits', () => {
    const m = assertModal(buildSettingsModal(cfg()));
    const byId = Object.fromEntries(m.components.map((l) => [l.component.custom_id, l.component]));
    assert.equal(byId.classes.value, CLASSES.join('\n'));
    assert.equal(byId.groupCount.value, '2');
    assert.equal(m.components.find((l) => l.component.custom_id === 'groupCount').label, 'Số nhóm (mỗi nhóm 5 PT × 6)');
    assert.equal(byId.war.value, 'T7 20:00');
    assert.equal(byId.open.value, 'T2 00:00');
    assert.equal(byId.open.required, false);
    assert.equal(byId.timing.value, '2/3');
  });
  it('25 classes x 40 chars and 4 groups fit into max lengths', () => {
    const classes = Array.from({ length: 25 }, (_, i) => `${String(i).padStart(2, '0')}${'Đ'.repeat(38)}`);
    assertModal(buildSettingsModal(cfg({ classes, groupCount: 4, schedule: { ...defaults.schedule, enabled: false, lockBeforeHours: 168, remindBeforeHours: 168 } })));
  });
  it('auto-open disabled leaves "open" without a value', () => {
    const m = assertModal(buildSettingsModal(cfg({ schedule: { ...defaults.schedule, enabled: false } })));
    const open = m.components.find((l) => l.component.custom_id === 'open').component;
    assert.equal(open.value, undefined);
  });
});

describe('buildCreateModal', () => {
  it('has a single deadline field, prefilled, with the war window in the description', () => {
    const m = assertModal(buildCreateModal({ deadline: '10/10 18:00', war: 'T7 10/10 20:00–21:00' }));
    assert.deepEqual(m.components.map((l) => l.component.custom_id), ['deadline']);
    assert.equal(m.components[0].component.value, '10/10 18:00');
    assert.equal(m.components[0].description, 'Giờ Việt Nam. Bang chiến: T7 10/10 20:00–21:00');
  });
  it('empty values are allowed', () => {
    assertModal(buildCreateModal({}));
  });
});
