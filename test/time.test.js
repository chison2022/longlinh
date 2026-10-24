const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const t = require('../src/utils/time');
const { vn } = require('./helpers');

describe('parseTime', () => {
  it('parses HH:mm, H:mm, Hh, HhMM', () => {
    assert.deepEqual(t.parseTime('20:00'), { hour: 20, minute: 0 });
    assert.deepEqual(t.parseTime('9:05'), { hour: 9, minute: 5 });
    assert.deepEqual(t.parseTime('9h'), { hour: 9, minute: 0 });
    assert.deepEqual(t.parseTime('21H30'), { hour: 21, minute: 30 });
    assert.deepEqual(t.parseTime('  07:45  '), { hour: 7, minute: 45 });
  });
  it('accepts boundaries 00:00 and 23:59', () => {
    assert.deepEqual(t.parseTime('00:00'), { hour: 0, minute: 0 });
    assert.deepEqual(t.parseTime('23:59'), { hour: 23, minute: 59 });
  });
  it('rejects out-of-range and malformed input', () => {
    for (const bad of ['24:00', '23:60', '20:5', '20', '', 'abc', '-1:00', '20:00:00', '120:00', null, undefined, '20 00']) {
      assert.equal(t.parseTime(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
});

describe('parseDay', () => {
  it('maps CN / Chủ nhật to 0', () => {
    for (const s of ['CN', 'cn', ' Cn ', 'Chủ nhật', 'chu nhat', 'CHỦ NHẬT']) assert.equal(t.parseDay(s), 0, s);
  });
  it('maps T2..T7 to 1..6', () => {
    for (let d = 2; d <= 7; d++) assert.equal(t.parseDay(`T${d}`), d - 1);
  });
  it('accepts Thứ N with and without diacritics/spaces', () => {
    assert.equal(t.parseDay('Thứ 2'), 1);
    assert.equal(t.parseDay('thu 7'), 6);
    assert.equal(t.parseDay('THỨ5'), 4);
    assert.equal(t.parseDay('t 3'), 2);
    assert.equal(t.parseDay('4'), 3);
  });
  it('accepts decomposed (NFD) Vietnamese input', () => {
    assert.equal(t.parseDay('Thứ 2'.normalize('NFD')), 1);
  });
  it('returns null for garbage and out-of-range days', () => {
    for (const bad of ['T1', 'T8', '1', '8', 'Thứ Hai', 'monday', '', 'CNN', 'T22', null, undefined]) {
      assert.equal(t.parseDay(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
});

describe('parseDayTime', () => {
  it('parses day + time and normalizes the time', () => {
    assert.deepEqual(t.parseDayTime('CN 20:00'), { day: 0, time: '20:00' });
    assert.deepEqual(t.parseDayTime('Thứ 7 9h'), { day: 6, time: '09:00' });
    assert.deepEqual(t.parseDayTime('  t2   9:05 '), { day: 1, time: '09:05' });
  });
  it('returns null for missing parts or invalid values', () => {
    for (const bad of ['CN', '20:00', 'CN 25:00', 'T9 20:00', '', 'garbage text', null]) {
      assert.equal(t.parseDayTime(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
  it('round-trips through formatDayTime', () => {
    for (let d = 0; d < 7; d++) {
      const s = t.formatDayTime(d, '06:30');
      assert.deepEqual(t.parseDayTime(s), { day: d, time: '06:30' });
    }
  });
});

describe('nextWeekly', () => {
  // 2026-10-06 is a Tuesday (VN). 2026-10-11 is Sunday.
  it('finds the next occurrence later in the same week', () => {
    assert.deepEqual(t.nextWeekly(0, '20:00', vn(2026, 10, 6, 10, 0)), vn(2026, 10, 11, 20, 0));
  });
  it('same weekday, later time today -> today', () => {
    assert.deepEqual(t.nextWeekly(2, '20:00', vn(2026, 10, 6, 10, 0)), vn(2026, 10, 6, 20, 0));
  });
  it('same weekday, earlier time today -> next week', () => {
    assert.deepEqual(t.nextWeekly(2, '20:00', vn(2026, 10, 6, 21, 0)), vn(2026, 10, 13, 20, 0));
  });
  it('is strictly after: exact match rolls to next week', () => {
    const at = vn(2026, 10, 11, 20, 0);
    assert.deepEqual(t.nextWeekly(0, '20:00', at), vn(2026, 10, 18, 20, 0));
    assert.deepEqual(t.nextWeekly(0, '20:00', new Date(at.getTime() - 1)), at);
  });
  it('CN 06:00 VN is Saturday 23:00 UTC', () => {
    const r = t.nextWeekly(0, '06:00', vn(2026, 10, 6, 12, 0));
    assert.equal(r.toISOString(), '2026-10-10T23:00:00.000Z');
    assert.equal(r.getUTCDay(), 6);
  });
  it('uses the VN weekday when UTC is still the previous day', () => {
    // 2026-10-11 03:00 VN (Sunday) == 2026-10-10 20:00 UTC (Saturday)
    const after = vn(2026, 10, 11, 3, 0);
    assert.equal(after.getUTCDay(), 6);
    assert.deepEqual(t.nextWeekly(0, '06:00', after), vn(2026, 10, 11, 6, 0));
    // Saturday target from VN Sunday -> next Saturday, not "today in UTC"
    assert.deepEqual(t.nextWeekly(6, '23:00', after), vn(2026, 10, 17, 23, 0));
  });
  it('handles VN midnight boundary (00:00 local)', () => {
    assert.deepEqual(t.nextWeekly(0, '00:00', vn(2026, 10, 10, 23, 59)), vn(2026, 10, 11, 0, 0));
  });
  it('rolls over month and year', () => {
    assert.deepEqual(t.nextWeekly(0, '20:00', vn(2026, 12, 31, 12, 0)), vn(2027, 1, 3, 20, 0));
    assert.deepEqual(t.nextWeekly(1, '09:00', vn(2026, 10, 30, 12, 0)), vn(2026, 11, 2, 9, 0));
  });
  it('rolls over Feb in a leap year', () => {
    // 2028-02-27 is Sunday; next Tuesday = 2028-02-29
    assert.deepEqual(t.nextWeekly(2, '20:00', vn(2028, 2, 27, 12, 0)), vn(2028, 2, 29, 20, 0));
  });
  it('result is always in (after, after + 7 days] with the right VN weekday/time', () => {
    const base = vn(2026, 10, 6, 0, 0);
    for (let h = 0; h < 24 * 8; h += 5) {
      const after = new Date(base.getTime() + h * t.HOUR);
      for (let dow = 0; dow < 7; dow++) {
        const r = t.nextWeekly(dow, '13:37', after);
        assert.ok(r > after);
        assert.ok(r.getTime() - after.getTime() <= 7 * t.DAY);
        const local = new Date(r.getTime() + 7 * t.HOUR);
        assert.equal(local.getUTCDay(), dow);
        assert.equal(local.getUTCHours(), 13);
        assert.equal(local.getUTCMinutes(), 37);
      }
    }
  });
});

describe('previousWeekly', () => {
  it('returns the occurrence at or before the reference', () => {
    assert.deepEqual(t.previousWeekly(1, '09:00', vn(2026, 10, 11, 20, 0)), vn(2026, 10, 5, 9, 0));
  });
  it('inclusive: exact match returns the same instant', () => {
    const at = vn(2026, 10, 11, 20, 0);
    assert.deepEqual(t.previousWeekly(0, '20:00', at), at);
  });
  it('one ms before an occurrence returns the previous week', () => {
    const at = vn(2026, 10, 11, 20, 0);
    assert.deepEqual(t.previousWeekly(0, '20:00', new Date(at.getTime() - 1)), vn(2026, 10, 4, 20, 0));
  });
  it('crosses year boundary backwards', () => {
    assert.deepEqual(t.previousWeekly(4, '09:00', vn(2027, 1, 3, 20, 0)), vn(2026, 12, 31, 9, 0));
  });
});

describe('parseLocalDateTime', () => {
  const now = vn(2026, 10, 6, 10, 0);
  it('parses dd/mm HH:mm in VN time using the current local year', () => {
    assert.deepEqual(t.parseLocalDateTime('25/12 20:00', now), vn(2026, 12, 25, 20, 0));
    assert.deepEqual(t.parseLocalDateTime('1/11 9h', now), vn(2026, 11, 1, 9, 0));
  });
  it('parses dd/mm/yyyy HH:mm with explicit year', () => {
    assert.deepEqual(t.parseLocalDateTime('25/12/2027 20:00', now), vn(2027, 12, 25, 20, 0));
  });
  it('explicit past year is kept (no rollover)', () => {
    assert.deepEqual(t.parseLocalDateTime('01/01/2026 20:00', now), vn(2026, 1, 1, 20, 0));
  });
  it('omitted year: recent past (<30 days) stays in current year', () => {
    assert.deepEqual(t.parseLocalDateTime('01/10 20:00', now), vn(2026, 10, 1, 20, 0));
  });
  it('omitted year: long past (>30 days) rolls to next year', () => {
    assert.deepEqual(t.parseLocalDateTime('01/08 20:00', now), vn(2027, 8, 1, 20, 0));
  });
  it('omitted year: typing early January in late December means next year', () => {
    assert.deepEqual(t.parseLocalDateTime('02/01 20:00', vn(2026, 12, 28, 10, 0)), vn(2027, 1, 2, 20, 0));
  });
  it('uses the VN year, not the UTC year, near New Year', () => {
    const nyNow = vn(2027, 1, 1, 1, 0); // still 2026 in UTC
    assert.equal(nyNow.getUTCFullYear(), 2026);
    assert.deepEqual(t.parseLocalDateTime('01/01 20:00', nyNow), vn(2027, 1, 1, 20, 0));
  });
  it('accepts 29/02 in a leap year', () => {
    assert.deepEqual(t.parseLocalDateTime('29/02/2028 20:00', now), vn(2028, 2, 29, 20, 0));
  });
  it('omitted year: 29/02 is rejected when the year is not a leap year', () => {
    assert.equal(t.parseLocalDateTime('29/02 20:00', vn(2027, 1, 10, 10, 0)), null);
    assert.deepEqual(t.parseLocalDateTime('29/02 20:00', vn(2028, 1, 10, 10, 0)), vn(2028, 2, 29, 20, 0));
  });
  it('rejects malformed text', () => {
    for (const bad of ['', '25/12', '25-12 20:00', '25/12 25:00', '25/12 20:00 extra', '32/01 20:00', '00/01 20:00', '15/13 20:00', '15/00 20:00', 'abc', null]) {
      assert.equal(t.parseLocalDateTime(bad, now), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
  it('rejects impossible calendar dates instead of rolling over (31/02, 31/04, 29/02 non-leap)', () => {
    for (const bad of ['31/02 20:00', '30/02/2028 20:00', '31/04 20:00', '29/02/2027 20:00', '31/11/2026 09:00']) {
      const got = t.parseLocalDateTime(bad, now);
      assert.equal(got, null, `expected null for ${bad}, got ${got && got.toISOString()}`);
    }
  });
});

describe('formatLocalDateTime', () => {
  it('formats in VN time with zero padding', () => {
    assert.equal(t.formatLocalDateTime(vn(2026, 1, 2, 3, 4)), '02/01 03:04');
    // 2026-10-10T23:00Z = Sunday 11/10 06:00 VN
    assert.equal(t.formatLocalDateTime(new Date('2026-10-10T23:00:00Z')), '11/10 06:00');
  });
  it('round-trips with parseLocalDateTime', () => {
    const now = vn(2026, 10, 6, 10, 0);
    for (const s of ['25/12 20:00', '06/10 00:00', '31/12 23:59', '07/10 07:00']) {
      assert.equal(t.formatLocalDateTime(t.parseLocalDateTime(s, now)), s);
    }
    const d = vn(2026, 11, 15, 18, 30);
    assert.deepEqual(t.parseLocalDateTime(t.formatLocalDateTime(d), now), d);
  });
});

describe('discordTs', () => {
  it('formats seconds with default style F', () => {
    const d = new Date('2026-10-11T13:00:00Z');
    assert.equal(t.discordTs(d), `<t:${d.getTime() / 1000}:F>`);
  });
  it('floors milliseconds and honours style', () => {
    assert.equal(t.discordTs(new Date(1791810000999), 'R'), '<t:1791810000:R>');
  });
});
