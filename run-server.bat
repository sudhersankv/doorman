@echo off
cd /d "%~dp0"
if not exist logs mkdir logs
title Doorman server
node server.js
pause
