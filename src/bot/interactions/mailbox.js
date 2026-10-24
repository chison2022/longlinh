// "📮 Hòm thư góp ý" (customIds mb:*, screens in ../ui/mailbox.js, storage + privacy rules in ../../services/mailService.js).
// Members: mb:open | mb:cat | mb:anon:<cat> | mb:named:<cat> | mb:sendModal:<a|n>:<cat> | mb:view | mb:codeModal   (not admin-gated)
// Managers (the letter card): mb:seen:<no> | mb:reply:<no> | mb:replyModal:<no> | mb:done:<no>                  (admin-gated)
// Nothing here may log or keep who sent an anonymous letter, nor WHEN: no mail.* event of the member side carries the user id or a letter
// number, the router writes no ix.done line at all for mb:*, and sends / views are only counted in memory (mailService.countDaily ->
// one mail.daily line per day).
const { MessageFlags } = require('discord.js');
const mail = require('../../services/mailService');
const { getConfigOrDefault } = require('../../services/guildConfigService');
const { isAdmin } = require('../permissions');
const { LABELS, buildSendStep, buildSendModal, buildCodeModal, buildReplyModal, buildLetterCard, buildReplyView } = require('../ui/mailbox');
const { v2Create } = require('../ui/common');
const { NO_PERMISSION, eph } = require('./common');
const { logEvent } = require('../../eventLog');

const NOT_READY = 'Hòm thư ẩn danh chưa được thiết lập, bạn chỉ gửi kèm tên được.';
const NO_INBOX = 'Hòm thư chưa được thiết lập (chưa có kênh nhận thư), hãy báo quản lý.';
const NO_LETTER = 'Thư không tồn tại.';
const NO_MENTIONS = { parse: [] };

// Where managers read the letters: the chosen inbox channel, else the admin channel.
const inboxOf = (config) => config.mailInboxChannelId || config.adminChannelId || null;
const limitKey = (interaction) => `${interaction.guildId}:${interaction.user.id}`;
const fromMessage = (interaction) => typeof interaction.isFromMessage === 'function' && interaction.isFromMessage();

// Modal submits opened from a message update it in place (the ephemeral send step); otherwise a new ephemeral reply.
async function ack(interaction) {
  if (fromMessage(interaction)) await interaction.deferUpdate();
  else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
}

const finish = (interaction, content) => interaction.editReply({ content, components: [], allowedMentions: NO_MENTIONS });

// ---------- member side ----------

async function onSend(interaction, parts) {
  // the limiter is charged BEFORE the first await (parallel submits cannot all pass the check) and refunded unless a letter was made
  const key = limitKey(interaction);
  const allowed = mail.sendLimit.allowed(key);
  if (allowed) mail.sendLimit.hit(key);
  let created = false;
  try {
    await ack(interaction);
    const anonymous = parts[2] === 'a';
    const category = mail.isCategory(parts[3]) ? parts[3] : 'other';
    const guildId = interaction.guildId;
    const config = await getConfigOrDefault(guildId);

    if ((config.mailBlocked || []).includes(interaction.user.id)) {
      mail.countDaily(guildId, 'blocked');
      return await finish(interaction, LABELS.blocked);
    }
    if (!allowed) {
      mail.countDaily(guildId, 'ratelimited');
      return await finish(interaction, '⏳ Bạn đã gửi đủ 3 thư trong 24 giờ qua, hãy thử lại sau.');
    }
    const inboxId = inboxOf(config);
    if (!inboxId) return await finish(interaction, NO_INBOX);
    const publicKey = anonymous ? mail.loadPublicKey() : null;
    if (anonymous && !publicKey) return await finish(interaction, NOT_READY);

    const title = interaction.fields.getTextInputValue('title').trim().slice(0, mail.TITLE_MAX);
    const content = interaction.fields.getTextInputValue('content').trim().slice(0, mail.CONTENT_MAX);
    if (!content) return await finish(interaction, 'Nội dung thư đang trống.');

    const { letter, code } = await mail.createLetter({
      guildId,
      category,
      title,
      content,
      anonymous,
      senderEnc: anonymous ? mail.encryptSender(publicKey, interaction.user.id, { guildId, title, content }) : null,
      senderId: anonymous ? null : interaction.user.id,
    });
    created = true;

    let posted = true;
    try {
      const channel = await interaction.client.channels.fetch(inboxId);
      const msg = await channel.send(v2Create(buildLetterCard(letter)));
      await mail.setInbox(guildId, letter.no, channel.id, msg.id);
    } catch {
      posted = false; // no per-letter console / event line: a timed failure would pair a time with a letter (counted in mail.daily)
    }
    mail.countDaily(guildId, posted ? 'sent' : 'postFailed');

    const lines = [`✅ Đã gửi thư #${letter.no}.`];
    lines.push(
      anonymous
        ? `Mã thư của bạn: **${mail.formatCode(code)}** — lưu lại để xem trả lời (bấm 📬 Xem trả lời). Mất mã thì không xem được.`
        : `Quản lý sẽ trả lời qua tin nhắn riêng.\nMã thư: **${mail.formatCode(code)}** — dùng cho 📬 Xem trả lời nếu không nhận được tin nhắn.`
    );
    if (!posted) lines.push('⚠️ Bot chưa đăng được thư vào kênh quản lý, hãy báo quản lý.');
    return await finish(interaction, lines.join('\n'));
  } finally {
    if (allowed && !created) mail.sendLimit.undo(key);
  }
}

async function onCode(interaction) {
  // wrong guesses are charged before the first await too; a found letter refunds it
  const key = limitKey(interaction);
  const allowed = mail.guessLimit.allowed(key);
  if (allowed) mail.guessLimit.hit(key);
  let wrong = false; // the charge stays only for a wrong code
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guildId = interaction.guildId;
    if (!allowed) {
      mail.countDaily(guildId, 'ratelimited');
      return await interaction.editReply({ content: '⏳ Bạn nhập sai mã quá nhiều lần, hãy thử lại sau 10 phút.', allowedMentions: NO_MENTIONS });
    }
    const letter = await mail.findByCode(guildId, interaction.fields.getTextInputValue('code'));
    if (!letter) {
      wrong = true;
      mail.countDaily(guildId, 'badCode');
      return await interaction.editReply({ content: 'Không tìm thấy thư với mã này.', allowedMentions: NO_MENTIONS });
    }
    mail.countDaily(guildId, 'viewed');
    return await interaction.editReply(buildReplyView(letter));
  } finally {
    if (allowed && !wrong) mail.guessLimit.undo(key);
  }
}

// ---------- manager side ----------

async function onStatus(interaction, no, status) {
  await interaction.deferUpdate();
  const guildId = interaction.guildId;
  const changed = await mail.setStatus(guildId, no, status);
  const letter = changed || (await mail.getLetter(guildId, no)); // "seen" on a letter that is no longer new changes nothing: just redraw
  if (!letter) return interaction.followUp(eph(NO_LETTER));
  if (changed) logEvent('mail', 'status', { guild: guildId, no, status, by: interaction.user.id });
  return interaction.editReply(buildLetterCard(letter));
}

async function dmReply(client, letter, text) {
  if (letter.anonymous || !letter.senderId) return 'none'; // an anonymous sender is unknown to the bot: they read it by code
  try {
    const user = await client.users.fetch(letter.senderId);
    await user.send({ content: `📬 Quản lý đã trả lời thư #${letter.no} của bạn:\n${mail.safeReply(text)}\n-# ${mail.LINK_WARNING}`, allowedMentions: NO_MENTIONS });
    return 'sent';
  } catch {
    return 'failed'; // DMs closed: the reply is still viewable by code
  }
}

async function onReplySubmit(interaction, no) {
  await ack(interaction);
  const guildId = interaction.guildId;
  const text = interaction.fields.getTextInputValue('text').trim().slice(0, mail.CONTENT_MAX);
  if (!text) return interaction.followUp(eph('Nội dung trả lời đang trống.'));
  const letter = await mail.addReply(guildId, no, { by: interaction.user.id, text });
  if (!letter) return interaction.followUp(eph(NO_LETTER));
  const dm = await dmReply(interaction.client, letter, text);
  logEvent('mail', 'reply', { guild: guildId, no, by: interaction.user.id, dm });
  if (fromMessage(interaction)) await interaction.editReply(buildLetterCard(letter));
  const note = { none: 'Người gửi ẩn danh xem trả lời bằng mã thư.', sent: 'Đã nhắn riêng cho người gửi.', failed: '⚠️ Không nhắn riêng được cho người gửi (đóng tin nhắn riêng). Họ vẫn xem được bằng mã thư.' }[dm];
  return interaction.followUp(eph(`✅ Đã lưu trả lời thư #${no}. ${note}`));
}

const toNo = (text) => (/^\d{1,9}$/.test(String(text)) ? Number(text) : null);

async function handle(interaction, parts) {
  const action = parts[1];
  const managerAction = action === 'seen' || action === 'done' || action === 'reply' || action === 'replyModal';
  if (managerAction) {
    const config = await getConfigOrDefault(interaction.guildId);
    // the card stays untouched: only the clicker is told
    if (!isAdmin(interaction.member, config, interaction.memberPermissions)) return interaction.reply(eph(NO_PERMISSION));
    const no = toNo(parts[2]);
    if (no === null) return interaction.reply(eph(NO_LETTER));
    if (action === 'seen') return onStatus(interaction, no, 'seen');
    if (action === 'done') return onStatus(interaction, no, 'done');
    if (action === 'reply') return interaction.showModal(buildReplyModal(no));
    return onReplySubmit(interaction, no);
  }

  switch (action) {
    case 'open':
      return interaction.reply({ ...buildSendStep({ ready: mail.mailboxReady() }), flags: MessageFlags.Ephemeral });
    case 'cat':
      await interaction.deferUpdate();
      return interaction.editReply(buildSendStep({ category: (interaction.values || [])[0], ready: mail.mailboxReady() }));
    case 'anon':
    case 'named': {
      const category = mail.isCategory(parts[2]) ? parts[2] : null;
      if (!category) return interaction.reply(eph('Hãy chọn loại ý kiến trước.'));
      if (action === 'anon' && !mail.mailboxReady()) return interaction.reply(eph(NOT_READY));
      return interaction.showModal(buildSendModal(category, action === 'anon'));
    }
    case 'sendModal':
      return onSend(interaction, parts);
    case 'view':
      return interaction.showModal(buildCodeModal());
    case 'codeModal':
      return onCode(interaction);
    default:
      return undefined;
  }
}

module.exports = { handle, inboxOf };
