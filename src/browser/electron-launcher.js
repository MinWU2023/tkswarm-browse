/**
 * 自研内核启动器：用「第一页自研浏览器」本体（Electron）承载每个环境的窗口。
 *
 * 与 launcher.js（拉起系统 Chrome）返回完全相同的结构，
 * 区别只在于被拉起的进程是我们自己的 exe —— 窗口标题、图标、菜单都是自研的。
 *
 * 关键点：
 *  - 每个环境一个子进程 + 独立 userData（profiles/<id>）→ Cookie/登录态隔离
 *  - 每个子进程带 --remote-debugging-port → CDP ws 独立，Playwright connectOverCDP 照常可用
 *  - 指纹注入 / 时区 / 语言 / 地理位置沿用 launcher 的同一套 CDP 注入
 *  - 代理仍走 proxy-auth 的本地桥（有账密时），父进程持有，子进程连本地端口
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const { mergeFingerprint, parseResolution, buildUserAgent } = require('./fingerprint');
const { buildInjectScript } = require('./fp-inject');
const { injectFingerprintOnNewDocument, applyEmulation } = require('./cdp-inject');
const { resolveChromeProxy } = require('./proxy-auth');
const { reclaimBeforeOpen, writePid, clearPid } = require('./process-guard');
const { profileDir, getFreePort, waitForDevtools, waitForPageTarget } = require('./launcher');
const { readSettings } = require('../settings');

/** 环境进程内指纹注入开关：settings.json 里 fpInjectElectron=false 可关闭 */
function fpInjectEnabled() {
  try {
    return readSettings().fpInjectElectron !== false;
  } catch {
    return true;
  }
}

/** 应用根目录（含 package.json），dev 模式下作为 electron 的首个参数 */
const APP_ROOT = path.resolve(__dirname, '../..');

function resolveSelfExecutable() {
  let appRef = null;
  try {
    // 只在 Electron 主进程里可用；纯 node（standalone-server）拿不到
    appRef = require('electron').app;
  } catch {
    appRef = null;
  }
  if (!appRef || typeof appRef.isPackaged !== 'boolean') {
    throw new Error('自研内核需要在 Electron 控制台内运行；纯 node 模式请设 TKSWARM_BROWSER_ENGINE=chrome');
  }
  return { execPath: process.execPath, packaged: appRef.isPackaged };
}

/**
 * @returns {Promise<object>} 与 launchProfile 相同结构
 */
async function launchProfileElectron(profile, options = {}) {
  await reclaimBeforeOpen(profile.id);

  const { execPath, packaged } = resolveSelfExecutable();
  const fp = mergeFingerprint(JSON.parse(profile.fingerprint_json || '{}'));
  const { width, height } = parseResolution(fp.resolution);
  const userAgent = buildUserAgent(fp);
  const headless = Boolean(options.headless);
  const timezone = profile.timezone || 'America/New_York';
  const locale = profile.language || fp.languages || 'en-US';
  const latitude = Number(profile.latitude || fp.latitude || 0);
  const longitude = Number(profile.longitude || fp.longitude || 0);
  const port = await getFreePort();
  const userDataDir = profileDir(profile.id);
  const proxy = await resolveChromeProxy(profile);

  const displayName = profile.name || String(profile.id);
  const injectSrc = buildInjectScript(profile.id, {
    ...fp,
    languages: locale,
    os: fp.os,
  });
  const envConfig = {
    profileId: String(profile.id),
    name: displayName,
    userDataDir,
    headless,
    width,
    height,
    userAgent,
    acceptLanguages: locale,
    startUrl: profile.platform || 'https://www.tiktok.com',
    title: `${displayName} - 第一页自研浏览器`,
    // 代理：子进程侧用 session.setProxy 确定性生效（命令行开关仅作兜底）
    proxyServer: proxy.proxyArg ? String(proxy.proxyArg).replace(/^--proxy-server=/, '') : '',
    // 指纹与仿真：在环境进程内用 webContents.debugger 注入（父进程 CDP 注入在 Electron 主进程里没有 WebSocket，会空转）
    injectScript: injectSrc,
    timezone,
    locale,
    latitude,
    longitude,
    fpInject: fpInjectEnabled(),
  };

  const args = [];
  // 未打包时 process.execPath 是 electron.exe，首个参数必须给应用目录
  if (!packaged) args.push(APP_ROOT);
  args.push(
    '--tkswarm-env',
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    // WebRTC：禁止非代理 UDP，降低真实 IP 泄露
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--enforce-webrtc-ip-permission-check',
    `--lang=${locale}`,
    `--user-agent=${userAgent}`,
  );
  if (proxy.proxyArg) args.push(proxy.proxyArg);
  if (headless) args.push('--tkswarm-headless');

  const child = spawn(execPath, args, {
    detached: false,
    stdio: 'ignore',
    windowsHide: headless,
    env: { ...process.env, TKSWARM_ENV_CONFIG: JSON.stringify(envConfig) },
  });
  writePid(profile.id, child.pid);

  let ver;
  try {
    ver = await waitForDevtools(port);
  } catch (error) {
    proxy.release?.();
    clearPid(profile.id);
    try { child.kill(); } catch { /* */ }
    throw new Error(`自研内核窗口启动超时（port ${port}）：${error?.message || error}`);
  }

  const ws = ver.webSocketDebuggerUrl;
  const httpUrl = `http://127.0.0.1:${port}`;

  // 等首个 page target 就绪后再注入，避免注入落到空白页
  await waitForPageTarget(port, 15000).catch(() => null);

  // 兜底注入：子进程已用 webContents.debugger 注入过；这里只在环境进程注入未生效时补一次
  let injected = false;
  for (let i = 0; i < 2 && !injected; i += 1) {
    const r = await injectFingerprintOnNewDocument(port, injectSrc).catch(() => null);
    injected = Boolean(r?.ok);
    if (!injected) await new Promise((res) => setTimeout(res, 300));
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
    engine: 'electron',
    releaseProxy: proxy.release || (() => {}),
    localProxyPort: proxy.localPort || 0,
  };
}

module.exports = { launchProfileElectron, APP_ROOT };
