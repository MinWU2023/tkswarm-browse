/**
 * 本地状态页 + 代理自检页
 * ---------------------------------------------------------------
 * 解决两个日常问题：
 *   1) 浏览器打开 http://127.0.0.1:54345 只看到 "Cannot GET /" → 现在有状态页
 *      （端口活着、版本号、登录态、自研内核引擎）
 *   2) 「代理明明可用，自研浏览器就是连不上」→ /proxy-test 直接在这台机器上
 *      用 Node 裸连代理，分三步（TCP / SOCKS 认证 / CONNECT）报出原因，
 *      再并发开 5 条连接，看代理的并发上限。
 */
const express = require('express');
const { DATA_ROOT, API_HOST, API_PORT } = require('../config');
const { probeDest, probeBurst } = require('../browser/proxy-probe');
const { describeUpstreamRoute } = require('../browser/proxy-auth');

function appVersion() {
  try {
    return require('electron').app.getVersion();
  } catch {
    try {
      return require('../../package.json').version;
    } catch {
      return 'unknown';
    }
  }
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STYLE = `
:root{color-scheme:light}
body{margin:0;padding:32px;font:14px/1.65 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;color:#1d1310;
     background:radial-gradient(900px 420px at 50% -10%,#ffd2a4a8,transparent 62%),#fdf7f0}
.card{max-width:820px;margin:0 auto;background:#fff;border:1px solid #ecdac7;border-radius:16px;padding:26px 28px}
h1{margin:0 0 4px;font-size:20px}
h2{margin:26px 0 8px;font-size:15px;color:#8a6f5d}
.sub{margin:0 0 20px;color:#6b564a}
table{width:100%;border-collapse:collapse;margin:10px 0}
th,td{padding:7px 0;border-bottom:1px solid #f4e7d8;text-align:left;vertical-align:top;word-break:break-all}
th{width:120px;color:#a1897a;font-weight:400}
input[type=text]{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #e3cdb8;border-radius:10px;font:13px/1.4 ui-monospace,Consolas,monospace}
button{margin-top:12px;padding:10px 20px;border:0;border-radius:10px;background:#f7921e;color:#fff;font-size:14px;cursor:pointer}
a{color:#c2610a}
code{background:#f8ece0;border-radius:5px;padding:1px 6px}
.ok{color:#1a7f37;font-weight:600}
.bad{color:#c0392b;font-weight:600}
.warn{color:#b4690e;font-weight:600}
.tip{color:#6b564a;font-size:13px;margin:10px 0 0}
`;

function page(title, body) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>${STYLE}</style></head><body><div class="card">${body}</div></body></html>`;
}

function parseProxy(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const withScheme = raw.includes('://') ? raw : `socks5://${raw}`;
  try {
    const url = new URL(withScheme);
    const type = url.protocol.replace(':', '').toLowerCase();
    if (!url.hostname) return null;
    return {
      proxy_type: type === 'socks' ? 'socks5' : type,
      proxy_host: url.hostname,
      proxy_port: Number(url.port) || (type === 'https' ? 443 : 1080),
      proxy_user: decodeURIComponent(url.username || ''),
      proxy_pass: decodeURIComponent(url.password || ''),
    };
  } catch {
    return null;
  }
}

function renderStatus() {
  const version = appVersion();
  const table = [
    ['服务状态', '<span class="ok">运行中</span>'],
    ['地址', esc(`http://${API_HOST}:${API_PORT}`)],
    ['版本', esc(version)],
    ['数据目录', esc(DATA_ROOT)],
  ].map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');

  return page('TkSwarm 自研浏览器 - 本地服务', `
  <h1>本地服务运行中</h1>
  <p class="sub">自研浏览器内核（Node 侧 CDP）。这个页面能打开，就说明 54345 端口是通的。</p>
  <table>${table}</table>
  <h2>代理连不上？</h2>
  <p class="sub">用 <a href="/proxy-test">代理自检</a> 在这台机器上直接测：TCP 通不通、SOCKS 认证对不对、CONNECT 会不会被拒、并发 5 条能成几条。<br>
  手上代理多的话，用 <a href="/proxy-batch">批量检测</a> 一次测完，直接看哪些能到 TikTok。</p>
  `);
}

function renderForm(input = '', extra = '') {
  return page('代理自检', `
  <h1>代理自检</h1>
  <p class="sub">在这台机器上用 Node 裸连代理，绕开浏览器，直接看是哪一步断的。最多等 15 秒。</p>
  <form method="post" action="/proxy-test">
    <input type="text" name="proxy" value="${esc(input)}" placeholder="socks5://用户名:密码@1.2.3.4:1080" autofocus>
    <button type="submit">开始检测</button>
  </form>
  <p class="tip">支持 <code>socks5://</code>、<code>http://</code>；不带协议默认按 socks5 处理。<br>
  不给账密也行：<code>socks5://1.2.3.4:1080</code>。</p>
  ${extra}
  `);
}

function buildRouter() {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));

  router.get('/', (req, res) => {
    res.type('html').send(renderStatus());
  });

  router.get('/proxy-test', (req, res) => {
    res.type('html').send(renderForm(String(req.query.proxy || '')));
  });

  router.post('/proxy-test', async (req, res) => {
    const input = String(req.body?.proxy || '').trim();
    const meta = parseProxy(input);
    if (!meta) return res.type('html').send(renderForm(input, '<p class="tip bad">代理格式不对，示例：socks5://user:pass@1.2.3.4:1080</p>'));
    if (!['socks5', 'socks', 'http', 'https'].includes(meta.proxy_type)) {
      return res.type('html').send(renderForm(input, '<p class="tip bad">只支持 socks5 / http 代理</p>'));
    }
    if (meta.proxy_type === 'http' || meta.proxy_type === 'https') {
      return res.type('html').send(renderForm(input, '<p class="tip warn">目前只对 SOCKS5 代理做逐项自检（自研浏览器接的也是 SOCKS5）。HTTP 代理请改用「测试环境窗」验证。</p>'));
    }

    let html = '';
    try {
      const neutral = await probeDest({ host: meta.proxy_host, port: meta.proxy_port, user: meta.proxy_user, pass: meta.proxy_pass, destHost: 'www.gstatic.com', destPort: 443, timeoutMs: 5000 });
      const tiktok = await probeDest({ host: meta.proxy_host, port: meta.proxy_port, user: meta.proxy_user, pass: meta.proxy_pass, destHost: 'www.tiktok.com', destPort: 443, timeoutMs: 5000 });
      const burst = await probeBurst(meta, { count: 3, destHost: 'www.tiktok.com', timeoutMs: 5000, sequential: true, gapMs: 200 });

      const mark = (r) => (r.ok ? '<span class="ok">通</span>' : '<span class="bad">不通</span>');
      const route = await describeUpstreamRoute().catch(() => '未知');
      const rows = [
        ['上游链路', esc(route)],
        ['代理', esc(`${meta.proxy_type}://${meta.proxy_host}:${meta.proxy_port}${meta.proxy_user ? '（含账密）' : '（无账密）'}`)],
        ['到 TikTok', `${mark(tiktok)} ${esc(tiktok.message)}（${tiktok.ms}ms）`],
        ['到中性站', `${mark(neutral)} ${esc(neutral.message)}（${neutral.ms}ms）`],
        ['顺序 3 条', `${burst.ok === 3 ? '<span class="ok">' : burst.ok === 0 ? '<span class="bad">' : '<span class="warn">'}${burst.ok}/3 成功</span>`],
      ].map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');

      let verdict;
      if (tiktok.ok && burst.ok >= 2) {
        verdict = '<p class="tip ok">这台机器用这个代理没问题。若自研浏览器还连不上，把 data/logs/env-*.log 发我。</p>';
      } else if (neutral.ok && !tiktok.ok) {
        verdict = '<p class="tip bad">代理能出网，但 TikTok 被代理侧拦了（换支持 TikTok 的节点）。</p>';
      } else if (!tiktok.ok && burst.ok === 0) {
        verdict = '<p class="tip bad">这台机器连不上这个代理：换一个代理，或确认代理是否绑定了别的出口 IP。</p>';
      } else {
        verdict = '<p class="tip warn">代理时好时坏 / 并发被限。TikTok 首页一次要开十几条连接，这种代理一定会批量失败，换不限并发或开隧道模式的套餐。</p>';
      }

      html = renderForm(input, `<h2>结果</h2><table>${rows}</table>${verdict}
      <p class="tip">有 100 多个代理？用 <a href="/proxy-batch">批量检测</a> 一次测完，看哪些从这台机器真能到 TikTok。</p>`);
    } catch (error) {
      html = renderForm(input, `<p class="tip bad">检测异常：${esc(error?.message || error)}</p>`);
    }
    res.type('html').send(html);
  });

  /* -------- 批量检测：一次贴一堆代理，看哪些真能到 TikTok -------- */

  router.get('/proxy-batch', (req, res) => {
    res.type('html').send(renderBatchForm('', ''));
  });

  router.post('/proxy-batch', async (req, res) => {
    const raw = String(req.body?.proxies || '');
    const lines = raw.split(/[\r\n,;\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 300);
    if (!lines.length) {
      return res.type('html').send(renderBatchForm(raw, '<p class="tip bad">没有可检测的代理，一行一个</p>'));
    }

    const startedAt = Date.now();
    const results = await mapLimit(lines, 5, async (line) => {
      const meta = parseProxy(line);
      if (!meta) return { line, ok: false, message: '格式不对' };
      if (meta.proxy_type === 'http' || meta.proxy_type === 'https') {
        return { line, ok: false, message: '仅支持 SOCKS5 自检' };
      }
      const r = await probeDest({
        host: meta.proxy_host,
        port: meta.proxy_port,
        user: meta.proxy_user,
        pass: meta.proxy_pass,
        destHost: 'www.tiktok.com',
        destPort: 443,
        timeoutMs: 5000,
      });
      return { line, ok: r.ok, message: `${r.message}（${r.ms}ms）` };
    });

    const okList = results.filter((r) => r.ok);
    const body = [
      ['总数', String(results.length)],
      ['可用（能到 TikTok）', `${okList.length === 0 ? '<span class="bad">0</span>' : `<span class="ok">${okList.length}</span>`}`],
      ['耗时', `${Math.round((Date.now() - startedAt) / 1000)} 秒`],
    ].map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');

    const detail = results.map((r) => `<tr><td style="width:auto">${esc(r.line)}</td><td>${r.ok ? '<span class="ok">通</span>' : '<span class="bad">不通</span>'} ${esc(r.message)}</td></tr>`).join('');

    res.type('html').send(renderBatchForm(raw, `
      <h2>结果</h2>
      <table>${body}</table>
      <p class="tip ${okList.length ? 'ok' : 'bad'}">${okList.length
        ? '这些代理从这台机器能到 TikTok，优先用它们。'
        : '从这台机器，一个都到不了 TikTok。要么这台机器的出网被限，要么这批代理都不支持 TikTok（在别处测「可用」通常只是 ipify 之类的中性站）。'}</p>
      <h2>明细</h2>
      <table>${detail}</table>
    `));
  });

  return router;
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: size }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await worker(items[index], index);
    }
  }));
  return out;
}

function renderBatchForm(input, extra) {
  return page('代理批量检测', `
  <h1>代理批量检测</h1>
  <p class="sub">一行一个代理，最多 300 个，并发 5 路，每个最多等 7 秒。只测「能不能从这台机器连到 TikTok」。</p>
  <form method="post" action="/proxy-batch">
    <textarea name="proxies" rows="10" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #e3cdb8;border-radius:10px;font:13px/1.5 ui-monospace,Consolas,monospace" placeholder="socks5://user:pass@1.2.3.4:1080&#10;socks5://user:pass@5.6.7.8:20000">${esc(input)}</textarea>
    <button type="submit">开始批量检测</button>
  </form>
  <p class="tip">支持 <code>socks5://user:pass@ip:port</code>，也支持不带协议、不带账密的简写 <code>ip:port</code>。</p>
  ${extra}
  `);
}

module.exports = { buildRouter };
