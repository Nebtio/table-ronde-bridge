# Sync the source frontend (../frontend) into public/ (served by the bridge).
# Run before committing any frontend change:  npm run sync-frontend
$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot '..\frontend'
$dst = Join-Path $PSScriptRoot 'public'

if (-not (Test-Path $src)) { Write-Error "Source introuvable: $src"; exit 1 }

New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item (Join-Path $src '*.html') $dst -Force
Copy-Item (Join-Path $src 'Image') $dst -Recurse -Force

Write-Host "[OK] Frontend synchronise: $src -> $dst"
