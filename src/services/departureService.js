// "Left the guild in game but still on Discord": the members linked to a game name that the latest in-game roster no longer
// has. findDeparted is pure; the rest touches the DB (linked members, the once-per-import claim on GuildConfig).
const db = require('../db');
const memberStore = require('./members');
const { rowToConfig } = require('./guildConfigService');
const gameRoster = require('./gameRosterService');

const { nameKey, isCutName, cutStem } = gameRoster;

// Roster (member array or import doc) -> { keys: Set of nameKey, stems: [nameKey of every name the game cut] }.
function indexRoster(roster) {
  const members = Array.isArray(roster) ? roster : (roster && roster.members) || [];
  const keys = new Set();
  const stems = [];
  for (const g of members) {
    const raw = String(g && g.name !== undefined ? g.name : '');
    const cut = isCutName(raw);
    const key = nameKey(cut ? cutStem(raw) : raw);
    if (!key) continue;
    keys.add(key);
    if (cut) stems.push(key);
  }
  return { keys, stems };
}

// Is this linked name in the indexed roster? A roster name cut with "…" counts for every linked name that starts with its stem
// (so an ambiguous stem keeps all of them); a linked name that is itself cut is present while any roster name starts with its stem.
// A name with no key at all is never judged (counts as present).
function inRoster(idx, gameName) {
  const cut = isCutName(gameName);
  const key = nameKey(cut ? cutStem(gameName) : gameName);
  if (!key) return true;
  if (cut) {
    for (const k of idx.keys) if (k.startsWith(key)) return true;
    return false;
  }
  if (idx.keys.has(key)) return true;
  return idx.stems.some((s) => key.startsWith(s));
}

// linkedMembers: [{ discordId, gameName, source?, gameNameAt?, displayName?, bot? }]; roster: the member array of an import
// ([{ name }]) or the import doc; guildMemberIds: who is in the Discord server now - a Set / array of ids, or a Map(id -> { name?,
// bot? }) (a bot is skipped, a name replaces the stored displayName). -> [{ discordId, gameName, source, displayName, gameNameAt }] by name.
// opts: importedAt (when the roster was imported: a link made AFTER it is not judged, the roster cannot know that person yet) and
// previous (the member array of the import before it, or null): a "selfFree" name (typed by the member, unchecked) is judged only
// when it appeared in the previous roster, so a made-up name never turns into a "left the guild" flag.
// Conservative on purpose (a wrong flag costs a kick): names are compared with nameKey, a name with no key is never judged.
function findDeparted(linkedMembers, roster, guildMemberIds, { importedAt = null, previous = null } = {}) {
  const idx = indexRoster(roster);
  const prevIdx = previous ? indexRoster(previous) : null;
  const rosterAt = importedAt ? new Date(importedAt).getTime() : NaN;
  const inGuild = guildMemberIds instanceof Map ? guildMemberIds : new Map([...(guildMemberIds || [])].map((id) => [id, null]));
  const out = [];
  for (const l of linkedMembers || []) {
    const guildInfo = inGuild.get(l.discordId);
    if (!inGuild.has(l.discordId) || l.bot || (guildInfo && guildInfo.bot)) continue;
    const gameName = String(l.gameName || '');
    if (inRoster(idx, gameName)) continue;
    const source = l.source || 'admin';
    const linkedAt = l.gameNameAt ? new Date(l.gameNameAt).getTime() : NaN;
    if (!Number.isNaN(rosterAt) && !Number.isNaN(linkedAt) && linkedAt > rosterAt) continue; // linked after this roster was imported
    if (source === 'selfFree' && !(prevIdx && inRoster(prevIdx, gameName))) continue; // typed by the member and never seen in a roster
    out.push({ discordId: l.discordId, gameName, source, displayName: (guildInfo && guildInfo.name) || l.displayName || '', gameNameAt: l.gameNameAt || null });
  }
  return out.sort((a, b) => String(a.displayName || a.gameName).localeCompare(String(b.displayName || b.gameName), 'vi') || (a.discordId < b.discordId ? -1 : 1));
}

// Everybody of the guild with a game name (any source) -> [{ discordId, gameName, source, displayName, gameNameAt }].
async function loadLinked(guildId) {
  const rows = await memberStore.listMembers(guildId, `gc.name is not null and gc.name <> ''`);
  return rows.map((r) => ({ discordId: r.discordId, gameName: r.gameName, source: r.gameNameSource || 'admin', displayName: r.displayName || '', gameNameAt: r.gameNameAt || null }));
}

// The import before the latest, for findDeparted's `previous`; only read when somebody in `linked` typed their own name.
// -> the member array, [] when there is no earlier import (then no selfFree name is judged), null when not needed.
async function previousMembers(guildId, linked) {
  if (!(linked || []).some((l) => l.source === 'selfFree')) return null;
  const prev = await gameRoster.previous(guildId);
  return (prev && prev.members) || [];
}

// A once-per-import claim kept in the guild settings: moves `idKey` to `rosterId` for the one caller that changes it. With `importedAt`
// the claim only moves forward (`atKey` is null or older than it). `extra` = more settings written with the claim.
async function claimImport(guildId, rosterId, importedAt, idKey, atKey, extra = {}) {
  const id = String(rosterId);
  const patch = { [idKey]: id, ...extra };
  const params = [guildId, id];
  let forward = '';
  if (importedAt) {
    patch[atKey] = new Date(importedAt);
    params.push(new Date(importedAt));
    forward = ` and (settings->>'${atKey}' is null or (settings->>'${atKey}')::timestamptz < $3)`;
  }
  params.push(JSON.stringify(patch));
  const rows = await db.q(
    `update guilds set settings = settings || $${params.length}::jsonb
     where id = $1 and (settings->>'${idKey}' is distinct from $2)${forward} returning id`,
    params
  );
  return rows.length === 1;
}

// Marks this import as handled. true only for the one caller that moved departNoticeRosterId to it, so two ticks / processes
// (or the upload and the tick) never post twice. With `importedAt` the claim only moves forward: an older import can never be
// claimed after a newer one (departNoticeImportedAt is null or older than it).
function claimNotice(guildId, rosterId, importedAt = null) {
  return claimImport(guildId, rosterId, importedAt, 'departNoticeRosterId', 'departNoticeImportedAt', { departNoticeIds: [], departNoticeMore: 0 });
}

// Marks a game import as handled by the off notice. true only for the one caller that moved offNoticeRosterId to it; the claim only moves
// forward by importedAt (an older import can never be claimed after a newer one).
function claimOffNotice(guildId, rosterId, importedAt = null) {
  return claimImport(guildId, rosterId, importedAt, 'offNoticeRosterId', 'offNoticeImportedAt');
}

const MAX_NOTICE_IDS = 60;

// The people the posted notice really listed (the lines shown, not the "… và K người nữa"), for the unlink button. Only written
// while the import is still the claimed one. `more` = how many were left out of the lines.
// `joined` / `warId`: the people listed as still registered for that war (the 🗑️ Gỡ báo danh button acts on them only).
async function saveNoticeIds(guildId, rosterId, ids, { more = 0, at = new Date(), joined = [], warId = null } = {}) {
  const patch = { departNoticeIds: [...ids].slice(0, MAX_NOTICE_IDS), departNoticeMore: more, departNoticeAt: at, departNoticeJoined: [...joined].slice(0, 200), departNoticeWarId: warId ? String(warId) : null };
  const rows = await db.q(`update guilds set settings = settings || $3::jsonb where id = $1 and settings->>'departNoticeRosterId' = $2 returning id`, [guildId, String(rosterId), JSON.stringify(patch)]);
  return { matchedCount: rows.length, modifiedCount: rows.length };
}

// -> { rosterId, ids, more, at, joined, warId } of the last posted notice, or null. Read from the DB (not the config cache).
async function getNotice(guildId) {
  const row = await db.one('select settings from guilds where id = $1', [guildId]);
  const c = row && row.settings;
  if (!c || !c.departNoticeRosterId) return null;
  return { rosterId: String(c.departNoticeRosterId), ids: c.departNoticeIds || [], more: c.departNoticeMore || 0, at: c.departNoticeAt ? new Date(c.departNoticeAt) : null, joined: c.departNoticeJoined || [], warId: c.departNoticeWarId || null };
}

// Guilds that have somewhere to post the notice.
async function listNoticeConfigs() {
  return (await db.q(`select id, settings, created_at, updated_at from guilds where settings->>'adminChannelId' is not null`)).map(rowToConfig);
}

module.exports = { findDeparted, loadLinked, previousMembers, claimNotice, claimOffNotice, saveNoticeIds, getNotice, listNoticeConfigs, MAX_NOTICE_IDS };
