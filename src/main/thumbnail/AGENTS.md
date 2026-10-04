# AGENTS.md — `src/main/thumbnail`（缩略图单文件生成与 worker 进程）

本文件为 Agent 与新协作者提供 **thumbnail 模块级** 速览与约定。顶层项目速览见根目录 [`AGENTS.md`](../../../AGENTS.md)；IPC 白名单与 AppError 两条硬性约定见 [`docs/CODING_CONVENTIONS.md`](../../../docs/CODING_CONVENTIONS.md)（唯一真相源；IDE 的 always-on 规则文件仅为它的本地镜像）；通道契约见 [`docs/IPC_CONTRACT.md`](../../../docs/IPC_CONTRACT.md)；IPC 注册侧见 [`src/main/ipc/handlers/AGENTS.md`](../ipc/handlers/AGENTS.md)；preload 侧见 [`src/main/preload/AGENTS.md`](../preload/AGENTS.md)。本文件只补 **本目录内** 的进程拓扑、通信协议与生成流水线落地方式。

## 模块概述

thumbnail 模块负责**单文件缩略图生成**（按需生成），与 `media-worker` 的**批量生成**互补：

```
渲染进程
  │ window.electronAPI.thumbnail.*      （preload: api/thumbnail.ts）
  ▼
主进程                                          ← ThumbnailGenerator 类
  thumbnail-handler.ts  ──ctx──▶  ThumbnailGenerator (generator.ts)
                                          │  generate(filePath, quality)
                                          │  ↓ worker 可用时委托
                                          ▼
                                ThumbnailWorkerBridge (worker-bridge.ts)
                                          │  utilityProcess.fork('thumbnail-worker.js')
                                          │  postMessage(ThumbnailWorkerCommand) ▲ │ ▼ on('message', ThumbnailWorkerEvent)
                                          ▼
worker 进程（独立 utilityProcess）               ← sharp 缩放实现
  worker-entry.ts：三档 sharp 处理（standard/low/high）+ 原子落盘
```

- [`generator.ts`](generator.ts) 的 `ThumbnailGenerator` 是**主进程侧入口**：缓存管理（LRU 淘汰、大小限制）、并发控制（解码信号量）、视频抽帧（ffmpeg）、降级策略（worker 不可用时回退到内联 sharp）。
- 拆到 `utilityProcess` 的动机：sharp 是 native 模块，崩溃会影响主进程；单文件 worker 化后崩溃只影响当前请求，下次自动重新 fork。
- **与 media-worker 的差异**：
  - thumbnail worker：**单文件原子操作**，无进度推送，多请求并发，30s 超时保护
  - media-worker：**批量任务**，有进度推送，四类任务独立取消，崩溃自动重启

## 目录结构

| 路径                                       | 进程   | 职责                                                                                                                                          |
| ------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [`generator.ts`](generator.ts)             | 主     | `ThumbnailGenerator` 类：缓存管理 + 并发控制 + 视频抽帧 + worker 降级 + 损坏文件标记                                                          |
| [`worker-bridge.ts`](worker-bridge.ts)     | 主     | worker 生命周期（fork / READY 握手 / dispose）、多请求并发关联（pending Map）、30s 超时保护、降级到内联 sharp                                 |
| [`worker-protocol.ts`](worker-protocol.ts) | 共享   | **唯一协议定义**：`ThumbnailWorkerCommand` / `ThumbnailWorkerEvent` / `ThumbnailProcessInput` / `ThumbnailProcessOutput` / `ThumbnailQuality` |
| [`worker-entry.ts`](worker-entry.ts)       | worker | sharp 缩放实现（约 250 行）：三档处理函数 + 原子落盘 + 消息循环                                                                               |
| `*.test.ts`                                | —      | Vitest 单测（`npm run test:main`）                                                                                                            |

## 1. 进程拓扑与装配

装配点在 [`src/main/app/application.ts`](../app/application.ts)：

```ts
this.thumbnailGen = new ThumbnailGenerator()
this.thumbnailWorkerBridge = new ThumbnailWorkerBridge()
this.thumbnailGen.setWorkerBridge(this.thumbnailWorkerBridge) // bridge 注入到 Generator
```

`ThumbnailGenerator` 进 `HandlerContext`（`thumbnailGen`），其余模块**只经 ctx 访问**：

| 调用方                                                                                     | 用法                                                                                            |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| [`../app/ipc-setup.ts`](../app/ipc-setup.ts)                                               | `ctx.thumbnailGen.setCorruptedMarker(markCorruptedFn, clearCorruptedFn)`——注入损坏文件标记回调  |
| [`../app/cleanup.ts`](../app/cleanup.ts)                                                   | 退出时 `thumbnailWorkerBridge.dispose()`（带 500ms 优雅等待）                                   |
| [`../ipc/handlers/thumbnail-handler.ts`](../ipc/handlers/thumbnail-handler.ts)             | 注册 `thumbnail:generate` 通道：`ctx.thumbnailGen.generate(filePath, quality)`                  |
| [`../ipc/handlers/video.ts`](../ipc/handlers/video.ts)                                     | `video:thumbnail` 通道：`ctx.thumbnailGen.generate(filePath)` 抽帧                              |
| [`../ipc/handlers/media-lifecycle-handler.ts`](../ipc/handlers/media-lifecycle-handler.ts) | 删除媒体时清理缩略图缓存：`cleanupThumbnailsForRows(rows, ctx.thumbnailGen.getCacheDir(), ...)` |
| [`../services/thumbnail-phash-service.ts`](../services/thumbnail-phash-service.ts)         | 单条生成转发到 `ctx.thumbnailGen.generate(filePath, quality)`                                   |

**构建产物约束**：`worker-entry.ts` 在 [`electron.vite.config.ts`](../../../electron.vite.config.ts) 的 `main.build.lib.entry` 中是**独立入口** `'thumbnail-worker'`，输出 `dist/main/main/thumbnail/worker-entry.js`。bridge 以 `path.join(__dirname, 'worker-entry.js')` fork。**改入口名或产物布局会直接导致 fork 失败**。

## 2. worker 通信协议

协议只在 [`worker-protocol.ts`](worker-protocol.ts) 定义一份，两端都 import 它。**新增消息类型必须同时改协议、bridge 分发、worker 消息循环三处。**

**主进程 → worker（`ThumbnailWorkerCommand`）**

| type                       | payload                 | 语义                                                         |
| -------------------------- | ----------------------- | ------------------------------------------------------------ |
| `THUMBNAIL_PROCESS_START`  | `ThumbnailProcessInput` | 单文件生成请求；worker 完成后回 `THUMBNAIL_PROCESS_COMPLETE` |
| `THUMBNAIL_WORKER_DISPOSE` | —                       | worker 主动退出 + `process.exit(0)`                          |

`ThumbnailProcessInput` 字段：

- `requestId`：主进程生成，用于关联 pending Promise
- `filePath`：源文件绝对路径
- `fileHash`：文件内容 hash（主进程已计算，前 1MB sha256 前 16 字符）
- `quality`：缩略图档位（`'low' | 'standard' | 'high'`）
- `cacheDir`：缩略图缓存目录（主进程 `cacheDir`）

**worker → 主进程（`ThumbnailWorkerEvent`）**

| type                         | payload                     | bridge 处理                                               |
| ---------------------------- | --------------------------- | --------------------------------------------------------- |
| `WORKER_READY`               | —                           | resolve READY 握手（10s 超时即降级到内联 sharp）          |
| `THUMBNAIL_PROCESS_COMPLETE` | `ThumbnailProcessOutput`    | 按 `requestId` 关联 pending Promise 并 resolve            |
| `THUMBNAIL_WORKER_LOG`       | `{ level, message, args? }` | 转发主进程 `logger`；`info` 级丢弃，`warn`/`error` 才转发 |
| `WORKER_ERROR`               | `{ message, stack? }`       | 仅记 error 日志                                           |

`ThumbnailProcessOutput` 字段：

- `requestId`：对应的请求 ID
- `success`：是否成功
- `outputPath`：生成的缩略图绝对路径（失败时为 `null`）
- `errorMessage`：失败原因（成功时为空字符串）
- `outputSize`：生成的新文件大小（字节，用于主进程累加 `totalCacheSize`）

**worker 侧收发形态**（`worker-entry.ts` 末尾）：

```ts
process.parentPort?.on('message', async (event: { data: unknown }) => {
  const msg = event.data as ThumbnailWorkerCommand
  if (msg.type === 'THUMBNAIL_PROCESS_START') {
    const output = await processImage(msg.payload)
    sendEvent({ type: 'THUMBNAIL_PROCESS_COMPLETE', payload: output })
  } else if (msg.type === 'THUMBNAIL_WORKER_DISPOSE') {
    cleanupAndExit()
  }
})
```

**多请求并发**：sharp 自身 async 基于 libuv 线程池，多个 `THUMBNAIL_PROCESS_START` 自然并发，无需队列调度。bridge 用 `pending: Map<string, PendingRequest>` 按 `requestId` 关联。

## 3. 缩略图生成流水线（`generator.ts`）

### 3.1 主进程侧入口（`generate(filePath, quality?)`）

按序执行：

1. **计算内容 hash** `computeContentHash(filePath)`：读前 1MB，sha256 取前 16 字符，缓存到 `contentHashCache`（按 `filePath + mtime + size` 失效）
2. **检查缓存** `path.join(cacheDir, '<contentHash>.jpg')` 存在则直接返回（LRU 更新 `accessTimes`）
3. **并发控制** `await decodeLimiter.acquire()`（全局解码并发上限 = CPU 核数 × 2）
4. **worker 路径**：`workerBridge.isAvailable()` 为 true 时委托到 worker
   - 构造 `ThumbnailProcessInput`（`requestId` = `<filePath>-<Date.now()>-<rand6>`）
   - `workerBridge.processImage(input)` 返回 Promise
   - 30s 超时保护（`REQUEST_TIMEOUT_MS = 30_000`）
5. **降级路径**：worker 不可用（fork 失败 / READY 超时 / 已 dispose）时走 `runSharpInline(filePath, fileHash, quality)`
   - 图片：`sharp(filePath).resize(...).toFile(cacheDir/<contentHash>.jpg)`
   - 视频：`ffmpeg(filePath).screenshots(...)` 抽帧 + sharp 缩放（纯色帧自愈：0s/1s/3s 阶梯取帧）
6. **同步生成 `_low`**（standard 档位）：从刚生成的标准缩略图缩放，失败不阻断主流程
7. **同步生成 `_high`**（若 quality='high'）：512×512, q90
8. **更新缓存元数据** `accessTimes.set(fileHash, Date.now())` + `totalCacheSize += outputSize`
9. **LRU 淘汰** `enforceCacheLimit()`：超阈值 10% 才触发，按 `accessTimes` 排序删除最久未访问的

### 3.2 三档参数（**禁止随意改值**）

| 档位       | 最大宽高 | 质量 | 文件名后缀  | 用途                       |
| ---------- | -------- | ---- | ----------- | -------------------------- |
| `low`      | 64×64    | q30  | `_low.jpg`  | 首屏快速预览（滚动时模糊） |
| `standard` | 320×320  | q85  | `.jpg`      | 默认档位（列表/详情）      |
| `high`     | 512×512  | q90  | `_high.jpg` | 高分屏 DPR ≥ 2（详情放大） |

**常量同步约束**：worker 与主进程的三档参数必须完全一致（否则缓存命中失败、重复生成）。改动时需同步修改 `generator.ts` 与 `worker-entry.ts`。

### 3.3 视频抽帧（ffmpeg）

- **独立信号量** `videoLimiter`（`VIDEO_DECODE_CONCURRENCY = 2`）：与图片 sharp 解码解耦，避免慢视频长时间占满 `decodeLimiter` 把可视区图片全部堵住
- **纯色帧自愈**：0s 抽帧失败或为纯色 → 重试 1s → 仍失败重试 3s（`VIDEO_RETRY_SEEK_SECONDS` / `VIDEO_THIRD_SEEK_SECONDS`）
- **损坏文件容错**：ffmpeg spawn 同步抛错（EFTYPE）被 `installFfmpegSpawnGuard()` 收敛为回调错误，不崩溃
- **单文件超时**：`withFileTimeout(task, 30_000, filePath, 'video-frame')`，避免坏文件让批次永久挂起

### 3.4 缓存管理

- **缓存目录**：`<userData>/thumbnails/`（由 `app.getPath('userData')` 解析）
- **缓存上限**：默认 2GB（`DEFAULT_CACHE_LIMIT_BYTES`），可配置（`setCacheLimit(bytes)`），下限 100MB（`MIN_CACHE_LIMIT_BYTES`）
- **LRU 淘汰**：超阈值 10% 才触发（`LRU_TRIGGER_RATIO = 1.1`），按 `accessTimes` 排序删除最久未访问的
- **元数据持久化**：`accessTimes` 每 100 次写入或 5 分钟定时落盘到 `<cacheDir>/__access_times.json`（`CACHE_METADATA_FILENAME`）
- **启动清理**：`startup-tasks.cleanupOrphanThumbnails()` 删除不在 DB 中的孤儿缓存文件（豁免 `__access_times.json`）

### 3.5 损坏文件标记

- **回调注入**：`setCorruptedMarker(mark, clear)` 由 Application 注入
  - `markCorrupted(filePath, reason)`：解码失败时调用，`UPDATE is_corrupted=1`
  - `clearCorrupted(filePath)`：解码成功时调用，`UPDATE is_corrupted=0`（用于已修复文件的重扫场景）
- **未注入时降级**：仅日志写入，不阻塞主流程（单个损坏文件不应影响其他文件加载）

## 4. 生命周期与容错（bridge 侧）

| 机制         | 参数                          | 说明                                                                                                       |
| ------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 惰性 fork    | —                             | 首次 `processImage` 才 `ensureWorker()`；worker 已存在则复用                                               |
| READY 握手   | `READY_TIMEOUT_MS = 10_000`   | 超时 → `failReadyHandshake` + `workerFailed = true` + 降级到内联 sharp（不弹窗，单文件 worker 不自动重启） |
| 请求超时     | `REQUEST_TIMEOUT_MS = 30_000` | 单文件请求 30s 未响应 → reject + 降级到内联 sharp（sharp 单张不应超过 30s）                                |
| 崩溃降级     | —                             | worker 崩溃 → reject 所有 pending Promise → 下次请求重新 fork（不自动重启，避免崩溃循环）                  |
| dispose 优雅 | `DISPOSE_GRACE_MS = 500`      | 等待 worker 退出，超时走 `kill` 兜底                                                                       |

**`failReadyHandshake` 必须 reject，绝不只置 null**：所有提前终止路径（worker 退出 / 握手超时 / fork 失败 / dispose）都要走它，否则 `ensureWorker` 里的 `await this.readyPromise` 永久挂起。

**与 media-worker / scanner-worker 的差异**：

- **无自动重启策略**：崩溃后下次请求重新 fork，避免崩溃循环（单文件操作崩溃通常意味着 sharp/native 模块问题，自动重启无意义）
- **降级到内联 sharp**：worker 不可用时主进程直接调 sharp（保留原行为），不阻断用户操作
- **无进度推送**：单文件原子操作，sharp 单张 50~200ms，进度无意义

**`isAvailable()` 判定**：

- `isDisposed = true` → false
- `workerFailed = true`（fork 失败 / READY 超时）→ false
- `worker = null`（已崩溃）→ false（下次调用会重新 fork）

## 5. 并发控制与信号量

**两级信号量**：

- `decodeLimiter`（`DECODE_CONCURRENCY = CPU 核数 × 2`）：全局解码并发上限（图片 sharp + worker 路径）
- `videoLimiter`（`VIDEO_DECODE_CONCURRENCY = 2`）：视频抽帧独立信号量，与图片解耦

**信号量语义**：

- `acquire()`：获取许可（无许可则排队）
- `release()`：释放许可
- **排队等待不计入超时预算**：`withFileTimeout` 在拿到许可之后才启动计时，避免"堆积→集体超时→集体降级内联"的放大

**并发互斥锁**：`generatingLocks: Map<string, Promise<string | null>>`——相同 `filePath` 的并发请求复用同一个 Promise，避免重复生成。

## 6. 模块边界铁律

`worker-entry.ts` 有**模块顶层副作用**：`process.on('exit' / 'uncaughtException' / 'unhandledRejection')`、末尾 `sendEvent({ type: 'WORKER_READY' })`。已用 `process.parentPort?.postMessage` 守卫（无 parentPort 时静默丢弃），但**任何主进程模块 import `worker-entry.ts` 仍是致命错误**：

> 主进程无 `parentPort` → worker 启动逻辑在主进程执行 → 发送 `WORKER_READY` 失败 → bridge 握手超时 → 降级到内联 sharp（性能下降）。

因此本模块有一条硬约束：**任何可能被主进程引用的文件，禁止 import `worker-entry.ts`（含 `import type` 之外的任何形式）**。

**跨进程共享文件**（改动时须同时考虑两个进程的兼容性）：`worker-protocol.ts`。

**常量同步约束**：worker 与主进程的三档参数（`STANDARD_MAX_WIDTH` / `LOW_MAX_WIDTH` / `HIGH_MAX_WIDTH` 等）必须完全一致，否则缓存命中失败、重复生成。

## 7. i18n 约束

| 侧                                           | import                        | 原因                                 |
| -------------------------------------------- | ----------------------------- | ------------------------------------ |
| 主进程（`generator.ts`、`worker-bridge.ts`） | `import { t } from '../i18n'` | 跟随用户语言切换                     |
| worker（`worker-entry.ts`）                  | 无 i18n 依赖                  | 单文件操作无用户可见文案，日志走英文 |

**worker 侧无 i18n 需求**：`worker-entry.ts` 不 import 任何 i18n 模块，日志消息硬编码英文（仅 `warn`/`error` 转发到主进程 `logger`）。

## 8. 常见陷阱

| 陷阱                                                                | 后果                                                                         | 规避                                                                          |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 主进程模块 import `worker-entry.ts`                                 | worker 启动逻辑在主进程执行 → bridge 握手超时 → 降级到内联 sharp（性能下降） | 共享能力抽到 `worker-protocol.ts`                                             |
| 新增 `ThumbnailWorkerEvent` 只改协议不改 bridge 分发                | 事件被 `handleWorkerMessage` 的 switch 静默丢弃                              | 协议 + bridge 分发 + worker 发送三处同步                                      |
| `THUMBNAIL_PROCESS_START` 退出路径未发 `THUMBNAIL_PROCESS_COMPLETE` | pending Promise 永不 resolve，IPC 与 UI 一起卡死                             | 终态必成对；worker `uncaughtException` 补发双保险                             |
| 提前终止路径只把 `readyReject` 置 null                              | `await this.readyPromise` 永久挂起                                           | 一律走 `failReadyHandshake(reason)`                                           |
| 改 `STANDARD_MAX_WIDTH` / `LOW_MAX_WIDTH` 等常量而不改 worker       | 缩略图文件名/质量不一致 → 缓存命中失败、重复生成                             | worker 与主进程常量必须同步修改                                               |
| 视频抽帧走 `decodeLimiter` 而非 `videoLimiter`                      | 慢视频长时间占满解码许可 → 可视区图片全部堵在队列后（数十秒白屏）            | 视频抽帧独立信号量 `videoLimiter(2)`                                          |
| 单文件请求无超时保护                                                | sharp 卡死（损坏/超大/网络盘）→ pending Promise 永不 settle → 内存泄漏       | `REQUEST_TIMEOUT_MS = 30_000` 超时自动 reject + 降级                          |
| 崩溃后自动重启 worker                                               | sharp/native 模块问题导致崩溃循环                                            | 单文件 worker 无自动重启，下次请求重新 fork                                   |
| LRU 淘汰未豁免 `__access_times.json`                                | 启动清理时被当孤儿删除 → 缓存访问时间丢失 → LRU 排序错乱                     | `CACHE_METADATA_FILENAME` 在白名单内                                          |
| 并发生成同一文件而不加互斥锁                                        | 重复生成 → 缓存文件写冲突 → 裂图（`media://` 半截读取）                      | `generatingLocks: Map<string, Promise>` 按 `filePath` 互斥                    |
| 原子落盘用 `fs.writeFile` 而非 `writeFileAtomic`                    | 进程崩溃/断电 → 缓存文件半截 → `media://` 裂图                               | 用 `writeFileAtomic(path, (tmp) => sharp(...).toFile(tmp))` 临时文件 + rename |

## 9. 测试约定

- 单测与源码同目录命名 `*.test.ts`；跑法 `npm run test:main` 或 `npx vitest run src/main/thumbnail`。
- **纯函数直接测**：`generator.test.ts`（缓存管理/LRU/并发控制）、`generator.eftype.test.ts`（EFTYPE 容错）、`generator.limiter.test.ts`（信号量）都是无 electron / 无原生模块的快测。
- **测 worker-entry 需要两件套**：
  1. `process.parentPort` 桩——用共享工具 [`tests/mocks/parent-port.ts`](../../../tests/mocks/parent-port.ts) 的 `installParentPortStub()` / `uninstallParentPortStub()`。**必须在 import `worker-entry` 之前安装**（消息处理器在模块加载期注册），随后用 `port.emitMessage({ type: 'THUMBNAIL_PROCESS_START', payload })` 触发、`port.messages` 断言发出的事件。
  2. `sharp` mock——`vi.mock('sharp')` 返回可控 fake（返回固定尺寸/格式的假缩略图）。
- **bridge 测试用 fake timers** 推进握手/超时的等待（`worker-bridge.test.ts`）；`media-worker/bridge.test.ts` 与 `scanner/scanner-worker-bridge.test.ts` 沿用同一模式，改一处请对照另两处。
- **generator 测试 mock workerBridge**：`setWorkerBridge(mockBridge)` 注入假 bridge，测降级/委托/超时/崩溃路径。
