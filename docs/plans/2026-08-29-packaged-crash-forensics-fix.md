# 打包版启动后 ~15-20 秒无声闪退：取证与修复计划

> 日期：2026-08-29 ｜ 状态：执行中 ｜ 范围：仅针对"打包版启动后不足 1 分钟自动闪退"，不改动任何无关功能。

## 一、结论与依据（前期分析）

**现象**：2026-08-29 13:56 构建并安装（`D:\OOO\wxnn-photo-manager`）的打包版，三次启动（14:00:35 / 14:00:56 / 14:38:26）均在启动后约 15~20 秒进程无声消失。

**取证结论**（来自本机日志，JS 级退出路径逐一排除）：

| 排除项                 | 硬证据                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| before-quit 清理       | 数据库 `.clean-exit` 标记 mtime 仍是 08-28 22:07，今日未刷新                                                                                                                   |
| uncaughtException      | `startup-errors.log` 今日无新增；`faults-2026-08-29.jsonl` 不存在                                                                                                              |
| GPU 自愈 `app.exit(0)` | `gpu-fallback.json` 14:38:27 写入 `{failures:0, fallback:false}` 后未再改动（requestSelfHeal 会同步置 `fallbackActive:true` 并写 diag.log `[GPU]` 行）；diag.log 无 `[GPU]` 行 |
| 权限提权重启           | 扫描无 EACCES/EPERM；无弹窗路径痕迹                                                                                                                                            |
| 原生崩溃               | Crashpad 本机工作正常（历史 dump 存在），今日无新 dump、无 WER 1000 事件                                                                                                       |

**指向：进程被外部/原生层终止**（最典型：安全软件对未签名新 exe 的行为查杀；启动后 20 秒内行为面 = reg.exe 多次 + PowerShell 解析 lnk + 目录枚举 + DB 批量写 + userData 内 rm+rename）。

环境佐证：扫描"发现 0 个媒体文件"但按路径逐个访问 125/125 全部成功（目录枚举被过滤驱动拦截的特征）；搜索索引每次启动都因持久化失败（rm+rename 被占用）而重建（`[Search] indexed=0, db=159`）。

4 个新提交（438326f / cdc31c9 / 949b0f6 / c6fef71）逐一审查：无可直接致死的代码路径。

**策略**：先"取证增强 + 复现定位"（把无声死亡变成可观测事件），再按分支结果实施对应修复。不做猜测性重构。

## 二、改动总览（最小面）

| 编号 | 内容                                                                                              | 文件                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| M1   | 退出取证：心跳文件 + 退出码落盘 + 下次启动"异常终止"检测（复刻 Chrome「未正确关闭」成熟检测模式） | 新增 `src/main/app/exit-forensics.ts` + `src/main/app/__tests__/exit-forensics.test.ts`；接线 `src/main/index.ts`、`src/main/app/lifecycle.ts` |
| M2   | `child-process-gone` 全类型记录（现仅 GPU）                                                       | `src/main/app/gpu-fallback.ts` + 既有测试                                                                                                      |
| M3   | Chromium 原生日志落盘（捕获 FATAL "GPU process isn't usable. Goodbye." 等原生级退出）             | `src/main/index.ts`（appendSwitch）                                                                                                            |

不改动：扫描器、导航白名单、媒体读取守卫、分享服务、i18n、UI、打包配置。

## 三、依赖声明

- **无新增 npm 依赖。**
- 仅使用 Node 20 内置模块（`node:fs`、`node:crypto`、`node:path`）与既有依赖：`electron`、`electron-log`（已在 dependencies）、项目内 `logger`/`diagLog`/`logger.fault` 基础设施。
- 构建链沿用现有 scripts：`npm run dist:win`（含 pre-dist-check + verify:dist）、`npm run dist:win:smoke`（Playwright 打包冒烟）。
- 测试框架沿用 vitest ^1.6.1（无新 devDependencies）。

## 四、启动说明（复现与验证操作）

- 打包：`npm run dist:win`；冒烟：`npm run dist:win:smoke`
- 运行打包版：`release\win-unpacked\无限暖暖相册管理工具.exe`；已安装版：`D:\OOO\wxnn-photo-manager\无限暖暖相册管理工具.exe`
- 日志位置：
  - `%APPDATA%\wxnn-photo-manager\logs\`：`main-*.log`、`faults-*.jsonl`
  - `C:\Users\<username>\NikkiGallery\Diagnostics\`（文档库重定向后的用户友好诊断目录）：`diag.log`、`startup-errors.log`、`chromium-debug.log`（新增）、`*.dmp`
  - 新增取证文件（userData 下）：`heartbeat.json`（5s 心跳）、`last-exit.json`（退出码）
- GPU 兼容对照：环境变量 `NIKKI_FORCE_GPU_COMPAT=1`
- 单测：`npm test`；单文件：`npx vitest run <path>`

## 五、错误处理

- exit-forensics 全部文件操作 try/catch 静默降级（对齐 `gpu-fallback.ts` 风格）：userData 不可写 / 文件被占用 / JSON 损坏 → 视为不存在，绝不阻塞启动。
- `process.on('exit')` 处理器内**只允许同步操作**（Node 规范），写盘失败静默。
- 心跳 `setInterval(...).unref()`，绝不阻碍退出；`will-quit` 清理心跳文件失败静默。
- 检测到"上次异常终止"时经 `void logger.fault(...)` 异步记录，自身再包 try/catch。
- Chromium `enable-logging` 落盘文件 >10MB 时轮转为 `.old`，防无限增长。

## 六、参数校验

- `heartbeat.json` / `last-exit.json` 读取时严格校验形状：`bootId` 为非空 string、`code` 为 number、`stage` 为 string、`time` 为 ISO string；任一不符或 JSON.parse 失败 → 视为文件不存在（按默认分支处理）。
- 检测逻辑仅基于严格类型匹配，不信任文件内容做任何行为决策（取证数据不参与控制流，只产出日志）。
- `log-file` 路径来自既有 `getUserFacingDiagDir()`（已含候选链降级：文档/homedir/tmp）。

## 七、基础测试用例

`src/main/app/__tests__/exit-forensics.test.ts`（electron app mock 沿用既有 `gpu-fallback.test.ts` 模式）：

1. 首次启动（无陈旧心跳）→ 不告警；心跳文件创建并随时间刷新
2. 陈旧 `heartbeat.json` 且无 `last-exit.json` → 记录 `exitDiagnosis` 故障（异常终止）
3. `last-exit.json` 存在且形状合法 → 不告警（正常/自证退出）
4. 文件为损坏 JSON → 不抛错、按默认处理
5. 直接调用 `process.on('exit')` 处理器 → `last-exit.json` 写入正确 bootId/code/stage
6. `will-quit` 清理删除心跳文件
7. （M2）非 GPU 子进程 gone → 记录日志、不触发自愈；GPU → 行为与现状一致

既有套件（238 个测试）必须保持全绿。

## 八、分步实施（每步验证通过才进入下一步）

### Step 0 计划落盘 ✅

- 本文件。验收：含"依赖声明/启动说明/错误处理/参数校验/基础测试用例"五节。

### Step 1 基线复现与环境取证（无代码改动）

- 运行现有打包版（先 `D:\OOO\...` 2-3 分钟，再 `release\win-unpacked` 对比），记录是否复现与死亡时间。
- 只读检查：`Get-MpThreatDetection` / `Get-MpPreference` 排除项 / SecurityCenter2 注册的 AV。
- 验收：得到"是否复现 + 死亡时间 + AV 状态"三项记录（写入 §10 执行记录）。

### Step 2 M1 exit-forensics 模块 + 单测

- 新文件 `src/main/app/exit-forensics.ts`：
  - `initExitForensics()`：生成 bootId；检测陈旧 heartbeat → fault + diagLog；启动 5s 心跳；注册 `process.on('exit')`（同步写 last-exit）；`app.on('will-quit')` 删心跳。
  - `markExitStage(stage)`：里程碑打点（boot/ready/window-created/cleanup）。
  - `markCleanShutdown()`：lifecycle performCleanup 调用（删心跳）。
- 验收：`npx vitest run src/main/app/__tests__/exit-forensics.test.ts` 全绿；`npm run typecheck` 通过。

### Step 3 M2 child-process-gone 全类型日志

- `setupGpuProcessWatcher`：非 GPU 类型也记 diagLog+logger.warn（type/reason/exitCode/serviceName）；GPU 自愈逻辑不变。
- 验收：`npx vitest run src/main/app/__tests__/gpu-fallback.test.ts` 全绿。

### Step 4 M3 Chromium 日志落盘

- index.ts ready 前：`appendSwitch('enable-logging','file')` + `appendSwitch('log-file', <Diagnostics>/chromium-debug.log)`；>10MB 轮转。
- 验收：typecheck + `npm test` 全绿；打包运行后文件可见（Step 7 一并验证）。

### Step 5 接线与全局质量门

- index.ts 早期调 `initExitForensics()`；lifecycle `performCleanup` 调 `markCleanShutdown()`；里程碑 `markExitStage`。
- 验收：`npm test` 全量 + `npm run typecheck` + `npm run lint` 全绿。

### Step 6 打包与冒烟

- `npm run dist:win` → `npm run dist:win:smoke`。
- 验收：打包成功、冒烟通过。

### Step 7 带取证复现（决定分支，只走命中分支）

- 运行带取证的 win-unpacked ≥2 分钟、重复 2-3 次启动。三种观测必居其一：
  - **A 外部终止**：heartbeat 停更 + 无 last-exit + 无 Chromium FATAL → 产出取证报告（AV 保护历史、心跳停更时间、退出码缺失证据）+ 缓解指引（安装目录加 AV 白名单/恢复隔离/提交误报）；若复现指向具体行为仅做单一最小规避。
  - **B Chromium FATAL**：chromium-debug.log 出现 "GPU process isn't usable. Goodbye." → GPU 兼容模式追加 `appendSwitch('disable-gpu')` 强软件渲染（成熟做法），补单测，重新打包验证。
  - **C JS 退出码**：last-exit.json 有 code+stage → 按 stage 定位路径，最小修复 + 单测，重新打包验证。
- 验收：修复后打包版连续运行 ≥3 分钟不再退出；日志有正常心跳与干净退出标记。

### Step 8 收尾

- 执行记录写入本文件 §10；汇总报告；不改 i18n/UI；不提交 git（除非要求）。

## 九、风险与回滚

- 新增逻辑全部静默降级，最坏情况 = 少一条日志，不影响既有功能。
- 文件粒度小（1 新模块 + 2 接线点 + 2 处增强），可按文件回滚；不触碰打包配置与业务功能。

## 十、执行记录（2026-08-29）

### 1. 基线复现与环境取证（Step 1）✅

- **复现成功两次**：安装版（D:\OOO）15:55:23 启动、+18s 消失；修复前取证版 16:11:31 启动、+19s 消失。与用户报告"不足 1 分钟闪退"吻合。
- **杀软环境**：Defender 服务被停用（Get-MpPreference 报 0x800106ba）；唯一活跃 AV 为**腾讯电脑管家 QQPCRTP**（H:\QQPCMgr）。其隔离区在 08-14（372MB）与 08-21（242MB）各有一条加密记录，两者提取的图标哈希完全一致（同一应用被隔离两次）。初始假设为 AV 行为查杀，后被取证推翻。
- 环境备注：本机 shell 为管理员权限；`path-safety.test.ts` 的 chmod 只读目录用例在提权环境下必然失败（存量问题）。

### 2. M1/M2/M3 取证落地 + 关键突破（Step 2-5）✅

- 新增 `src/main/app/exit-forensics.ts`（心跳 + 退出码落盘 + 异常终止检测 + 退出事件链日志 + app.exit/process.exit 调用点堆栈捕获，12 个单测）；扩展 `gpu-fallback.ts` 记录全部 child-process-gone 类型；index.ts 增加 Chromium `enable-logging=file` 落盘（Diagnostics/chromium-debug.log，10MB 轮转）；index.ts/cleanup.ts 完成接线。
- **取证版复现立即定位真凶**：last-exit.json 事件链显示 `scanner-worker.js` 的 `cleanupAndExit` 从 Timeout 调用 `process.exit(0)`，发生在**主进程**，uptime=15.24s。

### 3. 根因（最终裁决）

```
scanner-handler.ts（主进程 IPC，c6fef71 新增 import detectGameRootCandidates）
  → game-directory-discovery.ts:27  import { shouldStop } from './worker-entry'   ← 反向导入
  → 打包器把 worker-entry 归入 scanner-worker.js 共享块，主进程为取 shouldStop 加载整份 worker 入口
  → worker-entry 模块顶层的 15s 心跳自杀看门狗在主进程启动（parentPort=undefined，永远收不到 WORKER_PING）
  → 启动后 15.2s：cleanupAndExit() → process.exit(0) → 主进程静默死亡（不触发 before-quit/will-quit/崩溃转储）
```

- 触发提交：**c6fef71（08-29 13:55）**——scanner-handler 首次引用 game-directory-discovery；反向导入边本身自 6b63c9e（08-26）已存在，但此前无主进程侧引用，故 08-27/28 构建正常。
- 前期"外部查杀"假设被硬证据推翻（QQPCMgr 相关仅为环境巧合；隔离记录为历史事件）。
- 附带发现：worker-entry 顶层还注册了 `process.on('exit'/'uncaughtException'/'unhandledRejection')`，若被主进程加载会劫持主进程的异常与退出处理——本次一并修复。

### 4. 修复内容（最小面，对齐仓库既有 scan-logger.ts 抽取模式）

| 文件                                                    | 改动                                                                                                                                   |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/scanner/scan-abort.ts`（新增）                | 零依赖共享中止标志：`isScanAborted / abortScan / resetScanAbort`                                                                       |
| `src/main/scanner/worker-entry.ts`                      | 移除 `export let shouldStop`；改用 scan-abort；**看门狗与 3 个 process.on 兜底全部加 `process.parentPort` 守卫**（仅真实 worker 注册） |
| `src/main/scanner/game-directory-discovery.ts`          | 改从 scan-abort 读取中止标志，删除对 worker-entry 的反向导入；更新依赖声明注释                                                         |
| `src/main/scanner/game-directory-discovery.test.ts`     | vi.mock 目标从 worker-entry 改为 scan-abort                                                                                            |
| `src/main/scanner/__tests__/scan-abort.test.ts`（新增） | 状态机 4 用例 + 反向导入回归守卫 2 用例                                                                                                |
| （取证增强，见 §2）                                     | exit-forensics.ts、gpu-fallback.ts、index.ts、cleanup.ts 及测试                                                                        |

### 5. 验收结果 ✅

- 单测：全量 **4176/4178 通过**；仅 2 个与本次无关的存量环境失败（管理员 shell 下 chmod 只读失效、GalleryStackOverflow 游离 RangeError），改动前即如此。
- 类型检查：与基线（17 条存量错误）**完全一致，零新增**。
- ESLint：本次全部新增/修改文件 0 问题（存量错误位于 .cache 产物、e2e、after-pack 脚本）。
- **打包版复现验证：修复前 +18s/+19s 必死；修复后存活 150s+，心跳持续更新**。
- 干净退出链验证：window-all-closed → before-quit → performCleanup → app.exit(0)；心跳删除、stage=cleanup、数据库 clean-exit 标记刷新。
- **Playwright 打包冒烟 9/9 通过**（S1-S7 + 全屏诊断 + userData 隔离）。

### 6. 遗留建议（未在本次改动，供后续决策）

- `signAndEditExecutable: false`（初始提交即有）导致 exe 无版本元数据，是 AV 误报的高危特征；建议接入签名或至少开启元数据编辑。
- 电脑管家隔离区的两条历史记录建议在管家里"恢复/信任"处理，并对安装目录加白名单。
- 搜索索引每次启动重建（indexed=0）与"扫描发现 0 文件但 125/125 可按路径访问"是本机过滤驱动干扰的环境症状，与本次闪退无关，未改动。
