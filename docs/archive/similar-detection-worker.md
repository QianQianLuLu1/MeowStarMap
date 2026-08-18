# 相似检测 pHash 聚类迁移到 media-worker（utilityProcess）实现计划

> 范围：`media:findSimilar` 的 O(n²) 汉明距离两两比对从主进程事件循环迁移到 `media-worker` utilityProcess。
> 本文档只描述方案与改动点，**不修改任何源码**（执行阶段见 `pre-packaging-audit.html` 的步骤 B 提示词）。

---

## 0. 关键结论（先读）

**最重要发现：worker 侧其实已经实现了相似检测的全部 CPU 密集逻辑，只是没有被接线。**

- `src/main/media-worker/worker-entry.ts` 已有 `startSimilarFind(dbPath, threshold)`（约 682 行），内部用 BK-tree（`buildAndSearch`，`bktree-index.ts`）做半径检索，把相似召回从 **O(n²) 降到约 O(n log n)**。
- `src/main/media-worker/worker-protocol.ts` 已定义完整消息协议：`SIMILAR_FIND_START` / `SIMILAR_PROGRESS` / `SIMILAR_CANDIDATES` / `SIMILAR_COMPLETE` / `SIMILAR_ERROR` / `SIMILAR_STOP`。
- `MediaWorkerBridge`（`bridge.ts`）已暴露 `startSimilarFind()` / `stopSimilarFind()` / `onEvent()`。
- `bktree-index.ts` 的注释明确写着：**"边以 media id 表示，主进程据 id 映射回行索引做 Union-Find"** —— 即原始设计就是要主进程消费候选边、做聚合。

**因此本次迁移 = "接线"，而不是"重写算法"。** 只需：

1. 在 `MediaWorkerManager` 暴露 `startSimilarFind()`（复用现有 TaskRegistry + 进度 + 取消机制）。
2. 重写 `similar-handler.ts` 的 `media:findSimilar`：派发任务 → 消费 `SIMILAR_CANDIDATES` + `SIMILAR_COMPLETE` → 仅做 **O(E·α(N))** 的 Union-Find 轻量聚合。
3. `MediaRepository` 增加 2 个轻量查询（`getPhashCount` / `getPhashStaleSample`），使主进程不再全量载入 pHash 行。

**worker-entry.ts / worker-protocol.ts 不需要改动**（已有实现完全够用，改动属于无意义 churn，违反"不要重新设计"约束）。

---

## 1. 现状与瓶颈量化

### 1.1 现状代码路径

`src/main/ipc/handlers/similar-handler.ts` 的 `media:findSimilar` 处理器（约 96–291 行）：

- **102 行**：`const rows = getRepo().getPhashRows()` —— 一次性把**全部** pHash 行（含 64 字符的 `phash` 字符串）载入主进程堆。
- **188–220 行**：嵌套 `for` 循环对每对 `(i, j)` 调 `hammingDistance(rows[i].phash, rows[j].phash)` 做 Union-Find 聚类。
- 比较总次数 = `n*(n-1)/2`（O(n²)）。

### 1.2 瓶颈量化（主线程阻塞）

| 图库规模 n | 比较总对数 n(n-1)/2 | 纯 JS `hammingDistance` 估算耗时* | 主进程事件循环            |
| ---------- | ------------------- | --------------------------------- | ------------------------- |
| 1,000      | ~5×10⁵              | < 50 ms                           | 轻微卡顿                  |
| 5,000      | ~1.25×10⁷           | ~0.5–1.5 s                        | 明显冻结                  |
| 10,000     | ~5×10⁷              | ~2–8 s（含 GC/字符串解析）        | **界面长时间冻结**        |
| 50,000     | ~1.25×10⁹           | 数十秒级                          | **完全无响应 / 可能崩溃** |

\* `hammingDistance` 是逐字符 `for` 循环（见 `utils/phash.ts` 129–136 行），每次比较约 64 次字符比较 + 长度检查；10k 张约 5 千万次调用，完全占用主进程事件循环，期间无法处理任何 IPC / 渲染 / 定时器，UI 假死。

### 1.3 内存峰值（OOM 风险）

- 主进程同时持有：
  - 全部 pHash 行对象（n 条 `PhashRow`，每条含 64-char `phash` + 多字段）→ 10k 张约 3–5 MB，50k+ 张可达数十 MB 且随对象开销放大；
  - `Int32Array(rows.length)` 并查集；
  - 比较过程中的中间变量。
- 这些本应隔离在 worker 进程堆中（崩溃也只杀 worker，不炸主进程）。当前却全堆在主进程。

### 1.4 不一致性

scanner / 缩略图 / pHash 补算 / 重复标记均已卸载到 `media-worker`（utilityProcess），唯独相似检测的聚类留在主进程 —— 与全局架构不一致，也正是本任务要补齐的一环。

---

## 2. 目标

- **主进程只负责**：解析参数（阈值透传）、派发 `SIMILAR_FIND_START`、转发进度（task:progress）、接收候选边 + 行元数据、做轻量 Union-Find 聚合、支持 `task:cancel`。
- **media-worker 负责**：读取已落库 pHash、BK-tree 半径检索生成候选边（替代 O(n²)）、回传进度/候选/完成。
- 主进程不再执行任何 O(n²) 汉明比较；不再全量持有 pHash 行。
- 对外 IPC 返回结构（`success / duplicates / bestItemIds / totalGroups / totalFiles / wastedBytes / scannedFiles / threshold / hashedFiles / cancelled`）**保持完全不变**，渲染端零改动。

---

## 3. 复用现有 media-worker / utilityProcess 通信接口设计

> 全部消息名、字段均为**已存在**协议，执行阶段只调用、不新增。

### 3.1 主进程 → worker（命令，`MediaWorkerCommand`）

```ts
// 已在 worker-protocol.ts 定义，无需新增
{
  type: 'SIMILAR_FIND_START'
  payload: {
    dbPath: string
    threshold: number
  }
}
{
  type: 'SIMILAR_STOP'
} // 取消
```

- `threshold`：0–64 整数，主进程直接从 `media:findSimilar` 的 `options.threshold` 透传（默认 5）。
- `dbPath`：由 `MediaWorkerManager` 内部 `this.dbPath` 提供（Application 在 `dbManager.initialize` 后调用 `manager.setDbPath(dbPath)` 注入），handler 不必传。

### 3.2 worker → 主进程（事件，`MediaWorkerEvent`）

| 事件                 | 触发时机                          | payload                                                                                | 主进程处理                                                 |
| -------------------- | --------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `SIMILAR_PROGRESS`   | 每扫描一条 / 每批候选             | `{ scanned: number; total: number; candidates: number }`                               | 转 task:progress（节流到 ~5 FPS）                          |
| `SIMILAR_CANDIDATES` | BK-tree 命中候选（每批 ≤5000 条） | `{ batch: Array<{ a: number; b: number; dist: number }> }`                             | 累积候选边（a/b 为 media id，a<b）                         |
| `SIMILAR_COMPLETE`   | 检索结束（含取消/空库）           | `{ success; message; rows: SimilarRowMeta[]; totalCandidates; totalRows; cancelled? }` | resolve 派发 Promise，主进程据此聚合                       |
| `SIMILAR_ERROR`      | worker 内捕获异常                 | `{ message; stack? }`                                                                  | 日志；终态由随后 `SIMILAR_COMPLETE` 或 bridge 崩溃合成兜底 |

- `SimilarRowMeta`（已在 `worker-protocol.ts` 19–30 行定义）：`{ id, file_path, file_name, file_type, file_size, modified_at, width, height, is_favorite, rating }` —— **不含 phash 本体**，体积可控。
- `SimilarCandidate`（已在 `bktree-index.ts` 21–25 行定义）：`{ a, b, dist }`。

### 3.3 进度回调

- 复用 `MediaWorkerManager` 既有的 `ProgressThrottle(200)` + `EtaCalculator(10)` + `taskRegistry`，通过 `task:progress` 通道推送给渲染端（与 thumbnail/phash/duplicate 完全一致）。
- handler **不再**自行持有 `ProgressThrottle` / `EtaCalculator` / `taskRegistry`（全部委托给 manager）。

### 3.4 取消机制 `task:cancel`

链路（已存在，无需新建）：

```
渲染端 electronAPI.task.cancel(taskId)
  → IPC 'task:cancel'（src/main/ipc/handlers/task-handler.ts）
    → taskRegistry.cancel(taskId)  // 触发 AbortController.abort()
      → manager 的 abort 监听器（registerTask 内）
        → 立即推送 phase:'cancelled' 终态 + 调用 bridge.stopSimilarFind()
          → worker 收到 SIMILAR_STOP → shouldStopSimilar=true
            → buildAndSearch 尽快 return（cancelled:true）
              → worker 发 SIMILAR_COMPLETE { cancelled:true }
                → manager resolve（cancelled:true）→ handler 返回空结果
```

- `MediaWorkerManager.registerTask()` 已封装上述 abort 监听 + stopFn 转发（见 `manager.ts` 250–282 行），新增的 `startSimilarFind` 直接复用。

---

## 4. 改动文件清单

| #   | 文件                                            | 改动性质                                                                         | 说明                                                                             |
| --- | ----------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| A   | `src/main/ipc/handlers/similar-handler.ts`      | **重写** `media:findSimilar` + 改 `maybeTriggerPhashStaleCheck` 签名             | 删除 O(n²) 循环与全量 `getPhashRows`；改为派发 + 消费事件 + Union-Find 聚合      |
| B   | `src/main/media-worker/manager.ts`              | **新增** `startSimilarFind()` + 字段 + `subscribeBridgeEvents` 增加 SIMILAR 分支 | 暴露相似检测任务入口，复用 TaskRegistry/进度/取消                                |
| C   | `src/main/database/media-repository.ts`         | **新增** `getPhashCount()` + `getPhashStaleSample(size)`                         | 主进程用轻量查询替代全量载入                                                     |
| D   | `src/main/media-worker/worker-entry.ts`         | **不改**（已具备）                                                               | 已正确实现 BK-tree 召回 + 候选/完成事件                                          |
| E   | `src/main/media-worker/worker-protocol.ts`      | **不改**（已具备）                                                               | 协议已完整；仅需在文档层面确认                                                   |
| F   | `src/main/ipc/handlers/similar-handler.test.ts` | **新增**（或迁移 `media.test.ts` 中 findSimilar 用例）                           | 用 mock `mediaWorkerManager` 覆盖阈值/分组/取消                                  |
| —   | `src/main/ipc/handler-context.ts`               | 不改                                                                             | `ctx.mediaWorkerManager: MediaWorkerManager` 已存在                              |
| —   | `src/shared/types/progress.ts`（TaskType）      | 不改                                                                             | 相似任务进度复用 `'duplicate'`（文案足够；如需区分可后续加 `'similar'`，非必须） |
| —   | 渲染端 / preload                                | 不改                                                                             | `task:cancel` / `task:progress` 通道已通用                                       |

---

## 5. 分步实现步骤

### Step 1 — `MediaRepository` 新增 2 个轻量查询

位置：在 `getPhashRows()`（约 `media-repository.ts` 中 `getPhashRows()` 方法之后）追加。

```ts
/** 已落库 pHash 行数（快速路径判断空库，避免全量载入） */
getPhashCount(): number {
  const row = this.db
    .prepare(
      `SELECT COUNT(*) AS c FROM media_files
       WHERE is_deleted = 0 AND phash IS NOT NULL AND phash != ''`
    )
    .get() as { c: number }
  return row.c
}

/**
 * R7 stale 检测用的轻量采样：仅取 file_path / phash_mtime / phash_file_size，
 * 不取 phash 本体，避免主进程持有全部 pHash 字符串。
 * 用 ROW_NUMBER 取均匀间隔的 sampleSize 行（覆盖头/中/尾）。
 */
getPhashStaleSample(sampleSize: number): Array<{
  id: number
  file_path: string
  phash_mtime: number | null
  phash_file_size: number | null
}> {
  return this.db
    .prepare(
      `WITH ranked AS (
         SELECT id, file_path, phash_mtime, phash_file_size,
                ROW_NUMBER() OVER (ORDER BY id) - 1 AS rn
         FROM media_files
         WHERE is_deleted = 0 AND phash IS NOT NULL AND phash != ''
       )
       SELECT id, file_path, phash_mtime, phash_file_size
       FROM ranked
       WHERE rn % ? = 0
       LIMIT ?`
    )
    .all(Math.max(1, Math.floor((this.getPhashCount() || 1) / Math.max(1, sampleSize))), sampleSize) as Array<{
      id: number; file_path: string; phash_mtime: number | null; phash_file_size: number | null
    }>
}
```

> 若 SQLite 版本不支持窗口函数（极老），回退为：主进程 `getPhashRows()` 后只取 3 个字段并采样（但此路径会重新全量载入，仅作兜底；生产 SQLite 均支持窗口函数）。

### Step 2 — `MediaWorkerManager` 暴露 `startSimilarFind`

#### 2.1 新增字段（在 `manager.ts` 的 `duplicateRuntime` 字段附近，约 96 行后）

```ts
import type { SimilarRowMeta } from './worker-protocol'
import type { SimilarCandidate } from './bktree-index'

// 新增：相似检测运行标志 + pending resolver + 候选累积
private isSimilarRunning = false
private similarRuntime: TaskRuntime = createTaskRuntime()
private pendingSimilarComplete:
  | ((result: {
      success: boolean
      message: string
      cancelled: boolean
      rows: SimilarRowMeta[]
      candidates: SimilarCandidate[]
    }) => void)
  | null = null
private pendingSimilarCandidates: SimilarCandidate[] = []
```

#### 2.2 `subscribeBridgeEvents()` 的 switch 增加 SIMILAR 分支

在 `case 'DUPLICATE_COMPLETE':` 之后追加：

```ts
case 'SIMILAR_PROGRESS':
  this.emit('similar:progress', { ...event.payload })
  this.handleProgress(
    this.similarRuntime,
    'duplicate',                       // 复用现有 TaskType（如需区分 UI 可加 'similar'）
    event.payload.scanned,
    event.payload.total,
    `比较图像相似度 ${event.payload.scanned}/${event.payload.total}`
  )
  break
case 'SIMILAR_CANDIDATES':
  this.emit('similar:candidates', event.payload)
  if (this.pendingSimilarCandidates) this.pendingSimilarCandidates.push(...event.payload.batch)
  break
case 'SIMILAR_COMPLETE':
  this.isSimilarRunning = false
  this.emit('similar:complete', event.payload)
  if (this.pendingSimilarComplete) {
    const resolve = this.pendingSimilarComplete
    this.pendingSimilarComplete = null
    resolve({
      success: event.payload.success,
      message: event.payload.message,
      cancelled: !!event.payload.cancelled,
      rows: event.payload.rows,
      candidates: this.pendingSimilarCandidates
    })
    this.pendingSimilarCandidates = []
  }
  this.handleComplete(this.similarRuntime, event.payload.success, event.payload.message)
  break
case 'SIMILAR_ERROR':
  this.emit('similar:error', event.payload)
  // 终态由随后到达的 SIMILAR_COMPLETE 或 bridge 崩溃合成兜底，此处不 resolve
  break
```

#### 2.3 新增公开方法（仿 `startDuplicateMark` 写法）

```ts
/**
 * 启动相似检测：派发 SIMILAR_FIND_START 到 worker，
 * 累积 SIMILAR_CANDIDATES 候选边，SIMILAR_COMPLETE 时 resolve 行 + 候选。
 * 复用 TaskRegistry + 进度节流 + task:cancel（取消 → bridge.stopSimilarFind）。
 */
async startSimilarFind(params: { threshold: number }): Promise<{
  success: boolean
  message: string
  cancelled: boolean
  rows: SimilarRowMeta[]
  candidates: SimilarCandidate[]
}> {
  if (this.isSimilarRunning) {
    return { success: false, message: '相似检测已在进行中', cancelled: false, rows: [], candidates: [] }
  }
  if (!this.dbPath) {
    return { success: false, message: '数据库路径未初始化', cancelled: false, rows: [], candidates: [] }
  }
  this.isSimilarRunning = true
  this.registerTask(this.similarRuntime, 'duplicate', '相似检测已取消', () =>
    this.bridge.stopSimilarFind()
  )

  return new Promise((resolve) => {
    this.pendingSimilarCandidates = []
    this.pendingSimilarComplete = resolve
    this.bridge.startSimilarFind(this.dbPath, params.threshold).catch((err) => {
      if (this.pendingSimilarComplete) {
        const r = this.pendingSimilarComplete
        this.pendingSimilarComplete = null
        this.isSimilarRunning = false
        r({
          success: false,
          message: `相似检测启动失败: ${err instanceof Error ? err.message : String(err)}`,
          cancelled: false,
          rows: [],
          candidates: []
        })
      }
      if (this.similarRuntime.taskId) {
        taskRegistry.unregister(this.similarRuntime.taskId)
        this.similarRuntime.taskId = null
        this.similarRuntime.progressThrottle.dispose()
      }
    })
  })
}

/** 取消相似检测（向后兼容；task:cancel 通道也会触发） */
stopSimilarFind(): void {
  this.bridge.stopSimilarFind()
}
```

> 注意：`stopSimilarFind()` 在 `MediaWorkerBridge` 已存在；manager 这层薄壳与另外三个 `*Stop` 方法保持一致。

### Step 3 — 重写 `similar-handler.ts` 的 `media:findSimilar`

**删除**：`hammingDistance` 导入（第 7 行）、`taskRegistry`/`ProgressThrottle`/`EtaCalculator` 导入（11–13 行）、`getRepo().getPhashRows()` 调用（102 行）、O(n²) 循环（188–220 行）、handler 内自建的 `pushProgress`/`pushTerminal`/TaskRegistry 注册（124–162、284–288 行）。
**保留**：`pickBestId` 导入（分组用）、`generatePhashForUnprocessed` 导入（stale 衔接）、`getRepo` 闭包、`AppError`/`z`/`fsp`。

新处理器骨架：

```ts
ipcMain.handle(
  'media:findSimilar',
  wrapHandler(
    ctx,
    z.tuple([z.object({ threshold: z.number().int().min(0).max(64).optional() }).optional()]),
    async ([options]) => {
      const threshold = options?.threshold ?? 5
      const repo = getRepo()

      // 快速路径：空库直接返回（避免起 worker）
      const count = repo.getPhashCount()
      if (count < 2) {
        return {
          success: true,
          duplicates: [],
          bestItemIds: [],
          totalGroups: 0,
          totalFiles: 0,
          wastedBytes: 0,
          scannedFiles: count,
          threshold,
          hashedFiles: count
        }
      }

      // R7：stale 检测仍 fire-and-forget（改走轻量采样，见 Step 4）
      void maybeTriggerPhashStaleCheck(ctx, getRepo).catch(() => {})

      // 派发到 worker，主进程只做轻量聚合
      const res = await ctx.mediaWorkerManager.startSimilarFind({ threshold })

      if (!res.success) {
        return {
          success: false,
          message: res.message,
          duplicates: [],
          bestItemIds: [],
          totalGroups: 0,
          totalFiles: 0,
          wastedBytes: 0,
          scannedFiles: count,
          threshold,
          hashedFiles: count
        }
      }

      // 取消：返回空结果（终态 cancelled 已由 manager 推送）
      if (res.cancelled) {
        return {
          success: true,
          duplicates: [],
          bestItemIds: [],
          totalGroups: 0,
          totalFiles: 0,
          wastedBytes: 0,
          scannedFiles: res.rows.length,
          threshold,
          hashedFiles: res.rows.length,
          cancelled: true
        }
      }

      // —— 轻量聚合：O(E·α(N)) Union-Find（E = 候选边数，远低于 n²）——
      const rows = res.rows
      const idToIndex = new Map<number, number>()
      rows.forEach((r, i) => idToIndex.set(r.id, i))

      const parent = new Int32Array(rows.length)
      for (let i = 0; i < rows.length; i++) parent[i] = i
      const find = (x: number): number => {
        while (parent[x] !== x) {
          parent[x] = parent[parent[x]]
          x = parent[x]
        }
        return x
      }
      const union = (a: number, b: number): void => {
        const ra = find(a)
        const rb = find(b)
        if (ra !== rb) parent[ra] = rb
      }
      for (const { a, b } of res.candidates) {
        const ia = idToIndex.get(a)
        const ib = idToIndex.get(b)
        if (ia === undefined || ib === undefined) continue
        union(ia, ib)
      }

      // 分组 + 排序（与现 223–283 行逻辑一致，数据源由 rows 替代 getPhashRows 结果）
      const groupMap = new Map<number, number[]>()
      for (let i = 0; i < rows.length; i++) {
        const root = find(i)
        if (!groupMap.has(root)) groupMap.set(root, [])
        groupMap.get(root)!.push(i)
      }

      const similarGroups: SimilarRowMeta[][] = []
      let totalFiles = 0
      let wastedBytes = 0
      for (const indices of groupMap.values()) {
        if (indices.length < 2) continue
        const groupRows = indices.map((i) => rows[i])
        groupRows.sort(
          (a, b) => new Date(b.modified_at).getTime() - new Date(a.modified_at).getTime()
        )
        similarGroups.push(groupRows)
        totalFiles += groupRows.length
        const minSize = Math.min(...groupRows.map((r) => r.file_size))
        wastedBytes += minSize * (groupRows.length - 1)
      }
      similarGroups.sort((a, b) => {
        const wa = Math.min(...a.map((r) => r.file_size)) * (a.length - 1)
        const wb = Math.min(...b.map((r) => r.file_size)) * (b.length - 1)
        return wb - wa
      })

      const result = similarGroups.map((group) => {
        const items = group.map((r) => ({
          id: r.id,
          file_path: r.file_path,
          file_name: r.file_name,
          file_type: r.file_type,
          file_size: r.file_size,
          modified_at: r.modified_at,
          width: r.width,
          height: r.height,
          is_favorite: Boolean(r.is_favorite),
          rating: r.rating
        }))
        return { items, bestItemId: pickBestId(items) }
      })

      return {
        success: true,
        duplicates: result.map((g) => g.items),
        bestItemIds: result.map((g) => g.bestItemId),
        totalGroups: similarGroups.length,
        totalFiles,
        wastedBytes,
        scannedFiles: rows.length,
        threshold,
        hashedFiles: rows.length
      }
    }
  )
)
```

> 说明：聚合阶段为 O(E·α(N))，E 为候选边数（threshold 越小 E 越小，远小于 n²），对 10k 张图通常在毫秒级完成，主进程事件循环不再被阻塞。

### Step 4 — `maybeTriggerPhashStaleCheck` 衔接（避免主进程全量载入）

改签名：去掉 `rows` 入参，改为接收 `getRepo` 闭包，内部走轻量采样。

```ts
// 原：async function maybeTriggerPhashStaleCheck(ctx, rows: Array<...>)
// 新：
async function maybeTriggerPhashStaleCheck(
  ctx: HandlerContext,
  getRepo: () => MediaRepository
): Promise<void> {
  const now = Date.now()
  if (now - lastPhashStaleCheckAt < PHASH_STALE_CHECK_INTERVAL_MS) return
  lastPhashStaleCheckAt = now

  // 轻量采样：只取 file_path/phash_mtime/phash_file_size，不取 phash
  const sample = getRepo().getPhashStaleSample(PHASH_STALE_CHECK_SAMPLE_SIZE)
  if (sample.length === 0) return

  let staleFound = false
  for (const row of sample) {
    if (row.phash_mtime === null || row.phash_file_size === null) {
      staleFound = true
      break
    }
    try {
      const stat = await fsp.stat(row.file_path)
      if (Math.floor(stat.mtimeMs) !== row.phash_mtime || stat.size !== row.phash_file_size) {
        staleFound = true
        break
      }
    } catch {
      /* 文件可能被删除/移动，由 is_missing 流程处理 */
    }
  }

  if (staleFound) {
    void generatePhashForUnprocessed(ctx, 'low').catch(() => {})
  }
}
```

> 调用点（原 105 行 `void maybeTriggerPhashStaleCheck(ctx, rows)...`）改为 `void maybeTriggerPhashStaleCheck(ctx, getRepo).catch(() => {})`。
> 注意：`generatePhashForUnprocessed(ctx, 'low')` 会向同一个 `media-worker` 派发 `PHASH_BATCH_START`。若相似检测正在进行，`PHASH_BATCH_START` 会在 worker 消息队列中排在 `SIMILAR_FIND_START` 之后（worker 单消息顺序处理），不会并发冲突；属低频（5 分钟节流）且 fire-and-forget，可接受。

### Step 5 — 编译 / 类型对齐

- 确认 `MediaWorkerManager` 新方法的返回类型被 `similar-handler.ts` 正确消费。
- 确认 `SimilarCandidate` / `SimilarRowMeta` 从正确模块导入（manager 从 `./worker-protocol` + `./bktree-index`；handler 不需要直接导入 `SimilarCandidate`，只用 `res.candidates`）。
- `wrapHandler` / `z` 链路保持不变。

### Step 6 — 测试（见第 7 节）

---

## 6. pHash 算法禁令（硬性约束）

**本迁移不重新实现、也不引入任何 pHash / DCT 算法。**

- 聚类只依赖**已落库**的 pHash（由 `getPhashRows` 读出的 `phash` 字段，worker 内 `startSimilarFind` 直接 `SELECT ... phash ...`）。
- 相似召回用 `bktree-js.ts` 的 BK-tree + 既有 `hammingDistance`（`utils/phash.ts`，纯汉明距离，非 DCT）。
- 主进程聚合用标准 Union-Find（无哈希计算）。

因此 **blockhash-js / imghash 在本次迁移中不需要安装或引用**。它们仅在"将来要（重新）生成 pHash"时才作为 sanctioned 来源（见 `pre-packaging-audit.html` OSS 章节）；本任务范围不含 pHash 生成，故不引入第三方依赖，避免无意义体积与 ABI 风险。

> 若执行阶段误以为需要重算 pHash：请不要这么做。worker 已读存好 pHash；如需重算也只允许用 blockhash-js / imghash 替代手写 DCT，但那属于独立任务。

---

## 7. 风险与验证

### 7.1 风险点

| 风险                            | 说明                                                           | 缓解                                                                                    |
| ------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 渲染端 `taskType` 文案          | 相似任务进度复用 `'duplicate'`                                 | 文案可接受；如需区分可在 `progress.ts` 加 `'similar'`（非必须）                         |
| 取消时 worker 仍回传全部 `rows` | 取消路径 `SIMILAR_COMPLETE.cancelled=true` 仍带 `rows`（体积） | handler 在 `cancelled` 时直接忽略 `rows` 返回空集；可选优化：worker 取消时回传空 `rows` |
| `SIMILAR_COMPLETE` 字段         | `bridge.test.ts` 若断言精确 payload 需小幅更新                 | 仅新增/扩展字段，向后兼容；必要时同步改测试                                             |
| 并发 pHash 重算                 | stale 检测 fire-and-forget 派 `PHASH_BATCH_START`              | worker 单消息顺序处理，排队在相似检测后，无冲突                                         |
| 阈值语义一致                    | 主进程默认 5，worker `buildAndSearch` 用同样 `threshold`       | 透传即可，无需转换                                                                      |
| 结果排序/分组回归               | 聚合逻辑由 `rows` 替代 `getPhashRows` 结果                     | 字段集一致（均含 id/path/.../file_size/modified_at），行为等价                          |

### 7.2 验证命令

```bash
# 1) 类型检查（全量构建）
npx tsc -b

# 2) 相似检测 handler 单测（新增 similar-handler.test.ts，mock mediaWorkerManager.startSimilarFind）
#    - 阈值透传：传 { threshold: 10 } → manager 收到 threshold=10
#    - 空库快速路径：getPhashCount()<2 → 返回 totalGroups=0
#    - 分组正确：mock 返回 2 条候选边 + 2 行 → 聚成 1 组
#    - 取消：mock 返回 cancelled:true → 返回 cancelled:true 空集
vitest run src/main/ipc/handlers/similar-handler

# 3) worker 侧 BK-tree 召回仍正确（既有，确保未回归）
vitest run src/main/media-worker

# 4) 全量回归（可选）
vitest run
```

- **新增测试文件**：`src/main/ipc/handlers/similar-handler.test.ts`。可将 `media.test.ts` 中 `describe('media:findSimilar'...)` 的 3 个用例（空库 / 阈值透传 / 距离≤threshold 聚类成组）迁移至此，mock `ctx.mediaWorkerManager` 使其 `startSimilarFind` 返回构造的 `{ success, rows, candidates }`。保留 `media.test.ts` 其余用例不变。

### 7.3 手动大库压测（必做）

1. 构造 ≈ 10,000 张已算 pHash 的图库（可用 `media:generatePhash` 或导入样本）。
2. 主进程启动后，触发 `media:findSimilar`，同时持续拖动窗口 / 点击其他 UI。
3. 验收：
   - 窗口/UI **不冻结**（事件循环被 worker 占用，主进程仅做轻量聚合）。
   - `task:progress` 进度条正常推进、可点取消（`task:cancel`）即时中断。
   - 10k 张总耗时从原来的秒级冻结下降到 BK-tree 召回（worker 内）+ 毫秒级聚合；内存峰值从主进程数 MB 降至仅候选边 + 分组（worker 堆隔离）。
4. 对照 `pre-packaging-audit.html` 中该 MED 级问题的验收标准。

---

## 8. 执行阶段一句话指引

> 严格按本文档接线：**只在 `similar-handler.ts` / `media-worker/manager.ts` / `media-repository.ts` 改动；不要碰 `worker-entry.ts` / `worker-protocol.ts` 的算法；不要引入 blockhash-js / imghash；不要在主进程写任何 O(n²) 或 DCT。**
