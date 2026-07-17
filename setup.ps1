# HazeHub one-time setup (Windows / PowerShell)
# Creates the Python venv, installs backend + frontend deps, starts MongoDB.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Write-Host "`n=== HazeHub setup ===`n" -ForegroundColor Magenta

# --- MongoDB ---------------------------------------------------------------
Write-Host "[1/4] Starting MongoDB (Docker)..." -ForegroundColor Cyan
Set-Location "$root\backend"
docker compose up -d
if ($LASTEXITCODE -ne 0) {
    Write-Host "  Docker unavailable - point MONGODB_URI in backend\.env at your own MongoDB." -ForegroundColor Yellow
}

# --- Backend ---------------------------------------------------------------
Write-Host "[2/4] Creating Python virtual environment..." -ForegroundColor Cyan
if (-not (Test-Path ".venv")) {
    if (Get-Command py -ErrorAction SilentlyContinue) { py -m venv .venv } else { python -m venv .venv }
}
Write-Host "[3/4] Installing backend dependencies + initializing schema..." -ForegroundColor Cyan
& ".\.venv\Scripts\python.exe" -m pip install --upgrade pip -q
& ".\.venv\Scripts\python.exe" -m pip install -r requirements-dev.txt -q
if (-not (Test-Path ".env")) { Copy-Item ".env.example" ".env" }
& ".\.venv\Scripts\python.exe" -m app.database

# --- Frontend ----------------------------------------------------------------
Write-Host "[4/4] Installing frontend dependencies..." -ForegroundColor Cyan
Set-Location "$root\frontend"
if (-not (Test-Path ".env.local")) { Copy-Item ".env.local.example" ".env.local" }
npm install --no-audit --no-fund

Set-Location $root
Write-Host "`nSetup complete! Run .\start.ps1 to launch HazeHub." -ForegroundColor Green
Write-Host "Sign in at http://localhost:3000 with any Scouter ID and the team password." -ForegroundColor Green
