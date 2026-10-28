// Admin view of the in-game member list: adm:game (summary + PNG table), adm:gamexlsx, adm:gameup (modal), adm:gameupModal;
// adm:gmap* (pairing a game name with a Discord member by hand) lives in ./gameMap.
const { AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown } = require('discord.js');
const gameRoster = require('../../services/gameRosterService');
const departure = require('../../services/departureService');
const departNotice = require('../departNotice');
const offNotice = require('../offNotice');
const { buildGameRosterXlsx } = require('../../services/rosterWorkbook');
const { memberInfo, isStranger } = require('../../services/rosterService');
const { formatLocalDateTime, discordTs } = require('../../utils/time');
const { stylesOf, styleOf, lineupStyles } = require('../classStyle');
const { ensureMembers, MEMBERS_WARNING } = require('../memberCache');
const { buildGameUploadModal, buildGameAddModal, buildGameUidModal } = require('../ui/settingsModal');
const { invalidateGameNames } = require('../gameNames');
const { schedulePanelRefresh } = require('../refresher');
const { scheduleSync } = require('../sheetSync');
const { logEvent, ixCtx } = require('../../eventLog');

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15000;
const MAX_FILES = 10;
const NAMES_SHOWN = 12;
const NO_ROSTER = 'Chưa có danh sách thành viên game. Bấm **📤 Cập nhật danh sách** để tải file .xlsx lên (sheet "Thành viên").';

// The image renderer needs the native canvas binary: loaded on first use so a broken one cannot stop the bot from starting.
let imageLoader = () => require('../ui/rosterImage');
let rosterImage; // undefined = not tried yet, null = unavailable
function loadRosterImage() {
  if (rosterImage === undefined) {
    try {
      rosterImage = imageLoader();
    } catch (err) {
      rosterImage = null;
      console.error('[gameRoster] image module unavailable, replying with text:', err);
      logEvent('roster', 'image_failed', { stage: 'load', err });
    }
  }
  return rosterImage;
}

// Tests only: swap the module loader and forget the cached result.
function setImageLoader(loader) {
  imageLoader = loader || (() => require('../ui/rosterImage'));
  rosterImage = undefined;
}

// Two rows (a row holds 5 buttons at most).
const buttons = () => [
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('adm:gamexlsx').setLabel('📥 Tải Excel').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('adm:gmap').setLabel('🔗 Ghép tên').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('adm:gren').setLabel('✏️ Đổi tên').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('adm:gameadd').setLabel('➕ Thêm tên game').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('adm:gameup').setLabel('📤 Cập nhật danh sách').setStyle(ButtonStyle.Primary)
  ),
  new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('adm:gameuid').setLabel('🆔 ID game').setStyle(ButtonStyle.Secondary)),
];

const esc = (s) => escapeMarkdown(String(s));
// Up to `max` items joined with ", " and a "… +k" tail; the whole text is cut to `limit` chars (embed field cap).
function list(items, max = NAMES_SHOWN, limit = 1000) {
  let text = items.slice(0, max).join(', ');
  if (items.length > max) text += `, … +${items.length - max}`;
  return text.length > limit ? `${text.slice(0, limit - 2).trimEnd()} …` : text;
}
// "Ban quản lý A · Bang Chúng B · Học việc C": any rank other than Bang Chúng / Học Việc counts as the management.
function rankLine(byRank) {
  const count = { staff: 0, member: 0, trainee: 0 };
  for (const [rank, n] of byRank) {
    const key = gameRoster.fold(rank);
    if (key === 'bangchung') count.member += n;
    else if (key === 'hocviec') count.trainee += n;
    else count.staff += n;
  }
  return `Ban quản lý ${count.staff} · Bang Chúng ${count.member} · Học việc ${count.trainee}`;
}
const clip = (text, limit = 1024) => (text.length > limit ? `${text.slice(0, limit - 2).trimEnd()} …` : text);

// Everything the views need: the latest import with the Discord match flag per member, the diff to the import before it.
async function load(interaction, config) {
  const roster = await gameRoster.latest(interaction.guildId);
  if (!roster) return null;
  const linkedIds = new Set((await gameRoster.loadMappings(interaction.guildId)).keys());
  const mappingsHas = (id) => linkedIds.has(id);
  const prev = await gameRoster.previous(interaction.guildId);
  const { complete } = await ensureMembers(interaction.guild);
  // "Kẻ lạ mặt" holders are not members yet: they are not offered as Discord-only people (their existing links still count)
  const infos = [...interaction.guild.members.cache.values()].map(memberInfo).filter((m) => !isStranger(m, config) || mappingsHas(m.id)).map((m) => ({ id: m.id, name: m.name, bot: m.bot }));
  const { match, mappings } = await gameRoster.matchGuild(interaction.guildId, infos, roster);
  const matchedNames = new Set(match.matched.map((m) => m.game));
  const members = roster.members.map((m) => ({ ...m, inDiscord: matchedNames.has(m) }));
  // linked to a game name that the roster no longer has, and still here: from data already loaded (no extra Discord call)
  const linked = [...mappings].map(([discordId, gameName]) => ({ discordId, gameName, source: mappings.sources && mappings.sources.get(discordId) }));
  const departed = departure.findDeparted(linked, roster.members, new Map(infos.map((p) => [p.id, { name: p.name, bot: p.bot }])));
  return { roster, prev, members, match, complete, departed, diff: prev ? gameRoster.diff(prev.members, roster.members) : null };
}

function buildEmbed(data, config, styles) {
  const { roster, prev, match, diff } = data;
  const sum = gameRoster.summarize(roster.members, config.classes);
  const embed = new EmbedBuilder()
    .setTitle('🎮 Thành viên trong game')
    .setColor(0x1e3a8a)
    .setDescription(
      [
        `Cập nhật ${discordTs(new Date(roster.importedAt), 'f')} (${discordTs(new Date(roster.importedAt), 'R')})`,
        `Nguồn: ${esc(clip(String(roster.source || '—'), 100))}${roster.importedBy && roster.importedBy !== 'script' ? ` · bởi <@${roster.importedBy}>` : ''}`,
        `**${sum.total}** thành viên · ${rankLine(sum.byRank)}`,
      ].join('\n')
    );
  embed.addFields({
    name: 'Theo phái',
    value: clip(sum.byClass.map(([c, n]) => `${styleOf(styles, c).emojiText} ${esc(styleOf(styles, c).plain)}: **${n}**`).join('\n')),
  });

  if (diff) {
    const lines = [];
    if (diff.added.length) lines.push(`➕ Mới vào (${diff.added.length}): ${list(diff.added.map((m) => esc(m.name)), 8, 300)}`);
    if (diff.removed.length) lines.push(`➖ Rời (${diff.removed.length}): ${list(diff.removed.map((m) => esc(m.name)), 8, 300)}`);
    if (diff.renamed.length) lines.push(`✏️ Có thể đổi tên (đoán, ${diff.renamed.length}): ${list(diff.renamed.map((r) => `${esc(r.from.name)} → ${esc(r.to.name)}`), 5, 300)} — bấm **✏️ Đổi tên** để xác nhận`);
    const back = roster.members.filter((m) => m.returnedAt && new Date(m.returnedAt) >= new Date(prev.importedAt));
    if (back.length) lines.push(`🔁 Quay lại bang (${back.length}): ${list(back.map((m) => esc(m.name)), 8, 300)}`);
    if (diff.rankChanged.length) lines.push(`🎖️ Đổi chức vụ (${diff.rankChanged.length}): ${list(diff.rankChanged.map((r) => `${esc(r.name)} (${esc(r.from)} → ${esc(r.to)})`), 5, 300)}`);
    embed.addFields({
      name: `So với lần trước (${formatLocalDateTime(new Date(prev.importedAt)).split(' ')[0]})`,
      value: lines.length ? clip(lines.join('\n')) : 'Không có thay đổi.',
    });
  }

  const counts = gameRoster.linkCounts(match);
  const lines = [`✅ Khớp tên Discord: **${match.matched.length}/${sum.total}** (trong đó ${counts.admin} ghép tay · ${counts.self} tự liên kết · ${counts.free} tên tự nhập)`];
  const unlisted = match.unlisted || [];
  if (unlisted.length) lines.push(`✍️ Tên tự nhập, không có trong danh sách game (${unlisted.length}): ${list(unlisted.map((s) => `${esc(s.gameName)} ⇄ <@${s.discordId}>`), 5, 400)}`);
  if (match.gameOnly.length) lines.push(`🔤 Tên Discord khác tên game (${match.gameOnly.length}): ${list(match.gameOnly.map((m) => esc(m.name)), 10, 600)}`);
  lines.push(`💬 Trên Discord nhưng không khớp ai trong game: **${match.discordOnly.length}**`);
  if (data.departed && data.departed.length) lines.push(`🚪 Đã rời game nhưng còn trong Discord: **${data.departed.length}** — ${list(data.departed.map((d) => `${esc(d.gameName)} ⇄ <@${d.discordId}>`), 5, 400)}`);
  if (match.stale.length) lines.push(`⚠️ Ghép tên cũ, game không còn tên này (${match.stale.length}): ${list(match.stale.map((s) => `${esc(s.gameName)} ⇄ <@${s.discordId}>`), 5, 400)}`);
  if (match.uncached.length) lines.push(`⏳ Đã ghép nhưng chưa thấy trong cache (${match.uncached.length}): ${list(match.uncached.map((s) => `${esc(s.gameName)} ⇄ <@${s.discordId}>`), 5, 400)}`);
  if (match.gameOnly.length || match.discordOnly.length) lines.push('-# Bấm 🔗 Ghép tên để ghép tay những người đổi tên khác nhau.');
  embed.addFields({ name: 'Đối chiếu Discord', value: clip(lines.join('\n')) });
  return embed;
}

// Plain-text table when the PNG cannot be drawn (cut to the 2000 char message limit).
function textFallback(members) {
  const rows = members.map((m, i) => `${i + 1}. ${String(m.name).replace(/`/g, "'")} — ${m.rank || '—'} — ${m.className}${m.inDiscord ? ' ✓' : ''}`);
  let out = '';
  let shown = 0;
  for (const row of rows) {
    if (out.length + row.length + 60 > 1900) break;
    out += `${row}\n`;
    shown++;
  }
  return `\`\`\`\n${out}\`\`\`${shown < rows.length ? `… và ${rows.length - shown} người nữa (bấm 📥 Tải Excel để xem đủ).` : ''}`;
}

async function pngFiles(data, config, styles, guild) {
  const mod = loadRosterImage();
  if (!mod) return null;
  try {
    const { roster, members } = data;
    const pageSize = Math.max(mod.PAGE_SIZE, Math.ceil(members.length / MAX_FILES));
    const pngs = await mod.renderRosterPngs(
      {
        title: `Thành viên bang — ${guild && guild.name ? guild.name : 'game'}`,
        subtitle: `Cập nhật ${formatLocalDateTime(new Date(roster.importedAt))} · ${members.length} thành viên · ✓ = đã khớp tên Discord`,
        members,
        classes: config.classes,
        styles: lineupStyles(styles),
      },
      { pageSize }
    );
    return pngs.slice(0, MAX_FILES).map((buf, i) => new AttachmentBuilder(buf, { name: `thanh-vien-game-${i + 1}.png` }));
  } catch (err) {
    console.error('[gameRoster] cannot render the roster image:', err);
    logEvent('roster', 'image_failed', { stage: 'render', err });
    return null;
  }
}

// The summary reply (also used after an upload, with `note` on top).
async function buildView(interaction, config, note) {
  const data = await load(interaction, config);
  if (!data) {
    logEvent('roster', 'view', { ...ixCtx(interaction), hasRoster: false });
    return { content: [note, NO_ROSTER].filter(Boolean).join('\n'), components: buttons() };
  }
  const styles = stylesOf(interaction.guild, config);
  const files = await pngFiles(data, config, styles, interaction.guild);
  logEvent('roster', 'view', { ...ixCtx(interaction), hasRoster: true, members: data.members.length, matched: data.match.matched.length, complete: data.complete, image: files ? 'png' : 'text' });
  const content = [note, data.complete ? null : MEMBERS_WARNING, files ? null : textFallback(data.members)].filter(Boolean).join('\n');
  return { content: content || undefined, embeds: [buildEmbed(data, config, styles)], files: files || [], components: buttons(), allowedMentions: { parse: [] } };
}

// adm:game
async function onView(interaction, config) {
  return interaction.editReply(await buildView(interaction, config));
}

// adm:gmap:g (↩ Về Thành viên game, from the pairing step view): the same summary drawn fresh over that message
async function onBack(interaction, config) {
  const view = await buildView(interaction, config);
  return interaction.editReply({ ...view, content: view.content || '' });
}

// adm:gamexlsx
async function onXlsx(interaction, config) {
  const data = await load(interaction, config);
  if (!data) return interaction.editReply({ content: NO_ROSTER, components: buttons() });
  const styles = stylesOf(interaction.guild, config);
  const xlsx = await buildGameRosterXlsx(data.members, { classes: config.classes, styles: lineupStyles(styles) });
  const day = formatLocalDateTime(new Date(data.roster.importedAt)).split(' ')[0].replace('/', '-');
  return interaction.editReply({ content: `📥 Thành viên game — ${data.members.length} người${data.complete ? '' : `\n${MEMBERS_WARNING}`}`, files: [new AttachmentBuilder(xlsx, { name: `thanh-vien-game-${day}.xlsx` })] });
}

// adm:gameup (opens the upload modal)
function onUpload(interaction) {
  return interaction.showModal(buildGameUploadModal());
}

const CDN_HOST = /^(cdn\.discordapp\.com|media\.discordapp\.net)$/;

// The attachment's bytes from the Discord CDN; throws an Error with a Vietnamese message.
async function download(att) {
  if (!/\.xlsx$/i.test(att.name || '')) throw new Error('Chỉ nhận file .xlsx.');
  if (att.size > MAX_FILE_BYTES) throw new Error('File quá lớn (tối đa 2 MB).');
  let url;
  try {
    url = new URL(att.url);
  } catch {
    throw new Error('Đường dẫn file không hợp lệ.');
  }
  if (url.protocol !== 'https:' || !CDN_HOST.test(url.hostname)) throw new Error('File phải được tải lên từ Discord.');
  let res;
  try {
    res = await globalThis.fetch(url, { redirect: 'error', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch {
    throw new Error('Không tải được file từ Discord, thử lại sau.');
  }
  if (!res.ok) throw new Error(`Không tải được file từ Discord (HTTP ${res.status}).`);
  const TOO_BIG = 'File quá lớn (tối đa 2 MB).';
  if (Number(res.headers && res.headers.get('content-length')) > MAX_FILE_BYTES) throw new Error(TOO_BIG);
  if (!res.body || typeof res.body.getReader !== 'function') throw new Error('Không tải được file từ Discord, thử lại sau.');
  const chunks = [];
  let received = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > MAX_FILE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(TOO_BIG);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err.message === TOO_BIG) throw err;
    throw new Error('Không tải được file từ Discord, thử lại sau.');
  }
  return Buffer.concat(chunks);
}

// roster.import line: rows and the diff to the previous import. Never throws.
function logImport(interaction, members, prev) {
  try {
    const d = prev ? gameRoster.diff(prev.members, members) : null;
    logEvent('roster', 'import', { ...ixCtx(interaction), source: 'upload', ok: true, rows: members.length, added: d ? d.added.length : members.length, removed: d ? d.removed.length : 0, renamed: d ? d.renamed.length : 0, first: !prev });
  } catch (err) {
    logEvent('roster', 'import', { ...ixCtx(interaction), source: 'upload', ok: true, rows: members.length, err });
  }
}

// adm:gameupModal
async function onUploadSubmit(interaction, config) {
  const files = interaction.fields.getUploadedFiles('file', true);
  const att = files.first();
  let members;
  try {
    members = await gameRoster.parseRosterXlsx(await download(att), config.classes);
  } catch (err) {
    logEvent('roster', 'import', { ...ixCtx(interaction), source: 'upload', ok: false, err });
    return interaction.editReply(`❌ ${err.message}`);
  }
  const prev = await gameRoster.latest(interaction.guildId).catch(() => null); // only for the added / removed counts of the log line
  await gameRoster.saveImport({ guildId: interaction.guildId, importedBy: interaction.user.id, source: att.name, members });
  logImport(interaction, members, prev);
  scheduleSync(interaction.client, interaction.guildId); // the LongLinh_GameRoster tab
  schedulePanelRefresh(interaction.client, interaction.guildId); // the dashboard shows the roster's size and date
  departNotice.noticeGuild(interaction.client, interaction.guildId, { guild: interaction.guild, config }); // managers hear who left the game right away (never throws; the claim stops a double post with the tick)
  offNotice.noticeGuild(interaction.client, interaction.guildId, { guild: interaction.guild, config }); // ... and who has been off too long without asking (same claim pattern)
  return interaction.editReply(await buildView(interaction, config, `✅ Đã cập nhật danh sách: **${members.length}** thành viên.`));
}

// adm:gameadd (opens the form) / adm:gameaddModal: a character who joined in game after the last import. Appended to that import
// (see gameRosterService.addManualMember): he can then pick the name in 🎮 / at the gate (auto-approved there) right away.
function onAdd(interaction, config) {
  return interaction.showModal(buildGameAddModal(config.classes));
}

async function onAddSubmit(interaction, config) {
  const name = interaction.fields.getTextInputValue('name');
  const index = Number((interaction.fields.getStringSelectValues('cls') || [])[0]);
  const rank = (interaction.fields.getStringSelectValues('rank') || [])[0] || 'Học Việc';
  const className = config.classes[index];
  if (!className) return interaction.editReply('⚠️ Danh sách phái vừa đổi, mở lại form.');
  const r = await gameRoster.addManualMember(interaction.guildId, { name, className, rank });
  if (r.error) {
    logEvent('roster', 'manual_add', { ...ixCtx(interaction), ok: false, reason: r.error.slice(0, 60) });
    return interaction.editReply(`❌ ${r.error}`);
  }
  logEvent('roster', 'manual_add', { ...ixCtx(interaction), ok: true });
  invalidateGameNames(interaction.guildId);
  scheduleSync(interaction.client, interaction.guildId);
  schedulePanelRefresh(interaction.client, interaction.guildId);
  return interaction.editReply(await buildView(interaction, config, `✅ Đã thêm **${esc(r.member.name)}** (${esc(r.member.className)} · ${esc(r.member.rank)}) vào danh sách game. Người này chọn được tên ở bảng 🎮 và ở cổng vào ngay; lần cập nhật danh sách sau sẽ thay bằng dữ liệu thật.`));
}

// adm:gameuid (opens the form) / adm:gameuidModal: a manager sets or removes the in-game ID of a character (see gameRosterService.setGameUid).
function onUid(interaction) {
  return interaction.showModal(buildGameUidModal());
}

async function onUidSubmit(interaction, config) {
  const name = interaction.fields.getTextInputValue('name');
  const r = await gameRoster.setGameUid(interaction.guildId, name, interaction.fields.getTextInputValue('uid'));
  if (r.error) {
    logEvent('roster', 'game_uid', { ...ixCtx(interaction), ok: false, reason: r.error.slice(0, 60) });
    return interaction.editReply(`❌ ${r.error}`);
  }
  logEvent('roster', 'game_uid', { ...ixCtx(interaction), ok: true, cleared: !r.uid });
  scheduleSync(interaction.client, interaction.guildId); // the ThanhVien tab shows the ID
  return interaction.editReply(await buildView(interaction, config, r.uid ? `✅ Đã lưu ID game **${r.uid}** cho **${esc(r.name)}**.` : `✅ Đã xoá ID game của **${esc(r.name)}**.`));
}

module.exports = { onUid, onUidSubmit, onView, onBack, onXlsx, onUpload, onUploadSubmit, onAdd, onAddSubmit, setImageLoader, MAX_FILE_BYTES, buildEmbedForTest: buildEmbed };
