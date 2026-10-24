// The persistent member panel "🎮 Liên kết tên trong game": posted once into the channel the admins chose, edited in place afterwards,
// re-posted when somebody deleted it. Its ids live in GuildConfig (gnPanelChannelId / gnPanelMessageId).
const { updateConfig } = require('../services/guildConfigService');
const { buildGnPanel } = require('./ui/gameName');
const { v2Create } = require('./ui/common');

const GONE_CODES = new Set([10003, 10008]); // Unknown Channel / Unknown Message

// -> { action: 'edited' | 'posted', channelId, messageId }. Throws when the chosen channel cannot be used.
async function postOrUpdateGnPanel(client, config) {
  const channel = await client.channels.fetch(config.gnChannelId);
  if (config.gnPanelMessageId && config.gnPanelChannelId === channel.id) {
    try {
      await channel.messages.edit(config.gnPanelMessageId, buildGnPanel());
      return { action: 'edited', channelId: channel.id, messageId: config.gnPanelMessageId };
    } catch (err) {
      if (!GONE_CODES.has(err.code)) throw err; // deleted: post a new one below
    }
  }
  const msg = await channel.send(v2Create(buildGnPanel()));
  await updateConfig(config.guildId, { gnPanelChannelId: channel.id, gnPanelMessageId: msg.id }); // store the new ids first
  if (config.gnPanelMessageId && config.gnPanelChannelId && config.gnPanelChannelId !== channel.id) {
    try {
      const old = await client.channels.fetch(config.gnPanelChannelId);
      await old.messages.delete(config.gnPanelMessageId);
    } catch (err) {
      if (!GONE_CODES.has(err.code)) console.warn(`[gn] guild ${config.guildId}: old panel ${config.gnPanelMessageId} not deleted: ${err.message}`);
    }
  }
  return { action: 'posted', channelId: channel.id, messageId: msg.id };
}

module.exports = { postOrUpdateGnPanel };
