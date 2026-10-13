# Builds kioskservice.exe (pkg) and the Windows installer (Inno Setup) in
# one step, reading the version to stamp everywhere from package.json's
# "version" field — so you only ever set the version in one place.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\build-installer.ps1
#
# To release a new version: edit "version" in package.json, then run this.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$isccPath = "C:\Program Files (x86)\Inno Setup 6\iscc.exe"

$pkgJson = Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json
$version = $pkgJson.version
if (-not $version) {
    throw 'Could not read "version" from package.json'
}
Write-Host "=== Building KioskService v$version ===" -ForegroundColor Cyan

Push-Location $root
try {
    Write-Host "`n[1/2] Building kioskservice.exe with pkg..." -ForegroundColor Yellow
    npx pkg . --targets node18-win-x64 --output kioskservice.exe
    if ($LASTEXITCODE -ne 0) {
        throw "pkg build failed (exit code $LASTEXITCODE)"
    }

    Write-Host "`n[2/2] Building installer with Inno Setup (AppVersion=$version)..." -ForegroundColor Yellow
    if (-not (Test-Path $isccPath)) {
        throw "Inno Setup compiler not found at $isccPath"
    }
    & $isccPath "/DMyAppVersion=$version" (Join-Path $root "setup.iss")
    if ($LASTEXITCODE -ne 0) {
        throw "Inno Setup build failed (exit code $LASTEXITCODE)"
    }

    Write-Host "`n=== Done: KioskService v$version ===" -ForegroundColor Green
    Write-Host "Exe:       $root\kioskservice.exe"
    Write-Host "Installer: see OutputDir/OutputBaseFilename in setup.iss for the exact filename"
} finally {
    Pop-Location
}
