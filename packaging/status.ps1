$dir = Split-Path -Parent $PSScriptRoot
[Console]::OutputEncoding = [Text.Encoding]::UTF8
# The .env is readable by admins/LocalService only; the installer writes the (non-secret) port to port.txt for everybody.
$port = 3000
try {
  $p = (Get-Content -LiteralPath (Join-Path $dir 'port.txt') -TotalCount 1 -ErrorAction Stop).Trim()
  if ($p -match '^\d{1,5}$') { $port = [int]$p }
} catch {}
Write-Host "=== Long Linh - Trạng thái ===" -ForegroundColor Cyan
# Only trust /health when the process listening on 127.0.0.1:<port> really is LongLinh.exe (another program could hold the port).
$listener = $null
try {
  $all = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop)
  # the bot binds 127.0.0.1; a listener on the wildcard address (0.0.0.0 / ::) that is not LongLinh also counts as "port taken"
  $listener = $all | Where-Object { $_.LocalAddress -eq '127.0.0.1' } | Select-Object -First 1
  if (-not $listener) { $listener = $all | Select-Object -First 1 }
} catch {}
if (-not $listener) {
  Write-Host "Không có chương trình nào đang lắng nghe 127.0.0.1:$port (bot chưa chạy hoặc đang khởi động)" -ForegroundColor Yellow
} else {
  $owner = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
  if (-not $owner -or $owner.Name -ne 'LongLinh') {
    $who = if ($owner) { $owner.Name } else { "PID $($listener.OwningProcess)" }
    Write-Host "Cổng $port bị chương trình khác chiếm ($who), không phải Long Linh. Không kiểm tra /health." -ForegroundColor Red
  } else {
    try {
      $h = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 5
      Write-Host ("Health: ok={0} db={1} bot={2}" -f $h.ok, $h.db, $h.bot)
      if ($h.ok) { Write-Host "BOT ĐANG CHẠY TỐT" -ForegroundColor Green } else { Write-Host "Bot chưa sẵn sàng (đang kết nối?)" -ForegroundColor Yellow }
    } catch { Write-Host "Không gọi được http://127.0.0.1:$port/health (bot đang kết nối database?)" -ForegroundColor Yellow }
  }
}
$t = Get-ScheduledTask -TaskName 'LongLinh Bot' -ErrorAction SilentlyContinue
if ($t) { $i = Get-ScheduledTaskInfo -TaskName 'LongLinh Bot'; Write-Host ("Task: {0}, lần chạy cuối: {1}, kết quả: {2}" -f $t.State, $i.LastRunTime, $i.LastTaskResult) } else { Write-Host "Chưa có task 'LongLinh Bot'" -ForegroundColor Red }
Write-Host "`n--- 40 dòng log cuối ---"
$log = Join-Path $env:ProgramData 'LongLinh\logs\longlinh.log'
if (Test-Path $log) { Get-Content $log -Tail 40 -Encoding UTF8 } else { Write-Host "(chưa có log)" }
