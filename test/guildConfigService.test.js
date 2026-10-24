const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseSettings, formatSettings, MAX_CLASSES, MAX_CLASS_LENGTH } = require('../src/services/guildConfigService');
const defaults = require('../config/defaults');

const base = { classes: 'Thiết Y\nTố Vấn', groupCount: '4', war: 'CN 20:00', open: 'T2 09:00', timing: '2/3' };
const parse = (patch) => parseSettings({ ...base, ...patch });

describe('parseSettings – happy path', () => {
  it('parses a full valid form', () => {
    const r = parse({});
    assert.equal(r.error, undefined);
    assert.deepEqual(r.value, {
      classes: ['Thiết Y', 'Tố Vấn'],
      classEmojis: [],
      groupCount: 4,
      schedule: { warDay: 0, warTime: '20:00', lockBeforeHours: 2, remindBeforeHours: 3, enabled: true, openDay: 1, openTime: '09:00' },
    });
  });
  it('keeps Unicode / emoji class names intact', () => {
    const r = parse({ classes: '🛡️ Thiết Y\n💊 Tố Vấn\n🐉 Long Ngâm' });
    assert.deepEqual(r.value.classes, ['🛡️ Thiết Y', '💊 Tố Vấn', '🐉 Long Ngâm']);
  });
  it('trims, drops empty lines and handles CRLF', () => {
    const r = parse({ classes: '  A  \r\n\r\nB\n\n   \nC\n' });
    assert.deepEqual(r.value.classes, ['A', 'B', 'C']);
  });
  it('a class listed twice (any spelling of one identity) is a validation error, never silently merged', () => {
    assert.match(parse({ classes: 'A\nB\nA' }).error, /trùng/);
    assert.match(parse({ classes: '🛡️ Thiết Y\nThiết Y' }).error, /trùng/);
  });
  it('plain numbers are part of the class identity: "1 Kiếm" and "2 Kiếm" are two classes', () => {
    assert.deepEqual(parse({ classes: '1 Kiếm\n2 Kiếm' }).value.classes, ['1 Kiếm', '2 Kiếm']);
    assert.match(parse({ classes: '1️⃣ Kiếm\n2️⃣ Kiếm' }).error, /trùng/, 'keycaps are decoration: same class');
  });
  it('a line with no name left (only emoji) is rejected', () => {
    assert.match(parse({ classes: 'A\n🩸' }).error, /không hợp lệ/);
  });
  it('a stored override token is kept even when it equals the auto-match; a new auto-equal token is dropped', () => {
    const autoEmoji = () => new Map([['Tố Vấn', 'tovan'], ['Thiết Y', 'thiety']]);
    const classes = 'Tố Vấn :tovan:\nThiết Y :thiety:';
    const fresh = parseSettings({ ...base, classes }, { autoEmoji });
    assert.deepEqual(fresh.value.classEmojis, []);
    const kept = parseSettings({ ...base, classes }, { autoEmoji, prevEmojis: [{ className: 'Tố Vấn', emoji: 'TOVAN' }] });
    assert.deepEqual(kept.value.classEmojis, [{ className: 'Tố Vấn', emoji: 'tovan' }]);
    const other = parseSettings({ ...base, classes }, { autoEmoji, prevEmojis: [{ className: 'Tố Vấn', emoji: 'khac' }] });
    assert.deepEqual(other.value.classEmojis, [], 'the stored override was a different token: this one is not it');
  });
  it('accepts exactly MAX_CLASSES (25) classes', () => {
    assert.equal(MAX_CLASSES, 25);
    const list = Array.from({ length: 25 }, (_, i) => `Phái ${i + 1}`);
    assert.deepEqual(parse({ classes: list.join('\n') }).value.classes, list);
  });
  it('26 lines that repeat one class are a duplicate error, not a silent 25', () => {
    const list = Array.from({ length: 25 }, (_, i) => `Phái ${i + 1}`);
    assert.match(parse({ classes: [...list, 'Phái 1'].join('\n') }).error, /trùng/);
  });
  it('accepts a class name of exactly 40 chars', () => {
    assert.equal(MAX_CLASS_LENGTH, 40);
    const name = 'Đ'.repeat(40);
    assert.deepEqual(parse({ classes: name }).value.classes, [name]);
  });
  it('group count boundaries 1 and 4, with surrounding spaces', () => {
    assert.equal(parse({ groupCount: '1' }).value.groupCount, 1);
    assert.equal(parse({ groupCount: '4' }).value.groupCount, 4);
    assert.equal(parse({ groupCount: ' 3 ' }).value.groupCount, 3);
  });
  it('timing accepts 0/0, decimals with dot or comma, spaces, and 168', () => {
    assert.deepEqual(pickTiming(parse({ timing: '0/0', open: '' })), [0, 0]);
    assert.deepEqual(pickTiming(parse({ timing: '1,5 / 2.5' })), [1.5, 2.5]);
    assert.deepEqual(pickTiming(parse({ timing: '168/168', open: '' })), [168, 168]);
  });
  it('empty or whitespace "open" disables auto-open and omits openDay/openTime', () => {
    for (const open of ['', '   ', undefined, null]) {
      const r = parse({ open });
      assert.equal(r.error, undefined);
      assert.equal(r.value.schedule.enabled, false);
      assert.equal('openDay' in r.value.schedule, false);
      assert.equal('openTime' in r.value.schedule, false);
    }
  });
  it('open on the same day but before the deadline is accepted', () => {
    const r = parse({ war: 'CN 20:00', open: 'CN 17:59', timing: '2/0' });
    assert.equal(r.error, undefined);
    assert.equal(r.value.schedule.openDay, 0);
  });
  it('open day after war day in the week (wraps to previous week) is accepted', () => {
    const r = parse({ war: 'T3 20:00', open: 'T5 09:00' });
    assert.equal(r.error, undefined);
    assert.equal(r.value.schedule.openDay, 4);
  });
});

function pickTiming(r) {
  assert.equal(r.error, undefined, r.error);
  return [r.value.schedule.lockBeforeHours, r.value.schedule.remindBeforeHours];
}

describe('parseSettings – validation errors', () => {
  const expectError = (patch, re) => {
    const r = parse(patch);
    assert.equal(r.value, undefined, `expected error for ${JSON.stringify(patch)}`);
    assert.match(r.error, re);
  };
  it('no classes', () => {
    expectError({ classes: '' }, /ít nhất 1/);
    expectError({ classes: '\n  \n\r\n' }, /ít nhất 1/);
    expectError({ classes: undefined }, /ít nhất 1/);
  });
  it('26 distinct classes', () => {
    expectError({ classes: Array.from({ length: 26 }, (_, i) => `P${i}`).join('\n') }, /Tối đa 25/);
  });
  it('41-char class name (error mentions the name)', () => {
    const name = 'x'.repeat(41);
    const r = parse({ classes: `A\n${name}` });
    assert.match(r.error, /quá dài/);
    assert.ok(r.error.includes(name));
  });
  it('group count 0, 5, 10, negative, decimal, empty, garbage', () => {
    for (const groupCount of ['0', '5', '10', '11', '-1', '2.5', '', 'abc', undefined, '1e1', '0x5', '+3', '3e0', '0b11', '4.0', '1_0']) expectError({ groupCount }, /Số nhóm/);
  });
  it('war schedule invalid', () => {
    for (const war of ['', 'CN', '20:00', 'T8 20:00', 'CN 24:00', 'xyz', undefined]) expectError({ war }, /Lịch đánh/);
  });
  it('timing invalid formats', () => {
    for (const timing of ['', '2', '2/', '/3', '2-3', 'a/b', '-1/2', '2/3/4', undefined]) expectError({ timing }, /Hạn chốt\/nhắc/);
  });
  it('timing above 168 hours', () => {
    expectError({ timing: '169/1' }, /168/);
    expectError({ timing: '1/169' }, /168/);
  });
  it('open garbage', () => {
    expectError({ open: 'sometime' }, /Giờ mở đăng ký/);
    expectError({ open: 'T2' }, /Giờ mở đăng ký/);
  });
  it('open at/after the deadline is rejected', () => {
    // deadline = CN 18:00
    expectError({ war: 'CN 20:00', open: 'CN 18:00', timing: '2/0' }, /trước hạn chốt/);
    expectError({ war: 'CN 20:00', open: 'CN 19:00', timing: '2/0' }, /trước hạn chốt/);
    expectError({ war: 'CN 20:00', open: 'CN 20:00', timing: '0/0' }, /trước hạn chốt/);
    // lock 168h -> deadline is a full week before the war, any open time is too late
    expectError({ war: 'CN 20:00', open: 'T2 09:00', timing: '168/0' }, /trước hạn chốt/);
  });
});

describe('formatSettings', () => {
  const config = {
    classes: ['Thiết Y', 'Tố Vấn'],
    groupCount: 4,
    schedule: { enabled: true, warDay: 0, warTime: '20:00', openDay: 1, openTime: '09:00', lockBeforeHours: 2, remindBeforeHours: 3 },
  };
  it('produces modal prefill strings', () => {
    assert.deepEqual(formatSettings(config), {
      classes: 'Thiết Y\nTố Vấn',
      groupCount: '4',
      war: 'CN 20:00',
      open: 'T2 09:00',
      timing: '2/3',
    });
  });
  it('open is empty when auto-open disabled', () => {
    assert.equal(formatSettings({ ...config, schedule: { ...config.schedule, enabled: false } }).open, '');
  });
  it('round-trips through parseSettings (enabled)', () => {
    const r = parseSettings(formatSettings(config));
    assert.deepEqual(r.value, { classes: config.classes, classEmojis: [], groupCount: config.groupCount, schedule: config.schedule });
  });
  it('round-trips through parseSettings (disabled, decimal timing)', () => {
    const c = { ...config, schedule: { ...config.schedule, enabled: false, lockBeforeHours: 1.5, remindBeforeHours: 0 } };
    const r = parseSettings(formatSettings(c));
    const { openDay, openTime, ...rest } = c.schedule;
    assert.deepEqual(r.value.schedule, rest);
  });
  it('round-trips the shipped defaults', () => {
    const { warDurationMinutes, ...schedule } = defaults.schedule; // fixed duration is not a settings field
    const c = { classes: defaults.classes, groupCount: defaults.groupCount, schedule: { ...schedule, enabled: true } };
    assert.deepEqual(parseSettings(formatSettings(c)).value, { classes: c.classes, classEmojis: [], groupCount: c.groupCount, schedule: c.schedule });
  });
});
