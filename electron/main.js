const { app, BrowserWindow, dialog, ipcMain, session } = require('electron');
const path = require('path');
const { execFile, spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');

// The desktop configuration application owns port 2003. This deliberately
// avoids connecting to legacy KioskService instances still listening on 5200.
let servicePort = 2003;
let serviceProcess = null;
let mainWindow = null;
let isQuitting = false;
let recentServiceRestarts = [];

function getServiceHost() {
  return `http://localhost:${servicePort}`;
}

function normaliseVersion(version) {
  return String(version || '').replace(/^(SSD_EXE|HEB_EXE|NKT)[_-]?/i, '').replace(/^v/i, '');
}

function getExpectedServiceVersion() {
  return require('../source/package.json').version;
}

function safeInstallerName(name) {
  const fallbackName = 'NETS-KioskService-update.exe';
  const filename = path.basename(String(name || fallbackName)).replace(/[^a-zA-Z0-9._-]/g, '_');
  return /\.(exe|msi)$/i.test(filename) ? filename : fallbackName;
}

// Persistent (not per-run-temp) log for the download/install flow, since a
// stuck "Downloading..." with no error has no other way to say what
// actually happened. Fixed location so it doesn't need hunting for.
const UPDATE_LOG_PATH = path.join(app.getPath('userData'), 'update-flow.log');
function logUpdateFlow(message) {
  try {
    fs.appendFileSync(UPDATE_LOG_PATH, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch (err) {
    // best effort — logging must never be why an update fails
  }
}

// If will-download never fires (e.g. the request to the local proxy fails
// before Chromium ever recognizes it as a download), the promise otherwise
// hangs forever with the button stuck on "Downloading...", no error, and
// nothing to diagnose. Bound it so it fails loudly and logs why instead.
const WILL_DOWNLOAD_TIMEOUT_MS = 30000;

// The download/install flow spans several async DownloadItem events, which
// can still fire after this window's webContents is destroyed — e.g. the OS
// restarting mid-download tears the window down while an 'updated' or
// 'done' event is already in flight. webContents.send() on a destroyed
// webContents throws synchronously, and since these are event-listener
// callbacks (not something the outer Promise's own try/catch wraps), that
// throw becomes an uncaught exception in the main process — the "A
// JavaScript error occurred in the main process" dialog. Route every send
// through here instead of calling webContents.send() directly.
function safeSend(wc, channel, payload) {
  try {
    if (wc && !wc.isDestroyed()) {
      wc.send(channel, payload);
    }
  } catch (err) {
    logUpdateFlow(`safeSend failed (webContents likely destroyed): ${err && err.message}`);
  }
}

function downloadAndInstallUpdate(webContents, installer) {
  return new Promise((resolve, reject) => {
    logUpdateFlow(`downloadAndInstallUpdate called. installer=${JSON.stringify(installer)}`);

    let downloadUrl;
    try {
      downloadUrl = new URL(installer && installer.downloadUrl);
    } catch (error) {
      logUpdateFlow(`Invalid download URL: ${error.message}`);
      reject(new Error('The update download URL is invalid.'));
      return;
    }

    // The update-check API points this at its own /api/update/download proxy
    // (same origin as the config page, http://localhost:<port>) rather than
    // GitHub's browser_download_url directly — the update repo is private,
    // so the actual GitHub fetch happens server-side with a token instead.
    // Only that local loopback origin is allowed over plain http; anything
    // else must be https.
    const isLocalProxy = downloadUrl.protocol === 'http:' && (downloadUrl.hostname === 'localhost' || downloadUrl.hostname === '127.0.0.1');
    if ((downloadUrl.protocol !== 'https:' && !isLocalProxy) || !/\.(exe|msi)$/i.test(String(installer && installer.name))) {
      logUpdateFlow(`Rejected: unsupported download URL/installer name. url=${downloadUrl.toString()} name=${installer && installer.name}`);
      reject(new Error('The selected release does not contain a supported Windows installer.'));
      return;
    }

    const targetDir = path.join(app.getPath('temp'), 'NETS-KioskService-updates');
    const targetPath = path.join(targetDir, safeInstallerName(installer.name));
    fs.mkdirSync(targetDir, { recursive: true });

    let settled = false;
    const willDownloadTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      session.defaultSession.removeListener('will-download', onWillDownload);
      logUpdateFlow(`TIMEOUT: will-download never fired within ${WILL_DOWNLOAD_TIMEOUT_MS}ms for ${downloadUrl.toString()}`);
      safeSend(webContents, 'update-download-progress', { phase: 'error', message: 'The download never started. Check your connection and try again.' });
      reject(new Error('The download never started (timed out waiting for it to begin).'));
    }, WILL_DOWNLOAD_TIMEOUT_MS);

    // session.defaultSession.downloadURL() starts a download that isn't tied
    // to any particular renderer's webContents the way a normal in-page
    // download is — the item's reported webContents here never actually
    // equals the window's webContents. Comparing them (as this used to)
    // always failed, so item.setSavePath() below was never reached, and
    // Chromium fell back to showing its native "Save As" picker instead of
    // saving the installer silently — that's the dialog defaulting to a
    // ".json" filename you saw, since the update-check response itself is
    // JSON and nothing here ever told Chromium otherwise. This app only
    // ever has one download in flight at a time via this exact flow, so
    // there's nothing to disambiguate against — just handle it.
    const onWillDownload = (event, item) => {
      clearTimeout(willDownloadTimer);
      session.defaultSession.removeListener('will-download', onWillDownload);
      logUpdateFlow(`will-download fired. filename=${item.getFilename()} totalBytes=${item.getTotalBytes()} mimeType=${item.getMimeType()}`);
      item.setSavePath(targetPath);

      let loggedFirstProgress = false;
      item.on('updated', (_updateEvent, state) => {
        try {
          if (state !== 'progressing' || item.isPaused()) return;
          if (!loggedFirstProgress) {
            loggedFirstProgress = true;
            logUpdateFlow(`First progress event: receivedBytes=${item.getReceivedBytes()} totalBytes=${item.getTotalBytes()}`);
          }
          const totalBytes = item.getTotalBytes();
          const receivedBytes = item.getReceivedBytes();
          safeSend(webContents, 'update-download-progress', {
            phase: 'downloading',
            receivedBytes,
            totalBytes,
            percent: totalBytes > 0 ? Math.round((receivedBytes / totalBytes) * 100) : null,
          });
        } catch (err) {
          logUpdateFlow(`'updated' handler failed: ${err && err.message}`);
        }
      });

      // The system restarting (or the app otherwise quitting) mid-download
      // can destroy this window while 'done' is still pending — wrapped in
      // try/catch so any failure here (a destroyed webContents, a dialog
      // call racing shutdown, etc.) is logged instead of becoming an
      // uncaught exception in the main process.
      item.once('done', async (_event, state) => {
        try {
          logUpdateFlow(`Download done. state=${state} receivedBytes=${item.getReceivedBytes()}`);
          if (settled) return;
          if (state !== 'completed') {
            settled = true;
            safeSend(webContents, 'update-download-progress', { phase: 'error', message: `Download ${state}.` });
            reject(new Error(`The update download ${state}.`));
            return;
          }

          safeSend(webContents, 'update-download-progress', { phase: 'downloaded' });

          if (webContents.isDestroyed()) {
            logUpdateFlow('webContents destroyed before the install-now dialog could show — skipping prompt, update stays downloaded for next launch.');
            settled = true;
            resolve({ started: false, path: targetPath });
            return;
          }

          const window = BrowserWindow.fromWebContents(webContents);
          const choice = await dialog.showMessageBox(window, {
            type: 'question',
            buttons: ['Install now', 'Later'],
            defaultId: 0,
            cancelId: 1,
            title: 'NETS and Printer Service update ready',
            message: 'The update installer has been downloaded.',
            detail: 'Choose Install now to automatically install the update and restart NETS and Printer Service — no further steps required.',
          });
          logUpdateFlow(`Install-now dialog choice: ${choice.response === 0 ? 'Install now' : 'Later'}`);

          if (choice.response !== 0) {
            settled = true;
            safeSend(webContents, 'update-download-progress', { phase: 'idle' });
            resolve({ started: false, path: targetPath });
            return;
          }

          safeSend(webContents, 'update-download-progress', { phase: 'installing' });

          try {
            installSilentlyAndRelaunch(targetPath);
            settled = true;
            resolve({ started: true });
          } catch (error) {
            settled = true;
            logUpdateFlow(`installSilentlyAndRelaunch threw: ${error.message}`);
            safeSend(webContents, 'update-download-progress', { phase: 'error', message: error.message });
            reject(new Error(`Could not start the installer: ${error.message}`));
          }
        } catch (err) {
          settled = true;
          logUpdateFlow(`'done' handler failed: ${err && err.message}`);
          reject(err);
        }
      });
    };

    session.defaultSession.on('will-download', onWillDownload);
    try {
      logUpdateFlow(`Calling session.defaultSession.downloadURL(${downloadUrl.toString()})`);
      session.defaultSession.downloadURL(downloadUrl.toString());
    } catch (error) {
      clearTimeout(willDownloadTimer);
      session.defaultSession.removeListener('will-download', onWillDownload);
      logUpdateFlow(`downloadURL() threw synchronously: ${error.message}`);
      settled = true;
      reject(error);
    }
  });
}

/**
 * Runs the downloaded Inno Setup installer unattended (/VERYSILENT) and
 * relaunches the app once it finishes, so applying an update never requires
 * the user to click through the installer wizard or restart anything
 * themselves.
 *
 * The install itself can't happen while this process is still running —
 * the installer can't overwrite the exe/DLLs the running app has mapped
 * into memory. So this hands off to a small detached helper script that:
 * waits for this process's PID to actually disappear, runs the installer
 * silently, then launches the freshly-installed exe. The script outlives
 * this process (spawned detached + unref'd), which then quits immediately
 * after.
 */
function installSilentlyAndRelaunch(installerPath) {
  const relaunchExePath = app.getPath('exe');
  // The installer is not one-click (a fresh manual run should still ask
  // where to install), which means a plain silent run installs to a fixed
  // default location — NOT necessarily where this build actually lives, if
  // it was ever installed to a custom path. Read the current install
  // directory straight from the running exe (there's nothing more
  // authoritative to "store locally") and force the installer to install
  // there via /DIR=, so an update always lands on top of the existing
  // install instead of silently creating a second copy somewhere else.
  // Unlike NSIS's /D=, Inno Setup's /DIR= takes a normally-quoted value,
  // so a path containing spaces (e.g. "NETS and Printer Service") just
  // needs ordinary quoting.
  const installDir = path.dirname(relaunchExePath);

  // Previously polled `tasklist | find` in a loop to wait for this process's
  // own PID to disappear before installing. That spawns find.exe as a
  // separate console process, and under detached+hidden spawn, Windows can
  // surface it as its own empty, visible console window sitting on stdin
  // forever — the update would silently never progress past it. A fixed
  // delay avoids spawning find.exe at all: this process is small and
  // app.quit() below reliably exits well under a second, so a few seconds'
  // margin is more than enough, and simpler than PID polling that can hang.
  //
  // The installer is invoked directly (not via `start /wait`) — a bare exe
  // line in a .bat already blocks until it exits, and this removes a layer
  // of `start`'s own command-line re-parsing that the quoted, space-containing
  // /DIR= path would otherwise have to survive twice instead of once. Logs
  // each step (and the installer's exit code) to a temp file, since a silent
  // failure here previously left the app just... not reappearing, with no
  // way to tell why.
  const logPath = path.join(app.getPath('temp'), `NETS-updater-log-${Date.now()}.txt`);
  const helperScript = [
    '@echo off',
    `echo [%date% %time%] Updater started. installDir=${installDir} > "${logPath}"`,
    'timeout /t 4 /nobreak >nul',
    `echo [%date% %time%] Running installer: ${installerPath} >> "${logPath}"`,
    `"${installerPath}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR="${installDir}"`,
    `echo [%date% %time%] Installer exit code: %errorlevel% >> "${logPath}"`,
    `if exist "${relaunchExePath}" (`,
    `  echo [%date% %time%] Relaunching: ${relaunchExePath} >> "${logPath}"`,
    `  start "" "${relaunchExePath}"`,
    `  echo [%date% %time%] Relaunch command issued. >> "${logPath}"`,
    `) else (`,
    `  echo [%date% %time%] ERROR: exe not found at expected path after install - install directory may not have applied correctly. >> "${logPath}"`,
    `)`,
  ].join('\r\n');

  const helperPath = path.join(app.getPath('temp'), `NETS-KioskService-updater-${Date.now()}.bat`);
  fs.writeFileSync(helperPath, helperScript, 'utf8');

  const helper = spawn('cmd.exe', ['/c', helperPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  helper.unref();

  // app.on('before-quit') already stops the bundled service child process.
  setTimeout(() => app.quit(), 200);
}

ipcMain.handle('install-update', (event, installer) => downloadAndInstallUpdate(event.sender, installer));

// A plain location.reload() can still serve stale cached assets from
// Chromium's HTTP cache. reloadIgnoringCache() is the actual "hard reload"
// (same as Ctrl+Shift+R in a browser) — only available on webContents, so
// this has to be an IPC round trip rather than something the config page
// can do purely on its own.
ipcMain.handle('hard-reload', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    win.webContents.reloadIgnoringCache();
  }
});

function getPackagedSourcePath(relativePath) {
  if (!app.isPackaged) {
    return path.join(__dirname, '..', relativePath);
  }

  return path.join(process.resourcesPath, 'app.asar.unpacked', relativePath);
}

function getServiceEntryPoint() {
  const serviceExe = getPackagedSourcePath(path.join('source', 'kioskservice.exe'));
  const serviceScript = getPackagedSourcePath(path.join('source', 'index.js'));

  if (fs.existsSync(serviceExe) && process.platform === 'win32') {
    return { command: serviceExe, args: [] };
  }

  return { command: process.execPath, args: [serviceScript] };
}

function startServiceProcess() {
  return new Promise((resolve, reject) => {
    const serviceInfo = getServiceEntryPoint();

    console.log('Starting kiosk service with:', serviceInfo);

    // Reuse an existing service only when it is the same version bundled with
    // this desktop application. A legacy service must not make a newly
    // installed application render its old configuration page.
    isServiceReady().then(async (ready) => {
      if (ready) {
        const runningVersion = await getRunningServiceVersion();
        if (normaliseVersion(runningVersion) === normaliseVersion(getExpectedServiceVersion())) {
          return resolve();
        }

        // Previously this just dodged the mismatched instance by picking the
        // next free port, forever — before-quit already kills any service
        // this app spawned itself, so a stray one here only exists after an
        // abnormal exit (force-killed from Task Manager, a crash) orphaned
        // it. Left running, it burns resources indefinitely and can still be
        // holding the terminal's COM port open, blocking the correct-version
        // instance we're about to start from ever opening it. Ask it to exit
        // and give it a moment to actually release the port before falling
        // back to the old dodge-with-a-new-port behavior if it doesn't.
        console.log(`Legacy or unknown service detected (version=${runningVersion}); shutting it down.`);
        await shutdownLegacyService(servicePort);
        servicePort = await findAvailablePort(servicePort);
        console.log(`Starting bundled service on port ${servicePort}.`);
      }

      const serviceCwd = path.dirname(serviceInfo.command);
      serviceProcess = execFile(serviceInfo.command, serviceInfo.args, {
        cwd: serviceCwd,
        env: { ...process.env, PORT: String(servicePort), port: String(servicePort) },
        windowsHide: true,
      }, (error, stdout, stderr) => {
        if (error) {
          console.error('Service execFile error:', error);
          console.error('Service stdout:', stdout);
          console.error('Service stderr:', stderr);
          return reject(error);
        }

        console.log('Service stdout:', stdout);
        console.log('Service stderr:', stderr);
      });

      serviceProcess.stdout.on('data', (data) => {
        console.log(`[Service] ${data.toString().trim()}`);
      });

      serviceProcess.stderr.on('data', (data) => {
        console.error(`[Service] ${data.toString().trim()}`);
      });

      serviceProcess.on('error', (err) => {
        reject(err);
      });

      serviceProcess.on('exit', (code, signal) => {
        console.log(`Service process exited with code=${code} signal=${signal}`);
        serviceProcess = null;
        if (!isQuitting) {
          handleUnexpectedServiceExit();
        }
      });

      // 45s rather than 15s: right after a fresh reboot, disk I/O, AV
      // on-access scanning of a freshly-installed exe, and the backend's
      // own network-dependent startup work (license validation, now
      // non-blocking but still competing for the same network stack
      // that may not be up yet) can all push a legitimately-successful
      // startup past what a warm launch needs.
      waitForServiceReady(45000)
        .then(resolve)
        .catch(reject);
    }).catch(reject);
  });
}

function stopServiceProcess() {
  if (serviceProcess && !serviceProcess.killed) {
    serviceProcess.kill();
    serviceProcess = null;
  }
}

// The service intentionally exits itself (process.exit) after a terminal
// port/simulation setting is saved, since the bundled nets-service-sdk only
// reads config.json once at startup — see the comment on /api/config/service
// in source/index.js. Bring it back automatically so applying a config
// change never requires the user to manually relaunch the app, and reload
// the window once it's back so the UI doesn't just sit on a dead connection.
// Also covers a genuine crash the same way, but with a cap so a repeatedly
// crashing service doesn't spin forever.
const MAX_RESTARTS_IN_WINDOW = 4;
const RESTART_WINDOW_MS = 30000;
// This delay gates two different situations with the same timer: a genuine
// crash loop (where some breathing room before retrying is actually useful)
// and a deliberate, expected exit right after a Configuration-page save
// (where the process has already cleanly released its port/handles and
// there's nothing to wait out). Was 800ms, tuned for the crash case; the
// crash-loop guard is still MAX_RESTARTS_IN_WINDOW/RESTART_WINDOW_MS above,
// which doesn't depend on this value, so shortening it doesn't weaken that
// protection — it just makes every save-triggered restart feel faster.
const RESTART_DELAY_MS = 150;

function handleUnexpectedServiceExit() {
  const now = Date.now();
  recentServiceRestarts = recentServiceRestarts.filter((t) => now - t < RESTART_WINDOW_MS);
  recentServiceRestarts.push(now);

  if (recentServiceRestarts.length > MAX_RESTARTS_IN_WINDOW) {
    console.error(`Kiosk service exited ${recentServiceRestarts.length} times in ${RESTART_WINDOW_MS / 1000}s — giving up on auto-restart.`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox(
        'NETS and Printer Service stopped',
        'The kiosk service keeps exiting shortly after it starts and has stopped auto-restarting. Please close and reopen NETS and Printer Service, or contact support if this continues.'
      );
    }
    return;
  }

  setTimeout(async () => {
    try {
      console.log('Restarting kiosk service after exit...');
      await startServiceProcess();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(getServiceHost());
      }
    } catch (err) {
      console.error('Failed to restart kiosk service:', err);
    }
  }, RESTART_DELAY_MS);
}

function isServiceReady() {
  return new Promise((resolve) => {
    const req = http.get(`${getServiceHost()}/api/config`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });

    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function getRunningServiceVersion() {
  return new Promise((resolve) => {
    const req = http.get(`${getServiceHost()}/api/version`, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(data.version || null);
        } catch (_) {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

// Best-effort: ask a stray, mismatched-version service to exit via its own
// /api/internal/shutdown (loopback-only — see source/index.js) rather than
// reaching for a PID-based kill. This process didn't spawn that one, so it
// has no PID to kill safely, and shelling out to taskkill/netstat to find one
// reintroduces exactly the "spawns a console process, Defender ASR blocks
// it, or Windows leaves a stray window behind" class of problem the rest of
// this file has deliberately moved away from (see installer/setup.iss and
// the comments on installSilentlyAndRelaunch). If the request fails or the
// old process ignores it, the caller falls back to picking a different port,
// same as before this existed — this only makes the common case (a
// well-behaved orphan) actually go away instead of accumulating forever.
function shutdownLegacyService(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/internal/shutdown', method: 'POST', timeout: 2000 },
      (res) => { res.resume(); }
    );
    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.end();
    // Give the old process a moment to actually release the port before the
    // caller tries to bind it again, independent of how the request itself
    // resolved.
    setTimeout(resolve, 1500);
  });
}

function findAvailablePort(startingPort) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      if (port > startingPort + 20) {
        reject(new Error('Could not find a free local port for NETS and Printer Service.'));
        return;
      }

      const probe = net.createServer();
      probe.once('error', () => tryPort(port + 1));
      probe.once('listening', () => probe.close(() => resolve(port)));
      probe.listen(port, '127.0.0.1');
    };
    tryPort(startingPort);
  });
}

function waitForServiceReady(timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = async () => {
      if (await isServiceReady()) {
        return resolve();
      }
      if (Date.now() - start >= timeoutMs) {
        return reject(new Error('Service did not start within timeout'));
      }
      // Was 500ms — this only controls how quickly we notice the service is
      // back up once it actually is, not how long the service itself takes
      // to boot. 150ms shaves up to 350ms of pure polling latency off every
      // restart without meaningfully increasing request volume (each check
      // is a single tiny localhost GET).
      setTimeout(check, 150);
    };
    check();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
    },
  });

  mainWindow.setTitle(`NETS and Printer Service - SSD_EXE_${app.getVersion()}`);
  mainWindow.loadURL(getServiceHost());
  mainWindow.on('closed', () => {
    // isQuitting must be set BEFORE stopServiceProcess() below, not left to
    // window-all-closed/before-quit to set it moments later. Those normally
    // fire fast enough after this single window closes that the race never
    // shows up — but "normally fast enough" is exactly the kind of
    // unguaranteed timing that already caused the payment-tracking bug
    // fixed in v1.0.8 (see handleTerminalPayment's ordering comment).
    // Without this, if the service child's own 'exit' event happened to
    // fire before window-all-closed/before-quit got to it, its handler
    // would see isQuitting still false and treat a normal window close as
    // an unexpected crash — auto-restarting the backend with no window
    // left to reload it into, so it would come back up invisibly with no
    // UI. That exact symptom (backend silently restarts, nothing else
    // visibly wrong) matches what's been seen in production.
    isQuitting = true;
    mainWindow = null;
    stopServiceProcess();
  });

  // No prior visibility into why the renderer window might disappear on
  // its own — 'closed' above fires the same way whether a user deliberately
  // closed it or Chromium's renderer process crashed/was OOM-killed
  // underneath it, and neither path left any log trace of which one
  // actually happened. Logging these explicitly, in the one place this app
  // already has durable logging (logUpdateFlow), turns "the window vanished
  // and the backend restarted, no idea why" into an actual, checkable
  // reason recorded at the moment it happens — instead of relying on
  // Windows' own crash records, which may log it under a different process
  // name than expected, or not at all.
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    logUpdateFlow(`Renderer process gone: reason=${details.reason} exitCode=${details.exitCode}`);
    console.error(`Renderer process gone: reason=${details.reason} exitCode=${details.exitCode}`);
  });
  mainWindow.webContents.on('unresponsive', () => {
    logUpdateFlow('Renderer became unresponsive.');
  });
  mainWindow.webContents.on('responsive', () => {
    logUpdateFlow('Renderer recovered from being unresponsive.');
  });


  mainWindow.once('ready-to-show', () => {
    // A single attempt can lose a timing race against Windows still
    // settling focus right after the updater's detached process exits, so
    // this fires a few times over ~2.5s instead of just once — each call is
    // cheap/no-op if the window is already in front.
    forceWindowToForeground(mainWindow);
    setTimeout(() => forceWindowToForeground(mainWindow), 800);
    setTimeout(() => forceWindowToForeground(mainWindow), 2500);
  });
}

function forceWindowToForeground(win) {
  if (!win || win.isDestroyed()) return;
  try {
    if (win.isMinimized()) win.restore();
    win.show();
    // Windows blocks background processes (e.g. our detached updater
    // batch script) from stealing foreground focus via a plain
    // show()/focus() call. Toggling always-on-top forces the OS to
    // raise the window anyway, then we release it immediately so it
    // behaves like a normal window afterwards. app.focus({steal:true})
    // and flashFrame are added as extra, cheap belt-and-suspenders cues —
    // if Windows still refuses to raise it, the taskbar icon will at least
    // flash so it's obvious the app did open.
    win.setAlwaysOnTop(true);
    win.focus();
    app.focus({ steal: true });
    win.setAlwaysOnTop(false);
    win.flashFrame(true);
  } catch (err) {
    logUpdateFlow(`forceWindowToForeground failed: ${err && err.message}`);
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    isQuitting = true;
    stopServiceProcess();
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  stopServiceProcess();
});

// Kiosk/POS terminals need this running the moment Windows starts, without
// anyone having to open it by hand after a reboot — so auto-launch at login
// is the default, not an opt-in toggle. Safe to call on every startup:
// Electron only touches the registry Run key when the setting actually
// changes, and this only affects the machine's own current Windows user.
function ensureAutoLaunchOnLogin() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: true,
      path: process.execPath,
    });
  } catch (err) {
    console.error('Failed to configure auto-launch at login:', err);
  }
}

// Checks for a new release once an hour, in the background, without the
// config page needing to be open — the "Check Git Update" button hits the
// same local endpoint, just on demand instead of on a timer.
const AUTO_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const AUTO_UPDATE_FIRST_CHECK_DELAY_MS = 30 * 1000;
let autoUpdateCheckTimer = null;

function fetchUpdateCheck() {
  return new Promise((resolve) => {
    const req = http.get(`${getServiceHost()}/api/update/check`, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
  });
}

async function runAutoUpdateCheck() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const data = await fetchUpdateCheck();
  if (!data || !data.success || !data.updateAvailable || !data.installer) return;

  const latestVersion = data.displayVersion || data.version;
  const choice = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    buttons: ['Install now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update available',
    message: `A new version (${latestVersion}) is available.`,
    detail: 'Choose Install now to automatically download, install, and restart — no further steps required.',
  });

  if (choice.response !== 0) return;

  try {
    await downloadAndInstallUpdate(mainWindow.webContents, data.installer);
  } catch (err) {
    console.error('Auto-update install failed:', err);
    dialog.showErrorBox('Update failed', `Could not install the update: ${err.message}`);
  }
}

function startAutoUpdateChecks() {
  if (autoUpdateCheckTimer) return;
  setTimeout(runAutoUpdateCheck, AUTO_UPDATE_FIRST_CHECK_DELAY_MS);
  autoUpdateCheckTimer = setInterval(runAutoUpdateCheck, AUTO_UPDATE_CHECK_INTERVAL_MS);
}

app.whenReady().then(async () => {
  try {
    ensureAutoLaunchOnLogin();
    await startServiceProcess();
    createWindow();
    startAutoUpdateChecks();
  } catch (err) {
    dialog.showErrorBox('Service startup failed', `Failed to start kiosk service: ${err.message}`);
    app.quit();
  }
});
