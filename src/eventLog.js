// Structured event log: one JSON object per line in <logDir>/events-YYYY-MM-DD.jsonl (local date, Asia/Ho_Chi_Minh on the host).
// It sits next to the human log (console -> longlinh.log), it does not replace it. Read it with `npm run logs:report`.
// Nothing here throws or awaits: a write is one small synchronous fd write (sync on purpose, so a line logged right before
// process.exit is not lost). Off until init() is called (app.js / scripts), so tests and requires never touch the disk.
const fs = require('node:fs');
const path = require('node:path');

const AREAS = ['boot', 'ix', 'sched', 'sheet', 'refresh', 'db', 'atlas', 'roster', 'setup', 'admin', 'war', 'gn', 'publish', 'unreg', 'mail', 'event', 'gate', 'voice'];
const KEEP_DAYS = 30;
const FILE_RE = /^events-(\d{4})-(\d{2})-(\d{2})\.jsonl$/;
const STACK_LINES = 6;
const MSG_MAX = 300;

// ---------- redaction ----------

// Applied to the finished line, so a secret inside any field (an error message, a URL) is blanked too.
const REDACTIONS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|[^"]*)/g, '<private key>'],
  [/("private_key"\s*:\s*")[^"]*(")/g, '$1<redacted>$2'],
  [/mongodb(\+srv)?:\/\/[^\s"'/@]*@/gi, 'mongodb$1://<redacted>@'],
  [/postgres(ql)?:\/\/[^\s"'/@]*@/gi, 'postgres$1://<redacted>@'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer <redacted>'],
  [/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{15,}/g, '<token>'], // a Discord bot token: three base64url parts
];

function redact(text) {
  let out = String(text);
  for (const [re, to] of REDACTIONS) out = out.replace(re, to);
  return out;
}

// ---------- errors ----------

// -> { msg, code, status, name, stack } (the first STACK_LINES lines only). Discord API errors carry `code` (10062 = unknown
// interaction: answered too late, 50013 = missing permissions) and `status` (HTTP).
function serializeError(err) {
  if (err === null || err === undefined) return { msg: String(err) };
  if (typeof err !== 'object') return { msg: String(err).slice(0, MSG_MAX) };
  const out = { msg: String(err.message === undefined ? err : err.message).slice(0, MSG_MAX) };
  if (err.code !== undefined) out.code = err.code;
  if (err.status !== undefined) out.status = err.status;
  if (err.name) out.name = err.name;
  if (typeof err.stack === 'string') out.stack = err.stack.split('\n').slice(0, STACK_LINES).join('\n');
  return out;
}

// ---------- file writer ----------

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; // local date, not UTC
const fileNameFor = (d) => `events-${dayOf(d)}.jsonl`;

// Deletes events-*.jsonl older than `days` (by the date in the name). -> the deleted file names. Never throws.
function cleanOld(dir, { now = new Date(), days = KEEP_DAYS } = {}) {
  const removed = [];
  try {
    const limit = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days).getTime();
    for (const name of fs.readdirSync(dir)) {
      const m = FILE_RE.exec(name);
      if (!m || new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() >= limit) continue;
      try {
        fs.rmSync(path.join(dir, name), { force: true });
        removed.push(name);
      } catch {
        /* locked: next start */
      }
    }
  } catch {
    /* no such directory yet */
  }
  return removed;
}

// A writer for one directory: opens the file of the current day, switches to the next one when the day changes.
function createWriter(dir, { clock = () => new Date() } = {}) {
  let fd = null;
  let openDay = null;
  const close = () => {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    fd = null;
    openDay = null;
  };
  return {
    write(line) {
      try {
        const now = clock();
        const day = dayOf(now);
        if (fd === null || day !== openDay) {
          close();
          fs.mkdirSync(dir, { recursive: true });
          fd = fs.openSync(path.join(dir, fileNameFor(now)), 'a');
          openDay = day;
        }
        fs.writeSync(fd, `${line}\n`);
      } catch {
        close(); // retry with a fresh fd on the next line
      }
    },
    close,
  };
}

// ---------- logger ----------

let sink = null; // tests: fn(line) instead of the disk
let writer = null; // set by init()

// Starts writing to <dir> (and removes files older than 30 days). Safe to call twice.
function init(dir, options) {
  try {
    if (writer) writer.close();
    cleanOld(dir, options);
    writer = createWriter(dir, options);
  } catch {
    writer = null;
  }
}

// Stops writing to disk (tests, shutdown).
function stop() {
  if (writer) writer.close();
  writer = null;
}

// Tests: capture lines (fn(line)) instead of writing; null restores.
function setSink(fn) {
  sink = typeof fn === 'function' ? fn : null;
}

function stringify(obj) {
  try {
    return JSON.stringify(obj, (k, v) => (typeof v === 'bigint' ? String(v) : v));
  } catch {
    return JSON.stringify({ ts: obj.ts, lvl: 'warn', area: obj.area, ev: obj.ev, note: 'unserialisable fields' });
  }
}

// logEvent(area, ev, fields): `err` is serialised and makes the level "error"; fields.lvl overrides ("warn").
function logEvent(area, ev, fields = {}) {
  try {
    if (!sink && !writer) return;
    const { err, lvl, ...rest } = fields || {};
    const entry = { ts: new Date().toISOString(), lvl: lvl || (err !== undefined && err !== null ? 'error' : 'info'), area, ev, ...rest };
    if (err !== undefined && err !== null) entry.err = serializeError(err);
    const line = redact(stringify(entry));
    if (sink) sink(line);
    else writer.write(line);
  } catch {
    /* logging must never break the bot */
  }
}

// Runs the async fn, logs `ms` and ok:true, or ok:false + err (then rethrows).
async function timed(area, ev, fields, fn) {
  if (typeof fields === 'function') {
    fn = fields;
    fields = {};
  }
  const started = Date.now();
  try {
    const result = await fn();
    logEvent(area, ev, { ...fields, ms: Date.now() - started, ok: true });
    return result;
  } catch (err) {
    logEvent(area, ev, { ...fields, ms: Date.now() - started, ok: false, err });
    throw err;
  }
}

// { guild, user } of an interaction, for the business events.
const ixCtx = (interaction) => ({ guild: interaction && interaction.guildId, user: interaction && interaction.user && interaction.user.id });

// ---------- customId -> action ----------

const ID_RE = /^[0-9a-f]{24}$/i;
const ARGS = new Set(['join', 'absent', 'reserve', 'yes', 'maybe', 'no', '-', 'g', 'r', 'in', 'all']); // short enums only; pages, indexes and versions never
// "war:st:<eid>:join" -> { action: "war:st", arg: "join", eid }; "gn:pick:0:abc" -> { action: "gn:pick" }.
function parseCustomId(customId) {
  const parts = String(customId || '').split(':');
  const out = { action: parts.slice(0, 2).join(':') };
  for (const p of parts.slice(2)) {
    if (ID_RE.test(p)) out.eid = out.eid || p;
    else if (ARGS.has(p) && out.arg === undefined) out.arg = p;
  }
  return out;
}

module.exports = { logEvent, timed, init, stop, setSink, redact, serializeError, createWriter, cleanOld, fileNameFor, dayOf, parseCustomId, ixCtx, AREAS, KEEP_DAYS };
