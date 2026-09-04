# 修复「重复文件」板块视频缩略图无法预览

- 状态：执行中（building）
- 创建日期：2026-08-31
- 关联计划 ID：5344f9e399554968af90b872b8599945

## 1. 缺陷现象

「重复文件」板块（`DuplicatesPage`，含精确重复 / 相似检测两种模式）中，视频条目的卡片缩略图区域**空白或裂图**：既看不到视频首帧预览，也不会退化成视频占位图标；图片条目正常。

## 2. 根因（只读阶段已逐行核对实码）

三段链路缺一不可：

- **数据层未携带缩略图**：`media_files` 表有 `thumbnail` 列（ffmpeg 抽帧后的 jpg 路径，`src/main/database/connection.ts:1093`），但重复检测相关的 3 处 SELECT（`getDuplicateCandidates` / `getDuplicateGroupRows` / `getOriginalsByIds`）与相似检测 worker 的 SELECT 都没查该列；对应行类型 `DuplicateCandidateRow` / `DuplicateGroupRow` / `OriginalRow` 及 worker 的 `BkRow`/`SimilarRowMeta` 均无该字段。
- **IPC 契约缺字段**：共享类型 `DuplicateItem`（`src/shared/types/duplicate.ts`）及 `duplicate-handler.ts` 内部映射（含一份与 shared 重复的本地 `interface DuplicateItem`）均无 `thumbnail`，前端拿不到缩略图路径。
- **渲染层把原视频当图片源**：`DuplicatesPage.tsx` 的 `DuplicateFileCard` 直接 `toFileUrl(file.file_path)` 塞进 `<img src>`，`file_path` 恒非空导致占位图标分支永不生效，且无 `onError` 兜底 → 视频必然裂图。图库侧同一缺陷早已修复（`VirtualImageGrid.tsx:365-367` 已改成 `file.file_type === 'video' ? file.thumbnail : file.thumbnail || file.file_path`，并有回归测试 `VirtualImageGrid.thumb.test.tsx`），重复文件板块未同步。

## 3. 修复后功能与视觉效果

- 视频条目显示 ffmpeg 抽帧首帧缩略图（与图库、回收站一致的观感）。
- 库中暂无缩略图的视频：自动按需触发一次缩略图生成，成功后原位刷新为首帧预览。
- 生成失败 / 加载失败：稳定降级为居中的视频占位图标（不再空白、不再裂图）；右下角「视频」角标与推荐保留、选中角标全部保持。
- 图片条目行为完全不变；卡片布局、尺寸、交互（点击选中、右键菜单、键盘操作）零变化。

## 4. 依赖声明

**本次不新增、不升级、不移除任何 npm 依赖，无需 `npm install`。**

视频抽帧（`fluent-ffmpeg`）、img 占位/错误兜底（`MediaThumbnail` + `MediaThumbPlaceholder`）、`media://` URL 转换（`toFileUrl`）在仓库内均已有成熟实现，直接复用。本机 npm 有 Safe-Delete 网关，禁止 `npm ci`／删除 `node_modules`。

## 5. 技术栈（沿用现有）

- Electron 40.10 + Vite（electron-vite） + React 18 + TypeScript + Tailwind
- 数据层：better-sqlite3（`media_files.thumbnail` 列已存在）
- 缩略图：`sharp` + `fluent-ffmpeg`（`src/main/thumbnail/generator.ts`，0s 失败自动重试 1s）
- 渲染层资源协议：`media://`（`toFileUrl`，`src/renderer/utils/file.ts`），白名单已放行缩略图缓存目录
- 测试：vitest；类型 `tsc -b`；静态 `eslint .`；格式 `prettier --check`

## 6. 实施策略

沿「数据层 → IPC 契约 → 渲染层」最短链路补齐 `thumbnail` 字段传递，渲染层复用已有公共组件 `MediaThumbnail` 与图库已验证的"视频不得回退到原文件"取源规则，再补一层「缺缩略图时按需生成一次」的兜底。

关键决策：

1. 复用 `MediaThumbnail`（`src/renderer/components/common/MediaThumbnail.tsx`，已封装 img + 占位图 + onError 兜底），净代码量为负增长。
2. 取源规则严格照抄图库已验证写法：`toFileUrl(file.file_type === 'video' ? file.thumbnail : file.thumbnail || file.file_path)`。
3. 共享契约字段设为可选 `thumbnail?: string | null`（`DuplicateItem` 与 `SimilarRowMeta`），仓库内部行类型设为必填 `string | null`，保证 SELECT 与类型同步。
4. 按需生成走已存在的 `thumbnail:generate` IPC（`window.electronAPI.thumbnail.generate(filePath, quality?)`），不新增通道、不改 preload、不动安全边界。
5. 不写库、不改扫描器：按需生成只取返回路径用于本次显示，不回写 `media_files.thumbnail`（持久化由既有批量任务负责）。

性能：3 处 SELECT 各多取一个 TEXT 列，无索引/额外查询变化；虚拟化列表约束下按需生成请求量 ≈ 实际可见视频数；模块级 `Map` 尝试缓存做单次守卫（含 null 结果不重试）；主进程侧 `generatingLocks` + `decodeLimiter` 已控并发。

## 7. 启动与验证说明

- 环境准备：Node 已就绪，无需 `npm install`。
- 开发态验证：`npm run dev` → 侧边栏「重复文件」→ 点击扫描（精确重复 / 相似检测各一次）→ 观察视频卡片显示首帧缩略图；删掉缓存 jpg 再进入，观察是否稳定降级为视频图标而非空白。
- 自动化验证命令（均已在 `package.json` 真实存在）：
  - 单文件：`npx vitest run <测试文件路径>`
  - 子集：`npm run test:db`、`npm run test:main`、`npm run test:renderer`
  - 全量：`npm run test`
  - 类型：`npm run typecheck`（基线 exit 0，零错误）
  - 静态：`npm run lint`、`npm run format:check`

## 8. 错误处理

- 渲染层按需生成的 `useEffect` 内 `try/catch` 静默降级（保持 `catch {}`，与 `VirtualImageGrid` 风格一致，避免滚动刷屏）。
- `useEffect` 用 `cancelled` 标志位在 unmount 后不再 `setState`，避免 React 警告。
- 主进程侧解码失败已由 `generator.ts` 的 `markCorrupted` + `logger.error` 覆盖，不重复打日志、不落用户路径 PII 到新位置。
- `thumbnail` 为 `NULL` / `''` 的历史行必须稳定走占位图标分支，不得出现空白容器或 `<img src="">`（空串会触发浏览器重请求当前页 URL）。

## 9. 参数校验

- `toFileUrl` 已处理 `null/undefined/''`（返回 `null`）。
- 按需生成前显式判定 `file.file_type === 'video' && !file.thumbnail && typeof file.file_path === 'string' && file.file_path.length > 0`。
- 主进程 `thumbnail:generate` 侧 `schemas.filePath` + `assertFileReadPath` 已生效，不放宽任何守卫。

## 10. 基础测试用例（正常 / 异常 / 边界）

渲染层新测试 `src/renderer/pages/DuplicatesPage.videoThumb.test.tsx`（沿用 `DuplicatesPage.contextMenu.test.tsx` 的 jsdom + mock react-virtuoso + 注入 `window.electronAPI` 脚手架）：

1. **正常**：视频含 `thumbnail` → `<img>` src 指向缓存 jpg（media:// 编码后包含 `.jpg`）。
2. **异常**：视频无 `thumbnail` 且 `generate` 返回 `null` → 不渲染 `<img>`，显示视频占位图标。
3. **异常**：视频无 `thumbnail` 且 `generate` 返回路径 → 触发一次 `thumbnail.generate` 且解析后渲染 `<img>`。
4. **边界**：同一路径重复渲染只调用 `generate` 一次（模块级缓存守卫）。
5. **边界**：图片类型不触发 `generate`、且仍可回退 `file_path`。
6. **不变量**：`<img>` src 绝不包含 `.mp4`（源码级 + DOM 级双重断言，含"旧写法 `toFileUrl(file.file_path)` 不得出现"的结构性断言）。

主进程侧追加 RED 用例：

- `media-repository.test.ts`：`getDuplicateCandidates` / `getDuplicateGroupRows` / `getOriginalsByIds` 返回值含 `thumbnail` 字段（含 thumbnail / 为 NULL 两种行）。
- `media.test.ts`：`media:findDuplicates` 经 `simulateCall` 解包后 `data.duplicates[0][0].thumbnail` 等于 repo 返回值；缺失时为 `null`。
- `similar-handler.test.ts`：worker 回传 rows 含 `thumbnail` 时，输出 `items[0].thumbnail` 与之一致；缺失时为 `null`。

## 11. 目录结构与子任务（文件路径 + 输入/输出 + 验收标准）

共 10 个文件：1 个新增计划文档、1 个新增渲染层测试、4 个源码文件补契约字段、1 个源码文件（渲染层核心修复）、3 个既有测试文件追加 RED 用例。无新增目录、无新增依赖、无 i18n key 变更。

### 子任务 0：计划文档落盘

- 文件：`docs/plans/fix-duplicates-video-thumbnail.md`（本文件，新增）
- 输入：根因分析、修复方案。输出：完整实施计划。
- 验收：`docs/plans/` 下生成该 MD，含依赖声明/启动说明/错误处理/参数校验/基础测试用例/子任务清单。

### 子任务 1：数据层补字段（RED→GREEN）

- 文件：`src/main/database/media-repository.ts`（修改）
  - 行类型 `DuplicateCandidateRow`(144-155) / `DuplicateGroupRow`(190-202) / `OriginalRow`(205-216) 各加 `thumbnail: string | null`。
  - SELECT 补 `thumbnail`：`getDuplicateCandidates`(1311-1318)、`getDuplicateGroupRows`(1571-1580)、`getOriginalsByIds`(1583-1590)。
- 测试：`src/main/database/media-repository.test.ts`（追加 RED 用例）
- 验收：`npm run test:db` 中新增用例全绿；仅加列名与字段声明，不改 WHERE/ORDER BY/分块语义。

### 子任务 2：IPC 契约透传（RED→GREEN）

- 文件：
  - `src/shared/types/duplicate.ts`：`DuplicateItem`(15-26) 加 `thumbnail?: string | null`。
  - `src/main/media-worker/worker-protocol.ts`：`SimilarRowMeta`(19-29) 加可选 `thumbnail?: string | null`。
  - `src/main/media-worker/worker-entry.ts`：相似检测 SELECT（约 881 行）补 `thumbnail` 列。
  - `src/main/ipc/handlers/duplicate-handler.ts`：删除本地重复 `interface DuplicateItem`(107-118) 改为 import shared 类型；第 144-155 行 map 与第 243-254 行 `toDupItem` 各补 `thumbnail: row.thumbnail ?? null`。
  - `src/main/ipc/handlers/similar-handler.ts`：第 220-231 行 items map 补 `thumbnail: r.thumbnail ?? null`。
- 测试：`src/main/ipc/handlers/media.test.ts`、`src/main/ipc/handlers/similar-handler.test.ts`（追加 RED 用例）
- 验收：`npm run test:main` 中新增用例全绿；契约三处映射全部落地，无分叉。

### 子任务 3：渲染层核心修复（RED→GREEN）

- 文件：`src/renderer/pages/DuplicatesPage.tsx` 的 `DuplicateFileCard`(1547-1666)
  - 取源改为 `toFileUrl(file.file_type === 'video' ? file.thumbnail : file.thumbnail || file.file_path)`。
  - 用 `MediaThumbnail` 替换手写 `<img>` + 三元占位分支(1586-1598)，传入 `src/alt/fileType`，保留外层 `aspect-square` 容器与选中/收藏/视频/推荐四个角标绝对定位不变。
- 测试：`src/renderer/pages/DuplicatesPage.videoThumb.test.tsx`（新增）
- 验收：`npm run test:renderer` 中新增用例全绿；`<img>` src 绝不含 `.mp4`；视频无图稳定降级图标。

### 子任务 4：缺图视频按需生成（RED→GREEN）

- 文件：`src/renderer/pages/DuplicatesPage.tsx` 的 `DuplicateFileCard`
  - 新增「视频且 `thumbnail` 为空时经 `window.electronAPI?.thumbnail?.generate(file.file_path)` 按需生成一次」逻辑：模块级 `Map` 尝试缓存做单次守卫（含 null 结果）；`try/catch` 静默降级；`useEffect` 内 `cancelled` 标志防卸载后 `setState`；代码量 ≤ 15 行。
- 测试：并入 `DuplicatesPage.videoThumb.test.tsx`（用例 3/4/5）
- 验收：`npm run test:renderer` 中相关用例全绿；不写库、不改 preload、不动安全边界。

### 子任务 5：回归与全局校验

- 命令（依次）：`npm run test:db`、`npm run test:main`、`npm run test:renderer`、`npm run test`、`npm run typecheck`、`npm run lint`、`npm run format:check`
- 验收：对齐已知基线——全量 231 文件 / 4082 用例中仅 2 项环境性失败（`path-safety.test.ts`「只读目录返回 false」、`GalleryStackOverflow.test.tsx`）；`npm run lint` 仅 16 个历史问题且全落在 `.cache/`、`e2e/fullscreen-diagnose.e2e.ts`、`scripts/after-pack-vc-runtime.cjs`。只出现这些即视为通过，无新增失败项。

## 12. 已知限制

- 按需生成不回写 DB：若用户不触发扫描/批量生成，下次进入仍走按需路径（但已有模块级缓存避免重复 spawn）。
- 模块级 `Map` 跨组件实例共享，进程生命周期内同一路径只生成一次（符合预期）。
