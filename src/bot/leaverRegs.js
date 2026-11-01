// Someone who left the Discord server is taken out of the registrations of the guild's wars that are still open or locked
// (published / done wars keep their history). Runs on GuildMemberRemove and once at startup for the people who left while the
// bot was down; the startup pass only trusts a complete member cache (a half-loaded cache would drop people still here).
const warService = require('../services/warService');
const regService = require('../services/registrationService');
const { ensureMembers } = require('./memberCache');
const { scheduleRefresh, schedulePanelRefresh } = require('./refresher');
const { scheduleSync } = require('./sheetSync');
const { logEvent } = require('../eventLog');

const ACTIVE = new Set(['open', 'locked']);

// -> [{ eventId, removed: [discordId] }] for the wars that lost somebody. `pick(regs)` -> the Discord ids to remove from that war.
async function dropFromActiveWars(client, guildId, pick, reason) {
  const events = (await warService.listActiveEvents(guildId)).filter((e) => ACTIVE.has(e.status));
  const out = [];
  for (const event of events) {
    const ids = pick(await regService.listRegistrations(event._id));
    if (!ids.length) continue;
    const removed = await regService.removeRegistrations(event._id, ids, { withAbsent: true });
    if (!removed.length) continue;
    out.push({ eventId: String(event._id), removed });
    logEvent('war', 'leaver_unreg', { guild: guildId, eid: String(event._id), removed: removed.length, reason });
    if (client) scheduleRefresh(client, event._id);
  }
  if (out.length && client) {
    schedulePanelRefresh(client, guildId);
    scheduleSync(client, guildId);
  }
  return out;
}

async function onMemberLeave(member) {
  try {
    if (!member || !member.guild || (member.user && member.user.bot)) return;
    await dropFromActiveWars(member.client || member.guild.client, member.guild.id, (regs) => (regs.some((r) => r.discordId === member.id) ? [member.id] : []), 'left');
  } catch (err) {
    console.error('[war] leaver unreg:', err.message);
  }
}

// Startup: everyone registered for an open / locked war who is no longer in the server. Skipped without a complete member list.
async function pruneLeavers(client, guild) {
  const { complete, members } = await ensureMembers(guild);
  if (!complete) return [];
  return dropFromActiveWars(client, guild.id, (regs) => regs.map((r) => r.discordId).filter((id) => !members.has(id)), 'startup');
}

module.exports = { onMemberLeave, pruneLeavers, dropFromActiveWars };
