// The "registration is open" role ping: when the scheduler auto-posts a war message and the guild turned schedule.openPing on, ONE extra short
// message tags the member role (config.memberRoleId) so people tick their registration. Only that role is allowed to be mentioned; nothing
// here may fail the war post (the caller also catches). At most once per war: warService.claimOpenPing takes the right first.
const warService = require('../services/warService');
const { discordTs } = require('../utils/time');
const { logEvent } = require('../eventLog');

// -> the message payload.
function buildOpenPing(event, roleId) {
  const link = warService.messageLink(event);
  const title = String(event.title || '').replace(/[*_`~|>]/g, '').slice(0, 100);
  const content = `<@&${roleId}> 📢 Đã mở báo danh **${title}** (${discordTs(new Date(event.startAt), 'f')}) — vào tick ✅ Tham gia / ❌ Vắng ở tin nhắn trên trước ${discordTs(new Date(event.deadlineAt), 'R')}!${link ? `\n${link}` : ''}`;
  return { content, allowedMentions: { roles: [roleId] } };
}

// -> true when the ping went out. `event` = the posted war (channelId / messageId set).
async function sendOpenPing(client, config, event) {
  const roleId = config && config.memberRoleId;
  if (!config || !config.schedule || !config.schedule.openPing || !roleId || !event) return false;
  try {
    if (!(await warService.claimOpenPing(event._id))) return false; // already pinged (a retry / restart)
    const channel = await client.channels.fetch(event.channelId || config.announceChannelId);
    await channel.send(buildOpenPing(event, roleId));
    logEvent('sched', 'open_ping', { result: 'sent', eid: String(event._id), guild: event.guildId });
    return true;
  } catch (err) {
    console.error(`[scheduler] open ping of ${event._id} failed:`, err && err.message);
    logEvent('sched', 'open_ping', { result: 'failed', eid: String(event._id), guild: event.guildId, err });
    return false;
  }
}

module.exports = { buildOpenPing, sendOpenPing };
