// Import who really took part in a war (the in-game result screen, transcribed to a text file) and compare it with the registrations.
//   npm run attendance:import -- --guild <guildId> --file <names.txt> [--event <eventId> | --date YYYY-MM-DD] [--dry] [--force]
// File lines: `Tên|key=value|key=value…` or just `Tên`; `#` comments and blank lines are skipped. The war defaults to the one
// that starts on --date (local VN date), else the latest war that has started. A second import of a war replaces the first.
// --dry prints the summary without writing. Names the bot cannot match to a Discord person ("chưa rõ") stop the save: --force saves
// anyway (the registrants it cannot rule out are then "chưa xác nhận", not no-shows). Needs PG_URL and PG_CA in .env.
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const db = require('../src/db');
const attendance = require('../src/services/attendanceService');
const warService = require('../src/services/warService');
const { listRegistrations } = require('../src/services/registrationService');
const eventLog = require('../src/eventLog');
const { logDir } = require('../src/paths');
const { formatLocalDateTime } = require('../src/utils/time');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const label = (it) => [it.gameName, it.displayName && it.displayName !== it.gameName ? `(${it.displayName})` : ''].filter(Boolean).join(' ') || it.discordId;
const list = (title, items) => items.length && console.log(`${title} (${items.length}): ${items.map(label).join(', ')}`);

async function pickEvent(guildId) {
  const id = arg('event');
  const date = arg('date');
  if (id && date) throw new Error('chọn --event hoặc --date, không dùng cả hai');
  let event;
  if (id) event = await warService.getEvent(id);
  else if (date) event = await attendance.findEventOnDate(guildId, date);
  else event = await attendance.latestStartedEvent(guildId);
  if (!event || event.guildId !== guildId) throw new Error(id ? 'không thấy trận với --event này trong guild' : date ? `không có trận nào bắt đầu ngày ${date}` : 'chưa có trận nào đã bắt đầu');
  return event;
}

async function main() {
  const guildId = arg('guild');
  const file = arg('file');
  const dry = process.argv.includes('--dry');
  if (!/^\d{17,20}$/.test(String(guildId)) || !file) {
    throw new Error('usage: npm run attendance:import -- --guild <guildId> --file <names.txt> [--event <eventId> | --date YYYY-MM-DD] [--dry]');
  }
  if (!process.env.PG_URL) throw new Error('PG_URL is missing in .env');

  eventLog.init(logDir()); // the same events-*.jsonl as the bot: `npm run logs:report` shows the script import too
  await db.connectPg({ max: 2 });
  try {
    if (!dry) await db.ensureSchema();
    const parsed = attendance.parseAttendanceText(fs.readFileSync(file, 'utf8'));
    if (!parsed.length) throw new Error('file không có tên nào');
    const event = await pickEvent(guildId);
    console.log(`trận: ${event.title} (${formatLocalDateTime(new Date(event.startAt))}) ${event._id}`);
    const regs = await listRegistrations(event._id);
    const members = await attendance.memberInfos(guildId, regs);
    const resolved = await attendance.resolve(guildId, parsed.map((p) => p.name), { members });
    const entries = resolved.map((r, i) => (Object.keys(parsed[i].stats).length ? { ...r, stats: parsed[i].stats } : r));
    const doc = { entries };
    const names = await attendance.linkedNames(guildId, regs.map((r) => r.discordId));
    const cmp = attendance.compare(event, regs, doc, { names, displayNames: new Map(members.map((m) => [m.id, m.name])) });
    const matched = entries.length - cmp.unknown.length;
    console.log(`có mặt ${entries.length}: khớp ${matched} (link ${entries.filter((e) => e.how === 'link').length}, tự khớp ${entries.filter((e) => e.how === 'auto').length}) / chưa rõ ${cmp.unknown.length}`);
    console.log(`đi ${cmp.came.length} / đăng ký mà không đi ${cmp.noShow.length} / chưa xác nhận ${cmp.unconfirmed.length} / không đăng ký vẫn đi ${cmp.walkIn.length} (trong đó đã báo vắng ${cmp.walkIn.filter((w) => w.saidAbsent).length})`);
    list('đăng ký mà không đi', cmp.noShow);
    list('đăng ký, chưa xác nhận (còn tên chưa rõ, người này chưa liên kết tên game)', cmp.unconfirmed);
    list('không đăng ký vẫn đi', cmp.walkIn);
    list('chưa rõ Discord', cmp.unknown);
    if (dry) return console.log('dry run: nothing saved');
    if (cmp.unknown.length && !process.argv.includes('--force')) {
      throw new Error(`còn ${cmp.unknown.length} tên chưa rõ Discord (liệt kê ở trên): liên kết tên game của họ rồi chạy lại, hoặc thêm --force để vẫn lưu (những người đăng ký còn lại sẽ ghi là chưa xác nhận)`);
    }
    const saved = await attendance.saveAttendance({ guildId, eventId: event._id, entries, source: path.basename(file), importedBy: 'script' });
    console.log(`saved attendance of war ${saved.eventId}`);
    eventLog.logEvent('roster', 'attendance_import', { source: 'script', ok: true, guild: guildId, event: String(event._id), present: entries.length, matched, unknown: cmp.unknown.length, came: cmp.came.length, noShow: cmp.noShow.length, walkIn: cmp.walkIn.length });
  } finally {
    await db.disconnectPg();
  }
}

main().catch((err) => {
  eventLog.logEvent('roster', 'attendance_import', { source: 'script', ok: false, err });
  console.error(require('../config/pg').redactPg(String((err && err.message) || err)));
  process.exitCode = 1;
});
