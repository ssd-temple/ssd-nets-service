# PowerShell script to add/remove "Restart Kiosk Service" to Windows Context Menu
# Needs to be run as Administrator

param (
    [Parameter(Mandatory=$false)]
    [ValidateSet("install", "uninstall")]
    $Action = "install"
)

$ServiceName = "KioskService"
$RegistryPath = "Registry::HKEY_CLASSES_ROOT\Directory\Background\shell\RestartKioskService"
$RegistryPathDir = "Registry::HKEY_CLASSES_ROOT\Directory\shell\RestartKioskService"

# Detect installation path (assuming script is in scripts/ folder of the app)
$AppPath = Join-Path $PSScriptRoot ".." | Resolve-Path
$NssmPath = Join-Path $AppPath "nssm.exe"
$ExePath = Join-Path $AppPath "kioskservice.exe"

if ($Action -eq "install") {
    if (-not (Test-Path $NssmPath)) {
        Write-Error "nssm.exe not found at $NssmPath. Please run this script from the application folder."
        exit 1
    }

    Write-Host "Installing context menu for $ServiceName..." -ForegroundColor Cyan

    # Build command
    $Command = "powershell.exe -WindowStyle Hidden -Command `"Start-Process '$NssmPath' -ArgumentList 'restart $ServiceName' -Verb RunAs`""

    # Background menu
    if (-not (Test-Path $RegistryPath)) { New-Item -Path $RegistryPath -Force | Out-Null }
    Set-ItemProperty -Path $RegistryPath -Name "(Default)" -Value "Restart Kiosk Service"
    Set-ItemProperty -Path $RegistryPath -Name "Icon" -Value $ExePath
    
    if (-not (Test-Path "$RegistryPath\command")) { New-Item -Path "$RegistryPath\command" -Force | Out-Null }
    Set-ItemProperty -Path "$RegistryPath\command" -Name "(Default)" -Value $Command

    # Directory menu
    if (-not (Test-Path $RegistryPathDir)) { New-Item -Path $RegistryPathDir -Force | Out-Null }
    Set-ItemProperty -Path $RegistryPathDir -Name "(Default)" -Value "Restart Kiosk Service"
    Set-ItemProperty -Path $RegistryPathDir -Name "Icon" -Value $ExePath
    
    if (-not (Test-Path "$RegistryPathDir\command")) { New-Item -Path "$RegistryPathDir\command" -Force | Out-Null }
    Set-ItemProperty -Path "$RegistryPathDir\command" -Name "(Default)" -Value $Command

    Write-Host "✅ Context menu installed successfully!" -ForegroundColor Green
    Write-Host "Right-click on your Desktop or any folder to see 'Restart Kiosk Service'."
}
else {
    Write-Host "Removing context menu entries..." -ForegroundColor Yellow
    if (Test-Path $RegistryPath) { Remove-Item -Path $RegistryPath -Recurse -Force }
    if (Test-Path $RegistryPathDir) { Remove-Item -Path $RegistryPathDir -Recurse -Force }
    Write-Host "✅ Context menu removed." -ForegroundColor Green
}
