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

describe('in-game character ID (game_uid)', () => {
  const NOW = new Date('2026-10-20T00:00:00Z');
  const uidOf = async (name) => (await db.one('select game_uid from game_characters where name = $1', [name])).game_uid;

  it('cleanGameUid: trims, digits only, 5 to 20 of them; empty means none', () => {
    assert.deepEqual(gr.cleanGameUid('  12345678 '), { uid: '12345678' });
    assert.deepEqual(gr.cleanGameUid(''), { uid: '' });
    assert.deepEqual(gr.cleanGameUid(null), { uid: '' });
    assert.deepEqual(gr.cleanGameUid('00123'), { uid: '00123' }, 'leading zeros kept');
    for (const bad of ['1234', '1'.repeat(21), '12 345', 'abc12345', '12345a', '١٢٣٤٥٦', '12.345', '-12345']) assert.match(gr.cleanGameUid(bad).error, /chữ số/, bad);
    assert.equal(gr.cleanGameUid('1'.repeat(20)).uid.length, 20);
  });
  it('setGameUid: a manager sets it by name (any spelling), changes it, and removes it with an empty ID', async () => {
    await save([m('Hắc Phong'), m('An')], T1);
    assert.deepEqual(await gr.setGameUid(G, ' hac  phong ', '12345678'), { name: 'Hắc Phong', uid: '12345678' });
    assert.equal(await uidOf('Hắc Phong'), '12345678');
    assert.equal((await gr.latest(G)).members.find((x) => x.name === 'Hắc Phong').gameUid, '12345678');
    await gr.setGameUid(G, 'Hắc Phong', '87654321');
    assert.equal(await uidOf('Hắc Phong'), '87654321');
    assert.deepEqual(await gr.setGameUid(G, 'Hắc Phong', ''), { name: 'Hắc Phong', uid: null });
    assert.equal(await uidOf('Hắc Phong'), null);
    assert.match((await gr.setGameUid(G, 'Không Có', '12345678')).error, /Không tìm thấy nhân vật \*\*Không Có\*\*/);
    assert.match((await gr.setGameUid(G, 'An', '12x45')).error, /chữ số/);
  });
  it('an ID is never shared: the holder is named, a departed holder says so and points at ✏️ Đổi tên; no raw DB error', async () => {
    await save([m('An'), m('Bình'), m('Chi')], T1);
    await gr.setGameUid(G, 'An', '11111');
    const dup = await gr.setGameUid(G, 'Bình', '11111');
    assert.match(dup.error, /thuộc nhân vật \*\*An\*\*/);
    assert.doesNotMatch(dup.error, /đã rời bang/);
    assert.equal(await uidOf('Bình'), null);
    assert.deepEqual(await gr.setGameUid(G, 'An', '11111'), { name: 'An', uid: '11111' }, 'its own ID again is fine');
    await save([m('Bình'), m('Chi')], T2); // An leaves, keeps the ID
    const gone = await gr.setGameUid(G, 'Bình', '11111');
    assert.match(gone.error, /\*\*An\*\* \(đã rời bang\)/);
    assert.match(gone.error, /Đổi tên/);
    assert.equal(await uidOf('Bình'), null);
    assert.match((await gr.checkGameUid(G, '11111')).error, /đã rời bang/);
    assert.deepEqual(await gr.checkGameUid(G, '22222'), { uid: '22222' });
    assert.deepEqual(await gr.checkGameUid(G, ''), { uid: '' });
    assert.match((await gr.checkGameUid(G, 'zz')).error, /chữ số/);
    await assert.rejects(db.q(`update game_characters set game_uid = '11111' where name = 'Chi'`), (e) => db.isUniqueViolation(e), 'the index itself refuses it');
  });
  it('the same ID may exist in two guilds', async () => {
    await db.q('insert into guilds (id) values ($1)', ['800000000000000002']);
    await save([m('An')], T1);
    await gr.saveImport({ guildId: '800000000000000002', source: 'f.xlsx', members: [m('An')], importedAt: T1 });
    assert.equal((await gr.setGameUid(G, 'An', '12345')).uid, '12345');
    assert.equal((await gr.setGameUid('800000000000000002', 'An', '12345')).uid, '12345');
  });
  it('claimGameUid (the gate): sets an empty ID, same is fine, a different ID or any other holder (departed too) is a clash that writes nothing', async () => {
    await save([m('An'), m('Bình'), m('Chi'), m('Dũng')], T1);
    const first = await gr.claimGameUid(G, 'An', '12345');
    assert.deepEqual([first.status, first.created], ['set', false]);
    assert.equal(await uidOf('An'), '12345');
    assert.equal((await gr.claimGameUid(G, 'An', '12345')).status, 'same');
    const has = await gr.claimGameUid(G, 'An', '99999');
    assert.equal(has.status, 'clash');
    assert.match(has.text, /đã có một ID game khác/);
    assert.equal(await uidOf('An'), '12345');
    const taken = await gr.claimGameUid(G, 'Bình', '12345');
    assert.equal(taken.status, 'clash');
    assert.match(taken.text, /\*\*An\*\*/);
    assert.equal(await uidOf('Bình'), null);
    await save([m('Bình'), m('Chi'), m('Dũng')], T2); // An left
    const gone = await gr.claimGameUid(G, 'Chi', '12345');
    assert.equal(gone.status, 'clash');
    assert.match(gone.text, /đã rời bang/);
  });
  it('claimGameUid: a name nobody has becomes a typed character that holds the ID (and releaseGameUid removes it again); a typed name that is a DEPARTED character lands on that very row, like the link does', async () => {
    await save([m('Cũ'), m('An')], T1);
    await save([m('An')], T2); // Cũ left
    const departed = await gr.claimGameUid(G, 'cũ', '22222');
    assert.deepEqual([departed.status, departed.created], ['set', false]);
    assert.equal(await uidOf('Cũ'), '22222', 'the departed row, not a second one');
    await gr.setMappings(G, [{ discordId: sid(1), gameName: 'Cũ' }]);
    assert.equal((await db.one(`select count(*) as n from game_characters where name_key = $1`, [gr.nameKey('Cũ')])).n, 1, 'the link used the same row');
    assert.equal(await uidOf('Cũ'), '22222');
    const typed = await gr.claimGameUid(G, 'Người Lạ', '33333');
    assert.deepEqual([typed.status, typed.created], ['set', true]);
    assert.equal(await uidOf('Người Lạ'), '33333');
    await gr.releaseGameUid(G, typed.characterId);
    assert.equal((await db.one(`select count(*) as n from game_characters where name = 'Người Lạ'`)).n, 0, 'the typed row the claim made is gone');
    await gr.releaseGameUid(G, departed.characterId);
    assert.equal(await uidOf('Cũ'), null, 'a linked row only loses the ID');
  });
  it('checkGameUid: the picked character already carries a different ID -> refused up front', async () => {
    await save([m('An')], T1);
    await gr.setGameUid(G, 'An', '12345');
    assert.match((await gr.checkGameUid(G, '99999', { exceptName: 'An' })).error, /đã có một ID game khác/);
    assert.deepEqual(await gr.checkGameUid(G, '99999'), { uid: '99999' }, 'without a chosen character nothing to compare');
    await save([m('An'), m('Bình')], T2);
    assert.deepEqual(await gr.checkGameUid(G, '99999', { exceptName: 'Bình' }), { uid: '99999' }, 'a character with no ID takes any free one');
  });
  it("checkGameUid: the picked character's own ID is accepted, another character's is not; a pending request reserves its ID", async () => {
    await save([m('An'), m('Bình')], T1);
    await gr.setGameUid(G, 'An', '12345');
    assert.match((await gr.checkGameUid(G, '12345')).error, /\*\*An\*\*/);
    assert.deepEqual(await gr.checkGameUid(G, '12345', { exceptName: 'an' }), { uid: '12345' });
    assert.match((await gr.checkGameUid(G, '12345', { exceptName: 'Bình' })).error, /\*\*An\*\*/);
    await db.q(`insert into discord_members (guild_id, discord_id, display_name) values ($1, $2, 'X')`, [G, sid(1)]);
    const mid = (await db.one('select id from discord_members where discord_id = $1', [sid(1)])).id;
    await db.q(`insert into gate_requests (id, guild_id, member_id, game_name, game_uid, status) values ($1, $2, $3, 'Q', '77777', 'pending')`, [db.newId(), G, mid]);
    assert.match((await gr.checkGameUid(G, '77777')).error, /người khác dùng để xin vào bang/);
    assert.deepEqual(await gr.checkGameUid(G, '88888'), { uid: '88888' });
  });
  it('renameCharacter: the ID moves from the old row to the surviving one (the new row held none); the unique index is never hit', async () => {
    await save([m('Cũ', { daysInGuild: 40 }), m('An')], T1);
    await gr.setGameUid(G, 'Cũ', '12345678');
    await save([m('Mới', { daysInGuild: 44 }), m('An')], T2);
    const { left, fresh } = await gr.renameChoices(G, NOW);
    const out = await gr.renameCharacter(G, left.find((c) => c.name === 'Cũ').id, fresh.find((c) => c.name === 'Mới').id);
    assert.deepEqual(out, { from: 'Cũ', to: 'Mới' });
    assert.equal(await uidOf('Mới'), '12345678');
    assert.equal((await db.one(`select count(*) as n from game_characters where game_uid = '12345678'`)).n, 1);
  });
  it('renameCharacter: two different IDs - the old one is kept and the manager is told what was dropped', async () => {
    await save([m('Cũ', { daysInGuild: 40 }), m('An')], T1);
    await gr.setGameUid(G, 'Cũ', '11111');
    await save([m('Mới', { daysInGuild: 44 }), m('An')], T2);
    await gr.setGameUid(G, 'Mới', '22222');
    const { left, fresh } = await gr.renameChoices(G, NOW);
    const out = await gr.renameCharacter(G, left.find((c) => c.name === 'Cũ').id, fresh.find((c) => c.name === 'Mới').id);
    assert.equal(await uidOf('Mới'), '11111');
    assert.match(out.note, /giữ \*\*11111\*\*.*bỏ \*\*22222\*\*/);
  });
  it("renameCharacter: no ID on the old row keeps the new row's; the old row's wins when both have one", async () => {
    await save([m('Cũ', { daysInGuild: 40 }), m('Cũ2', { daysInGuild: 40 }), m('An')], T1);
    await save([m('Mới', { daysInGuild: 44 }), m('Mới2', { daysInGuild: 44 }), m('An')], T2);
    await gr.setGameUid(G, 'Mới', '31111');
    await db.q(`update game_characters set game_uid = '42222' where name = 'Cũ2'`); // departed: the manager form only finds active ones
    await gr.setGameUid(G, 'Mới2', '43333');
    const { left, fresh } = await gr.renameChoices(G, NOW);
    const L = (n) => left.find((c) => c.name === n).id;
    const F = (n) => fresh.find((c) => c.name === n).id;
    assert.ok(!(await gr.renameCharacter(G, L('Cũ'), F('Mới'))).error);
    assert.equal(await uidOf('Mới'), '31111');
    assert.ok(!(await gr.renameCharacter(G, L('Cũ2'), F('Mới2'))).error);
    assert.equal(await uidOf('Mới2'), '42222', "the old row's ID");
    assert.equal((await db.one(`select count(*) as n from game_characters where game_uid is not null`)).n, 2);
  });
});
