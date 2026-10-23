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
const { app, session } = require('electron');
const { createEnvChrome } = require('./env-chrome');
const { resolveChromeProxy, PROXY_BRIDGE_REV, MAX_ACTIVE_TUNNELS } = require('./proxy-auth');
const { probeProxySummary, probeBurst } = require('./proxy-probe');
const { showDiagnosticOnWebContents, inspectBlankContentOnWc } = require('./env-window-ui');
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
let releaseProxy = () => {};
/** 上游代理自检结果（异步填充，诊断页用） */
let proxyProbeText = '';

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

function bindContentWatchers(webContents, proxyDisplay) {
  if (!webContents) return;
  let pageLoadedOk = false;
  const diagOpts = {
    url: targetUrl,
    proxy: proxyDisplay || '直连（未绑定代理）',
    userDataDir: String(cfg.userDataDir || ''),
    // getter：自检是异步的，诊断页展开时取当时的结果
    get probe() { return proxyProbeText; },
  };

  webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    if (errorCode === -3) return;
    if (!validatedURL || validatedURL.startsWith('data:') || validatedURL.startsWith('file:')) return;
    if (validatedURL === 'about:blank') return;
    logLine(`did-fail-load code=${errorCode} desc=${errorDescription} url=${validatedURL}`);
    if (pageLoadedOk) {
      logLine('页面此前已成功加载，本次导航失败不切换诊断页（可手动刷新或检查代理并发）');
      return;
    }
    if (settled) return;
    settled = true;
    showDiagnosticOnWebContents(webContents, profileId, {
      ...diagOpts,
      reason: '页面加载失败',
      detail: `${errorDescription}（错误码 ${errorCode}）`,
      url: validatedURL,
    }).catch(() => {});
  });

  webContents.on('render-process-gone', (event, details) => {
    logLine(`render-process-gone reason=${details?.reason} exitCode=${details?.exitCode}`);
    if (settled) return;
    settled = true;
    showDiagnosticOnWebContents(webContents, profileId, {
      ...diagOpts,
      reason: '渲染进程已退出',
      detail: `${details?.reason || 'unknown'}${details?.exitCode != null ? `（exitCode ${details.exitCode}）` : ''}`,
      url: targetUrl,
    }).catch(() => {});
  });

  const hardTimeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    showDiagnosticOnWebContents(webContents, profileId, {
      ...diagOpts,
      reason: '页面加载超时',
      detail: '90 秒内没有加载完成，通常是网络或账号代理不可用',
      url: targetUrl,
    }).catch(() => {});
  }, 90000);

  let inspected = false;
  webContents.on('did-finish-load', () => {
    const href = webContents.getURL();
    if (href.startsWith('data:') || href.startsWith('file:')) return;
    pageLoadedOk = true;
    clearTimeout(hardTimeout);
    if (inspected || settled) return;
    inspected = true;
    setTimeout(() => {
      inspectBlankContentOnWc(webContents, profileId, diagOpts).catch(() => {});
    }, 2500);
  });
}

/* ---------------- 启动 ---------------- */
app.whenReady().then(async () => {
  logLine(`启动环境窗口 v${app.getVersion()} profile=${profileId} headless=${cfg.headless ? 1 : 0} target=${targetUrl} PROXY_BRIDGE_REV=${PROXY_BRIDGE_REV} PROXY_MAX_TUNNELS=${MAX_ACTIVE_TUNNELS}`);

  const contentSes = session.defaultSession;
  const shellSes = session.fromPartition(`env-chrome-shell-${profileId}`, { cache: false });
  try {
    await shellSes.setProxy({ proxyMode: 'direct' });
  } catch (error) {
    logLine(`工具栏 session 直连设置失败: ${error?.message || error}`);
  }
  if (cfg.userAgent) {
    try {
      contentSes.setUserAgent(String(cfg.userAgent), String(cfg.acceptLanguages || 'en-US'));
    } catch { /* 老版本 Electron 只支持单参数 */ }
  }
  let proxyRules = String(cfg.proxyServer || '').trim();
  if (cfg.proxyMeta && cfg.proxyMeta.proxy_host) {
    if (!cfg.proxyMeta.proxy_user || !cfg.proxyMeta.proxy_pass) {
      logLine(`警告：环境代理账密不完整（user=${cfg.proxyMeta.proxy_user ? '有' : '无'} pass=${cfg.proxyMeta.proxy_pass ? '有' : '无'}）；需要认证的 SOCKS 将握手失败`);
    }
    try {
      const local = await resolveChromeProxy(cfg.proxyMeta, {
        onError: (error, dest) => {
          const target = dest ? `${dest.host}:${dest.port}` : '';
          logLine(`子进程代理桥转发失败${target ? ` → ${target}` : ''}: ${error?.message || error}`);
        },
        onLog: (message) => logLine(`[bridge] ${message}`),
      });
      releaseProxy = local.release || (() => {});
      proxyRules = local.proxyRules || String(local.proxyArg || '').replace(/^--proxy-server=/, '');
      if (proxyRules) {
        const authHint = (cfg.proxyMeta.proxy_user && cfg.proxyMeta.proxy_pass) ? '（含账密）' : '（账密不完整）';
        const viaBridge = local.localPort ? '本地桥' : '直连上游';
        logLine(`子进程代理已就绪（${viaBridge}）: ${proxyRules} → 上游 ${cfg.proxyMeta.proxy_type}://${cfg.proxyMeta.proxy_host}:${cfg.proxyMeta.proxy_port}${authHint}`);
      }
    } catch (error) {
      logLine(`子进程代理桥启动失败: ${error?.message || error}`);
    }
  }
  async function ensureContentProxy() {
    if (!proxyRules) return;
    await contentSes.setProxy({
      proxyMode: 'fixed_servers',
      proxyRules,
      proxyBypassRules: '<local>',
    });
  }

  if (proxyRules) {
    try {
      await ensureContentProxy();
      logLine(`代理已设置（仅内容标签页）: ${proxyRules}`);
    } catch (error) {
      logLine(`代理设置失败: ${error?.message || error}`);
    }
  }

  const bridgeHint = (() => {
    if (!cfg.proxyMeta?.proxy_host) return '';
    const isLocalBridge = /^socks5:\/\/127\.0\.0\.1:\d+$/i.test(String(proxyRules || ''));
    if (isLocalBridge) return `（本地桥 ${proxyRules}）`;
    if (cfg.proxyMeta.proxy_user || cfg.proxyMeta.proxy_pass) return '（直连上游，账密应由本地桥转发）';
    return '（直连上游，无账密）';
  })();
  const proxyDisplay = cfg.proxyMeta?.proxy_host
    ? `上游 ${cfg.proxyMeta.proxy_type}://${cfg.proxyMeta.proxy_host}:${cfg.proxyMeta.proxy_port}${bridgeHint}`
    : (proxyRules || cfg.proxyServer || '直连（未绑定代理）');

  const chrome = await createEnvChrome({
    profileId,
    userDataDir: String(cfg.userDataDir || ''),
    width: Number(cfg.width) || 1280,
    height: Number(cfg.height) || 800,
    windowTitle,
    startUrl: targetUrl,
    shellSession: shellSes,
    contentSession: contentSes,
    ensureContentProxy,
    onContentWebContents: (wc) => bindContentWatchers(wc, proxyDisplay),
    headless: Boolean(cfg.headless),
    log: logLine,
  });
  win = chrome.window;
  win.on('closed', () => {
    win = null;
    app.quit();
  });

  const contentWc = chrome.getActiveWebContents();
  contentWc?.on('unresponsive', () => logLine('窗口无响应（unresponsive）'));
  contentWc?.on('responsive', () => logLine('窗口恢复响应'));
  logLine('环境浏览器外壳已就绪');

  // 上游代理自检：与开窗并行，不拖慢打开速度；结果写日志，并在诊断页补上结论
  if (cfg.proxyMeta?.proxy_host) {
    void probeProxySummary(cfg.proxyMeta, { timeoutMs: 7000 })
      .then(async (text) => {
        try {
          const burst = await probeBurst(cfg.proxyMeta, { count: 6, timeoutMs: 8000 });
          const hint = burst.ok > 0
            ? `；并发探测 ${burst.ok}/${burst.count} 条同时成功（代理套餐并发约 ${burst.ok}，可设 TKSWARM_PROXY_MAX_TUNNELS=${Math.max(2, burst.ok)}）`
            : `；并发探测 0/${burst.count}（代理可能暂不可用或并发极低）`;
          text = `${text}${hint}`;
        } catch { /* */ }
        proxyProbeText = text;
        logLine(`代理自检: ${text}`);
        try {
          const wc = chrome.getActiveWebContents();
          const href = wc?.getURL() || '';
          if (settled && wc && (href.startsWith('data:') || href.startsWith('file:'))) {
            showDiagnosticOnWebContents(wc, profileId, {
              url: targetUrl,
              proxy: proxyDisplay,
              userDataDir: String(cfg.userDataDir || ''),
              probe: text,
              reason: '代理不可用（见「代理自检」）',
              detail: '上游代理没能建立到目标站点的连接，页面未加载',
            }).catch(() => {});
          }
        } catch { /* */ }
      })
      .catch((error) => logLine(`代理自检异常: ${error?.message || error}`));
  }
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  try { releaseProxy(); } catch { /* */ }
  try { win?.destroy(); } catch { /* */ }
});
