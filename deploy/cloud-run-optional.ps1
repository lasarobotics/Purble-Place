# OPTIONAL — host HazeHub in the cloud instead of on your own laptop.
#
#   ./deploy/cloud-run-optional.ps1 -ProjectId hazehub-8a941
#
# ** YOU DO NOT NEED THIS. ** The normal HazeHub setup runs the server on the
# team's scouting laptop (see run-server.ps1 and instructions.txt) and keeps
# the Firebase project on the free Spark plan.
#
# This script exists for the day you decide you want the app reachable from
# anywhere, with no laptop to set up. It REQUIRES the Blaze (pay-as-you-go)
# plan, because Cloud Run does. Firestore usage still fits inside the
# always-free allowances, so the realistic cost is the Cloud Run instance
# itself — a few dollars a month for an always-warm instance.
#
# It also needs firebase.json to have a hosting block with a Cloud Run
# rewrite, which the Spark-plan config deliberately omits:
#
#   "hosting": {
#     "public": "frontend/out",
#     "rewrites": [
#       { "source": "/api/**", "run": { "serviceId": "hazehub-api", "region": "us-central1" } },
#       { "source": "/ws",     "run": { "serviceId": "hazehub-api", "region": "us-central1" } },
#       { "source": "**", "destination": "/index.html" }
#     ]
#   }
#
# Prerequisites:
#   * Node.js, then:  npm install -g firebase-tools
#   * Google Cloud SDK:  https://cloud.google.com/sdk/docs/install
#   * firebase login   and   gcloud auth login
#   * The project upgraded to Blaze.
#
# Re-run it to ship updates.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ProjectId,
    [string]$Region = "us-central1",
    [string]$ServiceName = "hazehub-api",
    [string]$TeamPassword = "",
    [string]$TbaKey = "",
    [switch]$SkipApi,
    [switch]$SkipHosting
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

Write-Host "HazeHub -> Firebase project '$ProjectId' (region $Region)" -ForegroundColor Magenta

# --- 0. Sanity ---------------------------------------------------------------
foreach ($tool in @("firebase", "gcloud", "npm")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "'$tool' is not on PATH. See instructions.txt, step 1."
    }
}

gcloud config set project $ProjectId | Out-Null
firebase use $ProjectId | Out-Null

# --- 1. Enable the APIs this deployment touches ------------------------------
Write-Host "`n[1/5] Enabling Google Cloud APIs..." -ForegroundColor Cyan
gcloud services enable `
    firestore.googleapis.com `
    run.googleapis.com `
    cloudbuild.googleapis.com `
    artifactregistry.googleapis.com `
    --project $ProjectId

# --- 2. Firestore rules + index policy ---------------------------------------
Write-Host "`n[2/5] Deploying Firestore rules and index exemptions..." -ForegroundColor Cyan
firebase deploy --only firestore --project $ProjectId

# --- 3. The API on Cloud Run --------------------------------------------------
if (-not $SkipApi) {
    Write-Host "`n[3/5] Building and deploying the API to Cloud Run..." -ForegroundColor Cyan

    # --max-instances=1 is REQUIRED, not a cost tweak: the API keeps the event
    # in an in-memory write-through cache and assumes it is the only writer
    # (see backend/app/cache.py). Scale with concurrency, not instances.
    # --min-instances=1 keeps that cache warm, so the one-time load of the
    # working set does not repeat on every cold start.
    $envVars = @(
        "FIREBASE_PROJECT_ID=$ProjectId",
        "FIREBASE_SITE=$ProjectId",
        "HAZEHUB_FIRESTORE_LISTEN=0"
    )
    if ($TeamPassword) { $envVars += "HAZEHUB_TEAM_PASSWORD=$TeamPassword" }
    if ($TbaKey)       { $envVars += "TBA_AUTH_KEY=$TbaKey" }

    gcloud run deploy $ServiceName `
        --source backend `
        --region $Region `
        --platform managed `
        --allow-unauthenticated `
        --min-instances 1 `
        --max-instances 1 `
        --concurrency 80 `
        --cpu 1 --memory 1Gi `
        --timeout 3600 `
        --set-env-vars ($envVars -join ",") `
        --project $ProjectId

    $apiUrl = (gcloud run services describe $ServiceName --region $Region `
        --project $ProjectId --format "value(status.url)")
    Write-Host "  API: $apiUrl" -ForegroundColor Green
}

# --- 4. Frontend static build -------------------------------------------------
if (-not $SkipHosting) {
    Write-Host "`n[4/5] Building the frontend (static export)..." -ForegroundColor Cyan
    Push-Location frontend
    if (-not (Test-Path node_modules)) { npm install }
    # Empty NEXT_PUBLIC_API_URL means "same origin": Firebase Hosting rewrites
    # /api/** and /ws to the Cloud Run service, so there is no CORS and no
    # hard-coded backend URL baked into the bundle.
    $env:NEXT_PUBLIC_API_URL = ""
    $env:HAZEHUB_STATIC_EXPORT = "1"
    npm run build
    Pop-Location

    Write-Host "`n[5/5] Deploying Hosting..." -ForegroundColor Cyan
    firebase deploy --only hosting --project $ProjectId
}

Write-Host "`nDone." -ForegroundColor Green
Write-Host "  App:    https://$ProjectId.web.app"
Write-Host "  Health: https://$ProjectId.web.app/api/health"
Write-Host "  Quota:  https://$ProjectId.web.app/api/admin/firestore-usage  (admin token required)"
