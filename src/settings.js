const fs = require('node:fs');
const { SETTINGS_PATH, DEFAULT_API_TOKEN } = require('./config');

function readSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) || {};
    }
  } catch { /* ignore */ }
  return {};
}

function writeSettings(patch) {
  const cur = readSettings();
  const next = { ...cur, ...patch };
  fs.mkdirSync(require('node:path').dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
  return next;
}

function getApiToken() {
  return String(readSettings().apiToken || DEFAULT_API_TOKEN || '');
}

function isAuthorizedRequest(token) {
  const t = String(token || '').trim();
  if (!t) {
    return !!require('./db').getCurrentUser();
  }
  const user = require('./db').getCurrentUser();
  if (user?.token && user.token === t) return true;
  const cfg = getApiToken();
  if (cfg && cfg === t) return true;
  return require('./db').validateApiToken(t);
}

module.exports = { readSettings, writeSettings, getApiToken, isAuthorizedRequest };
