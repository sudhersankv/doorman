@echo off
cd /d "%~dp0"
if not exist logs mkdir logs
echo === FINAL RUN: reset site memory, bench v1, evolve 4 generations === > logs\final.log
echo (the server must be running: run-server.bat) >> logs\final.log
node scripts\reset-site.js --site trailhead > logs\10-reset.log 2>&1
node src\sim\run.js --split heldout --config 1 --base http://localhost:3000 > logs\11-bench-v1.log 2>&1
node src\harness\evolve.js --site trailhead --generations 4 --base http://localhost:3000 > logs\12-evolve.log 2>&1
echo DONE >> logs\final.log
echo Finished. Open http://localhost:3000/evolution/
pause
