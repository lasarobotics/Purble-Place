# =============================================================================
# HazeHub -> Azure Container Apps deployment
# =============================================================================
# Prereqs: Azure CLI (az) with the containerapp extension, and an active login:
#   az login
#   az extension add --name containerapp --upgrade
#
# This script provisions everything from scratch:
#   Resource Group -> ACR -> Postgres Flexible Server -> Container Apps Env
#   -> API container app -> Web container app
# Re-running it updates the images in place.
# =============================================================================

$ErrorActionPreference = "Stop"

# ----------------------------- EDIT THESE ------------------------------------
$RG        = "hazehub-rg"
$LOCATION  = "southcentralus"          # close to Texas events
$ACR       = "hazehubacr$(Get-Random -Maximum 9999)"   # must be globally unique
$ENVNAME   = "hazehub-env"
$PGSERVER  = "hazehub-pg$(Get-Random -Maximum 9999)"   # globally unique
$PGUSER    = "hazeadmin"
$PGPASS    = "ChangeMe-$(Get-Random)!"                  # note this down!
$TEAM_PW   = "HazeRain!"
$APP_SECRET = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
# ------------------------------------------------------------------------------

Write-Host "== 1/6 Resource group" -ForegroundColor Magenta
az group create --name $RG --location $LOCATION --output none

Write-Host "== 2/6 Container registry + image builds (in the cloud, no local Docker needed)" -ForegroundColor Magenta
az acr create --resource-group $RG --name $ACR --sku Basic --admin-enabled true --output none
az acr build --registry $ACR --image hazehub-api:latest ./backend

Write-Host "== 3/6 PostgreSQL flexible server" -ForegroundColor Magenta
az postgres flexible-server create `
    --resource-group $RG --name $PGSERVER --location $LOCATION `
    --admin-user $PGUSER --admin-password $PGPASS `
    --sku-name Standard_B1ms --tier Burstable --storage-size 32 `
    --database-name hazehub --public-access 0.0.0.0 --yes --output none
$PGHOST = "$PGSERVER.postgres.database.azure.com"
$DBURL  = "postgresql+psycopg://${PGUSER}:${PGPASS}@${PGHOST}:5432/hazehub?sslmode=require"

Write-Host "== 4/6 Container Apps environment" -ForegroundColor Magenta
az containerapp env create --name $ENVNAME --resource-group $RG --location $LOCATION --output none

Write-Host "== 5/6 API container app" -ForegroundColor Magenta
az containerapp create `
    --name hazehub-api --resource-group $RG --environment $ENVNAME `
    --registry-server "$ACR.azurecr.io" `
    --image "$ACR.azurecr.io/hazehub-api:latest" `
    --target-port 8000 --ingress external `
    --min-replicas 1 --max-replicas 3 `
    --secrets "dburl=$DBURL" "appsecret=$APP_SECRET" `
    --env-vars "DATABASE_URL=secretref:dburl" "HAZEHUB_SECRET=secretref:appsecret" `
               "HAZEHUB_TEAM_PASSWORD=$TEAM_PW" "HAZEHUB_SEASON=2026" `
               "HAZEHUB_HOME_TEAMS=418,436" `
    --output none
$API_FQDN = az containerapp show --name hazehub-api --resource-group $RG --query "properties.configuration.ingress.fqdn" -o tsv
Write-Host "   API live at https://$API_FQDN"

Write-Host "== 6/6 Web container app (built against the live API URL)" -ForegroundColor Magenta
az acr build --registry $ACR --image hazehub-web:latest `
    --build-arg "NEXT_PUBLIC_API_URL=https://$API_FQDN" ./frontend
az containerapp create `
    --name hazehub-web --resource-group $RG --environment $ENVNAME `
    --registry-server "$ACR.azurecr.io" `
    --image "$ACR.azurecr.io/hazehub-web:latest" `
    --target-port 3000 --ingress external `
    --min-replicas 1 --max-replicas 3 `
    --output none
$WEB_FQDN = az containerapp show --name hazehub-web --resource-group $RG --query "properties.configuration.ingress.fqdn" -o tsv

# Allow the web origin through CORS on the API.
az containerapp update --name hazehub-api --resource-group $RG `
    --set-env-vars "HAZEHUB_CORS=https://$WEB_FQDN" --output none

Write-Host ""
Write-Host "=============================================" -ForegroundColor Green
Write-Host " HazeHub is deployed."                          -ForegroundColor Green
Write-Host "   Web:  https://$WEB_FQDN"                     -ForegroundColor Green
Write-Host "   API:  https://$API_FQDN  (docs at /docs)"    -ForegroundColor Green
Write-Host "   PG:   $PGHOST  (user $PGUSER)"               -ForegroundColor Green
Write-Host " Postgres password: $PGPASS"                    -ForegroundColor Yellow
Write-Host " Save that password somewhere safe."            -ForegroundColor Yellow
Write-Host "=============================================" -ForegroundColor Green
