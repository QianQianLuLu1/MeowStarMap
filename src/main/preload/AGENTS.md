# AGENTS.md — `src/main/preload`（Preload 桥装配层）

本文件为 Agent 与新协作者提供 **preload 模块级** 速览与约定。顶层项目速览见根目录 [`AGENTS.md`](../../../AGENTS.md)；IPC 白名单与 AppError 两条硬性约定见 [`docs/CODING_CONVENTIONS.md`](../../../docs/CODING_CONVENTIONS.md)（唯一真相源；IDE 的 always-on 规则文件仅为它的本地镜像）；通道名/方法签名契约见 [`docs/IPC_CONTRACT.md`](../../../docs/IPC_CONTRACT.md)；handler 注册侧见 [`src/main/ipc/handlers/AGENTS.md`](../ipc/handlers/AGENTS.md)；渲染层调用侧见 [`src/renderer/AGENTS.md`](../../renderer/AGENTS.md)。本文件只补 **本目录内** 的装配与门禁落地方式。

## 模块概述

**注意目录形态：preload 入口不在 `src/preload`，而是 [`src/main/preload.ts`](../preload.ts)**，其命名空间实现全部落在 `src/main/preload/` 下。构建为 cjs lib 单文件 `dist/main/main/preload.js`（见 `electron.vite.config.ts` 的 `preload` 段），`window-manager.ts` 以 `../preload.js` 相对路径引用，产物布局不可随意改动。

职责边界：**preload 只做「装配 + 暴露」，不写业务**。所有业务逻辑在主进程 handler 内；preload 侧每个方法体应是一行 `call<T>('domain:action', ...args)` 或 `subscribe(...)`。

preload 运行在 **sandbox 渲染上下文**，两条硬约束由此而来：

1. **顶层求值必须安全**——任一模块顶层抛错会让整段 preload 失败，`window.electronAPI` 永不暴露，表现为**隐性白屏**（无报错、无界面）。
2. **零运行时依赖**——sandbox 内无 `node_modules` 解析能力，只允许 `electron`。

## 目录结构

| 路径                                           | 职责                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [`../preload.ts`](../preload.ts)               | **唯一入口**：装配 `electronAPI` 对象、执行 origin 门禁、调 `exposeIfTrusted` 暴露 5 个全局                                          |
| [`ipc.ts`](ipc.ts)                             | IPC 基础层：`IpcError` 类 / `call<T>()` 解包 / `subscribe()` 订阅。全部 `api/*.ts` 的公共依赖                                        |
| [`origin-guard.ts`](origin-guard.ts)           | 文档源自检（第二层防线）：`readDocumentOrigin` / `isTrustedDocumentOrigin` / `isPreloadDev`。**零 import**，只读 `location` 原生全局 |
| [`plugin-bridge.ts`](plugin-bridge.ts)         | 插件运行时能力桥 `window.pluginAPI` + i18n.t 注入点 `__setPluginI18nT`                                                               |
| `api/*.ts`                                     | 33 个功能域命名空间，每文件导出一个 `<key>API` 对象（`scannerAPI` / `fileAPI` / `mediaAPI` …）                                       |
| [`../preload-logger.ts`](../preload-logger.ts) | preload 专用零依赖日志（`[preload]` 前缀，仅 `console.warn/error`）                                                                  |
| `__tests__/`                                   | `preload.test.ts`（装配完整性 + 依赖白名单 + 门禁）、`origin-guard.test.ts`                                                          |

DTO 类型快照统一放 [`src/shared/types/electron-api.ts`](../../shared/types/electron-api.ts)，preload 层**不再内联业务类型定义**（例外见「§7 常见陷阱」）。

## 1. 装配模式（三步）

新增/修改一个功能域严格走这三步：

```ts
// ① src/main/preload/api/<domain>.ts —— 只导出一个命名空间对象
// <domain> 命名空间：对应主进程 handlers/<domain>-handler.ts 注册的 <domain>:* 通道
import { call, subscribe } from '../ipc'
import type { XxxResult } from '../../../shared/types/electron-api' // 必须 type-only

export const xxxAPI = {
  get: (id: number) => call<XxxResult>('xxx:get', id),
  onUpdated: (cb: (payload: XxxResult) => void) => subscribe('xxx:updated', cb)
}
```

```ts
// ② src/main/preload.ts —— import 后挂到 electronAPI 对象
import { xxxAPI } from './preload/api/xxx'

const electronAPI = {
  reportReady: () => ipcRenderer.send('renderer:ready'),
  // ...既有 33 个命名空间
  xxx: xxxAPI
}
```

```ts
// ③ 同步更新 src/main/preload/__tests__/preload.test.ts 的键清单断言
//    （'electronAPI 包含全部 34 个键（reportReady + 33 个命名空间，阶段4 增 assetEdits）' 用例），并更新 docs/IPC_CONTRACT.md
```

- **键名与文件名解耦**：`electronAPI` 上的键（如 `mediaAction`、`uiTheme`、`importRoot`）由 `preload.ts` 决定，文件名可用 kebab-case（`media-action.ts`）。改键名等于破坏对外契约。
- 每文件**只导出一个** `<key>API`；需要额外导出的类型（如 `api/scanner.ts` 的 `ScanLogEntry` / `GameRootCandidate`）是历史遗留，新增类型请放 `shared/types/electron-api.ts`。
- 注释风格：文件首行标注对应的 handler 文件与通道前缀，方法上方标注需求编号（`// T05：`、`// P0-02：`）。

## 2. `exposeIfTrusted` 门禁（不可绕过）

preload 是 **webContents 级** 的 `webPreferences`，对窗口加载的**任何**文档都会执行。主框架一旦被导航到 `file:///…/evil.html` 或本机任意端口的 localhost 服务，裸调 `contextBridge.exposeInMainWorld` 就会在那个非应用页面上重建完整 IPC 桥。preload **不受页面 CSP 约束**，CSP 挡不住这条路径。

纵深防御两层：

| 层     | 位置                                                                                   | 手段                                                      |
| ------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 第一层 | [`src/main/app/navigation-guard.ts`](../app/navigation-guard.ts) 的 `isAppDocumentUrl` | 主进程拦截 URL 导航                                       |
| 第二层 | [`origin-guard.ts`](origin-guard.ts) + `preload.ts` 的 `exposeIfTrusted`               | preload 自检所在文档 origin，非授信源**一个全局都不暴露** |

`preload.ts` 内的门禁形态（新增暴露点必须复用，**禁止**直接调 `contextBridge.exposeInMainWorld`）：

```ts
const documentOrigin = readDocumentOrigin()
const trustedDocument = isTrustedDocumentOrigin(documentOrigin, isPreloadDev())

/** 受门禁保护的 contextBridge 暴露：非授信文档静默跳过 */
const exposeIfTrusted = (key: string, value: unknown): void => {
  if (!trustedDocument) return
  contextBridge.exposeInMainWorld(key, value)
}
```

**放行/拒绝集合**（两层必须逐字镜像，改一处要同步改另一处）：

- 放行：`app://`、`media://`（自定义协议，以 `standard + secure` 注册）
- 仅 dev 构建放行：`http://localhost:5173`、`http://127.0.0.1:5173`（对应 `electron.vite.config.ts` 的 `renderer.server.port`）
- 拒绝：空 / `'null'` / `about:` 族。**opaque origin 同样拒绝**——evil 父页可用 `document.write` 写进自建 `about:blank` iframe 后访问其 `contentWindow`，放行等于把第一层防线开的洞重新打开
- 被拒时**只留痕不抛错**（抛错会让真实授信文档也拿不到 API）；此处也不做 i18n（preload 无 i18n 依赖）

**dev 判定是编译期常量，不是运行时环境变量**：`isPreloadDev()` 读 `__NIKKI_PRELOAD_DEV__`，由 `electron.vite.config.ts` 的 `preload.define` 注入 `JSON.stringify(process.env.NODE_ENV === 'development')`。不能用 `process.env.NODE_ENV`——preload 在 sandbox 内，且 electron-vite 的 lib 模式不做该静态替换（实测 dist 产物保留字面量）。常量缺失时（如 vitest 直接跑源码）**安全缺省为 false**，即只放行 `app://` 与 `media://`。

**当前暴露的 5 个全局**（`preload.test.ts` 有断言，增删必须同步）：
`electronAPI`、`IpcError`、`pluggableElectronIpc`、`__setPluginI18nT`、`pluginAPI`。

## 3. `call<T>()` / `subscribe()` 语义

```ts
export async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as IpcResponse<T>
  if (res && res.success) return res.data
  if (res && !res.success && res.error) {
    throw new IpcError(res.error.code, res.error.message, res.error.details, res.error.userMessage)
  }
  throw new IpcError('IPC_MALFORMED_RESPONSE', `IPC 响应格式异常: ${channel}`, res)
}
```

- **双层 `success` 结构**：外层 `IpcResponse.success` 由主进程 `wrapHandler` 生成，`call<T>()` **只透出 `res.data`**，外层 success 被丢弃。因此渲染层拿到的就是 handler 的**原始返回对象**——若前端要检查 `res.success`，handler 必须真的返回含 `success: true` 的对象（约定见 `docs/IPC_CONTRACT.md` §2）。
- 失败路径统一 `throw IpcError`，渲染层用 `try/catch` + `err instanceof window.IpcError` 判断；`userMessage` 经 `extractUserMessage(error)` 取用（见 `src/renderer`）。
- `subscribe(channel, cb)` 剥离首个 `IpcRendererEvent` 参数，回调直接收业务载荷，**返回退订函数**。禁止在 `api/*.ts` 里手写 `ipcRenderer.on + removeListener` 闭包。
- **`ipcRenderer` 裸调仅三处历史例外**，新增代码不得效仿：`ipc.ts`（基础层自身）、`preload.ts` 的 `reportReady`（fire-and-forget `send`，无需解包）、`pluggableElectronIpc` facade（第三方库要求 raw Promise）。

## 4. 依赖白名单（已机械化守卫）

`__tests__/preload.test.ts` 的「preload 依赖白名单守卫」用例会扫描 **入口 + `src/main/preload` 下全部 `.ts`**（排除 `__tests__`）的所有 `import`/`export ... from`，逐条判定。允许的 spec 只有四类：

1. `'electron'`
2. preload 目录**内部**的相对路径（`./ipc`、`./api/*`、`./plugin-bridge`、`./origin-guard`）
3. [`../preload-logger.ts`](../preload-logger.ts)（零依赖日志，白名单单点放行）
4. `src/shared/**` 且**必须 `import type`**（运行时值依赖会被打进 preload bundle）

其余一律判失败，包括：任何裸模块名（`zod`、`better-sqlite3`、`lodash`…）、主进程 heavy 模块（`../utils/logger`、`../i18n`、`../database/*`、`../services/*`）。

`../preload-logger.ts` 的存在理由就是这个约束：主进程 `utils/logger.ts` 顶层 `import { app } from 'electron'` 且在模块加载期调 i18n 的 `t()`，preload 一旦引入即耦合 app/i18n 初始化 → 顶层求值抛错 → 白屏。**新增日志需求请扩展 `preloadLogger`，不要引主进程 logger。**

`origin-guard.ts` 刻意保持零依赖（不引 `electron`、不引 shared 运行时值），以满足同一守卫。

## 5. 插件面收窄（安全约束）

`preload.ts` **刻意不使用** `pluggable-electron` 自带的 `initFacade()` / `useFacade()`：原版会把 `install` / `uninstall` / `update` / `toggleActive` 一并挂到 `window.pluggableElectronIpc`，而 `install` 最终执行 npm 包的 `postinstall` 脚本——渲染进程内任意脚本（XSS 注入代码、插件自身代码）一行 `window.pluggableElectronIpc.install(['evil-pkg'])` 就能拿到任意代码执行。

因此：

- `pluggableElectronIpc` **只暴露只读方法** `getActive` / `updatesAvailable`（`plugins.registerActive()` 与更新检查依赖）。对应的 `pluggable:*` 变更路由已在主进程侧摘除。
- 所有变更类管理操作走 `electronAPI.plugin.*`（[`api/plugin.ts`](api/plugin.ts)，`plugin:*` 通道，主进程做可信调用方校验）。
- `pluginAPI`（[`plugin-bridge.ts`](plugin-bridge.ts)）是**插件运行时能力桥**，与 `api/plugin.ts`（插件系统**管理**，用户在设置页操作）分工不同，别混。六个域：`media` / `db`（受限 SELECT）/ `fs`（受 pathGuard 约束）/ `watermark` / `task` / `i18n`。权限校验在主进程 handler 内由 permission-guard 按插件声明执行，preload 侧不做判断。
- **`contextBridge` 暴露的对象会被冻结**，无法后续覆盖方法。需要「先暴露、后注入实现」的能力（当前只有 i18n.t）用**可变内部函数指针**：暴露 `pluginBridgeAPI.i18n.t` 是读 `i18nT` 变量的闭包，渲染进程 `PluginRuntime.bootstrap` 时调 `window.__setPluginI18nT(i18next.t.bind(i18next))` 替换指针。
- `pluggableElectronIpc` 的暴露包在 `try/catch` 里：**暴露失败不得阻塞 preload**，否则渲染进程拿不到 `electronAPI` 直接白屏；失败只意味着插件功能不可用。

## 6. 校验与提交

- 改动本目录后至少跑：`npm run typecheck`、`npx vitest run src/main/preload`。
- 修改**任何**通道名、方法签名、`IpcResponse`/`IpcError` 结构、暴露的全局名或 `electronAPI` 键集合时，**必须**同步更新 [`docs/IPC_CONTRACT.md`](../../../docs/IPC_CONTRACT.md) 与 `preload.test.ts` 的清单断言，并保持向后兼容（新增字段可选、旧字段语义不变；破坏性变更另起通道 + 迁移期双写）。
- preload 侧**无 i18n**：内部诊断日志固定英文（运行在渲染上下文，`i18next` 不可用），用户可见文案一律由主进程 handler 通过 `AppError.userMessage` 提供。

## 7. 常见陷阱

| 陷阱                                                                | 后果                                                                                                                                                                                   | 规避                                                              |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 直接调 `contextBridge.exposeInMainWorld` 而非 `exposeIfTrusted`     | 绕过 origin 门禁，等于向 `file:///evil.html` 开放完整 IPC                                                                                                                              | 全部暴露走 `exposeIfTrusted(key, value)`                          |
| 在 `api/*.ts` 里 `import { z } from 'zod'` 或引主进程模块           | `preload.test.ts` 白名单守卫失败；打包后 sandbox 内解析失败 → 白屏                                                                                                                     | 校验留在主进程 handler；preload 只做透传                          |
| `import { SomeType } from '../../shared/types/...'` 漏写 `type`     | 白名单守卫判「shared 引入必须 type-only」失败                                                                                                                                          | 一律 `import type { ... }`                                        |
| 模块顶层执行有副作用的逻辑（读配置、调 `app.getPath`、初始化 i18n） | 顶层抛错 → `window.electronAPI` 永不暴露 → 无报错白屏                                                                                                                                  | 顶层只放常量与对象字面量；副作用推迟到方法调用期                  |
| 只改了 `origin-guard.ts` 的放行集合                                 | 两层防线口径分叉，第一层放行的 URL 在第二层被拒（或反之）                                                                                                                              | 与 `app/navigation-guard.ts` 的 `isAppDocumentUrl` 同步修改       |
| 用 `process.env.NODE_ENV` 判 dev                                    | sandbox + lib 模式不做静态替换，dist 产物保留字面量 → 生产误判                                                                                                                         | 用编译期常量 `__NIKKI_PRELOAD_DEV__`                              |
| 前端检查 `res.success` 但 handler 未返回该字段                      | `call<T>()` 已剥掉外层 success，`res.success` 恒 `undefined` → 误判失败                                                                                                                | 见 `docs/IPC_CONTRACT.md` §2；或改用 `try/catch` + `IpcError`     |
| 在 `api/*.ts` 里重复声明与主进程同名的 DTO（如 `ScanLogEntry`）     | 多处副本静默漂移（当前 `ScanLogEntry` 在 `api/scanner.ts`、`scanner/scan-log-store.ts`、`renderer/vite-env.d.ts`、`renderer/pages/settings/scan-log-diagnostic-section.tsx` 各有一份） | 新增类型放 `shared/types/electron-api.ts`；改动既有副本时四处同步 |
| 手写 `ipcRenderer.on` + `removeListener` 闭包                       | 与 `subscribe()` 语义分叉，退订易漏                                                                                                                                                    | 一律用 `subscribe()` 并返回其退订函数                             |

## 8. 测试约定

- `__tests__/preload.test.ts` 在 **node 环境**运行，而门禁在模块加载期读 `location.origin`——没有 `location` 全局会被判非授信 → 零暴露。因此必须用 `vi.hoisted` 抢在任何静态 `import '../../preload'` **之前** `Object.defineProperty(globalThis, 'location', { value: { origin: 'app://renderer' } })` 打桩。
- 入口在 import 阶段即完成装配与暴露，暴露记录要在任何 mock 清理**之前**捕获（`const exposedNames = exposeMock.mock.calls.map(...)` 置于文件顶层）。
- 「文档源自检门禁」用例组通过 `vi.resetModules()` + 动态 `import('../../preload')` 重估模块，**必须放在文件末尾**：`resetModules` 后的动态 import 拿到新实例，而上方各用例持有的是首次静态 import 的实例。
- `reportReady` 断言走 `ipcRenderer.send('renderer:ready')`（通道字符串不变）；`pluggableElectronIpc` 断言为 **raw invoke**（不走 `call` 解包）。
