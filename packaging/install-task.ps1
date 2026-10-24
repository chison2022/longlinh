# Creates / replaces the "LongLinh Bot" Scheduled Task. It runs as NT AUTHORITY\LOCALSERVICE (a low-privilege service account,
# not SYSTEM, RunLevel Limited), starts at boot and every 5 minutes (watchdog). Exit code 0 = ok, non-zero = failed.
# The 5-minute repeating trigger is the real watchdog: MultipleInstances IgnoreNew makes it a no-op while the bot runs.
# (The RestartCount settings below only help when the task fails to start; do not rely on them.)
# Repetition is INDEFINITE: the documented way is an empty Duration. [TimeSpan]::MaxValue is NOT usable: Register-ScheduledTask
# rejects it on Windows 11 (0x80041318, "P99999999DT23H59M59S out of range").
# The token is narrowed (unrestricted SID type, only SeChangeNotify + SeIncreaseWorkingSet; SeImpersonate dropped). If Task
# Scheduler refuses that principal we fall back to the plain LOCALSERVICE principal; the one used is logged (stdout + log file).
param([string]$InstallDir = (Join-Path $env:ProgramFiles 'LongLinh'), [switch]$Remove, [string]$LogFile)
$ErrorActionPreference = 'Stop'
$name = 'LongLinh Bot'
# The log goes to -LogFile (the installer passes a file in its own {tmp}), NEVER into ProgramData\LongLinh\logs: that directory is
# writable by LOCAL SERVICE and this script runs as admin, so appending there could be redirected by a planted link.
$logFile = $LogFile
function Say([string]$msg) {
  Write-Host $msg
  if ($logFile) { try { Add-Content -LiteralPath $logFile -Value ('{0:s} {1}' -f (Get-Date), $msg) -Encoding UTF8 } catch {} }
}
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
  # disable first so the watchdog trigger cannot start a new copy between Stop and Unregister
  Disable-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue | Out-Null
  Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
}
if ($Remove) { exit 0 }
$action = New-ScheduledTaskAction -Execute (Join-Path $InstallDir 'LongLinh.exe') -WorkingDirectory $InstallDir
$boot = New-ScheduledTaskTrigger -AtStartup
$watch = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$watch.Repetition.Duration = ''   # explicit: repeat indefinitely
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

function Register([object]$principal) {
  Register-ScheduledTask -TaskName $name -Action $action -Trigger @($boot, $watch) -Settings $settings -Principal $principal `
    -Description 'LongLinh Discord bot (one instance only)' | Out-Null
}
$used = 'narrowed token (Unrestricted SID, SeChangeNotify+SeIncreaseWorkingSet)'
try {
  $narrow = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\LOCALSERVICE' -LogonType ServiceAccount -RunLevel Limited `
    -ProcessTokenSidType Unrestricted -RequiredPrivilege SeChangeNotifyPrivilege, SeIncreaseWorkingSetPrivilege
  Register $narrow
} catch {
  Say ('narrowed principal rejected: ' + $_.Exception.Message)
  $used = 'FALLBACK plain LOCALSERVICE principal'
  $plain = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\LOCALSERVICE' -LogonType ServiceAccount -RunLevel Limited
  Register $plain
}
Say ("task registered with: $used")
$rep = (Get-ScheduledTask -TaskName $name).Triggers | Where-Object { $_.Repetition -and $_.Repetition.Interval } | Select-Object -First 1
if (-not $rep -or $rep.Repetition.Interval -ne 'PT5M') { Say 'ERROR: watchdog repetition (PT5M) missing from the registered task'; exit 1 }
if ($rep.Repetition.Duration) { Say "ERROR: watchdog repetition has a finite duration [$($rep.Repetition.Duration)] (must be empty = indefinite)"; exit 1 }
Say ("watchdog repetition: interval=$($rep.Repetition.Interval) duration=[$($rep.Repetition.Duration)] (empty = indefinite)")
Start-ScheduledTask -TaskName $name
exit 0
