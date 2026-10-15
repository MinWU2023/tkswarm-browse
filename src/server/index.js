const express = require('express');
const path = require('node:path');
const { createRouter } = require('./bit-api');
const dashboard = require('./dashboard-api');
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

  app.use(dashboard);
  app.use(createRouter());

  app.use('/ui', express.static(path.join(__dirname, '../../ui')));

  return app;
}

function startServer(port = API_PORT, host = API_HOST) {
  const app = createApp();
  return new Promise((resolve) => {
    const server = app.listen(port, host, () => {
      resolve({ app, server, url: `http://${host}:${port}` });
    });
  });
}

module.exports = { createApp, startServer };
