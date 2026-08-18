# 打包后白屏（file:// + ES Module CORS）修复方案

> 状态：**调研与规划文档，未落地任何改动**。
> 目标：把渲染进程从 `file://` 加载切换为自定义特权协议 `app://` 加载，
> 使 ES Module（`type="module"`）在打包后能以同源、正确 Content-Type 加载，消除 CORS 校验失败导致的白屏。

---

## 1. 根因回顾（已确认）

| 项         | 事实                                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 渲染入口   | `dist/renderer/index.html` 用 `<script type="module" src="./assets/main-*.js">`（已实测）                                                                                                                                      |
| 加载方式   | `window-manager.ts` 非 dev 分支 `mainWindow.loadFile(rendererPath)`，从 `app.asar` 走 `file://` 加载                                                                                                                           |
| 根因       | ES Module 脚本始终以 CORS 模式请求，与是否带 `crossorigin` 属性无关；`file://` 协议不返回 CORS 响应头 → 模块脚本 CORS 校验失败被拒执行 → React 未挂载 → 白屏                                                                   |
| 旧缓解无效 | `stripCrossOriginOnTags` 仅剥离 `crossorigin` 属性，但 `type="module"` 的 CORS 校验由脚本类型本身触发，与属性无关，故白屏依旧                                                                                                  |
| 诊断证据   | `createMainWindow` 的 8s 超时 `ipcMain.on('renderer:ready')` 未收到上报 → 弹“渲染进程 8s 内未上报就绪”，写 `diag.log` 的 `renderer-not-ready`；渲染成功时 `main.tsx` 末尾 `window.electronAPI?.reportReady?.()` 会清除该计时器 |

修复思路：**不用 `file://` 加载，改用自定义特权协议 `app://`**。特权协议（`secure + standard + supportFetchAPI + stream`）能让资源被视为同源、`webRequest` 正常触发、可被 `protocol.handle` 返回正确 `Content-Type` 与 CORS 头，模块脚本即可执行。

---

## 2. 涉及文件清单

| 文件                                            | 操作       | 说明                                                                                                                                                             |
| ----------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/index.ts`                             | 改         | 在 `app.whenReady()` 之前，于现有 `registerSchemesAsPrivileged` 注册 `app` 特权协议；并在顶层调用 `registerRendererProtocol()`                                   |
| `src/main/app/renderer-protocol.ts`             | 新增       | `protocol.handle('app', …)` 协议处理器：按 `req.url` 路径从 `dist/renderer` 读文件、按扩展名设置 Content-Type、补 `Access-Control-Allow-Origin: *`、缺失返回 404 |
| `src/main/app/window-manager.ts`                | 改         | 非 dev 分支 `loadFile` → `loadURL('app://renderer/index.html')`；dev 分支不变                                                                                    |
| `src/main/app/__tests__/window-manager.test.ts` | 改（跟进） | 非 dev 用例现断言 `loadFile` 被调用，需改为断言 `loadURL('app://renderer/index.html')`                                                                           |
| `vite.config.ts` / `electron.vite.config.ts`    | 不动       | `stripCrossOriginOnTags` 保留（无害纵深防御）；`base: './'` 保持不变，模块相对路径经 `app://renderer/` 解析正确                                                  |

> 路径依据：`window-manager.ts` 编译后 `__dirname === dist/main/main/app`，其现有 `path.join(__dirname,'../../../renderer/index.html')` 已证明可定位到 `dist/renderer`；新协议处理器沿用同一相对基准。

---

## 3. 自包含实现（不新增依赖）

### 3.1 `src/main/index.ts` — 注册 `app` 特权协议（Before / After）

**Before**（节选）：

```ts
import { app, protocol, dialog, shell } from 'electron'
// ...
// 注册自定义协议，使渲染进程可以安全访问本地媒体文件
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      stream: true
    }
  }
])
```

**After**：

```ts
import { app, protocol, dialog, shell } from 'electron'
import { registerRendererProtocol } from './app/renderer-protocol' // 新增
// ...
// 注册自定义协议，使渲染进程可以安全访问本地媒体文件
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      stream: true
    }
  },
  // 新增：渲染进程产物协议，替代 file:// 加载，规避 ES Module CORS 白屏
  {
    scheme: 'app',
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      stream: true
    }
  }
])

// 新增：注册 app:// 资源处理器（必须在 app.whenReady() 之前，与 registerSchemesAsPrivileged 同级）
registerRendererProtocol()
```

### 3.2 新增 `src/main/app/renderer-protocol.ts`

```ts
import { protocol } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'

// 编译后本文件 __dirname === dist/main/main/app
// 回退 3 层到达 dist/renderer（与 window-manager.ts 现有路径计算一致）
const RENDERER_DIR = path.resolve(__dirname, '../../../renderer')

// 按扩展名返回 Content-Type；缺失回退 octet-stream
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm'
}

let registered = false

/**
 * 注册 app:// 协议处理器：把 app://renderer/<path> 映射到 dist/renderer/<path>。
 * - 模块脚本以同源、正确 MIME 加载，不再触发 file:// CORS 校验
 * - 补 Access-Control-Allow-Origin:* 作为纵深防御
 * - 越界路径返回 403，缺失文件返回 404
 */
export function registerRendererProtocol(): void {
  if (registered) return
  registered = true

  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url)
      const rel = decodeURIComponent(url.pathname) // 忽略 hostname('renderer')，仅取 pathname 作为相对路径
      const filePath = path.normalize(path.join(RENDERER_DIR, rel))

      // 防目录穿越：解析后的真实路径必须仍在 RENDERER_DIR 内
      if (filePath !== RENDERER_DIR && !filePath.startsWith(RENDERER_DIR + path.sep)) {
        return new Response('Forbidden', { status: 403 })
      }

      const data = await fs.readFile(filePath)
      const ext = path.extname(filePath).toLowerCase()
      return new Response(data, {
        headers: {
          'Content-Type': MIME[ext] ?? 'application/octet-stream',
          'Access-Control-Allow-Origin': '*'
        }
      })
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  })
}
```

### 3.3 `src/main/app/window-manager.ts` — 加载方式（Before / After）

**Before**（非 dev 分支，约 96–180 行）：

```ts
  } else {
    // 路径计算：__dirname 在打包后为 dist/main/main/app/...
    const rendererPath = path.join(__dirname, '../../../renderer/index.html')
    const preloadPath = path.join(__dirname, '../preload.js')
    // 诊断：输出关键路径 + 文件存在性检查，定位白屏根因
    diagLog('WIN', `__dirname=${__dirname}`)
    // ...（大量 loadFile 相关诊断与事件监听）...
    diagLog('WIN', 'before loadFile')
    try {
      await mainWindow.loadFile(rendererPath)
      diagLog('WIN', 'loadFile resolved successfully')
    } catch (loadErr) {
      // ...
    }
  }
```

**After**（关键改动仅替换加载行，诊断日志保留以便对照）：

```ts
  } else {
    const preloadPath = path.join(__dirname, '../preload.js')
    // 诊断保留：确认关键路径
    diagLog('WIN', `__dirname=${__dirname}`)
    diagLog('WIN', `preloadPath=${preloadPath}`)
    // （其他 did-fail-load / console-message / 8s 就绪计时器等诊断逻辑保持不变）

    // 改用特权协议加载：app:// 资源同源、带正确 Content-Type，ES Module 不再被 CORS 拒执行
    diagLog('WIN', 'before loadURL app://renderer/index.html')
    try {
      await mainWindow.loadURL('app://renderer/index.html')
      diagLog('WIN', 'loadURL resolved successfully')
    } catch (loadErr) {
      diagLog(
        'WIN',
        `loadURL REJECTED: ${loadErr instanceof Error ? loadErr.message : String(loadErr)}`
      )
      throw loadErr
    }
  }
```

> 说明：
>
> - `fs` / `fs.existsSync` 的 import 若仅用于渲染路径检查可保留无害，亦可精简（本项目遵循“只解决当前问题”，保留不影响）。
> - `will-navigate` 防护已放行 `app://`（`url.startsWith('app://')`），**无需改动**。
> - `applyContentSecurityPolicy()` 的 `onHeadersReceived` 对 `app://` 响应同样生效，CSP 响应头逻辑**保留不动**。
> - `window-manager.ts` 顶部需新增 `import { registerRendererProtocol } from './renderer-protocol'`，但处理器在 `index.ts` 顶层已注册，本处 import 仅为类型/显式可读性；若仅由 `index.ts` 注册，可不在此 import（二选一）。

---

## 4. 对照成熟实现 `@electron-toolkit/utils` 的 `createProtocol`

社区标准做法出自 `@electron-toolkit/utils` 的 `createProtocol`（源码 `packages/utils/src/createProtocol.ts`，仓库 `github.com/electron-toolkit/electron-toolkit`）。其等价算法：

1. `protocol.registerSchemesAsPrivileged([{ scheme, privileges: { secure, standard, supportFetchAPI, stream } }])`；
2. `protocol.handle(scheme, async (request) => { … })` 用 `new URL(request.url)` 解析，`join(dir, parsedUrl.hostname, parsedUrl.pathname)` 拼文件，`readFile` 读回，按 `mime.getType()` 设 `Content-Type`；
3. 读失败 `catch` 返回 `new Response('', { status: 404 })`。

它把 `scheme://<hostname>/<pathname>` 映射到 `<dir>/<hostname>/<pathname>`——即 `app://renderer/index.html` → `<dir>/renderer/index.html`。

### 等价格式（若选择引入该库）

```bash
npm i @electron-toolkit/utils
```

```ts
// src/main/index.ts（在 app.whenReady() 之前，顶层）
import { createProtocol } from '@electron-toolkit/utils'
// __dirname 编译后为 dist/main/main/app；'../../../' 即 dist；hostname 'renderer' 拼接出 dist/renderer
createProtocol('app', path.resolve(__dirname, '../../../'))
```

```ts
// window-manager.ts 非 dev 分支
await mainWindow.loadURL('app://renderer/index.html')
```

> 决策建议：**推荐自包含方案（第 3 节）**。两者行为等价，但自包含方案零新增依赖、代码完全受控、对 `Content-Type` 映射与目录穿越防护可定制，契合本项目“优先用框架/原生、不随意引依赖”的约定。仅当团队已普遍使用 `@electron-toolkit/utils` 时再考虑引入。

---

## 5. 关键风险与注意

1. **`registerSchemesAsPrivileged` 必须在 `app.whenReady()` 之前调用**（本方案放在 `index.ts` 顶层，与 `media` 同处，已满足）。
2. **`protocol.handle` 与 `registerSchemesAsPrivileged` 需同一 scheme 名称 `app`**，避免拼写不一致导致 `ERR_UNSUPPORTED`。
3. **Content-Type 必须正确**：`.js/.mjs/.cjs → text/javascript`（不能是 `application/octet-stream`，否则模块被拒绝）；本方案 MIME 表已覆盖产物实际扩展名。
4. **`base: './'` 保持不变**：`index.html` 内 `./assets/main-*.js` 相对 URL 经 `app://renderer/index.html` 解析为 `app://renderer/assets/main-*.js`，handler 命中 `dist/renderer/assets/...`。
5. **测试需同步更新**：`__tests__/window-manager.test.ts` 当前断言非 dev 调 `loadFile`，改动后应为 `loadURL` 携带 `'app://renderer/index.html'`；否则 `npm run test:main` 失败。
6. **CSP 双保险**：`index.html` 内 `<meta http-equiv="Content-Security-Policy">` 与 `applyContentSecurityPolicy()` 响应头一致，二者均保留；`app://renderer` 为 `standard` 特权同源，`script-src 'self'` 正常匹配，不挡模块。

---

## 6. 回滚方案

- **源码回滚**：`git revert` 涉及的三处改动（或丢弃本方案 diff），恢复 `loadFile(rendererPath)` 分支即可。
- **无需回滚构建产物**：`dist/` 为可重建目录，回滚源码后重新 `npm run build` 即可。
- **`app://` 处理器残留无副作用**：即便未调用 `loadURL('app://…')`，已注册的 `app` scheme 与 handler 不影响 `file://`/`http://localhost`/`media://` 现有路径（dev 仍走 `localhost:5173`，`media://` 独立 scheme）。
- **快速验证回滚**：回滚后运行 `npm run build && electron .`，应再次复现 8s 诊断弹窗（即旧白屏行为），证明改动确为根因修复。

---

## 7. 验证步骤

### 7.1 构建后本地验证（已构建 `dist`）

```bash
npm run build
electron .
```

- 预期：主窗口在数秒内显示应用界面（非白屏）；**8s 诊断弹窗不弹出**；`userData/diag.log` 中无 `renderer-not-ready`。
- 核查：`DevTools → Console` 无 CORS / 模块加载报错；`DevTools → Network` 中 `app://renderer/index.html` 与 `app://renderer/assets/*.js` 状态 200，`Content-Type: text/javascript`。

### 7.2 打包后在干净机器验证（ installer）

```bash
npm run dist:win
```

- 在未安装 Node/仓库的 Windows 干净机器安装 `release/NikkiGallery-Setup-<version>.exe`；
- 启动应用，确认：窗口有内容、不弹“应用未能正常渲染”诊断框；打开 DevTools 确认无 CORS 报错；菜单/图片（走 `media://`）等核心功能正常。
- 回归：dev 模式 `npm run dev:ev`（或 `electron-vite dev`）仍走 `http://localhost:5173`，热更新正常，不受本次改动影响。

### 7.3 自动化回归

```bash
npm run test:main   # 需先更新 window-manager.test.ts 的非 dev 用例
npm run lint
npm run typecheck
```

---

## 8. 改动 diff 草案汇总

```diff
--- a/src/main/index.ts
+++ b/src/main/index.ts
+import { registerRendererProtocol } from './app/renderer-protocol'
 protocol.registerSchemesAsPrivileged([
   { scheme: 'media', privileges: { secure:true, standard:true, supportFetchAPI:true, stream:true } },
+  { scheme: 'app',   privileges: { secure:true, standard:true, supportFetchAPI:true, stream:true } }
 ])
+registerRendererProtocol()

--- a/src/main/app/window-manager.ts
+++ b/src/main/app/window-manager.ts
   } else {
-    const rendererPath = path.join(__dirname, '../../../renderer/index.html')
-    await mainWindow.loadFile(rendererPath)
+    await mainWindow.loadURL('app://renderer/index.html')
   }

--- /dev/null
+++ b/src/main/app/renderer-protocol.ts
+import { protocol } from 'electron'
+import path from 'node:path'
+import fs from 'node:fs/promises'
+const RENDERER_DIR = path.resolve(__dirname, '../../../renderer')
+// MIME 表 + registerRendererProtocol()：protocol.handle('app', …) 读文件、设 Content-Type、补 ACAO、404/403
```
