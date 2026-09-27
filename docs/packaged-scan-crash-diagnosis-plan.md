# 打包版"启动后扫描阶段闪退"排查与修复实施计划

> 状态：已确认执行（2026-09-27）。本文件为仓库内实施计划，执行完成后由 `docs/packaged-scan-crash-report.md` 记录最终结论。

## 0. 目标与非目标

**目标**：定位打包版（asar）在启动后自动扫描阶段闪退的根因；以 TDD 红绿流程完成最小化修复；交付日志收集与分析方法。

**非目标**：不做扫描算法重构、不改 IPC 契约、不处理 release/ 遗留 2.3.5 安装包清理（另行任务）。

## 1. 依赖声明

| 依赖                   | 类型 | 版本 | 安装方式 | 说明                                                                                  |
| ---------------------- | ---- | ---- | -------- | ------------------------------------------------------------------------------------- |
| 无新增运行时依赖       | —    | —    | —        | 全部复用仓库既有依赖（electron 40.10.6、better-sqlite3、vitest、electron-builder 等） |
| devDependencies 无新增 | —    | —    | —        | 测试复用 vitest 1.6.1 既有设施                                                        |

**环境硬约束**：本机 npm 有 Safe-Delete 网关（阈值 500 项），只能 `npm install` 增量安装，禁止 `npm ci` 与递归删除 `node_modules`。

## 2. 启动说明（环境准备 / 命令 / 验证）

```powershell
# 1) 环境准备（增量）
npm install

# 2) 开发启动（用于开发态复现与诊断日志采集）
npm run dev

# 3) 构建主进程产物（绕过 Safe-Delete 的构建序列）
npx electron-vite build
node -e "require('fs').writeFileSync('dist/main/package.json',JSON.stringify({type:'commonjs'}))"

# 4) 打包 Windows 安装包（asar）
npx electron-builder --win --publish never

# 5) 测试
npx vitest run src/main/scanner   # 相关测试子集
npm test                          # 全量回归
npm run typecheck                 # 类型检查
npm run lint                      # 静态检查
```

验证方式：构建产物存在 `dist/main/main/app/scanner-worker.js`；打包产物 `release/win-unpacked/resources/app.asar.unpacked/node_modules/better-sqlite3/` 存在原生绑定；安装版启动后扫描完成且 `文档/NikkiGallery/Diagnostics/` 产生正常日志。

## 3. 排查维度 × 关键代码 × 疑点

| 编号 | 疑点                            | 关键文件                                                                                                                                                      | 审计点                                                                                           |
| ---- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| S1   | asar 内 worker 原生模块加载失败 | `src/main/scanner/worker-entry.ts`（L125-142）、`src/main/utils/ffmpeg-paths.ts`、`package.json` build.asarUnpack、`scripts/pre-dist-check.ts`                | `require.resolve('better-sqlite3')` 在 asar 内的解析、app.asar.unpacked 产出、verify-asar 覆盖度 |
| S2   | 心跳竞争误判                    | `src/main/scanner/scanner-worker-bridge.ts`、`worker-entry.ts` 末尾看门狗                                                                                     | 主进程同步阻塞 >15s → worker 自杀退出 → bridge 误判崩溃 → 重启/重扫连锁                          |
| S3   | 重启恢复状态机不一致            | `scanner-worker-bridge.ts`（WorkerRestartPolicy/lastScanOptions）、`src/main/scanner/index.ts`（pendingComplete/restoreExecutor）、`src/main/app/recovery.ts` | 重启窗口与手动重扫并发、policy 耗尽后 notifyCrash 叠加/死循环、终态清理漏项                      |
| S4   | WAL 并发写失败路径              | `src/main/scanner/sqlite-retry.ts`、`worker-entry.ts` saveBatchToDatabase、`src/main/database/connection.ts`                                                  | SQLITE_BUSY 高峰下批量写异常是否未处理（worker uncaughtException 双保险是否闭合）                |
| S5   | 启动早期安全                    | `src/main/index.ts`、`src/main/app/startup-tasks.ts`、`src/main/utils/startup-diagnostic.ts`                                                                  | reportEarlyFatal 链路、无窗口早期 `promptAdminRelaunch`（kind=permission）安全性                 |

## 4. 诊断日志收集与分析方法

### 4.1 日志落点（按优先级）

| 日志               | 路径                                                                  | 用途                                                                    |
| ------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 启动错误日志       | `文档/NikkiGallery/Diagnostics/startup-errors.log`                    | 早期致命错误，`[STAGE: xxx]` 前缀定位阶段                               |
| 通用诊断           | `文档/NikkiGallery/Diagnostics/diag.log`                              | `diagLog(tag,msg)` 全程轨迹（BOOT/DB/WIN/INDEX）                        |
| Chromium 原生日志  | `文档/NikkiGallery/Diagnostics/chromium-debug.log`（>10MB 轮转 .old） | FATAL 原生退出（无 Node 崩溃栈时唯一证据）                              |
| 崩溃转储           | `文档/NikkiGallery/Diagnostics/`（crashDumps）                        | `crashReporter` dmp 文件，WinDbg/VS 打开看崩溃模块                      |
| 扫描诊断 JSONL     | scanLogStore 落盘路径（设置页可导出，`scan:exportScanLog`）           | E001–E005 错误码、stage、kind、detail                                   |
| electron-log       | `%APPDATA%/<userData>/logs/main.log`                                  | 主进程运行日志、WORKER_ERROR、notifyCrash 记录                          |
| Windows 事件查看器 | Application 日志 Event ID 1000/1001                                   | 崩溃模块名（如 node.dll / better_sqlite3.node）、异常代码 0xc0000005 等 |
| WER 转储           | `%LOCALAPPDATA%\CrashDumps`                                           | 用户态转储备用来源                                                      |

### 4.2 分析法

1. 时间线交叉：`diag.log` 的 BOOT→DB→WIN→扫描启动 时间戳 × electron-log 的 `[Scanner]` × 事件查看器崩溃时刻。
2. 错误码检索：JSONL 中 `code:E001–E005`、`kind:permission/path-missing`、`stage:startup-timeout`。
3. 退出码判定：worker exit code 0（看门狗自杀/正常）vs 非零（异常崩溃）；`startup-errors.log` 中 `[STAGE:]` 最后一条即崩溃前最后已知阶段。
4. 三次重启策略痕迹：10 分钟窗口内 3 次 `worker exit` + `restart scheduled` 日志 = policy 耗尽。

## 5. 错误处理与兜底策略（修复须沿用既有模式）

- `SCAN_COMPLETE` 终态必成对（worker `uncaughtException` 补发 + bridge `handleWorkerExit` 合成双保险）。
- 所有提前终止路径必走 `failReadyHandshake(reason)` reject，绝不止置 null。
- 主动 `kill()` 前必须置互斥标志（`startupTimedOut` / `terminatingForRestore` / `isDisposed`）。
- 终态成套清理：`taskRegistry.unregister` + `currentTaskId=null` + `cancelRequested=false` + `progressThrottle.dispose()` + `etaCalculator.reset()` + `setActiveScanTask(null)`。
- worker 侧 `SQLITE_BUSY/LOCKED` 才重试（指数退避），系统性错误立即 rethrow 中止扫描。
- 诊断日志写入全部 try/catch 静默失败（诊断模块自身不得引发二次崩溃）。
- 新增日志字符串：worker 侧硬编码中文须带 `// eslint-disable-next-line no-restricted-syntax`；UI 文案走 i18n。

## 6. 参数校验

- `SCAN_START` payload：`dbPath` 非空字符串且存在父目录；`options` 经 zod schema（沿用 `ipc/handlers/validator.ts` 既有校验）。
- 测试注入参数：`installParentPortStub()` 必须在 `import worker-entry` 之前；native 模块用 `Module._load` 拦截；bridge 测试用 fake timers。
- 非法值处理：dbPath 为空/不存在 → `openDatabaseIfNeeded` 失败即返回失败终态，不抛未捕获异常；`options.incremental` 等布尔字段做类型守卫。

## 7. 基础测试用例（正常 / 异常 / 边界）

| 类别 | 用例                                                                             | 断言                                                |
| ---- | -------------------------------------------------------------------------------- | --------------------------------------------------- |
| 正常 | worker 收 WORKER_PING 刷新 lastPingTime，心跳窗口内不自杀                        | 15s 后进程存活、扫描继续                            |
| 正常 | bridge 收非零 exit 且 isScanning → 合成失败 SCAN_COMPLETE + 走重启策略           | `pendingComplete` resolve、`restoredComplete` 透出  |
| 正常 | S1 审计结论落地：verify-asar 增加 better-sqlite3 unpacked 断言（若缺失）         | 脚本对缺产物报错                                    |
| 异常 | 主进程侧无 parentPort 引用 worker-entry 回归守卫（既有）                         | 守卫测试保持红灯不可发生                            |
| 异常 | policy 耗尽后不再重启、不重复 notifyCrash                                        | 第 4 次 exit 仅 notifyCrash 一次，无第 4 次 restart |
| 异常 | restoreExecutor 恢复扫描与 2s 重启窗口内手动重扫并发 → `duplicateScanStart` 拒绝 | 无双 `SCAN_START`、无 taskId 泄漏                   |
| 边界 | 心跳恰好 HEARTBEAT_TIMEOUT_MS（15s）临界：14.9s 存活 / 15.1s 自杀                | fake timers 推进断言                                |
| 边界 | `lastScanOptions` 为空时崩溃恢复不重扫                                           | 只 notifyCrash，不 startScan                        |

## 8. 子任务分解（文件 / 输入输出 / 验收标准）

### T1 写入本计划（本文件）

- 文件：`docs/packaged-scan-crash-diagnosis-plan.md`
- 输入：排查预读结论。输出：本文件。
- 验收：文件存在且含 §1–§8 全部小节。

### T2 日志取证与打包版复现

- 文件：无代码改动；产物 `docs/packaged-scan-crash-report.md`（证据章节）。
- 输入：本机构建产物 + 打包版运行。输出：崩溃时间线证据（或"无法在本机复现"的明确结论 + 日志采集指引）。
- 验收：报告中含至少一次打包版/开发态运行的日志摘录与时间线分析。

### T3 代码审计（S1–S5）

- 文件：只读审计，无改动；结论写入报告。
- 输入：§3 表列文件。输出：疑点-证据-代码位置审计表。
- 验收：S1–S5 每项有明确结论（证实/排除/待证据），排除项须引用代码行。

### T4 逐疑点 TDD 修复

- 文件：视审计结论，限定 `src/main/scanner/**`、`scripts/pre-dist-check.ts`、对应 `*.test.ts`；每次只动疑点直接相关代码。
- 输入：红灯测试。输出：绿灯测试 + 最小实现。
- 验收：每节点 `npx vitest run <相关测试>` 通过，且修复前该测试处于失败状态（记录红灯输出）。

### T5 打包产物校验

- 文件：`scripts/pre-dist-check.ts`（如需补断言）。
- 输入：electron-builder 产物。输出：校验通过。
- 验收：`npx electron-vite build` 后 `dist/main/main/app/scanner-worker.js` 存在；electron-builder 产物含 `app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node`；校验脚本对该缺失场景报错。

### T6 全量回归

- 验收：`npm test` 全部通过（无新增失败）、`npm run typecheck` 零错误、`npm run lint` 无新增告警；与基线（改动前）对比记录。

### T7 排查报告

- 文件：`docs/packaged-scan-crash-report.md`
- 验收：含根因结论 + 证据链、四维度审计表、修复记录（红灯/绿灯输出摘要）、§4 日志收集方法、全量回归结果。
