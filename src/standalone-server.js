#!/usr/bin/env node
/** 无 Electron 壳，仅启动 Bit 兼容 API（调试用） */
const { startServer } = require('./server');
const { API_HOST, API_PORT } = require('./config');

startServer(API_PORT, API_HOST).then(({ url }) => {
  console.log(`第一页自研浏览器 API listening at ${url}`);
  console.log('请在 第一页自研浏览器 桌面端登录后再调用 browser/* 接口');
});
