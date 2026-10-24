// Hardening of the Windows packaging: listen-before-DB order, log dir
// resolution, and static assertions on the installer + PowerShell files (the installer itself is never run by tests).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { ensureRealDir, logDir } = require('../src/paths');
const { listen } = require('../src/listen');
const { generatePassword, resolvePassword, PASSWORD_ALPHABET } = require('../packaging/build');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const silent = { log() {}, warn() {}, error() {} };
const NOW = Date.parse('2026-10-09T00:00:00Z');
const DAY = 86400000;
const ENV = { ATLAS_PUBLIC_KEY: 'pubkey', ATLAS_PRIVATE_KEY: 'privkey', ATLAS_PROJECT_ID: 'proj1' };
const json = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] || null }, json: async () => body, text: async () => String(body) });

// Mock Atlas with a stateful list. applyPost=false simulates a POST that is accepted but does not change the entry.
function atlas(list, { applyPost = true } = {}) {
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    calls.push({ url, ...opts });
    if (url.includes('ipify')) return json(200, '1.2.3.4');
    if (!opts.headers.Authorization) return json(401, {}, { 'www-authenticate': 'Digest realm="r", nonce="abc", qop="auth"' });
    if (opts.method === 'GET') return json(200, { results: list });
    if (applyPost) for (const e of JSON.parse(opts.body)) { const i = list.findIndex((x) => x.ipAddress === e.ipAddress); if (i >= 0) list[i] = e; else list.push(e); }
    return json(200, {});
  };
  fetchFn.calls = calls;
  return fetchFn;
}

describe('app.js start order (M3, L2, L5)', () => {
  const app = read('app.js');

  it('listen() resolves when bound to 127.0.0.1 and rejects with EADDRINUSE', async () => {
    const server = await listen((req, res) => res.end('ok'), 0, '127.0.0.1');
    assert.equal(server.address().address, '127.0.0.1');
    await assert.rejects(listen((req, res) => res.end(), server.address().port, '127.0.0.1'), (e) => e.code === 'EADDRINUSE');
    await new Promise((r) => server.close(r));
  });

  it('takes the port before the DB connect and the schema check; EADDRINUSE exits 0', () => {
    const main = app.slice(app.indexOf('async function main'));
    const iListen = main.indexOf('await listen(');
    assert.ok(iListen > 0);
    for (const later of ['connectWithRetry({', 'db.ensureSchema()']) assert.ok(main.indexOf(later) > iListen, later);
    assert.match(app, /EADDRINUSE[\s\S]{0,700}another instance is running[\s\S]{0,60}process\.exit\(0\)/);
    assert.match(app, /process\.env\.BIND_HOST \|\| '127\.0\.0\.1'/);
    assert.doesNotMatch(app, /mongoose|atlas/i, 'the bot no longer touches MongoDB / Atlas');
    assert.doesNotMatch(app, /pm2/i);
  });
});

describe('log dir and fonts fallback (H1, L3)', () => {
  it('--log-dir beats LONGLINH_LOG_DIR; unpackaged default is <repo>/logs', () => {
    assert.equal(logDir({ argv: ['node', 'x', '--log-dir=D:\\L'], env: { LONGLINH_LOG_DIR: 'E:\\o' } }), 'D:\\L');
    assert.equal(logDir({ argv: [], env: { LONGLINH_LOG_DIR: 'E:\\o' } }), 'E:\\o');
    assert.equal(logDir({ argv: [], env: {} }), path.join(root, 'logs'));
  });

  it('packaged default is %ProgramData%\\LongLinh\\logs and app.js no longer logs under the install dir', () => {
    assert.match(read('src', 'paths.js'), /env\.ProgramData \|\| 'C:\\\\ProgramData', 'LongLinh', 'logs'/);
    assert.match(read('app.js'), /installFileLogging\(logDir\(\), \{ monitorOnly: !isPackaged\(\) \}\)/); // also when not packaged: observe-only fatal handlers
    assert.doesNotMatch(read('app.js'), /appRoot\(\), 'logs'/);
  });

  it('font fallback uses a fresh mkdtemp dir, not a predictable os.tmpdir path', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'll-fb-'));
    const src = path.join(tmp, 'src');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'a.ttf'), 'x');
    fs.writeFileSync(path.join(tmp, 'blocker'), 'file'); // mkdir below a file fails -> fallback
    const out = ensureRealDir(src, path.join(tmp, 'blocker', 'dst'), ['a.ttf']);
    assert.match(path.basename(out), /^longlinh-assets-.{6}$/);
    assert.ok(fs.existsSync(path.join(out, 'a.ttf')));
    assert.doesNotMatch(read('src', 'paths.js'), /'longlinh-assets', path\.basename/);
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('installer hardening: static checks of packaging files', () => {
  const iss = read('packaging', 'longlinh.iss');
  const ps = read('packaging', 'install-task.ps1');

  it('installs into Program Files, nothing writable by normal users (C1)', () => {
    assert.match(iss, /^DefaultDirName=\{autopf\}\\LongLinh$/m);
    assert.doesNotMatch(iss, /users-modify/i);
    assert.doesNotMatch(iss, /C:\\LongLinh/);
    assert.match(iss, /^UsePreviousAppDir=no$/m);
    assert.doesNotMatch(iss, /^\[Dirs\]/m);
    assert.doesNotMatch(iss, /^\[Run\]/m); // every PowerShell/icacls call is a checked Exec
  });

  it('ACL steps: install dir, ProgramData log dir, .env; abort when icacls fails (H1/H2/M1)', () => {
    assert.match(iss, /\{commonappdata\}\\LongLinh/);
    assert.match(iss, /logDir := dataDir \+ '\\logs'/);
    assert.match(iss, /SID_LOCALSERVICE = '\*S-1-5-19'/);
    assert.match(iss, /\/inheritance:r \/grant:r/);
    assert.match(iss, /SID_LOCALSERVICE \+ ':\(OI\)\(CI\)M '/); // logs: LocalService modify
    assert.match(iss, /SID_USERS \+ ':\(OI\)\(CI\)RX', 'ACL log dir'/); // logs: Users read/execute
    assert.match(iss, /SID_ADMINS \+ ':F ' \+ SID_SYSTEM \+ ':F ' \+ SID_LOCALSERVICE \+ ':R( \/L)?'/); // .env
    assert.match(iss, /function PrepareToInstall[\s\S]*Result := FailInstall\('Không đặt được quyền/); // aborts before files are copied
    assert.match(iss, /DeleteFile\(envFile\);\s*PostInstallFailed := True;\s*RaiseException/);
    assert.ok(iss.indexOf("'ACL install dir'") < iss.indexOf("'ACL log dir'"));
    assert.ok(iss.indexOf("'ACL .env'") < iss.indexOf("'scheduled task'"));
    assert.ok(iss.indexOf('function PrepareToInstall') < iss.indexOf('procedure CurStepChanged'));
  });

  it('upgrade: Disable before Stop before taskkill, task re-registered after the copy (M2)', () => {
    const prep = iss.slice(iss.indexOf('function PrepareToInstall'), iss.indexOf('procedure CurStepChanged'));
    assert.ok(prep.indexOf('Disable-ScheduledTask') > 0);
    assert.ok(prep.indexOf('Disable-ScheduledTask') < prep.indexOf('Stop-ScheduledTask'));
    assert.ok(prep.indexOf('Stop-ScheduledTask') < prep.indexOf('taskkill'));
    assert.match(ps, /Disable-ScheduledTask[\s\S]*Stop-ScheduledTask[\s\S]*Unregister-ScheduledTask/);
    assert.match(iss, /procedure CurStepChanged[\s\S]*ssPostInstall[\s\S]*install-task\.ps1/);
  });

  it('encrypted with a build-time password, never printed (H3)', () => {
    assert.match(iss, /^Encryption=yes$/m);
    assert.match(iss, /^Password=\{#InstallerPassword\}$/m);
    assert.match(iss, /#error InstallerPassword/);
    const build = read('packaging', 'build.js');
    assert.doesNotMatch(build, /DInstallerPassword/); // the password is never a command-line define
    assert.match(build, /LL_INSTALLER_PW/);
    assert.match(build, /INSTALLER-PASSWORD\.txt/);
    assert.doesNotMatch(build, /console\.log\([^\n]*\$\{password\}/);
    assert.match(read('.gitignore'), /INSTALLER-PASSWORD\.txt/);
  });

  it('password generator: 16 letters+digits, no look-alikes; env password validated', () => {
    assert.match(generatePassword(), /^[A-Za-z0-9]{16}$/);
    assert.doesNotMatch(PASSWORD_ALPHABET, /[0OIl1]/);
    assert.notEqual(generatePassword(), generatePassword());
    assert.deepEqual(resolvePassword({ INSTALLER_PASSWORD: 'Abcdefgh12345678' }), { password: 'Abcdefgh12345678', generated: false });
    assert.equal(resolvePassword({}).generated, true);
    assert.throws(() => resolvePassword({ INSTALLER_PASSWORD: 'bad pass"word' }));
  });

  it('task runs as LocalService, Limited; uninstall removes it and asks about the logs (H2, L1, L7)', () => {
    assert.match(ps, /-UserId 'NT AUTHORITY\\LOCALSERVICE' -LogonType ServiceAccount -RunLevel Limited/);
    assert.doesNotMatch(ps, /Highest|'SYSTEM'/);
    assert.doesNotMatch(ps, /restart on failure every 1 min/); // stale comment
    assert.match(ps, /5-minute repeating trigger is the real watchdog/);
    assert.match(iss, /' -Remove( -LogFile '|')/);
    assert.match(iss, /usPostUninstall[\s\S]*MsgBox\([\s\S]*-Mode Purge/);
    assert.match(iss, /not UninstallSilent/);
  });

  it('status script reads the ProgramData log and uses 127.0.0.1 (H1, L5)', () => {
    const st = read('packaging', 'status.ps1');
    assert.match(st, /\$env:ProgramData 'LongLinh\\logs\\longlinh\.log'/);
    assert.match(st, /127\.0\.0\.1/);
    assert.doesNotMatch(st, /Join-Path \$dir 'logs/);
  });

  it('HUONG-DAN: password via another channel, no chat suggestion, secrets warning (H3)', () => {
    const t = read('packaging', 'HUONG-DAN.txt');
    assert.doesNotMatch(t, /Zalo/i);
    assert.match(t, /kênh KHÁC/);
    assert.match(t, /BẢO MẬT/);
    assert.match(t, /C:\\ProgramData\\LongLinh\\logs/);
    assert.doesNotMatch(t, /C:\\LongLinh/);
  });
});
