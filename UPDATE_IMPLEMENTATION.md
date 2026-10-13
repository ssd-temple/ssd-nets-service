# NETS-Service Update and Persistence Implementation

## Purpose
This document explains the changes made to ensure the kiosk service preserves its configuration and writes logs to a stable local install path. The implementation is designed so that configuration survives new executable installs and update workflows.

## What was changed

### 1. `source/configPath.js`
- Added `LOG_DIRNAME = 'logs'`
- Added `ensureDir(dir)` helper to create directories recursively
- Added `getLogDir()` to return the install log directory and create it if needed
- Added `ensureRuntimeDirs()` to create both config and log directories before the app starts
- Exported `getLogDir` and `ensureRuntimeDirs`

### 2. `source/index.js`
- Called `configUtil.ensureRuntimeDirs()` before `configUtil.syncSdkConfigFile()`
- This creates `C:\ProgramData\KioskService\` and `C:\ProgramData\KioskService\logs` before SDK config sync
- Added `service-start.log` under the log directory for reliable startup logging
- The app now writes one entry during startup: `Service startup beginning.`
- Integrated `source/logger.js` to capture console output and uncaught errors into daily log files

### 3. `source/logger.js`
- Added centralized logging helper for daily log files
- Uses Singapore timezone for timestamps and file names
- Records request/response details, status, durations, and response bodies
- Logs `uncaughtException` and `unhandledRejection` events
- Writes to `YYYY-MM-DD.log` files automatically in the shared log folder

## Where config and logs are stored

### Windows (production)
- Config file: `C:\ProgramData\KioskService\kiosk.netConfig`
- Log directory: `C:\ProgramData\KioskService\logs`
- Startup log file: `C:\ProgramData\KioskService\logs\service-start.log`

### Development
- Config file: `<repo-root>/source/kiosk.netConfig`
- Log directory: `<repo-root>/source/logs`

## How it works

1. On startup, `source/index.js` loads `configPath.js`
2. `ensureRuntimeDirs()` creates the runtime directories for config and logs
3. `syncSdkConfigFile()` ensures the SDK-compatible `config.json` is available next to the executable when needed
4. The service writes a local startup log entry in `service-start.log`
5. Existing config is preserved across executable updates because the config lives outside the installed EXE directory

## Why this matters

- `kiosk.netConfig` is stored in a shared system location, not inside the executable bundle
- When a new version is installed, the existing config file remains intact
- Local logs are stored outside the executable directory so they are not removed or overwritten by new builds
- The current service package therefore becomes safer to update without losing NETS terminal or printer settings

## Implementation details

### Config persistence
- `writeConfig(config)` writes to `C:\ProgramData\KioskService\kiosk.netConfig`
- `updateConfig(data)` merges updated settings into the existing config and rewrites the file
- `syncSdkConfigFile()` generates a local `config.json` copy for SDK compatibility
- `migrateFromLegacyConfig()` migrates old `config.json` to the new `.netConfig` location once

### Logging
- A `logs` folder is created inside the shared install directory
- Daily log files are created in Singapore timezone using the filename `YYYY-MM-DD.log`
- `service-start.log` is still written for startup-specific entries
- Express request/response details are logged with status codes, durations, and optional response bodies
- Console output is captured into the daily log files, and unhandled exceptions are logged automatically

## Files changed
- `source/configPath.js`
- `source/index.js`
- `UPDATE_IMPLEMENTATION.md`

## Notes and next steps

The current changes improve persistence and local log handling in the existing Node service packaging.

To complete the full desktop application update experience, the next step is:
1. Add an Electron-based UI shell
2. Add an update check button and updater flow
3. Publish releases or an update manifest
4. Ensure the desktop app installs the service and configuration in ProgramData

If you want, I can continue by implementing the Electron wrapper and update manifest flow next.
