# Push the Firestore security rules and index policy to Firebase.
#
#   ./deploy/firestore.ps1
#   ./deploy/firestore.ps1 -ProjectId hazehub-8a941
#
# This is the ONLY thing HazeHub deploys to Firebase. The API and web app run
# on your own scouting laptop (run-server.ps1), which is what keeps the
# project on the free Spark plan.
#
# Run it once during setup, and again whenever firestore.rules or
# firestore.indexes.json changes.

[CmdletBinding()]
param([string]$ProjectId = "")

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

if (-not (Get-Command firebase -ErrorAction SilentlyContinue)) {
    throw "firebase CLI not found. Run:  npm install -g firebase-tools"
}

if ($ProjectId) {
    firebase deploy --only firestore --project $ProjectId
} else {
    # Uses the "default" alias from .firebaserc.
    firebase deploy --only firestore
}

Write-Host "`nFirestore rules and index policy deployed." -ForegroundColor Green
Write-Host "Rules deny all client access on purpose — only the HazeHub server," -ForegroundColor DarkGray
Write-Host "using the Admin SDK, reads or writes the database." -ForegroundColor DarkGray
