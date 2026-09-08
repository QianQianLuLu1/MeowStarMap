# 图库 / 截图 / 收藏 三大板块「多选」功能实施计划

- 日期：2026-09-08
- 版本基线：v2.5.0
- 目标：为三大核心板块补齐显式多选能力（进入/退出多选模式、单项勾选、全选/取消全选、多选态批量操作），零新增依赖，严格 TDD 闭环。

---

## 0. 现状结论（已实读源码验证）

三大板块**复用同一个 `GalleryPage` 组件**（`src/renderer/App.tsx:285-296`），靠 `uiStore.currentView` 区分：

| 板块 | `currentView` 枚举值 | 数据来源过滤                                                                                               |
| ---- | -------------------- | ---------------------------------------------------------------------------------------------------------- |
| 图库 | `gallery`            | `mediaStore` 传 `galleryHighQualityOnly: true`（`src/renderer/stores/mediaStore.ts:302-314`）              |
| 截图 | `screenshots`        | `mediaStore` 传 `mediaSource: 'local_screenshot'`（`mediaStore.ts:304-309`）                               |
| 收藏 | `favorites`          | 前端 `useFilteredMediaFiles` 过滤 `f.is_favorite`（`src/renderer/hooks/useFilteredMediaFiles.ts:144-146`） |

`viewMode`（`grid` / `list` / `timeline` / `masonry` / `event-timeline`，`src/renderer/stores/uiStore.ts:47`）是**正交的渲染形态**，不是板块。

**已有可复用资产**（禁止重写）：

- `uiStore.selectedMediaIds: string[]`（`uiStore.ts:91`）+ `selectMedia` / `toggleMediaSelection` / `setSelectedMediaIds` / `clearSelection`（`uiStore.ts:136-139, 248-264`）
- `GalleryPage.tsx:265-312` 的 Ctrl/Cmd 切换、Shift 区间选择；`:326-330` 反选
- `src/renderer/components/gallery/BatchActions.tsx`（266 行）完整批量操作栏
- 图标：`IconSelectAll`(icons/index.tsx:336)、`IconInvertSelection`(:343)、`IconCheck`(:555)、`IconCheckCircle`(:577)
- 勾选框范式：`src/renderer/components/gallery/ImportWizard.tsx:175-188, 372-398`

**真实缺口**：

1. 无显式「多选模式」开关（当前是隐式 Ctrl 点击）
2. 无可见勾选框（仅 `ring-2` 描边 + `aria-selected`）
3. `TimelineView.tsx:13-17` / `EventTimelineView.tsx:14-18` **完全没有选中能力**
4. `handleSelectAll`（`GalleryPage.tsx:314-316`）只能全选，不能取消全选
5. 三大板块共用 `selectedMediaIds`，`navigateTo`（`uiStore.ts:224-233`）不清选中 → 跨板块串味

---

## 1. 依赖声明

### 1.1 新增依赖

**无。零新增依赖包。**

### 1.2 变更依赖

**无。** 不修改 `package.json` 的 `dependencies` / `devDependencies`，不改 `package-lock.json`。

### 1.3 复用清单

| 能力        | 复用对象                                                                              |
| ----------- | ------------------------------------------------------------------------------------- |
| 状态管理    | `zustand` + `zustand/react/shallow` 的 `useShallow`（已在 `GalleryPage` 使用）        |
| 选中态动作  | `uiStore` 既有 4 个 action                                                            |
| 批量操作 UI | `BatchActions.tsx`（**本组件不改**）                                                  |
| 勾选框图标  | `IconCheck`                                                                           |
| 提示        | `useGlobalToast`（`src/renderer/pages/settings/sections`）                            |
| 测试        | `vitest` + `@testing-library/react` + `@testing-library/user-event`（已在仓库依赖中） |

### 1.4 环境准备

```powershell
cd (Resolve-Path 'd:\Qode*\WXNN*').Path
npm install          # 增量安装；禁止 npm ci（Safe-Delete 网关会拦截全量删除）
```

> 约束：本机 npm 有 **Safe-Delete 网关**（阈值 500），`npm ci` 与 `Remove-Item node_modules` 会被拦。只允许 `npm install`。

---

## 2. 启动说明

### 2.1 可用命令（均已确认存在于 `package.json`）

```powershell
npm run typecheck                 # tsc -b
npm run lint                      # eslint .
npx vitest run <path>             # 跑指定测试子集
npm test                          # 全量 vitest run
npm run sync-i18n-keys            # 同步 12 语言 key
npm run i18n:check                # i18n key 校验
```

### 2.2 启动限制与验证方式（重要）

本机 npm **allow-scripts 网关**会拦截 `electron` / `better-sqlite3` / `esbuild` / `ffmpeg-static` / `koffi` 的安装脚本，**真实 Electron 启动（`npm run dev`）不可用**。

因此功能验证以以下三层为准：

1. **组件/单元测试**（主验证手段）：`MediaCheckbox` 渲染与冒泡隔离、5 视图 `multiSelectMode` 接入、`useMultiSelection` 正常/异常/边界、`uiStore` 模式切换与板块清理。
2. **类型与静态检查**：`npm run typecheck` exit 0；`npm run lint` 无新增问题。
3. **源码结构性断言**：工具栏按钮与 5 视图 prop 透传（沿用 `GalleryPage.test.tsx` 既有模式）。

若后续环境允许启动 Electron，手动冒烟清单置于第 8 节。

### 2.3 全量测试执行方式

全量 vitest 必须后台跑再轮询（直接前台跑会超时）：

```powershell
Start-Process cmd.exe "/c npx vitest run > .x.log 2>&1"
# 轮询
Get-Content .x.log -Tail 40
```

临时日志 `.x.log` 落在 `.gitignore`（以点开头），任务结束后删除。

---

## 3. 参数校验

### 3.1 `useMultiSelection` 入参契约

```ts
export interface UseMultiSelectionOptions {
  /** 当前板块经筛选后的文件列表；非法值（非数组/null/undefined）按空列表处理 */
  files: MediaFile[]
}
```

| 入参          | 类型          | 必填 | 校验规则                    | 非法值处理                                              |
| ------------- | ------------- | ---- | --------------------------- | ------------------------------------------------------- |
| `files`       | `MediaFile[]` | 是   | `Array.isArray(files)` 守卫 | 非数组 → 视为 `[]`，全选/反选为 no-op，`totalCount = 0` |
| `files[i].id` | `string`      | 是   | 只取 `f.id`，不校验唯一性   | 重复 id 由 `Set` 去重，不产生重复选中                   |

**边界值**：

- 空列表：全选 no-op（不写入空数组以外的状态），`isAllSelected = false`（避免 0/0 被判为 true）
- 已全选时点「全选」→ 清空（`selectedIds` 长度 === `totalCount` 且 `totalCount > 0`）
- 退出多选模式：必须同时 `clearSelection()`

### 3.2 视图组件新增 prop 契约

```ts
multiSelectMode?: boolean                    // 默认 false，向后兼容
selectedIds?: string[]                       // 仅 Timeline / EventTimeline 新增，默认 []
onSelect?: (id: string, index: number, e: React.MouseEvent | React.KeyboardEvent) => void
```

- 全部**可选**，既有调用点（`GalleryStackOverflow.test.tsx:89-92`、`*.stories.tsx`、`MasonryView.test.tsx`）不传时行为完全不变
- `multiSelectMode` 为 `undefined` / `false` 时不渲染勾选框 → DOM 结构零变化

### 3.3 `uiStore` 新增契约

```ts
multiSelectMode: boolean                     // 默认 false
setMultiSelectMode: (on: boolean) => void
```

- 非布尔值由 TypeScript 编译期拦截（strict）
- **不进 `partialize`**（与 `uiStore.test.ts:71-80`「不应持久化临时交互状态」契约一致）

---

## 4. 错误处理

| 异常分支                              | 处理策略                                                                                                                     | 用户可见反馈                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `files` 传入非数组（数据层异常/竞态） | `Array.isArray` 守卫降级为空列表                                                                                             | 无（静默降级，不打断渲染）     |
| 空列表下点「全选」                    | no-op，不写入状态                                                                                                            | 无（按钮仍在，不产生空批量栏） |
| 选中 id 在数据刷新后已不存在          | 批量操作路径已用 `filteredFiles.filter(f => selectedSet.has(f.id))` 过滤（`GalleryPage.tsx:529-530, 545-546`），**保持不变** | 无                             |
| 切换板块                              | `navigateTo` 命中三大板块切换时清空选中 + 退出多选模式                                                                       | 批量操作栏消失                 |
| 勾选框点击冒泡到卡片                  | `MediaCheckbox` 内 `e.stopPropagation()`                                                                                     | 仅切换选中，不打开全屏         |
| 多选模式下卡片裸点                    | 改为 `toggleMediaSelection(id)`，**不调用** `openFullscreen`                                                                 | 勾选框状态翻转                 |

### 4.1 日志输出规范

- 渲染层沿用既有 `useGlobalToast`（`showMessage`）
- **不新增 logger、不打 `console.log` / `console.error`**（本次为纯前端交互状态，无异常分支需落日志）
- 批量操作本身的错误提示已由 `useFileOperations` / `useBatchOperations` 覆盖，不重复实现

---

## 5. 子任务与验收标准

### T1 编写本计划文档并入库

- 修改文件：`docs/plans/2026-09-08-gallery-multiselect.md`（新建）
- 输入：需求与现状调研结论
- 输出：本文档（LF 行尾）
- 验收：文件存在、prettier 格式通过、行为 LF

### T2 `uiStore` 新增 `multiSelectMode` 与板块切换清理

- 修改文件：
  - `src/renderer/stores/uiStore.ts`（新增字段 + action + `navigateTo` 副作用）
  - `src/renderer/stores/uiStore.test.ts`（新增用例）
- 输入：`setMultiSelectMode(true | false)`、`navigateTo(view)`
- 输出：`uiStore.multiSelectMode` 与 `selectedMediaIds` 状态变更
- 验收标准（先红灯后绿灯）：
  1. `uiStore` 初始 `multiSelectMode === false`
  2. `setMultiSelectMode(true)` → `true`；`setMultiSelectMode(false)` → `false`
  3. 图库 → 截图 → 收藏 切换后 `selectedMediaIds === []` 且 `multiSelectMode === false`
  4. `partialize` 中**不含** `multiSelectMode`
  5. `npx vitest run src/renderer/stores/uiStore.test.ts` 全通过

### T3 新增 `useMultiSelection` hook

- 修改文件：
  - `src/renderer/hooks/useMultiSelection.ts`（新建）
  - `src/renderer/hooks/useMultiSelection.test.ts`（新建）
- 输入：`{ files: MediaFile[] }`
- 输出：`{ multiSelectMode, selectedIds, selectedCount, totalCount, isAllSelected, isSelected, enter, exit, toggle, toggleSelectAll, invert }`
- 验收标准（`npx vitest run src/renderer/hooks/useMultiSelection.test.ts` 全通过）：
  - **正常流程**：enter → `multiSelectMode=true`；toggle 单项 → 选中；再 toggle → 取消；`toggleSelectAll` 全选；再点 → 清空；`invert` 反选；`exit` → 模式关闭且选中清空
  - **异常流程**：`files` 传 `null` / `undefined` / 非数组对象 → 不抛错，`totalCount=0`，`toggleSelectAll` no-op
  - **边界条件**：空数组全选 no-op；`isAllSelected` 在 `totalCount===0` 时为 `false`；重复 id 不产生重复选中项

### T4 `MediaCheckbox` + 五种视图接入

- 修改文件：
  - `src/renderer/components/gallery/MediaCheckbox.tsx`（新建）
  - `src/renderer/components/gallery/MediaCheckbox.test.tsx`（新建）
  - `src/renderer/components/gallery/VirtualImageGrid.tsx`（新增可选 prop）
  - `src/renderer/components/gallery/ListView.tsx`
  - `src/renderer/components/gallery/MasonryView.tsx`
  - `src/renderer/components/gallery/TimelineView.tsx`（首次接入选中）
  - `src/renderer/components/gallery/EventTimelineView.tsx`（首次接入选中）
- 输入：`multiSelectMode`、`selectedIds`、`onSelect`
- 输出：多选模式下每张卡片/每行渲染 `role="checkbox"` 勾选框
- 验收标准（`npx vitest run src/renderer/components/gallery` 全通过）：
  1. `multiSelectMode` 未传 / `false` 时，5 个视图均**不渲染**勾选框（既有断言不破）
  2. `multiSelectMode=true` 时渲染勾选框，点击触发 `onSelect` 且**不冒泡**到卡片
  3. `aria-checked` 与选中态一致
  4. `TimelineView` / `EventTimelineView` 传入 `selectedIds` 后选中项正确高亮

### T5 工具栏按钮 + `GalleryPage` 接线 + i18n

- 修改文件：
  - `src/renderer/components/gallery/GalleryToolbar.tsx`（新增「选择 / 退出选择」按钮）
  - `src/renderer/pages/GalleryPage.tsx`（接线）
  - `src/renderer/i18n/locales/*.json`（12 个语言文件）
- 输入：用户点击「选择」按钮
- 输出：进入多选模式、勾选框出现、批量操作栏按既有条件出现
- 验收标准：
  1. `GalleryToolbar` 存在 `aria-pressed` 的「选择」按钮，多选态文案切换
  2. `GalleryPage` 在多选模式下裸点**不打开全屏**（结构性断言 + 逻辑单测）
  3. `handleSelectAll` 具备 toggle 语义
  4. `npm run sync-i18n-keys` 后 12 语言 key 齐平，`npm run i18n:check` 通过
  5. `npx vitest run src/renderer/pages src/renderer/components/gallery` 全通过

### T6 节点级 + 全局级回归

- 验收标准：
  1. `npm run typecheck` exit 0
  2. `npm run lint` 无新增问题（历史基线：仅 `.cache/`、e2e/fullscreen-diagnose.e2e.ts、scripts/after-pack-vc-runtime.cjs 三处）
  3. 全量 `npm test` 无新增失败（基线 263 文件 / 4476 用例）
  4. `npm run i18n:check` 通过

---

## 6. 测试用例清单（正常 / 异常 / 边界 三类全覆盖）

### 6.1 `src/renderer/stores/uiStore.test.ts`（追加）

| 类别 | 用例                                                                  |
| ---- | --------------------------------------------------------------------- |
| 正常 | `multiSelectMode` 默认 `false`；`setMultiSelectMode(true/false)` 生效 |
| 正常 | 三大板块互切后选中态与模式被清理                                      |
| 边界 | 同板块重复 `navigateTo`（`viewStack` 末位相同）不触发清理             |
| 异常 | `partialize` 不含 `multiSelectMode`（结构性断言）                     |

### 6.2 `src/renderer/hooks/useMultiSelection.test.ts`（新建）

| 类别 | 用例                                                                      |
| ---- | ------------------------------------------------------------------------- |
| 正常 | enter / exit / toggle / toggleSelectAll / invert / isSelected 全链路      |
| 正常 | exit 后 `selectedIds` 为空                                                |
| 异常 | `files` 为 `null` / `undefined` / `{}` / `'str'` → 不抛错，`totalCount=0` |
| 边界 | `files = []` 时 `toggleSelectAll` no-op；`isAllSelected === false`        |
| 边界 | `files` 含重复 id → 去重后 `selectedCount` 正确                           |

### 6.3 `src/renderer/components/gallery/MediaCheckbox.test.tsx`（新建）

| 类别 | 用例                                                     |
| ---- | -------------------------------------------------------- |
| 正常 | 渲染 `role="checkbox"`，点击触发 `onChange(true/false)`  |
| 正常 | `aria-checked` 随 `checked` 变化；选中态显示 `IconCheck` |
| 异常 | 点击勾选框**不冒泡**到父容器（父 `onClick` 不被调用）    |
| 边界 | `checked=false` 时不渲染勾选图标                         |

### 6.4 `src/renderer/components/gallery/SelectionWiring.test.tsx`（新建）

| 类别 | 用例                                                                |
| ---- | ------------------------------------------------------------------- |
| 正常 | 源码结构性断言：5 个视图组件均声明 `multiSelectMode?: boolean` prop |
| 正常 | 源码结构性断言：`GalleryToolbar` 含 `aria-pressed` 选择按钮         |
| 边界 | `GalleryPage.tsx` 中 5 个视图调用点均透传 `multiSelectMode`         |

---

## 7. TDD 执行纪律

每个节点严格按以下顺序，**不得颠倒、不得跳过**：

1. 编写能复现需求的测试用例
2. 运行并**确认测试失败**（红灯），记录失败输出
3. 修改业务代码实现功能
4. 重跑测试**确认通过**（绿灯）
5. 运行该节点的回归子集

**硬性要求**：若某个回归测试在修复前就已通过，说明该用例未覆盖当前逻辑，必须重写用例后重跑。

---

## 8. 手动冒烟清单（仅当环境可启动 Electron 时）

1. 进入「图库」→ 点击工具栏「选择」→ 卡片出现勾选框
2. 点击单个勾选框 → 该项选中，底部批量操作栏出现
3. 点击「全选」→ 全部选中；再点击 → 全部取消（文案切换为「取消全选」）
4. 点击「反选」→ 选中态反转
5. 点击「删除」→ 弹出确认框，确认后批量删除并清空选中
6. 点击「退出选择」→ 勾选框消失，选中清空
7. 切换到「截图」板块 → 选中态不残留
8. 切换到「收藏」板块重复 1-6 步
9. 切换视图形态（网格/列表/时间轴/瀑布流/事件时间轴）→ 每种形态均可勾选

---

## 9. 不触碰清单

- `docs/IPC_CONTRACT.md`（本次无 IPC 变更）
- 主进程 `src/main/**` 全部代码
- `BatchActions.tsx` 内部实现
- `release/`、`Za/`、`node_modules/`
- 既有 `toggleMediaSelection` 的 O(n) 实现（已知权衡，改动会放大回归面，本次不实施）
