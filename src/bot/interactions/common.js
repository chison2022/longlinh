const { MessageFlags } = require('discord.js');
const guildConfigService = require('../../services/guildConfigService');

const NO_PERMISSION = '⛔ Bạn không có quyền dùng chức năng này.';

function eph(content, extra = {}) {
  return { content, flags: MessageFlags.Ephemeral, ...extra };
}

function displayNameOf(interaction) {
  const m = interaction.member;
  return (m && (m.displayName || m.nick)) || interaction.user.globalName || interaction.user.username;
}

// Names of the clicking member's roles: a GuildMemberRoleManager when the member is cached, else a raw array of role ids.
function roleNamesOf(interaction) {
  const roles = interaction.member && interaction.member.roles;
  if (!roles) return [];
  if (Array.isArray(roles)) {
    const cache = interaction.guild && interaction.guild.roles.cache;
    return cache ? roles.map((id) => cache.get(id)?.name).filter(Boolean) : [];
  }
  return roles.cache.map((r) => r.name);
}

module.exports = { NO_PERMISSION, eph, displayNameOf, roleNamesOf };
