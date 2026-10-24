const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, escapeMarkdown } = require('discord.js');
const { truncate, textDisplay, v2Payload, V2_TEXT_LIMIT } = require('./common');
const { styleOf } = require('../classStyle');
const { MEMBERS_WARNING } = require('../memberCache');
const { sameClass } = require('../../services/registrationService');
const { discordTs } = require('../../utils/time');
const defaults = require('../../../config/defaults');

const NAME_MAX = 24;
const TEXT_BUDGET = V2_TEXT_LIMIT - 100; // all text displays together; what does not fit becomes "… +k người" per line
const NO_MEMBERS = '⚠️ Role thành viên chưa có ai — vào /setup chọn role thành viên.'; // the role is set but nobody has it
const NO_ROLE = '⚠️ Chưa chọn role thành viên — vào /setup chọn role thành viên để bot biết ai cần đăng ký.'; // no role set at all
const GREEN = 0x2ecc71;
const GREY = 0x95a5a6;
const ORANGE = 0xe67e22;

const button = (id, label, style = ButtonStyle.Secondary, disabled = false) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);

// Display / game names are user text: break anything that looks like a mention (<@id>, <@&id>, <#id>, @everyone, @here) with a zero-width space.
const ZWSP = '​';
const defang = (s) => String(s).replace(/<(?=[@#])/g, `<${ZWSP}`).replace(/@(?=everyone|here)/gi, `@${ZWSP}`);

const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().trim();

// grouped -> { inGame, notInGame }: the same { total, groups } shape, each person in one of the two by `inGame` (Set of discord ids
// that match somebody in the game roster, by name or by hand).
function splitByGame(grouped, inGame) {
  const part = (keep) => {
    const groups = grouped.groups
      .map((g) => {
        const idx = g.ids.map((id, i) => (keep(id) ? i : -1)).filter((i) => i >= 0);
        return { ...g, ids: idx.map((i) => g.ids[i]), names: idx.map((i) => g.names[i]) };
      })
      .filter((g) => g.ids.length);
    return { total: groups.reduce((n, g) => n + g.ids.length, 0), groups };
  };
  return { inGame: part((id) => inGame.has(id)), notInGame: part((id) => !inGame.has(id)) };
}

// Healer (Tố Vấn) and tank (Thiết Y) first, then the config order, "Chưa có role phái" last.
function ordered(groups) {
  const rank = (g) => (!g.className ? 3 : sameClass(g.className, defaults.healerClass) ? 0 : sameClass(g.className, defaults.tankClass) ? 1 : 2);
  return groups.map((g, i) => ({ g, i })).sort((a, b) => rank(a.g) - rank(b.g) || a.i - b.i).map((x) => x.g);
}

// "head: a, b, c" within `cap` chars; the names that do not fit become "… +k người".
function fitLine(head, entries, cap) {
  const prefix = `${head}: `;
  const full = prefix + entries.join(', ');
  if (full.length <= cap) return full;
  let out = prefix;
  let shown = 0;
  for (const e of entries) {
    const next = shown ? `${out}, ${e}` : `${out}${e}`;
    if (`${next}, … +${entries.length - shown - 1} người`.length > cap) break;
    out = next;
    shown++;
  }
  return shown ? `${out}, … +${entries.length - shown} người` : `${prefix}… +${entries.length} người`;
}

function entryName(name, id, gameNames) {
  const own = escapeMarkdown(defang(truncate(name, NAME_MAX)));
  const game = gameNames && gameNames.get(id);
  return game && fold(game) !== fold(name) ? `${own} (${escapeMarkdown(defang(truncate(game, NAME_MAX)))})` : own;
}

// One block as { head: [heading, optional "-#" line], lines: one per class }.
function blockParts(title, note, section, styles, gameNames, cap) {
  const lines = ordered(section.groups).map((g) => {
    const head = g.className ? `${styleOf(styles, g.className).emojiText} ${styleOf(styles, g.className).plain}` : `❔ ${g.label}`;
    return fitLine(defang(head), g.names.map((n, i) => entryName(n, g.ids[i], gameNames)), cap);
  });
  return { head: [`**${title} (${section.total})**`, note ? `-# ${note}` : null].filter(Boolean), lines, dropped: 0 };
}

const renderBlock = (p) => [...p.head, ...p.lines, ...(p.dropped ? [`… và ${p.dropped} phái nữa`] : [])].join('\n');

// Hard cap: when even the shortest lines do not fit, whole class lines go from the end (last block first), each block
// ending with "… và k phái nữa".
function capBlocks(parts, fixedLen, budget) {
  const total = () => fixedLen + parts.reduce((n, p) => n + renderBlock(p).length, 0);
  for (let i = parts.length - 1; i >= 0 && total() > budget; i--) {
    while (parts[i].lines.length && total() > budget) {
      parts[i].lines.pop();
      parts[i].dropped++;
    }
  }
  return parts.map(renderBlock);
}

const buttonsRow = (...b) => new ActionRowBuilder().addComponents(...b);

// A V2 message with just a text (and a way back to the list): the answers of the ping step ("đã đóng", "đã nhắc"...).
// A V2 message cannot go back to plain content, so even these answers are V2.
function buildUnregNotice(text, { back = true } = {}) {
  const parts = [textDisplay(text)];
  if (back) parts.push(buttonsRow(button('adm:unreg:r', '↩ Quay lại')));
  return v2Payload(parts);
}

// grouped = rosterService.groupUnregistered result. Components V2 (ephemeral): ≤4000 chars of text, ≤40 components.
// inGame (Set of discord ids that match somebody in the game roster) null = no roster imported: ONE block. gameNames = Map(id -> game name).
// trackedCount = people with the member role (tells "everybody registered" from "the role has nobody").
// confirm = 'in' | 'all' shows the "Nhắc N người?" step instead of the buttons.
// customIds: adm:unreg:r (refresh / cancel), adm:unregping:<eid>[:g] (ask: all / only the people in the guild), adm:unregok:<eid>[:g]
// (send), adm:gmap (the name-pairing view as a new ephemeral).
function buildUnregView(event, grouped, { styles, confirm = null, incomplete = false, inGame = null, gameNames = null, memberRoleId = null, trackedCount = null } = {}) {
  const eid = String(event._id);
  const split = inGame ? splitByGame(grouped, inGame) : null;
  const stamp = event.deadlineAt ? ` · chốt ${discordTs(new Date(event.deadlineAt), 't')} (${discordTs(new Date(event.deadlineAt), 'R')})` : '';
  const roleEmpty = !grouped.total && !incomplete && trackedCount === 0;
  const notes = [];
  if (roleEmpty) notes.push(NO_MEMBERS);
  else if (grouped.total) notes.push(`**${grouped.total}** người có role ${memberRoleId ? `<@&${memberRoleId}>` : 'thành viên'} chưa bấm Tham gia/Vắng.`);
  else if (incomplete) notes.push('❔ Chưa xác định được ai chưa đăng ký.');
  else notes.push('🎉 Mọi thành viên đã đăng ký.');
  if (incomplete) notes.push(MEMBERS_WARNING);
  const head = `### 👥 Chưa đăng ký · ${defang(truncate(event.title, 80))}${stamp}\n${notes.join('\n')}`;

  const pingTotal = split ? split.inGame.total : 0;
  const blocks = []; // { title, note, section, color, names, pingable }
  if (!split) {
    if (grouped.total) blocks.push({ title: '⏳ CHƯA ĐĂNG KÝ', note: null, section: grouped, color: ORANGE, names: null, pingable: false });
  } else {
    if (split.inGame.total) {
      blocks.push({ title: '✅ ĐANG Ở BANG – NÊN NHẮC', note: 'Bot đã xác định được nhân vật trong game của những người này.', section: split.inGame, color: GREEN, names: gameNames, pingable: true });
    }
    if (split.notInGame.total) {
      blocks.push({ title: '❔ CHƯA BIẾT LÀ AI TRONG GAME', note: 'Tên Discord không khớp ai trong bang → cần ghép tên, hoặc đã rời bang.', section: split.notInGame, color: GREY, names: null, pingable: false });
    }
  }
  const shown = confirm === 'in' ? blocks.filter((b) => b.pingable) : blocks;
  let partsList = [];
  for (let cap = 900; cap >= 80; cap -= 40) {
    partsList = shown.map((b) => blockParts(b.title, b.note, b.section, styles, b.names, cap));
    if (head.length + partsList.reduce((n, p) => n + renderBlock(p).length, 0) <= TEXT_BUDGET) break;
  }
  const texts = capBlocks(partsList, head.length, TEXT_BUDGET);

  const parts = [];
  if (confirm) {
    const n = confirm === 'in' ? pingTotal : grouped.total;
    const who = confirm === 'in' ? 'đang ở bang (đã xác định được nhân vật trong game)' : split ? 'chưa đăng ký (cả những người chưa xác định được trong game)' : 'chưa đăng ký';
    parts.push(textDisplay(`📣 Nhắc **${n}** người ${who} ở kênh thông báo?\n${head.split('\n')[0].replace(/^### /, '')}`));
  } else {
    parts.push(textDisplay(head));
  }
  shown.forEach((b, i) => parts.push(new ContainerBuilder().setAccentColor(b.color).addTextDisplayComponents(textDisplay(texts[i]))));

  if (confirm) {
    parts.push(buttonsRow(button(`adm:unregok:${eid}${confirm === 'in' ? ':g' : ''}`, '✅ Gửi', ButtonStyle.Success), button('adm:unreg:r', 'Huỷ')));
  } else {
    const off = event.status !== 'open';
    const row = [];
    if (pingTotal > 0) row.push(button(`adm:unregping:${eid}:g`, `📣 Nhắc ${pingTotal} người ở bang`, ButtonStyle.Primary, off));
    if (grouped.total > 0) row.push(button(`adm:unregping:${eid}`, `📣 Nhắc tất cả ${grouped.total}`, pingTotal > 0 ? ButtonStyle.Secondary : ButtonStyle.Primary, off));
    row.push(button('adm:gmap', '🔗 Ghép tên'), button('adm:unreg:r', '🔄 Làm mới'));
    parts.push(buttonsRow(...row));
  }
  return v2Payload(parts);
}

module.exports = { buildUnregView, buildUnregNotice, splitByGame, NO_MEMBERS, NO_ROLE };
