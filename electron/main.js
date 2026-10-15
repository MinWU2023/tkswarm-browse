const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');
const { startServer } = require('../src/server');
const { API_PORT, API_HOST, isDev } = require('../src/config');
const manager = require('../src/browser/manager');

let mainWindow = null;
let tray = null;
let apiServer = null;

async function bootApi() {
  if (apiServer) return apiServer;
  apiServer = await startServer(API_PORT, API_HOST);
  console.log(`[TkSwarm Browser] Local API: http://${API_HOST}:${API_PORT}`);
  return apiServer;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 600,
    title: 'TkSwarm Browser',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../ui/index.html'));
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('TkSwarm Browser');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开控制台', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
}

app.whenReady().then(async () => {
  await bootApi();
  createWindow();
  createTray();

  manager.events.on('window-open', () => mainWindow?.webContents.send('windows-updated'));
  manager.events.on('window-close', () => mainWindow?.webContents.send('windows-updated'));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});

app.on('before-quit', async () => {
  const wins = manager.listWindows();
  for (const w of wins) {
    await manager.closeProfile(w.profileId).catch(() => {});
  }
  apiServer?.server?.close?.();
});
