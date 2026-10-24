// The war lifecycle on an in-memory PostgreSQL (test/pgdb.js): one war per guild and start, compare-and-set claims and transitions.
const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { setupDb, resetDb } = require('./pgdb');
const w = require('../src/services/warService');
const { sid } = require('./helpers');

const G = '800000000000000001';
const START = new Date('2026-10-10T13:00:00Z');
let ev;

before(setupDb);
beforeEach(async () => {
  await resetDb();
  await db.q('insert into guilds (id) values ($1)', [G]);
  ev = await w.createEvent({ guildId: G, title: 'Bang chiến', startAt: START, deadlineAt: START });
});

describe('war lifecycle', () => {
  it('one war per guild and start time (unique)', async () => {
    assert.equal((await w.getEvent(ev._id)).title, 'Bang chiến');
    await assert.rejects(() => w.createEvent({ guildId: G, title: 'again', startAt: START, deadlineAt: START }), (err) => db.isUniqueViolation(err));
  });
  it('getCurrentEvent picks the nearest war that is not done; getLatestEvent the newest of any status', async () => {
    const later = await w.createEvent({ guildId: G, title: 'later', startAt: new Date('2026-10-17T13:00:00Z'), deadlineAt: new Date('2026-10-17T13:00:00Z') });
    assert.equal(String((await w.getCurrentEvent(G))._id), String(ev._id));
    await w.markDone(ev._id);
    assert.equal(String((await w.getCurrentEvent(G))._id), String(later._id));
    assert.equal(String((await w.getLatestEvent(G))._id), String(later._id));
  });
  it('status transitions only from the allowed states; publishEvent sets publishedAt to the snapshot, advance:false leaves it', async () => {
    assert.equal((await w.lockEvent(ev._id)).status, 'locked');
    assert.equal(await w.lockEvent(ev._id), null, 'not open any more');
    const snap = new Date('2026-10-10T12:00:00Z');
    assert.equal((await w.publishEvent(ev._id, snap)).publishedAt.toISOString(), snap.toISOString());
    assert.equal((await w.publishEvent(ev._id, new Date(), { advance: false })).publishedAt.toISOString(), snap.toISOString());
    assert.equal((await w.markDone(ev._id)).status, 'done');
    assert.equal(await w.reopenEvent(ev._id, START), null);
  });
  it('claimPost / claimReminder / moveMessage are compare-and-set: one caller wins', async () => {
    const [a, b] = await Promise.all([w.claimPost(ev._id), w.claimPost(ev._id)]);
    assert.equal(a !== b, true, 'exactly one claim');
    await w.setMessage(ev._id, 'chan', 'm1');
    assert.equal(await w.claimPost(ev._id), false, 'a posted message is never posted again');
    assert.equal(await w.claimReminder(ev._id), true);
    assert.equal(await w.claimReminder(ev._id), false);
    assert.equal(await w.moveMessage(ev._id, 'm1', 'chan2', 'm2'), true);
    assert.equal(await w.moveMessage(ev._id, 'm1', 'chan3', 'm3'), false, 'already moved');
  });
  it('upsertRegistration onlyIfOpen writes nothing once the war is locked or past its deadline', async () => {
    const reg = require('../src/services/registrationService');
    const open = await w.createEvent({ guildId: G, title: 'open', startAt: new Date(Date.now() + 864e5), deadlineAt: new Date(Date.now() + 36e5) });
    const row = { guildId: G, discordId: sid(1), displayName: 'A', status: 'join', className: 'Tố Vấn', onlyIfOpen: true };
    assert.equal((await reg.upsertRegistration({ ...row, eventId: open._id })).status, 'join');
    await w.lockEvent(open._id);
    assert.equal(await reg.upsertRegistration({ ...row, eventId: open._id, status: 'absent' }), null);
    assert.equal((await reg.listRegistrations(open._id))[0].status, 'join', 'the locked war kept the old answer');
    assert.equal(await reg.upsertRegistration({ ...row, eventId: ev._id }), null, 'deadline passed');
  });
  it('isConnected follows the last round trip: a connection error marks it down, an SQL error does not', async () => {
    assert.equal(db.isConnected(), true);
    await assert.rejects(() => db.q('select * from no_such_table'));
    assert.equal(db.isConnected(), true, 'an SQL error is not an outage');
  });
  it('a malformed id finds nothing and writes nothing', async () => {
    assert.equal(await w.getEvent('nope'), null);
    assert.equal(await w.lockEvent('nope'), null);
    assert.equal((await w.deleteEvent('nope')).deletedCount, 0);
  });
  it('registrations of a deleted war go with it', async () => {
    const reg = require('../src/services/registrationService');
    await reg.upsertRegistration({ eventId: ev._id, guildId: G, discordId: sid(1), displayName: 'A', status: 'join', className: 'Tố Vấn' });
    assert.equal((await w.deleteEvent(ev._id)).deletedCount, 1);
    assert.equal((await db.one('select count(*) as n from registrations')).n, 0);
  });
});
