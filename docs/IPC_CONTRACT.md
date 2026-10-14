# IPC 响应契约文档

## 1. 机制概述

### 1.1 双层 success 结构

项目 IPC 通信采用**双层 success 包装**，理解此结构是避免「扫描失败」类 bug 的关键。

```
主进程 handler 返回值
  ↓ wrapHandler 包装
IpcResponse<T> = { success: true, data: T } | { success: false, error: IpcError }
  ↓ ipcRenderer.invoke 传输
preload call<T>() 解包
  ↓ success=true → 返回 data（丢弃外层 success）
  ↓ success=false → 抛出 IpcError
前端拿到的值 = handler 的原始返回对象
```

### 1.2 关键约束

**前端拿到的值是 handler 的原始返回对象**，不包含外层 `IpcResponse.success`。

如果前端代码检查 `res.success`，则 handler 的返回值**必须包含 `success: true` 字段**。否则 `res.success` 为 `undefined`（falsy），前端会误判为失败。

### 1.3 preload `call()` 解包逻辑

```ts
// src/main/preload.ts
async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as IpcResponse<T>
  if (res && res.success) {
    return res.data  // ← 返回内层 data，外层 success 被丢弃
  }
  if (res && !res.success && res.error) {
    throw new IpcError(res.error.code, res.error.message, ...)
  }
  throw new IpcError('IPC_MALFORMED_RESPONSE', ...)
}
```

### 1.4 `wrapHandler` 包装逻辑

```ts
// src/main/ipc/validator.ts
wrapHandler(ctx, schema, handler) =>
  async (...args) => {
    try {
      const data = await handler(parsedArgs)  // handler 返回值
      return { success: true, data }          // 包装为 IpcResponse
    } catch (e) {
      return { success: false, error: ... }
    }
  }
```

## 2. 重复/相似检测域 IPC 契约

以下通道的返回值**必须包含 `success: true`**，因为前端 `DuplicatesPage.tsx` 会检查此字段。

> **本节范围**：仅覆盖重复/相似检测与回收站删除链路。`res.success` 这一「内层 success」约定在全仓并非只有本节这些通道——分类、编辑器、诊断、设置、批量操作等页面同样存在检查（检索方式：`grep -rn "\.success" src/renderer`）。这些通道未在此逐一列举，改动任何 handler 返回值前必须自行确认其调用方是否读 `success`；本节不构成完整通道清单。

### 2.1 `media:findDuplicates`

| 属性         | 值                                              |
| ------------ | ----------------------------------------------- |
| 通道         | `media:findDuplicates`                          |
| Handler 文件 | `src/main/ipc/handlers/duplicate-handler.ts`    |
| 参数         | 无                                              |
| 返回类型     | `ScanResult`（`src/shared/types/duplicate.ts`） |

**返回值结构**：

```ts
{
  success: true,           // ← 必须！前端检查此字段
  duplicates: DuplicateItem[][],  // 重复分组
  bestItemIds: (number | null)[], // 每组推荐保留的文件 id
  totalGroups: number,
  totalFiles: number,
  wastedBytes: number,
  scannedFiles: number,
  cancelled?: boolean      // 用户取消时为 true
}
```

### 2.2 `media:findSimilar`

| 属性         | 值                                         |
| ------------ | ------------------------------------------ |
| 通道         | `media:findSimilar`                        |
| Handler 文件 | `src/main/ipc/handlers/similar-handler.ts` |
| 参数         | `{ threshold?: number }`（默认 5）         |
| 返回类型     | `ScanResult`                               |

**返回值结构**：

```ts
{
  success: true,
  duplicates: DuplicateItem[][],
  bestItemIds: (number | null)[],
  totalGroups: number,
  totalFiles: number,
  wastedBytes: number,
  scannedFiles: number,
  threshold: number,       // 相似检测特有：实际使用的阈值
  hashedFiles: number,     // 相似检测特有：已计算 pHash 的文件数
  cancelled?: boolean
}
```

### 2.3 `media:generatePhash`

| 属性         | 值                                               |
| ------------ | ------------------------------------------------ |
| 通道         | `media:generatePhash`                            |
| Handler 文件 | `src/main/ipc/handlers/similar-handler.ts`       |
| 参数         | 无                                               |
| 返回类型     | `PhashResult`（`src/shared/types/duplicate.ts`） |

**返回值结构**：

```ts
{
  success: true,
  message: string,         // 'pHash 补算完成'
  processed: number,       // 本次处理的文件数
  total: number            // 总待处理文件数
}
```

### 2.4 `media:markDuplicates`

| 属性         | 值                                                        |
| ------------ | --------------------------------------------------------- |
| 通道         | `media:markDuplicates`                                    |
| Handler 文件 | `src/main/ipc/handlers/duplicate-handler.ts`              |
| 参数         | 无                                                        |
| 返回类型     | `MarkDuplicatesResult`（`src/shared/types/duplicate.ts`） |

**返回值结构**：

```ts
{
  success: true,
  message: string,           // '重复标记完成'
  markedDuplicates: number,  // 标记为重复的文件数
  totalGroups: number        // 重复分组数
}
```

### 2.5 `media:softDelete`

| 属性         | 值                                                  |
| ------------ | --------------------------------------------------- |
| 通道         | `media:softDelete`                                  |
| Handler 文件 | `src/main/ipc/handlers/media-lifecycle-handler.ts`  |
| 参数         | `number[]`（媒体 id 数组，`mediaIdArrayBulk` 校验） |
| 返回类型     | 内联类型                                            |

**返回值结构**：

```ts
{
  success: true,   // ← 必须！渲染端 4 处调用方检查此字段（见下）
  message: string  // '已将 N 个文件移至回收站'
}
```

**行为（回收站语义修复 D1 / D2 / D3）**：

- 软删除**不再搬动磁盘文件**：仅写 DB 标记 `is_deleted = 1` + `deleted_at` + `delete_origin = 'user'`，文件保留在原路径。「恢复」（`media:restore`）= 翻转标记并置 `delete_origin = NULL`，因此缩略图与打开均正常。原实现先调 `file:delete`（`shell.trashItem` 移入 Windows 系统回收站），而 Electron 无还原 API → 恢复只能翻转标记、文件实体回不来，表现为裂图与被完整性校验标记 `is_missing = 1`。
- `delete_origin` 三态与重扫复位口径（唯一真源 `src/main/scanner/rescan-restore-sql.ts`）：`'user'` = 用户主动删除，重扫 UPSERT **不得**复位（否则「删了又回来」）；`'root'` = `softDeleteByRootPath`（移除扫描源且清空记录）的整批软删，重扫重新发现后允许复位回图库；`NULL` = 升级前存量记录，按修复前行为复位，不引入回归。谓词为 `游戏目录树 AND COALESCE(delete_origin, '') <> 'user'`（游戏树条件整体带括号，保证 `OR` 不泄漏到顶层）。
- 检查 `res.success` 的调用方共 **6 处**（行号随改动漂移，按 `mediaAction.softDelete(` 调用点检索为准）：`src/renderer/hooks/useFileOperations.ts` 的单文件软删与批量软删两处、`src/renderer/pages/DetailPage.tsx`、`src/renderer/components/gallery/FullscreenViewer.tsx`，以及重复页 `src/renderer/pages/DuplicatesPage.tsx` 的单项删除与整组删除两处。其中详情页与全屏查看器原走 §2.9 `media:delete`（硬删 DB 行 + 搬文件），记录根本进不了回收站；改走本通道后删除项才真正出现在回收站（D3）。
- `media:permanentDelete`（§2.7）阶段 1 的 `softDeleteForPermanentDelete` 同样写 `delete_origin = 'user'`：物理删除失败、文件仍在的条目留在回收站供重试，且不会被重扫复位。
- 已知类型漂移（登记 DEBT-011 / DEBT-012，本次不改代码）：preload 侧声明为 `call<{ message: string }>`（`src/main/preload/api/media-action.ts:27`）少列 `success`，渲染端 `src/renderer/vite-env.d.ts:467` 声明为 `{ success: boolean; message: string }`（与 handler 实际返回一致）。运行期无危害——`call()` 原样透传 handler 的 data。

### 2.6 `file:deletePermanent`

| 属性         | 值                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------- |
| 通道         | `file:deletePermanent`                                                                    |
| Handler 文件 | `src/main/ipc/handlers/file.ts`                                                           |
| 参数         | `string[]`（绝对路径数组，`filePathArrayBulk` 校验 + `assertMediaDeletePath` 三级白名单） |
| 返回类型     | `{ success: boolean; message: string }`（`FileService.deletePermanent`）                  |

**确认语义（#fix-permanent-delete-error-toast）**：二次确认由渲染端 ConfirmDialog 承担（调用方：图库 `GalleryPage`）。主进程**不再弹出原生 `dialog.showMessageBox`**（原实现重复确认，且取消时向渲染端抛 `IPC_CANCELED` 误报错误）。渲染端按 preload `call()` 契约消费：成功收到 `{ success, message }`，失败抛 `IpcError`。

### 2.7 `media:permanentDelete`

| 属性         | 值                                                               |
| ------------ | ---------------------------------------------------------------- |
| 通道         | `media:permanentDelete`                                          |
| Handler 文件 | `src/main/ipc/handlers/media-lifecycle-handler.ts`               |
| 参数         | `number[]`（媒体 id 数组，`mediaIdArrayBulk` 校验）              |
| 返回类型     | `{ message: string; deletedCount: number; failedCount: number }` |

**返回值结构**：

```ts
{
  message: string,      // 成功 '已彻底删除 N 项'；部分失败 '已彻底删除 N 项，M 项失败'
  deletedCount: number, // 已物理删除 DB 记录数（含文件已不存在的项）
  failedCount: number   // 文件物理删除失败且文件仍存在的项数（渲染端据此判定部分失败）
}
```

**确认语义与行为（#fix-permanent-delete-error-toast / #fix-recyclebin-permanent-delete）**：

- 二次确认由渲染端 ConfirmDialog 承担（调用方：回收站 `RecycleBinPage`、重复页 `DuplicatesPage`）。主进程**不再弹出原生 `dialog.showMessageBox`**，也不再抛 `IPC_CANCELED`。
- 三阶段事务不变（软删标记 → 物理删除文件 → 硬删 DB）；阶段 4：对已删除记录的缩略图执行 best-effort 清理，范围见下方 #fix-gallery-delete-thumbnail-cleanup 行为变更，失败仅记录日志不影响返回值。
- **#fix-gallery-delete-thumbnail-cleanup 行为变更**：阶段 4 清理范围从「仅缓存目录内 thumbnail 列指向的单一文件」扩展为两类：① 缓存缩略图三档位（thumbnail 位于缓存目录内 → 引用文件 + `${hash}.jpg`/`${hash}_low.jpg`/`${hash}_high.jpg`）；② 游戏原生 LQ 文件（由 `file_path` 经 `resolveNativeThumbnailPath` 严格推导：须同时命中 `\X6Game\Saved\GamePlayPhotos\` 与 `\NikkiPhotos_HighQuality\` 目录段，thumbnail 列不作依据），并联动硬删该 LQ 的 DB 记录（LQ 文件本身也是入库媒体记录，避免悬空记录）。返回值结构不变。
- **#fix-recyclebin-permanent-delete 行为变更**：阶段 2 原用 `shell.trashItem`（仅把文件移入系统回收站，磁盘不释放，且 Windows Shell 大批量下有实测瞬时失败），现改为 `fsp.unlink` 直接物理删除；三态判定（成功/missing/failed）与重试/熔断/聚合日志机制沿用 `_trash-utils.ts` 不变。
- 渲染端按 preload `call()` 契约消费：成功收到 data，失败抛 `IpcError`；部分失败以 `failedCount > 0` 判定。

### 2.8 `media:emptyRecycleBin`

| 属性         | 值                                                                                   |
| ------------ | ------------------------------------------------------------------------------------ |
| 通道         | `media:emptyRecycleBin`                                                              |
| Handler 文件 | `src/main/ipc/handlers/media-lifecycle-handler.ts`                                   |
| 参数         | 无（`wrapHandlerNoArgs`）                                                            |
| 返回类型     | `{ message: string; movedCount: number; missingCount: number; failedCount: number }` |

**返回值结构**：

```ts
{
  message: string,      // 为空 '回收站为空，无需清理'；成功 '已清空回收站（共 N 项）'；部分失败 '已彻底删除 N 项，M 项失败'
  movedCount: number,   // 成功物理删除的文件数（#fix-recyclebin-permanent-delete 前语义为移入系统回收站数）
  missingCount: number, // 文件已不存在（原路径 ENOENT）的项数
  failedCount: number   // 物理删除失败且文件仍存在的项数（DB 记录保留供重试，渲染端据此判定部分失败）
}
```

**确认语义与行为（#fix-recyclebin-permanent-delete / 回收站语义修复 D5）**：

- 二次确认完全由渲染端 `ConfirmDialog` 承担（与 `media:permanentDelete` 同构）；主进程不再弹原生 `dialog.showMessageBox`，无取消路径（原「用户取消抛 `IPC_CANCELED`」行为已移除）。
- 文件处理：对每条软删除记录的 `file_path` 执行 `fsp.unlink` **物理删除**（原 `shell.trashItem` 仅移入系统回收站，磁盘不释放）；软删除记录经 `getSoftDeletedMediaPaths` 返回（含 `thumbnail` 列）。三态判定沿用 `_trash-utils.ts`：成功 / missing（仅删 DB）/ failed（文件仍存在，DB 保留供重试）。
- 阶段 4（本次新增）：对已删除 DB 记录的缩略图执行 best-effort 清理，范围同 §2.7 的 #fix-gallery-delete-thumbnail-cleanup 行为变更（缓存三档位 + 严格推导的原生 LQ 及其 DB 记录）。
- 渲染端按 preload `call()` 契约消费：成功收到 data（不含 `success` 字段），失败抛 `IpcError`；`RecycleBinPage` 仅消费 `message` 与 `failedCount`。

### 2.9 `media:delete`

| 属性         | 值                                                 |
| ------------ | -------------------------------------------------- |
| 通道         | `media:delete`                                     |
| Handler 文件 | `src/main/ipc/handlers/media-lifecycle-handler.ts` |
| 参数         | `number`（单条媒体 id，`schemas.mediaId` 校验）    |
| 返回类型     | `{ deleted: true }`                                |

**行为（#fix-gallery-delete-thumbnail-cleanup）**：硬删单条 DB 记录（`hardDelete`）后，对其关联缩略图执行 best-effort 清理，范围同 §2.7 的 #fix-gallery-delete-thumbnail-cleanup 行为变更（缓存三档位 + 由 `file_path` 严格推导的游戏原生 LQ 文件及其 DB 记录）。调用方：**仅**图库/详情页的**永久删除**链路（`file:deletePermanent` 成功后调用，`src/renderer/hooks/useFileOperations.ts:292`）；插件面的权限名见 `plugin-bridge-handler.ts`。详情页与全屏查看器的删除已改走 §2.5 `media:softDelete`（回收站语义修复 D3），**不再**调用本通道——原先它们「先移入系统回收站 + 硬删 DB 行」，记录直接消失、应用回收站里找不到。缩略图清理失败仅记录日志，不影响返回值。

## 3. 共享类型定义

所有跨进程共享的类型定义在 `src/shared/types/duplicate.ts`，通过 `src/shared/types/index.ts` 统一导出。

| 类型                   | 用途                                | 消费方                                  |
| ---------------------- | ----------------------------------- | --------------------------------------- |
| `DuplicateItem`        | 重复/相似检测中的单条媒体项         | handler 返回 → preload → DuplicatesPage |
| `ScanResult`           | findDuplicates / findSimilar 返回值 | handler → preload → DuplicatesPage      |
| `PhashResult`          | generatePhash 返回值                | handler → preload → DuplicatesPage      |
| `MarkDuplicatesResult` | markDuplicates 返回值               | handler → preload → DuplicatesPage      |

## 4. 新增 Handler 检查清单

新增 IPC handler 时，逐项检查：

- [ ] handler 返回值是否需要 `success` 字段？（前端是否检查 `res.success`）
- [ ] 返回值类型是否提取到 `src/shared/types/` 下？
- [ ] preload 泛型标注是否使用了共享类型？
- [ ] 单元测试是否验证了内层 `data.success`？
- [ ] 是否有 `simulateCall` 集成测试验证 preload 解包后的值？
- [ ] 本文档是否已更新对应通道的契约？

## 5. 历史教训

**2026-07-31 「扫描失败」bug**：handler 返回值缺少 `success` 字段，导致前端 `res.success` 为 `undefined`（falsy），所有扫描操作均被误判为失败。根因是 IPC 双层 success 结构中，内层 data 的 `success` 字段与外层 IpcResponse 的 `success` 字段容易混淆，且测试仅验证了外层。

## 6. 收藏夹域（示例）

### 6.1 `favorites:list`

| 属性         | 值                                           |
| ------------ | -------------------------------------------- |
| 通道         | `favorites:list`                             |
| Handler 文件 | `src/main/ipc/handlers/favorites-handler.ts` |
| 参数         | 无                                           |
| 返回类型     | `{ favorites: FavoriteItem[] }`              |

**返回值结构**：

```typescript
{
  favorites: Array<{
    id: number
    media_id: number
    created_at: string
  }>
}
```

### 6.2 `favorites:add`

| 属性         | 值                                           |
| ------------ | -------------------------------------------- |
| 通道         | `favorites:add`                              |
| Handler 文件 | `src/main/ipc/handlers/favorites-handler.ts` |
| 参数         | `mediaId: number`                            |
| 返回类型     | `{ id: number }`                             |

**返回值结构**：

```typescript
{
  id: number // 新创建的收藏记录 ID
}
```

**错误处理**：

- 媒体已在收藏夹中：抛出 `ValidationError`

### 6.3 `favorites:remove`

| 属性         | 值                                           |
| ------------ | -------------------------------------------- |
| 通道         | `favorites:remove`                           |
| Handler 文件 | `src/main/ipc/handlers/favorites-handler.ts` |
| 参数         | `mediaId: number`                            |
| 返回类型     | `{ removed: boolean }`                       |

**返回值结构**：

```typescript
{
  removed: true
}
```

**错误处理**：

- 收藏夹中不存在该媒体：抛出 `NotFoundError`

## 7. 共鸣录域（卡池心愿单，同步上游 65bb3d8f 新增）

### 7.1 `resonance:setWishlist`

| 属性                   | 值                                                                        |
| ---------------------- | ------------------------------------------------------------------------- |
| 通道名                 | `resonance:setWishlist`                                                   |
| 参数                   | 单个位置参数：`{ version: 1, entries: [{ bannerId: number }] }`           |
| 参数校验               | `resonanceSetWishlistArgs = z.tuple([resonanceBannerWishlistSchema])`     |
| 返回值（`data`）       | `{ wishlist: { version: 1, entries: [{ bannerId }] } }`（落库后的最新值） |
| 前端检查 `res.success` | 否——`call()` 只透出 `data`，渲染层用 `try/catch` + `IpcError` 分支        |
| 校验失败错误码         | `VALIDATION_ERROR`                                                        |

- 语义为**全量覆盖**：`entries: []` 即清空心愿单（非增量）。
- 非法入参：`version ≠ 1`、`entries` 非数组、`bannerId` 非 1..999999 的整数、条目数超过 `MAX_WISHLIST_ENTRIES`（200）→ zod 拒绝，不触达数据库。
- 「卡池是否真实存在」不在此层判定：由渲染层 `normalizeBannerWishlist()`（`src/renderer/utils/resonance/bannerWishlist.ts`）按本地静态快照 `BANNER_DATA` 过滤，保持离线特性。
- 回传条目按 `banner_id` 升序（表内无时间列，排序键固定以保证重载顺序稳定）；渲染层以回传值覆盖本地状态，乐观更新失败时回滚。
- 契约实现位置：`src/main/ipc/handlers/resonance-handler.ts`、`src/main/preload/api/resonance.ts`、`src/shared/types/resonance.ts`、`src/renderer/vite-env.d.ts`。

### 7.2 共鸣录既有通道的向后兼容扩展

本次未改名、未改既有字段语义，仅新增**可选**字段：

| 通道                     | 新增可选字段                                            | 说明                                                        |
| ------------------------ | ------------------------------------------------------- | ----------------------------------------------------------- |
| `resonance:getData`      | `wishlist`                                              | 旧调用方读取时缺省为空表，`ResonanceGetDataResult` 向后兼容 |
| `resonance:commitImport` | `wishlist` + `includeWishlist`                          | 与既有 `wardrobe` / `includeWardrobe` 同构，仅末批携带覆盖  |
| `resonance:export`       | 载荷 `bannerWishlist`（`resonanceExportPayloadSchema`） | 与上游导出格式对齐；上游同字段亦为可选，缺失即不导出        |

`resonance:commitImport` 的空批次 `refine` 守卫已同步放宽：仅携带 `includeWishlist: true` + `wishlist` 的末批视为有效批次（此前仅记录段与 wardrobe 可使其通过）。

## 8. NikkiSync 域（sync-integration 阶段 2 查询面 + 阶段 3 服务面 + 阶段 4 查询面扩容）

补齐阶段 1/2 欠下的同步义务：`nikkisync:*` 与 `sync:*` 两组通道此前未入本契约。
实现位置：`src/main/ipc/handlers/nikkisync-handler.ts`、`src/main/preload/api/nikkisync.ts`、
`src/shared/types/electron-api.ts`（形状快照）、`src/renderer/vite-env.d.ts`（镜像声明）。

命名口径：`nikkisync:` 道用 **kebab-case** 动作（本域一致），历史 `sync:` 道用 camelCase（保持不动以免破坏兼容）。
两组通道的返回值都由 `wrapHandler` 包成 `IpcResponse`，preload 的 `call<T>()` 只透出 `data`；
渲染层一律 `try/catch` + `IpcError`，不检内层 `res.success`。

### 8.1 查询面（阶段 2，响应体 = NikkiSync 协议 DTO，内嵌层零转换）

| 通道                         | 入参                                                                    | 出参                                                                                                  | 失败码                                                   |
| ---------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `nikkisync:runtime-status`   | 无                                                                      | `{state, dbPath, linkReady, scannerStatus?, installation?, lastScan?, tables?, sync?, error?, hint?}` | `PRECONDITION_FAILED`（句柄未装配）                      |
| `nikkisync:start-scan`       | `{gameRoot?, path?}`                                                    | 上游 `ScanResult` 原样                                                                                | `VALIDATION_ERROR` / `NOT_FOUND` / `PRECONDITION_FAILED` |
| `nikkisync:get-assets`       | `{limit=100 (1..500), cursor?, type?, afterRevision?, includeDeleted?}` | `{items, nextCursor?, libraryRevision}`                                                               | 同上                                                     |
| `nikkisync:get-asset-detail` | `assetId: string(1..128)`                                               | `mapAssetDetail` 结果                                                                                 | `VALIDATION_ERROR` / `NOT_FOUND`                         |
| `nikkisync:get-resource`     | `{assetId, resourceId, mode='meta'\|'path'}`                            | `MediaResource` 或上游 `source_path` 原值                                                             | 同上                                                     |

### 8.1.1 查询面扩容（阶段 4，仍零转换；为图库数据层切换而加）

实现位置同上。响应类型出处是 `src/shared/sync/protocol.ts`（本仓协议契约唯一真相源），
`electron-api.ts` 只以 `import type` 别名引用，**不再重列字段名**。

| 通道                             | 入参                                                         | 出参                                                                                                                                                                                                                                          | 失败码                                                   |
| -------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `nikkisync:get-resource-records` | `{assetIds: string(1..128)[] (1..500), mode='meta'\|'path'}` | `meta` → `{byAsset: {[assetId]: MediaResource[]}}`；`path` → `{byAsset: {[assetId]: {[resourceId]: 上游 source_path 原值}}}`；无资源的资产给 `[]` / `{}`，不静默丢弃                                                                          | `VALIDATION_ERROR` / `PRECONDITION_FAILED`               |
| `nikkisync:get-changes`          | `{after: int(>=0), limit=1000 (1..1000)}`                    | `{changes: ChangeRecord[], libraryRevision, fullResyncRequired}`；判据逐字同上游 `GET /v1/changes`——`after < minimumJournalRevision() - 1` 时 `fullResyncRequired=true` 且 `changes` 为空；日志表为空（`minimum` 为 `undefined`）**不判**全量 | `VALIDATION_ERROR` / `NOT_FOUND` / `PRECONDITION_FAILED` |
| `nikkisync:search-suits`         | `{query: string(1..128)，不得全空白}`                        | `SuitSearchResponse`（`{query, items}`）                                                                                                                                                                                                      | `VALIDATION_ERROR` / `PRECONDITION_FAILED`               |
| `nikkisync:search-clothing`      | 同上                                                         | `ClothingSearchResponse`                                                                                                                                                                                                                      | 同上                                                     |
| `nikkisync:profile-stats`        | 无                                                           | `ProfileStatsResponse`（`{libraryRevision, dictionary?, topSuits, topClothing}`）                                                                                                                                                             | `PRECONDITION_FAILED`                                    |

契约要点：

- **`query` 原串下传**：`trim` 与空判由上游索引内部负责，本层刻意不加 `.trim()`；但**全空白在本层即拒**——
  一旦放行，搜索源装配（`listSuitSearchAssets` 无 LIMIT）会为一个无意义查询摊平整库资产。
- `get-resource-records` 的存在理由是**往返次数**：一页 500 资产若逐条 `get-resource` 就是 500 次 IPC。
  外层容器 `byAsset` 由本仓组装，容器内每一项仍是上游 `mapResourceRow` / `resources.source_path` 原值。
- 上游 `AssetListQuery` **不支持** `uid` / `state` / 文本过滤（只有 `cursor/limit/type/afterRevision/includeDeleted`），
  故档案与关键字过滤属渲染层职责；要加服务端过滤条件属破坏性变更，须另起通道 + 迁移期双写。
- `path` 模式给的是绝对路径原值，**仅供**渲染层拼 `media://` URL；该路径能否被真正读取由
  `src/main/app/media-protocol.ts` 的白名单判定，本域不做授权、不做规整、不承诺文件仍存在。

### 8.1.2 推送事件（阶段 4）

| 事件                        | 方向            | 载荷 | 触发时机                                                          |
| --------------------------- | --------------- | ---- | ----------------------------------------------------------------- |
| `nikkisync:library-changed` | main → renderer | 无   | `nikkisync:start-scan` **成功返回后**推给发起方（`event.sender`） |

要点：

- 只在扫描成功时发：扫描失败时库可能处于中间态，通知反而会让 UI 刷出半截结果。
- 发送失败（窗口已关）或没有 `sender`（CLI / 探针复用同一 handler）一律**静默跳过**，
  绝不因为一次通知失败就把已经成功的扫描判成失败。
- 渲染层（`GalleryPage` 的 useEffect 4）收到后先用 `nikkisync:get-changes` 判有没有真的变化，
  无变化则不整表重取，避免用户滚到的位置被无意义刷新顶掉。
- 载荷刻意留空：变化内容由 `get-changes` 权威给出，事件只表示「去问一次」。

### 8.2 服务面（阶段 3，后端是上游 `LocalSyncServer`，本仓只做启停与配对面）

| 通道                           | 入参                                    | 出参                                                                                                                                                    | 失败码                                                                                          |
| ------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `nikkisync:server-status`      | 无                                      | `{available, running, host, port, secure?, serverId?, mdnsEnabled, tlsFingerprintSha256?, serverCertificatePem?, lanHost?, pairedDeviceCount?, error?}` | 不抛：句柄未装配时 `{available:false, running:false, host:'', port:0, mdnsEnabled:false}`       |
| `nikkisync:start-server`       | 可选 `{port? (1..65535), mdnsEnabled?}` | 同 `server-status`（`available:true`）                                                                                                                  | `VALIDATION_ERROR`；`PRECONDITION_FAILED`（含 `PORT_IN_USE`）；`INTERNAL_ERROR`（其它启动失败） |
| `nikkisync:stop-server`        | 无                                      | 同 `server-status`（`running:false`）                                                                                                                   | `PRECONDITION_FAILED`                                                                           |
| `nikkisync:get-pairing-code`   | 无                                      | `{content, expiresAt, serverId, host, port, tlsFingerprintSha256}`（`content` = 上游 `buildPairingUri()` 的 `NS1\|` 七段串）                            | `PRECONDITION_FAILED`（服务未运行，上游原生文案）                                               |
| `nikkisync:get-paired-devices` | 无                                      | `Array<{deviceId, deviceName, platform, appVersion?, pairedAt, lastSeenAt}>`（仅未撤销；不含公钥/凭据哈希）                                             | `PRECONDITION_FAILED`                                                                           |
| `nikkisync:revoke-device`      | `deviceId: string(1..128)`              | 撤销后的同一列表                                                                                                                                        | `VALIDATION_ERROR` / `NOT_FOUND` / `PRECONDITION_FAILED`                                        |

契约要点（不得凭实现细节臆造）：

- `secure` 只在真实监听时出现；未运行时 `host/port` 回落**配置值**，好让 UI 能把「配置端口 + `PORT_IN_USE`」显示出来。
- `mdnsEnabled` 表示**配置意图**：上游 `MdnsAdvertiser` 静默吞掉所有 socket 错误，因此它不能证明广播已生效，UI 与验收都不得把它当发现证据。
- `serverCertificatePem` 是公开材料（自签证书，不含私钥），供客户端在 pin 指纹之外做第二重核对。
- `start-server` 改端口会**重建内嵌会话**（上游把 `LocalSyncServerConfig` 冻结在构造期），调用方应预期一次 SQLite 重开与扫描器重新发现。
- 撤销是软删（上游 `PairingRepository.revoke` 写 `revoked_at`），**不踢**已建立的 WebSocket 连接；该设备后续签名请求由上游鉴权返回 401。

### 8.3 历史 `sync:` 域（移植面，阶段 3 起不再自启）

`sync:getStatus` / `startServer` / `stopServer` / `createPairingQr` / `listDevices` / `revokeDevice`
六条通道**原样保留**以维持兼容（`src/main/ipc/handlers/sync-handler.ts`），其后端是 `src/main/sync/`
的自有实现，数据源是本 App 的 `media_files` 库，与 8.2 的 NikkiSync 库是两份数据。
阶段 3 起设置页的「同步服务」节改接 8.2，移植面服务不再自启
（`PORTED_SYNC_AUTOSTART_ENABLED = false`；组装仍在，`ctx.syncEvents` 被 App 自有写路径依赖）。

## 9. asset-edits 域（sync-integration 阶段 4 · 资产编辑叠加层）

实现位置：`src/main/ipc/handlers/asset-edits-handler.ts`、`src/main/preload/api/asset-edits.ts`
（新命名空间 `electronAPI.assetEdits`，`electronAPI` 键数由 33 → 34）、
`src/main/database/asset-edits-repository.ts`（DDL 单一事实源 `ASSET_EDITS_DDL_STATEMENTS`，
由 `connection.ts` 幂等执行）。

| 通道               | 入参                                                      | 出参                               | 失败码                                     |
| ------------------ | --------------------------------------------------------- | ---------------------------------- | ------------------------------------------ |
| `asset-edits:list` | `assetIds: string(1..128)[]`（≤500，与一页资产同界）      | `{ edits: AssetEditsInfo[] }`      | `VALIDATION_ERROR` / `PRECONDITION_FAILED` |
| `asset-edits:set`  | `{ assetId: string(1..128), patch: AssetEditsPatchInfo }` | `{ edit: AssetEditsInfo \| null }` | `VALIDATION_ERROR` / `PRECONDITION_FAILED` |

契约要点：

- **这组通道不属于 NikkiSync 协议 DTO**，因此 handler **允许**塑形：`0/1 → boolean`、
  `tags` JSON 文本 → `string[]`。塑形口径必须与 `media_files` 的同名字段一致，
  否则「切换数据源」会连带「切换行为」。`tags` 脏数据（非法 JSON）降级为 `[]`，不抛错。
- 归键是 NikkiSync 的 `asset_id`（TEXT），**不是** `media_files.id`。两者不可混用：
  `mediaAction:*` 仍以 `media_files.id` 为准，只服务本地数据源。
- `updatedAt` 由主进程生成，渲染层不传（避免客户端时钟漂移影响排序与冲突判定）。
- 旧库未迁移（缺 `asset_edits` 表）时读取如实回退为空列表；写入则 `PRECONDITION_FAILED`。
- 回填 `media_files → asset_edits`（按归一化路径匹配）的纯函数已在仓储层实现并单测
  （`planAssetEditSeed`），但**尚未接线任何通道**：需要 `media_files` 与 assets 两侧
  分页游标对拉，属独立一步，见 `docs/sync-integration/04-ui-bridge-plan.md` §16.3。
