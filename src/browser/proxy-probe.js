/**
 * 上游代理自检 — 必须与 proxy-auth.js 本地桥使用同一套上游 SOCKS 握手。
 * 禁止并行猛怼同一代理（住宅套餐并发低时会把 TikTok 页面和自检一起打死）。
 */
const { probeUpstreamSocks5 } = require('./proxy-auth');

const REPLY_HINT = /拒绝|认证|账密|不可达|规则|超时|ETIMEDOUT|ECONNREFUSED/i;

/**
 * 探一个目标（顺序调用；复用桥的 connectUpstreamSocks5 + 短超时重试）
 */
async function probeDest({
  host, port, user, pass, destHost, destPort, timeoutMs = 5000,
}) {
  const started = Date.now();
  const dest = `${destHost}:${destPort}`;
  try {
    await Promise.race([
      probeUpstreamSocks5(host, port, user, pass, destHost, destPort),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`握手超时（>${timeoutMs}ms）`)), timeoutMs);
      }),
    ]);
    const ms = Date.now() - started;
    return { ok: true, stage: 'connect', message: `代理可用（到 ${dest} 握手成功）`, ms };
  } catch (error) {
    const ms = Date.now() - started;
    const raw = String(error?.message || error);
    let message = raw;
    if (/ETIMEDOUT|握手超时|连接超时/i.test(raw)) {
      message = `连接超时（${ms}ms，代理未在时限内响应）`;
    } else if (/ECONNREFUSED/i.test(raw)) {
      message = '代理端口拒绝连接（地址或端口错误或代理已停）';
    } else if (/认证|账密|0xFF|拒绝认证/i.test(raw)) {
      message = '代理用户名或密码不正确（认证被拒）';
    } else if (/需要账密/i.test(raw)) {
      message = '该代理要求账号密码，但环境里没填代理用户名/密码';
    } else if (!REPLY_HINT.test(raw)) {
      message = `代理连接失败：${raw}`;
    }
    const stage = /认证|账密|密码/i.test(message) ? 'auth' : 'connect';
    return { ok: false, stage, message, ms };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 汇总自检（顺序探测：先中性站再 TikTok，避免两条连接同时抢代理槽位）
 */
async function probeProxySummary(meta, options = {}) {
  const type = String(meta?.proxy_type || '').toLowerCase();
  if (!meta?.proxy_host || type === 'noproxy') return '未绑定代理（直连）';
  if (type === 'http' || type === 'https') {
    return 'HTTP 代理不提供 SOCKS 自检，请用「测试环境窗」验证';
  }

  const timeoutMs = Number(options.timeoutMs) || 5000;
  const base = {
    host: String(meta.proxy_host),
    port: Number(meta.proxy_port),
    user: meta.proxy_user,
    pass: meta.proxy_pass,
    timeoutMs,
  };

  const neutral = await probeDest({ ...base, destHost: 'www.gstatic.com', destPort: 443 });
  await sleep(120);
  const tiktok = await probeDest({ ...base, destHost: 'www.tiktok.com', destPort: 443 });

  const parts = [];
  parts.push(`TikTok ${tiktok.ok ? '通' : '不通'}（${tiktok.message}，${tiktok.ms}ms）`);
  parts.push(`中性站 ${neutral.ok ? '通' : '不通'}（${neutral.message}，${neutral.ms}ms）`);

  if (tiktok.ok) return parts.join('；');
  if (neutral.ok) {
    parts.push('结论：代理能出网但 TikTok 目标不通 → 换支持 TikTok 的节点，或稍后重试（非账密问题）');
  } else if (/认证|密码|账密/.test(tiktok.message)) {
    parts.push('结论：代理账密不对 → 在账号页更新代理用户名/密码');
  } else if (/拒绝|规则|不可达/.test(tiktok.message)) {
    parts.push('结论：代理侧拦了这个目标 → 换节点或换套餐');
  } else {
    parts.push('结论：代理服务器本身连不上 → 检查 IP/端口/是否过期');
  }
  return parts.join('；');
}

/**
 * 并发能力探测：默认顺序逐条探（不并行），避免自检把正在打开的页面打死。
 */
async function probeBurst(meta, options = {}) {
  const count = Math.max(1, Math.min(10, Number(options.count) || 3));
  const timeoutMs = Number(options.timeoutMs) || 5000;
  const sequential = options.sequential !== false;
  const gapMs = Number(options.gapMs) || 150;
  const base = {
    host: String(meta.proxy_host),
    port: Number(meta.proxy_port),
    user: meta.proxy_user,
    pass: meta.proxy_pass,
    destHost: options.destHost || 'www.tiktok.com',
    destPort: Number(options.destPort) || 443,
    timeoutMs,
  };

  const results = [];
  if (sequential) {
    for (let i = 0; i < count; i += 1) {
      results.push(await probeDest(base));
      if (i < count - 1) await sleep(gapMs);
    }
  } else {
    const batch = Math.max(1, Math.min(3, Number(options.concurrency) || 2));
    for (let i = 0; i < count; i += batch) {
      const slice = Array.from({ length: Math.min(batch, count - i) }, () => probeDest(base));
      results.push(...await Promise.all(slice));
      if (i + batch < count) await sleep(gapMs);
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  return { count, ok: okCount, fail: count - okCount, results };
}

module.exports = { probeDest, probeProxySummary, probeBurst };
