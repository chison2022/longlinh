const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const w = require('../src/services/warService');
const { HOUR } = require('../src/utils/time');
const { vn, oid, sid } = require('./helpers');

const schedule = { warDay: 0, warTime: '20:00', openDay: 1, openTime: '09:00', lockBeforeHours: 2, remindBeforeHours: 3, enabled: true };

describe('computeCycle', () => {
  it('open earlier in the same week as the war', () => {
    const c = w.computeCycle(schedule, vn(2026, 10, 6, 10, 0)); // Tue
    assert.deepEqual(c.warStart, vn(2026, 10, 11, 20, 0));
    assert.deepEqual(c.openAt, vn(2026, 10, 5, 9, 0));
    assert.deepEqual(c.deadline, vn(2026, 10, 11, 18, 0));
  });
  it('open weekday after war weekday wraps to the previous week', () => {
    const s = { ...schedule, warDay: 2, openDay: 4 }; // war Tue 20:00, open Thu 09:00
    const c = w.computeCycle(s, vn(2026, 10, 7, 10, 0)); // Wed
    assert.deepEqual(c.warStart, vn(2026, 10, 13, 20, 0));
    assert.deepEqual(c.openAt, vn(2026, 10, 8, 9, 0));
  });
  it('during a war in progress the cycle points to next week', () => {
    const c = w.computeCycle(schedule, vn(2026, 10, 11, 20, 30));
    assert.deepEqual(c.warStart, vn(2026, 10, 18, 20, 0));
    assert.deepEqual(c.openAt, vn(2026, 10, 12, 9, 0));
  });
  it('exactly at war start -> next week (strictly after)', () => {
    const c = w.computeCycle(schedule, vn(2026, 10, 11, 20, 0));
    assert.deepEqual(c.warStart, vn(2026, 10, 18, 20, 0));
  });
  it('1 ms before war start -> this war', () => {
    const c = w.computeCycle(schedule, new Date(vn(2026, 10, 11, 20, 0).getTime() - 1));
    assert.deepEqual(c.warStart, vn(2026, 10, 11, 20, 0));
  });
  it('open time equal to war time and day -> openAt == warStart', () => {
    const c = w.computeCycle({ ...schedule, openDay: 0, openTime: '20:00' }, vn(2026, 10, 6, 10, 0));
    assert.deepEqual(c.openAt, c.warStart);
  });
  it('fractional lock hours', () => {
    const c = w.computeCycle({ ...schedule, lockBeforeHours: 1.5 }, vn(2026, 10, 6, 10, 0));
    assert.deepEqual(c.deadline, vn(2026, 10, 11, 18, 30));
  });
  it('invariant: openAt <= warStart and openAt > warStart - 7d', () => {
    for (let d = 0; d < 7; d++) {
      const c = w.computeCycle({ ...schedule, openDay: d }, vn(2026, 10, 6, 10, 0));
      assert.ok(c.openAt <= c.warStart);
      assert.ok(c.warStart - c.openAt < 7 * 24 * HOUR);
    }
  });
});

describe('remindAtFor', () => {
  const deadline = vn(2026, 10, 11, 18, 0);
  const now = vn(2026, 10, 6, 10, 0);
  it('returns deadline minus N hours', () => {
    assert.deepEqual(w.remindAtFor(deadline, 3, now), vn(2026, 10, 11, 15, 0));
    assert.deepEqual(w.remindAtFor(deadline, 0.5, now), vn(2026, 10, 11, 17, 30));
  });
  it('null when off (0, negative, missing, NaN)', () => {
    for (const h of [0, -1, undefined, null, NaN]) assert.equal(w.remindAtFor(deadline, h, now), null);
  });
  it('null when the reminder time is already past or exactly now', () => {
    assert.equal(w.remindAtFor(deadline, 3, vn(2026, 10, 11, 16, 0)), null);
    assert.equal(w.remindAtFor(deadline, 3, vn(2026, 10, 11, 15, 0)), null);
    assert.ok(w.remindAtFor(deadline, 3, new Date(vn(2026, 10, 11, 15, 0).getTime() - 1)));
  });
});

describe('shouldAutoCreate', () => {
  const cycle = w.computeCycle(schedule, vn(2026, 10, 6, 10, 0));
  const ev = (startAt, status = 'open') => ({ startAt, status });
  it('true inside [openAt, deadline) with no events', () => {
    assert.equal(w.shouldAutoCreate(cycle, vn(2026, 10, 6, 10, 0), []), true);
    assert.equal(w.shouldAutoCreate(cycle, cycle.openAt, []), true);
    assert.equal(w.shouldAutoCreate(cycle, new Date(cycle.deadline.getTime() - 1), []), true);
  });
  it('false before openAt and at/after deadline', () => {
    assert.equal(w.shouldAutoCreate(cycle, new Date(cycle.openAt.getTime() - 1), []), false);
    assert.equal(w.shouldAutoCreate(cycle, cycle.deadline, []), false);
  });
  it('false when an active event starts within ±12h (inclusive)', () => {
    const now = vn(2026, 10, 6, 10, 0);
    const s = cycle.warStart.getTime();
    assert.equal(w.shouldAutoCreate(cycle, now, [ev(new Date(s))]), false);
    assert.equal(w.shouldAutoCreate(cycle, now, [ev(new Date(s + 12 * HOUR))]), false);
    assert.equal(w.shouldAutoCreate(cycle, now, [ev(new Date(s - 12 * HOUR), 'locked')]), false);
    assert.equal(w.shouldAutoCreate(cycle, now, [ev(new Date(s).toISOString(), 'published')]), false);
  });
  it('true when the only nearby events are outside the window or done', () => {
    const now = vn(2026, 10, 6, 10, 0);
    const s = cycle.warStart.getTime();
    assert.equal(w.shouldAutoCreate(cycle, now, [ev(new Date(s + 12 * HOUR + 1)), ev(new Date(s - 12 * HOUR - 1))]), true);
    assert.equal(w.shouldAutoCreate(cycle, now, [ev(new Date(s), 'done')]), true);
  });
});

describe('buildTitle', () => {
  it('contains schedule and local date', () => {
    assert.equal(w.buildTitle(vn(2026, 10, 11, 20, 0), schedule), 'Bang chiến CN 20:00 (11/10)');
  });
});

describe('warEnd / formatWarWindow', () => {
  const sat = vn(2026, 10, 10, 20, 0);
  it('uses warDurationMinutes, falling back to the default 60 for old saved schedules', () => {
    assert.deepEqual(w.warEnd(sat, { warDurationMinutes: 90 }), vn(2026, 10, 10, 21, 30));
    assert.deepEqual(w.warEnd(sat, schedule), vn(2026, 10, 10, 21, 0));
    assert.deepEqual(w.warEnd(sat, undefined), vn(2026, 10, 10, 21, 0));
  });
  it('formats weekday, date and the time window', () => {
    assert.equal(w.formatWarWindow(sat, { ...schedule, warDay: 6 }), 'T7 10/10 20:00–21:00');
    assert.equal(w.formatWarWindow(vn(2026, 10, 11, 20, 0), { ...schedule, warDay: 6 }), 'CN 11/10 20:00–21:00', 'weekday comes from the date');
  });
});

describe('validateEventTimes', () => {
  const now = vn(2026, 10, 6, 10, 0);
  it('null for valid times (deadline == start allowed)', () => {
    assert.equal(w.validateEventTimes(vn(2026, 10, 11, 20), vn(2026, 10, 11, 18), now), null);
    assert.equal(w.validateEventTimes(vn(2026, 10, 11, 20), vn(2026, 10, 11, 20), now), null);
  });
  it('errors for missing start / deadline', () => {
    assert.match(w.validateEventTimes(null, vn(2026, 10, 11, 18), now), /Giờ đánh không hợp lệ/);
    assert.match(w.validateEventTimes(vn(2026, 10, 11, 20), null, now), /Hạn chốt không hợp lệ/);
  });
  it('start must be strictly in the future', () => {
    assert.match(w.validateEventTimes(now, now, now), /tương lai/);
    assert.match(w.validateEventTimes(vn(2026, 10, 5, 20), vn(2026, 10, 5, 18), now), /tương lai/);
  });
  it('deadline already passed (<= now) is rejected', () => {
    assert.match(w.validateEventTimes(vn(2026, 10, 11, 20), now, now), /Hạn chốt đã qua/);
    assert.match(w.validateEventTimes(vn(2026, 10, 11, 20), vn(2026, 10, 5, 18), now), /Hạn chốt đã qua/);
    assert.equal(w.validateEventTimes(vn(2026, 10, 11, 20), new Date(now.getTime() + 1), now), null);
  });
  it('deadline after start is rejected', () => {
    assert.match(w.validateEventTimes(vn(2026, 10, 11, 20), vn(2026, 10, 11, 20, 1), now), /trước hoặc bằng/);
  });
});

describe('canRegister', () => {
  const deadline = vn(2026, 10, 11, 18, 0);
  it('open and before/at deadline', () => {
    assert.equal(w.canRegister({ status: 'open', deadlineAt: deadline }, vn(2026, 10, 6)), true);
    assert.equal(w.canRegister({ status: 'open', deadlineAt: deadline.toISOString() }, deadline), true);
  });
  it('false after deadline', () => {
    assert.equal(w.canRegister({ status: 'open', deadlineAt: deadline }, new Date(deadline.getTime() + 1)), false);
  });
  it('false when not open', () => {
    for (const status of ['locked', 'published', 'done']) {
      assert.equal(w.canRegister({ status, deadlineAt: deadline }, vn(2026, 10, 6)), false);
    }
  });
});

describe('buildReminderMessages', () => {
  const header = '⏰ **Bang chiến** sắp hết hạn.\nChưa đăng ký:';
  const mentionRe = /<@\d+>/g;
  it('single message when everything fits', () => {
    const ids = [sid(1), sid(2)];
    assert.deepEqual(w.buildReminderMessages(header, ids), [`${header} <@${sid(1)}> <@${sid(2)}>`]);
  });
  it('returns just the header for no ids', () => {
    assert.deepEqual(w.buildReminderMessages(header, []), [header]);
  });
  it('returns [] for empty header and no ids', () => {
    assert.deepEqual(w.buildReminderMessages('', []), []);
  });
  it('empty header: first message starts with a mention', () => {
    const msgs = w.buildReminderMessages('', [sid(1)]);
    assert.deepEqual(msgs, [`<@${sid(1)}>`]);
  });
  it('chunks 300 ids: every chunk <= limit, header only in first, no split mentions, order preserved', () => {
    const ids = Array.from({ length: 300 }, (_, i) => sid(i));
    for (const limit of [1900, 200, 100]) {
      const msgs = w.buildReminderMessages(header, ids, limit);
      assert.ok(msgs.length > 1);
      msgs.forEach((m, i) => {
        assert.ok(m.length <= limit, `chunk ${i} length ${m.length} > ${limit}`);
        if (i === 0) assert.ok(m.startsWith(header));
        else assert.ok(!m.includes(header));
        const rest = i === 0 ? m.slice(header.length) : m;
        assert.match(rest, /^( ?<@\d+>)*$/, `chunk ${i} has a broken mention`);
      });
      const all = msgs.join(' ').match(mentionRe).map((s) => s.slice(2, -1));
      assert.deepEqual(all, ids);
    }
  });
  it('header + first mention exceeding limit pushes header alone', () => {
    const msgs = w.buildReminderMessages('x'.repeat(95), [sid(1)], 100);
    assert.deepEqual(msgs, ['x'.repeat(95), `<@${sid(1)}>`]);
  });
});

describe('messageLink', () => {
  it('builds a jump link', () => {
    assert.equal(w.messageLink({ guildId: '1', channelId: '2', messageId: '3', _id: oid() }), 'https://discord.com/channels/1/2/3');
  });
  it('empty when the message was not posted', () => {
    assert.equal(w.messageLink({ guildId: '1', channelId: '2', messageId: null }), '');
    assert.equal(w.messageLink({ guildId: '1' }), '');
  });
});
