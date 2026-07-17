@echo off
setlocal

set "ROOT=%~dp0"

if not exist "%ROOT%backend\.venv" (
    echo First run detected - running setup...
    powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%setup.ps1"
)

echo.
echo Starting HazeHub...
echo   Backend  -> http://localhost:8000  (API + docs at /docs)
echo   Frontend -> http://localhost:3000

echo.

start "HazeHub Backend" cmd /k "cd /d "%ROOT%backend" && .venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload"
start "HazeHub Frontend" cmd /k "cd /d "%ROOT%frontend" && npm run dev"

timeout /t 2 >nul

echo Two windows launched. Open http://localhost:3000 in your browser.
echo Sign in: ID 'admin' (or 1/2/3), password 'HazeRain!'.

endlocal
