// A persistent panel (🎮 name link, 📮 mailbox, 👋 gate, 📅 event management): posted once into the channel the admins chose, edited
// in place afterwards, re-posted when somebody deleted it. When the channel changed, the new panel is posted first and the old one is
// deleted after its ids were replaced in GuildConfig.
const configService = require('../services/guildConfigService');
const { v2Create } = require('./ui/common');

const GONE_CODES = new Set([10003, 10008]); // Unknown Channel / Unknown Message

// spec: tag (log prefix), channelId (where the panel belongs), channelKey / messageKey (the GuildConfig fields holding the posted
// panel's ids), build(channel) -> the V2 payload (sync or async).
// -> { action: 'edited' | 'posted', channelId, messageId }. Throws when the chosen channel cannot be used.
async function postOrUpdatePanel(client, config, { tag, channelId, channelKey, messageKey, build }) {
  const channel = await client.channels.fetch(channelId);
  const panel = await build(channel);
  const oldChannelId = config[channelKey];
  const oldMessageId = config[messageKey];
  if (oldMessageId && oldChannelId === channel.id) {
    try {
      await channel.messages.edit(oldMessageId, panel);
      return { action: 'edited', channelId: channel.id, messageId: oldMessageId };
    } catch (err) {
      if (!GONE_CODES.has(err.code)) throw err; // deleted: post a new one below
    }
  }
  const msg = await channel.send(v2Create(panel));
  await configService.updateConfig(config.guildId, { [channelKey]: channel.id, [messageKey]: msg.id }); // store the new ids first
  if (oldMessageId && oldChannelId && oldChannelId !== channel.id) {
    try {
      const old = await client.channels.fetch(oldChannelId);
      await old.messages.delete(oldMessageId);
    } catch (err) {
      if (!GONE_CODES.has(err.code)) console.warn(`[${tag}] guild ${config.guildId}: old panel ${oldMessageId} not deleted: ${err.message}`);
    }
  }
  return { action: 'posted', channelId: channel.id, messageId: msg.id };
}

module.exports = { postOrUpdatePanel };
