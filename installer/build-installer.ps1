# Builds the unpacked Electron app (electron-builder --win dir) and wraps it
# with Inno Setup, replacing electron-builder's built-in NSIS installer —
# which was tripping Windows Defender ASR rule b2b3f03d ("Block untrusted
# and unsigned processes that run from USB") by shelling out through
# cmd.exe during setup. Inno Setup never does that (same approach already
# proven across the fleet by the old kioskservice.exe installer at
# D:\EXE_CODE\source\build-installer.ps1).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\installer\build-installer.ps1
#   powershell -ExecutionPolicy Bypass -File .\installer\build-installer.ps1 -CertThumbprint <thumbprint>
#   powershell -ExecutionPolicy Bypass -File .\installer\build-installer.ps1 -CertPfxPath C:\path\to\cert.pfx -CertPfxPassword (Read-Host -AsSecureString)
#
# To release a new version: edit "version" in package.json, then run this.
#
# Code signing (optional, off by default): pass -CertThumbprint (cert already
# installed in the Windows certificate store — the normal case for an EV
# cert on a hardware token) or -CertPfxPath/-CertPfxPassword (a .pfx file, the
# normal case for an OV cert). Neither given -> the build proceeds unsigned,
# exactly as before. Once signing is wired in, this is what actually resolves
# the ASR "prevalence, age, or trusted list" rule blocking the app on some
# locked-down machines — no such rule can be satisfied by anything else this
# script does, only by a real certificate from a trusted CA.

param(
    [string]$CertThumbprint,
    [string]$CertPfxPath,
    [securestring]$CertPfxPassword,
    [string]$TimestampUrl = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$isccPath = "C:\Program Files (x86)\Inno Setup 6\iscc.exe"
$signToolPath = Get-Command signtool.exe -ErrorAction SilentlyContinue
$signingConfigured = [bool]$CertThumbprint -or [bool]$CertPfxPath

function Invoke-CodeSign {
    param([Parameter(Mandatory)][string]$Path)

    if (-not $signingConfigured) {
        return
    }
    if (-not $signToolPath) {
        Write-Warning "signtool.exe not found on PATH (install the Windows SDK) — skipping signing of $Path"
        return
    }
    if (-not (Test-Path $Path)) {
        throw "Cannot sign — file not found: $Path"
    }

    $signArgs = @("sign", "/fd", "SHA256", "/tr", $TimestampUrl, "/td", "SHA256")
    if ($CertThumbprint) {
        $signArgs += @("/sha1", $CertThumbprint)
    } else {
        $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [Runtime.InteropServices.Marshal]::SecureStringToBSTR($CertPfxPassword)
        )
        $signArgs += @("/f", $CertPfxPath, "/p", $plainPassword)
    }
    $signArgs += $Path

    Write-Host "  Signing: $Path" -ForegroundColor DarkCyan
    & signtool.exe @signArgs
    if ($LASTEXITCODE -ne 0) {
        throw "signtool failed on $Path (exit code $LASTEXITCODE)"
    }
}

if (-not $signingConfigured) {
    Write-Host "No certificate supplied (-CertThumbprint or -CertPfxPath) — building unsigned, as before." -ForegroundColor Yellow
}

$pkgJson = Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json
$version = $pkgJson.version
if (-not $version) {
    throw 'Could not read "version" from package.json'
}
Write-Host "=== Building NETS and Printer Service v$version ===" -ForegroundColor Cyan

# The running service reports its OWN version from source/package.json (see
# source/index.js: `require("./package.json").version`, used by the
# /api/version and /api/config endpoints that feed the UI's version badge),
# completely independent of the root package.json read above. Before this
# sync, a release only ever bumped the root file: the installer filename and
# Inno Setup's AppVersion (both driven by $version) correctly advanced, but
# the app's own UI kept reporting whatever version source/package.json last
# had, since nothing copied the new number into the file it actually reads
# at runtime. Explicit UTF8 (no BOM) read/write — Windows PowerShell's
# default Get-Content/Out-File encoding has corrupted source files before.
$sourcePkgPath = Join-Path $root "source\package.json"
$sourcePkgRaw = [System.IO.File]::ReadAllText($sourcePkgPath, [System.Text.Encoding]::UTF8)
$sourcePkgJson = $sourcePkgRaw | ConvertFrom-Json
if ($sourcePkgJson.version -ne $version) {
    Write-Host "Syncing source/package.json version: $($sourcePkgJson.version) -> $version" -ForegroundColor Yellow
    $sourcePkgJson.version = $version
    $updatedSourcePkg = $sourcePkgJson | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($sourcePkgPath, $updatedSourcePkg, (New-Object System.Text.UTF8Encoding($false)))
} else {
    Write-Host "source/package.json already at v$version — no sync needed." -ForegroundColor DarkGray
}

Push-Location $root
try {
    # kioskservice.exe is a pkg-compiled standalone snapshot (see
    # source/package.json's "pkg" config) - it bundles source/index.js and
    # source/package.json AT COMPILE TIME, not at run time. electron-builder
    # below only COPIES whatever source/kioskservice.exe already exists on
    # disk into the installer; it never recompiles it. Before this step
    # existed, that meant the binary actually answering /api/version at
    # runtime was whatever pkg snapshot happened to be sitting in source/
    # from its last manual build - in practice this had gone stale since the
    # Electron wrapper was introduced, so the UI's version badge kept
    # reporting an old version no matter how many times $version above was
    # bumped and the installer rebuilt. Rebuilding it here, every release,
    # from the (now version-synced) source/ folder is what actually fixes
    # that permanently, matching the old standalone build pipeline at
    # source/build-installer.ps1's own "npx pkg . --targets node18-win-x64
    # --output kioskservice.exe" step.
    Write-Host "`n[1/3] Building kioskservice.exe with pkg (v$version)..." -ForegroundColor Yellow
    Push-Location (Join-Path $root "source")
    try {
        npx pkg . --targets node18-win-x64 --output kioskservice.exe
        if ($LASTEXITCODE -ne 0) {
            throw "pkg build failed (exit code $LASTEXITCODE)"
        }
    } finally {
        Pop-Location
    }

    Write-Host "`n[2/3] Building unpacked Electron app (electron-builder --win dir)..." -ForegroundColor Yellow
    npx electron-builder --win dir
    if ($LASTEXITCODE -ne 0) {
        throw "electron-builder build failed (exit code $LASTEXITCODE)"
    }

    # Sign the actual binaries before they're packaged into the installer —
    # both the Electron app shell and the bundled backend service exe, since
    # either running unsigned is enough to trip prevalence/trust-based
    # blocking. Matches the output paths in installer/setup.iss and
    # package.json's build.directories.output (SSD's own build folder, kept
    # separate from HEB's D:\New_EXE).
    Invoke-CodeSign "D:\PROJECTS\SRI_SIVA_DURGA\SSD_EXE\unpacked\win-unpacked\NETS and Printer Service.exe"
    Invoke-CodeSign "D:\PROJECTS\SRI_SIVA_DURGA\SSD_EXE\unpacked\win-unpacked\resources\app.asar.unpacked\source\kioskservice.exe"

    # A brief pause here avoids a race seen in practice: running iscc
    # immediately after electron-builder returns can fail partway through
    # ("The system cannot find the file specified") on one of the ~150 just-
    # written files, most likely real-time antivirus scanning briefly
    # locking a freshly-written file right as Inno tries to read it. Running
    # the two steps back-to-back with no gap reproduced this; a short delay
    # (or simply running them as two separate invocations) did not.
    Start-Sleep -Seconds 5

    Write-Host "`n[3/3] Building installer with Inno Setup (AppVersion=$version)..." -ForegroundColor Yellow
    if (-not (Test-Path $isccPath)) {
        throw "Inno Setup compiler not found at $isccPath"
    }
    & $isccPath "/DMyAppVersion=$version" (Join-Path $root "installer\setup.iss")
    if ($LASTEXITCODE -ne 0) {
        throw "Inno Setup build failed (exit code $LASTEXITCODE)"
    }

    # And sign the installer stub itself — matches OutputDir/OutputBaseFilename
    # in installer/setup.iss.
    Invoke-CodeSign "D:\PROJECTS\SRI_SIVA_DURGA\SSD_EXE\SSD_EXE_${version}_Setup.exe"

    Write-Host "`n=== Done: NETS and Printer Service v$version ===" -ForegroundColor Green
    Write-Host "Installer: see OutputDir/OutputBaseFilename in installer\setup.iss for the exact filename"
} finally {
    Pop-Location
}
