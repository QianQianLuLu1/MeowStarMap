# 修复缩略图显示异常 / 渲染错误 / 加载缓慢（8 节点 TDD）

- 状态：已实施（2026-09-30，全部节点红→绿闭环通过；全量回归 298 文件 / 4943 用例通过，typecheck / lint / prettier 通过，`dist:win` + `e2e:smoke` 9/9 通过。npm audit 的 3 个 electron 高危通告为既有债务（commit a715d40 已立案专项），本次零依赖变更、无新增漏洞）
- 创建日期：2026-09-30
- 用户已确认决策：全部 8 节点实施；缩略图缓存头放宽为 `max-age=300`；损坏标记阈值改为连续 3 次；全局校验包含 `dist:win` + `e2e:smoke`。
- 关联前篇：[2026-09-29-fix-thumbnail-loading-latency.md](./2026-09-29-fix-thumbnail-loading-latency.md)、[2026-09-28-fix-video-thumbnail-spawn-eftype.md](./2026-09-28-fix-video-thumbnail-spawn-eftype.md)（本篇处理其遗留的结构性缺口）

## 1. 根因分析（已逐行读码核实）

| #   | 根因                                                                                                                                                                                                  | 证据位置                                                                                                                     | 症状                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| R1  | 5 个视图 `toFileUrl(file.thumbnail \|\| file.file_path)`：视频无缩略图时把视频文件当 `<img>` src 必裂图；图片无缩略图时直载数 MB 原图。网格视图已修，其余未同步                                       | `ListView.tsx:69`、`MasonryView.tsx:57`、`TimelineView.tsx:158`、`EventTimelineView.tsx:253`、`RecycleBinPage.tsx:495`       | 显示异常+慢            |
| R2  | 三处缩略图写入均直接写最终路径、无 temp+rename；渲染进程经 `media://` 流式读可读到半截 JPEG                                                                                                           | `thumbnail/generator.ts`（runSharpInline / ffmpeg 输出）、`thumbnail/worker-entry.ts:74`、`media-worker/worker-entry.ts:443` | 渲染错误（裂图）       |
| R3  | 生成部分失败时 UPDATE 用 NULL 覆盖已有 thumbnail/phash：`processThumbnailForRow` 无条件 `updateStmt.run(width,height,thumbnailPath,…)`；worker 批量 `if (result)` 只挡超时，`thumbnailPath:null` 照写 | `thumbnail-phash-service.ts:63`、`media-worker/worker-entry.ts:512-586`                                                      | 显示异常（好图变无图） |
| R4  | 任何一次解码失败即 `is_corrupted=1`，图库默认视图过滤之，ffmpeg 瞬时超时也让文件消失                                                                                                                  | `media-repository.ts:845-851`                                                                                                | 显示异常（消失）       |
| R5  | 视频抽帧阶梯末点固定 3s：时长 <3s 且片头淡入的视频 3s seek 空输出抛错 → 配合 R4 被标损坏                                                                                                              | `generator.ts` / `media-worker/worker-entry.ts:255-286`                                                                      | 显示异常（短视频）     |
| R6  | 缓存命中/生成成功路径无条件 `clearCorrupted`（SELECT+UPDATE，每张可见卡一次 DB 写）                                                                                                                   | `generator.ts:496,541` → `app/ipc-setup.ts:192-206`                                                                          | 加载缓慢               |
| R7  | `media:updated` 广播 → GalleryPage 只取首页 500 条整表替换 + 游标重置 → 列表闪回开头 + 失败集合清空重试风暴                                                                                           | `GalleryPage.tsx:221-234`、`mediaStore.ts:316-324`                                                                           | 慢+闪烁                |
| R8  | 缩略图 `max-age=0, must-revalidate`：每张可见缩略图每次都回主进程 stat+ETag                                                                                                                           | `media-protocol.ts:38`                                                                                                       | 加载缓慢               |
| R9  | 微项：主进程与 worker 降级 hash 公式不一致（缓存互不命中）；TimelineView 行 key 用下标                                                                                                                | `generator.ts:844-849` vs `media-worker/worker-entry.ts:222-226`；`TimelineView.tsx:124-127`                                 | 慢                     |

## 2. 依赖声明

**零依赖变更**：不新增/不升级/不移除任何 npm 依赖，不改 `package.json`。复用仓库既有能力：`toFileUrl`（`src/renderer/utils/file.ts`）、`MediaThumbPlaceholder`、`sharp`/`fluent-ffmpeg`/`better-sqlite3` 既有栈、vitest mock 基建（`tests/mocks/sqlite/require-hook.ts`、`tests/mocks/parent-port.ts`、`tests/setup.ts`）。

环境准备：确认 `node_modules` 存在（缺失则 `npm install` 增量安装，禁止 `npm ci`）。

## 3. 启动与验证说明

- 节点级（红→绿闭环）：`npx vitest run <对应测试文件>`
- 全局回归：`npm test`、`npm run test:main`、`npm run test:renderer`、`npm run typecheck`、`npm run lint`
- 安全：`npm audit`（对照 `audit-ci.jsonc` 豁免清单，无新增高危）
- 打包冒烟：`npm run dist:win` → `npm run e2e:smoke`
- 格式：`npx prettier --check` 覆盖改动文件
- 手验（dev）：`npm run dev` → 图库切换列表/瀑布流/时间线视图：① 无缩略图视频显示占位图标而非裂图；② 快速滚动不再成片闪回开头；③ 生成中/生成失败的文件不再从图库消失。

## 4. 错误处理

- 主进程：失败分支一律 `logger.warn/error`（`[Thumbnail]` 前缀惯例），不向渲染层抛错；临时文件清理 best-effort（try/catch unlink）；`markCorrupted`/`clearCorrupted` 回调失败不影响 generate 返回值（现有语义保持）。
- 渲染层：`resolveThumbnailSrc` 纯函数无副作用；视频占位复用 `MediaThumbPlaceholder`（IconVideo/IconWarning）；onError 回退链不动。
- 日志不新增 i18n key，中文硬编码（沿仓库 `[Cleanup] …` 先例）。

## 5. 参数校验

- `resolveThumbnailSrc`：`thumbnail` 为 null/undefined/空串一律视为无缩略图；`file_type` 非 `'image'` 按视频处理返回 null（不回退原文件，对齐 `resolveEffectiveThumbnail` 不变量）。
- COALESCE 更新语句参数个数与顺序不变（6+1）；`markCorrupted` reason 截断 200 字符保持。

## 6. 节点详情（文件 / 输入输出 / 验收标准）

### N0 基线与本文档

- 跑 `npm test` 记录基线；写入本文档。
- 验收：基线失败集为空或已记录。

### N1 渲染层 5 视图缩略图源统一（R1）

- 新增 `src/renderer/utils/thumbnail-src.ts`：`resolveThumbnailSrc(file): string|null`。
- 修改 5 视图一行改用之；null 走已有占位分支。
- 测试：`thumbnail-src.test.ts` 表驱动；重写 `RecycleBinPage.thumb.test.tsx` 固化缺陷的源码正则（L47）为行为断言；新增 ListView 视频占位行为测试。
- 验收：红灯确认后 `npx vitest run src/renderer` 相关文件全绿。

### N2 缩略图原子写入（R2）

- `thumbnail/generator.ts`、`thumbnail/worker-entry.ts`、`media-worker/worker-entry.ts`：同目录 `*.tmp-<pid>-<随机>` 写入 → 成功后 `fs.rename`；失败 best-effort unlink。视频阶梯在最终采纳帧时 rename。
- 测试：`generator.test.ts` 增用例（部分写入后抛错 → 最终路径不存在且无 tmp 残留；成功 → 最终路径完整字节）。
- 验收：`npx vitest run src/main/thumbnail src/main/media-worker` 全绿。

### N3 生成失败不覆写已有缩略图/pHash（R3）

- `media-worker/worker-entry.ts:512-514` UPDATE 六列改 `COALESCE(?, col)`；`startup-tasks.ts` 中 `processThumbnailForRow` 的 updateStmt SQL 同改。
- 测试：`worker-entry.test.ts` / `thumbnail-phash-service.test.ts` 增用例（generate→null 且行已有 thumbnail → 保留原值）。
- 验收：两文件全绿，`npm run test:db` 绿。

### N4 损坏标记宽容 + 短视频抽帧兜底（R4/R5）

- `media-repository.ts` markCorrupted：`corrupted_count+1`，`is_corrupted` 仅当累计 ≥3 置 1；两侧 `extractVideoFrame` 末点抛错但已有成功帧时保留帧不抛。
- 测试：repository 用例（1/2 次失败不置位、第 3 次置位、clearCorrupted 重置）；`generator.test.ts` 增 mode（0s/1s 成功、3s 抛错 → generate 成功）。
- 验收：相关测试文件全绿。

### N5 clearCorrupted 条件化（R6）

- `media-repository.ts` 新增 `clearCorruptedByPath`（单条条件 UPDATE）；`app/ipc-setup.ts` clear 回调换用之。
- 测试：`ipc-setup.test.ts` 增断言（未损坏路径零写）。
- 验收：`npx vitest run src/main/app src/main/database` 绿。

### N6 media:updated 保持分页深度（R7）

- `mediaStore.ts` `fetchMediaFromDatabase` 增可选 `{ limit }`；`GalleryPage.tsx` onUpdated 传 `Math.max(MEDIA_PAGE_SIZE, 当前长度)`。
- 测试：mediaStore 用例（2 页后刷新 → 1000 条且游标不回退）。
- 验收：`npx vitest run src/renderer/stores src/renderer/pages` 相关文件绿。

### N7 缩略图缓存头放宽（R8）

- `media-protocol.ts:38` → `'public, max-age=300, must-revalidate'`，更新注释。
- 测试：更新 header 断言（先红后绿）。

### N8 微项（R9）

- 降级 hash 统一 `${filePath}:${mtime}:${size}`；`TimelineView.tsx` 行 key 改 `row-${unit.files[0]?.id ?? index}`。
- 测试：hash 一致性单测；TimelineView key 稳定性断言。

## 7. 基础测试用例矩阵

| 节点 | 正常流程                | 异常场景                                 | 边界条件                                       |
| ---- | ----------------------- | ---------------------------------------- | ---------------------------------------------- |
| N1   | 有缩略图→URL 指向缩略图 | 视频无缩略图→null（占位）；生成失败→占位 | thumbnail 空串；file_type 未知值               |
| N2   | 成功→最终路径完整字节   | 写入中途失败→无半截文件、无 tmp 残留     | 视频阶梯多 seek 复用同一 tmp；0 字节输出       |
| N3   | 成功→全列更新           | generate null→旧 thumbnail/phash 保留    | 行本就全 NULL→仍 NULL；超时→整行跳过           |
| N4   | 3 次失败→is_corrupted=1 | 1/2 次失败→不置位                        | clearCorrupted 重置计数；末点失败但已有帧→保留 |
| N5   | 损坏行→清除             | 未损坏行→零写                            | 回调抛错→generate 不受影响                     |
| N6   | 刷新保持当前深度        | 首页（<500）刷新→仍 500                  | 游标不回退                                     |
| N7   | 首响应带 max-age=300    | 304 协商仍生效                           | —                                              |
| N8   | 两进程 hash 公式一致    | —                                        | content hash 读取失败降级路径                  |

## 8. 全局校验（一票否决）

1. `npm test` 全量绿（对照 N0 基线无新增失败）；2. `npm run typecheck`；3. `npm run lint`；4. `npm audit`；5. `npm run dist:win` + `npm run e2e:smoke` 全绿；6. 改动文件 `npx prettier --check` 通过。

## 9. 明确不做（范围外）

非 grid 视图拉全库（`useFilteredMediaFiles`）、视频扩展名扩充（m4v/flv）、decodeLimiter 队头阻塞、DB 缩略图 mtime 新鲜度、VirtualImageGrid 本体（b6ae15a 刚修复，规避回归风险）、`onDemandThumbPromises` 模块级 Map 治理。
