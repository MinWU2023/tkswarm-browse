const { EventEmitter } = require('node:events');
const { launchProfile, killProcessAndWait, clearPid, isPidAlive } = require('./launcher');
const { reclaimOrphans } = require('./process-guard');
const { MAX_CONCURRENT_OPENS } = require('../config');
const db = require('../db');

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
  return [...running.entries()].map(([id, s]) => ({
    id,
    profileId: id,
    name: s.profile?.name || id,
    ownerId: s.profile?.owner_id || 0,
    pid: s.pid,
    headless: s.headless,
    ws: s.ws,
    http: s.http,
    port: s.port,
    startedAt: s.startedAt,
  }));
}

function isSessionAlive(session) {
  if (!session) return false;
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
  db.setProfileStatus(id, 'idle');
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

async function openProfile(profileId, options = {}) {
  const id = String(profileId);
  dropStaleSession(id);
  const existing = running.get(id);
  if (existing?.ws && isSessionAlive(existing)) {
    return formatOpenResult(id, existing);
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

    const profile = db.getProfile(id);
    if (!profile) throw new Error('browser环境不存在或已删除');

    const launched = await launchProfile(profile, {
      headless: options.headless,
      args: options.args,
    });

    const session = {
      ...launched,
      profile,
      startedAt: new Date().toISOString(),
    };
    running.set(id, session);
    db.setProfileStatus(id, options.headless ? 'headless' : 'running');
    events.emit('window-open', listWindows());
    return formatOpenResult(id, session);
  });
}

function formatOpenResult(id, session) {
  const fp = session.fp || {};
  return {
    id,
    ws: session.ws,
    http: session.http,
    pid: session.pid,
    name: session.profile?.name || id,
    seq: session.profile?.seq,
    coreVersion: fp.coreVersion || '131',
    headless: session.headless,
  };
}

async function closeProfile(profileId) {
  const id = String(profileId);
  const session = running.get(id);
  if (!session) {
    clearPid(id);
    db.setProfileStatus(id, 'idle');
    return { ok: true };
  }
  await killProcessAndWait(session.process, 10000, session.port || 0);
  try { session.releaseProxy?.(); } catch { /* */ }
  clearPid(id);
  running.delete(id);
  db.setProfileStatus(id, 'idle');
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
  closeProfile,
  showWindow,
  listWindows,
  getSession,
  events,
};
