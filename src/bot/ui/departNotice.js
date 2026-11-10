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

const MAX_MERGE = 15;
const MERGE_HELP = '-# Bấm 🔀 Ghép tên mới nếu đúng là cùng người: liên kết Discord (và ID game) chuyển sang tên trong danh sách. Không thì ghép tay ở 🎮 Thành viên game.';

// maybe: [{ id, from, name }] people whose linked name is gone but a roster name nobody holds is very close to it.
// -> the text of that section ('' without anybody).
function mergeText(maybe) {
  if (!maybe || !maybe.length) return '';
  const lines = maybe.slice(0, MAX_MERGE).map((p) => `• <@${p.id}> — **${safeName(p.from)}** → **${safeName(p.name)}**`);
  if (maybe.length > MAX_MERGE) lines.push(`… và ${maybe.length - MAX_MERGE} người nữa`);
  return [`🔀 **Có thể chỉ khác tên** (${maybe.length}) — danh sách game có tên gần giống, chưa ai nhận:`, ...lines, MERGE_HELP].join('\n');
}

// departed: [{ discordId, gameName, source }]; importedAt: when the roster was imported; maybe: see mergeText (their section shares the budget).
// -> { subtitle, lines, more }: `lines` = what fits (at most MAX_LINES and the text budget), `more` = how many are left out.
function noticeParts(departed, importedAt, maybe = []) {
  const subtitle = `Theo danh sách game cập nhật ${discordTs(new Date(importedAt), 'R')} (${departed.length + maybe.length} người).`;
  let used = TITLE.length + subtitle.length + NOTE.length + 80 + mergeText(maybe).length;
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
// maybe: the people who probably only have another name (see mergeText): listed apart with a 🔀 Ghép tên mới button, and never among `departed`.
function buildDepartNotice({ rosterId, importedAt, departed, joined = [], warTitle = '', maybe = [] }) {
  const { subtitle, lines, more } = noticeParts(departed, importedAt, maybe);
  const list = more > 0 ? [...lines, `… và ${more} người nữa`] : lines;
  const container = new ContainerBuilder().setAccentColor(ORANGE).addTextDisplayComponents(textDisplay(`${TITLE}\n${subtitle}`));
  const row = new ActionRowBuilder().addComponents(button(`adm:depok:${rosterId}`, '✅ Đã xử lý', ButtonStyle.Success));
  if (list.length) {
    container.addSeparatorComponents(separator()).addTextDisplayComponents(textDisplay(list.join('\n')));
    row.addComponents(button(`adm:depunlink:${rosterId}`, '🔗 Gỡ liên kết những người này'));
  }
  if (maybe.length) {
    container.addSeparatorComponents(separator()).addTextDisplayComponents(textDisplay(mergeText(maybe)));
    row.addComponents(button(`adm:depmerge:${rosterId}`, '🔀 Ghép tên mới', ButtonStyle.Primary));
  }
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

module.exports = { buildDepartNotice, buildDepartDone, messageTexts, noticeParts, MAX_LINES, MAX_MERGE, TITLE };
