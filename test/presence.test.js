// The bot's status line: text per war state, the soonest war wins, one gateway update per minute.
const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const presence = require('../src/bot/presence');
const { vn, oid } = require('./helpers');

const config = { classes: ['Tố Vấn', 'Thiết Y'], groupCount: 2 };
const war = (over = {}) => ({ _id: oid(1), guildId: 'g1', title: 'Bang chiến', startAt: vn(2026, 11, 14, 20), deadlineAt: vn(2026, 11, 14, 18), status: 'open', ...over });
const regs = (join, absent = 0) => [
  ...Array.from({ length: join }, (_, i) => ({ discordId: `j${i}`, status: 'join', className: 'Tố Vấn' })),
  ...Array.from({ length: absent }, (_, i) => ({ discordId: `a${i}`, status: 'absent' })),
];
const clientOf = () => {
  const sent = [];
  return { sent, user: { setPresence: (p) => sent.push(p) } };
};
const textOf = (p) => (p.activities[0] ? p.activities[0].state : null);

beforeEach(() => {
  mock.timers.reset();
  presence.reset();
});

describe('presence text', () => {
  it('an open war shows joins over the capacity and the local start', () => {
    assert.equal(presence.textFor(war(), regs(27, 3), config), 'Báo danh 27/60 · T7 14/11 20:00');
  });
  it('a locked or published war shows the head count; a finished one shows nothing', () => {
    assert.equal(presence.textFor(war({ status: 'locked' }), regs(31), config), 'Bang chiến T7 14/11 20:00 · 31 người');
    assert.equal(presence.textFor(war({ status: 'published' }), regs(31), config), 'Bang chiến T7 14/11 20:00 · 31 người');
    assert.equal(presence.textFor(war({ status: 'done' }), regs(31), config), null);
    assert.equal(presence.textFor(null, [], config), null);
  });
});

describe('presence updates', () => {
  it('the first note is sent at once as a custom status; the same text is not sent twice', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: vn(2026, 11, 10, 12).getTime() });
    const c = clientOf();
    presence.note(c, war(), regs(5), config);
    assert.equal(c.sent.length, 1);
    assert.equal(textOf(c.sent[0]), 'Báo danh 5/60 · T7 14/11 20:00');
    assert.equal(c.sent[0].activities[0].type, 4, 'ActivityType.Custom');
    mock.timers.tick(presence.MIN_GAP_MS + 1);
    presence.note(c, war(), regs(5), config);
    assert.equal(c.sent.length, 1);
  });
  it('a burst of clicks gives one update after the gap, with the newest numbers', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: vn(2026, 11, 10, 12).getTime() });
    const c = clientOf();
    presence.note(c, war(), regs(1), config);
    presence.note(c, war(), regs(2), config);
    presence.note(c, war(), regs(3), config);
    assert.equal(c.sent.length, 1);
    mock.timers.tick(presence.MIN_GAP_MS);
    assert.deepEqual(c.sent.map(textOf), ['Báo danh 1/60 · T7 14/11 20:00', 'Báo danh 3/60 · T7 14/11 20:00']);
  });
  it('with two servers the war that starts first is shown; a finished war clears its line', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: vn(2026, 11, 10, 12).getTime() });
    const c = clientOf();
    presence.note(c, war({ guildId: 'g2', startAt: vn(2026, 11, 15, 20) }), regs(9), config);
    mock.timers.tick(presence.MIN_GAP_MS);
    presence.note(c, war(), regs(4), config);
    assert.equal(textOf(c.sent.at(-1)), 'Báo danh 4/60 · T7 14/11 20:00');
    mock.timers.tick(presence.MIN_GAP_MS);
    presence.note(c, war({ status: 'done' }), regs(4), config);
    assert.equal(textOf(c.sent.at(-1)), 'Báo danh 9/60 · CN 15/11 20:00');
    mock.timers.tick(presence.MIN_GAP_MS);
    presence.note(c, war({ guildId: 'g2', startAt: vn(2026, 11, 15, 20), status: 'done' }), [], config);
    assert.deepEqual(c.sent.at(-1), { activities: [] });
  });
  it('a war nobody reported as finished stops showing 6 hours after its start', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: vn(2026, 11, 14, 19).getTime() });
    const c = clientOf();
    presence.note(c, war({ guildId: 'g2' }), regs(9), config);
    mock.timers.tick(8 * 3600 * 1000);
    presence.note(c, war({ guildId: 'g3', startAt: vn(2026, 11, 21, 20) }), regs(1), config);
    assert.equal(textOf(c.sent.at(-1)), 'Báo danh 1/60 · T7 21/11 20:00');
  });
  it('never throws: a client that is not ready, or a failing gateway call', () => {
    mock.method(console, 'warn', () => {});
    presence.note({ user: null }, war(), regs(1), config);
    presence.note({ user: { setPresence() { throw new Error('boom'); } } }, war(), regs(2), config);
    presence.note(clientOf(), null);
  });
});
