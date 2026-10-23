const { contextBridge, ipcRenderer } = require('electron');

let ipcPrefix = '';

function argIpc() {
  try {
    const hit = process.argv.find((a) => a.startsWith('--env-chrome-ipc='));
    if (hit) return hit.split('=').slice(1).join('=');
  } catch { /* */ }
  return '';
}

ipcPrefix = argIpc();

function bindPrefix(prefix) {
  if (prefix) ipcPrefix = prefix;
}

ipcRenderer.on('env-chrome-bind', (_e, prefix) => bindPrefix(prefix));

function invoke(method, ...args) {
  if (!ipcPrefix) return Promise.resolve();
  return ipcRenderer.invoke(`${ipcPrefix}:${method}`, ...args);
}

contextBridge.exposeInMainWorld('envChrome', {
  ready: () => invoke('ready'),
  navigate: (url) => invoke('navigate', url),
  back: () => invoke('back'),
  forward: () => invoke('forward'),
  reload: () => invoke('reload'),
  home: () => invoke('home'),
  newTab: (url) => invoke('new-tab', url),
  switchTab: (id) => invoke('switch-tab', id),
  closeTab: (id) => invoke('close-tab', id),
  openHistory: (url) => invoke('open-history', url),
  clearHistory: () => invoke('clear-history'),
  closeWindow: () => invoke('close-window'),
  onState: (cb) => {
    const handler = (_e, state) => cb(state);
    const listen = () => {
      if (!ipcPrefix) return;
      ipcRenderer.on(`${ipcPrefix}:state`, handler);
    };
    const onBind = (_e, prefix) => {
      bindPrefix(prefix);
      listen();
    };
    ipcRenderer.on('env-chrome-bind', onBind);
    // 主进程实际发送的是 `${ipcPrefix}:bind`
    if (ipcPrefix) {
      ipcRenderer.on(`${ipcPrefix}:bind`, onBind);
    }
    listen();
    return () => ipcRenderer.removeListener(`${ipcPrefix}:state`, handler);
  },
});
