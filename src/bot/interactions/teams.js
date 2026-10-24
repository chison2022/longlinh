// Publishing the lineup = posting the link the admins made (their own Google Sheet).
const { MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const warService = require('../../services/warService');
const { getConfigOrDefault } = require('../../services/guildConfigService');
const { isAdmin } = require('../permissions');
const { buildPublishModal } = require('../ui/settingsModal');
const { buildLineupLinkMessage, parseLineupUrl } = require('../ui/lineupLink');
const { scheduleRefresh, schedulePanelRefresh } = require('../refresher');
const { NO_PERMISSION, eph } = require('./common');
const { logEvent, ixCtx } = require('../../eventLog');

const NOT_FOUND = 'Bang chiến không tồn tại hoặc đã bị xoá.';
const ENDED = 'Bang chiến đã kết thúc, không thể công bố đội hình.';
const BAD_URL = '❌ Link đội hình không hợp lệ (cần bắt đầu bằng https://).';
const PUBLISH_CONFIRM = 'Công bố sẽ đóng đăng ký với cả bang. Tiếp tục?';
const ALREADY_PUBLISHED = '📢 Đội hình đã được công bố rồi.';
const PUBLISHING = '⏳ Đang công bố…';

// Events whose publish is posting right now: a second click on "Công bố" must not post again. In-process only, so it
// assumes a single bot process.
const confirming = new Set();
// Link + note typed in the modal of an OPEN event, waiting for the admin's confirm click (nothing is stored on the event until the
// announcement is really posted). In-process, 15 minutes: after a restart the admin simply presses "Công bố" again.
const PENDING_MS = 15 * 60 * 1000;
const pending = new Map(); // `${eventId}:${userId}` -> { url, note, at }: per admin, so two admins never publish or cancel each other's link
const pendingKey = (eventId, interaction) => `${eventId}:${interaction.user.id}`;
const sweepPending = () => {
  for (const [k, p] of pending) if (Date.now() - p.at > PENDING_MS) pending.delete(k);
};
const pendingFor = (eventId, interaction) => {
  sweepPending();
  const key = pendingKey(eventId, interaction);
  const p = pending.get(key);
  return p ? { url: p.url, note: p.note, key } : null;
};
const EXPIRED = 'Link đội hình đã hết hạn chờ (hoặc bot vừa khởi động lại). Bấm **📢 Công bố** ở bảng điều khiển và dán link lại.';

// tm:pub:<eid> - the dashboard "Công bố": asks for the link (modal, answered within 3 s)
async function openModal(interaction, eventId) {
  let config = null;
  let allowed = isAdmin(interaction.member, null, interaction.memberPermissions);
  if (!allowed) {
    config = await getConfigOrDefault(interaction.guildId);
    allowed = isAdmin(interaction.member, config, interaction.memberPermissions);
  }
  if (!allowed) return interaction.reply(eph(NO_PERMISSION));
  const event = await warService.getEvent(eventId);
  if (!event || event.guildId !== interaction.guildId) return interaction.reply(eph(NOT_FOUND));
  if (event.status === 'done') return interaction.reply(eph(ENDED));
  logEvent('publish', 'modal', { ...ixCtx(interaction), eid: eventId, status: event.status });
  return interaction.showModal(buildPublishModal(event));
}

// tm:pubModal:<eid> - link + note saved on the event; while registration is still open the admin confirms first
async function onModalSubmit(interaction, eventId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const config = await getConfigOrDefault(interaction.guildId);
  if (!isAdmin(interaction.member, config, interaction.memberPermissions)) return interaction.editReply(NO_PERMISSION);
  const event = await warService.getEvent(eventId);
  if (!event || event.guildId !== interaction.guildId) return interaction.editReply(NOT_FOUND);
  if (event.status === 'done') return interaction.editReply(ENDED);
  const url = parseLineupUrl(interaction.fields.getTextInputValue('url'));
  if (!url) return interaction.editReply(BAD_URL);
  const note = (interaction.fields.getTextInputValue('note') || '').trim();
  if (event.status === 'open') {
    sweepPending();
    pending.set(pendingKey(eventId, interaction), { url, note, at: Date.now() });
    logEvent('publish', 'confirm_asked', { ...ixCtx(interaction), eid: eventId });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`tm:pubok:${eventId}`).setLabel('📢 Công bố').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`tm:pubno:${eventId}`).setLabel('Huỷ').setStyle(ButtonStyle.Secondary)
    );
    return interaction.editReply({ content: `⚠️ ${PUBLISH_CONFIRM}\n🔗 ${url.length > 100 ? `${url.slice(0, 97)}…` : url}`, components: [row] });
  }
  return publish(interaction, eventId, false, { url, note, key: null });
}

// the confirmed publish (tm:pubok edits the confirm message) or the direct one after the modal
async function publish(interaction, eventId, confirmed, link) {
  const reply = (content) => interaction.editReply(confirmed ? { content, components: [] } : content);
  const key = String(eventId);
  if (confirming.has(key)) return reply(PUBLISHING);
  confirming.add(key);
  try {
    return await publishNow(interaction, eventId, confirmed, reply, link);
  } finally {
    confirming.delete(key);
  }
}

async function publishNow(interaction, eventId, confirmed, reply, link) {
  const config = await getConfigOrDefault(interaction.guildId);
  if (!isAdmin(interaction.member, config, interaction.memberPermissions)) return reply(NO_PERMISSION);
  const stored = await warService.getEvent(eventId);
  if (!stored || stored.guildId !== interaction.guildId) return reply(NOT_FOUND);
  if (stored.status === 'done') return reply(ENDED);
  if (confirmed && stored.status === 'published') {
    if (link) pending.delete(link.key);
    return reply(ALREADY_PUBLISHED); // the first click of a double click already did it
  }
  if (!link) {
    logEvent('publish', 'expired', { ...ixCtx(interaction), eid: eventId });
    return reply(EXPIRED);
  }
  const { url, note } = link;
  const wasPublished = stored.status === 'published';
  const wasOpen = stored.status === 'open';
  const channelId = config.announceChannelId || stored.channelId;
  try {
    const channel = await interaction.client.channels.fetch(channelId);
    await channel.send(buildLineupLinkMessage(stored, config, { url, note }));
  } catch (err) {
    console.error('[teams] publish:', err.message);
    logEvent('publish', 'failed', { ...ixCtx(interaction), eid: eventId, stage: 'send', wasOpen, channel: channelId, err });
    return reply(`❌ Không gửi được vào <#${channelId}>. Kiểm tra quyền của bot.`);
  }
  if (link.key) pending.delete(link.key);
  // the announcement is out: only now is the link kept on the event (the war message button, a later re-post prefill)
  let warning = '';
  await warService.setLineupLink(stored._id, url, note).catch((err) => {
    console.error('[teams] could not store the lineup link:', err.message);
    warning = '\n⚠️ Đã đăng nhưng chưa lưu được link vào bang chiến (nút "📊 Đội hình" trên bài đăng ký có thể chưa hiện). Bấm Công bố lại nếu cần.';
  });
  const updated = await warService.publishEvent(stored._id, new Date());
  logEvent('publish', 'posted', { ...ixCtx(interaction), eid: eventId, wasOpen, republish: wasPublished, linkStored: !warning, statusChanged: Boolean(updated) });
  scheduleRefresh(interaction.client, stored._id, 0); // the war message gets its "📊 Đội hình" button
  schedulePanelRefresh(interaction.client, interaction.guildId);
  if (!updated) return reply(`⚠️ Đã đăng đội hình ở <#${channelId}> nhưng bang chiến vừa kết thúc nên trạng thái không đổi.${warning}`);
  if (wasOpen) return reply(`📢 Đã công bố — đăng ký đã đóng. Đội hình ở <#${channelId}>.${warning}`);
  return reply(`📢 Đã công bố đội hình ở <#${channelId}>${wasPublished ? ' (đăng lại)' : ''}.${warning}`);
}

// tm:pub:<eid> | tm:pubModal:<eid> | tm:pubok:<eid> | tm:pubno:<eid>
async function handle(interaction, parts) {
  const [, action, eventId] = parts;
  if (action === 'pub') return openModal(interaction, eventId);
  if (action === 'pubModal') return onModalSubmit(interaction, eventId);
  if (action === 'pubok') {
    await interaction.deferUpdate();
    return publish(interaction, eventId, true, pendingFor(eventId, interaction));
  }
  if (action === 'pubno') {
    await interaction.deferUpdate();
    pending.delete(pendingKey(eventId, interaction));
    logEvent('publish', 'cancelled', { ...ixCtx(interaction), eid: eventId });
    return interaction.editReply({ content: 'Đã huỷ, chưa công bố.', components: [] });
  }
  return undefined;
}

module.exports = { handle };
