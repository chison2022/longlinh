// The persistent member panel "📮 Hòm thư góp ý" (see persistentPanel.js). Its ids live in GuildConfig
// (mailPanelChannelId / mailPanelMessageId).
const { mailboxReady } = require('../services/mailService');
const { buildMailPanel } = require('./ui/mailbox');
const { postOrUpdatePanel } = require('./persistentPanel');

// -> { action: 'edited' | 'posted', channelId, messageId }. Throws when the chosen channel cannot be used.
const postOrUpdateMailPanel = (client, config) =>
  postOrUpdatePanel(client, config, {
    tag: 'mail',
    channelId: config.mailChannelId,
    channelKey: 'mailPanelChannelId',
    messageKey: 'mailPanelMessageId',
    build: () => buildMailPanel({ ready: mailboxReady() }),
  });

module.exports = { postOrUpdateMailPanel };
