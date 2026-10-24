// Role work of the new-member gate: which role is which, whether the bot may hand it out, and the /setup health lines.
// The bot never edits channel permissions: the owner hides the channels by hand (docs/LUONG-BOT.md, "Cổng vào").
const { PermissionFlagsBits } = require('discord.js');
const { normalizeName, classId } = require('../services/registrationService');
const { plainClass } = require('../services/lineupStyle');
const { missingPermissions } = require('./ui/panel');

const KIND_LABEL = { member: 'Thành viên', class: 'phái', stranger: 'Người lạ' };
const PROBLEM_TEXT = {
  missing: 'role không còn trong server',
  managed: 'là role của bot / tích hợp, không gán được',
  hierarchy: 'role của bot đang nằm DƯỚI hoặc bằng role này: kéo role bot lên trên',
  no_manage_roles: 'bot thiếu quyền Quản lý vai trò (Manage Roles)',
  no_bot: 'bot chưa có trong server',
  everyone: 'là @everyone, không dùng làm role này được',
  is_admin: 'là role quản lý: ai bấm cũng tự cấp được quyền quản lý',
  same_as_member: 'trùng role Thành viên: chọn role khác',
  privileged: 'role này có quyền quản trị (Quản trị viên / Quản lý máy chủ, vai trò, kênh, tin nhắn, webhook, kick, ban, timeout, @everyone)',
};

// A role that the bot hands out by name (phái) must never carry power.
const PRIVILEGED = [
  'Administrator',
  'ManageGuild',
  'ManageRoles',
  'ManageChannels',
  'BanMembers',
  'KickMembers',
  'ManageMessages',
  'MentionEveryone',
  'ManageWebhooks',
  'ModerateMembers',
].map((name) => PermissionFlagsBits[name]);

const rolesOf = (guild) => (guild && guild.roles && guild.roles.cache) || new Map();

// The guild role whose name is the class (same comparison as classFromRoles: normalizeName(role) == classId(class)); null when none.
function findClassRole(guild, className) {
  const id = classId(className);
  if (!id) return null;
  for (const role of rolesOf(guild).values()) {
    if (role.id === guild.id || role.managed) continue;
    if (normalizeName(role.name) === id) return role;
  }
  return null;
}

// Why a class role must not be handed out, or null. Needs the config for the admin roles.
function unsafeRole(guild, roleId, config) {
  if (!roleId) return null;
  if (guild && roleId === guild.id) return 'everyone';
  if (config && (config.adminRoleIds || []).includes(roleId)) return 'is_admin';
  const role = rolesOf(guild).get(roleId);
  const perms = role && role.permissions;
  if (perms && typeof perms.has === 'function' && PRIVILEGED.some((p) => perms.has(p))) return 'privileged';
  return null;
}

// null when the bot can hand out this role, else a key of PROBLEM_TEXT. With a config and kind 'class' the role must also be safe to
// hand out (unsafeRole); without them only the bot-side checks run.
function roleProblem(guild, roleId, config = null, kind = null) {
  const me = guild && guild.members && guild.members.me;
  if (!me) return 'no_bot';
  if (!me.permissions || !me.permissions.has(PermissionFlagsBits.ManageRoles)) return 'no_manage_roles';
  const role = rolesOf(guild).get(roleId);
  if (!role) return 'missing';
  if (role.managed) return 'managed';
  if (config && (kind === 'class' || kind === 'stranger')) {
    const unsafe = unsafeRole(guild, roleId, config);
    if (unsafe) return unsafe;
  }
  if (config && kind === 'stranger' && roleId === config.memberRoleId) return 'same_as_member';
  const top = me.roles && me.roles.highest;
  if (top && role.position >= top.position) return 'hierarchy';
  return null;
}

// entries [{ kind, id, name? }] -> the ones the bot cannot manage: [{ kind, id, name?, problem }]. Pass `config` to also refuse unsafe
// class roles.
function checkRoles(guild, entries, config = null) {
  const out = [];
  for (const e of entries) {
    if (!e || !e.id) continue;
    const problem = roleProblem(guild, e.id, config, e.kind);
    if (problem) out.push({ ...e, problem });
  }
  return out;
}

const roleLabel = (f) => `${KIND_LABEL[f.kind] || f.kind}${f.kind === 'class' && f.name ? ` ${plainClass(f.name)}` : ''}`;
const failureLine = (f) => `• Role **${roleLabel(f)}** <@&${f.id}>: ${PROBLEM_TEXT[f.problem] || f.problem}`;

// The class roles the bot may assign: [{ kind: 'class', id, name }] for every configured class that has a role.
function classRoleEntries(guild, config) {
  const out = [];
  for (const c of config.classes || []) {
    const role = findClassRole(guild, c);
    if (role) out.push({ kind: 'class', id: role.id, name: c });
  }
  return out;
}

const OWNER_REMINDER = 'Ẩn các kênh khác với @everyone (chỉ kênh welcome cho xem); role thành viên xem các kênh còn lại.';

// Lines for the /setup 🚪 view: [{ ok: bool, text }] (ok=false is a warning).
function gateHealth(config, guild) {
  const lines = [];
  const me = guild && guild.members && guild.members.me;
  if (!me) {
    lines.push({ ok: false, text: 'Bot chưa có trong server hoặc chưa tải được thông tin của bot.' });
  } else if (!me.permissions || !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    lines.push({ ok: false, text: 'Bot thiếu quyền **Quản lý vai trò** (Manage Roles): không gán / gỡ role được.' });
  } else {
    lines.push({ ok: true, text: 'Bot có quyền Quản lý vai trò.' });
  }

  if (!config.memberRoleId) {
    lines.push({ ok: false, text: 'Chưa chọn **role thành viên** (ở màn /setup chính): không duyệt được ai.' });
  } else {
    const problem = me ? roleProblem(guild, config.memberRoleId, config, 'member') : null;
    if (problem && problem !== 'no_manage_roles') lines.push({ ok: false, text: `Role **Thành viên** <@&${config.memberRoleId}>: ${PROBLEM_TEXT[problem]}.` });
    else lines.push({ ok: true, text: `Role **Thành viên**: <@&${config.memberRoleId}>` });
  }
  if (me && me.permissions && me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    for (const f of checkRoles(guild, classRoleEntries(guild, config), config)) lines.push({ ok: false, text: `Role phái **${plainClass(f.name)}** <@&${f.id}>: ${PROBLEM_TEXT[f.problem]}.` });
  }

  if (config.strangerRoleId) {
    const problem = me ? roleProblem(guild, config.strangerRoleId, config, 'stranger') : null;
    if (problem && problem !== 'no_manage_roles') lines.push({ ok: false, text: `Role **Người lạ** <@&${config.strangerRoleId}>: ${PROBLEM_TEXT[problem]}.` });
    else lines.push({ ok: true, text: `Role **Người lạ**: <@&${config.strangerRoleId}> (gán khi vào server, gỡ khi được duyệt)` });
  }

  if (config.gateChannelId) {
    const channel = guild && guild.channels && guild.channels.cache ? guild.channels.cache.get(config.gateChannelId) : null;
    if (!channel) {
      lines.push({ ok: false, text: `Kênh cổng vào <#${config.gateChannelId}>: bot không thấy kênh này.` });
    } else {
      const missing = missingPermissions(guild, channel);
      if (missing && missing.length) lines.push({ ok: false, text: `Kênh cổng vào <#${config.gateChannelId}>: bot thiếu quyền: ${missing.join(', ')}.` });
      const everyone = guild.roles && guild.roles.everyone;
      const perms = everyone && typeof channel.permissionsFor === 'function' ? channel.permissionsFor(everyone) : null;
      if (perms && !perms.has(PermissionFlagsBits.ViewChannel)) {
        lines.push({ ok: false, text: '@everyone **không xem được** kênh cổng vào: người mới sẽ không thấy bảng. Cho @everyone Xem kênh + Đọc lịch sử, không cho Gửi tin nhắn.' });
      } else if (perms && perms.has(PermissionFlagsBits.SendMessages)) {
        lines.push({ ok: false, text: '@everyone đang **gửi được tin** trong kênh cổng vào: nên tắt Gửi tin nhắn cho @everyone.' });
      } else if (perms) {
        lines.push({ ok: true, text: '@everyone xem được kênh cổng vào.' });
      }
    }
  }
  lines.push({ ok: true, text: `-# ${OWNER_REMINDER}` });
  return lines;
}

module.exports = { PRIVILEGED, unsafeRole, KIND_LABEL, PROBLEM_TEXT, OWNER_REMINDER, findClassRole, roleProblem, checkRoles, failureLine, classRoleEntries, gateHealth, roleLabel };
