/**
 * 版本升级 / 便携版换目录时，把旧 data 目录合并到当前 DATA_ROOT，避免环境绑定「二次失效」。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function hasProfileData(root) {
  if (!root || !fs.existsSync(root)) return false;
  const db = path.join(root, 'tkswarm-browser.json');
  const profiles = path.join(root, 'profiles');
  if (fs.existsSync(db)) {
    try {
      const pack = readJson(db);
      if (Array.isArray(pack?.profiles) && pack.profiles.length) return true;
    } catch { /* */ }
  }
  if (fs.existsSync(profiles)) {
    try {
      const names = fs.readdirSync(profiles);
      if (names.some((n) => fs.statSync(path.join(profiles, n)).isDirectory())) return true;
    } catch { /* */ }
  }
  return false;
}

function copyFileSafe(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) return false;
  fs.copyFileSync(src, dest);
  return true;
}

function copyDirMerge(src, dest) {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dest, { recursive: true });
  let copied = 0;
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    if (fs.existsSync(to)) continue;
    const st = fs.statSync(from);
    if (st.isDirectory()) {
      copied += copyDirMerge(from, to);
    } else {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      copied += 1;
    }
  }
  return copied;
}

function candidateLegacyRoots(currentRoot) {
  const out = [];
  const seen = new Set();
  const push = (dir) => {
    const abs = path.resolve(String(dir || ''));
    if (!abs || seen.has(abs) || abs === path.resolve(currentRoot)) return;
    seen.add(abs);
    out.push(abs);
  };

  const appData = process.env.APPDATA
    || (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.local', 'share'));
  push(path.join(appData, 'TkSwarmBrowser'));

  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableDir) {
    push(path.join(path.resolve(portableDir), 'data'));
  }

  const settingsPath = path.join(currentRoot, 'settings.json');
  const settings = readJson(settingsPath) || {};
  if (settings.lastDataRoot) push(settings.lastDataRoot);
  if (settings.migratedFrom) push(settings.migratedFrom);

  for (const legacy of out) {
    const legacySettings = readJson(path.join(legacy, 'settings.json'));
    if (legacySettings?.lastDataRoot) push(legacySettings.lastDataRoot);
  }

  return out.filter((root) => hasProfileData(root));
}

/**
 * @param {string} currentRoot
 * @returns {{ migrated: boolean, from?: string, files?: number }}
 */
function migrateIntoDataRoot(currentRoot) {
  fs.mkdirSync(currentRoot, { recursive: true });
  const settingsPath = path.join(currentRoot, 'settings.json');
  let settings = readJson(settingsPath) || {};

  if (hasProfileData(currentRoot)) {
    settings.lastDataRoot = currentRoot;
    writeJson(settingsPath, settings);
    return { migrated: false };
  }

  const sources = candidateLegacyRoots(currentRoot);
  for (const legacy of sources) {
    if (!hasProfileData(legacy)) continue;
    let files = 0;
    files += copyDirMerge(path.join(legacy, 'profiles'), path.join(currentRoot, 'profiles'));
    if (copyFileSafe(path.join(legacy, 'tkswarm-browser.json'), path.join(currentRoot, 'tkswarm-browser.json'))) {
      files += 1;
    }
    copyFileSafe(path.join(legacy, 'settings.json'), path.join(currentRoot, 'settings.json'));
    settings = readJson(settingsPath) || {};
    settings.migratedFrom = legacy;
    settings.lastDataRoot = currentRoot;
    settings.migratedAt = new Date().toISOString();
    writeJson(settingsPath, settings);
    return { migrated: true, from: legacy, files };
  }

  settings.lastDataRoot = currentRoot;
  writeJson(settingsPath, settings);
  return { migrated: false };
}

module.exports = { migrateIntoDataRoot, hasProfileData };
