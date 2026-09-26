# 修复计划：启动 `spawn EFTYPE` 原因分析、排查与加固（2026-09-25）

> 现场现象：打包版 NikkiGallery 在部分 Windows 机器上概率性启动失败，弹致命错误对话框
> "NikkiGallery 启动失败，程序已退出"，原因为 `spawn EFTYPE`，引导查看
> `C:\Users\<user>\Documents\NikkiGallery\Diagnostics\startup-errors.log`。

## 〇、原因分析结论

**EFTYPE 本质**：Windows 上 `child_process.spawn` 的 EFTYPE = CreateProcess 错误 193
（`ERROR_BAD_EXE_FORMAT`，"不是有效的 Win32 应用程序"）经 libuv 映射而来。典型触发：

- 目标文件不是合法 PE：被杀软隔离/替换为 0 字节或文本占位文件（`existsSync` 仍为 true）；
- 直接 spawn `.bat` / `.cmd` / `.ps1` / `.lnk` 等脚本（未设 `shell: true`）；
- PATH 上存在同名非 PE 文件，遮蔽了 System32 的真实命令（本仓库 tar.exe 事故即此因，见
  `src/main/utils/zip-archive.ts:4-8` 实锤注释）。

**弹窗链路**：未挂 `error` 监听的 spawn 失败 → `uncaughtException` →
`src/main/index.ts:29-31` / `src/main/app/error-handlers.ts:38-43` →
`early-crash-guard.reportEarlyFatal`（`src/main/utils/early-crash-guard.ts:139-235`）→
写 `startup-errors.log` → 弹"启动失败/程序已退出" → `app.exit(1)`。
窗口创建后（`createMainWindow` 之后）同类错误已降级为非致命弹窗，不退出（ebb2044 新增）。

**已修复的历史源头（HEAD = ebb2044，2026-09-25）**：

1. `src/main/services/log-service.ts` 旧实现 `spawn('tar.exe', ...)` 导出诊断包，无 error
   监听、无超时 → 已改进程内 archiver 流式打包（`zip-archive.ts`）。
2. `src/main/app/lifecycle.ts` 两处 `exec('taskmgr')` 无 error 监听 → 已挂 `.on('error')`
   并 `logStartupError('exec-taskmgr', e)`。
3. `startup-diagnostic.ts:86-96` 新增 `[errno] code=... errno=... syscall=... path=...
spawnargs=[...]` 摘要行（专为本现场设计：仅凭 message+stack 无法判断是哪个二进制）。
4. Diagnostics 日志路径统一为 `<Documents>\NikkiGallery\Diagnostics`（旧版弹窗指向
   Documents 但实际写入 `<homedir>\NikkiGallery\Diagnostics`）。

**剩余缺口（本计划修复）**：

- `src/main/utils/ffmpeg-paths.ts:34-50` `resolveBinaryPath` 仅 `existsSync`，不校验 PE
  魔数 → 杀软隔离 ffmpeg.exe/ffprobe.exe 留占位文件时照常 spawn → `spawn EFTYPE`，且错误
  被 fluent-ffmpeg 局部吞掉，不落任何诊断文件。
- `decryption-worker.js` 未加入 `electron.vite.config.ts` main.entry 与
  `scripts/pre-dist-check.ts` 白名单 → 打包版分享码网络解码 worker 必 fork 失败（静默降级；
  非 EFTYPE——utilityProcess fork 的是 electron.exe 本身，属附带实锤缺陷）。
- 结论：当前 HEAD 启动期（窗口创建前）已无未防护的 spawn 调用；现场"启动即弹窗"大概率来自
  旧版安装包，按第一节排查步骤可直接定位到具体调用。

## 一、排查方案

1. 打开 `startup-errors.log`。候选路径链（首个可创建者生效）：
   `<Documents>\NikkiGallery\Diagnostics\` → `<homedir>\NikkiGallery\Diagnostics\` →
   `%TEMP%\NikkiGallery-Diagnostics\`；另有应急兜底 `%TEMP%\NikkiGallery-startup-errors.log`。
   **旧版注意**：弹窗展示 Documents 路径，但实际写入可能是 homedir，两处都要看。
2. 找 `[errno]` 行：`code=EFTYPE` + `path=`（目标文件）+ `spawnargs=`（完整参数）→ 对照
   下文"调用点审计表"（file:line → 功能域）定位是哪一个 spawn 调用。
3. 在现场机器验证目标文件：
   - `Get-Item <path>`：看大小（0 字节即占位文件）；
   - `Format-Hex -Path <path> -Count 2`：合法 PE 应为 `4D 5A`（"MZ"）；
   - `where.exe <名称>`：查 PATH 是否被同名非 PE 文件遮蔽；
   - 查杀软隔离区/恢复记录（Windows 安全中心 → 保护历史记录）。
4. 若 `startup-errors.log` 为空/无对应记录 ⇒ 错误被局部处理（典型即 ffmpeg 链路）→
   本次 Node 4 的运行期诊断日志正是补此缺口。

## 二、调用点审计表（全量 spawn/exec/fork 清单，修复前状态）

| #   | 位置                                                                                                                                                | 目标                                         | 路径来源             | shell              | 时机                 | 错误处理                        | EFTYPE 风险                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------- | ------------------ | -------------------- | ------------------------------- | --------------------------------------------------------------------------- |
| 1   | `src/main/app/lifecycle.ts:109,123,134`                                                                                                             | powershell / taskkill                        | PATH                 | 否（execFileSync） | 仅单实例锁冲突分支   | try/catch                       | 低（同步抛错被捕获）                                                        |
| 2   | `src/main/app/lifecycle.ts:169,192`                                                                                                                 | taskmgr                                      | PATH                 | 是（exec）         | 锁冲突对话框按钮     | `.on('error')`（ebb2044 加）    | 已防护                                                                      |
| 3   | `src/main/app/desktop-shortcut.ts:124`                                                                                                              | reg                                          | PATH                 | 否                 | 窗口创建后           | callback err→resolve(null)      | 低                                                                          |
| 4   | `src/main/app/permission.ts:37`                                                                                                                     | powershell                                   | PATH                 | 否                 | 用户交互             | `child.on('error')`             | 已防护                                                                      |
| 5   | `src/main/scanner/game-directory-discovery.ts:409,506,919`                                                                                          | reg / powershell                             | PATH                 | 否                 | 扫描期（worker 内）  | callback err→resolve(null)      | 低                                                                          |
| 6   | `src/main/services/share-clipboard-service.ts:414,542,609,644,802,871`                                                                              | reg / wmic / powershell / tasklist / cmd     | PATH                 | 部分               | 用户交互             | callback err→resolve            | 低                                                                          |
| 7   | ffmpeg/ffprobe（`src/main/utils/video-probe.ts:42`、`media-worker/worker-entry.ts:335`、`thumbnail/generator.ts:772`、`utils/ffmpeg-runner.ts:32`） | ffmpeg-static / ffprobe-static 二进制或 PATH | asar.unpacked / PATH | 否                 | 扫描/缩略图/视频编辑 | fluent-ffmpeg error 事件→reject | **高：无 PE 校验；失败不落诊断日志**（Node 2/4 修复）                       |
| 8   | 6 处 `utilityProcess.fork`（scanner/media/database/thumbnail/video/decryption bridge）                                                              | electron.exe + 入口 js                       | `__dirname`          | —                  | 惰性                 | READY 超时 + exit 处理          | 无（electron.exe 恒为合法 PE）；decryption-worker.js 打包缺失由 Node 3 修复 |
| 9   | koffi `LoadLibrary`（`decryption-worker/dll-path.ts`）                                                                                              | nuan5_decryption.dll                         | resources            | —                  | 惰性                 | try/catch                       | 非 spawn，不产生 EFTYPE 字样                                                |

## 三、节点拆分（TDD：每节点先红后绿，闭环后才进入下一节点）

### Node 0 计划落盘

- 文件：`docs/plans/2026-09-25-spawn-eftype-analysis-and-fix.md`（本文档）。
- 验收：文件存在且含八节（原因分析/排查/审计表/节点/依赖/启动/错误处理/参数校验/测试用例）。

### Node 1 PE 魔数校验工具（红→绿）

- 文件：`src/main/utils/path-safety.ts` 新增 `hasWindowsExecutableHeader(filePath: string):
boolean`（`statSync` 校验 isFile 且 size≥2 → `openSync/readSync` 读前 2 字节 ===
  `0x4D 0x5A`；任何异常 → false）；`src/main/utils/path-safety.test.ts` 补用例（真实临时文件）。
- 测试（先红）：正常=MZ+内容临时文件→true；异常=文本占位/0 字节/目录/不存在→false；
  边界=恰 2 字节 MZ→true、1 字节 M→false。
- 验收：`npx vitest run src/main/utils/path-safety.test.ts` 全绿，且实现前新增用例为红。

### Node 2 ffmpeg 路径解析接入校验（红→绿）

- 文件：`src/main/utils/ffmpeg-paths.ts`（`resolveBinaryPath` 在 existsSync 后加 PE 校验：
  非 PE → `diagLog('FFMPEG', ...)` 记录"疑似被杀软隔离/替换"并回退 fallback）；
  `src/main/utils/ffmpeg-paths.test.ts`（扩展 fs mock 补 `statSync/openSync/readSync/
closeSync`；mock `./startup-diagnostic` 断言 diagLog）。
- 测试（先红）：占位文本→`ffmpegPath==='ffmpeg'` 且 diagLog 调用 1 次（当前实现返回本地
  路径=红）；0 字节→回退（红）；边界=正常 MZ 仍用本地路径（既有用例保持绿）、非 ASCII 回退
  与不存在回退（既有行为不变）。
- 验收：`npx vitest run src/main/utils/ffmpeg-paths.test.ts src/main/utils/path-safety.test.ts`
  全绿；`npm run typecheck` 无新增错误。

### Node 3 decryption-worker 打包修复（红→绿）

- 文件：`scripts/pre-dist-check.ts`（workerEntries 加 `'decryption-worker.js'`）；
  `electron.vite.config.ts`（main entry 加
  `'decryption-worker': 'src/main/decryption-worker/worker-entry.ts'`，顺带修正同段过时注释）。
- 红→绿：先 `npm run build` 建基线 → 加白名单 → `npm run pre-dist-check` 失败（缺文件=红）
  → 加 vite entry → 重新 `npm run build` → 预检全过（绿）。
- 验收：`npm run build` 后存在 `dist/main/main/app/decryption-worker.js`
  （`src/main/decryption-worker/bridge.ts:102` fork 的文件名）且 `npm run pre-dist-check` 通过。

### Node 4 ffmpeg spawn 失败运行期诊断日志（红→绿）

- 文件：新增 `src/main/utils/spawn-error-log.ts`（`maybeLogSpawnError(source, err)`：
  `err.syscall` 以 `spawn` 开头或 `code∈{EFTYPE,ENOENT,EACCES}` 时调
  `logStartupError('runtime-spawn-error:'+source, err)` 复用其 `[errno]` 摘要写入
  startup-errors.log；整体 try/catch 永不 throw，兼容 utilityProcess worker 内调用）；
  接线 3 处 error 路径各一行：`src/main/utils/ffmpeg-runner.ts`、
  `src/main/utils/video-probe.ts`、`src/main/thumbnail/generator.ts`。
- 测试：新增 `src/main/utils/spawn-error-log.test.ts`（先红：模块不存在）；
  `ffmpeg-runner.test.ts` / `video-probe.test.ts` / `generator.test.ts` 各补 1 例断言
  helper 被调用（mock helper 本体，避免重复测同一逻辑）。
- 验收：`npx vitest run src/main/utils/spawn-error-log.test.ts src/main/utils/ffmpeg-runner.test.ts
src/main/utils/video-probe.test.ts src/main/thumbnail/generator.test.ts` 全绿。

### Node 5 排查与审计文档

- 文件：`docs/troubleshooting-spawn-eftype.md`：第〇/一节全文 + 审计表 + ebb2044 修复对照
  与现场版本判别。
- 验收：文档存在且含审计表与排查四步；`npm run pre-dist-check`（含 check-doc-versions）不受影响。

### Node 6 回归与全局校验

- 每节点完成即跑相关子集；全部节点后依次：`npm test`（全量）→ `npm run typecheck` →
  `npm run lint` → `npm audit --omit=dev`（仅报告）。
- 硬性要求：Node 1/2/4 新增用例实现前必须红；全量不得出现新增失败项；若遇既有失败如实报告
  并区分是否本次引入，未全绿不结束。

## 四、依赖声明

无新增/变更依赖（仅 Node 内置 fs；复用既有 `logStartupError` / `diagLog` /
fluent-ffmpeg 超时兜底）。安装方式：不涉及。`npm audit --omit=dev` 仅作报告。

## 五、启动说明

- 环境：仓库现有 Node/npm 环境，无新安装步骤；Windows（PE 校验语义面向 win32，测试以
  临时文件模拟 MZ 头）。
- 命令：单测 `npx vitest run <文件>`；子集 `npm run test:main`；构建 `npm run build`；
  打包预检 `npm run pre-dist-check`；全量 `npm test` / `npm run typecheck` / `npm run lint`。
- 验证：按各节点验收标准逐步执行，最终以 Node 6 全量绿为准。

## 六、错误处理设计

- PE 校验任何异常一律按"不可执行"→ 回退 fallback，绝不 throw（`resolveBinaryPath` 在
  模块加载期求值，抛错会导致主进程启动失败）。
- 回退裸命令名（'ffmpeg'/'ffprobe'）后 spawn 仍失败：fluent-ffmpeg `error` 事件 → 既有
  try/catch + 超时 kill 兜底；Node 4 保证该失败落 `startup-errors.log` 可远程定位。
- 诊断写盘失败沿用 `startup-diagnostic.ts` 既有分级（writeFileSync/appendFileSync +
  tmpdir 兜底），不在本次改动范围。
- `maybeLogSpawnError` 内部 try/catch，worker 进程内异常不影响业务。

## 七、参数校验

- `hasWindowsExecutableHeader(filePath)`：string 必填；空串/非文件/size<2/读出<2 字节/
  异常 → false。
- `resolveBinaryPath(candidate: string | undefined | null, fallback: string)`：candidate
  空 → fallback（既有）；fallback 为非空字面量（'ffmpeg' / 'ffprobe'）。
- `maybeLogSpawnError(source, err)`：非 Error 值 String 化后仍可记录（与 logStartupError
  行为一致）；source 为非空短标签。

## 八、基础测试用例矩阵

| 类别 | 用例                                                           | 期望                                      |
| ---- | -------------------------------------------------------------- | ----------------------------------------- |
| 正常 | MZ 头二进制（≥2 字节）                                         | header=true；resolveBinaryPath 用本地路径 |
| 异常 | 文本占位/0 字节/目录/不存在                                    | header=false；回退 fallback 并 diagLog    |
| 边界 | 恰 2 字节 MZ / 1 字节 M / 读取抛错                             | true / false / false                      |
| 正常 | spawn EFTYPE 错误对象（code=EFTYPE, syscall, path, spawnargs） | maybeLogSpawnError 记录，stage 正确       |
| 异常 | 普通业务 Error（无 code/syscall）                              | 不记录                                    |
| 边界 | ENOENT/EACCES / err 为字符串                                   | 记录 / String 化后记录                    |
| 打包 | pre-dist-check 白名单 6 个 worker                              | build 后 6 个 .js 全部存在                |
