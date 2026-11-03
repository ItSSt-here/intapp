@echo off
cd /d "%~dp0"
start "intapp-server" cmd /c npx --yes serve -l 5174 .
timeout /t 2 /nobreak >nul
start http://localhost:5174
