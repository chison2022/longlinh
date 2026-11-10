// Buttons of the "left the guild in game but still on Discord" notice (see ../departNotice, ../ui/departNotice): adm:depok:<rosterId>
// (✅ Đã xử lý), adm:depunlink:<rosterId> (🔗 Gỡ liên kết những người này), adm:depreg:<rosterId> (🗑️ Gỡ báo danh) and
// adm:depmerge:<rosterId> (🔀 Ghép tên mới). All are admin-gated in ./admin before they get here.
const gameRoster = require('../../services/gameRosterService');
const departure = require('../../services/departureService');
const { ensureMembers, MEMBERS_WARNING } = require('../memberCache');
const { guildMemberMap } = require('../departNotice');
const { buildDepartDone, messageTexts } = require('../ui/departNotice');
const { schedulePanelRefresh, scheduleRefresh } = require('../refresher');
const warService = require('../../services/warService');
const regService = require('../../services/registrationService');
const memberStore = require('../../services/members');
const { scheduleSync } = require('../sheetSync');
const { eph } = require('./common');
const { logEvent, ixCtx } = require('../../eventLog');

const OLD_NOTICE = 'Thông báo này đã cũ (danh sách game đó không còn). Mở **🎮 Thành viên game** để xem lại.';

// adm:depok:<rosterId> - the notice itself is edited (the interaction was deferred with deferUpdate): green, no buttons, who and when.
async function onDone(interaction, config, rosterId) {
  const texts = messageTexts(interaction.message);
  if (!texts.length) return interaction.followUp(eph('Không đọc được thông báo để cập nhật.'));
  await interaction.editReply(buildDepartDone({ texts, adminId: interaction.user.id }));
  logEvent('roster', 'depart_done', { ...ixCtx(interaction), rosterId });
}

// adm:depunlink:<rosterId> - removes the links of the people the notice really LISTED (the ids stored when it was posted; the ones
// behind "… và K người nữa" were never shown, so they are left alone) who are STILL departed, judged now against the latest roster,
// and whose link is not newer than the notice: someone who linked or re-linked since is kept.
async function onUnlink(interaction, config, rosterId) {
  const guildId = interaction.guildId;
  const notice = await departure.getNotice(guildId);
  if (!notice || notice.rosterId !== rosterId) return interaction.editReply(OLD_NOTICE); // only the last posted notice has its list stored
  const latest = await gameRoster.latest(guildId);
  if (!latest) return interaction.editReply('Chưa có danh sách thành viên game.');
  const { complete, members } = await ensureMembers(interaction.guild); // an incomplete cache only hides people: it never adds a wrong one
  const inGuild = guildMemberMap(members);
  const linked = await departure.loadLinked(guildId);
  const shown = new Set(notice.ids);
  const noticeAt = notice.at ? new Date(notice.at).getTime() : NaN;
  const previous = await departure.previousMembers(guildId, linked);
  const ids = departure.findDeparted(linked, latest.members, inGuild, { importedAt: latest.importedAt, previous })
    .filter((d) => shown.has(d.discordId) && !(d.gameNameAt && !Number.isNaN(noticeAt) && new Date(d.gameNameAt).getTime() > noticeAt))
    .map((d) => d.discordId);
  const removed = ids.length ? await gameRoster.removeMappings(guildId, ids) : 0; // also bumps the name caches
  logEvent('roster', 'depart_unlink', { ...ixCtx(interaction), rosterId, asked: ids.length, removed, complete });
  if (removed) {
    scheduleSync(interaction.client, guildId); // the game names of the sheet
    schedulePanelRefresh(interaction.client, guildId); // the dashboard numbers follow the links
  }
  const base = removed ? `✅ Đã gỡ liên kết tên game của ${removed} người.` : 'Không còn ai cần gỡ (đã gỡ trước đó hoặc đã liên kết lại).';
  const text = notice.more > 0 ? `${base}\n${notice.more} người trong "… và ${notice.more} người nữa" không được hiển thị nên chưa bị đụng tới.` : base;
  return interaction.editReply(complete ? text : `${text}\n${MEMBERS_WARNING}`);
}

// adm:depreg:<rosterId> - removes the registrations, for the war the notice named, of the people it listed as still registered, except
// anyone who is linked again to a character still in the guild (came back / renamed and re-linked since). Absent answers are left alone.
// Once that war is over (another war is current) the button does nothing.
async function onUnreg(interaction, config, rosterId) {
  const guildId = interaction.guildId;
  const notice = await departure.getNotice(guildId);
  if (!notice || notice.rosterId !== rosterId) return interaction.editReply(OLD_NOTICE);
  const war = notice.warId ? await warService.getEvent(notice.warId) : null;
  const current = await warService.getCurrentEvent(guildId);
  if (!war || !current || String(current._id) !== String(war._id)) return interaction.editReply('Trận bang chiến của thông báo này đã qua — không gỡ gì.');
  const listed = new Set(notice.joined);
  const joined = (await regService.listRegistrations(war._id)).filter((r) => r.status !== 'absent' && listed.has(r.discordId)).map((r) => r.discordId);
  const members = joined.length ? await memberStore.listMembers(guildId, 'm.discord_id = any($2)', [joined]) : [];
  const back = new Set(members.filter((m) => m.gameName && !m.gameLeftAt).map((m) => m.discordId)); // linked to a character in the guild again
  const ids = joined.filter((id) => !back.has(id));
  const removed = ids.length ? await regService.removeRegistrations(war._id, ids) : [];
  logEvent('roster', 'depart_unreg', { ...ixCtx(interaction), rosterId, eid: String(war._id), asked: ids.length, removed: removed.length, kept: back.size });
  if (removed.length) {
    scheduleRefresh(interaction.client, war._id); // the war message counts
    scheduleSync(interaction.client, guildId);
    schedulePanelRefresh(interaction.client, guildId);
  }
  const lines = [removed.length ? `✅ Đã gỡ báo danh của ${removed.length} người khỏi **${war.title}**: ${removed.map((id) => `<@${id}>`).join(', ')}` : 'Không còn ai cần gỡ báo danh.'];
  if (back.size) lines.push(`Giữ lại ${back.size} người đã liên kết lại với nhân vật đang ở bang.`);
  return interaction.editReply({ content: lines.join('\n'), allowedMentions: { parse: [] } });
}

// adm:depmerge:<rosterId> - links the people the notice listed under "🔀 Có thể chỉ khác tên" to the roster name shown next to them.
// Judged again now: the name must still be in the latest roster with nobody linked to it, and the person must still hold the name the
// notice showed (anything else was handled by hand since). The in-game ID on the name they leave moves along when the roster
// character has none.
async function onMerge(interaction, config, rosterId) {
  const guildId = interaction.guildId;
  const notice = await departure.getNotice(guildId);
  if (!notice || notice.rosterId !== rosterId) return interaction.editReply(OLD_NOTICE);
  const latest = await gameRoster.latest(guildId);
  if (!latest) return interaction.editReply('Chưa có danh sách thành viên game.');
  const key = gameRoster.nameKey;
  const linked = await departure.loadLinked(guildId);
  const inRoster = new Map(latest.members.map((g) => [key(g.name), g]));
  const held = new Set(linked.map((l) => key(l.gameName)));
  const nameOf = new Map(linked.map((l) => [l.discordId, l.gameName]));
  const pairs = (notice.merge || [])
    .filter((p) => inRoster.has(key(p.name)) && !held.has(key(p.name)) && nameOf.has(p.id) && key(nameOf.get(p.id)) === key(p.from))
    .map((p) => ({ id: p.id, game: inRoster.get(key(p.name)) }));
  if (!pairs.length) return interaction.editReply('Không còn ai cần ghép (đã ghép trước đó, hoặc tên đó đã có người nhận).');
  const uids = await departure.linkedUids(guildId, pairs.map((p) => p.id)); // read before the links move
  try {
    await gameRoster.setMappings(guildId, pairs.map((p) => ({ discordId: p.id, gameName: p.game.name })));
  } catch (err) {
    if (err.code !== 'GAME_NAME_TAKEN') throw err;
    return interaction.editReply('Có tên vừa được người khác nhận. Mở **🎮 Thành viên game → 🔗 Ghép tên** để ghép tay.');
  }
  const notes = [];
  for (const p of pairs) {
    const uid = uids.get(p.id);
    if (!uid || p.game.gameUid) continue;
    const res = await gameRoster.setGameUid(guildId, p.game.name, uid);
    if (res.error) notes.push(`• ID ${uid} chưa chuyển sang **${p.game.name}**: ${res.error}`);
  }
  logEvent('roster', 'depart_merge', { ...ixCtx(interaction), rosterId, asked: (notice.merge || []).length, merged: pairs.length, uidNotes: notes.length });
  scheduleSync(interaction.client, guildId);
  schedulePanelRefresh(interaction.client, guildId);
  const lines = [`✅ Đã ghép ${pairs.length} người sang tên trong danh sách game: ${pairs.map((p) => `<@${p.id}> → **${p.game.name}**`).join(', ')}`, ...notes];
  return interaction.editReply({ content: lines.join('\n').slice(0, 1900), allowedMentions: { parse: [] } });
}

module.exports = { onDone, onUnlink, onUnreg, onMerge };
