const { app, BrowserWindow, Tray, Menu } = require('electron');
const { loadAppIcon, applyWindowIcon } = require('../src/browser/app-icon');
const path = require('node:path');
const { bootstrapRenderFlags, wantSoftwareRender } = require('../src/browser/render-flags');
const { applyChromiumArgvToApp } = require('../src/browser/chromium-argv');
const { useInProcessEnvWindows } = require('../src/browser/engine');

const softwareRenderReason = bootstrapRenderFlags();

if (process.platform === 'win32') {
  try { app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion'); } catch { /* */ }
}
try { app.allowRendererProcessReuse = false; } catch { /* */ }

const IS_ENV_PROCESS = process.argv.includes('--tkswarm-env');
const IN_PROCESS_ENVS = !IS_ENV_PROCESS && useInProcessEnvWindows();
const MAIN_CDP_PORT = Number(process.env.TKSWARM_MAIN_CDP_PORT) || 19222;

function startEnvWindow() {
  try {
    require('../src/browser/env-window');
  } catch (error) {
    const detail = String(error?.stack || error || '未知错误');
    console.error('[env-window] 启动失败:', detail);
    app.whenReady().then(() => {
      const fs = require('node:fs');
      const os = require('node:os');
      const pathMod = require('node:path');
      const esc = detail.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>环境窗口启动失败</title>
<style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;margin:0;padding:32px;background:#fdf7f0;color:#1d1310;line-height:1.7}
h2{margin:0 0 8px;font-size:19px}p{color:#6b564a}
pre{background:#fff;border:1px solid #ecdac7;border-radius:12px;padding:16px;overflow:auto;white-space:pre-wrap;word-break:break-all}</style></head>
<body><h2>环境窗口启动失败</h2>
<p>这是自研内核的环境子进程，没能加载 env-window 模块。请把下面内容发给技术支持：</p>
<pre>${esc}</pre></body></html>`;
      const win = new BrowserWindow({
        width: 940,
        height: 640,
        backgroundColor: '#fdf7f0',
        title: '环境窗口启动失败',
        icon: loadAppIcon() || undefined,
        webPreferences: { contextIsolation: true, nodeIntegration: false },
      });
      applyWindowIcon(win);
      const file = pathMod.join(os.tmpdir(), `tkswarm-env-boot-error-${process.pid}.html`);
      try {
        fs.writeFileSync(file, html, 'utf8');
        win.loadFile(file);
      } catch {
        win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      }
    }).catch(() => {});
  }
}

if (IS_ENV_PROCESS) {
  try {
    const cfg = JSON.parse(process.env.TKSWARM_ENV_CONFIG || '{}');
    applyChromiumArgvToApp(app, {
      softwareRender: cfg.softwareRender || Boolean(wantSoftwareRender()),
      disableSandbox: app.isPackaged,
      profileId: String(cfg.profileId || ''),
    });
  } catch { /* ignore */ }
  startEnvWindow();
} else {
  if (IN_PROCESS_ENVS) {
    app.commandLine.appendSwitch('remote-debugging-port', String(MAIN_CDP_PORT));
    app.commandLine.appendSwitch('remote-allow-origins', '*');
    const { initEnvSessionHost } = require('../src/browser/env-session-host');
    initEnvSessionHost(MAIN_CDP_PORT);
  }

  const { startServer } = require('../src/server');
  const { API_PORT, API_HOST, isDev } = require('../src/config');
  const manager = require('../src/browser/manager');
  let mainWindow = null;
  let tray = null;
  let apiServer = null;

  async function bootApi() {
    if (apiServer) return apiServer;
    apiServer = await startServer(API_PORT, API_HOST);
    console.log(`[第一页自研浏览器] Local API: http://${API_HOST}:${API_PORT}`);
    console.log(`[第一页自研浏览器] 版本 v${app.getVersion()}`);
    const mode = IN_PROCESS_ENVS ? 'electron/同进程窗口' : 'electron/子进程窗口';
    console.log(`[第一页自研浏览器] 内核: ${mode}${IN_PROCESS_ENVS ? `（CDP :${MAIN_CDP_PORT}）` : ''}`);
    if (softwareRenderReason) {
      console.log(`[第一页自研浏览器] 软件渲染: ${softwareRenderReason}`);
    }
    if (process.env.PORTABLE_EXECUTABLE_FILE) {
      console.log(`[第一页自研浏览器] 便携入口: ${process.env.PORTABLE_EXECUTABLE_FILE}`);
    }
    return apiServer;
  }

  function createWindow() {
    const appIcon = loadAppIcon();
    mainWindow = new BrowserWindow({
      width: 1180,
      height: 760,
      minWidth: 960,
      minHeight: 600,
      title: '第一页自研浏览器',
      icon: appIcon || undefined,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    applyWindowIcon(mainWindow);

    mainWindow.loadFile(path.join(__dirname, '../ui/index.html'));
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  }

  function createTray() {
    const icon = loadAppIcon();
    if (!icon) return;
    tray = new Tray(icon);
    tray.setToolTip('第一页自研浏览器');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开控制台', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]));
  }

  function createAppMenu() {
    const { buildMainAppMenu } = require('../src/browser/app-menu-zh');
    const { TEST_PROFILE_ID } = require('../src/browser/test-env');
    Menu.setApplicationMenu(buildMainAppMenu({
      onTestEnv: () => {
        manager.openTestEnvWindow()
          .then(() => mainWindow?.webContents.send('windows-updated'))
          .catch((error) => {
            console.error('[测试环境窗]', error);
            mainWindow?.webContents.send('test-env-error', String(error?.message || error));
          });
      },
      onCloseTestEnv: () => {
        manager.closeProfile(TEST_PROFILE_ID).catch(() => {});
      },
    }));
  }

  app.whenReady().then(async () => {
    await bootApi();
    createAppMenu();
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
}
