# 修复打包版首装全盘扫描早退（launcher 缓存命中被误判为游戏目录）与图库空态静默

> 交付物：打包版**首次安装启动**时，全盘扫描不再因 launcher 缓存命中而跳过签名搜索（非标准安装路径机器可发现截图目录）；扫描成功但图库过滤后为空时，用户获得引导 Toast 与正确的空态文案（不再死循环误导）；目录发现过程在打包版 main.log 可诊断（e2e S7 门禁守护）。
> 范围控制：批次三仅新增 e2e 用例（T5）与重建打包/门禁/首装验收/交付文档（T6）；批次一/二（T1-T4）代码已冻结，本批次未改动 `src/` 任何文件。

---

## 1. 问题背景

用户报告的打包版首装症状：**图库恒空 + 进度浮窗不可感知**。

三层根因结论（按发现顺序）：

1. **触发链路（已于 2026-08-24 上午修复，见 `2026-08-24-fix-startup-autoscan-packaged.md`）**：ready-to-show 注册竞态导致调度器不 resume → 扫描永不触发。该层修复后日志实证链路健康（`startup-scan 已入队` → `扫描完成` 均出现）。
2. **本缺陷 N1（主因）**：`findMediaDirectories` 的快速路径早退条件 `autoSet.size > 0` 把 **launcher 缓存命中**（如 `AppData\Local\InfinityNikki Launcher\cache\images`）当"游戏目录已找到"，首装全盘扫描时跳过签名搜索 → 秒完成（浮窗一闪而过）+ **游戏安装在非 Steam/Epic 标准路径的机器永远发现不了截图目录**（图库恒空的直接来源）。
3. **本缺陷 N2**：扫描成功（success:true）但图库按设计过滤 launcher 图后为空时**完全静默**——无 Toast、空状态文案仍是"点击扫描按钮开始扫描"（误导用户反复扫描的死循环）。
4. **本缺陷 R5（可诊断性）**：目录发现日志被 worker（`workerLog` 对 info 直接丢弃）/ bridge（SCAN_LOG 无 info 分支）**双级 info 过滤**，打包版 main.log 完全看不到目录发现了什么——N1 在现场不可诊断。

---

## 2. 修复内容（T1-T5，批次一/二/三）

### T1 全盘扫描强制签名搜索（修 N1 主因）

`src/main/scanner/worker-entry.ts` `findMediaDirectories` 新增第二参数 `opts.forceSignatureSearch`：

- 仅 `fullScan` 调用点传 `true`：早退条件改为 `autoSet.size > 0 && !opts?.forceSignatureSearch`，强制走全盘签名搜索并**合并**结果（autoSet 继续累加，末尾 Set 去重）；
- 增量/常规路径不传 opts，保持快速早退不变（零行为变更，U-B 回归保护）。

### T2 目录发现日志透传（修 R5）

- worker 侧新增 `sendScanLogInfo`：白名单式低频 info 透传（仅 3 处结论性日志：全盘签名搜索开始 / findMediaDirectories 搜索结果 / 逐目录行），绕过 `workerLog` 的 info 屏蔽；
- bridge 侧（`scanner-worker-bridge.ts`）SCAN_LOG 分发补 info 分支 → `logger.info`；
- 日志行格式：`[ScannerWorker] [Scanner] findMediaDirectories 搜索结果: N 个目录（自定义 X + 自动发现过滤后 Y）` + 逐目录行 `[ScannerWorker] [Scanner]   - <path>`。

### T3 ScanProgress D5 引导 Toast（修 N2 前半）

扫描成功 + 刷新后图库仍空 → 弹一次 info 引导 Toast，两态文案：

- `filesFound > 0`（Number.isFinite 判定）：`toast.scanFoundButGalleryEmpty` 带 count 插值（“扫描完成：发现 N 个文件，但均不是游戏内截图……可在扫描菜单中选择「指定目录扫描」”）；
- `filesFound` 缺省：`toast.scanCompletedNoGameShots`（“扫描完成：未发现游戏内截图……”）。（文档初版把两个 key 写反，此处已按实际代码修正，见 §9.1 次要项）
- 会话内 `galleryEmptyHintShownRef` 去重，不重复弹。

### T4 GalleryPage hasScanned 空态文案（修 N2 后半）

`src/renderer/pages/GalleryPage.tsx` 新增 `hasScanned` 状态（`scanner.status()` 查询 completed/failed + 订阅 `scanner:complete` 事件双通道置位；查询失败静默兜底），空状态 subtitle 按 `hasScanned` 切换为 `galleryPage.emptySubtitleScanned` 引导文案（i18n key 已入全部 12 份 locale = zh-CN 基准 + 11 份对比文件——`i18n:check` 输出的 “11 locale” 是对比文件数；批次 B 评审后九份对比文件已回填英文文案消除空串 Toast 风险，见 §9.3）。

### T5 e2e S7 门禁（批次三）

`e2e/smoke.e2e.ts` 新增 S7（详见 §6 U-H）：首装会话（S1 的临时 userData → scan_history 空 → 强制全盘扫描）轮询日志断言三行齐备（开始扫描 / 扫描完成 / findMediaDirectories 搜索结果），把 N1+T1+T2 的行为锁进打包产物冒烟门禁。

---

## 3. 依赖声明

- **零新增 npm 依赖**。
- 全部复用既有设施：`logger.info`（`src/main/utils/logger.ts`）、SCAN_LOG 消息通道与 bridge 分发骨架、`useGlobalToast`、`scanner.status()` IPC、Playwright `_electron.launch`（e2e 既有 helpers）。

---

## 4. 复现与验证

### 4.1 首装模拟（--user-data-dir 沙箱方式，不动真实数据）

```powershell
# 定位产物并指定全新临时 userData（等效首装：scan_history 空 → 强制全盘扫描）
$exe = (Get-ChildItem "h:\...\release\win-unpacked\*.exe" | Select-Object -First 1).FullName
$ud  = "h:\...\.cache\verify-first-launch"     # 全新目录
$p = Start-Process -FilePath $exe -ArgumentList "--user-data-dir=`"$ud`"" -PassThru
# 注意：$ud 含空格时 Start-Process 必须显式内嵌引号，否则 switch 值被拆断
```

日志位置：`$ud\logs\main-*.log`（electron-log 按日轮转）。

### 4.2 观察点（验收判据）

| #   | 日志行                                                                              | 来源                                                     |
| --- | ----------------------------------------------------------------------------------- | -------------------------------------------------------- |
| a   | `[Startup] 开始后台自动扫描，首次启动: true，全盘扫描: true，增量模式: false`       | startup-tasks.ts                                         |
| b   | `[ScannerWorker] [Scanner] 全盘签名搜索开始（快速路径已命中 N 个目录）`             | worker-entry.ts（T2）                                    |
| c   | `[ScannerWorker] [Scanner] findMediaDirectories 搜索结果: N 个目录（…）` + 逐目录行 | worker-entry.ts（T2）                                    |
| d   | `[Startup] 扫描完成: {success:true, …}`                                             | startup-tasks.ts（i18n `main.startup.log.scanComplete`） |
| e   | 无 `schedulerStuckPaused` / `workerCrash` fault                                     | logger fault 通道                                        |

### 4.3 e2e 门禁

```powershell
npm run e2e:smoke    # S1-S7 + userData 隔离校验，全绿
```

### 4.4 沙箱人工验收已知约束（2026-08-24 实测）

- **Start-Process 无引号**：`--user-data-dir` 值含空格（`WXNN XiangCe2`）被拆断 → userData 落工作区外 → singleton lock 创建被拒（`Error code: 5`）→ 应用卡死。必须按 §4.1 内嵌引号。
- **Start-Process（ShellExecute）即使引号正确**：在本机 Qoder 沙箱 job 下 mojo `platform_channel` OpenProcess 被拒 → 渲染进程 8s 未就绪（`renderer-not-ready` fault）→ 应用静默退出。**非产物缺陷**——同一 exe 经 Playwright / node spawn（CreateProcess + pipe）启动完全正常（e2e S1-S7 全绿 + §7 T6 首装验收全过）。人工验收遇此情况改用 node spawn 启动。

---

## 5. 错误处理与边界

| 场景                          | 策略                                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `findMediaDirectories` 新参数 | 可选（`opts?.forceSignatureSearch`），不传保持既有快速早退，调用方零迁移成本                                      |
| T3 filesFound 判定            | `Number.isFinite(filesFound) && filesFound > 0` 两态文案，缺省/NaN 走缺省分支                                     |
| SCAN_LOG info 透传            | 白名单式仅 3 处结论性日志（低频），不会造成日志洪泛；error/warn 分发行为不变                                      |
| T4 scanner.status() 查询      | 可选链 + catch 静默兜底（status=idle → 默认文案不切换），IPC 不可用不阻塞渲染                                     |
| T4 双通道置位                 | status 查询（completed/failed）+ scanner:complete 事件订阅，卸载解绑；两路幂等                                    |
| e2e S7 轮询                   | fs 读取全部 `.log`（含轮转 `.old.log`）拼接后 includes；readdir/readFile 各自 catch 容错（logs 目录未创建时不抛） |

---

## 6. 测试用例表

| #        | 文件                                                                   | 场景                                                                                                                                                    | RED→GREEN 结果                                              |
| -------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| U-A      | `src/main/scanner/__tests__/worker-entry.findMediaDirectories.test.ts` | forceSignatureSearch 时 launcher 缓存命中不早退，仍执行全盘签名搜索并合并结果                                                                           | ✅ RED（早退跳过签名搜索）→ GREEN                           |
| U-B      | 同上                                                                   | 不传 opts 时保持快速早退不变（回归保护）                                                                                                                | ✅ GREEN（回归保护例，无 RED 阶段）                         |
| U-C      | `src/main/scanner/__tests__/worker-entry.test.ts`                      | findMediaDirectories 结论日志以 SCAN_LOG info 事件透传到主进程                                                                                          | ✅ RED（workerLog info 屏蔽，无事件发出）→ GREEN            |
| U-D      | `src/main/scanner/scanner-worker-bridge.test.ts`                       | SCAN_LOG info 级别透传 logger.info（不误走 error/warn 分支）                                                                                            | ✅ RED（bridge 无 info 分支）→ GREEN                        |
| U-E      | `src/renderer/components/scanner/ScanProgress.test.tsx`                | 扫描成功（发现 30 个文件）但刷新后图库为空 → 弹 info 引导 Toast（含真实数量），会话内去重                                                               | ✅ RED→GREEN                                                |
| U-F①②③   | 同上                                                                   | ①刷新后图库非空不弹；②filesFound 缺省 → scanCompletedNoGameShots 分支文案；③success:false → 既有 D2 error Toast 行为不变                                | ✅ 全 GREEN                                                 |
| U-G①②③   | `src/renderer/pages/GalleryPage.test.tsx`                              | ①status=completed 且图库空 → emptySubtitleScanned 文案；②status 查询失败 → 兜底默认文案；③status=idle 但收到 scanner:complete → hasScanned 置位切换文案 | ✅ 全 GREEN                                                 |
| U-H (S7) | `e2e/smoke.e2e.ts`                                                     | 首装自动扫描：扫描执行、完成且目录发现可观测（三日志行齐备）                                                                                            | ✅ RED（旧产物 discovery:false）→ GREEN（新产物 7.0s 通过） |

运行：`npm run test`（全量 vitest）+ `npm run e2e:smoke`（Playwright，需先 `npm run dist:win` 产物）。

---

## 7. 子任务验收记录

### T1-T4（批次一/二，代码冻结前的完成态）

单测全绿（U-A/U-B、U-C、U-D、U-E/U-F、U-G 全部通过）；本批次复证：`npm run test` 全量 **191 文件 / 3610 用例全绿**（含上述全部用例），`npm run typecheck` exit 0。

### T5 e2e S7（批次三，本批次执行）

**RED（对旧产物 exe 2026-08-24 13:05:27，不含 T1/T2）**：

```
npx playwright test --config e2e/playwright.config.ts e2e/smoke.e2e.ts -g "S1|S7"
  ok  S1 启动与主窗口 (4.1s)
  x   S7 首装自动扫描 (1.5m)
      Object {
    -   "discovery": true,
    +   "discovery": false,
        "done": true,
        "started": true,
      }
      Timeout 90000ms exceeded while waiting on the predicate
```

- started/done 为 true（既有日志行在旧产物已存在）、**discovery: false**（缺 T2 的 `findMediaDirectories 搜索结果` 行）——正是预期失败模式，证明 S7 能区分新旧产物。
- 附注：任务原始命令 `-g "S7"` 单跑会因模块级 `launched` 未被 S1 赋值而 TypeError 快速失败（非日志断言失败），故 RED 取证改用 `-g "S1|S7"`；GREEN 阶段全量运行（S1-S7 串行）无此问题，用例代码保持任务给定原样。

**GREEN（对新产物 exe 2026-08-24 14:44:30）**：见 T6 6.3。

### T6 重建打包 + 全量门禁 + 首装验收（批次三，本批次执行）

**6.1 全量回归门禁（重建前）**：

| 命令                     | 结果                                                                                                                                                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run test`           | ✅ Test Files 191 passed (191)，Tests **3610 passed (3610)**，22.73s                                                                                                                                                                                            |
| `npm run typecheck`      | ✅ exit 0                                                                                                                                                                                                                                                       |
| `npm run i18n:check`     | ✅ 11 个 locale 文件 3511 keys 全部对齐，exit 0                                                                                                                                                                                                                 |
| `npm run pre-dist-check` | ⚠️ 重建前 exit 1：`main/renderer 产物比源码旧`（dist 05:02 UTC < T1-T4 源码 06:10/06:31 UTC）——这是"需重建"的预期信号非代码缺陷；其余 17 项校验（worker 产物/ABI 闸门/协议处理器等）全过；**6.2 步骤 3 重建后复跑 exit 0 全部校验通过**（含 README 版本一致性） |

**6.2 重建打包（分步命令）**：

| 步骤 | 命令                                                             | 结果                                                                         |
| ---- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1    | `npx electron-vite build`                                        | ✅ exit 0（main 952ms / preload 27ms / renderer 4.20s，未遇 clean 步 EPERM） |
| 2    | `node -e "…writeFileSync('dist/main/package.json', …commonjs…)"` | ✅ `{"type":"commonjs"}`                                                     |
| 3    | `npm run pre-dist-check`                                         | ✅ exit 0（main 产物 06:43:29Z / renderer 06:43:33Z 均新于源码，20 项全过）  |
| 4    | `npx electron-builder --win --publish never`                     | ✅ **exit 0**（本次 NSIS blockmap 阶段亦成功，未触发已知 EPERM）             |

**产物更新证据**：

- `release/win-unpacked/无限暖暖相册管理工具.exe`：LastWriteTime **2026/8/24 13:05:27 → 14:44:30**（213,976,576 字节）
- `release/NikkiGallery-Setup-2.3.5.exe`：2026/8/24 14:44:52（168,156,464 字节）
- app.asar 内容验证（node 字符串搜索）：`forceSignatureSearch: true`（T1）、`全盘签名搜索开始: true`（T2）、`findMediaDirectories 搜索结果: true`（T2）——T1/T2 代码确认入产物。

**6.3 e2e GREEN（对新产物）**：

```
npm run e2e:smoke → 8 passed (16.2s)，exit 0
  ok S1 启动与主窗口 (1.4s)      ok S2 非白屏 (333ms)
  ok S3 preload 注入 (3ms)       ok S4 主进程 IPC 探针 (3ms)
  ok S5 DB/原生模块探针 (2ms)    ok S6 启动稳定性 (5.0s)
  ok S7 首装自动扫描 (7.0s)      ok userData 隔离校验 (9ms)
```

RED→GREEN 闭环：旧产物 S7 failed（discovery:false，1.5m）→ 新产物 S7 passed（**7.0s**，三日志行齐备）。

**6.4 沙箱首装人工验收（node spawn + `--user-data-dir` 全新目录，等效首装）**：

观察点 a-e 实际日志行摘录（t56b 会话，本机装有游戏，完整验收路径）：

```
[a] 15:01:04.454 [INFO] [Startup] 开始后台自动扫描，首次启动: true，全盘扫描: true，增量模式: false
    15:01:04.456 [INFO] [Startup] startup-scan 已入队 (scheduler paused=false)
[b] 15:01:04.637 [INFO] [ScannerWorker] [Scanner] 全盘签名搜索开始（快速路径已命中 2 个目录）
[c] 15:01:07.925 [INFO] [ScannerWorker] [Scanner] findMediaDirectories 搜索结果: 7 个目录（自定义 0 + 自动发现过滤后 7）
    15:01:07.926 [INFO] [ScannerWorker] [Scanner]   - C:\Users\45001\AppData\Local\InfinityNikki
    15:01:07.926 [INFO] [ScannerWorker] [Scanner]   - C:\Users\45001\AppData\Local\InfinityNikki Launcher\cache\images
    15:01:07.927 [INFO] [ScannerWorker] [Scanner]   - H:/InfinityNikki Launcher/InfinityNikki/X6Game
    15:01:07.927 [INFO] [ScannerWorker] [Scanner]   - H:/InfinityNikki Launcher/InfinityNikki/X6Game/Saved
    15:01:07.927 [INFO] [ScannerWorker] [Scanner]   - H:/InfinityNikki Launcher/InfinityNikki/X6Game/Saved/CustomAvatar
    15:01:07.927 [INFO] [ScannerWorker] [Scanner]   - H:/InfinityNikki Launcher/InfinityNikki/X6Game/Saved/CustomCard
    15:01:07.928 [INFO] [ScannerWorker] [Scanner]   - H:/InfinityNikki Launcher/InfinityNikki/X6Game/Saved/GamePlayPhotos/114077271
[d] 15:01:08.536 [INFO] [Startup] 扫描完成: {"success":true,"message":"全盘扫描完成，扫描 7 个目录，发现 497 个媒体文件，新增 497 个","filesFound":497}
[e] schedulerStuckPaused 行数=0；workerCrash 行数=0；faults-*.jsonl 为空
```

**T1 修复价值的直接实证**：快速路径仅命中 2 个 launcher 缓存目录（旧代码到此即早退），强制签名搜索后最终发现 **7 个目录**（含 `X6Game/Saved/GamePlayPhotos` 等真实截图目录）→ 扫描入册 **497 个媒体文件**。目录发现 3.3s，全流程 4.1s 完成。

验收现场已清理（临时 userData 目录删除、诊断脚本删除、残留进程 0）。

### 二轮修复验收（批次 A/B，2026-08-24 下午）

批次三交付后三路评审（发现汇总见 §9.1）的阻断 1 项 + 重要 2 项 + 次要若干，由批次 A/B 修复并复证：

| 批次   | 范围                                                                                        | 用例结果                                                                     |
| ------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 批次 A | `worker-entry.ts` 四集合分组（R1）+ 注册表高置信早退（R2）+ 日志截断/JSDoc/用例改名等次要项 | 主进程 **2419 用例全绿**（含新增 U-I/U-J 两条）                              |
| 批次 B | D5 Toast 与空态文案限定 `currentView === 'gallery'` + 九份 locale 回填英文                  | 渲染端 **1158 用例全绿**（含新增 U-H 两条：ScanProgress / GalleryPage 各一） |

批次 C 收口的全量门禁、重建产物、e2e 与沙箱首装复验证据：见 §9.5（回填）。

### T6 交付文档

本文件（§1-§9）。

---

## 8. 范围外事项（未处理，仅记录）

- **repairLegacyData SQL 语法错误**（既有问题）：首装日志再次出现 `[ScannerWorker] [Scanner] repairLegacyData 失败: near "(": syntax error`，与 8-24 上午批次记录一致，不影响扫描主流程（本次 497 文件正常入册）。
- Start-Process（ShellExecute）在 Qoder 沙箱 job 下 mojo OpenProcess 被拒导致渲染进程起不来（§4.4）：属沙箱环境与进程创建方式的交互问题，非产物缺陷，产物代码不改动。

---

## 9. 评审与二轮修复记录（2026-08-24 下午）

> 批次三交付（§7 T6，产物 14:44:30，不含下述修复）后进行三路评审，发现的全部问题已于当日下午以批次 A（主进程）/ 批次 B（渲染端）两批修复完毕（代码已冻结）；本节记录评审发现、修复内容与修复后行为语义。批次 C（收口）仅重建产物、跑全量门禁/e2e/首装复验并回填证据，未改动 `src/` 任何文件。

### 9.1 三路评审发现汇总

| 级别       | 发现                                                                                                                                                                                                     | 根因与影响                                                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 阻断 ×1    | **软过滤误伤签名搜索命中**：T1 实现将签名命中并入结果后对合并集合整体做 `infinitynikki` 软过滤，launcher 缓存命中（路径含 InfinityNikki）时签名搜索发现的**中文安装路径**等非 infinitynikki 目录被误剔除 | 中文安装路径场景（T1 的目标场景）修复完全落空；U-A 用例的模拟路径恰好含 `InfinityNikki`，形成测试盲区未拦住                                    |
| 重要 ×2    | ① **D5 Toast 与空态文案未限定视图**：`mediaFiles` 是按 `currentView` 过滤后的结果，缓存/收藏视图下为空只代表该板块空，不代表图库空；② **Steam/Epic 高置信命中仍强制全盘搜索**                            | ① 缓存/收藏视图下扫描成功会弹“未发现游戏内截图”这类**与事实相反**的提示；② 注册表命中的就是游戏安装路径，force 时仍做数十秒 depth-6 遍历零收益 |
| 次要 ×若干 | 文档 §2 T3 key 名写反；`findMediaDirectories` JSDoc 未反映 T1 后语义；9 份对比 locale 新 key 空串；bridge 用例名漂移；逐目录日志无截断；ScanButton 注释过时                                              | 可维护性/一致性，无运行时阻断                                                                                                                  |

### 9.2 批次 A 修复（`worker-entry.ts` 按来源分组，主进程）

- **R1 四集合分组**（修阻断项）：`findMediaDirectories` 内部按来源分 `customSet`（自定义路径，恒包含）/ `registrySet`（Steam/Epic 注册表命中，高置信——注册表项就是 InfinityNikki 安装路径）/ `lowConfidenceSet`（`getUserDataPaths` 命中，低置信——可能只是 launcher 缓存）/ `signatureSet`（签名搜索命中，恒包含）；软过滤（`infinitynikki` 关键字）**仅作用于快速路径并集**（`registrySet ∪ lowConfidenceSet`，与历史对快速路径的处理一致），`signatureSet` 不参与软过滤——专属媒体文件夹签名（`MEDIA_FOLDER_SIGNATURES`，含 NikkiPhotos_HighQuality 等）已足够精确；
- **R2 高置信早退**（修重要项②）：早退条件改为 `registrySet.size > 0 || (quickSet.size > 0 && !force)`——force 时仅注册表高置信命中才早退（秒级，日志行 `注册表高置信已找到 N 个目录，跳过全盘签名搜索`），低置信命中（launcher 缓存，T1 场景）不早退仍强制签名搜索；非 force 分支与历史行为完全一致（日志行 `快速路径已找到 N 个目录，跳过全盘签名搜索`）；
- 新增用例：**U-I**（force 时签名命中的非 infinitynikki 目录不被 launcher 缓存软过滤剔除——模拟中文安装路径，补上 U-A 盲区）、**U-J**（force 时 Steam/Epic 注册表高置信命中仍早退，不执行全盘签名搜索）；
- 次要项同步：`findMediaDirectories` JSDoc 重写为四集合语义、bridge 用例改名（`U-D. info 级别应透传 logger.info（目录发现结论日志）`）、逐目录日志截断 20 条（超出部分汇总行带过，兑现 sendScanLogInfo“低频白名单”承诺）、结果汇总行改为“自定义 X + 快速路径过滤后 Y + 签名命中 Z”、ScanButton 相关注释更新；
- 复证：主进程 **2419 用例全绿**。

### 9.3 批次 B 修复（渲染端）

- `ScanProgress.tsx` D5 引导 Toast 判定追加 `useUIStore.getState().currentView === 'gallery'`——非 gallery 视图下列表为空只代表该板块空，不弹引导 Toast；
- `GalleryPage.tsx` 空态文案切换条件由 `hasScanned` 收紧为 `currentView === 'gallery' && hasScanned`；
- 新增用例 **U-H 两条**：ScanProgress（非 gallery 视图 launcher-cache 下扫描成功且刷新后列表为空 → 不弹 info 引导 Toast）、GalleryPage（status=completed 但 currentView=launcher-cache → 空态 subtitle 保持默认文案）；
- 九份对比 locale（de/es/fr/ja/ko/pt/ru/th/vi）回填新增 i18n key（`toast.scanFoundButGalleryEmpty` / `toast.scanCompletedNoGameShots` / `galleryPage.emptySubtitleScanned`）的英文文案，消除空串 Toast 风险；
- 复证：渲染端 **1158 用例全绿**。

### 9.4 修复后行为语义表

| 场景                                                           | 行为                                                                             |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 注册表命中（高置信：Steam/Epic 安装路径）                      | **任何模式秒级早退**（含 force——注册表项即游戏安装路径，全盘搜索零收益不再执行） |
| 仅低置信命中（launcher 缓存 / AppData 游戏数据目录）+ 全盘扫描 | **强制签名搜索**（低置信命中仍保留在结果中参与软过滤；签名命中恒包含）           |
| 签名搜索命中                                                   | **恒包含于最终结果，不受软过滤**（修中文安装路径误剔除——阻断项闭环）             |
| 非全盘（增量 / 常规扫描）                                      | 与历史行为**完全一致**（快速路径并集非空即早退 + 既有软过滤，U-B 回归保护）      |

### 9.5 批次 C 收口验收证据（2026-08-24 下午）

> 占位：全量门禁 / 重打包 / e2e / 沙箱首装验收——本批次执行后回填实际结果。
