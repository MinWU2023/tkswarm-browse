/**
 * 环境窗软件渲染与便携版检测。
 */
const { readSettings } = require('../settings');
const { applyChromiumArgvToApp } = require('./chromium-argv');

function inElectron() {
  return Boolean(process.versions && process.versions.electron);
}

function isRemoteSession() {
  return /rdp|citrix|console-remote/i.test(String(process.env.SESSIONNAME || ''));
}

function isPackagedApp() {
  if (!inElectron()) return false;
  try {
    return Boolean(require('electron').app.isPackaged);
  } catch {
    return false;
  }
}

function isPackagedPortable() {
  if (String(process.env.PORTABLE_EXECUTABLE_DIR || '').trim()) return true;
  return isPackagedApp() && Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
}

function wantSoftwareRender() {
  const env = String(process.env.TKSWARM_ENV_SOFTWARE_RENDER || '').trim();
  if (env === '1') return 'env';
  if (env === '0') return '';
  try {
    const flag = readSettings().envSoftwareRender;
    if (flag === true || flag === 'true') return 'settings';
    if (flag === false || flag === 'false') return '';
  } catch { /* default below */ }
  if (isPackagedPortable()) return 'portable';
  if (isPackagedApp() && process.platform === 'win32') return 'packaged-win';
  if (isRemoteSession()) return 'remote';
  return '';
}

function applySoftwareRenderFlags(app, options = {}) {
  applyChromiumArgvToApp(app, {
    softwareRender: options.softwareRender !== false,
    disableSandbox: options.disableSandbox !== false,
    profileId: options.profileId || '',
  });
}

function bootstrapRenderFlags() {
  if (!inElectron()) return '';
  let app;
  try { app = require('electron').app; } catch { return ''; }
  const reason = wantSoftwareRender();
  if (reason) {
    applySoftwareRenderFlags(app, {
      softwareRender: true,
      disableSandbox: isPackagedApp(),
    });
  }
  return reason;
}

module.exports = {
  wantSoftwareRender,
  applySoftwareRenderFlags,
  bootstrapRenderFlags,
  isPackagedPortable,
  isPackagedApp,
  isRemoteSession,
};
