// The game roster and the game name <-> Discord links on an in-memory PostgreSQL (test/pgdb.js): characters keep one row across
// imports (latest values, left_at for the departed), and one character is linked to one Discord member.
const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { setupDb, resetDb } = require('./pgdb');
const gr = require('../src/services/gameRosterService');
const departure = require('../src/services/departureService');
const memberStore = require('../src/services/members');
const { sid } = require('./helpers');

const G = '800000000000000001';
const T1 = new Date('2026-10-08T13:00:00Z');
const T2 = new Date('2026-10-12T13:00:00Z');
const T3 = new Date('2026-10-16T13:00:00Z');
const m = (name, extra = {}) => ({ name, rank: 'Bang Chúng', className: 'Tố Vấn', daysInGuild: 3, status: 'Online', offDays: 0, ...extra });
const save = (members, importedAt) => gr.saveImport({ guildId: G, source: 'f.xlsx', members, importedAt });
const chars = () => db.q('select name, origin, left_at, last_import_id, position from game_characters order by id');

before(setupDb);
beforeEach(async () => {
  await resetDb();
  await db.q('insert into guilds (id) values ($1)', [G]);
});

describe('roster imports', () => {
  it('latest() returns the newest import with its members in roster order and the latest values', async () => {
    await save([m('An'), m('Bình')], T1);
    const second = await save([m('Chi'), m('An', { rank: 'Trưởng Lão', daysInGuild: 20 })], T2);
    const latest = await gr.latest(G);
    assert.equal(String(latest._id), String(second._id));
    assert.deepEqual(latest.members.map((x) => [x.name, x.rank, x.daysInGuild]), [['Chi', 'Bang Chúng', 3], ['An', 'Trưởng Lão', 20]]);
    const head = await gr.latest(G, '_id importedAt');
    assert.equal(head.members, undefined, 'a projection without members skips the list');
    assert.deepEqual(await gr.latestRanks(G), ['Bang Chúng', 'Trưởng Lão']);
    assert.deepEqual(await gr.latestMeta(G), { importedAt: T2, source: 'f.xlsx', count: 2 });
  });
  it('one row per character across imports: the departed get left_at, a returning name gets its old row back', async () => {
    await save([m('An'), m('Bình')], T1);
    await save([m('An')], T2);
    let rows = await chars();
    assert.deepEqual(rows.map((r) => [r.name, r.left_at && r.left_at.toISOString()]), [['An', null], ['Bình', T2.toISOString()]]);
    await save([m('Bình'), m('an')], T3);
    rows = await chars();
    assert.equal(rows.length, 2, 'no new row: "an" is An (same name key), Bình came back');
    assert.deepEqual(rows.map((r) => [r.name, r.left_at]), [['an', null], ['Bình', null]]);
  });
  it('previous() is the import before the latest, with who was in the guild then', async () => {
    await save([m('An'), m('Bình')], T1);
    await save([m('An'), m('Chi')], T2);
    const prev = await gr.previous(G);
    assert.equal(prev.importedAt.toISOString(), T1.toISOString());
    assert.deepEqual(prev.members.map((x) => x.name).sort(), ['An', 'Bình']);
  });
  it('a second line with the same name key in one roster is kept once', async () => {
    const doc = await save([m('An'), m('AN'), m('Bình')], T1);
    assert.deepEqual(doc.members.map((x) => x.name), ['An', 'Bình']);
  });
  it('addManualMember appends to the latest import in place (same id), refuses a name already there and needs an import', async () => {
    assert.match((await gr.addManualMember(G, { name: 'Zed' })).error, /Chưa có danh sách game/);
    const doc = await save([m('An')], T1);
    assert.deepEqual((await gr.addManualMember(G, { name: 'Zed', className: 'Huyết Hà', rank: 'Học Việc' })).member.name, 'Zed');
    assert.match((await gr.addManualMember(G, { name: 'zed' })).error, /đã có trong danh sách game/);
    const latest = await gr.latest(G);
    assert.equal(String(latest._id), String(doc._id));
    assert.deepEqual(latest.members.map((x) => x.name), ['An', 'Zed']);
  });
});

describe('game name links', () => {
  beforeEach(() => save([m('An'), m('Bình'), m('Chi'), m('Nguyệt Tiểu L…')], T1));

  it('setMappings: an admin pair; the newest pair takes the name from whoever had it; one name per person', async () => {
    await gr.setMappings(G, [{ discordId: sid(1), gameName: 'An', displayName: 'A' }]);
    await gr.setMappings(G, [{ discordId: sid(2), gameName: 'an' }]); // same name key: taken from sid(1)
    let map = await gr.loadMappings(G);
    assert.deepEqual([...map], [[sid(2), 'An']]);
    assert.equal(map.sources.get(sid(2)), 'admin');
    await gr.setMappings(G, [{ discordId: sid(2), gameName: 'Bình' }]);
    map = await gr.loadMappings(G);
    assert.deepEqual([...map], [[sid(2), 'Bình']]);
    assert.equal((await db.one('select count(*) as n from character_links')).n, 1);
  });
  it('a name in no roster becomes a typed character; it is forgotten when nobody links it any more', async () => {
    await gr.setMappings(G, [{ discordId: sid(1), gameName: 'Người Mới' }]);
    assert.deepEqual((await chars()).filter((r) => r.origin === 'typed').map((r) => r.name), ['Người Mới']);
    await gr.removeMappings(G, [sid(1)]);
    assert.deepEqual((await chars()).filter((r) => r.origin === 'typed'), []);
  });
  it('a typed name becomes a roster character when a roster lists it, and keeps its link', async () => {
    await gr.selfLink(G, sid(1), 'Người Mới', { free: true, displayName: 'N' });
    await save([m('An'), m('Người Mới')], T2);
    const rows = await chars();
    assert.equal(rows.filter((r) => r.name === 'Người Mới').length, 1);
    assert.equal(rows.find((r) => r.name === 'Người Mới').origin, 'roster');
    assert.deepEqual(await gr.getLink(G, sid(1)), { gameName: 'Người Mới', source: 'selfFree' });
  });
  it('selfLink: refused when somebody else holds the name or an admin paired me; selfUnlink removes only my own link', async () => {
    await gr.setMappings(G, [{ discordId: sid(1), gameName: 'An' }]);
    await assert.rejects(() => gr.selfLink(G, sid(2), 'an'), (err) => err.code === 'GAME_NAME_TAKEN' && err.holder.id === sid(1) && err.holder.source === 'admin');
    await assert.rejects(() => gr.selfLink(G, sid(1), 'Bình'), (err) => err.code === 'ADMIN_LOCKED');
    assert.deepEqual(await gr.selfLink(G, sid(2), 'Bình', { displayName: 'B' }), { gameName: 'Bình', source: 'self' });
    assert.deepEqual(await gr.selfLink(G, sid(2), 'Chi'), { gameName: 'Chi', source: 'self' }, 'a self link can be changed');
    await assert.rejects(() => gr.selfUnlink(G, sid(1)), (err) => err.code === 'ADMIN_LOCKED');
    assert.equal(await gr.selfUnlink(G, sid(2)), true);
    assert.equal(await gr.getLink(G, sid(2)), null);
    assert.equal(await gr.selfUnlink(G, sid(2)), false);
  });
  it('the member store shows the link as gameName / gameNameSource / gameNameAt', async () => {
    await gr.setMappings(G, [{ discordId: sid(1), gameName: 'Chi', displayName: 'Chị Chi' }]);
    const mem = await memberStore.getMember(G, sid(1));
    assert.deepEqual([mem.discordId, mem.displayName, mem.gameName, mem.gameNameSource], [sid(1), 'Chị Chi', 'Chi', 'admin']);
    assert.ok(mem.gameNameAt instanceof Date);
    assert.deepEqual((await departure.loadLinked(G)).map((l) => [l.discordId, l.gameName, l.source]), [[sid(1), 'Chi', 'admin']]);
  });
  it('a link to a character that left stays (the departure notice lists it) until removed', async () => {
    await gr.setMappings(G, [{ discordId: sid(1), gameName: 'Bình' }]);
    await save([m('An')], T2);
    assert.deepEqual([...(await gr.loadMappings(G))], [[sid(1), 'Bình']]);
    assert.equal(await gr.removeMappings(G, [sid(1)]), 1);
    assert.deepEqual([...(await gr.loadMappings(G))], []);
  });
});

describe('per-import notice claims (guild settings)', () => {
  beforeEach(() => db.q(`update guilds set settings = '{"adminChannelId": "adm"}' where id = $1`, [G]));
  it('claimNotice: one caller per import, and only forward in time', async () => {
    assert.equal(await departure.claimNotice(G, 5, T2), true);
    assert.equal(await departure.claimNotice(G, 5, T2), false, 'already claimed');
    assert.equal(await departure.claimNotice(G, 4, T1), false, 'an older import never after a newer one');
    assert.equal(await departure.claimNotice(G, 6, T3), true);
    await departure.saveNoticeIds(G, 6, [sid(1), sid(2)], { more: 3, at: T3 });
    await departure.saveNoticeIds(G, 5, [sid(9)]); // not the claimed import: ignored
    assert.deepEqual(await departure.getNotice(G), { rosterId: '6', ids: [sid(1), sid(2)], more: 3, at: T3, joined: [], warId: null });
    assert.deepEqual((await departure.listNoticeConfigs()).map((c) => c.guildId), [G]);
  });
  it('claimOffNotice is a separate claim with the same rules', async () => {
    assert.equal(await departure.claimOffNotice(G, 5, T2), true);
    assert.equal(await departure.claimOffNotice(G, 5, T2), false);
    assert.equal(await departure.claimNotice(G, 5, T2), true, 'the departure claim is not the off claim');
  });
});

describe('roster status and confirmed renames', () => {
  const NOW = new Date('2026-10-20T00:00:00Z');
  it('a character listed again after it left gets returned_at; one that never left has none', async () => {
    await save([m('An'), m('Bình')], T1);
    await save([m('An')], T2);
    await save([m('An'), m('Bình')], T3);
    const latest = await gr.latest(G);
    const byName = new Map(latest.members.map((x) => [x.name, x]));
    assert.equal(byName.get('Bình').returnedAt.toISOString(), T3.toISOString());
    assert.equal(byName.get('An').returnedAt, null);
    assert.deepEqual(byName.get('An').oldNames, []);
  });

  it('renameChoices: who left recently, who is new in the latest import, and the likely pairs (same class, days kept)', async () => {
    await save([m('Cũ', { daysInGuild: 40 }), m('Khác', { className: 'Thiết Y', daysInGuild: 10 }), m('An')], T1);
    await save([m('Mới', { daysInGuild: 44 }), m('Lạ', { className: 'Thiết Y', daysInGuild: 1 }), m('An')], T2);
    const { left, fresh, pairs } = await gr.renameChoices(G, NOW);
    assert.deepEqual(left.map((c) => c.name).sort(), ['Cũ', 'Khác']);
    assert.deepEqual(fresh.map((c) => c.name).sort(), ['Lạ', 'Mới']);
    assert.deepEqual(pairs.map((p) => [p.from.name, p.to.name]), [['Cũ', 'Mới']], 'a newcomer with fewer days is not a rename');
  });

  it('renameCharacter: the old character takes the new name and place, keeps its id, link and old name; the new row and its link go', async () => {
    await save([m('Cũ', { daysInGuild: 40 }), m('An')], T1);
    await gr.setMappings(G, [{ discordId: sid(1), gameName: 'Cũ' }]);
    await save([m('Mới', { daysInGuild: 44, rank: 'Trưởng Lão' }), m('An')], T2);
    await gr.setMappings(G, [{ discordId: sid(2), gameName: 'Mới' }]); // somebody linked the new name meanwhile
    const { left, fresh } = await gr.renameChoices(G, NOW);
    const oldId = left.find((c) => c.name === 'Cũ').id;
    const out = await gr.renameCharacter(G, oldId, fresh.find((c) => c.name === 'Mới').id);
    assert.deepEqual(out, { from: 'Cũ', to: 'Mới' });
    const latest = await gr.latest(G);
    const moi = latest.members.find((x) => x.name === 'Mới');
    assert.equal(String(moi.id), String(oldId));
    assert.deepEqual([moi.rank, moi.daysInGuild, moi.oldNames, moi.leftAt], ['Trưởng Lão', 44, ['Cũ'], null]);
    assert.deepEqual([...(await gr.loadMappings(G))], [[sid(1), 'Mới']], 'the old link stays, the new one goes');
    assert.equal((await db.one(`select count(*) as n from game_characters where name in ('Mới', 'Cũ')`)).n, 1);
  });

  it('renameCharacter refuses a character still in the guild or a new one that is gone', async () => {
    await save([m('Cũ'), m('An')], T1);
    await save([m('Mới'), m('An')], T2);
    const rows = await db.q('select id, name from game_characters');
    const id = (n) => rows.find((r) => r.name === n).id;
    assert.match((await gr.renameCharacter(G, id('An'), id('Mới'))).error, /vẫn đang ở bang/);
    assert.match((await gr.renameCharacter(G, id('Cũ'), id('Cũ'))).error, /Không tìm thấy/);
  });

  it('the member store shows a linked character that left (gameLeftAt)', async () => {
    await save([m('Cũ'), m('An')], T1);
    await gr.setMappings(G, [{ discordId: sid(1), gameName: 'Cũ' }]);
    await save([m('An')], T2);
    assert.equal((await memberStore.getMember(G, sid(1))).gameLeftAt.toISOString(), T2.toISOString());
  });
});

describe('removeRegistrations', () => {
  it('removes only the listed people of that war', async () => {
    const w = require('../src/services/warService');
    const reg = require('../src/services/registrationService');
    const ev = await w.createEvent({ guildId: G, title: 'BC', startAt: T3, deadlineAt: T3 });
    for (const n of [1, 2, 3]) await reg.upsertRegistration({ eventId: ev._id, guildId: G, discordId: sid(n), displayName: `P${n}`, status: 'join', className: 'Tố Vấn' });
    assert.deepEqual((await reg.removeRegistrations(ev._id, [sid(1), sid(3), sid(9)])).sort(), [sid(1), sid(3)]);
    assert.deepEqual((await reg.listRegistrations(ev._id)).map((r) => r.discordId), [sid(2)]);
    assert.deepEqual(await reg.removeRegistrations('nope', [sid(2)]), []);
  });
});
