# 修复缩略图"白屏→模糊→清晰"渐进加载（7 节点 TDD）

- 状态：已实施（2026-09-30，7 节点全部红→绿闭环通过；全量回归 302 文件 / 4974 用例全绿（N0 基线 857 相关子集全绿，无新增失败），typecheck / lint / prettier --check 通过，`dist:win` 退出码 0 + `e2e:smoke` 9/9 通过（含 fullscreen-diagnose 缩略图点击诊断）。零依赖变更、`git diff --numstat` 确认仅计划内文件变更）
- 创建日期：2026-09-30
- 用户已确认决策：① 拦截方式 = 每卡片骨架屏（不做全页遮罩）；② 范围 = 全部缩略图视图统一接入；③ 性能侧 = 视频抽帧独立限流 + 后台批量让位 两项都做。
- 关联前篇：[2026-09-30-fix-thumbnail-persist-and-ondemand.md](./2026-09-30-fix-thumbnail-persist-and-ondemand.md)（批次二，已实施）、[2026-09-30-fix-thumbnail-display-and-latency.md](./2026-09-30-fix-thumbnail-display-and-latency.md)（批次一，已实施）

## 1. 根因分析（已逐行读码核实）

| #   | 根因                                                                                                                                                                           | 证据位置                                                                      | 症状                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------ |
| R1  | 网格卡片先显示 64px 低清图拉伸垫底（`object-cover` 放大像素模糊），滚动停止 300ms 后才升级 320px standard 交叉淡入——**即使 standard 已在磁盘也要先模糊一阵**（即"模糊"中间态） | `TieredCardImage.tsx:64-93`、`VirtualImageGrid.tsx:501-514,327-352`           | 全部缩略图先模糊后清晰   |
| R2  | 路由懒加载 Suspense 兜底页硬编码纯白 `#fff`，暗色主题下路由切换白屏闪烁（即"白屏"之一）                                                                                        | `App.tsx:55-73`                                                               | 路由切换白屏             |
| R3  | 缩略图未生成（DB NULL 或 standard 未落盘）时卡片只有灰底 + 静态图标干等，无任何加载动画（即"白屏"之二）                                                                        | `VirtualImageGrid.tsx:564-599`                                                | 灰卡图标数秒到数十秒     |
| R4  | 主进程视频 ffmpeg 抽帧与图片 sharp 解码**共用 `decodeLimiter`**；慢视频走 0/1/3s seek 阶梯（每次 30s 超时）最长占用解码通道 90s，把可视区按需生成的图片全部堵在队列后          | `src/main/thumbnail/generator.ts:77,485,509`                                  | 数十秒白屏（最恶性排队） |
| R5  | 后台批量（media-worker `runWithConcurrency` 并发 4）与可视区按需生成争抢 CPU，不让位                                                                                           | `src/main/media-worker/worker-entry.ts:628`、`src/main/utils/constants.ts:18` | 浏览期间生成被稀释       |

**已核实、方案成立的关键事实**：

- 批量任务忽略 `_quality` 参数、**总是产出 standard 320px** 并同步产出 `_low`（`worker-entry.ts:405-414,466`）——磁盘上清晰图会由批量任务铺满，去掉模糊档显示后骨架等待有界。
- 全仓无 IntersectionObserver；懒加载 = react-virtuoso 视口挂载 + 原生 `loading="lazy"`。
- 可复用资产：`globals.css` `.skeleton` 渐变动画（`globals.css:1044-1057`）、`useFailedImages`、`resolveThumbnailSrc`、`Skeleton` 组件族、`ensureOnDemandThumbnail` 单次守卫 + 重建成功 `clearFailed` 重试机制（commit 0cbb2c9）。

## 2. 依赖声明

**零依赖变更**：不新增/不升级/不移除任何 npm 依赖，不改 `package.json`。复用仓库既有能力：`.skeleton` CSS 动画类、React 19 内置、vitest + @testing-library（jsdom）既有测试栈、`tests/setup.ts` 的 `window.electronAPI` 占位注入。

环境准备：确认 `node_modules` 存在（缺失则 `npm install` 增量安装，禁止 `npm ci`）。

## 3. 启动与验证说明

- 节点级（红→绿闭环）：`npx vitest run <对应测试文件>`
- 全局回归：`npm test`（对照 N0 基线无新增失败）、`npm run typecheck`、`npm run lint`、改动文件 `npx prettier --check`、`npm run dist:win` → `npm run e2e:smoke`
- 手验（dev）：`npm run dev` → ① 首次进入图库：只见"骨架屏 → 清晰缩略图直显"，全程无模糊图、无白屏；② 暗色主题切换路由：无纯白闪烁；③ 批量扫描进行中进入图库：可视区图片优先就绪（批量让位生效）；④ 重复文件页/列表/瀑布流/时间线/回收站/套装封面：同样无模糊中间态。

## 4. 错误处理

- `ThumbReveal`：onError 透传父级，骨架层不吞错误；src 为空串时不渲染 img（错误态由父级 `MediaThumbPlaceholder` 负责，加载态≠错误态）。
- 网格 standard 失败新链：保持骨架 + `ensureOnDemandThumbnail` 就地重建 → 重建成功 `clearFailed` 原 URL 立即重试（既有机制）→ 重建失败（onDemandFailed）才 `markFailed` 警告占位。
- N2 让位命令发送失败仅 `logger.warn` 中文日志，不中断批量任务；worker 未启动时发送为 no-op。
- N1 视频限流分离不改变失败标记 / 损坏容错 / 纯白自愈行为，只改排队通道。

## 5. 参数校验

- `ThumbReveal src: string`：空串不渲染 img；`className` 缺省 `'absolute inset-0 w-full h-full object-cover'`。
- `VIDEO_DECODE_CONCURRENCY = Math.max(1, Math.min(2, os.cpus().length))`：下限 1，上限 2（ffmpeg 单进程内存开销高，保持保守）。
- 批量让位延迟常量钳制 50~1000ms（取 200ms）；`set-batch-yield` 命令 `active: boolean` 必填。

## 6. 节点详情（文件 / 输入输出 / 先红后绿 / 验收标准）

### N0 落盘计划与基线

- 写入本文档；跑基线 `npx vitest run src/renderer/components/gallery src/renderer/components/common src/main/thumbnail src/main/media-worker` + `npm run typecheck`。
- 基线结果：53 文件 / 857 用例全绿。
- 验收：本文档入库、基线已记录。

### N1 视频抽帧独立限流器（R4）

- 修改 `src/main/thumbnail/generator.ts`：新增 `videoLimiter`，替换 485（自愈）与 509（抽帧）两处 `decodeLimiter`；图片解码路径不动。
- 测试 `src/main/thumbnail/generator.test.ts` 新增用例：mock `os.cpus()` 使 `DECODE_CONCURRENCY=2`（vi.resetModules + vi.mock('os')），1 个慢视频（抽帧 mock 为受控 deferred）+ 2 张图片并发 `generate()`，断言**两张图片都在视频完成前返回**（共享 limiter 时第 2 张图片必被视频堵住 → 红；分离后 → 绿）。
- 输入：`generate(filePath, quality?)` 不变；输出不变；只改内部排队通道。
- 验收：红灯记录后 `npx vitest run src/main/thumbnail/generator.test.ts` 全绿。

### N2 可视区按需生成期间批量让位（R5）

- 修改 `src/main/thumbnail/generator.ts`：公开入口 `generate()` 维护 `onDemandPending` 计数（进入 +1 / settle -1），新增 `setOnDemandActivityListener(cb: (active: boolean) => void)`。
- 修改 media-worker 命令协议与 `manager.ts`：监听回调 → 发送 `{ type: 'set-batch-yield', active }`（形态对齐现有 WorkerCommand；发送失败仅日志）。
- 修改 `src/main/media-worker/worker-entry.ts`：批量循环在任务间检查 yield 标志，active 时 `setTimeout(200ms)` 再取下一任务。
- 测试 `src/main/media-worker/worker-entry.test.ts` 新增用例（fake timers）：yield 激活时两个任务之间等待延迟；未激活时不等待。
- 输入：主进程 `generate()` 调用（天然只覆盖按需 + 自愈，批量在 worker 进程内不经过该入口）；输出：worker 收到命令后批量吞吐自动降速/恢复。
- 验收：`npx vitest run src/main/media-worker src/main/thumbnail` 全绿，先红后绿有记录。

### N3 共享骨架门控图组件 ThumbReveal（R3 基建）

- 新增 `src/renderer/components/common/ThumbReveal.tsx`：props `{ src, alt, onError, className?, dataMediaId? }`；未 onLoad 前渲染 img（`opacity-0`）+ `<div class="skeleton">` 骨架层（复用 `.skeleton` 动画）；onLoad 后骨架卸载、img `transition-opacity duration-200` 淡入；src 变化重置；保留 `loading="lazy" decoding="async" draggable={false}`。
- 新增 `src/renderer/components/common/ThumbReveal.test.tsx`（先红：组件不存在）：① 未加载态骨架可见 + img opacity-0；② fireEvent.load 后骨架卸载 + img opacity-100；③ src 变化重置为未加载；④ onError 透传。
- 验收：`npx vitest run src/renderer/components/common/ThumbReveal.test.tsx` 全绿。

### N4 图库网格接入：删除模糊档位机（R1 核心）

- 修改 `src/renderer/components/gallery/VirtualImageGrid.tsx`；删除 `TieredCardImage.tsx`；更新 `VirtualImageGrid.thumb.test.tsx`。
- 改动：删除 low 垫底 / 交叉淡入 / `pickThumbnailUrl` / `showingLow` / `setHighQualityIds` 升级链；卡片唯一显示源 = `resolveEffectiveThumbnail` → standard URL → `ThumbReveal`；`triggerHighQualityUpgrade` 只保留"滚动停止 300ms 触发 `ensureOnDemandThumbnail`"；onError 新链见第 4 节。无 URL / 失败 / 损坏仍走 `MediaThumbPlaceholder`。`toLowQualityUrl` 导出保留（DetailPage / Duplicates fallback 仍在用），仅删网格内显示用途。
- 红灯：现有测试中断言 TieredCardImage / 档位机结构的用例失败 + 新增结构断言（源码不含 `pickThumbnailUrl` / `TieredCardImage`，含 `ThumbReveal`）失败。
- 验收：`npx vitest run src/renderer/components/gallery` 全绿。

### N5 其余缩略图视图统一接入（R1 全视图消灭）

- `MediaThumbnail.tsx`：img 段加骨架门控（opacity 门控 + `.skeleton` 层，src/usedFallback 变化重置），`fallbackSrc` 失败回退链**保留**（仅失败终态可见，非常态路径）；`MediaThumbnail.test.tsx` 增用例。
- 六个裸 img 视图换 `ThumbReveal`：`ListView.tsx`、`MasonryView.tsx`、`TimelineView.tsx`、`EventTimelineView.tsx`、`RecycleBinPage.tsx`、`OutfitGalleryPage.tsx`（每处 3-5 行，badge/占位/回退逻辑不动）；既有测试文件（`ListView.thumb.test.tsx`、`RecycleBinPage.thumb.test.tsx`、`OutfitGalleryPage.cover.test.tsx`、`DuplicatesPage.videoThumb.test.tsx` 等）各增"onLoad 前骨架可见、onLoad 后骨架卸载"用例；无既有测试的视图（MasonryView / 双 Timeline）新建轻量 `*.thumb.test.tsx`（模式参照 `ListView.thumb.test.tsx`）。
- 红灯：新增用例在现实现（img 直出无门控）下必红。
- 验收：`npx vitest run src/renderer` 全绿。

### N6 PageFallback 主题化（R2）

- 修改 `src/renderer/App.tsx`：`background: '#fff'` → `var(--bg-primary)`；spinner 边框色改用主题变量（以 globals.css 实际存在的变量为准）。
- 新增 `src/renderer/App.theme.test.tsx`（fs 读源码结构断言，零渲染依赖）：不含 `'#fff'`、含 `var(--bg-primary)`。先红（`'#fff'` 当前存在）后绿。
- 验收：`npx vitest run src/renderer/App.theme.test.tsx` 全绿。

### N7 全局校验（一票否决）

1. `npm test`（对照 N0 基线无新增失败）；2. `npm run typecheck`；3. `npm run lint`；4. 改动文件 `npx prettier --check`；5. `git diff --numstat` 确认仅计划内文件；6. `npm run dist:win` + `npm run e2e:smoke` 全绿。完成后回填本文档状态行。

## 7. 基础测试用例矩阵

| 节点 | 正常流程                                       | 异常场景                                       | 边界条件                                        |
| ---- | ---------------------------------------------- | ---------------------------------------------- | ----------------------------------------------- |
| N1   | 图片/视频并发生成互不堵塞，各自返回路径        | 视频抽帧失败 → 既有损坏标记行为不变            | cpus=1 时 videoLimiter=1；缓存命中路径不排队    |
| N2   | 按需生成期间批量任务间插入延迟，结束后恢复全速 | 命令发送失败仅日志、批量不中断                 | active 快速翻转去抖；worker 未启动为 no-op      |
| N3   | onLoad 后骨架卸载、img 200ms 淡入              | onError 透传；空 src 不渲染 img                | src 快速切换重置为未加载；复用卡片不残留旧态    |
| N4   | standard URL 直接进 ThumbReveal，无模糊中间态  | standard 失败 → 骨架 + 就地重建 → 重建失败占位 | 游戏原生缩略图（lowUrl=null）行为一致；损坏跳过 |
| N5   | 各视图加载完成前骨架、完成后直显               | onError 回退链（markFailed / fallbackSrc）不变 | 缺省 badge/占位/选中态背景不变                  |
| N6   | 暗色主题路由切换无白底                         | —                                              | 主题变量缺省回退可读                            |

## 8. 明确不做（范围外）

- 全页 Loading 遮罩（用户已确认采用每卡片骨架屏）。
- DetailPage `ZoomableImage` / FullscreenViewer 的原图渐进加载（属大图查看体验，现状良好，不在缩略图范围）。
- pHash / 扫描流水线 / media:// ETag 缓存策略（前序计划已处理）。
- 首次生成的固有耗时（视频最坏 90s 阶梯超时）不消除——N1/N2 缓解排队放大，骨架屏负责等待期的视觉兜底。
- `onDemandThumbPromises` 模块级 Map 治理（既有会话级缓存语义）。
