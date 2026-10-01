# 打包版"启动后扫描阶段闪退"排查报告

> 实施计划见 [packaged-scan-crash-diagnosis-plan.md](archive/packaged-scan-crash-diagnosis-plan.md)（已归档，不入仓）。排查日期：2026-09-27。

## 1. 结论速览

| 项           | 结论                                                                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 崩溃形态     | 主进程原生层 fail-fast，exit code `-1073740791`（`0xC0000409` STATUS_STACK_BUFFER_OVERRUN/FAST_FAIL，Chromium/V8 CHECK 与 CRT abort 的典型退出码）                    |
| 崩溃进程     | **主进程**（utilityProcess 子进程崩溃不会带走主进程；退出码由 Start-Process 主 PID 观测）                                                                             |
| 崩溃时刻     | 启动后 **6–9 秒**（19:00:59 启动 → 19:01:05–08 死亡），正处于启动扫描完成→索引链→场景分析的窗口                                                                       |
| JS 级退出    | **已排除**：exit-forensics 无 `last-exit.json`（任何 app.exit/process.exit/before-quit 都会留痕）；主进程 uncaughtException/unhandledRejection 兜底均在场但无触发痕迹 |
| 崩溃转储     | 未生成（crashpad 未捕获 fail-fast）；已用 WER LocalDumps（HKCU）布置下次捕获                                                                                          |
| 复现率       | 首次运行打包版（含旧版本 userData 迁移/一次性自检）时触发，之后约 20 次运行未再复现                                                                                   |
| 根因定位状态 | **待转储最终定位**；四维度 JS 级疑点全部审计排除（见 §3），指向原生依赖（sharp/libvips 或 better-sqlite3）在扫描-索引并发窗口内的低频原生崩溃                         |

## 2. 证据链

### 2.1 复现运行（2026-09-27 19:01，本次排查实际捕获）

1. `electron-builder --win --dir` 产物 `release/win-unpacked/无限暖暖相册管理工具.exe`，首启即闪退：`EXITED code=-1073740791`（0xC0000409）。
2. `%APPDATA%/wxnn-photo-manager/logs/main.log` 最后一行：
   `[2026-09-27 19:01:05.445] [info] [Startup] 场景时段分析：开始分析 19 张图片`
   其前 2ms 是 media-worker 的 pHash 批次 ENOENT 洪流结束（05.426–05.443），前 5s 是 `[Cleanup] 修复 12 条缩略图记录`（主进程 sharp）。
3. `diag.log` 最后记录：`[FFMPEG] binary path contains non-ASCII chars, fall back to system PATH`（11:01:05.389，media-worker 加载 video-probe）。
4. `heartbeat.json`（exit-forensics）：最后心跳 `11:01:03.680Z`，`stage=initialized`；无 `last-exit.json` → 原生终止。
5. 下次启动由 exit-forensics 判定：`检测到上次运行被外部/原生层终止（无 JS 退出痕迹）`。
6. Windows 事件查看器 Event ID 1000 有对应记录但 EventData 为空（本地化模板缺失）；crashpad（`%APPDATA%/wxnn-photo-manager/crashes/reports`）无当日转储。

### 2.2 历史同型崩溃

轮转日志 `main-2026-09-27.log` 证实 18:44（10:44Z）另有一次崩溃，最后一行同样是 `[Startup] 场景时段分析：开始分析 19 张图片`——两次独立崩溃的最后日志一致。

### 2.3 关键排除实验

| 实验                                                            | 结果                                                                                                                                                                                       | 排除对象                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| 隔离脚本用 electron + sharp 逐张分析崩溃前 19 行                | 18 行文件缺失（JS 错误被捕获）、1 行真实截图解码 OK，无崩溃                                                                                                                                | sharp 单独解码该图片集         |
| 主进程一次性真实解码 151 张图片（重置 scene_time 后运行）       | 无崩溃                                                                                                                                                                                     | "场景分析解码真实图片必崩"假设 |
| 8 轮猎捕循环（每轮重置 pHash/scene 状态 + WER LocalDumps 布防） | 0 崩溃                                                                                                                                                                                     | 状态级确定性复现               |
| asar 产物校验                                                   | `app.asar` 内 `scanner-worker.js`/`preload.js` 在位；`app.asar.unpacked` 含 `better-sqlite3/build/Release/better_sqlite3.node`、sharp、koffi、ffmpeg-static；`pre-dist-check` ABI 闸门通过 | S1 打包原生模块链路            |

## 3. 四维度审计结论（S1–S5）

| 疑点                | 结论                                      | 证据                                                                                                                                                                                                                                         |
| ------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1 打包原生模块链路 | **排除**（产物侧）                        | §2.3 asar 校验；`worker-entry.ts` L125-142 惰性 require + `resolveAsarUnpackedPath`；若模块加载失败会走 worker `uncaughtException` 补发 SCAN_COMPLETE（JS 痕迹），与本次"无 JS 痕迹"不符                                                     |
| S2 心跳竞争误判     | **排除**（非本次根因）；机制本身完整      | `worker-entry` 看门狗与全部顶层副作用均有 `process.parentPort` 守卫（2026-08-29 根因已修复，`scan-abort.test.ts` 有回归守卫）；bridge 心跳 5s/退出即停。但注意：主进程事件循环阻塞 >15s 仍会触发 worker 自杀退出，属"扫描失败"而非主进程崩溃 |
| S3 重启恢复状态机   | **排除**                                  | `failReadyHandshake` 必 reject、三互斥标志（startupTimedOut/terminatingForRestore/isDisposed）、`isScanning` 并发去重、restoreExecutor 经 Manager 走完整状态机——均为既有实现且有 `scanner-worker-bridge.test.ts` 覆盖                        |
| S4 WAL 并发写       | **排除**（崩溃根因）；发现 1 处健壮性弱点 | worker 侧 `executeWriteSafely` 只对 SQLITE_BUSY/LOCKED 指数退避；主进程 `autoAnalyzeSceneTime` 的 `updateStmt.run`（startup-tasks.ts）未包 try/catch，瞬时 SQLITE_BUSY 会中断整轮分析（被外层 catch 吞掉，不崩溃，仅遗留 unknown 行）        |
| S5 启动早期安全     | **排除**；发现 1 处陈旧注释               | `index.ts` 早期 uncaughtException→reportEarlyFatal 在场；`permission.ts` 头注释称 manifest 为 requireAdministrator，实际 `package.json build.win.requestedExecutionLevel=asInvoker`（注释过时，行为正确）                                    |

## 4. 已实施修复（TDD 红绿闭环）

### 4.1 exit-forensics 精细阶段打点（本次唯一代码改动）

**动机**：两次崩溃的 `heartbeat.json.stage` 都停留在 `initialized`（exit-forensics 仅有 boot→when-ready→initialized→cleanup 四个里程碑），无法定位崩溃处于扫描/索引窗口的哪个子阶段。下次再崩溃时 stage 可直接指认。

| 文件                                           | 改动                                                                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/main/app/startup-tasks.ts`                | `performStartupScan` 开始 → `markExitStage('startup-scan')`；`runPostScanIndexing` 开始 → `'post-scan-indexing'`；`autoAnalyzeSceneTime` 开始 → `'scene-analysis'` |
| `src/main/app/__tests__/startup-tasks.test.ts` | 新增 3 个用例（32/33/34）：断言三个阶段打点被调用                                                                                                                  |

- 红灯：3 个新用例修复前全部失败（`markExitStageMock` 未被调用）。
- 绿灯：`startup-tasks.test.ts` 54/54 通过；相关子集 exit-forensics 12/12、lifecycle 38/38 通过。
- 零依赖新增、零行为变更（markExitStage 是纯取证打点，不参与业务控制流）。

### 4.2 回归结果

| 检查                          | 结果                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `npm test`（全量 vitest）     | **285 文件 / 4808 用例全部通过**                                                                        |
| `npm run typecheck`（tsc -b） | 零错误                                                                                                  |
| `npm run lint`（eslint）      | 零告警                                                                                                  |
| 重建产物校验                  | `dist/main/main/app/scanner-worker.js`（含修复）、`index.js`、`package.json {"type":"commonjs"}` 均在位 |

## 5. 诊断日志收集与分析方法（用户侧操作指引）

### 5.1 收集（按优先级）

1. **退出取证心跳**：`%APPDATA%/wxnn-photo-manager/heartbeat.json`（崩溃后勿删）+ `last-exit.json`——`stage` 字段按本次修复将直接显示崩溃所处子阶段（startup-scan / post-scan-indexing / scene-analysis）。
2. **主进程日志**：`%APPDATA%/wxnn-photo-manager/logs/main.log`（每日轮转 `main-YYYY-MM-DD.log`）——最后几行即崩溃前最后已知活动；`[Fault:exitDiagnosis]` 行确证"原生层终止"。
3. **启动错误**：`文档/NikkiGallery/Diagnostics/startup-errors.log`（`[STAGE: xxx]` 前缀）与 `diag.log`（BOOT/DB/WIN/FFMPEG/EXIT-FX 标签）。
4. **Chromium 原生日志**：`文档/NikkiGallery/Diagnostics/chromium-debug.log`（GPU 进程连续崩溃、FATAL 等原生层证据；本机历史记录有 GPU process exit_code=1 反复崩溃）。
5. **扫描诊断 JSONL**：设置页诊断工具导出（`scan:exportScanLog`），检索 `code:E001–E005`、`kind:permission`。
6. **Windows 事件查看器**：Application 日志 Event ID 1000（崩溃模块名/异常代码）；本机模板缺失时用 PowerShell：
   `Get-WinEvent -FilterHashtable @{LogName='Application';Id=1000} -MaxEvents 3 | % { ([xml]$_.ToXml()).Event.EventData.Data }`
7. **强制转储（推荐在复现机上常驻）**：写入注册表
   `HKCU\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\<exe名>`：
   `DumpFolder=<目录> (ExpandString)`、`DumpType=2 (DWORD 全量)`、`DumpCount=5`。
   下次闪退会在 DumpFolder 生成 .dmp，可用 WinDbg `!analyze -v` 或 Visual Studio 打开，直接看到崩溃线程与模块（预期为 sharp/libvips 或 better-sqlite3 的原生帧）。

### 5.2 分析法

1. **时间线交叉**：main.log 最后时间戳 × heartbeat.updatedAt × 事件查看器崩溃时刻，误差 ≤5s。
2. **JS/原生判定**：有 last-exit.json = JS 管理退出；无 = 原生/外部终止。
3. **退出码**：`0xC0000409` = fail-fast（V8 CHECK / CRT abort / 栈保护）；`0xC0000005` = 访问违例；0 = 正常/看门狗自杀。
4. **重启策略痕迹**：10 分钟窗口 3 次 `[ScannerWorker] 异常退出 + restart` = policy 耗尽（仅 notifyCrash）。

## 6. 遗留事项

1. **转储待捕获**：崩溃为低频一次性事件（推测与旧版本 userData 首次迁移/一次性自检窗口相关）。建议按 §5.1-7 在用户机布置 WER LocalDumps 后等待/复现一次，用 dmp 完成最终归因。
2. `src/main/app/permission.ts` 头注释与实际 manifest（asInvoker）不符，建议顺手更正（未改，属无关改动）。
3. `autoAnalyzeSceneTime` 的 `updateStmt.run` 可加单行 try/catch 提升 WAL 突发冲突健壮性（未改，与本次崩溃无因果关系）。
4. 排查过程临时产物（诊断脚本/日志/WER 注册表键/DB 状态备份）已全部清理并恢复原状。
