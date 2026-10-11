@echo off
cd /d "%~dp0"
if not exist logs mkdir logs
echo Running 3 generations against the server on http://localhost:3000 (keep the server window open)
node src\harness\evolve.js --site trailhead --generations 3 --base http://localhost:3000 > logs\06-evolve.log 2>&1
echo DONE >> logs\06-evolve.log
echo Finished. See logs\06-evolve.log
pause
