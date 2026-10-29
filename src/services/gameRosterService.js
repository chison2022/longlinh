// In-game member list ("Thành Viên" screen transcribed to .xlsx): parse, store, compare with the previous import and with
// the Discord members. The parse / diff / match functions are pure; saveImport / latest / previous use the DB.
const ExcelJS = require('exceljs');
const JSZip = require('jszip'); // exceljs's own zip reader (also listed in package.json)
const db = require('../db');
const memberStore = require('./members');
const { canonicalClass } = require('./registrationService');

const SHEET = 'Thành viên';
const MAX_ROWS = 500;
const MAX_UNZIPPED_BYTES = 20 * 1024 * 1024; // zip-bomb guard: total uncompressed size of an .xlsx
const MAX_ZIP_RATIO = 100; // ... and per entry (uncompressed / compressed)
const RENAME_DAYS_TOLERANCE = 30; // a renamed character keeps its days in the guild (they only grow between two imports)
const UNKNOWN_CLASS = 'Chưa rõ';
// header text (start of the cell) -> member field. Other columns (an older file's "Lực chiến") are ignored.
const HEADERS = [
  ['STT', null],
  ['Tên nhân vật', 'name'],
  ['Chức vụ', 'rank'],
  ['Phái', 'className'],
  ['Ngày vào bang', 'daysInGuild'],
  ['Trạng thái', 'status'],
];

// ---------- parse ----------

// The in-game "Trạng thái" text (last seen) -> whole days offline, or null when it is not a text we know.
//   "Online", "Trong 1 giờ", "5 giờ trước", "20 phút trước" -> 0   ·   "3 ngày trước" -> 3   ·   "2 tuần trước" -> 14   ·   "1 tháng trước" -> 30   ·   "1 năm trước" -> 365
// Case, accents and spacing do not matter. Anything else (empty, "Offline", "Trong 3 ngày"...) is unknown: a wrong number would only cause a false warning.
function parseOffDays(text) {
  const t = String(text === null || text === undefined ? '' : text)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  if (t === 'online' || t === 'dang online' || t === 'truc tuyen') return 0;
  if (/^trong \d+ (gio|phut)$/.test(t)) return 0;
  const ago = /^(\d+) (giay|phut|gio|ngay|tuan|thang|nam) truoc$/.exec(t);
  if (!ago) return null;
  const n = Number(ago[1]);
  return { giay: 0, phut: 0, gio: 0, ngay: n, tuan: 7 * n, thang: 30 * n, nam: 365 * n }[ago[2]];
}

// Days offline of a stored roster member: the number saved at import (parseOffDays of its status), or null = unknown. An import made before
// this was saved has no number: it is never warned about (the status text of an old import is not worked out afterwards).
function offDaysOf(member) {
  return member && typeof member.offDays === 'number' && Number.isFinite(member.offDays) ? member.offDays : null;
}

// Cell value -> plain text (rich text / formula results / hyperlinks flattened).
function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('').trim();
    if ('result' in v) return cellText(v.result);
    if ('text' in v) return cellText(v.text);
  }
  return String(v).trim();
}

const echo = (text) => (text.length > 50 ? `${text.slice(0, 50)}…` : text); // raw cell text shown in an error message

// Numbers are rounded as they are (no digit stripping); text may carry thousand separators ("1.234.567"); error cells
// (#N/A ...) and text without a digit are rejected.
function cellNumber(v, label, row) {
  let x = v;
  while (x && typeof x === 'object' && !(x instanceof Date) && 'result' in x) x = x.result;
  if (typeof x === 'number') {
    if (!Number.isFinite(x) || x < 0) throw new Error(`Dòng ${row}: "${label}" phải là số (đang là "${echo(String(x))}").`);
    return Math.round(x);
  }
  if (x && typeof x === 'object' && 'error' in x) throw new Error(`Dòng ${row}: "${label}" đang là ô lỗi (${echo(String(x.error))}).`);
  const raw = cellText(x);
  if (raw === '') return 0;
  const n = /\d/.test(raw) ? Number(raw.replace(/[\s.,]/g, '')) : NaN;
  if (!Number.isFinite(n) || n < 0) throw new Error(`Dòng ${row}: "${label}" phải là số (đang là "${echo(raw)}").`);
  return n;
}

// Rejects a zip whose declared sizes look like a bomb (before exceljs inflates it). Not a zip at all: left to the loader.
// Known limitation (admin-only upload): forged declared sizes in the zip headers can bypass this check. It reads JSZip's private
// entry._data, so jszip is pinned exactly and a test fails if that shape disappears.
async function assertZipSane(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return;
  }
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    const data = entry._data || {};
    const size = Number(data.uncompressedSize) || 0;
    const packed = Number(data.compressedSize) || 0;
    total += size;
    if (total > MAX_UNZIPPED_BYTES || (size > 1024 && size > packed * MAX_ZIP_RATIO)) throw new Error('File nén bất thường (giải nén quá lớn), không nhận.');
  }
}

// .xlsx buffer -> members [{ name, rank, className, daysInGuild, status, offDays }] (the header "Trạng thái" also matches "Trạng thái (lúc quay)" of scripts/roster-video.js). Throws an Error with a Vietnamese message
// when the file is not a workbook, has no sheet "Thành viên", lacks a header or has no member.
async function parseRosterXlsx(buffer, classes = []) {
  await assertZipSane(buffer);
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw new Error('Không đọc được file. Hãy gửi file .xlsx hợp lệ.');
  }
  const ws = wb.getWorksheet(SHEET);
  if (!ws) throw new Error(`Không thấy sheet "${SHEET}".`);
  const cols = {};
  const missing = [];
  const header = ws.getRow(1);
  for (const [label, field] of HEADERS) {
    let found = 0;
    header.eachCell((cell, c) => {
      if (!found && cellText(cell.value).startsWith(label)) found = c;
    });
    if (!found) missing.push(label);
    else if (field) cols[field] = found;
  }
  if (missing.length) throw new Error(`Thiếu cột: ${missing.join(', ')}.`);
  if (ws.rowCount > MAX_ROWS + 1) throw new Error(`Quá nhiều dòng (tối đa ${MAX_ROWS}).`);

  const members = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const name = normalizeCut(cellText(row.getCell(cols.name).value));
    if (!name) continue;
    const className = cellText(row.getCell(cols.className).value);
    const status = cellText(row.getCell(cols.status).value);
    members.push({
      name,
      rank: cellText(row.getCell(cols.rank).value),
      className: className ? canonicalClass(className, classes) : UNKNOWN_CLASS,
      daysInGuild: cellNumber(row.getCell(cols.daysInGuild).value, 'Ngày vào bang', r),
      status,
      offDays: parseOffDays(status),
    });
  }
  if (!members.length) throw new Error('File không có thành viên nào.');
  return members;
}

// ---------- compare ----------

// Comparison key of a character name: NFKC, lower-case, spaces and punctuation/symbols removed.
const norm = (s) => String(s).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}\p{Cf}]+/gu, '');
// Same, with Vietnamese accents folded ("Hắc Phong" == "hac phong").
const fold = (s) => norm(s).normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd');

// Lookalike letters of other scripts -> the Latin letter they are drawn like (a typed name must not be able to hide behind them).
const CONFUSABLES = new Map(
  Object.entries({
    а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', к: 'k', м: 'm', т: 't', н: 'h', в: 'b', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ɡ: 'g',
    А: 'a', В: 'b', Е: 'e', К: 'k', М: 'm', Н: 'h', О: 'o', Р: 'p', С: 'c', Т: 't', Х: 'x', І: 'i', Ј: 'j', Ѕ: 's',
    α: 'a', ο: 'o', ν: 'v', ρ: 'p', ι: 'i', κ: 'k', τ: 't', υ: 'u', χ: 'x', Α: 'a', Β: 'b', Ε: 'e', Ζ: 'z', Η: 'h', Ι: 'i', Κ: 'k', Μ: 'm', Ν: 'n', Ο: 'o', Ρ: 'p', Τ: 't', Υ: 'y', Χ: 'x',
  })
);
const skeleton = (s) => [...String(s)].map((ch) => CONFUSABLES.get(ch) || ch).join('');
// The key a game name is unique by: fold() of the name with lookalike letters mapped to Latin ("Кelo" == "Kelo").
const nameKey = (s) => fold(skeleton(String(s).normalize('NFKC')));

// A name the game cut is written "Abc…"; a transcription may have "Abc..." instead. Both are cut names; normalizeCut gives the "…" form.
const CUT_RE = /\s*(?:…|\.{3})$/;
const isCutName = (name) => CUT_RE.test(String(name));
const normalizeCut = (name) => String(name).replace(/\s*\.{3}$/, '…');
const cutStem = (name) => String(name).replace(CUT_RE, '');

const FREE_NAME_MAX = 32;
// Letters: Basic Latin, Latin-1, Latin Extended-A/B and Latin Extended Additional (Vietnamese); NOT IPA / phonetic / small-capital lookalikes (ʙ ꜰ ᴏ ɑ)
const FREE_NAME_OK = /^[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F\u1E00-\u1EFF\u0300-\u036F\p{N}\s_.\-'·]+$/u; // letters, combining accents, digits, space and a few symbols
// A name the member typed -> { name } (NFKC, invisible format characters removed, spaces collapsed) or { error } (Vietnamese sentence).
function cleanFreeName(input) {
  const name = String(input ?? '')
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name || [...name].length > FREE_NAME_MAX) return { error: `Tên phải từ 1 đến ${FREE_NAME_MAX} ký tự.` };
  if (!FREE_NAME_OK.test(name)) return { error: "Tên chỉ được dùng chữ Latin / tiếng Việt, số, khoảng trắng và các ký tự _ . - ' · (không trộn chữ của bảng chữ cái khác, không emoji)." };
  if (!nameKey(name)) return { error: 'Tên phải có ít nhất một chữ hoặc số.' };
  return { name };
}

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

/// ---------- db ----------

// Per guild change counter: anything that caches what the roster / the pairs say (bot/gameNames) compares it to know it is stale.
const epochs = new Map();
const epochOf = (guildId) => epochs.get(String(guildId)) || 0;
const bump = (guildId) => epochs.set(String(guildId), epochOf(guildId) + 1);

// Short version of a roster import (its id): put in the customIds of the pairing menus, so a click made on an older roster than
// the latest one is recognised (the menus carry positions in the roster).
const rosterVersion = (doc) => (doc && doc._id ? String(doc._id).slice(-8) : '0');

// The key a character is stored under: nameKey, or the raw name for a symbol-only name (never '').
const storedKey = (name) => nameKey(name) || `#${String(name)}`;

const IMPORT_SQL = `select id as "_id", guild_id as "guildId", imported_at as "importedAt", imported_by as "importedBy", source from roster_imports`;
const CHARACTER_FIELDS = `id, name, rank, class_name as "className", days_in_guild as "daysInGuild", status, off_days as "offDays",
  first_seen as "firstSeen", left_at as "leftAt", returned_at as "returnedAt", old_names as "oldNames", game_uid as "gameUid"`;

// The characters an import listed, in its order (only the latest import of a character is known: no per-import history).
const membersOf = (importId) => db.q(`select ${CHARACTER_FIELDS} from game_characters where last_import_id = $1 order by position`, [importId]);

// Saves one in-game roster: each character keeps its row (found by name key among those still in the guild, else the newest one
// that left, which comes back), its numbers are overwritten, and the characters this roster no longer lists get left_at.
// A name typed by a member (origin 'typed') becomes a roster character when the roster lists it. A second line with the same
// name key is skipped (one row per name). -> the import as { _id, guildId, importedAt, importedBy, source, members }
async function saveImport({ guildId, importedBy = 'script', source = '', members, importedAt = new Date() }) {
  const doc = await db.tx(async () => {
    const imp = await db.one('insert into roster_imports (guild_id, imported_at, imported_by, source, total) values ($1, $2, $3, $4, $5) returning id', [guildId, importedAt, importedBy, source, members.length]);
    const seen = new Set();
    let position = 0;
    for (const m of members) {
      const key = storedKey(m.name);
      if (seen.has(key)) continue;
      seen.add(key);
      const values = [m.name, m.rank || '', m.className || '', Math.round(Number(m.daysInGuild) || 0), m.status || '', m.offDays ?? null, imp.id, position++];
      const hit = await db.one(
        `select id from game_characters where guild_id = $1 and name_key = $2 order by (left_at is null) desc, left_at desc nulls first, id desc limit 1`,
        [guildId, key]
      );
      if (hit) {
        // a character that had left and is listed again came back (returned_at); the right-hand side reads the old left_at
        await db.q(
          `update game_characters set name = $2, rank = $3, class_name = $4, days_in_guild = $5, status = $6, off_days = $7,
             last_import_id = $8, position = $9, origin = 'roster', returned_at = case when left_at is not null then $10 else returned_at end,
             left_at = null where id = $1`,
          [hit.id, ...values, importedAt]
        );
      } else {
        await db.q(
          `insert into game_characters (guild_id, name_key, name, rank, class_name, days_in_guild, status, off_days, last_import_id, position, origin, first_seen)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'roster', $11)`,
          [guildId, key, ...values, importedAt]
        );
      }
    }
    await db.q(`update game_characters set left_at = $3 where guild_id = $1 and origin = 'roster' and left_at is null and last_import_id is distinct from $2`, [guildId, imp.id, importedAt]);
    return { _id: imp.id, guildId, importedAt, importedBy, source };
  });
  bump(guildId);
  return { ...doc, members: await membersOf(doc._id) };
}

// The newest import of the guild with its members (null without one). `projection` (old Mongo style, e.g. '_id importedAt') that does
// not mention members skips the member list.
async function latest(guildId, projection) {
  const doc = await db.one(`${IMPORT_SQL} where guild_id = $1 order by imported_at desc, id desc limit 1`, [guildId]);
  if (!doc) return null;
  if (projection && !/members/.test(projection)) return doc;
  return { ...doc, members: await membersOf(doc._id) };
}

// ➕ Thêm tên game: appends one character typed by a manager to the LATEST import, in place. Same import id on purpose: the per-import
// notices (off / left the game, claimed per roster id) are not posted again, and the positions in open menus stay valid (appended at the end).
// The next real import replaces it. -> { member } | { error } (Vietnamese)
async function addManualMember(guildId, { name, className, rank }) {
  const cleaned = cleanFreeName(name);
  if (cleaned.error) return { error: cleaned.error };
  const out = await db.tx(async () => {
    const imp = await db.one('select id from roster_imports where guild_id = $1 order by imported_at desc, id desc limit 1 for update', [guildId]);
    if (!imp) return { error: 'Chưa có danh sách game: bấm 📤 Cập nhật danh sách trước.' };
    const key = storedKey(cleaned.name);
    const taken = await db.one('select name from game_characters where last_import_id = $1 and name_key = $2', [imp.id, key]);
    if (taken) return { error: `Tên **${taken.name}** đã có trong danh sách game.` };
    const member = { name: cleaned.name, rank: String(rank || ''), className: String(className || ''), daysInGuild: 0, status: '', offDays: null };
    const pos = await db.one('select coalesce(max(position), -1) + 1 as p from game_characters where last_import_id = $1', [imp.id]);
    const typed = await db.one(`select id from game_characters where guild_id = $1 and name_key = $2 and left_at is null`, [guildId, key]);
    if (typed) {
      await db.q(`update game_characters set name = $2, rank = $3, class_name = $4, origin = 'roster', last_import_id = $5, position = $6 where id = $1`, [typed.id, member.name, member.rank, member.className, imp.id, pos.p]);
    } else {
      await db.q(
        `insert into game_characters (guild_id, name_key, name, rank, class_name, origin, last_import_id, position) values ($1, $2, $3, $4, $5, 'roster', $6, $7)`,
        [guildId, key, member.name, member.rank, member.className, imp.id, pos.p]
      );
    }
    return { member };
  });
  if (out.member) bump(guildId);
  return out;
}

// One import of the guild by its id; null when it does not exist (or is not this guild's). Only the latest import of each
// character is kept, so an older import comes back with the characters it was the last one to list.
async function byId(guildId, id) {
  if (!/^\d+$/.test(String(id))) return null;
  const doc = await db.one(`${IMPORT_SQL} where id = $1 and guild_id = $2`, [Number(id), guildId]);
  return doc ? { ...doc, members: await membersOf(doc._id) } : null;
}

// Cheap summary of the latest import for the dashboard: { importedAt, source, count } without loading the member list.
async function latestMeta(guildId) {
  const doc = await db.one(
    `select i.imported_at as "importedAt", i.source, (select count(*) from game_characters g where g.last_import_id = i.id) as count
     from roster_imports i where i.guild_id = $1 order by i.imported_at desc, i.id desc limit 1`,
    [guildId]
  );
  return doc || null;
}

// The "Chức vụ" of every member of the latest import (just the rank strings, in roster order) for the dashboard headcount; null without an import.
async function latestRanks(guildId) {
  const imp = await db.one('select id from roster_imports where guild_id = $1 order by imported_at desc, id desc limit 1', [guildId]);
  if (!imp) return null;
  return (await db.q('select rank from game_characters where last_import_id = $1 order by position', [imp.id])).map((r) => r.rank);
}

// ---------- name mappings (character_links) ----------

// Map(discordId -> game name) of the guild's pairs (admin pairs and members' own links).
// The returned Map also carries `.sources` (Map discordId -> 'admin' | 'self' | 'selfFree').
async function loadMappings(guildId) {
  const rows = await db.q(
    `select m.discord_id, g.name, l.source from character_links l join discord_members m on m.id = l.member_id
     join game_characters g on g.id = l.character_id where l.guild_id = $1`,
    [guildId]
  );
  const map = new Map(rows.map((r) => [r.discord_id, r.name]));
  map.sources = new Map(rows.map((r) => [r.discord_id, r.source]));
  return map;
}

// The row a name points at: the one still in the guild with that name key, else the newest that left. Shared by the links and the
// game ID claim, so both always land on the same character. -> { id, game_uid } | null
const findCharacter = (guildId, name, lock = false) =>
  db.one(`select id, game_uid from game_characters where guild_id = $1 and name_key = $2 order by (left_at is null) desc, left_at desc nulls first, id desc limit 1${lock ? ' for update' : ''}`, [guildId, storedKey(name)]);

// The character a link to `name` points at: the one still in the guild with that name key, else the newest that left, else a new
// 'typed' character (a name no roster has shown). -> character id
async function characterFor(guildId, name) {
  const key = storedKey(name);
  const hit = await findCharacter(guildId, name);
  if (hit) return hit.id;
  const row = await db.one(`insert into game_characters (guild_id, name_key, name, origin) values ($1, $2, $3, 'typed') returning id`, [guildId, key, String(name).trim()]);
  return row.id;
}

// Typed characters nobody links any more are forgotten. Their game ID goes with them on purpose (a typed row is unverified; the ID is
// asked again at the gate / by a manager). The gate's own claim removes its row again when an approval fails.
const forgetUnlinkedTyped = (guildId) =>
  db.q(`delete from game_characters g where g.guild_id = $1 and g.origin = 'typed' and not exists (select 1 from character_links l where l.character_id = g.id)`, [guildId]);

// A member who typed the ID of a character themself (game_uid_by = their Discord id) loses it when their self link leaves that character -
// else link, stamp any ID, unlink and repeat would plant IDs on roster names nobody has claimed. `cond` filters the links being
// removed or moved (aliases l = character_links, m = discord_members, g = game_characters; $1 = guild, params from $2).
const releaseOwnUid = (guildId, cond, params = []) =>
  db.q(
    `update game_characters g set game_uid = null, game_uid_by = null from character_links l join discord_members m on m.id = l.member_id
     where l.character_id = g.id and g.guild_id = $1 and g.game_uid_by = m.discord_id and ${cond}`,
    [guildId, ...params]
  );

// Points member `memberId` at character `characterId` (its old link, if any, is replaced).
async function writeLink(guildId, memberId, characterId, source, linkedBy = null) {
  await db.q('delete from character_links where member_id = $1', [memberId]);
  await db.q('insert into character_links (character_id, member_id, guild_id, source, linked_by) values ($1, $2, $3, $4, $5)', [characterId, memberId, guildId, source, linkedBy]);
}

const NAME_TAKEN = 'tên game đã được ghép cho người khác';
const nameTaken = () => Object.assign(new Error(NAME_TAKEN), { code: 'GAME_NAME_TAKEN' });

// Saves pairs [{ discordId, gameName, displayName? }]. A game name belongs to one person: whoever had it (any spelling of it) loses it.
// A person has one game name: the last pair wins. All pairs are written in one transaction. -> how many pairs were saved
async function setMappings(guildId, pairs) {
  const last = new Map(pairs.filter((p) => p.discordId && p.gameName).map((p) => [p.discordId, p]));
  const byName = new Map([...last.values()].map((p) => [p.gameName, p]));
  try {
    await db.tx(async () => {
      for (const p of byName.values()) {
        const mid = await memberStore.memberId(guildId, p.discordId, p.displayName || undefined);
        const charId = await characterFor(guildId, p.gameName);
        // the newest pair takes the name: whoever holds a character with that name key loses it (and the ID they typed on it)
        await releaseOwnUid(guildId, 'l.member_id <> $2 and g.name_key = $3', [mid, storedKey(p.gameName)]);
        await releaseOwnUid(guildId, 'l.member_id = $2 and l.character_id <> $3', [mid, charId]); // the character this person leaves
        await db.q(
          `delete from character_links l using game_characters g where l.character_id = g.id and l.member_id <> $2 and g.guild_id = $1 and g.name_key = $3`,
          [guildId, mid, storedKey(p.gameName)]
        );
        await writeLink(guildId, mid, charId, 'admin');
      }
      await forgetUnlinkedTyped(guildId);
    });
  } catch (err) {
    if (db.isUniqueViolation(err)) throw nameTaken();
    throw err;
  } finally {
    bump(guildId);
  }
  return byName.size;
}

// ---------- the member's own link ----------

const TAKEN_ADMIN_MSG = 'Tên này đã được quản lý gán cho người khác — báo quản lý nếu nhầm';
const TAKEN_SELF_MSG = 'Đã có thành viên khác nhận tên này — báo quản lý để xác minh';
const TAKEN_AUTO_MSG = 'Tên này đang khớp tự động với người khác — báo quản lý nếu nhầm';
// source of the holder ('admin' | 'self' | 'selfFree' | 'auto') -> the refusal text
const takenMessage = (source) => (source === 'self' || source === 'selfFree' ? TAKEN_SELF_MSG : source === 'auto' ? TAKEN_AUTO_MSG : TAKEN_ADMIN_MSG);
const failWith = (code, message, extra) => Object.assign(new Error(message), { code }, extra);

// The member's current link -> { gameName, source } or null.
async function getLink(guildId, discordId) {
  const row = await db.one(
    `select g.id as character_id, g.name, g.game_uid, l.source from character_links l join discord_members m on m.id = l.member_id join game_characters g on g.id = l.character_id
     where m.guild_id = $1 and m.discord_id = $2`,
    [guildId, discordId]
  );
  return row ? { gameName: row.name, source: row.source, gameUid: row.game_uid || null, characterId: row.character_id } : null;
}

// The member links themself with a game name: `free` = typed by hand (source selfFree, unverified), else a roster name (source self).
// Refused with code GAME_NAME_TAKEN (err.holder = { id, source }) when ANY other member holds the name (admin pair or self link,
// compared with nameKey) and with code ADMIN_LOCKED when an admin already paired this member. The check and the write run in one
// transaction. -> { gameName, source }
async function selfLink(guildId, discordId, gameName, { free = false, displayName = '' } = {}) {
  const name = String(gameName).trim();
  const key = nameKey(name) || null;
  if (!key) throw failWith('GAME_NAME_INVALID', 'Tên trống.');
  const api = module.exports;
  const source = free ? 'selfFree' : 'self';
  try {
    await db.tx(async () => {
      const mappings = await api.loadMappings(guildId);
      const sources = mappings.sources || new Map();
      for (const [id, other] of mappings) {
        const src = sources.get(id) || 'admin';
        if (id === discordId) {
          if (src === 'admin') throw failWith('ADMIN_LOCKED', 'Quản lý đã gán tên game cho bạn — nhờ quản lý đổi nếu nhầm.');
        } else if (nameKey(other) === key) {
          throw failWith('GAME_NAME_TAKEN', takenMessage(src), { holder: { id, source: src } });
        }
      }
      const mid = await memberStore.memberId(guildId, discordId, displayName || undefined);
      const target = await characterFor(guildId, name);
      await releaseOwnUid(guildId, 'l.member_id = $2 and l.character_id <> $3', [mid, target]);
      await writeLink(guildId, mid, target, source);
      await forgetUnlinkedTyped(guildId);
    });
  } catch (err) {
    if (db.isUniqueViolation(err)) throw failWith('GAME_NAME_TAKEN', TAKEN_SELF_MSG, { holder: null }); // lost a race for the name
    throw err;
  }
  bump(guildId); // only after a write that really happened
  return { gameName: name, source };
}

// The member removes their OWN link; an admin's pair stays (code ADMIN_LOCKED). -> true when a link was removed
async function selfUnlink(guildId, discordId) {
  const link = await getLink(guildId, discordId);
  if (!link) return false;
  if (link.source === 'admin') throw failWith('ADMIN_LOCKED', 'Liên kết này do quản lý gán — nhờ quản lý gỡ.');
  const removed = await db.tx(async () => {
    await releaseOwnUid(guildId, `m.discord_id = $2 and l.source in ('self', 'selfFree')`, [discordId]);
    const rows = await db.q(
      `delete from character_links l using discord_members m where l.member_id = m.id and m.guild_id = $1 and m.discord_id = $2 and l.source in ('self', 'selfFree') returning l.character_id`,
      [guildId, discordId]
    );
    await forgetUnlinkedTyped(guildId);
    return rows.length > 0;
  });
  if (removed) bump(guildId);
  return removed;
}

// Removes the pairs of these discord ids; -> how many were removed.
async function removeMappings(guildId, discordIds) {
  if (!discordIds.length) return 0;
  try {
    return await db.tx(async () => {
      await releaseOwnUid(guildId, 'm.discord_id = any($2)', [discordIds]);
      const rows = await db.q(
        `delete from character_links l using discord_members m where l.member_id = m.id and m.guild_id = $1 and m.discord_id = any($2) returning l.character_id`,
        [guildId, discordIds]
      );
      await forgetUnlinkedTyped(guildId);
      return rows.length;
    });
  } finally {
    bump(guildId);
  }
}

// The latest import with the Discord match applied (mappings included); null without an import. `roster` may be passed when
// it is already loaded. -> { roster, mappings, match }
async function matchGuild(guildId, infos, roster) {
  const api = module.exports; // looked up at call time so tests can stub latest / loadMappings
  const doc = roster === undefined ? await api.latest(guildId) : roster;
  if (!doc) return null;
  const mappings = await api.loadMappings(guildId);
  return { roster: doc, mappings, match: matchDiscord(doc.members, infos, mappings) };
}

// The import before the latest one, with the characters that were in the guild then: seen before it and not gone by then
// (no per-import history: someone who left and came back between the two is counted too).
async function previous(guildId) {
  const doc = await db.one(`${IMPORT_SQL} where guild_id = $1 order by imported_at desc, id desc offset 1 limit 1`, [guildId]);
  if (!doc) return null;
  const rows = await db.q(
    `select ${CHARACTER_FIELDS} from game_characters where guild_id = $1 and origin = 'roster' and first_seen <= $2 and (left_at is null or left_at > $2) order by position nulls last, id`,
    [guildId, doc.importedAt]
  );
  return { ...doc, members: rows };
}

// People the member sheet leaves out because they left the guild: Discord ids still linked to a character that left, and the name
// keys of the characters that left within DEPARTED_NAME_DAYS (a Discord name equal to one is that person; later a namesake is shown).
// A name a character in the guild has again is not listed.
const DEPARTED_NAME_DAYS = 60;
async function departedOf(guildId, now = new Date()) {
  const rows = await db.q(
    `select g.name_key, g.left_at, m.discord_id from game_characters g
     left join character_links l on l.character_id = g.id left join discord_members m on m.id = l.member_id
     where g.guild_id = $1 and g.left_at is not null
       and not exists (select 1 from game_characters a where a.guild_id = g.guild_id and a.left_at is null and a.name_key = g.name_key)`,
    [guildId]
  );
  const since = now.getTime() - DEPARTED_NAME_DAYS * 24 * 3600 * 1000;
  return { ids: new Set(rows.map((r) => r.discord_id).filter(Boolean)), keys: new Set(rows.filter((r) => new Date(r.left_at).getTime() > since).map((r) => r.name_key)) };
}

// ---------- ✏️ Đổi tên (a manager confirms that a character who "left" and a "new" one are the same person) ----------

const RENAME_LEFT_DAYS = 60; // characters that left within this many days are offered
const MAX_CHOICES = 25; // one select menu

// What the ✏️ Đổi tên view offers. left: characters gone within RENAME_LEFT_DAYS, newest first; fresh: characters still in the guild
// that the latest import listed for the first time (first seen after the import before it). `pairs` = likely renames: the same class,
// and the days in the guild did not drop and grew by at most RENAME_DAYS_TOLERANCE plus the days between the two imports. Best first.
// -> { left, fresh, pairs: [{ from, to }] } (characters as { id, name, className, daysInGuild, leftAt | firstSeen })
async function renameChoices(guildId, now = new Date()) {
  const fields = `id, name, class_name as "className", days_in_guild as "daysInGuild", left_at as "leftAt", first_seen as "firstSeen",
    exists (select 1 from character_links l where l.character_id = game_characters.id) as linked`;
  const left = await db.q(
    `select ${fields} from game_characters where guild_id = $1 and origin = 'roster' and left_at is not null and left_at > $2 order by left_at desc, id desc limit ${MAX_CHOICES}`,
    [guildId, new Date(now.getTime() - RENAME_LEFT_DAYS * 24 * 3600 * 1000)]
  );
  const prev = await db.one('select imported_at from roster_imports where guild_id = $1 order by imported_at desc, id desc offset 1 limit 1', [guildId]);
  const fresh = prev
    ? await db.q(`select ${fields} from game_characters where guild_id = $1 and origin = 'roster' and left_at is null and first_seen > $2 order by first_seen desc, name limit ${MAX_CHOICES}`, [guildId, prev.imported_at])
    : [];
  const pairs = [];
  for (const from of left) {
    for (const to of fresh) {
      if (from.className !== to.className) continue;
      const gap = Math.max(0, Math.round((new Date(to.firstSeen) - new Date(from.leftAt)) / (24 * 3600 * 1000)));
      const d = (Number(to.daysInGuild) || 0) - (Number(from.daysInGuild) || 0);
      if (d >= 0 && d <= RENAME_DAYS_TOLERANCE + gap) pairs.push({ from, to, score: Math.abs(d - gap) });
    }
  }
  pairs.sort((a, b) => a.score - b.score);
  const usedFrom = new Set();
  const usedTo = new Set();
  const best = [];
  for (const p of pairs) {
    if (usedFrom.has(p.from.id) || usedTo.has(p.to.id)) continue;
    usedFrom.add(p.from.id);
    usedTo.add(p.to.id);
    best.push({ from: p.from, to: p.to });
  }
  return { left, fresh, pairs: best };
}

// ---------- in-game character ID ----------

const GAME_UID_MIN = 5;
const GAME_UID_MAX = 20;
// What a member / manager typed -> { uid } ('' = none) or { error } (Vietnamese sentence). Spaces around are trimmed; digits only.
function cleanGameUid(input) {
  const uid = String(input ?? '').trim();
  if (!uid) return { uid: '' };
  if (!new RegExp(`^[0-9]{${GAME_UID_MIN},${GAME_UID_MAX}}$`).test(uid)) return { error: `ID game chỉ gồm chữ số (${GAME_UID_MIN} đến ${GAME_UID_MAX} số), không có chữ, dấu cách hay ký tự khác.` };
  return { uid };
}

// The character (still in the guild or not) that holds `uid`, other than `exceptId`; null when free. -> { id, name, left } | null
const uidHolder = (guildId, uid, exceptId = null) =>
  db.one('select id, name, left_at is not null as left from game_characters where guild_id = $1 and game_uid = $2 and ($3::bigint is null or id <> $3::bigint)', [guildId, uid, exceptId]);
// The sentence for a holder; a departed one may be the same person under a new name.
const uidTakenText = (holder) => (holder.left ? `ID này thuộc nhân vật **${holder.name}** (đã rời bang) — có thể là cùng người đổi tên: dùng ✏️ Đổi tên.` : `ID game này đang thuộc nhân vật **${holder.name}**.`);

const PENDING_UID_TEXT = 'ID này đang được một người khác dùng để xin vào bang. Kiểm tra lại ID của bạn.';

// A member's ID at the gate: -> { uid } | { error } (format, held by another character - departed ones too, or reserved by another
// pending request). `exceptName`: the character the member picked - an ID it already carries (a manager typed it) is the member's own.
async function checkGameUid(guildId, input, { exceptName = null, exceptId = null } = {}) {
  const cleaned = cleanGameUid(input);
  if (cleaned.error || !cleaned.uid) return cleaned;
  // exceptId (a member's linked character row) wins over the name: a departed row and a live one can share a name key
  const own = exceptId ? await db.one('select id, game_uid from game_characters where guild_id = $1 and id = $2', [guildId, exceptId]) : exceptName ? await findCharacter(guildId, exceptName) : null;
  if (own && own.game_uid && own.game_uid !== cleaned.uid) return { error: 'Nhân vật này đã có một ID game khác. Nhập đúng ID của nhân vật, hoặc báo quản lý nếu ID cũ bị nhầm.' };
  const holder = await uidHolder(guildId, cleaned.uid, own ? own.id : null);
  if (holder) return { error: uidTakenText(holder) };
  if (await db.one(`select 1 as x from gate_requests where guild_id = $1 and game_uid = $2 and status = 'pending'`, [guildId, cleaned.uid])) return { error: PENDING_UID_TEXT };
  return cleaned;
}

// ✏️ A manager sets (or, with uid '', removes) the ID of the character still in the guild called `name`. -> { name, uid } | { error } (Vietnamese)
async function setGameUid(guildId, name, input) {
  const cleaned = cleanGameUid(input);
  if (cleaned.error) return { error: cleaned.error };
  const typed = String(name ?? '').replace(/\s+/g, ' ').trim();
  const row = typed ? await db.one('select id, name from game_characters where guild_id = $1 and name_key = $2 and left_at is null', [guildId, storedKey(typed)]) : null;
  if (!row) return { error: `Không tìm thấy nhân vật **${typed.slice(0, FREE_NAME_MAX) || '?'}** trong danh sách game hiện tại.` };
  try {
    if (cleaned.uid) {
      const holder = await uidHolder(guildId, cleaned.uid, row.id);
      if (holder) return { error: uidTakenText(holder) };
    }
    await db.q('update game_characters set game_uid = $2, game_uid_by = null where id = $1', [row.id, cleaned.uid || null]);
  } catch (err) {
    if (!db.isUniqueViolation(err)) throw err;
    return { error: 'ID game này vừa được nhân vật khác nhận, thử lại.' };
  }
  bump(guildId);
  return { name: row.name, uid: cleaned.uid || null };
}

// The gate gives an approved applicant's ID to the character the name points at (the same row the link will use; a name nobody has
// yet becomes a 'typed' character). Runs in one transaction with the row locked, so two approvals cannot both take an ID. A clash
// never writes anything. -> { status: 'set' | 'same', characterId, created } | { status: 'clash', text }
// opts.characterId: the row to give the ID to (a member's linked character - the name could also match another row); opts.by: a Discord id
// when the member typed the ID themself (gn:uid), recorded in game_uid_by so it is taken back with their self link. Null for the gate.
async function claimGameUid(guildId, name, uid, { characterId = null, by = null } = {}) {
  try {
    const out = await db.tx(async () => {
      const row = characterId ? await db.one('select id, game_uid from game_characters where guild_id = $1 and id = $2 for update', [guildId, characterId]) : await findCharacter(guildId, name, true);
      if (row && row.game_uid === uid) return { status: 'same', characterId: row.id, created: false };
      if (row && row.game_uid) return { status: 'clash', text: 'Nhân vật này đã có một ID game khác. Báo quản lý nếu ID cũ bị nhầm.' };
      const holder = await uidHolder(guildId, uid, row ? row.id : null);
      if (holder) return { status: 'clash', text: uidTakenText(holder) };
      if (row) {
        await db.q('update game_characters set game_uid = $2, game_uid_by = $3 where id = $1', [row.id, uid, by]);
        return { status: 'set', characterId: row.id, created: false };
      }
      const made = await db.one(`insert into game_characters (guild_id, name_key, name, origin, game_uid) values ($1, $2, $3, 'typed', $4) returning id`, [guildId, storedKey(name), String(name).trim(), uid]);
      return { status: 'set', characterId: made.id, created: true };
    });
    if (out.status === 'set') bump(guildId);
    return out;
  } catch (err) {
    if (!db.isUniqueViolation(err)) throw err;
    return { status: 'clash', text: 'ID game này vừa được nhân vật khác nhận.' };
  }
}

// Undo a claimGameUid() that set the ID (the approval it belonged to did not finish): the ID is cleared, and a typed row the claim
// made is removed again (nobody is linked to it yet).
async function releaseGameUid(guildId, characterId) {
  await db.q('update game_characters set game_uid = null, game_uid_by = null where guild_id = $1 and id = $2', [guildId, characterId]);
  await db.q(`delete from game_characters g where g.guild_id = $1 and g.id = $2 and g.origin = 'typed' and not exists (select 1 from character_links l where l.character_id = g.id)`, [guildId, characterId]);
  bump(guildId);
}

// Confirms a rename: the character that left (`oldId`) takes over the new one (`newId`): its name, numbers and place in the latest import,
// back in the guild, the old name kept in old_names. The new row goes; its Discord link moves over when the old character had none.
// -> { from, to, note? } (names; note = an ID that was dropped) | { error } (Vietnamese)
async function renameCharacter(guildId, oldId, newId) {
  let out;
  try {
  out = await db.tx(async () => {
    const rows = await db.q('select id, name, name_key, left_at, origin, game_uid, game_uid_by from game_characters where guild_id = $1 and id = any($2) for update', [guildId, [String(oldId), String(newId)]]);
    const old = rows.find((r) => String(r.id) === String(oldId));
    const neu = rows.find((r) => String(r.id) === String(newId));
    if (!old || !neu || String(oldId) === String(newId)) return { error: 'Không tìm thấy nhân vật (danh sách vừa đổi?). Mở lại ✏️ Đổi tên.' };
    if (!old.left_at) return { error: `**${old.name}** vẫn đang ở bang, không phải tên cũ.` };
    if (neu.left_at || neu.origin !== 'roster') return { error: `**${neu.name}** không còn trong danh sách game mới nhất.` };
    const oldLink = await db.one('select member_id from character_links where character_id = $1', [old.id]);
    const newLink = await db.one('select member_id from character_links where character_id = $1', [neu.id]);
    if (newLink && !oldLink) await db.q('update character_links set character_id = $1 where character_id = $2', [old.id, neu.id]);
    else if (newLink) await db.q('delete from character_links where character_id = $1', [neu.id]);
    const n = await db.one(`select name, name_key, rank, class_name, days_in_guild, status, off_days, last_import_id, position from game_characters where id = $1`, [neu.id]);
    await db.q('update attendance_entries set character_id = $1 where character_id = $2', [old.id, neu.id]);
    await db.q('update gate_requests set character_id = $1 where character_id = $2', [old.id, neu.id]);
    // the in-game ID follows the character: the old row's, else the one the new row had. Cleared on both rows first, so the
    // unique index never sees two holders; dropped (not an error) when some other character holds it.
    let uid = old.game_uid || neu.game_uid || null;
    let uidBy = old.game_uid ? old.game_uid_by : neu.game_uid_by; // who typed it travels with the ID
    const notes = [];
    if (old.game_uid && neu.game_uid && old.game_uid !== neu.game_uid) notes.push(`ℹ️ Hai dòng có ID game khác nhau: giữ **${old.game_uid}** (tên cũ), bỏ **${neu.game_uid}** (tên mới). Sai thì sửa ở 🆔 ID game.`);
    await db.q('update game_characters set game_uid = null, game_uid_by = null where id = any($1)', [[old.id, neu.id]]);
    if (uid && (await db.one('select id from game_characters where guild_id = $1 and game_uid = $2 and id <> all($3)', [guildId, uid, [old.id, neu.id]]))) {
      notes.push(`ℹ️ ID game **${uid}** đang thuộc nhân vật khác nên không chuyển sang tên mới. Kiểm tra ở 🆔 ID game.`);
      uid = null;
    }
    if (!uid) uidBy = null;
    await db.q('delete from game_characters where id = $1', [neu.id]); // first: the active name index would refuse two rows with that name
    await db.q(
      `update game_characters set name = $2, name_key = $3, rank = $4, class_name = $5, days_in_guild = $6, status = $7, off_days = $8,
         last_import_id = $9, position = $10, origin = 'roster', left_at = null, game_uid = $12, game_uid_by = $13,
         old_names = case when $11 = any(old_names) or $11 = $2 then old_names else array_append(old_names, $11) end
       where id = $1`,
      [old.id, n.name, n.name_key, n.rank, n.class_name, n.days_in_guild, n.status, n.off_days, n.last_import_id, n.position, old.name, uid, uidBy]
    );
    return { from: old.name, to: n.name, ...(notes.length ? { note: notes.join(String.fromCharCode(10)) } : {}) };
  });
  } catch (err) {
    if (!db.isUniqueViolation(err)) throw err;
    return { error: 'Có thay đổi cùng lúc (ID game hoặc tên vừa bị người khác nhận). Mở lại ✏️ Đổi tên rồi thử lại.' };
  }
  if (!out.error) bump(guildId);
  return out;
}

module.exports = { cleanGameUid, checkGameUid, uidHolder, setGameUid, claimGameUid, releaseGameUid, findCharacter, GAME_UID_MIN, GAME_UID_MAX, renameChoices, renameCharacter, departedOf, parseOffDays, offDaysOf, SHEET, MAX_ROWS, parseRosterXlsx, norm, fold, diff, summarize, matchDiscord, levenshtein, similarity, suggestPairs, rankPeople, gameNameMap, nameSources, linkCounts, rankGames, nameKey, isCutName, normalizeCut, cutStem, skeleton, cleanFreeName, FREE_NAME_MAX,  TAKEN_ADMIN_MSG, TAKEN_SELF_MSG, TAKEN_AUTO_MSG, takenMessage, getLink, selfLink, selfUnlink,  saveImport, addManualMember, latest, byId, latestMeta, latestRanks, epochOf, bump, rosterVersion, previous, loadMappings, setMappings, removeMappings, matchGuild };
