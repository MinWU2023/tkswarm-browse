/**
 * 统一解析应用图标路径（开发 / 打包后窗口、托盘共用）
 */
const path = require('node:path');
const fs = require('node:fs');
const { app, nativeImage } = require('electron');

function iconCandidates() {
  const roots = [
    path.join(__dirname, '../../build'),
    path.join(process.resourcesPath || '', 'icons'),
    path.join(process.resourcesPath || '', 'build'),
  ];
  const names = process.platform === 'win32'
    ? ['icon.ico', 'icon.png']
    : ['icon.png', 'icon.icns', 'icon.ico'];
  const out = [];
  for (const root of roots) {
    if (!root) continue;
    for (const name of names) {
      out.push(path.join(root, name));
    }
  }
  return out;
}

function resolveAppIconPath() {
  for (const candidate of iconCandidates()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* */ }
  }
  return '';
}

function loadAppIcon() {
  const iconPath = resolveAppIconPath();
  if (!iconPath) return null;
  try {
    const image = nativeImage.createFromPath(iconPath);
    return image.isEmpty() ? null : image;
  } catch {
    return null;
  }
}

function applyWindowIcon(win) {
  if (!win || win.isDestroyed?.()) return;
  const icon = loadAppIcon();
  if (!icon) return;
  try { win.setIcon(icon); } catch { /* */ }
}

module.exports = {
  resolveAppIconPath,
  loadAppIcon,
  applyWindowIcon,
};
