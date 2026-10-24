// "Off quá N ngày không xin phép": after a new game import, tell the managers (admin channel) which roster members have been offline for
// at least `offWarnDays` days. Same driver as ./departNotice: the minute tick
// (scheduler step `offwarn`) and the upload both call noticeGuild; the claim on GuildConfig.offNoticeRosterId (moving forward by importedAt)
// makes sure each import is handled once. The bot never kicks anybody.
const gameRoster = require('../services/gameRosterService');
const departure = require('../services/departureService'); // the import claims (claimOffNotice) and the guilds to scan
const { getConfigOrDefault, isOn } = require('../services/guildConfigService');
const { ensureMembers } = require('./memberCache');
const { buildOffNotice } = require('./ui/offNotice');
const { v2Create } = require('./ui/common');
const { logEvent } = require('../eventLog');

const DEFAULT_DAYS = 5;
const warned = new Set(); // "guild:roster" with an incomplete member list already logged (the tick retries every minute)
const leftGuilds = new Set(); // guilds the bot is no longer in, already logged once

// The threshold of a config: offWarnDays (0 = off); a config document older than the field means the default.
const thresholdOf = (config) => (config && Number.isInteger(config.offWarnDays) ? config.offWarnDays : DEFAULT_DAYS);

// Pure. members = roster members (with offDays), links = Map(member object -> discordId) of the ones paired with a Discord member,
// days = threshold. -> { off: [{ name, offDays, discordId? }] } (longest off first)
function classify({ members, links = new Map(), days }) {
  const off = [];
  for (const m of members || []) {
    const offDays = gameRoster.offDaysOf(m);
    if (offDays === null || offDays < days) continue;
    const discordId = links.get(m) || null;
    off.push({ name: m.name, offDays, ...(discordId ? { discordId } : {}) });
  }
  const order = (a, b) => b.offDays - a.offDays || String(a.name).localeCompare(String(b.name), 'vi');
  return { off: off.sort(order) };
}

// -> { posted, reason?, count? }. Never throws. `guild` / `config` may be passed when the caller already has them.
async function noticeGuild(client, guildId, { guild = null, config = null } = {}) {
  let rosterId;
  let count;
  try {
    const cfg = config || (await getConfigOrDefault(guildId));
    if (!cfg || !cfg.adminChannelId) return { posted: false, reason: 'no_admin_channel' }; // nowhere to post: not an event
    if (!isOn(cfg, 'offNotice')) return { posted: false, reason: 'feature_off' }; // 🧩 Tính năng: switched off
    if (!guild && client.guilds && client.guilds.cache && !client.guilds.cache.has(guildId)) {
      if (!leftGuilds.has(guildId)) {
        leftGuilds.add(guildId);
        logEvent('roster', 'off_notice', { guild: guildId, posted: false, reason: 'not_in_guild', lvl: 'warn' });
      }
      return { posted: false, reason: 'not_in_guild' };
    }
    const head = await gameRoster.latest(guildId, '_id importedAt'); // the tick asks every minute: the id first, the member list only when there is news
    if (!head) return { posted: false, reason: 'no_roster' };
    if (cfg.offNoticeRosterId && String(cfg.offNoticeRosterId) === String(head._id)) return { posted: false, reason: 'handled' };
    const roster = await gameRoster.latest(guildId);
    if (!roster) return { posted: false, reason: 'no_roster' };
    rosterId = String(roster._id);
    const days = thresholdOf(cfg);

    if (days <= 0) {
      // switched off: the import is claimed (and logged) once, so turning it on later waits for the NEXT import
      if (await departure.claimOffNotice(guildId, roster._id, roster.importedAt)) logEvent('roster', 'off_notice', { guild: guildId, rosterId, count: 0, posted: false, reason: 'disabled' });
      return { posted: false, reason: 'disabled' };
    }

    const g = guild || (await client.guilds.fetch(guildId));
    const { complete, members } = await ensureMembers(g);
    if (!complete) {
      // not claimed: the next tick tries again (a half-empty cache would leave linked people unlinked)
      if (!warned.has(`${guildId}:${rosterId}`)) {
        warned.add(`${guildId}:${rosterId}`);
        logEvent('roster', 'off_notice', { guild: guildId, rosterId, posted: false, reason: 'members_incomplete', lvl: 'warn' });
      }
      return { posted: false, reason: 'members_incomplete' };
    }

    const importedAt = new Date(roster.importedAt);
    const offMembers = roster.members.filter((m) => {
      const d = gameRoster.offDaysOf(m);
      return d !== null && d >= days;
    });
    let result = { off: [] };
    if (offMembers.length) {
      const infos = [...members.values()].map((m) => ({ id: m.id, name: m.displayName || (m.user && (m.user.globalName || m.user.username)) || '', bot: Boolean(m.user && m.user.bot) }));
      const found = await gameRoster.matchGuild(guildId, infos, roster);
      const links = new Map(((found && found.match.matched) || []).map((x) => [x.game, x.discordId]));
      result = classify({ members: roster.members, links, days });
    }
    count = result.off.length;

    // an import may have landed while this ran: this one is stale then, the next tick handles the new one
    const again = await gameRoster.latest(guildId, '_id importedAt');
    if (!again || String(again._id) !== rosterId) return { posted: false, reason: 'changed' };
    if (!(await departure.claimOffNotice(guildId, roster._id, roster.importedAt))) return { posted: false, reason: 'claimed' }; // another tick / process / the upload has it, or a newer import was claimed
    if (!result.off.length) {
      logEvent('roster', 'off_notice', { guild: guildId, rosterId, count: 0, posted: false, reason: 'none' });
      return { posted: false, reason: 'none', count: 0 };
    }
    const channel = await client.channels.fetch(cfg.adminChannelId);
    await channel.send(v2Create(buildOffNotice({ rosterId, importedAt, days, off: result.off })));
    logEvent('roster', 'off_notice', { guild: guildId, rosterId, count, days, posted: true });
    return { posted: true, count };
  } catch (err) {
    // after the claim a failed post is not retried (no repeated notices)
    console.error(`[offNotice] guild ${guildId}:`, err.message);
    logEvent('roster', 'off_notice', { guild: guildId, rosterId, count, posted: false, reason: 'error', err });
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
      console.error(`[offNotice] ${config.guildId}:`, err.message); // noticeGuild itself never throws; belt and braces
    }
  }
}

// Tests only.
function resetWarned() {
  warned.clear();
  leftGuilds.clear();
}

module.exports = { noticeGuild, noticeDue, classify, thresholdOf, resetWarned, DEFAULT_DAYS };
