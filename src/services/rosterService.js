// Member roster: who has not registered, and the "danh bạ" rows. Pure shaping (plain member infos, no discord.js
// objects) plus ONE aggregation for the join counts.
const db = require('../db');
const { classFromRoles } = require('./registrationService');

const NO_CLASS = 'Chưa có role phái';

// GuildMember -> plain info. @everyone (role id = guild id) is dropped from the role names.
function memberInfo(member) {
  const roles = member.roles && member.roles.cache ? [...member.roles.cache.values()].filter((r) => r.id !== member.guild?.id && r.name !== '@everyone') : [];
  return {
    id: member.id,
    name: member.displayName || member.user.globalName || member.user.username,
    username: member.user.username,
    bot: Boolean(member.user.bot),
    roleIds: roles.map((r) => r.id),
    roleNames: roles.map((r) => r.name),
    joinedAt: member.joinedAt || null,
  };
}

// The people the bot tracks: with the member role when one is configured, else everybody; never bots.
// Holders of the "Kẻ lạ mặt" role are not guild members yet: the configured stranger role, else a role of that name.
const STRANGER_NAME = 'ke la mat';
const plainRole = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/gi, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
const isStranger = (m, config = {}) => Boolean(config.strangerRoleId && (m.roleIds || []).includes(config.strangerRoleId)) || (m.roleNames || []).some((n) => plainRole(n) === STRANGER_NAME);
const tracked = (infos, config) => infos.filter((m) => !m.bot && (!config.memberRoleId || m.roleIds.includes(config.memberRoleId)) && !isStranger(m, config));

const classOf = (info, config) => classFromRoles(info.roleNames, config.classes || []);

// Tracked members without a registration, grouped by class (config order, "Chưa có role phái" last), names sorted.
// -> { total, groups: [{ className, label, ids: [], names: [] }] }
function groupUnregistered(infos, registeredIds, config) {
  const reg = registeredIds instanceof Set ? registeredIds : new Set(registeredIds);
  const missing = tracked(infos, config).filter((m) => !reg.has(m.id));
  const by = new Map();
  for (const m of missing) {
    const k = classOf(m, config) || null;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(m);
  }
  const order = [...(config.classes || []), null];
  const groups = order
    .filter((k) => by.has(k))
    .map((k) => {
      const list = by.get(k).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
      return { className: k, label: k || NO_CLASS, ids: list.map((m) => m.id), names: list.map((m) => m.name) };
    });
  return { total: missing.length, groups };
}

module.exports = { NO_CLASS, memberInfo, isStranger, tracked, groupUnregistered };
