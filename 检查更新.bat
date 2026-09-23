@echo off
cd /d "%~dp0"
title TripMALL Data Update

echo ==================================================
echo    TripMALL  DATA UPDATE  (new products + prices)
echo ==================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js first.
  echo.
  pause
  exit /b 1
)

if exist "_ghtoken.txt" goto RUN

echo [First run only] Paste your GitHub token and press Enter.
echo The token is saved locally in _ghtoken.txt on THIS computer only.
echo It is never uploaded to the website.
echo.
set /p TK=
> "_ghtoken.txt" echo %TK%
echo Token saved.
echo.

:RUN
echo Starting update ... a browser window will open.
echo Keep this window open. It takes about 10-20 minutes.
echo You can watch the progress bar on the web page.
echo.

node "tools\update.mjs"

echo.
echo ==================================================
echo    Finished. You can close this window.
echo ==================================================
pause
