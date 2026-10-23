#!/usr/bin/env node
/**
 * 打包后自检：确认 app.asar 内是否包含新版代理桥（避免误用未重建的 dist/）。
 * 用法：npm run dist:win 之后执行 node scripts/verify-packaged-proxy.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const asar = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');

if (!fs.existsSync(asar)) {
  console.error('未找到 dist/win-unpacked/resources/app.asar，请先执行: npm run dist:win');
  process.exit(1);
}

const distDir = path.join(root, 'dist');
const portable = fs.existsSync(distDir)
  ? fs.readdirSync(distDir).find((n) => /-win-portable\.exe$/i.test(n))
  : null;

const tmp = path.join(require('node:os').tmpdir(), `tkswarm-asar-verify-${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
try {
  execSync(`npx --yes asar extract "${asar}" "${tmp}"`, { stdio: 'inherit', cwd: root });
} catch (e) {
  console.error('解压 asar 失败:', e.message);
  process.exit(1);
}

const proxyAuth = path.join(tmp, 'src', 'browser', 'proxy-auth.js');
const text = fs.readFileSync(proxyAuth, 'utf8');
const checks = [
  ['handleSocksClient', /function handleSocksClient/],
  ['PROXY_BRIDGE_REV', /PROXY_BRIDGE_REV\s*=\s*['"]10['"]/],
  ['系统前置代理探测', /detectSystemProxy/],
  ['上游借道系统代理', /openRawUpstream/],
  ['handshake slot queue', /acquireHandshakeSlot/],
  ['max tunnels config', /MAX_ACTIVE_TUNNELS/],
  ['socks5:// local rules', /socks5:\/\/127\.0\.0\.1/],
  ['no stale proxy.proxyArg in launcher', () => {
    const launcherPath = path.join(tmp, 'src', 'browser', 'electron-launcher.js');
    if (!fs.existsSync(launcherPath)) return true;
    const launcher = fs.readFileSync(launcherPath, 'utf8');
    return !/proxy\.proxyArg/.test(launcher);
  }],
];

let ok = true;
for (const [name, rule] of checks) {
  const pass = typeof rule === 'function' ? rule() : rule.test(text);
  console.log(`${pass ? 'OK' : 'FAIL'}  ${name}`);
  if (!pass) ok = false;
}

const ver = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8')).version;
console.log(`\npackage.json version: ${ver}`);
if (portable) console.log(`portable exe: dist/${portable}`);

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }

if (!ok) {
  console.error('\n打包产物仍是旧代理代码，请重新 npm run dist:win 或从 GitHub Release 下载新包。');
  process.exit(1);
}
console.log('\n打包产物已包含新版代理桥，可分发。');
