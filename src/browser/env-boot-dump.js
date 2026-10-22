/**
 * 环境子进程启动诊断：写入 env-<profileId>.log，便于 portable 双层 spawn 排障。
 */
const { bootFingerprint } = require('./chromium-argv');

function dumpEnvBoot(logLine) {
  const fp = bootFingerprint();
  const lines = [
    `boot.execPath=${fp.execPath}`,
    `boot.cwd=${fp.cwd}`,
    `boot.resourcesPath=${fp.resourcesPath || ''}`,
    `boot.PORTABLE_EXECUTABLE_FILE=${fp.portableFile}`,
    `boot.PORTABLE_EXECUTABLE_DIR=${fp.portableDir}`,
    `boot.pid=${fp.pid}`,
    `boot.argv=${JSON.stringify(fp.argv)}`,
  ];
  for (const line of lines) {
    try { logLine(line); } catch { /* */ }
  }
}

module.exports = { dumpEnvBoot };
