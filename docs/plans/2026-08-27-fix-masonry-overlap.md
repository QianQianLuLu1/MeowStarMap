# 修复图库「瀑布流视图」图片重叠

> 状态：已执行完成（2026-08-27）
> 范围：`src/renderer/components/gallery/MasonryView.tsx`（仅此文件 + 新增单测）

## 问题根因

原 `MasonryView` 使用 `react-virtuoso` + 固定 600px 的 **band 切片**：每个 band 包含「与该 y 区间重叠」的全部 item，并在 band 内按 `top = y - band.start` 绝对定位。
跨 band 边界的同一张图片会被**重复渲染**到相邻 band，而两个 band 在滚动容器中的绝对位置使该图片的两份拷贝落在**完全相同的视觉坐标**上，从而形成重叠/重影。

## 技术选型（优先复用成熟开源方案）

引入 GitHub 开源库 **`masonic`**（v4，jaredLunde/masonic），复用其布局内核：
`usePositioner` / `useResizeObserver` / `useMasonry`。

- `masonic` 自动用 `ResizeObserver` 测量每项真实高度、计算最短列位置，且**每个元素仅渲染一次**，从根因消除重叠。
- 默认 `<Masonry>` 组件依赖 window 滚动，本项目图库为「内层滚动容器」，因此仅借用其布局内核，自行提供 `scrollTop` / `height` 数据源（容器滚动监听），不重新实现绝对定位与虚拟化算法。

## 依赖声明

| 依赖                                          | 类型         | 版本                       | 说明                                                               |
| --------------------------------------------- | ------------ | -------------------------- | ------------------------------------------------------------------ |
| `masonic`                                     | dependencies | `^4.0.0`（安装锁定 4.1.0） | 虚拟化瀑布流布局内核，支持 React 18+/19，自带类型与 ResizeObserver |
| `react` / `react-dom`                         | peer         | 已有 `^19.2.7`             | 宿主 React                                                         |
| `vitest` / `@testing-library/react` / `jsdom` | dev          | 已有                       | 测试运行器与 DOM 环境                                              |

安装命令（增量，禁用 `npm ci` 以绕开本机 Safe-Delete 网关）：

```bash
npm install masonic@^4.0.0
```

## 启动 / 验证说明

- 开发预览：`npm run dev` → 进入「图库」→ 切换为瀑布流视图 → 滚动确认无重叠/重影。
- 类型检查：`npm run typecheck`
- 代码风格：`npx eslint src/renderer/components/gallery/MasonryView.tsx`
- 单元用例：`npx vitest run src/renderer/components/gallery/MasonryView.test.tsx`
- 构建（受限环境）：`npx electron-vite build`（产物已含 `dist/main/package.json {"type":"commonjs"}`）

## 错误处理 & 参数校验

- `files` 必须为数组；非数组时 `console.warn` 并渲染空 `role="feed"` 容器，不向上抛错。
- 单项 `id` 必须为字符串；非法项被过滤。
- `onSelect` / `onContextMenu` 缺失或非函数时降级为 no-op，点击/右键不报错。
- 渲染期异常由 `GalleryPage` 既有 `ErrorBoundary` 捕获并上报主进程。
- 图片加载失败沿用 `useFailedImages`：`onError` 后降级为 `MediaThumbPlaceholder`。

## 基础测试用例（`MasonryView.test.tsx`，已通过 5/5）

1. **无重叠**：12 张不同宽高比图片固定 1200×4000 容器，断言 `.media-card` 数量 = 12 且 `data-media-id` 唯一（无重复 DOM）。
2. **空数组**：`[]` → 0 张卡片，存在 `role="feed"` 容器。
3. **非法 files**：`null` → 不抛错、空容器、`onSelect` 未调用。
4. **选中态与点击**：`selectedIds=['2']`，点击对应卡片 → `onSelect` 以 `('2', index, event)` 调用。
5. **失败占位**：模拟 `img` `error` → 该卡片缩略图移除、降级占位，其余卡片不受影响。

## 子任务与验收

### A. 安装并验证 masonic

- 文件：`package.json`、`package-lock.json`
- 输入：无 / 输出：`masonic` 安装、lockfile 更新
- 验收：`npm ls masonic` 显示 4.1.0；`npm run typecheck` 无 MasonryView 相关错误；peer React 19 兼容。

### B. 用 masonic 重构 MasonryView

- 文件：`src/renderer/components/gallery/MasonryView.tsx`
- 输入：原 band 切片实现 + `GalleryPage` 调用点（props 不变）
- 输出：基于 `useMasonry` 的新实现，保留缩略图/文件名浮层/选中高亮/缺失·损坏角标/失败占位
- 验收：`npm run typecheck` 通过；`eslint` 0 错误；`npm run dev` 瀑布流无重叠；**未触碰** `BatchActions.*`、`ShareMenuButton.tsx`、`globals.css` 等无关文件。

### C. 新增单测

- 文件：`src/renderer/components/gallery/MasonryView.test.tsx`（新增）
- 输入：重构后组件 + mock 数据 / 输出：5 个用例
- 验收：`npx vitest run ...` 全部通过（本机 vitest 实际可运行，5 passed）。

### D. 构建与回归

- 文件：仅上述文件
- 输入：B/C 结果 / 输出：构建成功、无回归
- 验收：`npx electron-vite build` 成功（`dist/main/main/index.js` + `dist/main/package.json` 存在）；Grid/List/Timeline 等视图未被改动；`typecheck`/`eslint` 对本次改动 0 错误。

## 结果

- 重叠/重影问题从根因消除（band 重复渲染被移除，改用 masonic 单实例定位）。
- 新增依赖 `masonic@4.1.0`，本地 `npm install` 增量成功。
- 类型检查、ESLint、5 项单测、electron-vite 构建均通过。
- 未改动任何与问题无关的功能或文件。
