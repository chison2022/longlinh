# LongLinh installer: Windows Sandbox test checklist

Run everything inside Windows Sandbox (`LongLinh-test.wsb`). Nothing here touches the host. Admin shell = the sandbox's default
user (`WDAGUtilityAccount`). Standard user = `tuser` (password in the .wsb comment). Installer: `C:\LLTest\LongLinh-Setup.exe`,
password in `C:\LLTest\INSTALLER-PASSWORD.txt` (the file build.js writes into the out dir; absent if the build was given INSTALLER_PASSWORD). The dummy .env has no Discord token and `PG_URL=postgres://u:p@127.0.0.1:1/llsbx`, so
`/health` will report ok=false (no DB): that is expected; what matters is the process, ACLs, port and task.

Copy the installer to a local folder first (`copy C:\LLTest\LongLinh-Setup.exe C:\Users\Public\`), run it elevated.
For each step note PASS/FAIL. Dump commands are PowerShell/cmd as written.

## 1. Clean install and the password
1. Run Setup with a WRONG password: the wizard must refuse and not continue. Then the right one: install completes, the "power"
   task option can be ticked.
2. Wizard: no directory page; install dir is `C:\Program Files\LongLinh`.
3. `Get-ScheduledTask 'LongLinh Bot'` exists, state Running (or Ready right after the 1-minute trigger).

## 2. ACL dumps (copy the output into the report)
```
icacls "C:\Program Files\LongLinh"
icacls "C:\Program Files\LongLinh\.env"
icacls "C:\Program Files\LongLinh\port.txt"
icacls "C:\ProgramData\LongLinh"
icacls "C:\ProgramData\LongLinh\logs"
(Get-Acl "C:\Program Files\LongLinh").Owner; (Get-Acl "C:\ProgramData\LongLinh").Owner; (Get-Acl "C:\ProgramData\LongLinh\logs").Owner
icacls "C:\Program Files\LongLinh\tools\status.cmd"
```
Confirm: the owner is Administrators (BUILTIN\Administrators) on `C:\Program Files\LongLinh`, `C:\ProgramData\LongLinh` and `...\logs`.
`tools\status.cmd` and `port.txt` each show `BUILTIN\Users:(I)(RX)` (inherited read/execute for Users). `.env` has NO Users ACE.
Expect: Program Files dir = Administrators + SYSTEM full, LOCAL SERVICE and Users read/execute (no write for Users).
`.env` = Administrators F, SYSTEM F, LOCAL SERVICE R only (no Users, no Authenticated Users). ProgramData\LongLinh owner
Administrators, Users read only (no create/write). logs: LOCAL SERVICE modify, Users read.

## 3. tuser access (open `runas /user:tuser cmd`)
- `type "C:\Program Files\LongLinh\.env"` -> Access denied.
- `type "C:\Program Files\LongLinh\port.txt"` -> prints the port (3000).
- `echo x > "C:\Program Files\LongLinh\x.txt"` -> denied. `echo x > C:\ProgramData\LongLinh\x.txt` and `...\logs\x.txt` -> denied.
- `mkdir C:\ProgramData\LongLinh\evil` -> denied.
- `type C:\ProgramData\LongLinh\logs\longlinh.log` -> readable.
- Start menu "Long Linh - Trạng thái" works as tuser (no UAC), shows port, listener = LongLinh, task state, log tail.

## 4. Upgrade loop check
Run the installer a second time (same password) while the bot runs.
- Wizard stops the bot first (no "files in use"), install completes, bot is running again after.
- Run it 3 times in a row: still exactly one `LongLinh.exe`, one task, no duplicate processes.
- Cancel test: start the installer, get past the Ready page so PrepareToInstall ran, then Cancel (during copy): the old bot must
  come back up and the dialog must say whether it is running. Also force a failure (e.g. icacls on a locked dir) if you can.

## 5. Task settings
```
$t = Get-ScheduledTask 'LongLinh Bot'
$t.Principal | fl *        # UserId LOCAL SERVICE, LogonType ServiceAccount, RunLevel Limited, ProcessTokenSidType Unrestricted, RequiredPrivilege
$t.Settings | fl *         # MultipleInstances IgnoreNew, ExecutionTimeLimit PT0S, StartWhenAvailable, no stop on battery
$t.Triggers | fl *         # a Boot trigger + a TimeTrigger whose Repetition: Interval PT5M, Duration empty (indefinite)
# The task script no longer logs into ProgramData: run Setup with /LOG="C:\LLTest-setup.log" and look in that Inno log for the
# lines "task registered with: ..." (narrowed token or FALLBACK plain LOCALSERVICE principal) and "watchdog repetition: ..."
# (the installer copies every line of install-task.ps1's log into the Inno log, prefixed "install-task:").
```
`Repetition.Duration` must be empty (indefinite); install-task.ps1 exits 1 otherwise. If the log says FALLBACK, note the rejection message. Also confirm the bot STARTS under the narrowed token (process alive after
2 minutes, longlinh.log has output). If it dies at once, the narrowed privileges break node/pkg: report it.

## 6. Process owner, bind, pkg cache
```
Get-CimInstance Win32_Process -Filter "Name='LongLinh.exe'" | % { $_.ProcessId; (Invoke-CimMethod -InputObject $_ -MethodName GetOwner) | select User,Domain }
Get-NetTCPConnection -State Listen -LocalPort 3000 | select LocalAddress,OwningProcess      # 127.0.0.1 only, never 0.0.0.0 / ::
dir C:\Windows\ServiceProfiles\LocalService\AppData\Local\pkg   # (or where the log says the pkg cache is)
```
Expect owner `LOCAL SERVICE`, bind `127.0.0.1:3000`, the pkg cache under the LocalService profile (not C:\Users\...).

## 7. Second copy
`& "C:\Program Files\LongLinh\LongLinh.exe"` as admin while the bot runs: it must print "another instance is running" and exit
with code 0 (`$LASTEXITCODE`), and the first instance keeps running.

## 8. Watchdog
`taskkill /F /IM LongLinh.exe` -> within ~5 minutes (repeating trigger) a new LongLinh.exe appears, owner LOCAL SERVICE. Note the
time it took. Repeat after a reboot of the sandbox if you like (boot trigger).

## 9. Power settings (if the option was ticked)
```
powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE
powercfg /q SCHEME_CURRENT SUB_BUTTONS LIDACTION
```
Expect standby/hibernate timeouts 0 and lid action "Do nothing" for AC and DC.

## 10. Restart shortcut UAC
As tuser: Start menu "Long Linh - Khởi động lại" must show a UAC prompt asking for admin credentials; after approving, the
bot restarts (new PID) and the task stays enabled. Declining must change nothing.

## 11. status.ps1 port checks
- Normal: shows the LongLinh listener and the health line.
- Disable the task and stop the bot (`Disable-ScheduledTask 'LongLinh Bot'; taskkill /F /IM LongLinh.exe`), then start a
  fake listener: `powershell -c "$l=[Net.Sockets.TcpListener]::new('127.0.0.1',3000);$l.Start();Start-Sleep 300"`. Status must say
  the port is taken by another program (powershell) and must NOT call /health. Afterwards re-enable and start the task.

## 12. Uninstall with planted junctions
Before uninstalling, as admin (simulating an attacker with a link in logs):
```
mkdir C:\Victim; echo keep > C:\Victim\keep.txt
cmd /c mklink /J C:\ProgramData\LongLinh\logs\evil C:\Victim
```
(a standard user cannot create this after install; admin does it here only to test the uninstaller).
Uninstall via "Apps & features" and answer YES to delete the logs. Expect: `C:\Victim\keep.txt` STILL EXISTS, the logs folder and
`C:\ProgramData\LongLinh` are gone, task removed, `C:\Program Files\LongLinh` gone. Repeat with a junction as
`C:\ProgramData\LongLinh` itself (replace the folder by `mklink /J`): uninstall must remove only the link, never the target.

## 13. Junction-squat abort on install (after uninstall)
Test A: `cmd /c mklink /J C:\ProgramData\LongLinh C:\Victim` then run Setup: it must abort in the wizard with a message about a
link ("liên kết"), say the old bot (if any) keeps running, and copy nothing. `C:\Victim` must be untouched (compare
`icacls C:\Victim` before/after).
Test B: `rmdir C:\ProgramData\LongLinh`, then as tuser `mkdir C:\ProgramData\LongLinh` (tuser owns it) and run Setup as admin:
it must abort with the "owner" message and change nothing. Remove it and re-run: installs normally.
Test C: pre-create `C:\ProgramData\LongLinh\logs` as admin, put a junction inside it, run Setup: abort naming the junction.

Test D (race between the guard check and the ACL step; run the planting loop as admin and any `type`/`mkdir` probes as `tuser`): the second guard run (right after the data folder is created) and `icacls /L`
on every call close this window. To exercise it, in an admin shell start this loop just before clicking Install:
`while ($true) { if (Test-Path C:\ProgramData\LongLinh) { Remove-Item C:\ProgramData\LongLinh -Recurse -Force -EA SilentlyContinue; cmd /c mklink /J C:\ProgramData\LongLinh C:\Victim; break } }`
(repeat a few times; or pause at the Ready page and plant the junction by hand once the Setup log shows `dir-guard ... exit code 0`).
Expect: the install ABORTS with the link ("liên kết") message, OR (if the link appears later still) icacls only touches the link.
Either way `icacls C:\Victim` is IDENTICAL before and after and `C:\Victim\keep.txt` still exists.

## 14. Legacy C:\LongLinh (NOTHING is deleted)
The old build was never installed anywhere, and deleting inside a user-writable folder as admin is racy, so Setup deletes nothing there.
Create `C:\LongLinh\LongLinh.exe`, `C:\LongLinh\.env` and `C:\LongLinh\other.txt` and run Setup: the wizard says the old install was stopped
(only a process whose path is exactly `C:\LongLinh\LongLinh.exe`) and tells the admin to delete `C:\LongLinh` by hand and to rotate any
secrets in the old `.env`. Afterwards ALL three files and the folder are still there. Repeat with `C:\LongLinh` as a junction to
`C:\Victim`: nothing is touched, the target is intact. The Setup log (`/LOG`) has the line "legacy install found at ...; nothing is deleted".
