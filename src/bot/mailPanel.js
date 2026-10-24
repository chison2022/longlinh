// The persistent member panel "📮 Hòm thư góp ý": posted once into the channel the admins chose, edited in place afterwards,
// re-posted when somebody deleted it. Same shape as gnPanel.js; its ids live in GuildConfig (mailPanelChannelId / mailPanelMessageId).
const { updateConfig } = require('../services/guildConfigService');
const { mailboxReady } = require('../services/mailService');
const { buildMailPanel } = require('./ui/mailbox');
const { v2Create } = require('./ui/common');

const GONE_CODES = new Set([10003, 10008]); // Unknown Channel / Unknown Message

// -> { action: 'edited' | 'posted', channelId, messageId }. Throws when the chosen channel cannot be used.
async function postOrUpdateMailPanel(client, config) {
  const channel = await client.channels.fetch(config.mailChannelId);
  const panel = buildMailPanel({ ready: mailboxReady() });
  if (config.mailPanelMessageId && config.mailPanelChannelId === channel.id) {
    try {
      await channel.messages.edit(config.mailPanelMessageId, panel);
      return { action: 'edited', channelId: channel.id, messageId: config.mailPanelMessageId };
    } catch (err) {
      if (!GONE_CODES.has(err.code)) throw err; // deleted: post a new one below
    }
  }
  const msg = await channel.send(v2Create(panel));
  await updateConfig(config.guildId, { mailPanelChannelId: channel.id, mailPanelMessageId: msg.id }); // store the new ids first
  if (config.mailPanelMessageId && config.mailPanelChannelId && config.mailPanelChannelId !== channel.id) {
    try {
      const old = await client.channels.fetch(config.mailPanelChannelId);
      await old.messages.delete(config.mailPanelMessageId);
    } catch (err) {
      if (!GONE_CODES.has(err.code)) console.warn(`[mail] guild ${config.guildId}: old panel ${config.mailPanelMessageId} not deleted: ${err.message}`);
    }
  }
  return { action: 'posted', channelId: channel.id, messageId: msg.id };
}

module.exports = { postOrUpdateMailPanel };
