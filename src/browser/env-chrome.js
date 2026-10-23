/**
 * 环境窗浏览器外壳：标签页 + 地址栏 + 前进后退 + 浏览历史（BrowserView）
 * 工具栏（shell）与内容页必须用不同 session：shell 直连，内容页走代理。
 */
const { BrowserWindow, BrowserView, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { loadAppIcon, applyWindowIcon } = require('./app-icon');

const TOOLBAR_H = 92;
const SHELL_HTML = path.join(__dirname, '../../ui/env-shell.html');
const SHELL_PRELOAD = path.join(__dirname, '../../electron/env-shell-preload.js');
const MAX_HISTORY = 80;

function isShellUrl(url) {
  const u = String(url || '');
  return /env-shell\.html/i.test(u) || u.startsWith('data:text/html');
}

function pickBrowsingCdpPage(pages) {
  const list = Array.isArray(pages) ? pages : [];
  return list.find((t) => {
    if (t.type !== 'page' || !t.webSocketDebuggerUrl) return false;
    const url = String(t.url || '');
    if (!url || url.startsWith('devtools://')) return false;
    if (url === 'about:blank' || url === 'about:srcdoc') return false;
    if (isShellUrl(url)) return false;
    return true;
  }) || null;
}

function historyFile(userDataDir) {
  return path.join(String(userDataDir || ''), 'browse-history.json');
}

function loadHistory(userDataDir) {
  try {
    const raw = fs.readFileSync(historyFile(userDataDir), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data.slice(0, MAX_HISTORY) : [];
  } catch {
    return [];
  }
}

function saveHistory(userDataDir, items) {
  if (!userDataDir) return;
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(historyFile(userDataDir), JSON.stringify(items.slice(0, MAX_HISTORY), null, 0));
  } catch { /* */ }
}

function normalizeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw) || /^file:\/\//i.test(raw)) return raw;
  if (/^localhost[:/]/i.test(raw) || /^127\.0\.0\.1/.test(raw)) return `http://${raw}`;
  if (raw.includes('.') && !raw.includes(' ')) return `https://${raw}`;
  return `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
}

/**
 * @param {object} opts
 * @param {Electron.Session} [opts.shellSession] 工具栏 session（应直连，不走代理）
 * @param {Electron.Session} [opts.contentSession] 标签页 session（Profile + 代理）
 * @param {Electron.Session} [opts.ses] 兼容旧参数，等同 contentSession
 * @param {() => Promise<void>} [opts.ensureContentProxy] 导航前重新 setProxy
 * @param {(wc: Electron.WebContents) => void} [opts.onContentWebContents] 每个标签页创建时回调
 * @returns {Promise<{ window: BrowserWindow, getActiveWebContents: Function, pickBrowsingCdpPage: Function }>}
 */
async function createEnvChrome(opts) {
  const {
    profileId,
    userDataDir,
    width = 1280,
    height = 800,
    windowTitle,
    startUrl,
    shellSession,
    contentSession,
    ses,
    ensureContentProxy,
    onContentWebContents,
    headless = false,
    log = () => {},
  } = opts;

  const browseSes = contentSession || ses;
  const uiSes = shellSession || browseSes;
  if (!browseSes) {
    throw new Error('createEnvChrome: 缺少 contentSession');
  }

  const history = loadHistory(userDataDir);
  const tabs = [];
  const views = new Map();
  let activeTabId = 0;
  let nextTabId = 1;
  const ipcPrefix = `env-chrome-${profileId}-${Date.now()}`;

  const appIcon = loadAppIcon();
  const win = new BrowserWindow({
    width,
    height: height + TOOLBAR_H,
    show: !headless,
    paintWhenInitiallyHidden: true,
    title: windowTitle,
    icon: appIcon || undefined,
    autoHideMenuBar: true,
    backgroundColor: '#e8eaed',
    webPreferences: {
      session: uiSes,
      preload: SHELL_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: [`--env-chrome-ipc=${ipcPrefix}`],
    },
  });
  applyWindowIcon(win);
  try { win.setMenuBarVisibility(false); } catch { /* */ }

  async function beforeBrowseNav() {
    if (typeof ensureContentProxy === 'function') {
      try { await ensureContentProxy(); } catch (error) {
        log(`导航前重设代理失败: ${error?.message || error}`);
      }
    }
  }

  function pauseInactiveTabs(exceptId) {
    for (const [tid, view] of views) {
      if (tid === exceptId) continue;
      try {
        const wc = view.webContents;
        if (wc && !wc.isDestroyed() && wc.isLoading()) wc.stop();
      } catch { /* */ }
    }
  }

  function pushHistory(url, title) {
    if (!url || isShellUrl(url) || url.startsWith('file:')) return;
    const entry = { url, title: title || url, at: new Date().toISOString() };
    const idx = history.findIndex((h) => h.url === url);
    if (idx >= 0) history.splice(idx, 1);
    history.unshift(entry);
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    saveHistory(userDataDir, history);
  }

  function sendState() {
    if (win.isDestroyed()) return;
    const view = views.get(activeTabId);
    const wc = view?.webContents;
    win.webContents.send(`${ipcPrefix}:state`, {
      envTitle: windowTitle,
      tabs: tabs.map((t) => ({
        id: t.id,
        title: t.title || '新标签页',
        url: t.url || '',
        active: t.id === activeTabId,
      })),
      url: wc?.getURL() || '',
      canGoBack: Boolean(wc?.canGoBack()),
      canGoForward: Boolean(wc?.canGoForward()),
      history: history.slice(0, 30),
    });
  }

  function layout() {
    if (win.isDestroyed()) return;
    const [w, h] = win.getContentSize();
    const view = views.get(activeTabId);
    if (view) {
      view.setBounds({ x: 0, y: TOOLBAR_H, width: w, height: Math.max(0, h - TOOLBAR_H) });
      view.setAutoResize({ width: true, height: true });
    }
  }

  function switchTab(id) {
    const view = views.get(id);
    if (!view) return;
    pauseInactiveTabs(id);
    for (const v of win.getBrowserViews()) {
      try { win.removeBrowserView(v); } catch { /* */ }
    }
    win.addBrowserView(view);
    activeTabId = id;
    layout();
    sendState();
  }

  function wireView(id, view, tab) {
    const wc = view.webContents;
    if (typeof onContentWebContents === 'function') {
      try { onContentWebContents(wc); } catch { /* */ }
    }
    wc.on('page-title-updated', (_e, title) => {
      tab.title = title || tab.url || '新标签页';
      sendState();
    });
    wc.on('did-navigate', (_e, url) => {
      tab.url = url;
      pushHistory(url, tab.title);
      sendState();
    });
    wc.on('did-navigate-in-page', (_e, url) => {
      tab.url = url;
      sendState();
    });
    wc.on('did-finish-load', () => sendState());
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      log(`标签页加载失败 code=${code} url=${url} ${desc || ''}`);
    });
  }

  async function loadInActiveView(url) {
    const view = activeView();
    if (!view) return;
    await beforeBrowseNav();
    pauseInactiveTabs(activeTabId);
    const wc = view.webContents;
    if (wc.isLoading()) wc.stop();
    await wc.loadURL(normalizeUrl(url));
  }

  function createTab(url, activate = true) {
    const id = nextTabId++;
    const view = new BrowserView({
      webPreferences: {
        session: browseSes,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    const tab = { id, title: '加载中…', url: normalizeUrl(url) };
    tabs.push(tab);
    views.set(id, view);
    wireView(id, view, tab);
    if (activate) switchTab(id);
    void beforeBrowseNav().then(() => {
      view.webContents.loadURL(tab.url).catch((err) => {
        log(`loadURL 失败: ${err?.message || err}`);
      });
    });
    return id;
  }

  function closeTab(id) {
    const view = views.get(id);
    if (view) {
      try {
        if (win.getBrowserViews().includes(view)) win.removeBrowserView(view);
        view.webContents.destroy();
      } catch { /* */ }
      views.delete(id);
    }
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx >= 0) tabs.splice(idx, 1);
    if (!tabs.length) {
      win.close();
      return;
    }
    if (activeTabId === id) {
      const next = tabs[Math.min(idx, tabs.length - 1)];
      switchTab(next.id);
    } else {
      sendState();
    }
  }

  function activeView() {
    return views.get(activeTabId);
  }

  const ipcHandlers = [
    [`${ipcPrefix}:ready`, async () => sendState()],
    [`${ipcPrefix}:navigate`, async (_e, url) => {
      await loadInActiveView(url);
      sendState();
    }],
    [`${ipcPrefix}:back`, async () => {
      await beforeBrowseNav();
      pauseInactiveTabs(activeTabId);
      const wc = activeView()?.webContents;
      if (wc?.canGoBack()) wc.goBack();
      sendState();
    }],
    [`${ipcPrefix}:forward`, async () => {
      await beforeBrowseNav();
      pauseInactiveTabs(activeTabId);
      const wc = activeView()?.webContents;
      if (wc?.canGoForward()) wc.goForward();
      sendState();
    }],
    [`${ipcPrefix}:reload`, async () => {
      await beforeBrowseNav();
      pauseInactiveTabs(activeTabId);
      const wc = activeView()?.webContents;
      if (wc) {
        if (wc.isLoading()) wc.stop();
        wc.reload();
      }
      sendState();
    }],
    [`${ipcPrefix}:home`, async () => {
      await loadInActiveView(startUrl);
      sendState();
    }],
    [`${ipcPrefix}:new-tab`, async (_e, url) => {
      createTab(url || startUrl, true);
    }],
    [`${ipcPrefix}:switch-tab`, async (_e, tabId) => { switchTab(Number(tabId)); }],
    [`${ipcPrefix}:close-tab`, async (_e, tabId) => { closeTab(Number(tabId)); }],
    [`${ipcPrefix}:open-history`, async (_e, url) => {
      await loadInActiveView(url);
      sendState();
    }],
    [`${ipcPrefix}:clear-history`, async () => {
      history.length = 0;
      saveHistory(userDataDir, history);
      sendState();
    }],
    [`${ipcPrefix}:close-window`, async () => { win.close(); }],
  ];

  for (const [channel, handler] of ipcHandlers) {
    ipcMain.handle(channel, handler);
  }

  win.on('resize', layout);
  win.on('maximize', layout);
  win.on('unmaximize', layout);
  win.on('closed', () => {
    for (const [channel] of ipcHandlers) {
      try { ipcMain.removeHandler(channel); } catch { /* */ }
    }
    for (const view of views.values()) {
      try { view.webContents.destroy(); } catch { /* */ }
    }
    views.clear();
  });

  if (!headless) {
    win.once('ready-to-show', () => {
      try { win.show(); } catch { /* */ }
      log('窗口已显示');
    });
  }

  await win.loadFile(SHELL_HTML, { query: { ipc: ipcPrefix } });
  win.webContents.send(`${ipcPrefix}:bind`, ipcPrefix);
  createTab(startUrl, true);

  return {
    window: win,
    getActiveWebContents: () => activeView()?.webContents || null,
    pickBrowsingCdpPage,
    isShellUrl,
  };
}

module.exports = {
  createEnvChrome,
  pickBrowsingCdpPage,
  isShellUrl,
  TOOLBAR_H,
};
