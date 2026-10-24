// Helper for turning a screen recording of the in-game "Thành Viên" list into the roster xlsx (used by the dong-bo-video skill).
//   node scripts/roster-video.js latest [--dir <folder>]             newest video not yet turned into a thanh-vien-bang-*.xlsx (JSON)
//   node scripts/roster-video.js frames <video> <outDir>              cropped table frames (2 fps) + counter.jpg (the "57/60 · 14/20" bar)
//   node scripts/roster-video.js build <rows.txt> <out.xlsx> [--prev <xlsx>]
//                                                                     rows "STT|Tên|Chức vụ|Cấp|Phái|Lực chiến|Ngày|Trạng thái" -> xlsx + diff
// The xlsx has the sheet "Thành viên" that scripts/import-game-roster.js (and the 🎮 Thành viên game upload) read.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ExcelJS = require('exceljs');
require('dotenv').config({ quiet: true }); // ROSTER_VIDEO_DIR: the folder the recordings are saved to

const VIDEO_EXT = /\.(mp4|mkv|mov)$/i;
const ROSTER_FILE = /^thanh-vien-bang-(\d{4}-\d{2}-\d{2})\.xlsx$/;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

// Folding for the diff only: accents, đ, spacing and case do not make a different person.
const fold = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').replace(/\s+/g, ' ').trim().toLowerCase();

function latest(dir) {
  const files = fs.readdirSync(dir).map((name) => ({ name, full: path.join(dir, name), mtime: fs.statSync(path.join(dir, name)).mtime }));
  const rosters = files.filter((f) => ROSTER_FILE.test(f.name)).sort((a, b) => b.mtime - a.mtime);
  const lastRoster = rosters[0] || null;
  const videos = files.filter((f) => VIDEO_EXT.test(f.name)).sort((a, b) => b.mtime - a.mtime);
  const fresh = videos.filter((v) => !lastRoster || v.mtime > lastRoster.mtime);
  return {
    lastRoster: lastRoster && { file: lastRoster.full, at: lastRoster.mtime.toISOString() },
    candidates: fresh.map((v) => ({ file: v.full, at: v.mtime.toISOString(), mb: Math.round(fs.statSync(v.full).size / 1048576) })),
  };
}

function frames(video, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  // the table area of a 16:9 recording of the game window, and the member counter bar below it
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', video, '-vf', 'fps=2,crop=iw*0.83:ih*0.62:iw*0.125:ih*0.21', '-q:v', '3', path.join(outDir, 'f_%03d.jpg')]);
  const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video]).toString().trim());
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(Math.max(duration - 1, 0)), '-i', video, '-frames:v', '1', '-vf', 'crop=iw*0.45:ih*0.08:iw*0.10:ih*0.81', path.join(outDir, 'counter.jpg')]);
  const count = fs.readdirSync(outDir).filter((f) => /^f_\d+\.jpg$/.test(f)).length;
  console.log(JSON.stringify({ outDir, frames: count, duration }));
}

async function readPrev(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const rows = [];
  const ws = wb.getWorksheet('Thành viên');
  let ngayCol = 6; // older files had "Lực chiến" before it
  ws.getRow(1).eachCell((c, n) => { if (String(c.value).startsWith('Ngày vào bang')) ngayCol = n; });
  ws.eachRow((r, i) => {
    if (i > 1) rows.push({ ten: String(r.getCell(2).value), chucVu: String(r.getCell(3).value), phai: String(r.getCell(4).value), ngay: Number(r.getCell(ngayCol).value) });
  });
  return rows;
}

function prevFor(out) {
  const dir = path.dirname(out);
  const own = path.basename(out);
  const older = fs.readdirSync(dir).filter((f) => ROSTER_FILE.test(f) && f !== own && f < own).sort();
  return older.length ? path.join(dir, older[older.length - 1]) : null;
}

async function build(txt, out, prevPath) {
  const problems = [];
  const rows = [];
  fs.readFileSync(txt, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/).forEach((l, i) => {
    if (!l.includes('|')) return problems.push(`d\u00F2ng ${i + 1} sai \u0111\u1ECBnh d\u1EA1ng`);
    const [stt, ten, chucVu, , phai, lc, ngay, tt] = l.split('|');
    // a cut name typed "..." is the game's "\u2026"
    rows.push({ stt: Number(stt), ten: String(ten || '').replace(/\s{2,}/g, ' ').trim().replace(/\s*\.{3}$/, '\u2026'), chucVu, phai, lc: Number(lc), ngay: Number(ngay), tt });
  });
  rows.forEach((r, i) => {
    if (r.stt !== i + 1) problems.push(`STT ${r.stt} ở dòng ${i + 1}`);
    if (!r.ten || !r.phai || !Number.isFinite(r.lc) || !Number.isFinite(r.ngay)) problems.push(`dòng ${i + 1} thiếu cột`);
  });

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Thành viên');
  ws.columns = [
    { header: 'STT', key: 'stt', width: 6 }, { header: 'Tên nhân vật', key: 'ten', width: 22 },
    { header: 'Chức vụ', key: 'chucVu', width: 34 }, { header: 'Phái', key: 'phai', width: 13 },
    { header: 'Ngày vào bang', key: 'ngay', width: 14 },
    { header: 'Trạng thái (lúc quay)', key: 'tt', width: 20 },
  ];
  rows.forEach((r) => ws.addRow(r));
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A93' } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = 'A1:F1';

  const byClass = {};
  rows.forEach((r) => { (byClass[r.phai] ||= []).push(r); });
  const sum = wb.addWorksheet('Theo phái');
  sum.columns = [{ header: 'Phái', key: 'phai', width: 14 }, { header: 'Số người', key: 'n', width: 10 }];
  Object.entries(byClass).sort((a, b) => b[1].length - a[1].length).forEach(([phai, l]) => sum.addRow({ phai, n: l.length }));
  sum.getRow(1).font = { bold: true };

  const report = { file: out, rows: rows.length, hocViec: rows.filter((r) => fold(r.chucVu) === 'hoc viec').length, problems, byClass: Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, v.length])) };
  prevPath = prevPath || prevFor(out);
  if (prevPath) {
    const prev = await readPrev(prevPath);
    const nowK = new Map(rows.map((r) => [fold(r.ten), r]));
    const prevK = new Map(prev.map((p) => [fold(p.ten), p]));
    const gone = prev.filter((p) => !nowK.has(fold(p.ten)));
    const added = rows.filter((r) => !prevK.has(fold(r.ten)));
    // a rename keeps the class, and the days in the guild keep counting (a newcomer starts again near 0)
    const renamed = [];
    for (const g of [...gone]) {
      const a = added.filter((x) => x.phai === g.phai && x.ngay >= g.ngay && x.ngay - g.ngay <= 30).sort((x, y) => x.ngay - y.ngay)[0];
      if (a) { renamed.push({ from: g.ten, to: a.ten, phai: a.phai }); gone.splice(gone.indexOf(g), 1); added.splice(added.indexOf(a), 1); }
    }
    const rank = rows.filter((r) => prevK.has(fold(r.ten)) && prevK.get(fold(r.ten)).chucVu !== r.chucVu).map((r) => ({ ten: r.ten, from: prevK.get(fold(r.ten)).chucVu, to: r.chucVu }));
    const spelling = rows.filter((r) => prevK.has(fold(r.ten)) && prevK.get(fold(r.ten)).ten !== r.ten).map((r) => ({ from: prevK.get(fold(r.ten)).ten, to: r.ten }));
    const d = wb.addWorksheet(`So với ${path.basename(prevPath).match(ROSTER_FILE)[1].slice(5)}`);
    d.columns = [{ header: 'Thay đổi', key: 'k', width: 16 }, { header: 'Tên', key: 'ten', width: 24 }, { header: 'Chi tiết', key: 'ct', width: 48 }];
    added.forEach((a) => d.addRow({ k: 'Mới vào', ten: a.ten, ct: `${a.phai} · ${a.chucVu} · ${a.ngay} ngày` }));
    gone.forEach((g) => d.addRow({ k: 'Không còn', ten: g.ten, ct: `${g.phai} · ${g.chucVu}` }));
    renamed.forEach((r) => d.addRow({ k: 'Đổi tên?', ten: r.to, ct: `trước là "${r.from}" (${r.phai})` }));
    rank.forEach((p) => d.addRow({ k: 'Đổi chức vụ', ten: p.ten, ct: `${p.from} → ${p.to}` }));
    d.getRow(1).font = { bold: true };
    Object.assign(report, {
      prev: prevPath,
      prevRows: prev.length,
      added: added.map((a) => ({ ten: a.ten, phai: a.phai, ngay: a.ngay })),
      gone: gone.map((g) => ({ ten: g.ten, phai: g.phai, ngay: g.ngay })),
      renamed,
      rank,
      spelling,
    });
  }
  await wb.xlsx.writeFile(out);
  console.log(JSON.stringify(report, null, 1));
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'latest') return console.log(JSON.stringify(latest(arg('dir', process.env.ROSTER_VIDEO_DIR || 'videos')), null, 1));
  if (cmd === 'frames' && a && b) return frames(a, b);
  if (cmd === 'build' && a && b) return build(a, b, arg('prev'));
  throw new Error('usage: roster-video.js latest [--dir <dir>] | frames <video> <outDir> | build <rows.txt> <out.xlsx> [--prev <xlsx>]');
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
