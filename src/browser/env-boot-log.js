/**
 * 便携双层 Electron 启动诊断：写入 data/logs，便于区分「渲染 crash」vs「about:blank 未绘制」。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function safeDataRoot() {
  try { return require('../config').DATA_ROOT; } catch {
    return path.join(os.tmpdir(), 'tkswarm-boot-log');
  }
}

function bootLogPath(tag) {
  const root = safeDataRoot();
  const dir = path.join(root, 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* */ }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `boot-${tag}-${stamp}.log`);
}

function appendBootLog(file, line) {
  if (!file) return;
  try {
    fs.appendFileSync(file, `${line}\n`);
  } catch { /* */ }
}

function snapshotProcess(tag, extra = {}) {
  const file = bootLogPath(tag);
  const lines = [
    `=== boot ${tag} ${new Date().toISOString()} ===`,
    `pid=${process.pid} ppid=${process.ppid}`,
    `platform=${process.platform} arch=${process.arch}`,
    `execPath=${process.execPath}`,
    `cwd=${process.cwd()}`,
    `argv=${JSON.stringify(process.argv)}`,
    `PORTABLE_EXECUTABLE_FILE=${process.env.PORTABLE_EXECUTABLE_FILE || ''}`,
    `PORTABLE_EXECUTABLE_DIR=${process.env.PORTABLE_EXECUTABLE_DIR || ''}`,
    `PORTABLE_EXECUTABLE_APP_FILENAME=${process.env.PORTABLE_EXECUTABLE_APP_FILENAME || ''}`,
    `SESSIONNAME=${process.env.SESSIONNAME || ''}`,
    `ELECTRON_RUN_AS_NODE=${process.env.ELECTRON_RUN_AS_NODE || ''}`,
  ];
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      lines.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }
  }
  if (inElectron()) {
    try {
      const { app } = require('electron');
      lines.push(`isPackaged=${app.isPackaged}`);
      lines.push(`appPath=${app.getAppPath()}`);
      lines.push(`resourcesPath=${process.resourcesPath || ''}`);
      lines.push(`version=${app.getVersion()}`);
    } catch (e) {
      lines.push(`electronMetaError=${e?.message || e}`);
    }
  }
  for (const line of lines) appendBootLog(file, line);
  return file;
}

function inElectron() {
  return Boolean(process.versions && process.versions.electron);
}

/** 子进程 spawn 前由父进程写入 */
function logSpawnIntent(profileId, payload) {
  const file = path.join(safeDataRoot(), 'logs', `env-${profileId}.log`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `\n[${new Date().toISOString()}] spawn-intent ${JSON.stringify(payload)}\n`);
  } catch { /* */ }
  return file;
}

module.exports = { snapshotProcess, logSpawnIntent, bootLogPath, appendBootLog };
