// Who is a manager (pure), from the snapshot the bot took of the guild (act_guilds): the guild owner, or anybody holding one of the
// configured admin roles or a role with Administrator / Manage Server (the bot worked those roles out from its guild cache).
// member: { roles: [roleId] } as the user's own OAuth token reads it; guild: { ownerId, adminRoleIds, managerRoleIds }.
function isManager({ userId, member, guild }) {
  if (!guild) return false;
  if (guild.ownerId && guild.ownerId === userId) return true;
  const own = new Set((member && member.roles) || []);
  return [...(guild.adminRoleIds || []), ...(guild.managerRoleIds || [])].some((id) => own.has(id));
}

module.exports = { isManager };
