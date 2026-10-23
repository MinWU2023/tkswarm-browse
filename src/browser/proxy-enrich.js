/**
 * 开窗前从中心 API 拉取绑定账号的代理账密，写入本地 profile。
 * 比特浏览器引擎原生支持 SOCKS 账密；自研浏览器必须落库后才能建本地桥。
 */
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const { getApiToken, readSettings } = require('../settings');
const { TKSWARM_API_BASE, DATA_ROOT } = require('../config');

function apiBase() {
  const s = readSettings();
  const base = String(s.apiBase || TKSWARM_API_BASE || '').trim().replace(/\/+$/, '');
  return base || String(TKSWARM_API_BASE).replace(/\/+$/, '');
}

function authToken() {
  const user = db.getCurrentUser();
  return String(user?.token || getApiToken() || '').trim();
}

function appendLog(profileId, message) {
  const line = `[${new Date().toISOString()}] [proxy-enrich] ${message}`;
  try { console.log(line); } catch { /* */ }
  try {
    const dir = path.join(DATA_ROOT, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `env-${profileId}.log`), `${line}\n`);
  } catch { /* */ }
}

async function fetchJson(url, token) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json.message || json.msg || res.statusText || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  const ok = json.success === true || json.code === 0 || json.code === 200;
  if (!ok && json.success !== undefined) {
    throw new Error(json.message || json.msg || 'API 返回失败');
  }
  return json.data !== undefined ? json.data : json;
}

/**
 * @param {string} profileId
 * @returns {Promise<object|null>}
 */
async function fetchProfileProxyBundle(profileId) {
  const token = authToken();
  if (!token) return null;
  const url = `${apiBase()}/node/browser-profiles/${encodeURIComponent(profileId)}/proxy-bundle`;
  try {
    return await fetchJson(url, token);
  } catch (error) {
    appendLog(profileId, `API 拉取代理失败: ${error?.message || error}`);
    return null;
  }
}

function proxyNeedsEnrich(profile) {
  if (!profile?.proxy_host || !profile?.proxy_port) return true;
  const user = String(profile.proxy_user || '').trim();
  const pass = String(profile.proxy_pass || '');
  return !user || !pass;
}

/**
 * 开窗前调用：本地缺账密时从 API 补全并写回 db.json
 * @param {object} profile
 * @returns {Promise<object>} 最新 profile（可能已更新）
 */
async function enrichProfileProxyFromApi(profile) {
  if (!profile?.id) return profile;
  const token = authToken();
  if (!token) {
    if (proxyNeedsEnrich(profile)) {
      appendLog(profile.id, '未登录中心 API，无法拉取代理账密（请先在自研浏览器控制台登录）');
    }
    return profile;
  }

  const bundle = await fetchProfileProxyBundle(profile.id);
  if (!bundle?.hasProxy) {
    if (proxyNeedsEnrich(profile) && profile.proxy_host) {
      appendLog(profile.id, '中心库未找到该环境绑定账号的代理，或账号未绑代理');
    }
    return profile;
  }

  const nextUser = String(bundle.username || '').trim();
  const nextPass = String(bundle.password || '');
  const sameEndpoint = String(profile.proxy_host || '') === String(bundle.host || '')
    && Number(profile.proxy_port || 0) === Number(bundle.port || 0);
  const sameCreds = String(profile.proxy_user || '').trim() === nextUser
    && String(profile.proxy_pass || '') === nextPass;

  if (sameEndpoint && sameCreds && !proxyNeedsEnrich(profile)) {
    return profile;
  }

  db.updateProfileProxy(profile.id, {
    proxyType: bundle.protocol || profile.proxy_type || 'socks5',
    host: bundle.host,
    port: bundle.port,
    proxyUserName: nextUser,
    proxyPassword: nextPass,
    proxyId: bundle.proxy_id,
  });
  appendLog(
    profile.id,
    `已从中心 API 同步代理 ${bundle.protocol}://${bundle.host}:${bundle.port}`
    + `（user=${nextUser ? '有' : '无'} pass=${nextPass ? '有' : '无'} account=#${bundle.account_id || '?'})`,
  );
  return db.getProfile(profile.id) || profile;
}

module.exports = {
  enrichProfileProxyFromApi,
  fetchProfileProxyBundle,
  proxyNeedsEnrich,
};
