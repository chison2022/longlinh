@echo off
chcp 65001 >nul
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
echo Dang khoi dong lai Long Linh...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Stop-ScheduledTask -TaskName 'LongLinh Bot' -ErrorAction SilentlyContinue; Get-Process LongLinh -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep 3; Start-ScheduledTask -TaskName 'LongLinh Bot'"
echo Xong. Mo "Long Linh - Trang thai" de kiem tra sau ~1 phut.
pause
