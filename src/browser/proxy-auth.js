/**
 * 本地代理桥：Chrome/Electron 对带账密 SOCKS5 支持差，且 session.setProxy 直连上游 SOCKS 不稳定。
 * 在 127.0.0.1 起无认证本地 SOCKS5，再转发到上游（支持 IPv4 / 域名 / IPv6）。
 * 打包后可在 env-*.log 搜 PROXY_BRIDGE_REV 确认是否为新桥代码。
 */
const net = require('node:net');

/** 代理桥实现版本（发版后对照 env 日志，避免误用旧 dist/ 或未下载的新 Release） */
const PROXY_BRIDGE_REV = '8';

/** @type {Map<string, { server: net.Server, port: number, refs: number }>} */
const bridges = new Map();

/**
 * 同时保持的「上游 TCP 隧道」上限（住宅/隧道代理常见只有 5~10 条，超了会 SYN 超时）。
 * TikTok 会 burst 几十条连接：必须在桥里排队等槽位，而不是同时怼上游。
 * 环境变量 TKSWARM_PROXY_MAX_TUNNELS（默认 6）；排队 TKSWARM_PROXY_TUNNEL_QUEUE_MS（默认 120000）。
 */
function readMaxActiveTunnels() {
  const raw = Number(process.env.TKSWARM_PROXY_MAX_TUNNELS || 6);
  if (!Number.isFinite(raw) || raw < 2) return 6;
  return Math.min(Math.floor(raw), 64);
}
const MAX_ACTIVE_TUNNELS = readMaxActiveTunnels();
const TUNNEL_QUEUE_TIMEOUT_MS = Math.max(
  30000,
  Number(process.env.TKSWARM_PROXY_TUNNEL_QUEUE_MS || 120000) || 120000,
);
let activeTunnels = 0;
/** @type {Array<{ resolve: Function, timer: NodeJS.Timeout }>} */
const tunnelQueue = [];

function acquireTunnelSlot(timeoutMs = TUNNEL_QUEUE_TIMEOUT_MS) {
  if (activeTunnels < MAX_ACTIVE_TUNNELS) {
    activeTunnels += 1;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, timer: null };
    waiter.timer = setTimeout(() => {
      const index = tunnelQueue.indexOf(waiter);
      if (index >= 0) tunnelQueue.splice(index, 1);
      reject(new Error(`上游隧道已满（${activeTunnels}/${MAX_ACTIVE_TUNNELS}，排队超时）`));
    }, timeoutMs);
    tunnelQueue.push(waiter);
  });
}

function releaseTunnelSlot() {
  const next = tunnelQueue.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve();
    return;
  }
  activeTunnels = Math.max(0, activeTunnels - 1);
}

function bridgeKey(profile) {
  const type = String(profile.proxy_type || 'noproxy').toLowerCase();
  return [
    type,
    profile.proxy_host || '',
    profile.proxy_port || 0,
    profile.proxy_user || '',
    profile.proxy_pass || '',
  ].join('|');
}

function needsAuthBridge(profile) {
  const type = String(profile.proxy_type || 'noproxy').toLowerCase();
  if (type === 'noproxy' || !profile.proxy_host) return false;
  return Boolean(String(profile.proxy_user || '').trim() || String(profile.proxy_pass || '').trim());
}

function packSocksAuth(user, pass) {
  const u = Buffer.from(String(user || ''), 'utf8');
  const p = Buffer.from(String(pass || ''), 'utf8');
  return Buffer.concat([
    Buffer.from([0x01, u.length]),
    u,
    Buffer.from([p.length]),
    p,
  ]);
}

function ipv6BufToString(buf) {
  const parts = [];
  for (let i = 0; i < 16; i += 2) {
    parts.push(buf.readUInt16BE(i).toString(16));
  }
  let s = parts.join(':');
  s = s.replace(/(^|:)0(:0)+:0(?=:|$)/, '$1::');
  s = s.replace(/(^|:)0:0(?=:|$)/, '$1::');
  return s;
}

/** @param {{ host: string, port: number, atyp?: number, ipBuf?: Buffer }} dest */
function buildSocks5ConnectBuf(dest) {
  const port = Number(dest.port) || 0;
  const host = String(dest.host || '').trim();
  const atyp = dest.atyp;
  const ipBuf = dest.ipBuf;

  if (atyp === 0x04 && ipBuf && ipBuf.length === 16) {
    const req = Buffer.alloc(22);
    req[0] = 0x05;
    req[1] = 0x01;
    req[2] = 0x00;
    req[3] = 0x04;
    ipBuf.copy(req, 4);
    req.writeUInt16BE(port, 20);
    return req;
  }

  if (net.isIPv4(host)) {
    const oct = host.split('.').map((x) => Number(x));
    const req = Buffer.alloc(10);
    req[0] = 0x05;
    req[1] = 0x01;
    req[2] = 0x00;
    req[3] = 0x01;
    req[4] = oct[0];
    req[5] = oct[1];
    req[6] = oct[2];
    req[7] = oct[3];
    req.writeUInt16BE(port, 8);
    return req;
  }

  if (net.isIPv6(host)) {
    const normalized = host.replace(/^\[|\]$/g, '');
    const chunks = normalized.split(':');
    const buf = Buffer.alloc(16);
    let bi = 0;
    let ci = 0;
    if (normalized.includes('::')) {
      const [left, right] = normalized.split('::');
      const leftParts = left ? left.split(':') : [];
      const rightParts = right ? right.split(':') : [];
      const missing = 8 - leftParts.length - rightParts.length;
      const full = [...leftParts, ...Array(missing).fill('0'), ...rightParts];
      for (const part of full) {
        buf.writeUInt16BE(parseInt(part || '0', 16), bi);
        bi += 2;
      }
    } else {
      for (const part of chunks) {
        buf.writeUInt16BE(parseInt(part || '0', 16), bi);
        bi += 2;
      }
    }
    const req = Buffer.alloc(22);
    req[0] = 0x05;
    req[1] = 0x01;
    req[2] = 0x00;
    req[3] = 0x04;
    buf.copy(req, 4);
    req.writeUInt16BE(port, 20);
    return req;
  }

  const hostBuf = Buffer.from(host, 'utf8');
  const req = Buffer.alloc(7 + hostBuf.length);
  req[0] = 0x05;
  req[1] = 0x01;
  req[2] = 0x00;
  req[3] = 0x03;
  req[4] = hostBuf.length;
  hostBuf.copy(req, 5);
  req.writeUInt16BE(port, 5 + hostBuf.length);
  return req;
}

/**
 * 单次上游连接超时。住宅/轮换代理经常出现「一次 ETIMEDOUT、下一次就通」，
 * 所以单次别等太久（20s+ 干等没意义），改成短超时 + 多次重试。
 */
const UPSTREAM_TIMEOUT_MS = 9000;
/** 上游连接重试次数（含首次） */
const UPSTREAM_ATTEMPTS = 3;

function socksGreetingPacket(mode) {
  if (mode === 'auth-only') return Buffer.from([0x05, 0x01, 0x02]);
  if (mode === 'both') return Buffer.from([0x05, 0x02, 0x00, 0x02]);
  return Buffer.from([0x05, 0x01, 0x00]);
}

function connectUpstreamSocks5(host, port, user, pass, dest, greetAttempt = 0) {
  const hasAuth = Boolean(String(user || '').trim() || String(pass || '').trim());
  const greetModes = hasAuth ? ['auth-only', 'both', 'no-auth-only'] : ['no-auth-only', 'both'];
  const greetMode = greetModes[Math.min(greetAttempt, greetModes.length - 1)];

  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port: Number(port), timeout: UPSTREAM_TIMEOUT_MS });
    let stage = 'greeting';
    let buf = Buffer.alloc(0);
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* */ }
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const retryGreeting = () => {
      if (greetAttempt + 1 >= greetModes.length) {
        return fail(new Error(hasAuth
          ? 'SOCKS5 拒绝认证（账密错误或代理不支持该认证方式）'
          : 'SOCKS5 需要账密认证（环境里未配置代理用户名/密码）'));
      }
      settled = true;
      try { sock.destroy(); } catch { /* */ }
      connectUpstreamSocks5(host, port, user, pass, dest, greetAttempt + 1).then(resolve).catch(reject);
    };

    const succeed = (upstream) => {
      if (settled) return;
      settled = true;
      sock.setTimeout(0);
      try {
        sock.setKeepAlive(true, 15000);
        sock.setNoDelay(true);
      } catch { /* */ }
      resolve(upstream);
    };

    sock.on('error', fail);
    sock.on('timeout', () => fail(new Error('上游 SOCKS 连接超时')));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greeting') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05) return fail(new Error('上游不是 SOCKS5'));
        const method = buf[1];
        if (method === 0xFF) return retryGreeting();
        buf = buf.slice(2);
        if (method === 0x02) {
          stage = 'auth';
          sock.write(packSocksAuth(user, pass));
          return;
        }
        if (method === 0x00) {
          stage = 'request';
          sock.write(buildSocks5ConnectBuf(dest));
          return;
        }
        return fail(new Error(`SOCKS5 不支持的认证方法: ${method}`));
      }
      if (stage === 'auth') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x01 || buf[1] !== 0x00) {
          return fail(new Error('SOCKS5 用户名/密码认证失败'));
        }
        buf = buf.slice(2);
        stage = 'request';
        sock.write(buildSocks5ConnectBuf(dest));
        return;
      }
      if (stage === 'request') {
        if (buf.length < 4) return;
        if (buf[1] !== 0x00) return fail(new Error(`SOCKS5 连接失败 code=${buf[1]}`));
        let need = 4;
        const atyp = buf[3];
        if (atyp === 0x01) need += 4 + 2;
        else if (atyp === 0x03) {
          if (buf.length < 5) return;
          need += 1 + buf[4] + 2;
        } else if (atyp === 0x04) need += 16 + 2;
        else return fail(new Error('SOCKS5 不支持地址类型'));
        if (buf.length < need) return;
        sock.removeAllListeners('data');
        succeed(sock);
      }
    });

    sock.on('connect', () => {
      sock.write(socksGreetingPacket(greetMode));
    });
  });
}

function connectUpstreamHttp(host, port, user, pass, destHost, destPort) {
  return new Promise((resolve, reject) => {
    const hasAuth = Boolean(String(user || '').trim() || String(pass || '').trim());
    const sock = net.connect({ host, port: Number(port), timeout: UPSTREAM_TIMEOUT_MS });
    const lines = [
      `CONNECT ${destHost}:${destPort} HTTP/1.1`,
      `Host: ${destHost}:${destPort}`,
    ];
    if (hasAuth) {
      const auth = Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
      lines.push(`Proxy-Authorization: Basic ${auth}`);
    }
    lines.push('Proxy-Connection: Keep-Alive', '', '');
    const req = lines.join('\r\n');

    let buf = '';
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* */ }
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const succeed = (upstream) => {
      if (settled) return;
      settled = true;
      sock.setTimeout(0);
      try {
        sock.setKeepAlive(true, 15000);
        sock.setNoDelay(true);
      } catch { /* */ }
      resolve(upstream);
    };

    sock.on('error', fail);
    sock.on('timeout', () => fail(new Error('上游 HTTP 代理连接超时')));
    sock.on('data', (chunk) => {
      buf += chunk.toString('binary');
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = buf.slice(0, idx);
      if (!/^HTTP\/1\.\d 200/i.test(head)) {
        return fail(new Error(`HTTP 代理 CONNECT 失败: ${head.split('\r\n')[0]}`));
      }
      sock.removeAllListeners('data');
      succeed(sock);
    });
    sock.on('connect', () => sock.write(req));
  });
}

function parseSocksClientRequest(buf) {
  if (buf.length < 7) return null;
  if (buf[0] !== 0x05 || buf[1] !== 0x01) return { error: 0x07 };
  const atyp = buf[3];
  let offset = 4;
  let destHost = '';
  let destPort = 0;
  let ipBuf = null;

  if (atyp === 0x01) {
    if (buf.length < 10) return null;
    destHost = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
    destPort = buf.readUInt16BE(8);
    offset = 10;
  } else if (atyp === 0x03) {
    const len = buf[4];
    if (buf.length < 5 + len + 2) return null;
    destHost = buf.slice(5, 5 + len).toString('utf8');
    destPort = buf.readUInt16BE(5 + len);
    offset = 5 + len + 2;
  } else if (atyp === 0x04) {
    if (buf.length < 22) return null;
    ipBuf = buf.slice(4, 20);
    destHost = ipv6BufToString(ipBuf);
    destPort = buf.readUInt16BE(20);
    offset = 22;
  } else {
    return { error: 0x08 };
  }

  return {
    dest: { host: destHost, port: destPort, atyp, ipBuf },
    leftover: buf.slice(offset),
  };
}

function handleSocksClient(client, profile, onError, onLog) {
  const upHost = String(profile.proxy_host);
  const upPort = Number(profile.proxy_port);
  const user = String(profile.proxy_user || '');
  const pass = String(profile.proxy_pass || '');
  const type = String(profile.proxy_type || 'socks5').toLowerCase();
  const log = typeof onLog === 'function' ? onLog : () => {};

  let buf = Buffer.alloc(0);
  let stage = 'greeting';
  let upstream = null;
  let tunnelUp = 0;
  let tunnelDown = 0;
  const clientPending = [];

  const destroyBoth = () => {
    try { client.destroy(); } catch { /* */ }
    try { upstream?.destroy(); } catch { /* */ }
  };

  const replyFail = (code = 0x01) => {
    try {
      client.end(Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    } catch { /* */ }
    destroyBoth();
  };

  const startTunnel = (up, leftover, dest, releaseTunnel) => {
    upstream = up;
    let tunnelReleased = false;
    const releaseOnce = () => {
      if (tunnelReleased) return;
      tunnelReleased = true;
      if (typeof releaseTunnel === 'function') releaseTunnel();
    };
    client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    if (leftover.length) up.write(leftover);
    for (const pending of clientPending) up.write(pending);
    clientPending.length = 0;
    stage = 'tunnel';
    log(`隧道建立 → ${dest?.host || '?'}:${dest?.port || 0}（活跃 ${activeTunnels}/${MAX_ACTIVE_TUNNELS}）`);
    up.on('error', (error) => {
      log(`隧道上游错误: ${error?.message || error}`);
      releaseOnce();
      destroyBoth();
    });
    client.on('error', () => {
      releaseOnce();
      destroyBoth();
    });
    client.on('close', () => {
      log(`客户端关闭（上行 ${tunnelUp}B / 下行 ${tunnelDown}B）`);
      releaseOnce();
      try { up.destroy(); } catch { /* */ }
    });
    up.on('close', () => {
      log(`上游关闭（上行 ${tunnelUp}B / 下行 ${tunnelDown}B）`);
      releaseOnce();
      try { client.destroy(); } catch { /* */ }
    });
    // 只走 pipe 转发；曾经同时在 data 事件里写一次，导致同一份字节发两遍，TLS 握手必然失败
    client.pipe(up);
    up.pipe(client);
    client.on('data', (chunk) => { tunnelUp += chunk.length; });
    up.on('data', (chunk) => { tunnelDown += chunk.length; });
  };

  client.on('error', () => destroyBoth());
  client.on('data', (chunk) => {
    if (stage === 'tunnel') {
      // 隧道阶段的数据由 client.pipe(upstream) 转发，这里只做计数，绝不能再写一次
      return;
    }
    if (stage === 'connecting') {
      clientPending.push(chunk);
      return;
    }

    buf = Buffer.concat([buf, chunk]);

    if (stage === 'greeting') {
      if (buf.length < 2) return;
      if (buf[0] !== 0x05) {
        client.destroy();
        return;
      }
      const nMethods = buf[1];
      if (buf.length < 2 + nMethods) return;
      client.write(Buffer.from([0x05, 0x00]));
      buf = buf.slice(2 + nMethods);
      stage = 'request';
      if (!buf.length) return;
    }

    if (stage === 'request') {
      const parsed = parseSocksClientRequest(buf);
      if (!parsed) return;
      if (parsed.error) {
        replyFail(parsed.error);
        return;
      }
      const { dest, leftover } = parsed;
      buf = Buffer.alloc(0);
      stage = 'connecting';
      client.pause();

      const openUpstream = () => ((type === 'http' || type === 'https')
        ? connectUpstreamHttp(upHost, upPort, user, pass, dest.host, dest.port)
        : connectUpstreamSocks5(upHost, upPort, user, pass, dest));

      // 住宅代理常见「这一次超时、下一次就通」，短超时 + 重试明显更稳
      const attempt = (n) => openUpstream().catch((error) => {
        log(`上游连接失败（第 ${n}/${UPSTREAM_ATTEMPTS} 次）: ${error?.message || error}`);
        if (n >= UPSTREAM_ATTEMPTS) throw error;
        return new Promise((done) => setTimeout(done, 300 * n)).then(() => attempt(n + 1));
      });

      let releaseSlot = () => {};
      void acquireTunnelSlot()
        .then(() => {
          let held = true;
          releaseSlot = () => {
            if (!held) return;
            held = false;
            releaseTunnelSlot();
          };
          if (client.destroyed) throw new Error('客户端已断开');
          return attempt(1);
        })
        .then((up) => {
          client.resume();
          startTunnel(up, leftover, dest, releaseSlot);
        })
        .catch((error) => {
          releaseSlot();
          if (onError) onError(error, dest);
          client.resume();
          replyFail(0x01);
        });
    }
  });
}

function startLocalSocksBridge(profile, onError, onLog) {
  const key = bridgeKey(profile);
  const existing = bridges.get(key);
  if (existing) {
    existing.refs += 1;
    return Promise.resolve({ port: existing.port, key, release: () => releaseBridge(key) });
  }

  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      handleSocksClient(client, profile, onError, onLog);
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      bridges.set(key, { server, port, refs: 1 });
      resolve({ port, key, release: () => releaseBridge(key) });
    });
  });
}

function releaseBridge(key) {
  const entry = bridges.get(key);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  bridges.delete(key);
  try { entry.server.close(); } catch { /* */ }
}

function formatProxyRules(port) {
  return `socks5://127.0.0.1:${port}`;
}

/**
 * @returns {Promise<{ proxyArg: string|null, release: function, localPort?: number, proxyRules?: string }>}
 */
async function resolveChromeProxy(profile, opts = {}) {
  const type = String(profile.proxy_type || 'noproxy').toLowerCase();
  if (type === 'noproxy' || !profile.proxy_host) {
    return { proxyArg: null, release: () => {} };
  }

  const useBridge = opts.alwaysBridge === true || needsAuthBridge(profile);

  if (!useBridge) {
    const host = profile.proxy_host;
    const port = profile.proxy_port;
    if (type === 'socks5' || type === 'socks') {
      const rules = `socks5://${host}:${port}`;
      return { proxyArg: `--proxy-server=${rules}`, proxyRules: rules, release: () => {} };
    }
    const rules = `${host}:${port}`;
    return { proxyArg: `--proxy-server=${rules}`, proxyRules: rules, release: () => {} };
  }

  const onError = typeof opts.onError === 'function' ? opts.onError : null;
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : null;
  const bridge = await startLocalSocksBridge(profile, onError, onLog);
  const rules = formatProxyRules(bridge.port);
  return {
    proxyArg: `--proxy-server=${rules}`,
    proxyRules: rules,
    release: bridge.release,
    localPort: bridge.port,
  };
}

module.exports = {
  resolveChromeProxy,
  needsAuthBridge,
  releaseBridge,
  bridges,
  formatProxyRules,
  PROXY_BRIDGE_REV,
  MAX_ACTIVE_TUNNELS,
};
