# HazeHub launcher (Windows / PowerShell)
# Starts the backend (FastAPI) and frontend (Next.js), each in its own window.
#
#   ./start.ps1              # use whatever backend/.env is configured for
#   ./start.ps1 -Emulator    # also start the local Firestore emulator
#
# Datastore resolution (see backend/app/cache.py):
#   FIRESTORE_EMULATOR_HOST set -> the local emulator
#   FIREBASE_PROJECT_ID set     -> real Cloud Firestore
#   neither                     -> a JSON file in backend\data\ (dev only)

param([switch]$Emulator)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

if (-not (Test-Path "$root\backend\.venv")) {
    Write-Host "First run detected - running setup..." -ForegroundColor Yellow
    & "$root\setup.ps1"
}

Write-Host "`nStarting HazeHub..." -ForegroundColor Magenta

if ($Emulator) {
    if (-not (Get-Command firebase -ErrorAction SilentlyContinue)) {
        throw "firebase CLI not found. Run: npm install -g firebase-tools  (needs a JDK 21+)"
    }
    Write-Host "  Firestore emulator -> http://localhost:8080 (UI at :4000)" -ForegroundColor Cyan
    Start-Process powershell -ArgumentList @(
        "-NoExit", "-Command",
        "Set-Location '$root'; firebase emulators:start --only firestore --project hazehub-local"
    )
    $env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080"
    $env:FIREBASE_PROJECT_ID = "hazehub-local"
    Start-Sleep -Seconds 6
}

Write-Host "  Backend  -> http://localhost:8000  (API + docs at /docs)" -ForegroundColor Cyan
Write-Host "  Frontend -> http://localhost:3000" -ForegroundColor Cyan

$prefix = ""
if ($Emulator) {
    $prefix = "`$env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'; `$env:FIREBASE_PROJECT_ID='hazehub-local'; "
}

Start-Process powershell -ArgumentList @(
    "-NoExit", "-Command",
    "Set-Location '$root\backend'; $prefix.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload"
)

Start-Process powershell -ArgumentList @(
    "-NoExit", "-Command",
    "Set-Location '$root\frontend'; npm run dev"
)

Start-Sleep -Seconds 2
Write-Host "`nWindows launched. Open http://localhost:3000 in your browser." -ForegroundColor Green
Write-Host "Sign in with any Scouter ID and the team password ('admin' is privileged)." -ForegroundColor Green
Write-Host "Check http://localhost:8000/api/health to confirm which datastore is in use." -ForegroundColor Green
