// The persistent event management panel "📅 Quản lý sự kiện" (see persistentPanel.js; bot/refresher.js keeps it fresh). Its ids live
// in GuildConfig (eventPanelChannelId / eventPanelMessageId).
const eventService = require('../services/eventService');
const { buildEventPanel } = require('./ui/eventPanel');
const { postOrUpdatePanel } = require('./persistentPanel');

const PANEL_EVENT_LIMIT = 100; // only the first 10 are listed, the rest is counted

// The panel payload of a guild: its open / locked events with their numbers.
async function buildEventPanelFor(guildId) {
  const events = await eventService.listManage(guildId, PANEL_EVENT_LIMIT);
  const counts = await eventService.countsFor(events.map((e) => e._id));
  return buildEventPanel({ events, counts });
}

// -> { action: 'edited' | 'posted', channelId, messageId }. Throws when the chosen channel cannot be used.
const postOrUpdateEventPanel = (client, config) =>
  postOrUpdatePanel(client, config, {
    tag: 'events',
    channelId: eventService.eventAdminChannelOf(config),
    channelKey: 'eventPanelChannelId',
    messageKey: 'eventPanelMessageId',
    build: () => buildEventPanelFor(config.guildId),
  });

module.exports = { buildEventPanelFor, postOrUpdateEventPanel };
