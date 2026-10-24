const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { discordTs } = require('../../utils/time');
const { truncate } = require('./common');
const feed = require('../../services/sheets/feed');

const button = (id, label, style = ButtonStyle.Secondary, disabled = false) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);

const TABS = feed.tabsText();

// The ephemeral "📊 Google Sheet" view (button adm:sheet).
// `s` = { configured, hasKey, title?, titleError?, url?, email?, status? ({ at, error } of the last sync), note? }.
//  - not configured: the setup hint + "✏️ Đặt Sheet" (adm:sheetedit),
//  - configured: sheet title, "Mở Sheet" link, last sync / last error, "🔄 Đồng bộ ngay" (adm:sheetnow) + "✏️ Đổi Sheet" (adm:sheetedit).
function buildSheetView(s) {
  const lines = ['📊 **Google Sheet**'];
  if (!s.configured) {
    lines.push('Chưa nối Google Sheet.');
    if (!s.hasKey) lines.push(s.keyHint || 'Bot chưa có file khoá Google.');
    else lines.push(`Tạo một Google Sheet, chia sẻ cho ${s.email ? `\`${s.email}\`` : 'tài khoản service account của bot'} quyền **Editor**, rồi bấm **✏️ Đặt Sheet** và dán link. Bot sẽ ghi các tab ${TABS}.`);
    if (s.note) lines.push('', s.note);
    return {
      content: lines.join('\n'),
      allowedMentions: { parse: [] },
      components: [new ActionRowBuilder().addComponents(button('adm:sheetedit', '✏️ Đặt Sheet', ButtonStyle.Primary, !s.hasKey))],
    };
  }
  lines.push(s.title ? `Sheet: **${truncate(s.title, 100)}**` : s.titleError ? `⚠️ Không đọc được Sheet: ${truncate(s.titleError, 300)}` : 'Sheet đã nối.');
  if (!s.hasKey) lines.push(`⚠️ ${s.keyHint || ''}`);
  const st = s.status || {};
  lines.push(st.at ? `Đồng bộ lần cuối: ${discordTs(new Date(st.at), 'R')}` : 'Chưa đồng bộ từ lúc bot khởi động.');
  if (st.error) lines.push(`⚠️ Lỗi lần gần nhất: ${truncate(String(st.error), 400)}`);
  lines.push(`-# Bot ghi các tab ${TABS} (tự đồng bộ sau mỗi thay đổi đăng ký).`);
  if (s.note) lines.push('', s.note);
  const row = new ActionRowBuilder();
  if (s.url) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Mở Sheet').setURL(s.url));
  row.addComponents(button('adm:sheetnow', '🔄 Đồng bộ ngay', ButtonStyle.Primary, !s.hasKey), button('adm:sheetedit', '✏️ Đổi Sheet'));
  return { content: lines.join('\n'), allowedMentions: { parse: [] }, components: [row] };
}

module.exports = { buildSheetView };
