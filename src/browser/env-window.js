/**
 * 环境窗口进程（自研内核）
 * ---------------------------------------------------------------
 * 由「第一页自研浏览器」本体以子进程方式拉起：`TkSwarmBrowser --tkswarm-env`。
 * 每个环境一个进程 + 一个独立 userData（= profiles/<环境ID>），
 * 因此 Cookie / 缓存 / 登录态彼此隔离，且 CDP 端口独立，node 侧按原有
 * `browser/open` 契约（返回 ws/http）即可连接，无需改动业务代码。
 *
 * 配置通过环境变量 TKSWARM_ENV_CONFIG（JSON）传入，避免子进程读数据库造成并发写。
 */
const { app, BrowserWindow, Menu, session } = require('electron');
const fs = require('node:fs');

function readConfig() {
  try {
    return JSON.parse(process.env.TKSWARM_ENV_CONFIG || '{}') || {};
  } catch {
    return {};
  }
}

const cfg = readConfig();
const profileId = String(cfg.profileId || '');

if (!profileId || !cfg.userDataDir) {
  console.error('[env-window] 缺少 profileId / userDataDir，退出');
  app.exit(1);
}

// 必须在 ready 之前设置：该环境的 Profile 目录
try {
  fs.mkdirSync(String(cfg.userDataDir), { recursive: true });
  app.setPath('userData', String(cfg.userDataDir));
} catch (error) {
  console.error('[env-window] setPath(userData) 失败:', error?.message || error);
}

// 窗口不可见（无头）时也不要限流，否则任务里的定时器/渲染会被节流
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
if (cfg.acceptLanguages) {
  app.commandLine.appendSwitch('lang', String(cfg.acceptLanguages).split(',')[0]);
}

const windowTitle = String(cfg.title || `${cfg.name || profileId} - 第一页自研浏览器`);

let win = null;

function createEnvWindow() {
  Menu.setApplicationMenu(null);
  const browserWindow = new BrowserWindow({
    width: Number(cfg.width) || 1280,
    height: Number(cfg.height) || 800,
    show: !cfg.headless,
    title: windowTitle,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  try { browserWindow.setMenuBarVisibility(false); } catch { /* */ }
  // 保持窗口标题为环境名，不被站点标题顶掉
  browserWindow.on('page-title-updated', (event) => {
    event.preventDefault();
    try { browserWindow.setTitle(windowTitle); } catch { /* */ }
  });
  browserWindow.on('closed', () => {
    win = null;
    app.quit();
  });
  return browserWindow;
}

/**
 * 指纹注入（自研内核专用）
 * 直接在环境进程内用 webContents.debugger 下发，不依赖父进程的 CDP WebSocket
 * （Electron 主进程的 Node 20 没有全局 WebSocket，父进程那条注入会空转）。
 * 附加会话保持开启，后续每次导航都会执行该脚本。
 */
async function applyFingerprintViaDebugger(browserWindow, config) {
  const dbg = browserWindow.webContents.debugger;
  try {
    if (!dbg.isAttached()) dbg.attach('1.3');
    if (config.injectScript) {
      await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: String(config.injectScript),
      });
    }
    if (config.timezone) {
      await dbg.sendCommand('Emulation.setTimezoneOverride', { timezoneId: String(config.timezone) });
    }
    if (config.locale) {
      await dbg.sendCommand('Emulation.setLocaleOverride', { locale: String(config.locale) });
    }
    const lat = Number(config.latitude);
    const lon = Number(config.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0)) {
      await dbg.sendCommand('Emulation.setGeolocationOverride', {
        latitude: lat,
        longitude: lon,
        accuracy: 100,
      });
    }
  } catch (error) {
    console.warn('[env-window] 指纹注入失败（不影响启动）:', error?.message || error);
  }
}

app.whenReady().then(async () => {
  const ses = session.defaultSession;
  if (cfg.userAgent) {
    try {
      ses.setUserAgent(String(cfg.userAgent), String(cfg.acceptLanguages || 'en-US'));
    } catch { /* 老版本 Electron 只支持单参数 */ }
  }
  // 代理：确定性写入 session（命令行 --proxy-server 之外的兜底）
  if (cfg.proxyServer) {
    try {
      await ses.setProxy({
        proxyMode: 'fixed_servers',
        proxyRules: String(cfg.proxyServer),
        proxyBypassRules: '<-loopback>',
      });
    } catch (error) {
      console.warn('[env-window] 代理设置失败:', error?.message || error);
    }
  }
  win = createEnvWindow();
  if (cfg.fpInject !== false) await applyFingerprintViaDebugger(win, cfg);
  const startUrl = String(cfg.startUrl || 'https://www.tiktok.com');
  try {
    await win.loadURL(startUrl);
  } catch (error) {
    // 启动页打不开不影响后续任务导航，保持空白窗口等待 CDP 驱动
    console.warn('[env-window] 首个页面加载失败:', error?.message || error);
  }
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  try { win?.destroy(); } catch { /* */ }
});
