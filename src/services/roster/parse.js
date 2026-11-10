// The in-game member list as an .xlsx ("Thành Viên" screen transcribed): parsing and its guards (pure, no DB).
const ExcelJS = require('exceljs');
const JSZip = require('jszip'); // exceljs's own zip reader (also listed in package.json)
const { canonicalClass } = require('../registrationService');
const { normalizeCut } = require('./names');

const SHEET = 'Thành viên';
const MAX_ROWS = 500;
const MAX_UNZIPPED_BYTES = 20 * 1024 * 1024; // zip-bomb guard: total uncompressed size of an .xlsx
const MAX_ZIP_RATIO = 100; // ... and per entry (uncompressed / compressed)
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

module.exports = { SHEET, MAX_ROWS, parseOffDays, offDaysOf, parseRosterXlsx };
