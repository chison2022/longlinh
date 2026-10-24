const { PermissionFlagsBits, PermissionsBitField } = require('discord.js');

function memberRoleIds(member) {
  if (!member || !member.roles) return [];
  if (Array.isArray(member.roles)) return member.roles; // uncached APIInteractionGuildMember
  if (member.roles.cache) return [...member.roles.cache.keys()];
  return [];
}

function hasManageGuild(permissions) {
  if (!permissions) return false;
  if (typeof permissions.has === 'function') return permissions.has(PermissionFlagsBits.ManageGuild);
  return new PermissionsBitField(BigInt(permissions)).has(PermissionFlagsBits.ManageGuild);
}

// Admin = Manage Server permission, or any of the configured admin roles.
// `permissions` defaults to member.permissions (pass interaction.memberPermissions when available).
function isAdmin(member, config, permissions = member && member.permissions) {
  if (hasManageGuild(permissions)) return true;
  const adminRoles = (config && config.adminRoleIds) || [];
  if (adminRoles.length === 0) return false;
  const roles = new Set(memberRoleIds(member));
  return adminRoles.some((id) => roles.has(id));
}

module.exports = { isAdmin, memberRoleIds };
