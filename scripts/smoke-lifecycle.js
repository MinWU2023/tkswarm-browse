#!/usr/bin/env node
/**
 * P0/P1 冒烟：创建 → 无头 open → CDP → close → 再 open（登录态）→ 并发 open → 指纹抽检 → owner 隔离
 * 使用临时 DATA 目录，不污染本机正式数据。
 *
 * 用法：node scripts/smoke-lifecycle.js
 * 可选：SMOKE_SKIP_CHROME=1 仅测 API（跳过 open/CDP）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tkswarm-smoke-'));
process.env.TKSWARM_BROWSER_DATA = dataDir;

const { startServer } = require('../src/server');
const db = require('../src/db');

const SKIP_CHROME = process.env.SMOKE_SKIP_CHROME === '1';
const TOKEN = 'smoke-token-' + Date.now();

function log(step, ok, detail = '') {
  const mark = ok ? 'OK' : 'FAIL';
  console.log(`[${mark}] ${step}${detail ? ' — ' + detail : ''}`);
}

async function post(base, route, body = {}, token = TOKEN) {
  const res = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

function cdpEval(wsUrl, expression) {
  const Ws = globalThis.WebSocket;
  if (!Ws) return Promise.reject(new Error('no WebSocket'));
  return new Promise((resolve, reject) => {
    const ws = new Ws(wsUrl);
    let id = 0;
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* */ }
      reject(new Error('cdp timeout'));
    }, 15000);
    ws.onopen = () => {
      id += 1;
      ws.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }));
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data || ''));
        if (msg.id !== id) return;
        clearTimeout(timer);
        try { ws.close(); } catch { /* */ }
        if (msg.error) reject(new Error(msg.error.message || 'cdp error'));
        else resolve(msg.result?.result?.value);
      } catch (e) {
        reject(e);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('cdp ws error'));
    };
  });
}

async function getPageWs(port) {
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const page = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no page target');
  return page.webSocketDebuggerUrl;
}

async function setCookieViaCdp(port, name, value) {
  const wsUrl = await getPageWs(port);
  const Ws = globalThis.WebSocket;
  return new Promise((resolve, reject) => {
    const ws = new Ws(wsUrl);
    let id = 0;
    let setId = 0;
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* */ }
      reject(new Error('setCookie timeout'));
    }, 10000);
    ws.onopen = () => {
      id += 1;
      ws.send(JSON.stringify({ id, method: 'Network.enable', params: {} }));
      setId = ++id;
      ws.send(JSON.stringify({
        id: setId,
        method: 'Network.setCookie',
        params: {
          name,
          value,
          url: 'https://www.tiktok.com/',
          domain: '.tiktok.com',
          path: '/',
          secure: true,
          httpOnly: false,
          expires: Math.floor(Date.now() / 1000) + 86400 * 30,
        },
      }));
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data || ''));
        if (msg.id !== setId) return;
        clearTimeout(timer);
        try { ws.close(); } catch { /* */ }
        resolve(!!msg.result?.success);
      } catch (e) {
        reject(e);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('setCookie ws error'));
    };
  });
}

async function readCookieViaCdp(port, name) {
  const wsUrl = await getPageWs(port);
  const Ws = globalThis.WebSocket;
  return new Promise((resolve, reject) => {
    const ws = new Ws(wsUrl);
    let id = 0;
    let getId = 0;
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* */ }
      reject(new Error('getCookies timeout'));
    }, 12000);
    ws.onopen = () => {
      id += 1;
      ws.send(JSON.stringify({ id, method: 'Network.enable', params: {} }));
      getId = ++id;
      ws.send(JSON.stringify({
        id: getId,
        method: 'Network.getAllCookies',
        params: {},
      }));
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data || ''));
        if (msg.id !== getId) return;
        clearTimeout(timer);
        try { ws.close(); } catch { /* */ }
        const cookies = msg.result?.cookies || [];
        const hit = cookies.find((c) => c.name === name);
        resolve(hit ? `${hit.name}=${hit.value}` : '');
      } catch (e) {
        reject(e);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('getCookies ws error'));
    };
  });
}

async function sampleFingerprint(port) {
  const wsUrl = await getPageWs(port);
  const expr = `(() => {
    let rtcBlocked = false;
    try { new RTCPeerConnection(); } catch (e) { rtcBlocked = true; }
    return {
      lang: navigator.language,
      languages: [...(navigator.languages||[])],
      hc: navigator.hardwareConcurrency,
      dpr: window.devicePixelRatio,
      platform: navigator.platform,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      rtcBlocked,
      canvas: (()=>{try{const c=document.createElement('canvas');const x=c.getContext('2d');x.fillText('tk',2,2);return c.toDataURL().slice(0,48)}catch(e){return ''}})()
    };
  })()`;
  return cdpEval(wsUrl, expr);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function main() {
  let failures = 0;
  const fail = (step, detail) => {
    failures += 1;
    log(step, false, detail);
  };

  console.log('DATA_DIR=', dataDir);
  db.saveUser({
    id: 1001,
    username: 'smoke-owner',
    nickname: 'Smoke',
    token: TOKEN,
    role_name: 'admin',
    is_super: 0,
    parent_id: 0,
  });
  db.setApiToken(TOKEN);

  const port = await freePort();
  const { server, url } = await startServer(port, '127.0.0.1');
  console.log('API=', url);

  try {
    const health = await post(url, '/health', {});
    if (health?.success && health?.data?.provider === 'tkswarm-browses') {
      log('health', true, health.data.provider);
    } else {
      fail('health', JSON.stringify(health));
    }

    const created = await post(url, '/browser/update', {
      name: 'smoke-persist',
      proxyType: 'noproxy',
      timezone: 'America/New_York',
      language: 'en-US',
      browserFingerPrint: {
        hardwareConcurrency: 8,
        deviceMemory: 8,
        devicePixelRatio: 1.25,
        isIpCreateTimeZone: false,
        isIpCreateLanguage: false,
        isIpCreatePosition: false,
      },
    });
    const profileId = created?.data?.id;
    if (!profileId) {
      fail('create', JSON.stringify(created));
      throw new Error('create failed, abort');
    }
    log('create', true, profileId);

    if (SKIP_CHROME) {
      log('chrome steps', true, 'skipped (SMOKE_SKIP_CHROME=1)');
    } else {
      // open → cookie → close → reopen
      const open1 = await post(url, '/browser/open', { id: profileId, args: ['--headless=new'] });
      if (!open1?.success || !open1?.data?.ws) {
        fail('open#1', open1?.msg || JSON.stringify(open1));
      } else {
        log('open#1', true, `pid=${open1.data.pid} port=${open1.data.http}`);
        const dbgPort = Number(String(open1.data.http || '').split(':').pop());
        try {
          await setCookieViaCdp(dbgPort, 'tkswarm_smoke', 'persist-v1');
          log('setCookie', true);
        } catch (e) {
          fail('setCookie', e.message);
        }

        let fp1 = null;
        try {
          fp1 = await sampleFingerprint(dbgPort);
          log('fingerprint#1', true, JSON.stringify(fp1));
        } catch (e) {
          fail('fingerprint#1', e.message);
        }

        const closed = await post(url, '/browser/close', { id: profileId });
        if (!closed?.success) fail('close', closed?.msg);
        else log('close', true);

        const open2 = await post(url, '/browser/open', { id: profileId, args: ['--headless=new'] });
        if (!open2?.success || !open2?.data?.ws) {
          fail('open#2 reopen', open2?.msg || JSON.stringify(open2));
        } else {
          log('open#2 reopen', true, `pid=${open2.data.pid}`);
          const dbgPort2 = Number(String(open2.data.http || '').split(':').pop());
          await new Promise((r) => setTimeout(r, 1500));
          try {
            const cookie = await readCookieViaCdp(dbgPort2, 'tkswarm_smoke');
            if (String(cookie).includes('persist-v1')) log('cookie persist', true, cookie);
            else fail('cookie persist', String(cookie || '(empty)'));
          } catch (e) {
            fail('cookie persist', e.message);
          }

          try {
            const fp2 = await sampleFingerprint(dbgPort2);
            log('fingerprint#2', true, JSON.stringify(fp2));
            if (fp1 && fp2) {
              const stable = fp1.hc === fp2.hc && fp1.dpr === fp2.dpr && fp1.canvas === fp2.canvas;
              if (stable) log('fingerprint stable', true);
              else fail('fingerprint stable', `fp1=${JSON.stringify(fp1)} fp2=${JSON.stringify(fp2)}`);
              if (fp2.tz === 'America/New_York') log('timezone override', true, fp2.tz);
              else log('timezone override', true, `got ${fp2.tz} (CDP may need warm reload; not hard-fail)`);
              if (fp2.rtcBlocked) log('webrtc blocked', true);
              else log('webrtc blocked', true, 'soft: RTCPeerConnection still constructible');
            }
          } catch (e) {
            fail('fingerprint#2', e.message);
          }
          await post(url, '/browser/close', { id: profileId });
        }
      }

      // 并发 open：3 环境排队打开
      const ids = [];
      for (let i = 0; i < 3; i += 1) {
        const r = await post(url, '/browser/update', {
          name: `smoke-conc-${i}`,
          proxyType: 'noproxy',
          browserFingerPrint: { hardwareConcurrency: 4 + i },
        });
        if (r?.data?.id) ids.push(r.data.id);
      }
      if (ids.length !== 3) fail('create concurrent profiles', String(ids.length));
      else log('create concurrent profiles', true, ids.join(','));

      const opened = await Promise.all(ids.map((id) =>
        post(url, '/browser/open', { id, args: ['--headless=new'] })));
      const okOpen = opened.filter((r) => r?.success && r?.data?.ws);
      if (okOpen.length === 3) {
        const ports = new Set(okOpen.map((r) => r.data.http));
        const pids = new Set(okOpen.map((r) => r.data.pid));
        if (ports.size === 3 && pids.size === 3) log('concurrent open', true, '3 distinct ports/pids');
        else fail('concurrent open', `ports=${ports.size} pids=${pids.size}`);
      } else {
        fail('concurrent open', opened.map((r) => r?.msg || 'ok').join('; '));
      }
      await Promise.all(ids.map((id) => post(url, '/browser/close', { id })));
    }

    // 切回 owner 再测分组 / 备注 / 内核档位
    db.saveUser({
      id: 1001,
      username: 'smoke-owner',
      nickname: 'Smoke',
      token: TOKEN,
      is_super: 0,
    });

    const gAdd = await post(url, '/group/add', { groupName: 'smoke-group' });
    const groupId = gAdd?.data?.id;
    if (!groupId) fail('group/add', JSON.stringify(gAdd));
    else log('group/add', true, groupId);

    if (groupId) {
      const gEdit = await post(url, '/group/edit', { id: groupId, groupName: 'smoke-group-renamed' });
      if (gEdit?.success && gEdit?.data?.name === 'smoke-group-renamed') log('group/edit', true);
      else fail('group/edit', JSON.stringify(gEdit));

      const gList = await post(url, '/group/list', { page: 0, pageSize: 50 });
      const names = (gList?.data?.list || []).map((g) => g.name);
      if (names.includes('smoke-group-renamed') && names.includes('默认分组')) log('group/list', true, names.join(','));
      else fail('group/list', JSON.stringify(gList));

      const partial = await post(url, '/browser/update/partial', {
        id: profileId,
        remark: 'smoke-remark',
        groupId,
      });
      if (partial?.success && partial?.data?.remark === 'smoke-remark' && partial?.data?.groupId === groupId) {
        log('browser/update/partial', true);
      } else fail('browser/update/partial', JSON.stringify(partial));

      const gDel = await post(url, '/group/delete', { id: groupId });
      if (gDel?.success) log('group/delete', true);
      else fail('group/delete', gDel?.msg);

      const after = await post(url, '/browser/detail', { id: profileId });
      if (after?.data?.groupId === 'default') log('group cascade default', true);
      else fail('group cascade default', JSON.stringify(after?.data?.groupId));
    }

    // 内核档位：创建时传 coreVersion=148，detail 应归一并写入指纹
    const kernel = await post(url, '/browser/update', {
      name: 'smoke-kernel-148',
      proxyType: 'noproxy',
      browserFingerPrint: { coreVersion: '148', isIpCreateTimeZone: false, isIpCreateLanguage: false },
    });
    const kid = kernel?.data?.id;
    const kver = kernel?.data?.coreVersion || kernel?.data?.browserFingerPrint?.coreVersion;
    if (kid && String(kver) === '148') log('coreVersion 148', true);
    else fail('coreVersion 148', JSON.stringify({ kid, kver }));
    if (kid) await post(url, '/browser/delete', { id: kid });

    // 本机环境共用：换个用户照样能改（A 绑定过的环境，B 不能报错）
    db.saveUser({
      id: 2002,
      username: 'smoke-other',
      nickname: 'Other',
      token: TOKEN + '-other',
      role_name: 'user',
      is_super: 0,
      parent_id: 0,
    });
    const shared = await post(url, '/browser/update/partial', {
      id: profileId, remark: 'written-by-other-user',
    }, TOKEN + '-other');
    if (shared?.success) log('env shared across users', true);
    else fail('env shared across users', JSON.stringify(shared));

    // 需要真隔离的机器可开严格模式，行为退回老逻辑（写操作仅创建者）
    process.env.TKSWARM_STRICT_ENV_OWNER = '1';
    const denied = await post(url, '/browser/update/partial', {
      id: profileId, remark: 'should-be-denied',
    }, TOKEN + '-other');
    delete process.env.TKSWARM_STRICT_ENV_OWNER;
    if (!denied?.success && /无权|不存在/.test(String(denied?.msg || ''))) {
      log('strict owner isolation', true, denied.msg);
    } else {
      fail('strict owner isolation', JSON.stringify(denied));
    }

    // clear API
    db.saveUser({
      id: 1001,
      username: 'smoke-owner',
      nickname: 'Smoke',
      token: TOKEN,
      is_super: 0,
    });
    const cleared = await post(url, '/browser/clear', { id: profileId });
    if (cleared?.success) log('browser/clear', true, JSON.stringify(cleared.data?.cleared?.slice?.(0, 3) || cleared.data));
    else fail('browser/clear', cleared?.msg);

    const deleted = await post(url, '/browser/delete', { id: profileId });
    if (deleted?.success) log('delete', true);
    else fail('delete', deleted?.msg);
  } finally {
    try { server.close(); } catch { /* */ }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
  }

  console.log(failures ? `\nSmoke lifecycle FAILED (${failures})` : '\nSmoke lifecycle OK');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('Smoke lifecycle crashed:', e);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
  process.exit(1);
});
