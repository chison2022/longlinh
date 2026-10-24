// In-game character names of Discord members, for the lineup image / xlsx / board. Display only: a failure here must never stop a
// lineup from being shown, so the loader falls back to "no names" (the Discord names are shown).
const gameRoster = require('../services/gameRosterService');
const db = require('../db');
const { memberInfo } = require('../services/rosterService');

const TTL_MS = 60 * 1000;
const cache = new Map(); // guildId -> { names, at, epoch }: the computed Map, valid for TTL_MS and until the roster / pairs / members change
let lastState = 1; // last DB connection state seen by a loader, to warn once per change

// Forget the cached names of a guild (member renamed / left, ...). The roster service bumps its own counter on import / pairing.
function invalidateGameNames(guildId) {
  if (guildId === undefined || guildId === null) return cache.clear();
  gameRoster.bump(guildId); // also stops a load that is in flight from caching what it read before the change
  cache.delete(String(guildId));
}

// console.warn once when the DB connection state differs from the one the previous call saw.
function noteState(where, state) {
  if (state === lastState) return;
  lastState = state;
  console.warn(`[${where}] database readyState ${state}: falling back to the Discord names`);
}

// guild -> Map(discordId -> game name) for the people paired by hand or matched exactly with the latest roster. Reads the member
// cache as it is (no fetch): this runs on every board click and for members' own buttons, hence the short cache and the
// names-only read of the roster.
async function loadGameInfo(guild) {
  const none = { names: new Map(), sources: new Map() };
  try {
    const members = guild && guild.members && guild.members.cache;
    if (!guild || !members) return none;
    const state = (db.isConnected() ? 1 : 0);
    noteState('gameNames', state);
    if (state !== 1) return none; // no DB connection: Discord names
    const key = String(guild.id);
    const epoch = gameRoster.epochOf(key);
    const hit = cache.get(key);
    if (hit && hit.epoch === epoch && Date.now() - hit.at < TTL_MS) return hit.info;
    const infos = [...members.values()].map(memberInfo).map((m) => ({ id: m.id, name: m.name, bot: m.bot }));
    const found = await gameRoster.matchGuild(guild.id, infos, await gameRoster.latest(guild.id, 'members.name'));
    const info = found ? { names: gameRoster.gameNameMap(found.match), sources: gameRoster.nameSources(found.match) } : none;
    cache.set(key, { info, at: Date.now(), epoch }); // epoch read BEFORE the load: a change meanwhile makes this entry stale at once
    return info;
  } catch (err) {
    console.error('[gameNames] cannot load the game names:', err.message);
    return none;
  }
}

// guild -> Map(discordId -> game name) (see loadGameInfo).
const loadGameNames = async (guild) => (await loadGameInfo(guild)).names;

module.exports = { loadGameInfo, loadGameNames,  invalidateGameNames, noteState };
