// Second hardening round of the Windows packaging: static assertions on the installer / PowerShell files and unit tests of build.js.
// The installer is never run by tests.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { resolvePassword, parseArgs, readPort, runIscc } = require('../packaging/build');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const iss = read('packaging', 'longlinh.iss');
const prep = iss.slice(iss.indexOf('function PrepareToInstall'), iss.indexOf('procedure CurStepChanged'));
const uninst = iss.slice(iss.indexOf('procedure CurUninstallStepChanged'));

describe('MEDIUM-1: ProgramData squatting / junction guard', () => {
  it('checks dataDir and logs BEFORE stopping the bot or changing anything', () => {
    const iCheck = prep.indexOf("GuardRc(dataDir, '-Mode Check')");
    assert.ok(iCheck > 0);
    assert.ok(iCheck < prep.indexOf('Disable-ScheduledTask'));
    assert.ok(prep.indexOf("GuardRc(logDir, '-Mode Check')") < prep.indexOf('Disable-ScheduledTask'));
    assert.match(prep, /ExtractTemporaryFile\('dir-guard\.ps1'\)/);
    assert.match(iss, /dir-guard\.ps1"; DestDir: "\{tmp\}"; Flags: dontcopy/);
  });

  it('creates and locks dataDir before the logs, verifies logs + children before LockDir(logDir)', () => {
    const iData = prep.indexOf("'ACL data dir'");
    const iMkLogs = prep.indexOf('ForceDirectories(logDir)');
    const iRec = prep.indexOf("-Mode Check -Recurse -AllowLocalService");
    const iLockLogs = prep.indexOf("'ACL log dir'");
    assert.ok(iData > 0 && iData < iMkLogs && iMkLogs < iRec && iRec < iLockLogs);
    // Users get read only on the data dir: no create rights
    assert.match(prep, /SID_USERS \+ ':\(OI\)\(CI\)RX', 'ACL data dir'/);
    assert.doesNotMatch(prep, /SID_USERS \+ ':\(OI\)\(CI\)(M|F|W)/);
    // re-verified after locking
    assert.ok(prep.indexOf("GuardRc(dataDir, '-Mode Check')", iData) > iData);
  });

  it('every abort branch returns a message (nothing is followed or copied)', () => {
    assert.match(iss, /function GuardMessage[\s\S]*liên kết[\s\S]*thuộc sở hữu của tài khoản lạ/);
    assert.match(iss, /KHÔNG theo liên kết và chưa chép file nào/);
  });

  it('dir-guard.ps1 never follows reparse points and checks owners', () => {
    const g = read('packaging', 'dir-guard.ps1');
    assert.match(g, /ReparsePoint/);
    assert.match(g, /S-1-5-32-544/);
    assert.match(g, /S-1-5-18/);
    assert.match(g, /S-1-5-19/); // LocalService only with -AllowLocalService
    assert.doesNotMatch(g, /Get-ChildItem[^\n]*-Recurse/); // manual walk: -Recurse would descend into junctions
    assert.doesNotMatch(g, /Remove-Item/);
    assert.match(g, /\[IO\.Directory\]::Delete\(\$item\.FullName, \$false\)/); // links removed with rmdir semantics
    assert.match(g, /Fail 2 'reparse point'/);
    assert.match(g, /Fail 3 'unexpected owner'/);
  });

  it('uninstall: no DelTree on the data dir; purge via the guard, which removes links as links', () => {
    assert.doesNotMatch(uninst, /DelTree/);
    assert.match(uninst, /-Mode Purge/);
    assert.match(uninst, /CopyFile\([^\n]*dir-guard\.ps1/); // copied before {app}\tools is deleted
  });

  it('guard script behaves: Check rejects a junction, Purge removes the link but not the target (live, temp dirs only)', { skip: process.platform !== 'win32' }, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'll-guard-'));
    const guard = path.join(root, 'packaging', 'dir-guard.ps1');
    const run = (...a) => {
      try {
        execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', guard, ...a], { stdio: 'pipe' });
        return 0;
      } catch (e) { return e.status; }
    };
    try {
      const victim = path.join(tmp, 'victim');
      const data = path.join(tmp, 'data');
      fs.mkdirSync(victim);
      fs.writeFileSync(path.join(victim, 'keep.txt'), 'keep');
      fs.mkdirSync(data);
      fs.writeFileSync(path.join(data, 'a.log'), 'x');
      fs.symlinkSync(victim, path.join(data, 'evil'), 'junction');
      assert.equal(run('-Path', path.join(tmp, 'absent'), '-Mode', 'Check'), 0);
      assert.equal(run('-Path', data, '-Mode', 'Check', '-Recurse', '-AllowLocalService', '-SkipOwner'), 2); // junction inside
      assert.equal(run('-Path', data, '-Mode', 'Purge', '-SkipOwner'), 0);
      assert.ok(!fs.existsSync(data));
      assert.equal(fs.readFileSync(path.join(victim, 'keep.txt'), 'utf8'), 'keep'); // target untouched
      // the top-level directory itself is a junction: Check refuses, Purge removes only the link
      fs.symlinkSync(victim, path.join(tmp, 'link'), 'junction');
      assert.equal(run('-Path', path.join(tmp, 'link'), '-Mode', 'Check', '-SkipOwner'), 2);
      assert.equal(run('-Path', path.join(tmp, 'link'), '-Mode', 'Purge', '-SkipOwner'), 0);
      assert.ok(!fs.existsSync(path.join(tmp, 'link')));
      assert.ok(fs.existsSync(path.join(victim, 'keep.txt')));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('LOW-1/2/3: installer password and build.js', () => {
  it('the .iss reads the password from LL_INSTALLER_PW and errors when empty', () => {
    assert.match(iss, /#define InstallerPassword GetEnv\("LL_INSTALLER_PW"\)/);
    assert.match(iss, /#if InstallerPassword == ""\s*\n\s*#error/);
    assert.doesNotMatch(iss, /#ifndef InstallerPassword/);
  });

  it('runIscc passes the password only in env; argv and error text never contain it', () => {
    const pw = 'SuperSecretPw12345';
    let seen;
    const failing = (cmd, args, opts) => {
      seen = { cmd, args, opts };
      const e = new Error(`Command failed: ${cmd} ${args.join(' ')} password=${pw}`);
      e.status = 2;
      e.cmd = `${cmd} ${args.join(' ')} ${pw}`;
      throw e;
    };
    assert.throws(() => runIscc('ISCC.exe', ['/DStageDir=x', 'a.iss'], pw, failing), (e) => {
      assert.ok(!e.message.includes(pw));
      assert.ok(!String(e.stack).includes(pw));
      assert.match(e.message, /exit code 2/);
      return true;
    });
    assert.equal(seen.opts.env.LL_INSTALLER_PW, pw);
    assert.ok(!seen.args.some((a) => a.includes(pw)));
    assert.ok(!JSON.stringify(seen.args).includes('InstallerPassword'));
    // success path also keeps the password out of argv
    runIscc('ISCC.exe', ['x'], pw, (c, a, o) => { assert.equal(o.env.LL_INSTALLER_PW, pw); assert.ok(!a.join(' ').includes(pw)); });
    // build.js must not put the password anywhere else
    const b = read('packaging', 'build.js');
    assert.doesNotMatch(b, /DInstallerPassword/);
    assert.doesNotMatch(b, /console\.log\(`[^`\n]*\$\{password\}/);
  });

  it('a user-supplied INSTALLER_PASSWORD needs 14-64 safe characters', () => {
    assert.throws(() => resolvePassword({ INSTALLER_PASSWORD: 'Abcdefgh12345' })); // 13
    assert.equal(resolvePassword({ INSTALLER_PASSWORD: 'Abcdefgh123456' }).generated, false); // 14
    assert.throws(() => resolvePassword({ INSTALLER_PASSWORD: 'x'.repeat(65) }));
    assert.throws(() => resolvePassword({ INSTALLER_PASSWORD: 'Abcdefgh12345 6' }));
  });

  it('stage (with its .env copy) is removed in a finally block', () => {
    const b = read('packaging', 'build.js');
    assert.match(b, /try \{[\s\S]*\} finally \{\s*fs\.rmSync\(stage, \{ recursive: true, force: true \}\)/);
  });

  it('--env / --out options and PORT extraction', () => {
    const d = parseArgs([]);
    assert.equal(d.env, path.join(root, '.env'));
    assert.equal(d.out, path.join(root, 'dist'));
    const o = parseArgs(['--env', 'C:\\x\\dummy.env', '--out', 'C:\\y\\out']);
    assert.equal(o.env, path.resolve('C:\\x\\dummy.env'));
    assert.equal(o.out, path.resolve('C:\\y\\out'));
    assert.throws(() => parseArgs(['--env']));
    assert.throws(() => parseArgs(['--bogus']));
    assert.equal(readPort('A=1\nPORT=4123\n'), 4123);
    assert.equal(readPort('PORT = "8080" # web'), 8080);
    assert.equal(readPort('XPORT=5\nFOO=1'), 3000);
    assert.equal(readPort('PORT=99999'), 3000);
    assert.equal(readPort(''), 3000);
  });
});

describe('LOW-4/5: failure paths restore the old bot; legacy C:\\LongLinh', () => {
  it('every PrepareToInstall error after the stop goes through FailInstall (re-enable + start + say if running)', () => {
    const afterStop = prep.slice(prep.indexOf('BotStopped := True'));
    const results = afterStop.match(/Result := [^\n]*/g);
    assert.ok(results.length >= 8);
    for (const r of results) assert.match(r, /Result := FailInstall\(/, r);
    assert.match(iss, /function RestoreBot[\s\S]*Enable-ScheduledTask[\s\S]*Start-ScheduledTask/);
    assert.match(iss, /ĐANG CHẠY/);
    assert.match(iss, /KHÔNG chạy/);
  });

  it('cancel / abort before the new task started restores the bot (DeinitializeSetup)', () => {
    assert.match(iss, /procedure DeinitializeSetup[\s\S]*BotStopped and not InstallDone[\s\S]*RestoreBot/);
    assert.match(iss, /InstallDone := True/);
    assert.ok(iss.indexOf("'scheduled task'") < iss.indexOf('InstallDone := True'));
  });

  it('legacy C:\\LongLinh: only stops the process (path match) and tells the admin; never deletes', () => {
    const f = iss.slice(iss.indexOf('procedure RemoveLegacyInstall'), iss.indexOf('function PrepareToInstall'));
    assert.match(f, /\{sd\}\\LongLinh/);
    assert.match(f, /\$_\.Path -eq/);
    assert.match(f, /thủ công/);
    assert.match(f, /rotate/);
    assert.doesNotMatch(f, /DeleteFile|DelTree|DeleteKnown|Purge|Remove-Item|taskkill/);
    assert.match(prep, /RemoveLegacyInstall/);
  });
});

describe('LOW-6/8: scheduled task definition', () => {
  const ps = read('packaging', 'install-task.ps1');
  it('narrowed token with a logged fallback', () => {
    assert.match(ps, /-ProcessTokenSidType Unrestricted -RequiredPrivilege SeChangeNotifyPrivilege, SeIncreaseWorkingSetPrivilege/);
    assert.doesNotMatch(ps, /RequiredPrivilege[^\n]*SeImpersonate/);
    assert.match(ps, /catch \{[\s\S]*FALLBACK plain LOCALSERVICE principal[\s\S]*Register \$plain/);
    assert.match(ps, /task registered with: \$used/);
  });
  it('boot trigger kept; watchdog repeats every 5 min with an explicit indefinite duration', () => {
    assert.match(ps, /New-ScheduledTaskTrigger -AtStartup/);
    assert.match(ps, /-RepetitionInterval \(New-TimeSpan -Minutes 5\)/);
    assert.match(ps, /\$watch\.Repetition\.Duration = ''/);
    assert.doesNotMatch(ps, /^\s*[^#\n]*\[TimeSpan\]::MaxValue/m); // rejected by Register-ScheduledTask on Windows 11 (only mentioned in a comment)
    assert.match(ps, /PT5M/);
  });
});

describe('LOW-7: status.ps1 verifies the listener; port.txt', () => {
  const st = read('packaging', 'status.ps1');
  it('uses port.txt, Get-NetTCPConnection and the owner process name before /health', () => {
    assert.match(st, /port\.txt/);
    assert.match(st, /Get-NetTCPConnection -State Listen -LocalPort \$port/);
    assert.match(st, /127\.0\.0\.1/);
    assert.match(st, /\$owner\.Name -ne 'LongLinh'/);
    assert.match(st, /bị chương trình khác chiếm/);
    assert.ok(st.indexOf('OwningProcess') < st.indexOf('Invoke-RestMethod'));
    assert.doesNotMatch(st, /Select-String -Path[^\n]*\.env/); // does not read the secret .env any more
  });
  it('status.ps1 starts with a UTF-8 BOM (PowerShell 5.1 reads Vietnamese correctly)', () => {
    assert.deepEqual([...fs.readFileSync(path.join(root, 'packaging', 'status.ps1')).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  });
  it('installer ships port.txt and the stage gets the guard script', () => {
    assert.match(iss, /port\.txt"; DestDir: "\{app\}"/);
    const b = read('packaging', 'build.js');
    assert.match(b, /port\.txt/);
    assert.match(b, /'dir-guard\.ps1'/);
  });
});

describe('sandbox support files', () => {
  const wsb = read('packaging', 'sandbox', 'LongLinh-test.wsb');
  it('wsb: networking disabled, folder read-only, tuser created', () => {
    assert.match(wsb, /<Networking>Disable<\/Networking>/);
    assert.match(wsb, /<ReadOnly>true<\/ReadOnly>/);
    assert.match(wsb, /net user tuser \S+ \/add/);
  });
  it('checklist covers the required scenarios', () => {
    const c = read('packaging', 'sandbox', 'CHECKLIST.md');
    for (const k of ['WRONG password', 'icacls', 'tuser', 'Upgrade loop', 'Task settings', 'LOCAL SERVICE', '127.0.0.1', 'pkg', 'Second copy', 'Watchdog', 'powercfg', 'UAC', 'junction', 'squat']) assert.match(c, new RegExp(k, 'i'), k);
  });
});
