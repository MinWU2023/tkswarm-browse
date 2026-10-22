const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tkswarmBrowser', {
  onWindowsUpdated: (fn) => {
    ipcRenderer.on('windows-updated', () => fn());
  },
  onTestEnvError: (fn) => {
    ipcRenderer.on('test-env-error', (_event, message) => fn(message));
  },
  apiPort: 54345,
});
