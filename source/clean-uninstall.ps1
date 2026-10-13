# Fully removes a KioskService install so a fresh install starts from a
# known-clean state. Run as Administrator BEFORE installing a new build,
# especially when comparing "does the new exe work on this machine" across
# multiple test runs.
#
# Usage: powershell -ExecutionPolicy Bypass -File .\clean-uninstall.ps1
# Add -KeepConfig to preserve C:\ProgramData\KioskService (COM port,
# printer, temple settings) instead of wiping it.

param(
    [switch]$KeepConfig
)

$ErrorActionPreference = "Continue"
$installDir = "C:\kiosk\kioskservice"
$programData = "C:\ProgramData\KioskService"
$tempFallback = Join-Path $env:TEMP "KioskService"

Write-Host "=== Cleaning up KioskService ===" -ForegroundColor Cyan

# 1. Stop and remove the service directly (in case the uninstaller isn't run)
$svc = Get-Service -Name KioskService -ErrorAction SilentlyContinue
if ($svc) {
    Write-Host "Stopping KioskService..." -ForegroundColor Yellow
    Stop-Service -Name KioskService -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    $nssm = Join-Path $installDir "nssm.exe"
    if (Test-Path $nssm) {
        & $nssm remove KioskService confirm
    } else {
        sc.exe delete KioskService | Out-Null
    }
    Write-Host "Service removed." -ForegroundColor Green
} else {
    Write-Host "No KioskService service found (already removed)." -ForegroundColor Green
}

# 2. Kill any lingering process (in case it was run manually, not as a service)
Get-Process -Name kioskservice -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "Stopping lingering process (PID $($_.Id))..." -ForegroundColor Yellow
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}

# 3. Remove the install folder
if (Test-Path $installDir) {
    Write-Host "Removing $installDir ..." -ForegroundColor Yellow
    Remove-Item -Path $installDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "Install folder removed." -ForegroundColor Green
} else {
    Write-Host "Install folder not present." -ForegroundColor Green
}

# 4. Remove ProgramData config (unless -KeepConfig)
if (-not $KeepConfig) {
    if (Test-Path $programData) {
        Write-Host "Removing $programData (saved config) ..." -ForegroundColor Yellow
        Remove-Item -Path $programData -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "ProgramData config removed." -ForegroundColor Green
    }
} else {
    Write-Host "Keeping $programData (per -KeepConfig)." -ForegroundColor Cyan
}

# 5. Remove temp fallback extraction location
if (Test-Path $tempFallback) {
    Write-Host "Removing $tempFallback ..." -ForegroundColor Yellow
    Remove-Item -Path $tempFallback -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "Temp fallback removed." -ForegroundColor Green
}

Write-Host "`n=== Done. Reboot recommended before installing the new build. ===" -ForegroundColor Cyan
