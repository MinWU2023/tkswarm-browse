/**
 * 本地代理桥：Chrome/Electron 对带账密 SOCKS5 支持差，且 session.setProxy 直连上游 SOCKS 不稳定。
 * 在 127.0.0.1 起无认证本地 SOCKS5，再转发到上游（支持 IPv4 / 域名 / IPv6）。
 */
const net = require('node:net');

/** @type {Map<string, { server: net.Server, port: number, refs: number }>} */
const bridges = new Map();

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

function connectUpstreamSocks5(host, port, user, pass, dest) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(port), host);
    let stage = 'greeting';
    let buf = Buffer.alloc(0);
    const hasAuth = Boolean(String(user || '').trim() || String(pass || '').trim());

    const fail = (err) => {
      try { sock.destroy(); } catch { /* */ }
      reject(err);
    };

    sock.on('error', fail);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greeting') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05) return fail(new Error('上游不是 SOCKS5'));
        const method = buf[1];
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
        if (buf[1] !== 0x00) return fail(new Error('SOCKS5 用户名/密码认证失败'));
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
        if (buf.length < need) return;
        sock.removeAllListeners('data');
        resolve(sock);
      }
    });

    sock.write(hasAuth ? Buffer.from([0x05, 0x01, 0x02]) : Buffer.from([0x05, 0x01, 0x00]));
  });
}

function connectUpstreamHttp(host, port, user, pass, destHost, destPort) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(port), host);
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
    sock.on('error', reject);
    sock.on('data', (chunk) => {
      buf += chunk.toString('binary');
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = buf.slice(0, idx);
      if (!/^HTTP\/1\.\d 200/i.test(head)) {
        sock.destroy();
        reject(new Error(`HTTP 代理 CONNECT 失败: ${head.split('\r\n')[0]}`));
        return;
      }
      sock.removeAllListeners('data');
      resolve(sock);
    });
    sock.write(req);
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

function startLocalSocksBridge(profile) {
  const key = bridgeKey(profile);
  const existing = bridges.get(key);
  if (existing) {
    existing.refs += 1;
    return Promise.resolve({ port: existing.port, key, release: () => releaseBridge(key) });
  }

  const upHost = String(profile.proxy_host);
  const upPort = Number(profile.proxy_port);
  const user = String(profile.proxy_user || '');
  const pass = String(profile.proxy_pass || '');
  const type = String(profile.proxy_type || 'socks5').toLowerCase();

  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      let buf = Buffer.alloc(0);
      let stage = 'greeting';

      client.on('error', () => client.destroy());
      client.on('data', async (chunk) => {
        try {
          if (stage === 'tunnel') return;
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
              client.end(Buffer.from([0x05, parsed.error, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
              return;
            }
            const { dest, leftover } = parsed;
            buf = Buffer.alloc(0);
            stage = 'tunnel';
            client.pause();

            let upstream;
            if (type === 'http' || type === 'https') {
              upstream = await connectUpstreamHttp(upHost, upPort, user, pass, dest.host, dest.port);
            } else {
              upstream = await connectUpstreamSocks5(upHost, upPort, user, pass, dest);
            }
            client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            if (leftover.length) upstream.write(leftover);
            client.resume();
            client.pipe(upstream);
            upstream.pipe(client);
            upstream.on('error', () => client.destroy());
            client.on('close', () => upstream.destroy());
          }
        } catch (e) {
          try {
            client.end(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          } catch { /* */ }
          client.destroy();
        }
      });
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
  return `socks5=127.0.0.1:${port}`;
}

/**
 * @returns {Promise<{ proxyArg: string|null, release: function, localPort?: number, proxyRules?: string }>}
 */
async function resolveChromeProxy(profile, opts = {}) {
  const type = String(profile.proxy_type || 'noproxy').toLowerCase();
  if (type === 'noproxy' || !profile.proxy_host) {
    return { proxyArg: null, release: () => {} };
  }

  const alwaysBridge = opts.alwaysBridge !== false;
  const useBridge = alwaysBridge || needsAuthBridge(profile);

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

  const bridge = await startLocalSocksBridge(profile);
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
};
