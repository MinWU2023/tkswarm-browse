/**
 * 本地代理桥：Chrome/Electron 对带账密 SOCKS5 支持差，且 session.setProxy 直连上游 SOCKS 不稳定。
 * 在 127.0.0.1 起无认证本地 SOCKS5，再转发到上游（支持 IPv4 / 域名 / IPv6）。
 * 打包后可在 env-*.log 搜 PROXY_BRIDGE_REV 确认是否为新桥代码。
 */
const net = require('node:net');
const http = require('node:http');
const { execFile } = require('node:child_process');

/** 代理桥实现版本（发版后对照 env 日志，避免误用旧 dist/ 或未下载的新 Release） */
const PROXY_BRIDGE_REV = '10';

/* ------------------------------------------------------------------ *
 * 前置系统代理（v2ray / clash / 公司代理）
 *
 * 大陆机器直连海外住宅代理的高位端口，TCP 常常直接超时或被重置
 * （日志里就是 connect ETIMEDOUT / read ECONNRESET），这跟账密无关。
 * 比特浏览器能稳，是因为它自带的 Chromium 打了补丁：连上游代理时先借道
 * 系统代理。这里在桥里做同样的事——探测 Windows 系统代理，用它 CONNECT
 * 到上游代理，再在上游代理里做 SOCKS5 握手。
 * 设置 TKSWARM_NO_SYSTEM_PROXY=1 可关闭。
 * ------------------------------------------------------------------ */

const SYS_PROXY_TTL_MS = 60000;
const SYS_PROXY_MISS_TTL_MS = 5000;
let sysProxyCache = { at: 0, value: null };
let sysProxyInflight = null;

function systemProxyDisabled() {
  return String(process.env.TKSWARM_NO_SYSTEM_PROXY || '').trim() === '1';
}

/**
 * 解析 Windows 的 ProxyServer 取值，兼容三种写法：
 *   127.0.0.1:10809
 *   http=127.0.0.1:10809;https=127.0.0.1:10809;socks=127.0.0.1:1080
 *   http://127.0.0.1:10809
 */
function parseSystemProxyString(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  const pick = (key) => {
    const m = text.match(new RegExp(`(?:^|;)\\s*${key}\\s*=\\s*([^;]+)`, 'i'));
    return m ? m[1].trim() : null;
  };

  let value = null;
  let scheme = 'http';
  if (text.includes('=')) {
    const httpEntry = pick('http') || pick('https') || pick('proxy');
    const socksEntry = pick('socks') || pick('socks5');
    if (httpEntry) {
      value = httpEntry;
    } else if (socksEntry) {
      value = socksEntry;
      scheme = 'socks5';
    } else {
      return null;
    }
  } else {
    value = text;
  }

  const cleaned = value.replace(/^[a-z0-9]+:\/\//i, '');
  const m = cleaned.match(/^\[([0-9a-fA-F:]+)\]:(\d+)$/) || cleaned.match(/^([^:]+):(\d+)$/);
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isFinite(port) || port <= 0 || port >= 65536) return null;
  return { type: scheme, host: m[1], port };
}

function queryWindowsSystemProxy() {
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { windowsHide: true, timeout: 4000, maxBuffer: 1 << 20 },
      (error, stdout) => {
        if (error || !stdout) return resolve(null);
        const enable = stdout.match(/ProxyEnable\s+REG_DWORD\s+0x([0-9a-fA-F]+)/);
        const server = stdout.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/);
        if (!enable || parseInt(enable[1], 16) !== 1 || !server) return resolve(null);
        return resolve(parseSystemProxyString(server[1]));
      },
    );
  });
}

/** 环境变量兜底：不少代理工具会同时写 HTTP_PROXY / ALL_PROXY */
function envSystemProxy() {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const raw = String(process.env[key] || '').trim();
    if (!raw) continue;
    const parsed = parseSystemProxyString(raw);
    if (parsed) {
      if (/^socks/i.test(raw)) parsed.type = 'socks5';
      return parsed;
    }
  }
  return null;
}

/**
 * 探测系统前置代理；成功缓存 60s，失败只缓存 5s（读注册表偶尔会瞬时报错，
 * 不能因为一次失败就把整条链路锁死在直连上）。
 */
async function detectSystemProxy() {
  if (systemProxyDisabled()) return null;

  const age = Date.now() - sysProxyCache.at;
  const ttl = sysProxyCache.value ? SYS_PROXY_TTL_MS : SYS_PROXY_MISS_TTL_MS;
  if (sysProxyCache.at > 0 && age < ttl) return sysProxyCache.value;
  if (sysProxyInflight) return sysProxyInflight;

  sysProxyInflight = (async () => {
    let value = envSystemProxy();
    if (!value) {
      try {
        if (process.platform === 'win32') value = await queryWindowsSystemProxy();
      } catch {
        value = null;
      }
    }
    sysProxyCache = { at: Date.now(), value };
    return value;
  })();

  try {
    return await sysProxyInflight;
  } finally {
    sysProxyInflight = null;
  }
}

/* ---------------- 建立到上游代理的基础连接（三种方式） ---------------- */

function connectDirect(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const sock = net.connect({ host, port: Number(port), timeout: timeoutMs });
    sock.once('connect', () => {
      if (settled) return;
      settled = true;
      sock.setTimeout(timeoutMs);
      resolve(sock);
    });
    sock.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    sock.once('timeout', () => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(new Error(`TCP 连接上游代理超时（${timeoutMs}ms）`));
    });
  });
}

function viaHttpProxy(sysProxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.request({
      host: sysProxy.host,
      port: sysProxy.port,
      method: 'CONNECT',
      path: `${host}:${port}`,
      agent: false,
    });
    const bail = (err) => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch { /* */ }
      reject(err);
    };
    req.setTimeout(timeoutMs, () => bail(new Error(
      `经系统前置代理 ${sysProxy.host}:${sysProxy.port} 连接上游超时（${timeoutMs}ms）`,
    )));
    req.once('connect', (res, socket) => {
      if (settled) {
        try { socket.destroy(); } catch { /* */ }
        return;
      }
      settled = true;
      if (res.statusCode !== 200) {
        try { socket.destroy(); } catch { /* */ }
        return reject(new Error(`系统前置代理 CONNECT 失败，状态码 ${res.statusCode}`));
      }
      socket.setTimeout(timeoutMs);
      return resolve(socket);
    });
    req.once('error', bail);
    req.end();
  });
}

function viaSocksProxy(sysProxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stage = 'greeting';
    let buf = Buffer.alloc(0);
    const sock = net.connect({ host: sysProxy.host, port: Number(sysProxy.port), timeout: timeoutMs });

    const bail = (err) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* */ }
      reject(err);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      sock.removeAllListeners('data');
      sock.setTimeout(timeoutMs);
      resolve(sock);
    };

    sock.once('error', bail);
    sock.once('timeout', () => bail(new Error(
      `经系统 SOCKS 代理 ${sysProxy.host}:${sysProxy.port} 连接上游超时（${timeoutMs}ms）`,
    )));
    sock.once('connect', () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greeting') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05) return bail(new Error('系统代理不是 SOCKS5'));
        if (buf[1] === 0xFF) return bail(new Error('系统 SOCKS 代理要求认证，暂不支持'));
        buf = buf.slice(2);
        stage = 'connect';
        sock.write(buildSocks5ConnectBuf({ host, port }));
        return;
      }
      if (stage === 'connect') {
        if (buf.length < 4) return;
        if (buf[1] !== 0x00) return bail(new Error(`系统 SOCKS 代理拒绝连接 ${host}:${port}，code=${buf[1]}`));
        done();
      }
    });
  });
}

/** 立即性错误（前置代理没开、端口不对），值得退回直连；超时不算 */
function isImmediateFailure(error) {
  const code = String(error?.code || '');
  const msg = String(error?.message || error);
  return code === 'ECONNREFUSED'
    || code === 'ECONNRESET'
    || code === 'ENOENT'
    || code === 'EADDRNOTAVAIL'
    || /状态码/.test(msg);
}

/**
 * 建立到上游代理服务器的原始套接字。
 * 有系统前置代理且目标不是本机时自动借道；前置代理不可用时立刻退回直连。
 */
async function openRawUpstream(host, port, timeoutMs = 15000) {
  const targetHost = String(host || '');
  const targetPort = Number(port);
  const isLocal = /^(127\.|localhost$|::1$|0\.0\.0\.0$)/i.test(targetHost);

  if (!isLocal) {
    const sysProxy = await detectSystemProxy();
    const isSameEndpoint = sysProxy
      && sysProxy.host === targetHost
      && Number(sysProxy.port) === targetPort;
    if (sysProxy && !isSameEndpoint) {
      try {
        if (sysProxy.type === 'socks5') {
          return await viaSocksProxy(sysProxy, targetHost, targetPort, timeoutMs);
        }
        return await viaHttpProxy(sysProxy, targetHost, targetPort, timeoutMs);
      } catch (error) {
        // 前置代理没开/端口变了：退回直连，别让它变成新的故障点
        if (!isImmediateFailure(error)) throw error;
      }
    }
  }

  return connectDirect(targetHost, targetPort, timeoutMs);
}

/** @type {Map<string, { server: net.Server, port: number, refs: number }>} */
const bridges = new Map();

/* ------------------------------------------------------------------ *
 * 并发控制
 *
 * 住宅/隧道代理通常只允许 5~10 条并发，而 TikTok 一次要开几十条连接。
 * 这里只限制「同时正在握手」的数量（默认 4），握手完成立刻释放槽位。
 * 不要限制已建立的隧道数量：Chromium 会长期保持 keep-alive 连接，
 * 按隧道数排队会让页面在等槽位时直接假死（旧实现的问题）。
 * ------------------------------------------------------------------ */

function readHandshakeLimit() {
  const raw = Number(process.env.TKSWARM_PROXY_HANDSHAKE_LIMIT || 4);
  if (!Number.isFinite(raw) || raw < 1) return 4;
  return Math.min(Math.floor(raw), 32);
}
const HANDSHAKE_LIMIT = readHandshakeLimit();
const HANDSHAKE_QUEUE_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.TKSWARM_PROXY_HANDSHAKE_QUEUE_MS || 30000) || 30000,
);
/** 软上限：只用于日志观察，不阻塞连接 */
const MAX_ACTIVE_TUNNELS = Math.max(
  HANDSHAKE_LIMIT,
  Math.min(Number(process.env.TKSWARM_PROXY_MAX_TUNNELS || 64) || 64, 256),
);

let activeHandshakes = 0;
let openTunnels = 0;
/** @type {Array<{ resolve: Function, timer: NodeJS.Timeout }>} */
const handshakeQueue = [];

function acquireHandshakeSlot(timeoutMs = HANDSHAKE_QUEUE_TIMEOUT_MS) {
  if (activeHandshakes < HANDSHAKE_LIMIT) {
    activeHandshakes += 1;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, timer: null };
    waiter.timer = setTimeout(() => {
      const index = handshakeQueue.indexOf(waiter);
      if (index >= 0) handshakeQueue.splice(index, 1);
      reject(new Error(`上游握手排队超时（${activeHandshakes}/${HANDSHAKE_LIMIT} 条正在握手）`));
    }, timeoutMs);
    handshakeQueue.push(waiter);
  });
}

function releaseHandshakeSlot() {
  const next = handshakeQueue.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve();
    return;
  }
  activeHandshakes = Math.max(0, activeHandshakes - 1);
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
    let sock = null;
    let stage = 'greeting';
    let buf = Buffer.alloc(0);
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { sock?.destroy(); } catch { /* */ }
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const retryGreeting = () => {
      if (greetAttempt + 1 >= greetModes.length) {
        return fail(new Error(hasAuth
          ? 'SOCKS5 拒绝认证（账密错误或代理不支持该认证方式）'
          : 'SOCKS5 需要账密认证（环境里未配置代理用户名/密码）'));
      }
      settled = true;
      try { sock?.destroy(); } catch { /* */ }
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

    openRawUpstream(host, port, UPSTREAM_TIMEOUT_MS).then((rawSocket) => {
      sock = rawSocket;
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

      sock.write(socksGreetingPacket(greetMode));
    }).catch(fail);
  });
}

function connectUpstreamHttp(host, port, user, pass, destHost, destPort) {
  return new Promise((resolve, reject) => {
    let sock = null;
    const hasAuth = Boolean(String(user || '').trim() || String(pass || '').trim());
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
      try { sock?.destroy(); } catch { /* */ }
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

    openRawUpstream(host, port, UPSTREAM_TIMEOUT_MS).then((rawSocket) => {
      sock = rawSocket;
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
      sock.write(req);
    }).catch(fail);
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

  const startTunnel = (up, leftover, dest) => {
    upstream = up;
    client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    if (leftover.length) up.write(leftover);
    for (const pending of clientPending) up.write(pending);
    clientPending.length = 0;
    stage = 'tunnel';
    openTunnels += 1;
    log(`隧道建立 → ${dest?.host || '?'}:${dest?.port || 0}（当前 ${openTunnels} 条隧道）`);
    let counted = true;
    const closeOnce = () => {
      if (!counted) return;
      counted = false;
      openTunnels = Math.max(0, openTunnels - 1);
    };
    up.on('error', (error) => {
      log(`隧道上游错误: ${error?.message || error}`);
      destroyBoth();
    });
    client.on('error', () => destroyBoth());
    client.on('close', () => {
      log(`客户端关闭（上行 ${tunnelUp}B / 下行 ${tunnelDown}B）`);
      closeOnce();
      try { up.destroy(); } catch { /* */ }
    });
    up.on('close', () => {
      log(`上游关闭（上行 ${tunnelUp}B / 下行 ${tunnelDown}B）`);
      closeOnce();
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

      // 只限制「同时正在握手」的条数，握手完成立刻释放，不会堵住已建立的隧道
      let releaseSlot = () => {};
      void acquireHandshakeSlot()
        .then(() => {
          let held = true;
          releaseSlot = () => {
            if (!held) return;
            held = false;
            releaseHandshakeSlot();
          };
          if (client.destroyed) throw new Error('客户端已断开');
          return attempt(1);
        })
        .then((up) => {
          releaseSlot();
          client.resume();
          startTunnel(up, leftover, dest);
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

/**
 * 与本地桥相同的上游 SOCKS5 握手（供自检/探测复用，避免两套实现结果不一致）
 */
async function probeUpstreamSocks5(upHost, upPort, user, pass, destHost, destPort) {
  const dest = { host: String(destHost), port: Number(destPort) || 443 };
  const sock = await connectUpstreamSocks5(upHost, upPort, user, pass, dest);
  try { sock.destroy(); } catch { /* */ }
  return true;
}

/** 一句话描述当前链路（给日志和诊断页用） */
async function describeUpstreamRoute() {
  const sysProxy = await detectSystemProxy();
  if (!sysProxy) return '直连上游代理（未检测到系统前置代理）';
  return `经系统前置代理 ${sysProxy.type}://${sysProxy.host}:${sysProxy.port} → 上游代理`;
}

module.exports = {
  resolveChromeProxy,
  needsAuthBridge,
  releaseBridge,
  bridges,
  formatProxyRules,
  probeUpstreamSocks5,
  connectUpstreamSocks5,
  detectSystemProxy,
  describeUpstreamRoute,
  PROXY_BRIDGE_REV,
  MAX_ACTIVE_TUNNELS,
  HANDSHAKE_LIMIT,
  get openTunnels() { return openTunnels; },
};
