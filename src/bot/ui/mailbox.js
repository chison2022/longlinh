// "📮 Hòm thư góp ý" screens (pure: no Discord client, no DB). customIds (all mb:*, see interactions/mailbox.js):
// member:  mb:open (panel) | mb:cat (select) | mb:anon:<cat> / mb:named:<cat> (open the modal mb:sendModal:<a|n>:<cat>) | mb:view (modal mb:codeModal)
// manager: mb:seen:<no> | mb:reply:<no> (modal mb:replyModal:<no>) | mb:done:<no>   (the letter card, admin-gated)
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, StringSelectMenuBuilder, ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle, escapeMarkdown } = require('discord.js');
const { truncate, textDisplay, separator, v2Payload } = require('./common');
const { discordTs } = require('../../utils/time');
const { CATEGORIES, CONTENT_MAX, TITLE_MAX, categoryLine, defang, safeReply, isCategory, LINK_WARNING } = require('../../services/mailService');

const STATUS_COLORS = { new: 0xf1c40f, seen: 0x3498db, done: 0x2ecc71 };
const STATUS_LABELS = { new: '🟡 Chưa xem', seen: '🔵 Đã xem', done: '🟢 Đã xong' };

const LABELS = {
  title: '### 📮 Hòm thư góp ý',
  intro: 'Gửi góp ý, khiếu nại, báo lỗi cho quản lý bang.',
  anonNote: '🕵️ Thư ẩn danh: quản lý không thấy tên bạn. Chủ bot có thể tra người gửi khi thư vi phạm nghiêm trọng (đe doạ, bôi nhọ).',
  notReady: '🕵️ Thư ẩn danh: hòm thư chưa được thiết lập, tạm thời chỉ gửi kèm tên được.',
  send: '📮 Gửi ý kiến',
  view: '📬 Xem trả lời',
  anon: '🕵️ Gửi ẩn danh',
  named: '🙋 Gửi kèm tên',
  blocked: 'Bạn không thể gửi thư.',
};

const button = (id, label, style = ButtonStyle.Secondary, disabled = false) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);

// The persistent panel in the members' channel. ready = the owner's public key is installed (anonymous letters possible).
function buildMailPanel({ ready = true } = {}) {
  const container = new ContainerBuilder()
    .setAccentColor(0x1e3a8a)
    .addTextDisplayComponents(textDisplay(`${LABELS.title}\n${LABELS.intro}\n${ready ? LABELS.anonNote : LABELS.notReady}`))
    .addActionRowComponents(new ActionRowBuilder().addComponents(button('mb:open', LABELS.send, ButtonStyle.Primary), button('mb:view', LABELS.view)));
  return v2Payload([container]);
}

// The ephemeral step after "Gửi ý kiến": category select + the two send buttons (disabled until a category is chosen; the
// category rides in the buttons' customId). Plain content message, so the modal submit can edit it into the result.
function buildSendStep({ category = null, ready = true } = {}) {
  const cat = isCategory(category) ? category : null;
  const select = new StringSelectMenuBuilder()
    .setCustomId('mb:cat')
    .setPlaceholder('Chọn loại ý kiến…')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(Object.entries(CATEGORIES).map(([value, c]) => ({ label: `${c.emoji} ${c.label}`, value, default: value === cat })));
  const arg = cat || '-';
  const lines = ['**📮 Gửi ý kiến**', cat ? `Loại: ${categoryLine(cat)}. Chọn cách gửi:` : 'Chọn loại ý kiến, rồi chọn cách gửi.'];
  if (!ready) lines.push('-# 🕵️ Hòm thư ẩn danh chưa được thiết lập: chỉ gửi kèm tên được.');
  return {
    content: lines.join('\n'),
    allowedMentions: { parse: [] },
    components: [
      new ActionRowBuilder().addComponents(select),
      new ActionRowBuilder().addComponents(button(`mb:anon:${arg}`, LABELS.anon, ButtonStyle.Primary, !cat || !ready), button(`mb:named:${arg}`, LABELS.named, ButtonStyle.Secondary, !cat)),
    ],
  };
}

function field(id, label, { style = TextInputStyle.Short, required = true, maxLength, description } = {}) {
  const input = new TextInputBuilder().setCustomId(id).setStyle(style).setRequired(required);
  if (maxLength) input.setMaxLength(maxLength);
  const f = new LabelBuilder().setLabel(label).setTextInputComponent(input);
  if (description) f.setDescription(description);
  return f;
}

function buildSendModal(category, anonymous) {
  return new ModalBuilder()
    .setCustomId(`mb:sendModal:${anonymous ? 'a' : 'n'}:${category}`)
    .setTitle(anonymous ? 'Gửi ý kiến ẩn danh' : 'Gửi ý kiến kèm tên')
    .addLabelComponents(
      field('title', 'Tiêu đề ngắn (không bắt buộc)', { required: false, maxLength: TITLE_MAX }),
      field('content', 'Nội dung', { style: TextInputStyle.Paragraph, maxLength: CONTENT_MAX })
    );
}

function buildCodeModal() {
  return new ModalBuilder()
    .setCustomId('mb:codeModal')
    .setTitle('Xem trả lời')
    .addLabelComponents(field('code', 'Mã thư', { maxLength: 20, description: 'Dạng ABCDE-FGHJK, bạn nhận được lúc gửi thư' }));
}

function buildReplyModal(no) {
  return new ModalBuilder().setCustomId(`mb:replyModal:${no}`).setTitle(`Trả lời thư #${no}`).addLabelComponents(field('text', 'Nội dung trả lời', { style: TextInputStyle.Paragraph, maxLength: CONTENT_MAX }));
}

// The letter card in the inbox channel. The sender's words are untrusted: defanged here, and the message is sent without mentions.
function buildLetterCard(letter) {
  const when = discordTs(new Date(letter.createdAt || Date.now()), 'R');
  const who = letter.anonymous ? '🕵️ Ẩn danh' : `🙋 <@${letter.senderId}>`;
  const lines = [`### 📮 Thư #${letter.no} · ${categoryLine(letter.category)}`];
  if (letter.title) lines.push(`**${escapeMarkdown(defang(letter.title))}**`);
  lines.push(defang(letter.content), `-# ${who} · ${when}`);
  const container = new ContainerBuilder().setAccentColor(STATUS_COLORS[letter.status] || STATUS_COLORS.new).addTextDisplayComponents(textDisplay(lines.join('\n')));
  const last = (letter.replies || [])[letter.replies.length - 1];
  if (last) {
    container.addSeparatorComponents(separator()).addTextDisplayComponents(textDisplay(`💬 <@${last.by}> · ${discordTs(new Date(last.at), 'R')}: ${truncate(defang(last.text), 1000)}`));
  }
  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      button(`mb:seen:${letter.no}`, '👀 Đã xem', ButtonStyle.Secondary, letter.status !== 'new'),
      button(`mb:reply:${letter.no}`, '💬 Trả lời', ButtonStyle.Primary),
      button(`mb:done:${letter.no}`, '✔️ Xong', ButtonStyle.Success, letter.status === 'done')
    )
  );
  return v2Payload([container]);
}

// What the sender sees for their code: status + the managers' replies (names left out).
function buildReplyView(letter) {
  const lines = [`**📬 Thư #${letter.no} · ${categoryLine(letter.category)}**`, `Trạng thái: ${STATUS_LABELS[letter.status] || letter.status}`];
  const replies = letter.replies || [];
  if (!replies.length) lines.push('Quản lý chưa trả lời.');
  for (const r of replies) lines.push(`💬 Quản lý · ${discordTs(new Date(r.at), 'R')}: ${truncate(safeReply(r.text), 1000)}`);
  if (replies.length) lines.push(`-# ${LINK_WARNING}`);
  return { content: truncate(lines.join('\n'), 2000), allowedMentions: { parse: [] } };
}

module.exports = { LABELS, STATUS_LABELS, STATUS_COLORS, buildMailPanel, buildSendStep, buildSendModal, buildCodeModal, buildReplyModal, buildLetterCard, buildReplyView };
