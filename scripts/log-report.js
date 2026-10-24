// Reads the structured event log (logs/events-YYYY-MM-DD.jsonl, written by src/eventLog.js) and prints what ran on real Discord:
// totals, per-action latency, grouped errors, the docs/LUONG-BOT.md section 6 checklist coverage, the scheduler timeline, the sheet sync.
//   npm run logs:report -- [--since 24h|7d|2026-10-11] [--dir logs] [--guild <id>] [--json]
// Default window: 7d. --json prints the same data as JSON (for an AI to parse). Reads files only; never touches the bot or the DB.
const fs = require('node:fs');
const path = require('node:path');
const { logDir } = require('../src/paths');

const SLOW_MS = 2500;
const FILE_RE = /^events-(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

// ---------- checklist of docs/LUONG-BOT.md section 6 ----------
// need = { ev: 'area.ev', where?: (e) => bool (which events count as this flow), ok?: (e) => bool (default: no error, ok !== false),
//          fail?: ['area.ev'] (other events that mean the flow was tried and failed), label? }.
// An item is ✅ when every need has a success, ❌ when a need was seen only failing, ⏳ when something was never seen.
const hasErr = (e) => e.lvl === 'error' || Boolean(e.err);
const clean = (e) => !hasErr(e) && e.ok !== false && e.outcome !== 'error';
const CHECKLIST = [
  { n: 1, title: 'Đăng ký Tham gia / Vắng, chọn phái', needs: [{ ev: 'war.register', where: (e) => e.result === 'ok', ok: clean }] },
  { n: 2, title: 'Tự nhắc trước hạn, tự chốt', needs: [{ ev: 'sched.remind', ok: () => true }, { ev: 'sched.lock' }] }, // a reminder without tags still went out
  { n: 3, title: 'Tự kết thúc trận sau 12 giờ', needs: [{ ev: 'sched.done' }] },
  { n: 4, title: 'Tự tạo trận hằng tuần', needs: [{ ev: 'sched.create', ok: (e) => e.result === 'created' || e.result === 'posted_missing' }] },
  { n: 5, title: 'Công bố link đội hình', needs: [{ ev: 'publish.posted', fail: ['publish.failed'] }] },
  {
    n: 6,
    title: 'Công bố khi trận còn mở (bước xác nhận)',
    needs: [
      { ev: 'publish.confirm_asked' },
      { ev: 'publish.posted', where: (e) => e.wasOpen === true, label: 'publish.posted (trận đang mở)', fail: ['publish.failed'] },
      { ev: 'publish.cancelled' },
    ],
  },
  {
    n: 7,
    title: 'Chưa đăng ký (giao diện mới)',
    needs: [{ ev: 'unreg.view' }, { ev: 'unreg.sent', fail: ['unreg.failed'] }, { ev: 'unreg.cooldown', where: (e) => e.reason === 'recent' }],
  },
  {
    n: 8,
    title: 'Chọn nhân vật: màn gọn khi đã liên kết',
    needs: [
      { ev: 'gn.view', where: (e) => e.mode === 'compact', label: 'gn.view compact' },
      { ev: 'gn.view', where: (e) => e.src === 'change', label: 'gn.view (Đổi nhân vật)' },
      { ev: 'gn.unlink', where: (e) => e.result === 'ok' },
    ],
  },
  {
    n: 9,
    title: 'Chọn tên đã có người giữ',
    needs: [
      { ev: 'gn.link', where: (e) => e.result === 'refused' && ['admin', 'self', 'selfFree', 'auto'].includes(e.reason), ok: () => true, label: 'gn.link bị từ chối' },
      { ev: 'gn.admin_notice', where: (e) => e.result !== 'skipped', ok: (e) => e.result === 'sent' },
    ],
  },
  { n: 10, title: 'Gõ tay tên không có trong danh sách', needs: [{ ev: 'gn.link', where: (e) => e.source === 'selfFree' && e.result === 'ok', label: 'gn.link selfFree ok' }] },
  { n: 11, title: 'Cập nhật danh sách bằng file Excel', needs: [{ ev: 'roster.import', where: (e) => e.source === 'upload' }] },
  {
    n: 12,
    title: 'Ghép tên, gỡ ghép',
    needs: [{ ev: 'roster.gmap_save', where: (e) => e.pairs > 0 }, { ev: 'roster.gmap_remove', where: (e) => e.removed > 0 }],
  },
  { n: 13, title: 'Đồng bộ ngay + 3 tab Sheet', needs: [{ ev: 'sheet.sync', where: (e) => e.trigger === 'now' && !e.skipped, ok: (e) => e.ok === true && !hasErr(e) }] },
  {
    n: 14,
    title: 'Tuyến Khiên: bỏ chọn người, người không có role bị bỏ qua',
    needs: [{ ev: 'war.tk', where: (e) => e.action === 'tkpick', label: 'war.tk tkpick' }, { ev: 'war.tk', where: (e) => e.skippedNoRole > 0, label: 'war.tk (bỏ qua không có role)' }],
  },
  { n: 15, title: 'Chốt tay → Mở lại', needs: [{ ev: 'admin.lock', where: (e) => e.result === 'locked', label: 'admin.lock locked' }, { ev: 'admin.lock', where: (e) => e.result === 'reopened', label: 'admin.lock reopened' }] },
  { n: 16, title: 'Chuyển bài sang kênh mới', needs: [{ ev: 'admin.move', where: (e) => e.result === 'moved', ok: (e) => e.result === 'moved' && !hasErr(e) }] },
  { n: 17, title: 'Nhắc thêm nút 🎮 sau khi bấm Tham gia', needs: [{ ev: 'war.gn_nudge' }] },
  { n: 18, title: 'Xem trên điện thoại', needs: [], manual: true }, // looks only: no event can prove it
  { n: 19, title: 'Báo người đã rời bang trong game nhưng còn trong Discord', needs: [{ ev: 'roster.depart_notice', where: (e) => e.posted === true }] },
  { n: 20, title: 'Hòm thư: gửi thư (ẩn danh / kèm tên) và quản lý trả lời', needs: [{ ev: 'mail.sent', where: (e) => e.anonymous === true, label: 'mail.sent ẩn danh' }, { ev: 'mail.reply' }] },
  { n: 21, title: 'Hòm thư: xem trả lời bằng mã thư', needs: [{ ev: 'mail.view_code', where: (e) => e.result === 'ok', label: 'mail.view_code ok' }] },
  { n: 22, title: 'Sự kiện: quản lý tạo sự kiện, thẻ được đăng', needs: [{ ev: 'event.create', where: (e) => e.result === 'created' || e.result === 'error', ok: (e) => e.result === 'created' && !hasErr(e), label: 'event.create created' }] },
  { n: 23, title: 'Sự kiện: thành viên trả lời, bị từ chối khi đã đủ người', needs: [{ ev: 'event.reply', where: (e) => e.result === 'ok', label: 'event.reply ok' }, { ev: 'event.reply', where: (e) => e.result === 'full', ok: () => true, label: 'event.reply (đã đủ người)' }] },
  { n: 24, title: 'Sự kiện: tự nhắc trước giờ bắt đầu', needs: [{ ev: 'event.remind', where: (e) => e.mode === 'auto', ok: (e) => !hasErr(e), label: 'event.remind auto' }] },
  { n: 25, title: 'Sự kiện: huỷ sự kiện (thẻ chuyển xám, bot báo trong kênh)', needs: [{ ev: 'event.cancel', ok: (e) => e.notice === 'sent' && !hasErr(e), label: 'event.cancel (đã báo trong kênh)' }] },
  { n: 26, title: 'Sự kiện: thiếu người tối thiểu, tin báo trong kênh admin và quản lý bấm quyết định', needs: [{ ev: 'event.min_notice', where: (e) => e.result === 'posted', ok: (e) => !hasErr(e), label: 'event.min_notice posted' }, { ev: 'event.min_decision', where: (e) => e.result === 'ok', ok: (e) => !hasErr(e), label: 'event.min_decision' }] },
  {
    n: 27,
    title: 'Sự kiện: đăng bảng quản lý ở kênh quản lý sự kiện, quản lý mở màn quản lý từ bảng',
    needs: [{ ev: 'setup.event_panel_posted', where: (e) => e.result === 'posted' || e.result === 'edited' || e.result === 'error', ok: (e) => e.result !== 'error' && !hasErr(e), label: 'setup.event_panel_posted' }, { ev: 'event.manage_open', where: (e) => e.src === 'panel', label: 'event.manage_open (từ bảng)' }],
  },
  {
    n: 28,
    title: 'Cổng vào: đăng bảng (một nút Thành viên bang)',
    needs: [
      { ev: 'setup.gate_panel_posted', where: (e) => e.result === 'posted' || e.result === 'edited' || e.result === 'error', ok: (e) => e.result !== 'error' && !hasErr(e), label: 'setup.gate_panel_posted' },
    ],
  },
  {
    n: 29,
    title: 'Cổng vào: thành viên gửi yêu cầu, quản lý duyệt (role + liên kết tên + phái)',
    needs: [
      { ev: 'gate.request', where: (e) => !e.result || e.result === 'card_failed', ok: (e) => !e.result && !hasErr(e), label: 'gate.request' },
      { ev: 'gate.approve', ok: (e) => !hasErr(e), label: 'gate.approve' },
    ],
  },
  { n: 30, title: 'Cổng vào: quản lý từ chối (có lý do)', needs: [{ ev: 'gate.reject', where: (e) => e.reason === true, label: 'gate.reject (kèm lý do)' }] },
  { n: 31, title: 'Cổng vào: cảnh báo khi role của bot thấp hơn (không duyệt nửa vời, yêu cầu vẫn chờ)', needs: [{ ev: 'gate.role_failed', ok: () => true }] }, // a logged failure is the proof that the warning path ran
  { n: 34, title: 'Báo người off quá N ngày không xin phép', needs: [{ ev: 'roster.off_notice', where: (e) => e.posted === true, label: 'roster.off_notice posted' }] },
  { n: 35, title: 'Sổ vi phạm: quản lý ghi một vi phạm, dòng ghi nhận hiện ở kênh admin', needs: [{ ev: 'vp.create', where: (e) => e.result === 'ok', ok: (e) => e.audit === 'posted' && !hasErr(e), label: 'vp.create ok (đã đăng dòng ghi nhận)' }] },
  { n: 36, title: 'Quay thưởng: kết quả được đăng công khai, chỉ tag người trúng', needs: [{ ev: 'gc.draw', where: (e) => e.result === 'ok', ok: (e) => e.posted === true && !hasErr(e), label: 'gc.draw posted' }] },
];

// ---------- arguments ----------

function parseSince(text, now = new Date()) {
  let m = /^(\d+)([hd])$/.exec(String(text));
  if (m) return new Date(now.getTime() - Number(m[1]) * (m[2] === 'h' ? 3600e3 : 86400e3));
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text));
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])); // local midnight
  throw new Error(`--since: "${text}" không hợp lệ (dùng 24h, 7d hoặc 2026-10-11)`);
}

function parseArgs(argv, env = process.env) {
  const out = { since: '7d', dir: null, guild: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--since' || a === '--dir' || a === '--guild') {
      if (argv[i + 1] === undefined) throw new Error(`${a} cần một giá trị`);
      out[a.slice(2)] = argv[++i];
    } else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`tham số lạ: ${a}`);
  }
  out.dir = out.dir || logDir({ argv: [], env });
  return out;
}

// ---------- reading ----------

// -> { events, files, bad }: the parsed events with ts >= since (and <= until), oldest first.
function readEvents(dir, { since, until = new Date(), guild = null } = {}) {
  const events = [];
  const files = [];
  let bad = 0;
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => FILE_RE.test(n)).sort();
  } catch {
    return { events, files, bad, missing: true };
  }
  const dayStart = since ? new Date(since.getFullYear(), since.getMonth(), since.getDate()).getTime() : 0;
  for (const name of names) {
    const [, y, mo, d] = FILE_RE.exec(name);
    if (new Date(Number(y), Number(mo) - 1, Number(d)).getTime() < dayStart) continue; // the whole file is older than the window
    files.push(name);
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        bad++;
        continue;
      }
      if (!e || typeof e !== 'object' || Array.isArray(e)) {
        bad++; // valid JSON that is not an event (null, 5, "x", [])
        continue;
      }
      const t = Date.parse(e.ts);
      if (Number.isNaN(t) || (since && t < since.getTime()) || (until && t > until.getTime())) continue;
      if (guild && e.guild !== undefined && String(e.guild) !== String(guild)) continue; // boot / global events have no guild: kept
      events.push(e);
    }
  }
  events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return { events, files, bad };
}

// ---------- analysis ----------

const key = (e) => `${e.area}.${e.ev}`;
function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function needStatus(events, need) {
  const seen = events.filter((e) => key(e) === need.ev && (!need.where || need.where(e)));
  const failures = events.filter((e) => (need.fail || []).includes(key(e)));
  const isOk = need.ok || clean;
  const good = seen.filter(isOk);
  const status = good.length ? 'ok' : seen.length || failures.length ? 'fail' : 'none';
  return { ev: need.label || need.ev, status, count: good.length, seen: seen.length, failures: failures.length };
}

function coverage(events) {
  return CHECKLIST.map((item) => {
    const needs = item.needs.map((n) => needStatus(events, n));
    let status = 'none';
    if (needs.length && needs.every((n) => n.status === 'ok')) status = 'ok';
    else if (needs.some((n) => n.status === 'fail')) status = 'fail';
    return { n: item.n, title: item.title, status, manual: Boolean(item.manual), needs };
  });
}

function errorGroups(events) {
  const groups = new Map();
  for (const e of events) {
    if (!hasErr(e)) continue;
    const err = e.err || {};
    const what = err.code !== undefined ? `code ${err.code}` : String(err.msg || '').slice(0, 80);
    const label = e.area === 'ix' && e.action ? `${key(e)} [${e.action}]` : key(e);
    const k = `${label}|${err.code !== undefined ? err.code : ''}|${String(err.msg || '').slice(0, 80)}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { key: label, code: err.code, msg: String(err.msg || '').slice(0, 80), what, count: 0, first: e.ts, last: e.ts, example: e }));
    g.count++;
    g.last = e.ts;
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

function buildReport(events, { since = null, until = new Date(), files = [], bad = 0, guild = null } = {}) {
  const ix = events.filter((e) => e.area === 'ix' && e.ev === 'done');
  const byAction = new Map();
  for (const e of ix) {
    const name = e.arg ? `${e.action}:${e.arg}` : e.action;
    let a = byAction.get(name);
    if (!a) byAction.set(name, (a = { action: name, count: 0, errors: 0, slow: 0, ms: [] }));
    a.count++;
    if (e.outcome === 'error') a.errors++;
    if (e.slow || e.ms > SLOW_MS) a.slow++;
    if (typeof e.ms === 'number') a.ms.push(e.ms);
  }
  const actions = [...byAction.values()]
    .map((a) => {
      const ms = a.ms.sort((x, y) => x - y);
      return { action: a.action, count: a.count, errors: a.errors, slow: a.slow, p50: percentile(ms, 50), p95: percentile(ms, 95) };
    })
    .sort((a, b) => b.count - a.count);

  const sched = events
    .filter((e) => e.area === 'sched')
    .map((e) => ({ ts: e.ts, ev: e.ev, eid: e.eid, guild: e.guild, result: e.result, reason: e.reason, pinged: e.pinged, fallback: e.fallback, step: e.step, err: e.err && (e.err.code !== undefined ? `code ${e.err.code}` : e.err.msg) }));

  const syncs = events.filter((e) => e.area === 'sheet' && e.ev === 'sync');
  const fails = syncs.filter((e) => e.ok === false && !e.skipped);
  const oks = syncs.filter((e) => e.ok === true);
  const lastOk = oks[oks.length - 1];
  const lastFail = fails[fails.length - 1];
  const sheet = {
    syncs: syncs.length,
    ok: oks.length,
    failures: fails.length,
    skipped: syncs.filter((e) => e.skipped && e.ok === false).length,
    lastOk: lastOk ? { ts: lastOk.ts, trigger: lastOk.trigger, rows: lastOk.rows, roster: lastOk.roster, danhba: lastOk.danhba, ms: lastOk.ms } : null,
    lastError: lastFail ? { ts: lastFail.ts, trigger: lastFail.trigger, msg: lastFail.err && lastFail.err.msg, code: lastFail.err && lastFail.err.code } : null,
  };

  return {
    window: { since: since && since.toISOString(), until: until && until.toISOString(), files, guild, events: events.length, badLines: bad },
    totals: {
      interactions: ix.length,
      errors: ix.filter((e) => e.outcome === 'error').length,
      slow: ix.filter((e) => e.slow || e.ms > SLOW_MS).length,
      eventErrors: events.filter(hasErr).length,
    },
    actions,
    errors: errorGroups(events),
    coverage: coverage(events),
    scheduler: sched,
    sheet,
  };
}

// ---------- text ----------

const pad2 = (n) => String(n).padStart(2, '0');
function local(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
const ICON = { ok: '✅', fail: '❌', none: '⏳' };
const short = (id) => (id ? String(id).slice(-6) : '');

function shortLine(e) {
  const copy = { ...e };
  if (copy.err) copy.err = { ...copy.err, stack: undefined };
  const text = JSON.stringify(copy);
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

function renderText(r) {
  const out = [];
  const w = r.window;
  out.push(`BÁO CÁO NHẬT KÝ SỰ KIỆN  ${w.since ? local(w.since) : '(đầu)'} → ${local(w.until)}${w.guild ? `  · guild ${w.guild}` : ''}`);
  out.push(`File: ${w.files.length ? w.files.join(', ') : '(không có file events-*.jsonl)'} · ${w.events} sự kiện${w.badLines ? ` · ${w.badLines} dòng hỏng` : ''}`);
  out.push('');
  out.push(`TỔNG: ${r.totals.interactions} tương tác · ${r.totals.errors} lỗi · ${r.totals.slow} chậm (> ${SLOW_MS} ms) · ${r.totals.eventErrors} sự kiện có lỗi`);
  out.push('');
  out.push('THEO NÚT / LỆNH');
  if (!r.actions.length) out.push('  (chưa có tương tác nào)');
  else {
    const width = Math.min(34, Math.max(6, ...r.actions.map((a) => a.action.length)));
    out.push(`  ${'action'.padEnd(width)}  ${'số'.padStart(5)} ${'lỗi'.padStart(4)} ${'chậm'.padStart(4)} ${'p50'.padStart(6)} ${'p95'.padStart(6)}  (ms)`);
    for (const a of r.actions) out.push(`  ${a.action.padEnd(width)}  ${String(a.count).padStart(5)} ${String(a.errors).padStart(4)} ${String(a.slow).padStart(4)} ${String(a.p50 ?? '-').padStart(6)} ${String(a.p95 ?? '-').padStart(6)}`);
  }
  out.push('');
  out.push('LỖI (nhóm theo sự kiện + mã/thông báo)');
  if (!r.errors.length) out.push('  (không có lỗi)');
  for (const g of r.errors) {
    out.push(`  ${g.count}x  ${g.key}  ${g.what}`);
    out.push(`      đầu ${local(g.first)} · cuối ${local(g.last)}`);
    out.push(`      ví dụ: ${shortLine(g.example)}`);
  }
  out.push('');
  out.push('KIỂM TRA THỰC TẾ (docs/LUONG-BOT.md §6)   ✅ chạy ổn · ❌ chỉ thấy lỗi · ⏳ chưa thấy');
  for (const c of r.coverage) {
    const detail = c.manual ? 'không có sự kiện để chứng minh (xem tay trên điện thoại)' : c.needs.map((n) => `${n.ev} ${ICON[n.status]}${n.count ? ` ×${n.count}` : ''}${n.failures ? ` (lỗi ×${n.failures})` : ''}`).join(' · ');
    out.push(`  ${ICON[c.status]} #${String(c.n).padStart(2)} ${c.title}`);
    out.push(`        ${detail}`);
  }
  out.push('');
  out.push('LỊCH TỰ ĐỘNG (chỉ khi có việc)');
  if (!r.scheduler.length) out.push('  (chưa có)');
  for (const s of r.scheduler) {
    const bits = [s.result, s.reason, s.pinged !== undefined ? `nhắc ${s.pinged}` : null, s.fallback ? 'không tag' : null, s.step ? `bước ${s.step}` : null, s.err].filter(Boolean).join(' · ');
    out.push(`  ${local(s.ts)}  sched.${s.ev.padEnd(10)} ${short(s.eid).padEnd(6)} ${bits}`);
  }
  out.push('');
  out.push('GOOGLE SHEET');
  const sh = r.sheet;
  out.push(`  ${sh.syncs} lần đồng bộ · ${sh.ok} thành công · ${sh.failures} lỗi · ${sh.skipped} bỏ qua (chưa có Sheet/khoá)`);
  out.push(sh.lastOk ? `  Lần thành công gần nhất: ${local(sh.lastOk.ts)} (${sh.lastOk.trigger}, ${sh.lastOk.rows} dòng, ${sh.lastOk.roster} game, ${sh.lastOk.danhba} danh bạ, ${sh.lastOk.ms} ms)` : '  Chưa có lần thành công nào.');
  out.push(sh.lastError ? `  Lỗi gần nhất: ${local(sh.lastError.ts)} (${sh.lastError.trigger}) ${sh.lastError.code !== undefined ? `code ${sh.lastError.code} ` : ''}${sh.lastError.msg || ''}` : '  Chưa có lỗi.');
  return out.join('\n');
}

// ---------- main ----------

function main(argv = process.argv.slice(2), { now = new Date(), write = (s) => process.stdout.write(`${s}\n`) } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    write('Dùng: node scripts/log-report.js [--since 24h|7d|2026-10-11] [--dir logs] [--guild <id>] [--json]');
    return null;
  }
  const since = parseSince(args.since, now);
  const read = readEvents(args.dir, { since, until: now, guild: args.guild });
  const report = buildReport(read.events, { since, until: now, files: read.files, bad: read.bad, guild: args.guild });
  write(args.json ? JSON.stringify(report, null, 2) : renderText(report));
  return report;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

module.exports = { main, parseArgs, parseSince, readEvents, buildReport, renderText, coverage, errorGroups, percentile, CHECKLIST };
