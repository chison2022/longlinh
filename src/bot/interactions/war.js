const { MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, escapeMarkdown } = require('discord.js');
const { LABELS: GN_LABELS } = require('../ui/gameName');
const { loadGameNames } = require('../gameNames');
const warService = require('../../services/warService');
const regService = require('../../services/registrationService');
const { getConfigOrDefault } = require('../../services/guildConfigService');
const { buildClassSelect, buildListEmbeds, buildMissionSelect } = require('../ui/warMessage');
const missions = require('../../services/missions');
const { discordTs } = require('../../utils/time');
const { toMessages } = require('../ui/common');
const { scheduleRefresh } = require('../refresher');
const { scheduleSync } = require('../sheetSync');
const { displayNameOf, roleNamesOf } = require('./common');
const { stylesOf, styleOf, editReplyWithEmojiFallback } = require('../classStyle');
const { liveRegs, liveName } = require('../liveNames');
const linkService = require('../../services/linkService');
const { buildTkPanel } = require('../ui/tuyenKhien');
const { logEvent, ixCtx } = require('../../eventLog');

// "<emoji> Plain name" of a class, styled like the war embed (server emoji when matched, else the unicode fallback).
const classLabel = (interaction, config, className) => {
  const st = styleOf(stylesOf(interaction.guild, config), className);
  return `${st.emojiText} ${st.plain}`;
};

// The member's class is whatever class role they hold (exactly one), else null.
const roleClassOf = (interaction, config) => regService.classFromRoles(roleNamesOf(interaction), config.classes);

const STATUSES = ['join', 'absent']; // 'Dự bị' is no longer a member choice (old buttons: RESERVE_GONE)
const RESERVE_GONE = 'Nút Dự bị đã bỏ — bấm ✅ Tham gia hoặc ❌ Vắng.';
const CLOSED = '🔒 Đã hết hạn đăng ký cho bang chiến này.';
const NOT_FOUND = 'Bang chiến không tồn tại hoặc đã bị xoá.';
const NOT_PUBLISHED = 'Chưa công bố đội hình.';
const ENDED = 'Bang chiến đã kết thúc.';

// The confirmation after a click: what was saved and until when it can be changed.
const recorded = (event, status, label) =>
  `✅ Đã ghi nhận: **${warService.REG_LABELS[status]}** – ${label}. Đổi được tới ${discordTs(new Date(event.deadlineAt), 'f')}.`;

// After a ✅ Tham gia of a member who has not linked an in-game character: one extra line and a button to the picker (never blocks).
const GN_NUDGE = '🎮 Bạn chưa chọn nhân vật trong game — chọn để quản lý xếp đội đúng người (không bắt buộc).';
// Skipped for a member who is already matched automatically (game names), and shown at most once per war per member.
const nudged = new Set(); // `${eventId}:${userId}`
// A ✅ Tham gia from someone whose linked character left the guild in game is saved, with a warning (the managers decide).
const leftWarning = (gameName) => `⚠️ Nhân vật **${escapeMarkdown(String(gameName || ''))}** của bạn đã rời bang trong game (theo danh sách game mới nhất). Báo danh vẫn được lưu — nếu đã quay lại bang, báo quản lý cập nhật danh sách.`;

async function withGameNameNudge(interaction, eventId, reply, status, member) {
  if (status === 'join' && member && member.gameLeftAt) {
    logEvent('war', 'left_join', { ...ixCtx(interaction), eid: eventId });
    return `${reply}\n${leftWarning(member.gameName)}`;
  }
  if (status !== 'join' || (member && member.gameName)) return reply;
  const key = `${eventId}:${interaction.user.id}`;
  if (nudged.has(key)) return reply;
  if ((await loadGameNames(interaction.guild)).has(interaction.user.id)) return reply;
  if (nudged.size > 5000) nudged.clear();
  nudged.add(key);
  logEvent('war', 'gn_nudge', { ...ixCtx(interaction), eid: eventId, shown: true });
  return { content: `${reply}\n${GN_NUDGE}`, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('gn:open').setLabel(GN_LABELS.open).setStyle(ButtonStyle.Secondary))] };
}

async function loadEvent(interaction, eventId) {
  const event = await warService.getEvent(eventId);
  return event && event.guildId === interaction.guildId ? event : null;
}

// Save registration; absent members are removed from any team. `event` must come from a read made right before
// this call (no other DB round trip in between): it is the deadline re-check, so there is no second read here.
// Returns false (nothing saved) when that event is already closed.
async function register(interaction, event, status, className) {
  if (!event || !warService.canRegister(event, new Date())) return false;
  // onlyIfOpen: re-checked under the war row's lock, so a lock / publish that commits meanwhile wins and the click is refused
  const saved = await regService.upsertRegistration({
    eventId: event._id,
    guildId: event.guildId,
    discordId: interaction.user.id,
    displayName: displayNameOf(interaction),
    status,
    className,
    onlyIfOpen: true,
  });
  if (saved === null) return false;
  scheduleRefresh(interaction.client, event._id);
  scheduleSync(interaction.client, event.guildId);
  return true;
}

// war:st:<eid>:<status>
async function onStatus(interaction, eventId, status) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (status === 'reserve') {
    // an old message still shows the removed button: say so and redraw it
    const old = await loadEvent(interaction, eventId);
    if (old) scheduleRefresh(interaction.client, old._id);
    return interaction.editReply(RESERVE_GONE);
  }
  if (!STATUSES.includes(status)) return interaction.editReply(NOT_FOUND);
  // One round trip for the event and the member together (config is cached), then straight to the write.
  const [event, config, member] = await Promise.all([
    loadEvent(interaction, eventId),
    getConfigOrDefault(interaction.guildId),
    regService.getMember(interaction.guildId, interaction.user.id),
  ]);
  if (!event) return interaction.editReply(NOT_FOUND);
  if (!warService.canRegister(event, new Date())) {
    logEvent('war', 'register', { ...ixCtx(interaction), eid: eventId, status, result: 'closed' });
    return interaction.editReply(CLOSED);
  }
  // Class order: the Discord role (exactly one) -> the saved class -> ask.
  const saved = member && member.className;
  const roleClass = roleClassOf(interaction, config);
  const savedClass = saved ? regService.canonicalClass(saved, config.classes) : null; // old "🛡️ Thiết Y" -> configured "Thiết Y"
  const className = roleClass || (config.classes.includes(savedClass) ? savedClass : null);
  if (!className) {
    logEvent('war', 'register', { ...ixCtx(interaction), eid: eventId, status, classFrom: 'asked', result: 'asked' });
    return editReplyWithEmojiFallback(interaction, (noEmoji) => ({
      content: 'Chọn môn phái của bạn (chỉ cần chọn một lần):',
      components: [buildClassSelect(`war:cls:${eventId}:${status}`, config.classes, undefined, stylesOf(interaction.guild, config), { noEmoji })],
    }));
  }
  // A role class that differs from the saved one is persisted alongside the registration write (no extra round trip).
  const syncClass =
    roleClass && roleClass !== saved
      ? regService
          .saveMemberClass(interaction.guildId, interaction.user.id, displayNameOf(interaction), roleClass)
          .catch((err) => console.error('saveMemberClass failed', err))
      : null;
  const [ok] = await Promise.all([register(interaction, event, status, className), syncClass]);
  logEvent('war', 'register', { ...ixCtx(interaction), eid: eventId, status, classFrom: roleClass ? 'role' : 'saved', result: ok ? 'ok' : 'closed' });
  if (!ok) return interaction.editReply(CLOSED);
  return interaction.editReply(await withGameNameNudge(interaction, eventId, recorded(event, status, classLabel(interaction, config, className)), status, member));
}

// war:cls:<eid>:<status|-> ; '-' = change class only
async function onClass(interaction, eventId, status) {
  await interaction.deferUpdate();
  const picked = interaction.values[0];
  const config = await getConfigOrDefault(interaction.guildId); // cached
  const roleClass = roleClassOf(interaction, config);
  const className = roleClass || regService.canonicalClass(picked, config.classes); // the role wins over the picked value
  const note = roleClass && !regService.sameClass(roleClass, picked) ? `Môn phái của bạn lấy theo role **${classLabel(interaction, config, roleClass)}**.\n` : '';
  if (!config.classes.includes(className)) {
    return interaction.editReply({ content: 'Môn phái không còn trong danh sách, hãy thử lại.', components: [] });
  }
  const displayName = displayNameOf(interaction);
  // Event read and class save in one round trip: the event is as fresh as it gets right before the registration write.
  const [event, memberDoc] = await Promise.all([
    loadEvent(interaction, eventId),
    regService.saveMemberClass(interaction.guildId, interaction.user.id, displayName, className),
  ]);

  const open = event && warService.canRegister(event, new Date());
  logEvent('war', 'class', { ...ixCtx(interaction), eid: eventId, className, byRole: Boolean(roleClass), change: status === '-', open: Boolean(open) });
  if (status !== '-') {
    if (!event) return interaction.editReply({ content: NOT_FOUND, components: [] });
    if (!open) return interaction.editReply({ content: `${note}Đã lưu môn phái ${classLabel(interaction, config, className)}.\n${CLOSED}`, components: [] });
    if (status === 'reserve') {
      scheduleRefresh(interaction.client, event._id);
      return interaction.editReply({ content: `${note}Đã lưu môn phái ${classLabel(interaction, config, className)}.
${RESERVE_GONE}`, components: [] });
    }
    if (!STATUSES.includes(status)) return interaction.editReply({ content: NOT_FOUND, components: [] });
    const registered = await register(interaction, event, status, className);
    logEvent('war', 'register', { ...ixCtx(interaction), eid: eventId, status, classFrom: 'asked', result: registered ? 'ok' : 'closed' });
    if (!registered) {
      return interaction.editReply({ content: `${note}Đã lưu môn phái ${classLabel(interaction, config, className)}.\n${CLOSED}`, components: [] });
    }
    const done = await withGameNameNudge(interaction, eventId, `${note}${recorded(event, status, classLabel(interaction, config, className))}`, status, memberDoc);
    return interaction.editReply(typeof done === 'string' ? { content: done, components: [] } : done);
  }

  if (open) {
    await regService.updateRegistrationClass(event._id, interaction.user.id, className, displayName);
    scheduleRefresh(interaction.client, event._id);
    scheduleSync(interaction.client, event.guildId);
  } else if (event) {
    // Registration is over: only the saved preference changed, the registration of this war keeps its class.
    const mine = await regService.getRegistration(event._id, interaction.user.id);
    if (mine && mine.status === 'absent') {
      return interaction.editReply({ content: `${note}Đã lưu phái ${classLabel(interaction, config, className)} cho các lần sau. Trận này bạn đã báo vắng.`, components: [] });
    }
    const kept = mine ? ` — đăng ký trận này giữ nguyên ${mine.className ? classLabel(interaction, config, mine.className) : 'chưa chọn phái'}` : '. Đăng ký trận này đã đóng';
    return interaction.editReply({ content: `${note}Đã lưu phái ${classLabel(interaction, config, className)} cho các lần sau${kept}.`, components: [] });
  }
  return interaction.editReply({ content: `${note}Đã đổi môn phái thành ${classLabel(interaction, config, className)}.`, components: [] });
}

// war:chg:<eid>
async function onChangeClass(interaction, eventId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const [config, member] = await Promise.all([
    getConfigOrDefault(interaction.guildId),
    regService.getMember(interaction.guildId, interaction.user.id),
  ]);
  const roleClass = roleClassOf(interaction, config);
  if (roleClass) {
    return interaction.editReply(`🎭 Phái của bạn: **${classLabel(interaction, config, roleClass)}** (lấy theo role). Muốn đổi, nhờ quản lý đổi role.`);
  }
  return editReplyWithEmojiFallback(interaction, (noEmoji) => ({
    content: 'Bạn chưa có role phái. Chọn môn phái của bạn:',
    components: [buildClassSelect(`war:cls:${eventId}:-`, config.classes, member && member.className, stylesOf(interaction.guild, config), { noEmoji })],
  }));
}

// war:mis:<eid> - anybody: their role in the war (remembered for every war; the admins arrange the teams from it)
async function onMission(interaction, eventId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const [event, member] = await Promise.all([loadEvent(interaction, eventId), regService.getMember(interaction.guildId, interaction.user.id)]);
  if (!event) return interaction.editReply(NOT_FOUND);
  const current = missions.normalizeRole(member && member.missionPref);
  const closed = warService.canRegister(event, new Date()) ? '' : '\n-# Đăng ký đã đóng: vai trò vẫn được lưu cho các lần sau (tính cho trận này nếu lead chưa xếp đội).';
  return interaction.editReply({
    content: `🎯 Chọn vai trò của bạn trong bang chiến (lead sẽ xếp theo đây, chưa rõ thì chọn "Không biết — tùy lead sắp xếp").${closed}`,
    components: [buildMissionSelect(`war:mispick:${eventId}`, current)],
  });
}

// war:mispick:<eid> - saves the role (a select of an OLD message may still send mid / mobile / supply: saved as its new role)
async function onMissionPick(interaction, eventId) {
  await interaction.deferUpdate();
  const raw = String((interaction.values || [])[0]);
  if (!missions.isRoleValue(raw)) return interaction.editReply({ content: 'Lựa chọn không hợp lệ, hãy thử lại.', components: [] });
  const pick = missions.normalizeRole(raw);
  const [event] = await Promise.all([loadEvent(interaction, eventId), regService.saveMemberMission(interaction.guildId, interaction.user.id, displayNameOf(interaction), pick)]);
  scheduleSync(interaction.client, interaction.guildId); // the role column of the sheet
  logEvent('war', 'mission', { ...ixCtx(interaction), eid: eventId, pick, role: pick, status: event && event.status });
  let note = '';
  if (event && (event.status === 'published' || event.status === 'done')) note = '\nĐội hình trận này đã công bố nên không đổi; vai trò được lưu cho lần sau.';
  else if (event && !warService.canRegister(event, new Date())) note = '\nĐăng ký đã đóng: vai trò được lưu cho lần sau (tính cho trận này nếu lead chưa xếp đội).';
  return interaction.editReply({ content: `✅ Đã lưu vai trò: **${missions.roleName(pick)}**.${note}`, components: [] });
}

// war:list:<eid>
async function onList(interaction, eventId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const event = await loadEvent(interaction, eventId);
  if (!event) return interaction.editReply(NOT_FOUND);
  const [regs, config, members] = await Promise.all([regService.listRegistrations(event._id), getConfigOrDefault(interaction.guildId), linkService.loadMembers(interaction.guildId)]);
  // One ephemeral message holds at most 6000 chars of embeds; a long list continues in follow-up messages.
  const [first, ...rest] = toMessages(buildListEmbeds(event, liveRegs(interaction.guild, regs), config.classes, stylesOf(interaction.guild, config), linkService.contextFor(members, regs)));
  await interaction.editReply({ embeds: first });
  for (const embeds of rest) await interaction.followUp({ embeds, flags: MessageFlags.Ephemeral });
}

// ---------- Nhóm Tuyến Khiên (persistent links, not gated by the registration deadline) ----------

const hasRole = (member, roleId) => {
  const roles = member && member.roles;
  if (!roles) return true; // unknown: do not warn
  return Array.isArray(roles) ? roles.includes(roleId) : roles.cache ? roles.cache.has(roleId) : true;
};

// Renders the panel into the interaction (edit of the ephemeral message). `eventId` only proves the guild.
async function showTk(interaction, notes = [], nonce = null) {
  const eid = interaction.customId.split(':')[2];
  const members = await linkService.loadMembers(interaction.guildId);
  const stored = new Map(members.map((m) => [m.discordId, m.displayName]));
  const nameOf = (id) => liveName(interaction.guild, id, stored.get(id) || null) || `<@${id}>`;
  return interaction.editReply(buildTkPanel({ eid, me: interaction.user.id, members, nameOf, notes, nonce }));
}

// war:tk:<eid> (open) | war:tkpick:<eid> | war:tkcarry:<eid> | war:tkclear:<eid>
async function onTk(interaction, eventId, action) {
  if (action === 'tk') await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  else await interaction.deferUpdate();
  const event = await loadEvent(interaction, eventId);
  if (!event) return interaction.editReply({ content: NOT_FOUND, components: [] });
  const { guildId } = interaction;
  const me = interaction.user.id;
  const notes = [];
  let nonce = null; // set when somebody picked was rejected: the menu is redrawn with only the saved links
  const tk = {}; // counts for the war.tk event (tkpick only)
  if (action === 'tkpick') {
    const users = interaction.users;
    const isBot = (id) => !!(users && users.get && users.get(id) && users.get(id).bot);
    const picked = [...new Set(interaction.values || [])];
    let ids = picked.filter((id) => id !== me && !isBot(id));
    tk.picked = picked.length;
    tk.skippedSelfBot = picked.length - ids.length;
    if (ids.length < picked.length) notes.push('ℹ️ Bỏ qua chính bạn / bot.');
    const nameOf = (id) => {
      const m = interaction.members && interaction.members.get && interaction.members.get(id);
      const u = users && users.get && users.get(id);
      return (m && m.displayName) || (u && (u.globalName || u.username)) || `<@${id}>`;
    };
    const config = await getConfigOrDefault(guildId);
    // with a member role set, only people holding it can be linked (like bots / yourself, the others are skipped)
    const lacksRole = (id) => {
      if (!config.memberRoleId || !interaction.members || !interaction.members.get) return false;
      const member = interaction.members.get(id);
      return member ? !hasRole(member, config.memberRoleId) : Boolean(users && users.get && users.get(id)); // a user without a member is not in the guild
    };
    const odd = ids.filter(lacksRole);
    for (const id of odd) notes.push(`⚠️ Bỏ qua ${nameOf(id)}: không có role thành viên bang`);
    tk.skippedNoRole = odd.length;
    ids = ids.filter((id) => !odd.includes(id));
    // the ids the menu really showed as selected (the DB may have changed since): only those can be unlinked here
    const shownDefaults = interaction.component && interaction.component.data ? (interaction.component.data.default_values || []).map((d) => d.id) : null;
    const saved = await linkService.setLinks(guildId, me, ids, shownDefaults);
    tk.rejectedFull = ((saved && saved.rejected) || []).length;
    tk.saved = ids.length - tk.rejectedFull;
    for (const id of (saved && saved.rejected) || []) notes.push(`⚠️ Không thêm được ${nameOf(id)}: nhóm sẽ vượt ${linkService.MAX_GROUP} người.`);
    if (notes.length || picked.length > ids.length) nonce = Date.now().toString(36).slice(-6);
  } else if (action === 'tkcarry') {
    await linkService.toggleCarries(guildId, me);
  } else if (action === 'tkclear') {
    await linkService.clearLinks(guildId, me);
  }
  if (action !== 'tk') scheduleSync(interaction.client, guildId); // the Tuyến Khiên group column of the sheet
  logEvent('war', 'tk', { ...ixCtx(interaction), eid: eventId, action, ...tk });
  return showTk(interaction, notes, nonce);
}

async function handle(interaction, parts) {
  const [, action, eventId, arg] = parts;
  switch (action) {
    case 'st':
      return onStatus(interaction, eventId, arg);
    case 'cls':
      return onClass(interaction, eventId, arg);
    case 'chg':
      return onChangeClass(interaction, eventId);
    case 'mis':
      return onMission(interaction, eventId);
    case 'mispick':
      return onMissionPick(interaction, eventId);
    case 'list':
      return onList(interaction, eventId);
    case 'tk':
    case 'tkpick':
    case 'tkcarry':
    case 'tkclear':
      return onTk(interaction, eventId, action);
    default:
      return undefined;
  }
}

module.exports = { handle, resetNudges: () => nudged.clear() };
