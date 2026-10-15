#!/usr/bin/env node
/** 快速验证：browser/update 带 id upsert + MAX_CONCURRENT 配置可读 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tkswarm-upsert-'));
process.env.TKSWARM_BROWSER_DATA = dataDir;
process.env.TKSWARM_BROWSER_MAX_CONCURRENT = '2';

const { startServer } = require('../src/server');
const db = require('../src/db');
const { MAX_CONCURRENT_OPENS } = require('../src/config');

const TOKEN = 'upsert-token';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function post(base, route, body) {
  const res = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

async function main() {
  console.log('MAX_CONCURRENT_OPENS=', MAX_CONCURRENT_OPENS);
  if (Number(MAX_CONCURRENT_OPENS) !== 2) {
    console.error('FAIL concurrent config');
    process.exit(1);
  }

  db.saveUser({ id: 1, username: 'u', token: TOKEN, is_super: 1 });
  db.setApiToken(TOKEN);

  const port = await freePort();
  const { server, url } = await startServer(port, '127.0.0.1');
  try {
    const created = await post(url, '/browser/update', { name: 'before', remark: 'r0', proxyType: 'noproxy' });
    if (!created?.success || !created?.data?.id) {
      console.error('FAIL create', created);
      process.exit(1);
    }
    const id = created.data.id;
    const updated = await post(url, '/browser/update', {
      id,
      name: 'after',
      remark: 'r1',
      proxyType: 'noproxy',
    });
    if (
      updated?.success
      && updated?.data?.id === id
      && updated?.data?.name === 'after'
      && updated?.data?.remark === 'r1'
    ) {
      console.log('[OK] upsert', id, updated.data.name, updated.data.remark);
    } else {
      console.error('FAIL upsert', updated);
      process.exit(1);
    }
    await post(url, '/browser/delete', { id });
    console.log('\nSmoke upsert OK');
  } finally {
    try { server.close(); } catch { /* */ }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
