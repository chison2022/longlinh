// Seeds a guild, a war and joined members in the MAIN database, and takes the Activity snapshot of it into the SIDE database
// (not a test file). Needs both test databases: before(async () => { await setupDb(); await setupSide(); }).
const db = require('../src/db');
const war = require('../src/services/warService');
const reg = require('../src/services/registrationService');
const actSnapshot = require('../src/services/actSnapshot');
const { sid } = require('./helpers');

const G = '800000000000000001';
const START = new Date('2026-12-05T13:00:00Z');
const ADMIN_ROLE = '700000000000000001'; // a configured admin role
const MANAGER_ROLE = '700000000000000009'; // a role with Manage Server
const OWNER_ID = '555000000000000003';

// `classes` = class of member i (0-based); ids are sid(1..n). -> { warId, ids, guildId }
async function seedWar({ guildId = G, classes = [], status = 'open' } = {}) {
  await db.q('insert into guilds (id) values ($1) on conflict do nothing', [guildId]);
  const ev = await war.createEvent({ guildId, title: 'Bang chiến T7', startAt: START, deadlineAt: START, status });
  const ids = [];
  for (let i = 0; i < classes.length; i++) {
    const discordId = sid(i + 1);
    ids.push(discordId);
    await reg.upsertRegistration({ eventId: ev._id, guildId, discordId, displayName: `Người ${i + 1}`, status: 'join', className: classes[i] });
  }
  return { warId: String(ev._id), ids, guildId };
}

// What the bot writes into act_guilds for the test guild (override any field).
const guildSnapshot = (guildId = G, over = {}) => ({
  guildId,
  adminRoleIds: [ADMIN_ROLE],
  managerRoleIds: [MANAGER_ROLE],
  ownerId: OWNER_ID,
  classes: [{ name: 'Thiết Y', tag: 'TY', emojiId: null }, { name: 'Tố Vấn', tag: 'TV', emojiId: null }, { name: 'Huyết Hà', tag: 'HH', emojiId: null }],
  rules: { healerClass: 'Tố Vấn', tankClass: 'Thiết Y' },
  shape: { groupCount: 2, partiesPerGroup: 5, partySize: 6 },
  ...over,
});

// The registration-lock snapshot of a seeded war, exactly as the bot takes it (the main war row is left as it is).
async function snapshot(w, over = {}) {
  const ev = await war.getEvent(w.warId);
  await actSnapshot.writeSnapshot({ guild: guildSnapshot(w.guildId, over), war: { ...ev, status: 'locked' }, joiners: await actSnapshot.listJoiners(w.warId) });
}

module.exports = { seedWar, snapshot, guildSnapshot, G, ADMIN_ROLE, MANAGER_ROLE, OWNER_ID };
