// The persistent gate panel "👋 Chào mừng": posted once into the gate channel, edited in place afterwards, re-posted when somebody
// deleted it. Same shape as gnPanel.js; its ids live in GuildConfig (gateChannelId / gatePanelChannelId / gatePanelMessageId).
const { updateConfig } = require('../services/guildConfigService');
const { guildNameOf } = require('../services/gateService');
const { buildGatePanel } = require('./ui/gate');
const { v2Create } = require('./ui/common');

const GONE_CODES = new Set([10003, 10008]); // Unknown Channel / Unknown Message

// -> { action: 'edited' | 'posted', channelId, messageId }. Throws when the chosen channel cannot be used.
async function postOrUpdateGatePanel(client, config) {
  const channel = await client.channels.fetch(config.gateChannelId);
  const panel = buildGatePanel({ guildName: guildNameOf(config, channel.guild), autoApprove: config.gateAutoApprove !== false, guest: Boolean(config.guestRoleId) });
  if (config.gatePanelMessageId && config.gatePanelChannelId === channel.id) {
    try {
      await channel.messages.edit(config.gatePanelMessageId, panel);
      return { action: 'edited', channelId: channel.id, messageId: config.gatePanelMessageId };
    } catch (err) {
      if (!GONE_CODES.has(err.code)) throw err; // deleted: post a new one below
    }
  }
  const msg = await channel.send(v2Create(panel));
  await updateConfig(config.guildId, { gatePanelChannelId: channel.id, gatePanelMessageId: msg.id }); // store the new ids first
  if (config.gatePanelMessageId && config.gatePanelChannelId && config.gatePanelChannelId !== channel.id) {
    try {
      const old = await client.channels.fetch(config.gatePanelChannelId);
      await old.messages.delete(config.gatePanelMessageId);
    } catch (err) {
      if (!GONE_CODES.has(err.code)) console.warn(`[gate] guild ${config.guildId}: old panel ${config.gatePanelMessageId} not deleted: ${err.message}`);
    }
  }
  return { action: 'posted', channelId: channel.id, messageId: msg.id };
}

module.exports = { postOrUpdateGatePanel };
