// Finds the start time of an event in a free-text post (Vietnamese), for the "bump" of a post in the watched event channel.
// Understood: a clock time ("20h", "20h30", "20:30", "8 giờ tối", "8h tối") plus, optionally, a day: a date ("23/11", "23-11-2026"),
// a weekday ("CN", "chủ nhật", "thứ 7", "T7", "thứ bảy") or a relative day ("hôm nay", "tối nay", "mai", "ngày mai", "mốt").
// A time without a day is the next time it comes (today, else tomorrow). The FIRST clock time of the post is the start.
// All in Vietnam time. -> Date (strictly after `now`) | null when no clock time is found or the result lies in the past.
const { toLocalParts, fromLocal, DAY } = require('../utils/time');

// accents off, đ -> d, lower case: the patterns below are written without accents
const fold = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();

const WEEKDAY_WORDS = { hai: 1, ba: 2, tu: 3, nam: 4, sau: 5, bay: 6 };

// "20h", "20h30", "20:30", "20g", "8 gio", "8 gio 30" (+ an optional "sang|trua|chieu|toi|dem" right after) -> { hour, minute, index } | null
// A bare "N gio" can be a length ("choi 2 gio"): a clock written with h / g / ":" / minutes / a part of the day wins over it.
// "12h dem" is midnight: hour 24 (fromLocal rolls it to 00:00 of the next day).
function findClock(t) {
  // h / g / gio must not run into a word ("7 giai dau" is no time); a colon needs the minutes
  const re = /(^|[^\d/:.-])(\d{1,2})\s*(?:gio(?![a-z])|h(?![a-z])|g(?![a-z])|:(?=\d{2}))\s*(\d{2})?(?!\d)(?:\s*(sang|trua|chieu|toi|dem))?/g;
  let m;
  let weak = null;
  while ((m = re.exec(t))) {
    let hour = Number(m[2]);
    const minute = m[3] ? Number(m[3]) : 0;
    if (hour > 23 || minute > 59) continue;
    const before = t.slice(Math.max(0, m.index - 12), m.index + m[1].length);
    const part = m[4] || (/(chieu|toi|dem)(\s+(nay|mai|mot))?\s*$/.test(before) ? (/dem(\s+(nay|mai|mot))?\s*$/.test(before) ? 'dem' : 'toi') : '');
    if ((part === 'chieu' || part === 'toi' || part === 'dem') && hour >= 1 && hour < 12) hour += 12;
    else if (part === 'dem' && hour === 12) hour = 24;
    const clock = { hour, minute, index: m.index };
    if (!/gio/.test(m[0]) || m[3] || part) return clock;
    if (!weak) weak = clock;
  }
  return weak;
}

// "23/11", "23.11", "23/11/2026", "23-11-2026" (a dash only with the year: "15-20 nguoi" is no date) -> { day, month (0-11), year|null } | null
// A dot without a year needs two digits on each side ("23.11"): "x1.5", "1.5 trieu" are no dates.
function findDate(t) {
  const re = /(^|[^\d:.,])(\d{1,2})(?:([/.])(\d{1,2})(?:[/.-](\d{2,4}))?|-(\d{1,2})-(\d{2,4}))(?![\d:]|[.,]\d)/g;
  let m;
  while ((m = re.exec(t))) {
    if (m[3] === '.' && !m[5] && (m[2].length < 2 || m[4].length < 2)) continue;
    break;
  }
  if (!m) return null;
  const [, , d, , slashMonth, slashYear, dashMonth, dashYear] = m;
  const day = Number(d);
  const month = Number(slashMonth || dashMonth) - 1;
  if (day < 1 || day > 31 || month < 0 || month > 11) return null;
  const y = slashYear || dashYear;
  let year = y ? Number(y) : null;
  if (year !== null && year < 100) year += 2000;
  return { day, month, year };
}

// -> 0 (Sunday) .. 6 | null
function findWeekday(t) {
  if (/(^|[^a-z])(cn|chu nhat)([^a-z]|$)/.test(t)) return 0;
  let m = /(^|[^a-z])(?:thu|t)\s*([2-7])(?!\d)/.exec(t);
  if (m) return Number(m[2]) - 1;
  m = /(^|[^a-z])thu\s+(hai|ba|tu|nam|sau|bay)([^a-z]|$)/.exec(t);
  return m ? WEEKDAY_WORDS[m[2]] : null;
}

// -> days from today (0 today, 1 tomorrow, 2 the day after) | null. `raw` keeps the accents: "mốt" (the day after) is not "một" (one), and
// "mai" (tomorrow) is not "mãi" / "mài".
function findRelative(t, raw) {
  if (/(^|[^a-z])(hom nay|toi nay|chieu nay|sang nay|dem nay)([^a-z]|$)/.test(t)) return 0;
  const r = String(raw || '').normalize('NFC').toLowerCase();
  if (/(^|[^\p{L}])mai(?![\p{L}\p{M}])/u.test(r)) return 1;
  if (/(^|[^\p{L}])mốt(?![\p{L}\p{M}])/u.test(r)) return 2;
  return null;
}

function parseEventTime(text, now = new Date()) {
  const t = fold(text);
  const clock = findClock(t);
  if (!clock) return null;
  const today = toLocalParts(now);
  const at = (y, mo, d) => fromLocal(y, mo, d, clock.hour, clock.minute);
  let start = null;

  const date = findDate(t);
  if (date) {
    let year = date.year ?? today.year;
    start = at(year, date.month, date.day);
    if (date.year === null && start.getTime() < now.getTime() - 30 * DAY) start = at((year += 1), date.month, date.day); // "02/01" written in late December
    const back = toLocalParts(start);
    if (back.day !== date.day || back.month !== date.month) return null; // 31/02
  } else {
    const weekday = findWeekday(t);
    const rel = findRelative(t, text);
    if (weekday !== null) {
      start = at(today.year, today.month, today.day + ((weekday - today.dow + 7) % 7));
      if (start <= now) start = new Date(start.getTime() + 7 * DAY);
    } else if (rel !== null) {
      start = at(today.year, today.month, today.day + rel);
    } else {
      start = at(today.year, today.month, today.day);
      if (start <= now) start = new Date(start.getTime() + DAY);
    }
  }
  return start > now ? start : null;
}

// The title of a post: its first line with text, markdown and mentions taken out, at most `max` characters. -> string ('' when none)
function titleOf(text, max = 100) {
  const line = String(text || '')
    .split('\n')
    .map((l) =>
      l
        .replace(/<a?:\w+:\d+>/g, '') // custom emoji
        .replace(/<(@[!&]?|#)\d+>/g, '') // mentions
        .replace(/@(everyone|here)/g, '')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/^#{1,3}\s+/, '') // heading
        .replace(/^>\s?/, '')
        .replace(/[*_~`|]/g, '')
        .trim()
    )
    .find((l) => l.length > 0);
  if (!line) return '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

module.exports = { parseEventTime, titleOf };
