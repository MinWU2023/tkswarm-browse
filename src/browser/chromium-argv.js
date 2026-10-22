/**
 * 子 Electron 进程的 Chromium 启动参数。
 * 双层 portable 架构下，父进程 app.commandLine 不会继承到子进程，必须经 spawn argv 传入。
 */
const WIN_FEATURES = ['RendererCodeIntegrity', 'CalculateNativeWinOcclusion', 'Vulkan'];

/**
 * @param {{ softwareRender?: boolean, disableSandbox?: boolean, profileId?: string }} options
 * @returns {string[]}
 */
function buildChildChromiumArgv(options = {}) {
  const {
    softwareRender = true,
    disableSandbox = true,
    profileId = '',
  } = options;

  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--remote-allow-origins=*',
    `--disable-features=${WIN_FEATURES.join(',')}`,
  ];

  if (disableSandbox) {
    args.push('--no-sandbox', '--disable-gpu-sandbox');
  }

  if (softwareRender) {
    args.push('--disable-gpu', '--disable-gpu-compositing', '--use-angle=swiftshader');
  }

  if (profileId) {
    args.push(`--tkswarm-profile=${profileId}`);
  }

  return args;
}

/** 将 argv 开关同步到 app.commandLine（子进程 main.js 兜底，须在 app.ready 前） */
function applyChromiumArgvToApp(app, options = {}) {
  if (!app) return;
  if (options.softwareRender !== false) {
    try { app.disableHardwareAcceleration(); } catch { /* */ }
  }
  for (const arg of buildChildChromiumArgv(options)) {
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq > 0) {
      app.commandLine.appendSwitch(body.slice(0, eq), body.slice(eq + 1));
    } else {
      app.commandLine.appendSwitch(body);
    }
  }
}

function bootFingerprint() {
  return {
    execPath: process.execPath,
    cwd: process.cwd(),
    resourcesPath: process.resourcesPath,
    portableFile: process.env.PORTABLE_EXECUTABLE_FILE || '',
    portableDir: process.env.PORTABLE_EXECUTABLE_DIR || '',
    argv: process.argv.slice(1),
    pid: process.pid,
  };
}

module.exports = {
  buildChildChromiumArgv,
  applyChromiumArgvToApp,
  bootFingerprint,
  WIN_FEATURES,
};
