# 批量选择模式下五视图收藏图标常驻与即时切换（实施计划）

- 日期：2026-10-24
- 状态：已批准，执行中
- 关联需求：进入批量删除（批量选择）状态时，每条记录保留并显示收藏图标及当前收藏状态，点击即时切换，无需退出批量模式；收藏操作与批量选择互不冲突，界面状态实时同步。

## 背景与目标

图库页（GalleryPage）工具栏「选择」按钮进入批量选择模式（`multiSelectMode`，底部 BatchActions 含批量删除）后：

- **网格视图**（默认，VirtualImageGrid）：仅已收藏项在非悬停时显示静态星标（`div`，不可点击，且仅桌面）；未收藏项无任何收藏标识。
- **列表 / 时间线 / 瀑布流 / 事件时间线**：完全没有收藏图标（正常模式也没有）。

目标（已确认范围）：**全部五种视图**在批量模式下每条记录常驻显示可点击收藏图标（实心=已收藏、空心=未收藏），点击即时切换且不与勾选/打开冲突；**正常模式下已收藏项的静态星标一并升级为可点击**。界面状态经 Zustand 乐观更新实时同步。

收藏切换链路完全复用现有实现，零新增业务逻辑：

```
GalleryPage 传 onFavorite=fileOperations.handleToggleFavorite
  → useFavoriteToggle（src/renderer/hooks/useFavoriteToggle.ts，
    乐观 updateMediaFile → window.electronAPI.mediaAction.updateFavorite
    → 失败回滚 + 撤销栈）
  → mediaStore.mediaFiles map 替换 → 各视图 items 重渲染
```

## 1. 依赖声明

**无新增依赖。** 全部复用仓库已有：React 19、react-i18next、`IconFavorite`（`src/renderer/icons/index.tsx`，`filled` prop）、i18n 既有键 `gallery.virtualGrid.favoriteTitle / unfavoriteTitle / favoriteAria / unfavoriteAria`（12 语言已存在，无需新增文案、无需跑 i18n 同步脚本）。

## 2. 启动说明

- 环境：仓库根目录，依赖已安装（禁止 `npm install`，遵循本仓库定版纪律）。
- 启动验证：`npm run dev` → 图库页点工具栏「选择」进批量模式 → 网格/列表/时间线/瀑布流/事件时间线切换视图，逐视图核对：每条记录右上/行尾星标可见、空心实心正确、点击即切换、勾选状态不受影响。
- 自动化验证：`npx vitest run src/renderer/components/gallery`（相关子集）与 `npm run verify`（typecheck + lint 只读 + prettier --check + 相关单测）。

## 3. 错误处理

- IPC 失败：由 `useFavoriteToggle` 现有 catch 回滚 store 并 toast 报错，本次不改动、天然继承。
- `onFavorite` 缺省（预览/其他调用点未传）：组件不渲染收藏按钮，视图行为与现状一致（向后兼容，沿用 `multiSelectMode` 可选 prop 的既有约定）。
- 触屏设备：网格视图保持现状（`!isTouchDevice` 门控，触屏走常驻操作按钮行，其中本就含收藏），避免新常驻图标与触屏操作行重叠。

## 4. 参数校验

- `MediaFavoriteButtonProps`：`isFavorite: boolean`（必填）、`onToggle: () => void`（必填）、`label?: string`（无障碍标签，缺省回退 i18n 文案）、`className?: string`、`size?: number`（默认 16）。
- 各视图新 prop：`onFavorite?: (file: MediaFile) => void`，可选、缺省不渲染（不破坏既有调用点）。
- `file.is_favorite` 取值 `0/1/undefined`（SQLite 布尔）：组件内 `!!` 归一化。

## 5. 实施节点（每节点红灯→修复→绿灯→相关子集回归）

### 节点 0：写入实施计划文档

- 文件：`docs/plans/2026-10-24-batch-mode-favorite-toggle.md`（本文件）。
- 验收：文件存在且包含依赖/启动/错误处理/参数校验/测试五要素。

### 节点 1：新建共用组件 `MediaFavoriteButton`

- 文件：新建 `src/renderer/components/gallery/MediaFavoriteButton.tsx` + 同目录 `MediaFavoriteButton.test.tsx`。
- 实现（仿 `MediaCheckbox` 先例）：
  - `button type="button"`，`aria-pressed={isFavorite}`、`data-testid="media-favorite"`，`title`/`aria-label` 用 `gallery.virtualGrid.(un)favoriteTitle/(un)favoriteAria`，内含 `<IconFavorite filled={isFavorite} />`；
  - `onClick/onMouseDown/onDoubleClick/onContextMenu` 全部 `stopPropagation`（浮层点击不得冒泡触发卡片勾选/打开）。
- 红灯测试（先写，组件不存在 → 导入失败即红）：
  - 正常：`aria-pressed` 随 `isFavorite` 切换；title 在「收藏/取消收藏」间切换。
  - 交互：点击触发 `onToggle` 一次；父容器 onClick 零调用（不冒泡）。
  - 边界：不传 `label` 不抛错、aria-label 回退 i18n 文案。
- 验收标准：`npx vitest run src/renderer/components/gallery/MediaFavoriteButton.test.tsx` 全绿（修复前红）。

### 节点 2：网格视图接入（VirtualImageGrid）

- 文件：改 `src/renderer/components/gallery/VirtualImageGrid.tsx`（徽标分支）。
- 改动：静态 `div` 星标替换为 `MediaFavoriteButton`；渲染条件由 `file.is_favorite && hoveredId !== file.id && !isTouchDevice` 放宽为 `(multiSelectMode || file.is_favorite) && hoveredId !== file.id && !isTouchDevice && onFavorite`——批量模式每卡常驻（悬停让位给既有 hover 操作行），正常模式仅已收藏显示但可点击。
- 红灯测试：新建 `src/renderer/components/gallery/media-favorite-batch.test.tsx`，渲染级用例 mock `react-virtuoso`（VirtuosoGrid 透传 `itemContent`）+ 沿用 `VirtualImageGrid.thumb.test.tsx` mock 清单：
  - 正常：批量 + `onFavorite` 下每卡有 `data-testid="media-favorite"`；`aria-pressed` 与 `is_favorite` 对应。
  - 交互：点击收藏按钮 → `onFavorite(file)` 被调，`onSelect`/`onToggleSelection` 零调用。
  - 边界：非批量仅已收藏卡渲染；不传 `onFavorite` 不渲染。
- 验收标准：`npx vitest run src/renderer/components/gallery/media-favorite-batch.test.tsx` 网格部分全绿（修复前红）；`npm run verify` 通过。

### 节点 3：其余四视图接入 + GalleryPage 接线

- 文件与改动：
  - `ListView.tsx`：新增 `onFavorite?` prop；行尾（评分星右侧）渲染同条件按钮；补 `useTranslation` 导入。
  - `TimelineView.tsx` / `EventTimelineView.tsx`：新增 `onFavorite?` prop；卡片右上 `absolute top-2 right-2 z-10` 渲染同条件按钮。
  - `MasonryView.tsx`：新增 `onFavorite?` prop 并入 `MasonryContext`；卡片右上同款按钮。
  - `GalleryPage.tsx`：五处视图调用统一传 `onFavorite={fileOperations.handleToggleFavorite}`。
- 红灯测试（同文件增补，先写先红）：
  - 渲染级（MasonryView，jsdom 注入 clientWidth/Height）：批量模式 6 卡各 1 个收藏按钮、`aria-pressed` 对应；点击调 `onFavorite` 且 `onSelect`/`onToggleSelection` 零调用；非批量仅已收藏渲染。
  - 结构级（readCode 剔注释模式）：ListView / TimelineView / EventTimelineView 源码含 `MediaFavoriteButton` 分支；GalleryPage 源码五视图均传 onFavorite。
- 验收标准：`npx vitest run src/renderer/components/gallery/media-favorite-batch.test.tsx` 全绿（修复前红）；`npm run verify` 通过。

### 节点 4：全量回归

- `npm test`（全量 vitest）、`npm run typecheck`、`npm run lint`、`npm run verify` 全部通过，无新增失败项（含既有 `SelectionWiring.test.tsx`、`media-card-selection.test.tsx`、`MasonryView.test.tsx` 等多选用例不回归）。
- 提交：`git add` 相关文件 → `git commit`（Conventional Commits）→ 提交后 `git status --porcelain` 复核钩子未留意外改动。

## 改动文件清单

| 文件                                                                                                              | 动作                            |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `docs/plans/2026-10-24-batch-mode-favorite-toggle.md`                                                             | 新建（计划落档）                |
| `src/renderer/components/gallery/MediaFavoriteButton.tsx` / `.test.tsx`                                           | 新建（共用组件 + 单测）         |
| `src/renderer/components/gallery/media-favorite-batch.test.tsx`                                                   | 新建（渲染级 + 结构级回归）     |
| `src/renderer/components/gallery/VirtualImageGrid.tsx`                                                            | 徽标 div → 可点击按钮，条件放宽 |
| `src/renderer/components/gallery/ListView.tsx` / `TimelineView.tsx` / `EventTimelineView.tsx` / `MasonryView.tsx` | 新增 onFavorite prop + 收藏按钮 |
| `src/renderer/pages/GalleryPage.tsx`                                                                              | 五视图统一传 onFavorite         |

不触及受保护路径（`src/main/preload/api`、`src/main/ipc/handlers`、`src/main/services`、`src/shared/errors`），无需 `@core-change` 注释；不新增 i18n 键、不新增依赖、不改主进程。
