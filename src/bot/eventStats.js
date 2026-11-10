// Numbers shown on the war message and on the admin dashboard.
const defaults = require('../../config/defaults');
const { summarize, classId } = require('../services/registrationService');
const { layoutOf, partyCount } = require('../services/teamService');
const { memberInfo, groupUnregistered, tracked } = require('../services/rosterService');
const { isComplete } = require('./memberCache');

// Plain infos of the cached members when the member role is set and the cache is known to be complete, else null (a partial
// cache would show a wrong number).
function completeInfos(guild, config) {
  if (!config || !config.memberRoleId || !guild || !guild.members || !guild.members.cache || !isComplete(guild)) return null;
  return [...guild.members.cache.values()].map(memberInfo);
}

// True when the member role is set, the cache is complete and nobody (bots aside) holds the role: nothing to count or remind.
function roleIsEmpty(guild, config, infos = completeInfos(guild, config)) {
  return infos !== null && tracked(infos, config).length === 0;
}

// Members with the member role who have not registered; null when it cannot be known (no member role, the member cache is not
// known to be complete, or the role has no member at all: a count of 0 there would only look like "everybody registered").
function unregisteredCount(guild, config, regs, infos = completeInfos(guild, config)) {
  if (!infos || tracked(infos, config).length === 0) return null;
  return groupUnregistered(infos, regs.map((r) => r.discordId), config).total;
}

// 10-cell bar: ▰▰▱▱▱▱▱▱▱▱ (at least one ▰ when value > 0)
function progressBar(value, max, cells = 10) {
  const raw = max > 0 ? Math.min(cells, Math.max(0, Math.round((value / max) * cells))) : 0;
  const filled = value > 0 && max > 0 ? Math.max(1, raw) : raw; // someone joined: never an empty-looking bar
  return '▰'.repeat(filled) + '▱'.repeat(cells - filled);
}

// -> { join, absent, capacity, byClass: [{ className, count }], missing: [{ label, have, needed }], unregistered }
// `config` = guild config ({ classes, groupCount }); `unregistered` = number | null (see unregisteredCount).
function eventStats(event, regs, config, { unregistered = null } = {}) {
  const layout = layoutOf(config);
  const capacity = partyCount(layout) * layout.partySize;
  const s = summarize(regs, (config && config.classes) || defaults.classes);
  const join = s.join;
  const needed = Math.min(Math.ceil(join / layout.partySize), partyCount(layout));
  const have = (cls) => regs.filter((r) => r.status === 'join' && r.className && classId(r.className) === classId(cls)).length;
  const missing = needed
    ? [defaults.healerClass, defaults.tankClass].map((label) => ({ label, have: have(label), needed })).filter((m) => m.have < m.needed)
    : [];
  return {
    join,
    absent: s.absent,
    capacity,
    byClass: s.byClass.map((c) => ({ className: c.className, count: c.join })).filter((c) => c.count > 0),
    missing,
    unregistered,
  };
}

const missingLine = (m) => `⚠️ Thiếu ${m.label}: ${m.have}/${m.needed} PT`;

module.exports = { completeInfos, unregisteredCount, roleIsEmpty, progressBar, eventStats, missingLine };
