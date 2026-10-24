// Member names shown to people are the SERVER profile name (nickname -> global display name -> username) as Discord has
// it right now. The stored name (Registration/Member.displayName) is only the fallback for people not in the cache
// (left the server, cold cache, tests); guildMemberUpdate keeps the stored copies fresh too.

// Pure: the cached member's displayName, else the stored name.
function liveName(guild, discordId, storedName) {
  const member = guild && guild.members && guild.members.cache && guild.members.cache.get(discordId);
  return (member && member.displayName) || storedName;
}

// id -> live name, only for ids whose member is cached.
function namesFor(guild, ids) {
  const names = new Map();
  for (const id of ids) {
    const name = liveName(guild, id, null);
    if (name) names.set(id, name);
  }
  return names;
}

// Pure: registrations with displayName replaced by names.get(discordId) when present (input is not mutated).
function withNames(regs, names) {
  if (!names || !names.size) return regs;
  return regs.map((r) => (names.has(r.discordId) ? { ...r, displayName: names.get(r.discordId) } : r));
}

// Registrations rendered with live names.
const liveRegs = (guild, regs) => withNames(regs, namesFor(guild, regs.map((r) => r.discordId)));

module.exports = { liveName, namesFor, withNames, liveRegs };
