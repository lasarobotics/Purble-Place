# HazeHub one-time setup (Windows / PowerShell)
# Creates the Python venv and installs backend + frontend dependencies.
#
# No database to install: HazeHub stores its data in Cloud Firestore. Until
# you configure a Firebase project (see instructions.txt) it falls back to a
# JSON file in backend\data\ so you can run and click around immediately.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Write-Host "`n=== HazeHub setup ===`n" -ForegroundColor Magenta

# --- Backend ---------------------------------------------------------------
Write-Host "[1/3] Creating Python virtual environment..." -ForegroundColor Cyan
Set-Location "$root\backend"
if (-not (Test-Path ".venv")) {
    if (Get-Command py -ErrorAction SilentlyContinue) { py -m venv .venv } else { python -m venv .venv }
}

Write-Host "[2/3] Installing backend dependencies..." -ForegroundColor Cyan
& ".\.venv\Scripts\python.exe" -m pip install --upgrade pip -q
& ".\.venv\Scripts\python.exe" -m pip install -r requirements-dev.txt -q
if (-not (Test-Path ".env")) { Copy-Item ".env.example" ".env" }

# --- Frontend ----------------------------------------------------------------
Write-Host "[3/3] Installing frontend dependencies..." -ForegroundColor Cyan
Set-Location "$root\frontend"
if (-not (Test-Path ".env.local")) { Copy-Item ".env.local.example" ".env.local" }
npm install --no-audit --no-fund

# --- Demo data ---------------------------------------------------------------
Set-Location "$root\backend"
Write-Host "`nSeeding a demo event so every screen has data..." -ForegroundColor Cyan
& ".\.venv\Scripts\python.exe" -m app.demo_data

Set-Location $root
Write-Host "`nSetup complete! Run .\start.ps1 to launch HazeHub." -ForegroundColor Green
Write-Host "Sign in at http://localhost:3000 with any Scouter ID and the team password." -ForegroundColor Green
Write-Host "`nNext: follow instructions.txt to connect a real Firebase project." -ForegroundColor Yellow
