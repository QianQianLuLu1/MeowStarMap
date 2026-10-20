# AGENTS.md — `src/main/scanner`（扫描流水线与 worker 进程）

本文件为 Agent 与新协作者提供 **scanner 模块级** 速览与约定。顶层项目速览见根目录 [`AGENTS.md`](../../../AGENTS.md)；IPC 白名单与 AppError 两条硬性约定见 [`docs/CODING_CONVENTIONS.md`](../../../docs/CODING_CONVENTIONS.md)（唯一真相源；IDE 的 always-on 规则文件仅为它的本地镜像）；通道契约见 [`docs/IPC_CONTRACT.md`](../../../docs/IPC_CONTRACT.md)；IPC 注册侧见 [`src/main/ipc/handlers/AGENTS.md`](../ipc/handlers/AGENTS.md)；preload 侧见 [`src/main/preload/AGENTS.md`](../preload/AGENTS.md)。本文件只补 **本目录内** 的进程拓扑、通信协议与流水线落地方式。

## 模块概述

扫描是 **跨两个进程** 的流水线，这是本模块一切约定的根源：

```
渲染进程
  │ window.electronAPI.scanner.* / task.*      （preload: api/scanner.ts、api/task.ts）
  ▼
主进程                                          ← 薄壳 + 桥接，不含扫描算法
  scanner-handler.ts  ──ctx──▶  ScannerManager (index.ts)
                                      │  startScan / stopScan / getStatus / scanRoot
                                      ▼
                                ScannerWorkerBridge (scanner-worker-bridge.ts)
                                      │  utilityProcess.fork('scanner-worker.js')
                                      │  postMessage(WorkerCommand) ▲ │ ▼ on('message', WorkerEvent)
                                      ▼
worker 进程（独立 utilityProcess）               ← 全部扫描核心逻辑
  worker-entry.ts：目录发现 → 通道编排 → 递归遍历 → 分类 → 批量写库 → 完整性校验
  独立 new Database(dbPath)，与主进程共享同一 WAL 库文件
```

- [`index.ts`](index.ts) 的 `ScannerManager` 是**接口薄壳**（`extends EventEmitter`）：`startScan` / `stopScan` / `getStatus` / `scanRoot` / `setDbPath` 的签名与拆分到 worker 之前**完全一致**，上层（`app/*` 与 `ipc/handlers/*`）的调用方式不变。核心逻辑（`findMediaDirectories` / `scanDirectory` / `saveBatchToDatabase` / `checkMissingFiles` / `repairLegacyData*`）已全部迁到 `worker-entry.ts`。（注：`index.ts` 头注释提到的 `misc.ts` 已不存在，属陈旧注释。）
- 拆到 `utilityProcess` 的动机：扫描是长时间 CPU + 磁盘密集任务，留在主进程会阻塞全部 IPC。
- 对外仍通过 `EventEmitter` 的 `'progress'` / `'complete'` / `'restoredComplete'` 事件通知，**handler 不直接接触 bridge**。

## 目录结构

| 路径                                                               | 进程            | 职责                                                                                                                                           |
| ------------------------------------------------------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [`index.ts`](index.ts)                                             | 主              | `ScannerManager` 薄壳：转发指令、维护 `currentStatus`、`pendingComplete` 状态机、注入 `restoreExecutor`                                        |
| [`scanner-worker-bridge.ts`](scanner-worker-bridge.ts)             | 主              | worker 生命周期（fork / READY 握手 / 心跳 / 崩溃重启 / dispose）、事件分发、进度节流与 ETA、TaskRegistry 注册                                  |
| [`worker-protocol.ts`](worker-protocol.ts)                         | 共享            | **唯一协议定义**：`WorkerCommand` / `WorkerEvent` / `ScanOptions` / `ScanProgress` / `MediaFile`                                               |
| [`worker-entry.ts`](worker-entry.ts)                               | worker          | 扫描全部核心逻辑（约 1650 行）+ 消息循环 + 心跳看门狗 + 进程级兜底                                                                             |
| [`scan-channels.ts`](scan-channels.ts)                             | worker          | 双通道编排：官方相册（GamePlayPhotos）+ 次级（ScreenShot / Video）                                                                             |
| [`gameplayphotos-root.ts`](gameplayphotos-root.ts)                 | worker          | GamePlayPhotos 根解析与指纹判定（含无 `Saved` 的兼容变体）                                                                                     |
| [`game-directory-discovery.ts`](game-directory-discovery.ts)       | **主 + worker** | 三渠道游戏根定位（官方启动器 > Steam > Epic）、`detectGameRootCandidates`、探测轨迹                                                            |
| [`uid-discovery.ts`](uid-discovery.ts)                             | worker          | 从 GamePlayPhotos 一级纯数字子目录发现真实 UID 集合                                                                                            |
| [`path-classifier.ts`](path-classifier.ts)                         | **主 + worker** | 纯函数分类：`extractUidFromPath` / `extractAlbumTypeFromPath` / `extractMediaSourceFromPath` / `gateAccountUid` / `resolveNativeThumbnailPath` |
| [`integrity-root-filter.ts`](integrity-root-filter.ts)             | worker          | 完整性校验的差量根过滤（SQL LIKE 归一化表达式）                                                                                                |
| [`rescan-restore-sql.ts`](rescan-restore-sql.ts)                   | worker + 单测   | 重扫复位软删除的 SQL 谓词唯一真源（游戏树 ∧ `delete_origin` 非 `'user'`），纯字符串常量                                                        |
| [`sqlite-retry.ts`](sqlite-retry.ts)                               | worker          | `executeWriteSafely`（SQLITE_BUSY 指数退避）+ `walCheckpoint`                                                                                  |
| [`repair-legacy-data-v1/v3/v4/v5/v6.ts`](repair-legacy-data-v1.ts) | worker          | 存量数据修复步骤（V2 仍在 `worker-entry.ts` 内）                                                                                               |
| [`scan-abort.ts`](scan-abort.ts)                                   | **主 + worker** | 中止标志（零依赖纯状态）：`abortScan` / `isScanAborted` / `resetScanAbort`                                                                     |
| [`scan-logger.ts`](scan-logger.ts)                                 | worker          | `sendScanLogEntry` / `sendScanLogInfo`：经 `parentPort` 发 `SCAN_LOG`（零依赖）                                                                |
| [`scan-log-store.ts`](scan-log-store.ts)                           | **主 + worker** | 诊断日志环形仓库（2000 条）+ 可选 JSONL 落盘 + `classifyFsError` + `ScanErrorCode`（**不 import electron**）                                   |
| `__tests__/` 与同目录 `*.test.ts`                                  | —               | Vitest 单测（`npm run test:main`）                                                                                                             |

## 1. 进程拓扑与装配

装配点在 [`src/main/app/application.ts`](../app/application.ts)：

```ts
this.scannerWorkerBridge = new ScannerWorkerBridge()
this.scannerManager = new ScannerManager(this.scannerWorkerBridge) // bridge 先建，注入 Manager
```

两者都进 `HandlerContext`（`scannerManager` / `scannerWorkerBridge`），其余模块**只经 ctx 访问**：

| 调用方                                                                     | 用法                                                                                                                                                                                                      |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`../app/lifecycle.ts`](../app/lifecycle.ts)                               | `ctx.scannerManager.setDbPath(...)`（在 `dbManager.initialize` 之后）；`ctx.dbManager.setScannerWorkerBridge(ctx.scannerWorkerBridge)`；长任务注册时传 `cancel: () => void ctx.scannerManager.stopScan()` |
| [`../app/startup-tasks.ts`](../app/startup-tasks.ts)                       | 首装/启动扫描：`ctx.scannerManager.startScan({...})`                                                                                                                                                      |
| [`../app/ipc-setup.ts`](../app/ipc-setup.ts)                               | `ctx.scannerManager.on('progress', onScanProgress)`——监听器存在模块级 `WeakMap<ctx, fn>` 里，注册前先 `removeListener` 同一引用，保证可精确摘除                                                           |
| [`../app/cleanup.ts`](../app/cleanup.ts)                                   | 退出顺序：先 `scannerManager.stopScan().catch(() => {})`，再 `scannerWorkerBridge.dispose()`（带超时兜底）                                                                                                |
| [`../app/recovery.ts`](../app/recovery.ts)                                 | 数据库自恢复流程持有 bridge                                                                                                                                                                               |
| [`../database/connection.ts`](../database/connection.ts)                   | 还原库文件前 `await scannerWorkerBridge?.stopWorkerForRestore()` 释放 dbPath 句柄                                                                                                                         |
| [`../ipc/handlers/scanner-handler.ts`](../ipc/handlers/scanner-handler.ts) | 注册 `scanner:*` / `scan:*` 通道；只监听 `'restoredComplete'` 补广播（`'progress'` 在 `ipc-setup.ts`）                                                                                                    |
| [`../ipc/handlers/import-handler.ts`](../ipc/handlers/import-handler.ts)   | 导入向导单目录入库：`ctx.scannerManager.scanRoot(targetBaseDir)`                                                                                                                                          |

**构建产物约束**：`worker-entry.ts` 在 [`electron.vite.config.ts`](../../../electron.vite.config.ts) 的 `main.build.lib.entry` 中是**独立入口** `'scanner-worker'`，输出 `dist/main/main/app/scanner-worker.js`，与 `index.js` 同目录。bridge 以 `path.join(__dirname, 'scanner-worker.js')` fork。**改入口名或产物布局会直接导致 fork 失败**——6 个 worker 入口（scanner / media / thumbnail / video / database / decryption）都靠区分性文件名 fork，若共用一个 entry 会全部指向同一个不存在的 `worker-entry.js`。

**DB 连接**：worker 内部 `new Database(dbPath)`（惰性 `require('better-sqlite3')` + `resolveAsarUnpackedPath` 修正 asar 解包路径），**不持有 `DatabaseManager`**。PRAGMA 与主进程一致（WAL / foreign_keys / synchronous=NORMAL / cache_size=-20000 / temp_store=MEMORY / mmap_size / wal_autocheckpoint=1000），额外加 worker 独有的 `busy_timeout = 5000`。需要 `dbManager` 能力的地方（如 `repairLegacyData` 判断迁移标记）改为**直接查 `schema_migrations` 表**。

## 2. worker 通信协议

协议只在 [`worker-protocol.ts`](worker-protocol.ts) 定义一份，两端都 import 它。**新增消息类型必须同时改协议、bridge 分发、worker 消息循环三处。**

**主进程 → worker（`WorkerCommand`）**

| type           | payload                            | 语义                                                                  |
| -------------- | ---------------------------------- | --------------------------------------------------------------------- |
| `SCAN_START`   | `{ dbPath, options: ScanOptions }` | 启动扫描；worker 完成后回 `SCAN_COMPLETE`                             |
| `SCAN_STOP`    | —                                  | 置中止标志（`abortScan()`），**不立即退出**，循环在下一个检查点 break |
| `SCAN_DISPOSE` | —                                  | 关 DB + kill 子进程 + 回发 `WORKER_DISPOSED` + `process.exit(0)`      |
| `WORKER_PING`  | —                                  | 主进程心跳，worker 刷新 `lastPingTime`                                |

**worker → 主进程（`WorkerEvent`）**

| type              | payload                                                    | bridge 处理                                                                                     |
| ----------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `WORKER_READY`    | —                                                          | resolve READY 握手（15s 超时即判启动失败）；清除 `startupTimedOut`                              |
| `SCAN_PROGRESS`   | `ScanProgress`                                             | 补 `total` / `etaMs` / `perSec` / `taskId` 后分发给 handler，并节流推 `task:progress`           |
| `SCAN_COMPLETE`   | `{ success, message, filesFound?, gatedVirtualUidCount? }` | 清 `lastScanOptions`、分发、推终态、注销 taskId                                                 |
| `SCAN_LOG`        | `{ level, message, args?, stage?, kind?, detail?, code? }` | 转发主进程 `logger` + 落 `scanLogStore`；`kind === 'permission'` 时触发 `promptAdminRelaunch()` |
| `WORKER_ERROR`    | `{ message, stack? }`                                      | 仅记 error 日志                                                                                 |
| `WORKER_DISPOSED` | —                                                          | resolve `stopWorkerForRestore` 的等待                                                           |

`ScanProgress` 的 `total` / `perSec` / `etaMs` / `taskId` / `integrity*` 都是**可选字段**，由 bridge 补充而非 worker 发出——旧监听者忽略即可，这是向后兼容的既定做法，新增字段请沿用「可选 + 补充」而非改必填。

**worker 侧收发形态**（`worker-entry.ts` 末尾）：

```ts
// utilityProcess 的 'message' 事件参数是 Node 的 MessageEvent（仅 data 字段），
// 与 lib.dom.d.ts 的 MessageEvent 冲突，故用最小结构类型避开
process.parentPort?.on('message', async (event: { data: unknown }) => {
  const msg = event.data as WorkerCommand
  if (msg.type === 'SCAN_START') {
    /* ... sendEvent({ type: 'SCAN_COMPLETE', payload: result }) */
  } else if (msg.type === 'SCAN_STOP') abortScan()
  else if (msg.type === 'SCAN_DISPOSE') cleanupAndExit(true)
  else if (msg.type === 'WORKER_PING') lastPingTime = Date.now()
})
```

**`SCAN_COMPLETE` 必须成对出现**：`SCAN_START` 的每条退出路径（正常完成 / 校验失败 / 抛异常 / 进程崩溃）都要让主进程收到一次终态，否则 `ScannerManager.pendingComplete` 永不 resolve，`scanner:start` 的 IPC 与前端 UI 一起卡死。因此：worker 的 `uncaughtException` / `unhandledRejection` 在 `progress.status === 'running'` 时**先补发**携带真实错误的 `SCAN_COMPLETE` 再发 `WORKER_ERROR`；bridge 侧 `handleWorkerExit` 在 `isScanning` 为真时**合成**一个失败的 `SCAN_COMPLETE`。

## 3. 扫描流水线（`worker-entry.startScan`）

按序执行，任何一步失败都走 `makeScanCompleteResult(false, ...)`：

1. **归零诊断计数** `gatedVirtualUidCount = 0`（必须在最早返回路径之前，否则带入上次残留）
2. **打开 DB** `openDatabaseIfNeeded(dbPath)`——失败即返回
3. **重置状态** `resetScanAbort()` + `progress = { ..., status: 'running' }` + `realpathCache.clear()`
4. **发初始进度事件**——`findMediaDirectories` 在慢机器上可达数十秒，期间无 `SCAN_PROGRESS` 会导致渲染端浮窗不出现、`task:getActive` 快照为 `null`
5. **写扫描历史** `insertScanHistory(scanType)`（`full_scan` / `incremental` / `full`）
6. **修复存量数据 V1→V6**——**前置失败即中止后续**：V1 失败时数据仍是未清理的脏状态，继续跑 V2~V6 会留下半迁移状态。各步内部自带事务与幂等迁移标记，被跳过的步骤下次扫描重跑
7. **定位游戏根** `findMediaDirectories(customPaths, excludedPaths)`：`customSet`（用户自定义，存在即加入，**恒包含于结果**）+ `registrySet`（仅三渠道，命中即止）。**不做全盘签名搜索、不做 `infinitynikki` 软过滤**——这两条是历史缺陷来源，见该函数头注释
8. **编排双通道** `resolveScanChannels(gameDirs, channelLogger)` → `{ officialAlbum, secondary, missing }`
   - 官方相册通道：GamePlayPhotos 子树，**强制遍历豁免**（`isGamePlayPhotosScanExempt`：跳过缓存目录与小图过滤均不生效）、复用游戏原生 LQ 缩略图、不触发生成任务
   - 次级通道：`X6Game\ScreenShot` / `X6Game\Saved\ScreenShot` / `X6Game\Video`，保留缓存目录跳过与小图过滤，缩略图照常生成
   - 两通道为空 → 返回 `null`，上层走 `noMediaDirFound` 失败分支
9. **UID 闸门** `discoverUidsFromGameDirs(officialAlbum, workerLog)` → 逐个 `autoRegisterUid(uid)`；发现非空时构造 `Set` 作为 `uidGate` 传入 `scanDirectory`，**为空时显式传 `null` 而非空 Set**（让 gate 走「无闸门」分支）。作用：把路径中的时间戳/活动 ID 等虚拟数字段拦在 `character_profiles` 之外，归 `'default'`
10. **逐目录扫描** `scanDirectory(dir, incremental, applyFilters, uidGate)`——每个目录前检查 `isScanAborted()`；单目录导入（`options.path`）走 `applyFilters = false`，避免用户文件被误跳过
11. **完整性校验**（仅 `incremental`）`checkMissingFiles(roots)`——分页 2000 条、并发 8，按本次覆盖的根做差量过滤，避免全库磁盘访问
12. **收尾** `updateScanHistory(...)` → `finalizeScanCheckpoint()`（WAL `TRUNCATE`）→ `makeScanCompleteResult(true, ...)`

关键常量（**禁止随意改值**，改动需给出实测依据）：`MAX_SCAN_DEPTH = 15`（原 10 不足以覆盖 `X6Game\Plugins\PaperSDK\...` 的 12+ 层）、`SCAN_BATCH_SIZE = 500`、`TRAVERSE_SLOW_MS = 3000`、`INTEGRITY_PAGE_SIZE = 2000`、`INTEGRITY_CONCURRENCY = 8`。

`readdirWithSlowTraverseWarning` 的取舍是**只告警不中断**：安全软件实时扫描、机械盘冷启动、网络盘首访都可能超 3 秒，据此中断会直接丢失用户照片，代价远大于误报。

## 4. 生命周期与容错（bridge 侧）

| 机制          | 参数                                                       | 说明                                                                                                                                     |
| ------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 惰性 fork     | —                                                          | 首次 `startScan` 才 `ensureWorker()`；worker 已存在则复用                                                                                |
| READY 握手    | `READY_TIMEOUT_MS = 15_000`                                | 超时 → `failReadyHandshake` + `kill` + `notifyCrash(stage:'startup-timeout')`，并置 `startupTimedOut` 抑制随后 `exit` 事件的二次崩溃处理 |
| 主进程心跳    | 每 5s 发 `WORKER_PING`，`unref()`                          | `startHeartbeat()` 重入时先清旧定时器                                                                                                    |
| worker 看门狗 | 检查 5s / 超时 `HEARTBEAT_TIMEOUT_MS = 15_000`             | 3 次未收到 ping 即判父进程已死，`abortScan()` + `cleanupAndExit()`，避免孤儿进程继续写库                                                 |
| 崩溃自动重启  | `WorkerRestartPolicy`：10 分钟窗口内最多 3 次，延迟 2000ms | 重启后若有 `lastScanOptions` 则恢复扫描；耗尽则只 `notifyCrash`                                                                          |
| dispose 确认  | `DISPOSE_CONFIRM_TIMEOUT_MS = 2000`                        | 先 `SCAN_STOP` 再 `SCAN_DISPOSE`，等 `WORKER_DISPOSED` 确认 DB 句柄已释放，超时走 `kill` 兜底（不再盲等固定时长）                        |

**`failReadyHandshake` 必须 reject，绝不只置 null**：所有提前终止路径（worker 退出 / 握手超时 / dispose）都要走它，否则 `ensureWorker` 里的 `await this.readyPromise` 永久挂起，`startScan` 永不 settle。

**三个互斥标志**（都是为避免「主动 kill 触发的 exit 被误判为崩溃」而存在，新增终止路径请沿用同一模式）：

- `startupTimedOut`：启动超时已 `kill` + `notifyCrash`，随后的 `exit` 只做状态清理
- `terminatingForRestore`：`stopWorkerForRestore` 期间的退出不算崩溃，不触发自动重启
- `isDisposed`：`dispose()` 后不再重启（致命，不可复用）

**重复启动防护**：`bridge.startScan` 以 `isScanning` 拒绝并发（抛 `duplicateScanStart`）。崩溃恢复回调与用户手动重扫在 2s 重启窗口内并发时，直接放行会覆盖 `currentTaskId`——旧 taskId 泄漏在 `taskRegistry`，worker 收到两个 `SCAN_START`。

**恢复扫描走 Manager 而非直连 bridge**：`ScannerManager` 构造时 `bridge.setRestoreExecutor(...)`，恢复路径复用 Manager 的 `running` 去重与 `pendingComplete` 完成链，并通过 `'restoredComplete'` 事件透出结果——原 IPC `await` 的 Promise 已在崩溃合成事件时以失败 resolve，若无此事件将无人广播 `scanner:complete`。

**`stopWorkerForRestore` ≠ `dispose`**：前者可逆（不置 `isDisposed`、不 dispose 节流/ETA），被停的 worker 下次 `ensureWorker` 会重新 fork 并打开还原后的库；目的是释放 dbPath 文件句柄，避免 Windows 上 `rename` 覆盖在线库时 EPERM。调用方在 `await` 后可用 `hasLiveWorker()` 断言句柄已释放。

## 5. 进度、取消与快照

**两级节流**（容易误判的一点）：worker 侧 `emitProgress(force?)` 自带 **500ms** 节流（`lastProgressEmit`）才发 `SCAN_PROGRESS`；bridge 侧再用 `ProgressThrottle(200)` 节流 `task:progress` 推送。因此渲染端有效频率由 **worker 的 500ms** 主导，不是 bridge 的 200ms；调任一侧前先确认另一侧的取值。`emitProgress(true)` 用于关键节点强制立即上报。

- `ProgressThrottle(200)`：`task:progress` 节流至 4~6 FPS；**终态（`done` / `cancelled` / `error`）绕过节流立即推送**。`intervalMs` 被钳制在 `[100, 1000]`。
- `EtaCalculator(10)`：滑动窗口平均吞吐量 → `etaMs` / `perSec`。
- `taskRegistry.register(taskId)` 返回 `AbortController`；`taskId` 形如 `scan-<Date.now()>-<rand6>`，随 `SCAN_PROGRESS.taskId` 透出，渲染进程据此调 `task:cancel`。
- `abort` 监听器：置 `cancelRequested = true` → 立即推 `cancelled` 终态 → 转发 `SCAN_STOP`（保留 `scanner:stop` 向后兼容）。`cancelRequested` 用于让后续 `SCAN_COMPLETE` **跳过终态二次推送**，并抑制 abort 后残留的 `SCAN_PROGRESS`。
- `setActiveScanTask(taskProgress)` / `getActiveScanTask()`（[`../utils/active-task-store.ts`](../utils/active-task-store.ts)）：缓存最新非终态快照，供 `task:getActive` 在渲染进程挂载时一次性拉取——**IPC 事件无重放**，不补偿就会丢掉订阅前的进度。终态与崩溃路径都要 `setActiveScanTask(null)`。
- 每条终态路径都必须成套清理：`taskRegistry.unregister` + `currentTaskId = null` + `cancelRequested = false` + `progressThrottle.dispose()` + `etaCalculator.reset()` + `setActiveScanTask(null)`。漏一项就会残留注册项或陈旧进度。

## 6. 全链路诊断日志（E001–E005）

worker 侧统一用 [`scan-logger.ts`](scan-logger.ts) 的 `sendScanLogEntry({ stage, level, kind, message, detail?, code? })` 埋点，经 `SCAN_LOG` 到主进程后由 bridge 落 [`scan-log-store.ts`](scan-log-store.ts)（环形 2000 条 + 可选 JSONL 落盘，路径由 `setLogFilePath` 在 app ready 后注入）。渲染端经 `scan:getScanLog` / `scan:clearScanLog` / `scan:exportScanLog` 读取。

| code   | 阶段     | 含义                                                      | 埋点位置                 |
| ------ | -------- | --------------------------------------------------------- | ------------------------ |
| `E001` | 路径定位 | 未找到任何可扫描目录                                      | `scan-channels.ts`       |
| `E002` | 路径定位 | 找到游戏根但目标子目录不存在（`detail` 带实际子目录列表） | `scan-channels.ts`       |
| `E003` | 目录访问 | 访问被拒（EACCES/EPERM）                                  | `gameplayphotos-root.ts` |
| `E004` | 目录遍历 | 未找到 UID 文件夹                                         | `uid-discovery.ts`       |
| `E005` | 文件读取 | 图片/元数据读取失败                                       | `worker-entry.ts`        |

- `workerLog(level, message, ...args)` 是 worker 内部通用日志：**`info` 级直接丢弃**（跨进程 IPC 开销），`warn` / `error` 才转发。低频关键诊断（目录发现结论等）走 `sendScanLogInfo` 白名单式发送，或 `sendScanLogEntry`。
- bridge 侧对 `stage` 有回退解析：worker 未显式携带时从 `message` 的 `[xxx]` 前缀提取，缺省 `'Scanner'`。**日志消息保留 `[Stage]` 前缀** 因此不只是美观，它参与诊断分类。
- `classifyFsError(err)` 把 fs 错误归一为 `kind`：`ENOENT → path-missing`、`EACCES/EPERM → permission`、其余 `other`；「目录存在但为空」需调用方自行判 `empty`。`kind === 'permission'` 会在主进程触发 `promptAdminRelaunch()`（内置幂等，单会话只提示一次）。
- 每次扫描启动时 `scanner-handler.ts` 调 `scanLogStore.startRun()` 清空轨迹。

## 7. 模块边界铁律

`worker-entry.ts` 有**模块顶层副作用**：心跳看门狗 `setInterval`、`process.on('exit' / 'uncaughtException' / 'unhandledRejection')`、末尾 `sendEvent({ type: 'WORKER_READY' })`。致命的那几项已用 `if (process.parentPort)` 守卫（心跳定时器为 `process.parentPort ? setInterval(...) : null`；`sendEvent` 内部是 `parentPort?.postMessage`，无 parentPort 时静默丢弃），但**任何主进程模块 import `worker-entry.ts` 仍是致命错误**：

> 主进程无 `parentPort` → 永远收不到 `WORKER_PING` → 看门狗在启动 15s 后 `process.exit(0)` **静默杀死主进程**。这是 2026-08-29 打包版「运行不足 1 分钟闪退」的根因。

因此本模块有一条硬约束：**任何可能被主进程引用的文件，禁止 import `worker-entry.ts`（含 `import type` 之外的任何形式）**。为满足它，以下能力被刻意抽成零依赖小模块：

- [`scan-abort.ts`](scan-abort.ts)：`game-directory-discovery` 需要 `isScanAborted`，若反向从 `worker-entry` 导入，则主进程侧的 `scanner-handler.detectGameRootCandidates` 会把整份 `worker-entry` 跨块拉进主进程
- [`scan-logger.ts`](scan-logger.ts)：同理，只用 `process.parentPort`，父进程不可用时静默丢弃
- [`scan-log-store.ts`](scan-log-store.ts)：**不 import `electron`**（避免单测环境崩溃），落盘路径靠注入

**跨进程共享文件清单**（改动时须同时考虑两个进程的兼容性，且不得引入 `electron`）：
`worker-protocol.ts`、`scan-abort.ts`、`scan-logger.ts`、`scan-log-store.ts`、`path-classifier.ts`、`gameplayphotos-root.ts`、`game-directory-discovery.ts`、`uid-discovery.ts`、`integrity-root-filter.ts`、`sqlite-retry.ts`、`repair-legacy-data-v*.ts`、`scan-channels.ts`。

其中 `path-classifier.ts` 还被 [`../thumbnail/generator.ts`](../thumbnail/generator.ts)（主进程）引用，`game-directory-discovery.ts` 被 [`../ipc/handlers/scanner-handler.ts`](../ipc/handlers/scanner-handler.ts)（主进程）引用——**改这两个文件的签名会同时影响两个进程**。

**纯函数优先**：路径分类、通道编排、根解析、UID 判定、完整性过滤一律抽为无副作用纯函数（不依赖 electron / sharp / ffmpeg），以便 characterization test 覆盖。新增分类逻辑请沿用该模式，不要塞进 `worker-entry.ts`。

## 8. 数据库并发约束

worker 与主进程 `DatabaseManager` / `database-worker` **共享同一 WAL 库文件、各持独立连接并发写入**：

- 单次 better-sqlite3 事务已由 `busy_timeout = 5000` 内部重试 5 秒；持续冲突仍会抛 `SQLITE_BUSY`。
- [`sqlite-retry.ts`](sqlite-retry.ts) 的 `executeWriteSafely(fn, { retries = 3, baseDelayMs = 200, log })` 在 `busy_timeout` 之外再做指数退避（200/400/800ms，总约 1.4s），把瞬时冲突窗口提到约 6.4s，专门吸收瞬时锁冲突而非中止整次扫描。
- **只对 `SQLITE_BUSY` / `SQLITE_LOCKED` 重试**；约束违反、磁盘满等非锁错误必须**立即 rethrow**，以保持「系统性故障中止扫描」的语义。
- `isSqliteBusy` 自包含实现，**不 import `../database/connection.ts`**——worker 是独立 utilityProcess，应轻量自洽，不耦合 `DatabaseManager`。
- `walCheckpoint(db, mode)`：`TRUNCATE` **会等待写锁**，只应在扫描写入完全结束、连接空闲时调用（`finalizeScanCheckpoint`，且调用方自行 try/catch，失败只记 warn）；扫描进行中关闭旧连接用 `PASSIVE`。**绝不把 checkpoint 放进批量写入循环。**
- prepared statement 缓存（`insertStmtCache` / `insertProfileStmtCache`）在 db 变化时置空；`realpathCache` 每次 `startScan` 开始时清空。

## 9. i18n 约束

| 侧                                                 | import                                    | 原因                                                      |
| -------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------- |
| 主进程（`index.ts`、`scanner-worker-bridge.ts`）   | `import { t } from '../i18n'`             | 跟随用户语言切换                                          |
| worker（`worker-entry.ts` 及被 worker 共享的模块） | `import { t } from '../i18n/worker-safe'` | `@main/i18n` 依赖 electron `app`，utilityProcess 内不可用 |

[`../i18n/worker-safe.ts`](../i18n/worker-safe.ts) 是固定 zh-CN 的同步查表实现，key 仍集中在 `locales/zh-CN.json`（文案调整无需改 worker 代码），key 缺失时返回 key 本身。**worker 侧禁止 import `../i18n`。**

例外：少数**诊断日志**字符串仍硬编码中文并带 `// eslint-disable-next-line no-restricted-syntax` 注释——worker 进程早于 i18n 初始化，日志须始终可读。新增此类字符串必须带上同样的 disable 注释与理由。

## 10. 常见陷阱

| 陷阱                                                                      | 后果                                                                                  | 规避                                                                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 主进程模块 import `worker-entry.ts`                                       | 心跳看门狗在主进程 15s 后 `process.exit(0)`，打包版静默闪退                           | 共享能力抽到零依赖模块（见 §7）                                                        |
| 从 `worker-entry` 反向 import `scan-abort` / `scan-logger` 之外的共享模块 | 循环依赖，或把 worker 顶层副作用带进主进程 chunk                                      | 共享模块单向依赖：`worker-entry → 共享模块`，共享模块之间可互引但不得引 `worker-entry` |
| 新增 `WorkerEvent` 只改协议不改 bridge 分发                               | 事件被 `handleWorkerMessage` 的 switch 静默丢弃                                       | 协议 + bridge 分发 + worker 发送三处同步；必要时在 switch 补 `default` 记日志          |
| 某条 `SCAN_START` 退出路径未发 `SCAN_COMPLETE`                            | `pendingComplete` 永不 resolve，IPC 与 UI 一起卡死                                    | 终态必成对；崩溃路径靠 bridge 合成 + worker `uncaughtException` 补发双保险             |
| 提前终止路径只把 `readyReject` 置 null                                    | `await this.readyPromise` 永久挂起                                                    | 一律走 `failReadyHandshake(reason)`                                                    |
| 主动 `kill()` 后未置互斥标志                                              | `exit` 事件被当崩溃 → 二次 fault / 二次崩溃弹窗 / 计划外自动重启                      | 沿用 `startupTimedOut` / `terminatingForRestore` / `isDisposed` 模式                   |
| 终态清理漏项（`taskRegistry` / `progressThrottle` / `activeTaskStore`）   | 注册项泄漏、`task:getActive` 返回陈旧进度、UI 卡在 processing                         | 复制 §5 的成套清理清单                                                                 |
| 在批量写入循环里调 `walCheckpoint(db, 'TRUNCATE')`                        | 等待写锁 → 扫描吞吐崩塌                                                               | 只在 `finalizeScanCheckpoint` 收尾调用                                                 |
| 对非锁错误也走 `executeWriteSafely` 重试                                  | 约束违反/磁盘满被重试 3 次后才暴露，削弱「系统性故障中止扫描」语义                    | 该封装只对 `SQLITE_BUSY`/`SQLITE_LOCKED` 生效，别在外层再包一层无差别重试              |
| 修复步骤 V1~V6 改成「失败也继续」                                         | 在脏数据上做二次修改，留下半迁移状态                                                  | 保持「前置失败即中止后续」；各步自带幂等迁移标记，下次扫描重跑                         |
| `uidGate` 发现为空时传空 `Set` 而非 `null`                                | gate 把所有 UID 判为非法 → 全部归 `'default'`，账号维度数据丢失                       | 显式 `discoveredUids.length > 0 ? new Set(...) : null`                                 |
| 恢复 `findMediaDirectories` 的软过滤或全盘枚举                            | 重现历史缺陷：一个空的自定义路径抑制全盘搜索、或自定义路径被 `infinitynikki` 过滤挤出 | 保持 `customSet`（恒包含）+ `registrySet`（仅三渠道）两集合分离                        |
| worker 侧 import `../i18n`                                                | utilityProcess 内 electron `app` 不可用 → worker 启动即崩                             | 用 `../i18n/worker-safe`                                                               |
| 改 `MAX_SCAN_DEPTH` / `SCAN_BATCH_SIZE` 等常量而不给实测依据              | 深度不足漏扫（原 10 层漏 `PaperSDK` 子树）或内存峰值回升                              | 常量处已有注释说明取值理由，改动须同步更新注释                                         |

## 11. 测试约定

- 单测与源码同目录命名 `*.test.ts`，跨文件/集成用例放 `__tests__/`；跑法 `npm run test:main` 或 `npx vitest run src/main/scanner`。
- **路径语义按三分法归位**（`docs/CODING_CONVENTIONS.md` §6）：本模块的游戏根/相册路径既可能是库里的 `D:\Game`，也可能是 `mkdtemp(os.tmpdir())` 出来的 `/tmp/x`，一律走 `../utils/path-dialect` 的 `joinUnder` / `pathOf` / `sepOf`（样板 `uid-discovery.ts`、`gameplayphotos-root.ts`、`scan-channels.ts`、`game-directory-discovery.ts`）。整体钉 win32 会打死 `__tests__/scan-channels.test.ts`、`__tests__/epic-manifests.test.ts`、`__tests__/worker-entry.findMediaDirectories.test.ts` 这些真 IO 套件；保持宿主绑定则 CI（ubuntu）上拼出混合分隔符并误记 E002。GPP 候选拼接与 `scan-channels.ts` 的前缀比较是**锁步**的，改一侧必须同批改另一侧。
- **CI 复现桩（常驻）**：只喂 Windows 字面量且把 fs 全量 mock 的套件（`game-directory-discovery.test.ts`、`__tests__/resolve-gameplayphotos.test.ts`、`__tests__/scan-channels.win32-root.test.ts`）在文件内 `vi.mock('path')` 钉 posix 宿主，使「撤掉方言分流」在开发机上就红；真 IO 套件**不得**加这个桩。全量 CI 语义预跑用 `npm run test:ci-linux`。
- **纯函数直接测**：`path-classifier.test.ts`、`uid-gate.test.ts`、`integrity-root-filter.test.ts`、`sqlite-retry.test.ts`、`scan-abort.test.ts`、`__tests__/scan-channels.test.ts`、`__tests__/resolve-gameplayphotos.test.ts`、`__tests__/epic-manifests.test.ts` 都是无 electron / 无原生模块的快测。
- **测 worker-entry 需要两件套**：
  1. `process.parentPort` 桩——用共享工具 [`tests/mocks/parent-port.ts`](../../../tests/mocks/parent-port.ts) 的 `installParentPortStub()` / `uninstallParentPortStub()`。**必须在 import `worker-entry` 之前安装**（消息处理器在模块加载期注册），随后用 `port.emitMessage({ type: 'SCAN_START', payload })` 触发、`port.messages` 断言发出的事件。
  2. `better-sqlite3` 替换——`vi.mock` 对 native 模块无效（vite-node 的 import 绕过它，且该模块是 Electron ABI，Node 下加载即崩）。现有用例（`__tests__/scan-batch-write-failure.test.ts`、`__tests__/scan-worker-recovery.test.ts`）改用 `Module._load` 拦截返回可控 fake db 工厂。
- **bridge 测试用 fake timers** 推进握手/重启/dispose 的等待（`scanner-worker-bridge.test.ts`）；`media-worker/bridge.test.ts` 与 `thumbnail/worker-bridge.test.ts` 沿用同一模式，改一处请对照另两处。
- `scan-log-store` 提供 `__resetScanLogStore()` 供用例间隔离；`worker-entry` 提供 `__setTraverseSlowMsForTest(ms)` 注入更小的慢遍历阈值——**两个 `__*ForTest` 生产代码不得调用**。
- 诊断错误码的埋点回归见 `__tests__/scan-error-codes.test.ts`；E001/E002 的 `detail` 结构（含 `probeTrail`、`children`）变更需同步该用例与渲染端诊断页。
