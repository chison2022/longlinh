// Member-facing "Liên kết tên trong game" (pure: no Discord client, no DB). customIds (not admin-gated):
// gn:open (the persistent panel button / the nudge after ✅ Tham gia) | gn:me | gn:change (compact view -> full picker) | gn:p:<page>:<ver> (◀ ▶) | gn:pick:<page>:<ver> (the select; value =
// position in the latest roster, <ver> = rosterVersion of the roster it was drawn from) | gn:free (modal gn:freeModal) | gn:unlink | gn:uid (modal gn:uidModal: the member's in-game character ID).
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, StringSelectMenuBuilder, escapeMarkdown } = require('discord.js');
const { truncate, textDisplay, v2Payload } = require('./common');

// All owner-facing wording in one place.
const LABELS = {
  open: '🎮 Chọn nhân vật của tôi',
  me: '👤 Xem nhân vật đã liên kết',
  uid: '🆔 Nhập ID game',
  free: '✏️ Tên tôi không có trong danh sách',
  unlink: 'Gỡ liên kết',
  change: '🔄 Đổi nhân vật',
  adminOwned: 'Nhờ quản lý nếu cần đổi',
  title: '### 🎮 Liên kết tên trong game',
  intro: 'Chọn nhân vật trong game của bạn để quản lý xếp đội đúng người. Đổi lại lúc nào cũng được.',
  placeholder: 'Chọn nhân vật của bạn trong game…',
};

const PAGE_SIZE = 25;
const SOURCE_TEXT = { admin: 'do quản lý gán', self: 'bạn tự chọn', selfFree: 'bạn tự nhập, chờ quản lý kiểm tra' };

const button = (id, label, style = ButtonStyle.Secondary, disabled = false) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
const clampPage = (page, pages) => Math.min(Math.max(Number(page) || 0, 0), Math.max(pages - 1, 0));

// The persistent message an admin posts in a channel (edited in place). For channel.send (v2Create) or an edit.
function buildGnPanel() {
  const container = new ContainerBuilder()
    .setAccentColor(0x1e3a8a)
    .addTextDisplayComponents(textDisplay(`${LABELS.title}\n${LABELS.intro}`))
    .addActionRowComponents(new ActionRowBuilder().addComponents(button('gn:open', LABELS.open, ButtonStyle.Primary), button('gn:me', LABELS.me), button('gn:uid', LABELS.uid)));
  return v2Payload([container]);
}

const COMPACT_SOURCE = { admin: 'quản lý gán', self: 'bạn tự chọn', selfFree: 'bạn tự nhập, chờ quản lý kiểm tra' };
const memberOwned = (link) => Boolean(link) && (link.source === 'self' || link.source === 'selfFree');

// The line "you are X in game" / "not linked yet" (compact wording, also used by gn:me).
function linkLine(link) {
  if (!link) return 'Bạn **chưa liên kết** nhân vật nào trong game.';
  return `✅ Bạn đang là **${escapeMarkdown(truncate(link.gameName, 60))}** trong game.\n-# ${COMPACT_SOURCE[link.source] || COMPACT_SOURCE.admin}`;
}

// gn:me: the link line plus the saved in-game ID (or how to add it).
const meLine = (link) => (link ? `${linkLine(link)}\n${link.gameUid ? `🆔 ID game: ${link.gameUid}` : `🆔 Chưa có ID game — bấm ${LABELS.uid}`}` : linkLine(null));

// The full picker's status line (the member may be about to change the link).
const currentLine = (link) => (link ? `Bạn đang là **${escapeMarkdown(truncate(link.gameName, 60))}** trong game (${SOURCE_TEXT[link.source] || SOURCE_TEXT.admin}).` : linkLine(null));

// Linked member: only the result + "Đổi nhân vật" (full picker) + "Gỡ liên kết"; an admin-owned link has neither button.
function buildCompact(link) {
  const lines = [linkLine(link)];
  const buttons = [];
  if (memberOwned(link)) buttons.push(button('gn:change', LABELS.change), button('gn:unlink', LABELS.unlink));
  else lines.push(`-# ${LABELS.adminOwned}`);
  return { content: truncate(lines.join('\n'), 2000), components: buttons.length ? [new ActionRowBuilder().addComponents(...buttons)] : [], allowedMentions: { parse: [] } };
}

// The roster select of one page + its ◀ ▶ buttons, shared with the new-member gate (prefix 'gate'): the customIds are
// `<prefix>:pick:<page>:<ver>` (value = position in the latest roster) and `<prefix>:p:<page>:<ver>`.
// ranked = [{ game, score, index }] best first. -> { p, pages, line, row, nav }
function rosterSelect(ranked, page, ver, prefix = 'gn') {
  const pages = Math.max(1, Math.ceil(ranked.length / PAGE_SIZE));
  const p = clampPage(page, pages);
  const nav = [];
  if (pages > 1) nav.push(button(`${prefix}:p:${Math.max(p - 1, 0)}:${ver}`, '◀', ButtonStyle.Secondary, p === 0), button(`${prefix}:p:${Math.min(p + 1, pages - 1)}:${ver}`, '▶', ButtonStyle.Secondary, p === pages - 1));
  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${prefix}:pick:${p}:${ver}`)
      .setPlaceholder(LABELS.placeholder)
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        ranked.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE).map((c) => {
          const about = [c.game.className, c.game.rank, c.score > 0 ? `giống ${Math.round(c.score * 100)}%` : null].filter(Boolean).join(' · ');
          return { label: truncate(c.game.name, 100), value: String(c.index), ...(about ? { description: truncate(about, 100) } : {}) };
        })
      )
  );
  return { p, pages, line: `Chọn nhân vật của bạn (giống tên Discord nhất xếp trước${pages > 1 ? `, trang ${p + 1}/${pages}` : ''}):`, row, nav };
}

// The ephemeral picker. link = { gameName, source } | null; ranked = [{ game, score, index }] (index = position in the roster) of the
// names the member may take, best first; ver = roster version; hasRoster=false -> only the free-text button.
function buildPicker({ link = null, ranked = [], page = 0, ver = '0', hasRoster = true, note = null, compact = false } = {}) {
  if (compact && link) return buildCompact(link);
  const lines = [LABELS.title.replace('### ', '**') + '**', currentLine(link)];
  if (note) lines.push(note);
  const rows = [];
  let nav = [];
  if (!hasRoster) {
    lines.push('Quản lý chưa nhập danh sách thành viên game — bạn có thể tự nhập tên nhân vật.');
  } else if (!ranked.length) {
    lines.push('Không còn tên nào trong danh sách game để chọn (đã có người liên kết) — bấm “Tên tôi không có trong danh sách” để nhập tay.');
  } else {
    const sel = rosterSelect(ranked, page, ver);
    lines.push(sel.line);
    rows.push(sel.row);
    nav = sel.nav;
  }
  rows.push(new ActionRowBuilder().addComponents(...nav, button('gn:free', LABELS.free), button('gn:unlink', LABELS.unlink, ButtonStyle.Secondary, !link)));
  return { content: truncate(lines.join('\n'), 2000), components: rows, allowedMentions: { parse: [] } };
}

module.exports = { LABELS, PAGE_SIZE, buildGnPanel, buildPicker, linkLine, meLine, rosterSelect };
