@echo off
cd /d "%~dp0"
REM One-click Fly.io deploy. Uses the Fly token from D:\kevin\FLY_API_TOKEN.txt and secrets from .env (never committed).
set /p FLY_API_TOKEN=<..\kevin\FLY_API_TOKEN.txt
REM token is "FlyV1 fm2_..." - the space is part of it; do not strip it
echo Checking fly CLI...
fly version || (echo fly CLI not found. Install from https://fly.io/docs/flyctl/install/ && pause && exit /b 1)
echo Creating app (ignore "already exists")...
fly apps create doorman-trailhead 2>nul
echo Setting secrets from .env ...
for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
  if not "%%B"=="" (
    if /i "%%A"=="MONGODB_URI" fly secrets set --stage -a doorman-trailhead "MONGODB_URI=%%B"
    if /i "%%A"=="VOYAGE_API_KEY" fly secrets set --stage -a doorman-trailhead "VOYAGE_API_KEY=%%B"
    if /i "%%A"=="VOYAGE_BASE_URL" fly secrets set --stage -a doorman-trailhead "VOYAGE_BASE_URL=%%B"
    if /i "%%A"=="VOYAGE_MODEL" fly secrets set --stage -a doorman-trailhead "VOYAGE_MODEL=%%B"
    if /i "%%A"=="VOYAGE_DIMS" fly secrets set --stage -a doorman-trailhead "VOYAGE_DIMS=%%B"
    if /i "%%A"=="JEV_API_KEY" fly secrets set --stage -a doorman-trailhead "JEV_API_KEY=%%B"
    if /i "%%A"=="JEV_API_URL" fly secrets set --stage -a doorman-trailhead "JEV_API_URL=%%B"
    if /i "%%A"=="JEV_MODEL" fly secrets set --stage -a doorman-trailhead "JEV_MODEL=%%B"
    if /i "%%A"=="NEON_AI_GATEWAY_BASE_URL" fly secrets set --stage -a doorman-trailhead "NEON_AI_GATEWAY_BASE_URL=%%B"
    if /i "%%A"=="NEON_AI_GATEWAY_TOKEN" fly secrets set --stage -a doorman-trailhead "NEON_AI_GATEWAY_TOKEN=%%B"
    if /i "%%A"=="NEON_MODEL" fly secrets set --stage -a doorman-trailhead "NEON_MODEL=%%B"
  )
)
echo Deploying...
fly deploy -a doorman-trailhead --ha=false
echo.
echo If this succeeded, the site is at https://doorman-trailhead.fly.dev/shop/
fly status -a doorman-trailhead
pause
