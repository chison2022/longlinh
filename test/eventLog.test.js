// Structured event log: redaction, error serialisation, file naming / day rollover, the 30-day cleanup, customId parsing, the router line.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eventLog = require('../src/eventLog');
const { logEvent, timed, redact, serializeError, parseCustomId, createWriter, cleanOld, fileNameFor } = eventLog;

let lines;
beforeEach(() => {
  lines = [];
  eventLog.setSink((l) => lines.push(l));
});
afterEach(() => eventLog.setSink(null));
const last = () => JSON.parse(lines[lines.length - 1]);

describe('redact', () => {
  it('blanks mongodb credentials', () => {
    const out = redact('connect mongodb+srv://bot:s3cr3t%21@cluster0.abc.mongodb.net/db failed; mongodb://u:p@h:27017/x');
    assert.doesNotMatch(out, /s3cr3t|bot:|u:p/);
    assert.match(out, /mongodb\+srv:\/\/<redacted>@cluster0/);
    assert.match(out, /mongodb:\/\/<redacted>@h:27017/);
  });
  it('blanks a Discord bot token', () => {
    const token = ['MTIzNDU2Nzg5MDEyMzQ1Njc4OQ', 'GabcDe', 'abcdefghijklmnopqrstuvwxyz0'].join('.');
    const out = redact(`login with ${token} rejected`);
    assert.doesNotMatch(out, /MTIzNDU2/);
    assert.match(out, /<token>/);
  });
  it('keeps ordinary dotted text', () => {
    assert.equal(redact('thanh-vien-bang.2026.xlsx and war:st.join'), 'thanh-vien-bang.2026.xlsx and war:st.join');
  });
  it('blanks Bearer values', () => {
    const out = redact('Authorization failed: Bearer ya29.a0AfH6SMBxyz-abc_123 end');
    assert.doesNotMatch(out, /ya29/);
    assert.match(out, /Bearer <redacted> end/);
  });
  it('blanks the private_key block, as a JSON field and as a bare PEM', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\nabc\\n-----END PRIVATE KEY-----\\n';
    const json = redact(`{"client_email":"a@b.iam","private_key":"${pem}"}`);
    assert.doesNotMatch(json, /MIIEvQ/);
    assert.match(json, /"private_key":"<redacted>"/);
    const bare = redact(`key was ${pem} and more`);
    assert.doesNotMatch(bare, /MIIEvQ/);
    assert.match(bare, /<private key>/);
  });
  it('is applied to the finished line, whatever field the secret is in', () => {
    logEvent('db', 'connect_failed', { err: new Error('bad auth for mongodb+srv://user:hunter2@host/db'), detail: 'Bearer abc.def' });
    assert.doesNotMatch(lines[0], /hunter2|abc\.def/);
  });
});

describe('serializeError', () => {
  it('keeps msg, code, status, name and only 6 stack lines', () => {
    const err = Object.assign(new Error('Unknown interaction'), { code: 10062, status: 404, name: 'DiscordAPIError[10062]' });
    err.stack = ['Error: Unknown interaction', ...Array.from({ length: 12 }, (_, i) => `    at fn${i} (file.js:${i}:1)`)].join('\n');
    const out = serializeError(err);
    assert.equal(out.msg, 'Unknown interaction');
    assert.equal(out.code, 10062);
    assert.equal(out.status, 404);
    assert.equal(out.name, 'DiscordAPIError[10062]');
    assert.equal(out.stack.split('\n').length, 6);
  });
  it('copes with non-errors', () => {
    assert.deepEqual(serializeError('boom'), { msg: 'boom' });
    assert.deepEqual(serializeError(null), { msg: 'null' });
  });
  it('is reachable as the err field, which also sets the level to error', () => {
    logEvent('ix', 'done', { err: Object.assign(new Error('x'), { code: 50013 }) });
    assert.equal(last().lvl, 'error');
    assert.equal(last().err.code, 50013);
    logEvent('ix', 'done', {});
    assert.equal(last().lvl, 'info');
    logEvent('sheet', 'sync', { lvl: 'warn' });
    assert.equal(last().lvl, 'warn');
  });
  it('writes ts, area, ev and the fields, one JSON object per line', () => {
    logEvent('war', 'register', { eid: 'abc', status: 'join' });
    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines[0], /\n/);
    const e = last();
    assert.match(e.ts, /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual([e.area, e.ev, e.eid, e.status], ['war', 'register', 'abc', 'join']);
  });
  it('never throws, even for circular fields or a throwing sink', () => {
    const a = {};
    a.self = a;
    assert.doesNotThrow(() => logEvent('war', 'x', { a }));
    eventLog.setSink(() => {
      throw new Error('disk');
    });
    assert.doesNotThrow(() => logEvent('war', 'x', {}));
  });
});

describe('timed', () => {
  it('logs ms and ok:true, returning the result', async () => {
    assert.equal(await timed('refresh', 'x', { eid: 'e' }, async () => 7), 7);
    const e = last();
    assert.equal(e.ok, true);
    assert.equal(e.eid, 'e');
    assert.equal(typeof e.ms, 'number');
  });
  it('logs ok:false with err and rethrows', async () => {
    await assert.rejects(timed('refresh', 'x', {}, async () => Promise.reject(Object.assign(new Error('nope'), { code: 10003 }))), /nope/);
    const e = last();
    assert.equal(e.ok, false);
    assert.equal(e.lvl, 'error');
    assert.equal(e.err.code, 10003);
  });
});

describe('files', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'll-events-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('names the file by the LOCAL date', () => {
    assert.equal(fileNameFor(new Date(2026, 9, 11, 0, 5)), 'events-2026-10-11.jsonl');
    assert.equal(fileNameFor(new Date(2026, 0, 2, 23, 59)), 'events-2026-01-02.jsonl');
  });

  it('opens a new file when the day changes', () => {
    let now = new Date(2026, 9, 11, 23, 59, 50);
    const w = createWriter(dir, { clock: () => now });
    w.write('{"a":1}');
    now = new Date(2026, 9, 12, 0, 0, 5);
    w.write('{"a":2}');
    w.write('{"a":3}');
    w.close();
    assert.deepEqual(fs.readdirSync(dir).sort(), ['events-2026-10-11.jsonl', 'events-2026-10-12.jsonl']);
    assert.equal(fs.readFileSync(path.join(dir, 'events-2026-10-11.jsonl'), 'utf8'), '{"a":1}\n');
    assert.equal(fs.readFileSync(path.join(dir, 'events-2026-10-12.jsonl'), 'utf8'), '{"a":2}\n{"a":3}\n');
  });

  it('creates the directory and never throws on an unusable one', () => {
    const w = createWriter(path.join(dir, 'a', 'b'));
    w.write('{"x":1}');
    w.close();
    assert.equal(fs.readdirSync(path.join(dir, 'a', 'b')).length, 1);
    const blocked = createWriter(path.join(dir, 'a', 'b', fs.readdirSync(path.join(dir, 'a', 'b'))[0], 'sub')); // under a FILE
    assert.doesNotThrow(() => blocked.write('{}'));
  });

  it('init() deletes events-*.jsonl older than 30 days and nothing else', () => {
    const now = new Date(2026, 9, 11, 12);
    const keep = ['events-2026-10-11.jsonl', 'events-2026-09-11.jsonl', 'longlinh.log', 'events-notes.txt'];
    const drop = ['events-2026-09-10.jsonl', 'events-2025-01-01.jsonl'];
    for (const n of [...keep, ...drop]) fs.writeFileSync(path.join(dir, n), 'x');
    const removed = cleanOld(dir, { now });
    assert.deepEqual(removed.sort(), drop.sort());
    assert.deepEqual(fs.readdirSync(dir).sort(), keep.sort());
  });

  it('init() writes events to disk and cleans on start', () => {
    fs.writeFileSync(path.join(dir, 'events-2020-01-01.jsonl'), 'old');
    eventLog.setSink(null);
    eventLog.init(dir);
    logEvent('boot', 'start', { pid: 1 });
    const files = fs.readdirSync(dir);
    assert.ok(!files.includes('events-2020-01-01.jsonl'));
    const today = files.find((f) => /^events-\d{4}-\d\d-\d\d\.jsonl$/.test(f));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, today), 'utf8').trim()).ev, 'start');
    eventLog.stop(); // closes the fd (Windows can then delete the temp dir); logEvent is a no-op again
  });
});

describe('parseCustomId', () => {
  const eid = '65f1a2b3c4d5e6f708192a3b';
  it('prefix + action only, eid and the short enum arg split out', () => {
    assert.deepEqual(parseCustomId(`war:st:${eid}:join`), { action: 'war:st', eid, arg: 'join' });
    assert.deepEqual(parseCustomId(`war:st:${eid}:absent`), { action: 'war:st', eid, arg: 'absent' });
    assert.deepEqual(parseCustomId(`war:cls:${eid}:-`), { action: 'war:cls', eid, arg: '-' });
    assert.deepEqual(parseCustomId(`adm:unregok:${eid}:g`), { action: 'adm:unregok', eid, arg: 'g' });
    assert.deepEqual(parseCustomId('adm:unreg:r'), { action: 'adm:unreg', arg: 'r' });
    assert.deepEqual(parseCustomId(`tm:pubok:${eid}`), { action: 'tm:pubok', eid });
  });
  it('never puts pages, indexes or roster versions in the log', () => {
    assert.deepEqual(parseCustomId('gn:pick:2:9f8e7d6c'), { action: 'gn:pick' });
    assert.deepEqual(parseCustomId('adm:gmapm:3:1:abc123'), { action: 'adm:gmapm' });
    assert.deepEqual(parseCustomId('setup:announce'), { action: 'setup:announce' });
    assert.deepEqual(parseCustomId('gn:open'), { action: 'gn:open' });
  });
});

describe('router ix.done', () => {
  const { routeInteraction } = require('../src/bot/interactions/router');
  const make = (extra) => ({
    inGuild: () => true,
    isChatInputCommand: () => false,
    isMessageComponent: () => true,
    isModalSubmit: () => false,
    isButton: () => true,
    isRepliable: () => true,
    guildId: '111111111111111111',
    user: { id: '222222222222222222' },
    deferred: false,
    replied: false,
    async reply() {
      this.replied = true;
    },
    async followUp() {},
    ...extra,
  });
  const silence = async (fn) => {
    const original = console.error;
    console.error = () => {};
    try {
      return await fn();
    } finally {
      console.error = original;
    }
  };

  it('logs one ok line for a handled click', async () => {
    await routeInteraction(make({ customId: 'zzz:unknown' })); // no handler: nothing happens, still one line
    assert.equal(lines.length, 1);
    const e = last();
    assert.deepEqual([e.area, e.ev, e.kind, e.action, e.outcome, e.guild, e.user], ['ix', 'done', 'button', 'zzz:unknown', 'ok', '111111111111111111', '222222222222222222']);
    assert.equal(e.slow, undefined);
    assert.equal(typeof e.ms, 'number');
  });

  it('logs the Discord error code of a failing handler (10062 = answered too late)', async () => {
    const eid = '65f1a2b3c4d5e6f708192a3b';
    const interaction = make({
      customId: `tm:pubno:${eid}`,
      async deferUpdate() {
        throw Object.assign(new Error('Unknown interaction'), { code: 10062, status: 404 });
      },
    });
    await silence(() => routeInteraction(interaction));
    assert.equal(lines.length, 1);
    const e = last();
    assert.equal(e.outcome, 'error');
    assert.equal(e.err.code, 10062);
    assert.equal(e.action, 'tm:pubno');
    assert.equal(e.eid, eid);
    assert.equal(e.lvl, 'error');
  });

  it('names a slash command', async () => {
    await routeInteraction(make({ isChatInputCommand: () => true, isButton: () => false, commandName: 'nonexistent' }));
    assert.equal(last().kind, 'command');
    assert.equal(last().action, 'cmd:nonexistent');
  });
});
