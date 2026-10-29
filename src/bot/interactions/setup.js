const { getOrCreateConfig, updateConfig, isOn } = require('../../services/guildConfigService');
const { FEATURES, FEATURE_KEYS, featuresOf } = require('../../services/features');
const warService = require('../../services/warService');
const { isAdmin } = require('../permissions');
const { buildSetupView } = require('../ui/panel');
const { isComplete } = require('../memberCache');
const { postOrUpdatePanel, scheduleRefresh, schedulePanelRefresh } = require('../refresher');
const { postAllPanels, summaryLines, logResults } = require('../postAll');
const { postOrUpdateGnPanel } = require('../gnPanel');
const { postOrUpdateMailPanel } = require('../mailPanel');
const { postOrUpdateEventPanel } = require('../eventPanel');
const { eventAdminChannelOf } = require('../../services/eventService');
const { mailboxReady, loadPublicKey, keyFingerprint } = require('../../services/mailService');
const { postOrUpdateGatePanel } = require('../gatePanel');
const { gateHealth, roleProblem, PROBLEM_TEXT } = require('../gateRoles');
const { buildWelcomeModal, readWelcomeModal } = require('../ui/gateSetup');
const { inboxOf } = require('./mailbox');
const { NO_PERMISSION, eph } = require('./common');
const { logEvent, ixCtx } = require('../../eventLog');
const sheetsGateway = require('../../services/sheets/gateway');
const eventDoc = require('../../services/sheets/eventDoc');
const { syncDocNow, getDocStatus, docError } = require('../eventDocSync');
const { buildEventDocModal } = require('../ui/settingsModal');
const voiceHang = require('../voiceHang');

// SHA-256 fingerprint of the installed mailbox public key (null when there is none): the owner compares it with the keygen output.
function mailKeyFingerprint() {
  const pem = loadPublicKey();
  return pem ? keyFingerprint(pem) : null;
}

// The /setup view with live checks: the bot's permissions in both channels, the member count of the member role (cache
// complete only) and - when the open/locked war message is not in the announce channel - the button that moves it.
async function setupView(interaction, config, note, view = null) {
  const guild = interaction.guild;
  if (view === 'gn' || view === 'feat' || view === 'adv') return buildSetupView(config, note, { guild, view });
  if (view === 'ev') return buildSetupView(config, note, { guild, view, docStatus: getDocStatus(config.guildId) });
  if (view === 'gate') return buildSetupView(config, note, { guild, view, health: gateHealth(config, guild) });
  if (view === 'voice') return buildSetupView(config, note, { guild, view, voiceStatus: voiceHang.statusLine(guild, config) });
  if (view === 'mb') return buildSetupView(config, note, { guild, view, mailReady: mailboxReady(), mailFingerprint: mailKeyFingerprint() });
  let memberCount;
  if (config.memberRoleId && guild && guild.members && guild.members.cache && isComplete(guild)) {
    memberCount = [...guild.members.cache.values()].filter((m) => !(m.user && m.user.bot) && m.roles && m.roles.cache && m.roles.cache.has(config.memberRoleId)).length;
  }
  // manager roles that belong to a bot / integration (role.managed, or role.tags.botId)
  const roles = guild && guild.roles && guild.roles.cache;
  const botRoleIds = roles ? config.adminRoleIds.filter((id) => { const r = roles.get(id); return r && (r.managed || (r.tags && r.tags.botId)); }) : [];
  let moveEvent = null;
  try {
    const event = await warService.getCurrentEvent(interaction.guildId);
    if (event && warService.canMoveMessage(event, config)) moveEvent = event;
  } catch (err) {
    console.error('[setup] current event:', err.message);
  }
  return buildSetupView(config, note, { guild, memberCount, moveEvent, botRoleIds });
}

// setup:announce | setup:admin | setup:roles | setup:member | setup:postall (📌 Đăng tất cả) | setup:featview | setup:features (the 🧩 Tính năng select) | setup:advview (⚙️ Nâng cao) | setup:post | setup:gnview | setup:main | setup:gnchan | setup:gnpost
// | setup:gateview | setup:gatechan | setup:gateadmin | setup:gatestranger | setup:gateguestrole | setup:gatetoggle | setup:gateauto | setup:gatepost | setup:gatewelcome (+ modal gatewelcomeModal) (the 🚪 Cổng vào sub-view)
// | setup:mbview | setup:mbchan | setup:mbinbox | setup:mbpost (the 📮 Hòm thư sub-view) | setup:evview | setup:evchan | setup:evadmin | setup:evpost (the 🎉 Sự kiện sub-view)
// 📄 Google Doc submit: empty = disconnect; else the id is checked (the bot can read it) before it is saved, then the Doc is written at once.
// -> the note shown under the 🎉 Sự kiện view.
async function onEventDocSubmit(interaction) {
  const raw = String(interaction.fields.getTextInputValue('link') || '').trim();
  if (!raw) {
    await updateConfig(interaction.guildId, { eventDocId: null });
    logEvent('setup', 'event_doc', { ...ixCtx(interaction), set: false });
    return '📄 Đã ngắt Google Doc (Doc giữ nguyên nội dung cũ, bot không ghi nữa).';
  }
  const id = eventDoc.parseDocId(raw);
  if (!id) return '⚠️ Link không phải Google Doc. Dạng đúng: https://docs.google.com/document/d/…/edit';
  if (!sheetsGateway.isAvailable()) return `⚠️ ${sheetsGateway.NO_KEY_HINT()}`;
  try {
    await sheetsGateway.getClient().docsGet(id);
  } catch (err) {
    logEvent('setup', 'event_doc', { ...ixCtx(interaction), set: false, err, lvl: 'warn' });
    return `⚠️ ${docError(err)}`;
  }
  await updateConfig(interaction.guildId, { eventDocId: id });
  const res = await syncDocNow(interaction.client, interaction.guildId, 'setup');
  logEvent('setup', 'event_doc', { ...ixCtx(interaction), set: true, ok: res.ok });
  return res.ok ? `✅ Đã nối Google Doc và ghi ${res.events} sự kiện. Từ giờ bot tự cập nhật Doc sau mỗi thay đổi (~1 phút).` : `⚠️ Đã lưu link nhưng ghi lỗi: ${res.message}`;
}

// (all admin-gated: the member side of the name link is gn:*, see ./gameName)
async function handle(interaction, parts) {
  if (parts[1] === 'evdoc') {
    // the 📄 Google Doc button opens a modal: it must be the first answer, so the admin check comes first
    const current = await getOrCreateConfig(interaction.guildId);
    if (!isAdmin(interaction.member, current, interaction.memberPermissions)) return interaction.reply(eph(NO_PERMISSION));
    return interaction.showModal(buildEventDocModal(current, sheetsGateway.accountEmail()));
  }
  if (parts[1] === 'gatewelcome') {
    // the ✏️ Lời chào button opens a modal: it must be the first answer, so the admin check comes first
    const current = await getOrCreateConfig(interaction.guildId);
    if (!isAdmin(interaction.member, current, interaction.memberPermissions)) return interaction.reply(eph(NO_PERMISSION));
    return interaction.showModal(buildWelcomeModal(current, interaction.guild));
  }
  await interaction.deferUpdate();
  let config = await getOrCreateConfig(interaction.guildId);
  if (!isAdmin(interaction.member, config, interaction.memberPermissions)) return interaction.followUp(eph(NO_PERMISSION));

  const values = interaction.values || [];
  let note;
  let view = null;
  switch (parts[1]) {
    case 'announce':
      config = await updateConfig(interaction.guildId, { announceChannelId: values[0] || null });
      logEvent('setup', 'channel_set', { ...ixCtx(interaction), select: 'announce', set: Boolean(values[0]) });
      break;
    case 'admin':
      config = await updateConfig(interaction.guildId, { adminChannelId: values[0] || null });
      logEvent('setup', 'channel_set', { ...ixCtx(interaction), select: 'admin', set: Boolean(values[0]) });
      break;
    case 'roles':
      config = await updateConfig(interaction.guildId, { adminRoleIds: values });
      logEvent('setup', 'channel_set', { ...ixCtx(interaction), select: 'roles', count: values.length });
      break;
    case 'member':
      config = await updateConfig(interaction.guildId, { memberRoleId: values[0] || null });
      logEvent('setup', 'channel_set', { ...ixCtx(interaction), select: 'member', set: Boolean(values[0]) });
      break;
    case 'postall': {
      const results = await postAllPanels(interaction.client, config, interaction.guild);
      logResults(ixCtx(interaction), results);
      note = summaryLines(results).join('\n');
      config = await getOrCreateConfig(interaction.guildId); // the stored panel ids may have changed
      break;
    }
    case 'featview':
      view = 'feat';
      break;
    case 'advview':
      view = 'adv';
      break;
    case 'features': {
      view = 'feat';
      const picked = new Set(values);
      const before = featuresOf(config);
      const next = Object.fromEntries(FEATURE_KEYS.map((key) => [key, picked.has(key)]));
      config = await updateConfig(interaction.guildId, { features: next, gateEnabled: next.gate }); // features.gate is the source of truth; gateEnabled is kept in step for older readers
      logEvent('setup', 'features_set', { ...ixCtx(interaction), on: FEATURE_KEYS.filter((k) => next[k]), off: FEATURE_KEYS.filter((k) => !next[k]) });
      note = featuresNote(before, next);
      await refreshAfterToggle(interaction.client, interaction.guildId);
      await voiceHang.syncGuild(interaction.client, interaction.guildId, config).catch((err) => console.error('[setup] voice:', err.message)); // 🎧 on: join, off: leave
      break;
    }
    case 'voiceview':
      view = 'voice';
      break;
    case 'voicechan':
    case 'voiceclear': {
      view = 'voice';
      const channelId = parts[1] === 'voicechan' ? values[0] || null : null;
      config = await updateConfig(interaction.guildId, { hangChannelId: channelId });
      const res = await voiceHang.syncGuild(interaction.client, interaction.guildId, config);
      logEvent('setup', 'channel_set', { ...ixCtx(interaction), select: parts[1], set: Boolean(channelId), voice: res.action });
      note = voiceHang.noteOf(res, config);
      break;
    }
    case 'post':
      note = await postPanel(interaction, config);
      config = await getOrCreateConfig(interaction.guildId); // the stored dashboard ids may have changed
      break;
    case 'gnview':
      view = 'gn';
      break;
    case 'main':
      break;
    case 'gnchan':
      view = 'gn';
      config = await updateConfig(interaction.guildId, { gnChannelId: values[0] || null });
      logEvent('setup', 'channel_set', { ...ixCtx(interaction), select: 'gnchan', set: Boolean(values[0]) });
      break;
    case 'gnpost':
      view = 'gn';
      note = await postGnPanel(interaction, config);
      config = await getOrCreateConfig(interaction.guildId); // the stored panel ids may have changed
      break;
    case 'mbview':
      view = 'mb';
      break;
    case 'mbchan':
      view = 'mb';
      config = await updateConfig(interaction.guildId, { mailChannelId: values[0] || null });
      logEvent('setup', 'channel_set', { ...ixCtx(interaction), select: 'mbchan', set: Boolean(values[0]) });
      break;
    case 'mbinbox':
      view = 'mb';
      config = await updateConfig(interaction.guildId, { mailInboxChannelId: values[0] || null });
      logEvent('setup', 'channel_set', { ...ixCtx(interaction), select: 'mbinbox', set: Boolean(values[0]) });
      break;
    case 'mbpost':
      view = 'mb';
      note = await postMailPanel(interaction, config);
      config = await getOrCreateConfig(interaction.guildId); // the stored panel ids may have changed
      break;
    case 'evview':
      view = 'ev';
      break;
    case 'evchan':
      view = 'ev';
      config = await updateConfig(interaction.guildId, { eventChannelId: values[0] || null });
      logEvent('setup', 'channel_set', { ...ixCtx(interaction), select: 'evchan', set: Boolean(values[0]) });
      break;
    case 'evadmin':
      view = 'ev';
      config = await updateConfig(interaction.guildId, { eventAdminChannelId: values[0] || null });
      logEvent('setup', 'channel_set', { ...ixCtx(interaction), select: 'evadmin', set: Boolean(values[0]) });
      break;
    case 'evdocModal': {
      view = 'ev';
      note = await onEventDocSubmit(interaction);
      config = await getOrCreateConfig(interaction.guildId);
      break;
    }
    case 'evpost':
      view = 'ev';
      note = await postEventPanel(interaction, config);
      config = await getOrCreateConfig(interaction.guildId); // the stored panel ids may have changed
      break;
    case 'gateview':
      view = 'gate';
      break;
    case 'gatechan':
      view = 'gate';
      config = await updateConfig(interaction.guildId, { gateChannelId: values[0] || null });
      logEvent('setup', 'channel_set', { ...ixCtx(interaction), select: 'gatechan', set: Boolean(values[0]) });
      break;
    case 'gateguestrole': {
      view = 'gate';
      // the guest role is handed out on a click-and-approve: it must be safe like the other gate roles (checked here, and again by the health lines)
      const problem = values[0] ? roleProblem(interaction.guild, values[0], config, 'guest') : null;
      if (problem && problem !== 'no_manage_roles' && problem !== 'no_bot') {
        note = `⚠️ Role khách <@&${values[0]}> chưa lưu: ${PROBLEM_TEXT[problem]}.`;
        logEvent('setup', 'channel_set', { ...ixCtx(interaction), select: 'gateguestrole', set: false, problem });
        break;
      }
      config = await updateConfig(interaction.guildId, { guestRoleId: values[0] || null });
      logEvent('setup', 'channel_set', { ...ixCtx(interaction), select: 'gateguestrole', set: Boolean(values[0]) });
      note = values[0] ? '🤝 Đã lưu role khách. Bấm 📌 để bảng cổng vào hiện nút Khách.' : '🤝 Đã tắt nút Khách. Bấm 📌 để bảng cổng vào cập nhật.';
      break;
    }
    case 'gateguest': // retired role selects of older /setup messages: nothing is saved, the gate view is just redrawn
    case 'gatepending':
      view = 'gate';
      break;
    case 'gatestranger':
      view = 'gate';
      if (values[0] && values[0] === config.guestRoleId) {
        note = `⚠️ Role người lạ <@&${values[0]}> chưa lưu: ${PROBLEM_TEXT.guest_same_as_stranger}.`;
        break;
      }
      config = await updateConfig(interaction.guildId, { strangerRoleId: values[0] || null });
      logEvent('setup', 'channel_set', { ...ixCtx(interaction), select: 'gatestranger', set: Boolean(values[0]) });
      break;
    case 'gateadmin':
      view = 'gate';
      config = await updateConfig(interaction.guildId, { gateAdminChannelId: values[0] || null });
      logEvent('setup', 'channel_set', { ...ixCtx(interaction), select: 'gateadmin', set: Boolean(values[0]) });
      break;
    case 'gatetoggle':
      view = 'gate';
      config = await updateConfig(interaction.guildId, { features: { ...featuresOf(config), gate: !isOn(config, 'gate') }, gateEnabled: !isOn(config, 'gate') });
      logEvent('setup', 'gate_toggle', { ...ixCtx(interaction), enabled: isOn(config, 'gate') });
      break;
    case 'gateauto':
      view = 'gate';
      config = await updateConfig(interaction.guildId, { gateAutoApprove: config.gateAutoApprove === false });
      logEvent('setup', 'gate_auto', { ...ixCtx(interaction), enabled: config.gateAutoApprove !== false });
      note = config.gateAutoApprove !== false ? '🤖 Đã bật tự duyệt. Bấm 📌 để bảng cổng vào cập nhật chú thích.' : '✋ Đã tắt tự duyệt: mọi yêu cầu chờ quản lý. Bấm 📌 để bảng cổng vào cập nhật chú thích.';
      break;
    case 'gatepost':
      view = 'gate';
      note = await postGatePanel(interaction, config);
      config = await getOrCreateConfig(interaction.guildId); // the stored panel ids may have changed
      break;
    case 'gatewelcomeModal': {
      view = 'gate';
      const parsed = readWelcomeModal(interaction.fields, interaction.guild, config);
      config = await updateConfig(interaction.guildId, { gateGuildName: parsed.guildName, gateWelcomeMember: parsed.member });
      logEvent('setup', 'gate_welcome', { ...ixCtx(interaction), custom: { member: Boolean(parsed.member), name: Boolean(parsed.guildName) } });
      note = '✅ Đã lưu lời chào (bấm 📌 để bảng cổng vào cập nhật tên bang).';
      break;
    }
    default:
      return;
  }
  return interaction.editReply(await setupView(interaction, config, note, view));
}

// The note under the 🧩 view after saving: what was saved, and the extra setup of every feature that was just turned on.
function featuresNote(before, next) {
  const turnedOn = FEATURES.filter((f) => next[f.key] && !before[f.key]);
  const lines = ['✅ Đã lưu. Thẻ bang chiến và bảng điều khiển sẽ cập nhật ngay.'];
  for (const f of turnedOn) if (f.setup) lines.push(f.setup);
  if (turnedOn.length) lines.push('Rồi bấm ↩ Quay lại → 📌 Đăng tất cả để đăng bảng của tính năng mới bật.');
  return lines.join('\n');
}

// The war messages (buttons) and the dashboard follow a change of toggles. Never throws.
async function refreshAfterToggle(client, guildId) {
  try {
    for (const event of await warService.listActiveEvents(guildId)) if (event.messageId) scheduleRefresh(client, event._id, 0);
    schedulePanelRefresh(client, guildId, 0);
  } catch (err) {
    console.error('[setup] refresh after toggle:', err.message);
  }
}

// Posts / refreshes the member panel "Liên kết tên trong game" in the chosen channel.
async function postGnPanel(interaction, config) {
  if (!config.gnChannelId) return '⚠️ Hãy chọn kênh liên kết tên trước.';
  try {
    const res = await postOrUpdateGnPanel(interaction.client, config);
    logEvent('setup', 'gn_panel_posted', { ...ixCtx(interaction), result: res.action, channel: res.channelId });
    return res.action === 'edited' ? `✅ Đã làm mới bảng liên kết tên ở <#${res.channelId}>.` : `✅ Đã đăng bảng liên kết tên ở <#${res.channelId}>.`;
  } catch (err) {
    console.error('[setup] post gn panel:', err.message);
    logEvent('setup', 'gn_panel_posted', { ...ixCtx(interaction), result: 'error', channel: config.gnChannelId, err });
    return `❌ Không gửi được vào <#${config.gnChannelId}>. Kiểm tra quyền của bot (Xem kênh, Gửi tin nhắn).`;
  }
}

// Posts / refreshes the gate panel "Chào mừng" in the gate channel.
async function postGatePanel(interaction, config) {
  if (!config.gateChannelId) return '⚠️ Hãy chọn kênh cổng vào trước.';
  try {
    const res = await postOrUpdateGatePanel(interaction.client, config);
    logEvent('setup', 'gate_panel_posted', { ...ixCtx(interaction), result: res.action, channel: res.channelId });
    return res.action === 'edited' ? `✅ Đã làm mới bảng cổng vào ở <#${res.channelId}>.` : `✅ Đã đăng bảng cổng vào ở <#${res.channelId}>.`;
  } catch (err) {
    console.error('[setup] post gate panel:', err.message);
    logEvent('setup', 'gate_panel_posted', { ...ixCtx(interaction), result: 'error', channel: config.gateChannelId, err });
    return `❌ Không gửi được vào <#${config.gateChannelId}>. Kiểm tra quyền của bot (Xem kênh, Gửi tin nhắn).`;
  }
}

// Posts / refreshes the member panel "Hòm thư góp ý" in the chosen channel.
async function postMailPanel(interaction, config) {
  if (!config.mailChannelId) return '⚠️ Hãy chọn kênh đặt bảng hòm thư trước.';
  if (!inboxOf(config)) return '⚠️ Hãy chọn kênh nhận thư (hoặc kênh admin) trước.';
  try {
    const res = await postOrUpdateMailPanel(interaction.client, config);
    logEvent('setup', 'mail_panel_posted', { ...ixCtx(interaction), result: res.action, channel: res.channelId });
    return res.action === 'edited' ? `✅ Đã làm mới bảng hòm thư ở <#${res.channelId}>.` : `✅ Đã đăng bảng hòm thư ở <#${res.channelId}>.`;
  } catch (err) {
    console.error('[setup] post mail panel:', err.message);
    logEvent('setup', 'mail_panel_posted', { ...ixCtx(interaction), result: 'error', channel: config.mailChannelId, err });
    return `❌ Không gửi được vào <#${config.mailChannelId}>. Kiểm tra quyền của bot (Xem kênh, Gửi tin nhắn).`;
  }
}

// Posts / refreshes the persistent event management panel in the management channel (event channel, else the admin channel).
async function postEventPanel(interaction, config) {
  const channelId = eventAdminChannelOf(config);
  if (!channelId) return '⚠️ Hãy chọn kênh quản lý sự kiện (hoặc kênh admin) trước.';
  try {
    const res = await postOrUpdateEventPanel(interaction.client, config);
    logEvent('setup', 'event_panel_posted', { ...ixCtx(interaction), result: res.action, channel: res.channelId });
    return res.action === 'edited' ? `✅ Đã làm mới bảng quản lý sự kiện ở <#${res.channelId}>.` : `✅ Đã đăng bảng quản lý sự kiện ở <#${res.channelId}>.`;
  } catch (err) {
    console.error('[setup] post event panel:', err.message);
    logEvent('setup', 'event_panel_posted', { ...ixCtx(interaction), result: 'error', channel: channelId, err });
    return `❌ Không gửi được vào <#${channelId}>. Kiểm tra quyền của bot (Xem kênh, Gửi tin nhắn).`;
  }
}

// Edits the stored dashboard when it still exists, else posts a new one (and stores its ids).
async function postPanel(interaction, config) {
  if (!config.announceChannelId || !config.adminChannelId) return '⚠️ Hãy chọn kênh thông báo và kênh admin trước.';
  try {
    const res = await postOrUpdatePanel(interaction.client, config);
    logEvent('setup', 'panel_posted', { ...ixCtx(interaction), result: res.action, channel: res.channelId });
    return res.action === 'edited'
      ? `✅ Đã làm mới bảng điều khiển ở <#${res.channelId}>.`
      : `✅ Đã đăng bảng điều khiển ở <#${res.channelId}>.`;
  } catch (err) {
    console.error('[setup] post panel:', err.message);
    logEvent('setup', 'panel_posted', { ...ixCtx(interaction), result: 'error', channel: config.adminChannelId, err });
    return `❌ Không gửi được vào <#${config.adminChannelId}>. Kiểm tra quyền của bot (Xem kênh, Gửi tin nhắn, Nhúng liên kết).`;
  }
}

module.exports = { handle, setupView };
