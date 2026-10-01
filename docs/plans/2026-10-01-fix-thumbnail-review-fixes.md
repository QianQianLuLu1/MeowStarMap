# 缩略图未提交改动审查修复（TDD 红-绿闭环）

- 状态：已实施（2026-10-01，T0–T7 全部红→绿闭环通过；全局回归见第 7 节）
- 创建日期：2026-10-01
- 关联前篇：[2026-09-30-fix-thumbnail-skeleton-reveal.md](../archive/plans/2026-09-30-fix-thumbnail-skeleton-reveal.md)（本批次未提交改动的原计划）
- 背景：对该批次未提交改动做全面代码审查（主进程 / 渲染进程 / 版本与构建三通道并行 + 逐行复核），发现 1 个 P1 缺陷与若干 P2 问题。本计划按「最小化改动 / 优先复用 / TDD 红-绿 / 分步验证」原则修复。

## 0. 审查结论摘要

| 编号 | 级别 | 位置                              | 问题                                                                                                                                              | 处置          |
| ---- | ---- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| T1   | P1   | `VirtualImageGrid.tsx` onError 链 | DB 缩略图 404 + 就地重建失败（或重建成功但重载仍 404）时无第二次 onError，`markFailed` 永不执行，卡片永久卡骨架屏（改动前为警告占位图标，属回归） | 修复（红→绿） |
| T2   | P2   | `ThumbReveal.tsx`                 | 换源重置经 useEffect（绘制后执行），旧图闪现一帧；旧 src 迟到 onLoad 在新元素上触发导致提前撤骨架                                                 | 修复（红→绿） |
| T3   | P2   | `MediaThumbnail.tsx`              | 与 T2 同根（activeSrc/usedFallback 的 effect 重置）                                                                                               | 修复（红→绿） |
| T4   | P2   | `OutfitGalleryPage.tsx:55`        | `coverFailed` 置位后不复位，重扫描换封面后卡片停留图标态                                                                                          | 修复（红→绿） |
| T5   | P2   | `RecycleBinPage.tsx:498`          | `thumbFailed` 置位后不复位，同 id 条目数据刷新后失败态粘滞                                                                                        | 修复（红→绿） |
| T6   | P2   | 主进程 4 处注释                   | 注释与实现不符（详见 T6）                                                                                                                         | 修正          |
| T7   | P2   | 两个新测试文件                    | yield 标志状态残留、注释与串行 mock 矛盾、断言与实现细节耦合未注明                                                                                | 修正          |

## 1. 依赖声明

零新增 / 零升级 / 零移除依赖，不改动 `package.json`。复用仓库既有能力：vitest + @testing-library（jsdom）、`tests/setup.ts` 的 `window.electronAPI` 占位注入、`globals.css` 的 `.skeleton` 动画类、`useFailedImages`（items 变化自动清空 + mark/clear 稳定引用）、`MediaThumbPlaceholder`、React 官方「渲染期调整 state」模式。

## 2. 启动与运行说明

- 环境准备：`node_modules` 已存在（无需安装）。
- 节点级验证（每个 T 节点红→绿后立即执行）：`npx vitest run <对应测试文件>`。
- 全局回归（全部节点完成后）：`npm test`（对照基线 302 文件 / 4974 用例，不允许新增失败）、`npm run typecheck`、`npm run lint`、改动文件 `npx prettier --check`。
- 安全检查：执行时确认 `package.json` scripts 中真实存在的脚本（如 audit-ci 相关）后运行；若仓库无此脚本，则以 lint + typecheck 覆盖并在总结中如实说明（不虚构命令）。
- 手验（可选，dev）：`npm run dev` → 图库网格中对缩略图被 LRU 驱逐的卡片确认失败终态为警告图标而非永久骨架。

## 3. 错误处理

- 错误链终点统一落到既有 `MediaThumbPlaceholder` 警告占位（`hasError=true → showThumb=false`），不新增错误态、不加新 IPC、不改 worker 协议。
- `markFailed` / `clearFailed` 复用 `useFailedImages` 既有语义；items 变化时自动清空，失败集合不无限增长。
- T2/T3 的渲染期重置为 React 官方支持的「adjusting state during render」模式：仅在 `prev !== current` 分支内 setState，无副作用、无额外渲染回路。
- 所有修复不改变既有成功路径行为（正常加载、缓存命中、fallback 回退链均不动）。

## 4. 参数校验

- `standardRebuildTried: Set<string>`：按 `file.id` 记录，仅在 img onError 回调内写入（id 必为非空字符串，无需额外校验）。
- `ensureOnDemandThumbnail(file, onRebuildFailMarkId?)`：第二参数可选；缺省（`undefined`）时行为与现状完全一致——`scheduleOnDemandGeneration` 既有调用点不传该参数。
- T2/T3 `key={src}` / `key={activeSrc}`：src 为受控字符串 prop；空串时组件不渲染 img（既有守卫保留，key 不生效于 null 分支）。
- T4/T5 复位依赖：`cover` / `thumbUrl` 均为派生值（`resolveOutfitCoverSrc(stat)` / `resolveThumbnailSrc(file)`），恒为 string | null，作 useEffect 依赖安全。

## 5. 子任务详情（三要素 + TDD）

### T0 计划文档落盘

- **涉及文件**：`docs/plans/2026-10-01-fix-thumbnail-review-fixes.md`（本文档）。
- **输入/输出**：无代码变更；产出本计划。
- **验收标准**：文档存在且包含本节全部小节（依赖声明/启动运行/错误处理/参数校验/测试矩阵）。

### T1 VirtualImageGrid 错误链终点缺口（P1）

- **涉及文件**：`src/renderer/components/gallery/VirtualImageGrid.tsx`、`src/renderer/components/gallery/VirtualImageGrid.thumb.test.tsx`。
- **输入/输出**：输入为既有 props 与 `window.electronAPI.thumbnail.generate` IPC mock；输出为组件失败终态渲染（警告占位图标）。新增组件内状态 `standardRebuildTried: Set<string>`（file.id），`ensureOnDemandThumbnail` 增加可选第二参数 `onRebuildFailMarkId?: string`。
- **红灯**（先写测试，运行确认失败）：
  - 用例①：卡片 thumbnail 非空 → 触发 img onError → generate mock 返回 null → 断言出现占位警告图标（现实现：停留骨架 → 红）。
  - 用例②：同上但 generate mock 返回有效路径（重建"成功"）→ 再次触发 onError → 断言占位警告图标（现实现：Map 命中无动作 → 红）。
- **绿灯**：onError 改为 `generateFailed || standardRebuildTried.has(file.id)` → `markFailed(file.id)` 终止；否则记入集合并触发 `ensureOnDemandThumbnail(file, file.id)`；`applyResult` 收到 null 且 `onRebuildFailMarkId` 存在时直接 `markFailed`（覆盖"重建失败后无第二次 onError"）。
- **验收标准**：`npx vitest run src/renderer/components/gallery/VirtualImageGrid.thumb.test.tsx` 全绿；红灯输出已记录于第 7 节。

### T2 ThumbReveal 换源一帧闪现 + 迟到 onLoad 竞态

- **涉及文件**：`src/renderer/components/common/ThumbReveal.tsx`、`src/renderer/components/common/ThumbReveal.test.tsx`。
- **输入/输出**：props 不变；行为输出：src 切换后旧 img 节点的迟到 load 事件不得撤掉新源骨架。
- **红灯**：新增用例——src=A onLoad 后 rerender 为 src=B，在切换前捕获的旧 img 节点上 `fireEvent.load` → 断言骨架仍可见且 img 仍 opacity-0（现实现：loaded 保持 true → 红）。
- **绿灯**：换源重置改渲染期（`prevSrc` 模式）+ img 加 `key={src}`（旧节点卸载，迟到事件失效）；缓存命中 complete 自检 effect 保留。
- **验收标准**：`npx vitest run src/renderer/components/common/ThumbReveal.test.tsx` 全绿。

### T3 MediaThumbnail 同类竞态

- **涉及文件**：`src/renderer/components/common/MediaThumbnail.tsx`、`src/renderer/components/common/MediaThumbnail.test.tsx`。
- **输入/输出**：props 不变；`fallbackSrc` 回退链行为保持不变。
- **红灯**：新增用例——src=A onLoad 后 rerender 为 src=B，旧 img 节点迟到 `fireEvent.load` → 断言骨架仍可见（现实现 → 红）。
- **绿灯**：src / activeSrc / usedFallback 渲染期复位 + img `key={activeSrc}`。
- **验收标准**：`npx vitest run src/renderer/components/common/MediaThumbnail.test.tsx` 全绿。

### T4 OutfitGalleryPage `coverFailed` 失败态粘滞

- **涉及文件**：`src/renderer/pages/OutfitGalleryPage.tsx`、`src/renderer/pages/OutfitGalleryPage.cover.test.tsx`。
- **输入/输出**：输入为 `OutfitStat`（重渲染时更换封面路径）；输出为失败后新封面可恢复显示。渲染方式优先复用仓库既有页面测试的 store / 桥 mock 模式；若 mock 成本过高，则对卡片组件加测试专用导出（最小改动）后单测——执行时定，选择记录于此节。
- **红灯**：触发封面 onError 后，以新 cover 重渲染同一卡片 → 断言恢复 ThumbReveal 分支（现实现：永久图标态 → 红）。
- **绿灯**：`useEffect(() => setCoverFailed(false), [cover])`。
- **验收标准**：`npx vitest run src/renderer/pages/OutfitGalleryPage.cover.test.tsx` 全绿。

### T5 RecycleBinPage `thumbFailed` 失败态粘滞

- **涉及文件**：`src/renderer/pages/RecycleBinPage.tsx`、`src/renderer/pages/RecycleBinPage.thumb.test.tsx`。
- **红灯**：同 T4 模式（同 id 条目 thumbUrl 变化重渲染 → 断言恢复 ThumbReveal 分支）。
- **绿灯**：`useEffect(() => setThumbFailed(false), [thumbUrl])`。
- **验收标准**：`npx vitest run src/renderer/pages/RecycleBinPage.thumb.test.tsx` 全绿。

### T6 主进程失实注释修正（无行为变化，TDD 不适用）

- **涉及文件**：`src/main/thumbnail/generator.ts`（:355 GamePlayPhotos 路径实际会计数；:560-561 删除"与 runSharp 共用同一信号量"残留旧注释）、`src/main/media-worker/worker-entry.ts`（:556 让位等待期间取消最多延迟 200ms 生效、不会丢失）、`src/main/media-worker/bridge.ts`（:555 补发实为 bridge 自身 `startThumbnailBatch` 末尾）。
- **输入/输出**：仅注释文本，无任何行为变更。
- **验收标准**：`npm run typecheck`、`npm run lint` 通过；grep 确认旧表述已清除。

### T7 测试卫生（仅测试文件）

- **涉及文件**：`src/main/media-worker/worker-entry.test.ts`（批量让位用例 try/finally 复位 `active:false`，防失败时标志残留拖慢后续用例；修正与 runWithConcurrency 串行 mock 矛盾的注释）、`src/main/thumbnail/generator.limiter.test.ts`（`videoRunCount===2` 断言补注释：同时固定 videoLimiter 并发=2 的实现细节耦合）。
- **输入/输出**：测试内部结构，不改断言语义。
- **验收标准**：两个测试文件 `npx vitest run` 全绿。

## 6. 基础测试用例矩阵

| 节点  | 正常路径                                               | 异常路径                                                       | 边界条件                                                                                 |
| ----- | ------------------------------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| T1    | standard 加载成功不受影响；重建成功 + 重载成功正常显示 | 重建失败 → 警告占位（新）；重建成功但二次失败 → 警告占位（新） | generateFailed 项首错即占位（既有行为不变）；scheduleOnDemandGeneration 调用点不传新参数 |
| T2    | 首次加载骨架→淡入不变；缓存命中 complete 自检不变      | 旧节点迟到 load 不撤新源骨架（新）                             | src 快速连续切换每次都重置；空串不渲染 img（既有）                                       |
| T3    | fallback 回退链不变；onError 终态占位不变              | 旧节点迟到 load 不撤骨架（新）                                 | src 与 fallbackSrc 相同引用切换；usedFallback 随 src 复位                                |
| T4    | 封面正常加载显示                                       | 封面失败回退图标（既有）；换 cover 后恢复重试（新）            | cover 为 null 时无 img 分支不受影响                                                      |
| T5    | 缩略图正常显示                                         | 失败回退图标（既有）；thumbUrl 变化后恢复重试（新）            | thumbUrl 为 null 时占位分支不受影响                                                      |
| T6/T7 | —                                                      | —                                                              | 仅注释/测试结构，行为零变更                                                              |

## 7. 红灯记录与实施结果（已回填）

| 节点 | 红灯用例                                                  | 红灯输出摘要                                                                                       | 转绿确认                                                         |
| ---- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| T1   | grid-cycle 用例①（重建失败→占位）+ ②（二次 onError→占位） | 2 failed / 5 passed：`expect(container.querySelector('img')).toBeNull()` 失败，卡片停留 img+骨架态 | grid-cycle 7/7 + thumb 结构断言 26/26 全绿                       |
| T2   | 旧源迟到 load 撤新源骨架                                  | 1 failed / 6 passed：骨架被迟到事件提前卸载                                                        | 7/7 全绿（末条恒真断言同步改为确定性断言）                       |
| T3   | 同 T2（MediaThumbnail）                                   | 1 failed / 23 passed                                                                               | 24/24 全绿（连同 ThumbReveal 31/31）                             |
| T4   | 封面失败后换 cover 恢复加载                               | 1 failed / 9 passed：`expected null to be truthy`（失败态粘滞，img 未恢复）                        | 10/10 全绿（边界用例初稿误用图片场景，已改视频场景后确认纯红灯） |
| T5   | 同 id 条目缩略图补齐后恢复加载                            | 1 failed / 8 passed：失败态粘滞                                                                    | 9/9 全绿                                                         |
| T6   | 不适用（注释零行为变更）                                  | —                                                                                                  | typecheck / lint / grep 确认                                     |
| T7   | 不适用（仅测试内部结构）                                  | —                                                                                                  | worker-entry + limiter 43/43 全绿                                |

### 实施偏差记录（相对第 5 节计划）

1. **T1 行为测试落点**：由 `VirtualImageGrid.thumb.test.tsx` 改为 `VirtualImageGrid.grid-cycle.test.tsx`——后者已有「真渲染 VirtualImageGrid + 仅 mock react-virtuoso」的完整先例（组件文件头注释明确 thumb.test 采用源码结构断言策略、避免脆弱的全 mock 渲染），复用先例符合"最小改动 + 优先复用"；thumb.test.tsx 保持结构断言不变（新增修复杂志见其结构断言仍全部通过）。
2. **T4/T5 渲染方式**：采用备用方案——对内部卡片组件加测试专用导出（`OutfitCard`、`RecycleBinItemComponent`，行为与内部使用完全一致）后直测，整页渲染 mock 成本过高。
3. **T2 的一帧闪现半边**：jsdom 下 act 会同步 flush effects，渲染期重置与 effect 重置在测试中不可区分，无法构造红灯；红灯仅覆盖"旧源迟到 load 竞态"半边，一帧闪现由渲染期重置 + `key={src}` 一并修复（代码评审可查）。

## 8. 已知边界（本轮不修，仅登记）

- 双 Timeline（TimelineView / EventTimelineView）缺行为级骨架测试，仅有结构断言（原计划 N5 偏差）。
- `onDemandThumbPromises` / `thumbRetryNonce` 会话级无界增长（前计划第 8 节已豁免）。
- generator 侧 N2 在途计数监听、bridge 补发逻辑无直接单测（既有覆盖缺口）。
- 批量让位（200ms）期间 THUMBNAIL_STOP 取消最多延迟 200ms 生效，不丢失（与既有取消语义一致）。
- `VIDEO_DECODE_CONCURRENCY` 固定为 2（与原计划 `Math.max(1, Math.min(2, cpus))` 公式偏差，代码注释已自述）。
