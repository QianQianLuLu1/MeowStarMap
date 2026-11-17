# 喵星图启动链静默失败：诊断结论与实施计划

> **口径声明**：本轮为**代码级分析**，问题机日志未取得。所有结论按「代码实证 / 强推断 / 待日志确认」标注证据强度，不把假设写成定论。
>
> **已确认的四项决策**：① 问题机日志暂时拿不到，只做代码级分析 + 采集清单；② 改动范围仅主应用主进程启动链 + 对应测试，不改 `NikkiSync`、不改打包配置 / 安装器 / 快捷方式脚本；③ 新增的 bug 复现测试必须先红后绿，既有全量回归以「无新增失败」验收（已放弃「全量修复前必须全红」的字面要求）；④ 允许 `build` + 单测 + `typecheck` + `lint`，不跑 `dist:win` 重打包、不跑 Playwright GUI。
>
> **路径约定**：`ROOT = D:/项目/软件/MeowStarMap/MeowStarMap/MeowStarMap`。下文「需修改文件」一律写完整绝对路径。所有命令的 cwd 均为 `ROOT`。
>
> **计划模式限制**：本文件是当前唯一允许写入的文件，路径为 `C:\Users\Qian Lu\.workbuddy\plans\radiant-nebula-lovelace-qcKwNkyR.md`。用户要求的「MD 计划写入仓库」在确认后作为 **N0** 执行，本轮不写仓库。

---

## 一、诊断结论

### 1. 三类现象的分别归因与关联关系

| 现象                                                   | 直接归因                                                                                                                                                                                                                                                                                                                                                                            | 证据位置                                                                                                                                                |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **① 双击无响应**（无窗口 / 无错误框 / 进程挂起或残留） | `app.whenReady().then(async …)` **无 `.catch()`**（`ROOT/src/main/index.ts:181`），`:189-214` 不在任何 try 内（try 从 `:216` 才开始）；`:33-39` 的 `unhandledRejection` 明确「只记日志，不再 `app.exit(1)`」。任一处抛错 → 进程存活、无窗口、无提示、可能持锁                                                                                                                       | `ROOT/src/main/index.ts:33-39,181,189-214,285`                                                                                                          |
| **② 反复双击弹「已有实例运行」**                       | 现象①的存活进程持锁 → 第二实例 `requestSingleInstanceLock()=false`（`ROOT/src/main/app/lifecycle.ts:76`）→ 6×1s 无反馈重试 → 三选项对话框；文案误导；`:225-230` dialog 自身抛错被 catch 吞后仅 `logStartupError` + `app.quit()`（无 GUI 提示）                                                                                                                                      | `ROOT/src/main/app/lifecycle.ts:76-91,92-231,225-230`；`ROOT/.cache/e2e-smoke-1794676215133/last-exit.json`（journal 内 7 条连续 `second-instance`）    |
| **③ 无弹窗闪退 / 反复重启**                            | 启动期渲染崩溃 `requestSelfHeal()` 成功即 `return`，跳过错误对话框（`ROOT/src/main/app/window-manager.ts:294-298`），由 `ROOT/src/main/app/gpu-fallback.ts:598-606` 静默 `app.exit(0)` 重启；`did-fail-load` 只 diagLog（`window-manager.ts:184-189`）；`defaultShowErrorBox` 用 `electron.dialog?.showErrorBox(...)`，`dialog` 为 undefined 时**可选链短路，既不弹框也不进 catch** | `ROOT/src/main/app/startup-environment.ts:30-40`；`ROOT/src/main/app/native-load-guard.ts:65-76`；`ROOT/src/main/app/window-manager.ts:184-189,281-331` |

**关联关系（三者是同一条因果链的不同观测点，不是三个独立 bug）**：

```
index.ts:189-214 任一抛错（或环境/原生预检失败但弹框静默短路）
  → whenReady().then() 无 .catch → unhandledRejection → 只 log 不退出
  → 进程存活、无窗口、无提示，且可能持有 named mutex           【现象①】
  → 用户以为没启动，反复双击 → 第二实例 gotLock=false
  → 6s 静默重试 + 三选项对话框（文案误称「锁未释放」）         【现象②】
  → 点「清理并重启」→ taskkill 按 exe 文件名强杀（可能误杀健康实例）
    → 2s 后 relaunch + exit(0)；残留未清干净则再次撞锁 → 循环
  → 任一对 dialog（lifecycle.ts:172-203 / 225-230 / 717-742）抛错被吞
    → 只 logStartupError + app.quit()，彻底无 GUI 提示           【现象③】
支线：启动期 GPU/渲染崩溃 → 静默自愈重启 → 用户看到「闪一下就没了」
  → diagLog / logStartupError 的写盘失败本身也是空 catch（startup-diagnostic.ts:69-78,102-131）
    → 连「为什么重启」都留不下证据
```

### 2. 关键订正：「单实例锁未释放」这句文案技术上不成立

- 唯一判重机制是 Electron 内建 `app.requestSingleInstanceLock()`（`ROOT/src/main/app/lifecycle.ts:76`、`:88` 重试），底层是 Windows 命名互斥体；**进程终止（含崩溃 / `taskkill /F` / 正常退出）时 OS 自动回收句柄**。只读检索确认 `src` 下无自建 `.lock` / pid 文件 / 端口判重，仓库不存在可残留的锁。
- 因此 `gotLock=false` 只有两种真因：**(a) 另一个进程此刻仍存活并持锁**（现象①的静默挂起实例、`before-quit` 清理中的实例、开机自启后台实例、托盘常驻）；**(b) 另一路径 / 会话 / 另一份 exe 的实例**。
- 结论：**「已有实例运行」提示本身是正常单实例保护被正确触发**，不是 bug；bug 在于误导文案、6s 无反馈、dialog 异常被吞、按文件名无差别强杀 + relaunch 竞态、以及主实例未亮窗。
- 关联组件（只分析不改）：`NikkiSync` 是独立仓库，C# WPF 便携单文件外壳用 `Local\NikkiSync.WindowsShell.Instance` 命名 Mutex + `Local\...Activate` 命名事件（`ROOT/../NikkiSync/apps/windows-shell/Services/SingleInstanceCoordinator.cs`），关闭窗口只隐藏到托盘（`DesktopWindowLifecycle.cs`），自启 Run 值绑定 `Environment.ProcessPath`，端口 `28080`/`28950`。主应用**不 spawn 它**，只把 4 个 workspace 包当库加载；主应用内嵌 LAN 同步服务也用 `28080`。`SignalExistingInstance()` 对 `UnauthorizedAccessException` 返回 false 后仍 `Shutdown()` → 第二实例静默退出且主实例不亮窗，是「有后台实例却看不到窗口」的**独立平行链路**，但不会触发主应用那句中文文案。

### 3. 最可能的根因列表（按可能性排序）

| #   | 根因                                                                                                                                                                                                                                                                                                                                                                                                    | 证据强度                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | `whenReady().then()` 缺 `.catch` + `:189-214` 裸奔在 try 外 + `unhandledRejection` 主动放弃退出 → 启动早期异常被静默吞掉、进程僵持持锁                                                                                                                                                                                                                                                                  | **代码实证**（缺陷存在）；「问题机命中此路径」**待日志确认**                                |
| 2   | 所有 startup 失败出口普遍缺「至少一个用户可见提示」：`defaultShowErrorBox` 可选链短路静默、3 处 dialog catch 吞异常后直接退出、`showFatalStartupErrorBox` 失败仍退出；日志写盘失败本身也是空 catch                                                                                                                                                                                                      | **代码实证**                                                                                |
| 3   | `second-instance` 只 `restore()+focus()` **无 `show()`**，`windows.length===0` 静默无操作；注册点在 8 阶段初始化中途（`lifecycle.ts:267`）                                                                                                                                                                                                                                                              | **代码实证 + 样本佐证**（`last-exit.json` 7 条 second-instance 无窗口动作记录）             |
| 4   | 锁检查在构造完 15+ 服务对象之后（`application.ts:70-113` → `lifecycle.ts:76`），第二实例要跑完整链 + 等最多 6s 才见反馈                                                                                                                                                                                                                                                                                 | **代码实证 + 强推断**                                                                       |
| 5   | 启动期 GPU 自愈 / 渲染崩溃静默重启、无可见反馈且取证不可靠（`window-manager.ts:294-298` → `gpu-fallback.ts:598-606`）                                                                                                                                                                                                                                                                                   | **代码实证**；「问题机命中」**待日志确认**（需 `chromium-debug.log` / `gpu-fallback.json`） |
| 6   | 外部电脑环境差异：`signExecutable:false`（未签名，杀软/SmartScreen）、VC++ DLL 由 `scripts/after-pack-vc-runtime.cjs` 从**构建机** System32 拷贝、原生模块 ABI + `asarUnpack`、userData 被锁 / 中文路径 / OneDrive 重定向、`ELECTRON_RUN_AS_NODE` 泄漏致 exitCode=9 静默退出（`e2e/launch-env.ts:1-16`）、`.lnk` 指向已删除的旧 exe（`desktop-shortcut.ts:27-38` 只在 target 不存在时重建、不校验版本） | **待日志确认 / 环境类**；本轮不改打包配置，只能缓解不能根除                                 |

### 4. 问题电脑上需采集的关键信息 / 日志证据清单

| 类别        | 具体项                                                                                                                                                                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 诊断目录    | `文档/喵星图/Diagnostics/`（候选回落 `用户目录/喵星图/Diagnostics`、`%TEMP%/喵星图-Diagnostics`）：`diag.log`、`startup-errors.log`、`chromium-debug.log`（及 `.old`）、`.dmp`、应用内「导出诊断包」产物                                                                                                                                                |
| userData    | `%APPDATA%/<appName>/`：`gpu-fallback.json`、`gpu-pref.json`、`heartbeat.json`、`boot-ok.marker`、`last-exit.json` / exit-forensics journal、`logs/main-*.log`、`logs/faults-*.jsonl`、`database/` 可写性                                                                                                                                               |
| 进程 / 系统 | `Get-CimInstance Win32_Process -Filter "Name='喵星图.exe'"                                                                                                                                                                                                                                                                                              | Select ProcessId,CommandLine,SessionId,ParentProcessId`；会话 ID、是否有残留 PID、任务管理器截图；Windows 事件查看器「应用程序」错误与 WER 报告 |
| 环境        | exe 实际路径与版本号、快捷方式 `link.target` / `WorkingDirectory`（是否指向旧版本 exe）、环境变量（尤其 `ELECTRON_RUN_AS_NODE`、`NIKKI_*`、`NIKKI_SKIP_ENV_GUARD`）、是否管理员运行、杀软拦截日志、4 个 VC++ DLL（`msvcp140.dll` / `vcruntime140.dll` / `vcruntime140_1.dll` / `msvcp140_2.dll`）在 System32 与安装目录的存在性、Windows 版本与会话类型 |
| 复现时序    | 带时间戳记录：双击时刻 → 等待秒数 → 是否有弹窗（截图）→ 是否闪退 → 进程是否残留 → 是否再次双击。用于与 `diag.log` 的 `INDEX/BOOT/WIN/GPU` 行对齐                                                                                                                                                                                                        |

### 5. 可复现 / 缩小范围的验证步骤（区分「本机正常 vs 外部电脑异常」）

- **本机注入对照**（复用仓库既有开关，不新增依赖）：`NIKKI_EARLY_CRASH_SIM=1`（`index.ts:86`）、`NIKKI_GPU_SIMULATE_CRASH=1`（`index.ts:210`）、`NIKKI_SKIP_ENV_GUARD=1`（`startup-environment.ts:97`）、`NIKKI_SKIP_NATIVE_GUARD=1`（`native-load-guard.ts:193`）、`NIKKI_FORCE_GPU_COMPAT` / `NIKKI_GPU_FORCE_LEVEL`（`gpu-fallback.ts`）；在 `npm run dev` 或 `npm run build` 产物上分别触发，观察「静默挂起 / 无提示 / 弹误导框 / 静默重启」。
- **判定标尺**：
  - 本机正常 = `boot-ok.marker='ok'` + 首窗可见 + `diag.log` 全链路含 `=== index.ts loaded ===` → `Application.initialize() completed` + `gpu-fallback.json.consecutiveFailures` 首绘后清零。
  - 代码缺陷（本机可复现）= 用上述开关稳定复现同类现象，且日志停在某一 `stage` 后无后续行 → 按「最后一行 tag → 文件」映射定位（INDEX→`index.ts`、BOOT→`lifecycle.ts`、WIN→`window-manager.ts`、GPU→`gpu-fallback.ts`）。
  - 外部异常 = 本机始终正常而问题机异常，且问题机 `chromium-debug.log` 有 `GPU process isn't usable. Goodbye.` / FATAL、或进程列表有残留 exe、或 `exitCode=9`、或 VC++ DLL 缺失、或 userData 被锁、或 `.lnk` 指向旧路径 → 归入根因 #6。
- **环境差异对照实验**：同一安装包分别装在①干净 Windows（无杀软、系统盘默认路径）②带杀软 / 中文用户名 / OneDrive 重定向 ③曾装过旧版本且残留 `.lnk` 的机器；对比 `link.target`、VC++ DLL、userData 路径、进程残留数。
- **本轮允许的深度**：`npm run build` + 单测 + `typecheck` + `lint` + `typecheck:e2e`（静态）；**不跑** `dist:win`、不跑 Playwright GUI、不做真机双击验收（仅列清单）。

### 6. 修复方案（按优先级）

1. **P0 启动流程**：`whenReady()` 链补 `.catch()`；`unhandledRejection` 按「启动是否 settled」分级——启动期致命化（可见提示 + 释放锁 + 退出），运行期保留「游离 rejection 不杀应用」的既有意图。**不搬启动编排、不新增编排模块**。
2. **P0 错误提示策略**：所有 startup 失败出口在 `exit(1)`/`quit()` 之前必须至少调用一次可见弹框。降级链 `dialog.showMessageBox`（i18n，带打开日志）→ `dialog.showErrorBox`（不依赖 i18n / 渲染进程，复用 `early-crash-guard.reportEarlyFatal` / `native-load-guard.showFatalStartupErrorBox`）→ 同步落盘 + 明确退出。修掉 `electron.dialog?.showErrorBox` 的可选链静默短路；3 处被 `catch {}` 吞掉的 dialog 出口补 P0 fallback。
3. **P1 单实例锁处理**：**不动锁的位置、不动 6×1s 重试、不删三选项对话框**。理由：`lifecycle.ts:79-84` 注释明确 6s 用于覆盖 `before-quit` 的 WAL checkpoint（2–5s），缩短会让「关闭后立即重开」误判并 `taskkill` 掉健康实例；删除三选项框会移除用户明确要求的「清理/重启选择」。只把 `second-instance` 注册前移到锁成功后立即，并让主实例亮窗成为二次双击的第一反馈。
4. **P1 第二实例激活**：handler 补 `show()` + `restore()` + `focus()`；0 窗口时复用 `lifecycle.ts:701-706` 已有的 `createMainWindow(ctx)`，但**必须加「启动已 settled」闸门**：启动未完成（`isStartupSettled()===false`）时只记日志、不创建窗口，避免与正在进行的 8 阶段启动链重入；启动完成但无窗口（托盘 / 隐藏）时才重建。
5. **P1 文案**：`main.dialog.instanceRunning.detail` 从「可能是之前的进程异常未退出，导致单实例锁未释放」改为「检测到另一个实例仍在运行……」，12 个 locale 同步（仅改值、不改 key 结构）。
6. **P2 异常兜底 / 取证**：启动期 GPU 自愈与渲染崩溃在静默重启前必留 `logStartupError` 痕迹；自愈档位到顶（`MAX_COMPAT_LEVEL`）时给一次可见提示，避免无限静默重启。
7. **本轮不做的建议**（改动范围外）：签名与 `after-pack-vc-runtime.cjs` 的 VC++ DLL 来源、`.lnk` 版本校验、`ELECTRON_RUN_AS_NODE` 防护、NikkiSync WPF 的 Mutex / 托盘 / 自启路径、端口 28080 冲突。仅在第 4、5 节列为后续排查方向。

### 7. 修复后回归 / 验收清单

| 场景             | 可判定验收标准                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 双击启动         | 本机 `boot-ok.marker='ok'` + 首窗可见 + diag 全链路；问题机按第 4 节采集后判定                                                                         |
| 异常退出         | `NIKKI_EARLY_CRASH_SIM=1` / 让 `:189-214` 抛错 → **必有可见错误框** + 进程退出 + 锁释放，绝不静默挂起                                                  |
| 后台实例重复启动 | 主实例收到 `second-instance` → 主窗口 `show/restore/focus`；0 窗口且启动已完成 → 重建窗口；启动未完成 → 不重入、有日志；三选项框仍可用                 |
| 清理并重启       | 文案不含「锁未释放」；dialog 抛错时仍有一次可见提示；`killedAny=false` 不循环；`clearDeathEvidenceForRelaunch → release → relaunch → exit(0)` 顺序不变 |
| 关闭后立即重开   | 6s 重试窗口内不误弹「已有实例运行」、不误杀健康实例（本轮不缩短重试，重点回归）                                                                        |
| 环境差异         | 干净系统 / 中文用户名 / OneDrive 重定向 / 旧版残留 `.lnk` 四组对照，失败时均能看到可见提示与可检索日志                                                 |

---

## 二、实施计划

### 2.0 设计原则与复用清单

- **零新增 npm 依赖、零新增源码模块**。只改 6 个现有源码文件 + 12 个 locale 的值 + 新增 4 个测试文件；复用 Electron 官方 API 与仓库既有函数：`early-crash-guard.reportEarlyFatal` / `showNonFatalErrorBox`、`native-load-guard.showFatalStartupErrorBox`、`startup-diagnostic.logStartupError` / `diagLog`、`lifecycle.ts:701-706` 的 `createMainWindow(ctx)`、`t()` + 12 locale。
- **不采纳的两个备选**（已评估并排除）：① 把锁前移到入口顶层、第二实例直接静默退出、删掉三选项框 —— 会移除清理/重启选择且在主实例是僵尸时无兜底；② 新增 `startup-orchestrator.ts` 搬走 `index.ts:189-284` 编排并抽 6 个纯函数 —— 属大重构，违反最小改动并牵动覆盖率与既有测试。
- `src/main/index.ts` 被 `vitest.config.ts:92-97` 列入 coverage exclude（进程入口，无法行为单测），**不虚构对它的单测**：用「静态源码守卫测试 + `typecheck` + `build`」验证接线。
- 每个节点严格执行：**先写红灯测试并确认 FAIL → 改代码 → 重跑转绿 → 立即跑相关测试子集**；上一步未通过不得进入下一步。

### 节点总览

| 节点 | 目标                                                              | 对应根因 |
| ---- | ----------------------------------------------------------------- | -------- |
| N0   | 确认后把本计划写入仓库（用户明确要求）                            | —        |
| N1   | 堵住启动早期静默挂起（总闸门），建立 `isStartupSettled` 闸门      | #1       |
| N2   | `second-instance` 前移注册 + 亮窗 + 0 窗口兜底（带 settled 闸门） | #3       |
| N3   | 所有 startup 失败出口至少一个可见提示 + 修正误导文案              | #2、#4   |
| N4   | 启动期自愈 / 渲染崩溃留可靠取证 + 到顶可见提示                    | #5       |
| N5   | 全量回归 + 静态 / 类型 / 安全检查                                 | —        |

---

### N0：把实施计划写入仓库

- **需修改文件（完整路径）**：`D:/项目/软件/MeowStarMap/MeowStarMap/MeowStarMap/docs/startup-silent-failure-plan.md`（新建；`docs/` 目录已核实存在，内含 `manual-smoke-checklist.md`、`packaged-scan-crash-report.md`）。
- **输入**：本计划文件全文。
- **输出**：仓库内一份 MD 计划文档（含诊断结论、节点、五段声明、验收清单）。
- **验收标准**：文件存在；内容与本计划一致；`npm run docs:links`（真实脚本 `tsx scripts/check-md-links.ts`）不因该文件新增失败。
- **说明**：本节点在用户确认计划后、任何代码改动前执行。

---

### N1：堵住启动早期静默挂起

**① 红灯测试（先写、确认 FAIL）**

新增 `D:/项目/软件/MeowStarMap/MeowStarMap/MeowStarMap/src/main/app/__tests__/startup-entry-guard.test.ts`（静态源码守卫，`fs.readFileSync` 读 `src/main/index.ts`），断言：

- `app.whenReady().then(...)` 链末尾存在 `.catch(`；
- `process.on('unhandledRejection', ...)` 回调体内引用 `reportEarlyFatal` 与 `shouldEscalateUnhandledRejection`；
- `whenReady` 成功路径末尾调用 `markStartupSettled()`。

在已有 `D:/项目/软件/MeowStarMap/MeowStarMap/MeowStarMap/src/main/utils/early-crash-guard.test.ts` 追加 `shouldEscalateUnhandledRejection` 用例（正常 / 异常 / 边界，见「参数校验」）。

> 修复前：`index.ts` 无 `.catch`、无 `markStartupSettled`，`early-crash-guard.ts` 无该导出 → **测试必 FAIL**。

**② 改代码**

| 文件（完整路径）                           | 行号级改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ROOT/src/main/utils/early-crash-guard.ts` | 模块级新增 `let startupSettled = false`；导出 `markStartupSettled(): void`、`isStartupSettled(): boolean`、`shouldEscalateUnhandledRejection(settled: unknown): boolean`（仅严格 `=== true` 时返回 false）。约 12 行，复用现有模块状态与去重守卫                                                                                                                                                                                                                                                |
| `ROOT/src/main/index.ts`                   | `:33-39` `unhandledRejection` 回调内追加 `if (shouldEscalateUnhandledRejection(isStartupSettled())) reportEarlyFatal(reason, { stage: 'index.unhandledRejection' })`，保留原 diagLog / electronLogger.error 与运行期不杀应用的注释；`:181` 的 `.then(async …)` 末尾（`:285` 之后）追加 `.catch(err => reportEarlyFatal(err, { stage: 'index.whenReady.catch' }))`；`:263-267` 成功标记之后调用 `markStartupSettled()`；`:268-284` 既有 FATAL catch 内也调用 `markStartupSettled()` 避免重复上报 |

**③ 绿灯与验收**

- 命令：`npx vitest run src/main/app/__tests__/startup-entry-guard.test.ts src/main/utils/early-crash-guard.test.ts` → **全部 PASS**。
- `npm run typecheck`、`npm run build` → 退出码 0（验证 `index.ts` 接线可编译、主进程入口可打包）。
- **输入 / 输出**：输入 = 注入的 rejection reason / settled 状态；输出 = 是否升级为致命（可见弹框 + 释放锁 + 退出）与 settled 标志。
- **可判定验收**：上述两条命令退出码 0；静态守卫三条断言全绿；既有 `early-crash-guard.test.ts` 用例无新增失败。

---

### N2：`second-instance` 亮窗与 0 窗口兜底

**① 红灯测试（先写、确认 FAIL）**

新增 `D:/项目/软件/MeowStarMap/MeowStarMap/MeowStarMap/src/main/app/__tests__/second-instance-window.test.ts`，复用 `src/main/app/__tests__/lifecycle.test.ts:22-60` 的 `vi.hoisted` + `vi.mock('electron', …)` 既有模式，捕获 `app.on('second-instance')` 回调并手动触发：

- 窗口最小化 → `restore()` + `show()` + `focus()` 三者都被调用；
- 窗口未最小化 → `show()` + `focus()` 被调用；
- `getAllWindows()=[]` 且 `isStartupSettled()=true` → `createMainWindow(ctx)` 兜底被调用；
- `getAllWindows()=[]` 且 `isStartupSettled()=false` → **不**调用 `createMainWindow`（防重入），且有日志留痕；
- 边界：窗口为 `null` / `isDestroyed()=true` → 走兜底、不抛错；
- `app.on('second-instance')` 的注册调用顺序早于 `await app.whenReady()`（`lifecycle.ts:277`）。

> 修复前：handler 只有 `restore()+focus()`、0 窗口静默、注册点在 `:267` → **测试必 FAIL**。

**② 改代码**

| 文件（完整路径）                 | 行号级改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ROOT/src/main/app/lifecycle.ts` | 把 `:266-274` 的 `app.on('second-instance', …)` **整块前移**到 `:232`（`lockAcquired = true` 之后、`initExitForensics` 之前）；handler 体改为：遍历 `BrowserWindow.getAllWindows()`，对每个有效窗口 `if (win.isMinimized()) win.restore()`、`win.show()`、`win.focus()`；无有效窗口时 `if (isStartupSettled()) { void createMainWindow(ctx).catch(err => logStartupError('second-instance-recreate', err)) } else { diagLog('BOOT', 'second-instance during startup: deferred to bootstrap') }`；整体包 try/catch 记 `logStartupError`。新增 `isStartupSettled` 的 import |

**不动**：`lifecycle.ts:76-91` 的锁位置与 6×1s 重试、`:92-231` 的三选项对话框与清理分支。

**③ 绿灯与验收**

- `npx vitest run src/main/app/__tests__/second-instance-window.test.ts src/main/app/__tests__/lifecycle.test.ts` → 全绿、无新增失败。
- `npm run typecheck` → 0 error。
- **输入 / 输出**：输入 = `second-instance` 事件 + 窗口列表 + settled 状态；输出 = 窗口 show/restore/focus 或受控的窗口重建 / 日志留痕。
- **可判定验收**：6 条断言全绿；`lifecycle.test.ts` 原有 `app.on` 注册断言若受影响则同步更新后仍全绿。

---

### N3：所有 startup 失败出口至少一次可见提示 + 修正误导文案

**① 红灯测试（先写、确认 FAIL）**

新增 `D:/项目/软件/MeowStarMap/MeowStarMap/MeowStarMap/src/main/app/__tests__/startup-error-visibility.test.ts`：

- `startup-environment.defaultShowErrorBox` / `native-load-guard.defaultShowErrorBox` 在 `require('electron')` 返回 `{}` 或 `{ dialog: {} }` 时 → 断言存在 fallback 可见通道调用（当前可选链短路、完全静默，且 `console.error` 不算可见）；
- `lifecycle.ts:225-230` 锁失败 dialog 抛错 → 断言 `dialog.showErrorBox` / `reportEarlyFatal` 被调用 ≥1 次（当前仅 `logStartupError`）；
- `lifecycle.ts:172-203` `killedAny=false` 的清理失败框抛错 → 断言 fallback 可见，且不进入 relaunch 循环；
- `lifecycle.ts:717-742` DB fatal dialog 抛错 → 断言 fallback 可见；
- **文案静态断言**：读 12 个 locale 的 `main.dialog.instanceRunning.detail`，断言均不含「单实例锁未释放」且含准确措辞。

> 修复前：4 条行为断言 + 12 条文案断言 **必 FAIL**。

**② 改代码**

| 文件（完整路径）                                                                  | 行号级改动                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ROOT/src/main/app/startup-environment.ts`                                        | `:30-40` `defaultShowErrorBox`：去掉 `electron.dialog?.showErrorBox` 的可选链静默短路，改为显式取 `dialog`、判 `typeof dialog?.showErrorBox === 'function'`；不可用时调用 `showFatalStartupErrorBox(title, content)`（复用 `native-load-guard` 导出）作为 P0 fallback，再失败才 `console.error`                       |
| `ROOT/src/main/app/native-load-guard.ts`                                          | `:65-76` 同上；导出 `showStartupFailureWithFallback(err: unknown, opts?: { title?: string; logPath?: string }): void`（约 25 行）：先 `dialog.showMessageBox`（P1，i18n）→ 抛错则 `dialog.showErrorBox` / `showFatalStartupErrorBox`（P0）→ 仍失败则 `logStartupError` 同步落盘；所有分支包 try/catch，绝不把异常抛回 |
| `ROOT/src/main/app/lifecycle.ts`                                                  | `:172-203`、`:225-230`、`:717-742` 三处 `catch {}` 内改为调用 `showStartupFailureWithFallback(...)`；`:208-211` 补注释明确「失败实例本身不持锁、`release` 为 no-op」（不改行为）                                                                                                                                      |
| `ROOT/src/renderer/i18n/locales/{de,en,es,fr,ja,ko,pt,ru,th,vi,zh-CN,zh-TW}.json` | 各改 `main.dialog.instanceRunning.detail` 一个值：改为「检测到另一个实例仍在运行」的对应语义；**仅改值、不改 key 结构**                                                                                                                                                                                               |

**③ 绿灯与验收**

- `npx vitest run src/main/app/__tests__/startup-error-visibility.test.ts src/main/app/startup-environment.test.ts src/main/app/native-load-guard.test.ts src/main/app/__tests__/lifecycle.test.ts src/main/utils/early-crash-guard.test.ts` → 全绿、无新增失败。
- `npm run i18n:check`（真实脚本 `tsx scripts/check-i18n-keys.ts`）、`npm run typecheck`、`npm run lint` → 0 error。
- **输入 / 输出**：输入 = 各类 startup 异常 + dialog 可用性；输出 = 至少一次可见提示调用 + 同步落盘 + 明确退出。
- **可判定验收**：静态与行为断言全绿；**代码中不再存在「catch 后仅 `logStartupError` 就 `app.quit()` / `app.exit()`」的 startup 路径**（由测试与 `grep` 双重确认）。
- **诚实边界**：若运行时 `dialog` 模块整体不可用，JS 层没有第二条 GUI 通道；本节点保证「每个退出点都尝试过 P1→P0→落盘」，极端环境仍可能无弹窗，列为风险项。

---

### N4：启动期自愈 / 渲染崩溃留可靠取证 + 到顶可见提示

**① 红灯测试（先写、确认 FAIL）**

新增 `D:/项目/软件/MeowStarMap/MeowStarMap/MeowStarMap/src/main/app/__tests__/gpu-selfheal-evidence.test.ts`（复用 `gpu-selfheal.test.ts` 的 mock 口径）：

- `window-manager.ts` 的 `render-process-gone` 启动期分支 `requestSelfHeal()` 返回 true 时 → 断言 `logStartupError('startup-renderer-gone', …)` 在 `return` 之前被调用（当前直接 return，无留痕）；
- `gpu-fallback.requestSelfHeal` 在 `relaunch()` 之前 → 断言 `logStartupError('gpu-selfheal-relaunch', …)` 被调用；留痕函数抛错时仍 `relaunch + exit(0)`（fail-open）；
- 档位到顶 `level >= MAX_COMPAT_LEVEL` → 断言不 relaunch 且有可见提示调用；
- 边界：`details.exitCode` 为 `undefined` / `NaN` → 归一为 `-1`，不抛错。

> 修复前：无留痕、到顶无可见提示 → **测试必 FAIL**。

**② 改代码**

| 文件（完整路径）                      | 行号级改动                                                                                                                                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ROOT/src/main/app/window-manager.ts` | `:294-298` 在 `if (healed) return` 之前加 `logStartupError('startup-renderer-gone', err)`（包 try/catch，失败不阻断自愈）；`healed=false` 时保持走 `:302-313` 既有错误对话框                                            |
| `ROOT/src/main/app/gpu-fallback.ts`   | `:598-606` 在 `app.releaseSingleInstanceLock?.()` 之前加 `logStartupError('gpu-selfheal-relaunch', …)`；到顶分支（`requestSelfHeal` 返回 false 的路径）加一次 `showStartupFailureWithFallback` 可见提示（复用 N3 导出） |

**③ 绿灯与验收**

- `npx vitest run src/main/app/__tests__/gpu-selfheal-evidence.test.ts src/main/app/__tests__/gpu-selfheal.test.ts src/main/app/__tests__/gpu-fallback.test.ts src/main/app/__tests__/window-manager.test.ts` → 全绿、无新增失败。
- `npm run typecheck`、`npm run lint` → 0 error。
- **输入 / 输出**：输入 = 渲染进程退出 details / 当前兼容档位；输出 = 静默重启前的可检索留痕，或到顶时的可见提示。
- **可判定验收**：4 条断言全绿；`gpu-fallback.json` 与 `startup-errors.log` 在注入 `NIKKI_GPU_SIMULATE_CRASH=1` 后可检索到对应条目（本机人工观察项，记录结果）。

---

### N5：全量回归与全局校验

- **需修改文件**：无（仅执行）。
- **输入**：N1~N4 全部改动后的工作树。
- **输出**：命令执行结果报告（逐条列出退出码与关键输出行）。
- **验收标准**：下表全部通过且**无新增失败**；任一失败先修复再重跑，不得跳过 / 弱化 / 伪造结果。

### 分步验证与回归命令清单（全部为仓库真实脚本）

| 步骤                     | 命令（cwd = ROOT）                                              | 预期输出                                                                                            |
| ------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 每节点①红灯              | `npx vitest run <该节点新增测试相对路径>`                       | **FAIL**，失败项与预期断言一一对应                                                                  |
| 每节点③绿灯              | 同上 + 该节点列出的相关测试子集                                 | **PASS**，`0 failed`                                                                                |
| 每节点子集回归           | `npm run test:main`（= `vitest run src/main`）                  | 主进程单测全绿、无新增失败                                                                          |
| 全量单测                 | `npm test`（= `vitest run`）                                    | `Tests … passed`，**无新增失败**                                                                    |
| 覆盖率                   | `npm run test:coverage`（= `vitest run --coverage`）            | 阈值 statements≥66 / branches≥58 / functions≥59 / lines≥68 不跌破                                   |
| 类型检查                 | `npm run typecheck`（`tsc -b && tsc -p tsconfig.scripts.json`） | 退出码 0                                                                                            |
| e2e 静态检查（不跑 GUI） | `npm run typecheck:e2e`（`tsc --noEmit -p e2e`）                | 退出码 0                                                                                            |
| 静态检查                 | `npm run lint`（`eslint .`）                                    | 0 errors                                                                                            |
| 格式检查                 | `npm run format:check`                                          | `All matched files use Prettier code style`                                                         |
| 构建（验证主进程入口）   | `npm run build`                                                 | `dist/main` 产出成功，无 import / 路径错误                                                          |
| 安全检查                 | `npm run audit`（`audit-ci --config ./audit-ci.jsonc`）         | 无新增高危漏洞；若因网络 / 镜像失败，如实报告并判定与本次改动是否相关（本轮不新增依赖，原则上无关） |
| 预提交门禁               | `npm run test:precommit`                                        | 通过                                                                                                |
| i18n 一致性              | `npm run i18n:check`                                            | 12 locale 同 key、0 error                                                                           |
| 文档链接                 | `npm run docs:links`                                            | 无新增失败（N0 新增 MD 后）                                                                         |

> **明确不执行**：`npm run dist:win`、`npm run e2e:smoke` / 任何 Playwright GUI、真机双击。仓库**不存在** `test:unit` / `test:e2e` / jest / mocha，不得调用。

---

## 三、五段声明

### 1. 依赖声明

- **新增依赖：无。变更依赖：无。安装方式：无**（不执行 `npm install`）。
- **复用清单**：Electron 官方 `app.requestSingleInstanceLock/releaseSingleInstanceLock/whenReady/on('second-instance')/exit/quit`、`dialog.showMessageBox/showErrorBox`、`BrowserWindow.getAllWindows/show/restore/focus/isMinimized/isDestroyed`、`shell.openPath`；仓库现有 `reportEarlyFatal` / `showNonFatalErrorBox`（`early-crash-guard.ts`）、`showFatalStartupErrorBox`（`native-load-guard.ts`）、`logStartupError` / `diagLog` / `getStartupLogPathValue`（`startup-diagnostic.ts`）、`createMainWindow(ctx)`（`window-manager.ts`）、`t()` + 12 个 locale、`tests/mocks/electron.ts` 的 `createElectronMock()` 与 `lifecycle.test.ts:22-60` 的 `vi.hoisted` 模式。
- **节点依赖**：N1 建立 `isStartupSettled` 闸门 → N2（防重入）与 N3（错误降级）依赖它；N3 导出 `showStartupFailureWithFallback` → N4 依赖它；N5 依赖 N1~N4 全绿；N0 在确认后最先执行。
- **明确不改**：`ROOT/../NikkiSync/**`、`ROOT/package.json` 的 build 段、`ROOT/scripts/after-pack-vc-runtime.cjs`、`ROOT/src/main/app/desktop-shortcut.ts`、`ROOT/e2e/**`（不改断言、不改 `RETRY_WINDOW_MARGIN_MS`）。

### 2. 启动说明

- **环境准备**：Node ≥ 22.12.0（`ROOT/package.json:24-26`）；在 `ROOT` 下 `npm ci`（依赖已存在时不重装）；清理 `ELECTRON_RUN_AS_NODE` 等泄漏环境变量（见 `ROOT/e2e/launch-env.ts:1-16`）；确认 `release/win-unpacked/喵星图.exe` 保持原样（本轮不覆盖打包产物）。
- **启动命令**：`npm run dev`（`electron-vite dev`）仅用于本机人工冒烟，**不作为自动验证**；`npm run build` 产出 `dist/main` 用于接线静态验证。
- **验证方式**：`npx vitest run <路径>` / `npm test` / `npm run test:main` / `npm run typecheck` / `npm run typecheck:e2e` / `npm run lint` / `npm run format:check` / `npm run build` / `npm run audit` / `npm run i18n:check` / `npm run test:precommit`。真机双击与 Playwright GUI 仅列清单。

### 3. 错误处理

- **异常分支清单**：`verifyStartupEnvironment` 失败；`index.ts:189-214` 任一步抛错（协议注册 / GPU 模拟 / 路径提供器）；`import Application` / `new Application()` / `initialize()` 抛错；`dialog.showMessageBox` / `showErrorBox` 抛错；原生模块预检失败；DB 初始化失败；锁获取失败与三选项交互；`taskkill` / PowerShell 失败；渲染进程 `render-process-gone`；GPU 自愈到顶；`second-instance` 时窗口为 null / 已销毁 / 启动未完成。
- **兜底策略**：P1 `showMessageBox` → P0 `showErrorBox`（`reportEarlyFatal` / `showFatalStartupErrorBox`）→ 同步落盘 `logStartupError` + 明确退出；`unhandledRejection` 启动期致命化、运行期不杀应用；`createMainWindow` 兜底受 `isStartupSettled()` 闸门控制，失败只记日志；GPU 自愈留痕失败 fail-open 继续重启；所有兜底自身再包 try/catch，绝不把异常抛回 `unhandledRejection`。
- **日志输出**：沿用 `diagLog('INDEX'|'BOOT'|'WIN'|'GPU', …)` 与 `logStartupError(stage, err)`；新增 stage 名固定为 `index.whenReady.catch` / `index.unhandledRejection` / `gotLock-false-dialog-fallback` / `cleanup-failed-dialog-fallback` / `initialize-fatal-dialog-fallback` / `second-instance-recreate` / `startup-renderer-gone` / `gpu-selfheal-relaunch`，便于问题机按字符串检索。`diagLog` / `logStartupError` 自身的空 catch 静默失败本轮**不重构**（超出范围），作为已知风险列出。

### 4. 参数校验

| 函数 / 入口                                           | 入参类型与必填                                                   | 边界与非法值处理                                                                                                                                                                 |
| ----------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shouldEscalateUnhandledRejection(settled: unknown)`  | 必填，接受任意类型                                               | **仅严格 `=== true` 返回 false**；`undefined` / `null` / `0` / `'true'` / `false` 一律返回 `true`（启动期保守致命化，防漏报）                                                    |
| `markStartupSettled()` / `isStartupSettled()`         | 无入参                                                           | 幂等；重复调用不影响结果                                                                                                                                                         |
| `showStartupFailureWithFallback(err: unknown, opts?)` | `err` 必填（任意类型）；`opts.title` / `opts.logPath` 可选字符串 | `err` 为 null / 非 Error → `String(err)`；`title` / `logPath` 非字符串或空 → 用默认中英双语标题与 `getStartupLogPathValue()`；`dialog` 不可用 → 逐级降级；任何一级抛错都不向外抛 |
| `second-instance` handler 的窗口对象                  | `BrowserWindow.getAllWindows(): BrowserWindow[]`                 | 返回非数组 / `null` → 按空数组处理；窗口 `null` / `isDestroyed()` → 跳过；`isMinimized()` 非函数 → 只做 `show()+focus()`；0 窗口且 `isStartupSettled()=false` → 只记日志不重建   |
| `render-process-gone` details                         | `reason: string`、`exitCode: number`                             | `undefined` / `NaN` → 归一为 `'unknown'` / `-1`；`logStartupError` 抛错 → fail-open 继续自愈                                                                                     |
| locale 文案值                                         | 非空字符串                                                       | 12 个文件同 key，`npm run i18n:check` 校验 key 一致性；不改插值变量名                                                                                                            |

### 5. 基础测试用例（正常 / 异常 / 边界）

- **正常**：`shouldEscalateUnhandledRejection(true) === false`；env 可写 + 锁 winner → 全链路 initialize + 首窗 + `boot-ok.marker`；第二实例（已 settled、有窗口）→ `show/restore/focus`；GPU 档位到顶 → 不重启、有可见提示。
- **异常**：`index.ts:189-214` 抛错 / `initialize` 抛错 / `dialog.showMessageBox` 抛错 / `require('electron')` 返回 `{}` / 清理失败框抛错 / DB fatal 框抛错 → 必有可见提示 + 明确退出 + 锁释放；渲染崩溃启动期 healed=true → 有留痕且不自愈循环；`unhandledRejection` 在未 settled 时 → 升级为致命。
- **边界**：`settled` 为 `undefined` / `null` / `'true'`；`err` 为 `null` / 字符串；`title` / `logPath` 非字符串；`getAllWindows()` 返回 `[]` / `null`；窗口 `isDestroyed()=true`；`isStartupSettled()=false` 时 0 窗口（防重入）；`exitCode=undefined` / `NaN`；自愈留痕函数抛错 → fail-open。

---

## 四、风险与不可验证项

1. **问题机日志缺失**：所有「问题机根因」结论均为待日志确认；第 4 节采集清单是后续定性的前置条件，本轮不假装定论。
2. **真机双击本轮不验证**：`dist:win` 重打包与 Playwright GUI 均不跑；第 7 节的六类验收只输出清单，不产出「通过」结论。
3. **打包配置不改 → 环境类根因只能缓解不能根除**：签名、VC++ DLL 来源、`asar`/`npmRebuild`、`requestedExecutionLevel`、`.lnk` 版本校验、`ELECTRON_RUN_AS_NODE`、NikkiSync WPF 侧 Mutex / 托盘 / 自启 / 28080 端口冲突，本轮仅通过「启动期可见提示 + 可检索留痕」让问题可定位。
4. **`dialog` 整体不可用的极端情况**：JS 层无第二条 GUI 通道，N3 只保证「每个退出点都尝试过 P1→P0→落盘」，不承诺 100% 可见。
5. **保留 6s 重试的权衡**：不缩短重试避免误杀健康实例，代价是「关闭后立即重开」仍可能出现最多 6s 的无反馈窗口；已列入真机验收重点。
6. **日志模块未重构**：`startup-diagnostic.ts:69-78,102-131` 的空 catch 静默失败仍在，N4 只对自愈路径新增 stage 留痕，其余仍可能查不到日志。
7. **既有测试波及面**：`lifecycle.test.ts` 的锁用例簇（约 `:414-570`、`:1149`，含 `toHaveBeenCalledTimes(7)` 与 `advanceTimersByTimeAsync(6000)`）依赖旧 6s / 7 次语义——本轮**不改重试策略**，因此预期不受影响；若 N2 的 `app.on` 注册顺序变更触发其断言，须同步更新后仍保持全绿，否则视为新增失败。
8. **覆盖率**：本轮无新增源码模块，仅新增测试文件与少量分支；若 `npm run test:coverage` 因新增未覆盖分支跌破阈值，必须补测试后重跑，不得弱化阈值。

---

## 五、待确认后执行的顺序

`N0`（写仓库计划）→ `N1 红灯` → `N1 改码` → `N1 绿灯 + 子集` → `N2 红灯` → `N2 改码` → `N2 绿灯 + 子集` → `N3 红灯` → `N3 改码` → `N3 绿灯 + 子集` → `N4 红灯` → `N4 改码` → `N4 绿灯 + 子集` → `N5 全量回归 + 静态/类型/安全检查`。

任何一步未通过，停在该步修复并重跑，不进入下一步；全部通过后才向用户报告完成，并如实列出未能验证的真机项与仍需问题机日志的待定根因。
