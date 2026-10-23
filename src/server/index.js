const express = require('express');
const path = require('node:path');
const { createRouter } = require('./bit-api');
const dashboard = require('./dashboard-api');
const statusPage = require('./status-page');
const { API_HOST, API_PORT } = require('../config');

function createApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // 人看的：状态页 + 代理自检（/ 与 /proxy-test），必须排在最前
  app.use(statusPage.buildRouter());
  app.use(dashboard);
  app.use(createRouter());

  app.use('/ui', express.static(path.join(__dirname, '../../ui')));

  return app;
}

function startServer(port = API_PORT, host = API_HOST) {
  const app = createApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      resolve({ app, server, url: `http://${host}:${port}` });
    });
    server.on('error', (error) => {
      if (error && error.code === 'EADDRINUSE') {
        const conflict = new Error(`本地端口 ${port} 已被占用：可能已有一个客户端在运行（右下角托盘），先完全退出再打开`);
        conflict.code = 'EADDRINUSE';
        reject(conflict);
        return;
      }
      reject(error);
    });
  });
}

module.exports = { createApp, startServer };
