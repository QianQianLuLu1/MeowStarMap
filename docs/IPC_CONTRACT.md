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
  message: string,      // 成功 '已彻底删除 N 项'；部分失败 '已移入系统回收站 N 项（M 项移入失败，已保留记录供手动处理）'
  deletedCount: number, // 已处理（移入系统回收站或本已不存在）并硬删 DB 的记录数
  failedCount: number   // 移入系统回收站失败且文件仍存在的项数（渲染端据此判定部分失败）
}
```

**确认语义与行为（#fix-permanent-delete-error-toast / #fix-empty-recyclebin-system-trash）**：

- 二次确认由渲染端 ConfirmDialog 承担（调用方：回收站 `RecycleBinPage`、重复页 `DuplicatesPage`）。主进程**不再弹出原生 `dialog.showMessageBox`**，也不再抛 `IPC_CANCELED`。
- 三阶段事务不变（软删标记 → 移入系统回收站 → 硬删 DB）；阶段 4：对已删除记录的缩略图执行 best-effort 清理，范围见下方 #fix-gallery-delete-thumbnail-cleanup 行为变更，失败仅记录日志不影响返回值。
- **#fix-gallery-delete-thumbnail-cleanup 行为变更**：阶段 4 清理范围从「仅缓存目录内 thumbnail 列指向的单一文件」扩展为两类：① 缓存缩略图三档位（thumbnail 位于缓存目录内 → 引用文件 + `${hash}.jpg`/`${hash}_low.jpg`/`${hash}_high.jpg`）；② 游戏原生 LQ 文件（由 `file_path` 经 `resolveNativeThumbnailPath` 严格推导：须同时命中 `\X6Game\Saved\GamePlayPhotos\` 与 `\NikkiPhotos_HighQuality\` 目录段，thumbnail 列不作依据），并联动硬删该 LQ 的 DB 记录（LQ 文件本身也是入库媒体记录，避免悬空记录）。返回值结构不变。
- **#fix-empty-recyclebin-system-trash 行为变更**：阶段 2 恢复 `shell.trashItem`（移入系统回收站）——回收站页确认文案自项目基线起承诺「文件会先移至系统回收站，之后无法从本应用恢复」，`a5d154c` 改 `fsp.unlink` 与该承诺矛盾，且 `80d910a`（软删除改纯 DB 标记、文件留在原位）后 unlink 会永久删除用户文件。`a5d154c` 的动机（Shell API 大批量 94.5% 瞬时失败）是旧双回收站架构产物（当时文件在删除时已被搬走，清空打的是空路径），前提已消失。三态判定（成功/missing/failed）与重试/熔断/聚合日志机制沿用 `_trash-utils.ts` 不变，失败项保留 DB 记录供重试，不 fallback 永久删除。
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
  message: string,      // 为空 '回收站为空，无需清理'；成功 '已清空回收站（共 N 项）'；部分失败 '已移入系统回收站 N 项（M 项移入失败，已保留记录供手动处理）'
  movedCount: number,   // 成功移入系统回收站的文件数（#fix-empty-recyclebin-system-trash 起恢复本语义；a5d154c 至该修复前曾为物理删除数）
  missingCount: number, // 文件已不存在（原路径 ENOENT）的项数
  failedCount: number   // 移入系统回收站失败且文件仍存在的项数（DB 记录保留供重试，渲染端据此判定部分失败）
}
```

**确认语义与行为（#fix-empty-recyclebin-system-trash / 回收站语义修复 D5）**：

- 二次确认完全由渲染端 `ConfirmDialog` 承担（与 `media:permanentDelete` 同构）；主进程不再弹原生 `dialog.showMessageBox`，无取消路径（原「用户取消抛 `IPC_CANCELED`」行为已移除）。
- 文件处理：对每条软删除记录的 `file_path` 执行 `shell.trashItem` **移入系统回收站**（与确认文案「文件会先移至系统回收站，之后无法从本应用恢复」一致；`a5d154c` 至 `#fix-empty-recyclebin-system-trash` 间曾为 `fsp.unlink` 物理删除，详见 §2.7 行为变更注记）；软删除记录经 `getSoftDeletedMediaPaths` 返回（含 `thumbnail` 列）。三态判定沿用 `_trash-utils.ts`：成功 / missing（仅删 DB）/ failed（文件仍存在，DB 保留供重试）。
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

> **一处刻意例外（上游 b397e0e 同步新增）**：上游 `mapAssetSummary` 自该锚点起在资产行追加
> `sourcePath` / `sourceFolder`（本机绝对路径与其父目录）。本仓在**委托层**
> （`src/main/nikkisync/runtime-manager.ts` 的 `stripAssetPathFields`）剔除这两键，作用通道为
> `nikkisync:get-assets`、`nikkisync:search-suits`（含嵌套 `items[].photos[].asset`）与
> `nikkisync:search-clothing`；其余键仍零转换原样透出，响应形状不变（少两个可选键，渲染层
> 本就无消费点，故不构成破坏性变更）。裁剪刻意不放在 handler：`get-resource-records`/`get-changes`/
> `search-*`/`profile-stats` 等通道以身份 `toBe` 钉死「handler 不加工返回值」，且 `handlers/`
> 属核心路径受保护面。
>
> `get-resource` 与 `get-resource-records` 的 `mode:'path'` **按设计仍返回绝对路径原值**，不受该
> 裁剪影响——它是 `media://` 授权的唯一出口（`registerNikkiSyncResourcePaths` 靠它建表）。
>
> 覆盖边界须如实读：本条只关闭**本仓渲染层**这一面。上游 `LocalSyncServer` 对已配对 LAN 设备
> 仍照常下发两键（本仓不改上游源码）；vendored `AssetSummary`（`src/shared/sync/protocol.ts`）
> 刻意不新增这两键，声明面与载荷一致。

| 通道                         | 入参                                                                    | 出参                                                                                                             | 失败码                                                   |
| ---------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `nikkisync:runtime-status`   | 无                                                                      | `{state, dbPath, linkReady, scannerStatus?, installation?, lastScan?, tables?, sync?, metadata?, error?, hint?}` | `PRECONDITION_FAILED`（句柄未装配）                      |
| `nikkisync:start-scan`       | `{gameRoot?, path?}`                                                    | 上游 `ScanResult` 原样                                                                                           | `VALIDATION_ERROR` / `NOT_FOUND` / `PRECONDITION_FAILED` |
| `nikkisync:get-assets`       | `{limit=100 (1..500), cursor?, type?, afterRevision?, includeDeleted?}` | `{items, nextCursor?, libraryRevision}`                                                                          | 同上                                                     |
| `nikkisync:get-asset-detail` | `assetId: string(1..128)`                                               | `mapAssetDetail` 结果                                                                                            | `VALIDATION_ERROR` / `NOT_FOUND`                         |
| `nikkisync:get-resource`     | `{assetId, resourceId, mode='meta'\|'path'}`                            | `MediaResource` 或上游 `source_path` 原值                                                                        | 同上                                                     |

### 8.1.1 查询面扩容（阶段 4，仍零转换；为图库数据层切换而加）

实现位置同上。响应类型出处是 `src/shared/sync/protocol.ts`（本仓协议契约唯一真相源），
`electron-api.ts` 只以 `import type` 别名引用，**不再重列字段名**。

| 通道                             | 入参                                                         | 出参                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 失败码                                                   |
| -------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `nikkisync:get-resource-records` | `{assetIds: string(1..128)[] (1..500), mode='meta'\|'path'}` | `meta` → `{byAsset: {[assetId]: MediaResource[]}}`；`path` → `{byAsset: {[assetId]: {[resourceId]: 上游 source_path 原值}}}`；无资源的资产给 `[]` / `{}`，不静默丢弃                                                                                                                                                                                                                                                                                                                                                                                                                           | `VALIDATION_ERROR` / `PRECONDITION_FAILED`               |
| `nikkisync:get-changes`          | `{after: int(>=0), limit=1000 (1..1000)}`                    | `{changes: ChangeRecord[], libraryRevision, fullResyncRequired}`；判据同上游 `GET /v1/changes` 的 **b422193 时点**形态——`after < minimumJournalRevision() - 1` 时 `fullResyncRequired=true` 且 `changes` 为空；日志表为空（`minimum` 为 `undefined`）**不判**全量。（上游自 b397e0e 另增 `after < accounts.revision()` 一支：用户改同步账号作用域即强制客户端全量重同步。本仓以单参构造 `SyncReadRepository`、不构造 `AccountSyncSettings` ⇒ 作用域恒 `1=1`、该支恒不触发，刻意不跟随；接入账号作用域时须同步，理由与影响面见 `src/main/nikkisync/runtime-facade.ts` 的 `listChanges` 注释。） | `VALIDATION_ERROR` / `NOT_FOUND` / `PRECONDITION_FAILED` |
| `nikkisync:search-suits`         | `{query: string(1..128)，不得全空白}`                        | `SuitSearchResponse`（`{query, items}`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `VALIDATION_ERROR` / `PRECONDITION_FAILED`               |
| `nikkisync:search-clothing`      | 同上                                                         | `ClothingSearchResponse`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 同上                                                     |
| `nikkisync:profile-stats`        | 无                                                           | `ProfileStatsResponse`（`{libraryRevision, dictionary?, topSuits, topClothing}`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `PRECONDITION_FAILED`                                    |

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

### 8.1.3 `runtime-status.metadata` 可选段（阶段 6，向后兼容的纯增字段）

通道、入参、包装器**都不变**：`nikkisync:runtime-status` 仍是 `wrapHandlerNoArgs` 的逐字透传，
preload 侧 `getRuntimeStatus()` 签名不变，因此不触发核心路径闸门、不改 `preload.test.ts` 键清单。
新增的只是 `NikkiSyncRuntimeStatus` 上的一个可选键（遵循「新增字段可选、旧字段语义不变」）：

| 字段         | 形状                                                                                                                                          | 出处与含义                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `enabled`    | `boolean`                                                                                                                                     | 主进程侧对该开关的最终判定（env 优先于设置项）                                                      |
| `endpoint`   | `string`                                                                                                                                      | 实际下传给上游解析器的 https 端点；**只来自主进程常量**，渲染层无法注入                             |
| `counters?`  | `{ordinaryPhotos, withNativeToken, withCompleteEnvelope, resolved, failed, pending, withOutfit, withCamera, motionPhotos, failureCategories}` | 上游 `metadataResolutionDiagnostics()` 原样透传，**全部是聚合计数**：不序列化行、原始信封或错误原文 |
| `lastDrive?` | `{passes, resolved, aborted, failed}`                                                                                                         | 最近一次扫描后驱动的统计；未开启或从未驱动时缺省                                                    |

要点：

- `counters` 只在**建会话时**与**每次驱动收尾后**各取一次，**不在** `status()` 里现取：
  那是两条带 `json_extract` 的全表聚合，而该通道会被 UI 轮询。
- 会话拆除后 `status()` 不再带 `metadata` 段（没有会话就没有快照）；在途驱动的结果只能从日志读，
  不能拿一个已关闭的库的计数继续对外称「当前状态」。
- 该段是**阶段 6 新增、阶段 6b 之前不完整**的：`counters.withOutfit` 会随解析增长，
  但上游 `dressing.clothes` 是裸 ID 数组，`search-suits` / `search-clothing` 仍返回空 `items`
  （需要本地字典 manifest）。不要把 `withOutfit > 0` 读成「搜索已经可用」。

### 8.1.4 `runtime-status.startupStages` 可选段（K1，向后兼容的纯增字段）

通道、入参、包装器都不变；新增 `NikkiSyncRuntimeStatus.startupStages?`：
`Array<{stage: string, at: string}>`。要点：

- 只记录本仓编排下**真实完成**的阶段，取值域 `scanner`（scanner.start 成功）、
  `runtime-ready`（start 完成）、`lan-listen`（server.start 成功）、`cached-metadata`
  （缓存解码 runOnce 完成）。上游六阶段中的 `dictionary-enrichment` / `background-services`
  在本仓编排下不会发生，**永不出现**。
- 同会话同阶段幂等（只记一次）；记录随会话生命周期，会话拆除（stop / 换根重建）即清空。
- 阶段抛错即未完成：`cachedMetadataRunOnce` 抛错时 `cached-metadata` 不出现，错误只落
  主进程 warn 日志，不影响启动/扫描结果。
- 缺省语义：尚未启动、启动中断在首个阶段完成之前、或会话已拆除 ⇒ 键缺省。UI 据此
  区分「还没开始」与「进行到一半」。

### 8.1.5 `runtime-status.scanDiagnostics` 可选段（K7，向后兼容的纯增字段）

通道、入参、包装器都不变；新增 `NikkiSyncRuntimeStatus.scanDiagnostics?`：
上游 `scanner/ScanDiagnostics.js` 的 `scanDiagnosticSummary(scanner)` 返回值**逐字透传**，
形状 `{lastScan?: {filesObserved, resourcesAccepted, resourcesIgnored, assetsCreated,
assetsUpdated, assetsDeleted, errorCount}, timestamp, status, installationFound,
scanRootCount, automaticRootCount, extraRootCount}`。要点：

- **纯计数观测面**：上游承诺绝不序列化路径/UID/文件名/原始错误/参数，可直接进 IPC；
  本仓不发明修复按钮、不新增协议动作（上游 1.0.23 的 live index repair 无用户可调用 API）。
- 刷新时机：仅**扫描成功返回后**由 manager 调一次并缓存；`status()` 读缓存值，
  轮询不触发上游聚合。未扫描 ⇒ 键缺省（不拿旧值伪装成当前值）。
- 记录随会话生命周期，会话拆除（stop / 换根重建）即清空。
- 老链接（上游包内无 `ScanDiagnostics.js` 深入口产物）⇒ 会话不挂诊断面 ⇒ 键恒缺省。

### 8.2 服务面（阶段 3，后端是上游 `LocalSyncServer`，本仓只做启停与配对面）

| 通道                           | 入参                                    | 出参                                                                                                                                                                                                                                                    | 失败码                                                                                          |
| ------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `nikkisync:server-status`      | 无                                      | `{available, running, host, port, secure?, serverId?, mdnsEnabled, tlsFingerprintSha256?, serverCertificatePem?, lanHost?, pairedDeviceCount?, error?}`                                                                                                 | 不抛：句柄未装配时 `{available:false, running:false, host:'', port:0, mdnsEnabled:false}`       |
| `nikkisync:start-server`       | 可选 `{port? (1..65535), mdnsEnabled?}` | 同 `server-status`（`available:true`）                                                                                                                                                                                                                  | `VALIDATION_ERROR`；`PRECONDITION_FAILED`（含 `PORT_IN_USE`）；`INTERNAL_ERROR`（其它启动失败） |
| `nikkisync:stop-server`        | 无                                      | 同 `server-status`（`running:false`）                                                                                                                                                                                                                   | `PRECONDITION_FAILED`                                                                           |
| `nikkisync:get-pairing-code`   | 无                                      | `{content, expiresAt, serverId, host, port, tlsFingerprintSha256, hosts?}`（`content` = 上游 `buildPairingUri()`：单 host 为 `NS1\|` 七段串，注入多 host 时为 `nikki-sync://pair?...` 新格式；`hosts` 由 `parsePairingUri` 解出，单 host 形态不含该键） | `PRECONDITION_FAILED`（服务未运行，上游原生文案）                                               |
| `nikkisync:get-paired-devices` | 无                                      | `Array<{deviceId, deviceName, platform, appVersion?, pairedAt, lastSeenAt}>`（仅未撤销；不含公钥/凭据哈希）                                                                                                                                             | `PRECONDITION_FAILED`                                                                           |
| `nikkisync:revoke-device`      | `deviceId: string(1..128)`              | 撤销后的同一列表                                                                                                                                                                                                                                        | `VALIDATION_ERROR` / `NOT_FOUND` / `PRECONDITION_FAILED`                                        |

契约要点（不得凭实现细节臆造）：

- `secure` 只在真实监听时出现；未运行时 `host/port` 回落**配置值**，好让 UI 能把「配置端口 + `PORT_IN_USE`」显示出来。
- `mdnsEnabled` 表示**配置意图**：上游 `MdnsAdvertiser` 静默吞掉所有 socket 错误，因此它不能证明广播已生效，UI 与验收都不得把它当发现证据。
- `serverCertificatePem` 是公开材料（自签证书，不含私钥），供客户端在 pin 指纹之外做第二重核对。
- `start-server` 改端口会**重建内嵌会话**（上游把 `LocalSyncServerConfig` 冻结在构造期），调用方应预期一次 SQLite 重开与扫描器重新发现。
- 撤销是软删（上游 `PairingRepository.revoke` 写 `revoked_at`），**不踢**已建立的 WebSocket 连接；该设备后续签名请求由上游鉴权返回 401。
- **K4 `diagnostics?` 可选段**：`{running, host, port, secure?, mdnsEnabled, pairedDeviceCount?,
tlsFingerprintTail8?, connectionHosts?, lastError?, updatedAt}`——本仓自建观测面，只聚合既有
  状态快照，**不做任何主动网络探测**（不 ping、不扫端口、不扫子网；上游 1.0.22 的诊断主体在其
  C# windows-shell，不可复用）。指纹为尾 8 位摘要（完整值见 `tlsFingerprintSha256`）；
  `connectionHosts` 由 K5 接线后给出（≤8）。

### 8.2.1 在线解析同意（K2，上游 `MetadataOnlineConsent` 的读写面）

| 通道                             | 入参                                               | 出参                                                                                            | 失败码                                                                                                                         |
| -------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `nikkisync:get-metadata-consent` | 无                                                 | `{enabled, policyVersion, recipients: [{name, endpoint, fields}]}`（endpoint 由上游脱敏后透出） | `PRECONDITION_FAILED`（会话未装配或解析关闭 ⇒ 同意面不存在）                                                                   |
| `nikkisync:set-metadata-consent` | `{enabled: boolean, policyVersion: string(1..64)}` | 更新后的同意状态（同 get）                                                                      | `VALIDATION_ERROR`（入参非法或 policyVersion 与当前策略不符，上游中文原生文案改写为英文不透传）；`PRECONDITION_FAILED`（同上） |

契约要点：

- `policyVersion` 必须取 `get-metadata-consent` 展示值**原串**带回（上游逐字比对，防「看旧文案点新同意」）。
- 同意面仅在「解析开启（`nikkisync.metadataResolverEnabled`）的会话」上存在；关闭解析 ⇒ 两通道
  `PRECONDITION_FAILED`（渲染层据此隐藏同意块，不当作错误弹给用户）。
- fail-closed：同意文件不存在（首次安装）或损坏（非法 JSON）⇒ `enabled:false`；同意文件持久化于
  `{userData}/nikkisync/metadata-online-consent.json`（0600，上游原子写）。
- 撤回（`enabled:false`）即时生效：上游 `setEnabled(false)` 内部即 `abortPending()` 中止在途出站请求。
- 未同意时零出站：上游 `guard()` 包装的解析器在 `resolve` 首行即抛，失败计数归入既有 `metadata.counters.failureCategories`。

### 8.2.2 游戏版本推断（K3，上游 `GameVersionCalendar` 静态表，纯本地无出站）

| 通道                             | 入参                                | 出参                                              | 失败码                                                                 |
| -------------------------------- | ----------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| `nikkisync:resolve-game-version` | 可选 `{capturedAt?: string(1..64)}` | `{version?, effectiveAt?}`（两键缺省 = 无法推断） | `VALIDATION_ERROR`（capturedAt 超长）；`PRECONDITION_FAILED`（未装配） |

契约要点：

- **不做日期格式校验**：ISO 8601 之外的输入原样下传，由上游判缺省返回空结果、不抛错（纯查询无副作用）。
- 推断边界以上游静态表为准（1.0=2024-12-05 起，维护开服时刻为界）；渲染层对推断值标注「（推断）」，
  metadata 自带版本优先、推断值并列或补位。

### 8.2.3 额外照片目录（K6，上游 `ExtraScanDirectories`；仅作用于同步库扫描器）

| 通道                                 | 入参                                                      | 出参                                                                                                  | 失败码                                                                                |
| ------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `nikkisync:get-extra-directories`    | 无                                                        | `{directories: [{id, path, mode}], automaticRoots, busy, scannerStatus}`（**中文 `message` 已剔除**） | `PRECONDITION_FAILED`（未装配/未挂面）                                                |
| `nikkisync:inspect-extra-directory`  | `{path: string(1..4096)，必须绝对路径，且须是已登记目录}` | `{id, roots, images, videos, limited}`（**中文 `hint` 已剔除**）                                      | `VALIDATION_ERROR`；`PATH_FORBIDDEN`（未登记路径）；`PRECONDITION_FAILED`（见映射表） |
| `nikkisync:add-extra-directory`      | `{id: string(1..128)}`（预检返回的 id）                   | 同 get（更新后状态）                                                                                  | 同上映射                                                                              |
| `nikkisync:remove-extra-directory`   | `{id: string(1..128)}`                                    | 同 get                                                                                                | 同上映射                                                                              |
| `nikkisync:rescan-extra-directories` | 无                                                        | 同 get                                                                                                | 同上映射                                                                              |

契约要点：

- 目录清单持久化在上游 0600 JSON（`{userData}/nikkisync/extra-scan-directories.json`，
  `{version, directories, retiredRoots}`）——**上游文件即单一真相源**，不落本仓设置键。
- 上限 16、模式折叠、重叠判定全部由上游实现承担，zod 不重复设上限（避免双真相源）。
- `inspect` 的 `path` 受路径白名单约束：`dialog:selectDirectory` 显式选中的目录（登记的
  userPickedDir）短路放行，其余一律 `assertFileReadPath`——未登记的绝对路径返回
  `IPC_PATH_FORBIDDEN` 且不调上游句柄。判据与 `scanner:start` / `settings:set` 的扫描根短路
  逐字一致（提案随后可被 `add` 提升为长期扫描根，其内容会经 `media://` 可读，故这一步不能省）。
- 上游九错误短码映射：`invalid_directory` / `choose_subfolder` / `thumbnail_only` /
  `choose_photo_folder` / `already_covered` → `VALIDATION_ERROR`；
  `directory_unavailable` / `too_many_directories` / `selection_expired` /
  `directory_not_found` → `PRECONDITION_FAILED`。
- **仅作用于 NikkiSync 同步库扫描器**，不影响本地图库自有扫描目录（`customScanPaths`）。

### 8.2.4 整理队列（K8，上游 `DeletionQueue` 的 PC 管理面；破坏性能力，开关默认关）

| 通道                                | 入参                                      | 出参                                                                                                                | 失败码                                                |
| ----------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `nikkisync:get-organizer-queue`     | 无                                        | `{items: [{id, assetId, state, online, files[{name,size,folder?}], count}], activity}`（**中文 `message` 已剔除**） | `PRECONDITION_FAILED`（开关关/未装配）                |
| `nikkisync:decide-organizer-item`   | `{id: /^[a-zA-Z0-9-]{16,64}$/, approve}`  | 批准/拒绝后的队列行列表（同样剔除 message）                                                                         | `VALIDATION_ERROR`；`PRECONDITION_FAILED`；`CANCELED` |
| `nikkisync:approve-organizer-items` | `{ids: string[] 1..500}`（id 正则同上游） | `{items, approved, skipped}`（items 剔除 message；重复 id 由上游 `invalid_ids` 拒绝，本层不去重）                   | 同上映射                                              |

契约要点：

- **开关门**：三通道先读 `nikkisync.organizerEnabled`（渲染层白名单键，默认 **false**），
  false ⇒ `PRECONDITION_FAILED`（错误文案指向同步服务页开关）；未装配会话同样
  `PRECONDITION_FAILED`。
- **删除语义**：上游确认链 `preparing→pending→PC decide/approveMany→confirming→queued→
executing（逐文件 sha256+size 复核后经回收 helper 送 Windows 回收站）→recycled`；
  文件变化 ⇒ `changed` 不执行；中断 ⇒ 构造期标记 `failed` 不自动重放。可逆性 =
  Windows 回收站可恢复；本仓不入应用内回收站（数据源与索引体系不同）。
- 上游四错误短码映射：`not_pending` / `invalid_ids` → `VALIDATION_ERROR`；
  `phone_offline` → `PRECONDITION_FAILED`；`stopping` → `CANCELED`。
- 回收 helper：上游 `DeletionQueue` 经 `NIKKISYNC_RECYCLE_HELPER` env 调用
  `--recycle-file <path> <sha256> <size>`（构建见 `scripts/build-recycle-helper.cjs`，
  打包经 extraResources 落 `{resourcesPath}/nikkisync/`）；helper 未构建/失败 ⇒
  上游抛 `recycle_unavailable`，任务标 `failed`，**绝不退化为永久删除**。
- 11 态枚举（UI i18n 映射）：`preparing/pending/confirming/queued/checking/executing/
recycled/failed/changed/cancelled/rejected`；未知态回退原样展示。
- 手机端协同前提：NikkiSync App ≥ 1.0.21（OrganizerPage 随 1.0.21 发布）。

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

## 10. 水印域（2026-10-17 图片水印修复补录）

实现位置：`src/main/ipc/handlers/watermark.ts`、`src/main/preload/api/watermark.ts`
（命名空间 `electronAPI.watermark`）、`src/main/services/watermark-service.ts`。

| 通道                       | 入参                                         | 出参（`data`，即渲染层拿到的对象）                     | 失败码                                                   |
| -------------------------- | -------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------- |
| `watermark:apply`          | `config`、`filePaths[]`、`targetDir`         | `{ success, message, processed, cancelled?, taskId? }` | `VALIDATION_ERROR` / `PATH_FORBIDDEN` / `INTERNAL_ERROR` |
| `watermark:saveTemplate`   | `name(≤128)`、`config`（JSON 字符串 ≤256KB） | `{ success: true, id: number }`                        | `VALIDATION_ERROR` / `PRECONDITION_FAILED`               |
| `watermark:loadTemplates`  | 无参                                         | 行数组（DB 未就绪为 `[]`）                             | `INTERNAL_ERROR`                                         |
| `watermark:deleteTemplate` | `id`（正整数）                               | `{ deleted: true }`                                    | `VALIDATION_ERROR` / `PRECONDITION_FAILED`               |
| `watermark:progress`       | 主进程 → 渲染层推送                          | `{ current, total }`                                   | —                                                        |

契约要点：

- **`watermark:saveTemplate` 的返回值必须含内层 `success: true`**：调用方
  `src/renderer/components/editor/WatermarkPanel.tsx` 判的是 `result.success`，而 §1.2 已说明
  `call<T>()` 会剥掉外层 `IpcResponse.success`。此前 handler 只返回 `{ id }`，该判断恒为
  `undefined` → 点「保存」后输入框不清空、列表不刷新、无任何提示（DB 行其实已插入）。
  修复与回归用例见 `docs/plans/2026-10-17-fix-image-watermark-media-auth.md` §5 N3。
- `watermark:deleteTemplate` 返回 `{ deleted: true }`，调用方以 `try/catch` + `IpcError` 判定成功，
  **不读** `success`。但 `src/renderer/vite-env.d.ts:421` 把它声明成了
  `Promise<{ success: boolean; message?: string }>`，与实现不符——运行期无危害（`call()` 原样透传
  `data`），属类型漂移，后续按 §4 清单修正声明即可，不得反向给 handler 加 `success` 字段来迁就类型。
- `watermark:apply` 的 `config` 在 IPC 层只做存在性检查（`z.record(z.string(), z.unknown())`），
  业务校验在 `WatermarkService.applyBatch` 内（平铺间距必须为正数——`tileSpacingX/Y ≤ 0` 曾分别导致
  水印静默缺失与主进程死循环冻结）。**`config.image.path`（图片水印 logo）自 2026-10-17 起必须经
  `assertMediaAccessPath(ctx, logoPath)`**（`src/main/ipc/media-read-guard.ts`：用户显式选择的文件 →
  已入库媒体 → PathGuard 兜底），未授权时整次批量以 `IPC_PATH_FORBIDDEN` 失败、不触达 `applyBatch`。
  收紧前 service 直接 `fsp.readFile` 该路径，渲染进程可指任意绝对路径把私人图片字节合成进导出文件
  （原 plan §8 E3 待办，就此关闭）。连带行为：重启后套用存下来的旧模板时，位于未索引目录的 logo
  不再被授权，需重选图片——渲染层已有失败可见提示与重选引导（plan §8 E1）。
- 编辑器内的图片水印**不走本域通道**：预览与导出由渲染层 canvas 完成
  （`src/renderer/utils/imageProcessor.ts` 的 `applyWatermark`），只有画廊批量「添加水印」走
  `watermark:apply`。canvas 链路经 `media://` 取 logo 字节（授权口径见
  `src/main/app/media-protocol.ts` 的 `isMediaPathAllowed` 规则 0），service 链路用 `fs` 直读但
  以同一口径的 `assertMediaAccessPath` 前置校验——两条链路的 logo 授权判据同源。

## 11. 路径白名单归一口径（2026-10-20 Linux CI 修复补录）

- 本轮**未新增/改名任何通道，未改任何方法签名与 `IpcResponse`/`IpcError` 结构**，仅订正既有通道的前置校验归一口径，故按契约同步义务在此登记。
- `src/main/ipc/validator.ts` 的 `PathGuard`（`assertFileReadPath` / `assertFileWritePath` 的白名单判定，以及 `isUserPicked` / `isUserPickedDir` 短路）改为**固化 `path.win32` 语义**，与同层黑名单 `isSensitivePath`（`src/main/utils/ipc-validate.ts`）口径一致。原因：白名单原先读宿主 `path`，CI 的 ubuntu runner 上 `path.posix.isAbsolute('D:\…')` 为 false，使所有 Windows 形态已授权路径被判为「路径不在白名单内」（错误码 `IPC_PATH_FORBIDDEN` 不变，只是不再误报）。
- 判据语义不变：非绝对路径（含 `relative/a.jpg`）、未登记路径、系统敏感目录仍返回 `IPC_PATH_FORBIDDEN`；`details.path` 仍经 `maskPath` 脱敏，仅在非 Windows 宿主下分隔符形态不同。

## 12. app:gpu-status（2026-10-24 GPU 硬件加速优化新增）

- **通道**：`app:gpu-status`（无入参，`wrapHandlerNoArgs` 包装，只读、无副作用）。
  注册于 `src/main/ipc/handlers/app-handler.ts`，实现委托 `src/main/app/gpu-status.ts` 的
  `collectGpuStatus()`；preload 侧暴露为 `window.electronAPI.app.getGpuStatus()`。
- **返回**（`GpuStatusSummary`，类型真相源 `src/shared/types/electron-api.ts`）：
  `hardwareAcceleration{enabled, reason: 'default'|'user-disabled'|'crash-fallback'|'retry-after-update'}`、
  `fallback{active, consecutiveFailures, fallbackVersion}`、
  `discretePreference{mode: 'auto'|'high-performance', registry: 应用结果|null}`、
  `featureStatus: Record<string,string>|null`（chrome://gpu 同源特性状态）、
  `gpus: GpuDeviceSummary[]|null`、`activeGpu: string|null`（auxAttributes.glRenderer）、
  `electronVersion`、`platform`。
- **容错契约**：`getGPUInfo('complete')` 3s 超时竞速 → 降级 `'basic'` → 再失败
  `gpus`/`activeGpu`/`featureStatus` 为 `null`（软件回退态 GPUInfo 缺失不抛错）；
  调用方（设置→日志与诊断的 GPU 状态卡、启动日志摘要）对 null 一律显示「不可用」。
- **消费方**：`src/renderer/pages/settings/diagnostics-sections.tsx`（GPU 状态卡）、
  `src/main/app/window-manager.ts`（did-finish-load 后记一行摘要日志）。

## 13. 文件导出域与同族写通道（2026-10-26 导出修复补录）

- 本轮**未新增/改名任何通道，未改任何入参 schema 与返回形状**（`file:export` / `file:saveAs` /
  `file:copy` / `file:move` / `file:rename` / `file:batchRename` 的参数与 `IpcResponse` 结构不变），
  仅订正源路径的前置校验口径与默认导出目录的白名单恢复，故按契约同步义务在此登记。
- **源图读校验统一到 `assertMediaAccessPath`**（`src/main/ipc/media-read-guard.ts`，三级：
  `pathGuard.isUserPicked` → `isMediaPathAllowed`（DB 已索引 `file_path` / 已索引 `source_path`
  下媒体扩展名 / 原生缩略图）→ `assertFileReadPath` 兜底）。落点：
  `file-export-handler.ts` 的 `file:export` / `file:saveAs`、`file.ts` 的 `file:copy`、
  `file-rename-handler.ts` 的 `file:move` / `file:rename` / `file:batchRename`。
  原先这些通道对**源文件**用裸 `assertFileReadPath`，而该校验在目标目录写校验**之前**执行，
  于是「导出到默认目录」与「选择目录导出」以同一个 `IPC_PATH_FORBIDDEN` 失败；已入库媒体并不
  必然命中 PathGuard——官方启动器默认装在 `C:\Program Files\InfinityNikki Launcher\...`，
  命中 `isSensitivePath` 黑名单，而 `isAllowed` 的判定顺序是「黑名单先于 roots」，登记扫描根
  也不放行，表现为图库里（`media://`）看得见、导不出。与 §11 的 `PathGuard` win32 归一是两个
  独立缺陷，本轮不动那部分。
- **放宽面有界**：只放行「DB 已索引媒体 ∪ 用户经系统对话框显式选过的路径」，其余未入库路径
  仍由 `assertFileReadPath` 判 `IPC_PATH_FORBIDDEN`、`details.path` 仍经 `maskPath` 脱敏。
  由 `file-export-handler.test.ts` 的 E3 / X1 与 `file.test.ts` 的 D6 钉住；目标目录写校验
  一律保持 `assertFileWritePath` 不变。刻意**不用** `assertMediaReadPath`：它保留
  `isSensitivePath` 前置闸门与 realpath 复检，对 Program Files 安装形态仍会回落拒绝。
- **`export.defaultDir` 进入 pathGuard 恢复源**：`refreshPathGuardRoots`
  （`src/main/app/media-update.ts`）在既有三类（`media_files.source_path` /
  `app_settings.customScanPaths` / `import_roots`）之外新增第 4 类 `app_settings.export.defaultDir`
  （仅非空字符串才登记）。`roots` 与 `userPicked` 都是进程内存态、重启即空，而导出时的默认目录
  是从设置读出的字符串、不再经过对话框，缺了恢复源就无人把它装回白名单——默认目录不在用户
  主目录/扫描根下（如 `D:\导出`）时，重启后 `file:export` 的目标写校验必然 `IPC_PATH_FORBIDDEN`。
  不构成自助扩权：写入端 `export:setDefaultDir` 必须先过 `assertFileWritePath`，而
  `assertAllowed` 的 `op` 只影响文案、读写共用同一 `isAllowed` 判定集，故登记后判定范围不变。
