/**
 * 浏览器内核引擎选择：
 *  - electron：用自研 Electron 本体承载窗口（默认，窗口即「第一页自研浏览器」）
 *  - chrome：旧的方案，拉起系统 Chrome / Chromium 进程
 *
 * 优先级：环境变量 TKSWARM_BROWSER_ENGINE > data/settings.json 的 engine > 默认 electron（仅 Electron 会话内可用）
 */
const { readSettings } = require('../settings');
const { isPackagedPortable, isPackagedApp } = require('./render-flags');

function inElectron() {
  return Boolean(process.versions && process.versions.electron);
}

function normalizeEngine(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'electron' || v === 'chrome') return v;
  return '';
}

function resolveEngine() {
  const fromEnv = normalizeEngine(process.env.TKSWARM_BROWSER_ENGINE);
  if (fromEnv) return fromEnv === 'electron' && !inElectron() ? 'chrome' : fromEnv;
  let cfg = '';
  try {
    cfg = normalizeEngine(readSettings().engine);
  } catch { /* settings 读不到就用默认 */ }
  if (cfg) return cfg === 'electron' && !inElectron() ? 'chrome' : cfg;
  return inElectron() ? 'electron' : 'chrome';
}

/**
 * 环境窗是否在同进程打开。
 * 打包版（便携/安装）默认走 Electron 子进程：每环境独立 CDP + userData，与 env-window.js 一致。
 * 便携版子进程必须通过 PORTABLE_EXECUTABLE_FILE 拉起（见 electron-launcher.js），不能用 Temp 内 exe。
 * 仅开发模式（npm start）默认同进程，便于调试。
 */
function useInProcessEnvWindows() {
  if (!inElectron() || process.argv.includes('--tkswarm-env')) return false;
  if (String(process.env.TKSWARM_ENV_SUBPROCESS || '') === '1') return false;
  try {
    const s = readSettings();
    if (s.envUseInProcess === true || s.envUseInProcess === 'true') return true;
    if (s.envUseSubprocess === true || s.envUseSubprocess === 'true') return false;
  } catch { /* default below */ }
  if (isPackagedPortable() || isPackagedApp()) return false;
  return true;
}

module.exports = { resolveEngine, normalizeEngine, inElectron, useInProcessEnvWindows };
