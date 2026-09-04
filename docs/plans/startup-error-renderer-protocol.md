# 启动白屏崩溃修复计划（app:// 协议 ERR_FAILED(-2)）

> 交付物：修复打包版本启动时 `loadURL('app://renderer/index.html')` 报 `ERR_FAILED (-2)` 的白屏崩溃。
> 范围控制：**仅处理启动白屏**，不触碰工作树中无关的删除进度改动（`useFileOperations.ts`、`useStagedTask.ts`、`TaskProgressOverlay.tsx`、`UpdateDialog.tsx`、`DuplicatesPage.tsx`、`GalleryPage.tsx`、`RecycleBinPage.tsx`、`progress.ts`、`plan-check-update-dialog.md` 等）。

---

## 1. 问题定位（根因）

用户（非本机，使用打包后版本）提交日志 `startup-errors.log` 反复出现：

```text
[WIN] before loadURL app://renderer/index.html
[WIN] loadURL REJECTED: ERR_FAILED (-2) loading 'app://renderer/index.html'
```

崩溃发生在 `app.whenReady → Application.initialize() → createMainWindow() → loadURL` 阶段（stage: `initialize-fatal`），导致主界面白屏无法进入。

`registerSchemesAsPrivileged done` / `registerRendererProtocol done` 均已在 `loadURL` 之前成功打印，说明协议处理器已注册，但首个文档请求即被 Chromium 协议栈以 `ERR_FAILED(-2)` 拒绝。

**根因**：线上 2.3.5 的 `app://` 协议处理器旧实现用 `net.fetch(file://app.asar/...)` 读取 asar 内的渲染产物。`net.fetch` 走 Chromium 网络栈读取 `app.asar` 内文件，主进程路径无官方背书，线上实测触发 `ERR_FAILED(-2)` 白屏（`renderer-protocol.ts` 源码注释已自陈："线上（2.3.5）实测触发 ERR_FAILED (-2) 白屏"）。早期一版 `fs.readFile + new Response(Buffer)` 缺 `Content-Length` 也曾触发同一错误。

**正确修复（工作树已含，本次验证固化）**：改用 Node `fs`（`fs.readFile`，Electron 官方明确支持 asar 虚拟文件系统的 API）读取文件，返回显式带 `Content-Type` / `Content-Length` 的 `Response`。

---

## 2. 依赖声明

- **零新增 npm 依赖**。
- **复用 Electron 首方协议 API**：`protocol.registerSchemesAsPrivileged` + `protocol.handle('app', handler)` + Node `fs`。这是 Electron 官方一等公民做法，文档明确推荐，对 asar + `Content-Length` 处理最稳健。
- **不引入第三方库**：评估过 `electron-serve`（sindresorhus），其底层用已废弃的 `protocol.registerFileProtocol`，对 asar + `Content-Length` 处理不如首方 `protocol.handle` 稳健，且引入新依赖 → 否决。
- **复用项目内部模块**：
  - `src/main/utils/startup-diagnostic.ts` 的 `diagLog` / `logStartupError`（处理器与窗口管理器已有诊断日志）。
  - `RENDERER_MIME` 扩展名→MIME 映射（模块内已实现）。
- 精确版本锁定：`electron@40.10.6`（ABI 一致），`electron-vite@5`，`React@19`，`TypeScript@5.9`。

---

## 3. 启动说明

### 3.1 开发模式

```bash
npm run dev          # electron-vite dev，渲染层走 http://localhost:5173，不经 app:// 协议
```

### 3.2 构建（本机绕过 Safe-Delete 网关）

> 本机 `npm run build` 的 `clean` 步会触发 Safe-Delete 网关 EPERM（`dist/main` 达数百项），故**不直接 `npm run dist:win`**，改用等价序列：

```bash
npx electron-vite build                                              # 构建 main/renderer/preload（绕过 clean）
node -e "require('fs').writeFileSync('dist/main/package.json',JSON.stringify({type:'commonjs'}))"  # 写 commonjs 声明
npm run pre-dist-check                                               # 预发布闸门（含 11.5/11.6/12）
npx electron-builder --win --publish never                           # 打包（若 release/win-unpacked 被锁，临时改 package.json 的 directories.output 指向 release2 后还原）
npm run verify:dist                                                  # 校验 asar 内原生二进制
```

> 注意：`electron-vite` 会把非入口模块（如 `renderer-protocol.ts`）内联进 `dist/main/main/app/index.js`，因此产物中**没有**独立的 `renderer-protocol.js` 文件——这是预期行为，修复已在 `index.js` 内联实现（grep 可见 `protocol.handle("app", ...)` + `fs.promises.readFile` + `Content-Length`）。

### 3.3 协议注册时序（关键约束）

- `protocol.registerSchemesAsPrivileged([{scheme:'app', privileges:{secure,standard,supportFetchAPI,stream}}])` 在 `app.whenReady()` **之前**于 `src/main/index.ts` 模块顶层同步调用。
- `registerRendererProtocol()` 在 `app.whenReady()` 回调**内**调用（`protocol.handle` 内部访问 `session.defaultSession`，提前调用会抛 "Session can only be received when app is ready" 致启动挂起）。

### 3.4 调用链

```text
index.ts: app.whenReady().then → registerRendererProtocol() 注册 app://
  → Application.initialize() → createMainWindow()
  → mainWindow.loadURL('app://renderer/index.html')
  → Chromium 请求 app://renderer/index.html → handler 读 dist/renderer/index.html 返回 200
```

---

## 4. 错误处理

处理器（`protocol.handle('app', handler)`）内部**绝不向外抛**，按场景返回标准 `Response`：

| 场景                                         | 处理         | 返回                                      |
| -------------------------------------------- | ------------ | ----------------------------------------- |
| 目录穿越（解析后路径不在 `RENDERER_DIR` 内） | 拒绝访问     | `403` + 简短文本                          |
| 文件不存在（`fs.existsSync` 为 false）       | 返回空       | `404` + 简短文本                          |
| `fs.promises.readFile` 抛错（`catch` 兜底）  | 记录并兜底   | `404`                                     |
| 非法 `%` 转义（`decodeURIComponent` 失败）   | `catch` 兜底 | `404`                                     |
| 正常文件                                     | 读取字节     | `200` + `Content-Type` + `Content-Length` |

上层防御（`src/main/app/window-manager.ts`）：

- `loadURL` 包在 `try/catch` 内，失败时写 `startup-diagnostic` 日志（`[WIN] loadURL REJECTED`）。
- 8 秒白屏兜底：若主窗口未 `did-finish-load`，弹窗提示并允许重建。
- `render-process-gone` 事件：弹窗并触发窗口重建，避免进程崩溃后无响应。

---

## 5. 参数校验

handler 接收 `Request` 后按以下步骤校验（防止路径穿越与非法输入）：

1. `new URL(request.url)` 解析，取 `pathname`。
2. `decodeURIComponent(pathname)`（失败 → 404 兜底）。
3. `path.join(RENDERER_DIR, rel)` 拼接相对路径。
4. `path.normalize` 规范化。
5. **目录穿越防护**：校验规范化后路径以 `RENDERER_DIR` 起止（不在其中 → `403`）。
6. `fs.existsSync` 文件存在性校验（不存在 → `404`）。
7. `fs.promises.readFile` 读取字节，`RENDERER_MIME[ext]` 取 MIME，`Content-Length = byteLength`。

`RENDERER_DIR` 计算：`path.resolve(__dirname, '../../../renderer')`（编译后 `__dirname === dist/main/main/app`，回退 3 层到 `dist/renderer`，与 `window-manager.ts` 一致）。测试期可通过 `process.env.WXNN_RENDERER_DIR` 覆盖（生产不设置，行为不变）。

---

## 6. 基础测试用例

| 用例   | 文件                                    | 场景                                                                | 断言                                                                 |
| ------ | --------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 单元#1 | `renderer-protocol.test.ts`             | app 就绪后注册                                                      | `protocol.handle` 被调用，scheme='app'                               |
| 单元#2 | 同上                                    | app 未就绪不注册                                                    | `registered` 不置位                                                  |
| 单元#3 | 同上                                    | 正常文件                                                            | 返回 `200` + 正确 MIME + `Content-Length`                            |
| 单元#4 | 同上                                    | 文件不存在                                                          | 返回 `404`                                                           |
| 单元#5 | 同上                                    | 目录穿越                                                            | 返回 `403`                                                           |
| 单元#6 | 同上                                    | `readFile` 抛错                                                     | `catch` 兜底 `404`                                                   |
| 单元#7 | 同上                                    | 非法 `%` 转义                                                       | `catch` 兜底 `404`                                                   |
| 集成#1 | `renderer-protocol.integration.test.ts` | 在临时真实目录写 `index.html`，经真实 `fs.readFile` 经 handler 返回 | `200` + `text/html; charset=utf-8` + `Content-Length` 等于文件字节数 |
| 集成#2 | 同上                                    | 子资源 `.js` 真实文件                                               | `200` + `text/javascript` + 正确 `Content-Length`                    |
| 集成#3 | 同上                                    | 目录穿越（真实文件系统）                                            | `403`                                                                |
| 集成#4 | 同上                                    | 不存在路径                                                          | `404`                                                                |

> 运行：`npm run test:main`（vitest run src/main）。集成用例不 mock `fs`/`electron`，写真实临时文件验证端到端 I/O。

---

## 7. 子任务与验收（每步先验证通过再进下一步）

### T1 根因复核 ✅

- 修改文件：`src/main/app/renderer-protocol.ts`、`src/main/index.ts`、`src/main/app/window-manager.ts`（仅走查，未改逻辑）
- 输入：用户日志 `startup-errors.log` + 现有修复代码
- 输出：确认根因 = `net.fetch` 读 asar；确认当前代码无 `net.fetch` / `pathToFileURL`
- 验收：grep 确认 `renderer-protocol.ts` 不含 `net.fetch`、`pathToFileURL`；`registerSchemesAsPrivileged` 含 `app` 特权且在 `whenReady` 前；`registerRendererProtocol` 在 `whenReady` 回调内。

### T2 单元测试 + 类型检查 ✅

- 修改文件：无（复核既有 7 用例）
- 输入：`npm run test:main` + `npx tsc --noEmit -p tsconfig.json`
- 输出：测试报告
- 验收：7 单元用例全绿；tsc 无类型错误（exit 0）。

### T3 集成测试 ✅

- 修改文件：`src/main/app/renderer-protocol.ts`（新增 `WXNN_RENDERER_DIR` 测试覆盖 seam，生产不受影响）、新增 `src/main/app/__tests__/renderer-protocol.integration.test.ts`
- 输入：临时真实 `dist/renderer` 样张（`index.html`、`.js`）
- 输出：4 个集成用例
- 验收：`npm run test:main` 中 `renderer-protocol` 共 11 用例（7+4）全绿。

### T4 构建 ✅

- 修改文件：无（运行命令）
- 输入：`npx electron-vite build` + 写 `dist/main/package.json {type:commonjs}`
- 输出：`dist/main/main/app/index.js`（含内联修复）、`dist/renderer/index.html`
- 验收：`dist/main/main/app/index.js` 与 `dist/renderer/index.html` 存在；grep 产物无 `net.fetch`/`pathToFileURL`、含 `Content-Length`。

### T5 预发布闸门 ✅

- 修改文件：无（运行命令）
- 输入：`npm run pre-dist-check`（含 `--verify-asar`）
- 输出：检查报告
- 验收：exit 0，无 fail；重点闸门 **11.5**（registerRendererProtocol 在 whenReady 内）、**11.6**（app:// 用 fs.readFile + Response + 显式 Content-Length）、**12**（原生模块 ABI 一致）全绿。

### T6 打包 + 启动冒烟 ✅

- 修改文件：`package.json`（临时将 `directories.output` 改为 `release2` 绕过被锁的 `release/win-unpacked`，构建后还原）
- 输入：`npx electron-builder --win --publish never` → `release2/NikkiGallery-Setup-2.3.5.exe` + `release2/win-unpacked/无限暖暖相册管理工具.exe`
- 输出：启动后读 `%APPDATA%/wxnn-photo-manager/diag.log`
- 验收：
  - 新运行（2026-08-18T14:32）含 `[PROTO] 200 app://renderer/index.html`、`did-finish-load: page loaded successfully`、`loadURL resolved successfully`、`Application.initialize() completed`。
  - 新运行中 `ERR_FAILED` / `REJECTED` 计数为 **0**（历史 4 条 `ERR_FAILED(-2)` 来自 2026-08-14 的旧未修复构建，已在 diag.log 中区分）。
  - 已把修复版安装包复制回 `release/NikkiGallery-Setup-2.3.5.exe`（166 MB）。

### T7 交付文档（本文件）✅

- 修改文件：新增 `docs/plans/startup-error-renderer-protocol.md`
- 输入：上述分析 + 验证结果
- 输出：本 MD 计划（含第 2–6 章强制章节 + 第 7 章子任务验收）
- 验收：文档存在且覆盖依赖声明、启动说明、错误处理、参数校验、基础测试用例。

---

## 8. 验收总标准（全部达成）

- [x] `npm run test` 全绿：`renderer-protocol` 7 单元 + 4 集成用例全过。
- [x] 构建产物经 `npm run pre-dist-check` 全绿（重点 11.5 / 11.6 / 12）。
- [x] 打包后实际启动：窗口渲染成功，`diag.log` 含 `PROTO 200 app://renderer/index.html`，**无 `ERR_FAILED (-2)`**（新运行 0 次，历史旧构建 4 次已区分）。
- [x] 未引入任何新 npm 依赖。
- [x] 无关工作树改动（删除进度相关）未被触碰。
- [x] 修复版安装包 `release/NikkiGallery-Setup-2.3.5.exe` 已就位。

---

## 9. 环境备注（本机实现约束）

- **Safe-Delete 网关**：`npm run build` 的 `clean` 与 `electron-builder` 对 `release/win-unpacked` 的 `trash` 会触发 EPERM。规避：构建用 `npx electron-vite build`；打包遇锁时临时改 `directories.output` 到 `release2` 后还原（已验证可行）。
- **严禁用 cmd 的 `del` 删以点开头文件**：清理临时文件一律用 PowerShell `Remove-Item -LiteralPath`。
- 被锁的 `release/win-unpacked`（系统进程持有 `app.asar`）与冗余的 `release2/` 为 gitignored 构建产物，未强行删除以免触发网关，不影响交付。
