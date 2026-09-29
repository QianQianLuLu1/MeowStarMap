# 修复打包版缩略图加载慢（视频 白→模糊→清晰 / 图片 模糊数十秒才清晰）

- 状态：已实施（2026-09-29，全部节点红→绿闭环通过；全量回归 289 文件 / 4859 用例通过，lint / typecheck 通过）
- 创建日期：2026-09-29
- 关联前篇：[fix-video-thumbnail-white-frame-startup-heal.md](./fix-video-thumbnail-white-frame-startup-heal.md)（本篇取代其子系统 B「clearCache 缓存击穿」，子系统 A「启动自愈」保留）

## 1. 根因分析（已逐行读码核实的证据链）

### 症状① 视频缩略图：白 → 模糊 → 清晰

- **白-A（占位卡）**：`thumbnail=NULL` 的视频显示近白占位卡（`var(--bg-tertiary)` 底 + 图标），等 `useVideoThumbGenerate` 经 IPC 触发 ffmpeg 阶梯抽帧后才换图（`src/renderer/hooks/useVideoThumbGenerate.ts`）。抽帧受主进程全局解码信号量 `decodeLimiter = cpus×2` 排队（`src/main/thumbnail/generator.ts:63-75`）；高分屏（DPR≥2）预生成 effect 还会对视频调用 `generate('high')`，经 `doGenerateHigh` 降级后**重新走一遍完整 ffmpeg 抽帧**，纯浪费（`src/renderer/components/gallery/VirtualImageGrid.tsx:239-250`、`generator.ts:407-416`）。
- **白-B（机制性根因，本篇主修）**：`media://` 协议对所有响应（含缩略图）下发 `Cache-Control: public, max-age=31536000` 一年强缓存（`src/main/app/media-protocol.ts:108/122`），URL 仅含 `path` 参数、无 ETag/304/版本指纹。启动自愈（`src/main/app/startup-tasks.ts:604-643`）与按需自愈（`generator.ts:473-492`）都**就地覆盖同名** `${hash}.jpg`，URL 不变 → Chromium 继续命中旧白字节。现有唯一补救是启动自愈后 `session.defaultSession.clearCache()`：
  - 仅覆盖启动自愈路径，按需自愈（渲染层任意一次 `thumbnail:generate` 触发）无补救；
  - 清空**整个会话缓存**（原图、视频一并失效），自愈发生的那次启动出现全量重拉请求风暴；
  - 且仅当 `healedBlankCount > 0` 才清，时序上在 bootstrap await，用户首屏之后才生效。
- **模糊 → 清晰**：生成完成后先显示 `_low`（64px q30）拉伸图，停滚 300ms 后切 standard（320px）。此分级加载为设计行为，保留。

### 症状② 图片缩略图：模糊 → 数秒~数十秒 → 清晰

- **模糊来源**：`_low`(64px q30) 被拉伸；或 `thumbnail=NULL` 时回退直载数 MB 原图（`VirtualImageGrid.tsx:381-383`），批量生成/pHash 未完成时磁盘 IO 被争抢，原图加载更慢。
- **核心缺陷（渲染层状态机死胡同）**：停滚 300ms 升级 standard 时，若 `${hash}.jpg` 尚未由后台批量任务生成（media-worker 仅 4 并发且图片同批算 pHash，`src/main/media-worker/worker-entry.ts:543-560`），`media://` 404 → `onError` 中 `useHighQuality` 已为 true → `markFailed` 死胡同（警告图标，无重试，`VirtualImageGrid.tsx:450-456`），直到 `media:updated` 全量刷新（`useFailedImages` 随 items 变化清空失败集）才恢复清晰——间隔即批量任务完成时间，「数秒~数十秒」。
- **高分屏档位写反**：DPR≥2 时 `thumbUrl` 首选 `_high.jpg`（`toHighQualityUrl` 推导，`VirtualImageGrid.tsx:386-392`），而 `_high` 仅被预生成 effect 覆盖可视区前 20 项 → 首屏大面积 404 一次再回退；且升级后（`useHighQuality=true`）三元表达式反而从 `_high`(512px) 回落到 standard(320px)，「升级即降清」。

### 四个怀疑方向结论

| 方向                     | 结论                                                                                                                  | 处置                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 主进程缩略图生成队列阻塞 | 部分成立：按需生成（thumbnail-worker/主进程）与批量（media-worker）无共享队列互锁，仅 decodeLimiter/磁盘/CPU 资源争抢 | 移除无谓的 `_high` 预生成（含视频 ffmpeg 重抽）；**不动生成架构** |
| HTTP 强缓存导致切换延迟  | 成立：不是「低/高清切换」延迟，而是**自愈/重生成后旧字节驻留**                                                        | ETag + 协商缓存（节点1），移除 clearCache 风暴（节点2）           |
| 渲染层状态机切换逻辑缺陷 | 成立（主修对象）                                                                                                      | 档位回退链修复（节点3、4）                                        |
| IPC 通信延迟             | 不成立：URL 由 DB 行同步构造（`toFileUrl`），IPC 仅视频按需生成                                                       | 不改                                                              |

## 2. 依赖声明

**零依赖变更**：不新增/不升级/不移除任何 npm 依赖，不改 `package.json`。全部复用仓库既有能力：

- `isPathUnderDir`（`src/main/utils/ipc-validate.ts`，media-protocol.ts 已导入）
- `ctx.thumbnailGen.getCacheDir()`（`src/main/thumbnail/generator.ts:196`）
- `useFailedImages`（`src/renderer/hooks/useFailedImages.ts`，可同 hook 双实例复用）
- `toLowQualityUrl` / `toFileUrl`（均为已导出纯函数）

环境准备：确认 `node_modules` 存在（缺失则 `npm install` 增量安装，禁止 `npm ci`）。

## 3. 启动与验证说明

- 自动化（节点级，红→绿闭环）：`npx vitest run <对应测试文件>`
- 全局回归：`npm test`（全量）、`npm run test:main`、`npm run test:renderer`、`npm run lint`、`npm run typecheck`
- 格式：`npx prettier --check` 覆盖改动文件
- 手验（dev）：`npm run dev` → 图库快速滚动，观察：① 模糊格不再出现「警告图标死胡同」，要么 ≤1~2s 转清晰、要么保持模糊待刷新自动重试；② DPR≥2 屏首屏无 `_high` 404 往返；③「缓存/收藏/截图」页复用 GalleryPage→VirtualImageGrid 自动受益；④ 重复文件页低清回退生效。
- 手验（打包）：`npm run dist:win` 安装后，存量白帧视频缩略图在自愈完成后随刷新即变为真帧（无整缓存清空风暴）。

## 4. 错误处理

- **ETag/304（media-protocol.ts）**：`If-None-Match` 按逗号分割 + trim 后比对；非法/不匹配一律回 200（fail-open）；304 响应带 ETag + Cache-Control + CORS 头、无 body；任何异常仍走既有 `logger.error(t('main.mediaProtocol.log.handleRequestFailed'))` 兜底。
- **渲染层回退链**：onError 链有终止条件（最终 `markFailed`）；`standardFailed` 集合复用 `useFailedImages(items)` 语义——items 变化自动清空 → `media:updated` 刷新后自动重试。
- **Chromium 不缓存 protocol.handle 流式响应的兜底**：若浏览器从不发 `If-None-Match`，行为与现状完全一致（每次 200），零风险回退。
- **日志**：新增日志中文硬编码（沿用仓库 `[Cleanup] ...` 先例），不新增 i18n key。

## 5. 参数校验

- `pickThumbnailUrl`：入参为类型化对象 `{ lowUrl, standardUrl, upgraded, standardFailed }`，lowUrl/standardUrl 允许 null，全空返回 null。
- `MediaThumbnail.fallbackSrc`：可选 `string | null`；img onError 且 fallbackSrc 非空时仅切换一次，fallback 再失败才显示占位（防循环）。
- ETag 仅对 `isPathUnderDir(realPath, thumbnailDir)` 成立的响应生效；206 Range / 416 分支不变。
- DuplicatesPage `fallbackSrc` 仅图片且 `toLowQualityUrl` 可推导时传入（游戏原生缩略图返回 null → 行为不变）。

## 6. 基础测试用例矩阵（正常 / 异常 / 边界）

### media-protocol.test.ts（新增，handler 行为级）

| 类别 | 用例                               | 期望                                                               |
| ---- | ---------------------------------- | ------------------------------------------------------------------ |
| 正常 | 缩略图目录内路径 200 响应          | 头含 `ETag` 与 `Cache-Control: public, max-age=0, must-revalidate` |
| 正常 | 二次请求带匹配 `If-None-Match`     | 304，无 body                                                       |
| 异常 | `If-None-Match` 不匹配 / 非法      | 200                                                                |
| 异常 | stat 缺少 mtimeMs（mock `{size}`） | 不抛错，ETag 兜底生成                                              |
| 边界 | 非缩略图路径（source 目录）        | 保持 `max-age=31536000` 且无 ETag（回归守卫）                      |
| 边界 | 缩略图路径带 Range 头              | 206 分支不变（无 ETag 逻辑介入）                                   |

### startup-tasks.test.ts（调整既有 clearCache 用例）

| 类别 | 用例                           | 期望                                              |
| ---- | ------------------------------ | ------------------------------------------------- |
| 正常 | 自愈发生（healedBlankCount>0） | `clearCache` **不**被调用（红灯：当前实现会调用） |
| 正常 | 既有 heal 用例                 | 保持绿（自愈主体不动）                            |

### VirtualImageGrid.thumb.test.tsx（新增纯函数 + 结构断言）

| 类别 | 用例                                     | 期望                                                                         |
| ---- | ---------------------------------------- | ---------------------------------------------------------------------------- |
| 正常 | `pickThumbnailUrl`：有 low 未升级        | low                                                                          |
| 正常 | `pickThumbnailUrl`：升级                 | standard                                                                     |
| 异常 | `pickThumbnailUrl`：全 null              | null                                                                         |
| 边界 | `pickThumbnailUrl`：升级但 standard 失败 | low（回退）                                                                  |
| 边界 | 源码结构                                 | 不再含 `HIGH_DPI_MODE`/预生成 effect；onError 含 `markStandardFailed` 回退链 |

### MediaThumbnail.test.tsx（新建，jsdom 渲染）

| 类别 | 用例                        | 期望                              |
| ---- | --------------------------- | --------------------------------- |
| 正常 | 有 fallbackSrc，img onError | src 切换到 fallbackSrc            |
| 异常 | fallbackSrc 也 onError      | 显示占位（hasError，不再循环）    |
| 边界 | 无 fallbackSrc（缺省）      | onError 直接 hasError（现状不变） |

时序/延迟说明：本方案无新增定时器依赖（既有 300ms 防抖保留不动），纯函数与 onError 行为用同步断言即可；如需覆盖防抖时序，沿用 `vi.useFakeTimers()` 既有模式。

## 7. 子任务与验收标准（分节点 TDD，红→绿闭环）

### 节点 0：计划落盘

- 输出：本 MD。
- 验收：`npx prettier --check docs/plans/2026-09-29-fix-thumbnail-loading-latency.md` 通过。

### 节点 1：media-protocol 缩略图 ETag/304（红→绿）

- 文件：`src/main/app/media-protocol.ts`；测试 `src/main/app/__tests__/media-protocol.test.ts`（`fsStatMock` 补 `mtimeMs`，`makeRequest` 支持注入 `If-None-Match`）。
- 输入/输出：请求（URL + headers）→ 响应（200/206/304 + 缓存头）。
- 先写红灯：上表 6 例（当前无 ETag/304，必红）。
- 实现：handler 内 `isPathUnderDir(realPath, path.resolve(ctx.thumbnailGen.getCacheDir()))` 判定缩略图路径 → 200 分支换 `max-age=0, must-revalidate` + `ETag: W/"<mtimeMs>-<size>"`，命中 `If-None-Match` 回 304；206/非缩略图不变。
- 验收：`npx vitest run src/main/app/__tests__/media-protocol.test.ts` 全绿；`npm run test:main` 无新增失败。

### 节点 2：startup-tasks 移除 clearCache（红→绿）

- 文件：`src/main/app/startup-tasks.ts`；测试 `src/main/app/__tests__/startup-tasks.test.ts`。
- 先写红灯：断言自愈发生时 `clearCache` 不被调用（当前必红）。
- 实现：删除 `healedBlankCount > 0` 的 `clearCache()` 块与 `session` import；日志与 `media:updated` 触发条件保留。
- 验收：该测试文件全绿；既有 heal 用例不回归。

### 节点 3：VirtualImageGrid 档位状态机修复（红→绿）

- 文件：`src/renderer/components/gallery/VirtualImageGrid.tsx`；测试 `src/renderer/components/gallery/VirtualImageGrid.thumb.test.tsx`。
- 先写红灯：`pickThumbnailUrl` 纯函数用例（函数尚不存在，导入即红）+ 结构断言（无 `HIGH_DPI_MODE` 等）。
- 实现：① 删除 `HIGH_DPI_MODE` 常量与高分屏预生成 effect；② 新增导出纯函数 `pickThumbnailUrl({ lowUrl, standardUrl, upgraded, standardFailed })`；③ `thumbUrl` 改由纯函数产出；④ 新增第二个 `useFailedImages(items)` 实例管理 `standardFailed`；⑤ onError 回退链：显示 low 时失败→升级 standard；显示 standard 时失败且有 low→`markStandardFailed`（回退 low，待刷新重试）；无 low 可退或回退后再失败→`markFailed`。
- 验收：`npx vitest run src/renderer/components/gallery/VirtualImageGrid.thumb.test.tsx` 全绿；`npm run test:renderer` 无新增失败。

### 节点 4：MediaThumbnail fallbackSrc + DuplicatesPage（红→绿）

- 文件：`src/renderer/components/common/MediaThumbnail.tsx`（新增测试 `MediaThumbnail.test.tsx`）；`src/renderer/pages/DuplicatesPage.tsx`。
- 先写红灯：fallbackSrc 切换/终止/缺省三例（prop 尚不存在，必红）。
- 实现：可选 prop `fallbackSrc`；DuplicatesPage 仅图片且 `toLowQualityUrl(file.thumbnail)` 可推导时传入 `toFileUrl(...)`。
- 验收：新建测试全绿；`DuplicatesPage.videoThumb.test.tsx` 保持绿。

### 节点 5：全局回归

- `npm test` 全量无新增失败；`npm run lint`、`npm run typecheck` 通过；`git diff --numstat` 确认仅计划内文件变更。

## 8. 改动边界（明确不动，遵守最小改动）

- **不动** 生成层：`thumbnail/generator.ts`、`media-worker/worker-entry.ts`、`utils/video-frame.ts`、批量并发与 pHash 逻辑。
- **不动** IPC 契约：`thumbnail:generate` 通道签名与语义。
- **不动** 白帧自愈主体（启动自愈阶段 A、按需自愈分支），仅移除其 clearCache 补救。
- **不动** 其他视图：`ListView/TimelineView/EventTimelineView/MasonryView`、`RecycleBinPage`、`OutfitGalleryPage`。
- **保留** `_low/_high` 命名纯函数导出与既有测试（`_high` 不再被网格请求，档位命名契约留作后续渐进增强）。

## 9. 已知限制

- DPR≥2 屏稳态清晰度为 standard 320px（与修复前实际稳态一致；`_high` 512px 渐进增强留待后续）。
- `thumbnail=NULL` 的图片在批量完成前仍回退加载原图（行为保留，不动批量架构）。
- 全白视频（三位点皆纯白）仍保留白帧（前篇已知限制，属 ffmpeg 抽帧域）。
