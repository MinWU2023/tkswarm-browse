const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const isDev = process.argv.includes('--dev') || process.env.TKSWARM_BROWSER_DEV === '1';

function appDataRoot() {
  if (process.env.TKSWARM_BROWSER_DATA) {
    return path.resolve(process.env.TKSWARM_BROWSER_DATA);
  }
  // electron-builder portable：数据目录在 exe 同级的 data/
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableDir) {
    const dir = path.join(path.resolve(portableDir), 'data');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const base = process.env.APPDATA
    || (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.local', 'share'));
  const dir = path.join(base, 'TkSwarmBrowser');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const DATA_ROOT = appDataRoot();

module.exports = {
  isDev,
  DATA_ROOT,
  DB_PATH: path.join(DATA_ROOT, 'tkswarm-browser.json'),
  PROFILES_DIR: path.join(DATA_ROOT, 'profiles'),
  SETTINGS_PATH: path.join(DATA_ROOT, 'settings.json'),
  API_HOST: process.env.TKSWARM_BROWSER_HOST || '127.0.0.1',
  API_PORT: Number(process.env.TKSWARM_BROWSER_PORT || 54345),
  MAX_ENVS_PER_USER: Number(process.env.TKSWARM_BROWSER_MAX_ENVS || 300),
  /** 同时运行的 Chrome 窗口上限（内存保护）；0 = 不限制 */
  MAX_CONCURRENT_OPENS: Number(process.env.TKSWARM_BROWSER_MAX_CONCURRENT || 20),
  DEFAULT_API_TOKEN: process.env.TKSWARM_BROWSER_TOKEN || '',
  TKSWARM_API_BASE: process.env.TKSWARM_API_BASE || 'http://127.0.0.1:8080/api',
};
