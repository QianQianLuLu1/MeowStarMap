# 修复「索引链缺兜底超时 + 低队列被长期占用」实施计划

> 状态：待评审（仅计划，未改任何代码）
> 适用版本：当前 main 分支工作区（含未提交的 fix-indexing-deadlock 改动）
> 作者：Electron 后台任务健壮性评审

---

## 1. 背景

### 1.1 问题复述

启动扫描完成后进入「索引链」（缩略图 → pHash → 场景分析），该链路存在两类健壮性缺口：

1. **缩略图 / pHash 批量无整体 watchdog**
   [runPostScanIndexing](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/app/startup-tasks.ts#L120-L247) 在缩略图 / pHash 阶段 `await` 两个 worker 批次（[L183-L187](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/app/startup-tasks.ts#L183-L187)、[L207-L217](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/app/startup-tasks.ts#L207-L217)），等待 [manager.ts](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/media-worker/manager.ts) 的 `pendingThumbnailComplete` / `pendingPhashComplete` 被 `*_COMPLETE` 事件 resolve。若 worker 批次长时间不发送 COMPLETE，`runPostScanIndexing` 就无限 `await`，索引任务长期停在「正在准备建立索引」，UI 无终态。

2. **worker 循环无单文件超时**
   [worker-entry.ts](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/media-worker/worker-entry.ts) 的缩略图逐文件处理（[L333-L385](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/media-worker/worker-entry.ts#L333-L385)）与 pHash 逐文件处理（[L460-L492](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/media-worker/worker-entry.ts#L460-L492)）没有单文件超时。`generateThumbnailInWorker` 里仅 `extractVideoFrame` 有 30s 内部超时（[L184-L222](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/media-worker/worker-entry.ts#L184-L222)），sharp 解码 / `calculatePHash` 均无超时。单张坏文件（损坏/超大/网络盘）可让一个并发槽位永久挂起，批次永不完成 → COMPLETE 永不发送 → 主进程 pending 永不 resolve。

3. **索引链在低队列内长时间占用（低队列被占）**
   `runPostScanIndexing` 若在 `startup-scan` 低优先级任务内被 `await` 数分钟，会占满 `maxLowConcurrency=1` 的唯一槽位，阻塞 `startup-integrity-check` / `startup-lru-enforce` / `startup-crash-cleanup` 等后续低优先级任务。

### 1.2 现状核对（关键：解耦已在工作区落地）

**问题 3 已在当前工作区修复**（未提交，源自 docs/plans/fix-indexing-deadlock.md）：

- [startup-tasks.ts L85-L93](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/app/startup-tasks.ts#L85-L93)：`performStartupScan` 改为 `void runPostScanIndexing(...)` fire-and-forget，扫描完成即返回，低队列槽位立即释放。
- [startup-tasks.ts L171-L217](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/app/startup-tasks.ts#L171-L217)：`runPostScanIndexing` 直接调 `ctx.mediaWorkerManager.startThumbnailBatch / startPhashBatch`，不再经 `taskScheduler.enqueueLow` 二次入队，消除了「低优先级伞内自我入队」死锁。

因此**本计划不再重复实现解耦（c）**，而是将其固化为验收项（回归测试 10b 已存在），并把新增工作聚焦在缺口 1 与 2。

---

## 2. 推荐方案

### 方案 A-1（缺口 2）：worker 内单文件处理加超时

**文件**：[worker-entry.ts](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/media-worker/worker-entry.ts)

**先例**：`autoAnalyzeSceneTime` 的 `SCENE_PER_IMAGE_TIMEOUT_MS` + `unref` 定时器模式（[startup-tasks.ts L283-L341](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/app/startup-tasks.ts#L283-L341)）。sharp/ffmpeg 无取消 API，超时后**不再 await** 其结果（结果被丢弃），从而释放 `runWithConcurrency` 的并发槽位，让批次继续推进。

**2.1 新增工具函数**（worker-entry.ts，置于任务常量区之后）：

```ts
// 单文件处理超时兜底（先例：autoAnalyzeSceneTime 的 SCENE_PER_IMAGE_TIMEOUT_MS + unref 定时器）
// sharp/ffmpeg 无取消 API，超时后不再 await 其结果（结果丢弃），释放 runWithConcurrency 并发槽位。
// 返回 null 表示"超时或失败，跳过该文件，不写 DB"；返回对象表示"正常处理完成"。
function withFileTimeout<T>(
  task: () => Promise<T>,
  ms: number,
  filePath: string,
  stage: string
): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      workerLog('warn', `[${stage}] 单文件处理超时(>${ms}ms)，跳过: ${filePath}`)
      resolve(null)
    }, ms)
    timer.unref?.() // 后台 worker 不应因超时定时器持有 event loop
    Promise.resolve()
      .then(task)
      .then((v) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(v)
      })
      .catch((err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        workerLog('warn', `[${stage}] 单文件处理失败，跳过: ${filePath}`, err)
        resolve(null)
      })
  })
}

// 常量（可调，导出供测试引用）：
// 缩略图：需兼容 extractVideoFrame 的 30s 内部上限，取 30s；正常视频抽帧 1~3s 不受影响
const THUMBNAIL_PER_FILE_TIMEOUT_MS = 30_000
// pHash：纯 DCT-II 计算，对齐 SCENE_PER_IMAGE_TIMEOUT_MS 取 10s
const PHASH_PER_FILE_TIMEOUT_MS = 10_000
```

**2.2 缩略图批次逐文件加超时**

将 [startThumbnailBatch L333-L385](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/media-worker/worker-entry.ts#L333-L385) 的逐文件任务体改为「把原有重活块（metadata + generateThumbnailInWorker + calculatePHash + stat 的 Promise.all）包进 `withFileTimeout`，返回结果对象；超时/失败返回 null 时跳过 DB 更新与计数」：

```ts
const tasks = rows.map((row) => async () => {
  if (shouldStopThumbnail) return

  const result = await withFileTimeout(
    async () => {
      // 原有 Promise.all 重活块，仅改为返回结果对象：
      // { width, height, thumbnailPath, phash, phashMtime, phashFileSize }
      // （metadata/stat 各自 .catch(() => null) 的行为保持不变）
    },
    THUMBNAIL_PER_FILE_TIMEOUT_MS,
    row.file_path,
    'Thumbnail'
  )

  // 超时/失败（null）→ 跳过该行，不写 DB、不计数，由下次批次重试
  if (result) {
    updateStmt.run(
      result.width, result.height, result.thumbnailPath,
      result.phash, result.phashMtime, result.phashFileSize,
      row.id
    )
    processed++
  }

  // 节流推送进度（500ms，保持原样）
  ...
})
```

> 行为等价性：原实现中「文件缺失导致 thumbnailPath=null 但仍写 DB、仍计数」的语义由 `result`（对象）保留；仅真正的超时/未捕获异常才返回 null 跳过。

**2.3 pHash 批次逐文件加超时**

将 [startPhashBatch L460-L492](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/media-worker/worker-entry.ts#L460-L492) 的逐文件任务体改为：

```ts
const tasks = rows.map((row) => async () => {
  if (shouldStopPhash) return

  const result = await withFileTimeout(
    async () => {
      // 原有逻辑：stat → 缓存命中判断 → calculatePHash → updateStmt.run
      // 返回 true/false 表示是否重算；缓存命中返回 false 且不写 DB
    },
    PHASH_PER_FILE_TIMEOUT_MS,
    row.file_path,
    'pHash'
  )

  if (result === true) {
    processed++
  }
  // 超时/失败（null）→ 跳过，R7 的 mtime/size 基线未更新，下次批次会重算
  // 节流推送进度（500ms，保持原样）
  ...
})
```

**2.4（可选加固）markDuplicates O(n²) 无进展 watchdog**

[markDuplicatesInWorker L548-L674](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/media-worker/worker-entry.ts#L548-L674) 是纯 CPU 循环、无单文件概念，理论上不会挂死（每次比较都推进 `compared`），正常大库仅「慢」。可选：若 `compared` 在连续 N 秒（如 60s）未推进则 `shouldStopDuplicate=true` 提前收尾并发送 COMPLETE。**列为可选加固，非本次必须**（其整体兜底由方案 A-2 覆盖）。

### 方案 A-2（缺口 1）：runPostScanIndexing 加整体 watchdog

**文件**：[startup-tasks.ts](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/app/startup-tasks.ts)

**先例**：`SCENE_TOTAL_TIMEOUT_MS`（5 分钟整体超时 + `unref`，[startup-tasks.ts L288-L301](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/app/startup-tasks.ts#L288-L301)）。

**要点**：`runPostScanIndexing` 是 fire-and-forget（无人 await），若 worker 批次永不 settle，函数自身的 `finally` 永不执行 → 必须由 watchdog **自行**负责「推送终态 + 清理」，并把清理抽成幂等的 `cleanup()` 供 watchdog 与 finally 共用。

**改动 1：常量 + 统一取消（区分超时/用户取消）**

```ts
// 索引链整体兜底超时：10 分钟。超时后强制推送终态 + fault 日志。
// 被截断的未处理文件（thumbnail IS NULL 等）下次启动/手动触发会重跑，可恢复。
const INDEXING_TOTAL_TIMEOUT_MS = 10 * 60_000
```

**改动 2：watchdog 定时器 + 幂等 abort 监听 + 幂等 cleanup**

改造 [L121-L169](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/app/startup-tasks.ts#L121-L169)：

```ts
let timedOut = false // 区分「超时」与「用户取消」的终态文案
let cleanedUp = false

// 幂等清理：watchdog 与 finally 共用，避免链挂死时清理永不执行、或双清理
const cleanup = (): void => {
  if (cleanedUp) return
  cleanedUp = true
  clearTimeout(watchdogTimer)
  taskRegistry.unregister(taskId)
  throttle.dispose()
  eta.reset()
  setTimeout(() => setActiveIndexingTask(null), 1500) // 终态快照渐隐，保持原样
}

// 整体兜底超时：fire-and-forget 链无人 await，超时必须在监听器内自清，不能只依赖 finally
const watchdogTimer = setTimeout(() => {
  timedOut = true
  logger.error(
    `[Startup] 索引任务超过 ${INDEXING_TOTAL_TIMEOUT_MS}ms 未完成，强制终止（已处理 ${processed}）`
  )
  void logger.fault?.('indexingTimeout', new Error('索引任务整体超时'), {
    taskId,
    elapsedMs: Date.now() - startedAt
  })
  controller.abort() // 触发下方统一 abort 监听
}, INDEXING_TOTAL_TIMEOUT_MS)
watchdogTimer.unref?.() // 后台启动任务不应持有 event loop

// 统一取消入口：用户取消（task:cancel）与整体超时都走这里，幂等只触发一次
controller.signal.addEventListener('abort', () => {
  if (aborted) return
  aborted = true
  report(timedOut ? 'error' : 'cancelled', timedOut ? '建立索引超时，已停止' : '已取消建立索引')
  ctx.mediaWorkerManager?.stopThumbnailBatch?.()
  ctx.mediaWorkerManager?.stopPhashBatch?.()
  // 链内 markDuplicates 检查的是 shouldStopDuplicate，单独补一刀停止其续跑
  ctx.mediaWorkerManager?.stopDuplicateMark?.()
  cleanup()
})
```

**改动 3：finally 改为调用 cleanup()**

将 [L239-L246](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/app/startup-tasks.ts#L239-L246) 的 finally 体替换为 `cleanup()`（保留 catch 的 `report('error', ...)` 不变）：

```ts
} catch (err) {
  logger.error('[Startup] 索引任务失败:', err)
  report('error', '建立索引失败')
} finally {
  cleanup() // 幂等：watchdog 已清理则此处为空操作
}
```

**改动 4：report() 超时后不再被误触发**

各阶段已由 `if (!aborted)` 守卫（[L177](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/app/startup-tasks.ts#L177)、[L201](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/app/startup-tasks.ts#L201)、[L207](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/app/startup-tasks.ts#L207)、[L219](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/app/startup-tasks.ts#L219)），watchdog 触发后 aborted=true，链恢复时直接跳过后续阶段并落到 finally。

> **分层关系**：A-1 让 worker 批次在**有界时间**内必然发送 COMPLETE（逐文件有界），主进程 pending 必然 resolve，链必然走到 finally —— 这是 A-2 能「等待到链自然收尾」的前提；A-2 则是 worker 极端异常（进程僵死等 bridge 兜底失效场景）时保证 UI/状态必达终态的第二层保险。

### 方案 A-3（缺口 3）：索引链解耦 —— 现状确认，固化为验收项

**不做代码改动**。当前工作区已实现 fire-and-forget 解耦（见 §1.2），本计划将其列为验收项：

- 回归测试 [startup-tasks.test.ts 用例 10b](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/app/__tests__/startup-tasks.test.ts#L494-L512)（`startThumbnailBatch` 永不 resolve 时 `performStartupScan` 仍立即返回）已覆盖「扫描不 await 索引链」。
- 验收时确认：`performStartupScan` 返回后 `startup-integrity-check` / `startup-lru-enforce` / `startup-crash-cleanup` 能正常 pump（低队列不被索引链占用）。

---

## 3. 备选方案对比与取舍

| 方案                | 做法                                                                                    | 优点                                                                                   | 缺点                                                                                                   | 结论                        |
| ------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------- |
| **A（推荐）**       | worker 逐文件超时（A-1）+ runPostScanIndexing 整体 watchdog（A-2）+ 解耦现状确认（A-3） | 双层兜底：worker 批次有界、主进程状态必达终态；复用 SCENE 超时先例；改动集中、语义清晰 | worker 内超时后遗留的 sharp 操作仍占用 CPU（无法取消，仅停止 await）；整体超时会截断大库索引（可恢复） | 采用                        |
| **B（不推荐）**     | 仅在主进程用 `Promise.race([startThumbnailBatch, timeout])` 让链继续，不改 worker       | 改动最小                                                                               | worker 仍挂死继续跑，占 CPU/DB 连接；COMPLETE 晚到后链会二次推终态、状态错乱；**只解 UI 不解资源**     | 否决                        |
| **C（不推荐）**     | 在 worker 内为整个批次加单层整体超时（batch 级 watchdog）发送假 COMPLETE                | 主进程 pending 必 resolve，链路自然收尾                                                | 与 A-2 职责重叠；batch 超时无法区分「慢但正常」与「挂死」，大库易误杀；进度被截断                      | 仅作 A-2 的补充备选，非替代 |
| **D（不推荐）**     | 调高 `maxLowConcurrency`                                                                | 一行改动                                                                               | 不解决单文件挂死与整体无兜底；增加主进程/DB 并发压力，破坏「低优先级串行」设计初衷                     | 否决                        |
| **E（临时逃生口）** | 关闭 `autoScanOnStartup`                                                                | 瞬时缓解                                                                               | 只缓解不根治；损失产品功能                                                                             | 否决（仅应急）              |

**取舍说明**：

- A-1 的 `THUMBNAIL_PER_FILE_TIMEOUT_MS` 取 30s（不低于 `extractVideoFrame` 的 30s 内部上限）而非常规的 10s，避免误伤正常大视频抽帧；pHash 纯计算取 10s 对齐 SCENE 先例。
- A-2 取 10 分钟整体上限（用户建议值）。对大图库可能提前截断索引，但未处理记录在下一次启动的 `performStartupScan` / 手动触发路径会重跑，属可恢复的兜底行为，符合「兜底超时」定位。
- 优先级权衡：**健壮性优先**（遵循用户规则「如果难以兼顾，先保健壮」）——宁可截断并记 fault 日志，也不让 UI 无限假死。

---

## 4. 文件清单

| 文件                                                                                                                             | 改动                                                                                                                                                                                                 | 是否新增 |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [src/main/media-worker/worker-entry.ts](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/media-worker/worker-entry.ts)               | 新增 `withFileTimeout` 工具 + `THUMBNAIL_PER_FILE_TIMEOUT_MS` / `PHASH_PER_FILE_TIMEOUT_MS` 常量；`startThumbnailBatch` / `startPhashBatch` 逐文件重活包进 `withFileTimeout`，超时跳过并记 warn 日志 | 修改     |
| [src/main/app/startup-tasks.ts](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/app/startup-tasks.ts)                               | `runPostScanIndexing` 新增 `INDEXING_TOTAL_TIMEOUT_MS` watchdog（unref）+ `timedOut` 标志 + 幂等 `cleanup()` + abort 监听补 `stopDuplicateMark()`；finally 改调 `cleanup()`                          | 修改     |
| [src/main/app/**tests**/startup-tasks.test.ts](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/app/__tests__/startup-tasks.test.ts) | 新增 watchdog / 超时终态用例；补充 `stopDuplicateMark` mock                                                                                                                                          | 修改     |
| [src/main/media-worker/worker-entry.test.ts](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/media-worker/worker-entry.test.ts)     | 新增（当前无该测试文件）`withFileTimeout` 超时/正常/异常三条用例                                                                                                                                     | 新增     |

> 不改：`manager.ts` / `bridge.ts`（worker 崩溃合成 COMPLETE 兜底已存在）、`task-scheduler.ts`、`thumbnail-phash-service.ts`、`lifecycle.ts`、IPC / renderer。worker 协议无需扩展（超时是 worker 内部行为，不外发新事件）。

---

## 5. 测试影响

### 5.1 startup-tasks.test.ts（[src/main/app/**tests**/startup-tasks.test.ts](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/app/__tests__/startup-tasks.test.ts)）

现有用例通过 `makeMediaWorkerManager` 注入 mock（[L195-L208](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/app/__tests__/startup-tasks.test.ts#L195-L208)）。改动后：

- 现有 `performStartupScan` 用例 8 / 9 / 9b / 9c / 10 / 10b **不受影响**（A-3 不动此链路逻辑）。
- `makeMediaWorkerManager` 需补 `stopDuplicateMark: vi.fn()`（A-2 改动 2 新增调用）。
- **新增用例**：
  1. `startThumbnailBatch` 永不 resolve + 假定时器（`vi.useFakeTimers()`）推进到 `INDEXING_TOTAL_TIMEOUT_MS` → 断言推送 `phase='error'` 终态、`logger.error` 含「索引任务超过」、`stopThumbnailBatch` 与 `stopDuplicateMark` 被调用、`taskRegistry` 已清理。
  2. 超时后 `startThumbnailBatch` 才 resolve → 断言后续阶段被 `aborted` 跳过（`startPhashBatch` 未被调用）、finally 幂等（`cleanup()` 二次调用无副作用）。
  3. 用户取消（`taskRegistry.cancel(taskId)`）→ 终态为 `phase='cancelled'`，文案「已取消建立索引」（回归：不被 timedOut 误标）。
  > 注意 watchdog 用真实定时器会在用例间残留，需在 `afterEach` 中 `vi.useRealTimers()` 或保证每条用例走到 finally 清理。

### 5.2 worker-entry.test.ts（新增）

- `withFileTimeout` 正常完成 → 返回原结果。
- 内部 Promise 超时（`vi.useFakeTimers()` 推进超时时间）→ 返回 null 且 `workerLog('warn', ...)` 被调用（断言含「超时」）。
- 内部 Promise reject → 返回 null 且记录 warn（不向上抛）。

### 5.3 现有相关测试回归

- [manager.test.ts](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/media-worker/manager.test.ts)、[bridge.test.ts](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/media-worker/bridge.test.ts)：未改动，应保持全绿。
- [concurrency.test.ts](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/utils/concurrency.test.ts)：未改动。

---

## 6. 验证命令

```bash
# 主进程相关单测（含新增 watchdog / withFileTimeout 用例）
npx vitest run src/main/app/__tests__/startup-tasks.test.ts
npx vitest run src/main/media-worker/worker-entry.test.ts
npx vitest run src/main/media-worker/manager.test.ts src/main/media-worker/bridge.test.ts

# 主进程全量 + 渲染层全量
npm run test:main
npm run test:renderer

# 类型与规范
npm run typecheck
npm run lint
```

**手工验证（dev 模式）**：

1. 准备含 1 张损坏/超大图片的图库 → 启动应用 → 观察缩略图 / pHash 阶段不再卡死在某一文件，worker 日志出现「单文件处理超时…跳过」warn，批次正常推进。
2. 人为让 `mediaWorkerManager.startThumbnailBatch` 挂起（或注释 COMPLETE 合成）→ 10 分钟后索引浮窗强制进入「建立索引超时，已停止」，`logger.fault('indexingTimeout')` 落盘；取消路径仍显示「已取消建立索引」。
3. 启动后确认 `startup-integrity-check` / `startup-lru-enforce` / `startup-crash-cleanup` 在扫描完成后正常执行（低队列未被索引链占用）。

---

## 7. 回滚边界

- 影响面仅限 `worker-entry.ts`、`startup-tasks.ts` 及其测试；调度器、`manager.ts` / `bridge.ts`、IPC、`lifecycle.ts` 外部行为均不变。
- 回滚：`git checkout src/main/media-worker/worker-entry.ts src/main/app/startup-tasks.ts` 并删除新增测试文件即可恢复。
- 无 DB schema、无 worker 协议、无 IPC 协议变更；新常量均为模块内常量，不涉及设置项。

---

## 完成状态

> 归档日期：2026-08-17。索引系列（死锁 → 进度 → 超时解耦）三份计划已全部落地并通过测试。

| 计划             | 落地确认                                                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 死锁修复（解耦） | ✅ `startup-tasks.ts` 已改 `void runPostScanIndexing()` fire-and-forget，批次直接调 worker，不再经 `taskScheduler.enqueueLow` 二次入队 |
| 进度修复         | ✅ `ScanProgress.tsx` 已扩展 `ACCEPTED_TASK_TYPES=['scan','indexing','batch','duplicate']`，含 `indexingActive` 门控与终态清除收紧     |
| 超时兜底         | ✅ watchdog 超时测试存在于 `startup-tasks.test.ts`；单文件超时已含于 `worker-entry.ts`                                                 |

## 附 A：死锁根因摘要（合并自 fix-indexing-deadlock.md）

`maxLowConcurrency = 1` 下，外层 `startup-scan` 低优先级任务占满唯一并发槽位后，索引链内部又通过 `generateThumbnailsForUnprocessed('low')` / `generatePhashForUnprocessed('low')` 经 `enqueueLow` 二次入队并等待其 Promise——内层任务永不 `pump`，Promise 永不 resolve，`runPostScanIndexing` 卡在 `preparing`，UI 长期停留在「正在准备建立索引…」。

**采用方案**：索引链直接调 `mediaWorkerManager.startThumbnailBatch / startPhashBatch`（复刻互斥锁与 `media:updated` 广播），`performStartupScan` 扫描完即返回、索引链独立驱动——既消除自锁，又保留取消与进度上报能力。

**已否决方案**：fire-and-forget 不 await（丢进度上报，退回假死体验）；临时关闭自动扫描（只缓解不根治，损失产品功能）。

## 附 B：索引进度方案摘要（合并自 fix-indexing-progress.md）

**问题**：扫描后索引存在两套互不感知的进度体系——粗粒度 indexing 伞任务（整段吞掉、段末跳变）与 worker 逐张真实进度（`taskType='batch'/'duplicate'`），而浮窗过滤条件只认 `scan/indexing`，worker 真实进度被整段丢弃，大图库索引期间浮窗长期 0% 假死。

**采用方案**：浮窗过滤扩展至 `batch/duplicate`，worker 真实进度归一显示（自带 current/total/percent/eta，无需换算）；batch/duplicate 终态不触发浮窗清空（单阶段收尾，伞任务仍在运行）；`taskIdRef` 不被 batch/duplicate 覆盖（取消仍指向 indexing 伞任务）；仅在 `indexingActive` 时并入，防止与手动重复检测双浮窗冲突；`runPostScanIndexing` 移除段末粗粒度跳变推送。

**已否决方案**：主进程订阅 worker 进度后转发为 indexing（改动大、污染 taskType 语义、ETA 打架风险高）。
