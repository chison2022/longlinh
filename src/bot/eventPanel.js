// The persistent event management panel "📅 Quản lý sự kiện": posted once into the management channel the admins chose, edited in place afterwards
// (bot/refresher.js keeps it fresh), re-posted when somebody deleted it. Same shape as gnPanel.js; its ids live in GuildConfig
// (eventPanelChannelId / eventPanelMessageId).
const { updateConfig } = require('../services/guildConfigService');
const eventService = require('../services/eventService');
const { buildEventPanel } = require('./ui/eventPanel');
const { v2Create } = require('./ui/common');

const GONE_CODES = new Set([10003, 10008]); // Unknown Channel / Unknown Message
const PANEL_EVENT_LIMIT = 100; // only the first 10 are listed, the rest is counted

// The panel payload of a guild: its open / locked events with their numbers.
async function buildEventPanelFor(guildId) {
  const events = await eventService.listManage(guildId, PANEL_EVENT_LIMIT);
  const counts = await eventService.countsFor(events.map((e) => e._id));
  return buildEventPanel({ events, counts });
}

// -> { action: 'edited' | 'posted', channelId, messageId }. Throws when the chosen channel cannot be used.
async function postOrUpdateEventPanel(client, config) {
  const channelId = eventService.eventAdminChannelOf(config);
  const channel = await client.channels.fetch(channelId);
  const panel = await buildEventPanelFor(config.guildId);
  if (config.eventPanelMessageId && config.eventPanelChannelId === channel.id) {
    try {
      await channel.messages.edit(config.eventPanelMessageId, panel);
      return { action: 'edited', channelId: channel.id, messageId: config.eventPanelMessageId };
    } catch (err) {
      if (!GONE_CODES.has(err.code)) throw err; // deleted: post a new one below
    }
  }
  const msg = await channel.send(v2Create(panel));
  await updateConfig(config.guildId, { eventPanelChannelId: channel.id, eventPanelMessageId: msg.id }); // store the new ids first
  if (config.eventPanelMessageId && config.eventPanelChannelId && config.eventPanelChannelId !== channel.id) {
    try {
      const old = await client.channels.fetch(config.eventPanelChannelId);
      await old.messages.delete(config.eventPanelMessageId);
    } catch (err) {
      if (!GONE_CODES.has(err.code)) console.warn(`[events] guild ${config.guildId}: old panel ${config.eventPanelMessageId} not deleted: ${err.message}`);
    }
  }
  return { action: 'posted', channelId: channel.id, messageId: msg.id };
}

module.exports = { buildEventPanelFor, postOrUpdateEventPanel };
