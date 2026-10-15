const express = require('express');
const db = require('../db');
const manager = require('../browser/manager');
const auth = require('../auth/service');
const { readSettings, writeSettings } = require('../settings');
const { TKSWARM_API_BASE } = require('../config');

const router = express.Router();

router.get('/api/settings', (req, res) => {
  const s = readSettings();
  res.json({
    ok: true,
    apiBase: s.apiBase || TKSWARM_API_BASE,
  });
});

router.get('/api/dashboard/stats', (req, res) => {
  const user = db.getCurrentUser();
  if (!user) return res.json({ ok: false, message: '未登录' });
  const self = db.statsForOwner(user.id);
  const children = auth.fetchChildrenStats(user).catch?.(() => []) || [];
  res.json({
    ok: true,
    user: { id: user.id, username: user.username, nickname: user.nickname, role: user.role_name },
    self,
    children: typeof children.then === 'function' ? [] : children,
    windows: manager.listWindows(),
  });
});

router.get('/api/dashboard/stats/async', async (req, res) => {
  const user = db.getCurrentUser();
  if (!user) return res.json({ ok: false, message: '未登录' });
  const children = await auth.fetchChildrenStats(user);
  res.json({
    ok: true,
    user: { id: user.id, username: user.username, nickname: user.nickname, role: user.role_name },
    token: user.token || '',
    self: db.statsForOwner(user.id),
    children,
    windows: manager.listWindows(),
  });
});

router.post('/api/auth/login', async (req, res) => {
  try {
    const { apiBase, username, password, captcha, captchaKey } = req.body || {};
    const pack = await auth.login({ apiBase, username, password, captcha, captchaKey });
    res.json({ ok: true, ...pack });
  } catch (e) {
    res.json({ ok: false, message: e.message || '登录失败' });
  }
});

router.post('/api/auth/logout', (req, res) => {
  auth.logout();
  res.json({ ok: true });
});

router.get('/api/auth/status', (req, res) => {
  const user = db.getCurrentUser();
  res.json({ ok: true, loggedIn: !!user, user: user ? {
    id: user.id, username: user.username, nickname: user.nickname, role: user.role_name,
  } : null });
});

router.post('/api/windows/:id/show', async (req, res) => {
  try {
    const data = await manager.showWindow(req.params.id);
    res.json({ ok: true, data });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

router.post('/api/windows/:id/close', async (req, res) => {
  try {
    await manager.closeProfile(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

module.exports = router;
