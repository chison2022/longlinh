// Third hardening round of the Windows packaging. The installer / .wsb are never run by tests.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { isccCandidates, pkgEnv, renderWsb, xmlEscape, assertWsbEnvSafe, parseArgs } = require('../packaging/build');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const iss = read('packaging', 'longlinh.iss');
const prep = iss.slice(iss.indexOf('function PrepareToInstall'), iss.indexOf('procedure CurStepChanged'));

describe('MEDIUM-A: icacls /L and the second guard check', () => {
  const lock = iss.slice(iss.indexOf('function LockDir'), iss.indexOf('var\n  BotStopped'));
  it('every icacls call in LockDir has /L', () => {
    const calls = lock.match(/Icacls\(AddQuotes[^\n]*/g);
    assert.equal(calls.length, 3);
    for (const c of calls) assert.match(c, / \/L'/, c);
  });
  it('every other Icacls call in the script also has /L', () => {
    const calls = iss.match(/\bIcacls\(AddQuotes[^\n]*/g);
    assert.ok(calls.length >= 5);
    for (const c of calls) assert.match(c, / \/L'/, c);
  });
  it('guard Check runs again after ForceDirectories(dataDir) and before LockDir(dataDir)', () => {
    const iMk = prep.indexOf('ForceDirectories(dataDir)');
    const iChk = prep.indexOf("GuardRc(dataDir, '-Mode Check')", iMk);
    const iLock = prep.indexOf('LockDir(dataDir');
    assert.ok(iMk > 0 && iMk < iChk && iChk < iLock);
  });
  it('checklist has the race step', () => {
    assert.match(read('packaging', 'sandbox', 'CHECKLIST.md'), /Test D \(race/);
  });
});

describe('MEDIUM-B: legacy C:\LongLinh is never deleted', () => {
  const f = iss.slice(iss.indexOf('procedure RemoveLegacyInstall'), iss.indexOf('function PrepareToInstall'));
  it('no deletion of any kind in the legacy routine or anywhere else for {sd}', () => {
    assert.doesNotMatch(f, /DeleteFile|DelTree|DeleteKnown|Purge|Remove-Item|Delete\(/);
    assert.doesNotMatch(iss, /DeleteKnown/);
    assert.match(f, /thủ công/); // the admin removes it by hand
  });
  it('dir-guard no longer has DeleteKnown / Names', () => {
    const g = read('packaging', 'dir-guard.ps1');
    assert.doesNotMatch(g, /DeleteKnown|\$Names/);
    assert.match(g, /ValidateSet\('Check', 'Purge'\)/);
  });
  it('checklist section 14 says nothing is deleted', () => {
    const c = read('packaging', 'sandbox', 'CHECKLIST.md');
    const sec = c.slice(c.indexOf('## 14.'));
    assert.match(sec, /NOTHING is deleted/);
    assert.doesNotMatch(sec, /ONLY `\.env` and `LongLinh\.exe` were deleted/);
  });
});

describe('LOW-A: ISCC candidates are absolute', () => {
  it('every candidate is absolute, with and without env overrides', () => {
    const envs = [{}, { ISCC: 'relative\\ISCC.exe', LOCALAPPDATA: 'rel', ProgramFiles: 'rel' },
      { ISCC: 'C:\\x\\ISCC.exe', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local', 'ProgramFiles(x86)': 'D:\\PF86', ProgramFiles: 'D:\\PF' }, process.env];
    for (const env of envs) {
      const c = isccCandidates(env);
      assert.ok(c.length >= 1);
      for (const x of c) assert.ok(path.isAbsolute(x), x);
    }
    const c = isccCandidates({});
    assert.ok(c.includes(path.join('C:\\Program Files (x86)', 'Inno Setup 6', 'ISCC.exe')));
    assert.ok(c.includes(path.join('C:\\Program Files', 'Inno Setup 6', 'ISCC.exe')));
  });
});

describe('LOW-B / INFO-3: install-task.ps1', () => {
  const ps = read('packaging', 'install-task.ps1');
  it('does not log into ProgramData; takes -LogFile; installer passes a {tmp} file', () => {
    assert.doesNotMatch(ps, /Join-Path \$env:ProgramData/);
    assert.match(ps, /\[string\]\$LogFile/);
    assert.match(iss, /-LogFile ' \+ AddQuotes\(ExpandConstant\('\{tmp\}\\install-task\.log'\)\)/);
    assert.match(iss, /-Remove -LogFile ' \+ AddQuotes\(ExpandConstant\('\{tmp\}\\/);
  });
  it('fails when Repetition.Duration is not empty', () => {
    assert.match(ps, /if \(\$rep\.Repetition\.Duration\) \{[^\n]*exit 1/);
    assert.ok(ps.indexOf('if ($rep.Repetition.Duration)') < ps.indexOf('Start-ScheduledTask -TaskName $name'));
  });
});

describe('INFO-5: pkg child gets a minimal env', () => {
  it('drops the installer password and unknown variables, keeps PATH', () => {
    const e = pkgEnv({ PATH: 'p', INSTALLER_PASSWORD: 'x', LL_INSTALLER_PW: 'y', DISCORD_TOKEN: 't', TEMP: 't', USERPROFILE: 'u' });
    assert.ok(!('INSTALLER_PASSWORD' in e) && !('LL_INSTALLER_PW' in e) && !('DISCORD_TOKEN' in e));
    assert.equal(e.TEMP, 't');
    assert.equal(e.PATH, 'p');
  });
  it('allow-list has NODE_EXTRA_CA_CERTS, npm_config_* (prefix), USERNAME, ALLUSERSPROFILE', () => {
    const e = pkgEnv({ NODE_EXTRA_CA_CERTS: 'c', npm_config_registry: 'r', NPM_CONFIG_CACHE: 'k', USERNAME: 'u', ALLUSERSPROFILE: 'a', npm_token: 'secret', NPM_CONFIG: 'x' });
    assert.equal(e.NODE_EXTRA_CA_CERTS, 'c');
    assert.equal(e.npm_config_registry, 'r');
    assert.equal(e.NPM_CONFIG_CACHE, 'k');
    assert.equal(e.USERNAME, 'u');
    assert.equal(e.ALLUSERSPROFILE, 'a');
    assert.ok(!('npm_token' in e) && !('NPM_CONFIG' in e));
  });
  it('build.js passes pkgEnv() to the npx pkg call', () => {
    assert.match(read('packaging', 'build.js'), /shell: true, env: pkgEnv\(\)/);
  });
});

describe('sandbox .wsb', () => {
  const wsb = read('packaging', 'sandbox', 'LongLinh-test.wsb');
  it('locks down redirections and uses a placeholder host folder', () => {
    for (const k of ['Networking', 'ClipboardRedirection', 'PrinterRedirection', 'AudioInput', 'VideoInput']) assert.match(wsb, new RegExp(`<${k}>Disable</${k}>`), k);
    assert.match(wsb, /<ProtectedClient>Enable<\/ProtectedClient>/);
    assert.match(wsb, /<HostFolder>@@HOST_FOLDER@@<\/HostFolder>/);
    assert.doesNotMatch(wsb, /scratchpad|Users\\ADMIN/i);
  });
  it('the XML comment contains no double hyphen (invalid XML)', () => {
    const c = wsb.slice(wsb.indexOf('<!--') + 4, wsb.indexOf('-->'));
    assert.ok(!c.includes('--'));
  });
  it('renderWsb substitutes the out dir; --wsb is parsed and off by default', () => {
    const out = renderWsb(wsb, 'C:\\out dir\\x');
    assert.match(out, /<HostFolder>C:\\out dir\\x<\/HostFolder>/);
    assert.ok(!out.includes('@@HOST_FOLDER@@'));
    assert.equal(parseArgs([]).wsb, false);
    assert.equal(parseArgs(['--wsb']).wsb, true);
  });
  it('renderWsb XML-escapes the five special characters in the path', () => {
    assert.equal(xmlEscape(`a&b<c>d"e'f`), 'a&amp;b&lt;c&gt;d&quot;e&apos;f');
    const out = renderWsb(wsb, `C:\\R&D <x> "q" 'z'`);
    assert.match(out, /<HostFolder>C:\\R&amp;D &lt;x&gt; &quot;q&quot; &apos;z&apos;<\/HostFolder>/);
  });
  it('--wsb is refused when --env is the repo .env (any case / relative spelling), allowed for others', () => {
    assert.throws(() => assertWsbEnvSafe(path.join(root, '.env')), /repo \.env/);
    assert.throws(() => assertWsbEnvSafe(path.join(root, 'packaging', '..', '.ENV')), /repo \.env/);
    assert.doesNotThrow(() => assertWsbEnvSafe(path.join(root, 'sbx-dummy.env')));
    const b = read('packaging', 'build.js');
    assert.ok(b.indexOf('if (wsb) assertWsbEnvSafe(envFile)') > 0 && b.indexOf('if (wsb) assertWsbEnvSafe(envFile)') < b.indexOf('fs.mkdirSync(out'));
  });
  it('comment and checklist name the real password file (INSTALLER-PASSWORD.txt), not TEST-PASSWORD', () => {
    const c = read('packaging', 'sandbox', 'CHECKLIST.md');
    assert.match(wsb, /INSTALLER-PASSWORD\.txt/);
    assert.match(c, /INSTALLER-PASSWORD\.txt/);
    assert.doesNotMatch(wsb + c, /TEST-PASSWORD/);
  });
});

describe('installer logs the helper script output into the Inno log', () => {
  it('install-task.log and the -Remove log are read with LoadStringsFromFile and Log()ged line by line', () => {
    assert.match(iss, /procedure LogFileLines[\s\S]*LoadStringsFromFile\(FileName, lines\)[\s\S]*Log\(What \+ ': ' \+ lines\[k\]\)/);
    assert.match(iss, /LogFileLines\(ExpandConstant\('\{tmp\}\\install-task\.log'\), 'install-task'\)/);
    assert.match(iss, /LogFileLines\(ExpandConstant\('\{tmp\}\\install-task-remove\.log'\), 'install-task -Remove'\)/);
    // read right after the script ran, before the failure branch
    assert.ok(iss.indexOf("'install-task')") > iss.indexOf("'scheduled task');") && iss.indexOf("'install-task')") < iss.indexOf('if not taskOk then begin'));
  });
  it('the script lines that end up in the log exist, and the checklist says how to find them', () => {
    const ps = read('packaging', 'install-task.ps1');
    assert.match(ps, /Say \("task registered with: \$used"\)/);
    assert.match(ps, /Say \("watchdog repetition:/);
    const c = read('packaging', 'sandbox', 'CHECKLIST.md');
    assert.match(c, /\/LOG="C:\\LLTest-setup\.log"/);
    assert.match(c, /task registered with/);
    assert.match(c, /watchdog repetition/);
  });
  it('checklist has the ownership / Users-RX / Test D as tuser confirmations', () => {
    const c = read('packaging', 'sandbox', 'CHECKLIST.md');
    assert.match(c, /owner is Administrators/i);
    assert.match(c, /BUILTIN\\Users:\(I\)\(RX\)/);
    assert.match(c, /status\.cmd/);
    assert.match(c, /Test D[\s\S]*as `?tuser/i);
  });
});
