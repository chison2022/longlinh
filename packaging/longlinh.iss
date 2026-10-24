; Long Linh bot installer. Build: npm run package [-- --env <path> --out <dir>] (passes /DStageDir=... /DOutDir=... /DAppVersion=...;
; the encryption password reaches ISCC ONLY through the LL_INSTALLER_PW environment variable, never on the command line).
; SECURITY: the installer embeds the builder's .env (tokens, DB password). It is encrypted (Encryption=yes) with a password
; (env INSTALLER_PASSWORD at build time, or random -> dist\INSTALLER-PASSWORD.txt). Still treat LongLinh-Setup.exe as a SECRET
; and send the password through a DIFFERENT channel than the file.
#ifndef StageDir
  #define StageDir "..\dist\stage"
#endif
#ifndef OutDir
  #define OutDir "..\dist"
#endif
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#define InstallerPassword GetEnv("LL_INSTALLER_PW")
#if InstallerPassword == ""
  #error InstallerPassword is empty: build with npm run package (it sets the LL_INSTALLER_PW environment variable)
#endif

[Setup]
AppId={{6F1D2C58-7B1E-4C58-9E0A-1A0B6C0D4C11}
AppName=Long Linh Bot
AppVersion={#AppVersion}
AppPublisher=Long Linh
; Program Files: Administrators + SYSTEM full control, Users read/execute only. Nothing under it is writable by normal users.
DefaultDirName={autopf}\LongLinh
; never reuse an older install dir (e.g. a former install in the drive root): always install into Program Files
UsePreviousAppDir=no
DisableDirPage=yes
DisableProgramGroupPage=yes
DefaultGroupName=Long Linh
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutDir}
OutputBaseFilename=LongLinh-Setup
Compression=lzma2
SolidCompression=yes
Encryption=yes
Password={#InstallerPassword}
WizardStyle=modern
UninstallDisplayName=Long Linh Bot
CloseApplications=no
; Always write a setup log (also on a plain double-click) to %TEMP%\Setup Log <date> #NNN.txt; /LOG=<file> still picks the path.
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "power"; Description: "Giữ máy không ngủ, đóng nắp laptop vẫn chạy (khuyên dùng)"; GroupDescription: "Nguồn điện:"

; No [Dirs] and no [Run]: {app}, the ProgramData log dir and every PowerShell/icacls call are handled in [Code] below, where
; each result is checked (a failed ACL step aborts the install before the .env is copied).

[Files]
Source: "{#StageDir}\LongLinh.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\.env"; DestDir: "{app}"; Flags: ignoreversion
; google-key.json: the (secret) service-account key of the Google Sheets sync; only when the builder had one next to the .env
Source: "{#StageDir}\google-key.json"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
Source: "{#StageDir}\assets\fonts\*"; DestDir: "{app}\assets\fonts"; Flags: ignoreversion recursesubdirs
; the PostgreSQL CA certificate (PG_CA in the .env, public): copied by build.js next to the .env
Source: "{#StageDir}\certs\*"; DestDir: "{app}\certs"; Flags: ignoreversion recursesubdirs skipifsourcedoesntexist
Source: "{#StageDir}\tools\*"; DestDir: "{app}\tools"; Flags: ignoreversion
Source: "{#StageDir}\HUONG-DAN.txt"; DestDir: "{app}"; Flags: ignoreversion
; port.txt: the (non-secret) HTTP port, so status.ps1 works for normal users who cannot read the .env
Source: "{#StageDir}\port.txt"; DestDir: "{app}"; Flags: ignoreversion
; used by PrepareToInstall before anything is copied to {app}
Source: "{#StageDir}\tools\dir-guard.ps1"; DestDir: "{tmp}"; Flags: dontcopy

[Icons]
Name: "{autoprograms}\Long Linh\Long Linh – Trạng thái"; Filename: "{app}\tools\status.cmd"; WorkingDir: "{app}"
Name: "{autoprograms}\Long Linh\Long Linh – Khởi động lại"; Filename: "{app}\tools\restart.cmd"; WorkingDir: "{app}"
Name: "{autoprograms}\Long Linh\Hướng dẫn"; Filename: "{app}\HUONG-DAN.txt"

[UninstallDelete]
Type: files; Name: "{app}\.env"
Type: files; Name: "{app}\google-key.json"
Type: files; Name: "{app}\port.txt"
Type: filesandordirs; Name: "{app}\assets"
Type: filesandordirs; Name: "{app}\tools"
Type: dirifempty; Name: "{app}"

[Code]
const
  SID_ADMINS = '*S-1-5-32-544';
  SID_SYSTEM = '*S-1-5-18';
  SID_LOCALSERVICE = '*S-1-5-19';
  SID_USERS = '*S-1-5-32-545';

function PowerShellExe: String;
begin
  Result := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
end;

// Runs a program hidden and waits. True only when it started and exited with code 0.
function RunChecked(const Exe, Params, What: String): Boolean;
var
  rc: Integer;
begin
  rc := -1;
  Result := Exec(Exe, Params, '', SW_HIDE, ewWaitUntilTerminated, rc) and (rc = 0);
  if Result then
    Log(What + ': ok')
  else
    Log(What + ': FAILED (exit code ' + IntToStr(rc) + ')');
end;

function Icacls(const Params, What: String): Boolean;
begin
  Result := RunChecked(ExpandConstant('{sys}\icacls.exe'), Params, What);
end;

function PsFile(const Script, Args, What: String): Boolean;
begin
  Result := RunChecked(PowerShellExe,
    '-NoProfile -ExecutionPolicy Bypass -File ' + AddQuotes(ExpandConstant('{app}\tools\' + Script)) + ' ' + Args, What);
end;

// /L on every call: icacls acts on a link itself, never on its target (a junction planted after the guard check cannot redirect it).
// Directory owned by Administrators, default ACL, then inheritance removed and ONLY the listed grants.
function LockDir(const Dir, Grants, What: String): Boolean;
begin
  Result := Icacls(AddQuotes(Dir) + ' /setowner ' + SID_ADMINS + ' /L', What + ' owner')
    and Icacls(AddQuotes(Dir) + ' /reset /L', What + ' reset')
    and Icacls(AddQuotes(Dir) + ' /inheritance:r /grant:r ' + Grants + ' /L', What + ' acl');
end;

var
  BotStopped: Boolean;       // we disabled/stopped the old task and have not restored it yet
  InstallDone: Boolean;      // the new task was registered and started
  PostInstallFailed: Boolean;

// ---- ProgramData squatting / junction guard (dir-guard.ps1) ----
function GuardReportFile: String;
begin
  Result := ExpandConstant('{tmp}\guard-report.txt');
end;

// Exit code of dir-guard.ps1: 0 ok/absent, 2 reparse point, 3 unexpected owner, 4 error, -1 could not run.
function GuardRc(const Dir, Extra: String): Integer;
var
  rc: Integer;
begin
  rc := -1;
  DeleteFile(GuardReportFile);
  if not Exec(PowerShellExe, '-NoProfile -ExecutionPolicy Bypass -File ' + AddQuotes(ExpandConstant('{tmp}\dir-guard.ps1')) +
      ' -Path ' + AddQuotes(Dir) + ' ' + Extra + ' -Report ' + AddQuotes(GuardReportFile), '', SW_HIDE, ewWaitUntilTerminated, rc) then
    rc := -1;
  Log('dir-guard ' + Dir + ' ' + Extra + ': exit code ' + IntToStr(rc));
  Result := rc;
end;

function GuardMessage(rc: Integer; const Dir: String): String;
var
  detail: AnsiString;
begin
  detail := '';
  if FileExists(GuardReportFile) then LoadStringFromFile(GuardReportFile, detail);
  case rc of
    2: Result := 'Thư mục ' + Dir + ' (hoặc một mục bên trong) là liên kết (junction/symlink), có thể do người khác tạo để chiếm quyền. ';
    3: Result := 'Thư mục ' + Dir + ' (hoặc một mục bên trong) thuộc sở hữu của tài khoản lạ (không phải Administrators/SYSTEM), có thể do người khác tạo trước. ';
  else
    Result := 'Không kiểm tra được an toàn của thư mục ' + Dir + '. ';
  end;
  Result := Result + '(' + Trim(String(detail)) + ') Cài đặt đã dừng, KHÔNG theo liên kết và chưa chép file nào. Hãy nhờ quản trị viên kiểm tra/xoá thư mục đó rồi chạy lại.';
end;

// Copies every line of a helper script's log file into the Inno log (the scripts run hidden, so this is the only place their
// diagnostics survive; run Setup with /LOG=...).
procedure LogFileLines(const FileName, What: String);
var
  lines: TArrayOfString;
  k: Integer;
begin
  if not LoadStringsFromFile(FileName, lines) then begin
    Log(What + ': no log file');
    Exit;
  end;
  for k := 0 to GetArrayLength(lines) - 1 do
    Log(What + ': ' + lines[k]);
end;

// ---- restoring the old bot when the install is aborted ----
// Re-enables and starts the existing "LongLinh Bot" task, if there is one. Returns a sentence saying whether the bot runs.
function RestoreBot: String;
var
  rc: Integer;
begin
  BotStopped := False;
  rc := -1;
  Exec(PowerShellExe,
    '-NoProfile -Command "$t = Get-ScheduledTask -TaskName ''LongLinh Bot'' -ErrorAction SilentlyContinue; if (-not $t) { exit 5 }; try { Enable-ScheduledTask -TaskName ''LongLinh Bot'' -ErrorAction Stop | Out-Null; Start-ScheduledTask -TaskName ''LongLinh Bot'' -ErrorAction Stop } catch { exit 6 }; exit 0"',
    '', SW_HIDE, ewWaitUntilTerminated, rc);
  Log('restore old bot: exit code ' + IntToStr(rc));
  if rc = 0 then
    Result := 'Bot cũ đã được bật lại và ĐANG CHẠY.'
  else if rc = 5 then
    Result := 'Trước đó chưa có bot nào được cài, nên bot KHÔNG chạy.'
  else
    Result := 'KHÔNG bật lại được bot cũ: bot có thể đang TẮT. Mở "Long Linh - Khởi động lại" hoặc Task Scheduler để bật.';
end;

function FailInstall(const Msg: String): String;
begin
  Result := Msg + ' ' + RestoreBot;
end;

procedure DeinitializeSetup();
begin
  // Cancel (or any exit before the new task started): put the old bot back. After a post-install failure the files are in an
  // unknown state, so do not start anything.
  if BotStopped and not InstallDone and not PostInstallFailed then
    SuppressibleMsgBox('Cài đặt chưa hoàn tất. ' + RestoreBot, mbInformation, MB_OK, IDOK);
end;

// An older build lived in the system drive root (writable by normal users). It was never installed anywhere, and deleting inside a
// user-writable folder as admin is racy (links can be planted), so NOTHING is deleted here: only a process whose image is exactly
// that exe is stopped, and the admin is told to remove the folder by hand (it may hold an old .env: rotate those secrets).
procedure RemoveLegacyInstall;
var
  legacy: String;
  rc: Integer;
begin
  legacy := ExpandConstant('{sd}\LongLinh');
  if not FileExists(legacy + '\LongLinh.exe') then Exit;
  // Stop by FULL path match (not by name), so an unrelated process is never touched. Failure is not fatal.
  rc := -1;
  Exec(PowerShellExe,
    '-NoProfile -Command "Get-Process -Name LongLinh -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq ''' + legacy + '\LongLinh.exe'' } | Stop-Process -Force -ErrorAction SilentlyContinue; exit 0"',
    '', SW_HIDE, ewWaitUntilTerminated, rc);
  Log('legacy install found at ' + legacy + '; stop by path: exit code ' + IntToStr(rc) + '; nothing is deleted');
  SuppressibleMsgBox('Có bản cài cũ ở ' + legacy + ' (đã dừng nếu đang chạy). Bộ cài KHÔNG xoá gì ở đó. Quản trị viên hãy tự xoá thủ công thư mục ' + legacy + '. Nó có thể chứa file .env cũ: hãy đổi (rotate) các khoá/mật khẩu trong đó.', mbInformation, MB_OK, IDOK);
end;

// Runs before any file is copied (and before the Ready page is left). Checks ProgramData for squatting, stops the old bot, then
// creates the locked-down directories so that the .env is never copied anywhere a normal user can read.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  rc: Integer;
  dataDir, logDir, appDir: String;
begin
  Result := '';
  appDir := ExpandConstant('{app}');
  dataDir := ExpandConstant('{commonappdata}\LongLinh');
  logDir := dataDir + '\logs';
  ExtractTemporaryFile('dir-guard.ps1');

  // 1. Before touching anything: %ProgramData%\LongLinh and its logs must not be a link nor owned by a stranger (a standard user
  //    can pre-create folders in ProgramData). Nothing has been stopped yet, so the old bot keeps running if we abort here.
  rc := GuardRc(dataDir, '-Mode Check');
  if rc <> 0 then begin Result := GuardMessage(rc, dataDir) + ' Bot cũ (nếu có) vẫn chạy như trước.'; Exit; end;
  rc := GuardRc(logDir, '-Mode Check');
  if rc <> 0 then begin Result := GuardMessage(rc, logDir) + ' Bot cũ (nếu có) vẫn chạy như trước.'; Exit; end;

  // Upgrade: disable the task FIRST (so the 5-minute watchdog cannot start a new copy), then stop it and kill the bot.
  // Failures are fine here (fresh install: no task, no process).
  BotStopped := True;
  Exec(PowerShellExe,
    '-NoProfile -Command "Disable-ScheduledTask -TaskName ''LongLinh Bot'' -ErrorAction SilentlyContinue | Out-Null; Stop-ScheduledTask -TaskName ''LongLinh Bot'' -ErrorAction SilentlyContinue; exit 0"',
    '', SW_HIDE, ewWaitUntilTerminated, rc);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM LongLinh.exe', '', SW_HIDE, ewWaitUntilTerminated, rc);
  Sleep(1500);

  // Install dir: no access for normal users until the .env has been locked (see CurStepChanged). New files inherit this.
  if not ForceDirectories(appDir) then begin
    Result := FailInstall('Không tạo được thư mục cài đặt: ' + appDir + '.');
    Exit;
  end;
  if not LockDir(appDir, SID_ADMINS + ':(OI)(CI)F ' + SID_SYSTEM + ':(OI)(CI)F ' + SID_LOCALSERVICE + ':(OI)(CI)RX', 'ACL install dir') then begin
    Result := FailInstall('Không đặt được quyền truy cập cho thư mục cài đặt (icacls lỗi). Cài đặt đã dừng, chưa có file nào được chép.');
    Exit;
  end;

  // 2. %ProgramData%\LongLinh (parent) FIRST: Administrators/SYSTEM full, LocalService + Users read (no create rights for Users),
  //    owner Administrators. Only then the logs below it, so nobody can slip a link in between.
  if not ForceDirectories(dataDir) then begin
    Result := FailInstall('Không tạo được thư mục ' + dataDir + '.');
    Exit;
  end;
  // Race: re-run the guard right before the ACL is applied (a link could have been planted since the first check).
  rc := GuardRc(dataDir, '-Mode Check');
  if rc <> 0 then begin Result := FailInstall(GuardMessage(rc, dataDir)); Exit; end;
  if not LockDir(dataDir, SID_ADMINS + ':(OI)(CI)F ' + SID_SYSTEM + ':(OI)(CI)F ' + SID_LOCALSERVICE + ':(OI)(CI)RX ' + SID_USERS + ':(OI)(CI)RX', 'ACL data dir') then begin
    Result := FailInstall('Không đặt được quyền cho ' + dataDir + ' (icacls lỗi). Cài đặt đã dừng.');
    Exit;
  end;
  rc := GuardRc(dataDir, '-Mode Check');
  if rc <> 0 then begin Result := FailInstall(GuardMessage(rc, dataDir)); Exit; end;

  // 3. Logs: Administrators/SYSTEM full, LocalService (the account running the bot) modify, Users read only. Existing content must
  //    contain no link and no stranger-owned entry before it is locked.
  if not ForceDirectories(logDir) then begin
    Result := FailInstall('Không tạo được thư mục log ' + logDir + '.');
    Exit;
  end;
  rc := GuardRc(logDir, '-Mode Check -Recurse -AllowLocalService');
  if rc <> 0 then begin Result := FailInstall(GuardMessage(rc, logDir)); Exit; end;
  if not LockDir(logDir, SID_ADMINS + ':(OI)(CI)F ' + SID_SYSTEM + ':(OI)(CI)F ' + SID_LOCALSERVICE + ':(OI)(CI)M ' + SID_USERS + ':(OI)(CI)RX', 'ACL log dir') then begin
    Result := FailInstall('Không đặt được quyền cho thư mục log ' + logDir + ' (icacls lỗi). Cài đặt đã dừng.');
    Exit;
  end;
  rc := GuardRc(logDir, '-Mode Check');
  if rc <> 0 then begin Result := FailInstall(GuardMessage(rc, logDir)); Exit; end;

  // 4. Last: report (never delete) an old build in the system drive root.
  RemoveLegacyInstall;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  envFile: String;
  keyFile: String;
  taskOk: Boolean;
begin
  if CurStep <> ssPostInstall then Exit;
  envFile := ExpandConstant('{app}\.env');

  // .env = secrets: Administrators + SYSTEM full, LocalService (the bot) read. Nobody else. On failure remove it and abort.
  if not Icacls(AddQuotes(envFile) + ' /reset /L', 'ACL .env reset')
     or not Icacls(AddQuotes(envFile) + ' /inheritance:r /grant:r ' + SID_ADMINS + ':F ' + SID_SYSTEM + ':F ' + SID_LOCALSERVICE + ':R /L', 'ACL .env') then begin
    DeleteFile(envFile);
    PostInstallFailed := True;
    RaiseException('Không khoá được quyền file .env (icacls lỗi) - đã xoá .env và dừng cài đặt. Bot đang TẮT. Hãy chạy lại bộ cài bằng quyền quản trị.');
  end;

  // google-key.json (when shipped) = a secret like the .env: same ACL, same abort on failure.
  keyFile := ExpandConstant('{app}\google-key.json');
  if FileExists(keyFile) then
    if not Icacls(AddQuotes(keyFile) + ' /reset /L', 'ACL google-key.json reset')
       or not Icacls(AddQuotes(keyFile) + ' /inheritance:r /grant:r ' + SID_ADMINS + ':F ' + SID_SYSTEM + ':F ' + SID_LOCALSERVICE + ':R /L', 'ACL google-key.json') then begin
      DeleteFile(keyFile);
      DeleteFile(envFile);
      PostInstallFailed := True;
      RaiseException('Không khoá được quyền file google-key.json (icacls lỗi) - đã xoá khoá và dừng cài đặt. Bot đang TẮT. Hãy chạy lại bộ cài bằng quyền quản trị.');
    end;

  // Now that the .env is locked, let normal users read/run the rest of the install dir (status.cmd, port.txt etc.). The .env does
  // not inherit this (its inheritance was removed).
  if not Icacls(AddQuotes(ExpandConstant('{app}')) + ' /grant:r ' + SID_USERS + ':(OI)(CI)RX /L', 'ACL install dir users') then begin
    PostInstallFailed := True;
    RaiseException('Không đặt được quyền đọc cho thư mục cài đặt (icacls lỗi). Bot đang TẮT.');
  end;

  if WizardIsTaskSelected('power') then
    if not PsFile('power.ps1', '', 'power settings') then
      SuppressibleMsgBox('Không đặt được cấu hình nguồn điện (bot vẫn được cài). Hãy tự tắt Sleep/Hibernate trong Power Options.', mbError, MB_OK, IDOK);

  // Creates the task (NT AUTHORITY\LOCALSERVICE, boot + 5-minute watchdog) and starts the bot.
  DeleteFile(ExpandConstant('{tmp}\install-task.log'));
  taskOk := PsFile('install-task.ps1', '-InstallDir ' + AddQuotes(ExpandConstant('{app}')) + ' -LogFile ' + AddQuotes(ExpandConstant('{tmp}\install-task.log')), 'scheduled task');
  LogFileLines(ExpandConstant('{tmp}\install-task.log'), 'install-task');
  if not taskOk then begin
    PostInstallFailed := True;
    RaiseException('Không tạo được tác vụ khởi động của bot (Task Scheduler lỗi). Bot CHƯA chạy. Xem hướng dẫn hoặc chạy lại bộ cài.');
  end;
  InstallDone := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  rc: Integer;
  dataDir, guard: String;
  taskOk: Boolean;
begin
  if CurUninstallStep = usUninstall then begin
    // Keep a copy of the guard script: {app}\tools is deleted before usPostUninstall.
    CopyFile(ExpandConstant('{app}\tools\dir-guard.ps1'), ExpandConstant('{tmp}\dir-guard.ps1'), False);
    // Remove the task first (disable, stop, unregister), then make sure no bot process is left holding the files.
    DeleteFile(ExpandConstant('{tmp}\install-task-remove.log'));
    taskOk := PsFile('install-task.ps1', '-InstallDir ' + AddQuotes(ExpandConstant('{app}')) + ' -Remove -LogFile ' + AddQuotes(ExpandConstant('{tmp}\install-task-remove.log')), 'remove scheduled task');
    LogFileLines(ExpandConstant('{tmp}\install-task-remove.log'), 'install-task -Remove');
    if not taskOk then
      SuppressibleMsgBox('Không xoá được tác vụ "LongLinh Bot" trong Task Scheduler. Hãy xoá thủ công (taskschd.msc).', mbError, MB_OK, IDOK);
    Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM LongLinh.exe', '', SW_HIDE, ewWaitUntilTerminated, rc);
    Sleep(1000);
  end;
  if CurUninstallStep = usPostUninstall then begin
    dataDir := ExpandConstant('{commonappdata}\LongLinh');
    guard := ExpandConstant('{tmp}\dir-guard.ps1');
    // Logs are kept unless the user agrees (silent uninstall always keeps them).
    if DirExists(dataDir) and not UninstallSilent then
      if MsgBox('Xoá luôn thư mục log (' + dataDir + ')?', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then begin
        // dir-guard Purge: refuses a top-level directory owned by a stranger; removes any junction/symlink as a LINK ONLY
        // (rmdir semantics), so the target of a planted link is never followed or deleted. (no recursive delete helper is used here).
        rc := -1;
        if FileExists(guard) then
          Exec(PowerShellExe, '-NoProfile -ExecutionPolicy Bypass -File ' + AddQuotes(guard) + ' -Path ' + AddQuotes(dataDir) + ' -Mode Purge', '', SW_HIDE, ewWaitUntilTerminated, rc);
        if rc <> 0 then
          SuppressibleMsgBox('Không xoá được thư mục log ' + dataDir + ' (chủ sở hữu lạ hoặc lỗi). Hãy kiểm tra và xoá thủ công.', mbError, MB_OK, IDOK);
      end;
  end;
end;
