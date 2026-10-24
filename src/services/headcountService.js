// "Quân số" of the guild from the latest in-game roster: official members vs apprentices (rank "Học Việc", any accents / case / spacing).
// Pure helpers first, then one DB read. The dashboard shows it; nothing here throws on a missing roster (-> null).
const db = require('../db');
const defaults = require('../../config/defaults');
const gameRoster = require('./gameRosterService');

const APPRENTICE_KEY = 'hocviec';
const isApprentice = (rank) => gameRoster.fold(rank === undefined || rank === null ? '' : rank) === APPRENTICE_KEY;

// members ([{ rank }]) -> { official, apprentice }. A member without a rank counts as official.
function countHeadcount(members) {
  let apprentice = 0;
  let official = 0;
  for (const m of members || []) {
    if (isApprentice(m && m.rank)) apprentice += 1;
    else official += 1;
  }
  return { official, apprentice };
}

// The wanted number of official members from a config (1..officialCap; anything else -> the default).
function targetOf(config) {
  const t = config && config.rosterTarget;
  return Number.isInteger(t) && t >= 1 && t <= defaults.officialCap ? t : defaults.rosterTarget;
}

// Dashboard lines. -> [] without a headcount (no roster).
function headcountLines(headcount, target = defaults.rosterTarget) {
  if (!headcount) return [];
  const { official, apprentice } = headcount;
  return [
    `👥 Chính thức ${official}/${defaults.officialCap} · Học Việc ${apprentice}/${defaults.apprenticeCap} · mục tiêu ${target}`,
    official < target ? '⚠️ Dưới mục tiêu: nên mở tuyển' : '✅ Đủ quân số',
  ];
}

// Latest roster of the guild -> { official, apprentice }, or null when there is no import.
async function loadHeadcount(guildId) {
  if (!db.isConnected()) return null; // no DB connection: no line (and no 10 s wait)
  const ranks = await gameRoster.latestRanks(guildId);
  return ranks ? countHeadcount(ranks.map((rank) => ({ rank }))) : null;
}

// "Mục tiêu quân số" text of the form -> { value } | { error }.
function parseTarget(text) {
  const raw = String(text === undefined || text === null ? '' : text).trim();
  const n = /^\d{1,2}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > defaults.officialCap) return { error: `Mục tiêu quân số chính thức phải là số nguyên từ 1 đến ${defaults.officialCap}.` };
  return { value: n };
}

module.exports = { isApprentice, countHeadcount, targetOf, headcountLines, loadHeadcount, parseTarget };
