// Pairing an in-game character name with a Discord member by hand (the member's server nickname differs from the game name).
// adm:gmap (opens the step view, new ephemeral reply) | adm:gmap:r (refresh / back) | adm:gmap:g (↩ the 🎮 view, in place) | adm:gmapp:<page> | adm:gmapsug (suggestions)
// | adm:gmapm:<index>:<page>:<ver> (page of the members menu of a game name) | adm:gmaps:<index>:<ver> (Discord member search)
// | adm:gmapg:<page>:<ver> (a game name) -> adm:gmapu:<index into the latest roster>:<ver> (its Discord member) | adm:gmapdel (remove pairs).
// <ver> = rosterVersion of the roster the menu was drawn from: a click after a newer import saves nothing (positions would drift).
// Called from admin.js after the admin gate; every save re-draws the step view with a note and refreshes the dashboard.
const gameRoster = require('../../services/gameRosterService');
const { memberInfo, isStranger } = require('../../services/rosterService');
const { getConfigOrDefault } = require('../../services/guildConfigService');
const { ensureMembers, MEMBERS_WARNING } = require('../memberCache');
const { buildMapView } = require('../ui/gameMap');
const { schedulePanelRefresh } = require('../refresher');
const { scheduleSync } = require('../sheetSync');
const { truncate } = require('../ui/common');
const { escapeMarkdown } = require('discord.js');
const { logEvent, ixCtx } = require('../../eventLog');

const NO_ROSTER = 'Chưa có danh sách thành viên game. Bấm **📤 Cập nhật danh sách** ở màn "🎮 Thành viên game" trước.';
const SHOWN_IN_NOTE = 5;
const ROSTER_CHANGED = 'Danh sách game vừa được cập nhật — mở lại 🔗 Ghép tên.';
const NAME_TAKEN = '⚠️ Tên game đã được ghép cho người khác. Mở lại 🔗 Ghép tên để xem cặp hiện tại.';

const num = (v) => (Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
const idx = (v) => (/^[0-9]+$/.test(String(v)) ? Number(v) : -1); // a roster index; -1 = malformed (never matches a member)

// Everything a step view needs: the latest roster, the match (hand-made pairs included) and the guild's people.
async function collect(interaction) {
  const roster = await gameRoster.latest(interaction.guildId);
  if (!roster) return null;
  const { complete } = await ensureMembers(interaction.guild);
  const [config, mappings] = await Promise.all([getConfigOrDefault(interaction.guildId), gameRoster.loadMappings(interaction.guildId)]);
  // "Kẻ lạ mặt" holders are not offered for pairing (an existing pair of theirs still shows)
  const infos = [...interaction.guild.members.cache.values()].map(memberInfo).filter((m) => !isStranger(m, config) || mappings.has(m.id)).map((m) => ({ id: m.id, name: m.name, username: m.username, bot: m.bot }));
  const found = await gameRoster.matchGuild(interaction.guildId, infos, roster);
  return { ...found, infos, complete };
}

// `totals`: add the new "Khớp N/M (K ghép tay)" count to the note (after a save / remove: the 🎮 view the admin came from is a
// different message and stays outdated).
async function render(interaction, { page = 0, pick = null, mpage = 0, search = false, note = null, totals = false } = {}) {
  const data = await collect(interaction);
  if (!data) return interaction.editReply({ content: NO_ROSTER, components: [] });
  const names = new Map(data.infos.map((i) => [i.id, i.name]));
  const nameOf = (id) => names.get(id) || `<${id}>`;
  const counts = gameRoster.linkCounts(data.match);
  const totalLine = totals ? `📊 Khớp **${data.match.matched.length}/${data.roster.members.length}** (${counts.admin} ghép tay · ${counts.self} tự liên kết · ${counts.free} tên tự nhập)` : null;
  const view = buildMapView({
    roster: data.roster.members,
    match: data.match,
    suggestions: gameRoster.suggestPairs(data.match.gameOnly, data.match.discordOnly),
    mappings: data.mappings,
    ver: gameRoster.rosterVersion(data.roster),
    nameOf,
    page,
    pick,
    candidates: pick === null ? [] : (data.roster.members[pick] ? gameRoster.rankPeople(data.roster.members[pick].name, data.match.discordOnly) : []),
    mpage,
    search,
    note: [note, totalLine, data.complete ? null : MEMBERS_WARNING].filter(Boolean).join('\n') || null,
  });
  return interaction.editReply(view);
}

// The Discord member `id` as { id, name } when the pair may be saved (a real, non-bot member), else null.
function personOf(interaction, id) {
  const cached = interaction.guild.members.cache.get(id);
  if (cached) return cached.user && cached.user.bot ? null : { id, name: memberInfo(cached).name };
  const picked = interaction.members && interaction.members.get ? interaction.members.get(id) : null;
  if (picked && picked.user && !picked.user.bot) return { id, name: picked.displayName || picked.user.username };
  return null;
}

const pairsText = (pairs) => {
  const shown = pairs.slice(0, SHOWN_IN_NOTE).map((p) => `${escapeMarkdown(truncate(p.gameName, 40))} ⇄ ${escapeMarkdown(truncate(p.name, 40))}`);
  return `${shown.join(', ')}${pairs.length > SHOWN_IN_NOTE ? ` … +${pairs.length - SHOWN_IN_NOTE}` : ''}`;
};

async function save(interaction, wanted, ver) {
  const roster = await gameRoster.latest(interaction.guildId);
  if (!roster) return render(interaction);
  if (gameRoster.rosterVersion(roster) !== ver) return render(interaction, { note: ROSTER_CHANGED }); // positions of an older roster: save nothing
  const ok = [];
  let skipped = 0;
  for (const { index, id } of wanted) {
    const game = roster.members[index];
    const person = personOf(interaction, id);
    if (!game || !person) skipped += 1;
    else ok.push({ discordId: id, gameName: game.name, displayName: person.name, name: person.name });
  }
  let taken = false;
  if (ok.length) {
    try {
      await gameRoster.setMappings(interaction.guildId, ok);
    } catch (err) {
      if (err.code !== 'GAME_NAME_TAKEN') throw err;
      taken = true; // another admin paired the same game name a moment ago (unique index): some pairs may be saved, the view shows the truth
    }
    scheduleSync(interaction.client, interaction.guildId); // game names in the sheet
    schedulePanelRefresh(interaction.client, interaction.guildId); // the lineup names / dashboard numbers follow the pairs
  }
  logEvent('roster', 'gmap_save', { ...ixCtx(interaction), pairs: ok.length, skipped, taken });
  if (taken) return render(interaction, { note: NAME_TAKEN, totals: true });
  const note = [
    ok.length ? `✅ Đã ghép ${ok.length} cặp: ${pairsText(ok)}` : null,
    skipped ? `⚠️ Bỏ qua ${skipped} cặp (danh sách game đã đổi, hoặc người đó là bot / không còn trong server).` : null,
  ]
    .filter(Boolean)
    .join('\n');
  return render(interaction, { note, totals: true });
}

async function remove(interaction, ids) {
  const removed = await gameRoster.removeMappings(interaction.guildId, ids);
  logEvent('roster', 'gmap_remove', { ...ixCtx(interaction), asked: ids.length, removed });
  if (removed) {
    scheduleSync(interaction.client, interaction.guildId); // the game names of the sheet
    schedulePanelRefresh(interaction.client, interaction.guildId);
  }
  return render(interaction, { note: removed ? `✅ Đã gỡ ghép ${removed} cặp.` : 'Không có cặp nào để gỡ (đã gỡ trước đó).', totals: true });
}

// True when the menu's roster version is still the latest import's.
async function sameRoster(interaction, ver) {
  const roster = await gameRoster.latest(interaction.guildId);
  return Boolean(roster) && gameRoster.rosterVersion(roster) === ver;
}

// parts = the customId split on ":" (parts[0] = "adm")
async function handle(interaction, parts) {
  const values = interaction.values || [];
  switch (parts[1]) {
    case 'gmap':
      return render(interaction);
    case 'gmapp':
      return render(interaction, { page: num(parts[2]) });
    case 'gmapg': {
      if (!(await sameRoster(interaction, parts[3]))) return render(interaction, { note: ROSTER_CHANGED });
      const pick = values.length ? idx(values[0]) : null;
      return render(interaction, { pick, page: num(parts[2]) });
    }
    case 'gmapm': {
      if (!(await sameRoster(interaction, parts[4]))) return render(interaction, { note: ROSTER_CHANGED });
      return render(interaction, { pick: idx(parts[2]), mpage: num(parts[3]) });
    }
    case 'gmaps': {
      if (!(await sameRoster(interaction, parts[3]))) return render(interaction, { note: ROSTER_CHANGED });
      return render(interaction, { pick: idx(parts[2]), search: true });
    }
    case 'gmapu':
      return save(interaction, values.slice(0, 1).map((id) => ({ index: idx(parts[2]), id })), parts[3]);
    case 'gmapsug':
      return save(
        interaction,
        values.map((v) => {
          const [index, id] = String(v).split(':');
          return { index: idx(index), id };
        }),
        parts[2]
      );
    case 'gmapdel':
      return remove(interaction, values.map(String));
    default:
      return interaction.editReply('Chức năng không tồn tại.');
  }
}

module.exports = { handle, NO_ROSTER };
