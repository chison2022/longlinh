// "🔗 Ghép tên" step view: pair an in-game character name with a Discord member by hand (pure: no Discord client, no DB).
// customIds (all admin-gated adm:*): adm:gmapsug:<ver> (suggestions), adm:gmapg:<page>:<ver> (game name), adm:gmapu:<index>:<ver> (Discord
// member of the game name at that index of the latest roster; <ver> = rosterVersion of that roster, a click on an older one is refused), adm:gmapdel (remove pairs), adm:gmapp:<page> (◀ ▶), adm:gmap:r (refresh / back),
// adm:gmapm:<index>:<page>:<ver> (page of the not-yet-matched members menu), adm:gmaps:<index>:<ver> (🔎 Discord member search), adm:gmap:g (↩ the 🎮 view).
// The member menu of step b) is a StringSelect adm:gmapu:<index>:<ver> (value = Discord id); the search is a UserSelect with the same id.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, UserSelectMenuBuilder, escapeMarkdown } = require('discord.js');
const { truncate } = require('./common');
const { linkCounts } = require('../../services/gameRosterService');

const PAGE_SIZE = 25; // options of a Discord select
const NAME_HALF = 44; // each side of "game ⇄ discord" in an option label (the label limit is 100)

const button = (id, label, style = ButtonStyle.Secondary, disabled = false) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
const pairLabel = (game, discord, half = NAME_HALF) => `${truncate(game, half)} ⇄ ${truncate(discord, half)}`;
// A remove-menu label (limit 100): the source tag goes FIRST ("(tự liên kết) game ⇄ discord"), the status suffix ("(cũ)") last, and the two
// names share what is left.
function removeLabel(game, discord, tag, suffix) {
  const fixed = (tag ? tag.length + 1 : 0) + (suffix ? suffix.length + 1 : 0) + 3; // spaces and the arrow
  const half = Math.max(8, Math.min(NAME_HALF, Math.floor((100 - fixed) / 2)));
  return truncate(`${tag ? `${tag} ` : ''}${pairLabel(game, discord, half)}${suffix ? ` ${suffix}` : ''}`, 100);
}
const clampPage = (page, pages) => Math.min(Math.max(Number(page) || 0, 0), Math.max(pages - 1, 0));

// roster = the latest import's members (the index in customIds is the position in this list);
// match = matchDiscord result; suggestions = suggestPairs result; mappings = Map(discordId -> game name);
// nameOf(id) -> Discord name; page = page of the game-name menu; pick = index of the game name chosen in step b), or null;
// candidates = [{ id, name, username, score }] the Discord members not matched / paired yet, most similar to the picked name first;
// mpage = page of that menu; search = show the Discord member search (UserSelect) instead of the menu;
// ver = version of `roster` (see rosterVersion), carried in the customIds.
function buildMapView({ roster, match, suggestions = [], mappings = new Map(), nameOf = (id) => id, page = 0, pick = null, candidates = [], mpage = 0, search = false, note = null, ver = '0' }) {
  const rows = [];
  const lines = ['🔗 **Ghép tên game ⇄ Discord**'];
  if (note) lines.push(note);

  if (pick !== null && roster[pick]) {
    const name = roster[pick].name;
    const back = button('adm:gmap:r', '↩ Quay lại');
    if (search || !candidates.length) {
      lines.push(`Tìm người Discord của nhân vật **${escapeMarkdown(truncate(name, 100))}**:${candidates.length ? '' : ' (không còn ai chưa khớp trong danh sách)'}`);
      rows.push(new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(`adm:gmapu:${pick}:${ver}`).setPlaceholder(truncate(`Người Discord của ${name}`, 150)).setMinValues(1).setMaxValues(1)));
      rows.push(new ActionRowBuilder().addComponents(candidates.length ? [button(`adm:gmapm:${pick}:0:${ver}`, '↩ Danh sách gợi ý'), back] : [back]));
      return { content: truncate(lines.join('\n'), 2000), components: rows, allowedMentions: { parse: [] } };
    }
    const pages = Math.ceil(candidates.length / PAGE_SIZE);
    const mp = clampPage(mpage, pages);
    lines.push(`Chọn người Discord của nhân vật **${escapeMarkdown(truncate(name, 100))}** (chưa khớp ${candidates.length} người, giống tên nhất xếp trước${pages > 1 ? `, trang ${mp + 1}/${pages}` : ''}):`);
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`adm:gmapu:${pick}:${ver}`)
          .setPlaceholder(truncate(`Người Discord của ${name}`, 150))
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(
            candidates.slice(mp * PAGE_SIZE, (mp + 1) * PAGE_SIZE).map((c) => {
              const about = [c.username, c.score > 0 ? `giống ${Math.round(c.score * 100)}%` : null].filter(Boolean).join(' · ');
              return { label: truncate(c.name || c.username || c.id, 100), value: c.id, ...(about ? { description: truncate(about, 100) } : {}) };
            })
          )
      )
    );
    const nav = [];
    if (pages > 1) nav.push(button(`adm:gmapm:${pick}:${Math.max(mp - 1, 0)}:${ver}`, '◀', ButtonStyle.Secondary, mp === 0), button(`adm:gmapm:${pick}:${Math.min(mp + 1, pages - 1)}:${ver}`, '▶', ButtonStyle.Secondary, mp === pages - 1));
    nav.push(button(`adm:gmaps:${pick}:${ver}`, '🔎 Tìm người khác'), back);
    rows.push(new ActionRowBuilder().addComponents(nav));
    return { content: truncate(lines.join('\n'), 2000), components: rows, allowedMentions: { parse: [] } };
  }

  const counts = linkCounts(match);
  lines.push(`Chưa khớp: **${match.gameOnly.length}** tên game · **${match.discordOnly.length}** người Discord không khớp ai · ghép tay: **${counts.admin}** · tự liên kết: **${counts.self}** · tên tự nhập: **${counts.free}**`);
  if (!match.gameOnly.length) lines.push('🎉 Mọi tên trong game đã khớp một người Discord.');

  const indexOf = new Map(roster.map((g, i) => [g, i]));
  if (suggestions.length) {
    lines.push('① **Gợi ý**: chọn các cặp đúng rồi bấm ra ngoài menu để lưu.');
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`adm:gmapsug:${ver}`)
          .setPlaceholder(truncate(`Gợi ý ghép (${suggestions.length}) — chọn để ghép`, 150))
          .setMinValues(1)
          .setMaxValues(suggestions.length)
          .addOptions(
            suggestions.map((s) => ({
              label: pairLabel(s.game.name, s.discordName),
              value: `${indexOf.get(s.game)}:${s.discordId}`,
              description: `Giống ${Math.round(s.score * 100)}%`,
            }))
          )
      )
    );
  }

  const pages = Math.max(1, Math.ceil(match.gameOnly.length / PAGE_SIZE));
  const p = clampPage(page, pages);
  const onPage = match.gameOnly.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
  if (onPage.length) {
    lines.push(`② **Tự chọn**: chọn tên game${pages > 1 ? ` (trang ${p + 1}/${pages})` : ''}, rồi chọn người Discord.`);
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`adm:gmapg:${p}:${ver}`)
          .setPlaceholder('Chọn tên trong game…')
          .addOptions(
            onPage.map((g) => {
              const about = [g.className, g.rank].filter(Boolean).join(' · ');
              return { label: truncate(g.name, 100), value: String(indexOf.get(g)), ...(about ? { description: truncate(about, 100) } : {}) };
            })
          )
      )
    );
  }

  // existing pairs: a pair whose game name left the roster is marked "cũ" and listed first; one whose person is not in the member
  // cache is marked "chưa thấy" (it may just be missing from the cache, so it is not "cũ")
  const staleIds = new Set(match.stale.map((s) => s.discordId));
  const unseenIds = new Set((match.uncached || []).map((s) => s.discordId));
  const sources = mappings.sources instanceof Map ? mappings.sources : new Map();
  const unlistedIds = new Set((match.unlisted || []).map((s) => s.discordId));
  const own = (id) => (sources.get(id) || 'admin') !== 'admin'; // the member's own link (self / selfFree): unverified, listed before the admin's pairs
  const tag = (id) => {
    const src = sources.get(id) || 'admin';
    if (src === 'self') return '(tự liên kết)';
    return src === 'selfFree' ? (unlistedIds.has(id) ? '(tự nhập · ngoài danh sách)' : '(tự nhập)') : '';
  };
  const pairs = [...mappings]
    .sort(([, a], [, b]) => a.localeCompare(b, 'vi'))
    .sort(([a], [b]) => Number(own(b)) - Number(own(a)))
    .sort(([a], [b]) => Number(staleIds.has(b)) - Number(staleIds.has(a)))
    .slice(0, PAGE_SIZE);
  if (pairs.length) {
    lines.push(`③ **Gỡ ghép**: ${mappings.size} cặp đã ghép${mappings.size > pairs.length ? ` (menu hiện ${pairs.length} cặp đầu, cặp cũ rồi cặp thành viên tự liên kết xếp trước)` : ''}${staleIds.size ? `, ${staleIds.size} cặp cũ (tên game không còn trong danh sách)` : ''}${unseenIds.size ? `, ${unseenIds.size} người chưa thấy trong cache` : ''}.`);
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('adm:gmapdel')
          .setPlaceholder('Gỡ ghép…')
          .setMinValues(1)
          .setMaxValues(pairs.length)
          .addOptions(pairs.map(([id, game]) => ({ label: removeLabel(game, nameOf(id), tag(id), staleIds.has(id) ? '(cũ)' : unseenIds.has(id) ? '(chưa thấy)' : ''), value: id })))
      )
    );
  }

  const nav = [];
  if (pages > 1) {
    nav.push(button(`adm:gmapp:${Math.max(p - 1, 0)}`, '◀', ButtonStyle.Secondary, p === 0), button(`adm:gmapp:${Math.min(p + 1, pages - 1)}`, '▶', ButtonStyle.Secondary, p === pages - 1));
  }
  nav.push(button('adm:gmap:r', '🔄 Làm mới'), button('adm:gmap:g', '↩ Về Thành viên game'));
  rows.push(new ActionRowBuilder().addComponents(nav));
  return { content: truncate(lines.join('\n'), 2000), components: rows, allowedMentions: { parse: [] } };
}

module.exports = { buildMapView, PAGE_SIZE };
