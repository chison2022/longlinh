// "Left the guild in game but still on Discord": after a new game import, tell the managers (admin channel) who is linked to a
// game name that the latest roster no longer has and is still in the server. Driven by the bot (the import may come from the
// script, which has no client): the minute tick (scheduler step `depart`) and the upload both call noticeGuild; the claim
// on GuildConfig.departNoticeRosterId makes sure each import is handled once. The bot never kicks anybody.
const gameRoster = require('../services/gameRosterService');
const departure = require('../services/departureService');
const { getConfigOrDefault, isOn } = require('../services/guildConfigService');
const warService = require('../services/warService');
const { listRegistrations } = require('../services/registrationService');
const { ensureMembers } = require('./memberCache');
const { buildDepartNotice, noticeParts } = require('./ui/departNotice');
const { v2Create } = require('./ui/common');
const { logEvent } = require('../eventLog');

const warned = new Set(); // "guild:roster" with an incomplete member list already logged (the tick retries every minute)
const leftGuilds = new Set(); // guilds the bot is no longer in, already logged once

// Collection of guild members -> Map(id -> { name, bot }) for findDeparted.
function guildMemberMap(members) {
  return new Map([...members.values()].map((m) => [m.id, { name: m.displayName || (m.user && (m.user.globalName || m.user.username)) || '', bot: Boolean(m.user && m.user.bot) }]));
}

// The departed people who still say "join" for the current war -> { war, ids } (ids in `departed` order; war null without one).
// A failed read only drops this section: the notice itself is still posted.
async function stillJoined(guildId, departed) {
  try {
    const war = departed.length ? await warService.getCurrentEvent(guildId) : null;
    if (!war) return { war: null, ids: [] };
    const joined = new Set((await listRegistrations(war._id)).filter((r) => r.status !== 'absent').map((r) => r.discordId));
    return { war, ids: departed.map((d) => d.discordId).filter((id) => joined.has(id)) };
  } catch (err) {
    console.warn(`[departNotice] guild ${guildId}: registrations unavailable:`, err.message);
    return { war: null, ids: [] };
  }
}

// -> { posted, reason?, count? }. Never throws. `guild` / `config` may be passed when the caller already has them.
async function noticeGuild(client, guildId, { guild = null, config = null } = {}) {
  let rosterId;
  let count;
  try {
    const cfg = config || (await getConfigOrDefault(guildId));
    if (!cfg || !cfg.adminChannelId) return { posted: false, reason: 'no_admin_channel' }; // nowhere to post: not an event
    if (!isOn(cfg, 'departNotice')) return { posted: false, reason: 'feature_off' }; // 🧩 Tính năng: switched off
    if (!guild && client.guilds && client.guilds.cache && !client.guilds.cache.has(guildId)) {
      // the bot left this guild (its config stays): nothing to fetch or post, say so once per process
      if (!leftGuilds.has(guildId)) {
        leftGuilds.add(guildId);
        logEvent('roster', 'depart_notice', { guild: guildId, posted: false, reason: 'not_in_guild', lvl: 'warn' });
      }
      return { posted: false, reason: 'not_in_guild' };
    }
    const head = await gameRoster.latest(guildId, '_id importedAt'); // the tick asks every minute: the id first, the member list only when there is news
    if (!head) return { posted: false, reason: 'no_roster' };
    if (cfg.departNoticeRosterId && String(cfg.departNoticeRosterId) === String(head._id)) return { posted: false, reason: 'handled' };
    const roster = await gameRoster.latest(guildId);
    if (!roster) return { posted: false, reason: 'no_roster' };
    rosterId = String(roster._id);

    const g = guild || (await client.guilds.fetch(guildId));
    const { complete, members } = await ensureMembers(g);
    if (!complete) {
      // not claimed: the next tick tries again (a half-empty cache would miss people for good)
      if (!warned.has(`${guildId}:${rosterId}`)) {
        warned.add(`${guildId}:${rosterId}`);
        logEvent('roster', 'depart_notice', { guild: guildId, rosterId, posted: false, reason: 'members_incomplete', lvl: 'warn' });
      }
      return { posted: false, reason: 'members_incomplete' };
    }
    const linked = await departure.loadLinked(guildId);
    const departed = departure.findDeparted(linked, roster.members, guildMemberMap(members), { importedAt: roster.importedAt, previous: await departure.previousMembers(guildId, linked) });
    count = departed.length;

    // an import may have landed while the members were being fetched: this one is stale then, the next tick handles the new one
    const again = await gameRoster.latest(guildId, '_id importedAt');
    if (!again || String(again._id) !== rosterId) return { posted: false, reason: 'changed' };
    if (!(await departure.claimNotice(guildId, roster._id, roster.importedAt))) return { posted: false, reason: 'claimed' }; // another tick / process / the upload has it, or a newer import was claimed
    if (!departed.length) {
      logEvent('roster', 'depart_notice', { guild: guildId, rosterId, count: 0, posted: false, reason: 'none' });
      return { posted: false, reason: 'none', count: 0 };
    }
    const channel = await client.channels.fetch(cfg.adminChannelId);
    const at = new Date();
    const { war, ids: joined } = await stillJoined(guildId, departed);
    await channel.send(v2Create(buildDepartNotice({ rosterId, importedAt: roster.importedAt, departed, joined, warTitle: war ? war.title : '' })));
    // the unlink button may touch only the people the lines really showed
    const shown = noticeParts(departed, roster.importedAt).lines.length;
    await departure.saveNoticeIds(guildId, roster._id, departed.slice(0, shown).map((d) => d.discordId), { more: departed.length - shown, at, joined, warId: war ? war._id : null });
    logEvent('roster', 'depart_notice', { guild: guildId, rosterId, count, joined: joined.length, posted: true });
    return { posted: true, count };
  } catch (err) {
    // after the claim a failed post is not retried (no repeated notices); the 🎮 view still shows the same list
    console.error(`[departNotice] guild ${guildId}:`, err.message);
    logEvent('roster', 'depart_notice', { guild: guildId, rosterId, count, posted: false, reason: 'error', err });
    return { posted: false, reason: 'error' };
  }
}

// Scheduler step: every guild with an admin channel whose latest import has not been handled yet.
async function noticeDue(client) {
  const configs = await departure.listNoticeConfigs();
  for (const config of configs) {
    try {
      await module.exports.noticeGuild(client, config.guildId, { config });
    } catch (err) {
      console.error(`[departNotice] ${config.guildId}:`, err.message); // noticeGuild itself never throws; belt and braces
    }
  }
}

// Tests only.
function resetWarned() {
  warned.clear();
  leftGuilds.clear();
}

module.exports = { noticeGuild, noticeDue, guildMemberMap, resetWarned };
