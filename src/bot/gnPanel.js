// The persistent member panel "🎮 Liên kết tên trong game" (see persistentPanel.js). Its ids live in GuildConfig
// (gnPanelChannelId / gnPanelMessageId).
const { buildGnPanel } = require('./ui/gameName');
const { postOrUpdatePanel } = require('./persistentPanel');

// -> { action: 'edited' | 'posted', channelId, messageId }. Throws when the chosen channel cannot be used.
const postOrUpdateGnPanel = (client, config) =>
  postOrUpdatePanel(client, config, { tag: 'gn', channelId: config.gnChannelId, channelKey: 'gnPanelChannelId', messageKey: 'gnPanelMessageId', build: () => buildGnPanel() });

module.exports = { postOrUpdateGnPanel };
