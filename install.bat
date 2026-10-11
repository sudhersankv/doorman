@echo off
cd /d "%~dp0"
call npm install --no-audit --no-fund
call npx playwright install chromium
echo INSTALL DONE
pause
