// Time helpers. All dates are stored as UTC Date objects; game schedule is
// written in Vietnam time (UTC+7, no DST), so we convert with a fixed offset.
const { timezoneOffsetHours } = require('../../config/defaults');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const OFFSET = timezoneOffsetHours * HOUR;

const DAY_NAMES = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

function toLocalParts(date) {
  const d = new Date(date.getTime() + OFFSET);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    day: d.getUTCDate(),
    dow: d.getUTCDay(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

function fromLocal(year, month, day, hour, minute) {
  return new Date(Date.UTC(year, month, day, hour, minute) - OFFSET);
}

function parseTime(text) {
  const m = /^(\d{1,2})[:hH](\d{2})?$/.exec(String(text).trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2] || 0);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function formatTime({ hour, minute }) {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// "CN", "T2".."T7", "Thứ 2", "thu 7", "2".."7" -> 0..6
function parseDay(text) {
  const t = String(text)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, '');
  if (t === 'cn' || t === 'chunhat') return 0;
  const m = /^(?:t|thu)?([2-7])$/.exec(t);
  return m ? Number(m[1]) - 1 : null;
}

// "CN 20:00" -> { day: 0, time: '20:00' }
function parseDayTime(text) {
  const parts = String(text).trim().split(/\s+/);
  if (parts.length < 2) return null;
  const time = parseTime(parts.pop());
  const day = parseDay(parts.join(' '));
  if (day === null || !time) return null;
  return { day, time: formatTime(time) };
}

function formatDayTime(day, time) {
  return `${DAY_NAMES[day]} ${time}`;
}

// First local occurrence of weekday `dow` at `time` strictly after `after`.
function nextWeekly(dow, time, after) {
  const { hour, minute } = parseTime(time);
  const p = toLocalParts(after);
  let cand = fromLocal(p.year, p.month, p.day + ((dow - p.dow + 7) % 7), hour, minute);
  if (cand <= after) cand = new Date(cand.getTime() + 7 * DAY);
  return cand;
}

// Last local occurrence of weekday `dow` at `time` at or before `before`.
function previousWeekly(dow, time, before) {
  return nextWeekly(dow, time, new Date(before.getTime() - 7 * DAY));
}

// "25/12 20:00" or "25/12/2026 20:00" (local time) -> Date
function parseLocalDateTime(text, now = new Date()) {
  const m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s+(\S+)$/.exec(String(text).trim());
  if (!m) return null;
  const time = parseTime(m[4]);
  if (!time) return null;
  const day = Number(m[1]);
  const month = Number(m[2]) - 1;
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  let year = m[3] ? Number(m[3]) : toLocalParts(now).year;
  let date = fromLocal(year, month, day, time.hour, time.minute);
  // Year omitted and date is long past -> admin means next year (e.g. typing 02/01 in late December)
  if (!m[3] && date.getTime() < now.getTime() - 30 * DAY) {
    year += 1;
    date = fromLocal(year, month, day, time.hour, time.minute);
  }
  // Date.UTC rolls 31/02 over into March: reject anything that does not round-trip.
  const back = toLocalParts(date);
  if (back.day !== day || back.month !== month) return null;
  return date;
}

// Like parseLocalDateTime, but a text without a year gets the year that puts the date CLOSEST to `anchor` (a Date), instead of the year of "now":
// editing an event made in December on 02/01 keeps "30/12" in December. A text with a year is parsed as is. -> Date | null
function parseLocalDateTimeNear(text, anchor) {
  const raw = String(text).trim();
  if (/^\d{1,2}\/\d{1,2}\/\d{4}\s/.test(raw)) return parseLocalDateTime(raw, anchor);
  const year = toLocalParts(anchor).year;
  let best = null;
  for (const y of [year - 1, year, year + 1]) {
    const date = parseLocalDateTime(raw.replace(/^(\d{1,2}\/\d{1,2})(?=\s)/, `$1/${y}`), anchor);
    if (date && (!best || Math.abs(date - anchor) < Math.abs(best - anchor))) best = date;
  }
  return best;
}

function formatLocalDateTime(date) {
  const p = toLocalParts(date);
  const dd = String(p.day).padStart(2, '0');
  const mm = String(p.month + 1).padStart(2, '0');
  return `${dd}/${mm} ${formatTime(p)}`;
}

// Discord timestamp markup, rendered in each viewer's own timezone
function discordTs(date, style = 'F') {
  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

module.exports = {
  HOUR,
  DAY,
  DAY_NAMES,
  toLocalParts,
  fromLocal,
  parseTime,
  parseDay,
  parseDayTime,
  formatDayTime,
  nextWeekly,
  previousWeekly,
  parseLocalDateTime,
  parseLocalDateTimeNear,
  formatLocalDateTime,
  discordTs,
};
