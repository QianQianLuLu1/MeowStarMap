# 实施计划：图库「删除 / 永久删除」同步清理关联缩略图（缩略图缓存 + 游戏原生 LQ）

> 任务来源：优化"图库"板块中图片的"删除"与"永久删除"逻辑——删除图片源文件时必须同步清理其关联的所有缩略图文件。
> 状态：**已执行完成（2026-09-09）**——TDD 红绿闭环通过：新增 `_trash-utils.test.ts`（17 用例）+ `media.test.ts` 4 用例先行红灯，实现后全绿；全量 `npm test` 4697/4697、`npm run typecheck`、`npm run lint` 均通过。

---

## 0. 现状与根因分析

### 0.1 现有删除链路矩阵（图库板块及其延伸）

| 用户操作                               | 渲染端调用                                                                     | 主进程行为                                                 | 缩略图现状                                       |
| -------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------ |
| 图库「永久删除」                       | `file:deletePermanent` → `media:delete`                                        | 物理删除源文件 → 硬删 DB 记录 → `cleanupThumbnailsForRows` | 仅清 thumbnail 列指向的**单个**缓存文件          |
| 详情页/全屏查看器「删除」              | `file:delete` → `media:delete`（DetailPage.tsx:187、FullscreenViewer.tsx:174） | 源文件移入系统回收站 → 硬删 DB 记录 → 同上                 | 同上                                             |
| 图库「删除」（常规，可撤销）/ 批量删除 | `file:delete` → `media:softDelete`                                             | 源文件移入系统回收站 → DB 仅标记 is_deleted=1（记录保留）  | 完全不清理（记录还在，回收站列表仍需渲染缩略图） |
| 回收站「彻底删除」/「清空」            | `media:permanentDelete` / `media:emptyRecycleBin`                              | 三阶段事务（unlink 源文件 → 硬删记录）+ 阶段 4 清缓存      | 同 media:delete                                  |

### 0.2 缺口（本任务要修的 Bug）

1. **缓存档位遗漏**：缩略图生成器对每个文件落盘三个档位 `${fileHash}.jpg` / `${fileHash}_low.jpg` / `${fileHash}_high.jpg`（见 `src/main/thumbnail/generator.ts`），而 `cleanupThumbnailsForRows` 只删 DB `thumbnail` 列指向的那一个文件，`_low`/`_high` 两个伴生档位成为孤儿（仅能靠 2GB LRU 被动淘汰）。
2. **游戏原生 LQ 遗漏**：GamePlayPhotos 高清原图（HQ）对应的原生低清缩略图（`...\GamePlayPhotos\{UID}\NikkiPhotos_LowQuality\同名文件`）**从不清理**。游戏目录没有 LRU 上限约束，每张被永久删除的照片都会永久遗留一份原生缩略图（无界增长）。
3. **连带一致性风险**（探索期新发现）：LQ 文件本身也会被扫描器作为独立媒体记录入库（`scene-category.ts` 定义 `thumbnail` 场景分类匹配 `NikkiPhotos_LowQuality`；`worker-entry.ts` 对 GPP 子树全量遍历且豁免小图过滤）。若只删 LQ 文件而不硬删其 DB 记录，会制造"指向已删除文件"的悬空记录。

### 0.3 现有安全策略重点分析（按任务要求）

`cleanupThumbnailsForRows`（`src/main/ipc/handlers/_trash-utils.ts`）现有策略：**仅删除 cacheDir 前缀内的文件，绝不触碰游戏原生文件**。

- **保留不变**：以 DB `thumbnail` 列为依据的清理仍严格限定 cacheDir 前缀内（`path.resolve` + 小写化 + `path.sep` 边界判定，既有逻辑不动）。理由：thumbnail 列可能指向任意历史路径，不可作为触碰缓存外文件的依据。
- **新增原生 LQ 清理的依据**：**不使用 thumbnail 列**，改用 `resolveNativeThumbnailPath(row.file_path)`（`src/main/scanner/path-classifier.ts` 纯函数）从**源文件路径**严格推导：
  - 必须同时命中完整目录特征 `\X6Game\Saved\GamePlayPhotos\` **且** `\NikkiPhotos_HighQuality\` 段（大小写不敏感），否则返回 null、不做任何清理——用户自建同名目录、LQ 目录自身的记录、普通图片路径全部不命中；
  - 推导结果 = 原路径上 HQ 段同位置替换为 `NikkiPhotos_LowQuality`，文件名与其余部分逐字符保留 → 只可能删到"与被删照片同名、位于兄弟 LQ 目录"的那**一个**文件；
  - 该推导函数与扫描入库（`worker-entry.ts`）、存量修复（`repair-legacy-data-v6.ts`）、缩略图豁免（`generator.ts`）共用同一口径，口径一致性已在仓库内经测试锁定；
  - 额外防御：推导结果若与**同批次任一 row 的 file_path 相同**（该 LQ 记录自身也在本批删除）则跳过文件级清理（由其自身记录的删除流程处理，避免重复 unlink）；沿用 pathExists 预检 + 逐文件 try/catch + 聚合日志的 best-effort 语义。
- **软删除阶段明确不清缩略图**（决策，请评审确认）：
  1. 回收站列表用 `file.thumbnail || file.file_path` 渲染缩略图（`RecycleBinPage.tsx:497`）——记录还在就还需要缩略图，提前清理会让回收站网格全部裂图；
  2. 原生 LQ 是不可再生的游戏资产；软删除可逆，"应用内恢复 + 用户从系统回收站手动还原 HQ"这条完整恢复路径依赖 LQ 存活（图库网格对空缩略图虽可回退原图展示，但 HQ 大图做缩略图代价高）；
  3. 缓存目录有 2GB LRU 上限自约束，无泄漏风险。
     因此"删除（软删除）"的缩略图随记录保留，统一在**记录被不可逆移除**时（`media:delete` / `media:permanentDelete` / `media:emptyRecycleBin`）清理——这三个通道恰好覆盖图库永久删除、详情页/全屏删除、回收站彻底删除与清空。

---

## 1. 依赖声明

**零新增 npm 依赖、零新增原生模块、零系统 API 变更**。全部复用既有能力：

| 复用项                                            | 来源                                                        | 用途                                                   |
| ------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------ |
| `resolveNativeThumbnailPath`                      | `src/main/scanner/path-classifier.ts`（纯函数，无循环依赖） | 由 HQ 路径严格推导原生 LQ 路径（本身就是路径安全闸门） |
| `pathExists` / `fsp.unlink`                       | `src/main/utils/file-utils.ts` / Node 内置                  | 缩略图文件预检与物理删除（与现有清理同一删除原语）     |
| `MediaRepository.getMediaIdByPath` / `hardDelete` | `src/main/database/media-repository.ts`（已有方法）         | 按路径定位并硬删 LQ 记录                               |
| Vitest mock 基建                                  | `media.test.ts` 既有 `unlinkMock`/`pathExistsMock`          | 测试改造，不引入新 mock 设施                           |

安装方式：无需安装（`npm install` 已完成的现有依赖树）。

## 2. 启动说明

- 环境准备：Node.js ≥ 20，依赖已装（无新增依赖，无需重装/重编原生模块）。
- 启动命令：`npm run dev`（electron-vite dev）。
- 人工验证方式（修复后）：
  1. 图库右键照片「永久删除」→ 检查缓存目录（`%APPDATA%\<app>\thumbnails`）中该图 `${hash}.jpg`、`${hash}_low.jpg`、`${hash}_high.jpg` 三档位均消失；若是 GamePlayPhotos HQ 照片，游戏 `NikkiPhotos_LowQuality` 目录中同名文件消失，且应用内「缩略图」场景分类下该 LQ 记录消失；
  2. 回收站「清空回收站」→ 同上验证；
  3. 图库常规「删除」（软删除）→ 缩略图**不**清理（回收站列表正常显示），彻底删除/清空后才清理。
- 自动化验收：见 §6 验收标准与 §7 回归命令。

## 3. 错误处理

| 分支                                          | 行为                                                                                    | 兜底 / 日志                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 缓存/原生缩略图 unlink 失败（EBUSY/EPERM 等） | best-effort：pathExists 预检 + 逐文件 try/catch                                         | 聚合一条 `logger.warn`（沿用现有 `[media-cleanup]` 日志样式），不阻断删除主流程、不影响 IPC 返回值 |
| 原生 LQ 记录硬删失败（hook 抛错）             | 吞掉并聚合日志，不影响返回值                                                            | 残留记录可经既有「清理丢失记录」（media:cleanupMissing）兜底                                       |
| 非法路径 / path.resolve 抛错                  | 跳过该目标（既有逻辑）                                                                  | 不计入失败                                                                                         |
| LQ 文件已不存在（missing）                    | 不 unlink；**仍触发**记录清理 hook（记录此刻已悬空，应移除）                            | —                                                                                                  |
| unlink 抛错但复检文件已消失                   | 视为 missing，触发 hook（竞态兜底）                                                     | —                                                                                                  |
| 推导 LQ 与批内其他 row 的 file_path 相同      | 跳过文件级清理（由其自身记录流程删除，幂等）                                            | —                                                                                                  |
| IPC 返回值                                    | `media:delete`/`permanentDelete`/`emptyRecycleBin` 三个通道的返回结构与字段**逐字不变** | 渲染端零改动                                                                                       |

日志规范：沿用 `_trash-utils.ts` 现有聚合日志样式（中文主进程日志，非用户可见 UI 文案，不新增 i18n key），warn 消息扩展为包含「缓存已删/原生已删/记录已删」计数。

## 4. 参数校验

- **不新增 IPC 入参**：`media:delete`（`schemas.mediaId`）、`media:permanentDelete` / `media:emptyRecycleBin`（既有 schema）完全不变；无新通道、无 preload 变更。
- 内部函数边界：
  - rows 元素缺 `file_path`（兼容旧调用方类型）→ 仅按 thumbnail 做缓存清理，跳过原生推导；
  - `thumbnail` 为 null/空/非法 → 跳过缓存清理；
  - `cacheDir` 为空串 → 直接返回 0（既有行为）；
  - 缓存档位推导仅接受 cacheDir 内 `.jpg` 文件名（`${hash}` 为 sha256 十六进制切片，不含下划线，`_low`/`_high` 后缀剥离无歧义）；非 `.jpg` 命名仅删除引用文件本身（维持现有行为）。

## 5. 改动清单（子任务）

### T1 缩略图清理工具增强（核心逻辑）

- **需修改文件**：`src/main/ipc/handlers/_trash-utils.ts`
- **输入**：`rows: readonly { file_path?: string; thumbnail?: string | null }[]`、`cacheDir: string`、可选 `hooks?: { onNativeThumbnailRemoved?: (lqPath: string) => Promise<void> }`
- **输出**：
  - `cleanupThumbnailsForRows(...)` 返回实际删除的文件总数（返回值类型不变，调用方现均未消费）；
  - 新增导出 `makeNativeThumbRecordCleaner(repo)`：基于结构类型 `{ getMediaIdByPath(p): number | undefined; hardDelete(id): Promise<void> }` 生成"按路径硬删 LQ 记录"的 hook 工厂；
  - 新增内部（导出供测试）目标收集函数：对每行产出缓存目标（引用文件 + 三档位去重）与原生目标（严格推导 + 排除批内 file_path + 排除 cacheDir 内路径 + 去重）。
- **验收标准（可客观判定）**：新增 `src/main/ipc/handlers/_trash-utils.test.ts` 全绿（用例见 §6-A）；现有 `media.test.ts` 全部用例不回退。

### T2 三个 handler 接线

- **需修改文件**：`src/main/ipc/handlers/media-lifecycle-handler.ts`（仅此一个文件，3 处调用点）
- **输入/输出**：`media:delete`、`media:permanentDelete`（阶段 4）、`media:emptyRecycleBin`（阶段 4）的 `cleanupThumbnailsForRows` 调用传入 `onNativeThumbnailRemoved: makeNativeThumbRecordCleaner(repo)`；`getMediaPathsByIds` / `getSoftDeletedMediaPaths` 返回的行已含 `file_path` + `thumbnail`，无需改仓储层。
- **验收标准（可客观判定）**：`media.test.ts` 新增 3 个 handler 级用例转绿（断言：unlink 调用了推导 LQ 路径 + `repoMock.getMediaIdByPath` 收到 LQ 路径 + `repoMock.hardDelete` 收到 LQ 记录 id）；现有「非 GPP file_path 的 LQ thumbnail 不触碰」用例保持绿（其 file_path 不命中推导规则，行为不变）。

### T3 文档同步

- **需修改文件**：`docs/IPC_CONTRACT.md`
- **内容**：§2.7（media:permanentDelete）与 §2.8（media:emptyRecycleBin）中"阶段 4 仅限应用缩略图缓存目录内（游戏原生 LQ 不触碰）"的行为描述更新为"缓存目录内（含 `_low`/`_high` 档位）+ 由 file_path 严格推导的游戏原生 LQ 文件及其 DB 记录"；§2.6（media:delete）如有同类描述同步更新。**通道名、参数、返回值不变**（无破坏性契约变更，无新增通道）。

### T4 全局回归

- **验收标准（可客观判定）**：
  1. `npx vitest run src/main/ipc/handlers/media.test.ts src/main/ipc/handlers/_trash-utils.test.ts` 全绿；
  2. `npm test`（全量）无新增失败；
  3. `npm run typecheck` 0 错误；
  4. `npm run lint` 0 新增错误（必要时先 `npm run format`）。

## 6. 基础测试用例（TDD：先红灯，后转绿）

### A. `src/main/ipc/handlers/_trash-utils.test.ts`（新增，单元级）

mock 方式与 `media.test.ts` 一致（`fs/promises.unlink`、`file-utils.pathExists`、`logger`；不 mock path-classifier——纯函数直接跑真实现）。

| #   | 类别 | 用例                                                                                                              | 断言要点                                                                                                 |
| --- | ---- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| A1  | 正常 | GPP HQ 行（file_path 含 `\X6Game\Saved\GamePlayPhotos\1001\NikkiPhotos_HighQuality\p.jpg`，thumbnail 为 LQ 路径） | 原生目标 = 推导 LQ 路径；thumbnail 为 LQ 路径（不在 cacheDir）→ 无缓存目标；删除后 hook 以 LQ 路径被调用 |
| A2  | 正常 | 行 thumbnail = `C:\cache\thumbnails\abc123.jpg`（file_path 非 GPP）                                               | 目标含 `abc123.jpg` + `abc123_low.jpg` + `abc123_high.jpg` 三档位；hook 不被调用                         |
| A3  | 边界 | thumbnail = `C:\cache\thumbnails\abc123_low.jpg`                                                                  | 规范化推导出三档位（`abc123.jpg`/`_low`/`_high`），引用文件与档位去重                                    |
| A4  | 边界 | 行 file_path 本身是 LQ 路径（无 HQ 段）                                                                           | 不推导（防自指）；thumbnail 为 null → 目标为空                                                           |
| A5  | 边界 | 同批两行：HQ 行推导出的 LQ 路径 = 另一行 file_path                                                                | 原生目标排除该路径（由其自身行处理）                                                                     |
| A6  | 边界 | thumbnail 在 cacheDir 外（非 LQ 的任意外部路径）                                                                  | 无缓存目标（前缀校验锁，现有行为回归）                                                                   |
| A7  | 异常 | unlink 对某目标抛 EBUSY 且文件仍存在                                                                              | 该目标不计删除数；其余目标照删；聚合 warn 被调用；**原生目标失败时 hook 不被调用**                       |
| A8  | 异常 | unlink 抛 ENOENT 且 pathExists 复检为 false                                                                       | 视为 missing；原生目标 missing 仍触发 hook                                                               |
| A9  | 异常 | hook 抛错                                                                                                         | 吞掉 + 聚合日志；函数正常返回已删数                                                                      |
| A10 | 异常 | cacheDir 为空串 / 非法路径行                                                                                      | 返回 0 / 跳过该行                                                                                        |

### B. `src/main/ipc/handlers/media.test.ts`（新增 handler 级，红灯断言）

`repoMock` 需补 `getMediaIdByPath`（默认返回 undefined，用例内按需覆盖）。沿用现有 `makeCtx()`（cacheDir = `C:\cache\thumbnails`）。

| #   | 通道                    | 用例                                                                                                                                                                        | 红灯断言（修复前失败）                                                           |
| --- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| B1  | `media:delete`          | GPP HQ 行：`file_path = C:\game\X6Game\Saved\GamePlayPhotos\1001\NikkiPhotos_HighQuality\p.jpg`，`thumbnail = ...\NikkiPhotos_LowQuality\p.jpg`，`getMediaIdByPath` 返回 99 | `unlinkMock` 收到 LQ 路径；`getMediaIdByPath` 收到 LQ 路径；`hardDelete` 收到 99 |
| B2  | `media:delete`          | 非 GPP 行 thumbnail 指向 cacheDir 内 `t8.jpg`                                                                                                                               | 额外断言 `_low`/`_high` 档位被 unlink（缓存档位清理）                            |
| B3  | `media:permanentDelete` | 阶段 4 同 B1（deletedRows 内含 GPP HQ 行）                                                                                                                                  | 同 B1                                                                            |
| B4  | `media:emptyRecycleBin` | 同 B1（行来自 `getSoftDeletedMediaPaths`）                                                                                                                                  | 同 B1                                                                            |
| B5  | 回归锁                  | 现有两处「非 GPP file_path 的 LQ thumbnail 不触碰」用例（行 437/637）                                                                                                       | 保持绿（新策略下其 file_path 不命中推导，行为不变，无需改动）                    |

### C. 红灯确认方式

先只提交测试（T1/T2 代码未动）运行 §6 命令：A1~~A3、A5、A7~~A8、B1~~B4 因功能不存在而**失败（红灯）**；A4/A6/A10 部分为现有行为锁定可能直接绿（在计划中标注：这类用例是边界回归锁，非 bug 复现用例，不违反"红灯优先"要求——真正的 bug 复现用例是 A1/A2/A5/A8/B1~~B4）。红灯确认后再实现转绿。

## 7. 分步验证与回归

1. 节点 1（T1）：写 `_trash-utils.test.ts` → 确认红灯 → 实现 `_trash-utils.ts` → 该文件用例全绿。
2. 节点 2（T2）：写 `media.test.ts` 新用例 → 确认红灯 → 接线 handler → `media.test.ts` 全绿（含 B5 回归锁）。
3. 节点 3（T3）：更新 `docs/IPC_CONTRACT.md`（纯文档，无测试面）。
4. 节点 4（T4 全局）：`npm test` + `npm run typecheck` + `npm run lint`（先 `npm run format`）全绿后任务方可结束。

- 每一步由本 Agent 亲自运行、亲自修复报错；任何红灯未转绿不得进入下一步。

## 8. 禁止事项自查

- 不顺手重构/格式化无关代码；改动仅限 `_trash-utils.ts`、`media-lifecycle-handler.ts`、`media.test.ts`、新增 `_trash-utils.test.ts`、`docs/IPC_CONTRACT.md`。
- 不假设不存在的命令/文件：所有复用项（`resolveNativeThumbnailPath`、`getMediaIdByPath`、`hardDelete`、mock 基建、vitest 命令）均已在探索中确认存在。
- 不跳过/弱化测试：红灯用例均为真实 bug 复现；边界回归锁（A4/A6/A10/B5）单独标注。

## 9. 明确不在本次范围（记录待议）

- 图库软删除（`file:delete` + `media:softDelete`）阶段不清理缩略图（见 §0.3 决策）。
- 反向关联：用户单独删除 LQ 记录时，不回写 HQ 记录的 thumbnail 列（现有行为，HQ 缩略图会裂图，属既有边界）。
- `media-cleanup-handler.ts`（丢失/损坏记录清理）不接原生 LQ 清理（不同域，文件本已丢失，改动另行立项）。
- 插件桥 `plugin:media.delete` 仅移文件入系统回收站、不删 DB 记录，行为不变。
