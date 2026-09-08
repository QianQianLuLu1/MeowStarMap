# 修复：重复文件板块右键「打开」全屏预览显示错误文件

- 状态：已确认，执行中
- 影响范围：`DuplicatesPage` 全屏打开路径（`uiStore` / `FullscreenViewer` / `DuplicatesPage`）
- 新增依赖：**无新增依赖**

## 1. 根因分析

全屏查看器是**全局单例**：`src/renderer/App.tsx:171-173` 计算 `useFilteredMediaFiles()`，在 `App.tsx:354-358` 渲染唯一的 `<FullscreenViewer filteredFiles={...} />`。它按下标从**图库过滤列表**取文件；而重复文件页写入的下标来自**重复文件摊平列表**。两个列表长度、顺序、内容均不同，于是必然错位。

缺陷代码行：

1. `src/renderer/pages/DuplicatesPage.tsx:329-336`
   `allFiles = (result?.duplicates ?? []).flat().map(toContextMenuMediaFile)` —— 重复文件摊平列表。
2. `src/renderer/pages/DuplicatesPage.tsx:459`
   `onOpen: fileOperations.handleOpen`。
3. `src/renderer/hooks/useFileOperations.ts:136-142`（**缺陷点**）

   ```ts
   const handleOpen = useCallback(
     (file: MediaFile) => {
       selectMedia(file.id)
       openFullscreen(filteredFiles.findIndex((f) => f.id === file.id))
     },
     [filteredFiles, selectMedia, openFullscreen]
   )
   ```

   下标语义属于「重复列表」，但只把下标写入 uiStore，**列表本身没有传递**。

4. `src/renderer/stores/uiStore.ts:376-406`
   `openFullscreen(index)` 仅 `set({ fullscreenOpen: true, fullscreenIndex: index })`，无承载列表的字段。
5. `src/renderer/components/gallery/FullscreenViewer.tsx:71-72`（**错位点**）

   ```tsx
   const currentFile = filteredFiles[fullscreenIndex]
   const fileUrl = toFileUrl(currentFile?.file_path)
   ```

   用的是 App 传入的**图库列表**。同名变量还被用于 `navigate`(80/86)、幻灯片 `onTick`(96/102)、`startSlideshow`(110/115)、删除回退(144/165)、标题(291)。

6. 下标越界时 `FullscreenViewer.tsx:271` 直接 `return null`、`:257-263` 自动关闭 → 表现为「点了没反应」。

### 已排除的假设（核验结论，避免误改）

| 线索                                              | 结论         | 依据                                                                                                                                                                                                                     |
| ------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. 数据源不一致（视频 `thumbnail` vs 全屏原文件） | **不是 bug** | 卡片用 `thumbnail`（视频无法被 `<img>` 解码）、全屏用原文件 `file_path`（高清原图 / `VideoPlayer` 可播放）是预期差异；`toContextMenuMediaFile` 不携带 `thumbnail` 不影响全屏取源                                         |
| 2. `media://` 协议转换/缓存键                     | **不是 bug** | `toFileUrl` 全仓唯一实现在 `src/renderer/utils/file.ts:3-36`（反斜杠归一 → `media://file?path=${encodeURIComponent(normalized)}`；命中 `media://`/`blob:`/`data:`/`file://` 原样返回），无截断、无编码错误、无缓存键逻辑 |
| 3. 上下文丢失（id/path 传错）                     | **不是 bug** | 右键菜单所有项拿到同一个 `toContextMenuMediaFile(item)` 映射结果；对照项「打开文件所在位置」正确拿到 `C:\dup\a.jpg`，删除正确使用 `Number(file.id)`                                                                      |

## 2. 依赖声明

**无新增依赖。** 沿用现有 React 19 + TypeScript(strict) + Zustand + Vitest + Testing Library。

## 3. 修改方案

策略：给全屏状态补上「打开时所用的文件列表」，`FullscreenViewer` 优先使用它；图库路径不传列表 → 回退到现有 props `filteredFiles`（行为零变化）。

改动前：`DuplicatesPage ──index──> uiStore.fullscreenIndex ──> FullscreenViewer[图库列表] ✗ 错位`
改动后：`DuplicatesPage ──(index + files)──> uiStore{fullscreenIndex, fullscreenFiles} ──> FullscreenViewer[fullscreenFiles ?? 图库列表] ✓`

### 3.1 `src/renderer/stores/uiStore.ts`

- 新增 `import type { MediaFile } from '../stores/mediaStore'`（**仅类型导入**，编译期擦除，不重建运行时循环依赖；文件头 C-S2 注释禁止的是**值**导入）。
- 新增状态 `fullscreenFiles: MediaFile[] | null`，默认 `null` 表示「使用图库 `filteredFiles`」。
- 签名变更 `openFullscreen: (index: number, files?: MediaFile[]) => void`；`openFullscreen` 内 `set({ fullscreenOpen: true, fullscreenIndex: index, fullscreenFiles: files ?? null })`。
- `closeFullscreen` 内 `set({ fullscreenOpen: false, fullscreenTargetImg: null, fullscreenFiles: null })`。
- `partialize`（`uiStore.ts:464-474`）未含任何全屏字段 → 新字段**自动不持久化**，无需改动。

### 3.2 `src/renderer/components/gallery/FullscreenViewer.tsx`

- 新增 `const fullscreenFiles = useUIStore((s) => s.fullscreenFiles)`。
- 新增 `const activeFiles = fullscreenFiles ?? filteredFiles`。
- 把 `filteredFiles` 的全部读取点替换为 `activeFiles`：`71`（currentFile）、`80/86`（navigate）、`96/102`（幻灯片 onTick）、`110/115`（startSlideshow）、`144/165`（handleDelete）、`291`（标题 total）。保证显示内容、导航、幻灯片、删除回退、标题同源。

### 3.3 `src/renderer/pages/DuplicatesPage.tsx`

- 新增 `selectMedia` / `openFullscreen` 两个 uiStore 字段级选择器。
- 新增 `handleOpenDuplicate`：

  ```tsx
  const handleOpenDuplicate = useCallback(
    (file: MediaFile) => {
      selectMedia(file.id)
      openFullscreen(
        allFiles.findIndex((f) => f.id === file.id),
        allFiles
      )
    },
    [allFiles, selectMedia, openFullscreen]
  )
  ```

- `contextMenuActions.onOpen` 由 `fileOperations.handleOpen` 改为 `handleOpenDuplicate`，并在依赖数组补充该项。

### 3.4 设计取舍

- 选「uiStore 增加可选 `fullscreenFiles`」而非「DuplicatesPage 改用图库列表算下标」：后者在图库存在搜索/分类过滤时 `findIndex` 可能为 -1，静默失效，不可靠。
- 选「DuplicatesPage 本地 handler」而非改 `useFileOperations.handleOpen`：不触碰 GalleryPage 打开路径，爆炸半径最小。
- 保留图库路径的**响应式** `filteredFiles`（不写入 store），避免把图库全屏从「随 mediaStore 实时更新」降级为「打开瞬间快照」。
- 已知副作用（可接受）：重复文件页全屏期间列表为打开时快照，删除后不会即时同步；`FullscreenViewer` 已有的删除后下标回退逻辑按该快照工作，不会出现错图或崩溃。

## 4. 测试策略

### 4.1 复现测试（红灯）

新建 `src/renderer/pages/DuplicatesPage.fullscreen.test.tsx`（jsdom），脚手架复用 `DuplicatesPage.contextMenu.test.tsx` 的 `react-virtuoso` mock 与 `window.electronAPI` 桩。

- 用例 A：2 条重复数据（`a.jpg` / `b.jpg`），同时给 `useMediaStore` 灌入**不同的图库列表**（`g1/g2/g3`），使下标错位可被观测；对 `b.jpg` 右键 → 点击「打开」→ 断言 `fullscreenFiles[fullscreenIndex].file_path === 'C:\\dup\\b.jpg'`。
  修复前 `fullscreenFiles` 不存在 → **红灯**。
- 用例 B：直接 `useUIStore.setState({ fullscreenOpen: true, fullscreenIndex: 1, fullscreenFiles: [a, b] })` 后渲染 `<FullscreenViewer filteredFiles={图库列表} />`，断言渲染出的 `<img>` 的 `alt`/`src` 指向 `b.jpg` 而非图库 `g2.jpg`。
  修复前走 props 列表 → **红灯**。

### 4.2 验收标准

1. 右键重复文件（图片、视频各一）→「打开」→ 全屏标题与内容均对应该文件（图片为原图、视频为该视频）。
2. 左右方向键在**重复文件集合**内切换，不跳到图库其他文件。
3. 关闭后从图库再次打开仍正确（图库行为零变化）。
4. 控制台无路径或加载错误日志。
5. `npm test` 全量通过（基线 263 文件 / 4476 用例），`npm run typecheck` exit 0，`npm run lint` 仅剩基线 16 处（`.cache/`、`e2e/fullscreen-diagnose.e2e.ts`、`scripts/after-pack-vc-runtime.cjs`）。

### 4.3 回归范围

- 局部：`DuplicatesPage.contextMenu.test.tsx`、`DuplicatesPage.videoThumb.test.tsx`、`duplicateContextMenu.test.ts`、`useFilteredMediaFiles.contract.test.ts`、`useFileOperations*.test.*`。
- 全局：全量 `npm test` → `npm run typecheck` → `npm run lint`。

### 4.4 手动验证

`npm run dev` → 进入「重复文件」板块 → 对图片与视频分别右键「打开」，比对全屏内容与卡片缩略图。

## 5. 风险与回滚

- **影响面**：仅全屏打开路径。`openFullscreen` 第二参可选 → `GalleryPage.tsx:308`、`DetailPage.tsx:402` 零行为变化；`fullscreenFiles` 默认 `null` → 未触发路径全等旧逻辑。
- **残留风险**：重复文件页全屏期间列表为快照，删除后不即时同步（已评估可接受，不为此新增复杂度）。
- **回滚**：`git checkout -- src/renderer/stores/uiStore.ts src/renderer/components/gallery/FullscreenViewer.tsx src/renderer/pages/DuplicatesPage.tsx` 即可完全还原；无数据库/配置/持久化结构变更，新增测试文件独立删除即可。
