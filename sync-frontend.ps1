# Synchronise le frontend source (../frontend) vers public/ (servi par le bridge).
# À lancer avant chaque commit qui touche au front :  ./sync-frontend.ps1
$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot '..\frontend'
$dst = Join-Path $PSScriptRoot 'public'

if (-not (Test-Path $src)) { Write-Error "Source introuvable : $src"; exit 1 }

New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item (Join-Path $src 'index.html') $dst -Force
Copy-Item (Join-Path $src 'Image') $dst -Recurse -Force

Write-Host "✓ Frontend synchronisé : $src -> $dst"
