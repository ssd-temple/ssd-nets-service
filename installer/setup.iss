; Packages the unpacked Electron build (electron-builder --win dir) with Inno
; Setup instead of electron-builder's built-in NSIS target. NSIS's generated
; installer shells out through cmd.exe during setup, which Windows Defender's
; Attack Surface Reduction rule "Block untrusted and unsigned processes that
; run from USB" (b2b3f03d-6a65-4f7b-a9c7-1c7ef74a9ba4) blocks for unsigned,
; freshly-downloaded installers. Inno Setup never spawns cmd.exe to do its
; work, so it doesn't trip that rule — the same approach already proven
; across the fleet by the old kioskservice.exe installer (see
; D:\EXE_CODE\source\setup.iss).
;
; AppVersion is passed in at compile time as MyAppVersion (see
; build-installer.ps1, which reads it straight from package.json's "version"
; field). The fallback below only kicks in if someone compiles this file
; directly without going through that script.
#ifndef MyAppVersion
  #define MyAppVersion "0.0.0-unknown (built without build-installer.ps1)"
#endif

#define MyAppName "NETS and Printer Service"
#define MyAppExeName "NETS and Printer Service.exe"
#define MyAppPublisher "Sri Siva Durga Temple"
; Output of `electron-builder --win dir`, per package.json's
; build.directories.output ("D:\PROJECTS\SRI_SIVA_DURGA\SSD_EXE\unpacked" —
; deliberately separate from HEB's own "D:\New_EXE", never overwriting it)
; plus electron-builder's default "win-unpacked" subfolder for an unpacked
; x64 build.
#define ElectronOutDir "D:\PROJECTS\SRI_SIVA_DURGA\SSD_EXE\unpacked\win-unpacked"

[Setup]
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
; Matches the old NSIS config's perMachine:false + allowElevation:true: a
; normal run installs for the current user only (no admin prompt), but
; launching the installer elevated (or passing /ALLUSERS) still works.
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
AllowNoIcons=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=commandline dialog
UsePreviousAppDir=yes
; allowToChangeInstallationDirectory:true in the old NSIS config — leave the
; directory selection page enabled (the default; nothing to set here).
; Final build artifact goes into the SSD-specific output folder — see the
; SSD conversion task's requirement to never overwrite HEB's own build.
OutputDir=D:\PROJECTS\SRI_SIVA_DURGA\SSD_EXE
OutputBaseFilename=SSD_EXE_{#MyAppVersion}_Setup
Compression=lzma2
SolidCompression=yes
; Uses Windows' native Restart Manager to detect/close a running instance
; before copying files — no cmd.exe/taskkill involved.
CloseApplications=yes
RestartApplications=no
SetupIconFile=..\assets\app-icon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
WizardStyle=modern

[Files]
; Entire unpacked Electron app output — the exact same files electron-builder's
; NSIS installer used to package, just installed via Inno Setup instead of
; NSIS. No app code is touched here.
Source: "{#ElectronOutDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop icon"; GroupDescription: "Additional icons:"

[Run]
; ── Legacy NSSM service cleanup ──────────────────────────────────────────────
; Older installs registered a Windows Service called "KioskService" via NSSM.
; That service auto-starts at boot, opens the same COM port this Electron app
; uses, and wins the race — so the Electron app can never open the port until
; the old service is gone. It survives a normal update because the Electron
; installer never knew about it. Kill it here, once, during every install so
; it can never hold the port again. Both commands are best-effort / silent:
; "stop" is a no-op if the service isn't running; "delete" is a no-op if the
; service isn't registered. Neither failing stops the install.
Filename: "sc.exe"; Parameters: "stop KioskService";          Flags: runhidden waituntilterminated; StatusMsg: "Removing legacy KioskService (stop)..."
Filename: "sc.exe"; Parameters: "delete KioskService";        Flags: runhidden waituntilterminated; StatusMsg: "Removing legacy KioskService (delete)..."

; ── Launch app after install ─────────────────────────────────────────────────
; Mirrors the old NSIS runAfterFinish:true behavior.
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent

[Registry]
; The app registers itself to auto-launch at login via Electron's
; app.setLoginItemSettings (see electron/main.js), which writes this Run
; value under the app's package.json "name" ("kioskservice", not the
; product name). Inno's uninstaller only removes what it created itself
; unless told about entries the app created at runtime — without this,
; the login item would silently survive an uninstall.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "kioskservice"; Flags: deletevalue uninsdeletevalue

[UninstallDelete]
; Full cleanup, not just the originally-installed files: the app writes a
; SQLite transactions DB, logs, and other runtime state directly into {app}
; (and the shared config/log directories in ProgramData/LocalAppData — see
; source/configPath.js), none of which Inno's default uninstaller tracks
; since it wasn't part of the [Files] manifest. Removing {app} recursively
; (not just its originally-installed contents) and both possible config
; locations is what actually leaves nothing behind, matching the "clean
; uninstall" the old exe's own clean-uninstall.ps1 did explicitly.
; {app} always resolves to the actual install directory recorded for this
; specific installation, whether that's the default location or a custom
; path typed in during setup — this already removes a customized install
; path correctly, not just the default one.
Type: filesandordirs; Name: "{app}"
; Start Menu program group — Inno normally removes this on its own once
; empty, but being explicit here means it's gone even if something (an
; extra shortcut, a locked file) would otherwise have left it behind.
Type: filesandordirs; Name: "{group}"
Type: filesandordirs; Name: "{commonappdata}\KioskService"
Type: filesandordirs; Name: "{localappdata}\KioskService"
