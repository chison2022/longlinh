// lu:mine:<warId> - the "Xem PT của tôi" button under the published lineup. The answer is private (ephemeral) and mentions nobody.
const lineupService = require('../../services/lineupService');
const rules = require('../../services/lineupRules');
const { plainClass } = require('../../services/lineupStyle');
const { eph } = require('./common');
const { isId } = require('../../db');

const NOT_PLACED = 'Bạn chưa được xếp vào đội hình. Hỏi quản lý nếu bạn nghĩ có nhầm lẫn.';
const GONE = 'Chưa có đội hình cho bang chiến này.';
const NOT_PUBLISHED = 'Đội hình chưa được công bố.';

// -> the Vietnamese answer for one person.
function mineText(layout, people, userId) {
  const at = rules.locate(layout, userId);
  if (!at) return NOT_PLACED;
  const party = layout.groups[at.group][at.party];
  const lines = [`✅ Bạn ở **Nhóm ${at.group + 1} – PT ${at.party + 1}** (vị trí ${at.slot + 1}).`, '', 'Cả PT:'];
  party.forEach((id, i) => {
    const who = people[id] || { name: id, className: '' };
    lines.push(`${i + 1}. ${who.name}${who.className ? ` (${plainClass(who.className)})` : ''}${id === userId ? ' ← bạn' : ''}`);
  });
  return lines.join('\n');
}

async function mine(interaction, warId) {
  if (!isId(warId)) return interaction.reply(eph(GONE));
  const row = await lineupService.getLineup(warId);
  if (!row || row.guildId !== interaction.guildId) return interaction.reply(eph(GONE));
  if (!row.publishedLayout) return interaction.reply(eph(NOT_PUBLISHED));
  const joiners = await lineupService.listJoiners(warId);
  const people = Object.fromEntries(joiners.map((j) => [j.id, { name: j.name || j.id, className: j.className || '' }]));
  const layout = rules.filterLayout(row.publishedLayout, (id) => Boolean(people[id]));
  return interaction.reply(eph(mineText(layout, people, interaction.user.id), { allowedMentions: { parse: [] } }));
}

// lu:mine:<warId>
async function handle(interaction, parts) {
  if (parts[1] === 'mine') return mine(interaction, parts[2]);
  return undefined;
}

module.exports = { handle, mineText, NOT_PLACED, NOT_PUBLISHED };
