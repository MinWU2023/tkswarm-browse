# 第一页自研浏览器（tkswarm-browses）推代码与版本打包

> 项目目录：`tkswarm-browses/`  
> 自动打包工作流：仓库根目录 [`.github/workflows/tkswarm-browses-release.yml`](../.github/workflows/tkswarm-browses-release.yml)  
> 触发条件：推送 tag **`browser-v*`**（或 Actions 里手动 `workflow_dispatch`）

---

## 1. 日常推代码（不打包）

在仓库根目录操作（本仓库为 monorepo）：

```bash
# 查看改动
git status
git diff

# 暂存自研浏览器相关改动
git add tkswarm-browses/
# 若改了根目录工作流，一并：
# git add .github/workflows/tkswarm-browses-release.yml

git commit -m "feat(browses): 说明本次改动"

# 推到远端（按你的主分支名替换 main）
git push origin HEAD
```

仅推代码 **不会** 触发安装包构建；要出 EXE/DMG 需走下面「打版本」。

---

## 2. 发新版本前准备

### 2.1 改版本号

编辑 `tkswarm-browses/package.json` 的 `"version"`，与即将打的 tag 对齐（去掉 `browser-` 前缀）：

| package.json | Git tag |
|--------------|---------|
| `"1.0.1"` | `browser-v1.0.1` |
| `"1.2.0"` | `browser-v1.2.0` |

也可用 npm（在 `tkswarm-browses` 目录）：

```bash
cd tkswarm-browses
npm version 1.0.1 --no-git-tag-version
cd ..
```

### 2.2（建议）本地冒烟

```bash
cd tkswarm-browses
npm install
npm run smoke:all
```

### 2.3 提交版本号

```bash
git add tkswarm-browses/package.json tkswarm-browses/package-lock.json
git commit -m "chore(browses): bump version to 1.0.1"
git push origin HEAD
```

---

## 3. 打 tag 触发 Git 自动打包（推荐）

**Tag 格式必须是 `browser-v` + 语义化版本**，否则根目录工作流不会创建 Release。

### Windows（PowerShell）

```powershell
# 版本示例：1.0.1 → tag browser-v1.0.1
$VER = "1.0.1"

# 确保当前提交已推送
git push origin HEAD

# 打 annotated tag 并推送（推送 tag 才会跑 Actions）
git tag -a "browser-v$VER" -m "第一页自研浏览器 v$VER"
git push origin "browser-v$VER"
```

### macOS / Linux（bash）

```bash
VER=1.0.1
git push origin HEAD
git tag -a "browser-v${VER}" -m "第一页自研浏览器 v${VER}"
git push origin "browser-v${VER}"
```

### 之后发生什么

1. GitHub Actions 跑 `Release 第一页自研浏览器`
2. Windows runner：`npm run dist:win` → 上传 NSIS 安装包 `*-win-x64.exe` + 绿色便携版 `*-win-portable.exe`
3. macOS runner：`npm run dist:mac` → 上传 `*.dmg` / `*.zip`
4. 两个平台都成功后，用 `gh release create` 生成 Release：
   - Tag / Release 名：`browser-v1.0.1`
   - 标题：`第一页自研浏览器 v1.0.1`
   - 附件：Win 安装包 + Win 便携版 + Mac DMG/ZIP

查看进度：

```bash
gh run list --workflow=tkswarm-browses-release.yml
gh release view browser-v1.0.1
```

浏览器打开：仓库 → **Actions** → **Release 第一页自研浏览器**；产物在 **Releases**。

---

## 4. 不打 tag：手动触发工作流

Actions 页对该 workflow 点 **Run workflow**（`workflow_dispatch`）。

注意：当前脚本里 **创建 GitHub Release 的步骤** 带条件  
`if: startsWith(github.ref, 'refs/tags/browser-v')`，  
因此手动跑一般只会产出 **Artifacts**，**不会**自动建 Release。要正式发版仍建议推 `browser-v*` tag。

下载 Artifacts：

```bash
gh run download <run-id> -n TkSwarmBrowser-Windows
gh run download <run-id> -n TkSwarmBrowser-macOS
```

---

## 5. 本机打包（不依赖 CI）

需本机已装 Node ≥ 20，且能拉 Electron 依赖（国内可配镜像）。

```bash
cd tkswarm-browses
npm install

# 仅打未安装目录（调试用）
npm run pack

# Windows：NSIS 安装包 + 绿色便携版 → dist/*-win-x64.exe、dist/*-win-portable.exe
npm run dist:win

# 仅打绿色便携版
npm run dist:win:portable

# macOS（需在 Mac 上）→ dist/*.dmg、*.zip
npm run dist:mac
```

国内 Electron 下载慢时（PowerShell 示例）：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
npm install
npm run dist:win
```

本机打好后若要手动挂到 Release：

```bash
gh release create browser-v1.0.1 `
  --title "第一页自研浏览器 v1.0.1" `
  --notes "Windows / macOS 安装包。本地 API: http://127.0.0.1:54345" `
  tkswarm-browses/dist/*.exe
# Mac 产物同理追加 dist/*.dmg dist/*.zip
```

---

## 6. 推荐完整发版流程（复制即用）

把 `1.0.1` 换成新版本：

```powershell
$VER = "1.0.1"

# 1) 改版本号
cd tkswarm-browses
npm version $VER --no-git-tag-version
cd ..

# 2) 提交并推送代码
git add tkswarm-browses/package.json tkswarm-browses/package-lock.json
git commit -m "chore(browses): bump version to $VER"
git push origin HEAD

# 3) 打 tag 触发 CI 打包 + Release
git tag -a "browser-v$VER" -m "第一页自研浏览器 v$VER"
git push origin "browser-v$VER"

# 4) 盯构建
gh run list --workflow=tkswarm-browses-release.yml --limit 3
```

---

## 7. 常见问题

| 问题 | 处理 |
|------|------|
| 推了 tag 没跑 Actions | monorepo 用 `browser-v1.x.x`；独立仓库 `tkswarm-browse` 用 `v1.x.x` |
| Release 只有安装版没有便携版 | 旧版 `package.json` 的 `win.target` 只有 `nsis`；需升级到含 `portable` 的配置后重打 tag |
| 只出了 Artifacts 没有 Release | 是否用了 `workflow_dispatch` 而不是推 tag；或 Win/Mac 某一 job 失败 |
| Mac 包打不出来 | `dist:mac` 必须在 macOS runner / 本机 Mac；不要在 Windows 上跑 |
| Mac 只有 arm64 | 旧 CI 仅 Apple Silicon；现配置会同时打 x64 + arm64 |
| tag 打错了 | `git push origin :refs/tags/browser-v错版` 删远端 tag 后重打（若已建 Release，先在网页删 Release） |
| `tkswarm-browses/.github/workflows/release.yml` | **独立仓库** `tkswarm-browse` 用这份：tag `v*`，路径在仓库根（`package-lock.json` / `dist/`）。monorepo 仍以根目录 `browser-v*` 工作流为准 |

---

## 8. 相关路径

| 说明 | 路径 |
|------|------|
| 自研浏览器源码 | `tkswarm-browses/` |
| 版本号 | `tkswarm-browses/package.json` → `version` |
| 本地打包脚本 | `npm run dist:win`（含便携版）/ `dist:win:portable` / `dist:mac` |
| 便携版数据目录 | exe 同级 `data/`（可用 `TKSWARM_BROWSER_DATA` 覆盖） |
| CI 自动发版 | `.github/workflows/tkswarm-browses-release.yml` |
| 项目简介 | `tkswarm-browses/README.md` |
