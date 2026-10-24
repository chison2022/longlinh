// The member's ephemeral "Nhóm Tuyến Khiên" panel (pure: no Discord client, no DB).
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, UserSelectMenuBuilder } = require('discord.js');
const defaults = require('../../../config/defaults');
const { buildGroups, neighborsOf, declaredBy, groupOf, menuIds, MAX_LINKS } = require('../../services/linkService');
const { truncate, TK_MARK } = require('./common');

const LIST_MAX = 15; // names per line; the rest becomes "… và N người nữa"

// ids -> "a, b, c" with names from nameOf(id), capped.
function names(ids, nameOf) {
  const shown = ids.slice(0, LIST_MAX).map((id) => truncate(nameOf(id), 32));
  return shown.join(', ') + (ids.length > LIST_MAX ? ` … và ${ids.length - LIST_MAX} người nữa` : '');
}

// members = loadMembers result (carriers and people with links); nameOf(id) -> display name; notes = extra lines on top.
// Components: UserSelect war:tkpick (the people linked to me, max 5) + buttons war:tkcarry / war:tkclear.
// `nonce`: a different customId suffix (war:tkpick:<eid>:<nonce>) so Discord redraws the menu from its defaults (the saved links)
// instead of keeping the picks the user made locally, which matters after some picked people were rejected.
function buildTkPanel({ eid, me, members, nameOf, notes = [], nonce = null }) {
  const mine = members.find((m) => m.discordId === me);
  const carries = !!(mine && mine.tuyenKhien);
  const neighbors = neighborsOf(members, me);
  const mates = (groupOf(buildGroups(members), me) || []).filter((id) => id !== me);
  const theyDeclared = declaredBy(members, me);
  const shown = menuIds(members, me); // my own declared links first, then the people who declared me

  // steps: who the group is, then what to do (① pick the partners, ② tell the bot if you carry the passive yourself)
  const lines = [
    ...notes,
    `${TK_MARK} Nhóm Tuyến Khiên · nhóm của bạn: ${mates.length ? names(mates, nameOf) : 'chỉ mình bạn'}`,
    '① Chọn tối đa 5 người đã có Nhất Tuyến Khiên với bạn (hảo cảm ≥3000)',
    '② Nếu bạn đang trang bị nội tại Nhất Tuyến Khiên → bấm 🛡️',
  ];
  if (mates.length + 1 > defaults.partySize) lines.push(`⚠️ Nhóm có ${mates.length + 1} người, nhiều hơn 1 PT (${defaults.partySize}) — chỉ ${defaults.partySize} người cùng PT hưởng được.`);
  if (theyDeclared.length) lines.push(`📩 Đã khai bạn: ${names(theyDeclared, nameOf)} (bỏ chọn họ ở menu để gỡ liên kết)`);
  if (neighbors.length > MAX_LINKS) lines.push(`ℹ️ Menu chỉ hiện ${MAX_LINKS} người đầu; "Bỏ hết liên kết" gỡ tất cả.`);
  lines.push('-# Bỏ chọn ai thì liên kết với người đó bị gỡ cả hai phía.');

  const pick = new UserSelectMenuBuilder().setCustomId(`war:tkpick:${eid}${nonce ? `:${nonce}` : ''}`).setPlaceholder('Chọn người (tối đa 5)…').setMinValues(0).setMaxValues(MAX_LINKS);
  if (shown.length) pick.setDefaultUsers(shown);
  const button = (id, label, style, disabled = false) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
  return {
    content: truncate(lines.join('\n'), 2000),
    components: [
      new ActionRowBuilder().addComponents(pick),
      new ActionRowBuilder().addComponents(
        button(`war:tkcarry:${eid}`, `🛡️ Tôi mang Nhất Tuyến Khiên: ${carries ? 'Có' : 'Không'}`, carries ? ButtonStyle.Success : ButtonStyle.Secondary),
        button(`war:tkclear:${eid}`, 'Bỏ hết liên kết', ButtonStyle.Danger, neighbors.length === 0)
      ),
    ],
    allowedMentions: { parse: [] },
  };
}

module.exports = { buildTkPanel };
