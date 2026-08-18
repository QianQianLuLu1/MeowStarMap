# 启动性能优化：integrity_check 分级 + 冷启动负担 — 调研与实施计划

> **范围**：仅调研 + 计划，不改动任何业务源码。本文档供决策与后续实施使用。
> **主文件**：`src/main/database/connection.ts`、`src/main/app/lifecycle.ts`、`src/main/app/cleanup.ts`、`src/main/scheduler/task-scheduler.ts`、`src/main/utils/startup-diagnostic.ts`
> **目标**：把每次启动同步整库 `PRAGMA integrity_check`（大库可达秒级、阻塞主进程）降级为「毫秒级 quick_check 快速路径 + 异常退出标志触发全量自检」，并缓解 `autoScanOnStartup` 的冷启动负担，同时保持「启动即发现损坏」的保底能力。

---

## 0. 现状结论（代码实测）

### 0.1 integrity_check 全量自检阻塞启动

[connection.ts](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/database/connection.ts#L151-L165) 的 `initialize()` 在 `PRAGMA` 设置前、迁移前，同步执行一次整库完整性校验：

```ts
const integrityResult = this.runIntegrityCheck()   // connection.ts:154，同步、阻塞
if (!integrityResult.ok) { await this.attemptRecovery(...) }
```

[runIntegrityCheck()](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/database/connection.ts#L220-L236) 调用 `this.db.pragma('integrity_check', { simple: true })`，这是 better-sqlite3 的**同步**操作，在大库上扫描全部分页/B-tree，可达数百毫秒到数秒，直接阻塞主进程事件循环，位于启动关键路径（阶段 1）最前。

关键点：注释已自述「integrity_check 在大库上耗时几百毫秒」——实际大库更高；且它**每次启动都跑**，无论上次是否干净退出。

### 0.2 已有 quick_check 先例

代码库已有一处使用 `quick_check` 的先例：[isDatabaseUsable()](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/database/connection.ts#L534-L541)，用于迁移失败后判断「要不要回滚到备份」。SQLite 官方文档：`quick_check` 跳过部分深层校验（如部分索引页一致性），但速度远快于 `integrity_check`，通常能抓住绝大多数损坏。

### 0.3 「干净退出」尚无持久化标志

现状没有任何跨启动的「上次是否干净退出」持久化信号：

- [startup-diagnostic.ts](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/utils/startup-diagnostic.ts) 只写 `diag.log` / `startup-errors.log` 文本日志，不参与决策。
- `app_settings` 表（key-value，可读写，见 `getSetting/setSetting`，connection.ts:1381-1433）可作为持久化介质，但**依赖 DB 可读**，DB 损坏时读不到——不适合单独作为损坏探测信号。
- 优雅退出的唯一可靠落点是 [performCleanup()](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/app/cleanup.ts#L128-L133) 中 `ctx.dbManager.close()`（含 WAL checkpoint）成功执行；崩溃/强杀/断电/超时强制退出（lifecycle.ts:456-487 的 `force-exit-timeout`）都到不了这一步。

### 0.4 autoScanOnStartup 已部分降级，但链式负担仍在

[lifecycle.ts](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/app/lifecycle.ts#L392-L429) 中 `autoScanOnStartup` 默认 `true`（:392），启动后依次安排：

| 任务                                                            | 延迟                          | 队列          |
| --------------------------------------------------------------- | ----------------------------- | ------------- |
| 自动扫描 `performStartupScan`（enqueueLow，仅当 autoScan=true） | `STARTUP_SCAN_DELAY_MS`(1500) | low           |
| LRU 强制校准 `enforceLimitNow`                                  | +5000                         | low           |
| 崩溃文件清理 `enforceCrashLimit`                                | +6000                         | low           |
| 自动更新检查 `checkForUpdates`                                  | +8000                         | 裸 setTimeout |

即「3~8s 冷启动负担」来自：窗口出现后 ~1.5s 启动全盘/增量扫描 → 扫描后链式触发缩略图/pHash/场景分析（`runPostScanIndexing`，可能数分钟）→ ~6.5s LRU → ~9.5s 更新检查。其中扫描**已经**走了 `enqueueLow` 低优先级队列且延迟 1500ms，说明框架已具备降级手段，只是默认延迟仍偏短、且 autoScan 默认开着。

### 0.5 TaskScheduler 分级能力

[task-scheduler.ts](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/scheduler/task-scheduler.ts) 提供：

- `enqueueLow`：FIFO 入队，`maxLowConcurrency=1` 串行，启动期 `paused` 直到主窗口 `ready-to-show` 后 `resume()`。
- 高优先级 `runHighPriority` 会抢占/取消低优先级任务（`preemptRunningLow` + `cancel()` 回调），最多等 `PREEMPT_WAIT_MS=2000ms`。
- 退出时 `pause()` + `cancelAllLow()` 清理（cleanup.ts:48-50）。

> 注意：**同步 PRAGMA 无法被 cancel() 中断**——抢占只能「等它跑完」，不能中途打断。

---

## 1. 自检分级方案（quick_check 快速路径 + 干净退出标志）

### 1.1 核心思路

**每次启动同步跑 `quick_check`（毫秒级）作为快速路径**；只有当：

- `quick_check` 失败，**或**
- 检测到「上次非干净退出」标志（异常退出标志）

时才执行全量 `integrity_check`。快速路径通过 → 直接跳过全量自检，启动不被秒级阻塞。

### 1.2 「干净退出」标志：选型与落点

两种候选：

| 方案                              | 介质                               | 优点                                                                          | 缺点                                                |
| --------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------- |
| A. 侧车文件 `{dbPath}.clean-exit` | userData/database 目录下独立小文件 | **不依赖 DB 可读**，DB 损坏时仍能读取；与 startup-diagnostic 的文件式思路一致 | 需自行管理写入/删除；首次启动无标志                 |
| B. `app_settings.cleanExit=true`  | DB 表                              | 复用现有 getSetting/setSetting                                                | DB 损坏时读不到，恰好是我们要探测的场景，需另加兜底 |

**推荐 A（侧车文件）**，理由：损坏探测信号本身必须在 DB 不可读时仍可用。写入位置：

- **写入**：`performCleanup` 中 `ctx.dbManager.close()` **成功返回后**调用新增的 `markCleanExit()`（connection.ts 提供方法，写入 `{dbPath}.clean-exit`）。崩溃/强杀/断电/超时强制退出（app.exit(1)）都走不到这一步 → 标志不写 → 下次启动判定为「上次非干净退出」。
- **读取/判定**：`initialize()` 打开 DB 后，`fs.existsSync(marker)` 判断。
- 首次启动（无 DB 或全新 DB）：标志不存在 → 走全量检查。此时库为空/新库，全量检查毫秒级完成，可接受；也可在首次 `initialize()` 成功末尾补写一次标志，避免首启全量（见 5. 步骤 1 的可选优化）。

### 1.3 判定逻辑（initialize 内同步快速路径）

```
打开 db（自动应用 WAL 恢复）
result = PRAGMA quick_check            // 同步，毫秒级，快速路径
if result !== ok:
    → 同步跑全量 integrity_check + attemptRecovery（保持现状「启动即发现损坏」）
elif !exists(cleanExitMarker):
    → 由 lifecycle 将全量 integrity_check 入低优先级队列后台执行（见 §2）
    → 异常退出标志仍在快速路径被识别，触发全量自检（保底）
else:
    → 快速路径通过 + 上次干净退出 → 跳过全量自检（最常见的启动路径，毫秒级）
```

要点：

- `quick_check` 永远同步跑（不阻塞太久），是**兜底安全网**——即使标志逻辑漏判，quick_check 仍能抓住大多数损坏。
- 全量 `integrity_check` 只在该两种条件下出现，从「每次启动」降到「异常场景」。

---

## 2. 全量自检是否放入 `taskScheduler.enqueueLow` 后台队列

### 2.1 可行性：可行，但需注意「阻塞并未消除，只是延后」

- 调度器已成熟，启动扫描/LRU/崩溃清理都在用 `enqueueLow`，加入一个 `startup-integrity-check` 低优先级任务模式一致。
- `integrity_check` 是 better-sqlite3 **同步**操作，放低优先级队列**并不能消除主进程阻塞**——它只是在窗口出现后某个时刻才跑，把「启动时卡顿」换成「运行中短暂的同步停顿」。
- 调度器 `maxLowConcurrency=1`，后台自检会与启动扫描（同为 low）FIFO 串行；高优先级用户操作会抢占并尝试 cancel，但同步 PRAGMA 不可中断，只能等它自然结束（≤ 数秒）。
- 退出时 `cancelAllLow` 会清掉队列中未执行的条目；若自检被打断/取消，下次启动因标志仍缺失会**重新触发**，具备自愈性。

### 2.2 对「启动即发现损坏」体验的影响

| 场景                        | 影响                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| quick_check 失败            | 全量自检**同步**执行（不 defer），恢复弹窗时序与现状一致 → 「启动即发现损坏」完全保留                                                                        |
| 标志缺失但 quick_check 通过 | 全量自检延后到后台 → 用户可能已开始操作，此时才触发恢复弹窗（稍晚于启动）。但 quick_check 已通过 + WAL 已自动恢复，DB 实际损坏概率低，全量只是「双保险」复核 |
| 标志存在 + quick_check 通过 | 完全跳过全量 → 启动最快，无损坏检测负担                                                                                                                      |

**结论**：推荐「quick_check 失败 → 同步；仅标志缺失 → 后台」。这样既保住关键损坏的启动即发现，又把最常见的（干净退出）启动路径彻底降为毫秒级，仅剩「上次异常退出」这一次性后台复核。

### 2.3 保底

异常退出标志的**判定**在 `initialize()` 快速路径（同步）完成——即使后台全量自检任务被用户操作抢占或退出取消，标志仍已触发「需要全量自检」的决策；任务取消后下次启动标志仍缺失，会再次触发，不丢失探测。

---

## 3. autoScanOnStartup 处理（两个方案，供决策）

> 背景：扫描已走 `enqueueLow` + 1500ms 延迟，负担主要来自「窗口出现后扫描立即起 + 链式缩略图/pHash/场景分析 + LRU + 更新检查」的组合。

### 方案 A：保持默认 true，但延后 / 再降优先级（推荐）

- 做法：把 `STARTUP_SCAN_DELAY_MS` 由 1500 上调（如 3000~5000），或把自动扫描延迟从「固定 setTimeout」改为「主窗口 `ready-to-show` / 首帧渲染后再入队」，让用户先看到可用界面。
- 优点：保留「开箱即有数据」的自动扫描体验与数据新鲜度；改动小、不改变默认语义。
- 缺点：扫描+链式索引仍会消耗 CPU/IO（只是更靠后），极端大库下仍可能轻微卡顿。

### 方案 B：改默认 false

- 做法：`ctx.dbManager.getSetting('autoScanOnStartup', true)` 的默认值改为 `false`，首次启动由用户手动触发扫描。
- 优点：冷启动负担最彻底地消除。
- 缺点：改变默认行为；首次启动用户看不到图库数据，需手动扫描，可能造成困惑；增量数据可能陈旧。**收益相对有限**——因为扫描本就是后台低优先级，真正拖慢「窗口出现」的不是扫描本身。

### 建议

默认走 **A**（保体验、改动小）；若后续埋点/反馈证明自动扫描仍是主要卡顿源，再退到 **B**。自动更新检查（lifecycle.ts:337-342，`+8000ms`）已足够靠后，可保留。

---

## 4. 现有测试影响

### 4.1 connection.test.ts（核心）

- **现状陷阱**：[MockDatabase.pragma()](file:///d:/WorkBuddy/WXNN%20XiangCe/src/main/database/connection.test.ts#L109-L127) 对未知 pragma 一律返回 `undefined`。当前 `runIntegrityCheck` 里 `result === 'ok'` 判真，`undefined` 会被当作「校验失败」→ 触发 `attemptRecovery`（依赖未 mock 的 backupService 静默失败），所以现有 initialize 测试是「一路走到 recovery 兜底」的假绿，**并未真实覆盖完整性逻辑**。
- **必须改**：mock 需让 `quick_check` / `integrity_check` 返回 `'ok'`（默认干净路径），并支持注入失败（返回非 'ok' 或抛错）以测损坏分支。
- **需新增用例**：
  1. quick_check 通过 + 标志存在 → 不调用 `integrity_check`（断言 `integrity_check` 未被 pragma 命中）。
  2. quick_check 失败 → 调用 `integrity_check` + 触发 `attemptRecovery`。
  3. 标志缺失（`fs.existsSync(marker)` 返回 false）→ `shouldRunFullIntegrityCheck()` 返回 true。
  4. `markCleanExit()` 写入 marker；`initialize` 读到 marker 时跳过全量。
  5. `runFullIntegrityCheck()` 失败 → 返回 `{ ok:false }` 且记录 `databaseCorruption` fault。
- **fs mock 注意**：测试已在 beforeEach `vi.spyOn(fs,'existsSync').mockReturnValue(true)`（connection.test.ts:619），会让 marker 默认「存在」。新增标志相关用例需按场景覆写 `existsSync` 对 marker 路径的返回值。

### 4.2 lifecycle.test.ts（阶段 8 定时器计数）

- 用例 22/23（lifecycle.test.ts:658-692）断言 `startupTimers` 增量：autoScan=true 时 `+3`、false 时 `+2`。
- 若新增后台 integrity-check 入队（新增一个 setTimeout/enqueueLow），计数变为 `+4` / `+3`，**必须同步更新**。
- 方案 B（改默认 false）不影响这两条：它们显式 mock `getSetting` 返回值，与默认值无关；但需确认没有其他用例断言「默认开启」。

### 4.3 其他

- `startup-diagnostic.test.ts`：未受影响（仅日志工具）。
- `startup-tasks.test.ts`：`performStartupScan` 逻辑不变，仅当 §3 选择改动 `performStartupScan` 调用参数时才涉及（方案 A 改延迟不动函数体，不受影响）。
- `task-scheduler.test.ts`：若复用调度器但改 `enqueueLow` 选项（id/cancel），现有测试契约不破坏（新增选项默认值兼容）。

---

## 5. 分步实施清单

> 按「每步一个文件 + 改动摘要 + 验证命令」组织；每步完成后跑对应单测再进下一步。

### Step 1 — connection.ts：加「干净退出」标志 + quick_check 快速路径

**文件**：`src/main/database/connection.ts`
**改动摘要**：

- 新增私有 `getCleanExitMarkerPath(): string`（`${this.dbPath}.clean-exit`）。
- 新增 `writeCleanExitMarker()` / `hasCleanExitMarker()`（`fs.writeFileSync` / `fs.existsSync`，各自 try/catch 不抛错）。
- 新增公开 `markCleanExit(): void`（写标志，供 cleanup 调用）。
- 新增公开 `shouldRunFullIntegrityCheck(): boolean`（`!hasCleanExitMarker()`）。
- 把私有 `runIntegrityCheck()` 重构为公开 `runFullIntegrityCheck(): { ok:boolean; reason?:string }`（内容不变）。
- 新增私有 `runQuickCheck(): boolean`（`pragma('quick_check',{simple:true}) === 'ok'`，失败/异常返回 false）。
- 改写 `initialize()` 完整性块（connection.ts:151-165）为分级逻辑（见 §1.3）：quick_check 失败→同步全量+recovery；仅标志缺失→跳过同步（由 lifecycle 后台处理）。

**验证**：

```bash
npx vitest run src/main/database/connection.test.ts
```

### Step 2 — lifecycle.ts：后台全量自检入低优先级队列

**文件**：`src/main/app/lifecycle.ts`
**改动摘要**：

- 阶段 8（:389-429 附近）新增一个 `startupTimers` 定时器：当 `ctx.dbManager.shouldRunFullIntegrityCheck()` 为 true 时，延迟 `STARTUP_SCAN_DELAY_MS`（可再叠加偏移）后 `ctx.taskScheduler.enqueueLow(() => ctx.dbManager.runFullIntegrityCheck(), { id: 'startup-integrity-check' })`，`.catch` 记录 `logStartupError`。
- 若 quick_check 已失败并在 initialize 内同步处理，lifecycle 侧无需重复入队（以 `shouldRunFullIntegrityCheck` 结果为准——损坏时仍为 true 也不重复全量？需与 Step1 约定：quick_check 失败时标志保持缺失，但 lifecycle 入队的是「复核」；为免重复，可让 initialize 在同步全量失败后仍返回 need，lifecycle 仅在其未同步处理时入队。**实施时在 Step1 明确返回值约定**）。

**验证**：

```bash
npx vitest run src/main/app/__tests__/lifecycle.test.ts
```

（同时更新用例 22/23 的定时器计数断言，见 §4.2）

### Step 3 — cleanup.ts：优雅退出时写「干净退出」标志

**文件**：`src/main/app/cleanup.ts`
**改动摘要**：在 `ctx.dbManager.close()`（:128-133）**成功返回后**（未进入 catch）调用 `ctx.dbManager.markCleanExit()`。崩溃/强杀/超时强制退出走不到此，保证标志语义正确。

**验证**：

```bash
npx vitest run src/main/app/__tests__/cleanup-perform-cleanup.test.ts
```

### Step 4 — connection.test.ts：补分级用例

**文件**：`src/main/database/connection.test.ts`
**改动摘要**：

- `MockDatabase.pragma` 支持 `quick_check` / `integrity_check` 返回 `'ok'`，并支持按需注入失败。
- 新增 §4.1 所列 5 类用例；按场景覆写 marker 的 `fs.existsSync`。

**验证**：

```bash
npx vitest run src/main/database/connection.test.ts
```

### Step 5 — autoScanOnStartup（按 §3 决策执行其一）

- **方案 A**：`src/main/utils/constants.ts` 上调 `STARTUP_SCAN_DELAY_MS`（1500→3000/5000）；或在 lifecycle 阶段 8 把自动扫描入队时机改为窗口就绪后。
  ```bash
  npx vitest run src/main/app/__tests__/lifecycle.test.ts src/main/utils/constants.test.ts
  ```
- **方案 B**：`lifecycle.ts:392` 默认值 `true`→`false`。
  ```bash
  npx vitest run src/main/app/__tests__/lifecycle.test.ts
  ```

### Step 6 — 回归：lint + typecheck + 全套单测

```bash
npm run lint
npm run typecheck
npm run test:main
```

---

## 6. 风险与缓解

| #   | 风险                     | 说明                                                                                                                  | 缓解                                                                                                           |
| --- | ------------------------ | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| R1  | 误判「损坏」             | `quick_check` 通过但 `integrity_check` 才发现的深层损坏，在「干净退出」路径会被跳过 → 潜在漏检                        | quick_check 永远同步跑（兜底）；标志缺失路径仍全量复核；可选：周期性（如每周一次）在后台跑一次全量作为长期兜底 |
| R2  | 异常退出标志遗漏         | 标志写入失败，或「close 成功后又崩溃」导致标志已写但库随后被破坏                                                      | 标志仅在 close 成功后才写；quick_check 兜底不依赖标志；写入 try/catch                                          |
| R3  | 后台自检与用户操作并发   | 后台全量 `integrity_check` 是同步阻塞，运行数秒时用户操作/扫描被短暂卡顿；高优先级抢占只能等它跑完（PRAGMA 不可中断） | `maxLowConcurrency=1` 与启动扫描串行；`quick_check` 已先兜底降低其必要性；文档注明「延后而非消除」阻塞的取舍   |
| R4  | 定时器/队列计数测试脆弱  | lifecycle 用例 22/23 断言 `startupTimers` 增量，新增后台任务会破坏                                                    | 实施 Step2 时同步更新断言（§4.2）                                                                              |
| R5  | 现有 connection 测试假绿 | mock pragma 返回 `undefined` 使完整性分支实际未测                                                                     | Step4 修复 mock（`quick_check`/`integrity_check` 默认 `'ok'`）并补真实分支用例                                 |
| R6  | 首启/迁移路径            | 全新库标志缺失会触发一次全量（空库毫秒级，可接受）；迁移失败已有 `isDatabaseUsable` 用 quick_check                    | 可选：首启成功初始化末尾补写标志；迁移失败回滚逻辑复用 quick_check，与新增快速路径语义一致                     |
| R7  | 侧车文件泄漏/脏          | marker 文件极小，但需在 DB 重建/恢复后保持一致                                                                        | 恢复（attemptRecovery）成功后由后续正常退出重写标志；路径与 dbPath 绑定                                        |

---

## 附：决策点汇总（请审阅确认）

1. **全量自检后台化范围**：推荐「quick_check 失败→同步；仅异常退出标志→后台 enqueueLow」。是否同意？
2. **「干净退出」标志介质**：推荐侧车文件 `{dbPath}.clean-exit`。是否同意？
3. **autoScanOnStartup**：默认走方案 A（延后/降优先，保默认 true）还是方案 B（改默认 false）？
4. 是否接受 R1 的「干净退出路径可能漏检深层损坏」这一取舍（可选加周期全量兜底）？
