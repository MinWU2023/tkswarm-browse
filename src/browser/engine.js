/**
 * 浏览器内核引擎选择：
 *  - electron：用自研 Electron 本体承载窗口（默认，窗口即「第一页自研浏览器」）
 *  - chrome：旧的方案，拉起系统 Chrome / Chromium 进程
 *
 * 优先级：环境变量 TKSWARM_BROWSER_ENGINE > data/settings.json 的 engine > 默认 electron（仅 Electron 会话内可用）
 */
const { readSettings } = require('../settings');

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
  // 默认：Electron 控制台内用自研内核；纯 node（standalone-server）退回 Chrome
  return inElectron() ? 'electron' : 'chrome';
}

module.exports = { resolveEngine, normalizeEngine, inElectron };
