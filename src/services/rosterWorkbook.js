// The in-game member list as a real .xlsx (pure: no Discord, no DB). Every name is written as a plain string cell (never a
// formula object), so "=SUM(1)" stays text.
const ExcelJS = require('exceljs');
const { chipColor } = require('./lineupStyle');

const HEAD_FILL = 'E3EAF5';
const GRID = 'C4CAD4';
const INK = '1F2937';

const solid = (rgb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${rgb}` } });
const edge = (rgb = GRID, style = 'thin') => ({ style, color: { argb: `FF${rgb}` } });
const box = () => ({ top: edge(), left: edge(), bottom: edge(), right: edge() });

// '#e03131' -> 'F9DCDC': 18% of the colour over white (dark ink stays readable on top).
function tint(hex) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (shift) => Math.round(255 - (255 - ((n >> shift) & 255)) * 0.18);
  return [16, 8, 0].map((s) => mix(s).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function style(cell, { fill, bold, border } = {}) {
  if (fill) cell.fill = solid(fill);
  cell.font = { name: 'Calibri', size: 12, bold: !!bold, color: { argb: `FF${INK}` } };
  cell.alignment = { vertical: 'middle', horizontal: 'left' };
  if (border) cell.border = border;
}

// In-game member list (same sheet and columns as the file the admins import, so it can be edited and uploaded again) plus a
// "Discord" column ("Có" when a Discord member has this name). members: [{ name, rank, className, daysInGuild, status,
// inDiscord }]; classes/styles give the class colours (styles = lineupStyles(), optional).
async function buildGameRosterXlsx(members, { classes = [], styles = {} } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Bang chiến bot';
  const ws = wb.addWorksheet('Thành viên', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'STT', width: 6 },
    { header: 'Tên nhân vật', width: 28 },
    { header: 'Chức vụ', width: 20 },
    { header: 'Phái', width: 16 },
    { header: 'Ngày vào bang', width: 15 },
    { header: 'Trạng thái (lúc quay)', width: 22 },
    { header: 'Discord', width: 10 },
    { header: 'ID game', width: 22 },
  ];
  ws.getRow(1).eachCell((cell) => style(cell, { fill: HEAD_FILL, bold: true, border: box() }));
  const order = [...classes, ...[...new Set(members.map((m) => m.className))].filter((c) => !classes.includes(c))];
  members.forEach((m, i) => {
    const row = ws.addRow([i + 1, String(m.name ?? ''), m.rank || '', m.className || '', Number(m.daysInGuild) || 0, m.status || '', m.inDiscord ? 'Có' : '', m.gameUid ? String(m.gameUid) : '']);
    row.eachCell((cell) => style(cell, { border: box() }));
    const color = (styles[m.className] && styles[m.className].color) || chipColor(Math.max(order.indexOf(m.className), 0));
    style(row.getCell(4), { fill: tint(color), border: { ...box(), left: edge(color.slice(1), 'thick') } });
    row.getCell(5).numFmt = '#,##0';
    row.getCell(8).numFmt = '@'; // text: leading zeros and long numbers stay as typed
  });
  ws.autoFilter = { from: 'A1', to: 'H1' };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { buildGameRosterXlsx };
