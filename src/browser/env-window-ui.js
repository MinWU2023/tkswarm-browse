/**
 * 环境窗共用：加载中/诊断页、白屏检测、日志（同进程与子进程共用）
 */
const fs = require('node:fs');
const path = require('node:path');
const { DATA_ROOT } = require('../config');

function envLogPath(profileId) {
  const dir = path.join(DATA_ROOT, 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* */ }
  return path.join(dir, `env-${profileId}.log`);
}

function appendEnvLog(profileId, message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  try { console.log(`[env-${profileId}] ${message}`); } catch { /* */ }
  try {
    fs.appendFileSync(envLogPath(profileId), `${line}\n`);
  } catch { /* */ }
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function writeStatusHtml(profileId, html) {
  const file = path.join(DATA_ROOT, 'logs', `env-${profileId}-status.html`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html, 'utf8');
  return file;
}

function buildDiagnosticHtml(profileId, opts = {}) {
  const rows = [
    ['目标地址', opts.url || '—'],
    ['失败原因', opts.reason || '未知'],
    ['错误详情', opts.detail || '—'],
    ['代理设置', opts.proxy || '直连（未绑定代理）'],
    ['代理自检', opts.probe || '检测中…（开窗后约 7 秒出结果，也可看日志）'],
    ['环境 ID', profileId],
    ['数据目录', opts.userDataDir || '—'],
    ['日志文件', envLogPath(profileId)],
    ['时间', new Date().toLocaleString('zh-CN')],
  ].map(([k, v]) => `<tr><th>${escHtml(k)}</th><td>${escHtml(v)}</td></tr>`).join('');

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>环境窗口 - 加载诊断</title>
<style>
  :root{color-scheme:light}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:28px;
       font:14px/1.6 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;color:#1d1310;
       background:radial-gradient(900px 420px at 50% -10%,#ffd2a4a8,transparent 62%),#fdf7f0}
  .card{width:min(760px,100%);background:#fff;border:1px solid #ecdac7;border-radius:16px;padding:26px 28px}
  h1{margin:0 0 6px;font-size:19px}
  .sub{margin:0 0 18px;color:#6b564a}
  table{width:100%;border-collapse:collapse;margin-bottom:18px}
  th,td{padding:8px 0;border-bottom:1px solid #f4e7d8;text-align:left;vertical-align:top}
  th{width:104px;color:#a1897a}
  td{word-break:break-all}
  .tips{margin:0;padding-left:18px;color:#6b564a}
  code{background:#f8ece0;border-radius:5px;padding:1px 6px}
</style></head><body><div class="card">
  <h1>环境窗口没能正常打开页面</h1>
  <p class="sub">下面是诊断信息。请确认已使用最新客户端（v1.0.13+）。</p>
  <table>${rows}</table>
  <ol class="tips">
    <li>先看上面「代理自检」：<b>TikTok 不通 + 中性站通</b> = 代理封了 TikTok 出口（换支持 TikTok 的节点）；<b>两个都不通</b> = 代理服务器本身连不上（过期 / IP 被封 / 端口错）；<b>提示认证被拒</b> = 代理账密填错。</li>
    <li>若错误含 <code>ERR_SOCKS_CONNECTION_FAILED</code>：常见是<b>代理套餐并发太低</b>（日志里 5 条同时超时即典型）。看日志「并发探测 x/6」；可设环境变量 <code>TKSWARM_PROXY_MAX_TUNNELS=5</code> 与套餐一致，或换更高并发节点。</li>
    <li>检查账号代理是否可用，或临时改为直连测试。</li>
    <li>完全退出客户端后重开（托盘也要退出）。</li>
    <li>把 <code>data/logs/env-${escHtml(profileId)}.log</code> 发给技术支持。</li>
  </ol>
</div></body></html>`;
}

const LOADING_HTML = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>加载中</title>'
  + '<style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;display:flex;align-items:center;'
  + 'justify-content:center;height:100vh;margin:0;color:#6b564a;background:#f5f6f8}'
  + 'i{display:inline-block;width:14px;height:14px;margin-right:10px;border-radius:50%;'
  + 'border:2px solid #f7921e;border-top-color:transparent;animation:s .9s linear infinite}'
  + '@keyframes s{to{transform:rotate(360deg)}}</style></head><body>'
  + '<div><i></i>正在打开页面，请稍候…</div></body></html>';

async function loadBuiltinHtml(browserWindow, html) {
  try {
    return await browserWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  } catch (error) {
    return browserWindow.loadURL(`data:text/html,${encodeURIComponent(html)}`).catch(() => null);
  }
}

async function loadStatusPage(win, profileId, html) {
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return;
  } catch (error) {
    appendEnvLog(profileId, `data: URL 失败（${error?.message || error}），回退 file:`);
  }
  try {
    const file = writeStatusHtml(profileId, html);
    const { pathToFileURL } = require('node:url');
    await win.loadURL(pathToFileURL(file).href);
  } catch (error) {
    appendEnvLog(profileId, `file: URL 失败（${error?.message || error}）`);
    await loadBuiltinHtml(win, html);
  }
}

async function waitForMainFrameLoad(webContents, timeoutMs = 15000) {
  if (!webContents.isLoading()) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('加载状态页超时')), timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    webContents.once('did-finish-load', done);
    webContents.once('did-fail-load', done);
  });
}

/** 确保窗口可见且首帧已绘制（避免 ready-to-show 不触发导致长期纯白） */
async function revealEnvWindow(win, profileId, { headless = false } = {}) {
  if (headless || !win || win.isDestroyed()) return;
  try { win.show(); win.focus(); } catch { /* */ }
  try {
    await win.webContents.executeJavaScript(
      'document.body && document.body.innerText && document.body.innerText.length > 0',
      true
    );
  } catch { /* 首帧可能尚未就绪 */ }
  appendEnvLog(profileId, '窗口已显示');
}

async function showDiagnostic(win, profileId, opts = {}) {
  if (!win || win.isDestroyed()) return;
  appendEnvLog(profileId, `显示诊断页：${opts.reason || ''} ${opts.detail || ''}`.trim());
  await loadStatusPage(win, profileId, buildDiagnosticHtml(profileId, opts));
  await revealEnvWindow(win, profileId);
}

async function looksLikeBlankWhite(browserWindow) {
  try {
    const image = await browserWindow.webContents.capturePage();
    const size = image.getSize();
    if (!size.width || !size.height) return false;
    const bitmap = image.toBitmap();
    let min = 255;
    let max = 0;
    let sum = 0;
    let n = 0;
    for (let i = 0; i + 3 < bitmap.length; i += 4 * 53) {
      const v = (bitmap[i] + bitmap[i + 1] + bitmap[i + 2]) / 3;
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      n += 1;
    }
    const avg = n ? sum / n : 0;
    return max - min < 6 && avg >= 235;
  } catch {
    return false;
  }
}

async function loadStatusPageOnWebContents(webContents, profileId, html) {
  if (!webContents || webContents.isDestroyed()) return;
  try {
    webContents.stop();
    await new Promise((r) => setTimeout(r, 80));
  } catch { /* */ }
  try {
    await webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return;
  } catch (error) {
    const msg = String(error?.message || error);
    if (msg.includes('ERR_ABORTED') || msg.includes('(-3)')) return;
    appendEnvLog(profileId, `状态页 data: 失败: ${msg}`);
  }
  try {
    const file = writeStatusHtml(profileId, html);
    const { pathToFileURL } = require('node:url');
    await webContents.loadURL(pathToFileURL(file).href);
  } catch (error) {
    appendEnvLog(profileId, `状态页 file: 失败: ${error?.message || error}`);
  }
}

async function showDiagnosticOnWebContents(webContents, profileId, opts = {}) {
  if (!webContents || webContents.isDestroyed()) return;
  appendEnvLog(profileId, `显示诊断页：${opts.reason || ''} ${opts.detail || ''}`.trim());
  await loadStatusPageOnWebContents(webContents, profileId, buildDiagnosticHtml(profileId, opts));
}

async function inspectBlankContentOnWc(webContents, profileId, opts, attempt = 0) {
  if (!webContents || webContents.isDestroyed()) return false;
  let info = null;
  try {
    info = await webContents.executeJavaScript(
      '({ href: location.href, text: (document.body ? document.body.innerText : "").trim().length,'
      + ' html: (document.documentElement ? document.documentElement.outerHTML : "").length })',
      true
    );
  } catch (error) {
    appendEnvLog(profileId, `内容检查失败: ${error?.message || error}`);
    return false;
  }
  if (!info) return false;
  appendEnvLog(profileId, `内容检查 href=${info.href} 文本=${info.text} html=${info.html}`);

  if (info.html < 600) {
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 6000));
      return inspectBlankContentOnWc(webContents, profileId, opts, attempt + 1);
    }
    await showDiagnosticOnWebContents(webContents, profileId, {
      ...opts,
      reason: '页面已加载，但内容为空',
      detail: `DOM 长度 ${info.html}（${info.href}）`,
      url: info.href,
    });
    return true;
  }
  return false;
}

async function inspectBlankContent(browserWindow, profileId, opts, attempt = 0) {
  if (!browserWindow || browserWindow.isDestroyed()) return false;
  let info = null;
  try {
    info = await browserWindow.webContents.executeJavaScript(
      '({ href: location.href, text: (document.body ? document.body.innerText : "").trim().length,'
      + ' html: (document.documentElement ? document.documentElement.outerHTML : "").length })',
      true
    );
  } catch (error) {
    appendEnvLog(profileId, `内容检查失败: ${error?.message || error}`);
    return false;
  }
  if (!info) return false;
  appendEnvLog(profileId, `内容检查 href=${info.href} 文本=${info.text} html=${info.html}`);

  if (info.html < 600) {
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 6000));
      return inspectBlankContent(browserWindow, profileId, opts, attempt + 1);
    }
    await showDiagnostic(browserWindow, profileId, {
      ...opts,
      reason: '页面已加载，但内容为空',
      detail: `DOM 长度 ${info.html}（${info.href}）`,
      url: info.href,
    });
    return true;
  }

  if (await looksLikeBlankWhite(browserWindow)) {
    await showDiagnostic(browserWindow, profileId, {
      ...opts,
      reason: '页面有内容，但窗口渲染成纯白',
      detail: '请完全退出客户端后重开；若仍白屏请换 setup 安装版',
      url: info.href,
    });
    return true;
  }
  return false;
}

module.exports = {
  appendEnvLog,
  envLogPath,
  LOADING_HTML,
  loadStatusPage,
  loadStatusPageOnWebContents,
  loadBuiltinHtml,
  waitForMainFrameLoad,
  revealEnvWindow,
  showDiagnostic,
  showDiagnosticOnWebContents,
  inspectBlankContent,
  inspectBlankContentOnWc,
};
