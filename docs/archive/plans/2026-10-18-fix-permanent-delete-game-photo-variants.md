# 完全删除图片未同步清理游戏三目录同图文件修复（2026-10-18）

- 日期：2026-10-18
- 分支 / 基线 HEAD：`aa7c653`
- 状态：执行中（本文档先于业务代码入库；执行记录回填 §10）
- 范围已与用户确认：只修复「完全删除」链路对 `NikkiPhotos_HighQuality` / `NikkiPhotos_LowQuality` / `X6Game\ScreenShot` 三个目录中同图文件的同步清理，不扩大到扫描器、渲染层交互、缩略图生成策略

---

## 0. 背景（Context）

用户反馈：在软件内对图片执行「完全删除」后，该图片在游戏路径下 **highquality、lowquality、screenshot 三个目录**中的同名照片、缩略图或衍生文件**仍然残留**未被删除。

### 0.1 实测确认的真实目录结构（本机只读验证，非推测）

本机游戏根：`H:\InfinityNikki Launcher\InfinityNikki`

| 目录（相对游戏根）                                               | 实测文件数 | 说明                                |
| ---------------------------------------------------------------- | ---------- | ----------------------------------- |
| `X6Game\Saved\GamePlayPhotos\114077271\NikkiPhotos_HighQuality\` | 24         | 高清原图（图库板块主路径）          |
| `X6Game\Saved\GamePlayPhotos\114077271\NikkiPhotos_LowQuality\`  | 23         | 游戏原生低清缩略副本                |
| `X6Game\ScreenShot\`                                             | 72         | 游戏截图副本，**扁平无 UID 子目录** |

- 三个目录中**同一张照片文件名完全相同**，形如 `2026_06_16_21_17_41_299035.jpeg`。
- 实测交集：`HQ ∩ LQ = 23`、`HQ ∩ ScreenShot = 24`（24 张 HQ 照片**全部**在 `X6Game\ScreenShot` 有同名副本）。
- `X6Game\Saved\GamePlayPhotos\114077271\` 下实测子目录：`ClockInPhoto`、`CloudPhotos`、`NikkiAlbums_NikkiPhotos`、`NikkiPhotos_HighQuality`、`NikkiPhotos_LowQuality`、`Videos`、`PendingUp.jpeg` —— **GamePlayPhotos 下没有 Screenshot 子目录**。
- `X6Game\` 下实测子目录：`Binaries`、`Content`、`Plugins`、`Samples`、`Saved`、`ScreenShot`、`Video`；`X6Game\Saved\ScreenShot` 本机不存在，但 `src/main/scanner/scan-channels.ts:29-33` 的 `SECONDARY_RELATIVE_PATHS` 同时收录 `X6Game\ScreenShot` 与 `X6Game\Saved\ScreenShot`。
- 数据库（从 `%APPDATA%\wxnn-photo-manager\database\wxnn_photo_manager.db` 文本抽取统计）中这三个目录各有独立媒体记录：`NikkiPhotos_HighQuality` 47 行、`NikkiPhotos_LowQuality` 36 行、`X6Game\ScreenShot` 87 行 ⇒ 三个副本**都各自入库**，删除时必须联动清理其记录。

### 0.2 根因（有行号证据）

三条删除通道 `media:delete` / `media:permanentDelete` / `media:emptyRecycleBin` 的「同图衍生文件清理」**唯一汇聚点**是 `src/main/ipc/handlers/_trash-utils.ts` 的 `collectThumbnailCleanupTargets`（`:271`）。它只收集两类目标：

1. **缓存缩略图**：`row.thumbnail` 落在 `cacheDir` 内 → 引用文件 + `${hash}.jpg/_low/_high` 三档位（`_trash-utils.ts:311-328`）。
2. **游戏原生 LQ**：`resolveNativeThumbnailPath(row.file_path)` 严格推导（`_trash-utils.ts:330-343`）—— 而 `src/main/scanner/path-classifier.ts:164` 的 `resolveNativeThumbnailPath` **只做一件事**：把归一化路径中唯一出现的 `\nikkiphotos_highquality\` 目录段替换为 `NikkiPhotos_LowQuality`，非 GPP / 非 HQ 目录段一律返回 `null`。

因此：

- **`X6Game\ScreenShot\<同名文件>` 完全没有推导与清理逻辑** ⇒ 该副本及其 `media_source='local_screenshot'` 数据库记录 **100% 残留**（实测 24/24 命中），重扫即复活，正是用户看到的现象。
- LQ 清理**只在被删行本身就是 HQ 行时生效**（单向），这是既有的、正确的部分，本次保留并纳入统一口径。
- `file:deletePermanent`（`src/main/services/file-service.ts:423`）只对传入的那一个路径 `fsp.unlink`，不承担关联清理职责；渲染层 `src/renderer/hooks/useFileOperations.ts:283` 也只传了 `file.file_path` 一项。
- 不存在「删除失败被吞掉」或「文件占用/权限」导致的静默失败：`file-service.deletePermanent` 已区分 ENOENT 与其他错误并返回 partial；`unlinkBatch` 有三态 + 重试 + 熔断 + 聚合日志。**问题纯属「关联路径未推导」，不是删除动作失败。**

### 0.3 软删除 vs 完全删除的路径差异（已确认）

| 通道                       | 渲染层入口                                                                                                    | 是否碰物理文件                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 软删除（移入回收站）       | `useFileOperations.ts:304` `api.mediaAction.softDelete([id])`                                                 | **否**，仅 `UPDATE ... is_deleted=1, delete_origin='user'`      |
| 完全删除（单文件，图库页） | `useFileOperations.ts:283` `api.file.deletePermanent([file.file_path])` + `:292` `api.mediaAction.delete(id)` | 是：先 unlink 单文件，再 `media:delete` 硬删记录 + 清理衍生文件 |
| 彻底删除（回收站批量）     | `media:permanentDelete`                                                                                       | 是：软删标记 → `unlinkBatch` → `hardDeleteBatch` → 清理衍生文件 |
| 清空回收站                 | `media:emptyRecycleBin`                                                                                       | 是：同 `permanentDelete`                                        |

⇒ 只有**完全/彻底删除**才触发物理清理；本次改动全部落在清理阶段，软删除语义不受影响。

---

## 1. 依赖声明

**零新增 / 零变更 npm 依赖。** 全部复用仓库既有能力：

| 复用项                                                                             | 出处                                             | 用途                                   |
| ---------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------- |
| 路径推导纯函数口径（`\x6game\saved\gameplayphotos\`、`\nikkiphotos_highquality\`） | `src/main/scanner/path-classifier.ts:164`        | 新函数复用同一套归一化与目录段定位逻辑 |
| `pathExists`                                                                       | `src/main/utils/file-utils.ts`                   | 删除前预检，不存在即跳过               |
| `fsp.unlink`                                                                       | Node 内置（已在 `_trash-utils.ts` 使用）         | 统一删除原语                           |
| `logger.warn`                                                                      | `src/main/utils/logger.ts`                       | 聚合日志                               |
| `MediaRepository.getMediaIdByPath` / `hardDelete`                                  | `src/main/database/media-repository.ts:939/:745` | 联动硬删衍生副本自身的数据库记录       |
| 三档位缓存命名推导正则 `CACHE_THUMB_NAME_RE`                                       | `src/main/ipc/handlers/_trash-utils.ts:261`      | 衍生副本缓存缩略图清理复用             |
| Vitest 同目录 `*.test.ts` 测试模式                                                 | 仓库约定                                         | 复现 / 回归测试                        |

---

## 2. 修复范围

| 文件（完整仓库路径）                                                | 改动性质 | 说明                                                                                                         |
| ------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `docs/plans/2026-10-18-fix-permanent-delete-game-photo-variants.md` | 新增     | 本文档                                                                                                       |
| `src/main/scanner/path-classifier.ts`                               | 修改     | 新增导出纯函数 `resolveGamePhotoVariantPaths(filePath): string[]`；`resolveNativeThumbnailPath` **保持不变** |
| `src/main/scanner/path-classifier.test.ts`                          | 修改     | 新增该纯函数用例组                                                                                           |
| `src/main/ipc/handlers/_trash-utils.ts`                             | 修改     | 接入变异目标收集、失败路径聚合日志、变异行缓存清理；新增 `@core-change` 注释                                 |
| `src/main/ipc/handlers/_trash-utils.test.ts`                        | 修改     | 新增 D 组复现用例（红灯先行）；同步更新受影响的既有断言                                                      |
| `src/main/database/media-repository.ts`                             | 修改     | 新增同步方法 `getThumbnailByPath(filePath): string \| null`                                                  |
| `src/main/ipc/handlers/media-lifecycle-handler.ts`                  | 修改     | 3 处 `makeNativeThumbRecordCleaner` 调用传入 `cacheDir`；**替换**第 1 行 `@core-change` 原因                 |

**明确不触碰**：`resolveNativeThumbnailPath`（被 `src/main/thumbnail/generator.ts:433`、scanner repair 脚本引用）、`unlinkBatch` / `unlinkWithFallback`、`file-service.deletePermanent`、`media-read-guard.ts`、扫描器入库逻辑、渲染层删除交互、i18n key。

---

## 3. 方案说明

### 3.1 新增纯函数：同图变异路径推导

`src/main/scanner/path-classifier.ts` 新增导出：

```ts
export function resolveGamePhotoVariantPaths(filePath: string): string[]
```

推导规则（**纯字符串运算、零 IO、无副作用**）：

1. 入参守卫：`!filePath || typeof filePath !== 'string'` → `[]`。
2. 归一化只做 `/ → \` + 小写（长度不变，索引与原路径一一对应）。
3. 必须同时命中：
   - `\x6game\saved\gameplayphotos\`（官方相册锚点，防用户自建同名目录误伤）；
   - `\nikkiphotos_highquality\`（**HQ 锚点**，见 §3.4 边界）；
   - `GamePlayPhotos` 与 `NikkiPhotos_HighQuality` 之间必须是一个**单层纯数字 UID 目录**（对齐 `src/main/scanner/gameplayphotos-root.ts:54` 的 `UID_DIR_REGEX`）；结构异常（如 `...\<uid>\sub\NikkiPhotos_HighQuality\` 或 UID 非纯数字）**整体返回空数组**，绝不猜测路径。
4. 输出候选（按序、去重）：
   1. 兄弟目录 `NikkiPhotos_LowQuality\<同名>`（替换目录段，保留原路径的大小写与分隔符形态）
   2. `<X6Game 根>\ScreenShot\<同名>`
   3. `<X6Game 根>\Saved\ScreenShot\<同名>`
      —— `<X6Game 根>` 由 `\saved\gameplayphotos\<uid>\` 反切得到。

`kind` 沿用 `'native'`，注释口径扩为「游戏原生同图衍生文件（LQ 同名副本 / X6Game\ScreenShot 同名副本）」。

### 3.2 接入清理阶段

`collectThumbnailCleanupTargets` 中把原来的单个 `resolveNativeThumbnailPath` 调用改为遍历 `resolveGamePhotoVariantPaths(row.file_path ?? '')` 逐个 `pushTarget`。既有的三重安全边界**全部保留**：

- `batchPaths` 排除（推导结果与批内任一 `file_path` 相同 → 交给该行自身删除流程处理，避免重复删除）
- `isInsideCacheDir` 排除（推导结果落在缓存目录属异常数据，不删）
- `seen` 去重 + 非法路径 `try/catch` 跳过

### 3.3 避免重复删除 / 误删 / 路径错误

| 风险         | 兜底                                                                              |
| ------------ | --------------------------------------------------------------------------------- |
| 重复删除     | `seen` 大小写不敏感去重 + `batchPaths` 排除 + `pathExists` 预检                   |
| 误删其他图片 | 只做**目录段替换 + 同名文件名**，绝不按文件名模糊匹配、绝不递归目录、绝不扫描目录 |
| 误伤自建目录 | 必须命中完整 `\x6game\saved\gameplayphotos\` 锚点 + HQ 目录段 + 单层纯数字 UID    |
| 路径错误     | 结果必须仍以原文件名结尾；`pathExists` 预检后才 unlink                            |
| 跨账号误删   | `X6Game\ScreenShot` 为游戏级扁平目录，不涉 UID；LQ 为同 UID 兄弟目录，不跨账号    |

### 3.4 已知边界（明确写定，不做反向推导）

从 **`NikkiPhotos_LowQuality` 行**或 **`X6Game\ScreenShot` 行**触发完全删除时，**不反向删除 HQ 原图**。理由：

1. `X6Game\ScreenShot` 扁平无 UID 段，无法纯路径推导 HQ/LQ；猜测 UID 有跨账号误删风险。
2. 「缓存 / 截图」视图删除不应连带删除图库原图，符合「不得误删」硬要求。

后续可选扩展（本次不做）：按 `file_name` 在 `X6Game` 子树内查库匹配其余副本。见 §9 残留风险。

---

## 4. 启动说明（只使用仓库真实存在的脚本）

| 步骤 | 命令                                                        | 说明                                                                    |
| ---- | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| 环境 | 仓库已 `npm install` 完成，无需重装（**零新增依赖**）       | —                                                                       |
| 单测 | `npx vitest run src/main/scanner/path-classifier.test.ts`   | 纯函数用例                                                              |
| 单测 | `npx vitest run src/main/ipc/handlers/_trash-utils.test.ts` | 清理目标收集与执行                                                      |
| 单测 | `npx vitest run src/main/ipc/handlers/media.test.ts`        | 既有 `media:delete` 回归                                                |
| 子集 | `npm run test:main`                                         | `vitest run src/main`                                                   |
| 全量 | `npm test`                                                  | `vitest run`（全仓）                                                    |
| 类型 | `npm run typecheck`                                         | `tsc -b && tsc -p tsconfig.scripts.json`                                |
| 静态 | `npm run lint`                                              | `eslint .`                                                              |
| 格式 | `npm run format`                                            | `prettier`                                                              |
| 闸门 | `npm run verify`                                            | 只读：typecheck + eslint + core-path-gate + prettier --check + 相关单测 |
| 手动 | `npm run dev`                                               | 真机验证（见 §9 验收标准 A5）                                           |

> 本机不执行打包（`npm run dist:win`），本次无二进制/原生模块改动。

---

## 5. 错误处理

| 异常分支                            | 行为                                                                                                                                     | 可判定性                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 候选文件不存在                      | `pathExists` 预检为 false → 跳过，不 unlink、不计入失败；若为 `native` 仍触发记录清理钩子（记录此刻已悬空）                              | 单元测试 D3 / B3 断言                        |
| `fsp.unlink` 抛错（EBUSY/EPERM 等） | 捕获后二次 `pathExists` 复检：已消失按 missing 处理；仍存在则计入失败、聚合一条 warn，**不触发记录清理钩子**（保留数据库记录供用户重试） | 单元测试 D5 断言 `logger.warn` 被调用 1 次   |
| 路径非法（`path.resolve` 抛错）     | `try/catch` 跳过该目标                                                                                                                   | 单元测试 D7 断言                             |
| `cacheDir` 为空串                   | `collectThumbnailCleanupTargets` 直接返回 `[]`（既有 A9 行为不变）                                                                       | 既有 A9                                      |
| 记录清理钩子抛错                    | 吞掉并聚合到同一条 warn，不影响删除计数与 IPC 返回（既有 B4 行为不变）                                                                   | 既有 B4                                      |
| 主文件删除失败                      | 仍由 `unlinkBatch` 三态决定：`failed` 时**保留数据库记录**，IPC 返回 partial 文案                                                        | 既有行为，不受本次改动影响                   |
| 异步清理未触发                      | 三条通道均 `await` 阶段 4 清理，未使用 fire-and-forget                                                                                   | 代码审计 + `media-lifecycle-handler.test.ts` |

**关键取舍**：衍生副本删除是 **best-effort**，不参与 `unlinkBatch` 的「是否硬删数据库记录」决策——主文件删成功即删主记录；副本删失败只记录日志并保留副本自身的数据库记录，用户可重试。绝不因副本锁定而让整次删除失败。

---

## 6. 日志输出

复用既有聚合约定（**禁止循环内逐项 warn**：历史上 2474 项失败写出 2474 行刷爆日志）。

- `cleanupThumbnailsForRows` 结束时若有失败，输出**一条** `logger.warn`，内容包含：
  - 目标总数、已删数、原生记录联动数（既有文案保留）
  - **新增**：失败路径样例（最多 3 条，沿用 `UNLINK_LOG_SAMPLE_LIMIT = 3`）与省略计数
- 失败原因：聚合首个错误对象作为 `logger.warn` 第二参（既有行为）。
- 跳过策略：候选文件不存在属预期（三目录并不总是齐备），**不写日志**，避免噪声。
- 成功路径不写日志（既有行为，删除是高频操作）。

---

## 7. 参数校验

| 层                               | 校验                                                                                                                                          | 非法值处理            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `resolveGamePhotoVariantPaths`   | ① 非字符串 / 空串 → `[]`；② 非官方相册路径 → `[]`；③ 非 HQ 目录段 → `[]`；④ UID 段非单层纯数字 → 整体返回 `[]`；⑤ 文件名含分隔符或为空 → `[]` | 返回空数组，不抛异常  |
| `collectThumbnailCleanupTargets` | ① `cacheDir` 空 → `[]`；② `path.resolve` 抛错 → 跳过；③ 目标落在 `cacheDir` 内 → 跳过；④ 目标与批内 `file_path` 相同 → 跳过                   | 跳过，不影响其他行    |
| `cleanupThumbnailsForRows`       | `rows` 元素缺 `file_path` / `thumbnail` 字段（既有 A10 兼容）→ 仅按 `thumbnail` 做缓存清理，不推导                                            | 跳过推导              |
| IPC 入参                         | 沿用既有 `schemas.mediaId` / `schemas.mediaIdArrayBulk`（`src/main/ipc/validator.ts`），**不改校验规则**                                      | 既有 `AppError` 语义  |
| 目录外路径                       | 推导结果必须仍在同一游戏树内（由 `\x6game\saved\gameplayphotos\` 锚点与 `<X6Game 根>` 反切保证）                                              | 结构不满足即返回 `[]` |

---

## 8. 基础测试用例

### 8.1 新增（红灯先行，修复前必须失败）

`src/main/ipc/handlers/_trash-utils.test.ts` D 组：

| 编号 | 场景         | 用例要点                                                                                                          | 修复前预期                |
| ---- | ------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------- |
| D1   | 正常完全删除 | HQ 行 → `collectThumbnailCleanupTargets` 的 `native` 目标**包含** `X6Game\ScreenShot\p.jpg` 与 LQ 路径            | ❌ 失败                   |
| D2   | 正常完全删除 | `cleanupThumbnailsForRows` 对 HQ 行执行后 `unlink` 被调用 3 次（LQ / ScreenShot / Saved\ScreenShot 中存在的那些） | ❌ 失败                   |
| D3   | 文件不存在   | 候选不存在 → 不 unlink、不报错、返回计数只含存在的目标                                                            | ❌ 失败                   |
| D4   | 数据库记录   | 每个被移除的变异路径都触发 `onNativeThumbnailRemoved` → `repo.hardDelete`                                         | ❌ 失败                   |
| D5   | 删除失败     | ScreenShot 副本 unlink 抛 EBUSY 且仍存在 → 其余照删、`logger.warn` 聚合 1 条、该副本**不**触发记录清理钩子        | ❌ 失败                   |
| D6   | 误删防护     | 非官方相册路径（用户自建 `C:\backup\GamePlayPhotos\...\NikkiPhotos_HighQuality\p.jpg`）→ **无**变异目标           | ✅ 通过（防回归，非复现） |
| D7   | 边界         | 空串 / 非字符串 / 相对路径 → `[]`                                                                                 | ✅ 通过（防回归）         |
| D8   | 边界         | 推导结果与批内另一行 `file_path` 相同 → 排除（不重复删除）                                                        | ❌ 部分失败               |

`src/main/scanner/path-classifier.test.ts` E 组（纯函数）：

| 编号 | 用例要点                                                                          |
| ---- | --------------------------------------------------------------------------------- |
| E1   | 标准 HQ 路径 → 产出 LQ + `X6Game\ScreenShot` + `X6Game\Saved\ScreenShot` 三个候选 |
| E2   | 保留原路径大小写与分隔符形态（正斜杠输入、异常大小写目录段）                      |
| E3   | LQ 锚点 / `X6Game\ScreenShot` 路径 → `[]`（不做反向推导，§3.4）                   |
| E4   | UID 段非单层纯数字（如 `...\114077271\sub\NikkiPhotos_HighQuality\p.jpg`）→ `[]`  |
| E5   | 用户自建同名目录 / 空串 / 非字符串 → `[]`                                         |
| E6   | 无 `Saved` 段的变体 `X6Game\GamePlayPhotos\...` → `[]`（锚点口径不变）            |

### 8.2 同步更新的既有断言（`_trash-utils.test.ts`）

因新增 ScreenShot 目标，以下既有用例的期望值需按新语义更新（**不是弱化**，是扩为新口径）：

`A1`（native 目标列表）、`A4`（LQ 锚点仍为 `[]`，不变）、`A5`（`[HQ, LQ]` 批 → 新增 ScreenShot 目标）、`A7`（native 列表）、`A8`（去重后计数）、`B1`（`deleted` 计数）、`B2`（部分失败计数）、`B3`（hook 调用次数与入参）。

### 8.3 必须保持通过（禁止回归）

`src/main/ipc/handlers/media.test.ts`（`media:delete` 端到端，含 6 处 `getMediaIdByPath` 断言）、`media-lifecycle-handler.test.ts`、`src/main/thumbnail/generator.test.ts`、`src/main/scanner/path-classifier.test.ts` 既有全部用例。

---

## 9. 验收标准

| #   | 验收项                     | 判定标准                                                                                                                          | 验证方式                                                                            |
| --- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| A1  | 红灯证据                   | D1–D5、D8 在**修复前**失败并有失败输出（截图/日志留档于 §10）                                                                     | `npx vitest run src/main/ipc/handlers/_trash-utils.test.ts`                         |
| A2  | 绿灯                       | 上述用例修复后全部通过                                                                                                            | 同上                                                                                |
| A3  | 纯函数用例                 | E1–E6 全部通过                                                                                                                    | `npx vitest run src/main/scanner/path-classifier.test.ts`                           |
| A4  | 全量回归                   | `npm test` 全绿，无跳过失败                                                                                                       | `npm test`                                                                          |
| A5  | 三目录同步清理（手动实测） | 图库中完全删除一张照片后：`NikkiPhotos_HighQuality`、`NikkiPhotos_LowQuality`、`X6Game\ScreenShot` 三个目录中**均不存在**该文件名 | `npm run dev` 后手工执行，并用 `Get-ChildItem` 复核三目录                           |
| A6  | 无数据库残留               | 删除后 `SELECT id FROM media_files WHERE file_name = '<同名>'` 返回 0 行                                                          | 手工：删除前后对 `%APPDATA%\wxnn-photo-manager\database\wxnn_photo_manager.db` 查询 |
| A7  | 无缓存残留                 | 删除后缩略图缓存目录中不存在该照片各副本对应的 `<hash>.jpg/_low/_high`                                                            | 手工复核 `%APPDATA%\wxnn-photo-manager\thumbnails`                                  |
| A8  | 重扫不复活                 | 删除后重新扫描，该照片不出现在图库 / 缓存 / 截图任一板块                                                                          | `npm run dev` 手工执行扫描                                                          |
| A9  | 软删除不受影响             | 「移入回收站」后三个目录文件**仍然存在**，回收站可见、可恢复                                                                      | `npm run dev` 手工验证                                                              |
| A10 | 类型检查                   | `npm run typecheck` 零错误                                                                                                        | `npm run typecheck`                                                                 |
| A11 | 静态检查                   | `npm run lint` 零错误                                                                                                             | `npm run lint`                                                                      |
| A12 | 核心路径闸门               | `npm run verify` 全绿（`_trash-utils.ts` 与 `media-lifecycle-handler.ts` 的 `@core-change` 合规）                                 | `npm run verify`                                                                    |

---

## 10. 执行记录（回填）

| 节点 | 内容                                               | 结果                                                                             | 命令 / 证据                                                                                                                                           |
| ---- | -------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1   | 计划文档入库                                       | ✓                                                                                | 本文档                                                                                                                                                |
| T2   | 红灯                                               | ✓ **12 failed / 96 passed**                                                      | `npx vitest run src/main/ipc/handlers/_trash-utils.test.ts src/main/scanner/path-classifier.test.ts`                                                  |
| T3   | `resolveGamePhotoVariantPaths`                     | ✓ 82 passed                                                                      | `npx vitest run src/main/scanner/path-classifier.test.ts`                                                                                             |
| T4   | `_trash-utils.ts` 接入                             | ✓ 26 → 28 passed（含 D10/D11）                                                   | `npx vitest run src/main/ipc/handlers/_trash-utils.test.ts`                                                                                           |
| T5   | repo + handler 接线                                | ✓ 269 passed                                                                     | `npx vitest run src/main/ipc/handlers/media.test.ts src/main/ipc/handlers/media-lifecycle-handler.test.ts src/main/database/media-repository.test.ts` |
| T6   | 子集绿灯（含既有断言同步 A1/A5/A7/A8/B1/B2/B3/B4） | ✓ 110 passed                                                                     | `npx vitest run src/main/ipc/handlers/_trash-utils.test.ts src/main/scanner/path-classifier.test.ts`                                                  |
| T7   | 全量校验                                           | ✓ 413 files / **6395 passed \| 2 skipped**；typecheck / lint 0 error；verify 5/5 | `npm test`、`npm run typecheck`、`npm run lint`、`npm run verify`、`npx vitest run scripts/__tests__/check-md-links.test.ts`                          |
| T8   | 真机只读推导验证                                   | ✓ 见 §10.1                                                                       | `npx tsx -e ...` + `Test-Path`                                                                                                                        |

### 10.1 真机只读验证（不删除任何用户照片）

用生产代码对真实 HQ 路径推导并核验候选是否真实存在：

```
输入  H:\InfinityNikki Launcher\InfinityNikki\X6Game\Saved\GamePlayPhotos\114077271\NikkiPhotos_HighQuality\2026_06_16_21_17_41_299035.jpeg
输出  ...\NikkiPhotos_LowQuality\2026_06_16_21_17_41_299035.jpeg   → Test-Path = True
      ...\X6Game\ScreenShot\2026_06_16_21_17_41_299035.jpeg        → Test-Path = True（修复前**从未被清理**的残留点）
      ...\X6Game\Saved\ScreenShot\2026_06_16_21_17_41_299035.jpeg  → Test-Path = False（候选，执行时 pathExists 预检跳过）
```

全量统计（遍历真实 HQ 目录 24 个文件）：`HQ总数=24 有LQ=23 有ScreenShot=24`
⇒ **修复前每一次「完全删除」都会在 `X6Game\ScreenShot` 留下 1 个残留文件 + 1 条 `local_screenshot` 数据库记录（24/24 命中）**，与用户反馈完全吻合。

---

## 11. 已知残留风险

1. **反向推导未覆盖**（§3.4）：从「缓存 / 截图」视图完全删除时，不会连带删除 HQ 原图。属于有意取舍。
2. **非 HQ 相册目录**（`ClockInPhoto`、`CloudPhotos`、`MagazinePhotos`、`Videos`、`Collage` 等）的同图副本关系本次未建模——实测这些目录与 HQ 不存在同名副本，且用户未反馈。
3. **多 UID 同名碰撞**：`X6Game\ScreenShot` 为游戏级扁平目录，若同一台机器多账号存在同名文件（时间戳含微秒，实测唯一），会被一并删除；概率极低但非绝对为零。
4. **`X6Game\Saved\ScreenShot`** 本机不存在，作为候选一并产出，由 `pathExists` 守卫；若将来存在则自动生效。
