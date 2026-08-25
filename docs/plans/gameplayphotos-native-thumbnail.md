# GamePlayPhotos 多账号扫描 + 原生缩略图直连方案

> 本文档以已批准的实施计划为蓝本落地，内容涵盖依赖声明、启动说明、错误处理、参数校验、基础测试用例，并保留原计划的「假设与边界」与「Rejected Alternatives」章节。文末附实施记录。

## 摘要

经三视角（可维护性 / 性能 / 最小变更）并行勘察与关键文件核验，结论：**需求 1（自动遍历动态数字 UID 子目录）与需求 2（UID 账号隔离）已由现有代码完整覆盖，本方案零改动复用**；真正缺口只有需求 3 —— 现有链路会无视原生缩略图、对 GamePlayPhotos 文件重复生成缩略图。方案核心：扫描入库时把 `thumbnail` 列直接写为同名 `NikkiPhotos_LowQuality` 文件路径，并在所有缩略图生成入口豁免 `gameplayphotos` 路径。零新增依赖、零表结构变更、零 IPC 契约变更，新增代码（含测试）≤ 300 行。

## 现状结论（已核验，勿重复实现）

| 需求点                                | 现有实现（直接复用）                                                                            | 位置                                                                                               |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 发现 `X6Game/Saved/GamePlayPhotos`    | 目录签名含 `NikkiPhotos_HighQuality/LowQuality`、`X6Game`                                       | `src/main/scanner/game-directory-discovery.ts` L50-74                                              |
| 动态遍历所有数字 UID 子目录（不写死） | `discoverUidsFromGameDirs` 用 `^\d{6,12}$` 过滤                                                 | `src/main/scanner/uid-discovery.ts` L15/L48-87                                                     |
| 资源按 UID 归属入库                   | `extractUidFromPath` → `account_uid` 列 + `autoRegisterUid` 注册 `character_profiles`           | `src/main/scanner/path-classifier.ts` L14-23；`src/main/scanner/worker-entry.ts` L686-712/L850-867 |
| UID 隔离查询/展示                     | `listMedia` 支持 `accountUid` 过滤（走 `idx_media_files_account_uid` 索引）；图库仅放行 HQ 路径 | `src/main/database/media-repository.ts` L58-71/L505-506                                            |
| `media://` 放行                       | 协议白名单规则 2 精确放行 `thumbnail` 列路径                                                    | `src/main/app/media-protocol.ts`                                                                   |

**缺口清单（本方案修复的 5 处）**：

1. 扫描 INSERT 不含 `thumbnail` 列，新记录恒为 NULL（`src/main/scanner/worker-entry.ts` L898-929）。
2. media-worker 批量生成 SQL 为 `thumbnail IS NULL OR width IS NULL OR height IS NULL`（`src/main/media-worker/worker-entry.ts` L412-416），三条触发链（启动索引链、扫描后链式、崩溃恢复）均经此进入。
3. 主进程 `processThumbnailForRow`（`cleanupAndRepairDatabase` 修复路径）仍直调 `ctx.thumbnailGen.generate`（`src/main/services/thumbnail-phash-service.ts` L29-67）。
4. 按需生成入口 `thumbnail:generate`（`src/main/ipc/handlers/thumbnail-handler.ts`），高分屏预生成会调用（`src/renderer/components/gallery/VirtualImageGrid.tsx` L210-221）。
5. 前端 `toLowQualityUrl/toHighQualityUrl` 按缓存命名规则推导 `_low/_high.jpg`（VirtualImageGrid.tsx L141-160），对原生路径会推导出 404。

## 依赖声明

- **不新增任何 npm 依赖、不新增数据库表/列、不改 IPC 契约**；仅复用既有 `thumbnail` 列、`account_uid` 索引、`repair-legacy-data-v*` 幂等迁移模式与 `path-classifier` 纯函数。
- 复用内部模块：`src/main/scanner/path-classifier.ts`、`src/main/scanner/uid-discovery.ts`、`src/main/thumbnail/generator.ts`、`src/main/scanner/repair-legacy-data-v5.ts`（迁移结构模板）。
- 开发环境：Node 版本见 `.node-version`；安装 `npm ci`（锁版本，勿用 `npm install`）。

## 启动说明

```powershell
# 工作目录：h:\45001\Documents\WXNN XiangCe2（PowerShell 用 ; 分隔命令）
npm ci ; npm run dev          # 启动开发环境验证
npx vitest run src/main/scanner/path-classifier.test.ts   # 按步骤逐个验证
npm run typecheck             # 全量类型检查（最后一步）
```

## 子任务分解（每步验证通过后再进入下一步）

### 子任务 1：路径分类纯函数（地基）

- **修改文件**：`src/main/scanner/path-classifier.ts`、`src/main/scanner/path-classifier.test.ts`
- **输入**：文件绝对路径字符串。**输出**：`isGamePlayPhotosPath(p): boolean`；`resolveNativeThumbnailPath(hqPath): string | null`。
- **实现要点**：
  - `isGamePlayPhotosPath`：沿用 `extractMediaSourceFromPath` 的归一化口径——`replace(/\//g,'\\').toLowerCase()` 后判断含 `\\gameplayphotos\\`。
  - `resolveNativeThumbnailPath`：归一化后仅当路径含 `\\gameplayphotos\\` 且含 `\\nikkiphotos_highquality\\` 时，将目录段 `nikkiphotos_highquality` 按**原始大小写**替换为同形 `NikkiPhotos_LowQuality`（用正则定位索引区间做子串替换，保留原路径其余部分的大小写与分隔符），其余返回 `null`。
- **验收标准**：`npx vitest run src/main/scanner/path-classifier.test.ts` 全部通过。

### 子任务 2：扫描入库直接关联原生缩略图

- **修改文件**：`src/main/scanner/worker-protocol.ts`（`MediaFile` 类型）、`src/main/scanner/worker-entry.ts`
- **输入**：扫描到的每个图片条目。**输出**：`media_files.thumbnail` 列 = 原生 LQ 路径（或保持 `undefined`）。
- **实现要点**：
  - `MediaFile` 增加可选字段 `thumbnail?: string`。
  - `scanDirectory` 图片分支：调用 `resolveNativeThumbnailPath(fullPath)`；非空时用 `fsp.access(lqPath, fs.constants.R_OK)` 校验可读，通过才填入 `thumbnail`，否则保持 `undefined`（前端已有 `file.thumbnail || file.file_path` 原图兜底）。视频分支不填（原生目录无视频缩略图）。
  - `saveBatchToDatabase`：INSERT 列表追加 `thumbnail`；`ON CONFLICT DO UPDATE` 追加 `thumbnail = COALESCE(excluded.thumbnail, media_files.thumbnail)` —— 原生文件缺失时不清空既有值，非游戏路径 `excluded.thumbnail` 恒为 NULL、行为不变。
- **验收标准**：相关单测全部通过；`npm run typecheck` 无新增错误。

### 子任务 3：缩略图生成三入口豁免

- **修改文件**：
  1. `src/main/media-worker/worker-entry.ts` L412-416：批量查询追加归一化排除条件——`AND LOWER(REPLACE(file_path,'\','/')) NOT LIKE '%/gameplayphotos/%'`（口径与 `src/main/database/media-repository.ts` L81 `NORMALIZED_PATH_EXPR` 完全一致）。一处改动同时豁免启动链、扫描后链、崩溃恢复三条触发路径。
  2. `src/main/thumbnail/generator.ts` 的 `generate()` 入口：`isGamePlayPhotosPath(filePath)` 为真时早退——返回 `resolveNativeThumbnailPath(filePath) ?? filePath`，**不做任何解码/写盘**。此单点同时覆盖 `thumbnail:generate` IPC（handler 不改）与主进程 `processThumbnailForRow` 修复路径。
- **输入/输出**：批量入口输入为 `media_files` 行；生成器入口输入为文件路径。输出：GamePlayPhotos 记录永不进入生成队列；按需调用返回原生路径且缓存目录零新增文件。
- **验收标准**：对应单测全部通过。

### 子任务 4：前端缩略图推导守卫

- **修改文件**：`src/renderer/components/gallery/VirtualImageGrid.tsx` L141-160
- **输入**：`thumbnail` 字符串。**输出**：缓存产物仍推导 `_low/_high`；原生路径返回 `null`。
- **实现要点**：`toLowQualityUrl`/`toHighQualityUrl` 前置守卫——`thumbnail` 归一化后含 `nikkiphotos_lowquality` 或 `nikkiphotos_highquality` 即返回 `null`（走 `standardUrl` 直接显示原生文件）。不动 `onError` 降级链。
- **验收标准**：组件测试通过；不引入 lint 错误。

### 子任务 5：存量数据幂等迁移 V6

- **新建文件**：`src/main/scanner/repair-legacy-data-v6.ts`（严格仿照 `src/main/scanner/repair-legacy-data-v5.ts` 结构）；接线点 `src/main/scanner/worker-entry.ts` L1066 之后（`repairOk` 链）。
- **输入**：存量 `media_files` 中 `thumbnail IS NULL`（或指向 thumbnails 缓存）且路径命中 `%/gameplayphotos/%/nikkiphotos_highquality/%` 的行。**输出**：`thumbnail` 回填为同名 LQ 路径（逐行 `fs.existsSync` 校验，缺失跳过）。
- **幂等性**：`schema_migrations` 标记 `repair_legacy_data_v6`，已应用直接返回 `true`。
- **验收标准**：迁移单测全部通过。

### 子任务 6：全量验证与文档落地

- **执行**：`npx vitest run src/main/scanner src/main/media-worker src/main/database src/renderer/components/gallery` → `npm run lint` → `npm run typecheck`；把计划写入 `docs/plans/gameplayphotos-native-thumbnail.md`。
- **手动冒烟**（开发环境）：指向含 ≥2 个数字 UID 文件夹的 `GamePlayPhotos` 目录执行全量扫描 → ① 图库按账号档案分别展示各 UID 资源且互相隔离；② 网格缩略图正常显示（加载的是 `media://` 原生 LQ 文件）；③ `userData/thumbnails` 目录**无**该批文件的新增缓存；④ 日志无缩略图生成该批文件的记录。
- **验收标准**：全部命令零错误 + 冒烟四项全部通过。

## 依赖关系

```
子任务1（纯函数）─┬─→ 子任务2（扫描入库）─→ 子任务5（V6 迁移，复用推导函数与列语义）
                  ├─→ 子任务3（生成入口豁免）
                  └─→ 子任务4（前端守卫，仅依赖"thumbnail 可为原生路径"的约定）
子任务2/3/4/5 全部完成 ─→ 子任务6（全量验证 + 文档）
```

子任务 2、3、4 互相独立，可并行实施。

## 参数校验

- `isGamePlayPhotosPath` / `resolveNativeThumbnailPath`：均须容忍 `''`、`null/undefined`（入参类型收窄为 `string`，空串直接返回 `false`/`null`，**不抛异常**）。
- 扫描入库：`resolveNativeThumbnailPath` 返回非空时，须先以 `fsp.access(lqPath, fs.constants.R_OK)` 校验 LQ 文件可读，校验不通过时 `thumbnail` 保持 `undefined`，禁止写入不可读路径。
- V6 迁移：逐行 `fs.existsSync` 校验 LQ 文件存在，缺失行跳过不回填。
- 前端推导函数：`thumbnail` 为 `undefined`/非 jpg/已含 `_low`/`_high` 后缀时维持既有返回 `null` 的规则，守卫不得改变该行为。

## 错误处理

### 各子任务错误处理要点

| 环节                                           | 处理策略                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| 子任务 2：`fsp.access` 失败（文件不存在/权限） | 静默降级为 `undefined`，仅 `workerLog('warn')` 计数，不中断扫描（与现有容错风格一致） |
| 子任务 3：SQL 排除条件                         | 走 SQL 层，无额外异常路径；`generate()` 早退分支不抛错                                |
| 子任务 5：迁移标记/主流程异常                  | 主流程异常时记录 error 并返回 `false`；标记写入失败仅 warn 不影响迁移结果（仿 v5）    |

### 错误处理与风险缓解（总表）

| 风险                             | 缓解                                                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| HQ 无同名 LQ 文件                | 入库前 `fsp.access` 校验，缺失时 `thumbnail` 置空 → 前端回退原图（既有兜底链），不触发生成（子任务 3 排除条件兜底）        |
| `ON CONFLICT` 覆盖既有缩略图     | `COALESCE(excluded.thumbnail, media_files.thumbnail)` 语义 + 回归测试                                                      |
| 排除条件误伤普通文件             | `%/gameplayphotos/%` 为高度专属路径段；正/反斜杠、大小写变体均有单测                                                       |
| 前端 `_low/_high` 推导 404       | 子任务 4 守卫先行 + `onError` 原图降级为第二道防线                                                                         |
| HQ 图片 `width/height` 保持 NULL | 接受现状：网格布局对缺尺寸项已有异步自适应；如需精确尺寸可后续用 `sharp().metadata()` 轻量补读（本期不做，避免扩大改动面） |
| GamePlayPhotos 内视频无缩略图    | 需求内预期行为；渲染层已有无缩略图视频的占位降级                                                                           |
| 存量已生成缓存残留               | 不清理（避免扩大范围），文档注明可选清理项                                                                                 |

## 基础测试用例

按子任务列出已实现的测试文件与实际用例要点。

### 子任务 1：`src/main/scanner/path-classifier.test.ts`

- `isGamePlayPhotosPath`：
  1. 反斜杠/正斜杠 GamePlayPhotos 路径 → `true`。
  2. 大小写不敏感（全小写、全大写、混合大小写均命中）。
  3. 非游戏拍照路径（普通相册、`X6Game/ScreenShot`、`CloudPhotos`）→ `false`。
  4. 路径仅含 `GamePlayPhotos` 但无尾部分隔符 → `false`。
  5. 空字符串 → `false` 且不抛异常。
- `resolveNativeThumbnailPath`：
  1. 反斜杠/正斜杠 HQ 路径 → 返回同名 LowQuality 路径，其余部分（大小写、分隔符）原样保留。
  2. 非 HQ 目录段（`Collage`、LowQuality 自身防自指、`X6Game/ScreenShot`）→ `null`。
  3. 非 `gameplayphotos` 路径与空串 → `null`（空串不抛异常）。
  4. HQ 目录段大小写异常时仍可定位，替换段用标准拼写 `NikkiPhotos_LowQuality` 且保留原分隔符。
  5. 混合分隔符路径：替换段前后分隔符各自按原位置形态保留。

### 子任务 2：`src/main/scanner/__tests__/worker-entry.native-thumbnail.test.ts`

- 以 parentPort 桩 + `Module._load` 拦截 better-sqlite3 驱动真实 `SCAN_START` 全链路扫描（临时目录 fixture）：
  1. HQ 图片 + 存在同名 LQ 文件 → 入库行 `thumbnail` = LQ 路径。
  2. LQ 缺失 → `thumbnail` 为 NULL，仅记 `warn` 日志（含缺失路径）、扫描仍成功完成。
  3. 非游戏路径 → `thumbnail` 为 NULL（回归）。
  4. LQ 目录自身的文件不推导缩略图（避免自指）。
  5. INSERT SQL 结构防回归：列列表与 VALUES 含 `thumbnail`，且含 `COALESCE(excluded.thumbnail, media_files.thumbnail)`。

### 子任务 3：`src/main/media-worker/worker-entry.test.ts` 与 `src/main/thumbnail/generator.test.ts`

- media-worker 批量豁免（fake DB 模式）：构造 3 行（普通图片 / GamePlayPhotos HQ 图片 / GamePlayPhotos 视频，且 `thumbnail/width/height` 均为 NULL）→ 批次 SELECT 追加归一化排除条件后仅普通图片被选中；断言 SQL 含 `LOWER(REPLACE(file_path, '\', '/')) NOT LIKE '%/gameplayphotos/%'`。
- 生成器豁免（`ThumbnailGenerator GamePlayPhotos 原生缩略图豁免` 套件）：
  1. GamePlayPhotos HQ 路径 → 早退返回原生 LQ 路径，零解码/零写盘（spy 断言底层函数未被调用）。
  2. GamePlayPhotos 非 HQ 路径（视频子目录）→ 早退返回原路径兜底。
  3. 正斜杠形态的 HQ 路径同样命中豁免（大小写不敏感）。
  4. 回归：普通路径仍走原生成逻辑（图片经 sharp 解码产出缓存路径）。

### 子任务 4：`src/renderer/components/gallery/VirtualImageGrid.thumb.test.tsx`

- `toLowQualityUrl` 守卫：原生路径（反斜杠 / 正斜杠 + 目录名大小写混合）→ `null`，不推导 `_low` 缓存名；回归：应用缓存路径仍正常推导 `_low.jpg`。
- `toHighQualityUrl` 守卫：HighQuality 反斜杠、LowQuality 正斜杠混合大小写 → `null`；回归：缓存路径正常推导 `_high.jpg`。
- 既有规则保留：已含 `_low/_high` 后缀、非 jpg、`undefined` 输入仍返回 `null`。
- 视频缩略图裂图防护（同文件既有结构性检查）：视频类型不再以 `file.file_path` 作为 `<img>` 源，图片类型保留 `file_path` 回退。

### 子任务 5：`src/main/scanner/repair-legacy-data-v6.test.ts`

- in-memory better-sqlite3（仿 v5 测试）：
  1. 存量 HQ 行 + 同名 LQ 存在 → 回填为 LQ 路径。
  2. LQ 缺失 → 不回填（仍写迁移标记，返回 `true`）。
  3. 幂等：重复执行第二次直接跳过（迁移标记早退）。
  4. 非游戏路径行不受影响（无 UPDATE）。
  5. `thumbnail` 指向生成缩略图目录（`%thumbnails%`）的 HQ 行同样回填。
  6. `schema_migrations` 缺失降级：主流程仍执行，标记失败仅 warn。
  7. 主流程异常时记录 error 且返回 `false`。
  8. 标记迁移 INSERT 失败仅 warn 且仍返回 `true`。

## 验证纪律（执行约束）

- 每段子任务完成后：跑该任务对应测试 → 通过即进入下一步；失败当场修复后重跑，不积压。
- 每段代码**最多审查一次**，审查必须指出具体检查项（如"子任务 3 SQL 排除条件是否覆盖反斜杠路径"）；无严重缺陷即视为通过，禁止以模糊理由重复验证同一产出。
- 不改动缺口清单以外的任何功能（尤其不动 `GALLERY_PATH_CONDITION`、`ALBUM_TYPE_MAP`、LQ 目录独立入库现状）。

## 假设与边界

- UID 长度沿用现有约定 `^\d{6,12}$`（与上游 nikki_albums 一致）。若实际出现超出该位数的 UID，属独立问题，另行评估放宽正则（会影响 `character_profiles` 与既有分类），本期不做。
- `NikkiPhotos_LowQuality` 文件继续按现状作为独立媒体行入库（`album_type='低质量照片'`，图库视图不展示）；"不重复存储缩略图"指**不再生成并存储缓存副本**，不改变既有索引行为。

## Rejected Alternatives

1. **停止索引 `NikkiPhotos_LowQuality` 目录（Sam 方案）**：可将行数减半、pHash 负载减半，但会改变存量 `album_type` 映射与导入向导 `applyFilters=false` 行为，需要额外的存量行清理迁移与产品决策，违反"不改动无关功能"约束 → 否决。
2. **批量查询保留命中、仅对已填 `thumbnail` 行做 `sharp().metadata()` 补尺寸（Sam 方案）**：可补齐 `width/height`，但引入条件分支与尺寸补写逻辑，且每轮批次重复选中这些行；本期以最小改动为先 → 否决，列为后续可选优化。
3. **新增 `is_gallery_hq` 布尔索引列替代路径 LIKE 过滤**：性能更优但属表结构变更，与本需求无关 → 否决，记入技术债清单。
4. **在 `thumbnail-handler.ts` 单独加豁免**：生成器入口早退已覆盖该 IPC 与主进程修复路径两处，handler 层重复加判断属冗余 → 否决。

## 实施记录（2026-08-25）

以下为已完成实施情况的如实记录。

### 子任务 1 / 2 / 5：扫描器改造（已完成）

- **涉及文件**：`src/main/scanner/path-classifier.ts`、`src/main/scanner/worker-protocol.ts`、`src/main/scanner/worker-entry.ts`、`src/main/scanner/repair-legacy-data-v6.ts`。
- **对应测试**：`src/main/scanner/path-classifier.test.ts`、`src/main/scanner/__tests__/worker-entry.native-thumbnail.test.ts`、`src/main/scanner/repair-legacy-data-v6.test.ts`。
- 完成内容：新增 `isGamePlayPhotosPath` / `resolveNativeThumbnailPath` 纯函数；`MediaFile` 类型增加 `thumbnail` 可选字段；扫描入库时对 HQ 图片经可读性校验后直填原生 LQ 路径，`ON CONFLICT` 采用 `COALESCE` 语义；新建幂等迁移 `repair-legacy-data-v6.ts` 对存量行回填并接线 `repairOk` 链。

### 子任务 3：缩略图生成入口豁免（已完成）

- **涉及文件**：`src/main/media-worker/worker-entry.ts`、`src/main/thumbnail/generator.ts`。
- **对应测试**：`src/main/media-worker/worker-entry.test.ts`、`src/main/thumbnail/generator.test.ts`。
- 完成内容：媒体工作线程批量查询追加归一化排除条件，一次性豁免启动链、扫描后链、崩溃恢复三条触发路径；`ThumbnailGenerator.generate()` 对 GamePlayPhotos 路径早退返回原生路径，单点覆盖 `thumbnail:generate` IPC 与主进程修复路径，零解码零写盘。

### 子任务 4：前端缩略图推导守卫（已完成）

- **涉及文件**：`src/renderer/components/gallery/VirtualImageGrid.tsx`。
- **对应测试**：`src/renderer/components/gallery/VirtualImageGrid.thumb.test.tsx`。
- 完成内容：`toLowQualityUrl` / `toHighQualityUrl` 前置守卫，原生 `NikkiPhotos_LowQuality` / `NikkiPhotos_HighQuality` 路径返回 `null`（走 `standardUrl` 显示原生文件），缓存命名推导规则与 `onError` 降级链保持不变。

### 验证命令

```powershell
npx vitest run      # 全量单元测试
npm run typecheck   # 全量类型检查
npx eslint          # 代码规范检查
```
