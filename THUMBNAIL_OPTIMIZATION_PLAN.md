# 缩略图加载性能优化（打包版：图片模糊数十秒才清晰 / 视频过渡生硬）

- 状态：已实施（2026-09-29，全部节点红→绿闭环通过；全量回归 292 文件 / 4887 用例通过，lint / typecheck / audit 通过）
- 创建日期：2026-09-29
- 关联前篇：[docs/plans/2026-09-29-fix-thumbnail-loading-latency.md](docs/archive/plans/2026-09-29-fix-thumbnail-loading-latency.md)（已修复「死胡同/缓存风暴/高分屏错档」，本篇接手其「已知限制」中遗留的等待时长与过渡体验问题）

## 1. 根因分析（已逐行读码核实的证据链）

上次修复（7c29cb5）解决了「standard 404 后死胡同」与「自愈后旧字节驻留」，但「模糊→清晰要数秒~数十秒」的**等待本身**仍在：

1. **等整批跑完才有重试机会**：standard 档 `${hash}.jpg` 由 media-worker 批量生成（`src/main/media-worker/worker-entry.ts:467-637`，`THUMBNAIL_CONCURRENCY=4` 且每图并行 metadata+pHash+stat），批量**结束时才广播一次** `media:updated`（`src/main/app/startup-tasks.ts:239`）。期间可视项 standard 请求 404 → 回退模糊图，唯一重试机会是全量刷新使 `useFailedImages` 集合清空（`src/renderer/hooks/useFailedImages.ts:20-22`）——间隔即整批完成时间，「数秒~数十秒」。
2. **`thumbnail=NULL` 直载数 MB 原图**（`src/renderer/components/gallery/VirtualImageGrid.tsx:383-385`）：`effectiveThumbnail || file.file_path` 在批量未达时把原图拉伸当缩略图，与批量任务争抢磁盘 IO，越忙越慢（前篇「已知限制」第 2 条明确遗留）。
3. **无预取与过渡生硬**：全屏查看每换一张现场加载解码原图（`src/renderer/components/gallery/FullscreenViewer.tsx:94-114` 仅有当前图 decode 探针）；`<img>` 全仓无 `decoding="async"`；64px 低清 → 320px standard 为换 `src` 硬切，无淡入。
4. **视频按需生成整表触发**：`useVideoThumbGenerate`（`src/renderer/hooks/useVideoThumbGenerate.ts:25-73`）对 items 全列表的缺图视频一次性发起 IPC，万级视频库会在主进程 `decodeLimiter` 前排起长队，可视项反而靠后。

### 怀疑方向结论

| 方向                        | 结论                                 | 处置                                                |
| --------------------------- | ------------------------------------ | --------------------------------------------------- |
| 渲染层要等批量结束才重试    | 成立（主因）                         | 节点 1：批量进度节流广播                            |
| NULL 缩略图直载原图         | 成立                                 | 节点 2：可视区按需生成 + 占位                       |
| 换档硬切 / 无 decoding 提示 | 成立（体验）                         | 节点 3：交叉淡入 + `decoding="async"`               |
| 全屏/详情无预取             | 成立（体验）                         | 节点 4：邻近预取 + 详情渐进                         |
| 图片格式（WebP/AVIF）       | 不成立：本地盘读取毫秒级、非字节瓶颈 | 不做（牵动 generator/LRU/mime/测试，收益/侵入比差） |
| IPC 通信延迟                | 不成立（URL 由 DB 行同步构造）       | 不改                                                |

## 2. 依赖声明

**零依赖变更**：不新增/不升级/不移除任何 npm 依赖，不改 `package.json`。全部复用仓库既有能力：

- `thumbnail:generate` IPC（`src/main/preload/api/thumbnail.ts` → `generate(filePath, quality?)` 返回缩略图绝对路径）
- `useFailedImages`（`src/renderer/hooks/useFailedImages.ts`，additive 扩展 `clearFailed`）
- EventEmitter 订阅模式（`MediaWorkerManager extends EventEmitter`，`manager.ts:139-150` 已有事件分支）
- `sendToRenderer(ctx, channel)`（`src/main/app/renderer-bridge.ts:11`）
- `vi.useFakeTimers`（仓库既有测试模式）

环境准备：确认 `node_modules` 存在（缺失则 `npm install` 增量安装，禁止 `npm ci`）。

## 3. 启动与验证说明

- 自动化（节点级，红→绿闭环）：`npx vitest run <对应测试文件>`
- 全局回归：`npm test`（全量）、`npm run test:main`、`npm run test:renderer`、`npm run lint`、`npm run typecheck`、`npm run audit`
- 格式：`npx prettier --check` 覆盖全部改动文件
- 手验（dev，`npm run dev`）：图库快速滚动后停住——① 低清图应在 ~300ms 后淡入为清晰图（无闪跳）；② 刚导入/`thumbnail=NULL` 的卡片显示占位图并在数秒内就地变清晰，不再长时间显示拉伸原图；③ 批量进行中每隔 ~2s 已生成项逐步由模糊转清晰；④ 全屏左右切换时相邻图基本即点即显。
- 手验（打包，可选）：`npm run dist:win` 安装后重复上述观察。

## 4. 错误处理

- **节点 1（节流广播）**：notifier 未注入时行为与现状完全一致（不订阅、不调用）；`sendToRenderer` 自带窗口存活兜底；节流为无状态时间判断，无定时器泄漏。
- **节点 2（按需生成）**：模块级 `Map<string, Promise<string | null>>` 单次守卫——同一 `file_path` 只尝试一次（成功缓存结果、失败不重试），杜绝请求风暴；IPC 抛错 catch 后置失败态：图片回退直载原图（保留旧行为兜底）、视频维持占位图标（绝不返回视频路径，对齐 `useVideoThumbGenerate` 不变量）。
- **节点 3（交叉淡入）**：onError 回调透传给父组件，既有回退链终止条件不变；standard `onLoad` 前底图可见，`onLoad` 后卸载底图，不存在双图常驻。
- **节点 4（预取）**：`new Image()` 不挂监听，加载失败静默，无未捕获 Promise 拒绝；视频项跳过。
- **日志**：主进程新增日志中文硬编码（沿用仓库 `[Cleanup] ...` 先例），不新增 i18n key；渲染层不新增 console。

## 5. 参数校验

- `resolveEffectiveThumbnail`：入参为类型化对象 `{ fileType: 'image' | 'video'; thumbnail: string | null | undefined; generatedPath: string | undefined; generateFailed: boolean; filePath: string }`；`filePath` 非空字符串守卫，空则返回 `null`（占位）。
- 按需生成触发：`file_path` 非空才入 Map；`window.electronAPI?.thumbnail?.generate` 缺失时整段跳过（测试环境安全）。
- 节点 1 节流窗口常量 `THUMBNAIL_BROADCAST_THROTTLE_MS = 2000`；测试用 `vi.useFakeTimers` 驱动。
- `TieredCardImage`：`standardUrl` 为空字符串时整体不渲染（占位由父组件 `MediaThumbPlaceholder` 负责）。
- `useFailedImages.clearFailed(id)`：仅删除既有集合成员，不抛错。

## 6. 基础测试用例矩阵（正常 / 异常 / 边界）

### src/main/media-worker/manager.test.ts（节点 1，追加 describe）

| 类别 | 用例                                   | 期望                          |
| ---- | -------------------------------------- | ----------------------------- |
| 正常 | 注入 notifier，首个 THUMBNAIL_PROGRESS | notifier 同步被调用 1 次      |
| 正常 | 2s 窗口内连续多条进度                  | 仅第 1 条触发通知（节流合并） |
| 边界 | 推进 fake timers 越过 2s 后再来一条    | 再次通知                      |
| 异常 | 未注入 notifier 时收到进度             | 不调用、不抛错                |
| 边界 | THUMBNAIL_COMPLETE 后再收进度          | 不复用旧窗口，行为一致        |

### src/renderer/components/gallery/VirtualImageGrid.thumb.test.tsx（节点 2）

| 类别 | 用例                                      | 期望                                                                                              |
| ---- | ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 正常 | `resolveEffectiveThumbnail`：有 thumbnail | 返回 thumbnail                                                                                    |
| 正常 | 无 thumbnail，生成成功                    | 返回 generatedPath                                                                                |
| 正常 | 图片无 thumbnail、生成失败                | 返回 filePath（旧兜底保留）                                                                       |
| 异常 | 视频无 thumbnail、生成失败                | 返回 null（绝不返回视频路径）                                                                     |
| 边界 | 无 thumbnail、生成中（无结果）            | 返回 null（占位）                                                                                 |
| 边界 | filePath 为空字符串                       | 返回 null                                                                                         |
| 边界 | 源码结构                                  | 不再存在 `effectiveThumbnail \|\| file.file_path` 直载原图；不含 `useVideoThumbGenerate` 整表触发 |

### src/renderer/components/gallery/TieredCardImage.test.tsx（节点 3，新建 jsdom）

| 类别 | 用例                               | 期望                                       |
| ---- | ---------------------------------- | ------------------------------------------ |
| 正常 | showStandard 且 standard onLoad    | standard `opacity-100`，低清底图卸载       |
| 正常 | showStandard 且 standard 未 onLoad | 双图并存，standard `opacity-0`             |
| 异常 | standard onError                   | onStandardError 被调用（回退链交由父组件） |
| 异常 | low onError                        | onLowError 被调用                          |
| 边界 | lowUrl 为 null                     | 仅渲染 standard                            |
| 边界 | showStandard=false                 | 仅渲染低清                                 |
| 边界 | standardUrl 为空                   | 不渲染任何 img                             |

### src/renderer/components/gallery/FullscreenViewer.prefetch.test.tsx（节点 4，新建 jsdom）

| 类别 | 用例                 | 期望                                 |
| ---- | -------------------- | ------------------------------------ |
| 正常 | 打开全屏并位于中间项 | `new Image()` 预热前后各一张原图 src |
| 边界 | 当前项为列表首/尾    | 只预热存在的一侧                     |
| 异常 | 相邻项为视频         | 不为其构造 Image                     |

### src/renderer/pages/DetailPage（节点 4）

| 类别 | 用例                    | 期望                                     |
| ---- | ----------------------- | ---------------------------------------- |
| 正常 | 有 thumbnail 的图片     | 主图下方渲染低清底图，原图 onLoad 后淡入 |
| 边界 | 无 thumbnail / 视频文件 | 行为与现状一致（单图/播放器）            |

## 7. 子任务与验收标准（分节点 TDD，红→绿闭环）

### 节点 0：计划落盘

- 文件：`THUMBNAIL_OPTIMIZATION_PLAN.md`（本文件，仓库根目录）。
- 验收：`npx prettier --check THUMBNAIL_OPTIMIZATION_PLAN.md` 通过。

### 节点 1：主进程批量进度节流广播（红→绿）

- 文件：`src/main/media-worker/manager.ts`；`src/main/app/application.ts`；测试 `src/main/media-worker/manager.test.ts`。
- 输入/输出：worker `THUMBNAIL_PROGRESS`（worker-entry.ts:588-597 每 500ms/10 项已上报）→ manager 2s 节流调用 notifier → 渲染层周期收到 `media:updated` → GalleryPage 既有订阅静默刷新（`GalleryPage.tsx:221-234`）→ 新缩略图路径入库即逐步可见。
- 先写红灯：上表 manager 5 例（`setThumbnailProgressNotifier` 尚不存在，必红）。
- 实现：manager 新增 `setThumbnailProgressNotifier(fn: (() => void) | null)` 与 `THUMBNAIL_BROADCAST_THROTTLE_MS=2000` 时间节流，`THUMBNAIL_PROGRESS` 分支调用；`application.ts` 在 `new MediaWorkerManager(...)`（:78）与 AppContext 装配后注入 `() => sendToRenderer(ctx, 'media:updated')`。
- 验收：`npx vitest run src/main/media-worker/manager.test.ts` 全绿；`npm run test:main` 无新增失败。

### 节点 2：渲染层可视区按需生成，替代直载原图（红→绿，核心节点）

- 文件：`src/renderer/components/gallery/VirtualImageGrid.tsx`；`src/renderer/hooks/useFailedImages.ts`；测试 `src/renderer/components/gallery/VirtualImageGrid.thumb.test.tsx`。
- 输入/输出：可视区（`rangeChanged` + 既有 300ms 防抖定时器）内 `!thumbnail` 或 `standardFailed` 的项 → `thumbnail.generate(filePath)` → 成功路径就地显示、standardFailed 项 `clearFailed` 后原 URL 重试。
- 先写红灯：上表 `resolveEffectiveThumbnail` 7 例（纯函数尚不存在，导入即红）+ 结构断言。
- 实现：
  1. 新导出纯函数 `resolveEffectiveThumbnail`（见 §5）；`standardUrl` 改由其产出，`thumbnail=NULL` 且生成中显示占位（用户已确认），不再直载原图。
  2. 既有 `triggerHighQualityUpgrade` 定时器内追加按需生成触发（模块级 Promise Map 单次守卫）；生成成功对 standardFailed 项 `clearFailed`（顺带修复 LRU 驱逐后 404 死角）。
  3. `useFailedImages` additive 新增 `clearFailed(id)`。
  4. 移除 VirtualImageGrid 对 `useVideoThumbGenerate` 的使用（可视区统一机制取代整表触发；DuplicatesPage 保留该 hook 不动），同步更新该文件既有结构断言。
- 验收：`npx vitest run src/renderer/components/gallery/VirtualImageGrid.thumb.test.tsx` 全绿；`npm run test:renderer` 无新增失败。

### 节点 3：模糊→清晰交叉淡入 + decoding 提示（红→绿）

- 文件：新增 `src/renderer/components/gallery/TieredCardImage.tsx`；`src/renderer/components/gallery/VirtualImageGrid.tsx` 接入；测试新建 `src/renderer/components/gallery/TieredCardImage.test.tsx`。
- 输入/输出：props `{ lowUrl, standardUrl, showStandard, alt, onLowError, onStandardError }`；standard `onLoad` 前双图并存（standard `opacity-0`），onLoad 后淡入并卸载低清底图；onError 透传保持既有回退链。
- 先写红灯：上表 7 例（组件不存在必红）。
- 实现：新组件（约 50 行）+ VirtualImageGrid 卡片 `<img>` 替换为该组件并加 `decoding="async"`。
- 验收：新测试全绿；`VirtualImageGrid.thumb.test.tsx` 全绿。

### 节点 4：全屏邻近预取 + 详情页渐进（红→绿）

- 文件：`src/renderer/components/gallery/FullscreenViewer.tsx`；`src/renderer/pages/DetailPage.tsx`；测试新建 `src/renderer/components/gallery/FullscreenViewer.prefetch.test.tsx` 与 DetailPage 对应测试（无既有测试则新建）。
- 输入/输出：`fullscreenIndex`/`activeFiles` 变化 → `new Image()` 预热前后各一张原图（跳过视频）；DetailPage 主图叠加 thumbnail 底图、原图 onLoad 淡入。
- 先写红灯：预取用例（当前无预取逻辑必红）、DetailPage 双图结构断言（当前单图必红）。
- 验收：新测试全绿；`npm run test:renderer` 无新增失败。

### 节点 5：全局回归与安全检查（终止条件）

- `npm test` 全量无新增失败 → `npm run test:main`、`npm run test:renderer` → `npm run lint`、`npm run typecheck` → `npx prettier --check`（全部改动文件）→ `npm run audit` → `git diff --numstat` 确认仅计划内文件变更。
- 任一失败必须修复后重跑对应检查，不得跳过或弱化。

## 8. 改动边界（明确不动，遵守最小改动）

- **不动** 生成架构与批量并发：`thumbnail/generator.ts`、`media-worker/worker-entry.ts`、`THUMBNAIL_CONCURRENCY=4`、pHash 逻辑、白帧自愈。
- **不动** IPC 契约：无新增/变更通道与签名，`docs/IPC_CONTRACT.md` 无需同步。
- **不动** `media://` 协议（ETag/304 协商缓存已就绪）与 300ms 防抖。
- **不动** 其他视图：`ListView/TimelineView/EventTimelineView/MasonryView/RecycleBinPage/OutfitGalleryPage`（经节点 1 广播间接受益）、`DuplicatesPage` 既有按需生成与 `useVideoThumbGenerate` 本体。
- **保留** `_low/_high` 命名契约与 `pickThumbnailUrl` 语义（仅 data source 换为 `resolveEffectiveThumbnail`）。

## 9. 已知限制

- 批量期间深分页（首屏 500 之后）的项仍需滚动触底后随刷新逐步补图。
- 视频抽帧本身的耗时（ffmpeg seek 阶梯）不变；本计划消除的是排队、IO 争抢与「等整批广播」的放大效应。
- DPR≥2 屏稳态仍为 standard 320px（`_high` 512px 渐进增强留待后续，与前篇一致）。
