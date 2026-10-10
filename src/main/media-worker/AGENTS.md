# AGENTS.md — `src/main/media-worker`（缩略图/pHash/重复检测 worker 进程）

本文件为 Agent 与新协作者提供 **media-worker 模块级** 速览与约定。顶层项目速览见根目录 [`AGENTS.md`](../../../AGENTS.md)；IPC 白名单与 AppError 两条硬性约定见 [`docs/CODING_CONVENTIONS.md`](../../../docs/CODING_CONVENTIONS.md)（唯一真相源；IDE 的 always-on 规则文件仅为它的本地镜像）；通道契约见 [`docs/IPC_CONTRACT.md`](../../../docs/IPC_CONTRACT.md)；IPC 注册侧见 [`src/main/ipc/handlers/AGENTS.md`](../ipc/handlers/AGENTS.md)；preload 侧见 [`src/main/preload/AGENTS.md`](../preload/AGENTS.md)。本文件只补 **本目录内** 的进程拓扑、通信协议与任务流水线落地方式。

## 模块概述

media-worker 是 **跨两个进程** 的批量任务流水线，承载三类 CPU 密集任务：

```
渲染进程
  │ window.electronAPI.media.* / task.*      （preload: api/media.ts、api/task.ts）
  ▼
主进程                                          ← 薄壳 + 桥接，不含核心算法
  media-handler.ts  ──ctx──▶  MediaWorkerManager (manager.ts)
                                      │  startThumbnailBatch / startPhashBatch / startDuplicateMark / startSimilarFind
                                      ▼
                                MediaWorkerBridge (bridge.ts)
                                      │  utilityProcess.fork('media-worker.js')
                                      │  postMessage(MediaWorkerCommand) ▲ │ ▼ on('message', MediaWorkerEvent)
                                      ▼
worker 进程（独立 utilityProcess）               ← 全部核心逻辑
  worker-entry.ts：缩略图批量生成 + pHash 补算 + Union-Find 重复标记 + BK-tree 相似检测
  独立 new Database(dbPath)，与主进程共享同一 WAL 库文件
```

- [`manager.ts`](manager.ts) 的 `MediaWorkerManager` 是**接口薄壳**（`extends EventEmitter`）：转发指令到 worker、接收事件通知、维护四类任务的 pendingPromise。核心逻辑已全部迁到 `worker-entry.ts`。
- 拆到 `utilityProcess` 的动机：缩略图/pHash/重复检测是长时间 CPU 密集任务，留在主进程会阻塞全部 IPC。
- 对外通过 `EventEmitter` 的事件通知上层，**handler 不直接接触 bridge**。

## 目录结构

| 路径                                       | 进程   | 职责                                                                                                |
| ------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------- |
| [`manager.ts`](manager.ts)                 | 主     | `MediaWorkerManager` 薄壳：转发指令、维护四类任务状态机、注入 `restoreExecutor`                     |
| [`bridge.ts`](bridge.ts)                   | 主     | worker 生命周期（fork / READY 握手 / 崩溃重启 / dispose）、事件分发、任务恢复                       |
| [`worker-protocol.ts`](worker-protocol.ts) | 共享   | **唯一协议定义**：`MediaWorkerCommand` / `MediaWorkerEvent` / `ThumbnailQuality` / `SimilarRowMeta` |
| [`worker-entry.ts`](worker-entry.ts)       | worker | 全部核心逻辑（约 1200 行）：缩略图批量 + pHash + Union-Find 重复标记 + BK-tree 相似检测 + 消息循环  |
| [`bktree-index.ts`](bktree-index.ts)       | worker | BK-tree 建树与半径检索：`buildAndSearch` 收集候选边（a<b，去重）                                    |
| [`bktree-js.ts`](bktree-js.ts)             | worker | 纯 JS BK-tree 实现（基于汉明距离）：源自 bktree-fast 合并，去 lodash 依赖，改 ESM + TypeScript      |
| `*.test.ts`                                | —      | Vitest 单测（`npm run test:main`）                                                                  |

## 1. 进程拓扑与装配

装配点在 [`src/main/app/application.ts`](../app/application.ts)：

```ts
this.mediaWorkerBridge = new MediaWorkerBridge()
this.mediaWorkerManager = new MediaWorkerManager(this.mediaWorkerBridge) // bridge 先建，注入 Manager
```

两者都进 `HandlerContext`（`mediaWorkerManager` / `mediaWorkerBridge`），其余模块**只经 ctx 访问**：

| 调用方                                                                             | 用法                                                                                                                            |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [`../app/lifecycle.ts`](../app/lifecycle.ts)                                       | 长任务注册时传 `cancel: () => void ctx.mediaWorkerManager.stopXxxBatch()`                                                       |
| [`../app/ipc-setup.ts`](../app/ipc-setup.ts)                                       | `ctx.mediaWorkerManager.on('thumbnailProgress', ...)`——监听器注册前先 `removeListener` 同一引用，保证可精确摘除                 |
| [`../app/cleanup.ts`](../app/cleanup.ts)                                           | 退出顺序：先 `mediaWorkerManager.stopAllBatches()`，再 `mediaWorkerBridge.dispose()`（带超时兜底）                              |
| [`../ipc/handlers/media-handler.ts`](../ipc/handlers/media-handler.ts)             | 注册 `media:*` 通道；只监听事件广播                                                                                             |
| [`../services/thumbnail-phash-service.ts`](../services/thumbnail-phash-service.ts) | 薄壳服务：`generateThumbnailsForUnprocessed` / `generatePhashForUnprocessed` / `markDuplicates` 转发到 `ctx.mediaWorkerManager` |

**构建产物约束**：`worker-entry.ts` 在 [`electron.vite.config.ts`](../../../electron.vite.config.ts) 的 `main.build.lib.entry` 中是**独立入口** `'media-worker'`，输出 `dist/main/main/app/media-worker.js`。bridge 以 `path.join(__dirname, 'media-worker.js')` fork。**改入口名或产物布局会直接导致 fork 失败**——6 个 worker 入口（scanner / media / thumbnail / video / database / decryption）都靠区分性文件名 fork。

**DB 连接**：worker 内部 `new Database(dbPath)`（惰性 `require('better-sqlite3')` + `resolveAsarUnpackedPath` 修正 asar 解包路径），**不持有 `DatabaseManager`**。PRAGMA 与主进程一致（WAL / foreign_keys / synchronous=NORMAL / cache_size=-20000 / temp_store=MEMORY / mmap_size / wal_autocheckpoint=1000），额外加 worker 独有的 `busy_timeout = 5000`。

## 2. worker 通信协议

协议只在 [`worker-protocol.ts`](worker-protocol.ts) 定义一份，两端都 import 它。**新增消息类型必须同时改协议、bridge 分发、worker 消息循环三处。**

**主进程 → worker（`MediaWorkerCommand`）**

| type                                                                | payload                                  | 语义                                                                   |
| ------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------- |
| `THUMBNAIL_BATCH_START`                                             | `{ dbPath, cacheDir, thumbnailQuality }` | 启动缩略图批量生成；worker 完成后回 `THUMBNAIL_COMPLETE`               |
| `PHASH_BATCH_START`                                                 | `{ dbPath }`                             | 启动 pHash 批量补算；完成后自动链式 `markDuplicates`                   |
| `DUPLICATE_MARK_START`                                              | `{ dbPath }`                             | 启动 O(n²) Union-Find 重复标记                                         |
| `SIMILAR_FIND_START`                                                | `{ dbPath, threshold }`                  | 启动 BK-tree 相似检测                                                  |
| `THUMBNAIL_STOP` / `PHASH_STOP` / `DUPLICATE_STOP` / `SIMILAR_STOP` | —                                        | 各自独立取消，互不影响                                                 |
| `MEDIA_WORKER_BATCH_YIELD`                                          | `{ active: boolean }`                    | N2 批量让位：主进程有可视区按需生成在途时，worker 在条目启动前插入延迟 |
| `MEDIA_WORKER_DISPOSE`                                              | —                                        | 关 DB + kill 子进程 + 回发 `MEDIA_WORKER_DISPOSED` + `process.exit(0)` |

**worker → 主进程（`MediaWorkerEvent`）**

| type                                                                                | payload                            | bridge 处理                                                             |
| ----------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| `WORKER_READY`                                                                      | —                                  | resolve READY 握手（15s 超时即判启动失败）                              |
| `THUMBNAIL_PROGRESS` / `PHASH_PROGRESS` / `DUPLICATE_PROGRESS` / `SIMILAR_PROGRESS` | 各自进度结构                       | 补 `taskId` 后分发给 handler，并节流推 `task:progress`                  |
| `THUMBNAIL_COMPLETE` / `PHASH_COMPLETE` / `DUPLICATE_COMPLETE` / `SIMILAR_COMPLETE` | 各自结果结构                       | 分发、推终态、注销 taskId                                               |
| `SIMILAR_CANDIDATES`                                                                | `{ batch: Array<{ a, b, dist }> }` | 累积候选边（`pendingSimilarCandidates`），`SIMILAR_COMPLETE` 时一并回传 |
| `SIMILAR_ERROR`                                                                     | `{ message, stack? }`              | 主进程据此合成失败终态                                                  |
| `MEDIA_WORKER_LOG`                                                                  | `{ level, message, args? }`        | 转发主进程 `logger`；`info` 级在 worker 内丢弃，`warn`/`error` 才转发   |
| `WORKER_ERROR`                                                                      | `{ message, stack? }`              | 仅记 error 日志                                                         |
| `MEDIA_WORKER_DISPOSED`                                                             | —                                  | resolve `dispose` 的等待                                                |

**worker 侧收发形态**（`worker-entry.ts` 末尾）：

```ts
process.parentPort?.on('message', async (event: { data: unknown }) => {
  const msg = event.data as MediaWorkerCommand
  if (msg.type === 'THUMBNAIL_BATCH_START') {
    /* ... sendEvent({ type: 'THUMBNAIL_COMPLETE', payload: result }) */
  } else if (msg.type === 'THUMBNAIL_STOP') shouldStopThumbnail = true
  else if (msg.type === 'MEDIA_WORKER_DISPOSE') cleanupAndExit(true)
})
```

**四类任务各自独立**：`shouldStopThumbnail` / `shouldStopPhash` / `shouldStopDuplicate` / `shouldStopSimilar` 互不影响，取消/恢复/崩溃互不干扰。

## 3. 任务流水线（`worker-entry.ts`）

### 3.1 缩略图批量生成（`THUMBNAIL_BATCH_START`）

按序执行：

1. **打开 DB** `openDatabaseIfNeeded(dbPath)`
2. **查询缺缩略图记录** `SELECT id, file_path, file_type FROM media_files WHERE thumbnail IS NULL AND ...`（排除 GamePlayPhotos 路径）
3. **逐文件处理** `processThumbnailForRow(row)`：
   - 图片：`sharp(filePath).resize(...).toFile(cacheDir/<contentHash>.jpg)` + 同步生成 `_low`
   - 视频：`ffmpeg(filePath).screenshots(...)` 抽帧 + `sharp` 缩放（纯色帧自愈：0s/1s/3s 阶梯取帧）
   - 同时补算 `phash`（若为空）
4. **批量更新 DB** `UPDATE media_files SET thumbnail=?, width=?, height=?, phash=? WHERE id=?`
5. **发终态** `THUMBNAIL_COMPLETE`

关键常量（**禁止随意改值**）：`THUMBNAIL_CONCURRENCY`（来自 `../utils/constants`）、`STANDARD_MAX_WIDTH/HEIGHT = 320`、`LOW_MAX_WIDTH/HEIGHT = 64`、`HIGH_MAX_WIDTH/HEIGHT = 512`。

### 3.2 pHash 批量补算（`PHASH_BATCH_START`）

1. **查询缺 phash 记录** `SELECT id, file_path, thumbnail FROM media_files WHERE phash IS NULL AND thumbnail IS NOT NULL`
2. **逐文件计算** `calculatePHash(thumbnailPath)`（DCT-II + 二值化）
3. **批量更新 DB** `UPDATE media_files SET phash=? WHERE id=?`
4. **自动链式触发** `markDuplicates(db)`（保持原有行为）
5. **发终态** `PHASH_COMPLETE`（含 `duplicatesResult`）

### 3.3 重复标记（`DUPLICATE_MARK_START`）

1. **查询有 phash 记录** `SELECT id, phash FROM media_files WHERE phash IS NOT NULL`
2. **O(n²) 双重循环**：两两计算汉明距离，`hammingDistance(a, b) <= MARK_THRESHOLD`（默认 2）则归为重复组
3. **Union-Find 聚类**：把重复对合并为连通分量，选出 `original_id`（评分最高或 id 最小）
4. **批量更新 DB** `UPDATE media_files SET is_duplicate=1, original_id=? WHERE id=?`
5. **发终态** `DUPLICATE_COMPLETE`

### 3.4 相似检测（`SIMILAR_FIND_START`）

1. **查询有 phash 记录**（同 3.3）
2. **建 BK-tree** `buildAndSearch({ rows, threshold, shouldStop, onCandidates, onProgress })`：
   - 把 pHash 转 hex（64 位 → 16 字符）
   - 对每条记录做半径检索（`search(tree, hash, threshold)`），收集候选边（`a < b`，去重）
   - 候选边通过 `onCandidates` 分批回传（`SIMILAR_CANDIDATES`）
3. **主进程累积候选边**（`pendingSimilarCandidates`），`SIMILAR_COMPLETE` 时一并回传
4. **发终态** `SIMILAR_COMPLETE`（含 `rows` 元数据 + `totalCandidates`）

**BK-tree 选型**：纯 JS 实现（`bktree-js.ts`），源自 bktree-fast 合并，去 lodash 依赖。选型理由见 [`bktree-js.ts`](bktree-js.ts) 头注释。

## 4. 生命周期与容错（bridge 侧）

| 机制         | 参数                                                       | 说明                                                                                                     |
| ------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 惰性 fork    | —                                                          | 首次任务才 `ensureWorker()`；worker 已存在则复用                                                         |
| READY 握手   | `READY_TIMEOUT_MS = 15_000`                                | 超时 → `failReadyHandshake` + `kill` + `notifyCrash(stage:'startup-timeout')`                            |
| 崩溃自动重启 | `WorkerRestartPolicy`：10 分钟窗口内最多 3 次，延迟 2000ms | 重启后若有 `lastXxxTask` 则恢复任务；耗尽则只 `notifyCrash`                                              |
| dispose 确认 | `DISPOSE_CONFIRM_TIMEOUT_MS = 2000`                        | 先 `*_STOP` 再 `MEDIA_WORKER_DISPOSE`，等 `MEDIA_WORKER_DISPOSED` 确认 DB 句柄已释放，超时走 `kill` 兜底 |

**`failReadyHandshake` 必须 reject，绝不只置 null**：所有提前终止路径（worker 退出 / 握手超时 / dispose）都要走它，否则 `ensureWorker` 里的 `await this.readyPromise` 永久挂起。

**四个互斥标志**（都是为避免「主动 kill 触发的 exit 被误判为崩溃」而存在）：

- `isDisposed`：`dispose()` 后不再重启（致命，不可复用）
- `terminatingForRestore`：`stopWorkerForRestore` 期间的退出不算崩溃，不触发自动重启
- `batchYieldActive`：N2 批量让位状态记忆，worker 崩溃重启后补发

**恢复任务走 Manager 而非直连 bridge**：`MediaWorkerManager` 构造时 `bridge.setRestoreExecutor(...)`，恢复路径复用 Manager 的 `isXxxRunning` 互斥与 `registerTask` 注册（恢复的任务对 `task:cancel` 可取消、有 `task:progress` 进度，对用户可见）。

## 5. 进度、取消与快照

**两类节流**：

- `ProgressThrottle(200)`：`task:progress` 节流至 4~6 FPS；**终态（`done` / `cancelled` / `error`）绕过节流立即推送**。
- `EtaCalculator(10)`：滑动窗口平均吞吐量 → `etaMs` / `perSec`。

**缩略图批量渲染层广播**（THUMBNAIL_OPTIMIZATION_PLAN 节点1）：

- `THUMBNAIL_BROADCAST_THROTTLE_MS = 2000`：批量进行中周期性通知渲染层刷新（`media:updated`），使新落盘缩略图逐步可见，不再等整批完成才有一次广播。
- 由 `Application` 注入 `setThumbnailProgressNotifier(() => sendToRenderer(ctx, 'media:updated'))`。

**四类任务各自的 `TaskRuntime`**：

- `taskId` / `startedAt` / `cancelRequested` / `progressThrottle` / `etaCalculator`
- `taskRegistry.register(taskId)` 返回 `AbortController`；`taskId` 形如 `thumbnail-<Date.now()>-<rand6>` / `phash-*` / `duplicate-*` / `similar-*`
- `abort` 监听器：置 `cancelRequested = true` → 立即推 `cancelled` 终态 → 转发 `*_STOP`

**终态清理清单**（每类任务都必须成套执行）：`taskRegistry.unregister` + `isXxxRunning = false` + `cancelRequested = false` + `progressThrottle.dispose()` + `etaCalculator.reset()`。漏一项就会残留注册项或陈旧进度。

## 6. 模块边界铁律

`worker-entry.ts` 有**模块顶层副作用**：`process.on('uncaughtException' / 'unhandledRejection')`、末尾 `sendEvent({ type: 'WORKER_READY' })`。已用 `if (process.parentPort)` 守卫（`sendEvent` 内部是 `parentPort?.postMessage`，无 parentPort 时静默丢弃），但**任何主进程模块 import `worker-entry.ts` 仍是致命错误**：

> 主进程无 `parentPort` → worker 启动逻辑在主进程执行 → 发送 `WORKER_READY` 失败 → bridge 握手超时 → 任务永不启动。

因此本模块有一条硬约束：**任何可能被主进程引用的文件，禁止 import `worker-entry.ts`（含 `import type` 之外的任何形式）**。

**跨进程共享文件**（改动时须同时考虑两个进程的兼容性）：`worker-protocol.ts`、`bktree-index.ts`（仅 worker 侧使用，但类型定义影响协议）。

**纯函数优先**：BK-tree 建树/检索、Union-Find 聚类、汉明距离计算一律抽为无副作用纯函数（不依赖 electron / sharp / ffmpeg），以便 characterization test 覆盖。

## 7. 数据库并发约束

worker 与主进程 `DatabaseManager` / `database-worker` **共享同一 WAL 库文件、各持独立连接并发写入**：

- 单次 better-sqlite3 事务已由 `busy_timeout = 5000` 内部重试 5 秒；持续冲突仍会抛 `SQLITE_BUSY`。
- worker 内部在批量写入前做 `BEGIN TRANSACTION` / `COMMIT`，减少锁冲突次数。
- **只对 `SQLITE_BUSY` / `SQLITE_LOCKED` 重试**；约束违反、磁盘满等非锁错误必须**立即 rethrow**。
- `isSqliteBusy` 自包含实现，**不 import `../database/connection.ts`**——worker 是独立 utilityProcess，应轻量自洽。

## 8. i18n 约束

| 侧                                  | import                                    | 原因                                                      |
| ----------------------------------- | ----------------------------------------- | --------------------------------------------------------- |
| 主进程（`manager.ts`、`bridge.ts`） | `import { t } from '../i18n'`             | 跟随用户语言切换                                          |
| worker（`worker-entry.ts`）         | `import { t } from '../i18n/worker-safe'` | `@main/i18n` 依赖 electron `app`，utilityProcess 内不可用 |

[`../i18n/worker-safe.ts`](../i18n/worker-safe.ts) 是固定 zh-CN 的同步查表实现。**worker 侧禁止 import `../i18n`。**

## 9. 常见陷阱

| 陷阱                                                                              | 后果                                                                            | 规避                                                                                  |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 主进程模块 import `worker-entry.ts`                                               | worker 启动逻辑在主进程执行 → bridge 握手超时 → 任务永不启动                    | 共享能力抽到 `worker-protocol.ts`                                                     |
| 新增 `MediaWorkerEvent` 只改协议不改 bridge 分发                                  | 事件被 `handleWorkerMessage` 的 switch 静默丢弃                                 | 协议 + bridge 分发 + worker 发送三处同步；必要时在 switch 补 `default` 记日志         |
| 某条 `*_START` 退出路径未发 `*_COMPLETE`                                          | `pendingXxxComplete` 永不 resolve，IPC 与 UI 一起卡死                           | 终态必成对；崩溃路径靠 bridge 合成 + worker `uncaughtException` 补发双保险            |
| 提前终止路径只把 `readyReject` 置 null                                            | `await this.readyPromise` 永久挂起                                              | 一律走 `failReadyHandshake(reason)`                                                   |
| 主动 `kill()` 后未置互斥标志                                                      | `exit` 事件被当崩溃 → 二次 fault / 二次崩溃弹窗 / 计划外自动重启                | 沿用 `isDisposed` / `terminatingForRestore` 模式                                      |
| 终态清理漏项（`taskRegistry` / `progressThrottle` / `isXxxRunning`）              | 注册项泄漏、`task:getActive` 返回陈旧进度、UI 卡在 processing                   | 复制 §5 的成套清理清单                                                                |
| 恢复任务直连 bridge 而非走 Manager                                                | 绕过 `isXxxRunning` 互斥 → 与用户手动启动并发 → 共享 `shouldStop*` 标志互相干扰 | 恢复路径走 `bridge.setRestoreExecutor(async (tasks) => { await this.startXxx(...) })` |
| 在 worker 侧 import `../i18n`                                                     | utilityProcess 内 electron `app` 不可用 → worker 启动即崩                       | 用 `../i18n/worker-safe`                                                              |
| 改 `STANDARD_MAX_WIDTH` / `LOW_MAX_WIDTH` 等常量而不改主进程 `ThumbnailGenerator` | 缩略图文件名/质量不一致 → 缓存命中失败、重复生成                                | worker 与主进程常量必须同步修改（或统一抽到共享模块）                                 |
| BK-tree 建树时未去重（同一 pHash 多张图）                                         | 候选边重复计数 → 前端分组错误                                                   | `hashToIds` 映射回行索引数组，建树时对相同 hash 去重                                  |

## 10. 测试约定

- 单测与源码同目录命名 `*.test.ts`；跑法 `npm run test:main` 或 `npx vitest run src/main/media-worker`。
- **纯函数直接测**：`bktree-js.test.ts`、`bktree-index.test.ts`、`worker-protocol.test.ts` 都是无 electron / 无原生模块的快测。
- **测 worker-entry 需要两件套**：
  1. `process.parentPort` 桩——用共享工具 [`tests/mocks/parent-port.ts`](../../../tests/mocks/parent-port.ts) 的 `installParentPortStub()` / `uninstallParentPortStub()`。**必须在 import `worker-entry` 之前安装**（消息处理器在模块加载期注册），随后用 `port.emitMessage({ type: 'THUMBNAIL_BATCH_START', payload })` 触发、`port.messages` 断言发出的事件。
  2. `better-sqlite3` 替换——`vi.mock` 对 native 模块无效（vite-node 的 import 绕过它，且该模块是 Electron ABI，Node 下加载即崩）。现有用例改用 `Module._load` 拦截返回可控 fake db 工厂。
- **bridge 测试用 fake timers** 推进握手/重启/dispose 的等待（`bridge.test.ts`）；`scanner/scanner-worker-bridge.test.ts` 与 `thumbnail/worker-bridge.test.ts` 沿用同一模式，改一处请对照另两处。
- `manager.test.ts` 测 Manager 层状态机（互斥/恢复/事件分发），mock bridge 与 taskRegistry。
