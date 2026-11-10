// The admin-channel notice "left the guild in game but still on Discord" (pure: no Discord client, no DB). customIds (admin-gated):
// adm:depok:<rosterId> (✅ Đã xử lý, edits the notice) | adm:depunlink:<rosterId> (🔗 Gỡ liên kết những người này)
// | adm:depreg:<rosterId> (🗑️ Gỡ báo danh: only when some of them still say "join" for the current war).
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, escapeMarkdown } = require('discord.js');
const { truncate, textDisplay, separator, v2Payload, V2_TEXT_LIMIT } = require('./common');
const { discordTs } = require('../../utils/time');

const MAX_LINES = 40;
const NAME_MAX = 30;
const TEXT_BUDGET = V2_TEXT_LIMIT - 500; // the whole message is one 4000-char text budget: lines past it become "… và K người nữa"
const ORANGE = 0xe67e22;
const GREEN = 0x2ecc71;
const ZWSP = '​';

const TITLE = '### 🚪 Đã rời bang trong game nhưng còn trong Discord';
const NOTE = '-# Có thể họ chỉ đổi tên trong game — kiểm tra trước khi kick. Bot không tự kick.';
const SOURCE_TEXT = { admin: 'admin', self: 'tự chọn', selfFree: 'tự nhập' };

// A game name is user text: no markdown, and nothing that looks like a mention.
const safeName = (s) => escapeMarkdown(truncate(s, NAME_MAX)).replace(/<(?=[@#])/g, `<${ZWSP}`).replace(/@(?=everyone|here)/gi, `@${ZWSP}`);

const lineOf = (p) => `• <@${p.discordId}> — tên game **${safeName(p.gameName)}** (liên kết: ${SOURCE_TEXT[p.source] || SOURCE_TEXT.admin})`;

// departed: [{ discordId, gameName, source }]; importedAt: when the roster was imported.
// -> { subtitle, lines, more }: `lines` = what fits (at most MAX_LINES and the text budget), `more` = how many are left out.
function noticeParts(departed, importedAt) {
  const subtitle = `Theo danh sách game cập nhật ${discordTs(new Date(importedAt), 'R')} (${departed.length} người).`;
  let used = TITLE.length + subtitle.length + NOTE.length + 80;
  const lines = [];
  for (const p of departed) {
    const line = lineOf(p);
    if (lines.length >= MAX_LINES || used + line.length + 1 > TEXT_BUDGET) break;
    lines.push(line);
    used += line.length + 1;
  }
  return { subtitle, lines, more: departed.length - lines.length };
}

const button = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);

// joined: Discord ids of `departed` who still say "join" for the current war (`warTitle`): listed apart, with a 🗑️ Gỡ báo danh button.
function buildDepartNotice({ rosterId, importedAt, departed, joined = [], warTitle = '' }) {
  const { subtitle, lines, more } = noticeParts(departed, importedAt);
  const list = more > 0 ? [...lines, `… và ${more} người nữa`] : lines;
  const container = new ContainerBuilder()
    .setAccentColor(ORANGE)
    .addTextDisplayComponents(textDisplay(`${TITLE}\n${subtitle}`))
    .addSeparatorComponents(separator())
    .addTextDisplayComponents(textDisplay(list.join('\n')));
  const row = new ActionRowBuilder().addComponents(button(`adm:depok:${rosterId}`, '✅ Đã xử lý', ButtonStyle.Success), button(`adm:depunlink:${rosterId}`, '🔗 Gỡ liên kết những người này'));
  if (joined.length) {
    const shown = joined.slice(0, MAX_LINES).map((id) => `<@${id}>`).join(', ');
    const rest = joined.length > MAX_LINES ? ` … +${joined.length - MAX_LINES}` : '';
    container.addSeparatorComponents(separator()).addTextDisplayComponents(textDisplay(`⚠️ **Vẫn đang báo danh Tham gia**${warTitle ? ` trận ${safeName(warTitle)}` : ''} (${joined.length}): ${shown}${rest}\n-# Bấm 🗑️ Gỡ báo danh nếu họ thật sự đã rời bang.`));
    row.addComponents(button(`adm:depreg:${rosterId}`, '🗑️ Gỡ báo danh', ButtonStyle.Danger));
  }
  container.addSeparatorComponents(separator()).addTextDisplayComponents(textDisplay(NOTE)).addActionRowComponents(row);
  return v2Payload([container]);
}

// The notice after "✅ Đã xử lý": same texts (read back from the clicked message), green, no buttons, plus who handled it and when.
function buildDepartDone({ texts, adminId, at = new Date() }) {
  const container = new ContainerBuilder().setAccentColor(GREEN);
  texts.forEach((t, i) => {
    if (i) container.addSeparatorComponents(separator());
    container.addTextDisplayComponents(textDisplay(t));
  });
  container.addSeparatorComponents(separator()).addTextDisplayComponents(textDisplay(`✅ <@${adminId}> đã xử lý ${discordTs(at, 'R')}`));
  return v2Payload([container]);
}

// Text of every Text Display of a message (Container -> children), in order; buttons and rows have no `content`.
function messageTexts(message) {
  const out = [];
  const walk = (c) => {
    if (!c) return;
    if (typeof c.content === 'string' && c.content) out.push(c.content);
    for (const child of c.components || []) walk(child);
  };
  for (const c of (message && message.components) || []) walk(c);
  return out;
}

module.exports = { buildDepartNotice, buildDepartDone, messageTexts, noticeParts, MAX_LINES, TITLE };
