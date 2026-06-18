# HazeHub launcher (Windows / PowerShell)
# Opens the backend (FastAPI) and frontend (Next.js) each in their own window.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

if (-not (Test-Path "$root\backend\.venv")) {
    Write-Host "First run detected - running setup..." -ForegroundColor Yellow
    & "$root\setup.ps1"
}

Write-Host "`nStarting HazeHub..." -ForegroundColor Magenta
Write-Host "  Backend  -> http://localhost:8000  (API + docs at /docs)" -ForegroundColor Cyan
Write-Host "  Frontend -> http://localhost:3000" -ForegroundColor Cyan

# Backend
Start-Process powershell -ArgumentList @(
    "-NoExit", "-Command",
    "Set-Location '$root\backend'; .\.venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload"
)

# Frontend
Start-Process powershell -ArgumentList @(
    "-NoExit", "-Command",
    "Set-Location '$root\frontend'; npm run dev"
)

Start-Sleep -Seconds 2
Write-Host "`nTwo windows launched. Open http://localhost:3000 in your browser." -ForegroundColor Green
Write-Host "Sign in: ID 'admin' (or 1/2/3), password 'HazeRain!'." -ForegroundColor Green
