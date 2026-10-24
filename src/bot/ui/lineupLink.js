const { ButtonBuilder, ButtonStyle, ActionRowBuilder, ContainerBuilder } = require('discord.js');
const { warEnd } = require('../../services/warService');
const { discordTs } = require('../../utils/time');
const { truncate, textDisplay, v2Payload, v2Create } = require('./common');

const LINK_LABEL = '📊 Xem đội hình';

const MAX_URL = 512; // Discord: a link button's url holds at most 512 characters

// http(s) URL only (a link button needs one); -> the NORMALIZED URL (href: non-ASCII characters are percent-encoded, which makes
// it longer than what was typed) or null when it is not http(s) or the normalized form exceeds MAX_URL.
function parseLineupUrl(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  try {
    const u = new URL(text);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.href.length <= MAX_URL ? u.href : null;
  } catch {
    return null;
  }
}

const linkButton = (url, label = LINK_LABEL) => new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel(label);

// The published-lineup announcement: ONE Components V2 message (title, war time, note, link button). Nobody is mentioned.
// For channel.send.
function buildLineupLinkMessage(event, config, { url, note = '' }) {
  const start = new Date(event.startAt);
  const lines = [`### 📢 Đội hình — ${truncate(event.title, 200)}`, `🕗 ${discordTs(start, 'f')} – ${discordTs(warEnd(start, config.schedule), 't')} (${discordTs(start, 'R')})`];
  if (note && note.trim()) lines.push('', truncate(note.trim(), 1000));
  const container = new ContainerBuilder()
    .setAccentColor(0x3498db)
    .addTextDisplayComponents(textDisplay(lines.join('\n')))
    .addActionRowComponents(new ActionRowBuilder().addComponents(linkButton(url)));
  return v2Create(v2Payload([container]));
}

module.exports = { MAX_URL, LINK_LABEL, parseLineupUrl, linkButton, buildLineupLinkMessage };
