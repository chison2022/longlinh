// Seeds a guild, a war and joined members for the lineup tests (not a test file).
const db = require('../src/db');
const war = require('../src/services/warService');
const reg = require('../src/services/registrationService');
const { sid } = require('./helpers');

const G = '800000000000000001';
const START = new Date('2026-12-05T13:00:00Z');

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

module.exports = { seedWar, G };
