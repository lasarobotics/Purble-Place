# HazeHub launcher (Windows / PowerShell)
# Starts MongoDB, then the backend (FastAPI) and frontend (Next.js) each in
# their own window.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

if (-not (Test-Path "$root\backend\.venv")) {
    Write-Host "First run detected - running setup..." -ForegroundColor Yellow
    & "$root\setup.ps1"
}

Write-Host "`nStarting HazeHub..." -ForegroundColor Magenta
Write-Host "  MongoDB  -> localhost:27017 (docker)" -ForegroundColor Cyan
Write-Host "  Backend  -> http://localhost:8000  (API + docs at /docs)" -ForegroundColor Cyan
Write-Host "  Frontend -> http://localhost:3000" -ForegroundColor Cyan

# MongoDB
Set-Location "$root\backend"
docker compose up -d
Set-Location $root

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
Write-Host "Sign in with any Scouter ID and the team password ('admin' is privileged)." -ForegroundColor Green
