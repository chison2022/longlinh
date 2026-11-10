// New-member gate views (pure: no Discord client, no DB). customIds (prefix gate, stateless):
//  public panel : gate:member
//  member steps : gate:pick:<page>:<ver> (select) | gate:p:<page>:<ver> (◀ ▶) | gate:free (modal gate:freeModal) | gate:cls:<token> (class select)
//                 | gate:send:<token>:<classIndex> (opens the ID modal gate:sendModal:<token>:<classIndex>, the real send) | gate:back
//  approval card: gate:ok:<id> | gate:no:<id> (modal gate:noModal:<id>)      (admin-gated)
//  guest (only while config.guestRoleId is set; self-serve, nobody approves): gate:gst (panel button) -> confirm step: gate:gyes | gate:gback
//  auto-approved card (a roster name): gate:rv:<id> (modal gate:rvModal:<id>) = take the membership back      (admin-gated)
// <token> = the chosen character: `r<position in the roster>-<roster version>` or `f-<typed name>`.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, StringSelectMenuBuilder, ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle, escapeMarkdown } = require('discord.js');
const { truncate, textDisplay, separator, v2Payload } = require('./common');
const { rosterSelect, LABELS: GN } = require('./gameName');
const { styleOf, optionEmoji } = require('../classStyle');
const { plainClass } = require('../../services/lineupStyle');
const { discordTs } = require('../../utils/time');

const BLUE = 0x1e3a8a;
const ORANGE = 0xe67e22;
const GREEN = 0x2ecc71;
const RED = 0xe74c3c;
const GREY = 0x95a5a6;
const ZWSP = '​';

const LABELS = {
  member: '⚔️ Thành viên bang',
  send: '📨 Gửi yêu cầu',
  back: '↩ Chọn lại',
  changeClass: '🎭 Đổi phái',
  ok: '✅ Duyệt',
  no: '❌ Từ chối',
  revoke: '↩️ Thu hồi',
  free: GN.free,
  guest: '🤝 Khách',
  guestYes: '✅ Vào làm khách',
  guestBack: '↩ Quay lại',
};

const button = (id, label, style = ButtonStyle.Secondary, disabled = false) => new ButtonBuilder().setCustomId(id).setLabel(truncate(label, 80)).setStyle(style).setDisabled(disabled);
const ephemeral = (content, components = []) => ({ content: truncate(content, 2000), components, allowedMentions: { parse: [] } });

// User text inside a message: no markdown, no look-alike mention.
const safe = (s, max = 60) => escapeMarkdown(truncate(String(s || ''), max)).replace(/<(?=[@#])/g, `<${ZWSP}`).replace(/@(?=everyone|here)/gi, `@${ZWSP}`);

// ---------- the public panel ----------

// autoApprove: a name from the game roster gets in at once; else every request waits for a manager.
// guest: the 🤝 Khách button next to the member one (only while a guest role is configured).
function buildGatePanel({ guildName, autoApprove = true, guest = false }) {
  const buttons = [button('gate:member', `${LABELS.member} ${guildName}`, ButtonStyle.Primary)];
  if (guest) buttons.push(button('gate:gst', LABELS.guest, ButtonStyle.Secondary));
  const container = new ContainerBuilder()
    .setAccentColor(BLUE)
    .addTextDisplayComponents(textDisplay(`### 👋 Chào mừng đến ${truncate(guildName, 100)}!\nBấm nút bên dưới để xin vào bang.`))
    .addActionRowComponents(new ActionRowBuilder().addComponents(...buttons))
    .addTextDisplayComponents(textDisplay(autoApprove ? '-# Chọn đúng nhân vật có trong danh sách game là vào bang ngay; tên không có trong danh sách thì chờ quản lý duyệt.' : '-# Thành viên bang cần quản lý duyệt trước khi thấy các kênh của bang.'));
  if (guest) container.addTextDisplayComponents(textDisplay('-# Không chơi trong bang (bạn bè, khách)? Bấm Khách để vào server ngay, không cần duyệt.'));
  return v2Payload([container]);
}

// ---------- the member steps (ephemeral) ----------

// token <-> choice. r<index>-<ver> = a roster entry; f-<name> = typed by hand.
const rosterToken = (index, ver) => `r${index}-${ver}`;
const freeToken = (name) => `f-${name}`;
function parseToken(token) {
  const t = String(token || '');
  if (t.startsWith('f-')) return t.length > 2 ? { free: true, name: t.slice(2) } : null;
  const m = /^r(\d+)-([0-9a-zA-Z]+)$/.exec(t);
  return m ? { free: false, index: Number(m[1]), ver: m[2] } : null;
}

// Step 1: pick the character. ranked/hasRoster as in the gn picker (same ranking, 25 per page).
function buildGatePicker({ ranked = [], page = 0, ver = '0', hasRoster = true, note = null } = {}) {
  const lines = ['**🚪 Xin vào bang (1/3): chọn nhân vật trong game**'];
  if (note) lines.push(note);
  const rows = [];
  let nav = [];
  if (!hasRoster) {
    lines.push('Quản lý chưa nhập danh sách thành viên game — bạn tự nhập tên nhân vật.');
  } else if (!ranked.length) {
    lines.push('Không còn tên nào trong danh sách game để chọn (đã có người liên kết) — bấm “Tên tôi không có trong danh sách” để nhập tay.');
  } else {
    const sel = rosterSelect(ranked, page, ver, 'gate');
    lines.push(sel.line);
    rows.push(sel.row);
    nav = sel.nav;
  }
  rows.push(new ActionRowBuilder().addComponents(...nav, button('gate:free', LABELS.free)));
  return ephemeral(lines.join('\n'), rows);
}

function freeNameModal() {
  return new ModalBuilder()
    .setCustomId('gate:freeModal')
    .setTitle('Nhập tên nhân vật')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Tên nhân vật trong game')
        .setDescription('Gõ đúng như trong game (chữ Latin / tiếng Việt, số). Quản lý sẽ kiểm tra lại.')
        .setTextInputComponent(new TextInputBuilder().setCustomId('name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(32))
    );
}

// Step 2: pick the class. classes = config.classes; styles = Map from stylesOf (emoji per class); noEmoji drops the option emojis.
function buildClassStep({ token, name, free, classes, styles, noEmoji = false, note = null }) {
  const lines = ['**🚪 Xin vào bang (2/3): chọn phái**', `🎮 Nhân vật: **${safe(name, 40)}**${free ? ' (tự nhập, quản lý sẽ kiểm tra)' : ''}`];
  if (note) lines.push(note);
  const select = new StringSelectMenuBuilder()
    .setCustomId(`gate:cls:${token}`)
    .setPlaceholder('Chọn phái của bạn…')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      classes.slice(0, 25).map((c, i) => {
        const emoji = noEmoji ? undefined : optionEmoji(styleOf(styles, c));
        return { label: truncate(plainClass(c) || c, 100), value: String(i), ...(emoji ? { emoji } : {}) };
      })
    );
  return ephemeral(lines.join('\n'), [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(button('gate:back', LABELS.back))]);
}

// Step 3: summary + send.
// fromRoster: the class came from the game roster (step 2 skipped) -> a note + a "change class" button back to step 2.
// instant: sending gets the member in right away (a roster name with the auto-approval on).
function buildSummary({ token, classIndex, name, free, className, styles, fromRoster = false, instant = false, note = null }) {
  const st = styleOf(styles, className);
  const lines = [
    '**🚪 Xin vào bang (3/3): kiểm tra rồi gửi**',
    `🎮 Nhân vật: **${safe(name, 40)}**${free ? ' (tự nhập, quản lý sẽ kiểm tra)' : ''}`,
    `🧙 Phái: ${st.emojiText} ${safe(plainClass(className) || className, 40)}${fromRoster ? ' (theo danh sách game; sai thì bấm Đổi phái)' : ''}`,
    instant ? 'Bấm Gửi yêu cầu, nhập ID nhân vật trong game là vào bang ngay (tên có trong danh sách game).' : 'Bấm Gửi yêu cầu và nhập ID nhân vật trong game. Quản lý sẽ duyệt; bạn nhận tin nhắn riêng khi được vào.',
  ];
  if (note) lines.push(note);
  const buttons = [button(`gate:send:${token}:${classIndex}`, LABELS.send, ButtonStyle.Success)];
  if (fromRoster) buttons.push(button(`gate:chc:${token}`, LABELS.changeClass));
  buttons.push(button('gate:back', LABELS.back));
  return ephemeral(lines.join('\n'), [new ActionRowBuilder().addComponents(...buttons)]);
}

// The send button's form: the in-game ID (required). Longest customId: gate:sendModal:f-<32 chars>:<2 digits> = 52 chars.
function sendModal(token, classIndex) {
  return new ModalBuilder()
    .setCustomId(`gate:sendModal:${token}:${classIndex}`)
    .setTitle('Gửi yêu cầu vào bang')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('ID nhân vật trong game')
        .setDescription('Chỉ chữ số, 5 đến 20 số (xem trong game, mục thông tin nhân vật).')
        .setTextInputComponent(new TextInputBuilder().setCustomId('uid').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20))
    );
}

// The member already has a pending request (a second click): its status.
function buildPendingNotice(request) {
  const lines = [`⏳ Yêu cầu vào bang của bạn đang **chờ quản lý duyệt** (nhân vật **${safe(request.gameName, 40)}**${request.className ? `, phái ${safe(plainClass(request.className) || request.className, 40)}` : ''}).`, 'Bạn sẽ nhận tin nhắn riêng khi được duyệt.'];
  return ephemeral(lines.join('\n'));
}

// ---------- the guest path (self-serve) ----------

// Confirm step of 🤝 Khách (ephemeral): the role is given only after ✅ Vào làm khách.
function buildGuestConfirm() {
  return ephemeral(
    'Bạn sẽ vào server với vai trò **khách** (không phải thành viên bang). Thành viên bang thì bấm ⚔️ Thành viên bang.',
    [new ActionRowBuilder().addComponents(button('gate:gyes', LABELS.guestYes, ButtonStyle.Success), button('gate:gback', LABELS.guestBack))]
  );
}

// ---------- the approval card (admin channel) ----------

const ALERT_PREFIX = '🔔 Lần xử lý gần nhất: ';

// texts -> V2 payload. buttons=true adds the two admin buttons for `requestId`.
function cardPayload({ texts, accent, requestId = null, buttons = false }) {
  const container = new ContainerBuilder().setAccentColor(accent);
  texts.forEach((t, i) => {
    if (i) container.addSeparatorComponents(separator());
    container.addTextDisplayComponents(textDisplay(t));
  });
  if (buttons && requestId) {
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        button(`gate:ok:${requestId}`, LABELS.ok, ButtonStyle.Success),
        button(`gate:no:${requestId}`, LABELS.no, ButtonStyle.Danger)
      )
    );
  }
  return v2Payload([container]);
}

// info: { member: { id, displayName, createdAt: Date, joinedAt: Date|null }, game: { entry|null }, classText, warnings: [string] }
// request: the GateRequest. -> the texts of the card (also what the decided card is rebuilt from).
function approvalTexts({ request, member, entry = null, classText, warnings = [] }) {
  const who = [`Discord: **${safe(member.displayName || request.displayName, 40)}**`, `tài khoản tạo ${discordTs(member.createdAt, 'R')}`];
  if (member.joinedAt) who.push(`vào server ${discordTs(member.joinedAt, 'R')}`);
  const game = [`🎮 Tên game: **${safe(request.gameName, 40)}**${request.gameNameFree ? ' (tự nhập)' : ''}`];
  if (entry) {
    game.push(`✅ có trong danh sách game mới nhất${entry.rank ? ` · cấp bậc ${safe(entry.rank, 30)}` : ''}`);
  } else {
    game.push('⚠️ không có trong danh sách game mới nhất');
  }
  const main = ['### 🚪 Yêu cầu vào bang', `<@${request.discordId}> (${who.join(', ')})`, game.join(' · '), `🧙 Phái: ${classText}`, ...(request.gameUid ? [`🆔 ID game: ${request.gameUid}`] : [])].join('\n');
  const out = [main];
  if (warnings.length) out.push(warnings.join('\n'));
  return out;
}

// The info card managers get when somebody took the guest role themselves (no buttons: nothing to decide).
// member: { id, displayName, createdAt: Date, joinedAt: Date|null }
function buildGuestJoinedCard({ member, warnings = [] }) {
  const who = [`Discord: **${safe(member.displayName, 40)}**`, `tài khoản tạo ${discordTs(member.createdAt, 'R')}`];
  if (member.joinedAt) who.push(`vào server ${discordTs(member.joinedAt, 'R')}`);
  return cardPayload({ texts: [`🤝 <@${member.id}> đã tự vào làm khách (${who.join(', ')})`, ...(warnings.length ? [warnings.join('\n')] : [])], accent: GREEN });
}

function buildApprovalCard(info) {
  return cardPayload({ texts: approvalTexts(info), accent: ORANGE, requestId: info.request._id, buttons: true });
}

// Same card with an alert line (a role could not be changed: the request stays pending, the buttons stay).
function buildAlertCard({ texts, requestId, alert }) {
  return cardPayload({ texts: [...texts.filter((t) => !t.startsWith(ALERT_PREFIX)), `${ALERT_PREFIX}${alert}`], accent: ORANGE, requestId, buttons: true });
}

const AUTO_LINE = (at) => `🤖 Bot tự duyệt ${discordTs(at, 'R')} (tên có trong danh sách game, chưa ai giữ). Sai người thì bấm ${LABELS.revoke}.`;

// A roster name was approved by the bot itself: green, the notes, one admin button to take it back.
function buildAutoApprovedCard({ texts, requestId, at = new Date(), notes = [] }) {
  const body = texts.filter((t) => !t.startsWith(ALERT_PREFIX));
  const container = new ContainerBuilder().setAccentColor(GREEN);
  [...body, [AUTO_LINE(at), ...notes].join('\n')].forEach((t, i) => {
    if (i) container.addSeparatorComponents(separator());
    container.addTextDisplayComponents(textDisplay(t));
  });
  container.addActionRowComponents(new ActionRowBuilder().addComponents(button(`gate:rv:${requestId}`, LABELS.revoke, ButtonStyle.Danger)));
  return v2Payload([container]);
}

// Revoke modal: optional reason (sent to the member when given). Also the confirmation step.
function revokeModal(requestId) {
  return new ModalBuilder()
    .setCustomId(`gate:rvModal:${requestId}`)
    .setTitle('Thu hồi: gỡ role thành viên')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Lý do (không bắt buộc)')
        .setDescription('Bot gỡ role thành viên + role phái đã cấp. Nếu nhập lý do, bot nhắn riêng cho người đó.')
        .setTextInputComponent(new TextInputBuilder().setCustomId('reason').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500))
    );
}

const DECIDED = {
  approved: { accent: GREEN, line: ({ by, at }) => `✅ <@${by}> đã duyệt ${discordTs(at, 'R')}` },
  revoked: { accent: RED, line: ({ by, at, reason }) => `↩️ <@${by}> đã thu hồi ${discordTs(at, 'R')} (gỡ role thành viên)${reason ? `\nLý do: ${safe(reason, 200)}` : ''}` },
  rejected: { accent: RED, line: ({ by, at, reason }) => `❌ <@${by}> đã từ chối ${discordTs(at, 'R')}${reason ? `\nLý do: ${safe(reason, 200)}` : ''}` },
  cancelled: { accent: GREY, line: ({ text, at }) => `🚫 ${text} ${discordTs(at, 'R')}` },
};

// The card after a decision: the original texts, grey/green/red, no buttons, who and when (+ notes: a role that could not be removed...).
function buildDecidedCard({ texts, kind, by = null, at = new Date(), reason = '', text = '', notes = [] }) {
  const d = DECIDED[kind] || DECIDED.cancelled;
  const body = texts.filter((t) => !t.startsWith(ALERT_PREFIX));
  const last = [d.line({ by, at, reason, text }), ...notes].join('\n');
  return cardPayload({ texts: [...body, last], accent: d.accent });
}

// Reject modal: optional reason.
function rejectModal(requestId) {
  return new ModalBuilder()
    .setCustomId(`gate:noModal:${requestId}`)
    .setTitle('Từ chối yêu cầu')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Lý do (không bắt buộc)')
        .setDescription('Nếu nhập, bot gửi lý do này cho người xin vào qua tin nhắn riêng.')
        .setTextInputComponent(new TextInputBuilder().setCustomId('reason').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500))
    );
}

module.exports = {
  LABELS,
  safe,
  rosterToken,
  freeToken,
  parseToken,
  ephemeral,
  buildGatePanel,
  buildGatePicker,
  freeNameModal,
  buildClassStep,
  buildSummary,
  sendModal,
  buildPendingNotice,
  approvalTexts,
  buildApprovalCard,
  buildGuestConfirm,
  buildGuestJoinedCard,
  buildAlertCard,
  buildDecidedCard,
  buildAutoApprovedCard,
  rejectModal,
  revokeModal,
};
