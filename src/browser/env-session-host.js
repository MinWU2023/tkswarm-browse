/**
 * 在主 Electron 进程内打开环境窗口（不 spawn 子进程）。
 * 便携版 portable exe 二次 spawn 自身在 Windows 上常导致白屏；同进程多窗口 + 共享 CDP 端口更稳。
 */
const { mergeFingerprint, parseResolution, buildUserAgent } = require('./fingerprint');
const { resolveChromeProxy } = require('./proxy-auth');
const { profileDir, fetchJson } = require('./launcher');
const {
  appendEnvLog,
  LOADING_HTML,
  loadStatusPage,
  waitForMainFrameLoad,
  revealEnvWindow,
  showDiagnostic,
  inspectBlankContent,
} = require('./env-window-ui');

function electron() {
  return require('electron');
}

/** @type {number} */
let mainCdpPort = 0;
/** @type {Map<string, { window: BrowserWindow, releaseProxy?: Function, profile: object }>} */
const windows = new Map();

function initEnvSessionHost(cdpPort) {
  mainCdpPort = Number(cdpPort) || 0;
}

function pickEnvPageTarget(pages, webContentsId, titleHint) {
  const wantId = String(webContentsId);
  const mine = pages.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const byId = mine.find((t) => String(t.id) === wantId);
  if (byId) return byId;
  if (titleHint) {
    const byTitle = mine.find((t) => String(t.title || '').includes(titleHint));
    if (byTitle) return byTitle;
  }
  return mine.find((t) => {
    const url = String(t.url || '');
    return url && !url.startsWith('devtools://') && !/index\.html/i.test(url);
  }) || null;
}

async function waitForPageWs(webContentsId, titleHint, timeoutMs = 30000) {
  const port = mainCdpPort;
  if (!port) throw new Error('主进程 CDP 端口未初始化');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      const pages = Array.isArray(list) ? list : [];
      const hit = pickEnvPageTarget(pages, webContentsId, titleHint);
      if (hit) return hit;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('环境窗口 CDP 页面未就绪，请重启第一页自研浏览器后重试');
}

/**
 * @returns {Promise<object>} 与 launchProfileElectron 相同结构
 */
async function launchProfileInProcess(profile, options = {}) {
  if (!mainCdpPort) {
    throw new Error('环境窗口宿主未初始化（请从第一页自研浏览器控制台启动，勿单独跑 API）');
  }
  const id = String(profile.id);
  const displayName = profile.name || id;
  const windowTitle = `${displayName} - 第一页自研浏览器`;
  const existing = windows.get(id);
  if (existing?.window && !existing.window.isDestroyed()) {
    const page = await waitForPageWs(existing.window.webContents.id, displayName, 8000).catch(() => null);
    if (page?.webSocketDebuggerUrl) {
      return formatLaunchResult(profile, existing.window, page.webSocketDebuggerUrl, options, existing.releaseProxy);
    }
  }
  if (existing) await closeInProcessWindow(id);

  const fp = mergeFingerprint(JSON.parse(profile.fingerprint_json || '{}'));
  const { width, height } = parseResolution(fp.resolution);
  const userAgent = buildUserAgent(fp);
  const headless = Boolean(options.headless);
  const locale = profile.language || fp.languages || 'en-US';
  const timezone = profile.timezone || 'America/New_York';
  const startUrl = String(profile.platform || 'https://www.tiktok.com');
  const userDataDir = profileDir(id);
  const proxy = await resolveChromeProxy(profile);
  const { BrowserWindow } = electron();

  appendEnvLog(id, `=== 同进程打开环境 ${id}（${displayName}） startUrl=${startUrl} ===`);

  let settled = false;
  const diagOpts = {
    url: startUrl,
    proxy: proxy.proxyArg ? String(proxy.proxyArg).replace(/^--proxy-server=/, '') : '',
    userDataDir,
  };

  // 只用 partition 创建隔离 session；禁止同时传 session + partition（会导致渲染异常/白屏）
  const win = new BrowserWindow({
    width,
    height,
    show: !headless,
    paintWhenInitiallyHidden: true,
    title: windowTitle,
    autoHideMenuBar: true,
    backgroundColor: '#f5f6f8',
    webPreferences: {
      partition: `persist:env-${id}`,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  try { win.setMenuBarVisibility(false); } catch { /* */ }

  const ses = win.webContents.session;
  if (userAgent) {
    try { ses.setUserAgent(userAgent, locale); } catch { ses.setUserAgent(userAgent); }
  }
  if (proxy.proxyArg) {
    const rules = String(proxy.proxyArg).replace(/^--proxy-server=/, '');
    await ses.setProxy({ proxyMode: 'fixed_servers', proxyRules: rules, proxyBypassRules: '<-loopback>' });
    appendEnvLog(id, `代理: ${rules}`);
  } else {
    await ses.setProxy({ proxyMode: 'direct' });
  }

  win.once('ready-to-show', () => {
    revealEnvWindow(win, id, { headless }).catch(() => {});
  });

  win.on('page-title-updated', (e) => {
    e.preventDefault();
    try { win.setTitle(windowTitle); } catch { /* */ }
  });
  win.on('closed', () => {
    windows.delete(id);
    try { proxy.release?.(); } catch { /* */ }
  });

  const wc = win.webContents;

  wc.on('did-fail-load', (event, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    if (!url || url.startsWith('file:') || url.startsWith('data:')) return;
    if (settled) return;
    settled = true;
    appendEnvLog(id, `did-fail-load code=${code} url=${url} ${desc}`);
    showDiagnostic(win, id, {
      ...diagOpts,
      reason: '页面加载失败',
      detail: `${desc}（错误码 ${code}）`,
      url,
    }).catch(() => {});
  });

  wc.on('render-process-gone', (event, details) => {
    if (settled) return;
    settled = true;
    appendEnvLog(id, `render-process-gone ${details?.reason} exit=${details?.exitCode}`);
    showDiagnostic(win, id, {
      ...diagOpts,
      reason: '渲染进程已退出',
      detail: String(details?.reason || 'unknown'),
    }).catch(() => {});
  });

  try {
    await loadStatusPage(win, id, LOADING_HTML);
    await waitForMainFrameLoad(wc);
    appendEnvLog(id, '加载中页面已就绪');
    await revealEnvWindow(win, id, { headless });
  } catch (error) {
    appendEnvLog(id, `加载中页面失败: ${error?.message || error}`);
    await showDiagnostic(win, id, {
      ...diagOpts,
      reason: '加载中页面失败',
      detail: error?.message || String(error),
    }).catch(() => {});
  }

  const hardTimeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    showDiagnostic(win, id, {
      ...diagOpts,
      reason: '页面加载超时',
      detail: '90 秒内没有加载完成，通常是网络或账号代理不可用',
    }).catch(() => {});
  }, 90000);

  let inspected = false;
  wc.on('did-finish-load', () => {
    const href = wc.getURL();
    if (href.startsWith('file:') || href.startsWith('data:')) return;
    clearTimeout(hardTimeout);
    if (inspected || settled) return;
    inspected = true;
    setTimeout(() => {
      inspectBlankContent(win, id, diagOpts).catch(() => {});
    }, 2500);
  });

  try {
    const nav = win.loadURL(startUrl, { timeout: 60000 });
    if (nav && typeof nav.catch === 'function') {
      nav.catch((error) => {
        const code = String(error?.code || '');
        if (code === '-3' || code === 'ERR_ABORTED') return;
        if (settled) return;
        settled = true;
        appendEnvLog(id, `loadURL 失败: ${error?.message || error}`);
        showDiagnostic(win, id, {
          ...diagOpts,
          reason: '页面加载失败',
          detail: error?.message || String(error),
        }).catch(() => {});
      });
    }
  } catch (error) {
    settled = true;
    await showDiagnostic(win, id, {
      ...diagOpts,
      reason: '页面加载失败',
      detail: error?.message || String(error),
    });
  }

  const page = await waitForPageWs(win.webContents.id, displayName, 45000);
  windows.set(id, { window: win, releaseProxy: proxy.release, profile });
  appendEnvLog(id, `CDP 就绪 ws=${page.webSocketDebuggerUrl} url=${page.url || ''}`);

  return formatLaunchResult(profile, win, page.webSocketDebuggerUrl, options, proxy.release, {
    userAgent,
    timezone,
    fp,
    userDataDir,
  });
}

function formatLaunchResult(profile, win, ws, options, releaseProxy, extra = {}) {
  const http = `http://127.0.0.1:${mainCdpPort}`;
  return {
    pid: process.pid,
    port: mainCdpPort,
    ws,
    http,
    headless: Boolean(options.headless),
    userDataDir: extra.userDataDir || profileDir(profile.id),
    process: null,
    inProcess: true,
    window: win,
    webContentsId: win.webContents.id,
    userAgent: extra.userAgent || '',
    timezone: extra.timezone || '',
    fp: extra.fp || {},
    engine: 'electron',
    releaseProxy: releaseProxy || (() => {}),
  };
}

async function closeInProcessWindow(profileId) {
  const id = String(profileId);
  const rec = windows.get(id);
  if (!rec) return { ok: true };
  try { rec.releaseProxy?.(); } catch { /* */ }
  if (rec.window && !rec.window.isDestroyed()) {
    rec.window.close();
  }
  windows.delete(id);
  return { ok: true };
}

function isInProcessAlive(session) {
  return Boolean(session?.inProcess && session.window && !session.window.isDestroyed());
}

module.exports = {
  initEnvSessionHost,
  launchProfileInProcess,
  closeInProcessWindow,
  isInProcessAlive,
  getMainCdpPort: () => mainCdpPort,
};
