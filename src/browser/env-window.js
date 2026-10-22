/**
 * 环境窗口进程（自研内核）
 * ---------------------------------------------------------------
 * 由「第一页自研浏览器」本体以子进程方式拉起：`TkSwarmBrowser --tkswarm-env`。
 * 每个环境一个进程 + 一个独立 userData（= profiles/<环境ID>），
 * 因此 Cookie / 缓存 / 登录态彼此隔离，且 CDP 端口独立，node 侧按原有
 * `browser/open` 契约（返回 ws/http）即可连接，无需改动业务代码。
 *
 * 配置通过环境变量 TKSWARM_ENV_CONFIG（JSON）传入，避免子进程读数据库造成并发写。
 *
 * 关于「窗口一片空白」：三种成因都会走到诊断页，不会再留白
 *  1) 页面加载失败 / 超时（代理不可用、DNS、证书）
 *  2) 页面加载了但 DOM 是空的（登录墙、反爬拦截）
 *  3) DOM 有内容但窗口渲染成纯色（显卡/远程桌面合成问题）→ 提示开启软件渲染
 * 日志：<data>/logs/env-<环境ID>.log
 */
const { app, BrowserWindow, Menu, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

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

/* ---------------- 日志 ---------------- */
function dataRoot() {
  try {
    return require('../config').DATA_ROOT;
  } catch {
    return '';
  }
}

const LOG_FILE = (function resolveLogFile() {
  const root = dataRoot();
  if (!root) return '';
  try {
    const dir = path.join(root, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `env-${profileId}.log`);
  } catch {
    return '';
  }
})();

function logLine(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  try { console.log(line); } catch { /* */ }
  if (!LOG_FILE) return;
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* */ }
}

/* ---------------- Chromium argv（子进程必须在 argv + 此处双保险） ---------------- */
const { wantSoftwareRender } = require('./render-flags');
const { applyChromiumArgvToApp } = require('./chromium-argv');
const { dumpEnvBoot } = require('./env-boot-dump');

dumpEnvBoot(logLine);

if (cfg.softwareRender || wantSoftwareRender()) {
  try {
    applyChromiumArgvToApp(app, {
      softwareRender: true,
      disableSandbox: app.isPackaged,
      profileId,
    });
    logLine(`Chromium argv 已应用（软件渲染: ${wantSoftwareRender() || 'config'}）`);
  } catch (error) {
    logLine(`Chromium argv 应用失败: ${error?.message || error}`);
  }
}

/* ---------------- Profile 目录 ---------------- */
try {
  const dir = String(cfg.userDataDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.accessSync(dir, fs.constants.W_OK);
  app.setPath('userData', dir);
  logLine(`userData = ${dir}`);
} catch (error) {
  // 便携版常见：exe 放在只读目录 / 网盘同步目录 → 落回临时目录，至少不白屏
  logLine(`Profile 目录不可用（${error?.message || error}），回退到临时目录`);
  try {
    const fallback = path.join(app.getPath('temp'), `tkswarm-env-${profileId}`);
    fs.mkdirSync(fallback, { recursive: true });
    app.setPath('userData', fallback);
    logLine(`userData(fallback) = ${fallback}`);
  } catch (fallbackError) {
    logLine(`临时目录也不可用: ${fallbackError?.message || fallbackError}`);
  }
}

// 窗口不可见（无头）时也不要限流，否则任务里的定时器/渲染会被节流
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// 子进程也需允许 Playwright 跨源连 CDP（免安装版从 exe 拉起 env 子进程）
app.commandLine.appendSwitch('remote-allow-origins', '*');
if (cfg.acceptLanguages) {
  app.commandLine.appendSwitch('lang', String(cfg.acceptLanguages).split(',')[0]);
}

const windowTitle = String(cfg.title || `${cfg.name || profileId} - 第一页自研浏览器`);
const targetUrl = String(cfg.startUrl || 'https://www.tiktok.com');

let win = null;
let settled = false;

/* ---------------- 诊断页 ---------------- */
function buildDiagnosticHtml(opts) {
  const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rows = [
    ['目标地址', opts.url || targetUrl],
    ['失败原因', opts.reason || '未知'],
    ['错误详情', opts.detail || '—'],
    ['代理设置', cfg.proxyServer || '直连（未绑定代理）'],
    ['环境 ID', profileId],
    ['数据目录', String(cfg.userDataDir || '')],
    ['日志文件', LOG_FILE || '（未写入）'],
    ['时间', new Date().toLocaleString('zh-CN')],
  ].map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>环境窗口 - 加载诊断</title>
<style>
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:28px;
       font:14px/1.6 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;color:#1d1310;
       background:radial-gradient(900px 420px at 50% -10%,#ffd2a4a8,transparent 62%),#fdf7f0}
  .card{width:min(760px,100%);background:#fff;border:1px solid #ecdac7;border-radius:16px;
        padding:26px 28px;box-shadow:0 20px 44px #a4713a24}
  h1{margin:0 0 6px;font-size:19px}
  .sub{margin:0 0 18px;color:#6b564a}
  table{width:100%;border-collapse:collapse;margin-bottom:18px}
  th,td{padding:8px 0;border-bottom:1px solid #f4e7d8;text-align:left;vertical-align:top;font-weight:400}
  th{width:104px;color:#a1897a;white-space:nowrap}
  td{color:#1d1310;word-break:break-all}
  .tips{margin:0;padding-left:18px;color:#6b564a}
  .tips li{margin:6px 0}
  code{background:#f8ece0;border-radius:5px;padding:1px 6px;font-size:13px}
  .k{display:inline-block;width:8px;height:8px;border-radius:50%;background:#f7921e;margin-right:8px}
</style></head><body>
<div class="card">
  <h1><span class="k"></span>环境窗口没能正常打开页面</h1>
  <p class="sub">下面是这次打开的诊断信息，把它（或日志文件）发给技术支持即可定位。</p>
  <table>${rows}</table>
  <p class="sub" style="margin-bottom:6px"><b>请依次检查：</b></p>
  <ol class="tips">
    <li>关闭本窗口，在账号页重新点「打开 / 登录」再试一次。</li>
    <li>确认账号绑定的代理可用（先用「诊断」里的代理探测，或换直连测试）。</li>
    <li>确认本机网络能正常访问 TikTok（浏览器手动打开试一试）。</li>
    <li>如果上面的「错误详情」为空、且本机是远程桌面/云主机，请在
        <code>data/settings.json</code> 加 <code>"envSoftwareRender": true</code> 后重启客户端
        （部分机器硬件合成会把窗口渲染成纯白）。</li>
    <li>仍然不行，把 <code>data/logs/env-${esc(profileId)}.log</code> 发给我们。</li>
  </ol>
</div></body></html>`;
}

/** 加载中 / 诊断页：优先 data:（不依赖 asar/CWD），再 PORTABLE_EXECUTABLE_DIR/data/logs */
async function loadBuiltinHtml(browserWindow, html) {
  try {
    await browserWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    logLine('状态页已通过 data: URL 加载');
    return;
  } catch (error) {
    logLine(`data: URL 加载失败: ${error?.message || error}`);
  }
  const root = dataRoot()
    || path.join(process.env.PORTABLE_EXECUTABLE_DIR || app.getPath('temp'), 'data');
  const file = path.join(root, 'logs', `env-${profileId}-status.html`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, html, 'utf8');
    await browserWindow.loadURL(pathToFileURL(file).href);
    logLine(`状态页已通过 file: URL 加载 ${file}`);
  } catch (error) {
    logLine(`file: URL 加载失败: ${error?.message || error}`);
    await browserWindow.loadURL(`data:text/html,${encodeURIComponent(html)}`).catch(() => {});
  }
}

function showDiagnostic(browserWindow, opts) {
  if (!browserWindow || browserWindow.isDestroyed()) return Promise.resolve();
  logLine(`显示诊断页：${opts.reason || ''} ${opts.detail || ''}`.trim());
  return loadBuiltinHtml(browserWindow, buildDiagnosticHtml(opts));
}

/* ---------------- 窗口 ---------------- */
function createEnvWindow() {
  Menu.setApplicationMenu(null);
  const browserWindow = new BrowserWindow({
    width: Number(cfg.width) || 1280,
    height: Number(cfg.height) || 800,
    show: !cfg.headless,
    paintWhenInitiallyHidden: true,
    title: windowTitle,
    autoHideMenuBar: true,
    // 不是纯白：即使渲染管线出问题也不会是刺眼的白色空白
    backgroundColor: '#f5f6f8',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  try { browserWindow.setMenuBarVisibility(false); } catch { /* */ }
  if (!cfg.headless) {
    browserWindow.once('ready-to-show', () => {
      try { browserWindow.show(); } catch { /* */ }
      logLine('窗口已显示');
    });
  }
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

/** 截图判断是否「整窗接近纯白」（DOM 有内容却白屏 = 合成/显卡问题） */
async function looksLikeBlankWhite(browserWindow) {
  try {
    const image = await browserWindow.webContents.capturePage();
    const size = image.getSize();
    if (!size.width || !size.height) return false;
    const bitmap = image.toBitmap(); // BGRA
    let min = 255;
    let max = 0;
    let sum = 0;
    let n = 0;
    for (let i = 0; i + 3 < bitmap.length; i += 4 * 53) {
      const v = (bitmap[i] + bitmap[i + 1] + bitmap[i + 2]) / 3;
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      n += 1;
    }
    const avg = n ? sum / n : 0;
    // 纯白 + 几乎无对比：只有真白屏才会同时满足，避免把「页面还在淡入」误判
    return max - min < 6 && avg >= 235;
  } catch (error) {
    logLine(`截图检测失败: ${error?.message || error}`);
    return false;
  }
}

/** 页面加载完但可能是空白的兜底检查 */
async function inspectPageContent(browserWindow, attempt = 0) {
  if (settled || !browserWindow || browserWindow.isDestroyed()) return;
  let info = null;
  try {
    info = await browserWindow.webContents.executeJavaScript(
      '({ href: location.href, text: (document.body ? document.body.innerText : "").trim().length, html: (document.documentElement ? document.documentElement.outerHTML : "").length })',
      true
    );
  } catch (error) {
    logLine(`内容检查失败: ${error?.message || error}`);
    return;
  }
  if (!info) return;
  logLine(`内容检查 href=${info.href} 文本长度=${info.text} HTML长度=${info.html}`);

  // DOM 几乎是空的：登录墙 / 反爬 / 站点脚本挂了。
  // 有些站点先给空壳再水合，所以隔 6 秒复查两次再下结论。
  if (info.html < 600) {
    if (attempt < 2) {
      setTimeout(() => { inspectPageContent(browserWindow, attempt + 1); }, 6000);
      return;
    }
    settled = true;
    await showDiagnostic(browserWindow, {
      reason: '页面已加载，但内容为空',
      detail: `DOM 长度 ${info.html}（当前地址 ${info.href}）`,
      url: info.href,
    });
    return;
  }

  // DOM 有内容却整窗纯白：显卡/远程桌面合成问题
  if (!cfg.headless && (await looksLikeBlankWhite(browserWindow))) {
    settled = true;
    await showDiagnostic(browserWindow, {
      reason: '页面有内容，但窗口渲染成纯白',
      detail: '疑似显卡/远程桌面硬件合成问题，请按第 4 条开启软件渲染',
      url: info.href,
    });
  }
}

/* ---------------- 启动 ---------------- */
app.whenReady().then(async () => {
  logLine(`启动环境窗口 v${app.getVersion()} profile=${profileId} headless=${cfg.headless ? 1 : 0} target=${targetUrl}`);

  const ses = session.defaultSession;
  if (cfg.userAgent) {
    try {
      ses.setUserAgent(String(cfg.userAgent), String(cfg.acceptLanguages || 'en-US'));
    } catch { /* 老版本 Electron 只支持单参数 */ }
  }
  if (cfg.proxyServer) {
    try {
      await ses.setProxy({
        proxyMode: 'fixed_servers',
        proxyRules: String(cfg.proxyServer),
        proxyBypassRules: '<-loopback>',
      });
      logLine(`代理已设置: ${cfg.proxyServer}`);
    } catch (error) {
      logLine(`代理设置失败: ${error?.message || error}`);
    }
  }

  win = createEnvWindow();
  const webContents = win.webContents;

  // 主框架加载失败（忽略 -3 ERR_ABORTED：站点自身重定向/新导航会打断上一次加载，是正常现象）
  webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    if (errorCode === -3) return;
    if (!validatedURL || validatedURL.startsWith('data:') || validatedURL.startsWith('file:')) return;
    if (validatedURL === 'about:blank') return;
    logLine(`did-fail-load code=${errorCode} desc=${errorDescription} url=${validatedURL}`);
    if (settled) return;
    settled = true;
    showDiagnostic(win, {
      reason: '页面加载失败',
      detail: `${errorDescription}（错误码 ${errorCode}）`,
      url: validatedURL,
    }).catch(() => {});
  });

  webContents.on('render-process-gone', (event, details) => {
    logLine(`render-process-gone reason=${details?.reason} exitCode=${details?.exitCode}`);
    if (settled) return;
    settled = true;
    showDiagnostic(win, {
      reason: '渲染进程已退出',
      detail: `${details?.reason || 'unknown'}${details?.exitCode != null ? `（exitCode ${details.exitCode}）` : ''}`,
      url: targetUrl,
    }).catch(() => {});
  });

  webContents.on('unresponsive', () => logLine('窗口无响应（unresponsive）'));
  webContents.on('responsive', () => logLine('窗口恢复响应'));

  // 先让「加载中」页面真正画出来，再导航：避免导航期间整窗纯白
  const loadingHtml = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>加载中</title>'
    + '<style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;'
    + 'height:100vh;margin:0;color:#6b564a;background:#f5f6f8}i{display:inline-block;width:14px;height:14px;margin-right:10px;'
    + 'border-radius:50%;border:2px solid #f7921e;border-top-color:transparent;animation:s .9s linear infinite;vertical-align:-2px}'
    + '@keyframes s{to{transform:rotate(360deg)}}</style></head><body><div><i></i>正在打开页面，请稍候…</div></body></html>';

  try {
    await loadBuiltinHtml(win, loadingHtml);
    logLine('加载中页面已就绪');
  } catch (error) {
    logLine(`加载中页面失败: ${error?.message || error}`);
  }

  const hardTimeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    showDiagnostic(win, {
      reason: '页面加载超时',
      detail: '90 秒内没有加载完成，通常是网络或账号代理不可用',
      url: targetUrl,
    }).catch(() => {});
  }, 90000);

  try {
    const nav = win.loadURL(targetUrl);
    if (nav && typeof nav.catch === 'function') {
      nav.catch((error) => {
        const code = String(error?.code || '');
        logLine(`loadURL 中断 code=${code} msg=${error?.message || error}`);
        // -3 是重定向/二次导航导致的正常中断
        if (code === '-3' || code === 'ERR_ABORTED') return;
        if (settled) return;
        settled = true;
        showDiagnostic(win, {
          reason: '页面加载失败',
          detail: `${error?.message || error}${code ? `（${code}）` : ''}`,
          url: targetUrl,
        }).catch(() => {});
      });
    }
  } catch (error) {
    logLine(`loadURL 抛错: ${error?.message || error}`);
    settled = true;
    await showDiagnostic(win, { reason: '页面加载失败', detail: error?.message || String(error), url: targetUrl });
  }

  let inspected = false;
  webContents.on('did-finish-load', () => {
    const href = webContents.getURL();
    if (href.startsWith('data:') || href.startsWith('file:')) return;
    clearTimeout(hardTimeout);
    if (inspected || settled) return;
    inspected = true;
    setTimeout(() => { inspectPageContent(win); }, 2500);
  });
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  try { win?.destroy(); } catch { /* */ }
});
