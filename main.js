const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');

const SERVICE_PORT = process.env.SERVICE_PORT || 5200;
const SERVICE_HOST = `http://localhost:${SERVICE_PORT}`;
let serviceProcess = null;

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

    // If service is already running, skip launch
    isServiceReady().then((ready) => {
      if (ready) {
        return resolve();
      }

      serviceProcess = spawn(serviceInfo.command, serviceInfo.args, {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: SERVICE_PORT },
        windowsHide: true,
        shell: false,
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
      });

      waitForServiceReady(15000)
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

function isServiceReady() {
  return new Promise((resolve) => {
    const req = http.get(`${SERVICE_HOST}/api/config`, (res) => {
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
      setTimeout(check, 500);
    };
    check();
  });
}

function createWindow() {
  const mainWindow = new BrowserWindow({
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

  mainWindow.loadURL(SERVICE_HOST);
  mainWindow.on('closed', () => {
    stopServiceProcess();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    stopServiceProcess();
    app.quit();
  }
});

app.on('before-quit', () => {
  stopServiceProcess();
});

app.whenReady().then(async () => {
  try {
    await startServiceProcess();
    createWindow();
  } catch (err) {
    dialog.showErrorBox('Service startup failed', `Failed to start kiosk service: ${err.message}`);
    app.quit();
  }
});
