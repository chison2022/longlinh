// The persistent gate panel "👋 Chào mừng" (see persistentPanel.js). Its ids live in GuildConfig
// (gateChannelId / gatePanelChannelId / gatePanelMessageId).
const { guildNameOf } = require('../services/gateService');
const { buildGatePanel } = require('./ui/gate');
const { postOrUpdatePanel } = require('./persistentPanel');

// -> { action: 'edited' | 'posted', channelId, messageId }. Throws when the chosen channel cannot be used.
const postOrUpdateGatePanel = (client, config) =>
  postOrUpdatePanel(client, config, {
    tag: 'gate',
    channelId: config.gateChannelId,
    channelKey: 'gatePanelChannelId',
    messageKey: 'gatePanelMessageId',
    build: (channel) => buildGatePanel({ guildName: guildNameOf(config, channel.guild), autoApprove: config.gateAutoApprove !== false, guest: Boolean(config.guestRoleId) }),
  });

module.exports = { postOrUpdateGatePanel };
