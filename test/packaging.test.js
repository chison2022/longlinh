const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { connectWithRetry } = require('../src/dbRetry');
const { pingOnce } = require('../src/healthPing');
const { runSelftest } = require('../src/selftest');
const { ensureRealDir } = require('../src/paths');

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const silent = { log() {}, warn() {}, error() {} };
const NOW = Date.parse('2026-10-09T00:00:00Z');
const DAY = 86400000;
const ENV = { ATLAS_PUBLIC_KEY: 'pubkey', ATLAS_PRIVATE_KEY: 'privkey', ATLAS_PROJECT_ID: 'proj1' };

const json = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] || null }, json: async () => body, text: async () => String(body) });

// Mock Atlas: first call without Authorization gets a Digest challenge, then data. `list` = current access list.
function mockFetch(list, { ip = '1.2.3.4', postStatus = 200 } = {}) {
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    calls.push({ url, ...opts });
    if (url.includes('ipify')) return json(200, ip);
    if (url.includes('ifconfig.me')) return json(200, ip);
    if (!opts.headers.Authorization) return json(401, {}, { 'www-authenticate': 'Digest realm="MMS Public API", nonce="abc123", qop="auth", algorithm=MD5' });
    if (opts.method === 'GET') return json(200, { results: list });
    if (postStatus === 200) for (const e of JSON.parse(opts.body)) { const i = list.findIndex((x) => x.ipAddress === e.ipAddress); if (i >= 0) list[i] = e; else list.push(e); } // Atlas applies the write
    return json(postStatus, postStatus === 200 ? {} : { errorCode: 'BAD' });
  };
  fetchFn.calls = calls;
  return fetchFn;
}
const posts = (f) => f.calls.filter((c) => c.method === 'POST' && c.headers.Authorization);

describe('connectWithRetry', () => {
  it('retries with growing delays, runs beforeRetry each time, and returns on success', async () => {
    let n = 0;
    const sleeps = [];
    let before = 0;
    const r = await connectWithRetry({
      connect: async () => { if (++n < 4) throw new Error('timeout'); return 'ok'; },
      beforeRetry: async () => { before++; },
      sleep: async (ms) => sleeps.push(ms),
      log: silent,
    });
    assert.equal(r, 'ok');
    assert.deepEqual(sleeps, [15000, 30000, 60000]);
    assert.equal(before, 3);
  });

  it('caps the delay at 5 minutes', async () => {
    let n = 0;
    const sleeps = [];
    await connectWithRetry({ connect: async () => { if (++n < 9) throw new Error('x'); }, sleep: async (ms) => sleeps.push(ms), log: silent });
    assert.equal(Math.max(...sleeps), 300000);
  });

  it('fails at once when DB_URL is missing and honours maxAttempts', async () => {
    let n = 0;
    await assert.rejects(connectWithRetry({ connect: async () => { n++; throw new Error('DB_URL is missing in .env'); }, sleep: async () => {}, log: silent }), /DB_URL/);
    assert.equal(n, 1);
    await assert.rejects(connectWithRetry({ connect: async () => { throw new Error('nope'); }, sleep: async () => {}, log: silent, maxAttempts: 2 }), /nope/);
  });
});

describe('healthPing', () => {
  it('pings only while healthy', async () => {
    const urls = [];
    const fetchFn = async (u) => { urls.push(u); return { ok: true }; };
    assert.equal(await pingOnce({ url: 'https://hc/x', isHealthy: () => false, fetchFn, log: silent }), false);
    assert.equal(await pingOnce({ url: 'https://hc/x', isHealthy: () => true, fetchFn, log: silent }), true);
    assert.deepEqual(urls, ['https://hc/x']);
    assert.equal(await pingOnce({ url: 'https://hc/x', isHealthy: () => true, fetchFn: async () => { throw new Error('x'); }, log: silent }), false);
  });
});

describe('selftest', () => {
  const deps = (over = {}) => ({ env: { PG_URL: 'x', PG_CA: 'y' }, connectDb: async () => {}, disconnect: async () => {}, pingDb: async () => {}, ...over });

  it('renders a real PNG (canvas + fonts) and passes without touching Discord', async () => {
    const { ok, lines } = await runSelftest(deps());
    assert.equal(ok, true, lines.join('\n'));
    assert.ok(lines.some((l) => /^PASS canvas\+fonts: PNG \d+ bytes/.test(l)));
    assert.equal(lines.at(-1), 'SELFTEST PASS');
  });

  it('fails when PG_URL / PG_CA is missing, the DB ping fails, or rendering fails', async () => {
    assert.equal((await runSelftest(deps({ env: {} }))).ok, false);
    assert.equal((await runSelftest(deps({ env: { PG_URL: 'x' } }))).ok, false);
    const disconnected = [];
    const r = await runSelftest(deps({ pingDb: async () => { throw new Error('boom'); }, disconnect: async () => disconnected.push(1) }));
    assert.equal(r.ok, false);
    assert.equal(disconnected.length, 1);
    assert.equal((await runSelftest(deps({ renderPng: async () => { throw new Error('no font'); } }))).ok, false);
  });
});

describe('paths.ensureRealDir', () => {
  it('copies snapshot files to the wanted dir when missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'll-paths-'));
    const src = path.join(tmp, 'src');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'a.ttf'), 'x');
    const out = ensureRealDir(src, path.join(tmp, 'dst'), ['a.ttf']);
    assert.equal(out, path.join(tmp, 'dst'));
    assert.ok(fs.existsSync(path.join(out, 'a.ttf')));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('logFile redaction', () => {
  it('every human-log line is redacted before it is written (a MongoDB URI with a password never reaches the disk)', () => {
    const { createRotatingLog } = require('../src/logFile');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'll-log-'));
    const log = createRotatingLog(dir);
    log.write('2026-10-14T00:00:00.000Z ERROR connect failed mongodb+srv://bot:s3cret-pass@cluster0.example.mongodb.net/db');
    log.write('Bearer abcdef.123456 in a header');
    log.write('ERROR connect failed postgres://avnadmin:pg-s3cret@pg-x.aivencloud.com:12345/defaultdb');
    const text = fs.readFileSync(path.join(dir, 'longlinh.log'), 'utf8');
    assert.ok(!text.includes('s3cret-pass') && !text.includes('abcdef.123456') && !text.includes('pg-s3cret'));
    assert.match(text, /postgres:\/\/<redacted>@pg-x/);
    assert.match(text, /mongodb\+srv:\/\/<redacted>@cluster0/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('logFile rotation', () => {
  it('rotates at the size limit and keeps at most `keep` files', () => {
    const { createRotatingLog } = require('../src/logFile');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'll-log-'));
    const log = createRotatingLog(dir, { maxBytes: 100, keep: 3 });
    for (let i = 0; i < 20; i++) log.write(`line ${i} ${'x'.repeat(30)}`);
    const files = fs.readdirSync(dir).sort();
    assert.deepEqual(files, ['longlinh.1.log', 'longlinh.2.log', 'longlinh.log']);
    assert.ok(fs.statSync(path.join(dir, 'longlinh.log')).size <= 100);
    assert.match(fs.readFileSync(path.join(dir, 'longlinh.log'), 'utf8'), /line 19/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
