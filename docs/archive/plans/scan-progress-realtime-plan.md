# 启动自动扫描进度弹窗不实时显示 —— 改造计划

> 适用项目：无限暖暖相册管理工具（Electron + React 19 + TypeScript）
> 目标：软件启动后自动扫描时，右下角扫描进度弹窗能即时、实时显示，并覆盖扫描完成后的缩略图 / pHash / 场景分析长任务反馈。
> 日期：2026-08-13
> 范围：**仅计划文档，不修改任何源代码。** 下文所有改动点均为待实施清单。

---

## 1. 背景

用户反馈：软件**启动后自动扫描**期间，右下角的进度弹窗（由 `ScanProgress` → `TaskProgressOverlay` 渲染）几乎从不出现；即使出现，也常常在扫描已结束（`scanner:complete` 已发）后才"闪一下"随即消失。扫描完成之后，后台还在跑缩略图生成 / pHash 补算 / 场景时段分析（可能耗时数分钟），这段时间内界面**没有任何进度反馈**，看起来像"卡死"。

手动点击"增量扫描 / 自动定位游戏目录"时弹窗**正常显示**——这说明问题集中在"启动自动扫描"这一特殊时序路径，而非进度通道本身完全失效。

---

## 2. 现状链路：启动自动扫描的进度事件完整路径

下面把 `scanner:progress` 与 `task:progress` 两条通道，从 main 进程一路追到 renderer 弹窗，逐跳标注"是否会在订阅前丢失"。

### 2.1 主进程侧（事件的产生与广播）

| 跳  | 代码位置                                                                   | 动作                                                                                             | 说明                                                                                                                                                   |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ①   | `startup-tasks.ts` → `performStartupScan()`                                | 直接调用 `ctx.scannerManager.startScan({...})`                                                   | 启动自动扫描**不走 `scanner:start` IPC**，由 main 进程在 `app.whenReady` 后主动发起，早于渲染窗口加载完成。                                            |
| ②   | `scanner/index.ts` `ScannerManager.startScan()`                            | 置 `currentStatus.status='running'`，转发 `SCAN_START` 给 worker                                 | 同时把 `pendingComplete` 挂起，等 `SCAN_COMPLETE` 解算。                                                                                               |
| ③   | `scanner-worker-bridge.ts` `startScan()`                                   | 注册 `taskRegistry`，记 `currentTaskId` / `scanStartedAt`                                        | 每个 `currentTaskId` 形如 `scan-<时间戳>-<随机>`。                                                                                                     |
| ④   | worker → `scanner-worker-bridge.ts` `handleWorkerMessage('SCAN_PROGRESS')` | 计算 ETA，构造 `TaskProgress` 快照                                                               | **同时做两件事**：(a) `this.messageHandlers.forEach(...)` 透传给 `ScannerManager`；(b) `this.progressThrottle.push(taskProgress)` 推 `task:progress`。 |
| ⑤   | `progress-throttle.ts` `emit()`                                            | `BrowserWindow.getAllWindows().forEach(w => w.webContents.send('task:progress', p))`             | `task:progress` 以 200ms 节流（5 FPS）**广播到所有窗口**，无缓冲、无重放。                                                                             |
| ⑥   | `ipc-setup.ts` `bindScanProgressListener()`                                | `ScannerManager.on('progress', p => sendToRenderer(ctx,'scanner:progress',p))`                   | `scanner:progress` 把 ④(a) 的透传事件转发给渲染进程，同样**无重放**。                                                                                  |
| ⑦   | 扫描结束 `handleWorkerMessage('SCAN_COMPLETE')` / `startup-tasks.ts`       | 推 `task:progress` 终态（`done`/`error`）；`startup-tasks.ts` 发 `scanner:complete`              | `SCAN_COMPLETE` 后 `currentTaskId` 置 `null`、`lastScanTaskProgress` 清空（目前尚无该字段，见 §4.2）。                                                 |
| ⑧   | `startup-tasks.ts`（⑦ 之后）                                               | 链式 `generateThumbnailsForUnprocessed` → `generatePhashForUnprocessed` → `autoAnalyzeSceneTime` | **这些长任务当前不推送任何 `task:progress` / `scanner:progress`**，界面完全无反馈。                                                                    |

### 2.2 渲染进程侧（事件的订阅与显示门控）

| 跳  | 代码位置                                         | 动作                                                                           | 关键问题                                                                                                                                                                      |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ⑨   | `ScanButton.tsx` 挂载即订阅 `scanner.onProgress` | `setScanProgress({ ...progress, scanning: true })`                             | **唯一**会把 `scanProgress.scanning` 置 `true` 的地方。但订阅发生在组件挂载、窗口加载之后。                                                                                   |
| ⑩   | `ScanButton.tsx` 挂载同步 `scanner.status()`     | `if (progress?.status === 'running') setScanProgress({...scanning:true})`      | 仅当挂载时扫描**仍在进行**才生效；且 preload 的 `ScannerStatus` 类型未声明 `status` 字段，依赖运行时实际返回 `{status:'running'}`。扫描已结束则返回 `completed`，条件不成立。 |
| ⑪   | `ScanProgress.tsx` 挂载订阅 `task.onProgress`    | 过滤 `taskType==='scan'`，写入 `taskProgress`                                  | 订阅同样晚于 ⑤ 的广播；若挂载时已有事件发出，这些事件**已丢失，无重放**。                                                                                                     |
| ⑫   | `ScanProgress.tsx` 第 96 行                      | `if (!scanProgress.scanning && scanProgress.status !== 'running') return null` | **显示门控**：只有 `scanProgress.scanning===true` 或 `status==='running'` 才渲染弹窗。                                                                                        |
| ⑬   | `TaskProgressOverlay.tsx`                        | `progress===null` 时 `return null`                                             | 纯展示，由父组件传入 `progress`。                                                                                                                                             |

### 2.3 两条通道的关键差异

- `scanner:progress`：驱动 `scanProgress.scanning`（⑫ 门控依赖此字段）。
- `task:progress`：驱动 `taskProgress`（本应是更准的实时数据源），但**被 ⑫ 的 `scanProgress.scanning` 门控挡在门外**——即使 `taskProgress` 已到达，只要 `scanProgress.scanning` 为 `false`，组件在第 96 行就提前 `return null`。

---

## 3. 根因

弹窗不显示是**"门控依赖错误 + 启动时序 + IPC 无重放"**三者叠加：

1. **门控错绑到 `scanProgress.scanning`（`ScanProgress.tsx:96`）。**
   `scanProgress.scanning` 只会在 `ScanButton` 的 `scanner.onProgress` 回调（⑨）里被置 `true`。而该回调依赖"扫描进行中且 `scanner:progress` 事件在订阅之后到达"。

2. **启动自动扫描早于渲染订阅，事件因 IPC 无重放而丢失。**
   启动扫描由 main 在窗口就绪前发起（①），`scanner:progress`（⑥）与 `task:progress`（⑤）都通过 `webContents.send` 即时广播、无缓冲队列。渲染进程（`ScanButton`/`ScanProgress`）在窗口加载、组件挂载后才 `ipcRenderer.on(...)`。二者之间存在时间窗，早到的进度事件**永久丢失**，`scanner.onProgress` 可能一次都没触发，`scanProgress.scanning` 始终 `false`。

3. **挂载同步状态在 `completed` 后无法触发显示。**
   即便 `ScanButton` 的 `scanner.status()` 同步路径（⑩）在挂载时执行，启动扫描对小型库/快速磁盘往往在组件挂载前就已 `SCAN_COMPLETE`，`getStatus()` 返回 `status:'completed'`，条件 `status === 'running'` 不成立，`scanning` 仍不被置 `true`。

4. **结果：** `scanProgress.scanning===false` 且 `status!=='running'` → 第 96 行 `return null` → 弹窗永不出现。即便 `task:progress` 后续到达，`taskProgress` 被第 96 行门控吞掉。这正是"手动扫描正常、启动扫描不显示"的差异来源——手动时渲染早已挂载并订阅，两条通道事件都不丢。

5. **次生问题（"假死"）：** 扫描 `SCAN_COMPLETE` 后，`startup-tasks.ts` ⑧ 链式运行的缩略图 / pHash / 场景分析**不推送任何进度**，`task:progress` 在 `done` 之后 1.5s（清除定时器）即归零，弹窗消失，用户面对数分钟无反馈的后台计算，误以为软件卡死。

---

## 4. 改造方案

总原则（对齐项目"极简健壮"信条）：**只解决"实时显示"这一件事**，不重写进度体系；新增皆为**增量、向后兼容**能力；取消的兜底链路（`scanner:stop` / `task:cancel`）全部保留。

### 4.1 解耦显示门控（核心修复）

`ScanProgress` 不再以 `scanProgress.scanning` 作为显隐开关，改由 `task:progress`（`taskType` 为 `scan` 或新增的 `indexing`）**直接驱动**。

- 渲染门控改为：`if (!taskProgress) return null`（终态 `done/cancelled/error` 仍走现有 1.5s 渐隐逻辑）。
- `taskProgress` 的来源有三：
  1. `task.onProgress` 实时推送（处理进行中/收尾/取消）；
  2. **挂载即拉快照**（见 4.2），补偿"订阅前已丢失的事件"；
  3. 取消后的 `cancelled` 终态（保留）。
- 移除对 `scanProgress.scanning` / `status` 的显隐依赖；`scanProgress` 仅作为 `currentPath` / `found` 的**兼容回退**来源（过渡期保留，最终由 4.3 的 `TaskProgress` 新字段取代）。

> 为什么这样能修：手动扫描时渲染已订阅，`task:progress` 正常到达，门控放开后即显示；启动扫描时即便前几帧事件丢失，**挂载即拉快照（4.2）** 会立刻用当前任务状态把 `taskProgress` 填上，弹窗在挂载瞬间即出现，后续实时事件无缝续上——等效实现了"进度重放"。

### 4.2 挂载即拉快照（等效重放）

新增主进程"当前活动扫描任务快照"接口，渲染进程挂载时立即拉取，补偿 IPC 无重放造成的丢失。

- **main 侧**：`ScannerWorkerBridge` 维护 `lastScanTaskProgress: TaskProgress | null`（在 ④ 每次构造 `taskProgress` 后缓存最新一份；`SCAN_COMPLETE` / worker 退出时清空）。新增方法：
  ```ts
  getActiveScanTask(): TaskProgress | null {
    return this.currentTaskId ? this.lastScanTaskProgress : null
  }
  ```
- **新增 IPC**：`task-handler.ts` 注册 `task:getActive`（无参），返回 `ctx.scannerWorkerBridge.getActiveScanTask()`（后续可一并返回 `indexing` 活动任务，见 4.4）。
- **preload**：`electronAPI.task.getActive = () => call<TaskProgress | null>('task:getActive')`。
- **renderer 侧**：`ScanProgress` 挂载的 `useEffect` 中先 `await window.electronAPI.task.getActive()`，若返回非空且非终态，立即 `setTaskProgress(snapshot)`。这样"订阅前已发出的事件"被快照一次性"重放"。

> 注：快照返回的是"最近一次进度"，而非完整事件流，但对进度弹窗而言已足够（用户只要看到"正在扫描、当前 X/Y"即可），无需重建事件序列。

### 4.3 补全 scan 任务的展示字段

为避免解耦后丢失 `currentPath` / `found` 这两个 scan 专属子行信息，给 `TaskProgress` 增加两个**可选**字段（向后兼容，旧监听者忽略即可）：

```ts
export interface TaskProgress {
  // ...现有字段...
  /** 扫描当前路径（scan 任务特有，用于弹窗子行展示；其他任务可省略） */
  currentPath?: string
  /** 已发现文件数（scan 任务特有） */
  found?: number
}
```

- `scanner-worker-bridge.ts` ④ 构造 `taskProgress` 时填入 `currentPath: progress.currentPath`、`found: progress.found`。
- preload 本地 `TaskProgress` 镜像同步增加这两个字段。
- `ScanProgress` 改为从 `taskProgress.currentPath` / `taskProgress.found` 读取子行（保留 `scanProgress` 回退以防旧数据）。

### 4.4 把扫描后长任务纳入统一 `task:progress` 通道（消除"假死"）

将 ⑧ 的缩略图 / pHash / 场景分析包装成一个 `indexing` 任务，复用 `task:progress`，让弹窗在扫描结束后继续显示，直至全部收尾完成。

- **`TaskType` 新增 `'indexing'`**（`shared/types/progress.ts` 与 preload 镜像同步）。
- **新增"indexing 任务"发射器**：在 `startup-tasks.ts` 中新增 `runPostScanIndexing(ctx)`：
  - 复用 `ProgressThrottle`（新建一个模块级实例或提取共享 `emitTaskProgress()` 工具，供 bridge 与 startup 共用，避免重复 `getAllWindows` 逻辑）。
  - 阶段映射：
    - `preparing`：开始生成缩略图前
    - `processing`：缩略图生成进度 → pHash 补算进度（可在 `message` 中标注"正在生成缩略图…/正在计算 pHash…"）
    - `finalizing`：场景时段分析
    - `done`：全部完成
  - `current` / `total`：优先用各服务的可计数来源（如待处理行数）；若服务不暴露细粒度计数，退化为"按步骤估算百分比"（缩略图 0–60%、pHash 60–85%、场景 85–100%），保证有连续反馈即可。
- **`ScanProgress` 同时响应 `taskType==='scan'` 与 `'indexing'`**：二者都是"同一活动弹窗"的延续——优先展示非终态的那个；扫描 `done` 后由 `indexing` 的 `processing` 无缝接管，弹窗不消失，直至 `indexing` 终态。
- 仍保留 `scanner:complete` 的 `fetchMediaFromDatabase()` 兜底刷新（现有逻辑不动）。

> 取舍：细粒度计数需要 `thumbnail-phash-service` 暴露进度；若改动成本过高，先用"步骤级 message + 估算百分比"即可满足"消除假死"目标，后续再细化。

### 4.5 取消链路保持不变

`task:cancel`（`taskRegistry.abort` → `scanner-worker-bridge` abort 监听推 `cancelled`）继续有效；`ScanProgress.handleStop` 仍优先 `task:cancel(taskId)`，回退 `scanner:stop`。`taskIdRef` 由 `task:progress` 填充，门控解耦后不受影响。

---

## 5. 文件改动清单（函数级）

> 标注 **[新增]** / **[改]** / **[不动]**。所有改动力求最小、向后兼容。

### 5.1 `src/shared/types/progress.ts` **[改]**

- `TaskType` 联合增加 `'indexing'`。
- `TaskProgress` 增加可选 `currentPath?: string`、`found?: number`。

### 5.2 `src/main/preload.ts` **[改]**

- 本地 `TaskProgress` 接口同步：联合加 `'indexing'`，加 `currentPath?` / `found?`。
- `electronAPI.task` 增加 `getActive: () => call<TaskProgress | null>('task:getActive')`。

### 5.3 `src/main/scanner/scanner-worker-bridge.ts` **[改]**

- 新增私有字段 `lastScanTaskProgress: TaskProgress | null = null`。
- `handleWorkerMessage('SCAN_PROGRESS')`：构造 `taskProgress` 后补充 `currentPath`/`found`，并 `this.lastScanTaskProgress = taskProgress`。
- `handleWorkerMessage('SCAN_COMPLETE')` 与 `handleWorkerExit(...)`：终态/异常分支里 `this.lastScanTaskProgress = null`。
- 新增方法 `getActiveScanTask(): TaskProgress | null`（见 4.2）。

### 5.4 `src/main/ipc/handlers/task-handler.ts` **[改]**

- `registerTaskHandlers` 内新增 `ipcMain.handle('task:getActive', wrapHandlerNoArgs(ctx, async () => ctx.scannerWorkerBridge.getActiveScanTask()))`。
- （可选）后续返回时也包含 `indexing` 活动任务——本期先返回 scan 快照。

### 5.5 `src/main/app/startup-tasks.ts` **[改]**

- 新增 `runPostScanIndexing(ctx)`：用 `ProgressThrottle`（或共享 `emitTaskProgress`）推送 `taskType:'indexing'` 的 `task:progress`（`preparing`→`processing`→`finalizing`→`done`）。
- `performStartupScan()`：在 `sendToRenderer(ctx,'scanner:complete',result)` 之后调用 `runPostScanIndexing(ctx)`（替换/包裹现有的 ⑧ 链式调用），使其带进度反馈。失败时仍走现有 `catch` 与 `notifyMediaUpdated()`。

### 5.6 `src/renderer/components/scanner/ScanProgress.tsx` **[改]（核心）**

- 删除第 96 行 `if (!scanProgress.scanning && scanProgress.status !== 'running') return null`；改为 `if (!taskProgress) return null`。
- 挂载 `useEffect` 中新增：先 `await window.electronAPI.task.getActive()`，非空非终态则 `setTaskProgress(snapshot)`（重放补偿）。
- `task.onProgress` 订阅：过滤条件由 `taskType !== 'scan'` 改为 `taskType !== 'scan' && taskType !== 'indexing'`（或改为白名单集合）。
- 子行 `currentPath` / `found` 改为优先读 `taskProgress.currentPath` / `taskProgress.found`，回退 `scanProgress`。
- 移除对 `scanProgress.scanning` / `status` 的显隐依赖（保留 `setScanProgress` 仅作兼容写；或彻底不再依赖 `scanProgress` 做显示，仅保留 `scanner:complete` 兜底刷新）。
- `mergedProgress` 合成逻辑保留；`found`/`currentPath` 优先取 `taskProgress`。

### 5.7 `src/renderer/components/scanner/ScanButton.tsx` **[不动 / 可选清理]**

- 现有 `scanner.onProgress` / `scanner.status()` 订阅仍会写 `scanProgress`，属**无害回退**，本期**保持不变**。
- 可选：确认 `scanner.status()` 同步分支（⑩）已不再承担显示门控职责后，可保留或删除——建议保留（零风险），避免扩大改动面。

### 5.8 `src/renderer/components/common/TaskProgressOverlay.tsx` **[不动]**

- 纯展示组件，按 `phase` 渲染，已支持 `preparing/processing/finalizing/done/cancelled/error`，无需改动。`indexing` 复用现有 phase 文案即可。

### 5.9 其他（无改动）

- `src/main/app/ipc-setup.ts`：保留 `scanner:progress` 转发（兼容旧路径）。
- `src/main/scanner/index.ts` `ScannerManager`：保留 `getStatus()`（兼容 `scanner.status()`）。
- `src/renderer/stores/mediaStore.ts`：保留 `scanProgress` 状态与 `setScanProgress`（兼容写），不删。

---

## 6. 改动顺序（建议实施节奏）

1. **类型先行**：`progress.ts` 增加 `indexing` / `currentPath` / `found`（5.1）→ 同步 preload 镜像（5.2）。保证全仓类型一致。
2. **main 快照能力**：`scanner-worker-bridge.ts` 增加 `lastScanTaskProgress` + `getActiveScanTask`（5.3）→ `task-handler.ts` 增加 `task:getActive`（5.4）。
3. **indexing 通道**：`startup-tasks.ts` 增加 `runPostScanIndexing` 并接入（5.5）。
4. **renderer 解耦**：改造 `ScanProgress.tsx`（5.6）——门控解耦 + 挂载即拉快照 + 双 taskType 响应。
5. **校验**：typecheck → 启动验证 → 自动化测试（见 §8）。
6. **（可选）** 清理 `ScanButton` 冗余同步分支。

> 依赖关系：步骤 2 依赖步骤 1；步骤 4 依赖步骤 2（`task.getActive`）。步骤 3 与步骤 2 可并行。

---

## 7. 向后兼容与回滚方案

### 7.1 向后兼容

- **新增** `task:getActive` 通道：旧渲染版本若不调用则无任何影响（handler 始终存在，无副作用）。
- **新增** `indexing` taskType：旧 `ScanProgress` 不识别 `indexing` 只忽略——但本期会同步改 `ScanProgress` 响应它；旧监听者（如其他页面）按 `taskType` 过滤，遇未知类型静默忽略。
- **保留** `scanner:progress` / `scanner:status` / `scanner:start` / `scanner:stop`：全部不动，`ScanButton` 仍写 `scanProgress` 作为回退。
- **保留** `task:cancel` / `scanner:stop` 取消链路。
- `TaskProgress` 新增字段为可选，序列化后旧消费者忽略即可。

### 7.2 回滚

- 本次改动**无数据库 schema 变更、无持久化格式变更**，回滚纯靠代码还原：
  - 逐文件 `git revert` / `git checkout -- <file>`，受影响文件仅 §5 列出的 6 个（5.1–5.6）。
  - 若需"热开关"：可在 `ScanProgress` 保留一个常量 `USE_TASK_DRIVEN_GATE = true`，回滚时置 `false` 即恢复旧门控；但推荐直接 git 回滚，保持代码干净。
- 验证回滚：回滚后手动扫描仍正常（原链路未动），启动扫描回到"旧的不显示"行为（可接受，因本次即修复它）。

---

## 8. 验证方法

### 8.1 类型检查（必过）

```bash
npm run typecheck        # 或 npx tsc --noEmit -p tsconfig.json
```

重点确认：`TaskType` 与 `TaskProgress` 在 `shared` 与 preload 两处一致；`electronAPI.task.getActive` 类型存在；`ScanProgress` 不再引用已删除的门控字段。

### 8.2 启动验证（手动，强烈建议）

构造"启动扫描必然可见"的场景：

- **首次启动（全盘扫描）**：清空数据库 / 用新库路径，启动后应在右下角**立即**看到弹窗，且 `task:progress` 节流刷新（当前 X/Y、ETA 变化）。
- **挂载晚于扫描**：在 `ScanProgress` 挂载逻辑中临时加 3s 延迟（仅验证用），确认即便前几帧事件丢失，"挂载即拉快照"仍让弹窗在挂载瞬间出现。
- **小型库快速完成**：故意用小库，确认即便 `scanner:complete` 早于挂载，弹窗仍因快照出现或根本不再"漏显"。
- **扫描后长任务**：确认 `scan` 弹窗在 `done` 后由 `indexing` 弹窗**无缝接管**，显示"正在生成缩略图…/正在计算 pHash…/正在分析场景时段…"，直至全部完成才消失（消除假死）。
- **取消**：扫描/索引中点击取消，弹窗进入 `cancelled` 并在 1.5s 后消失，媒体列表刷新。
- **手动扫描回归**：点击"增量扫描"仍正常显示（确认解耦未破坏原有链路）。

### 8.3 自动化测试建议（新增）

- **`scanner-worker-bridge.test.ts`**：
  - 模拟 `SCAN_PROGRESS` 序列 → 断言 `getActiveScanTask()` 返回最新非终态快照（含 `currentPath`/`found`）；
  - 模拟 `SCAN_COMPLETE` → 断言 `getActiveScanTask()` 返回 `null`。
- **`task-handler` 测试**：
  - `task:getActive` 在扫描进行中返回活动任务快照；扫描结束后返回 `null`。
- **`ScanProgress` 组件测试（vitest + @testing-library/react）**：
  - 给定 `task.onProgress` 推 `taskType:'scan'` 事件，**不**设 `scanProgress.scanning` → 断言弹窗可见（验证门控解耦）；
  - 给定 `task.getActive` mock 返回活动任务 → 断言挂载即显示（验证快照重放）；
  - 给定 `taskType:'indexing'` → 断言 scan 终态后弹窗继续显示（验证长任务反馈）。
- **`startup-tasks` 测试（可选）**：断言 `runPostScanIndexing` 至少发出一条 `taskType:'indexing'` 的非终态 `task:progress` 与一条 `done` 终态。

---

## 9. 风险与缓解

| 风险                                                                     | 影响             | 缓解                                                                                                            |
| ------------------------------------------------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------- |
| 挂载即拉快照与实时事件"双重触发"导致数字跳动                             | 低               | 快照与实时 `task:progress` 同源（同一 `TaskProgress` 结构），渲染用 `taskProgress` 单状态覆盖，无叠加。         |
| `task:getActive` 在窗口就绪前被调用                                      | 低               | preload `call` 走 IPC，窗口未就绪时调用方（组件 mount）本就在窗口内，无此问题；handler 内部只读字段，不会抛错。 |
| `indexing` 阶段计数不准（服务未暴露细粒度）                              | 中               | 退化为步骤级 message + 估算百分比，仍能消除"假死"；后续再细化。                                                 |
| `ProgressThrottle` 在 startup 与 bridge 各持一份，终态清除不一致         | 低               | 每轮任务结束各自 `dispose()`；或提取共享 `emitTaskProgress()` 统一管理（推荐，见 4.4）。                        |
| 解耦后 `scanProgress` 仍被 `ScanButton` 写入但不再用于门控，造成"死状态" | 低               | 仅为兼容回退，无副作用；后续清理可移除。                                                                        |
| 误删 `scanner:progress` 兼容链路                                         | 高（但本次不做） | 本计划明确保留 `scanner:progress` / `ScanButton` 订阅，不做破坏性删除。                                         |

---

## 10. 结论

问题根因是**显示门控错绑到 `scanProgress.scanning`，而该字段依赖早于渲染订阅到达、又无重放的 `scanner:progress` 事件**；启动扫描对小型库甚至在组件挂载前就 `SCAN_COMPLETE`，门控永不满足。

修复方案三件套——**解耦门控（改由 `task:progress` 驱动）+ 挂载即拉快照（`task:getActive` 等效重放）+ 长任务统一进 `task:progress`（新增 `indexing`）**——均为增量、向后兼容改动，可在不触碰现有取消/兼容链路的前提下，让启动自动扫描弹窗即时、实时显示，并消除扫描完成后的"假死"无反馈。
