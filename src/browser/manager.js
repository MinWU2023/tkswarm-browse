const { EventEmitter } = require('node:events');
const { launchProfile, killProcessAndWait, clearPid, isPidAlive } = require('./launcher');
const { launchProfileElectron } = require('./electron-launcher');
const { resolveEngine, useInProcessEnvWindows } = require('./engine');
const { reclaimOrphans } = require('./process-guard');
const { MAX_CONCURRENT_OPENS } = require('../config');
const db = require('../db');
const { buildTestProfile, isTestProfileId, TEST_PROFILE_ID } = require('./test-env');

/** @type {Map<string, object>} */
const running = new Map();
const queue = [];
let queueBusy = false;
const events = new EventEmitter();

/** 启动时清理无主 Chrome 残留 */
try {
  reclaimOrphans(new Set());
} catch { /* ignore */ }

function listWindows() {
  // 用户直接点窗口关闭时子进程会退出，这里顺带清理掉已死的 session
  for (const id of [...running.keys()]) dropStaleSession(id);
  return [...running.entries()].map(([id, s]) => ({
    id,
    profileId: id,
    name: s.profile?.name || id,
    ownerId: s.profile?.owner_id || 0,
    pid: s.pid,
    headless: s.headless,
    engine: s.engine || 'chrome',
    ws: s.ws,
    http: s.http,
    port: s.port,
    startedAt: s.startedAt,
  }));
}

function isSessionAlive(session) {
  if (!session) return false;
  if (session.inProcess && session.window && !session.window.isDestroyed()) return true;
  if (session.pid && isPidAlive(session.pid)) return true;
  if (session.process?.pid && isPidAlive(session.process.pid)) return true;
  return false;
}

/** 丢弃已死但未从 map 清掉的 session */
function dropStaleSession(id) {
  const session = running.get(id);
  if (!session) return false;
  if (isSessionAlive(session)) return false;
  try { session.releaseProxy?.(); } catch { /* */ }
  clearPid(id);
  running.delete(id);
  if (!isTestProfileId(id)) db.setProfileStatus(id, 'idle');
  return true;
}

async function processQueue() {
  if (queueBusy || !queue.length) return;
  queueBusy = true;
  const job = queue.shift();
  try {
    const result = await job.run();
    job.resolve(result);
  } catch (e) {
    job.reject(e);
  } finally {
    queueBusy = false;
    processQueue();
  }
}

function enqueueOpen(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ run: fn, resolve, reject });
    processQueue();
  });
}

function profileProxyKey(profile) {
  if (!profile) return '';
  return [
    profile.proxy_type || '',
    profile.proxy_host || '',
    profile.proxy_port || 0,
    profile.proxy_user || '',
    profile.proxy_pass ? '1' : '0',
  ].join('|');
}

async function openProfile(profileId, options = {}) {
  const id = String(profileId);
  dropStaleSession(id);
  const forceRelaunch = Boolean(options.forceRelaunch);
  const existing = running.get(id);
  if (forceRelaunch && existing) {
    await closeProfile(id).catch(() => {});
  } else if (existing?.ws && isSessionAlive(existing)) {
    const fresh = db.getProfile(id);
    const proxyChanged = fresh && profileProxyKey(fresh) !== profileProxyKey(existing.profile);
    const metaNewer = fresh?.updated_at && existing.startedAt
      && String(fresh.updated_at) > String(existing.startedAt);
    if (proxyChanged || metaNewer) {
      await closeProfile(id).catch(() => {});
    } else {
      return formatOpenResult(id, existing);
    }
  }
  if (existing) dropStaleSession(id);

  return enqueueOpen(async () => {
    dropStaleSession(id);
    if (running.has(id) && isSessionAlive(running.get(id))) {
      return formatOpenResult(id, running.get(id));
    }

    // 扫掉队列等待期间死去的 session，再按上限保护内存
    for (const rid of [...running.keys()]) dropStaleSession(rid);
    const maxConc = Number(MAX_CONCURRENT_OPENS || 0);
    if (maxConc > 0 && running.size >= maxConc) {
      throw new Error(`同时打开窗口已达上限 ${maxConc}，请先关闭部分环境后再试（可用 TKSWARM_BROWSER_MAX_CONCURRENT 调整）`);
    }

    let profile = db.getProfile(id);
    if (!profile) throw new Error('browser环境不存在或已删除');
    try {
      const { enrichProfileProxyFromApi } = require('./proxy-enrich');
      profile = await enrichProfileProxyFromApi(profile);
    } catch (error) {
      console.warn(`[manager] 代理 API 补全跳过: ${error?.message || error}`);
    }

    const engine = resolveEngine();
    let launched;
    if (engine === 'electron' && useInProcessEnvWindows()) {
      const { launchProfileInProcess } = require('./env-session-host');
      launched = await launchProfileInProcess(profile, { headless: options.headless, args: options.args });
    } else if (engine === 'electron') {
      launched = await launchProfileElectron(profile, { headless: options.headless, args: options.args });
    } else {
      launched = await launchProfile(profile, { headless: options.headless, args: options.args });
    }

    const session = {
      ...launched,
      profile,
      startedAt: new Date().toISOString(),
    };
    running.set(id, session);
    if (!isTestProfileId(id)) db.setProfileStatus(id, options.headless ? 'headless' : 'running');
    events.emit('window-open', listWindows());
    return formatOpenResult(id, session);
  });
}

/** 顶部菜单 / 控制台：直连测试环境窗（不走代理，打开 TkSwarm 官网） */
async function openTestEnvWindow() {
  const profile = buildTestProfile();
  const id = TEST_PROFILE_ID;
  dropStaleSession(id);
  const existing = running.get(id);
  if (existing && isSessionAlive(existing)) {
    await closeProfile(id).catch(() => {});
  }

  return enqueueOpen(async () => {
    dropStaleSession(id);

    const engine = resolveEngine();
    let launched;
    if (engine === 'electron' && useInProcessEnvWindows()) {
      const { launchProfileInProcess } = require('./env-session-host');
      launched = await launchProfileInProcess(profile, { headless: false });
    } else if (engine === 'electron') {
      launched = await launchProfileElectron(profile, { headless: false });
    } else {
      launched = await launchProfile(profile, { headless: false });
    }

    const session = {
      ...launched,
      profile,
      isTest: true,
      startedAt: new Date().toISOString(),
    };
    running.set(id, session);
    events.emit('window-open', listWindows());
    return formatOpenResult(id, session);
  });
}

function formatOpenResult(id, session) {
  const fp = session.fp || {};
  const inProcess = Boolean(session.inProcess);
  return {
    id,
    ws: session.ws,
    // 同进程多窗口共享主 CDP：Playwright 必须连 page ws，browser 根 http 看不到 partition 环境窗
    http: inProcess ? '' : session.http,
    pid: session.pid,
    name: session.profile?.name || id,
    seq: session.profile?.seq,
    engine: session.engine || 'chrome',
    coreVersion: fp.coreVersion || '131',
    headless: session.headless,
    inProcess,
  };
}

async function closeProfile(profileId) {
  const id = String(profileId);
  const session = running.get(id);
  if (!session) {
    clearPid(id);
    if (!isTestProfileId(id)) db.setProfileStatus(id, 'idle');
    return { ok: true };
  }
  if (session.inProcess) {
    const { closeInProcessWindow } = require('./env-session-host');
    await closeInProcessWindow(id);
  } else {
    await killProcessAndWait(
      session.process,
      10000,
      session.engine === 'electron' ? 0 : (session.port || 0)
    );
  }
  try { session.releaseProxy?.(); } catch { /* */ }
  clearPid(id);
  running.delete(id);
  if (!isTestProfileId(id)) db.setProfileStatus(id, 'idle');
  events.emit('window-close', listWindows());
  return { ok: true };
}

/** 无头 → 有头：关旧进程再以有头模式重开 */
async function showWindow(profileId) {
  const id = String(profileId);
  const session = running.get(id);
  if (session && !session.headless && isSessionAlive(session)) {
    return formatOpenResult(id, session);
  }
  await closeProfile(id);
  return openProfile(id, { headless: false, queue: true });
}

function getSession(profileId) {
  const id = String(profileId);
  dropStaleSession(id);
  return running.get(id) || null;
}

module.exports = {
  openProfile,
  openTestEnvWindow,
  closeProfile,
  showWindow,
  listWindows,
  getSession,
  events,
};
