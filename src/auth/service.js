const db = require('../db');
const { TKSWARM_API_BASE } = require('../config');
const { writeSettings } = require('../settings');

function normalizeApiBase(raw) {
  const fallback = String(TKSWARM_API_BASE).replace(/\/+$/, '');
  const base = String(raw || fallback).trim().replace(/\/+$/, '');
  if (/127\.0\.0\.1|localhost/i.test(base)) return fallback;
  return base || fallback;
}

async function login({ apiBase, username, password, captcha, captchaKey }) {
  const base = normalizeApiBase(apiBase);
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username, password, captcha, captchaKey }),
  });
  const json = await res.json().catch(() => ({}));
  const ok = json.success === true || json.code === 0 || json.code === 200;
  if (!res.ok || !ok) {
    throw new Error(json.message || json.msg || '登录失败');
  }
  const data = json.data || json;
  const token = data.token || data.accessToken || '';
  const user = data.user || {};
  const role = user.role || user.roleName || (Number(user.role_id) === 1 ? '超级管理员' : 'user');
  db.saveUser({
    id: Number(user.id || 0),
    username: user.username || username,
    nickname: user.nickname || '',
    token,
    role_name: role,
    is_super: user.isSuper || user.roleId === 1 ? 1 : 0,
    parent_id: 0,
  });
  if (token) {
    db.setApiToken(token);
    writeSettings({ apiToken: token, apiBase: base });
    // 与 Node 共用 PHP 登录 Token，写入用户设置后 Node 无需再手动复制
    fetch(`${base}/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ tkswarmBrowserApiToken: token }),
    }).catch(() => {});
  }
  return { token, user: db.getCurrentUser() };
}

function logout() {
  const fs = require('node:fs');
  const { DB_PATH } = require('../config');
  try {
    if (fs.existsSync(DB_PATH)) {
      const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      data.users = [];
      data.sessions = [];
      fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
    }
  } catch { /* ignore */ }
}

async function fetchChildrenStats(user) {
  if (!user?.token) return [];
  const base = String(process.env.TKSWARM_API_BASE || TKSWARM_API_BASE).replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/auth/status`, {
      headers: { Authorization: `Bearer ${user.token}`, Accept: 'application/json' },
    });
    const json = await res.json().catch(() => ({}));
    const body = json.data || json;
    const children = body.children || [];
    return children.map((c) => ({
      id: c.id,
      username: c.username,
      nickname: c.nickname || c.username,
      ...db.statsForOwner(c.id),
    }));
  } catch {
    return [];
  }
}

module.exports = { login, logout, fetchChildrenStats };
