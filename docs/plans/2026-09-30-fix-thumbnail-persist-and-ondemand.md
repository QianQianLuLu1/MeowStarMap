# 修复缩略图缓存持久化闭环与按需生成回填（3 节点 TDD）

- 状态：已实施（2026-09-30，3 节点全部红→绿闭环通过；全量回归 4961 用例通过（基线 4943 + 新增 18），typecheck / lint / prettier 通过，`dist:win` 退出码 0 + `e2e:smoke` 9/9 通过。`npm run audit`（audit-ci）拦到的 4 条 electron high 通告为既有债务（docs/plans/2026-09-30-electron-40-eol-security-upgrade.md，commit a715d40 已立案专项），本次零依赖变更、lockfile 未动、无新增漏洞）
- 创建日期：2026-09-30
- 用户已确认决策：开工前先提交批次一（commit 414dfd0）；全局校验含 `dist:win` + `e2e:smoke`。
- 关联前篇：[2026-09-30-fix-thumbnail-display-and-latency.md](./2026-09-30-fix-thumbnail-display-and-latency.md)（批次一，8 节点，已实施）、[THUMBNAIL_OPTIMIZATION_PLAN.md](../../../THUMBNAIL_OPTIMIZATION_PLAN.md)（结构参照）

## 1. 根因分析（已逐行读码核实）

| #   | 根因                                                                                                                                                                                                                                             | 证据位置                                                                  | 症状                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------- |
| R1  | 按需生成（`thumbnail:generate` IPC）结果只存组件 state，从不写库 → DB `thumbnail` 仍 NULL → 该行文件不在启动孤儿清理白名单（白名单 = `thumbnail IS NOT NULL` 集合）→ **每次启动被当孤儿删除** → 下次进图库重新生成，形成"每次启动重复生成"死循环 | `ipc/handlers/thumbnail-handler.ts:12-22`、`app/startup-tasks.ts:452-458` | 每次启动重复生成、IO 争抢 |
| R2  | `onDemandThumbPromises` Map 命中即 return，不把已 resolved 的结果回填新组件实例的 state → 卡片滚出视区（state 随卸载丢失）再滚回时显示占位，要等下一次 `media:updated` 全量刷新                                                                  | `VirtualImageGrid.tsx:279`                                                | 占位/白屏（已生成过的项） |
| R3  | 套装图鉴封面仍是 `coverThumbnail \|\| coverFilePath` 旧模式且无 file_type 判断：用户可给视频打套装标签，视频成为最新一张时封面把视频文件当 `<img>` src → 裂图 + 整个视频文件被当图片下载（IO 争抢）                                              | `OutfitGalleryPage.tsx:38`、`media-repository.ts:1324-1330`               | 裂图 + 慢                 |

**已排查、确认无需改动的方向**（用户诉求 1）：

- 游戏原生缩略图复用链路已完整实现：扫描器推导 `NikkiPhotos_LowQuality` 同名文件写入 DB thumbnail（`scanner/worker-entry.ts:862-935`）；生成器对 GamePlayPhotos 非视频零解码快路径（`thumbnail/generator.ts:316-337`）；批量任务 SQL 层排除游戏图片（`media-worker/worker-entry.ts:501-514`）；存量数据由 `repair-legacy-data-v6.ts` 回填。现有回归测试：`__tests__/nikki-albums-compat.test.ts`、`scan-gpp-exemption.test.ts`、`path-classifier.test.ts` 等 30+ 文件。
- 批次一已修复：孤儿清理误删 `_low`/`_high` 变体与 `cache-metadata.json`（`startup-tasks.ts` 白名单已豁免）；缩略图缓存头 `max-age=300` + ETag 304；启动不再 `session.clearCache()`——HTTP 缓存与磁盘缓存均可跨重启生效。
- `DuplicatesPage.tsx:1582-1620` 内联了与 `resolveThumbnailSrc` 等价的不变量（视频只用 thumbnail），且自带 `thumbGenerateCache` 回填，不迁移（避免无行为变化的重构）。

## 2. 依赖声明

**零依赖变更**：不新增/不升级/不移除任何 npm 依赖，不改 `package.json`。复用仓库既有能力：`_test-helpers.ts`（`makeCtx`/`getHandler`/`createSchemasMock`）、vitest mock 基建（`tests/mocks/sqlite/require-hook.ts`、`tests/setup.ts`）、`invalidateMediaPathCache` 既有失效模式（`media-update.ts:77` 先例）、`IconVideo` 占位图标。

环境准备：确认 `node_modules` 存在（缺失则 `npm install` 增量安装，禁止 `npm ci`）。

## 3. 启动与验证说明

- 节点级（红→绿闭环）：`npx vitest run <对应测试文件>`
- 全局回归（用户已确认含打包冒烟）：`npm test`、`npm run test:main`、`npm run test:renderer`、`npm run test:db`、`npm run typecheck`、`npm run lint`、`npm audit`（对照 `audit-ci.jsonc` 无新增高危）、改动文件 `npx prettier --check`、`npm run dist:win` → `npm run e2e:smoke`
- 手验（dev）：`npm run dev` → ① 图库滚动到无缩略图项，等占位变缩略图后滚出再滚回，缩略图应立即显示（不再占位）；② 重启软件再进图库，同批项不再重新生成（缩略图立即出现）；③ 服装图鉴中视频封面显示视频图标占位而非裂图。

## 4. 错误处理

- 主进程：回写失败（DB 抛错）`logger.warn('[Thumbnail] …')` 中文日志，不影响 IPC 正常返回生成路径；`invalidateMediaPathCache` 仅在 UPDATE 实际改动行时调用。不新增 i18n key。
- 渲染层：`applyResult` 复用既有幂等守卫（`onDemandThumbs.prev.has` / `onDemandFailed.has`），晚到的回填与首个订阅者行为一致；生成失败仍进 `onDemandFailed` 不重试。
- 套装封面：`coverFileType` 缺失/未知值按图片处理（保守降级为现状），仅 `file_type === 'video' && !coverThumbnail` 才走占位。

## 5. 参数校验

- `setThumbnailIfNull(filePath, thumbnailPath)`：两参均为非空字符串；`thumbnailPath` 为空/null 时不调用（handler 侧守卫）。
- handler 回写条件：`generate` 返回非空 string 且 `quality` 为 `'standard' | undefined`（low/high 是派生档位，不是 `thumbnail` 列的规范值；视频 high 已降级返回 standard 路径，同样不写）。
- `OutfitStat.coverFileType`：`'image' | 'video' | null`；SQL 侧 `file_type` 可能 NULL，renderer 侧仅精确匹配 `'video'`。

## 6. 节点详情（文件 / 输入输出 / 验收标准）

### N0 基线与本文档

- 提交批次一（414dfd0）→ 写入本文档并提交 → `npm test` 记录基线。
- 验收：基线全绿或失败集已记录。

### N1 视图网格按需缓存命中回填（R2）

- 修改 `src/renderer/components/gallery/VirtualImageGrid.tsx`：`ensureOnDemandThumbnail` 内把现有 `.then` 体内 setState 逻辑提取为 `applyResult(result)` 闭包（本就幂等）；Map 命中分支改为 `void existing.then(applyResult)` 后 return——promise 已 resolved 时微任务内回填新实例 state。
- 测试：`VirtualImageGrid.thumb.test.tsx` 增用例：首次调用触发 generate 并成功后，新挂载实例再次调用（Map 命中）→ 渲染出发放结果而非占位。
- 输入：`file`（file_path 非空）；输出：无返回值，副作用为回填 `onDemandThumbs` / 清理 `onDemandFailed` / 清两类失败标记。
- 验收：红灯确认后 `npx vitest run src/renderer/components/gallery/VirtualImageGrid.thumb.test.tsx` 全绿。

### N2 按需生成结果持久化写库（R1，核心）

- 修改 `src/main/database/media-repository.ts`：新增 `setThumbnailIfNull(filePath: string, thumbnailPath: string): boolean`，SQL `UPDATE media_files SET thumbnail = ? WHERE file_path = ? AND thumbnail IS NULL`（`file_path` 有 UNIQUE 索引），返回 `changes > 0`。
- 修改 `src/main/ipc/handlers/thumbnail-handler.ts`：`generate` 成功且满足第 5 节条件时回写；`changes > 0` 则 `ctx.invalidateMediaPathCache()`（对齐 `media-update.ts:77` 既有模式；cacheDir 路径本就被白名单规则 1 放行，此步覆盖游戏原生 LQ 写入 DB 后的精确匹配分支）。
- 测试（先红后绿）：
  - 新增 `src/main/ipc/handlers/__tests__/thumbnail-handler.test.ts`（复用 `_test-helpers`）：① generate 成功 → DB thumbnail 回写 + invalidate 被调；② generate 返回 null → 不写；③ quality='low' → 不写；④ 行已有 thumbnail → 不覆盖；⑤ 写库抛错 → IPC 仍返回路径。
  - `media-repository.test.ts` 增 `setThumbnailIfNull` 三态：NULL 行填补返回 true / 非 NULL 行不覆盖返回 false / 路径不存在返回 false。
- 输入：`filePath`（已过 `assertFileReadPath` + zod）；输出：`generate` 原返回值（`string | null`），不变。
- 验收：新测试红→绿；`npm run test:db` 全绿。

### N3 套装封面视频守卫（R3）

- 修改 4 文件：
  - `src/main/database/media-repository.ts` `getLatestOutfitMedia` SELECT 加 `file_type`（`OutfitLatestRow` 类型同步）；
  - `src/shared/scene-category.ts` `OutfitStat` 加 `coverFileType: 'image' | 'video' | null`；
  - `src/main/ipc/handlers/media-handler.ts:135` `getOutfitStats` 透传 `latest?.file_type ?? null`；
  - `src/renderer/pages/OutfitGalleryPage.tsx:38` `coverFileType === 'video' && !coverThumbnail` → 渲染 `IconVideo` 占位（复用现有占位分支结构），否则行为不变。
- 测试（先红后绿）：`media-repository.test.ts` 断言 `getLatestOutfitMedia` 返回 `file_type`；新建 `src/renderer/pages/OutfitGalleryPage.cover.test.tsx`：视频无缩略图 → 占位图标、无 `<img src=media://…视频路径>`；视频有缩略图 → 正常 `<img>`；图片封面 → 现状不变。
- 验收：相关测试文件红→绿。

### N4 全局校验（一票否决）

1. `npm test`（对照 N0 基线无新增失败）；2. `npm run test:main` + `npm run test:renderer`；3. `npm run typecheck`；4. `npm run lint`；5. `npm audit`（无新增高危）；6. 改动文件 `npx prettier --check`；7. `npm run dist:win` + `npm run e2e:smoke` 全绿。完成后回填本文档状态行并提交批次二。

## 7. 基础测试用例矩阵

| 节点 | 正常流程                          | 异常场景                                | 边界条件                                       |
| ---- | --------------------------------- | --------------------------------------- | ---------------------------------------------- |
| N1   | Map 命中 → 回填已生成路径         | promise resolve null → onDemandFailed   | 重复回填幂等（prev.has 守卫）；视频同逻辑      |
| N2   | NULL 行回写 + invalidate 调用一次 | generate null / 写库抛错 → IPC 不受影响 | 非 NULL 行不覆盖；quality=low 不写；changes=0  |
| N3   | 图片封面行为不变                  | 视频无缩略图 → 占位，不发 `<img>` 请求  | 视频有缩略图 → 正常显示；file_type 缺失→按现状 |

## 8. 明确不做（范围外）

- 游戏原生缩略图复用链路改动（已实现，见第 1 节验证结论）。
- DuplicatesPage 内联逻辑迁移到 `resolveThumbnailSrc`（无行为变化的重构）。
- 启动修复扩展到"图片 thumbnail NULL 且尺寸齐全"行（N2 写库闭环即可，避免启动 IO 峰值；该行何时被浏览何时生成并持久化）。
- `onDemandThumbPromises` 模块级 Map 治理（会话级缓存语义，主进程磁盘缓存 + generatingLocks 兜底）。
- media-protocol 206 Range 恒用 IMMUTABLE 头（`<img>` 不发 Range 请求，影响极小）。
- LRU `enforceCacheLimit` 不校验 DB 引用（容量管理固有行为，悬空行由启动修复兜底）。
