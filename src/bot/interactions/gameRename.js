// ✏️ Đổi tên: a manager confirms that a character the latest import no longer lists and a new one are the same person (renamed in
// game). The bot never does it on its own. Called from admin.js after the admin gate.
// adm:gren (opens the view, new ephemeral reply) | adm:gren:r (back to the first step, in place) | adm:grenpair (a suggested pair)
// | adm:grenold (the old name) -> adm:grennew:<oldId> (the new name) -> adm:grenok:<oldId>:<newId> (confirm). Ids = game_characters ids.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, escapeMarkdown } = require('discord.js');
const gameRoster = require('../../services/gameRosterService');
const { truncate } = require('../ui/common');
const { formatLocalDateTime } = require('../../utils/time');
const { invalidateGameNames } = require('../gameNames');
const { schedulePanelRefresh } = require('../refresher');
const { scheduleSync } = require('../sheetSync');
const { logEvent, ixCtx } = require('../../eventLog');

const esc = (s) => escapeMarkdown(String(s || ''));
const day = (d) => (d ? formatLocalDateTime(new Date(d)).split(' ')[0] : '?');
const label = (c) => truncate(c.name, 100);
const leftDesc = (c) => truncate(`${c.className || '—'} · ${c.daysInGuild} ngày · rời ${day(c.leftAt)}`, 100);
const freshDesc = (c) => truncate(`${c.className || '—'} · ${c.daysInGuild} ngày · mới thấy ${day(c.firstSeen)}`, 100);
const isId = (v) => /^[0-9]{1,18}$/.test(String(v || ''));
const back = () => new ButtonBuilder().setCustomId('adm:gren:r').setLabel('↩ Chọn lại').setStyle(ButtonStyle.Secondary);
const HELP = '-# Chỉ dùng khi chắc đó là cùng một người: tên mới thay vào nhân vật cũ, tên cũ được giữ lại, liên kết Discord và lịch sử báo danh giữ nguyên.';

// First step: the suggested pairs (fastest), or any name that left.
function firstView(choices, note = null) {
  const { left, fresh, pairs } = choices;
  const lines = ['✏️ **Đổi tên nhân vật**'];
  if (note) lines.unshift(note, '');
  if (!left.length) lines.push('Không có nhân vật nào rời bang trong 60 ngày qua.');
  else if (!fresh.length) lines.push('Lần cập nhật danh sách gần nhất không có tên mới nào để ghép.');
  else {
    lines.push(pairs.length ? `Gợi ý (cùng phái, số ngày trong bang khớp): ${pairs.map((p) => `${esc(p.from.name)} → ${esc(p.to.name)}`).join(', ')}` : 'Không có cặp nào khớp chắc — chọn tay bên dưới.');
  }
  lines.push(HELP);
  const rows = [];
  if (pairs.length) {
    rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('adm:grenpair').setPlaceholder('Chọn nhanh một cặp gợi ý').addOptions(
      pairs.slice(0, 25).map((p) => ({ label: truncate(`${p.from.name} → ${p.to.name}`, 100), description: truncate(`${p.to.className || '—'} · ${p.from.daysInGuild} → ${p.to.daysInGuild} ngày`, 100), value: `${p.from.id}:${p.to.id}` }))
    )));
  }
  if (left.length && fresh.length) {
    rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('adm:grenold').setPlaceholder('Hoặc chọn tên CŨ (đã rời bang)').addOptions(
      left.slice(0, 25).map((c) => ({ label: label(c), description: leftDesc(c), value: String(c.id) }))
    )));
  }
  return { content: lines.join('\n'), components: rows, allowedMentions: { parse: [] } };
}

// Second step: the new name for `old`; the same class first, then by closeness of the days in the guild.
function newView(choices, old) {
  const fresh = [...choices.fresh].sort((a, b) => (a.className !== old.className) - (b.className !== old.className) || Math.abs(a.daysInGuild - old.daysInGuild) - Math.abs(b.daysInGuild - old.daysInGuild));
  return {
    content: `✏️ Tên cũ: **${esc(old.name)}** (${esc(old.className || '—')} · ${old.daysInGuild} ngày · rời ${day(old.leftAt)}).\nChọn tên MỚI trong danh sách game:\n${HELP}`,
    components: [
      new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`adm:grennew:${old.id}`).setPlaceholder('Tên mới').addOptions(fresh.slice(0, 25).map((c) => ({ label: label(c), description: freshDesc(c), value: String(c.id) })))),
      new ActionRowBuilder().addComponents(back()),
    ],
    allowedMentions: { parse: [] },
  };
}

function confirmView(old, neu) {
  let warn = old.className && neu.className && old.className !== neu.className ? `\n⚠️ Khác phái (${esc(old.className)} → ${esc(neu.className)}): kiểm tra kỹ.` : '';
  if (old.linked && neu.linked) warn += `\n⚠️ Cả hai tên đều đang liên kết Discord: giữ liên kết của **${esc(old.name)}**, liên kết của **${esc(neu.name)}** sẽ bị gỡ.`;
  return {
    content: `Xác nhận **${esc(old.name)}** đã đổi tên thành **${esc(neu.name)}**?${warn}\n${HELP}`,
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`adm:grenok:${old.id}:${neu.id}`).setLabel('✅ Xác nhận đổi tên').setStyle(ButtonStyle.Primary), back())],
    allowedMentions: { parse: [] },
  };
}

const find = (list, id) => list.find((c) => String(c.id) === String(id)) || null;
const GONE = 'Danh sách vừa thay đổi — chọn lại.';

// parts = customId split on ':'
async function handle(interaction, parts) {
  const guildId = interaction.guildId;
  const action = parts[1];
  const choices = await gameRoster.renameChoices(guildId);
  if (action === 'gren') return interaction.editReply(firstView(choices));
  if (action === 'grenpair' || action === 'grennew') {
    const [oldId, newId] = action === 'grenpair' ? String(interaction.values[0]).split(':') : [parts[2], interaction.values[0]];
    const old = isId(oldId) && find(choices.left, oldId);
    const neu = isId(newId) && find(choices.fresh, newId);
    if (!old || !neu) return interaction.editReply(firstView(choices, GONE));
    return interaction.editReply(confirmView(old, neu));
  }
  if (action === 'grenold') {
    const old = find(choices.left, interaction.values[0]);
    return interaction.editReply(old && choices.fresh.length ? newView(choices, old) : firstView(choices, GONE));
  }
  if (action === 'grenok') {
    if (!isId(parts[2]) || !isId(parts[3])) return interaction.editReply(firstView(choices, GONE));
    const out = await gameRoster.renameCharacter(guildId, parts[2], parts[3]);
    logEvent('roster', 'rename', { ...ixCtx(interaction), ok: !out.error });
    if (out.error) return interaction.editReply(firstView(choices, `❌ ${out.error}`));
    invalidateGameNames(guildId);
    scheduleSync(interaction.client, guildId);
    schedulePanelRefresh(interaction.client, guildId);
    return interaction.editReply(firstView(await gameRoster.renameChoices(guildId), `✅ **${esc(out.from)}** → **${esc(out.to)}**: đã gộp vào một nhân vật (tên cũ được giữ, liên kết giữ nguyên).`));
  }
  return interaction.editReply(firstView(choices));
}

module.exports = { handle, firstView, newView, confirmView };
