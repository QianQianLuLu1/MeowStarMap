# GPU 硬件加速系统性优化实施计划

> 状态：已确认（2026-10-24）｜目标：独显设备上默认正确启用 GPU 硬件加速并让独显承担可加速负载；修复自愈误判与长期滞留软件渲染；补齐 GPU 状态可观测性；建立验证指标。全程保持稳定性与可回退性。
> 决策记录（用户确认）：混合显卡设备**默认开启独显优先**（打包版写 GpuPreference=2，可切回「跟随系统」）；GPU 状态**新增诊断面板**（12 语言）。

## 0. 现状分析与问题定位（探索已闭环）

**已具备**：

- 硬件加速默认开启：`src/main/app/gpu-fallback.ts:133-144` 无偏好无崩溃标记时返回 false（不禁用）；无任何无条件 `app.disableHardwareAcceleration()`。
- GPU 崩溃自愈（VS Code 模式）：`gpu-fallback.ts` + `window-manager.ts:238-240`（启动期渲染崩溃）+ `index.ts:180-181`（markBootAttempt/watcher 注册）；状态文件 `userData/gpu-fallback.json`，偏好镜像 `gpu-pref.json`（启动期 sqlite 未就绪，settings:set 双写）。
- 设置页「硬件加速」开关：`general-sections.tsx:31-45` + `settings-handler.ts:101-109`（内联布尔校验 + 双写镜像）；`writeHardwareAccelPref(true)` 复位 fallbackActive 给一次干净重试。
- Chromium 原生日志：`index.ts:60-78`（enable-logging/log-file 落盘 `chromium-debug.log`，捕获 GPU FATAL）。
- 性能基线 e2e：`e2e/perf-helpers.ts`（cold-start-first-paint / scan-ingest / scan-throughput / media-list-page100·500 / find-duplicates / cache-get-stats / thumbnail-generate-p95 / first-thumbnail-visible，v2 环境分段基线）。
- 渲染链路重度依赖 GPU：毛玻璃 `LiquidGlassDefs.tsx` + `display.glassEffect`、canvas 编辑器（`imageProcessor.ts`/`ToneCurve`/`Histogram`/`ColorWheel`）、react-virtuoso 虚拟滚动（`VirtualImageGrid`/`ListView`）、`VideoPlayer`/`SlideshowPlayer`。

**问题（瓶颈清单）**：

| #   | 问题                                                                                                                                                                 | 出处                      | 后果                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------ |
| 1   | GPU 子进程事件**任何 reason（含 clean-exit 正常退出）一次即永久置 fallbackActive**；运行期单次瞬时崩溃（Chromium 本可自行重启 GPU 进程恢复）也触发自动重启进软件渲染 | `gpu-fallback.ts:227-252` | 误判导致独显/集显设备被无谓打入软件渲染，毛玻璃/canvas/滚动/视频全线变慢 |
| 2   | fallbackActive 无有效期、无版本级自动重试，仅靠用户手删文件或重开开关                                                                                                | `gpu-fallback.ts:16-19`   | 驱动更新/系统修复后**长期滞留软件渲染**                                  |
| 3   | 独显优先完全缺失（全仓零命中 GpuPreference/force_high_performance_gpu/getGPUInfo/getGPUFeatureStatus）                                                               | 全仓                      | 混合显卡笔记本由 Windows 默认分派，常落在集显                            |
| 4   | 可观测性缺失：无法确认硬件加速是否开启、活动显卡是谁、哪些特性降级软件；GPU 日志仅崩溃路径                                                                           | 全仓                      | 无法验证优化效果，故障排查无抓手                                         |

## 1. 依赖声明

**零新增 npm 依赖**（项目发布配方禁 npm install）。注册表操作用系统 `reg.exe` 经 `child_process.execFile`（参数数组传递，无 shell 注入面）；其余复用仓库既有设施：`wrapHandlerNoArgs`/zod（IPC）、`diagLog`/`electronLogger`（日志）、`SettingsToggle`（UI）、`scripts/sync-i18n-keys.ts`（i18n 结构同步）、`e2e/perf-helpers.ts`（指标框架）。

## 2. 启动说明

- 环境：现有仓库已 `npm install`，无需新准备；**禁止执行 npm install**。
- 开发验证：`npm run dev` → 设置 → 日志与诊断 → 「GPU 状态」卡；主进程日志含 GPU 状态摘要行。
- 自动化：节点级 `npx vitest run <相关 *.test.ts>`；全局 `npm run verify`、`npm test`、`npm run typecheck`、`npm run typecheck:e2e`、`npm run lint`、`npm run i18n:guard`；打包链 `npm run dist:win` 后 `npm run e2e:smoke`（含新增 S8）。

## 3. 错误处理（全部 fail-open，绝不阻塞启动）

| 分支                                 | 行为                                                                   | 兜底/日志                     |
| ------------------------------------ | ---------------------------------------------------------------------- | ----------------------------- |
| GPU 子进程 clean-exit（正常退出）    | 忽略（不计数不回退）                                                   | diagLog 留痕                  |
| 运行期 GPU 崩溃第 1 次（60s 窗口内） | 仅记 warn，交 Chromium 自愈（自行重启 GPU 进程）                       | `logger.warn` + diagLog       |
| 运行期 60s 内第 2 次                 | 升级：落盘回退标记 + requestSelfHeal 自动重启进软件渲染                | 既有链路                      |
| 启动期（首绘前）GPU/渲染崩溃         | 维持现状立即自愈（2026-08-19 白屏根因场景保护不变）                    | 既有链路                      |
| 主进程被 FATAL 直接杀死              | consecutiveFailures≥2 跨手动启动兜底（不变）                           | 既有链路                      |
| 注册表 reg.exe 执行失败/不存在       | 静默降级，仅记日志，下次启动重试                                       | diagLog + electronLogger.warn |
| app.getGPUInfo('complete') 挂起/抛错 | 3s 超时竞速 → 降级 'basic' → 再失败置 null（软件回退态 info 缺失不炸） | 记降级原因                    |
| 状态/偏好文件损坏                    | 视为默认状态（既有 try/catch 口径不变）                                | 静默                          |
| app.getVersion() 异常                | 版本视为未知（''），**保守不禁用重试**（返回 true）                    | 记日志                        |

## 4. 参数校验

- `settings:set` 的 `gpu.discretePreference`：值必须 ∈ `{'auto','high-performance'}`，否则抛 `AppError.validation`（i18n 报错文案）；键加入 `RENDERER_PREF_KEYS` 白名单。
- `app:gpu-status`：无入参，走 `wrapHandlerNoArgs`（既有 zod/错误包裹）。
- reg 命令参数全部由纯函数构建为字符串数组（`buildRegAddArgs`/`buildRegQueryArgs`/`buildRegDeleteArgs`），execFile 不经 shell；含空格/中文/括号路径为单数组元素，无拼接注入面（单测覆盖）。
- GPU 崩溃窗口参数为常量 `RUNTIME_CRASH_WINDOW_MS=60_000`、`RUNTIME_CRASH_THRESHOLD=2`。

## 5. 基础测试用例清单（正常/异常/边界；每节点先红后绿）

**节点 1（崩溃升级策略）**：正常—启动期 GPU 崩溃立即回退（旧用例 9 保持绿）；60s 内两次运行期崩溃→回退+relaunch。异常—clean-exexit 忽略不写盘；运行期单次崩溃不置 active 不 relaunch。边界—两次崩溃恰好跨过 60s 窗口（不升级）；窗口边界 ±1ms；非 GPU 类型仅记日志（既有）。
**节点 2（版本重试）**：正常—fallbackVersion=旧版本→判定 false（重试）且落当前版本戳；重试后再崩→判定 true。异常—getVersion 抛错/为空→保守 true 不重试。边界—旧格式无 fallbackVersion 字段→恰好一次重试并落戳；用户 pref=false 仍绝对优先；状态文件损坏不变。
**节点 3（独显偏好）**：正常—high-performance 时 reg add 参数正确（含空格路径）；auto 且现值为自有格式→reg delete。异常—reg 执行失败静默不抛；非 win32 / dev 环境 skip。边界—auto 但现值为外来格式（用户手设）→**不删**；偏好镜像无字段→默认 high-performance；settings:set 值 'foo'→AppError.validation。
**节点 4（GPU 状态）**：正常—payload 结构完整、reason 分类正确（default/user-disabled/crash-fallback）；complete 成功取 gpus+activeGpu。异常—complete 超时→basic 降级；两者皆失败→null 不抛。边界—featureStatus 为空对象；getVersion 缺失。
**节点 5（诊断面板）**：正常—mock 状态渲染各字段；异常—getGpuStatus 抛错显示错误态；边界—gpus/featureStatus 为 null 显示「不可用」；硬件加速关闭时显示原因。
**节点 6（e2e S8）**：正常—payload 结构齐备且 `hardwareAcceleration.enabled===true`（全新 userData 必然成立，CI 无独显也通过）；异常/边界—featureStatus、gpus 仅断言字段存在并输出实际值（CI SwiftShader 值不同不误红）。

## 6. 子任务分解（严格 TDD：每节点红灯→修改→绿灯→回归→commit）

### T0 落档计划（本文件）

- 验收：文件存在于 docs/plans/（未被 .gitignore 排除，随节点提交入仓）。

### T1 GPU 崩溃升级策略

- 文件：`src/main/app/gpu-fallback.ts`、`src/main/app/__tests__/gpu-fallback.test.ts`
- 输入：`child-process-gone {type:'GPU', reason, exitCode}` + 当前是否启动期；输出：是否升级回退（落盘+relaunch）。
- 改动：纯函数 `shouldEscalateRuntimeGpuCrash(timestamps, nowMs)`（60s 窗口 ≥2 次）；watcher GPU 分支三段化（clean-exit 忽略 / 启动期立即 / 运行期计数升级）。requestSelfHeal 本体、防死循环、阈值兜底不动。
- 验收：`npx vitest run src/main/app/__tests__/gpu-fallback.test.ts src/main/app/__tests__/gpu-selfheal.test.ts` 全绿 + `npm run verify`。

### T2 版本级自动重试

- 文件：同 T1
- 输入：状态文件 `{consecutiveFailures, fallbackActive, fallbackVersion?}` + app.getVersion()；输出：本次是否禁用硬件加速。
- 改动：激活回退的两条路径（markGpuProcessCrash、阈值路径）盖版本戳；判定时 active 且戳≠当前版本（或无戳）→ 落当前戳并返回 false（每版本一次重试）；版本不可得→保守 true。
- 验收：同 T1 测试子集全绿 + verify。

### T3 独显优先（注册表，默认开启）

- 文件：新增 `src/main/app/gpu-preference.ts` + `__tests__/gpu-preference.test.ts`；改 `src/main/index.ts`（ready 前挂接，默认 high-performance）、`src/shared/settings-keys.ts`、`src/main/ipc/handlers/settings-handler.ts`（@core-change 授权注释）、`src/shared/types/settings.ts`（类型键）、`src/renderer/pages/settings/general-sections.tsx`（开关+重启提示）
- 输入：偏好 mode + {execPath, isPackaged, platform, run(注入)}；输出：{applied: 'set'|'removed'|'kept-foreign'|'skipped-dev'|'skipped-platform'|'noop'} + 日志。
- 改动：如 §4；'auto' 清理前先 query 比对，仅删自有格式值；注册表下次启动生效（日志/UI 说明）。gpu-pref.json 扩展字段 discretePreference（保留 hardwareAcceleration 字段双写）。
- 验收：`npx vitest run src/main/app/__tests__/gpu-preference.test.ts src/main/ipc/handlers/settings-handler.test.ts src/renderer/pages/settings/general-sections.test.tsx` 全绿 + verify。

### T4 GPU 状态可观测（IPC + 启动日志）

- 文件：新增 `src/main/app/gpu-status.ts` + `__tests__/gpu-status.test.ts`；改 `src/main/ipc/handlers/app-handler.ts`（@core-change）、`src/main/preload/api/app.ts`（@core-change）、`src/shared/types/electron-api.ts`、`src/main/app/window-manager.ts`（did-finish-load 后异步记一行摘要）、`docs/IPC_CONTRACT.md`
- payload：`{ hardwareAcceleration:{enabled,reason}, fallback:{active,consecutiveFailures,fallbackVersion}, discretePreference:{mode,registry}, featureStatus, gpus, activeGpu, electronVersion }`；reason 由 gpu-fallback 导出的共享纯函数 `classifyBootDecision` 推导（单一真相源）。
- 验收：`npx vitest run src/main/ipc/handlers/app-handler.test.ts src/main/app/__tests__/gpu-status.test.ts` 全绿 + verify + IPC_CONTRACT.md 登记。

### T5 诊断面板 GPU 状态卡 + i18n

- 文件：`src/renderer/pages/settings/diagnostics-sections.tsx`（新增 `DiagnosticsGpuSection`）、诊断 tab 挂载点、渲染层 electronAPI 类型、12 locale（zh-CN 手写 `settings.gpu.*` 约 14 条 → `npx tsx scripts/sync-i18n-keys.ts` 补结构 → 逐语言翻译）
- 验收：新组件测试全绿；`npm run i18n:guard` / `i18n:check` 通过；verify。

### T6 e2e 扩展

- 文件：`e2e/smoke.e2e.ts`（S8 GPU 探针）、`e2e/perf.e2e.ts`（`gallery-scroll-frame-p95` 滚动帧间隔采样，rAF 3s；**暂不设硬护栏**——CI SwiftShader 帧率失真，先采样落盘待基线固化，此取舍记录在案）
- 验收：`npm run typecheck:e2e` 通过；实现前 S8 必红（getGpuStatus 不存在），实现后打包 e2e 全绿。

### T7 全量回归 + 实机验证 + 报告

- 顺序：verify → `npm test` → typecheck/typecheck:e2e/lint/i18n:guard → `npm run dist:win`（四段链，禁 npm install）→ `npm run e2e:smoke`；mimosa 安全扫描（normal，focus 本次改动文件）。
- 独显实机验证：应用内 GPU 状态卡（硬件加速开启+独显型号）；任务管理器 GPU 引擎落独显；启动日志摘要行；注册表 `HKCU\Software\Microsoft\DirectX\UserGpuPreferences` 存在本 exe 的 `GpuPreference=2;`。
- 产出：最终报告 + 本文件追加执行记录；分节点 commit。

## 7. 风险与回退

- T1 放宽运行期触发的风险：启动期致命路径与阈值兜底均不变；运行期连崩 2 次（60s）仍回退。回退：revert 该节点。
- T2 版本重试的风险：每次升级至多多一轮「崩溃→自动重启进软件渲染」。回退：revert；用户侧永远可用设置开关手动控制。
- T3 注册表：仅 HKCU 自身 exe 路径；'auto' 只删自有格式值；失败静默不影响启动；e2e 打包产物路径写入无害。回退：设置切回「跟随系统」自动清理，或手动删除该值。
- T4/T5 只读通道与展示，无副作用；getGPUInfo 超时降级。回退：revert。
- 已评估并否决：`ignore-gpu-blocklist`/`use-angle` 等强制开关（绕过驱动黑名单易引入崩溃，VS Code 亦不启用）；macOS 专用 `force_high_performance_gpu`（本项目仅 Windows x64，Windows 混合显卡正解是 UserGpuPreferences 注册表）。

## 8. 执行记录

（执行中追加）
