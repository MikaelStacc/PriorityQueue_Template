@echo off
rem Starts the queue server hidden, or restarts it after server.js changes. Output goes to server.log.
rem The Startup folder shortcut runs this at logon. Open the app with the Priority Queue shortcut or start.cmd.
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 4747 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"
start "" conhost.exe --headless cmd /c node "%~dp0server.js" ^>^> "%~dp0server.log" 2^>^&1
