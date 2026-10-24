// scripts/log-report.js on a small fixture: parsing, windows, percentiles, error groups, checklist coverage, sheet summary.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs, parseSince, readEvents, buildReport, renderText, percentile, main } = require('../scripts/log-report');

const EID = '65f1a2b3c4d5e6f708192a3b';
const NOW = new Date(2026, 9, 11, 12, 0, 0);
const at = (h, m = 0) => new Date(2026, 9, 11, h, m, 0).toISOString();
const ev = (ts, area, name, fields = {}) => ({ ts, lvl: fields.err ? 'error' : 'info', area, ev: name, ...fields });

const FIXTURE = [
  ev(at(8), 'boot', 'start', { version: '1.0.0', pid: 1 }),
  ev(at(9), 'ix', 'done', { kind: 'button', action: 'war:st', arg: 'join', eid: EID, guild: 'G1', user: 'U1', ms: 100, outcome: 'ok' }),
  ev(at(9, 1), 'ix', 'done', { kind: 'button', action: 'war:st', arg: 'join', eid: EID, guild: 'G1', user: 'U2', ms: 300, outcome: 'ok' }),
  ev(at(9, 2), 'ix', 'done', { kind: 'button', action: 'war:st', arg: 'join', eid: EID, guild: 'G1', user: 'U3', ms: 3100, slow: true, outcome: 'ok' }),
  ev(at(9, 3), 'ix', 'done', { kind: 'button', action: 'tm:pubok', eid: EID, guild: 'G1', user: 'U9', ms: 50, outcome: 'error', err: { msg: 'Unknown interaction', code: 10062 } }),
  ev(at(9, 4), 'ix', 'done', { kind: 'button', action: 'tm:pubok', eid: EID, guild: 'G1', user: 'U9', ms: 60, outcome: 'error', err: { msg: 'Unknown interaction', code: 10062 } }),
  ev(at(9, 5), 'war', 'register', { guild: 'G1', user: 'U1', eid: EID, status: 'join', classFrom: 'role', result: 'ok' }),
  ev(at(9, 6), 'publish', 'failed', { guild: 'G1', eid: EID, err: { msg: 'Missing Permissions', code: 50013 } }),
  ev(at(10), 'gn', 'view', { guild: 'G1', mode: 'compact', src: 'open', hasRoster: true }),
  ev(at(10, 1), 'unreg', 'view', { guild: 'G1', total: 5, inGame: 3, unknown: 2 }),
  ev(at(10, 2), 'sched', 'create', { guild: 'G1', result: 'skipped', reason: 'post_failed', err: { msg: 'Missing Access', code: 50001 } }),
  ev(at(10, 3), 'sched', 'lock', { guild: 'G1', eid: EID }),
  ev(at(10, 4), 'sheet', 'sync', { guild: 'G1', trigger: 'now', ok: true, rows: 12, roster: 40, danhba: 41, ms: 900 }),
  ev(at(10, 5), 'sheet', 'sync', { guild: 'G1', trigger: 'debounce', ok: false, ms: 80, err: { msg: 'The caller does not have permission', code: 403 } }),
  ev(at(10, 6), 'sheet', 'sync', { guild: 'G1', trigger: 'debounce', ok: false, skipped: 'no-key', lvl: 'warn' }),
  ev(at(11), 'roster', 'import', { guild: 'G2', source: 'script', ok: true, rows: 50 }),
  ev(at(11, 1), 'ix', 'done', { kind: 'button', action: 'adm:sheetnow', guild: 'G2', user: 'U5', ms: 700, outcome: 'ok' }),
];
const OLD = ev(new Date(2026, 9, 3, 9).toISOString(), 'sched', 'done', { eid: EID });

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'll-report-'));
  fs.writeFileSync(path.join(dir, 'events-2026-10-11.jsonl'), `${FIXTURE.map((e) => JSON.stringify(e)).join('\n')}\nnot json at all\n`);
  fs.writeFileSync(path.join(dir, 'events-2026-10-03.jsonl'), `${JSON.stringify(OLD)}\n`);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const report = (opts = {}) => {
  const since = parseSince(opts.since || '24h', NOW);
  const read = readEvents(dir, { since, until: NOW, guild: opts.guild });
  return buildReport(read.events, { since, until: NOW, files: read.files, bad: read.bad, guild: opts.guild });
};

describe('log-report parsing', () => {
  it('parseSince: hours, days, a date', () => {
    assert.equal(parseSince('24h', NOW).getTime(), NOW.getTime() - 24 * 3600e3);
    assert.equal(parseSince('7d', NOW).getTime(), NOW.getTime() - 7 * 86400e3);
    assert.equal(parseSince('2026-10-11', NOW).getTime(), new Date(2026, 9, 11).getTime());
    assert.throws(() => parseSince('yesterday', NOW), /--since/);
  });
  it('parseArgs', () => {
    const a = parseArgs(['--since', '7d', '--dir', 'x', '--guild', 'G1', '--json']);
    assert.deepEqual([a.since, a.dir, a.guild, a.json], ['7d', 'x', 'G1', true]);
    assert.throws(() => parseArgs(['--nope']), /tham số lạ/);
    assert.throws(() => parseArgs(['--since']), /cần một giá trị/);
  });
  it('skips bad lines and files outside the window', () => {
    const r = report();
    assert.equal(r.window.badLines, 1);
    assert.deepEqual(r.window.files, ['events-2026-10-11.jsonl']);
    assert.equal(report({ since: '10d' }).window.files.length, 2);
  });
  it('a jsonl line that parses to a non-object (null, a number, a string, an array) is a bad line, not a crash', () => {
    fs.writeFileSync(path.join(dir, 'events-2026-10-11.jsonl'), [JSON.stringify(FIXTURE[0]), 'null', '42', '"text"', '[1,2]', ''].join('\n'));
    const r = report();
    assert.equal(r.window.badLines, 4);
    assert.equal(r.window.events, 1);
  });
  it('--guild keeps that guild and the events without a guild', () => {
    const r = report({ guild: 'G2' });
    assert.equal(r.totals.interactions, 1);
    assert.ok(r.window.events >= 3);
  });
  it('a missing directory is an empty report, not a crash', () => {
    const read = readEvents(path.join(dir, 'nope'), { since: NOW });
    assert.equal(read.events.length, 0);
    assert.doesNotThrow(() => renderText(buildReport([], { since: NOW, until: NOW })));
  });
});

describe('log-report numbers', () => {
  it('percentile is nearest-rank', () => {
    assert.equal(percentile([10, 20, 30, 40], 50), 20);
    assert.equal(percentile([10, 20, 30, 40], 95), 40);
    assert.equal(percentile([], 50), null);
  });
  it('totals and per-action stats', () => {
    const r = report();
    assert.deepEqual(r.totals, { interactions: 6, errors: 2, slow: 1, eventErrors: 5 });
    const join = r.actions.find((a) => a.action === 'war:st:join');
    assert.deepEqual([join.count, join.errors, join.slow, join.p50, join.p95], [3, 0, 1, 300, 3100]);
    assert.equal(r.actions.find((a) => a.action === 'tm:pubok').errors, 2);
  });
  it('groups errors by event + code, with first / last / example', () => {
    const g = report().errors.find((x) => x.key === 'ix.done [tm:pubok]');
    assert.equal(g.count, 2);
    assert.equal(g.code, 10062);
    assert.equal(g.first, at(9, 3));
    assert.equal(g.last, at(9, 4));
    assert.equal(g.example.action, 'tm:pubok');
    assert.equal(report().errors.length, 4); // + publish.failed, sched.create, sheet.sync
  });
  it('sheet summary: last success, last error, failure count (a skip is not a failure)', () => {
    const s = report().sheet;
    assert.equal(s.failures, 1);
    assert.equal(s.skipped, 1);
    assert.equal(s.lastOk.ts, at(10, 4));
    assert.equal(s.lastOk.rows, 12);
    assert.equal(s.lastError.code, 403);
  });
  it('scheduler timeline lists only what happened', () => {
    const t = report().scheduler;
    assert.deepEqual(t.map((x) => x.ev), ['create', 'lock']);
    assert.equal(t[0].reason, 'post_failed');
  });
});

describe('log-report checklist coverage', () => {
  const byN = (r, n) => r.coverage.find((c) => c.n === n);
  it('has all 19 items of docs/LUONG-BOT.md section 6', () => {
    assert.deepEqual(report().coverage.map((c) => c.n), Array.from({ length: 36 }, (_, i) => i + 1).filter((n) => n !== 32 && n !== 33));
    assert.ok(!report().coverage.some((c) => /Xin nghỉ/.test(c.title)), 'the 🙋 Xin nghỉ items are gone');
  });
  it('✅ for a success, ❌ when only failures were seen, ⏳ when never seen', () => {
    const r = report();
    assert.equal(byN(r, 1).status, 'ok'); // war.register ok
    assert.equal(byN(r, 5).status, 'fail'); // publish.failed, no publish.posted
    assert.equal(byN(r, 4).status, 'fail'); // sched.create seen but only skipped
    assert.equal(byN(r, 3).status, 'none'); // no sched.done in the window
    assert.equal(byN(r, 13).status, 'ok'); // sheet.sync trigger now ok (the failed debounce one does not count)
    assert.equal(byN(r, 11).status, 'none'); // only a script import, #11 needs source upload
    assert.equal(byN(r, 18).manual, true);
  });
  it('an item with several events is ✅ only when all of them were seen', () => {
    const r = report();
    const seven = byN(r, 7);
    assert.equal(seven.status, 'none'); // unreg.view seen, unreg.sent / unreg.cooldown not
    assert.deepEqual(seven.needs.map((n) => n.status), ['ok', 'none', 'none']);
    assert.equal(byN(r, 8).needs[0].status, 'ok'); // gn.view compact
  });
  it('#19 (left the game, still on Discord) is ✅ only when a notice was really posted', () => {
    const cover = (events) => buildReport(events, { since: new Date(2026, 9, 11), until: NOW }).coverage.find((c) => c.n === 19).status;
    assert.equal(cover([]), 'none');
    assert.equal(cover([ev(at(9), 'roster', 'depart_notice', { guild: 'G1', rosterId: 'r', count: 0, posted: false, reason: 'none' })]), 'none');
    assert.equal(cover([ev(at(9), 'roster', 'depart_notice', { guild: 'G1', rosterId: 'r', count: 3, posted: true })]), 'ok');
  });
  it('the text report renders the sections', () => {
    const text = renderText(report());
    for (const part of ['BÁO CÁO', 'TỔNG: 6 tương tác', 'THEO NÚT / LỆNH', 'war:st:join', 'LỖI', 'code 10062', 'KIỂM TRA THỰC TẾ', '✅ # 1', '❌ # 5', '⏳ # 3', 'LỊCH TỰ ĐỘNG', 'GOOGLE SHEET']) {
      assert.ok(text.includes(part), `missing "${part}"`);
    }
  });
  it('main --json prints parseable JSON', () => {
    const out = [];
    main(['--dir', dir, '--since', '2026-10-11', '--json'], { now: NOW, write: (s) => out.push(s) });
    const parsed = JSON.parse(out.join('\n'));
    assert.equal(parsed.totals.interactions, 6);
    assert.equal(parsed.coverage.length, 34);
  });
});

describe('log-report checklist: guild events (22-26)', () => {
  const { coverage } = require('../scripts/log-report');
  const statusOf = (events, n) => coverage(events).find((c) => c.n === n).status;
  const E = (name, fields) => ev(at(9), 'event', name, { guild: 'G1', eid: EID, ...fields });
  it('never seen -> none', () => {
    for (const n of [22, 23, 24, 25, 26]) assert.equal(statusOf([], n), 'none', String(n));
  });
  it('create / reply (ok AND full) / auto remind / cancel with a notice are each proven by their event', () => {
    assert.equal(statusOf([E('create', { result: 'created' })], 22), 'ok');
    assert.equal(statusOf([E('create', { result: 'error', err: { msg: 'Missing Access', code: 50001 } })], 22), 'fail');
    assert.equal(statusOf([E('reply', { result: 'ok', status: 'yes' })], 23), 'none', 'ok alone is not enough: the full refusal must be seen too');
    assert.equal(statusOf([E('reply', { result: 'ok', status: 'yes' }), E('reply', { result: 'full', status: 'yes' })], 23), 'ok');
    assert.equal(statusOf([E('remind', { mode: 'manual', pinged: 3 })], 24), 'none', 'a manual reminder is not the automatic one');
    assert.equal(statusOf([E('remind', { mode: 'auto', pinged: 3 })], 24), 'ok');
    assert.equal(statusOf([E('cancel', { yes: 1, maybe: 0, no: 0, notice: 'sent' })], 25), 'ok');
    assert.equal(statusOf([E('cancel', { notice: 'failed', lvl: 'warn' })], 25), 'fail');
  });
  it('#26 (shortfall notice) needs a posted notice AND a manager decision', () => {
    const posted = E('min_notice', { result: 'posted', yes: 9, min: 15 });
    const skipped = E('min_notice', { result: 'skipped', reason: 'reached', yes: 15, min: 15 });
    const decided = E('min_decision', { decision: 'extend', result: 'ok' });
    assert.equal(statusOf([posted], 26), 'none');
    assert.equal(statusOf([skipped, decided], 26), 'none', 'a skipped notice proves nothing');
    assert.equal(statusOf([posted, decided], 26), 'ok');
    assert.equal(statusOf([posted, E('min_decision', { decision: 'cancel', result: 'invalid' })], 26), 'none', 'only an accepted decision counts');
  });
});

describe('log-report checklist: the event panel (27)', () => {
  const { coverage } = require('../scripts/log-report');
  const status = (events) => coverage(events).find((c) => c.n === 27).status;
  const SETUP = (name, fields) => ev(at(9), 'setup', name, { guild: 'G1', ...fields });
  const EVT = (name, fields) => ev(at(9), 'event', name, { guild: 'G1', ...fields });
  it('needs a posted / refreshed panel AND a manage view opened from it', () => {
    assert.equal(status([]), 'none');
    assert.equal(status([SETUP('event_panel_posted', { result: 'posted', channel: 'c' })]), 'none');
    assert.equal(status([EVT('manage_open', { src: 'panel' })]), 'none');
    assert.equal(status([SETUP('event_panel_posted', { result: 'edited', channel: 'c' }), EVT('manage_open', { src: 'panel' })]), 'ok');
    assert.equal(status([SETUP('event_panel_posted', { result: 'posted', channel: 'c' }), EVT('manage_open', {})]), 'none', 'the old dashboard path does not count');
  });
  it('a failed post is a failure', () => {
    assert.equal(status([SETUP('event_panel_posted', { result: 'error', channel: 'c', err: { msg: 'Missing Access', code: 50001 } })]), 'fail');
  });
});

describe('log-report checklist: the off notice (34; 32-33 were 🙋 Xin nghỉ, retired)', () => {
  const { coverage } = require('../scripts/log-report');
  const status = (n, events) => coverage(events).find((c) => c.n === n).status;
  const L = (area, name, fields) => ev(at(9), area, name, { guild: 'G1', ...fields });
  it('32 and 33 are no longer in the checklist', () => {
    const ns = coverage([L('leave', 'create', { result: 'ok', card: 'posted' }), L('leave', 'auto_absent', { eid: 'e', count: 3 })]).map((c) => c.n);
    assert.ok(!ns.includes(32) && !ns.includes(33));
  });
  it('34: the off notice is proven only by a posted card', () => {
    assert.equal(status(34, [L('roster', 'off_notice', { count: 0, posted: false, reason: 'none' })]), 'none');
    assert.equal(status(34, [L('roster', 'off_notice', { count: 4, posted: true })]), 'ok');
  });
});

describe('log-report checklist: the new-member gate (28-31)', () => {
  const { coverage } = require('../scripts/log-report');
  const status = (n, events) => coverage(events).find((c) => c.n === n).status;
  const GATE = (name, fields) => ev(at(9), 'gate', name, { guild: 'G1', ...fields });
  const SETUP = (name, fields) => ev(at(9), 'setup', name, { guild: 'G1', ...fields });
  it('28: needs only the panel posted (no guest path any more)', () => {
    assert.equal(status(28, []), 'none');
    assert.equal(status(28, [GATE('guest', { result: 'ok' })]), 'none');
    assert.equal(status(28, [SETUP('gate_panel_posted', { result: 'posted', channel: 'c' })]), 'ok');
    assert.equal(status(28, [SETUP('gate_panel_posted', { result: 'edited', channel: 'c' })]), 'ok');
    assert.equal(status(28, [SETUP('gate_panel_posted', { result: 'error', channel: 'c', err: { msg: 'Missing Access', code: 50001 } })]), 'fail');
  });
  it('29: a request and an approval; a card that could not be posted is a failure', () => {
    assert.equal(status(29, [GATE('request', { gameInRoster: true, free: false }), GATE('approve', { by: 'A' })]), 'ok');
    assert.equal(status(29, [GATE('request', { gameInRoster: true, free: false })]), 'none');
    assert.equal(status(29, [GATE('request', { result: 'card_failed', err: { msg: 'Missing Access' } })]), 'fail');
  });
  it('30: a reject with a reason (the switch to guest is gone)', () => {
    assert.equal(status(30, []), 'none');
    assert.equal(status(30, [GATE('reject', { by: 'A', reason: true })]), 'ok');
    assert.equal(status(30, [GATE('reject', { by: 'A', reason: false })]), 'none');
    assert.equal(status(30, [GATE('to_guest', { by: 'A' })]), 'none');
  });
  it('31: a role_failed line proves the warning path (a warn-level line is not an error)', () => {
    assert.equal(status(31, []), 'none');
    assert.equal(status(31, [GATE('role_failed', { kind: 'member', lvl: 'warn', problem: 'hierarchy' })]), 'ok');
  });
});

describe('log-report checklist: violations log and prize draw (35-36)', () => {
  const { coverage } = require('../scripts/log-report');
  const status = (n, events) => coverage(events).find((c) => c.n === n).status;
  const L = (area, name, fields) => ev(at(9), area, name, { guild: 'G1', ...fields });
  it('35: only a saved record whose audit line was posted proves it; a failed audit line is a failure', () => {
    assert.equal(status(35, []), 'none');
    assert.equal(status(35, [L('vp', 'create', { result: 'invalid' })]), 'none');
    assert.equal(status(35, [L('vp', 'create', { result: 'ok', audit: 'posted', dm: 'sent' })]), 'ok');
    assert.notEqual(status(35, [L('vp', 'create', { result: 'ok', audit: 'failed', lvl: 'warn' })]), 'ok');
  });
  it('36: a draw counts when it was posted publicly', () => {
    assert.equal(status(36, []), 'none');
    assert.equal(status(36, [L('gc', 'draw', { result: 'gone' })]), 'none');
    assert.equal(status(36, [L('gc', 'draw', { result: 'ok', posted: true, pool: 8, winners: 3, round: 1, kind: 'event' })]), 'ok');
    assert.notEqual(status(36, [L('gc', 'draw', { result: 'ok', posted: false, lvl: 'warn' })]), 'ok');
  });
});
