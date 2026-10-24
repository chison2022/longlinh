// The admin-channel card "😴 Off quá N ngày không xin phép" (pure: no Discord client, no DB). One button, admin-gated in ../interactions/admin:
// adm:offok:<rosterId> (✅ Đã xử lý, edits the card; see ../interactions/admin.onOffDone).
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, escapeMarkdown } = require('discord.js');
const { truncate, textDisplay, separator, v2Payload, V2_TEXT_LIMIT } = require('./common');
const { discordTs } = require('../../utils/time');

const MAX_LINES = 40;
const NAME_MAX = 30;
const TEXT_BUDGET = V2_TEXT_LIMIT - 500; // the whole message is one 4000-char text budget: lines past it become "… và K người nữa"
const ORANGE = 0xe67e22;
const ZWSP = '​';

const title = (days) => `### 😴 Off game quá ${days} ngày`;
const note = (days) => `-# Theo luật bang: off không báo quá ${days} ngày thì mời ra khỏi bang. Bot không tự kick — kiểm tra trước.`;

// A game name is user text: no markdown, and nothing that looks like a mention.
const safeName = (s) => escapeMarkdown(truncate(s, NAME_MAX)).replace(/<(?=[@#])/g, `<${ZWSP}`).replace(/@(?=everyone|here)/gi, `@${ZWSP}`);

// p = { name, offDays, discordId? }
const lineOf = (p) => `• **${safeName(p.name)}** — off ${p.offDays} ngày${p.discordId ? ` · <@${p.discordId}>` : ''}`;

// off: array of p (see lineOf). -> { subtitle, lines, more }
function noticeParts(off, importedAt, days) {
  const subtitle = `Theo danh sách game cập nhật ${discordTs(new Date(importedAt), 'R')} (${off.length} người).`;
  let used = title(days).length + subtitle.length + note(days).length + 100;
  const lines = [];
  for (const p of off) {
    const line = lineOf(p);
    if (lines.length >= MAX_LINES || used + line.length + 1 > TEXT_BUDGET) break;
    lines.push(line);
    used += line.length + 1;
  }
  return { subtitle, lines, more: off.length - lines.length };
}

function buildOffNotice({ rosterId, importedAt, days, off }) {
  const { subtitle, lines, more } = noticeParts(off, importedAt, days);
  const list = more > 0 ? [...lines, `… và ${more} người nữa`] : lines;
  const container = new ContainerBuilder()
    .setAccentColor(ORANGE)
    .addTextDisplayComponents(textDisplay(`${title(days)}\n${subtitle}`))
    .addSeparatorComponents(separator())
    .addTextDisplayComponents(textDisplay(list.join('\n')));
  container
    .addSeparatorComponents(separator())
    .addTextDisplayComponents(textDisplay(note(days)))
    .addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`adm:offok:${rosterId}`).setLabel('✅ Đã xử lý').setStyle(ButtonStyle.Success)));
  return v2Payload([container]);
}

module.exports = { buildOffNotice, noticeParts, lineOf, MAX_LINES };
