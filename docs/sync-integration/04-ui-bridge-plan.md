# 阶段 4：图库数据层切换 NikkiSync Runtime 计划（04-ui-bridge-plan）

> 路径作用域：本文为阶段计划/审计报告快照，文中 `src/xxx`、`scripts/xxx` 形式的路径混指本仓与上游 NikkiSync 仓；属上游或当时设计未落地的项按原文保留、不覆写，读者请勿默认它们能在本仓解析。

> 生成日期：2026-10-14
> 范围：把 **渲染层图库的数据源** 从 WXNN XiangCe 自有 `media_files` 切换到内嵌 NikkiSync Runtime
> 的 Asset/Resource；UI 组件、交互与视觉**保持不变**，只换数据层。
> 唯一真相源：本文件（`WXNN XiangCe/docs/sync-integration/`）。上游依据见
> [`02-runtime-embed-plan.md`](./02-runtime-embed-plan.md)（阶段 2 内嵌 + 只读查询面）与
> [`03-sync-server-plan.md`](./03-sync-server-plan.md)（阶段 3 服务面）。
> 编号说明：同目录本就并存两条编号线（`01-dependency-link` vs `01-protocol-port`、
> `04-http-server` 属移植面线），本文件属**内嵌线**，文件名不冲突。
> 铁律：**主进程侧零字段转换**；IPC handler 直接调用 NikkiSync 仓储并原样返回；
> 转换只允许发生在渲染层 store 的一处；**不改 NikkiSync 源码**。

---

## 0. 步骤 0 执行记录（代码同步取证，已完成）

| 动作         | 结果（现场命令与原始输出）                                                                                                                                                                                                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 探查引入方式 | `find . -maxdepth 3 -name .git` → 工作树根**不是**仓库；`NikkiSync/`、`WXNN XiangCe/` 各为**独立仓库**。`ls -la node_modules/@nikkisync` → 4 条 junction 指向 sibling 检出；`package.json` **不声明** `@nikkisync/*`（阶段 9 自包含决策），由 `npm run link:nikkisync` 建立                                                         |
| 确认远程     | `git -C NikkiSync remote -v` → `origin https://github.com/ToStardust/NikkiSync`（fetch/push 均对）                                                                                                                                                                                                                                  |
| 版本核验     | `git -C NikkiSync ls-remote origin refs/heads/main` = `d4ca7d7a164d44ca91dcc3e7e7604b9839296ad3`；`git -C NikkiSync rev-parse HEAD` = **同一 sha** ⇒ 已在 GitHub 最新，**跳过 fetch/checkout/pull**（执行它们只会是无操作或制造风险）                                                                                               |
| 幻影改动     | `status -sb` 报 ` M tools/sample-analyzer/analyze.mjs`，但 `hash-object` 与 `ls-files -s` 同为 `202582cd47031dfb75380e54157d2425ee8472cb` ⇒ 内容指纹一致，属 NikkiSync 无 `.gitattributes` + 本机 `core.autocrlf=true` 的行尾幻影（同阶段 2 R11）。**不 stash、不还原、不提交**                                                     |
| 建链复验     | `npx tsx scripts/link-nikkisync.ts --check` → `root=...\NikkiSync source=sibling`，四链全 `ok`，退出码 0                                                                                                                                                                                                                            |
| 产物诊断     | `npx tsx scripts/verify-nikkisync-link.ts` → **退出码 1**：9 项 ✓（依赖自包含 / 四链在位 / 四包 `dist/src/index.js`+`index.d.ts` 齐 / migrations 可读 / LocalSyncServer 与 GalleryRuntime 产物在位 / 主进程产物无 `require("@nikkisync` / electron 41.10.6 等），唯一 ✖ =「`app.asar.unpacked` 缺 @nikkisync schema」，判读见 §16.1 |
| API 核对     | 复读 6 个上游文件：`sync-read-repository.ts`、`row-mappers.ts`、`LocalSyncServer.ts`、`packages/core/src/types.ts`、`packages/protocol/src/index.ts`、`packages/database/src/index.ts` ⇒ 与阶段 2 §0.1 / 阶段 3 §11 记录一致，**无破坏性变更**                                                                                      |

### 0.1 本阶段新增的上游事实（两条会直接改变方案）

| 事实                                                                                                                                | 证据                                                                                                                                                                                                                | 后果                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 上游**从不产出**缩略图/预览资源：`derived_thumbnail`/`derived_preview` 只被**读取**，全仓（`packages`+`apps` 的 `.ts`）无任何生产者 | `grep -rn "derived_thumbnail" packages apps --include=*.ts` 仅命中 `packages/core/src/types.ts:17`（角色枚举）与 `apps/pc-companion/src/server/row-mappers.ts:133-134`；`derived_preview` 同理 `row-mappers.ts:118` | `AssetSummary.thumbnailResourceId` / `previewResourceId` 实际恒为 `undefined` ⇒ 网格缩略图**不能**依赖 NikkiSync（§7） |
| `MetadataDictionaryRepository` 从 `@nikkisync/database` **桶导出**可得                                                              | `packages/database/src/index.ts` 有 `export * from './metadata-dictionary-repository.js'`；`LocalSyncServer.ts:137,155` 即 `new MetadataDictionaryRepository(database)`                                             | 搜索/统计只需 3 个 pc-companion **函数**深入口，**不需要**新增仓储深入口                                               |
| `listChanges` 的全量重同步判据                                                                                                      | `LocalSyncServer.ts:439`：`fullResyncRequired = minimum !== undefined && after < minimum - 1`，为真时 `changes: []`                                                                                                 | 内嵌层**逐字照抄**该判据，不自造（§5、§9）                                                                             |
| 搜索/统计源由上游私有方法构造                                                                                                       | `LocalSyncServer.suitSearchSource(libraryRevision)` `:326-347`（`listSuitSearchResources` 按 `asset_id` 分组 + `listSuitSearchAssets.map → {asset: mapAssetSummary(...), metadataJson}`，带 revision 缓存）         | XiangCe 侧须复刻这 12 行「装配」，并以 linked 测试与真实上游端点逐字比对来防分叉（§5.2）                               |

### 0.2 起草时的一处误判（已按现场取证改正）

原计划在 §14 步骤 1 写「扩 `protocol-contract.ts` 符号清单 ⇒ `protocol-drift.test.ts` 先红」。**该步不成立**：

- `protocol-contract.ts` 比对的是**运行时值**（`PROTOCOL_VERSION`、`ASSET_TYPES`、`API_ROUTES.*` 等），而 `AssetSummary` / `ChangesResponse` / `SuitSearchResponse` 是 **interface，无运行时值** ⇒ 无法进符号清单（同目录 AGENTS.md 硬性约定 2 早已写明这点）。
- 新端点的路由键 `API_ROUTES.changes` / `suitSearch` / `clothingSearch` / `profileStats` **已在** `protocol-contract.ts:47-56 LITERAL_ROUTE_KEYS` 内被漂移守护覆盖，无需扩表。

因此步骤 1 的红灯改由**编译期同形断言**承担（见 §14 步骤 1 与 §14.1 的落点约束）。

### 0.3 顺手取证的两个既有隐患（本阶段不越界修，仅登记）

| 隐患                                                                                                                                                                                                   | 证据                                                                                                                                                                                                                 | 影响与处置                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/vite-env.d.ts` 内 **22 处** `import('../../shared/...')` 相对深度写错（`src/renderer` 上两级不存在 `shared/`），被 `skipLibCheck: true` 完全掩盖，那些渲染层类型今天实际静默退化为 `any` | 探针 `npx tsc --noEmit -p tsconfig.json --skipLibCheck false` → `TS2307: Cannot find module '../../shared/types/progress'` 等 22 条（`vite-env.d.ts:150,1277-1305,…`）；根 `tsconfig.json:7` 为 `skipLibCheck: true` | 属存量缺陷，修它需逐条复核 12+ 个命名空间，**超出本阶段最小改动范围**，另轮处理。本阶段新增引用一律用正确深度 `../shared/...`，并以「探针计数不增」为验收口径（§14.2） |
| 主进程测试文件**不参与**类型检查：`src/main/tsconfig.json` 的 `exclude` 含 `**/*.test.ts`；根 `tsconfig.json` 只 include `src/renderer/**` + `src/common/**`                                           | 两份 tsconfig 原文                                                                                                                                                                                                   | 类型级红灯**只能**落在 `src/renderer/**` 下的 `*.test.ts`，否则 `tsc -b` 永远看不到它。步骤 1 的守护文件因此放 `src/renderer/stores/`（§14.1）                         |

---

## 1. 依赖声明

- **不新增任何 `package.json` 依赖**。`@nikkisync/*` 仍由 `npm run link:nikkisync` 以 junction 提供，未链接是受支持的默认态（`src/main/nikkisync/AGENTS.md` 规则 6）。
- **不新增静态值/类型导入**：装载缝仍唯一入口 `runtime-loader.ts:22 NIKKISYNC_PACKAGES`；新增的 3 个 pc-companion 深入口走 `embedding-paths.ts` 的 `resolveDeepEntryUrl`，与既有 `runtime-facade.ts:89 ROW_MAPPER_DEEP_ENTRY` 同构。
- **渲染层不新增运行时依赖**；跨进程类型一律从 vendored `src/shared/sync/protocol.ts` / `domain-types.ts` 以 `import type` 取得（**禁止** `import type '@nikkisync/*'`，阶段 9 起它不是声明依赖，CI 下 TS2307）。
- 装完依赖必须重跑 `npm run link:nikkisync`，否则本阶段所有 `*.linked.test.ts` 集体降级为 skip。

---

## 2. 前端数据层改造方案

### 2.1 数据流

```
NikkiSync SyncReadRepository（上游，只读，返回 DB 原始行）
  → row-mappers.mapAssetSummary/mapAssetDetail/mapResourceRow/mapChangeRow（上游，深入口）
  → runtime-facade.createQuerySurface()        ← 扩 5 个方法，仍零转换
  → runtime-manager NikkiSyncRuntimeHandle     ← 同名薄委托（现 :232-240 同模式）
  → nikkisync-handler.ts                       ← 新增 5 条通道，原样返回上游对象
  → preload/api/nikkisync.ts                   ← 一行 call<T>()
  → mediaStore（新增 nikkisync 源）             ← 唯一的转换点：toViewModel()
  → 现有图库组件 / 详情页 / 全屏 / 筛选排序（不改）
```

`nikkisync-handler.ts:32` 铁律保持有效并用测试锁死：新通道的返回值与 stub 给出的对象**同一身份**（`toBe`），即证「IPC 未转换」。

### 2.2 为什么必须有一处转换（口径已确认）

组件消费约 25 个 snake_case 字段（`src/renderer/stores/mediaStore.ts:21-64`），而 `AssetSummary` 只有 14 个 camelCase 字段（`src/shared/sync/protocol.ts:63-80`），且**完全没有**绝对路径与收藏/评分/标签/备注/分类/套装/重复/损坏/回收站概念。故：

- **转换收敛到 `toViewModel()` 一处**（纯函数、可单测），不散落进 JSX；
- NikkiSync 侧缺失的用户编辑字段由**叠加层**补（§2.3）；
- 约 10 个图库组件与 `useFilteredMediaFiles` / `uiStore` / 既有组件测试**零改动**。

### 2.3 编辑叠加层 `asset_edits`

XiangCe 自有库新增单表（键为 NikkiSync `assetId`，非路径）：

```sql
CREATE TABLE IF NOT EXISTS asset_edits (
  asset_id      TEXT PRIMARY KEY,
  is_favorite   INTEGER NOT NULL DEFAULT 0,
  rating        INTEGER NOT NULL DEFAULT 0,
  tags          TEXT    NOT NULL DEFAULT '[]',
  notes         TEXT    NOT NULL DEFAULT '',
  category_id   INTEGER,
  outfit        TEXT,
  scene_category TEXT,
  scene_time    TEXT,
  is_hidden     INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT,
  updated_at    TEXT    NOT NULL
);
```

配一次性回填脚本 `scripts/backfill-media-edits.ts`：`media_files.file_path` 与 asset 资源 `source_path` **双侧归一化**（`path.resolve` + Windows 大小写不敏感比较）后匹配 `asset_id`，逐条输出 `matched / ambiguous / unmatched` 三档计数。

选它而不是「按 path join 现有 `media_files`」：需求要求旧源退出——若编辑字段仍查 `media_files`，渲染每帧仍依赖旧表，等于没换数据源；且两套扫描器互相独立，未入库 `media_files` 的 asset 将无处写入收藏。

---

## 3. 需修改 / 新增文件清单（完整路径，均在 `WXNN XiangCe/` 下）

### 3.1 修改（受保护路径，各替换一行 `// @core-change:`）

| 文件                                         | 改动                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `src/main/ipc/handlers/nikkisync-handler.ts` | 新增 5 条通道 + 3 个 zod schema；保持零转换（`:32` 铁律与 `:94 toAppError` 复用不动） |
| `src/main/preload/api/nikkisync.ts`          | 新增 5 个一行 `call<T>()` 方法 + 1 个 `subscribe` 事件退订                            |

### 3.2 修改（其余）

`src/main/nikkisync/runtime-types.ts`（`:169 NikkiSyncQuerySurface`、`:225 NikkiSyncRuntimeHandle` 扩 5 方法；把 `Promise<unknown>` 换真实类型）
`src/main/nikkisync/runtime-facade.ts`（`createQuerySurface` 扩方法；`SEARCH_DEEP_ENTRIES` 常量；`buildSearchSource`；`loadRuntimeSurface` 装载 3 个深入口 + `MetadataDictionaryRepository`）
`src/main/nikkisync/runtime-manager.ts`（`:444` 附近补 5 个薄委托 + `library-changed` 通知出口）
`src/main/nikkisync/runtime-loader.ts`（`NIKKISYNC_REQUIRED_EXPORTS` 增 `MetadataDictionaryRepository`）
`src/main/nikkisync/protocol-contract.ts`：**不改**（§0.2 已述由：新端点路由键已在 `LITERAL_ROUTE_KEYS:47-56` 内被守护，DTO 是 interface 无运行时符号可扩）
`src/main/app/media-protocol.ts`（`isMediaPathAllowed:254` 增第 4 条规则）
`src/main/app/media-update.ts` 或新增同层薄模块（`nikkisync:library-changed` 100ms 节流广播）
`src/main/app/ipc-setup.ts`（如事件需新窗口句柄则接线）
`src/main/database/*`（schema 迁移 + `asset-edits-repository.ts` 注册）
`src/main/preload/__tests__/preload.test.ts`（nikkisync 命名空间方法清单；键集合不变 ⇒ 键数断言不动）
`src/shared/types/electron-api.ts`（`:556 NikkiSyncAssetPageInfo` 的 `items: unknown[]` → `AssetSummary[]` 等；新增 4 个返回类型）
`src/shared/settings-keys.ts`（`RENDERER_PREF_KEYS:2-26` 追加 `gallery.dataSource`）
`src/renderer/vite-env.d.ts`（`:927-975` 同步真实类型，消除 `unknown`）
`src/renderer/stores/mediaStore.ts`（新增 nikkisync 源与 `toViewModel`；`nikkiRevision` 游标；分流）
`src/renderer/pages/GalleryPage.tsx`、`src/renderer/pages/DetailPage.tsx`（取数入口按 `gallery.dataSource` 分流，渲染分支不动）
`src/renderer/components/gallery/{CameraInfo,Photography,NikkiInfo,Outfit,Interaction}Panel.tsx`（各 2 行：取数 Hook 换成 `useAssetParams`）
`src/renderer/pages/settings/sync-sections.tsx`（新增 `gallery.dataSource` 开关行）
`src/renderer/i18n/locales/*.json`（12 个语言文件键对齐）
`docs/IPC_CONTRACT.md`（§8.1 通道表 + §8.3 事件；CI 闸门要求同批改）
`docs/sync-integration/02-runtime-embed-plan.md`（§10.4 遗留项 2「渲染层 UI 未做」收口 + 路线①进度）

### 3.3 新增

`src/main/nikkisync/resource-allowlist.ts` + `.test.ts`
`src/main/database/asset-edits-repository.ts` + `.test.ts`
`scripts/backfill-media-edits.ts` + `scripts/__tests__/backfill-media-edits.test.ts`
`src/renderer/utils/game-params-from-metadata.ts` + `.test.ts`
`src/renderer/hooks/useAssetParams.ts` + `.test.ts`
`src/renderer/stores/mediaStore.nikkisync.test.ts`、`src/renderer/stores/mediaStore.perf.test.ts`
`src/renderer/components/gallery/ListView.nikkisync.test.tsx`
`src/main/nikkisync/library-paging.linked.test.ts`

---

## 4. 启动与运行说明

```bash
# 1) 前置：建立装载缝（npm install 会剪掉，必须重跑）
npm run link:nikkisync
npm run link:nikkisync:check        # 只读复验，四链 ok
npm run verify:nikkisync            # 装载面诊断（打包态一项见 §16.1，非本阶段引入）

# 2) 开发启动并打开内嵌 Runtime（默认 false，本阶段仍走设置页开关）
NIKKI_NIKKISYNC_RUNTIME=1 npm run dev

# 3) 无 UI 的装载自检（不启服务，探针语义见 nikkisync/AGENTS.md 规则 3）
npx electron --import tsx scripts/...   # 见 02 计划 §7；linked 测试用 ELECTRON_RUN_AS_NODE=1 口径（§8.3）
```

设置页路径：**设置 → 同步**（既有 `sync-sections.tsx` 节）→ 「图库数据源」二选一 `本地库（默认）` / `NikkiSync 资产库`。切到 NikkiSync 时自动置 `nikkisync.runtimeEnabled=true` 并触发一次扫描；空库时网格显示可执行提示的空态而非白屏。

---

## 5. IPC 通道清单（完整）

命名沿用 `docs/IPC_CONTRACT.md:383`（`nikkisync:` kebab-case）。渲染层**不查** `res.success`（`call<T>()` 已剥外层），一律 `try/catch` + `IpcError`。

### 5.1 通道表

| 通道                             | 状态         | 入参 zod（位置参数）                                                                                                 | 直接转发                                                                                             | 返回（**原样**）                                         | 新深入口 |
| -------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------- |
| `nikkisync:get-assets`           | 已存在，不动 | `listSchema` `:43` `{limit 1..500 默认 100, cursor?, type?, afterRevision?, includeDeleted?}`                        | `SyncReadRepository.listAssets` + `currentRevision`（`:22`、`:15`）                                  | `CursorPage<AssetSummary>`                               | 否       |
| `nikkisync:get-asset-detail`     | 已存在，不动 | `assetIdSchema` `:56`                                                                                                | `mapAssetDetail(row, listResources(id))`（`:55`、`:59`）                                             | `AssetDetailResponse`                                    | 否       |
| `nikkisync:get-resource`         | 已存在，不动 | `resourceSchema` `:58`                                                                                               | `getResource`（`:63`）                                                                               | `MediaResource` 或 `source_path` 原值                    | 否       |
| `nikkisync:get-resource-records` | **新增**     | `z.tuple([z.object({ assetIds: z.array(assetId).min(1).max(500), mode: z.enum(['meta','path']).default('meta') })])` | 逐 id `listResources`；`meta`→`MediaResource[]`，`path`→原始 `resources.source_path`                 | `{ byAsset: Record<AssetId, MediaResource[]> }` / 路径表 | 否       |
| `nikkisync:get-changes`          | **新增**     | `z.tuple([z.object({ after: z.number().int().min(0), limit: z.number().int().min(1).max(1000).default(1000) })])`    | `listChangesAfter` `:67` + `currentRevision` `:15` + `minimumJournalRevision` `:71` + `mapChangeRow` | `ChangesResponse`（判据逐字照上游 `:439`）               | 否       |
| `nikkisync:search-suits`         | **新增**     | `z.tuple([z.object({ query: z.string().trim().min(1).max(128) })])`                                                  | `searchSuitLibrary(source, manifest, q)`（`SuitSearchIndex.ts:96`）                                  | `SuitSearchResponse`                                     | 是       |
| `nikkisync:search-clothing`      | **新增**     | 同上                                                                                                                 | `searchClothingLibrary(...)`（`ClothingSearchIndex.ts:48`）                                          | `ClothingSearchResponse`                                 | 是       |
| `nikkisync:profile-stats`        | **新增**     | `wrapHandlerNoArgs`                                                                                                  | `buildProfileStats(source, manifest, libraryRevision)`（`ProfileStatsIndex.ts:58`）                  | `ProfileStatsResponse`                                   | 是       |
| `nikkisync:library-changed`      | **新增事件** | —（`subscribe`）                                                                                                     | 主进程在 `scan()` 完成与 `scannerStatus` 跃迁时推送，100ms 节流                                      | `{ libraryRevision }`                                    | 否       |

深入口三条，与 `ROW_MAPPER_DEEP_ENTRY`（`runtime-facade.ts:89`）同构：`['server','SuitSearchIndex.js']`、`['server','ClothingSearchIndex.js']`、`['server','ProfileStatsIndex.js']`。理由同阶段 2 §0.1：这些文件不在 pc-companion 桶导出内，且包 `exports` 不覆盖子路径 ⇒ 必须 `file://` URL 装载。

### 5.2 搜索源的装配与防分叉

`buildSearchSource(revision)` 复刻上游 `LocalSyncServer.suitSearchSource`（`:326-347`）的 12 行装配：`listSuitSearchResources()` 按 `asset_id` 分组 → `listSuitSearchAssets().map(row => ({ asset: mapAssetSummary(row, grouped ?? []), metadataJson: String(row.metadata_json) }))`，并按 `libraryRevision` 缓存。

**否决**两个偷懒方案：① 回环调用上游 HTTPS（需配对 token + 请求签名 + TLS pin，且 `syncServerEnabled` 默认关）；② 在 XiangCe 侧自写搜索算法（分叉上游语义）。防分叉证据 = `library-paging.linked.test.ts` 里把本地 `searchSuits` 结果与真实上游 `/v1/search/suits` 响应**逐字比对**。

### 5.3 上游能力缺口（不伪造）

`AssetPageQuery`（上游 `sync-read-repository.ts:3`）只有 `limit / cursorTime / cursorAssetId / assetType / afterRevision / includeDeleted` 六键 ⇒ **无 `uid`、无 `state`、无文本过滤**。档案（UID）筛选与搜索关键字只能在渲染层对已取条目做客户端过滤，翻页可能显得稀疏。不 fork 上游 SQL 补条件，登记为已知限制（§16.2）。

---

## 6. 参数校验（硬性约定 1）

- 全部新通道走 `wrapHandlerRaw` + `z.tuple([...])`，校验失败由 `wrapHandler` 归一 `VALIDATION_ERROR`，消息汇总 `[path] message`。
- 边界取自上游，不放宽：`limit` 1..500（同上游 `listAssets`）、`assetIds` 1..500（防单请求放大 N 次查询）、`after` ≥0、`query` 1..128（`.trim()` 后判空，`'   '` 必须被拒）、`mode` 枚举、`resourceId/assetId` 沿用 `:56` 的 1..128。
- `type` 继续用 `isAssetType` 白名单（`nikkisync-handler.ts:50`），不接受未知角色串。
- 路径类返回值（`mode:'path'`）**只读**，不写、不建目录；文件读取授权统一由 `media://` 判定（§7），handler 不做二次放行。

---

## 7. 资源文件访问与 `media://` 安全（含缩略图）

### 7.1 缩略图来源（口径已确认）

上游无 `derived_thumbnail`（§0.1）⇒ 网格缩略图**复用 XiangCe 现有 ThumbnailGenerator**（`src/main/thumbnail/`，已带 LRU、并发信号量、视频抽帧、损坏降级）对 asset 的 `source_path` 生成；生成的缩略图路径继续经 §7.2 规则 1（缩略图缓存目录）天然放行，无需新增授权。`thumbnailResourceId` 若将来上游产出则优先使用。

### 7.2 展示授权：`isMediaPathAllowed` 增第 4 条规则

新增纯模块 `src/main/nikkisync/resource-allowlist.ts`：维护「归一化路径 → `{assetId, revision}`」映射 + 与 `mediaPathCache` 同策略的 LRU/TTL；由 `createQuerySurface` 的批量路径查询与 `get-resource-records` 填充。`isMediaPathAllowed`（`media-protocol.ts:254`）在既有 3 条规则后查询它。

硬约束（不得回退既有安全语义）：

1. 判定必须发生在 `resolveRealPath` **之后**（延续 `:251` 记录的 A-S2/C-F5 修复：防符号链接伪装）；
2. 仍必须过 `MEDIA_EXTENSIONS` 扩展名白名单；
3. `libraryRevision` 变化或 `runtime.stop()` 时清空；Runtime 状态非 `running` 一律**拒绝**；
4. 复用 `media://` 既有 Range/206/416 与 ETag（`media-protocol.ts:84`），与上游 `streamResource:509` 语义一致 ⇒ 视频与实况的静图/视频两条资源走同一通道，无需新增协议。

**否决**：`nikkisync://` 需同步修改 `navigation-guard.isAppDocumentUrl` 与 `preload/origin-guard.ts` 两层互相镜像的放行集合（安全面双改、收益为零，且要重写 Range/ETag）；字节走 IPC 丢 Range 与 HTTP 缓存，500 条/页时是明显瓶颈。

---

## 8. 元数据展示与实况照片

### 8.1 面板取数改造

5 个游戏参数面板当前**不读库**，而是 `file.file_type === 'image' && !!file.album_type` 门禁下调用 `useGameParams(file.file_path, file.album_type, file.account_uid)` → `electronAPI.decrypt.decodeFile`（`src/renderer/hooks/useGameParams.ts:95`，koffi + `nuan5_decryption.dll`）**实时解密**。

- 新增纯函数 `src/renderer/utils/game-params-from-metadata.ts`：`AssetDetailResponse.metadata`（`InfinityPhotoMetadata`，`src/shared/sync/domain-types.ts:64-118`：`camera/filter/lighting/dressing{clothes?,eureka?}/photography/nikki/interactions?/location?/raw?`）→ 既有 `GameParamsData` 形状。
- 新增 `src/renderer/hooks/useAssetParams.ts`：`hasMetadata` 且映射结果非空 ⇒ **直接用 metadata，不重新解析 EXIF**；否则回落 `useGameParams`。
- 回落不可省：上游扫描只写 `identity/raw` 等骨架，富字段依赖远端 resolver 流水线（默认关、约 1 req/s），且 `publicMetadata`（`row-mappers.ts:19-31`）会剥掉 `nativeParamPayload` ⇒ 不是「有 metadata 就一定有穿搭」。
- 面板自身 JSX 与字段访问**不动**（每文件仅换 2 行取数）；`account_uid`/`album_type` 由 view-model 合成（`metadata.identity.uid` / 是否 `source_high_quality` ⇒ `HQ`/`LQ`），使既有门禁表达式无需改写。
- `useExif` / `ExifPanel` 保持现状（EXIF 不在 DTO 内）。

### 8.2 实况照片（motion_photo）

渲染层今天**零**实况支持（`hasMotion`/`motion_photo` 只出现在 `src/shared/sync/*`、`src/main/database/sync-*`、`src/main/nikkisync/*`）。本阶段只做最小呈现：卡片角标 + 详情/全屏内静图与视频并显，取数用 `NikkiAsset.motion`（`domain-types.ts:51-63`：`stillResourceId` / `motionResourceId`），两条资源都是普通 resource ⇒ 同一授权与 Range 路径；视频复用现有 `VideoPlayer`。不新建视图。

### 8.3 linked 测试运行口径

`@nikkisync/*` 图含 top-level await 且 `better-sqlite3` 是 Electron ABI ⇒ 真链路测试须 `ELECTRON_RUN_AS_NODE=1 electron --import tsx …`（先例：`scripts/sync-e2e/launch-server.ts` 与其在 `scripts/AGENTS.md` 的记录）。plain Node 22（CI 钉版）下这些用例会 skip-gate，不会真验。

---

## 9. 增量更新

`mediaStore` 新增 `nikkiRevision: number | null`。**注意**：它与既有 `mediaCursor: {sortValue,id}`（`mediaStore.ts:465` 用于 `media.list`）是两套游标，切到 NikkiSync 源后游标是上游 base64url `{t,id}` 字符串（`runtime-facade.ts:113 encodePageCursor`/`:118 decodePageCursor`），两者不得混用。

- 主进程在 `scan()` 返回与 `scannerStatus` 跃迁时推 `nikkisync:library-changed`（100ms 节流，复用 `src/main/app/media-update.ts` 的广播形态）。
- store 收到 ⇒ `get-changes({after: nikkiRevision})`；`fullResyncRequired === true` ⇒ 重置游标重取首页；否则按 `assetId` 定点补 detail 并原位替换。
- 仅当 `runtime-status().state === 'scanning'` 期间附 30s 轮询兜 watcher 变更（上游 `ScannerConfig.watcher`）。

**否决** WS 转发：上游 `WS /ws/v1` 需 LAN 服务 + 设备配对签名，而 `syncServerEnabled` 默认关闭（阶段 3 §15.3 还因上游 mDNS 自环泛洪把它默认关），把它变成图库刷新的必经依赖会引入无谓的启停与端口面。

---

## 10. 双数据源过渡与旧源移除时间线

- 设置键 `gallery.dataSource: 'local' | 'nikkisync'`，**默认 `local`**；追加进 `src/shared/settings-keys.ts:2-26` 的 `RENDERER_PREF_KEYS`（否则 `settings-handler.ts:108` 拒写）。开关落在既有 `pages/settings/sync-sections.tsx`，不新增页面/组件。
- 迁移期两源并存：`local` 走 `mediaStore.fetchMediaFromDatabase`（`:274`）原样不动；`nikkisync` 走新分支。去重/相似/损坏标记等 `media_files` 专有能力在 `nikkisync` 源下降级为不生效，并在筛选栏明示（§16.2）。
- **移除 `media_files` 数据源的条件**（三条同时满足才动，本阶段**不删**）：① 连续两个版本 runtime 扫描覆盖全部导入根；② `scripts/backfill-media-edits.ts` 报告 `unmatched = 0`；③ `media_files` 的读路径已收缩到扫描器/缩略图内部（不再有渲染层直查）。届时按 `02-runtime-embed-plan.md:155` 路线①收口，并另起阶段处理路线②③④⑤。

---

## 11. 错误处理（硬性约定 2）

- handler 只用 `AppError` 家族，复用既有 `toAppError`（`nikkisync-handler.ts:94`）：`not found` → `NOT_FOUND`；`not ready | unavailable | must be started | not running` → `PRECONDITION_FAILED`；其余 `INTERNAL_ERROR` 并保留原因。runtime 未装配 → `requireRuntime` 抛 `PRECONDITION_FAILED`，**不是白屏**。
- 装载类失败（junction 被 `npm install` 剪断、上游 `dist` 陈旧）→ `PRECONDITION_FAILED`，渲染层空态卡片给可执行提示（`npm run link:nikkisync` + 在 NikkiSync 内 `npm run build`），不静默显示空网格。
- 渲染层：`try/catch` + `err instanceof window.IpcError`，文案经 `extractUserMessage` / `useErrorToast`；分页失败保留已取条目，不整页清空。
- 主进程文案保持英文（`src/**` 中文硬编码护栏为 error），本地化由渲染层 i18n 承担（同 `02` 计划 §5 口径）。
- `resource-allowlist` 拒绝路径不写日志文件、不回显绝对路径（沿用 `maskPath` 口径）。

---

## 12. 加载状态

- 复用 store 既有 `isLoading` / `hasMore` 语义；新增 `sourceStatus`（`'local' | 'nikkisync' | 'degraded'`）供空态与错误态文案分支。
- 首屏：取 runtime-status（非阻塞）+ 首页 `get-assets`（`limit` 用 `MEDIA_PAGE_SIZE=500` 同界）→ 批量 `get-resource-records(mode:'path')` → 缩略图走既有 `useOnDemandThumbnails` 按需生成（不在首帧批量生成，避免 500 条并发打爆 IO）。
- 翻页：`nextCursor` 为空即 `hasMore=false`；游标非法（`decodePageCursor` 抛）→ 重置为首页并 toast。
- 切换数据源：先清列表与两套游标再取数，避免 `local`/`nikkisync` 的 id 命名空间混在同一屏。

---

## 13. 验收标准（逐条可判定）

| #   | 标准                                                                         | 判定方式                                                                                                                              |
| --- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 图库在 `gallery.dataSource=nikkisync` 下从 Runtime 加载并展示 Asset 列表     | 手动：切开关后有卡片；`mediaStore.nikkisync.test.ts` 断言 `getAssets` 被调且列表非空                                                  |
| 2   | 列表项显示缩略图、类型标识（照片/视频/实况）、拍摄时间                       | `ListView.nikkisync.test.tsx` 断言 `created_at`/宽高/`file_size` 落地、`src` 含静图路径                                               |
| 3   | 详情页展示完整 Asset（全部 Resource、metadata、motion）                      | 手动 + `DetailPage` 现有测试零改动仍绿；`get-asset-detail` 身份断言                                                                   |
| 4   | 图片/视频正常加载预览；实况并显静图与视频                                    | 手动 `npm run dev`（Runtime ON）                                                                                                      |
| 5   | 分页正常、大数据量不卡顿                                                     | `mediaStore.perf.test.ts`：1500 条 ⇒ 恰好 3 次 IPC、无重复 id、`toViewModel` < 150ms；`library-paging.linked.test.ts` 1200 行真库翻页 |
| 6   | 扫描触发后图库自动更新                                                       | `get-changes` 单测 + 手动：扫描完成后卡片数变化，无需手动刷新                                                                         |
| 7   | 元数据（相机/穿搭/滤镜/灯光/位置）正确展示，有 metadata 时不重新解密         | `game-params-from-metadata.test.ts` 用 `raw.nuan5` fixture 断言字段；缺字段时回落路径有测试                                           |
| 8   | 类型检查通过、无 `any`/`unknown` 逃逸                                        | `npm run typecheck` 0 error；`electron-api.ts:556` 的 `items: unknown[]` 被替换为 `AssetSummary[]`；`grep` 新增文件无 `: any`         |
| 9   | IPC 零转换（本阶段铁律）                                                     | `nikkisync-handler.test.ts` 对 5 条新通道断言返回值与 stub 对象 `toBe` 恒等                                                           |
| 10  | 门禁全绿：`typecheck` + `lint` + `i18n:guard` + `npm test` + `test:coverage` | 见 §14 取码口径                                                                                                                       |
| 11  | `media://` 未就绪/越权路径一律拒绝，符号链接逃逸被拒                         | `resource-allowlist.test.ts` + `media-protocol.test.ts` 五类用例                                                                      |
| 12  | `local` 源行为与改动前一致（回归零破坏）                                     | 现有 `mediaStore.test.ts` / 图库组件测试全部原样通过                                                                                  |

---

## 14. 测试用例与分步放行（红灯 → 绿灯）

每一步：**先写会精确失败的测试 → 取红灯证据 → 实现 → 重跑变绿 → `npm run verify` 通过 → 才进下一步**。新增回归测试若在改动前就通过，视为无效，重写。

| 步  | 红灯（先写）                                                                                                                                                                                                                           | 绿灯（后改）                                                                                                                        | 验证                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | `src/renderer/stores/nikkisyncContractTypes.test.ts` 编译期同形断言 ⇒ `tsc -b` 红（16 条：TS2305/TS2724 缺符号 + TS2344 `Exact<...>=false`）                                                                                           | `src/shared/types/electron-api.ts` 以 `import type` 指向 `../sync/protocol`；`vite-env.d.ts` nikkisync 块用正确深度 `../shared/...` | `npx tsc -b` 0 错误、`npx vitest run src/renderer/stores/nikkisyncContractTypes.test.ts` 2 passed、`npm run verify` 全 ✓ |
| 2   | `runtime-facade.test.ts` 断言 `listChanges/listResourceRecords/searchSuits/searchClothing/profileStats` ⇒ 方法不存在而红                                                                                                               | `runtime-facade.ts` + `runtime-types.ts:169/225` + `runtime-manager.ts` + `runtime-loader.ts`                                       | `npx vitest run src/main/nikkisync`                                                                                      |
| 3   | `nikkisync-handler.test.ts` 用 `createRuntimeStub()`（`:62`）加 5 通道用例，断言 `toBe` 恒等 + zod 拒绝（`limit:0`、`assetIds:[]`、`query:'  '`）                                                                                      | `nikkisync-handler.ts`（替换 `@core-change`）                                                                                       | `npx vitest run src/main/ipc/handlers/nikkisync-handler.test.ts`                                                         |
| 4   | `preload.test.ts` 补 5 个方法名 ⇒ 红                                                                                                                                                                                                   | `preload/api/nikkisync.ts`                                                                                                          | `npx vitest run src/main/preload`                                                                                        |
| 5   | —                                                                                                                                                                                                                                      | **同批**改 `docs/IPC_CONTRACT.md` §8.1/§8.3（CI `build.yml:76-102` 对 handler/preload 改动而契约未改即失败）                        | `npm run verify`（含 `core-gate`）                                                                                       |
| 6   | `resource-allowlist.test.ts` + `media-protocol.test.ts`：命中放行 / 同级 `.txt` 拒 / 符号链接逃逸拒 / revision 变更失效 / 未 running 拒 ⇒ 红                                                                                           | `resource-allowlist.ts` + `isMediaPathAllowed` 第 4 条规则                                                                          | `npx vitest run src/main/nikkisync src/main/app`                                                                         |
| 7   | `asset-edits-repository.test.ts` + `backfill-media-edits.test.ts`（0 匹配 / 多匹配 / 大小写与 UNC 边界）⇒ 红                                                                                                                           | 迁移 + 仓储 + 脚本                                                                                                                  | `npm run test:db`                                                                                                        |
| 8   | `game-params-from-metadata.test.ts` 用 `raw.nuan5` fixture 断言 `GameParamsData` 字段 ⇒ 红                                                                                                                                             | 纯函数 + `useAssetParams` + 5 面板 2 行替换                                                                                         | `npx vitest run src/renderer/utils src/renderer/hooks`                                                                   |
| 9   | `mediaStore.nikkisync.test.ts`（模板 `mediaStore.test.ts:60-87`）：两页按序追加、`hasMore` 由 `nextCursor`、叠加层按 `asset_id` 合并、`toFileUrl(view.file_path)` 形如 `media://file?path=<enc>`、`nikkiRevision` 随 changes 前进 ⇒ 红 | `mediaStore.ts` nikkisync 分支 + `toViewModel`                                                                                      | `npx vitest run src/renderer/stores`                                                                                     |
| 10  | `ListView.nikkisync.test.tsx`（模板 `ListView.thumb.test.tsx:102-130`）store→渲染 ⇒ 红                                                                                                                                                 | `GalleryPage.tsx` / `DetailPage.tsx` 分流                                                                                           | `npx vitest run src/renderer/components/gallery`                                                                         |
| 11  | `mediaStore.perf.test.ts`（3×500=1500，断言 3 次 IPC / 无重复 / <150ms）；`library-paging.linked.test.ts` 真库 1200 行 + 与上游 `/v1/search/suits` 逐字比对                                                                            | 按暴露问题修；linked 未建链整件 skip                                                                                                | `npx vitest run src/renderer/stores/mediaStore.perf.test.ts`；linked 用 §8.3 口径                                        |
| 12  | i18n 新键（开关标签 / 空态 / 降级提示 / 实况角标）缺 12 语言 ⇒ `i18n:guard` 红                                                                                                                                                         | `locales/*.json` 补齐                                                                                                               | `npm run i18n:guard` `npm run i18n:check`                                                                                |
| 13  | 手动验收：`npm run dev` 开开关 → 扫描 → 列表/详情/图/视频/分页/扫描后自动刷新                                                                                                                                                          | —                                                                                                                                   | 结果回填 §16                                                                                                             |

### 14.1 类型级红灯的落点约束（踩过才写下来）

`tsc -b` 能看见的测试文件只有两处：根 `tsconfig.json` 的 `include: ["src/renderer/**/*", "src/common/**/*"]`，以及 `src/main/tsconfig.json` —— 而后者的 `exclude` 明确含 `**/*.test.ts`。所以**任何「靠类型不匹配来变红」的守护必须放在 `src/renderer/**` 下**，写进 `src/main/**` 或 `src/shared/**` 都不会被检查（`src/shared` 只是作为被 import 的依赖进入 program，其自身的 `.test.ts` 不在 include 内）。

同时 `skipLibCheck: true` 使 `.d.ts` 内的错误全部静默 ⇒ 同形守护不能只写进 `vite-env.d.ts`，必须由真实 `.ts`（`electron-api.ts` + 上述测试）承担；`vite-env.d.ts` 只是消费侧的镜像。

副作用（已接受）：`npm run verify` 会就 `src/shared/types/electron-api.ts` 报一条 `[VERIFY] ⚠ 源文件未命中任何测试`，因为 `find-related-tests` 按 `<base>.test.ts` 同名匹配，而守护文件按上面的落点规则必须住在 `src/renderer/stores/`。⚠ 非阻断，且改名换址会牺牲类型检查，本阶段不做。

### 14.2 `vite-env.d.ts` 引用的验收口径

新增/修改 `src/renderer/vite-env.d.ts` 内任何 `import('...')` 类型引用后，必须跑一次：

```bash
npx tsc --noEmit -p tsconfig.json --skipLibCheck false > /tmp/tc-noskip.log 2>&1; echo $?
grep -c "vite-env.d.ts" /tmp/tc-noskip.log
```

判据是**计数不增**（存量 22 条见 §0.3，属另轮清偿）。2026-10-14 步骤 1 实测：改动前后同为 22，且 `shared/types/electron-api` / `shared/sync/protocol` 相关 TS2307 为 0 ⇒ 本阶段新增引用全部可解析。

**全量门禁（收尾一票否决）**：`npm run typecheck`、`npm run lint`、`npm run i18n:guard`、`npm test`、`npm run test:coverage`（阈值 statements 66 / branches 58 / functions 59 / lines 68，`all:true` 覆盖 `src/**`，**不得新增 exclude** —— DEBT-032 口径）。

**取码口径**（防假绿）：`cmd > /tmp/log 2>&1; echo "EXIT=$?"` 或 `${PIPESTATUS[0]}`；禁止 `gate | tail; echo $?`（管道尾命令状态）。后台任务的完成通知报的是**包装命令**的退出码，必须读旁路文件里的真实码。

---

## 15. 分支与提交

- **本阶段不改 NikkiSync**（前提已证为 `d4ca7d7` = 上游最新），因此只有 XiangCe 一侧分支：继续 `feat/gallery-runtime-embed`（当前分支）。
- **commit A（先做，与本轮分离）**：现工作树有上一轮覆盖率重基线未收口的 5 个已跟踪文件（`CHANGELOG.md`、`vitest.config.ts`、`audit-ci.jsonc`、`docs/debt-registry.json`、`docs/技术债清单.md`）+ 未跟踪 `docs/archive/plans/2026-10-14-coverage-rebaseline-and-braces-allowlist.md`，先单独成一个 docs/chore 提交。**执行前需确认**。
- **commit B…N（本轮）**，每步一提交，Conventional Commits（`commitlint`：header ≤100、subject ≤72、scope ≤24、无尾句号）：
  ① `feat(sync): 共享契约标注 nikkisync DTO 真实类型`
  ② `feat(nikkisync): 装载缝扩展 changes 与资源批量查询面`
  ③ `feat(nikkisync): 装载搜索与档案统计深入口`
  ④ `feat(ipc): 新增 nikkisync 五条查询通道与库变更事件`（同批含 preload 与 `IPC_CONTRACT`，核心路径闸门要求同批授权注释）
  ⑤ `feat(media): media:// 放行 nikkisync 资源路径`
  ⑥ `feat(db): 新增 asset_edits 编辑叠加层与回填脚本`
  ⑦ `feat(renderer): 图库接入 nikkisync 数据源`
  ⑧ `feat(renderer): 元数据面板改读 NikkiAsset metadata`
  ⑨ `feat(settings): 图库数据源开关`
  ⑩ `test(sync): 分页规模与上游搜索一致性守护`
  ⑪ `docs(sync-integration): 04-ui-bridge 执行结果与遗留项`
- 提交后 `git status --porcelain` 复核钩子（pre-commit 会 `eslint --fix` + `prettier --write` 改写并重新暂存）。

---

## 16. 已知限制与遗留项

### 16.1 `verify:nikkisync` 唯一红项（**本阶段未引入**）

`✖ packed app.asar.unpacked ships @nikkisync/database migrations`。根因是产物时间戳早于建链时间：`release/win-unpacked/resources/app.asar` 与 `NikkiGallery-Setup-2.5.5.exe` 同为 **2026-10-14 14:09**，而 `node_modules/@nikkisync/*` 四条 junction 为 **16:18** ⇒ 该次打包时链接尚不存在，`build.files` 的 `node_modules/@nikkisync/**/*` 自然无内容可拷。与 `02-runtime-embed-plan.md:23,183,218` 记录同源。
本环境无法复跑打包lane（`npx electron-builder --dir` 先报 `unable to verify the first certificate`，加 `--use-ca` 后下载 Electron 发行包 600s 超时；本机到 GitHub 仅 git 协议可达）。故该项判定为**无法验证**，不以「删除 `release/`」或放宽断言当作已修；待可行环境 `npm run dist:win` 后复验。

### 16.2 能力缺口（如实登记，不伪造）

- 无 `uid`/`state`/文本过滤下推 ⇒ 档案筛选与搜索词在渲染层做，翻页可能显稀疏。
- `is_corrupted` / `corrupted_reason` / `is_duplicate` / `original_id` 在 NikkiSync 无对应概念 ⇒ `nikkisync` 源下「仅看损坏」「重复组」等筛选不生效（筛选栏明示），回收站语义改由 `asset_edits.is_hidden/deleted_at` 承担。
- 上游 `derived_thumbnail` 缺产出 ⇒ 缩略图成本落在本仓缩略图流水线首帧之后。
- 实况（motion_photo）本阶段只做并显，不做厂商 LIVE 容器语义（上游 `LIVE_METADATA_GAP` 调查中，不得据此推断实况元数据可展示）。

### 16.3 规模与实况（本阶段未做）

- 上游端点逐字比对的 `library-paging.linked.test.ts` 未写：搜索源目前只有单元级形状断言（`runtime-facade.test.ts`）+ 真链接装载（`runtime-facade.linked.test.ts` 10 例、`sync-server.linked.test.ts` 12 例真实执行，未 skip）。CI 从不跑 `*.linked.test.ts`，因此「真机功能已验」只能靠 §14 步骤 13 的手动验收。
- `mediaStore.perf.test.ts`（3×500=1500 条、恰好 3 次 IPC、`toViewModel` 计时）未写；分页正确性由 `mediaStore.nikkisync.test.ts` 的两页续取/去重/`hasMore` 用例覆盖，规模维度暂无量化守卫。
- 实况（motion_photo）：视图模型已带 `nikkisync.motionVideoPath` / `motionVideoResourceId`，但卡片角标与详情/全屏的静图+视频并显未实现（渲染层今天零实况支持，本阶段未新建视图）。

### 16.4 元数据面板在本阶段**没有数据源**（取证结论，非"还没做"）

需求 §4 要求详情页直接展示 `InfinityPhotoMetadata` 的相机/穿搭/滤镜/灯光/位置。实测上游链路后判定：按当前内嵌接线，这份数据**根本不会被产出**。

| 取证                                                                                  | 结果                                                                                                                  |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `grep -rn "metadata_json\|metadataJson" NikkiSync/apps/pc-companion/src/scanner/*.ts` | **零命中** ⇒ 上游扫描阶段不写 `metadata_json`                                                                         |
| `Nuan5CompatibleResolver.ts:57-60`                                                    | `dressing{clothes}` / `location{coordinates}` / `photography{time}` / `raw{nuan5}` 由**解析器流水线**写入，不是扫描器 |
| `runtime.ts:20,74`                                                                    | `metadataResolver` 仅在构造配置里显式提供时才实例化                                                                   |
| `grep -c metadataResolver` on `runtime-facade.ts` / `nikkisync-runtime-setup.ts`      | **0 : 0** ⇒ 本仓建会话只传 `databaseFile`/`scanner`/`server`，从未启用解析器                                          |
| `protocol.ts` 的 `dressing.clothes?: unknown[]`                                       | 契约侧本就是 `unknown[]`，元素字段名要由解析器实现决定                                                                |

因此：嵌入态下 `AssetSummary.hasMetadata` 恒假，把面板改读 metadata 只会得到空区块。**两条可行路**，都需要单独决策，不在本阶段擅自选：

1. **启用上游解析器**（内嵌层把 `metadataResolver` 传进 `PcCompanionRuntime`）。代价：它是远端流水线（默认关、约 1 req/s、需外联），会把「本地离线可用」变成有条件；且 `publicMetadata`（`row-mappers.ts:19-31`）会剥掉 `nativeParamPayload`，富参数未必齐。
2. **继续用本 App 的实时解密**（现状）。可行前提：`decrypt:decodeFile` 走 `assertMediaReadPath`（`decrypt-handler.ts:30`）—— 命中 `media_files` 白名单才放行，否则回落 `assertFileReadPath`（PathGuard 扫描根）。所以只有当 XiangCe 自己也扫过同一游戏目录时，nikkisync 源的条目才解得出参数；否则会 `PATH_FORBIDDEN`。这与 §7.2 的 `media://` 第 4 条规则是**同一类授权缺口**，需要在 `media-read-guard` 上做对等处理。

面板自身的 JSX 与字段访问本阶段一行未动（改数据源前先定路线，避免把空态当成"已展示元数据"）。

## 17. 执行记录（2026-10-15 回填）

分支 `feat/gallery-runtime-embed`，8 个提交， NikkiSync 侧**一行未改**：

| commit    | 内容                                           | 红灯证据 → 绿灯                                                      |
| --------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| `3cdd997` | 上一轮 DEBT-032/034 闸门配置单独收口（经确认） | —                                                                    |
| `c990549` | 本计划文档                                     | —                                                                    |
| `5800968` | 桥接快照钉成协议 DTO                           | `tsc -b` 16 条（TS2305/TS2724/TS2344）→ 0 条                         |
| `a64bf6b` | 装载缝 5 方法 + 3 个搜索/统计深入口            | 12 例红 → `nikkisync` 11 文件 148 例绿（含 linked 真实执行）         |
| `dd2a326` | 5 条 IPC 通道 + preload + 契约 §8.1.1          | handler 12 例、preload 2 例红 → 96 例绿                              |
| `9b35cc5` | `media://` 第 4 条规则 + `resource-allowlist`  | 期望 200 的 3 例红 → nikkisync+app 13 文件 196 例绿                  |
| `0790252` | `asset_edits` 叠加层 + `assetEdits` 命名空间   | 两模块「Cannot find module」起步 → 新增用例全绿，全量 eslint 0 error |
| `39bd786` | 渲染层数据源切换 + `library-changed` 自动刷新  | store 8 例红 → 受影响 61 文件 803 例绿，本地源零回归                 |
| `080a8aa` | 设置页数据源开关 + 12 语言文案（3848 键对齐）  | 见下方「流程偏差」                                                   |

**全量门禁（真实退出码取自重定向旁路文件，不经管道）**：`npm run typecheck` 0 错误 · `npm run lint` 0 error（11 个存量 BOM warning，DEBT-030）· `npm run i18n:check` / `i18n:guard` 退出码 0 · `npm test` 380 文件 **5976 passed / 2 skipped**，`FULL_TEST_EXIT=0` · `npm run test:coverage` `COV_EXIT=0`，汇总 **66.87 / 58.50 / 59.46 / 68.46**（阈值 66/58/59/68，未新增 exclude）。

**流程偏差（如实登记）**：

1. `(j)(k)(l)` 三个设置页用例与 `resource-allowlist` / `assetViewModel` 两个纯函数模块，是在实现之后才补的测试，未走红灯先行（前者因中途进入 plan 模式打断，后两者首个红灯形态只是「模块不存在」）。其余步骤 1–5 与 store 均为真红灯→绿灯。
2. §14 步骤 1 原写「扩 `protocol-contract.ts` 符号清单使漂移守护先红」，经取证不成立（interface 无运行时值，且新端点路由键已被 `LITERAL_ROUTE_KEYS` 覆盖），已按 §0.2 改正。
3. §3.3 规划的 `scripts/backfill-media-edits.ts` 未落地为脚本：`better-sqlite3` 是 Electron ABI，plain Node 脚本打不开本 App 库；改判为「主进程内一次性 seed」，其纯函数 `planAssetEditSeed` 已实现并单测，但两侧游标对拉未接，登记在 §16.3 之上。

**验收对照**：#1–#6、#8–#12 已由代码 + 上述测试满足（其中 #1–#5 的**应用内人工验收未执行**，`npm run dev` 打开关实测是本阶段收尾必须补的一步）；**#7 元数据展示未满足**，根因见 §16.4——不是"漏做"，而是内嵌态没有该数据源，需按两条路择一再决策。

## 18. 风险（起草时清单，执行后仍然成立）

- **CI 从不跑** `link:nikkisync` / `verify:nikkisync` ⇒ 所有 `*.linked.test.ts` 在 CI 整件 skip：**绿 CI ≠ 功能已验**。真实证据 = §14 步骤 3 的 `toBe` 恒等断言 + 步骤 11 本地 linked 比对 + 步骤 13 手动验收，须写进 PR 描述。
- CI 钉 `.node-version` = 22，本机宿主是 Electron 41 / Node 24 ⇒ linked 行为两侧口径不同。
- `npm install` 剪 junction ⇒ 切源后图库空；恢复动作写进空态提示。
- 新增文件必须自带测试：覆盖率 `all:true` 且阈值卡 `build` job，任何无测试的新文件都会把 `test:coverage` 拖红。
