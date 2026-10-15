# NikkiGallery 启动失败闪退（ERR_INVALID_STATE: ReadableStream is already closed）根因分析与修复计划

> 分析对象：wxnn-photo-manager（工作区 `WXNN XiangCe`，源码 v2.5.5；故障现场安装版 v2.5.3，Electron 41.10.6 / Node 24.18.0，Windows 11）
> 分析材料：`startup-errors.log`（7 次 uncaughtException）+ `wxnn-logs-2026-10-15.zip`（main.log 6891 行 / faults jsonl 61 条 / system-info.json）
> 本计划批准后，执行时先落盘到 `WXNN XiangCe/docs/plans/2026-10-15-media-stream-cancel-race-fix.md`（仓库计划惯例位置，与 docs/plans/ 既有计划同级）。

---

## 一、根因结论

`media://` 协议处理器把 **Node fs.ReadStream 直接作为 `new Response()` 的 body**（[media-protocol.ts:167/183](file:///d:/Zcode项目/WXNN YD - 副本/WXNN XiangCe/src/main/app/media-protocol.ts#L167)）。Node 内置 undici 对 Node 流 body 会用 `ReadableStreamFrom()` 包装（[node_modules/undici/lib/core/util.js:623-655](file:///d:/Zcode项目/WXNN YD - 副本/WXNN XiangCe/node_modules/undici/lib/core/util.js#L623-L655)），其 `pull()` 在迭代结束后经 `queueMicrotask(() => controller.close())` 关闭流，**该 close 无任何"流已关闭"守卫**。当渲染进程取消图片/视频请求（快速滚动、视频 Range 切换）时，取消与关闭竞态交错，close 落在已关闭的流上 → `TypeError [ERR_INVALID_STATE]: Invalid state: ReadableStream is already closed`（微任务中抛出，无应用帧）→ `uncaughtException` 全局兜底一律按致命处理 → 弹「启动失败 / Startup Failed」框 + `app.exit(1)`。

**它不是启动问题，而是运行期流取消竞态被"一律致命"的异常策略误杀**；崩溃发生在启动后 12~70 秒（exit-forensics：`code=1 stage=scene-analysis`），重启后再崩，形成崩溃循环，用户感知为"启动失败"。

## 二、证据链（全部经实验/源码验证）

### 2.1 日志侧

1. 7 次崩溃堆栈完全同构：`ReadableByteStreamController.close ← node:internal/deps/undici/undici:1583:30 ← processTicksAndRejections`。
2. 每次崩溃前 ≤150ms 必有 `[ReadStream] 读流异常，已销毁: <文件> {"code":"ABORT_ERR"}`——产自 [managed-read-stream.ts:61-65](file:///d:/Zcode项目/WXNN YD - 副本/WXNN XiangCe/src/main/utils/managed-read-stream.ts#L61-L65)（request.signal 中止 → fs 流 destroy，IO 中断产生 ABORT_ERR）。被中止文件既含缩略图 `.jpg` 也含游戏目录大视频 `.Mp4`，且常见**同一文件两个流在几毫秒内先后销毁**。
3. 弹窗文案与 [early-crash-guard.ts](file:///d:/Zcode项目/WXNN YD - 副本/WXNN XiangCe/src/main/utils/early-crash-guard.ts) 的 `FATAL_TITLE='启动失败 / Startup Failed'` + `buildFatalContent()` 输出逐字匹配。

### 2.2 平台源码侧（本机已验证）

4. Electron 41.10.6 `protocol.handle` 官方源码：应用侧 `new Response(body)` 的 body 必须是 web `ReadableStream`；Electron 侧 `Readable.fromWeb(res.body)` 交给网络层，Chromium 取消请求时反向取消该流。
5. undici `extractBody`（[body.js:192-207](file:///d:/Zcode项目/WXNN YD - 副本/WXNN XiangCe/node_modules/undici/lib/web/fetch/body.js#L192-L207)）：有 `Symbol.asyncIterator` 的对象（Node 流）→ `ReadableStreamFrom()` 包装，`type: 'bytes'` → `ReadableByteStreamController`（与堆栈中的控制器类型吻合）。
6. **冒烟实验（决定性）**：在 Electron 41.10.6 内置 Node 24.18.0 下（`ELECTRON_RUN_AS_NODE=1`），原型补丁拦截 `ReadableByteStreamController.close` 记录调用方——`new Response(Node流)` 的消费/销毁路径中，**所有 close 调用 100% 来自 `node:internal/deps/undici/undici:1583:30`，与生产崩溃堆栈逐字节吻合**；同场景下 Node 原生 `Readable.toWeb()` 的 close 调用数为 0（走完全不同的适配器，不经过该无守卫站点）。
7. undici 自知此类竞态：其 fetch 路径的 `readableStreamClose()` 明确捕获 `ReadableStream is already closed`（源码留有 TODO 注释），但 `ReadableStreamFrom`（Node 流路径）未使用该守卫。

### 2.3 触发场景与环境差异（为何仅部分设备、开发环境无法复现）

- **必要条件是"取消风暴"**：图库快速滚动（虚拟列表回收 → img 请求取消）+ 视频 Range 切换 + 启动期场景分析并发。该用户有大量游戏视频（.Mp4）与 3.6MB+ 加密照片，启动期请求密度远高于开发机的小测试库。
- **竞态窗口 = 在途 `iterator.next()` 时长**：取决于磁盘单次读延迟。故障机媒体在 E: 盘（游戏目录，疑似慢速盘），窗口大、命中率高；开发机 SSD 小文件，窗口极窄。
- **概率事件**：取消必须恰好落在"pull 已发出、其关闭微任务尚未执行"的窗口内；本机 80~150 次合成循环均未触发（多进程 IPC 时序才稳定命中），与"同版本开发环境不崩"一致——不是版本差异，是环境时序差异。
- **崩溃循环放大**：崩 → 重启 → 启动扫描+场景分析再次制造请求风暴 → 再崩（日志 10:26–10:42 五连崩）。媒体库越大越易入循环。
- **已排除**：NikkiSync（崩溃时刻无任何 sync 活动，探针 env 门控，`nikkisync/` 无网络代码）；网络波动（全链路本地文件流）；杀软/权限（无 EACCES/EPERM 前置）；09:54 的 exit-diagnosis 属正常退出（uptime 669s），6 个 Socket 与崩溃无关。

## 三、修复方案（两个节点，均为最小改动）

### 依赖声明

**零新增依赖、零版本变更、零安装步骤。** 复用 Node 原生 `stream.Readable.toWeb()`（Node ≥17 内置，Electron 41/Node 24.18 具备）与仓库现有 `createManagedReadStream`。不升级 Electron/undici（上游 `ReadableStreamFrom` 至今未加守卫，本仓库 node_modules 内 undici 7.30.0 证实；升级也不可控）。

### 节点 1【根除】media:// 响应体改用 Node 原生 toWeb 适配

**修改文件：`src/main/app/media-protocol.ts`**（仅 2 个调用点 + 1 行 import，总 diff ≈ 4 行）

| 项   | 内容                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 输入 | `realPath: string`（已 realpath + 白名单校验）、`request.signal`（AbortSignal，可空）、`range: ByteRange`（206 分支，可空）——均与现状一致                                                                                                                                                                                                                                  |
| 改动 | L165-179（Range 206 分支）与 L181-194（完整 200 分支）：`new Response(stream as unknown as ReadableStream, …)` → `new Response(Readable.toWeb(stream) as unknown as ReadableStream, …)`；文件头 `import { Readable } from 'node:stream'`。`stream` 仍由 `createManagedReadStream(realPath, { signal: request.signal, range })` 创建——fd 归还、abort 监听、错误日志全部不变 |
| 输出 | `Response`，其 body 为 `ReadableStream<Uint8Array>`；头信息/缓存策略/白名单逻辑零改动                                                                                                                                                                                                                                                                                      |
| 原理 | undici `extractBody` 对已是 web `ReadableStream` 的 body **直通不包装**（body.js:51-52），`undici:1583` 无守卫 close 站点从链路上彻底消失；toWeb 走 Node 官方 webstreams 适配器（实验证实不经过 `ReadableByteStreamController.close`，且在 cancel/destroy/优雅关闭的全部敌对交错下零异常）                                                                                 |
| 类型 | `Readable.toWeb` 返回 node:stream/web 的 `ReadableStream`，与 DOM lib 的 `ReadableStream` 类型声明不同构，`as unknown as ReadableStream` 最小 cast 保留（原代码即有）                                                                                                                                                                                                      |

**验收标准（可判定）**：

- 新增缺陷复现测试「media:// 响应体的 close 不得经过 undici 适配层」由红转绿（见 4.1 节，修复前因 close 调用方含 `node:internal/deps/undici` 而失败）；
- `npm run test:main` 中 `media-protocol.test.ts` 既有 24 个用例全部保持通过（响应头/状态码/白名单行为不变）。

### 节点 2【兜底】uncaughtException 窄分类：流状态竞态在应用已就绪后降级为"仅记录"

**修改文件：`src/main/utils/early-crash-guard.ts`**（新增 1 个纯函数 + `reportEarlyFatal` 内 1 个分支，总 diff ≈ 30 行）

| 项         | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 输入       | `err: unknown`（任意异常）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 改动       | 新增纯函数 `isStreamStateRaceError(err)`：`err.code === 'ERR_INVALID_STATE'` 且 `err.message` 匹配 `/ReadableStream is already (closed\|locked)/`（入参做类型与字段判空，非对象/缺字段一律 false）。`reportEarlyFatal` 中，紧邻现有 `isChildProcessSpawnError` 分支（L188-206）增加：命中该分类 **且** `(deps.hasMainWindow ?? defaultHasMainWindow)()` → `logFaultSync('uncaughtException', err, { stage, declassified: 'stream-race' })` + `diagLog('STREAM-RACE-NONFATAL', …)` 后 `return`（**不弹窗、不退出**）；否则维持现状（致命） |
| 输出       | 无返回值；副作用为日志两条                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 合法性论证 | 异常抛自已分离的微任务，唯一受影响对象（被取消的响应流）已销毁，无应用状态受损；先例：spawn 错误同类降级已在线上运行。启动期（无主窗口）任何异常仍致命，真实启动故障的发现能力不受影响。窄分类三重条件（code + message + hasMainWindow）防止把真实致命错误吞掉                                                                                                                                                                                                                                                                            |

**验收标准（可判定）**：新增缺陷复现测试（生产同构错误 + hasMainWindow=true）由红转绿：`exitApp` 与致命 `showErrorBox` 不被调用、`logFaultSync` 被调用；修复前该测试因 `exitApp(1)` 被调用而失败。

### 文档同步（随节点 2 一起提交）

**修改文件：`src/main/utils/AGENTS.md`**：`managed-read-stream.ts` 职责行补一句"media:// 响应体经 `Readable.toWeb` 转换后供给 `new Response`（绕开 undici 对 Node 流的无守卫包装）"；`early-crash-guard.ts` 职责行补"流状态竞态降级"。各 1 行，符合"改模块职责须同步 AGENTS.md"的项目约定。

## 四、TDD 测试计划（红 → 绿，逐节点闭环）

> 测试运行器：vitest（`npm run test:main`）。测试与源码同目录。**缺陷复现测试（红灯）**必须先于代码修改编写并确认失败；**行为护栏测试**覆盖正常/异常/边界三类，修复后必须全绿防退化。分类依据：多进程 IPC 取消时序无法在单测中确定性触发（本机已验证 80~150 次合成循环不可稳定复现），故缺陷复现采用「确定性断言缺陷机制」而非「等待概率时序」——两盏红灯分别锁定两个层面的缺陷本体（路由经过 undici 无守卫站点 / 致命策略误杀）。

### 4.1 节点 1 测试（修改 `src/main/app/__tests__/media-protocol.test.ts`）

**T1【缺陷复现·红灯】**「media:// 响应体的 close 不得经过 undici 适配层」

- 构造：mock `fs.createReadStream` 返回**真实** `Readable`（`new Readable({read(){}})`，手动 push）；try/finally 中原型补丁 `ReadableByteStreamController.prototype.close`，记录每次调用的 `new Error().stack` 调用方帧；
- 执行：捕获的 `mediaHandler` 处理带 Range 请求 → `for await` 消费 `response.body` 至 done → mock 流 push 数据 + `push(null)` 结束；
- 断言：所有记录的 close 调用方中**不含** `node:internal/deps/undici`；
- 修复前：close 由 `undici:1583` 调用 → 断言失败（红灯）；修复后：body 为 toWeb 产物，不经 undici 包装 → 无 undici 调用方（绿灯）。补丁在 finally 中恢复原型，测试自注释引用生产堆栈。

**T2【护栏·正常】**：真实 `Readable` mock 下，206 与 200 两分支的 `response.body` 可完整消费，内容/字节数与 mock 数据一致；既有响应头断言（Content-Range/Content-Length/Cache-Control/ETag）不变。

**T3【护栏·异常】**：消费中途 `reader.cancel()` + mock 流 `destroy()`（模拟 Chromium 取消 + signal abort 的两种先后交错）→ 无异常逃逸（测试内 `process.on('uncaughtException')` 捕获断言为空）、reader 以 done 或 cancel 正常终止。

**T4【护栏·边界】**：空文件（size 0 的 mock stat）→ 响应体立即 done 不挂起；`push(null)` 前后两次 cancel 幂等。

### 4.2 节点 2 测试（修改 `src/main/utils/early-crash-guard.test.ts`，沿用其现有 DI/`vi.resetModules` 约定）

**T5【缺陷复现·红灯】**：`reportEarlyFatal(err, { stage: 'index.uncaughtException', deps: { hasMainWindow: () => true } })`，err 为生产同构对象（`Object.assign(new TypeError('Invalid state: ReadableStream is already closed'), { code: 'ERR_INVALID_STATE' })`）→ 断言 `exitApp` 未被调用、致命 `showErrorBox` 未被调用、`logFaultSync` 已调用 → 修复前 `exitApp(1)` 被调用而失败（红灯）。

**T6【护栏·边界】**：同样错误 + `hasMainWindow: () => false`（真启动期）→ 仍致命退出（守护启动故障发现能力）。

**T7【护栏·窄分类】**：`ERR_INVALID_STATE` 但 message 不匹配（其他 invalid state）+ 有窗口 → 仍致命；非对象入参/缺 code → 分类函数返回 false。

### 4.3 执行顺序（分步验证，每步通过才进下一步）

1. 写 T1/T5 → 运行确认红灯（`npx vitest run src/main/app/__tests__/media-protocol.test.ts src/main/utils/early-crash-guard.test.ts`）。
2. 节点 1 代码修改 → T1-T4 绿灯（先跑单文件，再 `npm run test:main` 相关子集）。
3. 节点 2 代码修改 + AGENTS.md 同步 → T5-T7 绿灯。
4. 全量回归（见下节）。

## 五、全量回归与全局校验（全部通过后任务才可结束）

在 `WXNN XiangCe` 目录依次执行（均为仓库真实存在的命令）：

```bash
npm test                # vitest 全量
npm run typecheck       # tsc -b + scripts 层
npm run lint            # eslint .
npm run audit           # audit-ci 安全检查（audit-ci.jsonc）
npm run verify          # 只读验证闸门（typecheck + lint + format + 相关单测 + 核心路径授权闸门）
```

手工验证（dev 压测）：`npm run dev` → 打开含视频的图库 → 快速滚动 + 反复切换视频预览 2 分钟 → `logs/main.log` 无 `uncaughtException`、无 `ERR_INVALID_STATE`；缩略图/视频正常加载；快速滚动后媒体文件可删除（fd 释放回归，对齐 managed-read-stream 既有验收口径）。

## 六、错误处理与日志规范

- 节点 1 不新增任何日志/文案（fd/abort/错误日志全部沿用 `createManagedReadStream` 现有通道，i18n key `main.readStream.log.streamErrorDestroyed` 不变）。
- 节点 2 降级路径：`logFaultSync('uncaughtException', err, { stage, declassified: 'stream-race' })`（进 faults 通道，下次线上再出现可直接检索来源）+ `diagLog('STREAM-RACE-NONFATAL', …)`；不弹窗（良性瞬态，弹窗即噪音；与 unhandledRejection 偶发路径"记录不打扰"策略一致）。
- early-crash-guard 模块按其自身设计约定不依赖 i18n（日志为硬编码字符串），无需 i18n 变更、无需跑 i18n:guard。

## 七、启动说明

- 环境准备：现有开发环境即可（Node ≥ 20、npm 已 install、无新环境变量）。
- 启动命令：`npm run dev`（electron-vite dev）。
- 验证方式：第四节/第五节的自动化命令 + dev 压测流程。
- 本机已具备的复现/验证工具（执行时可用）：`ELECTRON_RUN_AS_NODE=1 electron.exe`（仓库 `node_modules/electron/dist/`）可在生产同款 Node 24.18.0 下运行验证脚本。

## 八、风险与权衡

| 风险                       | 评估与对策                                                                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| toWeb 是否存在同类未知竞态 | 实验矩阵（自然结束/cancel-destroy/destroy-cancel/end-then-read × 100 次迭代，生产同款运行时）零异常；且即使出现，节点 2 兜底保证不再致命退出。双层设计互为保险 |
| 降级策略吞掉真实致命错误   | 分类三重收窄（code 精确匹配 + message 正则 + hasMainWindow）；启动期（无窗口）不降级；T6/T7 永久守护                                                           |
| 原型补丁测试的脆弱性       | T1 断言的是"调用方不含 undici"（结构性事实，非行号），undici 若未来改变实现，测试意图仍成立；finally 恢复原型，不污染其他用例                                  |
| 多进程时序无法单测复现     | 已如实声明：红灯测试锁定缺陷机制（undici 路由 + 致命策略），最终防线由 dev 压测 + 线上 faults 通道（declassified 标记）闭环验证                                |

## 九、次要发现（记录在案，不属于本次修复范围）

1. **渲染层 pageSize 超限**（`[fetchMediaFromDatabase] 参数校验失败：[0.pageSize] Too big: <=500`，53 条 rendererError，本次日志最大噪音源）：某处以 >500 的 pageSize 请求媒体列表被 zod 拒绝，可能导致该用户图库分页显示异常。建议另行修复（渲染层调用点 clamp 或修正分页逻辑）。
2. 缩略图 `realpath 解析失败`（文件缺失自愈重建期间 404）：既有设计行为，无需处理。
3. 建议后续关注 undici 上游对 `ReadableStreamFrom` 守卫的修复进展（跟踪项，不阻塞本次交付）。
