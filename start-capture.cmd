@echo off
REM Manual fallback launcher for the CDN capture tools.
REM Runs the dump watcher plus dedicated Frida sessions for tray service,
REM editor, and launcher using fixed control ports and log files.

setlocal
set "REPO=%~dp0"
cd /d "%REPO%"

echo Starting background capture tools from %REPO%
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
	"$repo = (Resolve-Path '%REPO%').Path;" ^
	"function Stop-FridaPort($port) {" ^
	"  $listeners = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue;" ^
	"  foreach ($listener in $listeners) {" ^
	"    $proc = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue;" ^
	"    if ($proc -and $proc.ProcessName -eq 'node') { Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue; }" ^
	"  }" ^
	"}" ^
	"function Start-Frida($port, $processName, $logName) {" ^
	"  $cmd = 'set FRIDA_CTL_PORT=' + $port + '&& node tools\\frida-attach.mjs --process ' + $processName + ' --log log\\' + $logName;" ^
	"  Start-Process -FilePath cmd.exe -WorkingDirectory $repo -ArgumentList @('/c', $cmd) -WindowStyle Hidden;" ^
	"}" ^
	"Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'watch-debug-dump\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue };" ^
	"39315,39316,39317 | ForEach-Object { Stop-FridaPort $_ };" ^
	"Start-Process -FilePath node -WorkingDirectory $repo -ArgumentList @('tools/watch-debug-dump.mjs','--json','log/dump-watch.jsonl') -WindowStyle Hidden;" ^
	"Start-Frida 39315 'qrmbtrayservicex64.exe' 'frida-cdn-bundlewatch.jsonl';" ^
	"Start-Frida 39316 'qseasuneditorx64.exe' 'frida-cdn-bundlewatch-editor.jsonl';" ^
	"Start-Frida 39317 'SeasunLauncher.exe' 'frida-cdn-bundlewatch-launcher.jsonl'"
if errorlevel 1 (
	echo Failed to start one or more background capture jobs.
	echo.
	pause
	endlocal
	exit /b 1
)

echo Background capture requested.
echo Control ports: 39315 tray, 39316 editor, 39317 launcher
echo Logs:
echo   log\frida-cdn-bundlewatch.jsonl
echo   log\frida-cdn-bundlewatch-editor.jsonl
echo   log\frida-cdn-bundlewatch-launcher.jsonl
echo.
echo Open http://localhost:3015/cdn-download.html and press Refresh.
echo.
pause
endlocal
