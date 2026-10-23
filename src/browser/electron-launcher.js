/**
 * 自研内核启动器：便携版子进程必须用 PORTABLE_EXECUTABLE_FILE 拉起（不能用 Temp 内层 exe）。
 * 所有 GPU / RCI / 沙箱开关经 buildChildChromiumArgv 写入 spawn argv。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { mergeFingerprint, parseResolution, buildUserAgent } = require('./fingerprint');
const { reclaimBeforeOpen, writePid, clearPid } = require('./process-guard');
const { DATA_ROOT } = require('../config');
const { wantSoftwareRender, isRemoteSession } = require('./render-flags');
const { buildChildChromiumArgv } = require('./chromium-argv');
const {
  profileDir, getFreePort, waitForDevtools, waitForCdpReady, fetchJson,
} = require('./launcher');

const APP_ROOT = path.resolve(__dirname, '../..');

function envLogFile(profileId) {
  const dir = path.join(DATA_ROOT, 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* */ }
  return path.join(dir, `env-${profileId}.log`);
}

function appendLog(file, line) {
  if (!file) return;
  try { fs.appendFileSync(file, line.endsWith('\n') ? line : `${line}\n`); } catch { /* */ }
}

function readLogTail(file, maxLines = 14) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    return lines.slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}

function resolveSelfExecutable() {
  let appRef = null;
  try { appRef = require('electron').app; } catch { appRef = null; }
  if (!appRef || typeof appRef.isPackaged !== 'boolean') {
    throw new Error('自研内核需要在 Electron 控制台内运行；纯 node 模式请设 TKSWARM_BROWSER_ENGINE=chrome');
  }
  return { packaged: appRef.isPackaged };
}

function resolveEnvSpawnExecutable(packaged) {
  const portableFile = String(process.env.PORTABLE_EXECUTABLE_FILE || '').trim();
  const portableDir = String(process.env.PORTABLE_EXECUTABLE_DIR || '').trim();
  if (packaged && portableFile && fs.existsSync(portableFile)) {
    return { electronBin: portableFile, kind: 'portable-wrapper' };
  }
  if (packaged && portableDir) {
    const appName = String(process.env.PORTABLE_EXECUTABLE_APP_FILENAME || 'TkSwarmBrowser.exe').trim();
    const guess = path.join(portableDir, appName);
    if (fs.existsSync(guess)) {
      return { electronBin: guess, kind: 'portable-dir' };
    }
    try {
      const hit = fs.readdirSync(portableDir)
        .filter((n) => /portable.*\.exe$/i.test(n) || n === 'TkSwarmBrowser.exe')
        .map((n) => path.join(portableDir, n))
        .find((p) => fs.existsSync(p));
      if (hit) return { electronBin: hit, kind: 'portable-scan' };
    } catch { /* */ }
  }
  return { electronBin: process.execPath, kind: packaged ? 'installed-inner' : 'dev-electron' };
}

function buildChildEnv(profileId, softwareRender) {
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  childEnv.TKSWARM_ENV_SOFTWARE_RENDER = softwareRender ? '1' : '0';
  return childEnv;
}

async function launchProfileElectron(profile, options = {}) {
  await reclaimBeforeOpen(profile.id);

  const { packaged } = resolveSelfExecutable();
  const { electronBin, kind: spawnKind } = resolveEnvSpawnExecutable(packaged);
  const fp = mergeFingerprint(JSON.parse(profile.fingerprint_json || '{}'));
  const { width, height } = parseResolution(fp.resolution);
  const userAgent = buildUserAgent(fp);
  const headless = Boolean(options.headless);
  const timezone = profile.timezone || 'America/New_York';
  const locale = profile.language || fp.languages || 'en-US';
  const port = await getFreePort();
  const userDataDir = profileDir(profile.id);
  // 代理桥必须在环境子进程内启动（父进程桥子进程连不上；Electron setProxy 直连上游 SOCKS 也不稳定）
  let proxyMeta = null;
  if (profile.proxy_type && profile.proxy_type !== 'noproxy' && profile.proxy_host) {
    proxyMeta = {
      proxy_type: profile.proxy_type,
      proxy_host: profile.proxy_host,
      proxy_port: profile.proxy_port,
      proxy_user: profile.proxy_user,
      proxy_pass: profile.proxy_pass,
    };
  }

  const logFile = envLogFile(profile.id);
  const softwareRender = Boolean(wantSoftwareRender());
  const remoteSession = isRemoteSession();
  const profileId = String(profile.id);

  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.accessSync(userDataDir, fs.constants.W_OK);
  } catch (error) {
    appendLog(logFile, `警告：Profile 目录不可写（${error?.message || error}）：${userDataDir}`);
  }

  const displayName = profile.name || profileId;
  const startUrl = String(profile.platform || 'https://www.tiktok.com');
  const envConfig = {
    profileId,
    name: displayName,
    userDataDir,
    headless,
    width,
    height,
    userAgent,
    acceptLanguages: locale,
    startUrl,
    title: `${displayName} - 第一页自研浏览器`,
    proxyServer: '',
    proxyMeta,
    timezone: profile.timezone || 'America/New_York',
    locale,
    latitude: Number(profile.latitude || fp.latitude || 0),
    longitude: Number(profile.longitude || fp.longitude || 0),
    softwareRender,
  };

  const chromiumArgs = buildChildChromiumArgv({
    softwareRender,
    disableSandbox: packaged,
    profileId,
  });

  const args = [
    ...chromiumArgs,
    '--tkswarm-env',
    `--remote-debugging-port=${port}`,
    '--enable-logging=file',
    `--log-file=${path.join(DATA_ROOT, 'logs', `env-${profileId}-chromium.log`)}`,
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--enforce-webrtc-ip-permission-check',
    `--lang=${locale}`,
    `--user-agent=${userAgent}`,
  ];
  if (!packaged) args.unshift(APP_ROOT);
  if (proxy.proxyArg && !proxyMeta) args.push(proxy.proxyArg);
  if (headless) args.push('--tkswarm-headless');

  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(electronBin);
  const portableFile = process.env.PORTABLE_EXECUTABLE_FILE || electronBin;
  const spawnCwd = portableDir && fs.existsSync(portableDir) ? portableDir : undefined;

  appendLog(logFile, [
    '',
    `=== ${new Date().toISOString()} 打开环境 ${profileId}（${displayName}）===`,
    `spawn=${electronBin} kind=${spawnKind}`,
    `parent.inner=${process.execPath}`,
    `spawn.cwd=${spawnCwd || process.cwd()}`,
    `chromiumArgv=${chromiumArgs.join(' ')}`,
    `port=${port} headless=${headless ? 1 : 0}`,
    `startUrl=${startUrl}`,
    `userData=${userDataDir}`,
    `proxy=${proxyMeta ? `上游 ${proxyMeta.proxy_type}://${proxyMeta.proxy_host}:${proxyMeta.proxy_port}（子进程内建桥）` : '直连'}`,
    `远程会话=${remoteSession ? 1 : 0} 软件渲染=${softwareRender ? 1 : 0}`,
  ].join('\n'));

  const childEnv = buildChildEnv(profileId, softwareRender);
  childEnv.PORTABLE_EXECUTABLE_DIR = portableDir;
  childEnv.PORTABLE_EXECUTABLE_FILE = portableFile;
  childEnv.TKSWARM_ENV_CONFIG = JSON.stringify(envConfig);

  const child = spawn(electronBin, args, {
    detached: false,
    stdio: 'ignore',
    windowsHide: headless,
    cwd: spawnCwd,
    env: childEnv,
  });
  child.on('error', (error) => appendLog(logFile, `[spawn error] ${error?.message || error}`));
  child.on('exit', (code, signal) => appendLog(logFile, `[env 进程退出] code=${code} signal=${signal}`));
  writePid(profile.id, child.pid);

  let ver;
  try {
    ver = await waitForDevtools(port);
  } catch (error) {
    clearPid(profile.id);
    try { child.kill(); } catch { /* */ }
    const tail = readLogTail(logFile);
    throw new Error(
      `自研内核窗口启动失败（CDP 端口 ${port} 未就绪）：${error?.message || error}`
      + (tail ? `\n--- data/logs/env-${profile.id}.log ---\n${tail}` : '')
    );
  }

  const httpUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForCdpReady(port, 30000, { excludeAboutBlank: true });
  } catch (error) {
    let pages = [];
    try {
      const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      pages = (Array.isArray(list) ? list : [])
        .filter((t) => t.type === 'page')
        .map((t) => String(t.url || ''));
    } catch { /* */ }
    clearPid(profile.id);
    try { child.kill(); } catch { /* */ }
    const tail = readLogTail(logFile);
    throw new Error(
      `${error?.message || error}`
      + (pages.length ? `\n窗口当前页面：${pages.join(' | ')}` : '')
      + (tail ? `\n--- data/logs/env-${profile.id}.log ---\n${tail}` : '')
    );
  }

  let ws = ver.webSocketDebuggerUrl;
  try {
    const fresh = await fetchJson(`http://127.0.0.1:${port}/json/version`);
    if (fresh?.webSocketDebuggerUrl) ws = fresh.webSocketDebuggerUrl;
  } catch { /* */ }

  appendLog(logFile, `CDP 就绪 port=${port} ws=${ws}`);

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
    inProcess: false,
    releaseProxy: () => {},
    localProxyPort: 0,
  };
}

module.exports = {
  launchProfileElectron,
  APP_ROOT,
  wantSoftwareRender,
  isRemoteSession,
  resolveEnvSpawnExecutable,
  buildChildChromiumArgv,
};
