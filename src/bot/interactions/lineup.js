// lu:mine:<warId> - the "Xem PT của tôi" button under the published lineup. The answer is private (ephemeral) and mentions nobody.
const lineupService = require('../../services/lineupService');
const rules = require('../../services/lineupRules');
const { plainClass } = require('../../services/lineupStyle');
const { MessageFlags } = require('discord.js');
const { eph } = require('./common');
const { isId } = require('../../db');
const actBridge = require('../actBridge');

const NOT_PLACED = 'Bạn chưa được xếp vào đội hình. Hỏi quản lý nếu bạn nghĩ có nhầm lẫn.';
const GONE = 'Chưa có đội hình cho bang chiến này.';
const NOT_PUBLISHED = 'Đội hình chưa được công bố.';
const UNAVAILABLE = '⏳ Chưa xem được lúc này (kho dữ liệu của bảng xếp đội đang bận). Thử lại sau ít phút.';

// snapshot = { tasks, notes, names } of rules.readSnapshot (older publishes have none: no task lines).
// -> the Vietnamese answer for one person.
function mineText(layout, people, userId, snapshot = {}) {
  const at = rules.locate(layout, userId);
  if (!at) return NOT_PLACED;
  const { tasks = {}, notes = {}, names = {} } = snapshot;
  const taskOf = (id) => (tasks[id] && names[tasks[id]] ? names[tasks[id]].label : '');
  const party = layout.groups[at.group][at.party];
  const lines = [`✅ Bạn ở **Nhóm ${at.group + 1} – PT ${at.party + 1}** (vị trí ${at.slot + 1}).`];
  lines.push(taskOf(userId) ? `🎯 Nhiệm vụ của bạn: **${taskOf(userId)}**` : '🎯 Nhiệm vụ: chưa giao');
  const note = rules.cleanNote(notes[`${at.group}-${at.party}`]);
  if (note) lines.push(`📝 Ghi chú PT: ${note}`);
  lines.push('', 'Cả PT:');
  party.forEach((id, i) => {
    const who = people[id] || { name: id, className: '' };
    const extra = [who.className ? plainClass(who.className) : '', taskOf(id)].filter(Boolean).join(' · ');
    lines.push(`${i + 1}. ${who.name}${extra ? ` (${extra})` : ''}${id === userId ? ' ← bạn' : ''}`);
  });
  return lines.join('\n');
}

async function mine(interaction, warId) {
  if (!isId(warId)) return interaction.reply(eph(GONE));
  // Discord wants an answer within 3 s: with the side database down (or asleep, or not connected yet) say so at once and reconnect in the background
  if (!actBridge.isUp()) {
    actBridge.ensureUp().catch(() => {});
    return interaction.reply(eph(UNAVAILABLE));
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const say = (content) => interaction.editReply({ content, allowedMentions: { parse: [] } });
  let row;
  let joiners;
  try {
    row = await lineupService.getLineup(warId);
    // the published layout may hold people who were removed afterwards: their names are still needed
    joiners = row ? [...(await lineupService.listMembers(warId)), ...(await lineupService.listMembers(warId, { removed: true }))] : [];
  } catch (err) {
    console.error('[lineup] side database:', err && err.message);
    return say(UNAVAILABLE);
  }
  if (!row || row.guildId !== interaction.guildId) return say(GONE);
  const snap = rules.readSnapshot(row.publishedLayout);
  if (!snap) return say(NOT_PUBLISHED);
  const people = Object.fromEntries(joiners.map((j) => [j.id, { name: j.name || j.id, className: j.className || '' }]));
  const layout = rules.filterLayout(snap.layout, (id) => Boolean(people[id]));
  return say(mineText(layout, people, interaction.user.id, snap));
}

// lu:mine:<warId>
async function handle(interaction, parts) {
  if (parts[1] === 'mine') return mine(interaction, parts[2]);
  return undefined;
}

module.exports = { handle, mineText, NOT_PLACED, NOT_PUBLISHED, UNAVAILABLE };
