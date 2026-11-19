// The watched event channel (/setup → 🎉 Sự kiện → "Kênh đăng bài sự kiện"): a manager writes an event post there the normal way, and the
// bot "bumps" it: it answers the post with the event card (✅ Tham gia / ❓ Có thể / ❌ Không), so members register right under the post.
// The time comes from the post text (eventTimeParse); when none is found the bot answers with a button instead (ev:bump:<post id>) that
// lets a manager pick the time (the picker + preview of the events flow, which then posts the card the same way).
// Only top-level posts of managers count (no replies, no bots, no other channel); one event per post (unique index on source_message_id).
// Needs the Message Content intent (see client.js: without it this listener is not registered).
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('../db');
const defaults = require('../../config/defaults');
const eventService = require('../services/eventService');
const { parseEventTime, titleOf } = require('../services/eventTimeParse');
const { getConfig } = require('../services/guildConfigService');
const { isOn } = require('../services/features');
const { isAdmin } = require('./permissions');
const { postEventCard } = require('./refresher');
const sheetSync = require('./sheetSync');
const { scheduleDocSync } = require('./eventDocSync');
const { logEvent } = require('../eventLog');

const FALLBACK_TITLE = 'Sự kiện mới';
const ASK_TIME = '⏰ Chưa thấy giờ sự kiện trong bài nên chưa mở báo danh.\n-# Quản lý bấm nút bên dưới để chọn giờ.';
const ASK_LABEL = '⏰ Chọn giờ & mở báo danh';

// Is this message a post the bot should bump? `config` = the guild config (cached).
function isWatchedPost(message, config) {
  if (!message || !message.guild || !config || !config.eventWatchChannelId) return false;
  if (message.channelId !== config.eventWatchChannelId) return false;
  if (!message.author || message.author.bot || message.system || message.webhookId) return false;
  if (message.reference) return false; // a reply is talk about a post, not a new one
  if (!isOn(config, 'events')) return false;
  return isAdmin(message.member, config);
}

// Creates the event of the post `source` ({ guildId, channelId, messageId }) and answers the post with its card.
// `value` = { title, startAt, endAt?, deadlineAt?, capacity?, minParticipants?, allowMaybe?, description? }.
// -> { event, existed } (existed: the post had an event already, nothing new was made). Throws when the card cannot be posted (the event is removed).
async function bumpPost(client, source, value, { by = null, tagRoleId = null } = {}) {
  const existing = await eventService.eventBySource(source.guildId, source.messageId);
  if (existing) return { event: existing, existed: true };
  let event;
  try {
    event = await eventService.createEvent({
      guildId: source.guildId,
      category: defaults.eventCategoryDefault,
      description: '',
      deadlineAt: value.startAt,
      ...value,
      createdBy: by,
      sourceMessageId: String(source.messageId),
    });
  } catch (err) {
    if (!db.isUniqueViolation(err)) throw err;
    return { event: await eventService.eventBySource(source.guildId, source.messageId), existed: true }; // a second click won the race
  }
  let posted;
  try {
    posted = await postEventCard(client, source.channelId, event, { replyTo: source.messageId, tagRoleId });
  } catch (err) {
    await eventService.deleteEvent(event._id).catch((delErr) => console.error('[eventWatch] could not remove the unposted event:', delErr.message));
    throw err;
  }
  sheetSync.scheduleSync(client, source.guildId);
  scheduleDocSync(client, source.guildId);
  return { event: posted, existed: false };
}

const askButton = (messageId) => new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`ev:bump:${messageId}`).setLabel(ASK_LABEL).setStyle(ButtonStyle.Primary));

async function onMessageCreate(message) {
  if (!message || !message.guild || (message.author && message.author.bot)) return;
  let config;
  try {
    config = await getConfig(message.guild.id);
  } catch (err) {
    console.error('[eventWatch] config:', err.message);
    return;
  }
  if (!isWatchedPost(message, config)) return;
  const ctx = { guild: message.guild.id, uid: message.author.id, post: message.id };
  const title = titleOf(message.content) || FALLBACK_TITLE;
  const startAt = parseEventTime(message.content, new Date());
  try {
    if (!startAt) {
      await message.reply({ content: ASK_TIME, components: [askButton(message.id)], allowedMentions: { parse: [], repliedUser: false } });
      logEvent('event', 'bump', { ...ctx, result: 'ask_time' });
      return;
    }
    const { event, existed } = await bumpPost(message.client, { guildId: message.guild.id, channelId: message.channelId, messageId: message.id }, { title, startAt }, { by: message.author.id });
    logEvent('event', 'bump', { ...ctx, result: existed ? 'exists' : 'created', eid: String(event && event._id), start: startAt.toISOString() });
  } catch (err) {
    console.error('[eventWatch] bump failed:', err.message);
    logEvent('event', 'bump', { ...ctx, result: 'error', err, lvl: 'warn' });
  }
}

module.exports = { onMessageCreate, bumpPost, isWatchedPost, ASK_TIME, ASK_LABEL };
