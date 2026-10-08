# Flatten a Firebase service-account key into the single line Render wants,
# and put it straight on the clipboard.
#
#   ./deploy/render-key.ps1 ~\Downloads\hazehub-8a941-firebase-adminsdk-xxxxx.json
#
# Then paste into Render as the value of  FIREBASE_SERVICE_ACCOUNT.
#
# The downloaded key file is pretty-printed across many lines, and the
# private_key field contains literal \n escapes — pasting that into a web form
# usually mangles it. This collapses it to one valid JSON line.
#
# Nothing is printed to the terminal, so the key does not end up in your shell
# history, your scrollback, or a screen share.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)][string]$KeyFile
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $KeyFile)) {
    throw "No such file: $KeyFile"
}

try {
    $key = Get-Content -Raw -Path $KeyFile | ConvertFrom-Json
} catch {
    throw "That file is not valid JSON. Did you download the service-account key from Firebase console -> Project settings -> Service accounts?"
}

# Sanity-check it is actually a service-account key for the right project,
# before you paste it somewhere and wonder why nothing connects.
foreach ($field in @("type", "project_id", "private_key", "client_email")) {
    if (-not $key.$field) {
        throw "Key file is missing '$field'. This does not look like a service-account key."
    }
}
if ($key.type -ne "service_account") {
    throw "Expected type 'service_account', got '$($key.type)'."
}
if ($key.project_id -ne "hazehub-8a941") {
    Write-Host "Warning: this key is for project '$($key.project_id)', not hazehub-8a941." -ForegroundColor Yellow
}

# -Compress puts it on one line. -Depth guards against silent truncation.
$oneLine = Get-Content -Raw -Path $KeyFile | ConvertFrom-Json | ConvertTo-Json -Compress -Depth 10
Set-Clipboard -Value $oneLine

Write-Host ""
Write-Host "Copied to clipboard." -ForegroundColor Green
Write-Host "  project      : $($key.project_id)"
Write-Host "  service acct : $($key.client_email)"
Write-Host "  key id       : $($key.private_key_id)"
Write-Host "  length       : $($oneLine.Length) characters"
Write-Host ""
Write-Host "Paste it into Render as the value of FIREBASE_SERVICE_ACCOUNT." -ForegroundColor Cyan
Write-Host ""
Write-Host "Then move the .json file out of this repository, or delete it." -ForegroundColor DarkGray
Write-Host "Anyone holding it has full read/write on your database." -ForegroundColor DarkGray
