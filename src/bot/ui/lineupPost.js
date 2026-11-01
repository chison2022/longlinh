// The published-lineup post: the PNG table + a "Xem PT của tôi" button. Nobody is mentioned (allowedMentions parses nothing).
const { AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { warEnd } = require('../../services/warService');
const { discordTs } = require('../../utils/time');
const { truncate } = require('./common');

const MINE_LABEL = '👤 Xem PT của tôi';
const FILE_NAME = 'doi-hinh.png';

// -> channel.send payload.
function buildLineupPost(event, config, png) {
  const start = new Date(event.startAt);
  const content = `### 📢 Đội hình — ${truncate(event.title, 200)}\n🕗 ${discordTs(start, 'f')} – ${discordTs(warEnd(start, config.schedule), 't')} (${discordTs(start, 'R')})\nBấm nút bên dưới để xem PT của bạn.`;
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`lu:mine:${event._id}`).setLabel(MINE_LABEL).setStyle(ButtonStyle.Primary));
  return { content, files: [new AttachmentBuilder(png, { name: FILE_NAME })], components: [row], allowedMentions: { parse: [] } };
}

module.exports = { MINE_LABEL, FILE_NAME, buildLineupPost };
