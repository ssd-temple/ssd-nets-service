const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  installUpdate: (installer) => ipcRenderer.invoke('install-update', installer),
  hardReload: () => ipcRenderer.invoke('hard-reload'),
  // Returns an unsubscribe function, same pattern as DOM addEventListener.
  onUpdateProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('update-download-progress', listener);
    return () => ipcRenderer.removeListener('update-download-progress', listener);
  },
});
