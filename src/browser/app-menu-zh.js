const { Menu, app, dialog } = require('electron');

function buildEditMenu() {
  return {
    label: '编辑',
    submenu: [
      { label: '撤销', role: 'undo' },
      { label: '重做', role: 'redo' },
      { type: 'separator' },
      { label: '剪切', role: 'cut' },
      { label: '复制', role: 'copy' },
      { label: '粘贴', role: 'paste' },
      { label: '全选', role: 'selectAll' },
    ],
  };
}

function buildViewMenu() {
  return {
    label: '视图',
    submenu: [
      { label: '重新加载', role: 'reload' },
      { label: '强制重新加载', role: 'forceReload' },
      { label: '开发者工具', role: 'toggleDevTools' },
      { type: 'separator' },
      { label: '实际大小', role: 'resetZoom' },
      { label: '放大', role: 'zoomIn' },
      { label: '缩小', role: 'zoomOut' },
      { type: 'separator' },
      { label: '全屏', role: 'togglefullscreen' },
    ],
  };
}

function buildWindowMenu() {
  return {
    label: '窗口',
    submenu: [
      { label: '最小化', role: 'minimize' },
      { label: '关闭', role: 'close' },
    ],
  };
}

/**
 * 主控制台应用菜单（汉化）
 * @param {object} opts
 * @param {() => void} [opts.onTestEnv]
 * @param {() => void} [opts.onCloseTestEnv]
 */
function buildMainAppMenu(opts = {}) {
  const product = '第一页自研浏览器';
  const template = [
    {
      label: product,
      submenu: [
        {
          label: '关于第一页自研浏览器',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: '关于',
              message: product,
              detail: `版本 v${app.getVersion()}\nTkSwarm 指纹浏览器 · 比特协议兼容`,
            });
          },
        },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    buildEditMenu(),
    buildViewMenu(),
    buildWindowMenu(),
    {
      label: '调试',
      submenu: [
        {
          label: '打开测试环境窗（直连 TkSwarm 官网）',
          click: () => opts.onTestEnv?.(),
        },
        {
          label: '关闭测试环境窗',
          click: () => opts.onCloseTestEnv?.(),
        },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: 'TkSwarm 官网',
          click: () => {
            const { shell } = require('electron');
            shell.openExternal('http://tkswarm-api.dyyweb.com/');
          },
        },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

module.exports = { buildMainAppMenu };
