# HazeHub event-day server (Windows / PowerShell)
#
# Run this on the ONE laptop that acts as the scouting server. It serves both
# the web app and the API from a single process on port 8000, and syncs
# everything to Cloud Firestore.
#
#   ./run-server.ps1                    # normal event day
#   ./run-server.ps1 -Rebuild           # rebuild the web app first
#   ./run-server.ps1 -Port 8080
#   ./run-server.ps1 -OpenFirewall      # allow tablets through Windows Firewall
#
# Everyone else just opens  http://<this-laptop-ip>:8000  on the same wifi.
#
# Why this instead of Cloud Run: hosting the API on your own machine is what
# keeps the Firebase project on the free Spark plan. Firestore is still the
# database — this laptop is only the server.

[CmdletBinding()]
param(
    [int]$Port = 8000,
    [switch]$Rebuild,
    [switch]$OpenFirewall,
    [switch]$Emulator
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$python = Join-Path $root "backend\.venv\Scripts\python.exe"

if (-not (Test-Path $python)) {
    Write-Host "First run detected - running setup..." -ForegroundColor Yellow
    & "$root\setup.ps1"
}

# --- 1. Build the web app so the API can serve it -----------------------------
$webDir = Join-Path $root "frontend\out"
if ($Rebuild -or -not (Test-Path (Join-Path $webDir "index.html"))) {
    Write-Host "`n[1/3] Building the web app..." -ForegroundColor Cyan
    Push-Location (Join-Path $root "frontend")
    if (-not (Test-Path node_modules)) { npm install --no-audit --no-fund }
    # Empty = same origin. The API serves these files, so the browser talks to
    # whatever host it loaded the page from — no hard-coded IP to update when
    # the laptop lands on a different address at the next event.
    $env:NEXT_PUBLIC_API_URL = ""
    $env:HAZEHUB_STATIC_EXPORT = "1"
    npm run build
    Pop-Location
} else {
    Write-Host "`n[1/3] Web app already built (use -Rebuild to force)." -ForegroundColor Cyan
}

# --- 2. Firewall + address ----------------------------------------------------
Write-Host "[2/3] Working out how tablets should reach this laptop..." -ForegroundColor Cyan

if ($OpenFirewall) {
    $ruleName = "HazeHub $Port"
    if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
        Write-Host "  Adding a Windows Firewall rule (needs Administrator)..." -ForegroundColor Yellow
        New-NetFirewallRule -DisplayName $ruleName -Direction Inbound `
            -Action Allow -Protocol TCP -LocalPort $Port -Profile Private | Out-Null
    }
    Write-Host "  Firewall rule '$ruleName' is in place." -ForegroundColor Green
}

$addresses = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
    Select-Object -ExpandProperty IPAddress

# --- 3. Run -------------------------------------------------------------------
Write-Host "[3/3] Starting HazeHub..." -ForegroundColor Cyan
Write-Host ""
Write-Host "  On this laptop:  http://localhost:$Port" -ForegroundColor Green
foreach ($ip in $addresses) {
    Write-Host "  On the tablets:  http://${ip}:$Port" -ForegroundColor Green
}
Write-Host ""
Write-Host "  Health check:    http://localhost:$Port/api/health" -ForegroundColor DarkGray
Write-Host "  Firestore usage: Admin -> System" -ForegroundColor DarkGray
Write-Host "  Stop with Ctrl+C. Nothing is lost: every submission is already"  -ForegroundColor DarkGray
Write-Host "  in Firestore, and each tablet keeps its own IndexedDB copy."     -ForegroundColor DarkGray
Write-Host ""

Set-Location (Join-Path $root "backend")

if ($Emulator) {
    $env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080"
    $env:FIREBASE_PROJECT_ID = "hazehub-local"
    Write-Host "  (using the local Firestore emulator)" -ForegroundColor Yellow
}

# One worker on purpose: the in-memory read cache is authoritative and assumes
# a single writer (see backend/app/cache.py). One process handles 60 people
# comfortably; do not add --workers.
& $python -m uvicorn app.main:app --host 0.0.0.0 --port $Port --workers 1 --timeout-keep-alive 75
