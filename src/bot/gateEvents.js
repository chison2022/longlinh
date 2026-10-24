// Gateway events of the new-member gate. Joining gives the "Người lạ" role (GuildConfig.strangerRoleId) to someone who has no role
// yet, nothing else (the channel permissions do the hiding, set by hand by the owner); existing members are never touched.
// Leaving cancels the member's pending request.
const { getConfig, isOn } = require('../services/guildConfigService');
const gateService = require('../services/gateService');
const { buildDecidedCard } = require('./ui/gate');
const { editCard } = require('./gateCard');
const { roleProblem } = require('./gateRoles');
const { logEvent } = require('../eventLog');

async function onGateMemberAdd(member) {
  try {
    if (!member || !member.guild || (member.user && member.user.bot)) return;
    const config = await getConfig(member.guild.id);
    if (!config || !isOn(config, 'gate')) return;
    let stranger;
    if (config.strangerRoleId) {
      const held = member.roles && member.roles.cache ? [...member.roles.cache.keys()].filter((id) => id !== member.guild.id) : [];
      const problem = roleProblem(member.guild, config.strangerRoleId, config, 'stranger');
      if (held.length) stranger = 'has_roles'; // came back with roles (or another bot was faster): left alone
      else if (problem) stranger = problem;
      else {
        try {
          await member.roles.add(config.strangerRoleId, 'Gate: người lạ mới vào server');
          stranger = 'added';
        } catch (err) {
          stranger = 'failed';
          console.warn('[gate] cannot give the stranger role:', err.message);
        }
      }
    }
    logEvent('gate', 'join', { guild: member.guild.id, user: member.id, ...(stranger ? { stranger } : {}), ...(stranger && !['added', 'has_roles'].includes(stranger) ? { lvl: 'warn' } : {}) });
  } catch (err) {
    console.error('[gate] guildMemberAdd:', err.message);
  }
}

// Works whether or not the gate is on: a pending request can outlive a switch-off.
async function onGateMemberRemove(member) {
  try {
    if (!member || !member.guild || (member.user && member.user.bot)) return;
    const request = await gateService.decidePendingOf(member.guild.id, member.id, 'cancelled', { reason: 'đã rời server' });
    if (!request) return;
    logEvent('gate', 'cancel', { guild: member.guild.id, user: member.id, rid: String(request._id), reason: 'left' });
    await editCard(member.client || member.guild.client, request, (texts) => buildDecidedCard({ texts, kind: 'cancelled', text: `<@${request.discordId}> đã rời server, yêu cầu tự huỷ.` }));
  } catch (err) {
    console.error('[gate] guildMemberRemove:', err.message);
  }
}

module.exports = { onGateMemberAdd, onGateMemberRemove };
