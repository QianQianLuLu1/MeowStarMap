# 修复「永久删除后异常弹出到错误 Toast」实施计划

> 状态：已确认执行 | 关联 Bug：图库 / 回收站 / 重复页右键「永久删除」二次确认后右下角弹出 `deleteFailed` / `unknownError` 风格的红色「出错」Toast

## 0. 根因分析（三层）

### 根因 A（核心）：渲染端 3 处误读 preload `call()` 返回契约

preload 统一入口 `src/main/preload/ipc.ts` 的 `call<T>()` 契约：**成功时只返回业务数据 `T`（不含 `success` 字段），失败时抛 `IpcError`**。以下 3 处渲染代码仍按旧的 `IpcResponse` 形态读取 `result.success`，导致「删除实际成功、前端恒判失败」：

| #   | 文件:行                                                                                                   | 错误代码                                                          | 真实 data 形态                                                                     | 用户可见后果                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| A1  | `src/renderer/hooks/useFileOperations.ts`（`getDeleteConfirm` permanent 分支，`mediaAction.delete` 之后） | `if (!dbRes.success) throw new Error(dbRes.message)`              | `media:delete` → `{ deleted: true }`（无 `success`）                               | **恒 throw** → `staged.run` 捕获 → `final.phase='error'` → 红色 Toast；`deleteMediaFiles` 不执行（前端状态不同步） |
| A2  | `src/renderer/pages/RecycleBinPage.tsx`（`handlePermanentDelete`，`settleWithConcurrency` 回调内）        | `if (!r.success) throw new Error(r.message)`                      | `media:permanentDelete` → `{ message, deletedCount, failedCount }`（无 `success`） | **每项恒 throw** → `anyFailed` 恒 true → 「重试删除」按钮恒显示                                                    |
| A3  | `src/renderer/pages/DuplicatesPage.tsx`（`handleContextDeleteConfirm` permanent 分支）                    | `if (res.success) {…} else { showMessage(res.message, 'error') }` | 同 A2                                                                              | **恒走 else** → 恒弹红色 error Toast（文案是成功消息）→ `runScan` 不执行（列表不刷新）                             |

佐证：仓库已有同类修复先例——`RecycleBinPage.handleRestore`（`#fix-restore-sync`）与 `handleEmptyRecycleBin`（`#fix-empty-recycle-bin-contract`）注释均写明「preload call() 解包 IpcResponse 只回传 data（无 success 字段）」。永久删除链路的 3 处是遗漏点。

既有测试用**不真实 mock** 掩盖了问题：`useFileOperations.test.ts` 中 `api.mediaAction.delete.mockResolvedValue({ success: true })`（真实契约是 `{ deleted: true }`）；`DuplicatesPage.contextMenu.test.tsx` 中 mock 了不存在的方法名 `deletePermanently`（真实为 `permanentDelete`）。

### 根因 B（次级）：主进程 handler 重复二次确认

`file:deletePermanent`（`src/main/ipc/handlers/file.ts`）与 `media:permanentDelete`（`src/main/ipc/handlers/media-lifecycle-handler.ts`）内部各有一次 `dialog.showMessageBox` 原生确认（A-S3）。但两个通道的全部渲染端调用方（GalleryPage / RecycleBinPage / DuplicatesPage）在调用前**已经过 ConfirmDialog 二次确认**：

- 图库链路用户要点 2 次确认；回收站批量删除时**每个 id 弹 1 次**原生对话框（选 3 项弹 3 次）；
- 用户在原生弹窗点「取消」（或焦点异常导致返回取消）→ `AppError.canceled` → 渲染端 `IpcError` → 红色 Toast，违背「二次确认后静默成功」的预期。

处置：移除这两个通道内的原生确认，二次确认职责统一由渲染端 ConfirmDialog 承担（已存在）。`media:emptyRecycleBin`（清空回收站按钮）不在本次 Bug 范围，保持不动。

### 根因 C（预期行为缺口）：删除后缩略图缓存残留

`media:delete`（hardDelete 单条）与 `media:permanentDelete` 阶段 3（hardDeleteBatch）只删 DB 记录，不清理 `media_files.thumbnail` 字段指向的缩略图文件，孤儿缩略图永久残留。**安全约束**：游戏拍照记录的 `thumbnail` 可能指向游戏自管的 `NikkiPhotos_LowQuality\...` 文件（见 `scanner/path-classifier.ts` / `repair-legacy-data-v6.ts`），**只能删除位于应用缩略图缓存目录内**（`ctx.thumbnailGen.getCacheDir()` 前缀校验）的文件，其余仅记日志跳过。

## 1. 依赖声明

**零新增依赖**。全部复用仓库既有能力：zod 校验（validator.ts）、`settleWithConcurrency`（shared/utils/concurrency）、`useStagedTask`、`pathExists`（utils/file-utils）、logger 聚合日志、Vitest 现有 mock 基建。

## 2. 启动与验证说明

环境准备：Node.js ≥ 20，`npm install` 已完成（better-sqlite3 等原生依赖无需重编）。

启动命令：`npm run dev`（electron-vite dev）。

复现 Bug 步骤（修复前）：

1. 启动应用，进入图库，右键任一照片 → 「永久删除」→ 弹出前端确认框 → 点确认 →（主进程又弹一个原生确认框）→ 点「确认删除」→ 观察右下角弹出红色 Toast，且图库列表该项可能残留（状态不同步）。
2. 回收站勾选若干项 → 点「彻底删除」→ 确认 →（每项各弹一次原生确认框）→ 全部确认 → 删除成功但底部工具栏出现「重试删除」按钮。
3. 重复文件页右键卡片 →「永久删除」→ 确认 → 删除成功但弹出红色 Toast，列表不刷新。

验证修复方式：

1. 步骤 1–3 操作后：无任何红色「出错」Toast；删除成功后列表/回收站/重复页状态正确刷新；不再出现主进程原生重复确认框。
2. 自动化验收：`npx vitest run src/renderer/hooks/useFileOperations.test.ts src/renderer/pages/DuplicatesPage.contextMenu.test.tsx src/renderer/pages/RecycleBinPage.permanentDelete.test.tsx src/main/ipc/handlers/media.test.ts src/main/ipc/handlers/file.test.ts` 全绿；`npm run typecheck`、`npm run lint` 无新增错误；`npm test` 全量无新增失败。

## 3. 错误处理与兜底

- 主进程：`wrapHandler` 统一捕获 `AppError`/普通 `Error` → `IpcResponse`；`fileService.deletePermanent` 已区分 ENOENT（视为已删除）与真实错误（EACCES/EBUSY → partial 失败消息）；`trashBatch` 三态判定 + 重试 + 熔断维持不变。
- 渲染端：`call()` 失败抛 `IpcError` → `useStagedTask.run` catch → error Toast 透传 `message`（错误透传机制**不削弱**，只是不再对「成功 data」误判）。`mediaAction.permanentDelete` 返回的 `failedCount > 0` 时按部分失败处理（error Toast / 重试按钮）。
- 缩略图清理为 best-effort：`pathExists` 预检 + try/catch，失败仅 `logger.warn` 聚合日志，不阻断删除主流程，不影响 IPC 返回值。
- 移除原生确认后不再产生 `IPC_CANCELED` 分支；`main.media.error.userCanceled` i18n key 仍被 `media:emptyRecycleBin` 使用，**不删除任何 i18n 键值**。

## 4. 参数校验

- `file:deletePermanent`：`schemas.filePathArrayBulk`（非空数组、每项 1–1024 字符）+ `assertMediaDeletePath` 三级校验（userPicked → 已入库媒体白名单 → PathGuard 兜底）——**保持不变**；空数组被 zod `min(1)` 拒绝，非白名单路径抛 `PATH_FORBIDDEN`。
- `media:permanentDelete`：`schemas.mediaIdArrayBulk`（非空正整数数组）——**保持不变**。
- 渲染端新增的 `failedCount` 判定属于返回值语义消费，不引入新入参。

## 5. 子任务分解

### T1 渲染端契约修正（根因 A1/A2/A3）

| 项            | 内容                                                                                                                                                                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 修改文件      | `src/renderer/hooks/useFileOperations.ts`、`src/renderer/pages/RecycleBinPage.tsx`、`src/renderer/pages/DuplicatesPage.tsx`、`src/main/preload/api/media-action.ts`（`permanentDelete` 返回类型补 `deletedCount: number; failedCount: number`，与主进程真实返回对齐） |
| 输入          | 渲染端各永久删除入口的用户确认事件                                                                                                                                                                                                                                    |
| 输出/状态变更 | 删除成功 → success Toast + `deleteMediaFiles`/`loadRecycleBin`/`runScan` 正常执行；`failedCount>0` → error Toast + 重试入口；`IpcError` → error Toast 透传                                                                                                            |
| 验收标准      | R1/R2/R3 红灯测试（见第 6 节）由失败转绿                                                                                                                                                                                                                              |

### T2 主进程移除重复二次确认（根因 B）

| 项        | 内容                                                                                                                                                                                                                                                                   |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 修改文件  | `src/main/ipc/handlers/file.ts`（`file:deletePermanent` 删除 `dialog.showMessageBox` 与 `AppError.canceled` 分支）、`src/main/ipc/handlers/media-lifecycle-handler.ts`（`media:permanentDelete` 同）、`docs/IPC_CONTRACT.md`（按项目规则同步说明确认语义由渲染端承担） |
| 输入/输出 | IPC 入参不变；出参形态不变；删除「用户取消」异常分支                                                                                                                                                                                                                   |
| 验收标准  | R4/R5 测试：断言 `showMessageBox` 未被调用且删除成功；`media.test.ts` 既有「用户取消时抛 canceled」用例改写为「不再弹原生确认、直接执行」                                                                                                                              |

### T3 缩略图缓存清理（根因 C）

| 项            | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 修改文件      | `src/main/ipc/handlers/_trash-utils.ts`（新增 `cleanupThumbnailsForRows(rows, cacheDir)`：仅删除 cacheDir 前缀内的 thumbnail 文件，best-effort + 聚合日志）、`src/main/database/media-repository.ts`（`IdPathRow` 增加可选 `thumbnail?: string \| null`；`getMediaPathsByIds` SELECT 增加 `thumbnail` 列）、`src/main/ipc/handlers/media-lifecycle-handler.ts`（`media:delete` 先查记录再 hardDelete，删除后清理；`media:permanentDelete` 阶段 3 后清理） |
| 输入          | 待删除 DB 行（id / file_path / thumbnail）                                                                                                                                                                                                                                                                                                                                                                                                                |
| 输出/状态变更 | 缓存目录内的缩略图文件被 unlink；游戏原生 LQ 与其他外部路径**绝不触碰**；失败仅日志                                                                                                                                                                                                                                                                                                                                                                       |
| 验收标准      | R4 测试中断言 `fs/promises.unlink` 仅对缓存目录内路径调用；游戏 LQ 路径不调用                                                                                                                                                                                                                                                                                                                                                                             |

### T4 回归测试用例矩阵（红→绿）

| 类别 | 用例                                                                                                                                                 | 文件                                                                              | 修复前预期                                                 | 修复后预期 |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------- |
| 正常 | 图库单文件永久删除成功：mock `deletePermanent→{success:true}`、`mediaAction.delete→{deleted:true}`（真实契约），断言 success Toast + mediaFiles 清空 | `useFileOperations.test.ts`（修正既有用例 mock）                                  | **失败**（恒 throw → error Toast + 状态残留）              | 通过       |
| 正常 | 重复页永久删除成功：mock `permanentDelete→{message,deletedCount:1,failedCount:0}`，断言 success Toast + `findDuplicates` 二次调用（刷新）            | `DuplicatesPage.contextMenu.test.tsx`（新增用例，方法名修正为 `permanentDelete`） | **失败**（恒 error Toast + 不刷新）                        | 通过       |
| 正常 | 回收站批量永久删除成功：mock `permanentDelete→真实契约`，断言 success Toast + 无重试按钮                                                             | `RecycleBinPage.permanentDelete.test.tsx`（新建）                                 | **失败**（重试按钮出现）                                   | 通过       |
| 异常 | 文件删除 EACCES：`fileService.deletePermanent` 返回 `success:false` → 渲染端 error Toast（错误透传不被削弱）                                         | `useFileOperations.test.ts`                                                       | 通过（保持）                                               | 通过       |
| 异常 | trashItem 失败：mock 返回 `failedCount:1` → 回收站显示重试入口 + error Toast                                                                         | `RecycleBinPage.permanentDelete.test.tsx`                                         | 通过（路径不变）                                           | 通过       |
| 异常 | `permanentDelete` 抛 `IpcError`（如 DB 错误）→ `staged.run` 捕获 → error Toast                                                                       | `RecycleBinPage.permanentDelete.test.tsx`                                         | 通过（路径不变）                                           | 通过       |
| 边界 | 主进程不再弹原生确认：`file:deletePermanent` 直接成功且 `showMessageBox` 未调用；`media:permanentDelete` 同（改写既有「用户取消」用例）              | `file.test.ts`、`media.test.ts`                                                   | **失败**（dialog mock 未配置 → INTERNAL_ERROR / canceled） | 通过       |
| 边界 | 缩略图清理：缓存目录内路径被 unlink、游戏 LQ 路径跳过、thumbnail 为 null 跳过                                                                        | `media.test.ts`                                                                   | 新增，修复前**失败**（清理逻辑不存在）                     | 通过       |
| 边界 | 部分失败：mock 返回 `failedCount>0` → `media:permanentDelete` 仍返回 partial 消息 + DB 仅删成功项                                                    | `media.test.ts`（既有逻辑保持）                                                   | 通过                                                       | 通过       |

### T5 局部回归与全局回归

- 局部：每完成一个子任务即运行第 2 节列出的 5 个测试文件。
- 全局：`npm test`（全量 vitest）+ `npm run typecheck` + `npm run lint`，不得出现新增失败项。

## 6. 硬性约束自查

- 修复前回归测试必须失败：R1/R2/R3/R4-边界/R4-缩略图 用例在修复前均验证失败后才开始改源码。
- 不使用 `@ts-ignore` / 不弱化断言 / 不 mock 掉被测行为本身（mock 仅用于隔离 electron IPC 与文件系统边界）。
- 不修改无关 i18n 键值；不重构无关代码。
