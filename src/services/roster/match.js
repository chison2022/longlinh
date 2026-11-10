// Comparing rosters and matching characters with Discord members (pure, no DB): diff of two imports, summary, automatic and
// suggested name matches.
const { norm, fold, nameKey, isCutName, cutStem } = require('./names');

const RENAME_DAYS_TOLERANCE = 30; // a renamed character keeps its days in the guild (they only grow between two imports)

// prev / cur: member arrays (prev may be null). Names are compared with norm(), so a case/spacing edit is not a change.
// renamed = a removed and an added member of the same class whose days in the guild did not drop and grew by at most
// RENAME_DAYS_TOLERANCE (closest pairs first; a newcomer starts again near 0); they are not listed in added / removed. rankChanged = same name, other rank.
function diff(prev, cur) {
  const before = new Map((prev || []).map((m) => [norm(m.name), m]));
  const after = new Map((cur || []).map((m) => [norm(m.name), m]));
  const rankChanged = [];
  for (const [k, m] of after) {
    const old = before.get(k);
    if (old && old.rank !== m.rank) rankChanged.push({ name: m.name, from: old.rank, to: m.rank });
  }
  const removed = [...before].filter(([k]) => !after.has(k)).map(([, m]) => m);
  const added = [...after].filter(([k]) => !before.has(k)).map(([, m]) => m);
  const pairs = [];
  for (const from of removed) {
    for (const to of added) {
      const d = (Number(to.daysInGuild) || 0) - (Number(from.daysInGuild) || 0);
      if (from.className === to.className && d >= 0 && d <= RENAME_DAYS_TOLERANCE) pairs.push({ from, to, d });
    }
  }
  pairs.sort((a, b) => a.d - b.d);
  const usedFrom = new Set();
  const usedTo = new Set();
  const renamed = [];
  for (const p of pairs) {
    if (usedFrom.has(p.from) || usedTo.has(p.to)) continue;
    usedFrom.add(p.from);
    usedTo.add(p.to);
    renamed.push({ from: p.from, to: p.to });
  }
  return {
    added: added.filter((m) => !usedTo.has(m)),
    removed: removed.filter((m) => !usedFrom.has(m)),
    renamed,
    rankChanged,
  };
}

// members -> { total, byRank: [[rank, n]] (first-seen order), byClass: [[className, n]] (config order, then the rest) }
function summarize(members, classes = []) {
  const ranks = new Map();
  const perClass = new Map();
  for (const m of members) {
    const rank = m.rank || '—';
    ranks.set(rank, (ranks.get(rank) || 0) + 1);
    perClass.set(m.className, (perClass.get(m.className) || 0) + 1);
  }
  const order = [...classes.filter((c) => perClass.has(c)), ...[...perClass.keys()].filter((c) => !classes.includes(c))];
  return {
    total: members.length,
    byRank: [...ranks],
    byClass: order.map((c) => [c, perClass.get(c)]),
  };
}

// ---------- discord ----------

// members: game members; infos: [{ id, name, bot }] with the server display name; mappings (optional): Map(discordId -> exact
// game name) or a plain object, the pairs an admin made by hand. A mapped pair always wins: it is matched first and its game
// name is never offered to anyone else. A mapping whose game name is not in `members` is "stale": it matches nothing and is
// reported in `stale`. A mapping whose person is not in `infos` (member cache) keeps its game name and is reported in `uncached`
// (not stale: the person may just be missing from the cache). For everyone else the automatic match runs in tiers, each a full
// pass over everybody before the next one starts: equal after norm(), then after fold(), then a game name cut with "…" by prefix
// (folded). A game name is assigned only when exactly ONE remaining Discord member has its key in that tier; an ambiguous key
// leaves those people unmatched (for the suggestions / a manual pair). Bots are never listed.
// -> { matched: [{ game, discordId, how: 'manual'|'norm'|'fold'|'prefix', manual }], gameOnly: [member], discordOnly: [info],
//      stale: [{ discordId, gameName }], uncached: [{ discordId, gameName }] }
// `mappings` may carry `.sources` (Map discordId -> 'admin' | 'self' | 'selfFree', see loadMappings): a self link is matched like a hand
// pair (it wins over the automatic tiers) but marked with its source; a typed name (selfFree) that is not in the roster is not "stale"
// but listed in `unlisted` ("không có trong danh sách game").
function matchDiscord(members, infos, mappings = null) {
  const sources = mappings && mappings.sources instanceof Map ? mappings.sources : new Map();
  const unlisted = [];
  const people = (infos || []).filter((p) => !p.bot);
  const taken = new Set();
  const matched = [];
  const stale = [];
  const uncached = [];
  const done = new Set(); // discord ids paired by hand
  const pairs = mappings instanceof Map ? [...mappings] : Object.entries(mappings || {});
  const byExact = new Map();
  const byKey = new Map();
  for (const g of members) {
    if (!byExact.has(g.name)) byExact.set(g.name, g); // first member of a name wins
    if (!byKey.has(nameKey(g.name))) byKey.set(nameKey(g.name), g);
  }
  const present = new Set(people.map((p) => p.id));
  for (const [discordId, gameName] of pairs) {
    const source = sources.get(discordId) || 'admin';
    let g = byExact.get(gameName);
    if (!g && source === 'selfFree') {
      const promoted = byKey.get(nameKey(gameName)); // a typed name that is in the roster (other case / accents / spacing) IS that character
      if (promoted && !taken.has(promoted)) g = promoted;
    }
    if (!g && source === 'selfFree') {
      done.add(discordId);
      unlisted.push({ discordId, gameName });
      continue;
    }
    if (!g || taken.has(g)) {
      stale.push({ discordId, gameName });
      continue;
    }
    taken.add(g);
    done.add(discordId);
    if (present.has(discordId)) matched.push({ game: g, discordId, how: 'manual', manual: true, source });
    else uncached.push({ discordId, gameName });
  }
  const cut = (g) => isCutName(g.name);
  const open = members.filter((g) => !taken.has(g));
  let left = people.filter((p) => !done.has(p.id));
  const assign = (g, p, how) => {
    taken.add(g);
    matched.push({ game: g, discordId: p.id, how, manual: false });
    left = left.filter((x) => x !== p);
  };
  // one exact-key tier: key -> the people having it; a key held by exactly one person goes to the first free game member of it
  const tier = (how, keyOf) => {
    const byKey = new Map();
    for (const p of left) {
      const k = keyOf(p.name);
      byKey.set(k, [...(byKey.get(k) || []), p]);
    }
    for (const g of open) {
      if (taken.has(g) || cut(g)) continue;
      const who = byKey.get(keyOf(g.name));
      if (who && who.length === 1) assign(g, who[0], how);
    }
  };
  tier('norm', norm);
  tier('fold', fold);
  for (const g of open) {
    if (taken.has(g) || !cut(g)) continue;
    const stem = fold(g.name.slice(0, -1));
    if (!stem) continue;
    const who = left.filter((p) => fold(p.name).startsWith(stem));
    if (who.length === 1) assign(g, who[0], 'prefix');
  }
  return { matched, gameOnly: members.filter((g) => !taken.has(g)), discordOnly: left, stale, uncached, unlisted };
}

// ---------- suggestions ----------

function levenshtein(a, b) {
  const x = [...a];
  const y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length];
}

const MIN_SIMILARITY = 0.6; // suggestions below 60% similar (1 - levenshtein / longer length) are hidden
const PIECE_PENALTY = 0.95; // a match on one word of the Discord name ranks below a match on the whole name
const MIN_LEN = 3;

// Similarity 0..1 of two folded names: 1 - distance ratio; one containing the other (or sharing a cut name's stem) scores at
// least 0.6 + 0.4 * (shorter / longer). 0 below MIN_LEN characters.
function similarity(a, b) {
  const x = [...a].length;
  const y = [...b].length;
  if (Math.min(x, y) < MIN_LEN) return 0;
  const longer = Math.max(x, y);
  let sim = 1 - levenshtein(a, b) / longer;
  if (a.includes(b) || b.includes(a)) sim = Math.max(sim, 0.6 + (0.4 * Math.min(x, y)) / longer);
  return sim;
}

// The folded forms a Discord name may be compared as: the whole name and each word / bracketed part of it ("Alone(Cabat)"
// -> alonecabat, alone, cabat), the pieces shorter than MIN_LEN dropped.
function nameForms(name) {
  const whole = { text: fold(name), piece: false };
  const parts = String(name).split(/[\s()[\]{}|/\\·•,;:_\-–—]+/u).map(fold).filter((p) => p.length >= MIN_LEN && p !== whole.text);
  return [whole, ...[...new Set(parts)].map((text) => ({ text, piece: true }))];
}

// Similarity 0..1 of a (folded) game name to a Discord name's forms (see nameForms).
const bestScore = (gname, forms) => forms.reduce((best, f) => Math.max(best, similarity(gname, f.text) * (f.piece ? PIECE_PENALTY : 1)), 0);
const foldedGameName = (name) => fold(cutStem(name));

// Every person of `people` ([{ id, name, username?, ... }]) with their similarity to the game name (best of the server name and
// the username), best first (ties by name); people alike at 0 come last. -> [{ ...person, score }]
function rankPeople(gameName, people) {
  const gname = foldedGameName(gameName);
  return (people || [])
    .map((p) => ({ ...p, score: gname ? Math.max(bestScore(gname, nameForms(p.name)), p.username ? bestScore(gname, nameForms(p.username)) : 0) : 0 }))
    .sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name), 'vi') || (a.id < b.id ? -1 : 1));
}

// The game names of `games` ([{ name, ... }]) ranked by similarity to a Discord member's server name / username (best first, ties by
// name; names alike at 0 last). -> [{ game, score }]
function rankGames(games, name, username) {
  const forms = [...nameForms(name || ''), ...(username ? nameForms(username) : [])];
  return (games || [])
    .map((game) => {
      const gname = foldedGameName(game.name);
      return { game, score: gname ? bestScore(gname, forms) : 0 };
    })
    .sort((a, b) => b.score - a.score || String(a.game.name).localeCompare(String(b.game.name), 'vi'));
}

// Pairs of an unmatched game name and an unmatched Discord member that look alike (accent / case folded, at least
// MIN_SIMILARITY). Best first, each game name and each Discord member used once, at most `limit`.
// -> [{ game, discordId, discordName, score }]
function suggestPairs(gameOnly, discordOnly, limit = 25) {
  const candidates = [];
  const forms = (discordOnly || []).map((p) => ({ p, forms: nameForms(p.name) }));
  for (const g of gameOnly || []) {
    const gname = foldedGameName(g.name);
    if (!gname) continue;
    for (const { p, forms: fs } of forms) {
      const best = bestScore(gname, fs);
      if (best >= MIN_SIMILARITY) candidates.push({ game: g, discordId: p.id, discordName: p.name, score: best });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.game.name.localeCompare(b.game.name, 'vi') || a.discordName.localeCompare(b.discordName, 'vi'));
  const usedGame = new Set();
  const usedPerson = new Set();
  const out = [];
  for (const c of candidates) {
    if (out.length >= limit) break;
    if (usedGame.has(c.game) || usedPerson.has(c.discordId)) continue;
    usedGame.add(c.game);
    usedPerson.add(c.discordId);
    out.push(c);
  }
  return out;
}

// discordId -> the name to show for that person: their in-game name when they are paired by hand or matched exactly (equal after
// norm() / fold()); a prefix match on a cut "…" name is not exact enough, the Discord name stays. Pure.
function gameNameMap(match) {
  const names = new Map((match.matched || []).filter((m) => m.how !== 'prefix').map((m) => [m.discordId, m.game.name]));
  for (const u of match.unlisted || []) names.set(u.discordId, u.gameName); // a typed name that is not in the roster is still the person's name
  return names;
}

// discordId -> 'admin' | 'self' | 'selfFree' | 'auto' for everybody who has a game name in `gameNameMap(match)`.
function nameSources(match) {
  const out = new Map();
  for (const m of match.matched || []) if (m.how !== 'prefix') out.set(m.discordId, m.manual ? m.source || 'admin' : 'auto');
  for (const u of match.unlisted || []) out.set(u.discordId, 'selfFree');
  return out;
}

// { admin, self, free } of the hand-made links of a match: admin pairs, roster names the members picked, names they typed (in the roster or not).
function linkCounts(match) {
  const count = { admin: 0, self: 0, free: (match.unlisted || []).length };
  for (const m of match.matched || []) {
    if (!m.manual) continue;
    if (m.source === 'self') count.self += 1;
    else if (m.source === 'selfFree') count.free += 1;
    else count.admin += 1;
  }
  return count;
}

module.exports = { RENAME_DAYS_TOLERANCE, diff, summarize, matchDiscord, levenshtein, similarity, suggestPairs, rankPeople, rankGames, gameNameMap, nameSources, linkCounts };
