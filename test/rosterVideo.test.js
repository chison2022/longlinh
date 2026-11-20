// scripts/roster-video.js build: a cut name typed "..." becomes "…", a row without "|" is reported instead of thrown.
// latest / mark: which videos are still to handle, and the da-xu-ly.json ledger.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ExcelJS = require('exceljs');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'roster-video.js');

function build(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'll-rv-'));
  try {
    const txt = path.join(dir, 'rows.txt');
    const out = path.join(dir, 'thanh-vien-bang-2026-10-14.xlsx');
    fs.writeFileSync(txt, lines.join('\n'));
    const report = JSON.parse(execFileSync(process.execPath, [SCRIPT, 'build', txt, out], { encoding: 'utf8' }));
    return { report, out, dir };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

describe('roster-video build', () => {
  it('a trailing "..." in a name is written as the cut "…"', async () => {
    const { out, dir } = build(['1|Thiên Long Bá...|Bang Chúng|10|Thiết Y|100|5|Online', '2|Bình ...|Bang Chúng|10|Thiết Y|100|5|Online', '3|A.B|Bang Chúng|10|Thiết Y|100|5|Online']);
    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(out);
      const ws = wb.getWorksheet('Thành viên');
      assert.deepEqual([2, 3, 4].map((r) => String(ws.getRow(r).getCell(2).value)), ['Thiên Long Bá…', 'Bình…', 'A.B']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('a row without "|" is a reported problem ("dòng N sai định dạng"), not a crash', () => {
    const { report, dir } = build(['1|An|Bang Chúng|10|Thiết Y|100|5|Online', 'dòng hỏng không có gạch', '3|Bình|Bang Chúng|10|Thiết Y|100|5|Online']);
    try {
      assert.ok(report.problems.includes('dòng 2 sai định dạng'), JSON.stringify(report.problems));
      assert.equal(report.rows, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('roster-video latest / mark (the da-xu-ly.json ledger)', () => {
  const { latest, mark, LEDGER } = require(SCRIPT);
  let dir;
  const touch = (name, at) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, 'x');
    fs.utimesSync(f, new Date(at), new Date(at));
  };
  const names = () => latest(dir).candidates.map((c) => path.basename(c.file));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'll-rv-'));
    touch('old.mp4', '2026-11-01T10:00:00Z');
    touch('thanh-vien-bang-2026-11-10.xlsx', '2026-11-10T10:00:00Z');
    touch('war.mp4', '2026-11-12T10:00:00Z');
    touch('roster.mp4', '2026-11-11T10:00:00Z');
    touch('notes.txt', '2026-11-13T10:00:00Z');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('without a ledger, offers the videos newer than the last roster, oldest first', () => {
    assert.deepEqual(names(), ['roster.mp4', 'war.mp4']);
    assert.equal(latest(dir).ledger, null);
  });

  it('a marked video is not offered again, even with no new roster file', () => {
    mark(dir, path.join(dir, 'war.mp4'), 'war');
    assert.deepEqual(names(), ['roster.mp4']);
    mark(dir, 'roster.mp4', 'roster', 'D:\\nthvideo\\thanh-vien-bang-2026-11-11.xlsx');
    assert.deepEqual(names(), []);
    const l = JSON.parse(fs.readFileSync(path.join(dir, LEDGER), 'utf8'));
    assert.equal(l.since, '2026-11-10T10:00:00.000Z');
    assert.equal(l.videos['roster.mp4'].output, 'thanh-vien-bang-2026-11-11.xlsx');
    assert.equal(l.videos['war.mp4'].kind, 'war');
  });

  it('keeps the first cut-off: a newer roster file does not hide unhandled videos', () => {
    mark(dir, 'war.mp4', 'skip');
    touch('thanh-vien-bang-2026-11-20.xlsx', '2026-11-20T10:00:00Z');
    touch('new.mp4', '2026-11-21T10:00:00Z');
    assert.deepEqual(names(), ['roster.mp4', 'new.mp4']);
  });

  it('rejects an unknown kind or a video that is not in the folder', () => {
    assert.throws(() => mark(dir, 'war.mp4', 'gameplay'), /kind must be/);
    assert.throws(() => mark(dir, 'missing.mp4', 'skip'), /no video/);
    assert.equal(fs.existsSync(path.join(dir, LEDGER)), false);
  });
});
