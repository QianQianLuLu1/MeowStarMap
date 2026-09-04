# 修复「缓存 / 重复文件」板块视频缩略图纯白色（存量白帧启动自愈）

- 状态：实施中（in-progress）
- 创建日期：2026-09-04
- 关联前篇：[fix-video-thumbnail-white-frame.md](./fix-video-thumbnail-white-frame.md)

## 0. 与前篇的关系

前篇 [fix-video-thumbnail-white-frame.md](./fix-video-thumbnail-white-frame.md) 已完成 **seek 阶梯抽帧 `[0,1,3]s`** 与 **缓存命中纯色自愈** 能力，从源头上 **阻止新的纯白帧产生**（生成层修复）。

本篇是其 **「存量自愈触发」收尾**：前篇防止新白帧，本篇修复 **历史已落盘的存量白帧**。二者互补，共同彻底消除「缓存 / 重复文件」板块视频缩略图纯白色的问题。

## 1. 根因摘要（已逐行读码核实）

用户报告的「视频缩略图纯白」根因 **不是** 渲染层取源错误，也 **不是** 缺少抽帧能力——仓库已具备完整的 seek 阶梯抽帧与「缓存命中纯色自愈」能力。真正的问题是：**这套自愈能力对「历史已落盘的存量白帧」从未被触发**，四个可能触发它的入口全部被前置门控挡死，导致白图永久留存。

| 触发入口                                   | 门控条件                                                           | 证据位置                                                   | 为何漏掉存量白帧                              |
| ------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------- | --------------------------------------------- |
| 主进程缓存命中自愈 `doGenerate`            | 需先被 `generate()` 调用                                           | `src/main/thumbnail/generator.ts:468-487`                  | 自愈代码存在，但没人对这些视频调 `generate()` |
| 「缓存」板块 `VirtualImageGrid` 预生成     | `if (!HIGH_DPI_MODE) return`                                       | `src/renderer/components/gallery/VirtualImageGrid.tsx:229` | 普通屏（DPR<2）直接短路                       |
| 「重复文件」板块 `DuplicatesPage` 按需生成 | `... \|\| file.thumbnail \|\| ... ) return`                        | `src/renderer/pages/DuplicatesPage.tsx:1567`               | 白帧 `thumbnail` 非空 → 跳过 `generate()`     |
| 批量任务 `startThumbnailBatch`             | SQL `WHERE (thumbnail IS NULL OR width IS NULL OR height IS NULL)` | `src/main/media-worker/worker-entry.ts:479`                | 白帧三列均非空 → 不入选                       |
| 启动修复 `cleanupAndRepairDatabase`        | `rowsToRepair = needsDimensions \|\| thumbnailDangling`            | `src/main/app/startup-tasks.ts:571-575`                    | 白帧尺寸齐全、文件存在（非悬空）→ 漏网        |

**次生风险**：`src/main/app/media-protocol.ts:108/122` 对缩略图响应设 `Cache-Control: public, max-age=31536000`（一年强缓存），自愈就地覆盖同名 `${hash}.jpg`、URL 不变，即便磁盘已换成真帧，Chromium HTTP 缓存仍可能返回旧白图字节。**若不处理，磁盘自愈将对用户不可见。**

## 2. 关键改动（最小改动，只动一个源文件）

**文件**：`src/main/app/startup-tasks.ts`（+ 其测试 `src/main/app/__tests__/startup-tasks.test.ts`）。

### 子系统 A：主进程启动自愈（核心）

- 新增 import：`import { session } from 'electron'`、`import { isBlankCachedThumbnail } from '../utils/video-frame'`（`path`、`runWithConcurrency`、`THUMBNAIL_CONCURRENCY`、`logger` 均已导入）。
- 在 `cleanupAndRepairDatabase` 内、现有 `await runWithConcurrency(repairTasks, THUMBNAIL_CONCURRENCY)` 之后、`if (missingCount > 0 || repairedCount > 0)` 之前，插入「存量纯白视频缩略图自愈」阶段：
  - 从既有 `validRows` 过滤出 `file_type === 'video' && thumbnail != null` 的候选；
  - 对每个候选用 `isBlankCachedThumbnail(path.resolve(row.thumbnail))` 判定（复用既有体积闸门：>4096B 直接短路，非白帧仅一次 stat，热路径成本≈0）；
  - 判为纯白 → **直接 `await ctx.thumbnailGen.generate(row.file_path)`**（命中 `doGenerate` 自愈分支，用 seek 阶梯重建 standard 帧并删除重建 `_low` 副本）；
  - **不走 `processThumbnailForRow`、不写库**：自愈后 `${hash}.jpg` 路径不变，DB `thumbnail` 列无需更新；此举同时规避了 `processThumbnailForRow` 的 `updateStmt` 参数不匹配隐患；
  - 用既有 `runWithConcurrency(tasks, THUMBNAIL_CONCURRENCY)` 做并发控制；每个任务 `try/catch`，自愈失败仅 `logger.warn`，绝不中断启动。
- 将 `media:updated` 的触发条件与日志扩展为包含 `healedBlankCount`，使自愈后也驱动渲染层刷新。

### 子系统 B：HTTP 缓存击穿（保证自愈可见）

- 仅当本次 `healedBlankCount > 0` 时，`await session.defaultSession.clearCache()`，清掉可能残留旧白图字节的会话 HTTP 缓存；`try/catch` 兜底，失败仅 `logger.warn`（提示可能需重启生效）。
- 该调用 **条件触发、一次性**：对本地文件应用无实质副作用，只在真正发生自愈的那次启动执行。

> **两个板块为何同时生效**：缓存板块（`VirtualImageGrid`）与重复文件板块（`DuplicatesPage`）的 `<img>` 最终都指向同一份磁盘 `${hash}.jpg` / `${hash}_low.jpg`。启动阶段把磁盘白帧换成真帧 + 清缓存后，两者读取到的都是重建后的真帧，无需分别改渲染层。

## 3. 依赖声明

- **零新增 / 零升级 / 零移除 npm 依赖，不改 `package.json`。**
- 复用清单（全部为仓库既有能力）：
  - `isBlankCachedThumbnail` / `isBlankImageFile`（`src/main/utils/video-frame.ts`，内部用既有 `sharp`）；
  - `ThumbnailGenerator.generate()` 的缓存命中自愈分支（`src/main/thumbnail/generator.ts:468-487`）；
  - `runWithConcurrency`（`src/main/utils/concurrency.ts`）、`THUMBNAIL_CONCURRENCY`（`src/main/utils/constants.ts`）；
  - Electron 内置 `session.defaultSession.clearCache()`；
  - 既有测试脚手架 `src/main/app/__tests__/startup-tasks.test.ts`。
- **环境准备**：执行前确认 `node_modules` 存在（若无则 `npm install` 增量安装，禁止 `npm ci`、禁止删除 `node_modules`）。

## 4. 启动与验证说明

- 单文件测试：`npx vitest run src/main/app/__tests__/startup-tasks.test.ts`
- 子集：`npm run test:main`
- 类型：`npm run typecheck`（`tsc -b`，基线 exit 0）
- 格式：`npm run format:check`（Prettier，`endOfLine: lf`）
- 手验：`npm run dev` → 侧边栏进入「缓存」「重复文件」→ 视频条目缩略图不再纯白。

## 5. 错误处理

- **`isBlankCachedThumbnail` 异常**：内部 fail-open 返回 `false`（文件不存在 / 无权限 / 非图片一律按「有内容」处理），不会误伤正常帧、不阻断启动。
- **`generate()` 自愈失败**：`doGenerate` 自愈分支本身有 `try/catch` 保留旧图；外层再包一层 `try/catch + logger.warn`，任何单条失败都不影响其余行与启动流程。
- **`clearCache()` 失败**：`try/catch + logger.warn`，提示「自愈可能需重启生效」，不抛出。
- **日志**：新增日志用中文硬编码，沿用仓库既有先例（如 `[Cleanup] ...`），不新增 i18n key。

## 6. 参数校验

- 候选过滤强约束 `row.file_type === 'video'` 且 `row.thumbnail != null`，图片与非视频行不进入自愈。
- `isBlankCachedThumbnail(path.resolve(row.thumbnail))`：入参为空 / 非法路径 → 内部返回 `false`；`path.resolve` 兼容相对 / 绝对路径（与既有悬空判定同口径）。
- `generate(row.file_path)`：`file_path` 来自 DB 且已在第一阶段经 `pathExists` 校验为存在的源文件；`generate` 内部对 GamePlayPhotos 路径自行豁免。
- `healedBlankCount` 为有限整数计数，仅 `> 0` 时才触发 `clearCache` 与 `media:updated`。

## 7. 测试用例矩阵（正常 / 异常 / 边界）

| 类别   | 用例                                      | 期望                                                   |
| ------ | ----------------------------------------- | ------------------------------------------------------ |
| 正常   | video 行 + `isBlankCachedThumbnail=true`  | `generate(file_path)` 被调用一次；`healedBlankCount=1` |
| 正常   | 自愈后 `media:updated`                    | `sendToRenderer(ctx,'media:updated')` 被调用           |
| 正常   | 自愈发生（`healedBlankCount>0`）          | `session.defaultSession.clearCache()` 被调用           |
| 异常   | video 行 + `isBlankCachedThumbnail=false` | `generate` 不因自愈被调用；`clearCache` 不被调用       |
| 异常   | `generate()` 抛错                         | 捕获并 `logger.warn`，不中断其余行与启动               |
| 异常   | `clearCache()` 抛错                       | 捕获并 `logger.warn`，函数正常返回                     |
| 边界   | image 行（即使缩略图很小）                | 不进入自愈候选（`file_type!=='video'`）                |
| 边界   | video 行 `thumbnail=null`                 | 不进入自愈候选                                         |
| 不变量 | 既有 `cleanupAndRepairDatabase` 全部用例  | 保持绿灯（自愈阶段为纯增量，不改 `rowsToRepair` 逻辑） |

## 8. 子任务与验收标准（分节点 TDD，红→绿闭环）

### 节点 0：计划落盘

- **输出**：本篇 MD。
- **验收**：`docs/plans/` 下生成本 MD；`npx prettier --check docs/plans/fix-video-thumbnail-white-frame-startup-heal.md` 通过。

### 节点 1：启动自愈阶段（RED → GREEN）

- **文件**：改 `src/main/app/startup-tasks.ts`（子系统 A）；测试改 `src/main/app/__tests__/startup-tasks.test.ts`。
- **先写红灯测试**：构造 `file_type:'video'`、`thumbnail` 非空、`width/height` 齐全、源文件存在的记录；mock `../../utils/video-frame` 的 `isBlankCachedThumbnail` 返回 `true`；spy `ctx.thumbnailGen.generate`。断言 `generate` 被以该 `file_path` 调用。**修复前必红**（当前无自愈阶段、该行也不进 `rowsToRepair`）。
- **改代码**：插入子系统 A 的自愈阶段。
- **验收**：`npx vitest run src/main/app/__tests__/startup-tasks.test.ts` 全绿；`npm run test:main` 无新增失败。

### 节点 2：HTTP 缓存击穿（RED → GREEN）

- **文件**：改 `src/main/app/startup-tasks.ts`（子系统 B）；测试同上文件。
- **先写红灯测试**：mock `electron` 的 `session.defaultSession.clearCache`；在自愈场景（`healedBlankCount>0`）下断言 `clearCache` 被调用；补一条「无白帧 → `clearCache` 不被调用」守卫；补一条「`clearCache` 抛错 → 被捕获、函数正常返回、`logger.warn`」异常用例。**修复前必红**（当前无 `clearCache` 调用）。
- **改代码**：插入子系统 B 的条件 `clearCache`，并把 `media:updated` 触发条件 / 日志扩展为含 `healedBlankCount`。
- **验收**：`npx vitest run src/main/app/__tests__/startup-tasks.test.ts` 全绿。

### 节点内自验

1. `npx vitest run src/main/app/__tests__/startup-tasks.test.ts` —— 全绿
2. `npm run test:main` —— 无新增失败
3. `npm run typecheck` —— exit 0
4. `npx prettier --check` 三个改动文件 —— 通过
5. `git diff --numstat` —— 确认只有 3 个文件变更、无整文件行尾翻动

## 9. 改动边界（明确不动，遵守最小改动）

- **不动** 渲染层：`VirtualImageGrid.tsx`、`DuplicatesPage.tsx`。
- **不动** 生成层：`generator.ts`、`worker-entry.ts`、`video-frame.ts`。
- **不动** 协议层：`media-protocol.ts`、`index.ts`、`file.ts`。
- **不动** 其它视图与回收站：`ListView/TimelineView/MasonryView/EventTimelineView`、`RecycleBinPage.tsx`。
- **不修** `processThumbnailForRow` 的 `updateStmt` 参数不匹配隐患（本方案通过「直接调 generate、不写库」绕开它）。

## 10. 已知限制

- **真正全白视频**（0s/1s/3s 三帧皆纯白）每次启动都会被重新判定为白帧并重跑一次阶梯，最终仍保留白帧。此类视频极罕见，代价受 `THUMBNAIL_CONCURRENCY` 约束；如需彻底避免，可后续在 DB 增 `thumbnail_healed` 持久标志位（本次不做）。
- **过曝但有细节** 的帧（`stdev>6`）判为「有内容」不重试，属 HDR→SDR 色调映射的独立议题。
- **内容 hash 漂移边界**：源内容变化但 `file_path` 未变时，`generate()` 修复的是按当前内容重算的新 hash 路径，而 DB `row.thumbnail` 仍指旧白图，自愈对该行渲染不可见。此为极端边界，与既有 `rowsToRepair` 同口径；已由「复检 DB 实际指向的缩略图路径」避免将其误计入 `healedBlankCount`。
- **`healedBlankCount` 新语义**：收敛为「真正白→真帧的转换数」——`generate()` 返回 null、三位点全白仍保留白帧、hash 漂移均未真正自愈，一律不计入。因此全局 `session.clearCache()` 为「确有自愈那一次启动」的一次性调用，而非每次启动都被全白视频误触发。
- **启动 stat 开销**：自愈判定的 `isBlankCachedThumbnail` 复用既有体积闸门（>4096B 直接短路、非白帧仅一次 stat），且阶段一已对全库做过 `pathExists`，故 stat 成本受既有量级约束，非新增量级。
