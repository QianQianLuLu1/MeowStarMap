# 实施计划：修复打包版视频缩略图缺失与 spawn EFTYPE 弹窗

> 日期：2026-09-28 ｜ 状态：已批准，进入实施
> 适用版本：wxnn-photo-manager（Electron 40 + TypeScript strict + Vitest）

## 概述

打包版"视频缩略图不显示"与"Runtime Error: spawn EFTYPE 弹窗"是**同一根因的两个表现**。修复策略分五层：

1. 修复被截断的 ffmpeg 二进制（真因）；
2. 强化 PE 完整性校验（让截断可被识别）；
3. 移除有害的非 ASCII 路径降级（让随包二进制真正被使用）；
4. fluent-ffmpeg spawn 逃逸垫片（让任何同步 spawn 失败不再升级为致命弹窗，转为优雅降级）；
5. 弹窗去重（消除模态框风暴）。

全程 TDD：每个节点先写红灯测试 → 确认失败 → 改代码 → 重跑转绿。共 8 个闭环节点，最小化改动。

## 根因结论（已由三方研究 + 对照实验证实）

- **真因是二进制损坏，不是路径字符**：`node_modules/ffmpeg-static/ffmpeg.exe` 被截断约 19.8MB（实际 62,985,414 字节，PE 节表要求 ≥ 82,797,568 字节）。MZ / `PE\0\0` / Machine=0x8664 头全部合法，但 `CreateProcess` 返回 `ERROR_BAD_EXE_FORMAT(193)` → Node 侧表现为 `spawn EFTYPE`。对照实验：同一非 ASCII 目录下 `electron.exe`(214MB)、`ffprobe.exe`(63MB) 均 spawn 成功；PowerShell 直连 `CreateProcessW` 打开同一 `ffmpeg.exe` 亦报"不是有效 Win32 程序"。
- **弹窗逃逸机制**：`ffmpeg(...).run()` 先跑能力探测 `availableFormats()` → `_spawnFfmpeg(['-formats'])`（`node_modules/fluent-ffmpeg/lib/processor.js:150` 的 `spawn` 同步抛 EFTYPE）。fluent-ffmpeg 内嵌 `async@0.2.10` 把 waterfall 每个任务放进 `setImmediate` 宏任务（`async.js:497-503`），故 `.run()` 外层 try/catch 与 Promise executor 均失效，`.on('error')`（`processor.js:156`）永不到达 → 逃逸为 `uncaughtException` → `early-crash-guard` 弹窗。同一次失败使视频帧从未抽取 → 缩略图缺失。
- **非 ASCII 降级有害且使 PE 预检失效**：`src/main/utils/ffmpeg-paths.ts:40-46` 的 `hasNonAsciiPath → 回退裸命令 'ffmpeg'` 排在 PE 预检（`:50`）之前，中文安装路径用户永远走不到 PE 校验，且被丢弃的恰是完好的随包二进制。
- **弹窗风暴**：`showNonFatalErrorBox`（`src/main/utils/early-crash-guard.ts:278-306`）无去重，且 `src/main/index.ts:29-31` 与 `src/main/app/error-handlers.ts:38-43` 各注册一个 `uncaughtException` 监听器、都调 `reportEarlyFatal` → 单次故障 ≥2 个模态框，叠加 3 级抽帧阶梯最多 6 个（模态阻塞主进程）。

## 改动范围与非目标

- **范围**：主进程 `src/main/utils` 与 `src/main/thumbnail`，以及 4 个进程入口的垫片安装；修复本地被截断的 ffmpeg 二进制。
- **非目标（明确不做）**：
  - 不改 IPC 通道 / preload 签名（`docs/IPC_CONTRACT.md` 同步义务**不触发**）；
  - 不改渲染层 / CSS / 主题；
  - 不新增 i18n key（`i18n:guard` 不触发）；
  - 不动 `ffprobe.js` 路径解析（`video-probe.ts` 事实安全）；
  - 不删除 `hasNonAsciiPath` 函数本身（`native-load-guard.ts:208` 仍依赖它）；
  - 不重构双 `uncaughtException` 监听器、不清理 `resolveSafeBinaryPath` 死代码（见文末"可选后续"）。

## 依赖声明

- **无新增 / 升级 npm 依赖**。复用现有：
  - `fluent-ffmpeg@^2.1.3`（ffmpeg 命令编排）
  - `ffmpeg-static@^5.3.0`（随包 ffmpeg 二进制，**版本号不变**）
  - `ffprobe-static@^3.1.0`（随包 ffprobe 二进制，完好，不动）
  - Node 内置 `child_process` / `fs`
  - 测试框架 `vitest@^1.6.1`
- **唯一的依赖变更 = 修复既有二进制**：重装 `ffmpeg-static`（同版本 ^5.3.0）以重新下载完整的 `ffmpeg.exe`；不改 `package.json` / `package-lock.json` 中的版本号，不引入下载镜像新包。
- `ffmpeg-static` 的二进制由其自带 install 脚本（`node_modules/ffmpeg-static/install.js`）从 GitHub Releases 下载；本机 `.npmrc` 未配置二进制镜像（镜像约定由环境变量 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` 承载，与 ffmpeg-static 无关）。若下载受阻，允许的兜底手段见节点 2 的"风险回退"。

## 启动说明

- **环境要求**：Windows x64，Node ≥ 20（见 `.node-version` 与 `engines.node`），PowerShell 下命令分隔用 `;`（不能用 `&&`）。
- **开发启动**：`npm run dev`（electron-vite dev，主进程 + vite dev server）。
- **本计划涉及的常用命令**（均已在 `package.json#scripts` 中确认存在）：
  - 单测：`npx vitest run <测试文件路径>`（节点级验证）；`npm test`（全量，节点 8）
  - 类型检查：`npm run typecheck`（`tsc -b`，引用式项目）
  - Lint：`npm run lint`（`eslint .`）
  - 构建：`npm run build`；打包：`npm run dist:win`（含 `scripts/pre-dist-check.ts` 前后置校验）
- **节点执行顺序**：节点 1 → 2 可并行启动（文档不依赖二进制修复结果）；节点 3 → 4 → 5 → 6 → 7 严格串行（后者依赖前者的导出/垫片）；节点 8 在全部节点完成后执行。
- **并行代理注意事项**：本项目多个单元测试 mock 了 `ffmpeg-static`，节点 2 重装期间不影响其他并行任务的测试；重装只允许 `npm rebuild ffmpeg-static` / 单包安装，**禁止全量 `npm install`** 造成 `node_modules` 大范围变动。

## 错误处理

汇总各节点的错误处理与兜底策略：

- **垫片降级链**（节点 5）：将"同步 spawn 抛出"降级为回调 `err` → 触发 fluent-ffmpeg 既有 `.on('error')` / `reject` → `src/main/thumbnail/generator.ts` 的 `maybeLogSpawnError` → `markCorrupted` → `return null`：缩略图缺失但**应用不弹窗、worker 不退出**。
- **PE 校验失败**（节点 3/4）：`diagLog('FFMPEG', …)` 记录诊断 + 回退裸命令 `'ffmpeg'`（PATH 中若有可用 ffmpeg 仍能工作；否则 ENOENT → 优雅返回 null）。
- **弹窗去重**（节点 6）：单次故障至多 1 个非致命模态框；非致命错误补写 `startup-errors.log`，使用户被指向的日志确有本次错误详情。
- **自身不抛错**：新增代码（`hasValidPeStructure` / spawn 垫片 / 去重守卫）全部 try/catch 包裹，绝不自身抛入 `uncaughtException`。
- **错误分类**：涉及可预期业务错误时遵循 `.qoder/rules/project-conventions.md` 第 2 节的 `AppError` 家族约定；本计划新增代码主要在底层 utils，以返回 `boolean` / 回调传错为主，不新增错误码。
- **日志**：沿用 `diagLog`（`startup-diagnostic`）与 `maybeLogSpawnError`（`spawn-error-log`），不引入新日志系统、不新增 i18n key（弹窗文案走既有 `dialog.showErrorBox` 原生路径）。

## 参数校验

新增/修改函数的入参校验约定：

- `hasValidPeStructure(filePath: string): boolean`（节点 3）：
  - 空路径 / 非字符串 → `false`（不抛错）；
  - 文件不存在 / 非普通文件 → `false`；
  - 文件大小 < 最小 PE 头长度（DOS header 64B）→ `false`；
  - `e_lfanew`（偏移 0x3C，4 字节 LE）指向越界、`PE\0\0` 签名缺失、COFF 头 / 节表项任一偏移越界 → `false`；
  - 任何读取异常（IO 错误、权限）→ try/catch 吞掉并返回 `false`；
  - 平台门控（仅 win32 调用）由**调用方**负责，函数本身不做平台判断。
- `resolveBinaryPath` / `ffmpegPath` / `ffprobePath`（节点 4）：候选路径为空 → 直接走 fallback；`existsSync` 为 false → fallback；win32 且 PE 校验失败 → `diagLog` + fallback。对外导出签名不变（仍为模块级常量）。
- `installFfmpegSpawnGuard()`（节点 5）：无参数；以 `Symbol` 幂等守卫防重复安装；安装前断言 `typeof ffmpeg.prototype._spawnFfmpeg === 'function'`，不满足则 `diagLog` 告警并跳过（不抛错）。包裹函数在无法定位回调（无 cb）时 **rethrow 原始错误**，不吞真错。
- `showNonFatalErrorBox` / `reportEarlyFatal`（节点 6）：签名不变；去重守卫为模块级布尔标志，仅影响弹框次数，不影响 `diag.log` / `startup-errors.log` 落盘。

## 基础测试用例

按 正常 / 异常 / 边界 三类，全部遵循"先红后绿"：

| 测试文件                                    | 正常                                | 异常                                                                                                       | 边界                                                                                                                                                       |
| ------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/utils/path-safety.test.ts`        | 合法 PE 文件 → `true`               | 非 PE（ELF / 随机字节 / 0 字节文件）→ `false`                                                              | 截断 PE（MZ + `e_lfanew` → `PE\0\0` + Machine=0x8664 + 节表 `max(PointerToRawData+SizeOfRawData) > fileSize`）→ `false`；`e_lfanew` / 节表项越界 → `false` |
| `src/main/utils/ffmpeg-paths.test.ts`       | 合法随包二进制 → 返回绝对路径       | 文件不存在 → 降级裸命令 `'ffmpeg'`                                                                         | 非 ASCII 路径 + 合法 PE → 返回绝对路径（**反转**原 `:244-249` 的降级断言）；截断 PE → 降级裸命令                                                           |
| `src/main/utils/fluent-ffmpeg-shim.test.ts` | spawn 成功 → `cb(null, …)` 正常返回 | spawn 同步抛 EFTYPE → `cb(err)` 收到 `code==='EFTYPE'`，且 `process` 的 `uncaughtException` 间谍**未**触发 | 无 cb → rethrow；重复安装 → 幂等（no-op，不二次包裹）                                                                                                      |
| `src/main/utils/early-crash-guard.test.ts`  | 致命路径：无主窗口 → 弹致命框并退出 | spawn 类非致命 + 有主窗口 → 弹非致命框、不退出                                                             | 同一进程内连续两次 `reportEarlyFatal(makeSpawnError(), …)` → `showErrorBox` 仅调用 1 次                                                                    |
| `src/main/thumbnail/generator.test.ts`      | 抽帧成功 → 返回缩略图路径           | ffmpeg `.on('error')` → `generate()` 返回 `null`、`markCorrupted` 被调                                     | `mode:'syncThrow'`（`run()` 内 `setImmediate(()=>{throw eftype})` 模拟能力探测逃逸）→ 经垫片降级为 `null`，不泄漏到 `process`                              |

垫片测试关键细节：**不 mock fluent-ffmpeg 本体**，用 `vi.mock('child_process')` 令 `spawn` 同步抛 `Object.assign(new Error('spawn EFTYPE'), {code:'EFTYPE', errno:-4028, syscall:'spawn'})`；调用 `ffmpeg.getAvailableFormats(cb)` 后需 `await` 两次 `setImmediate` 以跨过 `async@0.2.10` 的宏任务边界再断言。

## 实施节点（每节点严格闭环：先写红灯测试 → 确认失败 → 改代码 → 重跑转绿）

### 节点 1：写入实施计划 MD 到仓库

- **文件（新建）**：`docs/plans/2026-09-28-fix-video-thumbnail-spawn-eftype.md`（即本文档）
- **输入**：已批准的修复计划。
- **输出**：含 `## 依赖声明` / `## 启动说明` / `## 错误处理` / `## 参数校验` / `## 基础测试用例`（正常·异常·边界）五小节 + 每子任务（文件全路径·输入输出·可判定验收）的自洽 MD 文档。
- **验收标准（可判定）**：文件存在于仓库；五个小节标题齐全；节点 2~8 均列出文件路径、输入/输出与可判定验收标准。

### 节点 2：修复被截断的 ffmpeg 二进制（真因）

- **文件**：`node_modules/ffmpeg-static/ffmpeg.exe`（二进制，非源码；不改 `package.json` / `package-lock.json`）。
- **输入**：损坏的 `ffmpeg.exe`（62,985,414 B，PE 节表要求 ≥ 82,797,568 B）。
- **输出**：完整的 `ffmpeg.exe`（> 80,000,000 B，可执行）。
- **动作（按序尝试，尽量局部）**：
  1. 记录现状字节数 → 删除损坏的 `ffmpeg.exe` → `npm rebuild ffmpeg-static` 或直接 `node node_modules\ffmpeg-static\install.js` 触发重新下载；
  2. 若未重新下载：删除整个 `node_modules\ffmpeg-static` 目录 → `npm install ffmpeg-static`（沿用已声明的 ^5.3.0）。
- **验收标准（可判定，必须实际运行）**：
  - a) `(Get-Item "node_modules\ffmpeg-static\ffmpeg.exe").Length` > 80,000,000；
  - b) `node -e "const{execFileSync}=require('child_process');process.stdout.write(execFileSync(require('ffmpeg-static'),['-version']).toString())"` 退出码 0 且输出含 `ffmpeg version`。
- **风险回退**：若下载被网络/镜像阻断，如实报告失败原因与已尝试的镜像方案（如设置 `ffmpeg-static` 支持的镜像环境变量或手动放置官方完整二进制），**不得伪造成功、不得跳过**；若重装后仍为同一截断尺寸，判定为上游/镜像问题并单独取证，不进入后续节点。
- **ffprobe.exe（63,059,968 B）完好，不动。**

### 节点 3：强化 PE 完整性校验（TDD）

- **文件**：
  - `src/main/utils/path-safety.ts`（新增导出 `hasValidPeStructure(filePath: string): boolean`）
  - `src/main/utils/path-safety.test.ts`（新增用例）
- **输入**：任意文件路径。**输出**：该文件是否为结构完整（未截断）的 win32-x64 PE。
- **实现要点**：读 DOS header `e_lfanew`（偏移 0x3C，4B LE）→ 校验 `PE\0\0` 签名 → COFF `Machine`(0x8664) 与 `NumberOfSections` → 遍历节表求 `max(PointerToRawData + SizeOfRawData)` 与实际文件大小比较；全程 try/catch，任一偏移越界即 `false`。
- **验收标准**：`npx vitest run src/main/utils/path-safety.test.ts` 全绿；新用例（正常/异常/边界见上表）先红后绿；`npm run typecheck` 通过。

### 节点 4：修正 ffmpeg 路径解析（移除有害降级，TDD）

- **文件**：
  - `src/main/utils/ffmpeg-paths.ts`（删除 `:40-46` 非 ASCII 降级分支；PE 预检由"2 字节 MZ"改调 `hasValidPeStructure`）
  - `src/main/utils/ffmpeg-paths.test.ts`（**反转** `:244-249` 现有非 ASCII 断言 + 新增截断 PE 用例）
- **输入**：候选二进制路径列表。**输出**：解析后的 `ffmpegPath` / `ffprobePath` 模块级常量（签名不变）。
- **实现要点**：`resolveBinaryPath` 改为候选为空 → fallback；`existsSync` → (win32 && !`hasValidPeStructure`) → `diagLog('FFMPEG', …)` + fallback；否则返回解析后的绝对路径。移除对 `hasNonAsciiPath` 的**调用**（保留函数定义，`native-load-guard.ts:208` 仍依赖）。
- **验收标准**：`npx vitest run src/main/utils/ffmpeg-paths.test.ts` 全绿；两条新用例 + 反转用例先红后绿；`npm run typecheck` 通过。

### 节点 5：fluent-ffmpeg spawn 逃逸垫片（核心崩溃修复，TDD）

- **文件**：
  - 新建 `src/main/utils/fluent-ffmpeg-shim.ts`（导出 `installFfmpegSpawnGuard(): void`）
  - 新建 `src/main/utils/fluent-ffmpeg-shim.test.ts`
  - 安装点（各加一行 import + 调用）：`src/main/index.ts`、`src/main/media-worker/worker-entry.ts`、`src/main/scanner/worker-entry.ts`、`src/main/video-editor/worker-entry.ts`（各进程持有独立 fluent-ffmpeg 实例，须逐进程安装；thumbnail / database / decryption worker 不用 ffmpeg，不装）
- **输入**：无参数（幂等安装）。**输出**：`ffmpeg.prototype._spawnFfmpeg` 被安全包裹，同步抛出转为回调错误。
- **实现要点**：`Symbol` 幂等守卫；先断言 `typeof ffmpeg.prototype._spawnFfmpeg === 'function'`，否则 `diagLog` 告警并跳过；包裹 `orig`：`try { return orig.apply(this, arguments) } catch (e) { 按 processor.js:116-125 归一化 4/3/2 参数定位真正 endCB；typeof cb === 'function' ? cb(e) : throw e }`。在每个入口启动早期（任何 `.run()` 之前）调用一次。
- **验收标准**：`npx vitest run src/main/utils/fluent-ffmpeg-shim.test.ts` 全绿；先红后绿；grep 确认 4 个入口均 import + 调用；`npm run typecheck` 通过。

### 节点 6：弹窗去重 + 非致命落盘（early-crash-guard，TDD）

- **文件**：
  - `src/main/utils/early-crash-guard.ts`（`showNonFatalErrorBox` 加模块级去重守卫；`:186-197` 非致命分支 `return` 前补 `logStartupError`）
  - `src/main/utils/early-crash-guard.test.ts`（新增去重用例，复用 `makeSpawnError()` fixture `:225-232`）
- **输入**：`reportEarlyFatal(err, opts)` 调用序列。**输出**：同一进程内非致命弹框至多 1 次；每次非致命错误均落盘日志。
- **实现要点**：模块级 `hasShownNonFatal` 标志，首次弹框、后续静默（仍写 `diag.log` 与 `startup-errors.log`）；补 `logStartupError` 调用。函数签名不变。
- **验收标准**：`npx vitest run src/main/utils/early-crash-guard.test.ts` 全绿；去重用例先红后绿；双监听器场景下同一错误仅 1 个模态框。

### 节点 7：视频缩略图链路优雅降级验证（TDD）

- **文件**：
  - `src/main/thumbnail/generator.test.ts`（新增 `mode:'syncThrow'`：桩 `run()` 内 `setImmediate(() => { throw eftype })` 模拟能力探测逃逸）
  - `src/main/thumbnail/generator.ts` 降级链已存在（`:502-533` `markCorrupted` + `return null`），**预期无需改源码**；仅当测试暴露缺陷才做最小改动。
- **输入**：模拟 spawn 同步抛错的 ffmpeg 调用。**输出**：`extractVideoFrame` / `generate()` 返回 `null`（或 reject 被上层 catch），错误不泄漏到 `process`。
- **验收标准**：`npx vitest run src/main/thumbnail/generator.test.ts` 全绿；新用例先红后绿（未装垫片时泄漏/30s 超时为红）。

### 节点 8：全量回归 + 静态/类型/安全校验 + 打包产物核验

- **前置**：先读 `package.json#scripts` 与 `audit-ci.jsonc` **确认安全审计命令真实存在**（不假设；如无专用脚本则用 `npx audit-ci` 或 `npm audit --audit-level=high`）。
- **命令**（仓库真实存在）：`npm run typecheck`（tsc -b）、`npm run lint`（eslint .）、`npm test`（vitest run 全量）、安全审计（按前置确认的命令）。
- **打包核验**：`npm run build` 成功；如需产物级验证，`npm run dist:win` 后检查 `release/win-unpacked/resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe` 通过 `hasValidPeStructure` 或 `node -e …spawn -version` 成功。
- **验收标准（可判定）**：typecheck / lint / test 全绿，且**与修复前基线对比无新增失败项**（节点 8 开始前先记录 `npm test` 基线）；安全审计无新增 high/critical；打包产物 `ffmpeg.exe -version` 成功。
- **硬性约束**：新增的 bug 复现测试修复前必须为红（节点 3-7 已保证）；既有全量套件修复前后均须绿（无回归）。未通过全部回归不得结束。

## 假设与风险

- 假设截断源于本机 `ffmpeg-static` postinstall 下载中断（未取证具体原因）；重装应恢复完整二进制。若重装后仍截断 → 上游/镜像问题，节点 2 单独取证，不进入后续节点。
- 垫片 monkey-patch fluent-ffmpeg 私有方法 `_spawnFfmpeg`：未来升级该库需回归；已用 `typeof === 'function'` 断言 + `diagLog` 告警降级缓解。
- 全量测试基线：节点 8 前先记录修复前 `npm test` 结果作为对比基线，确保"无新增失败"。

## 明确不做项（属"全面加固"，本次未选，列为可选后续）

- `scripts/pre-dist-check.ts` 增加 ffmpeg/ffprobe 完整性发布闸门；
- `[errno]` 摘要行补 `path=` / `spawnargs=`；
- `src/main/media-worker/worker-entry.ts:362-367` 补 `maybeLogSpawnError` 对齐；
- `execFileSync` 二进制预校验 helper；
- `resolveSafeBinaryPath` 死代码清理；
- 双 `uncaughtException` 监听器合并；
- `isChildProcessSpawnError` 两份实现统一；
- `docs/技术债清单.md` 登记与相关文档更新。
