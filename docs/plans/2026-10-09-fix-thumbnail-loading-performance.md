# 缩略图加载性能优化实施计划

> 本文为 2026-10-09 轮次快照，当前口径以主规约文档为准（生命周期/约定见根 AGENTS.md 与 docs/CODING_CONVENTIONS.md；通道见 docs/IPC_CONTRACT.md）。

## 产品概述

针对本地相册应用各板块（图库网格/列表/时间线/事件时间线/瀑布流、重复文件、回收站、套装画廊）缩略图加载缓慢的问题，执行“测量 → 定位 → 最小修复 → 回归”闭环：先建立可复现的性能基线，再用确定性计数与真实运行耗时定位瓶颈，只修复被证据证实的瓶颈。

## 核心目标

- 记录首屏、滚动、按需生成和视频抽帧的 P50/P95，以及 IPC 调用、重复请求、原图回退、缓存失效次数。
- 非网格视图缺少缩略图时显示占位并触发按需生成，不再把原图作为缩略图解码。
- 抽取并复用按需生成的去重、失败和结果缓存逻辑。
- 缩略图回写后仅定向失效相关 `media://` 缓存，保留安全语义。
- 仅在测量证实后实施请求合并或首屏免防抖。
- 全量测试、类型检查、静态检查、安全审计、构建、打包态冒烟和性能回归全部通过。

## 依赖声明

- 默认零新增依赖，不修改 `package.json`、`package-lock.json`。
- 复用 `react-virtuoso@^4.18.11`、`masonic@^4.1.0`、`sharp@^0.35.3`、`zod@^4.4.3`、Vitest、Testing Library、Playwright、`ThumbReveal`、`MediaThumbnail`、`useFailedImages`、`ThumbnailGenerator` 和现有并发工具。
- 环境要求 Node.js `>=20`。依赖缺失时仅运行 `npm install` 增量安装，禁止 `npm ci`。
- 若实测证明必须新增依赖，先补充包名、精确版本、安装命令、许可证、维护性及现有能力不足的证据，确认后再安装。

## 环境、启动与验证

1. 环境检查：`node --version`、`npm --version`、`npm run doctor`。
2. 开发启动：`npm run dev`。
3. 节点测试：`npx vitest run <测试文件>`。
4. 增量验证：`npm run verify`、`npm run test:main`、`npm run test:renderer`。
5. 全局验证：`npm test`、`npm run lint`、`npm run typecheck`、`npm run audit`。
6. 构建与性能：`npm run dist:win`、`npm run e2e:smoke`、`npm run e2e:perf`。若 Safe-Delete 阻断 `npm run build` 的清理步骤，按项目既有流程移走旧 `dist/main`，执行 `npx electron-vite build`，再写入 `dist/main/package.json` 的 `{ "type": "commonjs" }`，不得跳过构建验证。

## 错误处理与降级

- 生成失败返回 `null`，卡片维持占位；图片和视频均不因生成失败回退为不可控的大文件请求。
- 同一路径在会话内复用同一个 Promise；失败状态不自动无限重试，避免请求风暴。
- preload/API 不可用、路径为空或索引越界时跳过生成，不抛出渲染期异常。
- 主进程回写数据库或缓存失效失败使用既有 `logger.warn('[Thumbnail] ...')`，不影响本次已生成路径返回。
- `media://` 定向失效失败时保持 fail-safe：未知/未授权路径仍走完整白名单校验，禁止放宽安全判断。
- 保留 worker 超时、损坏文件标记、视频白帧自愈、内联 sharp 降级和 `_low/_high` 命名契约。

## 参数校验

- Hook 输入必须是数组；条目必须含非空 `file_path`，`thumbnail` 为 `string | null | undefined`。
- 可视区 `startIndex`、`endIndex` 必须为有限整数；负数钳制到 `0`，上界钳制到 `files.length - 1`，`endIndex < startIndex` 时无操作。
- `file_type` 仅 `'image'` 可参与图片逻辑；未知类型按视频/不安全类型处理，不回退原文件。
- 定向失效参数为可选 `string[]`：缺省保持全清语义；空数组无操作；非法/空路径忽略；有效路径先 `path.resolve` 后删除对应缓存项。
- 若新增 IPC，必须复用 zod schema、限制批量大小、逐路径执行 `assertFileReadPath`，并保持旧 `thumbnail:generate` 向后兼容。

## 性能假设与判定

| 编号 | 候选瓶颈                 | 当前证据                            | 判定门禁                                                        |
| ---- | ------------------------ | ----------------------------------- | --------------------------------------------------------------- |
| H1   | 非网格视图缺图直载原图   | `thumbnail-src.ts` 对图片回退原文件 | 缺图解析结果必须为 `null`，原图回退次数为 0                     |
| H2   | 每次回写全局清缓存       | handler 每项调用全清函数            | 定向失效后无关路径缓存仍命中，source-path/realpath 缓存不被清空 |
| H3   | N 个单项 IPC/DB 写放大   | Grid 可视区逐项并发调用             | 仅在实测显著时合并；同一路径重复触发始终仅 1 次                 |
| H4   | 首屏等待 300ms           | Grid 的滚动防抖复用于初次范围       | 仅在首屏测量证明后改为首次立即、滚动仍防抖                      |
| H5   | `media:updated` 全量刷新 | store 替换数组并清失败态            | 仅记录，除非测量证明为主要耗时                                  |
| H6   | 视频抽帧/排队            | ffmpeg 并发 2、seek 重试            | 不弱化超时/损坏/白帧保护；仅证实可视项饥饿后调优                |

## 基础测试矩阵

| 场景                     | 类型 | 预期                                          |
| ------------------------ | ---- | --------------------------------------------- |
| DB 已有缩略图            | 正常 | 返回 DB 缩略图 URL，不触发生成                |
| 图片无缩略图             | 正常 | 返回 `null` 显示占位，并仅触发一次按需生成    |
| 视频无缩略图             | 正常 | 返回 `null`，绝不把视频路径交给 `<img>`       |
| 同路径重复进入可视区     | 边界 | 复用同一 Promise，IPC 次数为 1                |
| 空路径/非法索引/API 缺失 | 边界 | 无操作、不抛错、不发 IPC                      |
| 生成失败                 | 异常 | 保持占位、记录失败、无无限重试                |
| 定向失效一个新路径       | 正常 | 该路径否定缓存被删除，重新走安全判断          |
| 定向失效后访问无关路径   | 边界 | 无关路径缓存继续命中，不重复 DB 查询/realpath |
| 缺省调用失效函数         | 兼容 | 仍全清，保持媒体整体更新语义                  |
| 非缓存目录未知路径       | 安全 | 仍被拒绝且否定结果可缓存                      |

## 逐节点 TDD 队列

### 节点 0：计划落盘与既有基线

- 目标文件：`docs/plans/2026-10-09-fix-thumbnail-loading-performance.md`。
- 输入/输出：输入为确认后的本计划；输出为仓库内可审查的 Markdown 计划和基线日志。
- 执行：写入本文件，运行与计划文件适用的格式检查；执行现有 `test:main`、`test:renderer`、构建和 `e2e:perf` 基线，记录现状，不改业务代码。
- 验收：计划文件存在且完整；基线命令真实执行；失败项如实记录并区分既有失败与后续回归。

### 节点 1：测量并定性 H1–H6

- 目标文件：优先复用 `e2e/perf.e2e.ts` 与现有性能脚本；只有现有指标不能观测缩略图行为时才最小追加测试/埋点。
- 输入/输出：输入为固定规模测试库和各视图操作；输出为 H1–H6 的证实/证伪表、P50/P95、IPC/回退/失效次数。
- Red：新增的行为/计数测试必须先因当前瓶颈失败，且不是编译或导入错误。
- Green：此节点只负责测量；修复后的指标在对应后续节点转绿。
- 验收：每个假设都有证据；未证实项明确标为“不实施”。

### 节点 2：缺图不再直载原图，并共享按需生成

- 目标文件：`src/renderer/utils/thumbnail-src.ts`、`src/renderer/utils/thumbnail-src.test.tsx`、`src/renderer/hooks/useOnDemandThumbnails.ts`、`src/renderer/hooks/useOnDemandThumbnails.test.tsx`、`src/renderer/components/gallery/VirtualImageGrid.tsx`、`ListView.tsx`、`TimelineView.tsx`、`EventTimelineView.tsx`、`MasonryView.tsx`、`src/renderer/pages/RecycleBinPage.tsx`；`OutfitGalleryPage.tsx`/`DuplicatesPage.tsx` 仅在测量证实时修改。
- 输入/输出：输入 `files` 与可视索引范围；输出生成结果 revision、稳定的 `ensureVisible(startIndex,endIndex,immediate?)`，以及解析后的缩略图 URL 或 `null`。
- Red：先追加“图片缺缩略图返回 `null`”“同路径重复可视仅调用一次”“失败不无限重试”等行为测试，并逐条运行确认失败。
- Fix：从 Grid 提取最小共享逻辑；各虚拟视图只对可见/overscan 范围触发；复用 `ThumbReveal` 和占位组件。
- Green：逐条重跑同一测试，再跑所有相关 renderer 测试。
- 验收：原图回退次数为 0；同一路径重复触发 IPC 次数为 1；视频永不回退原视频；`npm run test:renderer` 无新增失败。

### 节点 3：定向缓存失效

- 目标文件：`src/main/ipc/handler-context.ts`、`src/main/ipc/handlers/thumbnail-handler.ts`、`src/main/app/media-protocol.ts`、`src/main/ipc/handlers/__tests__/thumbnail-handler.test.ts` 或现有同类测试、`src/main/app/__tests__/media-protocol.test.ts`。
- 输入/输出：`invalidateMediaPathCache(paths?: string[]) -> void`；`undefined` 为全清，数组为定向删除。
- Red：先写“定向失效后无关路径仍命中”“目标否定缓存重新验证”“handler 回写只传目标路径”的测试并确认失败。
- Fix：实现定向删除；handler 回写传入生成结果路径；保留一般媒体更新的无参全清。受保护 handler 顶部写唯一真实 `@core-change` 原因。
- Green：重跑同一测试、主进程相关测试和 core gate。
- 验收：目标路径安全语义正确；无关缓存不清空；全清兼容测试保持通过；`npm run test:main` 无新增失败。

### 节点 4：条件性请求优化

- 目标文件：仅根据节点 1 证据选择 `useOnDemandThumbnails.ts`、`VirtualImageGrid.tsx`、`src/main/preload/api/thumbnail.ts`、`thumbnail-handler.ts`、`docs/IPC_CONTRACT.md`、对应测试。
- 输入/输出：可能为首次范围立即调度，或受限批量请求/响应。
- Red：只有 H3/H4 实测超过阈值时才添加对应 fail-first 测试。
- Fix：首选首次立即、滚动防抖或现有 Promise Map 去重等最小方案；批量 IPC 为最后选择。
- Green：确定性门禁与打包态耗时均达标。
- 验收：未证实则零代码改动并记录结论；若实施，新旧 IPC 兼容且文档、校验、核心路径授权齐全。

### 节点 5：剩余板块一致性

- 目标文件：`src/renderer/pages/DuplicatesPage.tsx`、`RecycleBinPage.tsx`、`OutfitGalleryPage.tsx` 及相关测试，仅修改测量证实存在问题的板块。
- 输入/输出：各板块的可见媒体集合；输出统一的占位→按需生成→缩略图淡入行为。
- Red/Fix/Green：每个板块单独完成一个行为闭环后再进入下一个。
- 验收：动态缩略图板块无原图回退/裂视频；静态资源板块和无图片板块不受影响；相关测试全部通过。

### 节点 6：全局验证与终止条件

- 目标文件：不新增业务修改；若验证发现由本次改动引入的问题，只精准修复对应计划内文件并重跑失败门禁。
- 输入/输出：完整工作区；输出为全量校验和性能对比结果。
- 命令：`npm run verify`、`npm test`、`npm run lint`、`npm run typecheck`、`npm run audit`、构建/打包、`npm run e2e:smoke`、`npm run e2e:perf`、`git diff --numstat`。
- 验收：所有命令通过；性能指标不劣化，证实瓶颈的指标达到计划阈值；diff 仅包含计划内文件。任一门禁失败则任务不得标记完成。

## 改动边界

- 不改缩略图尺寸/质量常量、worker 协议、ffmpeg 超时、损坏文件处理、白帧自愈、LRU 上限或批量 worker 并发，除非测量直接证实且先更新计划。
- 不改分类页和使用静态打包缩略图的共鸣记录页。
- 不进行无关重构、全仓格式化、依赖升级或文案调整。
- `worker-entry.ts` 不得被主进程模块导入。

## 修改前基线与诊断结论（2026-10-09）

### 环境与自动化基线

- Node.js `v26.3.0`、npm `11.16.0`；`npm run doctor` 5/5 通过。
- `npm run test:renderer`：154 个文件、1867 个用例全部通过。
- `npm run test:main`：167 个文件、3192 个用例通过；`src/main/media-worker/worker-entry.test.ts` 的“processed 增量满 10”用例在全量并行时失败 1 次，隔离复跑通过，判定为修改前已存在的并行时序波动；最终全量门禁必须再次通过。
- `npm run build`、`npm run dist:win` 与解包原生二进制校验通过。
- 修改前 `npm run e2e:perf`：8/8 通过；冷启动 1766ms，扫描 588ms（2549.4 文件/秒），100 条列表 16ms，500 条列表 10ms，重复检测 1072ms（1399.3 文件/秒），缓存统计 0ms。

### H1-H6 结论

| 编号 | 结论                           | 证据与处置                                                                                                                                                                                                                                                             |
| ---- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1   | **证实，主瓶颈**               | 代码确认五类旧视图和套装/重复文件图片会在缩略图缺失时加载原图。隔离 sharp 基准使用 6000×4000、19.78MB JPEG：原图解码 P50 134.18ms/P95 137.12ms；320px、5KB 缩略图 P50 1.48ms/P95 2.17ms，P50 放大约 90.9 倍。实施“占位 + 可视区按需生成”，并移除生成失败后的原图回退。 |
| H2   | **证实，主放大器**             | 每个 standard 回写成功均调用无参 `invalidateMediaPathCache()`，一次清空路径、source-path、realpath 三个缓存；而生成缓存目录本身已在白名单首分支直接允许。实施目标路径定向失效，保留一般媒体更新的无参全清。                                                            |
| H3   | **部分成立，但不实施批量 IPC** | 可视区确有 N 个并发单项 IPC，但 `ThumbnailGenerator.generatingLocks` 与渲染层 Promise Map 已按路径去重；修改前打包态总体门禁无 IPC 回归证据。先共享去重逻辑并消除 H2，不新增批量通道与依赖。                                                                           |
| H4   | **证实固定首屏延迟**           | Grid 首次 `rangeChanged` 与滚动共用 300ms 定时器，缺图首屏必然至少晚 300ms 才发起生成。共享 Hook 首次可视范围立即执行，后续快速滚动仍复用防抖。                                                                                                                        |
| H5   | **存在但非本次主因，不改**     | `media:updated` 会刷新数组并清失败态，但已有 2 秒节流，且当前性能基线未显示列表查询瓶颈；修改 store/广播风险高于收益。                                                                                                                                                 |
| H6   | **固有成本，不改生成器**       | 视频并发 2、seek 重试和 30 秒超时是稳定性保护；没有证据表明可视项饥饿来自生成器调度。保留现状，仅让所有视图按可见范围触发并共享去重。                                                                                                                                  |

## 实施结果与验证记录（2026-10-09）

### 已完成优化

- 图库网格、列表、时间线、事件时间线、瀑布流、回收站、套装画廊、重复文件统一复用 `useOnDemandThumbnails`；同一路径并发请求合并为 1 次，成功/失败结果跨视图复用。
- 所有动态缩略图视图在缺图或生成失败时保持占位，不再加载原图片/原视频；`ThumbReveal` 的骨架、异步解码和淡入行为保持不变。
- 网格首个非空可视范围立即发起生成，后续滚动仍保留 300ms 防抖；已有缩略图 404 时通过 `force` 路径保留就地重建与 `&r=N` 强制重载。
- `thumbnail:generate` 回写数据库后仅定向失效生成结果路径；一般媒体更新继续无参全清，协议白名单安全语义不变。
- 未新增或升级依赖，未新增批量 IPC，未修改生成器、worker 协议、缩略图尺寸、视频超时或白帧自愈。

### TDD 与质量门禁

- 新增/调整的每个行为均实际执行 Red → Fix → Green；直接相关回归最终为 12 个文件、129 个用例全部通过。
- `npm run verify`：typecheck、lint、core-gate、format、相关测试 5 项全部通过。
- `npm test`：331 个文件、5236 个用例全部通过（现 334 个文件 / 5269 个用例，2026-10-10 全量 `npm test` 实测全绿）。
- `npm run typecheck`：源码与脚本工具链全部通过。
- `npm run lint`：0 error；11 个 BOM warning 为未改动文件的既有告警。
- Windows 构建/打包、`verify:dist` 通过；`npm run e2e:smoke` 9/9 通过。

### 修改后性能回归

- `npm run e2e:perf`：8/8 通过，无硬阈值超限或基线回归。
- 冷启动 1766ms → 1377ms；100 条列表 16ms → 11ms；500 条列表 10ms → 8ms。
- 扫描 588ms → 611ms；重复检测 1072ms → 1323ms，均在既有噪声容忍与门禁内；本次未修改对应链路。
- 确定性门禁：原图回退次数为 0；同路径并发生成调用次数为 1；定向失效后无关路径继续命中缓存；首个可视范围无 300ms 固定等待。

### 未通过的终止门禁

- 安全审计尚未通过，因此本任务**不得标记完成**：`registry.npmjs.org` 在当前环境被异常解析到自签名 `redirect-cnzz` 证书；切换同一 npm 官方服务的 `registry.npmjs.com` 后成功取得审计结果，但发现 10 个未在现有 allowlist 中的 high/critical 公告：`GHSA-5gmw-xhrv-c9v3`、`GHSA-68fv-2mgg-jv7q`、`GHSA-85c8-ppgw-ccpr`、`GHSA-9qh4-3jw8-366w`、`GHSA-ch52-4w7c-c8xp`、`GHSA-gr2m-v5gq-v685`、`GHSA-hq2x-r82h-9wj4`、`GHSA-j84w-jfhq-vhvj`、`GHSA-vfj7-8cjw-p6xm`、`GHSA-wq5f-xc86-pv6w`。
- 漏洞来自任务开始前已锁定的 Electron、Sharp、Vitest/tinypool、Babel/chokidar/braces 等依赖；本任务未改 `package.json` 或 `package-lock.json`。为遵守最小改动与禁止弱化门禁，未擅自升级大版本、写入新 allowlist 或关闭 TLS 校验。

## 用户确认的安全依赖范围扩展（2026-10-09）

用户已选择扩展修复依赖，不以新增 allowlist、关闭 TLS、跳过审计或弱化阈值消音。

### S1：正式修复版本升级

- `electron 40.10.6 → 41.10.6`，并同步 Node engine 下限到 `>=22.12.0`。
- `sharp 0.35.4 → >=0.35.5`。
- `vitest` / `@vitest/coverage-v8 1.6.1 → 5.0.3`，`vite 5.4.21 → 6.4.2`。
- npm `overrides`：`source-map-js=1.2.2`、`http-cache-semantics=4.3.0`。
- 安装使用 `npm install --registry=https://registry.npmjs.com`，更新 `package.json` 与 `package-lock.json`，每组变更后立即执行针对性测试/构建。

### S2：braces 无修复版本的处理

- 截至 2026-10-09，`braces@3.0.3` 是最新正式版，公告影响 `<=3.0.3`。
- S1 后重新执行 `npm explain braces`，只处理实际残留父链；优先成熟上游升级或替代，不自造 glob 实现。
- 若无正式修复或成熟替代，保持安全门禁阻断，不通过新增豁免伪造成功。

### S3：扩展后的终止门禁

- `npm run verify`、`npm test`、`npm run lint`、`npm run typecheck` 全部通过。
- `npx audit-ci --config ./audit-ci.jsonc --registry https://registry.npmjs.com` 无未豁免 high/critical。
- Windows 打包、`verify:dist`、`e2e:smoke`、`e2e:perf` 全部通过；任一失败则保持未完成。
