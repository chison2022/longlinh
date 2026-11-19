// The in-game member list as a real .xlsx (pure: no Discord, no DB). Every name is written as a plain string cell (never a
// formula object), so "=SUM(1)" stays text.
const ExcelJS = require('exceljs');
const { chipColor } = require('./lineupStyle');
const { HOUR, DAY, formatLocalDateTime } = require('../utils/time');
const { timezoneOffsetHours } = require('../../config/defaults');

const HEAD_FILL = 'E3EAF5';
const RAW_HEAD_FILL = 'F1F3F6';
const GRID = 'C4CAD4';
const INK = '1F2937';
const MUTED = '6B7280';
const YES_FILL = 'E3F4E8';
const NO_FILL = 'FBE1E1';

const solid = (rgb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${rgb}` } });
const edge = (rgb = GRID, style = 'thin') => ({ style, color: { argb: `FF${rgb}` } });
const box = () => ({ top: edge(), left: edge(), bottom: edge(), right: edge() });

// '#e03131' -> 'F9DCDC': 18% of the colour over white (dark ink stays readable on top).
function tint(hex) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (shift) => Math.round(255 - (255 - ((n >> shift) & 255)) * 0.18);
  return [16, 8, 0].map((s) => mix(s).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function style(cell, { fill, bold, border, color = INK, align = 'left' } = {}) {
  if (fill) cell.fill = solid(fill);
  cell.font = { name: 'Calibri', size: 12, bold: !!bold, color: { argb: `FF${color}` } };
  cell.alignment = { vertical: 'middle', horizontal: align, wrapText: !!bold };
  if (border) cell.border = border;
}

// Excel stores wall-clock time without a zone and ExcelJS writes a Date by its UTC fields: shift so the cell shows Vietnam time.
const vnCell = (date) => new Date(date.getTime() + timezoneOffsetHours * HOUR);

const fold = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const UNIT = { giay: 1000, phut: 60 * 1000, gio: HOUR, ngay: DAY, tuan: 7 * DAY, thang: 30 * DAY, nam: 365 * DAY };

// The in-game "Trạng thái" text read at `at` -> { date, withTime } (when last seen), or null when the text is not one we know.
// "Online" / "Trong 1 giờ" -> at; "5 giờ trước" -> at - 5h (with the hour); "3 ngày trước" -> at - 3 days (date only).
function lastSeen(status, at) {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return null;
  const t = fold(status);
  if (!t) return null;
  if (t === 'online' || t === 'dang online' || t === 'truc tuyen' || /^trong \d+ (gio|phut)$/.test(t)) return { date: at, withTime: true };
  const ago = /^(\d+) (giay|phut|gio|ngay|tuan|thang|nam) truoc$/.exec(t);
  if (!ago) return null;
  return { date: new Date(at.getTime() - Number(ago[1]) * UNIT[ago[2]]), withTime: UNIT[ago[2]] < DAY };
}

// In-game member list (same sheet as the file the admins import, so it can be edited and uploaded again). The days in the guild
// and the last-seen text are only true at the moment of the import, so they are turned into dates ("Vào bang từ", "Online lần cuối");
// the raw in-game columns stay at the end (greyed, dated in their header) because the importer reads them.
// members: [{ name, rank, className, daysInGuild, status, inDiscord, discordName, gameUid }]; importedAt: when the list was read
// (without it the date columns stay empty); classes/styles give the class colours (styles = lineupStyles(), optional).
async function buildGameRosterXlsx(members, { classes = [], styles = {}, importedAt = null } = {}) {
  const at = importedAt ? new Date(importedAt) : null;
  const atValid = !!at && !Number.isNaN(at.getTime());
  const stamp = atValid ? formatLocalDateTime(at) : '';
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Bang chiến bot';
  const ws = wb.addWorksheet('Thành viên', { views: [{ state: 'frozen', ySplit: 1, xSplit: 2 }] });
  const RAW_FROM = 10; // first raw in-game column
  ws.columns = [
    { header: 'STT', width: 6 },
    { header: 'Tên nhân vật', width: 26 },
    { header: 'Chức vụ', width: 18 },
    { header: 'Phái', width: 14 },
    { header: 'Vào bang từ (ước tính)', width: 14 },
    { header: 'Online lần cuối (ước tính)', width: 17 },
    { header: 'Discord', width: 10 },
    { header: 'Tên Discord', width: 22 },
    { header: 'ID game', width: 22 },
    { header: `Ngày vào bang (số ngày, tính đến ${stamp.split(' ')[0] || 'lúc cập nhật'})`, width: 18 },
    { header: `Trạng thái (trong game lúc ${stamp || 'cập nhật'})`, width: 20 },
  ];
  ws.getRow(1).height = 36;
  ws.getRow(1).eachCell((cell, c) => style(cell, c >= RAW_FROM ? { fill: RAW_HEAD_FILL, bold: true, border: box(), color: MUTED } : { fill: HEAD_FILL, bold: true, border: box() }));
  ws.getCell('E1').note = 'Ngày cập nhật danh sách trừ đi số ngày trong bang.';
  ws.getCell('F1').note = 'Tính từ cột "Trạng thái" và lúc cập nhật danh sách. Có giờ khi game ghi theo phút/giờ, chỉ có ngày khi game ghi theo ngày.';
  ws.getCell('G1').note = '✘ Chưa = chưa ghép được với ai trong Discord: dùng 🔗 Ghép tên trong bot.';

  const order = [...classes, ...[...new Set(members.map((m) => m.className))].filter((c) => !classes.includes(c))];
  members.forEach((m, i) => {
    const days = Number(m.daysInGuild) || 0;
    const joined = atValid ? vnCell(new Date(at.getTime() - days * DAY)) : null;
    const seen = atValid ? lastSeen(m.status, at) : null;
    const row = ws.addRow([
      i + 1,
      String(m.name ?? ''),
      m.rank || '',
      m.className || '',
      joined,
      seen ? vnCell(seen.date) : m.status ? 'Không rõ' : '',
      m.inDiscord ? '✔ Có' : '✘ Chưa',
      m.inDiscord && m.discordName ? String(m.discordName) : '',
      m.gameUid ? String(m.gameUid) : '',
      days,
      m.status || '',
    ]);
    for (let c = 1; c <= ws.columns.length; c++) style(row.getCell(c), c >= RAW_FROM ? { border: box(), color: MUTED } : { border: box() });
    const color = (styles[m.className] && styles[m.className].color) || chipColor(Math.max(order.indexOf(m.className), 0));
    style(row.getCell(4), { fill: tint(color), border: { ...box(), left: edge(color.slice(1), 'thick') } });
    row.getCell(5).numFmt = 'dd/mm/yyyy';
    if (seen) row.getCell(6).numFmt = seen.withTime ? 'dd/mm/yyyy hh:mm' : 'dd/mm/yyyy';
    style(row.getCell(7), { fill: m.inDiscord ? YES_FILL : NO_FILL, border: box(), align: 'center' });
    row.getCell(8).numFmt = '@'; // a Discord name like "=1" stays text
    row.getCell(9).numFmt = '@'; // text: leading zeros and long numbers stay as typed
    row.getCell(10).numFmt = '#,##0';
  });
  ws.autoFilter = { from: 'A1', to: { row: 1, column: ws.columns.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { buildGameRosterXlsx, lastSeen };
