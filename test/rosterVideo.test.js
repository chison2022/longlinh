// scripts/roster-video.js build: a cut name typed "..." becomes "…", a row without "|" is reported instead of thrown.
const { describe, it } = require('node:test');
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
