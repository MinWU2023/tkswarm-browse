const express = require('express');
const db = require('../db');
const manager = require('../browser/manager');
const auth = require('../auth/service');
const { readSettings, writeSettings } = require('../settings');
const { TKSWARM_API_BASE, DATA_ROOT, SETTINGS_PATH } = require('../config');
const { resolveEngine, useInProcessEnvWindows } = require('../browser/engine');
const { getMainCdpPort } = require('../browser/env-session-host');
const { wantSoftwareRender, isPackagedPortable, isPackagedApp } = require('../browser/render-flags');

const router = express.Router();

function resolveApiBaseForUi() {
  const saved = String(readSettings().apiBase || '').trim().replace(/\/+$/, '');
  const fallback = String(TKSWARM_API_BASE).trim().replace(/\/+$/, '');
  // 旧版默认/误填的本机地址 → 一律回退线上，避免每次登录都要手改
  if (!saved || /127\.0\.0\.1|localhost/i.test(saved)) {
    return fallback;
  }
  return saved;
}

router.get('/api/settings', (req, res) => {
  res.json({
    ok: true,
    apiBase: resolveApiBaseForUi(),
    defaultApiBase: String(TKSWARM_API_BASE).trim().replace(/\/+$/, ''),
  });
});

/** 便携版排障：确认 settings.json 是否改对了目录 */
router.get('/api/system/info', (req, res) => {
  const s = readSettings();
  res.json({
    ok: true,
    dataRoot: DATA_ROOT,
    settingsPath: SETTINGS_PATH,
    portableDir: process.env.PORTABLE_EXECUTABLE_DIR || '',
    engine: resolveEngine(),
    envWindowMode: useInProcessEnvWindows() ? 'in-process' : 'subprocess',
    portableExecutableFile: process.env.PORTABLE_EXECUTABLE_FILE || '',
    mainCdpPort: getMainCdpPort(),
    envSoftwareRender: s.envSoftwareRender === true || s.envSoftwareRender === 'true',
    softwareRenderActive: Boolean(wantSoftwareRender()),
    softwareRenderReason: wantSoftwareRender() || '',
    packagedPortable: isPackagedPortable(),
    packagedApp: isPackagedApp(),
    version: require('../../package.json').version,
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

/** 控制台顶部：直连测试环境窗（不走代理，打开 https://www.dyyseo.com） */
router.post('/api/test/open-env-window', async (req, res) => {
  const user = db.getCurrentUser();
  if (!user) return res.json({ ok: false, message: '请先登录' });
  try {
    const data = await manager.openTestEnvWindow();
    res.json({ ok: true, data, url: 'https://www.dyyseo.com' });
  } catch (e) {
    res.json({ ok: false, message: e.message || '测试环境窗打开失败' });
  }
});

module.exports = router;
