const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  ChannelType,
  ContainerBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const { STATUS_LABELS } = require('../../services/warService');
const { discordTs } = require('../../utils/time');
const { truncate, textDisplay, separator, v2Payload } = require('./common');
const { missingLine } = require('../eventStats');
const { headcountLines } = require('../../services/headcountService');
const { isOn, FEATURES, enabledLine } = require('../../services/features');

const PANEL_COLOR = 0x9b59b6;

const button = (id, label, style = ButtonStyle.Secondary, disabled = false) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);

// The "📊 Sheet" line of the dashboard: not connected / last error / last successful sync / connected but not synced yet.
function sheetLine(sheet) {
  if (!sheet || !sheet.configured) return '📊 Sheet: chưa nối';
  if (sheet.error) return `📊 Sheet: lỗi: ${truncate(String(sheet.error).replace(/\s+/g, ' '), 120)}`;
  if (sheet.at) return `📊 Sheet: đồng bộ ${discordTs(new Date(sheet.at), 'R')}`;
  return '📊 Sheet: chưa đồng bộ';
}

// The admin dashboard: ONE live Components V2 message (refreshed by bot/refresher.js).
// `event` = the current war event or null; `stats` = eventStats() of it; `game` = { count, at } of the last in-game roster import;
// `roleEmpty` = the member role is set but nobody holds it (the member cache is complete): the "⏳ chưa đăng ký" count is left out and this is said instead.
// `headcount` = { official, apprentice } of the latest game roster (null without a roster: no quân số line); `rosterTarget` = the wanted number of official members.
// The customIds are the same as the first (embed) dashboard had, so an old dashboard keeps working until it is redrawn.
// `sheet` = { configured, at?, error? } : the Google Sheet the bot feeds, its last successful sync and last failure (memory of this process).
function buildPanel({ event = null, stats = null, game = null, roleEmpty = false, sheet = null, headcount = null, rosterTarget, config = null } = {}) {
  const lines = [];
  if (event && stats) {
    const deadline = event.status === 'open' ? ` · chốt ${discordTs(new Date(event.deadlineAt), 'R')}` : '';
    lines.push(`⚔️ **${truncate(event.title, 150)}** · ${STATUS_LABELS[event.status] || event.status}${deadline}`);
    lines.push(
      `✅ ${stats.join}/${stats.capacity} · ❌ ${stats.absent}${stats.unregistered === null ? '' : ` · ⏳ ${stats.unregistered}`}`
    );
    lines.push(...stats.missing.map(missingLine));
  } else {
    lines.push('⚔️ Chưa có bang chiến tuần này');
  }
  const has = Boolean(event);
  const locked = has && event.status === 'locked';
  const canLock = has && (event.status === 'open' || event.status === 'locked');
  const canPublish = has && event.status !== 'done';
  const member = ['👥 **Thành viên**'];
  if (roleEmpty) member.push('⚠️ Role thành viên chưa có ai');
  if (game) member.push(`🎮 Game: ${game.count} người · cập nhật ${discordTs(new Date(game.at), 'R')}`);
  member.push(...headcountLines(headcount, rosterTarget));
  member.push(sheetLine(sheet));

  const container = new ContainerBuilder()
    .setAccentColor(PANEL_COLOR)
    .addTextDisplayComponents(textDisplay('### 🏯 Bảng điều khiển'), textDisplay(lines.join('\n')))
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        button('adm:create', '⚔️ Tạo bang chiến', ButtonStyle.Primary),
        locked ? button('adm:lock', '🟢 Mở lại', ButtonStyle.Success) : button('adm:lock', '🔒 Chốt', ButtonStyle.Secondary, !canLock),
        button(has ? `tm:pub:${event._id}` : 'tm:pub', '📢 Công bố', ButtonStyle.Primary, !canPublish)
      )
    )
    .addSeparatorComponents(separator())
    .addTextDisplayComponents(textDisplay(member.join('\n')))
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        button('adm:unreg', '👥 Chưa đăng ký'),
        button('adm:game', '🎮 Thành viên game'),
        button('adm:sheet', '📊 Google Sheet')
      )
    )
    .addActionRowComponents(new ActionRowBuilder().addComponents(button('adm:settings', '⚙️ Cài đặt'), button('adm:offcfg', '⚙️ Ngưỡng')))
    .addTextDisplayComponents(textDisplay('-# Chỉ quản lý dùng được các nút này.'));
  return v2Payload([container]);
}

// Permissions the bot needs in the announce / admin channel, with their Vietnamese names.
const CHANNEL_PERMISSIONS = [
  ['ViewChannel', 'Xem kênh'],
  ['SendMessages', 'Gửi tin nhắn'],
  ['EmbedLinks', 'Nhúng liên kết'],
  ['AttachFiles', 'Đính kèm tệp'],
];

// Names of the CHANNEL_PERMISSIONS the bot lacks in `channel`; null when the channel is unknown.
function missingPermissions(guild, channel) {
  if (!channel || !guild || !guild.members || !guild.members.me || typeof channel.permissionsFor !== 'function') return null;
  const perms = channel.permissionsFor(guild.members.me);
  if (!perms) return null;
  return CHANNEL_PERMISSIONS.filter(([flag]) => !perms.has(PermissionFlagsBits[flag])).map(([, name]) => name);
}

function channelLine(label, id, guild) {
  if (!id) return `⚠️ ${label}: _chưa chọn_`;
  const channel = guild && guild.channels && guild.channels.cache ? guild.channels.cache.get(id) : null;
  if (guild && !channel) return `⚠️ ${label}: <#${id}> — bot không thấy kênh này`;
  const missing = missingPermissions(guild, channel);
  if (missing && missing.length) return `⚠️ ${label}: <#${id}> — bot thiếu quyền: ${missing.join(', ')}`;
  return `✅ ${label}: <#${id}>`;
}

// Ephemeral /setup view; selects show current values. `ctx` = { guild?, memberCount?, moveEvent? }:
//  - guild: the bot's permissions in the announce / admin channel are checked (when given),
//  - memberCount: members with the member role (only when the member cache is known to be complete),
//  - botRoleIds: the chosen manager roles that belong to a bot / integration (nobody can hold them like a normal role),
//  - moveEvent: an open/locked event whose message sits in another channel -> a "Chuyển bài" button.
// The second /setup screen (ctx.view === 'gn'): where the member panel "🎮 Liên kết tên trong game" goes.
function buildGnSetupView(config, note, ctx = {}) {
  const chan = new ChannelSelectMenuBuilder()
    .setCustomId('setup:gnchan')
    .setPlaceholder('Kênh liên kết tên trong game')
    .setChannelTypes(ChannelType.GuildText);
  if (config.gnChannelId) chan.setDefaultChannels(config.gnChannelId);
  const lines = [
    '**🎮 Bảng liên kết tên trong game**',
    'Thành viên tự chọn nhân vật của mình trong game ở bảng này (dùng lúc nào cũng được).',
    config.gnChannelId ? channelLine('Kênh', config.gnChannelId, ctx.guild) : '⚠️ Kênh: _chưa chọn_',
    config.gnPanelMessageId ? '✅ Bảng đã đăng. Bấm nút bên dưới để làm mới (hoặc đăng lại nếu bị xoá).' : 'Chưa đăng bảng.',
  ];
  if (note) lines.push('', note);
  return {
    content: lines.join('\n'),
    allowedMentions: { parse: [] },
    components: [
      new ActionRowBuilder().addComponents(chan),
      new ActionRowBuilder().addComponents(button('setup:gnpost', '📌 Đăng / làm mới bảng liên kết tên', ButtonStyle.Success, !config.gnChannelId), button('setup:main', '↩ Quay lại')),
    ],
  };
}

// The third /setup screen (ctx.view === 'mb'): the "📮 Hòm thư góp ý" panel channel and the inbox channel where managers read the letters.
// ctx.mailReady = the owner's public key is installed (anonymous letters possible).
function buildMailSetupView(config, note, ctx = {}) {
  const inboxId = config.mailInboxChannelId || config.adminChannelId;
  const chan = new ChannelSelectMenuBuilder().setCustomId('setup:mbchan').setPlaceholder('Kênh đặt bảng hòm thư (thành viên thấy nút gửi)').setChannelTypes(ChannelType.GuildText);
  if (config.mailChannelId) chan.setDefaultChannels(config.mailChannelId);
  const inbox = new ChannelSelectMenuBuilder().setCustomId('setup:mbinbox').setPlaceholder('Kênh nhận thư (quản lý đọc), mặc định = kênh admin').setChannelTypes(ChannelType.GuildText);
  if (inboxId) inbox.setDefaultChannels(inboxId);
  const lines = [
    '**📮 Hòm thư góp ý**',
    'Thành viên gửi góp ý (có thể ẩn danh) từ bảng này; thư hiện ở kênh nhận thư để quản lý xem và trả lời.',
    config.mailChannelId ? channelLine('Kênh bảng', config.mailChannelId, ctx.guild) : '⚠️ Kênh bảng: _chưa chọn_',
    inboxId ? channelLine(`Kênh nhận thư${config.mailInboxChannelId ? '' : ' (= kênh admin)'}`, inboxId, ctx.guild) : '⚠️ Kênh nhận thư: _chưa chọn_ (và chưa có kênh admin)',
    ctx.mailReady ? `🔑 Thư ẩn danh: sẵn sàng${ctx.mailFingerprint ? ` · dấu vân tay khoá: \`${ctx.mailFingerprint}\` (so với lúc chạy mail:keygen)` : ''}` : '⚠️ Thư ẩn danh: chưa bật (chưa có config/mailbox-public.pem, chủ bot chạy `npm run mail:keygen`). Gửi kèm tên vẫn dùng được.',
    config.mailPanelMessageId ? '✅ Bảng đã đăng. Bấm nút bên dưới để làm mới (hoặc đăng lại nếu bị xoá).' : 'Chưa đăng bảng.',
  ];
  if (note) lines.push('', note);
  return {
    content: lines.join('\n'),
    allowedMentions: { parse: [] },
    components: [
      new ActionRowBuilder().addComponents(chan),
      new ActionRowBuilder().addComponents(inbox),
      new ActionRowBuilder().addComponents(button('setup:mbpost', '📌 Đăng / làm mới bảng hòm thư', ButtonStyle.Success, !config.mailChannelId || !inboxId), button('setup:main', '↩ Quay lại')),
    ],
  };
}

// The fourth /setup screen (ctx.view === 'ev'): where new event cards go, and where managers handle events (the shortfall notice and the persistent panel).
// An unset channel falls back to the war channels, and the line says so.
function buildEventSetupView(config, note, ctx = {}) {
  const cardId = config.eventChannelId || config.announceChannelId;
  const adminId = config.eventAdminChannelId || config.adminChannelId;
  const chan = new ChannelSelectMenuBuilder().setCustomId('setup:evchan').setPlaceholder('Kênh thông báo sự kiện (thẻ sự kiện đăng ở đây)').setChannelTypes(ChannelType.GuildText);
  if (config.eventChannelId) chan.setDefaultChannels(config.eventChannelId);
  const admin = new ChannelSelectMenuBuilder().setCustomId('setup:evadmin').setPlaceholder('Kênh quản lý sự kiện (bảng quản lý, tin thiếu người)').setChannelTypes(ChannelType.GuildText);
  if (config.eventAdminChannelId) admin.setDefaultChannels(config.eventAdminChannelId);
  const lines = [
    '**🎉 Sự kiện**',
    'Thẻ sự kiện đăng ở kênh thông báo sự kiện; quản lý tạo / sửa sự kiện bằng bảng cố định ở kênh quản lý sự kiện. Chỉ quản lý dùng được bảng.',
    cardId ? channelLine(`Kênh thông báo sự kiện${config.eventChannelId ? '' : ' (mặc định: kênh thông báo bang chiến)'}`, cardId, ctx.guild) : '⚠️ Kênh thông báo sự kiện: _chưa chọn_ (và chưa có kênh thông báo bang chiến)',
    adminId ? channelLine(`Kênh quản lý sự kiện${config.eventAdminChannelId ? '' : ' (mặc định: kênh admin)'}`, adminId, ctx.guild) : '⚠️ Kênh quản lý sự kiện: _chưa chọn_ (và chưa có kênh admin)',
    config.eventPanelMessageId ? '✅ Bảng quản lý đã đăng. Bấm nút bên dưới để làm mới (hoặc đăng lại nếu bị xoá).' : 'Chưa đăng bảng quản lý.',
    config.eventDocId
      ? `📄 Google Doc: [mở Doc](https://docs.google.com/document/d/${config.eventDocId}/edit) · bot tự ghi lại sau mỗi thay đổi (~1 phút)${ctx.docStatus && ctx.docStatus.error ? `
⚠️ Lần ghi gần nhất lỗi: ${ctx.docStatus.error}` : ctx.docStatus && ctx.docStatus.at ? ` · lần cuối ${discordTs(ctx.docStatus.at, 'R')}` : ''}`
      : '📄 Google Doc: _chưa nối_ (bấm 📄 Google Doc để dán link)',
  ];
  if (note) lines.push('', note);
  return {
    content: lines.join('\n'),
    allowedMentions: { parse: [] },
    components: [
      new ActionRowBuilder().addComponents(chan),
      new ActionRowBuilder().addComponents(admin),
      new ActionRowBuilder().addComponents(button('setup:evpost', '📌 Đăng / làm mới bảng quản lý sự kiện', ButtonStyle.Success, !adminId), button('setup:evdoc', '📄 Google Doc'), button('setup:main', '↩ Quay lại')),
    ],
  };
}

// The fifth /setup screen (ctx.view === 'gate'): the new-member gate. ctx.health = gateHealth(config, guild) lines [{ ok, text }].
function buildGateSetupView(config, note, ctx = {}) {
  const gateChan = new ChannelSelectMenuBuilder().setCustomId('setup:gatechan').setPlaceholder('Kênh cổng vào (người mới chỉ thấy kênh này)').setChannelTypes(ChannelType.GuildText);
  if (config.gateChannelId) gateChan.setDefaultChannels(config.gateChannelId);
  const adminId = config.gateAdminChannelId || config.adminChannelId;
  const admin = new ChannelSelectMenuBuilder().setCustomId('setup:gateadmin').setPlaceholder('Kênh nhận yêu cầu vào bang (mặc định = kênh admin)').setChannelTypes(ChannelType.GuildText);
  if (config.gateAdminChannelId) admin.setDefaultChannels(config.gateAdminChannelId);
  else if (config.adminChannelId) admin.setDefaultChannels(config.adminChannelId);
  const stranger = new RoleSelectMenuBuilder().setCustomId('setup:gatestranger').setPlaceholder('Role người lạ (gán khi vào server, gỡ khi được duyệt) — để trống = không dùng').setMinValues(0).setMaxValues(1);
  if (config.strangerRoleId) stranger.setDefaultRoles(config.strangerRoleId);
  const guest = new RoleSelectMenuBuilder().setCustomId('setup:gateguestrole').setPlaceholder('Role khách (người bấm 🤝 Khách tự nhận) — để trống = không có nút Khách').setMinValues(0).setMaxValues(1);
  if (config.guestRoleId) guest.setDefaultRoles(config.guestRoleId);
  const lines = [
    '**🚪 Cổng vào người mới**',
    'Người mới chỉ thấy kênh cổng vào (bạn tự chỉnh quyền kênh, bot không đụng). Bấm ⚔️ Thành viên bang → nhập tên nhân vật: tên có trong danh sách game thì bot tự duyệt (cấp role thành viên + role phái, quản lý nhận thẻ có nút ↩️ Thu hồi); tên tự gõ thì chờ quản lý duyệt.',
    config.guestRoleId ? `🤝 Nút Khách: **BẬT** (ai bấm cũng tự nhận role <@&${config.guestRoleId}>, không cần duyệt). Bấm 📌 để bảng cổng vào hiện nút.` : '🤝 Nút Khách: **TẮT** (chọn role khách bên dưới để bật)',
    config.gateAutoApprove !== false ? '🤖 Tự duyệt: **BẬT** (tên có trong danh sách game vào ngay)' : '✋ Tự duyệt: **TẮT** (mọi yêu cầu chờ quản lý duyệt)',
    isOn(config, 'gate') ? '🟢 Cổng đang **BẬT**' : '⚪ Cổng đang **TẮT** (bảng vẫn dùng được khi đã đăng, nhưng nút báo cổng đang tắt; bật lại ở 🧩 Tính năng)',
    config.gateChannelId ? channelLine('Kênh cổng vào', config.gateChannelId, ctx.guild) : '⚠️ Kênh cổng vào: _chưa chọn_',
    adminId ? `✅ Kênh nhận yêu cầu: <#${adminId}>${config.gateAdminChannelId ? '' : ' (= kênh admin)'}` : '⚠️ Kênh nhận yêu cầu: _chưa chọn_ (và chưa có kênh admin)',
    `✏️ Lời chào: thành viên ${config.gateWelcomeMember ? 'tuỳ chỉnh' : 'mặc định'}${config.gateGuildName ? `, tên bang "${truncate(config.gateGuildName, 40)}"` : ''}`,
    config.gatePanelMessageId ? '✅ Bảng đã đăng. Bấm nút bên dưới để làm mới (hoặc đăng lại nếu bị xoá).' : 'Chưa đăng bảng.',
    '',
    '**Kiểm tra**',
    ...(ctx.health || []).map((h) => (/^(-#|ℹ️)/.test(h.text) ? h.text : `${h.ok ? '✅' : '⚠️'} ${h.text}`)),
  ];
  if (note) lines.push('', note);
  return {
    content: truncate(lines.join('\n'), 2000),
    allowedMentions: { parse: [] },
    components: [
      new ActionRowBuilder().addComponents(gateChan),
      new ActionRowBuilder().addComponents(admin),
      new ActionRowBuilder().addComponents(stranger),
      new ActionRowBuilder().addComponents(guest),
      new ActionRowBuilder().addComponents(
        button('setup:gatewelcome', '✏️ Lời chào'),
        button('setup:gateauto', config.gateAutoApprove !== false ? '✋ Tắt tự duyệt' : '🤖 Bật tự duyệt'),
        button('setup:gatetoggle', isOn(config, 'gate') ? '⏸ Tắt cổng' : '▶ Bật cổng', isOn(config, 'gate') ? ButtonStyle.Danger : ButtonStyle.Success),
        button('setup:gatepost', '📌 Đăng / làm mới bảng cổng vào', ButtonStyle.Success, !config.gateChannelId),
        button('setup:main', '↩ Quay lại')
      ),
    ],
  };
}

// The 🧩 Tính năng screen (ctx.view === 'feat'): one multi-select with the eight toggles, the switched-on ones preselected.
function buildFeaturesSetupView(config, note) {
  const select = new StringSelectMenuBuilder()
    .setCustomId('setup:features')
    .setPlaceholder('Chọn các tính năng muốn bật')
    .setMinValues(0)
    .setMaxValues(FEATURES.length)
    .addOptions(FEATURES.map((f) => ({ label: f.label, value: f.key, description: truncate(f.desc, 100), emoji: { name: f.emoji }, default: isOn(config, f.key) })));
  const lines = [
    '**🧩 Tính năng**',
    'Bật những gì bang bạn dùng, tắt phần còn lại: nút, nhắc và thông báo của tính năng tắt sẽ ẩn / ngừng (dữ liệu cũ vẫn còn).',
    'Luôn bật: đăng ký bang chiến, 🎯 Vai trò, phái, 📋 danh sách, 👥 chưa đăng ký + nhắc, 📢 công bố, 🎮 liên kết tên + thành viên game, 📊 Google Sheet, 👥 quân số.',
    `Đang bật: ${enabledLine(config)}`,
  ];
  if (note) lines.push('', note);
  return {
    content: truncate(lines.join('\n'), 2000),
    allowedMentions: { parse: [] },
    components: [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(button('setup:main', '↩ Quay lại'))],
  };
}

// The ⚙️ Nâng cao screen (ctx.view === 'adv'): the separate-channel sub-views, only those of the enabled features (🎮 is always there).
function buildAdvancedSetupView(config, note) {
  const row = new ActionRowBuilder().addComponents(button('setup:gnview', '🎮 Bảng liên kết tên'));
  if (isOn(config, 'mailbox')) row.addComponents(button('setup:mbview', '📮 Hòm thư'));
  if (isOn(config, 'events')) row.addComponents(button('setup:evview', '🎉 Sự kiện'));
  if (isOn(config, 'gate')) row.addComponents(button('setup:gateview', '🚪 Cổng vào'));
  if (isOn(config, 'voiceHang')) row.addComponents(button('setup:voiceview', '🎧 Treo voice'));
  const lines = [
    '**⚙️ Nâng cao**',
    'Chỉ cần khi muốn kênh riêng cho từng bảng; 📌 Đăng tất cả đã dùng kênh mặc định (kênh thông báo / kênh admin).',
    'Muốn thêm 📮 / 🎉 / 🚪 / 🎧 ở đây: bật ở 🧩 Tính năng trước.',
  ];
  if (note) lines.push('', note);
  return { content: truncate(lines.join('\n'), 2000), allowedMentions: { parse: [] }, components: [row, new ActionRowBuilder().addComponents(button('setup:main', '↩ Quay lại'))] };
}

// The 🎧 Treo voice screen (ctx.view === 'voice'): the voice channel the bot sits in. ctx.voiceStatus = where the bot is now.
function buildVoiceSetupView(config, note, ctx = {}) {
  const chan = new ChannelSelectMenuBuilder()
    .setCustomId('setup:voicechan')
    .setPlaceholder('Kênh voice bot ngồi treo')
    .setChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice);
  if (config.hangChannelId) chan.setDefaultChannels(config.hangChannelId);
  const lines = [
    '**🎧 Treo voice**',
    'Bot vào ngồi sẵn trong kênh voice đã chọn (tắt mic, tắt loa) và tự vào lại khi bị kéo ra hay mất kết nối. Bot cần quyền Xem kênh + Kết nối ở kênh đó.',
    config.hangChannelId ? channelLine('Kênh', config.hangChannelId, ctx.guild) : '⚠️ Kênh: _chưa chọn_',
  ];
  if (ctx.voiceStatus) lines.push(ctx.voiceStatus);
  if (note) lines.push('', note);
  return {
    content: lines.join('\n'),
    allowedMentions: { parse: [] },
    components: [
      new ActionRowBuilder().addComponents(chan),
      new ActionRowBuilder().addComponents(button('setup:voiceclear', '⏏ Rời kênh', ButtonStyle.Danger, !config.hangChannelId), button('setup:main', '↩ Quay lại')),
    ],
  };
}

function buildSetupView(config, note, ctx = {}) {
  if (ctx.view === 'feat') return buildFeaturesSetupView(config, note);
  if (ctx.view === 'adv') return buildAdvancedSetupView(config, note);
  if (ctx.view === 'gate') return buildGateSetupView(config, note, ctx);
  if (ctx.view === 'gn') return buildGnSetupView(config, note, ctx);
  if (ctx.view === 'mb') return buildMailSetupView(config, note, ctx);
  if (ctx.view === 'ev') return buildEventSetupView(config, note, ctx);
  if (ctx.view === 'voice') return buildVoiceSetupView(config, note, ctx);
  const announce = new ChannelSelectMenuBuilder()
    .setCustomId('setup:announce')
    .setPlaceholder('Kênh thông báo bang chiến')
    .setChannelTypes(ChannelType.GuildText);
  if (config.announceChannelId) announce.setDefaultChannels(config.announceChannelId);

  const admin = new ChannelSelectMenuBuilder()
    .setCustomId('setup:admin')
    .setPlaceholder('Kênh admin (đặt bảng điều khiển)')
    .setChannelTypes(ChannelType.GuildText);
  if (config.adminChannelId) admin.setDefaultChannels(config.adminChannelId);

  const roles = new RoleSelectMenuBuilder()
    .setCustomId('setup:roles')
    .setPlaceholder('Role quản lý (được dùng bảng điều khiển)')
    .setMinValues(0)
    .setMaxValues(10);
  if (config.adminRoleIds.length) roles.setDefaultRoles(config.adminRoleIds.slice(0, 10));

  const member = new RoleSelectMenuBuilder()
    .setCustomId('setup:member')
    .setPlaceholder('Role thành viên (để nhắc đăng ký)')
    .setMinValues(0)
    .setMaxValues(1);
  if (config.memberRoleId) member.setDefaultRoles(config.memberRoleId);

  const botRoles = (ctx.botRoleIds || []).filter((id) => config.adminRoleIds.includes(id));
  const memberCount = Number.isInteger(ctx.memberCount) ? ` (${ctx.memberCount} người)` : '';
  const lines = [
    '**Cài đặt bot bang hội**',
    channelLine('Kênh thông báo', config.announceChannelId, ctx.guild),
    channelLine('Kênh admin', config.adminChannelId, ctx.guild),
    `✅ Role quản lý: ${config.adminRoleIds.length ? config.adminRoleIds.map((id) => `<@&${id}>`).join(' ') : '_chỉ người có quyền Quản lý máy chủ_'}`,
    ...(botRoles.length ? [`⚠️ Role quản lý là role của bot: ${botRoles.map((id) => `<@&${id}>`).join(' ')} — hãy chọn role gán cho người`] : []),
    config.memberRoleId
      ? ctx.memberCount === 0
        ? `⚠️ Role thành viên chưa có ai: <@&${config.memberRoleId}> (0 người)`
        : `✅ Role thành viên: <@&${config.memberRoleId}>${memberCount}`
      : '⚠️ Role thành viên: _chưa chọn_ (không đếm / nhắc được người chưa đăng ký)',
  ];
  lines.push(`Tính năng đang bật: ${enabledLine(config)}`);
  if (ctx.moveEvent) lines.push('', `📌 Bài **${ctx.moveEvent.title}** đang ở <#${ctx.moveEvent.channelId}>, khác kênh thông báo hiện tại.`);
  if (note) lines.push('', note);

  // A plain message holds 5 rows: 4 selects + this row of at most 4 buttons (the "Chuyển bài" one only while an event message sits in another channel).
  const lastRow = new ActionRowBuilder().addComponents(button('setup:postall', '📌 Đăng tất cả', ButtonStyle.Success), button('setup:featview', '🧩 Tính năng'), button('setup:advview', '⚙️ Nâng cao'));
  if (ctx.moveEvent) lastRow.addComponents(button(`adm:move:${ctx.moveEvent._id}`, '📌 Chuyển bài sang kênh mới', ButtonStyle.Primary));

  return {
    content: truncate(lines.join('\n'), 2000),
    allowedMentions: { parse: [] },
    components: [
      new ActionRowBuilder().addComponents(announce),
      new ActionRowBuilder().addComponents(admin),
      new ActionRowBuilder().addComponents(roles),
      new ActionRowBuilder().addComponents(member),
      lastRow,
    ],
  };
}

module.exports = { buildPanel, buildSetupView, missingPermissions };
