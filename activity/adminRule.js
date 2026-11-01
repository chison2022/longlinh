// Who is a manager (pure). Same rule as src/bot/permissions.js isAdmin (Manage Server permission, or one of the configured admin
// roles) plus Administrator and the guild owner, which a Discord member always has. The bot version needs discord.js, this one
// works on plain REST data.
const ADMINISTRATOR = 0x8n;
const MANAGE_GUILD = 0x20n;

// member: { roles: [roleId] }; guild: { ownerId, roles: [{ id, permissions }] } (permissions = decimal string); adminRoleIds from the guild config.
function isManager({ userId, member, guild, adminRoleIds = [] }) {
  const own = new Set((member && member.roles) || []);
  if (adminRoleIds.some((id) => own.has(id))) return true;
  if (!guild) return false;
  if (guild.ownerId && guild.ownerId === userId) return true;
  for (const role of guild.roles || []) {
    // @everyone has the id of the guild and applies to everybody
    if (!own.has(role.id) && role.id !== guild.id) continue;
    let perms = 0n;
    try {
      perms = BigInt(role.permissions || '0');
    } catch {
      perms = 0n;
    }
    if (perms & (ADMINISTRATOR | MANAGE_GUILD)) return true;
  }
  return false;
}

module.exports = { isManager };
