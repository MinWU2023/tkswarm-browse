# TkSwarm Browser (`tkswarm-browses`)

专为 **tkswarm-node** 打造的指纹浏览器，**本地 API 与比特浏览器完全兼容**（默认 `http://127.0.0.1:54345`），Node 项目无需大改，只需把「浏览器 API 地址」指向本服务即可。

## 功能

- 多环境、多代理、多时区、独立 `user-data-dir` 指纹隔离
- 打开时支持 **有头 / 无头**（与 Node `headless.js` 一致，通过 `browser/open` 的 `args` 控制）
- 账号与 TkSwarm 管理后台 **同一套登录**
- 每账号最多 **300** 个浏览器环境
- 桌面首页：本账号/子级环境用量、运行中窗口列表；无头窗口可 **一键显示**
- Windows EXE + macOS DMG，GitHub Actions 自动打包

## 技术选型

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面壳 | **Electron 33** | Win/Mac 一套代码，内嵌控制台 |
| 本地 API | **Express** | 复刻比特 `POST /health`、`/browser/*` 协议 |
| 浏览器内核 | **系统 Chrome / Playwright Chromium** | `--remote-debugging-port` 暴露 CDP，供 Playwright `connectOverCDP` |
| 存储 | **JSON 文件** | 环境元数据、用户会话（无 native 编译依赖） |
| 打包 | **electron-builder** | NSIS (Win) + DMG (Mac) |
| CI | **GitHub Actions + gh cli** | tag `v*` 触发 Release |

## 快速开始

```bash
cd tkswarm-browses
npm install
# 若 Electron 下载超时，可先：npm install --ignore-scripts
# 再单独：set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ && npm install electron electron-builder -D
npm start          # 桌面端（推荐）
# 或
npm run dev        # 开发模式 + DevTools
npm run server     # 仅 API（需先在桌面端登录）
```

1. 启动 **TkSwarm Browser** 桌面应用  
2. 使用与 Node 相同的管理员账号登录  
3. 复制登录后显示的 **API Token** 到 Node「设置 → 浏览器 API Token」（与 `browserApiToken` 相同）  
4. Node 设置里浏览器 API 地址保持：`http://127.0.0.1:54345`

## 与 tkswarm-node 对接

Node 侧 **无需改代码**，沿用 `BitBrowserProvider`：

| Node 配置项 | 值 |
|---|---|
| `browserApiUrl` / `BIT_API_URL` | `http://127.0.0.1:54345` |
| `browserApiToken` / `BIT_API_TOKEN` | 桌面端登录后的 Token |

已实现比特兼容接口：

- `POST /health`
- `POST /group/list`
- `POST /browser/list`
- `POST /browser/open` → 返回 `{ ws, http, pid, ... }`
- `POST /browser/close`
- `POST /browser/delete`
- `POST /browser/detail`
- `POST /browser/update`（创建环境）
- `POST /browser/proxy/update`

## 打包发布

```bash
npm run dist:win    # Windows NSIS 安装包
npm run dist:mac    # macOS DMG + ZIP
```

GitHub Release（需安装 [GitHub CLI](https://cli.github.com/) 并已 `gh auth login`）：

```bash
# 独立仓库 tkswarm-browse：tag 必须是 v*（如 v1.0.0）
git tag -a v1.0.0 -m "v1.0.0"
git push origin v1.0.0
```

工作流 `.github/workflows/release.yml` 会构建 Win/Mac 并 `gh release create` 上传产物。  
（若在 monorepo 根发版，改用 tag `browser-v*` + 根目录 `tkswarm-browses-release.yml`。）

## 数据目录

- Windows: `%APPDATA%\TkSwarmBrowser\`
- macOS: `~/Library/Application Support/TkSwarmBrowser/`

含 SQLite 数据库与各环境的 Chrome `user-data-dir`。

## 环境变量

见 `.env.example`。

## 指纹与代理

- **深度指纹**：打开环境时经 CDP 注入 Canvas / WebGL / Audio / Navigator 噪声（按环境 ID 稳定）
- **代理账密**：Chrome 不支持带用户名密码的 SOCKS5 直连；有账密时自动起本地无认证 SOCKS 桥再转发上游
- **时区**：创建时写入 `timezone`；改代理后需重新打开窗口
- 必须先 **桌面端登录**，Node 的 `browser/list` 才会成功（与比特「客户端已登录」行为一致）

## Node 设置

设置 → 浏览器设置 → **检测 TkSwarm Browser**：一键测连通、识别是否为本服务，并可将地址回填为 `http://127.0.0.1:54345`。
