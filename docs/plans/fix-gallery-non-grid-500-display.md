---
name: fix-gallery-non-grid-500-display
overview: 修复"扫描媒体超过 500 个时 UI 仅显示 500 个"——根因是图库非网格视图（list/timeline/masonry/event-timeline）无任何分页加载入口，只渲染首屏 500 条
todos:
  - id: t1
    content: 红灯：在 useFilteredMediaFiles.test.ts 新增复现测试（非网格视图触发后续页加载 + 600 文件全量计数）并确认失败
    depends: []
  - id: t2
    content: 绿灯：修改 useFilteredMediaFiles.ts，viewMode !== 'grid' 时纳入全库拉齐条件，使测试通过
    depends: [t1]
  - id: t3
    content: 回归：相关子集测试 → 全量 npm test → typecheck → lint，确认无新增失败
    depends: [t2]
---

# 实施计划：修复「扫描媒体超过 500 个时 UI 仅显示 500 个」

## 1. 根因分析（基于代码检索，均已逐一核实）

### 1.1 已排除的环节（确认无截断，不改动）

| 环节           | 文件                                                          | 结论                                                                                                                                                         |
| -------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 扫描入库       | `src/main/scanner/worker-entry.ts`                            | `SCAN_BATCH_SIZE = 500` 仅为流式写入的分批大小（`flushBatch` 逐批落库、循环继续），无截断；`SCAN_COMPLETE.filesFound` 为真实总数                             |
| 数据库层       | `src/main/database/media-repository.ts`                       | `listMedia` keyset 分页（L991-1074）：`pageSize+1` 探针判定 `hasMore`、`nextCursor` 锚点正确；`500` 仅是未传 pageSize 时的默认页大小，非硬上限               |
| IPC 层         | `src/main/ipc/handlers/media-handler.ts`                      | `media:list` 透传 `files/hasMore/nextCursor`，`pageSize.max(500)` 仅约束单页大小，与前端 `MEDIA_PAGE_SIZE=500` 匹配                                          |
| 前端 grid 视图 | `src/renderer/pages/GalleryPage.tsx` + `VirtualImageGrid.tsx` | grid 视图已接线无限滚动（`onEndReached` → `loadNextMediaPage`），且有集成测试覆盖"600 张：首屏 500 → 触底追加"（`mediaStore.integration.test.ts`），无需改动 |
| 扫描完成刷新   | `ScanButton.tsx` / `mediaStore.refreshMediaAfterScan`         | 统一走 `fetchMediaFromDatabase`（首页 500 + keyset 游标复位），链路正确                                                                                      |

### 1.2 确认的缺陷（真正根因）

`GalleryPage.tsx`（L667-723）中**只有 `viewMode === 'grid'` 分支**向 `VirtualImageGrid` 传递了 `onEndReached / loadingMore / hasMore`。其余四种视图：

- `ListView.tsx`、`TimelineView.tsx`、`MasonryView.tsx`、`EventTimelineView.tsx` 均无任何分页 props，也无内部触底检测（全仓 grep 证实 `onEndReached` 仅存在于 `VirtualImageGrid`）；
- `useFilteredMediaFiles.ts`（L88-114，FIX 组20-1）的"筛选激活时逐页拉齐全库" effect 仅在 `isFilteringActive` 时触发。

**结果**：扫描入库 >500 个文件后，在 list / timeline / masonry / event-timeline 任一非网格视图、且无激活筛选条件时，`mediaFiles` 永远停在首屏 500 条 —— 即"UI 仅显示 500 个"。grid 视图因可触底加载不受影响（默认视图恰好掩盖了该缺陷）。

### 1.3 相关但不在本次范围（最小化改动原则）

- `src/renderer/search/search-service.ts` L224 `search(query, limit = 500)`：仅限制**搜索召回**上限，与"扫描后浏览显示"无关，本次不改（如需放开可另立任务）。

## 2. 依赖声明

**无新增依赖。**

## 3. 修改方案

### 3.1 修改文件清单（共 2 个文件，均为干净文件——不在他人未提交改动范围内）

**文件 1：`src/renderer/hooks/useFilteredMediaFiles.ts`**（复用 FIX 组20-1 既有的"逐页拉齐"机制，约 +3 行）

- 新增订阅视图模式：`const viewMode = useUIStore((s) => s.viewMode)`
- 全库拉齐条件从 `isFilteringActive` 扩展为 `isFilteringActive || viewMode !== 'grid'`：

```ts
// 修复：非网格视图（list/timeline/masonry/event-timeline）没有触底加载入口，
// 无筛选条件时 mediaFiles 永远停在首屏 500 条。视图模式非 grid 时同样逐页拉齐全库，
// 复用 loadNextMediaPage 的并发保护/去重/游标推进，每页追加驱动 effect 再触发直至 hasMoreMedia=false
const shouldPullAll = isFilteringActive || viewMode !== 'grid'
useEffect(() => {
  if (shouldPullAll && hasMoreMedia && currentView !== 'recycle-bin') {
    void loadNextMediaPage()
  }
}, [shouldPullAll, hasMoreMedia, mediaCount, currentView])
```

- 输入/输出变化：输入新增 `uiStore.viewMode`；输出不变（仍返回 `MediaFile[]`）。行为变化：非网格视图下 mediaFiles 自动补齐至全库（≤10,000 条，每页 500，最多 20 次 IPC），与既有"筛选激活拉齐"行为同构。

**文件 2：`src/renderer/hooks/useFilteredMediaFiles.test.ts`**（新增 describe 块，见 §4）

### 3.2 已评估并否决的备选方案

- **方案 B（否决）**：给 4 个视图组件逐一新增 `onEndReached` props + 滚动哨兵。理由：改动面 5 个文件、需在 4 个非虚拟化组件各自实现触底检测，且其中 `ListView/TimelineView/MasonryView/EventTimelineView/VirtualImageGrid` 多数处于他人未提交改动区（git status 脏文件），冲突风险高，违背最小化原则。
- **方案 C（否决）**：在 `GalleryPage` 加 effect。理由：`GalleryPage.tsx` 是他人未提交改动的脏文件，且 hook 内修改与组20-1 机制天然同构、无需触碰页面组件。

### 3.3 附带收益说明

`useFilteredMediaFiles` 同时被 DetailPage / FullscreenViewer 消费：非网格模式下打开详情/全屏预览时，前后翻页覆盖完整库而非仅前 500 条，属正确行为延伸。

## 4. 测试策略

### 4.1 复现测试（红灯，先行编写并确认失败）

**测试 A（接线复现，扩展现有文件 `useFilteredMediaFiles.test.ts`）**：沿用该文件既有的 `loadNextMediaPageMock` 模式，新增 describe「非网格视图全库加载（修复>500只显示500）」：

1. `viewMode='list'`、无筛选、`hasMoreMedia=true` → 断言 `loadNextMediaPage` 被调用（**修复前失败**：未被调用）；
2. `viewMode='timeline'` 同上（覆盖第二种非网格视图）；
3. `viewMode='grid'`、无筛选 → 断言不触发（守护既有首屏分页行为，防回归）。

**测试 B（端到端计数验收，新建 `useFilteredMediaFiles.count.test.ts`，不 mock mediaStore 模块）**：

- mock `window.electronAPI.media.list`：按 keyset 游标分页返回 **600 个** mock 文件（第 1 页 500 + `hasMore:true, nextCursor`；第 2 页 100 + `hasMore:false`）；
- `useUIStore.setState({ viewMode: 'list' })`，renderHook `useFilteredMediaFiles`；
- **验收标准**：等待 `useMediaStore.getState().mediaFiles.length === 600` 且 `result.current.length === 600`、`hasMoreMedia === false`（**修复前失败**：恒为 500）。
- 追加用例：1200 个文件（3 页）同口径断言，验证多页循环推进。

### 4.2 回归测试范围

1. 子集先行：`npx vitest run src/renderer/hooks/useFilteredMediaFiles`；
2. 相邻模块：`src/renderer/stores`（mediaStore / mediaStore.integration 等，验证分页机制未被波及）；
3. 全量：`npm test`（Unit 全套）；
4. 静态：`npm run typecheck`、`npm run lint`；
5. E2E：`npm run e2e:smoke`（若本机环境可用；不可用则如实标注未验证）。

**失败项处置**：任何失败先判定与本次改动相关性；无关（既有基线失败）如实记录、不掩盖；相关则修复后再过全量。

## 5. 错误处理与回归

- **取数失败**：`loadNextMediaPage` 现有逻辑——`loadMoreMedia` 返回 null 时保持游标与 `hasMoreMedia` 不变、用户可重试；effect 由 `mediaCount` 变化驱动，失败时不产生死循环（状态未变则不再触发）。
- **并发保护**：复用 `loadNextMediaPage` 内部 `loadingMore` 标志（L446-447），多次触底/重渲染安全。
- **回收站隔离**：保留 `currentView !== 'recycle-bin'` 守卫，回收站独立游标不受影响。
- **大数据量边界**：10,000 条 = 19 次追加 IPC，均为 keyset 游标查询（可索引 seek），符合"10,000 以内"预期；非网格视图本就非虚拟化渲染，与既有筛选拉齐行为一致。
- **禁区声明**：本次不触碰 git status 中他人未提交的 32 个脏文件（含 GalleryPage.tsx、各视图组件、uiStore.ts 等）；仅改动上列 2 个干净文件。
