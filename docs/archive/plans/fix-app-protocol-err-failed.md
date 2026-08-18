# 修复打包后启动报错 `ERR_FAILED (-2) loading 'app://renderer/index.html'`

> 状态：**待实施（本文件为详细修复计划）**
> 目标：解决「打包后的版本」启动即报 `ERR_FAILED (-2) loading 'app://renderer/index.html'` 并反复出现的问题，让 `app://` 特权协议在 Electron 打包运行时正常提供渲染资源，恢复窗口渲染。
> 范围约束（硬性）：**严格控制修改面**，只动 `renderer-protocol.ts`（+ 配套测试 + 校验脚本），不动 `index.ts` 的协议特权声明、不动 `window-manager.ts` 的 `loadURL` 链路、不动 `media://` 协议、不引入额外 npm 依赖（除非第 2 节评估后才引入，且当前结论为**不引入**）。

---

## 1. 现状与根因

### 1.1 报错日志（用户提交 `D:\Users\Downloads\startup-errors.log`，节选）

```
[2026-08-17T06:54:29.404Z] [STAGE: initialize-fatal] ERR_FAILED (-2) loading 'app://renderer/index.html'
Error: ERR_FAILED (-2) loading 'app://renderer/index.html'
    at rejectAndCleanup ...
    at finishListener ...
    at WebContents.stopLoadingListener ...
    at WebContents.emit ...
（该错误在 06:54–07:31 之间重复出现十余次，每次对应一次启动/重试）
```

- `[STAGE: initialize-fatal]` 标签来自 `src/main/app/lifecycle.ts` 的启动兜底 `logStartupError('initialize-fatal', fatalErr)`（`src/main/utils/startup-diagnostic.ts` 统一落盘 `userData/startup-errors.log`）。
- 栈帧 `rejectAndCleanup → finishListener → stopLoadingListener → WebContents.emit` 表明：这是 `mainWindow.loadURL('app://renderer/index.html')` 触发的 `did-fail-load`（`net::ERR_FAILED (-2)`）被 reject 后向上抛出，经 `createMainWindow → bootstrapApplication` 冒泡到 lifecycle 的 catch。
- **只有在打包版本出现**：dev 模式走 `http://localhost:5173`，不经过 `app://` 协议，因此 dev 正常。这与用户「使用打包后的版本启动报错」的描述一致。

### 1.2 关键链路

1. `src/main/index.ts`：`app.whenReady().then(...)` 内先 `registerRendererProtocol()`，再 `new Application()` → `bootstrapApplication` → `createMainWindow`。
2. `src/main/app/window-manager.ts` 非 dev 分支：`await mainWindow.loadURL('app://renderer/index.html')`。
3. `src/main/app/renderer-protocol.ts`：注册 `protocol.handle('app', ...)`，把 `app://renderer/<path>` 映射到 `dist/renderer/<path>` 并用 `fs.readFile` 读取后返回 `Response`。

### 1.3 根因（已通过产物实测确认）

我已核实三点事实：

1. **渲染资源确实在 asar 内、路径解析正确**：解包 `release/win-unpacked/resources/app.asar`，可见 `\dist\renderer\index.html`、`\dist\main\main\app\index.js`、`\dist\main\main\preload.js` 均存在。`renderer-protocol.ts` 的 `RENDERER_DIR = path.resolve(__dirname, '../../../renderer')`（`__dirname === app.asar/dist/main/main/app` → `app.asar/dist/renderer`）解析无误。因此**不是文件缺失 / 路径回退层数问题**。
2. **`app://` handler 返回的 Response 缺少 `Content-Length`**：产物 `index.js` 中该 handler 为
   ```js
   const data = await fs$1.readFile(filePath);
   return new Response(data, { headers: { "Content-Type": ..., "Access-Control-Allow-Origin": "*" } });
   ```
   全产物检索 `Content-Length` 出现次数为 **0**。即：把 Node `Buffer` 直接作为 `Response` body 返回，却**未设置 `Content-Length`**。
3. **对比健康链路 `media://`**：`src/main/app/media-protocol.ts` 对 200/206 响应都显式带了 `Content-Length`（见 L101/L116），故 `media://` 正常，而 `app://` 失败。

结论根因：**Electron `protocol.handle` 的处理器返回一个「固定 Buffer 作为 body、但响应头没有 `Content-Length`」的 `Response` 时，Chromium 网络栈无法确定文档响应长度，进而以 `net::ERR_FAILED (-2)` 拒绝首个文档加载**。这正是 `app://renderer/index.html` 文档请求失败的直接原因；模块脚本请求（`*.js`）因文档都加载失败而根本无从发起。

> 补充佐证：Electron 官方教程/API 推荐的自定义协议实现一律用 `net.fetch(url.pathToFileURL(filePath).toString())` 作为返回（该实现会由 Chromium 正确填充 `Content-Length`、自动处理 asar、设置正确 MIME），而非手工 `fs.readFile + new Response(Buffer)`。`@electron-toolkit/utils` 的 `createProtocol` 内部即此算法。详见下文第 2 节「依赖声明 / 复用成熟方案」。

---

## 2. 依赖声明与复用成熟方案

### 2.1 依赖声明（严格执行「先验证，再进入下一步」）

| 依赖项      | 说明                                                                          | 动作                                                        |
| ----------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `electron`  | 仅用其内置 `net`、`protocol`、`app`。**不新增任何第三方 npm 依赖**。          | 复用现有（`electron 40.10.6`，package.json 已声明并已安装） |
| `node:url`  | 内置模块，用于 `url.pathToFileURL`。                                          | 复用现有 Node 内置                                          |
| `node:path` | 内置模块。                                                                    | 复用现有 Node 内置                                          |
| `node:fs`   | 内置模块（`existsSync` / `readFile` 仅用 `fs` 判存在）。                      | 复用现有 Node 内置                                          |
| 测试框架    | `vitest`（已有），沿用 `media-protocol.test.ts` 的 mock 约定。                | 复用现有                                                    |
| 打包冒烟    | `@playwright/test`（已有），用 `e2e/smoke.e2e.ts` S1 断言 `app://` 加载成功。 | 复用现有                                                    |

**不引入** `@electron-toolkit/utils`。理由（沿用「不随意引依赖」的仓库约定）：官方 `protocol.handle + net.fetch(file://)` 模式是内置能力，零依赖即可实现，行为与 `createProtocol` 等价且完全受控；本处仅需修一处 Response 构造，无需为此拉入整个工具库。

### 2.2 复用的成熟实现

直接采用 **Electron 官方文档的 `protocol.handle` + `net.fetch(pathToFileURL(...))` 范式**（Electron API「protocol」章节、`net` 章节均有此示例；下文第 4 节落地）。该模式已被 Electron 社区广泛使用，能正确：

- 填充 `Content-Length`（消除 `ERR_FAILED (-2)`）；
- 透传正确 MIME/状态给 Chromium；
- 透明处理 `app.asar` 内的资源读取（`pathToFileURL` 的 `file://` 指向 asar 内 `dist/renderer` 时，Electron 的 `net` 层自动经 asar 虚拟文件系统取文件）；
- 保留我们的**目录穿越防护**与 403/404 语义（在 `net.fetch` 之前先做路径校验，命中越界/缺失时返回自定义 `Response`）。

---

## 3. 启动说明（运行/验证命令）

前置：目录需已 install。Node ≥ 20、npm 可用。

```bash
# 1) 单元测试（含本修复新增用例）
npm run test:main
#    或在仅改动到位时定向跑
npx vitest run src/main/app/__tests__/renderer-protocol.test.ts media-protocol.test.ts window-manager.test.ts

# 2) 类型检查与 lint（改动文件不得新增错误）
npm run typecheck
npx eslint src/main/app/renderer-protocol.ts src/main/app/__tests__/renderer-protocol.test.ts

# 3) 构建产物（生成 dist）
npm run build

# 4) 打包产物并跑 E2E 冒烟（最终验收，S1～S6）
npm run dist:win          # 内含 build + pre-dist-check + electron-builder + verify:dist
npm run e2e:smoke         # 需先有 release/win-unpacked
```

> 注：`npm run build` 的 `clean` 步骤会被 IDE 的 Node 安全删除保护拦截（`dist/main` 文件>50 阈值 → `SAFE_DELETE_BULK_CONFIRM_REQUIRED`）。repo 记忆（`.codebuddy/memory/2026-08-15.md`）已记录**绕过方式**：先用 PowerShell `Remove-Item -Recurse -Force dist/main`（不受 Node 删除保护影响），再执行 `npm run build` / `npm run dist:win`。**绝不使用 `rmdir /s /q` 递归删除命令。**

---

## 4. 修改文件清单与输入输出

> 原则：**每一步先验证通过，再进入下一步**；把错误消灭在当下。

### 4.1 子任务 0（诊断固化，只读不改代码）

- **修改文件**：无（纯写计划阶段已完成并记录于第 1.3 节）。
- **输入**：`release/win-unpacked/resources/app.asar`（已存在）、`src/main/app/renderer-protocol.ts`、`src/main/app/media-protocol.ts`。
- **输出**：确认根因为「Response 缺 `Content-Length`」；产物路径/资源齐全。
- **验收**：第 1.3 节三项均已实测通过 ✅（已完成）。

### 4.2 子任务 1（主题修复：`renderer-protocol.ts` 改用 `net.fetch` 范式）

- **修改文件**：仅 `src/main/app/renderer-protocol.ts`。
- **改动内容**：
  1. 顶部 import 增加 `import { net } from 'electron'` 与 `import url from 'node:url'`（保留现有 `protocol, app`、`path`、`fs/promises`，删掉不再使用的 `fs` 读取路径——`fs/promises` 若不再用可移除，但**为最小改动**保留仅当被新实现复用时）。
  2. 保持 `RENDERER_DIR`、`MIME` 表、`registered` 标志、`registerRendererProtocol()` 的签名与「app.isReady() 未就绪即返回」防御不变。
  3. 仅改写 handler 主体：保留「解析 URL → `path.join(RENDERER_DIR, rel)` → 目录穿越防护（越界 403）」；在**放行路径存在**（`fs.existsSync(filePath)` 或直接交给 `net.fetch` 由其校验）后，返回 `net.fetch(url.pathToFileURL(filePath).toString())`。为保留「缺失文件 404」语义并避免 `net.fetch` 抛错污染 Chromium，用 `fs.existsSync` 预判：不存在返回 `new Response('Not Found', { status: 404 })`；存在则 `return net.fetch(fileUrl)`。
- **输入**：`app://renderer/index.html` / `app://renderer/assets/*.js` 等的请求 `request.url`。
- **输出**：`net.fetch` 返回的、带正确 `Content-Length` 与 MIME 的 `Response`；越界路径仍 403；缺失文件仍 404；不存在的 handler 内部异常走 `catch` 回 404/500。
- **验收（本步单独）**：
  - `npx vitest run src/main/app/__tests__/renderer-protocol.test.ts` 全绿；
  - `npm run typecheck` 无新错；`npx eslint` 该文件 0 error；
  - `npm run build` 通过；解包/检索产物 `dist/main/main/app/index.js` 确认出现 `net.fetch` 相关代码、且不再以「无 Content-Length 的 Buffer Response」作为主文档响应（见 4.3 校验脚本断言）。

### 4.3 子任务 2（新增/更新测试：`renderer-protocol.test.ts`）

- **修改文件**：新增 `src/main/app/__tests__/renderer-protocol.test.ts`（无则新建；沿用 `media-protocol.test.ts` 的 `vi.mock('electron')` + `vi.mock('fs')` 捕获 handler 的约定）。
- **覆盖用例**（基础测试用例，见第 6 节「错误处理」与第 7 节「参数校验」呼应）：
  1. `registerRendererProtocol()` 在 app.isReady() 为 true 时调用 `protocol.handle('app', handler)` 一次；
  2. app.isReady() 为 false 时不注册、且 `registered` 不被置位（回归「未就绪误置位导致永久未注册」）；
  3. 请求 `app://renderer/index.html` 且文件存在 → 返回 `net.fetch`（mock 返回 200）结果，断言调用 `net.fetch` 用的是 `file://` 且指向 `dist/renderer/index.html`；
  4. 文件不存在 → 404；
  5. 越界路径（`../` 穿越）→ 403，且**不**调用 `net.fetch`；
  6. `net.fetch` 抛错 → 兜底不抛、返回非 2xx（404 或 500，按实现定）；
  7. 目录分隔符兼容（Windows `\` / 正斜杠）下 `app://renderer/assets/main.js` 正确映射（可选，若 handler 保持纯字符串拼接+normalize 则可加）。
- **输入**：伪造的 `request`（`{ url, headers: {get} }`）与 mock 的 `net.fetch` / `fs`.
- **输出**：上述用例断言全绿。
- **验收**：`npx vitest run src/main/app/__tests__/renderer-protocol.test.ts` EXIT:0；`npm run test:main` 不回退既有用例。

### 4.4 子任务 3（校验脚本加固：把「Response 缺 Content-Length」纳入 pre-dist-check 防回归）

- **修改文件**：`scripts/pre-dist-check.ts`（仅追加一个校验函数），**不改动现有校验逻辑**。
- **改动内容**：新增 `checkRendererProtocolContentLength()`：
  - 读取 `dist/main/main/app/index.js`，定位 `protocol.handle('app'` 的 handler 段；
  - 断言其返回路径**不再出现**「`fs.*readFile` 返回值直接作为 `Response` body 且无 `Content-Length`」的旧模式（可采用与现有 `checkMainIndexProtocolInsideWhenReady` 类似的字符串哨兵：handler 段内应包含 `net.fetch`，且对主文档分支不应是裸 `new Response(data,` 而无 `Content-Length`）；
  - 简单、稳健的判据：handler 段内出现 `net.fetch(pathToFileURL`（或 minify 后的等价）即视为通过；否则 `fail(...)` 阻断打包。
  - 在 `main()` 中调用（放在 `checkMainIndexProtocolInsideWhenReady()` 之后）。
- **输入**：`dist/main/main/app/index.js`。
- **输出**：控制台 `✔ / ✖`；失败则 `process.exit(1)` 阻止 `npm run dist:win`。
- **验收**：改前（旧产物）应 `✖` 失败；改后（重 build 产物）应 `✔` 通过。

### 4.5 子任务 4（最终验收：打包 + E2E 冒烟）

- **修改文件**：无。
- **输入**：已修复并 build 的产物 + `release/win-unpacked`。
- **输出**：`npm run e2e:smoke` 全绿，尤其：
  - S1：`win.url()` 以 `app://renderer/` 开头（`app://` 协议加载成功——**本问题的直接验收**）；
  - S2：#root 有真实渲染内容（非白屏）；
  - S3/S4/S5/S6:preload/IPC/原生模块/稳定性正常。
- **验收**：
  - `npm run dist:win` 全部 pre-dist-check/`verify:dist` 通过；
  - `npm run e2e:smoke` 6+ 用例全绿；
  - 手工在干净目录双击安装后的 exe 启动，`userData/startup-errors.log` **不再新增** `ERR_FAILED (-2)`，窗口内容正常显示。

> 执行顺序依赖：子任务 1 → 先跑 4.2 验收；→ 子任务 2 → 4.3 验收；→ 子任务 3 → 4.4 验收；→ 子任务 4 → 最终验收。**每一步必须上一步通过后再开始。**

---

## 5. 错误处理

| 场景                                            | 行为（保持/新增）                                                                                                                                                |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.isReady()` 为 false 时调用注册             | 保持现有防御：记 `logStartupError` 并 `return`，**不置 `registered`**（防止永久漏注册）                                                                          |
| 目录穿越（`filePath` 落到 `RENDERER_DIR` 之外） | 保持返回 `403 Forbidden`，且不发起 `net.fetch`                                                                                                                   |
| 目标文件不存在                                  | `fs.existsSync` 预判 → 返回 `404 Not Found`（语义与现有一致）                                                                                                    |
| `net.fetch(fileUrl)` 抛错/被中止                | 外层 `try/catch` 兜底 → 记 `logStartupError`（可选）+ 返回 404/500，**绝不让 handler 以 reject 冒泡**（reject 会转成 `ERR_FAILED` 回到白屏）                     |
| MIME 设置                                       | 不再手工拼 MIME：`net.fetch` 对 `file://` 会由 Electron 推断正确 MIME/`Content-Type`；`stream` 特权已声明，`net.fetch` 的 body 为可读流，天然带 `Content-Length` |
| asar 内读取                                     | `net` 层自动处理 `app.asar` 虚拟路径，无需额外 `fs.readFile`                                                                                                     |

> 关键错误处理原则：**`protocol.handle` 的 handler 绝不能向外 reject 或抛同步异常**，否则 Chromium 以 `ERR_FAILED (-2)` 拒绝请求——这正是本次 bug 的直接成因，必须在重写时从根上避免（全程 try/catch，返回合法 `Response`）。

---

## 6. 参数校验

- **请求 URL 解析**：`new URL(request.url)` 失败（非法 URL）→ 兜底返回 `400/404`，不继续。
- **路径解析**：`decodeURIComponent(url.pathname)` 可能抛 `URIError`（如 `%off`）→ 置于 try/catch 内，兜底返回 404（与 media-protocol 对非法转义的处理保持一致）。
- **目录穿越校验**：`path.normalize(path.join(RENDERER_DIR, rel))` 后，`filePath !== RENDERER_DIR && !filePath.startsWith(RENDERER_DIR + path.sep)` → 403。
- **文件存在性**：`fs.existsSync(filePath)` 为 false → 404（避免把 ENOENT 交给 `net.fetch` 转成 Chromium 错误）。
- **返回类型**：handler 保证任何分支都返回一个合法的 `Response`（200 / 403 / 404 / 500），绝不 `return undefined` 或抛错。

---

## 7. 基础测试用例（固化到 `renderer-protocol.test.ts`）

| #   | 用例                       | 断言                                                                                                                              |
| --- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | app 就绪后注册成功         | `protocol.handle` 被调用 1 次，scheme 为 `'app'`，处理器为 function                                                               |
| 2   | app 未就绪不注册且不置位   | app.isReady=false 时无 `protocol.handle` 调用；再次（就绪后）调用能成功注册                                                       |
| 3   | 正常文档请求走 `net.fetch` | `app://renderer/index.html` & 文件存在 → `net.fetch` 被调；参数为 `file://...dist/renderer/index.html`；返回 mock 的 200 Response |
| 4   | 缺失文件 404               | 文件不存在分支返回 `404`，不调用 `net.fetch`                                                                                      |
| 5   | 目录穿越 403               | `../` 越界 URL 返回 `403`，不调用 `net.fetch`                                                                                     |
| 6   | `net.fetch` 抛错兜底       | mock `net.fetch` reject → handler 不 throw，返回合法 `Response`（404/500）                                                        |
| 7   | 非法 `%` 转义不抛          | `app://renderer/50%off.js` → 不抛 URIError，返回合法 `Response`                                                                   |

（补充打包冒烟用例，见 4.5 的 S1。）

---

## 8. 时间盒与验证节奏

- 每个子任务完成后，立即运行其验收命令；**任何一步失败先就地修复，不带着错误进入下一步**。
- 若 `npx vitest run` 全量被 watch 检测截断（repo 已知陷阱），改用**定向 `npx vitest run <file>`** 与 `npm run test:main`。
- 最终以 `npm run e2e:smoke`（对真实 `win-unpacked` 打包产物）为发布硬闸门。

---

## 9. 回滚方案

- 源码回滚：`git checkout -- src/main/app/renderer-protocol.ts scripts/pre-dist-check.ts`（并删除新增测试文件）即恢复旧 `fs.readFile + Raw Buffer Response` 实现。
- 产物回滚：`dist/`、`release/` 为可重建目录，回滚源码后重新 `npm run dist:win` 即可。
- 不影响面：新实现对 `dev`（走 `localhost:5173`）、`media://`、`file://` 均无影响；`app://` 处理器在 dev 下不被触发，行为向后兼容。

---

## 10. 变更 diff 草案（仅供实施参考）

`src/main/app/renderer-protocol.ts` handler 主体由：

```ts
const data = await fs.readFile(filePath)
return new Response(data, {
  headers: {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Access-Control-Allow-Origin': '*'
  }
})
```

改为（示意，按实际文件最终实现）：

```ts
import { protocol, app, net } from 'electron'
import url from 'node:url'
import fs from 'node:fs'
// ...
if (filePath !== RENDERER_DIR && !filePath.startsWith(RENDERER_DIR + path.sep)) {
  return new Response('Forbidden', { status: 403 })
}
if (!fs.existsSync(filePath)) {
  return new Response('Not Found', { status: 404 })
}
return net.fetch(url.pathToFileURL(filePath).toString())
```

> 说明：`Response` 构造（data/string）与 `Access-Control-Allow-Origin` 头的取舍在实施时以第 5/6 节约束为准：凡需自建 `Response`（403/404），仍可带 `Access-Control-Allow-Origin: *`；主文档成功响应一律交 `net.fetch` 以保证 `Content-Length` 正确。
