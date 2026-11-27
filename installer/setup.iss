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
; before copying files — no cmd.exe/taskkill involved. "force" (not "yes"):
; the app's background kioskservice.exe has no window to ask to close, so a
; plain "yes" left it running and a silent in-app update aborted with exit
; code 5 ("files in use"). "force" makes Restart Manager terminate it.
CloseApplications=force
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

[Code]
// ── Why this section exists (v1.0.17) ───────────────────────────────────────
// A client PC reported "The code execution cannot proceed because ffmpeg.dll
// was not found" when starting NETS and Printer Service.exe. The Electron
// exe has a hard load-time dependency on ffmpeg.dll (and the other Chromium
// runtime files below) sitting next to it — if any one is missing, Windows
// refuses to start the app before a single line of our code runs, so the app
// can never repair itself. The installer is the only place that can.
//
// 1. PrepareToInstall: force-close every running copy of the app (the main
//    exe AND its Chromium GPU/utility/renderer child processes, which all
//    share the same exe name) plus the bundled kioskservice.exe BEFORE any
//    file is touched, so no runtime DLL is held open mid-update.
//    Deliberately no "/T" (process tree): the in-app updater's helper script
//    is a child of the app, and /T would kill it too (no relaunch, no retry).
//    taskkill.exe is run directly, never through cmd.exe (same as the sc.exe
//    lines in [Run]) — see the ASR note at the top of this file.
// 2. ssPostInstall: verify every critical runtime file actually landed in
//    {app}. Any that is missing (antivirus quarantine, a file lock, a partial
//    earlier install) is re-extracted from this installer and copied back in.
//    Anything still missing afterwards is logged and, for a normal (non
//    silent) install, explained to the user — usually antivirus.
// Printing and NETS code is not touched by any of this.

const
  CriticalFileCount = 14;

var
  CriticalFiles: array[0..13] of String;

procedure InitCriticalFiles;
begin
  // Paths relative to {app}. Base names are unique within the build, which
  // ExtractTemporaryFile (matches by file name) relies on.
  CriticalFiles[0]  := '{#MyAppExeName}';
  CriticalFiles[1]  := 'ffmpeg.dll';
  CriticalFiles[2]  := 'libEGL.dll';
  CriticalFiles[3]  := 'libGLESv2.dll';
  CriticalFiles[4]  := 'd3dcompiler_47.dll';
  CriticalFiles[5]  := 'vk_swiftshader.dll';
  CriticalFiles[6]  := 'vulkan-1.dll';
  CriticalFiles[7]  := 'icudtl.dat';
  CriticalFiles[8]  := 'resources.pak';
  CriticalFiles[9]  := 'chrome_100_percent.pak';
  CriticalFiles[10] := 'snapshot_blob.bin';
  CriticalFiles[11] := 'v8_context_snapshot.bin';
  CriticalFiles[12] := 'resources\app.asar';
  CriticalFiles[13] := 'resources\app.asar.unpacked\source\kioskservice.exe';
end;

procedure KillProcessByName(const ExeName: String);
var
  ResultCode: Integer;
begin
  // Exit code 128 = "process not found" — the normal case, not an error.
  if Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM "' + ExeName + '"', '',
          SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Log(Format('taskkill /IM "%s" -> exit code %d', [ExeName, ResultCode]))
  else
    Log(Format('taskkill /IM "%s" could not be started', [ExeName]));
end;

procedure CloseRunningApp;
begin
  KillProcessByName('{#MyAppExeName}');
  KillProcessByName('kioskservice.exe');
  // Give Windows a moment to release the file handles / mapped DLLs.
  Sleep(1500);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  CloseRunningApp;
  Result := '';
end;

function RestoreFile(const RelPath: String): Boolean;
var
  DestPath, FileName, TempPath: String;
begin
  DestPath := ExpandConstant('{app}\') + RelPath;
  if FileExists(DestPath) then
  begin
    Result := True;
    exit;
  end;

  Log('Critical file missing after install, restoring: ' + DestPath);
  FileName := ExtractFileName(RelPath);
  try
    ExtractTemporaryFile(FileName);
    TempPath := ExpandConstant('{tmp}\') + FileName;
    ForceDirectories(ExtractFileDir(DestPath));
    if not FileCopy(TempPath, DestPath, False) then
      Log('  FileCopy failed for ' + DestPath);
  except
    Log('  Restore failed for ' + DestPath + ': ' + GetExceptionMessage);
  end;

  Result := FileExists(DestPath);
  if Result then
    Log('  Restored: ' + DestPath)
  else
    Log('  STILL MISSING: ' + DestPath);
end;

procedure VerifyAndRepairInstall;
var
  I: Integer;
  Missing: String;
begin
  InitCriticalFiles;
  Missing := '';
  for I := 0 to CriticalFileCount - 1 do
    if not RestoreFile(CriticalFiles[I]) then
      Missing := Missing + #13#10 + '  ' + CriticalFiles[I];

  if Missing = '' then
  begin
    Log('Install verification passed: all critical runtime files present.');
    exit;
  end;

  Log('Install verification FAILED. Missing:' + Missing);
  if not WizardSilent then
    MsgBox('Some required program files could not be written to:' + #13#10 +
           ExpandConstant('{app}') + #13#10 + Missing + #13#10#13#10 +
           'This is almost always caused by antivirus software removing or blocking them.' + #13#10 +
           'Please add the folder above as an exclusion in the antivirus, then run this installer again.',
           mbError, MB_OK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    VerifyAndRepairInstall;
end;

function InitializeUninstall(): Boolean;
begin
  // Uninstalling while the app runs used to leave locked files behind in a
  // half-deleted folder; any leftover exe then fails with "xxx.dll not found".
  CloseRunningApp;
  Result := True;
end;
