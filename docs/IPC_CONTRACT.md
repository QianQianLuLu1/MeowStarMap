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
- 检查 `res.success` 的调用方共 4 处：`src/renderer/hooks/useFileOperations.ts:305`（单文件软删）、`useFileOperations.ts:379`（批量软删）、`src/renderer/pages/DetailPage.tsx:205`、`src/renderer/components/gallery/FullscreenViewer.tsx:184`。后两者原走 §2.9 `media:delete`（硬删 DB 行 + 搬文件），记录根本进不了回收站；改走本通道后删除项才真正出现在回收站（D3）。
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
