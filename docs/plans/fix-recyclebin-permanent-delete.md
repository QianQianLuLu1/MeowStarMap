# 修复「清空回收站 / 永久删除后原图片文件与缩略图缓存残留磁盘」实施计划

> 状态：待确认 | 关联 Bug：右键删除（移入软件内回收站）→「清空回收站」（含清空系统回收站环节）后，原图片文件及其缩略图缓存文件未物理删除，仍残留在磁盘上。

## 0. 根因分析（两层）

### 根因 A（核心）：「彻底删除」误用 `shell.trashItem`，语义是「移入系统回收站」而非「物理删除」

`media:permanentDelete` 阶段 2 与 `media:emptyRecycleBin` 共用 `src/main/ipc/handlers/_trash-utils.ts` 的 `trashBatch` → `trashItemWithFallback`，对每条记录的 `file_path` 调用 Electron `shell.trashItem()`。该 API 的行为是**把文件从原位置移动到 Windows 系统回收站（`$Recycle.Bin`）**，文件本身仍占用磁盘空间，只有用户再手动清空系统回收站后才会消失。三个佐证说明「物理删除」才是设计意图：

1. 渲染端 ConfirmDialog 确认文案（`src/renderer/i18n/locales/zh-CN.json` 3034 行）：「文件将被直接删除（**不进入回收站**）。是否继续？」——用户确认的是直接删除，实际却把文件又送进了系统回收站；
2. 图库单文件链路 `file:deletePermanent`（`src/main/services/file-service.ts` `deletePermanent`）已经用 `fsp.unlink` **物理删除**——同为「永久删除」，两条链路行为不一致；
3. `_trash-utils.ts` 自身注释记录了 Windows Shell API 的实测缺陷：大批量连续调用 `trashItem` 时 2474 项中 94.5% 瞬时失败（「Failed to perform delete operation」），失败项文件留在原位置、DB 保留——不可靠且不可控。

用户可见后果（与 Bug 现象一一对应）：

- 清空软件内回收站后，原图片文件被转移到 `$Recycle.Bin` 继续占磁盘（即使随后清空系统回收站，下一轮删除又会重复此路径）；
- Windows Shell 大批量瞬时失败时，文件干脆留在原位置，DB 记录保留。

### 根因 B：`media:emptyRecycleBin` 完全缺失缩略图缓存清理

对比 `media:delete` 与 `media:permanentDelete` 阶段 4（均调用 `cleanupThumbnailsForRows`），`media:emptyRecycleBin` 在 `hardDeleteBatch` 后**没有**任何缩略图清理；且 `MediaRepository.getSoftDeletedMediaPaths` 的 SQL（`SELECT id, file_path FROM media_files WHERE is_deleted = 1`）未查询 `thumbnail` 列，即使补调用也拿不到缩略图路径。DB 记录删除后缩略图缓存文件成为永久孤儿，残留在磁盘上。

### 关键取舍（Windows 平台约束，需评审知悉）

预期行为第 1 条「软件内删除：文件移入系统回收站」与第 2 条「清空回收站：将文件**从系统回收站**彻底删除（物理删除）」在 Windows 平台上互斥：Electron/Node 没有「精确删除系统回收站中某一项」的原生 API（`Clear-RecycleBin` 会全清，误伤用户其他文件；COM 枚举 `$Recycle.Bin` 属于重复造轮子且极脆弱）。若软删除时移入系统回收站，则第 2 条永远无法满足——这正是当前 Bug 的形态。

因此本计划采用：**软删除保持现状（仅 DB 标记 `is_deleted=1`，文件留在原位置、可随时恢复）；清空回收站 / 永久删除时对原路径文件执行 `fsp.unlink` 物理删除**（不经过系统回收站）。效果：文件与缩略图真正从磁盘消失；对「外部已删除（原路径 ENOENT）」的记录判 missing、仅删 DB，其残留在系统回收站的实体由 Windows 自身机制管理（软件不越权全清）。

## 1. 依赖与 API 声明

**零新增依赖**。全部复用既有能力：

| API / 工具                 | 来源                                 | 用途                                                                                          |
| -------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `fsp.unlink`（Node 内置）  | `fs/promises`                        | 物理删除单个文件（与 `fileService.deletePermanent`、`cleanupThumbnailsForRows` 同一删除原语） |
| `pathExists`               | `src/main/utils/file-utils.ts`       | unlink 失败后复检文件是否仍存在（三态判定兜底）                                               |
| `cleanupThumbnailsForRows` | `_trash-utils.ts`（既有）            | 缩略图缓存 best-effort 清理（仅限缓存目录前缀内）                                             |
| 重试 / 熔断 / 聚合日志骨架 | `_trash-utils.ts`（既有）            | 平移到物理删除场景，机制不变                                                                  |
| Vitest mock 基建           | `media.test.ts`（既有 `unlinkMock`） | 测试改造，不引入新 mock 设施                                                                  |

无新增 npm 包、无原生模块、无系统 API 变更。

## 2. 环境准备与启动

- 环境要求：Node.js ≥ 20；`npm install` 已完成（better-sqlite3 等原生依赖无需重编）。
- 开发启动：`npm run dev`（electron-vite dev）。
- 人工复现步骤（修复前）：右键照片「删除」→ 回收站页「清空回收站」→ 确认 → 用 Everything/资源管理器在原照片目录与缩略图缓存目录（`%APPDATA%` 下 thumbnails）检查：原图片被移入系统回收站目录（磁盘未释放）或因 Shell 瞬时失败仍在原位置；缩略图缓存文件仍在。
- 人工验证（修复后）：同样操作后，原图片文件与缩略图缓存文件均从磁盘消失，回收站列表清空；失败项（如被占用文件）保留在软件回收站中可重试。
- 自动化验收：`npx vitest run src/main/ipc/handlers/media.test.ts src/main/database/media-repository.test.ts` 全绿；`npm test` 全量无新增失败；`npm run typecheck`、`npm run lint` 无新增错误。

## 3. 错误处理

| 分支                            | 行为                                                                                          | 兜底 / 日志                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| unlink 成功                     | 三态 `ok` → 统计 movedCount，DB 记录可删                                                      | —                                                                                                                                     |
| unlink 抛 ENOENT                | 三态 `missing`（文件已不存在）→ 删 DB，不计失败                                               | pathExists 复检兜底（unlink 实现差异）                                                                                                |
| unlink 抛 EBUSY/EPERM/EACCES 等 | 指数退避重试（50ms→100ms，最多 2 次重试）；每次重试前 pathExists 复检，文件消失立即判 missing | 重试用尽且文件仍存在 → 三态 `failed`：**不删 DB**（B1 数据安全约定，保留供重试），聚合成一条 `logger.warn`（样例路径 ≤ 3 + 首个错误） |
| 连续失败 ≥ 10                   | 熔断：后续项不再重试（仍尝试 1 次），防大批量场景分钟级卡顿                                   | 聚合日志已含总数与样例                                                                                                                |
| 缩略图清理失败                  | best-effort：pathExists 预检 + 逐文件 try/catch，仅聚合 `logger.warn`                         | 不阻断删除主流程、不影响 IPC 返回值；**绝不触碰**缓存目录前缀之外的文件（游戏原生 LQ `NikkiPhotos_LowQuality` 等）                    |
| 回收站为空                      | 提前返回 `recycleBinEmpty` 提示，movedCount=0                                                 | —                                                                                                                                     |
| 用户取消主进程确认框            | 维持现状：`AppError.canceled`（`media:emptyRecycleBin` 的原生确认不在本次 Bug 范围，不动）    | —                                                                                                                                     |

日志 i18n：`main.media.log.recycleBinMoveFailed` 文案随语义更新（见 T5），key 名不变（契约稳定）。

## 4. 参数校验

入参完全不变，无新增校验面：

- `media:permanentDelete`：`schemas.mediaIdArrayBulk`（非空正整数数组，≤1000）；
- `media:emptyRecycleBin`：无参（`wrapHandlerNoArgs`）；
- 返回值字段与类型**逐字不变**（`{ message, movedCount, missingCount, failedCount }` / `{ message, deletedCount, failedCount }`），仅 `movedCount` 的语义由「移入系统回收站数」变为「物理删除成功数」，在契约文档中注明；渲染端仅消费 `message` 与 `failedCount`，无需改动。

## 5. 子任务分解（严格 TDD：先红灯后修复）

### T1 红灯——新增复现 Bug 的失败测试

| 项       | 内容                                                                                                      |
| -------- | --------------------------------------------------------------------------------------------------------- |
| 修改文件 | `src/main/ipc/handlers/media.test.ts`（新增 4 个用例，见第 6 节 R1–R4）                                   |
| 输入     | mock `getSoftDeletedMediaPaths` / `getMediaPathsByIds` 返回带 `thumbnail` 的行；`showMessageBoxMock` 确认 |
| 输出     | R1–R4 运行**全部失败**（unlink 未被调用 / trashItem 仍被调用 / 缩略图未清理），证明测试覆盖了 Bug         |
| 验收标准 | `npx vitest run src/main/ipc/handlers/media.test.ts` 中 R1–R4 红、其余既有用例绿                          |

### T2 `_trash-utils.ts`：trashItem → unlink 物理化（最小改动核心）

| 项       | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 修改文件 | `src/main/ipc/handlers/_trash-utils.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 改动     | ① `trashItemWithFallback` 重命名为 `unlinkWithFallback`：`shell.trashItem(filePath)` 改为 `fsp.unlink(filePath)`；三态判定、重试退避、pathExists 复检、熔断参数（常量与阈值不变）全部保留；移除 `electron` 的 `shell` import。② `trashBatch` → `unlinkBatch`、`TrashItemResult` → `UnlinkResult`、`TrashBatchOutcome` → `UnlinkBatchOutcome`（仅重命名，聚合日志逻辑逐行保留）。③ 模块头与函数注释更新（A-retry 的 Shell 瞬时失败背景改述为文件占用类瞬时失败，重试机制理由不变） |
| 输入     | `rows: readonly { id, file_path }[]`                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 输出     | `UnlinkBatchOutcome { idsToDelete, movedCount（物理删除成功数）, missingCount, failedPaths }`                                                                                                                                                                                                                                                                                                                                                                                     |
| 验收标准 | T7 平移后的三态 / 重试 / 熔断 / 日志聚合用例全绿；`shell` 不再被生产代码引用                                                                                                                                                                                                                                                                                                                                                                                                      |

### T3 `media-lifecycle-handler.ts`：清空回收站补缩略图清理 + 语义注释

| 项       | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 修改文件 | `src/main/ipc/handlers/media-lifecycle-handler.ts`                                                                                                                                                                                                                                                                                                                                                                                                  |
| 改动     | ① import 改为 `unlinkBatch`；`media:permanentDelete` 阶段 2 注释「逐个移至系统回收站」→「逐个物理删除（fsp.unlink）」。② `media:emptyRecycleBin` 在 `hardDeleteBatch` 后**新增阶段**：`const deletedRows = rows.filter((r) => idsToDelete.includes(r.id)); await cleanupThumbnailsForRows(deletedRows, ctx.thumbnailGen.getCacheDir())`（与 permanentDelete 阶段 4 完全同构；failed 行保留 DB，其缩略图一并保留待重试成功后清理）。③ 模块头注释同步 |
| 输入     | `getSoftDeletedMediaPaths()` 行（T4 后含 thumbnail）                                                                                                                                                                                                                                                                                                                                                                                                |
| 输出     | IPC 返回结构不变；磁盘副作用变为：文件物理删除 + 缩略图清理                                                                                                                                                                                                                                                                                                                                                                                         |
| 验收标准 | R1–R4 转绿；`media:delete` 等无关通道不受影响                                                                                                                                                                                                                                                                                                                                                                                                       |

### T4 `media-repository.ts`：`getSoftDeletedMediaPaths` 补 thumbnail 列

| 项       | 内容                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 修改文件 | `src/main/database/media-repository.ts`                                                                                      |
| 改动     | SQL 改为 `SELECT id, file_path, thumbnail FROM media_files WHERE is_deleted = 1`，注释补「含缩略图，供清空回收站后清理缓存」 |
| 输入     | 软删除记录                                                                                                                   |
| 输出     | `IdPathRow[]`（thumbnail 可选字段填充）                                                                                      |
| 验收标准 | `src/main/database/media-repository.test.ts` 既有用例不破坏；在其中补断言 `thumbnail` 列被返回并绿                           |

### T5 i18n 文案对齐（仅 zh-CN 有值，其余语言为空串 fallback，无需触碰）

| 项       | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 修改文件 | `src/renderer/i18n/locales/zh-CN.json`（3 处）                                                                                                                                                                                                                                                                                                                                                                                                       |
| 改动     | ① 2845 行 `main.media.dialog.permanentDeletePartial`：「（{{failed}} 项移至回收站失败…）」→「（{{failed}} 项删除失败，已保留记录供手动处理）」；② 2832 行 `main.media.dialog.permanentDeleteDetail`：「文件将被移至系统回收站…」→「文件将被直接删除（不进入回收站），记录将从数据库永久清除。是否继续？」（与渲染端 ConfirmDialog 文案对齐）；③ 2856 行 `main.media.log.recycleBinMoveFailed`：「移至系统回收站失败」→「物理删除失败」（key 名不变） |
| 验收标准 | `npm run typecheck` 通过；key 结构不变（12 语言包 key 集合一致）                                                                                                                                                                                                                                                                                                                                                                                     |

### T6 契约文档同步

| 项       | 内容                                                                                                                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 修改文件 | `docs/IPC_CONTRACT.md`                                                                                                                                                                              |
| 改动     | 2.7 节：三阶段描述「trashItem」→「物理删除（fsp.unlink）」，`failedCount` 注释更新；新增 2.8 节 `media:emptyRecycleBin`（通道 / 参数 / 返回结构 / movedCount 语义 / 缩略图清理行为 / 确认语义现状） |
| 验收标准 | 文档与代码行为一致，无遗留「移至系统回收站」描述                                                                                                                                                    |

### T7 既有测试平移改造（trashItem → unlink）

| 项       | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 修改文件 | `src/main/ipc/handlers/media.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 改动     | ① `beforeEach` 中 `unlinkMock.mockClear()` → `unlinkMock.mockReset().mockResolvedValue(undefined)`（防止三态用例的 rejected 实现泄漏到后续用例）；② 8 个 `emptyRecycleBin` trashItem 用例（成功 / missing / failed / 重试成功 / 重试用尽 / 重试期间消失 / 日志聚合 / 熔断）逐个平移为 unlink 版本（resolve → ok；reject `{ code: 'ENOENT' }` → missing；reject Error 且 pathExists=true → failed），断言目标由 `trashItemMock` 换为 `unlinkMock`；③ `permanentDelete` 3 个用例平移，其中「仅清理缓存目录内缩略图」用例断言重写（unlink 现在承担文件删除 + 缩略图清理两种调用，用 `toHaveBeenCalledWith` 逐路径断言，缓存目录外 LQ 路径断言 not called）；④ 移除 `trashItemMock` 变量与断言（electron mock 中 `shell` 对象保留，防止无关模块 import 报错） |
| 验收标准 | `npx vitest run src/main/ipc/handlers/media.test.ts` 全绿                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### T8 全局回归与静态校验

| 项       | 内容                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------- |
| 执行     | `npm test`（全量 Vitest）→ `npm run typecheck` → `npm run format`（仅限本次触碰文件）→ `npm run lint` |
| 验收标准 | 全量测试无新增失败；typecheck / lint 零新增错误；未通过不得结束任务                                   |

## 6. 基础测试用例矩阵（R = 红灯用例，修复前必须失败）

### 正常

| #    | 用例                                                          | 断言要点                                                                  |
| ---- | ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| R1   | `emptyRecycleBin` 确认后对每个文件物理删除且不再调 trashItem  | `unlinkMock` 以 `/a` 被调用；`trashItem` 未被调用；DB 已删、movedCount=1  |
| R2   | `emptyRecycleBin` 删除 DB 后清理缓存目录内缩略图              | rows 带 `thumbnail: 'C:\cache\thumbnails\t1.jpg'` → unlink 以该路径被调用 |
| R3   | `permanentDelete` 对每个文件物理删除且不再调 trashItem        | 同 R1（`getMediaPathsByIds` 路径）                                        |
| 平移 | 三态全绿（成功计 movedCount / ENOENT 计 missing / 失败保 DB） | 继承既有 B1 回归语义                                                      |

### 异常

| #    | 用例                               | 断言要点                                                       |
| ---- | ---------------------------------- | -------------------------------------------------------------- |
| 平移 | unlink 首次失败（EBUSY）重试后成功 | movedCount=1、failedCount=0、DB 已删                           |
| 平移 | 重试用尽仍失败（文件仍存在）       | failedCount=1、DB 保留（`hardDeleteBatch([])`）、恰好 3 次尝试 |
| 平移 | 多项失败日志聚合为 1 条            | `loggerWarnMock` 恰好 1 次                                     |
| 平移 | 连续失败达阈值熔断                 | 尝试次数显著小于 14×3                                          |

### 边界

| #             | 用例                                                                                     | 断言要点                                                         |
| ------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 平移          | 重试期间文件消失 → 立即判 missing 停止重试                                               | missingCount=1、仅 2 次尝试、DB 已删                             |
| 既有          | 回收站为空提前返回                                                                       | movedCount=0、不弹确认框                                         |
| R4（并入 R2） | 缩略图安全边界：游戏 LQ 路径（`NikkiPhotos_LowQuality\...`）与缓存目录外路径不清理       | unlink 未以 LQ 路径被调用；仅 `cacheDir` 前缀内的 thumbnail 被删 |
| 既有          | 契约锁：data 仅含 `{ message, movedCount, missingCount, failedCount }` 无 `success` 字段 | 渲染端 `call()` 解析兼容                                         |
| 新增（T4）    | DB 层 `getSoftDeletedMediaPaths` 返回 thumbnail 列                                       | `result[0].thumbnail` 为插入值                                   |

## 7. 明确不做（防止范围蔓延）

- 不改软删除行为（不引入「软删除即移入系统回收站」——见第 0 节取舍）；`media:softDelete` / `media:restore` / `restoreBatch` 零改动。
- 不动 `media:delete`（图库「从库中移除记录」语义：hardDelete + 缩略图清理，文件由 `file:deletePermanent` 链路负责且已是 unlink）。
- 不实现「清空 Windows 系统回收站」（无精确 API，全清会误伤用户其他文件）；对原路径 ENOENT 的记录仅删 DB。
- 不动 `media:emptyRecycleBin` 的主进程原生确认弹窗（不在本次 Bug 范围）。
- 不重命名 `_trash-utils.ts` 文件（避免牵连 import 与文档引用；文件头注释说明职责）。
