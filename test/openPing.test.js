// The "registration is open" role ping: one short message tagging only the member role, at most once per war, never able to hurt the war post.
const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { setupDb, resetDb } = require('./pgdb');
const warService = require('../src/services/warService');
const { buildOpenPing, sendOpenPing } = require('../src/bot/openPing');
const { vn } = require('./helpers');

const G = '800000000000000001';
const ROLE = '700000000000000042';
let event;
let sent;
let client;
const config = (over = {}) => ({ guildId: G, announceChannelId: 'chan1', memberRoleId: ROLE, schedule: { openPing: true }, ...over });

before(setupDb);
beforeEach(async () => {
  await resetDb();
  await db.q('insert into guilds (id) values ($1)', [G]);
  const start = vn(2026, 11, 7, 20, 0);
  const made = await warService.createEvent({ guildId: G, title: 'Bang chiến T7 (07/11)', startAt: start, deadlineAt: vn(2026, 11, 7, 18, 0), auto: true });
  await warService.setMessage(made._id, 'chan1', 'msg1');
  event = await warService.getEvent(made._id);
  sent = [];
  client = { channels: { fetch: async () => ({ send: async (p) => sent.push(p) }) } };
});

describe('openPing', () => {
  it('one message: tags the member role only, names the war with its start and deadline, links the war message', async () => {
    assert.equal(await sendOpenPing(client, config(), event), true);
    assert.equal(sent.length, 1);
    const { content, allowedMentions } = sent[0];
    assert.deepEqual(allowedMentions, { roles: [ROLE] }, 'never everyone or users');
    assert.ok(content.startsWith(`<@&${ROLE}> 📢 Đã mở báo danh **Bang chiến T7 (07/11)**`));
    assert.match(content, /<t:\d+:f>/);
    assert.match(content, /✅ Tham gia \/ ❌ Vắng ở tin nhắn trên trước <t:\d+:R>!/);
    assert.ok(content.includes(`https://discord.com/channels/${G}/chan1/msg1`));
    assert.ok(!/@everyone|@here|<@\d/.test(content));
  });
  it('never twice: the claim is in the database, so a retry or a restart does not ping again', async () => {
    assert.equal(await sendOpenPing(client, config(), event), true);
    assert.equal(await sendOpenPing(client, config(), event), false);
    assert.equal(await sendOpenPing(client, config(), await warService.getEvent(event._id)), false, 'a fresh read of the war (as after a restart)');
    assert.equal(sent.length, 1);
    assert.ok((await warService.getEvent(event._id)).openPingedAt);
  });
  it('off by default, and without a member role there is nothing to tag', async () => {
    assert.equal(await sendOpenPing(client, config({ schedule: {} }), event), false);
    assert.equal(await sendOpenPing(client, config({ schedule: { openPing: false } }), event), false);
    assert.equal(await sendOpenPing(client, config({ memberRoleId: null }), event), false);
    assert.equal(await sendOpenPing(client, null, event), false);
    assert.equal(sent.length, 0);
    assert.equal((await warService.getEvent(event._id)).openPingedAt, null, 'nothing was claimed');
  });
  it('a failing send is isolated: no throw, false, and it is not retried (the war post is already out)', async () => {
    const failing = { channels: { fetch: async () => { throw new Error('Missing Access'); } } };
    assert.equal(await sendOpenPing(failing, config(), event), false);
    assert.equal(await sendOpenPing(client, config(), event), false, 'the claim stays: no later duplicate');
    assert.equal(sent.length, 0);
  });
  it('the text escapes markdown in the war title and uses the message of the war', () => {
    const { content } = buildOpenPing({ ...event, title: 'A *bold* _x_', messageId: null }, ROLE);
    assert.ok(content.includes('**A bold x**'));
    assert.ok(!content.includes('https://'));
  });
});

describe('Monday 12:00 opening', () => {
  const schedule = { enabled: true, warDay: 6, warTime: '20:00', openDay: 1, openTime: '12:00', lockBeforeHours: 2, remindBeforeHours: 3 };
  it('openDay 1 + openTime 12:00 creates the war at Monday 12:00 Vietnam time, not a minute before', () => {
    const cycle = warService.computeCycle(schedule, vn(2026, 11, 2, 11, 59));
    assert.equal(cycle.openAt.getTime(), vn(2026, 11, 2, 12, 0).getTime());
    assert.equal(cycle.warStart.getTime(), vn(2026, 11, 7, 20, 0).getTime());
    assert.equal(warService.shouldAutoCreate(cycle, vn(2026, 11, 2, 11, 59), []), false);
    assert.equal(warService.shouldAutoCreate(cycle, vn(2026, 11, 2, 12, 0), []), true);
    assert.equal(warService.shouldAutoCreate(cycle, vn(2026, 11, 5, 12, 0), []), true, 'any time until the deadline');
    assert.equal(warService.shouldAutoCreate(cycle, vn(2026, 11, 7, 18, 0), []), false, 'not after the deadline');
  });
});
