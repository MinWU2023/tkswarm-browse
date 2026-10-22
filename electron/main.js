const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');

/**
 * 同一个 exe 有两种角色：
 *  1) 控制台进程（默认）：起本地 API + 管理窗口 UI
 *  2) 环境窗口进程（`--tkswarm-env`）：由控制台拉起，只承载一个浏览器环境
 * 环境进程必须在 ready 之前设置自己的 userData，且绝不能启动 API（端口会冲突）。
 */
const IS_ENV_PROCESS = process.argv.includes('--tkswarm-env');

if (IS_ENV_PROCESS) {
  // 环境窗口：独立 Profile + 独立 CDP 端口
  require('../src/browser/env-window');
} else {
  const { startServer } = require('../src/server');
  const { API_PORT, API_HOST, isDev } = require('../src/config');
  const manager = require('../src/browser/manager');
  const { resolveEngine } = require('../src/browser/engine');

  let mainWindow = null;
  let tray = null;
  let apiServer = null;

  async function bootApi() {
    if (apiServer) return apiServer;
    apiServer = await startServer(API_PORT, API_HOST);
    console.log(`[第一页自研浏览器] Local API: http://${API_HOST}:${API_PORT}`);
    console.log(`[第一页自研浏览器] 内核引擎: ${resolveEngine()}（可用 TKSWARM_BROWSER_ENGINE 或 data/settings.json 的 engine 切换）`);
    return apiServer;
  }

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1180,
      height: 760,
      minWidth: 960,
      minHeight: 600,
      title: '第一页自研浏览器',
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
    tray.setToolTip('第一页自研浏览器');
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

    // 环境窗口子进程退出后刷新控制台列表
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
}
