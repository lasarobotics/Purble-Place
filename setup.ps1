# HazeHub one-time setup (Windows / PowerShell)
# Creates the Python venv, installs backend + frontend deps, seeds demo data.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Write-Host "`n=== HazeHub setup ===`n" -ForegroundColor Magenta

# --- Backend -------------------------------------------------------------
Write-Host "[1/4] Creating Python virtual environment..." -ForegroundColor Cyan
Set-Location "$root\backend"
if (-not (Test-Path ".venv")) {
    if (Get-Command py -ErrorAction SilentlyContinue) { py -m venv .venv } else { python -m venv .venv }
}
Write-Host "[2/4] Installing backend dependencies..." -ForegroundColor Cyan
& ".\.venv\Scripts\python.exe" -m pip install --upgrade pip -q
& ".\.venv\Scripts\python.exe" -m pip install -r requirements.txt -q
if (-not (Test-Path ".env")) { Copy-Item ".env.example" ".env" }

Write-Host "[3/4] Seeding a demo event (12 teams, 18 matches)..." -ForegroundColor Cyan
& ".\.venv\Scripts\python.exe" -m app.demo_data

# --- Frontend ------------------------------------------------------------
Write-Host "[4/4] Installing frontend dependencies..." -ForegroundColor Cyan
Set-Location "$root\frontend"
if (-not (Test-Path ".env.local")) { Copy-Item ".env.local.example" ".env.local" }
npm install --no-audit --no-fund

Set-Location $root
Write-Host "`nSetup complete! Run .\start.ps1 to launch HazeHub." -ForegroundColor Green
Write-Host "Sign in at http://localhost:3000 with ID 'admin' (or 1/2/3) and password 'HazeRain!'" -ForegroundColor Green
