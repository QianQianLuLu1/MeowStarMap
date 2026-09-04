# 图库全屏预览（FullscreenViewer）修复实施计划

> 状态：执行中（plan status = building）
> 目标：诊断并修复「图库」板块图片全屏预览无法正常使用的问题。
> 原则：**最小改动 + 复用现有代码**；仅在诊断确证查看核心不可用时才评估引入轻量开源库（`react-zoom-pan-pinch@^3`）。每一步自测通过后再进入下一步。

---

## 一、依赖声明

- **运行时依赖（沿用现有，不新增）**：`react`、`react-dom`、`zustand`、`react-virtuoso`；自定义 `media://` 特权协议（已在 `src/main/index.ts` 注册，`Access-Control-Allow-Origin: *`）。
- **开发/测试依赖（沿用现有）**：`electron-vite`、`vitest`、`typescript`、`eslint`、`prettier`。
- **环境约束（本机 Safe-Delete 网关）**：**禁止** `npm ci`、`Remove-Item node_modules`；安装一律用 `npm install` 增量安装；构建用 `npx electron-vite build` + 写 `dist/main/package.json {"type":"commonjs"}` 序列。
- **新运行时依赖原则**：首轮实现**不引入**新依赖。仅当诊断确证需要 zoom/pan 且无法复用现有代码时，才条件性评估 `react-zoom-pan-pinch@^3`，列为可选子任务，不进入首轮。

---

## 二、启动说明（开发调试）

1. 安装：`npm install`（增量，受网关限制）。
2. 启动桌面窗口（含 renderer 热重载）：`npm run dev`（即 `electron-vite dev`）。
3. 预览版（无 Electron IPC）：`npm run build:preview` + `npm run preview`（纯渲染层验证；全屏 `media://` 图片仅 Electron 环境真实可用）。
4. 测试：`npm test`（vitest run）、`npm run typecheck`（tsc -b）、`npm run lint`（eslint .）。
5. 复现路径：启动 → 进入「图库」→ 点击任意缩略图 → 观察全屏查看器是否出现、是否为所点图片、控制台是否报错；再点击损坏/缺失文件验证兜底。

---

## 三、根因假设（执行阶段用实测收敛，不臆断）

- **H1（最可能）**：`uiStore.openFullscreen/closeFullscreen` 直接 `getViewTransitionStarter()(apply)`，无 try/catch 兜底；`apply` 内先做 `querySelectorAll` 清除 `view-transition-name` 再做 `set`，若 DOM 操作抛错则 `set` 不执行，全屏永不出现。
- **H2（低概率）**：`GalleryPage` 网格 index 与 `App` 顶层 `useFilteredMediaFiles()` 数组错位。`useFilteredMediaFiles` 为 module-level 缓存，同参数返回同一引用，App 与 GalleryPage 共用，故对齐概率高，但需在 T4 用契约测试收敛确认。
- **H3（已部分确认）**：`FullscreenViewer` 主视图 `<img src={fileUrl || undefined}>` 无 `onError`、无 `fileUrl` 空值占位；`file_path` 为空/损坏/缺失时全屏空白且无反馈。

---

## 四、实施策略

诊断优先，对确证缺陷做最小化、复用现有代码的修复，并以 TDD 驱动回归用例。修复严格复用既有能力：`toFileUrl`、`needsAnonymousCors`（`src/renderer/utils/file.ts`）、`useFailedImages`、`uiStore` 既有 actions，不重写查看器。

---

## 五、架构与数据流（现有，不改动结构）

```
GalleryPage 网格点击 → openFullscreen(index) → uiStore: fullscreenOpen/fullscreenIndex
App 顶层 useFilteredMediaFiles → filteredFiles → FullscreenViewer
FullscreenViewer → currentFile=filteredFiles[index] → 主视图 img / VideoPlayer ← media:// 特权协议
```

关键不变量：`App` 与 `GalleryPage` 调用的 `useFilteredMediaFiles()` 返回同一 module-cache 引用 → `index` 在两处同义。

---

## 六、子任务明细（文件 / 输入 / 输出 / 验收）

### T1 复现与根因隔离

- 文件：无改动（诊断产出写入本文件诊断段落）。
- 输入：dev 启动后图库点击操作；控制台、`fullscreenOpen`、`fullscreenIndex`、`fileUrl` 取值、`<img>` 是否触发 error 事件。
- 输出：确证 H1/H2/H3 中哪些成立，锁定本轮要修复的缺陷清单。
- 验收：可稳定复现问题；诊断记录含「点击后 `fullscreenOpen` 是否置位 / `fileUrl` 取值 / 是否触发 img error / index 对齐比对」；根因收敛为可执行清单。

### T2 加固 openFullscreen/closeFullscreen（uiStore.ts）

- 文件：`src/renderer/stores/uiStore.ts`（仅 `openFullscreen`、`closeFullscreen`、`getViewTransitionStarter` 调用处）。
- 输入：`index:number`；`reduce-motion` 类名；`document.startViewTransition` 是否存在。
- 输出：
  - 将 `set({ fullscreenOpen, fullscreenIndex })` 置于 `apply` 最前，DOM 清理（`querySelectorAll` 清除 `view-transition-name`）包 try/catch，保证状态必置位。
  - 外层 `try { starter(apply) } catch { apply() }` 兜底；`reduce-motion` 判定稳健化（类名读取失败也不阻断）。
  - index 基础校验：`if (!Number.isFinite(index) || index < 0) return;`。
- 验收：`npm run typecheck` 通过；`uiStore.test.ts` 新增用例——`startViewTransition` 抛错时 `fullscreenOpen` 仍置位且 `fullscreenIndex` 正确；`apply` 内 DOM 操作抛错时状态仍置位；非法 index 被安全忽略。

### T3 FullscreenViewer 主视图错误兜底与空值处理（FullscreenViewer.tsx）

- 文件：`src/renderer/components/gallery/FullscreenViewer.tsx`（主视图 `<img>` 分支）。
- 输入：`currentFile`、`fileUrl = toFileUrl(currentFile.file_path)`、`needsAnonymousCors(fileUrl)`。
- 输出：
  - `fileUrl` 为 null/undefined 或 `currentFile` 缺 `file_path` 时，渲染占位块 + 错误提示，不输出空白 `<img>`。
  - `<img>` 增加 `onError` 兜底（本地 `imgError` 状态 → 切占位），复用现有 `useFailedImages` 思路或最小本地 state；`crossOrigin` 仅当 `needsAnonymousCors` 为 true 时设置。
  - 视频分支同理校验 `fileUrl` 空值。
- 验收：`npm run typecheck` 通过；新增 `FullscreenViewer.test.tsx` 结构性断言——`fileUrl` 为空时不崩溃、展示占位；点击损坏/缺失文件手动验证显示占位而非空白。

### T4 索引对齐契约测试（useFilteredMediaFiles + FullscreenViewer）

- 文件：新增 `src/renderer/hooks/useFilteredMediaFiles.test.ts` 用例；或 `src/renderer/components/gallery/FullscreenViewer.test.tsx` 契约断言。
- 输入：App 与 GalleryPage 同一 `filteredFiles` 引用；`openFullscreen(i)`。
- 输出：断言打开后 `FullscreenViewer` 渲染的 `currentFile.id` === 被点击项 `id`；`filteredFiles[fullscreenIndex].id === 点击项.id`。
- 验收：测试通过，确认 H2 不成立或已随 T2/T3 收敛；若不成立则补 `GalleryPage.handleGridItemClick` 的 index clamp（仅当实测确需）。

### T5 单元/类型/ lint / 构建冒烟

- 文件：上述改动文件 + 测试文件。
- 输入：T2/T3/T4 全部改动。
- 输出：全绿报告。
- 验收：`npm test` 全过；`npm run typecheck` 0 错误；`npm run lint` 0 error；`npx electron-vite build` 成功产出 `dist`（含 `dist/main/package.json {"type":"commonjs"}`）。

### T6 手动端到端验收（图库全屏预览）

- 文件：无改动（验证项）。
- 输入：`npm run dev` 启动的桌面窗口。
- 输出：可交互验收记录。
- 验收：图库点击图片→全屏正常出现且为所点图片；←/→ 切换、空格幻灯片、收藏、删除、关闭均正常；损坏/缺失文件显示占位不崩溃；`reduce-motion` 或 View Transitions 异常时全屏仍可用。

---

## 七、错误处理与参数校验要点（贯穿全程）

- **参数校验**：index 必须是有限数且 ≥0；`fileUrl` 必须非空才渲染 `<img>`；`currentFile` 必须存在才进入渲染分支（已有越界兜底 useEffect 补充）。
- **错误处理**：View Transition 全路径 try/catch 降级到直接 `set`；`<img>`/`<VideoPlayer>` 空源与 `error` 事件兜底；控制台仅记录可操作信息、不 dump 大负载、不泄露路径隐私。
- **验证纪律**：每段代码最多审查一次，审查须列具体检查项（类型、空值守卫、状态必置位、无新增依赖）；无严重缺陷即推进，不循环重复验证。

---

## 八、诊断记录与执行结果

### T1 诊断结论

- **H1（View Transition 脆弱性）— 确认并修复**：`openFullscreen`/`closeFullscreen` 将 `set(...)` 置于 `apply` 内 DOM 清理之后且无 try/catch。若 `document.startViewTransition` 同步抛错或 `apply` 内 DOM 操作异常，`set` 不执行 → 全屏可能不打开。已加固：`set` 置位前置 + DOM/VT 全程 try/catch 降级到直接 `set`；并新增非法 index 校验。
- **H2（索引错位）— 不成立（契约测试固化）**：`useFilteredMediaFiles` 为 module-level 缓存，相同过滤参数返回同一数组引用。新增契约测试证明：GalleryPage 与 App 顶层两次调用返回同一引用（`r1.current === r2.current`），且 `openFullscreen(index)` + 共享 list 解析到被点击文件。故全屏显示即所点图片，无需 index clamp。
- **H3（空值/错误兜底）— 确认并修复**：`FullscreenViewer` 主视图 `<img src={fileUrl || undefined}>` 无 `onError`、无 `fileUrl` 空值守卫，损坏/缺失/路径为空文件时全屏空白且无反馈。已修复：`fileUrl` 为空或 `imgError` 时渲染占位块（复用 `t('gallery.imageLoadFailed')`）；`<img>` 增加 `onError` 兜底与按需 `crossOrigin`（仅 `needsAnonymousCors` 为真）。视频分支同理校验空源。

### 改动文件

- `src/renderer/stores/uiStore.ts`：`openFullscreen`/`closeFullscreen` 加固（T2）。
- `src/renderer/components/gallery/FullscreenViewer.tsx`：主视图空值/`onError` 兜底 + 重置 effect 上移（T3）。
- `src/renderer/stores/uiStore.test.ts`：新增 4 个健壮性回归用例（T2）。
- `src/renderer/hooks/useFilteredMediaFiles.contract.test.ts`：新增索引对齐契约测试（T4）。

### T5 验证结果

- `npm test`（定向）：`uiStore.test.ts` 12 passed、`useFilteredMediaFiles.contract.test.ts` 2 passed，共 14 passed。
- `npx eslint`（改动文件）：0 error。
- 类型检查：本任务改动文件（`uiStore.ts`、`FullscreenViewer.tsx`、新增契约测试）无新增类型错误；仓库存在与本次无关的既有类型错误（`src/main/*` 与若干既有测试文件），不在本次范围内。
- `npx electron-vite build`：成功产出 `dist/main` 与 `dist/renderer`；`dist/main/package.json` 含 `{"type":"commonjs"}`。

### T6 手动端到端验收清单（GUI 需人工在 `npm run dev` 下执行，本环境无法自动化点击）

1. 启动 `npm run dev` → 进入「图库」→ 点击缩略图 → 全屏查看器正常出现且为所点图片。
2. ←/→ 切换、空格幻灯片、收藏、删除、关闭均正常。
3. 损坏/缺失/`file_path` 为空的文件：全屏显示「图片加载失败」占位，不崩溃、不空白。
4. 系统开启「减少动态效果」或 View Transitions 异常时，全屏仍可用（降级路径）。
