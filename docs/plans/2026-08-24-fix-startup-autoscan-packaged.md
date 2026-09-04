# 修复打包版首次安装启动时后台自动扫描未触发 / 渲染端无进度事件

> 交付物：打包（NSIS / win-unpacked）后**首次安装启动**时，后台自动扫描可靠触发，右下角显示扫描进度浮窗，图库在扫描完成后自动刷新；扫描失败时用户可见错误提示。
> 范围控制：仅修复启动扫描触发链路与进度可见性，不改动无关功能。

---

## 1. 问题定位（根因分析，基于代码走查）

症状：首装启动后图库始终显示"暂无媒体文件，点击扫描按钮开始扫描游戏截图"，右下角无任何进度提示。

完整链路：`Application.initialize()` → `taskScheduler.pause()`（启动期）→ `createMainWindow()` → ready-to-show → `taskScheduler.resume()` → 5s 延迟（`STARTUP_SCAN_DELAY_MS`）→ `enqueueLow(performStartupScan)` → `ScannerManager.startScan` → scanner-worker（utilityProcess）→ `SCAN_PROGRESS`/`SCAN_COMPLETE` → `task:progress`/`scanner:complete` → 渲染端 `ScanProgress` 浮窗 + `refreshMediaAfterScan`。

### D1（主因，高置信度）：ready-to-show 监听注册晚于 loadURL 的时序竞态

`src/main/app/window-manager.ts`：

```ts
// L172：先 await 加载
await mainWindow.loadURL('app://renderer/index.html')
// ...
// L183：之后才注册 once 监听
mainWindow.once('ready-to-show', () => {
  mainWindow.show()
  ctx.taskScheduler.resume() // 唯一的 resume 调用点
})
```

- `ready-to-show` 在渲染进程**首次绘制**时发出。打包版经 `app://` 特权协议从本地 asar 加载（快），事件可能在 `loadURL` 的 promise resolve 之前已发出，`once` 监听器错过事件。
- 后果：`taskScheduler.resume()` 永不执行 → `TaskScheduler.pump()` 被 `paused` 阻塞（`src/main/scheduler/task-scheduler.ts` L249）→ `startup-scan` 低优先级任务（`src/main/app/lifecycle.ts` L392）永不执行 → **扫描不触发、无进度事件、图库空**。
- 用户仍能看到界面：隐藏窗口（`show:false`）在任务栏有图标，点击可唤出窗口，但该路径不会补调 `resume()`。
- 开发模式走 vite dev server（首绘慢）几乎不输掉竞态；这解释了"仅打包后出现"。Electron 官方文档明确要求 ready-to-show 监听须在 loadURL/loadFile **之前**注册。
- 窗口隐藏 + 8s 白屏兜底（`renderer:ready` IPC）不报错——渲染进程正常加载并发送了 ready，只是窗口未 show、调度器未 resume，形成"一切正常但什么都没发生"的静默故障。

### D2：启动自动扫描失败完全静默

`src/main/app/startup-tasks.ts` `performStartupScan`：失败路径仅 `sendToRenderer('scanner:complete', {success:false})`。首装强制全盘扫描（`fullScan=true`），若 `findMediaDirectories` 返回 0 目录（Steam/Epic 注册表未命中 + 签名搜索深度不足），worker 在任何 `SCAN_PROGRESS` 之前就返回 `noMediaDirFound` → 无浮窗、无进度。手动扫描路径有失败 Toast（`ScanButton.reportScanFailure`，P1-2），但首装静默失败时用户毫无感知。

### D3：全盘发现阶段的进度盲区

`src/main/scanner/worker-entry.ts` `startScan` fullScan 分支：`findMediaDirectories`（多盘符 depth-6 签名搜索，慢机器可达数十秒）期间不发送任何 `SCAN_PROGRESS`；`active-task-store` 快照也仅在收到首个 SCAN_PROGRESS 后才写入 → 即使扫描正常运行，`task:getActive` 挂载即拉也返回 null，右下角在发现阶段无任何反馈。

### D4：触发链路无诊断埋点

`startup-scan` 入队、调度器 paused/resume 状态转换均不在 diag.log，现场无法取证（本次反馈即无日志可查）。

### 已排除项

- `scanner-handler.ts` 的 `scanner:complete` 广播（含校验失败/路径拒绝/异常路径）与 `runPostScanActions` 链路完整，`performStartupScan` 也独立补发 `scanner:complete` + `notifyMediaUpdated`，IPC 广播侧无缺陷。
- 渲染端 `ScanProgress.tsx`：已订阅 `task:progress`（scan/indexing/batch/duplicate 四类）+ `task:getActive` 挂载即拉快照 + `scanner:complete` 兜底刷新，接收侧无缺陷（前提是主进程真的发出事件，即 D1/D3）。
- 构建产物：`pre-dist-check` 闸门 1.6 已校验 `scanner-worker.js` 等 5 个 utilityProcess 入口存在；`asarUnpack` 覆盖 better-sqlite3/sharp/koffi，worker 产物侧无缺失。

---

## 2. 依赖声明

- **零新增 npm 依赖**。
- **复用项目内现有基础设施**（不重复造轮子）：
  - `TaskScheduler.resume()`（幂等：`paused=false + pump()`）；
  - `diagLog` / `logStartupError`（`src/main/utils/startup-diagnostic.ts`）；
  - `logger.info` / `logger.fault`（`src/main/utils/logger.ts`）；
  - worker 侧 `sendEvent({type:'SCAN_PROGRESS'})` 既有通道 + 主进程 `ProgressThrottle`/`setActiveScanTask` 快照机制；
  - 渲染端 `useGlobalToast` 失败提示（复用 `ScanButton.reportScanFailure` 同款文案 key）。
- **外部方案评估**：用户提及的 `github.com/RanAxro/nikki_albums` 为异构项目（非本仓库技术栈，亦不针对 Electron utilityProcess + 分级调度时序问题），不适用、不引入；`electron-serve` 等第三方库走已废弃 API 且与本缺陷无关，否决。本修复采用 Electron 官方文档指引（ready-to-show 须在 loadURL 前注册）。

---

## 3. 启动说明

### 3.1 开发模式（无法复现 D1，用于回归验证功能不破坏）

```bash
npm run dev        # electron-vite dev，渲染层走 http://localhost:5173
```

### 3.2 打包复现 / 验证（关键）

```bash
npx electron-vite build
node -e "require('fs').writeFileSync('dist/main/package.json',JSON.stringify({type:'commonjs'}))"
npm run pre-dist-check
npx electron-builder --win --publish never      # release/win-unpacked/
```

**首装模拟**（必做，首次启动 = `scan_history` 为空 → 强制全盘扫描）：

```powershell
Remove-Item -Recurse -Force "$env:APPDATA\wxnn-photo-manager"   # 清 userData 模拟首装
```

启动 `release/win-unpacked\无限暖暖相册管理工具.exe`，观察：

1. 右下角在目录发现阶段即出现进度浮窗（D2/D3 修复后）；
2. 扫描完成后图库自动刷新出媒体文件；
3. 诊断日志 `%APPDATA%\wxnn-photo-manager\diag.log` 含新埋点（见 T4）。

若本机装有无限暖暖（Steam/Epic 任一），上述即为完整验收路径；未安装则验收"失败 Toast + 手动路径提示"降级路径。

### 3.3 单元测试命令

```bash
npm run test:main       # vitest run src/main
npm run test:renderer   # vitest run src/renderer
npm run typecheck
```

---

## 4. 错误处理

| 场景                                        | 降级策略                                                                                      | 日志                                                                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| ready-to-show 在 loadURL 前触发（D1 竞态）  | 监听器提前注册即消除；did-finish-load 兜底 + 15s 保险丝强制 resume（幂等，不重复 show）       | `diagLog('[WIN] scheduler resumed via ready-to-show/fallback/fuse')`；保险丝触发时 `logger.fault('schedulerStuckPaused')` |
| 全盘目录发现失败（首装无游戏/注册表未命中） | 既有链路返回 `success:false`；渲染端 Toast 展示原因 + 手动路径引导                            | worker 既有 `workerLog('warn', ...)` + `updateScanHistory('failed')`                                                      |
| worker 启动失败/超时                        | 既有 15s `READY_TIMEOUT_MS` 握手超时 → `notifyCrash` 弹窗 + `scanner:complete{success:false}` | 既有 `logger.fault('workerCrash')`                                                                                        |
| 初始 SCAN_PROGRESS 发送异常（T2）           | `sendEvent` 包 try/catch，失败仅记 warn 不中断扫描                                            | `workerLog('warn')`                                                                                                       |
| 保险丝 resume 时任务已执行                  | `resume()` 幂等（`paused=false` 重复调用无副作用），`pump()` 对空队列 no-op                   | info 级记录即可                                                                                                           |

所有新增日志走既有 `logger`/`diagLog` 统一渠道，不引入新日志机制。

---

## 5. 参数校验

- **IPC Payload（既有契约，本计划不放宽）**：
  - `scanner:complete`：`{ success: boolean; message?: string; filesFound?: number }`，渲染端回调已做 `result?.success` 判空（`ScanButton` L56-59）。
  - `task:progress`：`TaskProgress`（`src/shared/types/progress.ts`），`ScanProgress` 已按 `taskType` 白名单过滤。
  - `task:getActive` 返回 `TaskProgress | null`，渲染端已判空。
- **新增初始 SCAN_PROGRESS（T2）**：payload 遵循既有 `ScanProgress` 契约 `{ scanned: 0, found: 0, currentPath: string, status: 'running' }`，不新增字段；主进程 bridge 侧无需改动（既有 enrichment 逻辑兼容）。
- **保险丝定时器（T1）**：常量本地化（`SCHEDULER_RESUME_FUSE_MS = 15_000`），`unref()` 不持有事件循环；触发前检查 `taskScheduler.isPaused()` 避免误报 fault。
- **窗口兜底 show（T1）**：`did-finish-load` 回调检查 `!mainWindow.isDestroyed() && !mainWindow.isVisible()` 才 show，防止与 ready-to-show 双 show 闪烁。

---

## 6. 基础测试用例

| #   | 文件                                                                | 场景                                                                                                               | 断言                                                                                                                       |
| --- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| U1  | `src/main/app/__tests__/window-manager.test.ts`（新增用例）         | ready-to-show 在 `loadURL` promise resolve **之前**触发（利用现有 `_emit` mock 窗口，在 mock loadURL 内同步 emit） | `mainWindow.show()` 与 `ctx.taskScheduler.resume()` 仍被调用（RED→GREEN 驱动 T1）                                          |
| U2  | 同上                                                                | 正常时序（loadURL resolve 后再 emit ready-to-show）                                                                | show + resume 各调用一次，无重复                                                                                           |
| U3  | 同上                                                                | ready-to-show 未触发但 did-finish-load 触发                                                                        | 兜底 show + resume 被调用                                                                                                  |
| U4  | `src/main/scanner/__tests__/worker-entry.test.ts`（新增用例）       | `startScan({fullScan:true})` 进入 `findMediaDirectories` 前                                                        | 已发出一条 `SCAN_PROGRESS`（`status:'running'`、`scanned:0`、`currentPath` 为发现阶段文案），且发生在目录发现 resolve 之前 |
| U5  | 同上                                                                | 初始进度 sendEvent 抛异常                                                                                          | 扫描流程不被中断，仍走到 findMediaDirectories                                                                              |
| U6  | `src/main/scheduler/task-scheduler.test.ts`（新增文件）             | `resume()` 幂等：pause→resume→resume                                                                               | `isPaused()===false`，队列任务只执行一次                                                                                   |
| U7  | `src/renderer/components/scanner/ScanProgress.test.tsx`（新增用例） | 挂载后收到 `task:getActive` 快照（taskType='scan'，发现阶段 scanned=0）                                            | 浮窗渲染，显示发现阶段 message，不依赖 `scanProgress.scanning`                                                             |

运行：`npm run test:main` + `npm run test:renderer` + `npm run typecheck`。

---

## 7. 子任务与验收（TDD：每步先 RED 后 GREEN，验证通过再进下一步）

### T1 主修复：消除 ready-to-show 注册竞态 + 双重兜底

- **涉及文件**：`src/main/app/window-manager.ts`（修改）、`src/main/app/__tests__/window-manager.test.ts`（新增 U1-U3）
- **输入/输出**：
  - 输入：`AppContext`、`BrowserWindow` mock；
  - 改造：`const onFirstVisible = () => { if (done) return; done = true; mainWindow.show(); ctx.taskScheduler.resume(); diagLog(...) }`；将 `mainWindow.once('ready-to-show', onFirstVisible)` **移到** `loadURL` 调用之前；`did-finish-load` 回调追加 `if (!mainWindow.isVisible()) onFirstVisible()`；`setTimeout(SCHEDULER_RESUME_FUSE_MS)` 保险丝：若 `ctx.taskScheduler.isPaused()` 仍为 true 则 `resume()` + `logger.fault('schedulerStuckPaused')`，定时器 `unref()`。
- **验收标准**：
  1. U1/U2/U3 全绿（先 RED：现状 U1 失败）；
  2. `npm run test:main` 全量回归无失败；
  3. `npm run typecheck` exit 0。

### T2 worker 发现阶段初始进度事件（修 D3，连带改善 D2 可见性）

- **涉及文件**：`src/main/scanner/worker-entry.ts`（修改，`startScan` 头部、repair 步骤之前）、`src/main/scanner/__tests__/worker-entry.test.ts`（新增 U4/U5）
- **输入/输出**：`sendEvent({ type:'SCAN_PROGRESS', payload:{ scanned:0, found:0, currentPath:'正在搜索游戏目录…', status:'running' } })`（文案与既有硬编码中文消息风格一致）；外层 try/catch 兜底。主进程 bridge→`task:progress`→`setActiveScanTask` 链路既有，无需改动。
- **验收标准**：
  1. U4/U5 全绿（先 RED）；
  2. `npm run test:main` 全量回归通过；
  3. 手动 `npm run dev` 点全盘扫描：右下角浮窗在目录发现阶段即出现（当前为空白期）。

### T3 渲染端首装失败可见性确认（修 D2，最小改动）

- **涉及文件**：`src/renderer/components/scanner/ScanProgress.tsx`（修改 `onComplete` 回调）、`src/renderer/components/scanner/ScanProgress.test.tsx`（新增用例）
- **输入/输出**：`onComplete(result)` 中当 `result && result.success === false` 时，复用 `useGlobalToast` 展示 `t('toast.scanFailed'): result.message`（与 `ScanButton.reportScanFailure` 同款文案；不复制"未找到游戏目录"引导逻辑，保持最小）。启动路径与手动路径重复 Toast 的去重：ScanButton 的 onComplete 仅在 `scanning===true`（手动触发中）才提示，避免双弹。
- **验收标准**：
  1. 新用例：`onComplete({success:false,message:'x'})` 触发一次 error Toast；`success:true` 不触发；
  2. `npm run test:renderer` 全量回归通过。

### T4 触发链路诊断埋点（修 D4）

- **涉及文件**：`src/main/app/lifecycle.ts`（阶段 8 enqueue 处）、`src/main/scheduler/task-scheduler.ts`（`resume()` 内）
- **输入/输出**：`diagLog/logStartupError` 无适合处用 `logger.info`：
  - lifecycle：`logger.info('[Startup] startup-scan 已入队 (scheduler paused=' + ctx.taskScheduler.isPaused() + ')')`；
  - scheduler.resume()：`logger.info('[Scheduler] resume：低优先级队列恢复， queued=' + this.lowQueue.length)`。
- **验收标准**：`npm run test:main` 回归通过（既有 logger 断言不破坏）；打包首装运行后 diag.log/main.log 含上述两条。

### T5 打包端到端验收

- **涉及文件**：无代码改动（运行命令 + 首装模拟，见 §3.2）
- **验收标准**（全部达成）：
  1. 清 userData 后首装启动：**右下角在目录发现阶段即出现进度浮窗**；
  2. 本机有游戏：扫描完成后图库自动刷新出媒体，无人工干预；
  3. 本机无游戏（或改注册表模拟）：出现失败 Toast + 手动路径提示，图库空态文案可引导用户手动扫描；
  4. diag.log 含 T4 埋点，且无 `schedulerStuckPaused` fault；
  5. `npm run test`（全量）、`npm run typecheck`、`npm run pre-dist-check` 全绿。

### T6 交付文档

- **涉及文件**：`docs/plans/2026-08-24-fix-startup-autoscan-packaged.md`（本文件，勾选验收结果）
- **验收标准**：覆盖依赖声明/启动说明/错误处理/参数校验/基础测试用例五个强制章节，子任务均含涉及文件、输入/输出、验收标准。

---

## 8. 执行纪律备注

- 每个 T 先写失败测试（RED）→ 最小实现（GREEN）→ 全量回归，错误消灭在当前步骤。
- 严禁顺带重构无关代码；D1 修复保持 `createMainWindow` 其余监听器（did-fail-load/console-message/render-process-gone 等）不动。
- 构建注意（本机已知约束）：`npm run build` 的 clean 步可能触发 Safe-Delete 网关 EPERM，用 §3.2 的分步命令绕过；临时文件清理用 PowerShell `Remove-Item -LiteralPath`。

---

## 9. 验收结果（2026-08-24 执行完毕）

### 基础测试用例

| #   | 结果 | 证据                                                                               |
| --- | ---- | ---------------------------------------------------------------------------------- |
| U1  | ✅   | RED（show 0 次）→ GREEN；`window-manager.test.ts` 19/19                            |
| U2  | ✅   | 同上（重复触发不叠加）                                                             |
| U3  | ✅   | 同上（did-finish-load 兜底路径）                                                   |
| U4  | ✅   | RED（目录发现挂起期间无初始事件）→ GREEN；`worker-entry.test.ts` 2/2               |
| U5  | ✅   | postMessage 抛错不中断扫描，流程完整走到 SCAN_COMPLETE                             |
| U6  | ✅   | `task-scheduler.test.ts`：pause→enqueue→resume→resume 任务仅执行一次 + resume 日志 |
| U7  | ✅   | `ScanProgress.test.tsx` 15/15：getActive 快照即渲染浮窗（含发现阶段 message）      |

全量回归：`npm run test` 191 文件 / 3594 用例全绿；`npm run typecheck` exit 0；`npm run pre-dist-check` 全部闸门通过。

### 子任务

- **T1 ✅** ready-to-show 监听移至 loadURL 前 + did-finish-load 兜底 + 15s 保险丝（`SCHEDULER_RESUME_FUSE_MS`，unref）；新增 `schedulerStuckPaused` fault 类型（logger.ts + buildFaultTypeLabels + 12 份 locale key，zh-CN 有文案其余留空回退）。logger.test 故障类型计数 16→17。
- **T2 ✅** `startScan` 状态重置后（repair 之前）发送初始 `SCAN_PROGRESS`（`currentPath:'正在搜索游戏目录…'`），外层 try/catch + workerLog warn。
- **T3 ✅（含一处计划内细化）** ScanProgress.onComplete 失败 Toast（复用 `toast.scanFailed` 文案 key）；去重实现为 mediaStore `scanProgress.manualScan` 标记（ScanButton.handleScan 置 true）+ ScanButton 侧 `manualScanningRef` 本地守卫——比计划原文"仅 ScanButton 加 scanning 守卫"多一个 store 标记，原因是 ScanButton 守卫只能消除启动路径双弹，手动失败仍会双弹（两组件同在 GalleryPage 挂载）；store 标记使两条路径均恰好一弹（手动路径保留 ScanButton 的手动路径引导 hint）。既有用例不破坏。
- **T4 ✅** lifecycle 入队处 `logger.info('[Startup] startup-scan 已入队 (scheduler paused=…)')`；`TaskScheduler.resume()` 内 `logger.info('[Scheduler] resume：低优先级队列恢复， queued=…')`。
- **T5 ✅（沙箱适配，见下）** 构建产物 `release/win-unpacked/无限暖暖相册管理工具.exe`（2026-08-24 12:27）与 `release/NikkiGallery-Setup-2.3.5.exe`（12:28）生成；NSIS blockmap 构建完成后 electron-builder 触碰 Windows Recent 临时文件被沙箱拦截（exit 1），产物本身完整。
- **T6 ✅** 本节。

### T5 打包首装验收记录

沙箱限制：`%APPDATA%` 写操作（Remove-Item/Rename-Item）均被拦截，无法按 §3.2 删除真实 userData（内含用户真实图库 DB 4.75MB）。改用 **`--user-data-dir` 指向工作区临时目录**启动打包 exe——等效首装（scan_history 为空 → 强制全盘扫描），且零风险不动真实数据。

实测（本机装有游戏，完整验收路径）：

1. ✅ diag.log：`[WIN] scheduler resumed via did-finish-load`（T1 双兜底生效；resume 发生在 5s 入队延迟之前，时序正确）
2. ✅ main.log：`[Scheduler] resume：低优先级队列恢复， queued=0`（T4 埋点）
3. ✅ main.log：`[Startup] startup-scan 已入队 (scheduler paused=false)`（T4 埋点）
4. ✅ main.log：`[Startup] 扫描完成: { success: true, message: '全盘扫描完成，扫描 2 个目录，发现 30 个媒体文件，新增 30 个' }`——**打包首装启动扫描可靠触发并完成**（修复前该链路永不执行）
5. ✅ 无 `schedulerStuckPaused` fault；无 startup-errors.log；diag.log 无渲染层 error
6. ⚠️ 进度浮窗的视觉确认未做（当前模型无图像读取能力）；发现阶段浮窗出现由 U4（worker 发事件）+ U7（渲染端 getActive 快照渲染）+ 既有 bridge 链路（计划已排除项）组合覆盖
7. 顺带发现（**本计划范围外，未处理**）：main.log 有 `[Scanner] repairLegacyData 失败: near "(": syntax error`，为既有问题

### 交付物清单

- `src/main/app/window-manager.ts`（T1）、`src/main/scanner/worker-entry.ts`（T2）、`src/renderer/components/scanner/ScanProgress.tsx` + `ScanButton.tsx` + `src/renderer/stores/mediaStore.ts`（T3）、`src/main/app/lifecycle.ts` + `src/main/scheduler/task-scheduler.ts`（T4）、`src/main/utils/logger.ts`（fault 类型）、12 份 `src/renderer/i18n/locales/*.json`（faultTypes.schedulerStuckPaused）
- 新增测试：`window-manager.test.ts`（U1-U3）、`src/main/scanner/__tests__/worker-entry.test.ts`（U4/U5）、`src/main/scheduler/task-scheduler.test.ts`（U6）、`ScanProgress.test.tsx` 新增 describe（T3 三例 + U7）
- 测试辅助：`_test-helpers.ts` 默认 taskScheduler mock 追加 `isPaused`（保险丝触发时的安全 no-op）
