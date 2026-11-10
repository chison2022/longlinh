// The persistent event management panel (Components V2), posted in the management channel chosen in /setup -> 🎉 Sự kiện and kept up to date by
// bot/refresher.js. customIds (the `ev` prefix, manager gate in ../interactions/events): ev:pnew (opens the create form) | ev:pmanage (the ephemeral
// 📅 manager view). Pure: no Discord client, no DB.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder } = require('discord.js');
const { discordTs } = require('../../utils/time');
const { truncate, textDisplay, v2Payload } = require('./common');
const eventService = require('../../services/eventService');
const { esc } = require('./eventCard');

const EVENT_PANEL_COLOR = 0xe91e8c; // magenta: distinct from the war purple (0x9b59b6)
const MAX_LISTED = 10;

const button = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);

// One line per event: emoji, title (a link to its card), start, status, answers (+ the shortfall of a minimum).
function panelLine(event, counts) {
  const c = counts || { yes: 0, maybe: 0, no: 0 };
  const link = eventService.messageLink(event);
  const title = truncate(esc(event.title), 60);
  const cap = event.capacity ? `/${event.capacity}` : '';
  const short = eventService.shortfallOf(event, c) ? ` · ⚠️ cần ${event.minParticipants}` : '';
  return `${eventService.categoryOf(event).emoji} ${link ? `[${title}](${link})` : title} · ${discordTs(new Date(event.startAt), 'f')} · ${eventService.STATUS_LABELS[event.status] || event.status} · ✅ ${c.yes}${cap}${short}`;
}

// `events` = open / locked events (soonest first), `counts` = Map eventId -> { yes, maybe, no }. For channel.send (v2Create) or an edit.
function buildEventPanel({ events = [], counts = new Map() } = {}) {
  const lines = ['### 📅 Quản lý sự kiện'];
  if (!events.length) lines.push('_Chưa có sự kiện nào sắp tới._');
  else {
    lines.push(...events.slice(0, MAX_LISTED).map((e) => `• ${panelLine(e, counts.get(String(e._id)))}`));
    if (events.length > MAX_LISTED) lines.push(`… và ${events.length - MAX_LISTED} sự kiện nữa`);
  }
  const container = new ContainerBuilder()
    .setAccentColor(EVENT_PANEL_COLOR)
    .addTextDisplayComponents(textDisplay(lines.join('\n')))
    .addActionRowComponents(new ActionRowBuilder().addComponents(button('ev:pnew', '➕ Tạo sự kiện', ButtonStyle.Primary), button('ev:pmanage', '📋 Quản lý…')))
    .addTextDisplayComponents(textDisplay('-# Chỉ quản lý dùng được các nút này.'));
  return v2Payload([container]);
}

module.exports = { EVENT_PANEL_COLOR, MAX_LISTED, buildEventPanel };
