# 修复自动扫描后「未发现游戏内截图」实施方案

> 目标：电脑中存在 `InfinityNikki Launcher\InfinityNikki\X6Game\ScreenShot`（图片）与
> `InfinityNikki Launcher\InfinityNikki\X6Game\Video`（视频）时，自动扫描后**图库板块**应正确显示它们；
> 除这两个目录之外的图片/视频仍归入**缓存**板块。不改动其他无关功能。

## 1. 根因分析

自动扫描后图库显示「已完成扫描，未发现游戏内截图…」的三步链路：

1. **目录发现（基本可用）**：`game-directory-discovery.ts` 的安装树签名 `X6Game` 命中后返回其父目录
   `InfinityNikki` 作为扫描根；`worker-entry.ts` 的 `scanDirectory` 递归（深度 15）可覆盖 `X6Game\ScreenShot`
   与 `X6Game\Video`。缺陷：媒体文件夹签名 `MEDIA_FOLDER_SIGNATURES` 含 `ScreenShot` 但**缺 `Video`**，
   且 `Video` 为通用名需上下文校验（否则误匹配 QQ/微信/TencentMeeting 的 Video 目录）。
2. **来源分类（已正确，不需改规则）**：`path-classifier.ts` 仅把 `X6Game\Saved\ScreenShot` 归 `launcher`（缓存）；
   用户真实路径 `X6Game\ScreenShot`（无 Saved）与 `X6Game\Video` 走默认分支返回 `game`（图库）。
3. **图库 SQL 过滤（致命）**：`media-repository.ts` 的 `GALLERY_HQ_PATH_CONDITION` 仅匹配
   `GamePlayPhotos/{uid}/NikkiPhotos_HighQuality`。图库视图 `galleryHighQualityOnly=true` 时只放行 HQ 路径，
   导致 `ScreenShot`/`Video` 即使标为 `game` 也进不了图库 → 图库为空 → 触发「未发现游戏内截图」提示。

**修复核心**：扩展图库放行条件为 `HQ ∪ X6Game/ScreenShot ∪ X6Game/Video`（与缓存反向条件对称）；
补强 `Video` 签名；新增存量迁移 V5 修复已被误标的旧记录。

## 2. 依赖声明

- 全部复用项目既有依赖，**不引入任何新依赖**：
  - `better-sqlite3`（主进程数据库，V5 迁移与图库 SQL 均复用）
  - `tinyglobby`（目录签名搜索，V1 已完成 mock 化用于单测）
  - `vitest`（测试框架，复用既有的 mock + 真实 in-memory db 两种模式）
- 参考上游成熟方案对齐目录语义（RanAxro/nikki_albums 的相册目录约定），不自造算法。

## 3. 启动 / 运行说明

```powershell
# 1. 安装依赖（本机受 Safe-Delete 网关限制，必须用增量安装，禁用 npm ci / 删 node_modules）
cd "h:\45001\Documents\WXNN XiangCe2"
npm install

# 2. 运行全部单测（主进程 scanner + database）
npx vitest run src/main/scanner src/main/database

# 3. 类型检查
npm run typecheck

# 4. 构建（绕过 clean 的 Safe-Delete 网关，勿用 npm run dist:win）
npx electron-vite build
# 产物校验 / 打包序列见 working_memory；安装包输出 release/NikkiGallery-Setup-<ver>.exe
```

- 首次启动：`startScan` 会对所有盘执行安装树签名搜索定位 `X6Game`，递归扫描其下媒体；
  修复链（`repairLegacyDataV2/V3/V4/V5`）在扫描前幂等执行，确保存量数据被正确归类。

## 4. 错误处理

| 位置                          | 错误场景                          | 处理                                                                                           |
| ----------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `repair-legacy-data-v5.ts`    | `schema_migrations` 表不存在      | 捕获异常降级为「每次执行」，不影响主流程                                                       |
| 同上                          | 主查询 `all()` 抛错（如 db lock） | `log error` 并返回 `false`，中断修复链后续步骤（`if (repairOk && db)`）                        |
| 同上                          | 标记迁移 `INSERT` 抛错            | 仅 `log warn` 并返回 `true`（下次重复执行，幂等）                                              |
| `game-directory-discovery.ts` | `Video` 等通用名路径              | 仅当父目录含 `infinitynikki`/`x6game` 才视为游戏媒体，避免误匹配                               |
| `media-repository.ts`         | 图库/缓存条件拼接                 | 新增常量 `GALLERY_PATH_CONDITION` 与 `NOT_IN_GALLERY_PATH_CONDITION` 严格对称，防缓存漏显/重显 |

## 5. 参数校验

- `repairLegacyDataV5(db, log)`：`db` 需为 `better-sqlite3.Database` 实例；`log` 需为
  `(level, message, ...args) => void`。函数内部仅改写 `media_source='launcher'` 且路径命中的行，
  不触碰其他来源，无入参越界风险。
- `searchByMediaFolderSignatureShallow(root, depth)`：`depth` 默认 8；`Video`/`ScreenShot` 命中后取
  `path.dirname(match)` 并去重，返回父目录集合（如 `X6Game`），保证扫描根正确。
- `listMedia` 的 `galleryHighQualityOnly`：仅 `=== true` 时启用图库放行条件；其余视图保持原行为，无副作用。

## 6. 改动文件清单与子任务

### 子任务 1 — 图库 SQL 放行条件（关键修复）

- **文件**：`src/main/database/media-repository.ts`
- **输入**：图库视图 `galleryHighQualityOnly=true` 的 SQL 常量
- **输出**：新增 `GALLERY_PATH_CONDITION`（HQ ∪ `x6game/screenshot` ∪ `x6game/video`）与对称
  `NOT_IN_GALLERY_PATH_CONDITION`；图库条件与缓存内联条件引用新常量
- **验收**：`npx vitest run src/main/database/media-repository.test.ts` 全通过（137）；
  新增用例断言生成 SQL 含 `x6game/screenshot` 与 `x6game/video` 子句

### 子任务 2 — 视频目录签名

- **文件**：`src/main/scanner/game-directory-discovery.ts`
- **输入**：`MEDIA_FOLDER_SIGNATURES` 数组
- **输出**：增加 `'Video'`；为 `screenshot`/`video` 增加父目录上下文校验（含 `infinitynikki`/`x6game`）
- **验收**：`game-directory-discovery.test.ts` 全通过（17）；新增 `Video` 命中用例

### 子任务 3 — 存量迁移 V5

- **文件**：`src/main/scanner/repair-legacy-data-v5.ts`（新建）、`src/renderer/i18n/locales/zh-CN.json`（新增 2 个日志 key）
- **输入**：`db` + `log`
- **输出**：把 `media_source='launcher'` 且路径含 `X6Game/ScreenShot` 或 `X6Game/Video` 的记录重分类为 `game`；
  幂等（schema_migrations 标记 `repair_legacy_data_v5`）
- **验收**：`repair-legacy-data-v5.test.ts` 全通过（7）；覆盖幂等早退/降级/重分类/容错/异常

### 子任务 4 — 接入修复链

- **文件**：`src/main/scanner/worker-entry.ts`
- **输入**：`startScan` 修复链
- **输出**：在 V4 之后追加 `if (repairOk && db) repairOk = repairLegacyDataV5(db, workerLog)`
- **验收**：`npm run typecheck` 通过；scanner 测试全绿（V5 行为本身由子任务 3 单测覆盖）

### 子任务 5 — 分类注释澄清

- **文件**：`src/main/scanner/path-classifier.ts`（注释）+ `path-classifier.test.ts`（新增用例）
- **输入/输出**：无行为变更；明确 `X6Game\ScreenShot`/`X6Game\Video` 归 `game`（图库）
- **验收**：`path-classifier.test.ts` 全通过（60）；新增 `X6Game\Video` 归 game 直测

### 子任务 6 — UX 闭环确认

- **文件**：`src/renderer/stores/mediaStore.ts`、`src/renderer/vite-env.d.ts`（注释更新）
- **输入/输出**：图库查询仍传 `galleryHighQualityOnly:true`；因 SQL 已放行 ScreenShot/Video，
  图库非空时不再误报「未发现游戏内截图」（ScanProgress/GalleryPage 空态逻辑无需改）
- **验收**：`ScanProgress.test.tsx`、`GalleryPage.test.tsx`、`mediaStore.test.ts` 通过
  （注：`GalleryPage.test.tsx` 有 1 例 pre-existing 存量失败，断言源码含 `api.status()`，
  与本次改动无关，未触碰该文件，遵循「不改动其他无关功能」）

### 子任务 7 — 全量验证

- **验收**：`npx vitest run src/main/scanner src/main/database` → 581 用例全通过；
  `npm run typecheck` → 无错误

## 7. 基础测试用例（摘要）

| 模块                     | 用例                                                       | 期望                           |
| ------------------------ | ---------------------------------------------------------- | ------------------------------ |
| media-repository         | 图库 SQL 含 `x6game/screenshot` & `x6game/video`           | 子句存在、无参数（无导入根时） |
| media-repository         | 缓存 SQL 含 `NOT (...x6game/screenshot...x6game/video...)` | 与图库对称                     |
| game-directory-discovery | `Video` 在 `X6Game` 下命中、非游戏上下文 `Video` 剔除      | 返回 `['D:\Game\X6Game']`      |
| repair-legacy-data-v5    | 迁移已应用早退                                             | 返回 true、不查询 media_files  |
| repair-legacy-data-v5    | 仅 ScreenShot/Video 命中重分类为 game                      | 其余 launcher 跳过             |
| repair-legacy-data-v5    | 标记迁移失败仅 warn 且返回 true                            | 幂等                           |
| repair-legacy-data-v5    | 主流程异常返回 false                                       | log error                      |
| path-classifier          | `X6Game\Video` 返回 game                                   | `toBe('game')`                 |

## 8. 实施约束

- 每步先本地验证（单测/typecheck）通过再进入下一步，错误消灭在当下。
- 不引入新依赖、不改动其他无关功能、不新增 i18n 裸中文违规。
- 存量数据通过 V5 幂等迁移自动修复，无需用户手动操作。
