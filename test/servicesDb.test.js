// The remaining services on an in-memory PostgreSQL (test/pgdb.js): guild settings, registrations, Tuyến Khiên links, join requests,
// war attendance and the guild events lists.
const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { setupDb, resetDb } = require('./pgdb');
const cfg = require('../src/services/guildConfigService');
const reg = require('../src/services/registrationService');
const links = require('../src/services/linkService');
const gate = require('../src/services/gateService');
const war = require('../src/services/warService');
const att = require('../src/services/attendanceService');
const gr = require('../src/services/gameRosterService');
const ev = require('../src/services/eventService');
const features = require('../src/services/features');
const { sid } = require('./helpers');

const G = '800000000000000001';
const START = new Date('2026-10-10T13:00:00Z');

before(setupDb);
beforeEach(async () => {
  await resetDb();
  cfg.clearConfigCache();
});
const withGuild = () => db.q('insert into guilds (id) values ($1)', [G]);

describe('guild settings', () => {
  it('getConfig is null for an unknown guild; getOrCreateConfig stores every default once (features at the new-guild values)', async () => {
    assert.equal(await cfg.getConfig(G), null);
    const c = await cfg.getOrCreateConfig(G);
    assert.equal(c.guildId, G);
    assert.deepEqual(c.features, features.NEW_GUILD_DEFAULTS);
    assert.equal(c.groupCount, cfg.defaultConfig(G).groupCount);
    assert.deepEqual(c.schedule, cfg.defaultConfig(G).schedule);
    await cfg.updateConfig(G, { sheetId: 's1' });
    cfg.clearConfigCache();
    const again = await cfg.getOrCreateConfig(G);
    assert.equal(again.sheetId, 's1', 'a second call keeps what is stored');
    assert.equal((await db.one('select count(*) as n from guilds')).n, 1);
  });
  it('updateConfig replaces top-level keys only, refuses an out-of-range value, and creates a missing row from the defaults', async () => {
    const c = await cfg.updateConfig(G, { adminRoleIds: ['r1'], schedule: { ...cfg.defaultConfig(G).schedule, enabled: true } });
    assert.deepEqual(c.adminRoleIds, ['r1']);
    assert.equal(c.schedule.enabled, true);
    assert.deepEqual(c.classes, cfg.defaultConfig(G).classes, 'the rest comes from the defaults');
    await assert.rejects(() => cfg.updateConfig(G, { groupCount: 9 }), { name: 'ValidationError' });
    assert.equal((await cfg.getConfig(G, { fresh: true })).groupCount, cfg.defaultConfig(G).groupCount);
  });
  it('dates kept in the settings come back as Date; the list helpers filter on the JSON', async () => {
    await cfg.updateConfig(G, { departNoticeAt: START, announceChannelId: 'a', schedule: { ...cfg.defaultConfig(G).schedule, enabled: true }, panelChannelId: 'p', panelMessageId: 'm' });
    const c = await cfg.getConfig(G, { fresh: true });
    assert.ok(c.departNoticeAt instanceof Date);
    assert.deepEqual((await cfg.listScheduledConfigs()).map((x) => x.guildId), [G]);
    assert.deepEqual((await cfg.listPanelConfigs()).map((x) => x.guildId), [G]);
    assert.equal(await cfg.clearPanelIf(G, 'other'), false);
    assert.equal(await cfg.clearPanelIf(G, 'm'), true);
    assert.deepEqual(await cfg.listPanelConfigs(), []);
  });
});

describe('registrations', () => {
  let e;
  beforeEach(async () => {
    await withGuild();
    e = await war.createEvent({ guildId: G, title: 't', startAt: START, deadlineAt: START });
  });
  const up = (n, status, extra = {}) => reg.upsertRegistration({ eventId: e._id, guildId: G, discordId: sid(n), displayName: `P${n}`, status, className: 'Tố Vấn', ...extra });

  it('one row per member and war: a second click updates it, first registration time is kept', async () => {
    const first = await up(1, 'join');
    const second = await up(1, 'absent', { className: 'Huyết Hà' });
    assert.equal((await reg.listRegistrations(e._id)).length, 1);
    assert.deepEqual([second.status, second.className], ['absent', 'Huyết Hà']);
    assert.equal(second.createdAt.toISOString(), first.createdAt.toISOString());
  });
  it('the list is in registration order with the current display name of each member', async () => {
    await up(2, 'join');
    await up(1, 'join');
    await reg.syncMemberName(G, sid(2), 'Tên Mới');
    assert.deepEqual((await reg.listRegistrations(e._id)).map((r) => [r.discordId, r.displayName]), [[sid(2), 'Tên Mới'], [sid(1), 'P1']]);
  });
  it('parallel first clicks of one member make one row', async () => {
    await Promise.all([up(1, 'join'), up(1, 'absent'), up(1, 'join')]);
    assert.equal((await reg.listRegistrations(e._id)).length, 1);
  });
  it('the member remembers class and mission', async () => {
    await reg.saveMemberClass(G, sid(1), 'A', 'Thiết Y');
    await reg.saveMemberMission(G, sid(1), 'A', 'daytru');
    const m = await reg.getMember(G, sid(1));
    assert.deepEqual([m.className, m.missionPref, m.displayName], ['Thiết Y', 'daytru', 'A']);
  });
});

describe('Tuyến Khiên links', () => {
  beforeEach(withGuild);
  it('setLinks stores my picks; a removed pick drops me from the other list too; clearLinks works both ways', async () => {
    let r = await links.setLinks(G, sid(1), [sid(2), sid(3)]);
    assert.deepEqual(r.links.sort(), [sid(2), sid(3)].sort());
    await links.setLinks(G, sid(2), [sid(1)]);
    r = await links.setLinks(G, sid(1), [sid(3)], [sid(2), sid(3)]); // the menu showed 2 and 3, now only 3 is picked
    assert.deepEqual(r.links, [sid(3)]);
    const two = (await links.loadMembers(G)).find((m) => m.discordId === sid(2));
    assert.ok(!two || !two.links.includes(sid(1)), 'my unpick also removed me from their list');
    await links.clearLinks(G, sid(3));
    const all = await links.loadMembers(G);
    assert.ok(all.every((m) => !m.links.includes(sid(3))));
  });
  it('toggleCarries flips the passive flag', async () => {
    assert.equal(await links.toggleCarries(G, sid(1)), true);
    assert.equal(await links.toggleCarries(G, sid(1)), false);
    assert.equal(await links.toggleCarries(G, sid(1)), true);
    assert.deepEqual((await links.loadMembers(G)).map((m) => [m.discordId, m.tuyenKhien]), [[sid(1), true]]);
  });
});

describe('join requests', () => {
  beforeEach(async () => {
    await withGuild();
    await gr.saveImport({ guildId: G, members: [{ name: 'Hắc Phong', rank: 'Bang Chúng', className: 'Tố Vấn' }], importedAt: START });
  });
  const ask = (n, extra = {}) => gate.createPending({ guildId: G, discordId: sid(n), displayName: `Người ${n}`, gameName: 'Hắc Phong', gameNameFree: false, className: 'Tố Vấn', ...extra });

  it('one pending request per member: a second one returns the first; a roster name points at its character', async () => {
    const a = await ask(1);
    assert.equal(a.created, true);
    assert.ok(db.isId(String(a.request._id)));
    assert.deepEqual([a.request.discordId, a.request.displayName, a.request.status], [sid(1), 'Người 1', 'pending']);
    const b = await ask(1, { gameName: 'Khác', gameNameFree: true });
    assert.deepEqual([b.created, String(b.request._id)], [false, String(a.request._id)]);
    const row = await db.one('select character_id from gate_requests where id = $1', [a.request._id]);
    assert.ok(row.character_id, 'linked to the roster character');
  });
  it('the optional in-game ID is stored on the request and read back (null when not given)', async () => {
    const a = await ask(1, { gameUid: '12345678' });
    assert.equal(a.request.gameUid, '12345678');
    assert.equal((await gate.getRequest(a.request._id, G)).gameUid, '12345678');
    const b = await ask(2);
    assert.equal(b.request.gameUid, null);
  });
  it('another pending request with the same game ID: createPending answers a friendly uidClash instead of throwing; after that request is decided the ID is free again', async () => {
    const a = await ask(1, { gameUid: '12345678' });
    assert.equal(a.created, true);
    const b = await ask(2, { gameUid: '12345678' });
    assert.equal(b.created, false);
    assert.equal(b.request, null);
    assert.match(b.uidClash, /người khác dùng để xin vào bang/);
    assert.equal((await db.one(`select count(*) as n from gate_requests`)).n, 1);
    await gate.decide(a.request._id, 'cancelled', { by: 'x', reason: gate.UID_CLASH_REASON });
    assert.equal((await ask(2, { gameUid: '12345678' })).created, true);
  });
  it('the pending-ID index firing with no visible holder (a race) still answers a friendly uidClash', async () => {
    const real = gr.checkGameUid;
    await ask(1, { gameUid: '12345678' });
    gr.checkGameUid = async () => ({ uid: '12345678' }); // the holder vanished between the violation and the lookup
    try {
      const b = await ask(2, { gameUid: '12345678' });
      assert.equal(b.request, null);
      assert.match(b.uidClash, /vừa được người khác dùng/);
    } finally {
      gr.checkGameUid = real;
    }
  });
  it('decideWithUid: gives the ID to the character and approves in one go; a clash decides nothing; a lost race rolls the ID back', async () => {
    const mk = async (n, uid) => (await ask(n, { gameUid: uid })).request;
    const claimOf = (name, uid) => ({ guildId: G, name, uid });
    const uidOf = async (name) => (await db.one('select game_uid from game_characters where name = $1', [name])).game_uid;
    const r1 = await mk(1, '11111');
    const ok = await gate.decideWithUid(r1._id, 'approved', { by: 'm' }, claimOf('Hắc Phong', '11111'));
    assert.equal(ok.decided.status, 'approved');
    assert.equal(ok.claim.status, 'set');
    assert.equal(await uidOf('Hắc Phong'), '11111');
    // a different ID for a character that already has one: clash, the request stays pending
    const r2 = await mk(2, '22222');
    const clash = await gate.decideWithUid(r2._id, 'approved', { by: 'm' }, claimOf('Hắc Phong', '22222'));
    assert.match(clash.clash, /đã có một ID game khác/);
    assert.equal((await gate.getRequest(r2._id, G)).status, 'pending');
    assert.equal(await uidOf('Hắc Phong'), '11111');
    // already decided by somebody else: nothing is kept
    await gate.decide(r2._id, 'rejected', { by: 'other' });
    await db.q(`update game_characters set game_uid = null where name = 'Hắc Phong'`);
    const lost = await gate.decideWithUid(r2._id, 'approved', { by: 'm' }, claimOf('Hắc Phong', '22222'));
    assert.equal(lost.decided, null);
    assert.equal(await uidOf('Hắc Phong'), null, 'the claim was rolled back with the lost decision');
    // an old request without an ID is just decided
    const old = (await ask(3)).request;
    assert.equal((await gate.decideWithUid(old._id, 'approved', { by: 'm' }, null)).decided.status, 'approved');
  });
  it('an ID clash cancellation is exempt from the 12 h cooldown, a rejection is not', async () => {
    const a = await ask(1, { gameUid: '12345678' });
    await gate.decide(a.request._id, 'cancelled', { by: 'm', reason: gate.UID_CLASH_REASON });
    assert.equal(await gate.recentDecision(G, sid(1)), null);
    const b = await ask(1, { gameUid: '12345678' });
    await gate.decide(b.request._id, 'rejected', { by: 'm', reason: 'no' });
    assert.ok(await gate.recentDecision(G, sid(1)));
  });
  it('unnoteRequest takes back the last count of the hourly limit', () => {
    gate.resetRequestLimits();
    for (let n = 0; n < 3; n++) gate.noteRequest(G, sid(9));
    assert.ok(gate.requestBlockedUntil(G, sid(9)));
    gate.unnoteRequest(G, sid(9));
    assert.equal(gate.requestBlockedUntil(G, sid(9)), null);
    gate.resetRequestLimits();
  });
  it('decide / revoke / reopen are compare-and-set; getRequest is scoped to the guild', async () => {
    const { request } = await ask(1);
    assert.equal((await gate.decide(request._id, 'approved', { by: 'adm', reason: 'ok' })).status, 'approved');
    assert.equal(await gate.decide(request._id, 'rejected'), null, 'not pending any more');
    assert.equal((await gate.revoke(request._id, { by: 'adm' })).status, 'revoked');
    assert.equal(await gate.revoke(request._id), null);
    assert.equal((await gate.reopen(request._id, 'revoked')).status, 'pending');
    assert.equal(await gate.getRequest(request._id, 'another-guild'), null);
    assert.equal((await gate.getRequest(request._id, G)).status, 'pending');
  });
  it('reopen while the member has a newer pending request cancels the old one instead', async () => {
    const { request } = await ask(1);
    await gate.decide(request._id, 'rejected');
    await ask(1);
    assert.equal(await gate.reopen(request._id, 'rejected'), null);
    assert.equal((await gate.getRequest(request._id, G)).status, 'cancelled');
  });
  it('recentDecision finds a bad decision within the cooldown, except a failed card; decidePendingOf closes the pending one', async () => {
    const { request } = await ask(1);
    const now = Date.now();
    await gate.decide(request._id, 'rejected', { at: new Date(now - 1000) });
    assert.equal(String((await gate.recentDecision(G, sid(1), { now }))._id), String(request._id));
    assert.equal(await gate.recentDecision(G, sid(1), { now: now + gate.COOLDOWN_MS + 5000 }), null);
    await ask(2);
    assert.equal((await gate.decidePendingOf(G, sid(2), 'cancelled', { reason: 'rời server' })).status, 'cancelled');
    assert.equal(await gate.findPending(G, sid(2)), null);
    await gate.setCard(request._id, 'chan', 'msg');
    assert.equal((await gate.getRequest(request._id, G)).adminMessageId, 'msg');
  });
});

describe('war attendance', () => {
  let e;
  beforeEach(async () => {
    await withGuild();
    await gr.saveImport({ guildId: G, members: [{ name: 'An' }, { name: 'Bình' }], importedAt: START });
    e = await war.createEvent({ guildId: G, title: 'Bang chiến', startAt: START, deadlineAt: START });
  });
  it('saveAttendance stores one row per name (pointing at its character), a second import replaces the first', async () => {
    await att.saveAttendance({ guildId: G, eventId: e._id, source: 'a.txt', entries: [{ gameName: 'An', discordId: sid(1), how: 'link', stats: { diem: 3 } }, { gameName: 'Lạ', discordId: null, how: 'none' }] });
    let saved = await att.getAttendance(e._id);
    assert.equal(saved.source, 'a.txt');
    assert.ok(saved.importedAt instanceof Date);
    assert.deepEqual(saved.entries, [{ gameName: 'An', discordId: sid(1), how: 'link', stats: { diem: 3 } }, { gameName: 'Lạ', discordId: null, how: 'none' }]);
    const rows = await db.q('select seen_name, character_id from attendance_entries order by seen_name');
    assert.deepEqual(rows.map((r) => [r.seen_name, Boolean(r.character_id)]), [['An', true], ['Lạ', false]]);
    await att.saveAttendance({ guildId: G, eventId: e._id, source: 'b.txt', entries: [{ gameName: 'Bình', discordId: sid(2), how: 'auto' }] });
    saved = await att.getAttendance(e._id);
    assert.deepEqual(saved.entries.map((x) => x.gameName), ['Bình']);
  });
  it('history: the wars with an attendance and the per-person numbers', async () => {
    await reg.upsertRegistration({ eventId: e._id, guildId: G, discordId: sid(1), displayName: 'A', status: 'join', className: 'Tố Vấn' });
    await reg.upsertRegistration({ eventId: e._id, guildId: G, discordId: sid(3), displayName: 'C', status: 'join', className: 'Tố Vấn' });
    await att.saveAttendance({ guildId: G, eventId: e._id, entries: [{ gameName: 'An', discordId: sid(1), how: 'link' }, { gameName: 'Bình', discordId: sid(2), how: 'auto' }] });
    const h = await att.history(G);
    assert.deepEqual(h.wars.map((x) => x.eventId), [String(e._id)]);
    assert.equal(h.people.get(sid(1)).came, 1);
    assert.equal(h.people.get(sid(3)).came, 0);
  });
  it('findEventOnDate / latestStartedEvent pick the war by its local day / start', async () => {
    assert.equal(String((await att.findEventOnDate(G, '2026-10-10'))._id), String(e._id));
    assert.equal(await att.findEventOnDate(G, '2026-10-11'), null);
    assert.equal(String((await att.latestStartedEvent(G, new Date('2026-10-11T00:00:00Z')))._id), String(e._id));
    assert.equal(await att.latestStartedEvent(G, new Date('2026-10-01T00:00:00Z')), null);
  });
});

describe('guild events lists', () => {
  beforeEach(withGuild);
  it('listForSheet: the recent and upcoming events with their answers; `any` tells a guild that never had one', async () => {
    const now = new Date('2026-10-20T00:00:00Z');
    assert.deepEqual(await ev.listForSheet(G, now), { items: [], any: false });
    const old = await ev.createEvent({ guildId: G, title: 'cũ', startAt: new Date('2026-08-01T13:00:00Z'), deadlineAt: new Date('2026-08-01T13:00:00Z') });
    assert.deepEqual(await ev.listForSheet(G, now), { items: [], any: true });
    const soon = await ev.createEvent({ guildId: G, title: 'sắp tới', startAt: new Date('2026-10-25T13:00:00Z'), deadlineAt: new Date('2026-10-25T13:00:00Z') });
    await ev.upsertReply({ eventId: soon._id, guildId: G, discordId: sid(1), displayName: 'A', status: 'yes' });
    const out = await ev.listForSheet(G, now);
    assert.deepEqual(out.items.map((i) => [i.event.title, i.replies.map((r) => r.discordId)]), [['sắp tới', [sid(1)]]]);
    assert.ok(old);
  });
  it('claimRemind / claimMinNotice are one-shot; listManage shows open and locked, soonest first', async () => {
    const a = await ev.createEvent({ guildId: G, title: 'a', startAt: new Date('2026-10-25T13:00:00Z'), deadlineAt: new Date('2026-10-25T13:00:00Z') });
    const b = await ev.createEvent({ guildId: G, title: 'b', startAt: new Date('2026-10-24T13:00:00Z'), deadlineAt: new Date('2026-10-24T13:00:00Z') });
    assert.equal(await ev.claimRemind(a._id), true);
    assert.equal(await ev.claimRemind(a._id), false);
    assert.equal(await ev.claimMinNotice(a._id), true);
    assert.equal(await ev.claimMinNotice(a._id), false);
    await ev.lockEvent(a._id);
    assert.deepEqual((await ev.listManage(G)).map((x) => x.title), ['b', 'a']);
    await ev.cancelEvent(b._id);
    assert.deepEqual((await ev.listManage(G)).map((x) => x.title), ['a']);
  });
});
