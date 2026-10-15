#!/usr/bin/env node
/** 无需 Electron：验证 Bit 兼容 API 可启动 */
const { startServer } = require('../src/server');

startServer(54346, '127.0.0.1').then(async ({ url }) => {
  console.log('Smoke: listening', url);
  const health = await fetch(`${url}/health`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }).then((r) => r.json());
  console.log('Health (no login):', health.msg || health);
  console.log('Smoke OK — 请先 npm start 登录后再测 browser/list');
  process.exit(0);
}).catch((e) => {
  console.error('Smoke failed:', e.message);
  process.exit(1);
});
