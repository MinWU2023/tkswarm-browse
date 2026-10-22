const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { PROFILES_DIR } = require('../config');
const { resolveChromeExecutable } = require('./chrome-path');
const { mergeFingerprint, parseResolution, buildUserAgent } = require('./fingerprint');
const { buildInjectScript } = require('./fp-inject');
const { injectFingerprintOnNewDocument, applyEmulation } = require('./cdp-inject');
const { resolveChromeProxy } = require('./proxy-auth');
const { reclaimBeforeOpen, writePid, clearPid, isPidAlive, waitForPidExit } = require('./process-guard');

function profileDir(profileId) {
  const dir = path.join(PROFILES_DIR, String(profileId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' ? addr.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function waitForDevtools(port, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ver = await fetchJson(`http://127.0.0.1:${port}/json/version`);
      if (ver?.webSocketDebuggerUrl) return ver;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Chrome 调试端口启动超时');
}

async function waitForPageTarget(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      const page = Array.isArray(list) && list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

/** Electron 自研内核：等 page target 就绪（含 URL），Playwright connectOverCDP 依赖 Target 事件 */
async function waitForCdpReady(port, timeoutMs = 45000, options = {}) {
  const excludeAboutBlank = options.excludeAboutBlank !== false;
  const urlIncludes = String(options.urlIncludes || '').trim();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      const pages = Array.isArray(list)
        ? list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
        : [];
      const page = pages.find((t) => {
        const url = String(t.url || '');
        if (!url || url.startsWith('devtools://')) return false;
        if (excludeAboutBlank && (url === 'about:blank' || url === 'about:srcdoc')) return false;
        if (urlIncludes && !url.includes(urlIncludes)) return false;
        return true;
      });
      if (page?.webSocketDebuggerUrl) return page;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  const hint = urlIncludes
    ? `（等待页面加载 ${urlIncludes} 超时，请检查网络/代理后重试）`
    : '';
  throw new Error(`CDP page target 未就绪（Playwright 无法连接，请重启浏览器客户端后重试）${hint}`);
}

/**
 * @returns {Promise<{ pid, port, ws, http, headless, userDataDir, process, userAgent, timezone, fp, releaseProxy }>}
 */
async function launchProfile(profile, options = {}) {
  await reclaimBeforeOpen(profile.id);

  const chromePath = resolveChromeExecutable();
  const userDataDir = profileDir(profile.id);
  const fp = mergeFingerprint(JSON.parse(profile.fingerprint_json || '{}'));
  const { width, height } = parseResolution(fp.resolution);
  const userAgent = buildUserAgent(fp);
  const headless = Boolean(options.headless);
  const timezone = profile.timezone || 'America/New_York';
  const locale = profile.language || fp.languages || 'en-US';
  const latitude = Number(profile.latitude || fp.latitude || 0);
  const longitude = Number(profile.longitude || fp.longitude || 0);
  const port = await getFreePort();

  const proxy = await resolveChromeProxy(profile);

  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    // WebRTC：禁止非代理 UDP，降低真实 IP 泄露
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--enforce-webrtc-ip-permission-check',
    `--window-size=${width},${height}`,
    `--lang=${locale}`,
    `--user-agent=${userAgent}`,
    profile.platform || 'https://www.tiktok.com',
  ];

  if (proxy.proxyArg) args.unshift(proxy.proxyArg);

  if (headless) {
    args.push('--headless=new', '--disable-gpu');
  } else {
    args.push('--start-maximized');
  }

  if (Array.isArray(options.args)) {
    for (const a of options.args) {
      if (a && !args.includes(a)) args.push(a);
    }
  }

  const child = spawn(chromePath, args, {
    detached: false,
    stdio: 'ignore',
    windowsHide: headless,
  });
  writePid(profile.id, child.pid);

  let ver;
  try {
    ver = await waitForDevtools(port);
  } catch (e) {
    proxy.release?.();
    clearPid(profile.id);
    try { child.kill(); } catch { /* */ }
    throw e;
  }

  const ws = ver.webSocketDebuggerUrl;
  const httpUrl = `http://127.0.0.1:${port}`;

  // 等首个 page 就绪后再注入（二次 open 时尤为重要）
  await waitForPageTarget(port, 15000);

  // Canvas / WebGL / WebRTC 深度指纹：CDP 注入（失败则短重试）
  const injectSrc = buildInjectScript(profile.id, {
    ...fp,
    languages: locale,
    os: fp.os,
  });
  let injected = false;
  for (let i = 0; i < 3 && !injected; i += 1) {
    const r = await injectFingerprintOnNewDocument(port, injectSrc).catch(() => null);
    injected = Boolean(r?.ok);
    if (!injected) await new Promise((r) => setTimeout(r, 300));
  }
  await applyEmulation(port, { timezone, locale, latitude, longitude }).catch(() => null);

  return {
    pid: child.pid,
    port,
    ws,
    http: httpUrl,
    headless,
    userDataDir,
    process: child,
    userAgent,
    timezone,
    fp,
    releaseProxy: proxy.release || (() => {}),
    localProxyPort: proxy.localPort || 0,
  };
}

function killProcess(proc) {
  if (!proc || proc.killed) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { stdio: 'ignore' });
    } else {
      proc.kill('SIGTERM');
    }
  } catch { /* ignore */ }
}

/** 经 CDP 优雅退出，便于 Cookie/Profile 落盘 */
function gracefulBrowserClose(debugPort, timeoutMs = 4000) {
  const Ws = globalThis.WebSocket;
  if (!Ws || !debugPort) return Promise.resolve(false);
  return fetchJson(`http://127.0.0.1:${debugPort}/json/version`)
    .then((ver) => new Promise((resolve) => {
      if (!ver?.webSocketDebuggerUrl) {
        resolve(false);
        return;
      }
      const ws = new Ws(ver.webSocketDebuggerUrl);
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* */ }
        resolve(false);
      }, timeoutMs);
      ws.onopen = () => {
        ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      };
      ws.onmessage = () => {
        clearTimeout(timer);
        try { ws.close(); } catch { /* */ }
        resolve(true);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
    }))
    .catch(() => false);
}

/** 杀进程并等到退出，避免关窗立刻再开抢锁 */
async function killProcessAndWait(proc, timeoutMs = 8000, debugPort = 0) {
  if (!proc) return true;
  const pid = proc.pid;
  if (debugPort) {
    await gracefulBrowserClose(debugPort, 4000);
    const softGone = await waitForPidExit(pid, Math.min(5000, timeoutMs));
    if (softGone) return true;
  }
  killProcess(proc);
  if (!pid) return true;
  const gone = await waitForPidExit(pid, timeoutMs);
  if (!gone && isPidAlive(pid)) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(pid), '/f', '/t'], { stdio: 'ignore' });
      } else {
        try { process.kill(pid, 'SIGKILL'); } catch { /* */ }
      }
    } catch { /* */ }
    await waitForPidExit(pid, 3000);
  }
  return !isPidAlive(pid);
}

module.exports = {
  launchProfile,
  killProcess,
  killProcessAndWait,
  profileDir,
  clearPid,
  isPidAlive,
  fetchJson,
  // 供 electron-launcher 复用同一套 CDP 等待/注入流程
  getFreePort,
  waitForDevtools,
  waitForPageTarget,
  waitForCdpReady,
};
