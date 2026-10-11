@echo off
cd /d "%~dp0"
if not exist logs mkdir logs
echo === Doorman pipeline (real services) === > logs\pipeline.log
echo [1/6] setup-db >> logs\pipeline.log
call node scripts\setup-db.js > logs\01-setup-db.log 2>&1
echo [2/6] check-services >> logs\pipeline.log
call node scripts\check-services.js > logs\02-check-services.log 2>&1
echo [3/6] goals (LLM paraphrases) >> logs\pipeline.log
call node src\sim\goals.js > logs\03-goals.log 2>&1
echo [4/6] server >> logs\pipeline.log
start "Doorman server" cmd /c "node server.js > logs\04-server.log 2>&1"
timeout /t 4 /nobreak > nul
echo [5/6] bench v1 heldout >> logs\pipeline.log
call node src\sim\run.js --split heldout --config 1 --base http://localhost:3000 > logs\05-bench-v1.log 2>&1
echo [6/6] evolve 3 generations >> logs\pipeline.log
call node src\harness\evolve.js --site trailhead --generations 3 > logs\06-evolve.log 2>&1
echo DONE >> logs\pipeline.log
echo.
echo Pipeline finished. Logs are in the logs folder. The server window stays open for the demo.
pause
