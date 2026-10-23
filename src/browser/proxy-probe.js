/**
 * 上游代理自检
 * ---------------------------------------------------------------
 * 目的：把「代理连不上」拆成可判定的三类，直接写进环境窗诊断页，不用再猜：
 *   1) TCP 都连不上（ETIMEDOUT / ECONNREFUSED）→ 代理地址/端口错或代理已停
 *   2) SOCKS 认证被拒（0xFF / 认证失败）→ 账密填错
 *   3) 握手过了但 CONNECT 被拒（REP != 0）→ 代理侧禁止该目标（常见：套餐不支持 TikTok）
 *
 * 判定思路：同时探两个目标
 *   - www.tiktok.com:443（业务目标）
 *   - www.gstatic.com:443（中性目标）
 * 中性通、TikTok 不通 → 代理封了 TikTok 出口，换节点即可，与客户端无关。
 */
const net = require('node:net');

const REPLY_TEXT = {
  1: '代理内部错误',
  2: '代理规则不允许该连接',
  3: '目标网络不可达',
  4: '目标主机不可达',
  5: '目标拒绝连接（出口被封）',
  6: 'TTL 超时',
  7: '代理不支持该命令',
  8: '代理不支持该地址类型',
};

function packSocksAuth(user, pass) {
  const u = Buffer.from(String(user || ''), 'utf8');
  const p = Buffer.from(String(pass || ''), 'utf8');
  return Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]);
}

function socksConnectBuf(host, port) {
  const name = String(host || '');
  const p = Number(port) || 443;
  if (net.isIPv4(name)) {
    const oct = name.split('.').map(Number);
    const buf = Buffer.alloc(10);
    buf[0] = 0x05; buf[1] = 0x01; buf[2] = 0x00; buf[3] = 0x01;
    oct.forEach((n, i) => { buf[4 + i] = n; });
    buf.writeUInt16BE(p, 8);
    return buf;
  }
  const hostBuf = Buffer.from(name, 'utf8');
  const buf = Buffer.alloc(7 + hostBuf.length);
  buf[0] = 0x05; buf[1] = 0x01; buf[2] = 0x00; buf[3] = 0x03; buf[4] = hostBuf.length;
  hostBuf.copy(buf, 5);
  buf.writeUInt16BE(p, 5 + hostBuf.length);
  return buf;
}

/**
 * 探一个目标。
 * @returns {Promise<{ok:boolean, stage:'tcp'|'greeting'|'auth'|'connect', message:string, ms:number}>}
 */
function probeDest({ host, port, user, pass, destHost, destPort, timeoutMs = 7000 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const hasAuth = Boolean(String(user || '').trim() || String(pass || '').trim());
    let stage = 'tcp';
    let settled = false;
    let buf = Buffer.alloc(0);
    const sock = net.connect({ host, port: Number(port) });
    let timer = null;

    const finish = (ok, message, finalStage) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { sock.destroy(); } catch { /* */ }
      resolve({ ok, stage: finalStage || stage, message, ms: Date.now() - started });
    };

    timer = setTimeout(() => {
      const label = {
        tcp: '连不上代理服务器（TCP 超时）',
        greeting: '代理没有回应 SOCKS5 握手',
        auth: '代理没有回应账号密码认证',
        connect: '代理没有回应 CONNECT 请求',
      }[stage] || '代理无响应';
      finish(false, `${label}，${timeoutMs}ms 超时`);
    }, timeoutMs);

    sock.on('error', (error) => {
      if (error?.code === 'ECONNREFUSED') {
        finish(false, '代理端口拒绝连接（地址或端口不对，或代理已停止）');
      } else if (error?.code === 'ETIMEDOUT') {
        finish(false, '连不上代理服务器（TCP 超时，IP 被封或代理已停）');
      } else if (error?.code === 'ENOTFOUND') {
        finish(false, `代理域名解析失败：${host}`);
      } else {
        finish(false, `连不上代理：${error?.code || ''} ${error?.message || error}`.trim());
      }
    });

    sock.on('connect', () => {
      stage = 'greeting';
      sock.write(hasAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]));
    });

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      if (stage === 'greeting') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05) return finish(false, '代理不是 SOCKS5 协议（端口可能填错）');
        const method = buf[1];
        if (method === 0xFF) {
          return finish(false, hasAuth
            ? '代理拒绝了提供的认证方式（账密可能错误）'
            : '该代理要求账号密码，但环境里没填代理用户名/密码');
        }
        buf = buf.slice(2);
        if (method === 0x02) {
          stage = 'auth';
          sock.write(packSocksAuth(user, pass));
          return;
        }
        if (method === 0x00) {
          stage = 'connect';
          sock.write(socksConnectBuf(destHost, destPort));
          return;
        }
        return finish(false, `代理返回了不支持的认证方式 ${method}`);
      }

      if (stage === 'auth') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x01 || buf[1] !== 0x00) {
          return finish(false, '代理用户名或密码不正确（认证被拒）');
        }
        buf = buf.slice(2);
        stage = 'connect';
        sock.write(socksConnectBuf(destHost, destPort));
        return;
      }

      if (stage === 'connect') {
        if (buf.length < 4) return;
        if (buf[1] !== 0x00) {
          const text = REPLY_TEXT[buf[1]] || `错误码 ${buf[1]}`;
          return finish(false, `代理拒绝连接 ${destHost}:${destPort}：${text}`);
        }
        return finish(true, `代理可用（到 ${destHost}:${destPort} 握手成功）`);
      }
    });
  });
}

/**
 * 汇总自检文本（给诊断页显示的一行）。
 * @param {object} meta 代理信息 { proxy_type, proxy_host, proxy_port, proxy_user, proxy_pass }
 */
async function probeProxySummary(meta, options = {}) {
  const type = String(meta?.proxy_type || '').toLowerCase();
  if (!meta?.proxy_host || type === 'noproxy') return '未绑定代理（直连）';
  if (type === 'http' || type === 'https') {
    return 'HTTP 代理不提供 SOCKS 自检，请用「测试环境窗」验证';
  }

  const timeoutMs = Number(options.timeoutMs) || 7000;
  const base = {
    host: String(meta.proxy_host),
    port: Number(meta.proxy_port),
    user: meta.proxy_user,
    pass: meta.proxy_pass,
    timeoutMs,
  };

  const [tiktok, neutral] = await Promise.all([
    probeDest({ ...base, destHost: 'www.tiktok.com', destPort: 443 }),
    probeDest({ ...base, destHost: 'www.gstatic.com', destPort: 443 }),
  ]);

  const parts = [];
  parts.push(`TikTok ${tiktok.ok ? '通' : '不通'}（${tiktok.message}，${tiktok.ms}ms）`);
  parts.push(`中性站 ${neutral.ok ? '通' : '不通'}（${neutral.message}，${neutral.ms}ms）`);

  if (tiktok.ok) return parts.join('；');
  if (neutral.ok) {
    parts.push('结论：代理能出网但封了 TikTok 出口 → 换支持 TikTok 的节点');
  } else if (/认证|密码/.test(tiktok.message)) {
    parts.push('结论：代理账密不对 → 在账号页更新代理用户名/密码');
  } else if (/拒绝连接|规则不允许|目标/.test(tiktok.message)) {
    parts.push('结论：代理侧拦了这个目标 → 换节点或换套餐');
  } else {
    parts.push('结论：代理服务器本身连不上 → 检查 IP/端口/是否过期');
  }
  return parts.join('；');
}

/**
 * 并发探测：同一个代理同时开 count 条连接，看几条能成。
 * 便宜的住宅/隧道代理常有并发上限（甚至只有 1~5 条），
 * TikTok 首页一次要开十几条连接，超了就会被 RST / 超时。
 */
async function probeBurst(meta, options = {}) {
  const count = Math.max(1, Math.min(20, Number(options.count) || 5));
  const timeoutMs = Number(options.timeoutMs) || 7000;
  const base = {
    host: String(meta.proxy_host),
    port: Number(meta.proxy_port),
    user: meta.proxy_user,
    pass: meta.proxy_pass,
    destHost: options.destHost || 'www.tiktok.com',
    destPort: Number(options.destPort) || 443,
    timeoutMs,
  };
  const results = await Promise.all(Array.from({ length: count }, () => probeDest(base)));
  const okCount = results.filter((r) => r.ok).length;
  return { count, ok: okCount, fail: count - okCount, results };
}

module.exports = { probeDest, probeProxySummary, probeBurst };
