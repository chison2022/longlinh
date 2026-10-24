# Directory guard for the installer / uninstaller. It never FOLLOWS a reparse point (junction / symlink / mount point).
#   -Mode Check : exit 0 when -Path is absent, or is a real directory owned by an allowed account (and, with -Recurse, so is every
#                 child: nothing below it is a reparse point and everything is owned by an allowed account).
#   -Mode Purge : delete -Path. Reparse points are removed as links only (their target is never touched). Refuses (exit 3) when
#                 the top-level directory has an unexpected owner (unless -SkipOwner). Only for admin-owned trees (ProgramData).
# Allowed owners: Administrators (S-1-5-32-544), SYSTEM (S-1-5-18); with -AllowLocalService also LOCAL SERVICE (S-1-5-19).
# Exit codes: 0 ok / absent, 2 reparse point, 3 unexpected owner, 4 other error. The offending path is written to -Report.
param(
  [Parameter(Mandatory)][string]$Path,
  [ValidateSet('Check', 'Purge')][string]$Mode = 'Check',
  [switch]$Recurse, [switch]$AllowLocalService, [switch]$SkipOwner,
  [string]$Report
)
$ErrorActionPreference = 'Stop'
$allowed = @('S-1-5-32-544', 'S-1-5-18')
if ($AllowLocalService) { $allowed += 'S-1-5-19' }

function Fail([int]$code, [string]$what, [string]$p) {
  if ($Report) { try { Set-Content -LiteralPath $Report -Value "$what`: $p" -Encoding ASCII } catch {} }
  exit $code
}
function IsReparse($item) { return [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint) }
function OwnerOk($p) {
  $sid = (Get-Acl -LiteralPath $p).GetOwner([Security.Principal.SecurityIdentifier]).Value
  return $allowed -contains $sid
}
# Removes a link without following it. Directory junction/symlink -> RemoveDirectory (non-recursive); file symlink -> delete.
function RemoveLink($item) {
  if ($item.PSIsContainer) { [IO.Directory]::Delete($item.FullName, $false) } else { [IO.File]::Delete($item.FullName) }
}
function CheckTree([string]$dir) {
  foreach ($c in Get-ChildItem -LiteralPath $dir -Force) {
    if (IsReparse $c) { Fail 2 'reparse point' $c.FullName }
    if (-not (OwnerOk $c.FullName)) { Fail 3 'unexpected owner' $c.FullName }
    if ($c.PSIsContainer) { CheckTree $c.FullName }
  }
}
function PurgeTree($item) {
  if (IsReparse $item) { RemoveLink $item; return }
  if ($item.PSIsContainer) {
    foreach ($c in Get-ChildItem -LiteralPath $item.FullName -Force) { PurgeTree $c }
    [IO.Directory]::Delete($item.FullName, $false)
  } else {
    $item.Attributes = 'Normal'
    [IO.File]::Delete($item.FullName)
  }
}

try {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if (-not $item) { exit 0 }
  if ($Mode -eq 'Purge') {
    if (IsReparse $item) { RemoveLink $item; exit 0 }
    if (-not $SkipOwner -and -not (OwnerOk $Path)) { Fail 3 'unexpected owner' $Path }
    PurgeTree $item
    exit 0
  }
  if (IsReparse $item) { Fail 2 'reparse point' $Path }
  if (-not $item.PSIsContainer) { Fail 4 'not a directory' $Path }
  if (-not $SkipOwner -and -not (OwnerOk $Path)) { Fail 3 'unexpected owner' $Path }
  if ($Recurse) { CheckTree $Path }
  exit 0
} catch {
  Fail 4 ('error ' + $_.Exception.Message) $Path
}
