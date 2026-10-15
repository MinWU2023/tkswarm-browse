const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tkswarmBrowser', {
  onWindowsUpdated: (fn) => {
    ipcRenderer.on('windows-updated', () => fn());
  },
  apiPort: 54345,
});
