// The Activity bridge on two in-memory PostgreSQL databases: the snapshot taken when registration locks (main -> side), re-lock semantics,
// removals that persist, the catch-up, and a side database that is off or down.
const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionFlagsBits } = require('discord.js');
const db = require('../src/db');
const side = require('../src/sideDb');
const { setupDb, resetDb } = require('./pgdb');
const { setupSide, resetSide } = require('./sidedb');
const actBridge = require('../src/bot/actBridge');
const actSnapshot = require('../src/services/actSnapshot');
const lineupService = require('../src/services/lineupService');
const rules = require('../src/services/lineupRules');
const reg = require('../src/services/registrationService');
const warService = require('../src/services/warService');
const { clearConfigCache } = require('../src/services/guildConfigService');
const publisher = require('../src/jobs/lineupPublisher');
const { handle, UNAVAILABLE } = require('../src/bot/interactions/lineup');
const { seedWar, snapshot, G, ADMIN_ROLE } = require('./lineupFixture');
const { sid } = require('./helpers');

const SHAPE = { groupCount: 2, partiesPerGroup: 5, partySize: 6 };
let w;

before(async () => {
  await setupDb();
  await setupSide();
});
beforeEach(async () => {
  await resetDb();
  await resetSide();
  clearConfigCache();
  actBridge.resetMemory();
  w = await seedWar({ classes: ['Tố Vấn', 'Thiết Y', 'Huyết Hà', 'Huyết Hà'] });
});

const members = (opts) => lineupService.listMembers(w.warId, opts);
const keys = async (opts) => (await members(opts)).map((m) => m.id);

describe('snapshot at the lock', () => {
  it('copies the guild, the war and the joiners (in-game names, classes, roles, Tuyến Khiên groups) into the side database', async () => {
    await db.q("insert into game_characters (guild_id, name, name_key, class_name) values ($1, 'Kiếm Tâm', 'kiemtam', 'Tố Vấn')", [G]);
    await db.q("insert into character_links (character_id, member_id, guild_id, source) select g.id, m.id, $1, 'admin' from game_characters g, discord_members m where g.name = 'Kiếm Tâm' and m.discord_id = $2", [G, w.ids[0]]);
    await db.q("update discord_members set tk_partners = $2, mission_pref = 'cong' where discord_id = $1", [w.ids[1], [w.ids[2]]]);
    await snapshot(w);
    const war = await lineupService.getWar(w.warId);
    assert.deepEqual([war.guildId, war.title, war.status], [G, 'Bang chiến T7', 'locked']);
    assert.ok(war.lockedAt);
    assert.deepEqual(war.linkGroups, [[w.ids[1], w.ids[2]].sort()]);
    const guild = await lineupService.getGuild(G);
    assert.deepEqual([guild.adminRoleIds, guild.shape.groupCount], [[ADMIN_ROLE], 2]);
    const list = await members();
    assert.deepEqual(list.map((m) => m.id), w.ids, 'sign-up order');
    assert.deepEqual([list[0].name, list[0].discordName, list[0].linked], ['Kiếm Tâm', 'Người 1', true]);
    assert.deepEqual([list[1].name, list[1].linked, list[1].rolePref, list[1].className], ['Người 2', false, 'cong', 'Thiết Y']);
  });

  it('a re-lock keeps the board work, hand-added people and a manager\'s removals; un-joiners go, newcomers come, returners return', async () => {
    await snapshot(w);
    const lockedAt = (await lineupService.getWar(w.warId)).lockedAt.getTime();
    // the managers work on the board
    const layout = rules.emptyLayout(SHAPE);
    layout.groups[0][0] = [w.ids[0], w.ids[1], w.ids[2]];
    assert.equal((await lineupService.saveLineup({ warId: w.warId, guildId: G, layout, expectedVersion: 0, userId: 'u', tasks: { [w.ids[0]]: 'def' }, partyNotes: { '0-0': 'giữ trụ' } })).ok, true);
    const added = (await lineupService.addManualMember({ warId: w.warId, guildId: G, userId: 'u', name: 'Khách', className: 'Tố Vấn' })).member;
    await lineupService.removeMember({ warId: w.warId, guildId: G, userId: 'u', key: w.ids[3] }); // a manager removes the 4th
    const before = await lineupService.getLineup(w.warId);
    // meanwhile on Discord: #2 un-joins, a newcomer joins, #4 (removed by the manager) stays registered
    await reg.upsertRegistration({ eventId: w.warId, guildId: G, discordId: w.ids[1], displayName: 'Người 2', status: 'absent', className: null });
    await reg.upsertRegistration({ eventId: w.warId, guildId: G, discordId: sid(99), displayName: 'Mới', status: 'join', className: 'Thiết Y' });
    await snapshot(w);
    const keysNow = await keys();
    assert.ok(keysNow.includes(sid(99)), 'the newcomer is on the list');
    assert.ok(keysNow.includes(added.id), 'the hand-added person stays');
    assert.ok(!keysNow.includes(w.ids[1]), 'the one who un-joined is off the list');
    assert.ok(!keysNow.includes(w.ids[3]), "the manager's removal stays");
    assert.deepEqual((await keys({ removed: true })).sort(), [w.ids[1], w.ids[3]].sort());
    const after = await lineupService.getLineup(w.warId);
    assert.deepEqual([after.layout, after.tasks, after.partyNotes, after.version], [before.layout, before.tasks, before.partyNotes, before.version], 'placements, tasks and notes untouched');
    // #2 joins again: back on the list; #4 stays removed even though he is registered
    await reg.upsertRegistration({ eventId: w.warId, guildId: G, discordId: w.ids[1], displayName: 'Người 2', status: 'join', className: 'Thiết Y' });
    await snapshot(w);
    assert.ok((await keys()).includes(w.ids[1]));
    assert.ok(!(await keys()).includes(w.ids[3]));
    assert.equal((await lineupService.getWar(w.warId)).lockedAt.getTime(), lockedAt, 'the first lock time is kept');
  });
});

describe('the bot side (actBridge)', () => {
  const roleOf = (id, bits) => ({ id, name: `r${id}`, color: 0, permissions: { has: (b) => bits.includes(b) } });
  const fakeClient = () => ({
    guilds: {
      cache: new Map([[G, {
        id: G,
        ownerId: '555000000000000003',
        roles: { cache: new Collection([['r1', roleOf('r1', [PermissionFlagsBits.ManageGuild])], ['r2', roleOf('r2', [])], ['r3', roleOf('r3', [PermissionFlagsBits.Administrator])]]) },
        emojis: { cache: new Collection() },
      }]]),
    },
  });

  it('snapshotWar of a locked war: roles with Manage Server / Administrator and the owner come from the guild cache', async () => {
    await db.q("update war_events set status = 'locked' where id = $1", [w.warId]);
    await db.q("update guilds set settings = settings || '{\"adminRoleIds\":[\"700000000000000001\"],\"classes\":[\"🛡️ Thiết Y\",\"Tố Vấn\",\"Huyết Hà\"]}'::jsonb where id = $1", [G]);
    clearConfigCache();
    assert.equal(await actBridge.snapshotWar(fakeClient(), w.warId), true);
    const guild = await lineupService.getGuild(G);
    assert.deepEqual(guild.managerRoleIds.sort(), ['r1', 'r3']);
    assert.deepEqual([guild.ownerId, guild.adminRoleIds], ['555000000000000003', ['700000000000000001']]);
    assert.deepEqual(guild.classes.map((c) => [c.name, c.tag]), [['Thiết Y', 'TY'], ['Tố Vấn', 'TV'], ['Huyết Hà', 'HH']]);
    assert.equal(guild.rules.healerClass, 'Tố Vấn');
  });
  it('an open war is not copied (the lock is what triggers it)', async () => {
    assert.equal(await actBridge.snapshotWar(fakeClient(), w.warId), false);
    assert.equal(await lineupService.getWar(w.warId), null);
  });
  it('catchUp copies the closed wars the side database does not know yet, a few per call', async () => {
    await db.q("update war_events set status = 'locked' where id = $1", [w.warId]);
    const second = await seedWar({ guildId: '800000000000000002', classes: ['Tố Vấn'] });
    await warService.publishEvent(second.warId);
    assert.equal(await actBridge.catchUp(fakeClient(), 1), 1);
    assert.equal(await actBridge.catchUp(fakeClient()), 1, 'the other one');
    assert.equal(await actBridge.catchUp(fakeClient()), 0, 'nothing left');
    assert.ok(await lineupService.getWar(w.warId));
    assert.ok(await lineupService.getWar(second.warId));
  });
  it('markDone takes a finished war off the board list', async () => {
    await snapshot(w);
    assert.equal((await lineupService.listWars(G)).length, 1);
    await actBridge.markDone(w.warId);
    assert.deepEqual(await lineupService.listWars(G), []);
  });
});

describe('the side database is off or down: nothing breaks', () => {
  let realBackend;
  beforeEach(async () => {
    await db.q("update war_events set status = 'locked' where id = $1", [w.warId]);
  });
  afterEach(async () => {
    await setupSide(); // the shared in-memory database again
  });

  it('no URL: the bridge stays off, every call answers quietly', async () => {
    side.useBackend(null);
    assert.equal(side.isConnected(), false);
    assert.equal(side.urlOf({}), null);
    assert.equal(side.urlOf({ DATABASE_URL: ' postgres://x ' }), 'postgres://x');
    assert.equal(side.urlOf({ ACTIVITY_PG_URL: 'postgres://a', DATABASE_URL: 'postgres://b' }), 'postgres://a');
    assert.equal(await actBridge.ensureUp(), false);
    assert.equal(await actBridge.snapshotWar({}, w.warId), false);
    assert.equal(await actBridge.catchUp({}), 0);
    await actBridge.markDone(w.warId);
    assert.deepEqual(await publisher.runOnce({}, { backoffMs: 1 }), []);
  });
  it('the side database fails: the snapshot logs and returns false, the publisher and the button answer politely', async () => {
    await snapshot(w);
    const boom = async () => {
      throw new Error('connection terminated');
    };
    realBackend = { query: boom, transaction: boom };
    side.useBackend(realBackend);
    assert.equal(await actBridge.snapshotWar({}, w.warId), false);
    assert.equal(await actBridge.catchUp({}), 0);
    assert.deepEqual(await publisher.runOnce({}, { backoffMs: 1 }), []);
    const replies = [];
    await handle({ guildId: G, user: { id: w.ids[0] }, reply: async (p) => replies.push(p), deferReply: async () => {}, editReply: async (p) => replies.push(p) }, ['lu', 'mine', w.warId]);
    assert.equal(replies[0].content, UNAVAILABLE);
    // not connected at all: an immediate answer, no database work, no deferral
    side.useBackend(null);
    const quick = [];
    let deferred = false;
    await handle({ guildId: G, user: { id: w.ids[0] }, reply: async (p) => quick.push(p), deferReply: async () => { deferred = true; }, editReply: async (p) => quick.push(p) }, ['lu', 'mine', w.warId]);
    assert.equal(quick[0].content, UNAVAILABLE);
    assert.equal(deferred, false);
  });
});
