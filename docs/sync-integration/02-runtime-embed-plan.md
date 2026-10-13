# 阶段 2：NikkiSync PcCompanion Runtime 内嵌计划（02-runtime-embed-plan）

> 生成日期：2026-10-13
> 范围：在 WXNN XiangCe **主进程内直接实例化并管理** NikkiSync 的 `PcCompanionRuntime`
> （数据库 + 游戏目录发现 + 扫描器），并以只读 IPC 把 NikkiSync 原生 DTO 透传给渲染进程。
> 唯一真相源：本文件（`WXNN XiangCe/docs/sync-integration/`）。上游依据见
> [`00-nikkisync-pc-audit-report.md`](./00-nikkisync-pc-audit-report.md)（阶段 0+ 盘点）与
> [`01-dependency-link-plan.md`](./01-dependency-link-plan.md)（阶段 1 装载缝）。
> 铁律：**不重写扫描逻辑、不重写数据库层、不做数据模型转换、不改 NikkiSync 源码。**

---

## 0. 步骤 0 执行记录（代码同步，已完成）

| 动作         | 结果                                                                                                                                                                                                                                                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 探查明现     | 本机**无** NikkiSync 检出：`..\NikkiSync`、`WXNN XiangCe\vendor\NikkiSync` 均不存在，`node_modules\@nikkisync` 四条 junction 全部缺失 ⇒ 第 0 步实为「重新克隆」                                                                                                                                                                                                        |
| 引入方式     | 自包含方案：`package.json` 不声明 `@nikkisync/*`；`npm run link:nikkisync` 在开发机建 junction（候选根 `NIKKISYNC_ROOT` → `../NikkiSync` → `vendor/NikkiSync`）                                                                                                                                                                                                        |
| 克隆落点     | `d:\Zcode项目\WXNN YD\NikkiSync`（命中 `sibling` 候选根）；`git remote -v` = `https://github.com/ToStardust/NikkiSync`                                                                                                                                                                                                                                                 |
| 版本核验     | HEAD = `d4ca7d7`（2026-10-13，`fix(android): save motion photos as rotated videos or LIVE`）；阶段 0+ 检查点为 `b2eb337`，本次前进 `467b590 / 131f301 / 58f2ca8 / d4ca7d7` 等                                                                                                                                                                                          |
| 上游测试     | `npm test` → **136 tests / 136 pass / 0 fail**（阶段 0+ 为 131，新增用例已随 main 增长）；`npm run db:validate` → `schema OK`（13 对象）                                                                                                                                                                                                                               |
| 构建顺序     | `npm run build` 首次失败：`build:pc` 先跑 `scripts/build-wechat-runtime.mjs`（esbuild）而 pc-companion 的 `dist/` 尚未产出（阶段 0+ 风险 **R10** 复现）。**不改上游脚本**，按序手工构建：`build:core` → `build:protocol` → `build:database` → `tsc -p apps/pc-companion/tsconfig.json` → `node scripts/build-wechat-runtime.mjs`，之后 `npm test`/`npm run build` 均绿 |
| 建链         | `npm run link:nikkisync` → 4 条 junction create；`npm run verify:nikkisync` 除「旧 `release/win-unpacked`（2.5.5，早于建链）不含 migrations」一项外全 ✓ —— 该项属**打包态**断言，留待 §7 步骤 5 用新产物复验                                                                                                                                                           |
| 幻影改动     | `tools/sample-analyzer/analyze.mjs` 显示 M 但 `git diff` 为空 = NikkiSync 无 `.gitattributes` + 本机 `core.autocrlf=true`（R11），不处理、不提交                                                                                                                                                                                                                       |
| XiangCe 基线 | 阶段 7 WIP 已停放（见 §8），干净 HEAD 上：`npm run typecheck` 退出码 0、`npm run lint` **0 error**（11 个存量 BOM warning）、`npm run test:main` **190 files / 3511 tests 通过，15 skipped**                                                                                                                                                                           |

### 0.1 API 核对结论（以克隆所得本地源码为准）

| 组件                                                                    | 实测签名                                                                                                                                                                                                                                                                                                                                               | 与阶段 0+ 记录                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `PcCompanionRuntime`（`apps/pc-companion/src/runtime.ts`）              | 构造入参 9 个全可选字段（`databaseFile`/`scanner`/`server`/`remoteBridge`/`metadataResolver`/`metadataDictionary`/`…Supplement`/`…Remote`/`…SupplementRemote`）；`readonly database/scanner/server/remoteBridge/metadataResolver/metadataDictionary/…`；`start(): {scan,server}`；`stop()`；`createPairingUri(host, ttlMs?)`                           | 一致，无破坏性变更                                                                  |
| `DatabaseManager`（`packages/database/src/database-manager.ts`）        | `new DatabaseManager(filename=':memory:')`；`initialize(schemaSql?)`（缺省用 `import.meta.url` 相对定位 `../../migrations/0001_initial.sql`）；`transaction<T>()`；`close()`；`connection` 暴露 `exec/prepare/close`                                                                                                                                   | 一致；顶层 `await import(sqliteModuleName)` ⇒ TLA 陷阱仍在（只能 `await import()`） |
| `ScannerService`（`scanner/ScannerService.ts`）                         | `new ScannerService(database, config?)`；`start()/stop()/fullScan()/rescanPath(p)/getStatus()`；发现失败 `throw new Error('Infinity Nikki installation was not found')`                                                                                                                                                                                | 一致                                                                                |
| `ScannerConfig`（`scanner/types.ts`）                                   | 继承 `GameDiscoveryOptions`（`selectedInstallRoot`/`cachedInstallRoot`/`startingPaths`/`includeDefaultPaths`/`windowsHints`/`runningExecutablePaths`/`onDiscoveryComplete`），另有 `stability`/`watcher`/`debounceMs`/`motionAssemblyGraceMs`/`onSettled`                                                                                              | 一致                                                                                |
| `game-directory-discovery.ts`                                           | 优先级 `manual > cached > local-ancestor > registry > shortcut > common-location > running-process`；`selectedInstallRoot ?? NIKKISYNC_GAME_ROOT`；产出 `{installRoot, x6GameRoot, photoRoots, motionRoots, source}`；有 `GamePlayPhotos` 时 `photoRoots=GamePlayPhotos`、`motionRoots=<uid>/Videos`，否则 `photoRoots=X6Game/ScreenShot`              | 一致                                                                                |
| `SyncReadRepository`（`packages/database/src/sync-read-repository.ts`） | `new SyncReadRepository(database)`；`listAssets(AssetPageQuery)`/`getAsset`/`listResources`/`getResource`/`currentRevision`/`listChangesAfter`/`minimumJournalRevision`；**返回 DB 原始行** `Record<string, unknown>`                                                                                                                                  | 一致                                                                                |
| 协议 DTO 映射                                                           | `apps/pc-companion/src/server/row-mappers.ts`：`mapResourceRow(row)`、`mapAssetRow(row, resourceRows)`、`mapAssetDetail(row, resourceRows)`、`mapAssetSummary(row, resourceRows)`、`mapChangeRow(row)`；**不在 `src/index.ts` 桶导出内**；`@nikkisync/pc-companion` 无 `exports` 字段，`@nikkisync/{core,database,protocol}` 的 `exports` 只暴露 `"."` | 一致 ⇒ 深入口必须以 `file://` URL 装载（`resolveDeepEntryUrl`）                     |
| 上游列表端点语义（`LocalSyncServer.listAssets` L292-323）               | `limit+1` 前瞻判 `hasMore`；游标 = `base64url(JSON {t,id})`；`items = mapAssetSummary(row, listResources(assetId))`；响应 `{items, nextCursor?, libraryRevision}`                                                                                                                                                                                      | 内嵌层逐字复用该语义，不自造分页模型                                                |

**据实修正阶段 0+ 的两条验收措辞：**

1. 真机数据实测（编码完成后补测，本文初稿「`Videos` 为空」的先行结论有误已修正）：
   `X6Game\Saved\GamePlayPhotos\114077271\Videos`
   的动图实际以**每个拍摄时间戳一个子目录**存放（`Videos\<ts>\<ts>.Mp4` + 同名 `*_cover.jpeg`），
   初次探查只列了直接子文件以至误判为「空」。实测结果：`photo` 25 + `motion_photo` 6，
   `motion_photo` 资各挂 2 个资源（`source_primary` + `source_motion`）且
   `motion_resolver_method='filename'` / `confidence=1` ⇒ **`motion_photo` 聚合已用真机数据验证**，
   夹具作为可复现门禁保留。
2. 上游扫描器（`ScanReconciler`）**不产出** `derived_thumbnail` / `derived_preview` 资源（派生资源属
   metadata/thumbnail 侧），扫描后实际角色为 `source_high_quality` / `source_low_quality` /
   `source_primary`（静图）/ `source_motion`（视频）。验收改为「角色集合与上游产出一致 + motion
   聚合正确」，不虚构缩略图。

---

## 1. 依赖声明（不新增声明依赖）

| 项             | 口径                                                                                                                                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json` | **不新增** `@nikkisync/*` 依赖（CI 只 checkout 本仓，`file:`/`workspace:` 必红）；`scripts` 复用已有 `link:nikkisync` / `verify:nikkisync`                                                                                                |
| 运行前置       | 开发机需：① NikkiSync 检出于 `NIKKISYNC_ROOT`/`../NikkiSync`/`vendor/NikkiSync` 之一；② 上游已产出 `dist/`；③ `npm run link:nikkisync` 建链。**`npm install` 会剪掉 junction，需重跑 link**                                               |
| 装载方式       | 一律 `await loadNikkiSyncPackage(...)`（变量式 `await import()`）；深入口用 `resolveDeepEntryUrl` + 变量式 `await import(url)`；**禁止**任何字面量 `@nikkisync/...` 静态导入（`eslint.config.js` 两层护栏 + `verify:nikkisync` 折叠校验） |
| 类型           | 本仓自定义结构面类型（`runtime-types.ts`），**不 `import type` 上游包**（阶段 9 自包含决策）                                                                                                                                              |
| 打包           | 沿用 `build.files: node_modules/@nikkisync/**/*` + `asarUnpack: **/@nikkisync/**`；本阶段补 `scripts/pre-dist-check.ts` 对 `pc-companion/dist/src/server/row-mappers.js` 的断言                                                           |

## 2. Runtime 生命周期管理

| 阶段           | 方案                                                                                                                                                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 启动时机       | **默认关闭**。三个入口：① 设置项 `nikkisync.runtimeEnabled`（默认 `false`）；② 环境变量 `NIKKI_NIKKISYNC_RUNTIME=1`（dev/验证强开，优先级高于设置）；③ IPC `nikkisync:start-scan` 惰性启动。装配点在 `app/lifecycle.ts` 的 `initSyncServer` 之后，独立 `try/catch`，fail-open |
| 构造           | `new PcCompanionRuntime({ databaseFile, scanner: {...}, server: { host:'127.0.0.1', port:0, mdns:false, name:'NikkiGallery embedded' } })`；**不调 `runtime.start()`、不调 `server.start()`**：scanner 单独 `start()`（R2 规避），LAN 服务留待后续阶段（不绑端口、不组播）    |
| 已知构造副作用 | Runtime 构造期总会 `new LocalSyncServer(...)`，未显式传 `tls` 时自动生成 RSA-2048 自签身份并写 `app_settings['server.tlsIdentity']`（只落库，无网络副作用）；未传 `metadataResolver`/`metadataDictionary*` ⇒ 不建任何联网组件（R6 规避：本阶段零外联）                        |
| 停止时机       | `app/cleanup.ts` 的 `performCleanup` 内、`ctx.dbManager.close()` 之前：`scanner.stop()` → `database.close()`，各自 `Promise.race` 超时兜底；**不调 `runtime.stop()`**（其内部 `server.stop()` 面向从未 `start()` 的服务器，行为未验证）                                       |
| 错误恢复       | 状态机：`unavailable`（未建链）/ `idle` / `starting` / `running` / `scanning` / `degraded`（库已建、发现失败）/ `stopping` / `error`。`degraded                                                                                                                               | error` 允许重试；`nikkisync:start-scan`带新`gameRoot`时走`restartWithGameRoot()`（stop+close 后重建，因 `ScannerService`缓存`installation`）；重复 `start` 幂等 |
| 崩溃隔离       | 启动/扫描/查询任一抛错：`electronLogger.warn/error` + `diagLog` 双通道落日志，返回 `AppError`，绝不让主进程 crash；`unhandledRejection` 已有全局兜底                                                                                                                          |

## 3. 数据库文件存储位置

- 路径：`{app.getPath('userData')}/nikkisync/nikkisync.db`（WAL/SHM 同目录），**不使用** `%LOCALAPPDATA%/NikkiSync`，也不使用上游默认 `APP_DATA`。
- 迁移：由上游 `DatabaseManager.initialize()` 跑 `migrations/0001_initial.sql`；打包态由 `embedding-paths.readMigrationsSql()` 解析绝对路径并显式传 `schemaSql`（上游 `import.meta.url` 在 asar 内不可靠）。
- 隔离：与 XiangCe 自有 `better-sqlite3` 库（`{userData}/database`，表 `media_files`）完全独立，无跨库写入。

## 4. 需修改 / 新增文件清单

| #   | 路径                                                                              | 动作      | 内容                                                                                                                                       |
| --- | --------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `src/main/nikkisync/embedding-paths.ts`                                           | 修改      | 新增纯函数 `resolveDeepEntryUrl(root, segments)`（拒绝绝对路径/`..`，产出 `file://` URL）                                                  |
| 2   | `src/main/nikkisync/embedding-paths.test.ts`                                      | 修改      | T1 用例                                                                                                                                    |
| 3   | `src/main/nikkisync/runtime-types.ts`                                             | 新增      | 结构面类型 + `NikkiSyncRuntimeState` / `NikkiSyncRuntimeStatus` / `NikkiSyncAssetPage` 形状                                                |
| 4   | `src/main/nikkisync/runtime-facade.ts`                                            | 新增      | 装载 + 组装（`createEmbeddedRuntimeHandle`）+ 查询（`listAssets/getAssetDetail/getResource`）+ 游标编解码纯函数                            |
| 5   | `src/main/nikkisync/runtime-manager.ts`                                           | 新增      | 进程内单例状态机（`startNikkiSyncRuntime/stopNikkiSyncRuntime/restartWithGameRoot/getRuntimeStatus/runScan`），facade 可注入以便纯逻辑单测 |
| 6   | `src/main/nikkisync/runtime-manager.test.ts`                                      | 新增      | T2 用例                                                                                                                                    |
| 7   | `src/main/nikkisync/runtime-facade.linked.test.ts`                                | 新增      | T3 链接态集成用例（`hasNikkiSyncLink` 门控 skip）                                                                                          |
| 8   | `src/main/nikkisync/runtime-cli.ts`                                               | 新增      | 独立 main 入口壳（`status → start → scan → query → stop`），`process.stdout.write` 输出                                                    |
| 9   | `src/main/app/nikkisync-runtime-setup.ts`                                         | 新增      | Electron 装配层：userData 路径、设置项/环境变量开关、PackagingContext、注入 `ctx.nikkisyncRuntime`                                         |
| 10  | `src/main/app/lifecycle.ts`                                                       | 修改      | `initSyncServer` 之后追加 `initNikkiSyncRuntime(ctx)`（独立 try/catch）                                                                    |
| 11  | `src/main/app/cleanup.ts`                                                         | 修改      | `performCleanup` 内停 Runtime（在 `dbManager.close()` 之前）                                                                               |
| 12  | `src/main/app/app-context.ts` / `src/main/ipc/handler-context.ts`                 | 修改      | 新增可选 `nikkisyncRuntime?: NikkiSyncRuntimeHandle`                                                                                       |
| 13  | `src/main/ipc/handlers/nikkisync-handler.ts`                                      | 新增      | 5 条通道（zod 校验 + DTO 透传）                                                                                                            |
| 14  | `src/main/ipc/handlers/nikkisync-handler.test.ts`                                 | 新增      | T4 用例                                                                                                                                    |
| 15  | `src/main/app/ipc-setup.ts`                                                       | 修改      | 注册 `registerNikkiSyncHandlers(ctx)`                                                                                                      |
| 16  | `src/main/preload/api/nikkisync.ts`                                               | 新增      | `electronAPI.nikkisync.*`                                                                                                                  |
| 17  | `src/main/preload.ts`                                                             | 修改      | 装配 `nikkisync: nikkisyncAPI`                                                                                                             |
| 18  | `src/shared/types/electron-api.ts` / `src/renderer/vite-env.d.ts`                 | 修改      | 形状快照类型 + `nikkisync:` 命名空间声明                                                                                                   |
| 19  | `electron.vite.config.ts`                                                         | 修改      | main 入口新增 `nikkisync-runtime`                                                                                                          |
| 20  | `scripts/pre-dist-check.ts`                                                       | 修改      | 打包断言补 `pc-companion/dist/src/server/row-mappers.js`                                                                                   |
| 21  | `src/main/nikkisync/AGENTS.md` / `docs/sync-integration/02-runtime-embed-plan.md` | 修改/新增 | 文件职责表 + link 剪枝提醒 + 本计划                                                                                                        |

## 5. IPC 通道清单（只读查询，响应体 = NikkiSync 协议 DTO）

| 通道                         | 入参                                                                                                  | 出参                                                                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nikkisync:runtime-status`   | 无                                                                                                    | `{ state, dbPath, tables?, linkReady, installation?, lastScan?, error?, hint? }`（`tables` 来自 `sqlite_master`，`installation/lastScan` 直接来自 `scanner.getStatus()`） |
| `nikkisync:start-scan`       | `{ gameRoot?: string, path?: string }`（可省）                                                        | 上游 `ScanResult` 原样；`gameRoot` 与当前不同 ⇒ `restartWithGameRoot`；`path` ⇒ `rescanPath`                                                                              |
| `nikkisync:get-assets`       | `{ limit: 1..500, cursor?: string, type?: string, afterRevision?: number, includeDeleted?: boolean }` | `{ items: AssetSummary[], nextCursor?, libraryRevision }`（`mapAssetSummary` + 上游同款游标）                                                                             |
| `nikkisync:get-asset-detail` | `assetId: string(1..128)`                                                                             | `AssetDetailResponse`（`mapAssetDetail`，含 `asset.resources` 与 `asset.motion`）                                                                                         |
| `nikkisync:get-resource`     | `{ assetId, resourceId, mode?: 'meta'\|'path' }`                                                      | `meta` ⇒ `MediaResource`（`mapResourceRow`）；`path` ⇒ `resources.source_path` 列原值（绝对路径，不包装）                                                                 |

失败口径：未建链 / 未启用 / 状态不允许 ⇒ `AppError.preconditionFailed`；`assetId`/`resourceId` 不存在 ⇒ `AppError.notFound`；参数非法 ⇒ `AppError.validation`。消息为英文（`src/**` 中文硬编码护栏），本地化在渲染层。

## 6. 验收标准

1. 启用后 `{userData}/nikkisync/nikkisync.db` 生成，`sqlite_master` 含全部 12 张业务表（`app_settings/assets/change_journal/device_sync_state/library_state/metadata_dictionary_entries/metadata_dictionary_state/paired_devices/pairing_sessions/resolver_candidates/resources/schema_migrations`）。
2. 扫描走 NikkiSync 自己的发现 + `ScanCoordinator` + `ScanReconciler`：真机根（`H:\InfinityNikki Launcher\InfinityNikki`，25 HQ + 23 LQ）产出 `photo` 资产，角色为 `source_high_quality`/`source_low_quality`；夹具根产出 `motion_photo` 资产且同时挂 `source_primary`（静图）与 `source_motion`（视频），`asset.motion.stillResourceId/motionResourceId` 均非空（`AssetResolver` 生效）。
3. `nikkisync:get-assets` / `get-asset-detail` 返回体与协议 DTO 逐字段一致（由 `row-mappers` 产出，内嵌层零转换）。
4. 退出优雅停止：无未捕获错误、日志有 `stopped` 轨迹；`release` 内旧产物不影响本阶段。
5. 未建链 / 无游戏目录 / Runtime 构造失败三种情况下应用照常启动，`runtime-status` 给出可读原因与修复命令。
6. 门禁：XiangCe `typecheck` / `lint`(0 error) / `test`（含 `test:main`）全绿；`verify:nikkisync` 0 blocking；NikkiSync `npm test` 全绿；上游源码零改动。

## 7. 测试用例与分步放行（红灯 → 绿灯）

| 步  | 红灯                                                                                                                                                                                                                            | 绿灯       | 判据                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------- |
| 1   | `embedding-paths.test.ts` 追加 `resolveDeepEntryUrl` 正/负例（`..`、绝对路径、空段）                                                                                                                                            | 文件 1     | 纯函数，不触磁盘              |
| 2   | `runtime-manager.test.ts`：`unavailable`/`idle→starting→running`/重复 start/`installation not found`→`degraded` 不外抛/stop 幂等并释放/`restartWithGameRoot` 重建/查询在未就绪时报错                                            | 文件 5     | 注入假 facade，不依赖链接     |
| 3   | `runtime-facade.linked.test.ts`（`LINKED` 门控）：临时库文件 + 夹具游戏根 ⇒ 建表 12 张、`fullScan` 后有 assets/resources、角色集合正确、`motion_photo` 静图+视频同资产、游标分页与 `nextCursor` 正确、DTO 由 `row-mappers` 产出 | 文件 4     | 真装载上游产物                |
| 4   | `nikkisync-handler.test.ts`：5 通道注册、参数校验、DTO 透传 `toEqual` 仓库输出、未启用 ⇒ `preconditionFailed`                                                                                                                   | 文件 13    | mock `ctx.nikkisyncRuntime`   |
| 5   | 打包/折叠校验：`npm run build` 后 `verify:nikkisync` 0 blocking（含 fresh `electron-builder --dir` 或清理旧 `release/win-unpacked`）                                                                                            | 文件 19/20 | 无 `require("@nikkisync` 命中 |
| 6   | 真机验证：`NIKKI_NIKKISYNC_RUNTIME=1 npm run dev` ⇒ 库文件、`runtime-status=running`、`get-assets` 返回真照片、退出日志干净                                                                                                     | —          | 手动，结论写入本文件 §9       |

## 8. 分支与提交

| 侧        | 分支                                          | 说明                                                                                                                                                                                                                                                                                    |
| --------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| XiangCe   | `feat/gallery-runtime-embed`                  | 已提交 `361d078`（阶段 1+9 装载缝/链接/自包含改造，原为未跟踪 WIP）与 `3298632`（阶段 2 内嵌 Runtime + 只读 IPC 桥，29 files / +2990）；两次提交均过 pre-commit（lint-staged + core-gate + `tsc -b`）                                                                                   |
| XiangCe   | `wip/sync-integration-07-parked`（`528fca0`） | 阶段 7 双向同步 WIP 停放点（6 个已跟踪文件改动 + 5 个未跟踪新文件，含 `protocol-extension.ts`）。**未做成 commit**：该 WIP 自带 2 个 tsc 错，仓内 pre-commit 的 `tsc -b` 步骤按设计必红，而跳钩子（`--no-verify`）违反纪律；改为 stash-commit 对象 + 分支指向 + 保留 `stash@{0}` 双备份 |
| NikkiSync | `main`（只读）                                | HEAD `d4ca7d7`，**零源码改动**（只有 `npm install` 与编译产物；`tools/sample-analyzer/analyze.mjs` 的幻影 M 已举证为 CRLF，未提交）。本阶段无需上游兼容性改动，因此未切分支                                                                                                             |

## 9. 后续阶段：扫描器统一（本阶段不动原扫描器）

- 现状：XiangCe `ScannerManager`（utilityProcess，写 `media_files`）与内嵌 `ScannerService`（写 `assets/resources`）**并行**，各扫各表、无写冲突；代价是同目录双份 sha256（R3/R4）与 `path_key` 全局 UNIQUE 的改名膨胀（R5）。规避：Runtime 默认关闭、`watcher` 可关、扫描仅手动/开关触发。
- 路线：① 以 `assets` 为媒体事实源，`media_files` 退化为 XiangCe 专有编辑层；② `ScannerService` 取代 XiangCe 扫描 worker；③ `SyncReadRepository` 取代移植面 `src/main/database/sync-*`；④ `PcCompanionRuntime.server` 取代 `src/main/sync/server/*`（届时处理 R7 的 `GalleryRuntime.mjs` 依赖、端口与防火墙归属、R8 mDNS）；⑤ 删除 `src/shared/sync` vendored 契约，以上游为真相源 + 漂移守护。

## 10. 执行结果（2026-10-13 回填）

### 10.1 单元/集成门禁

| 项         | 命令                                                                                         | 结果                                                                                                                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1         | `npx vitest run src/main/nikkisync/embedding-paths.test.ts`                                  | **17/17 通过**（含 `resolveDeepEntryUrl` 4 例，先红后绿）                                                                                                                                             |
| T2         | `runtime-manager.test.ts`                                                                    | **18/18 通过**（状态机、降级、幂等、换根重建、超时兜底）                                                                                                                                              |
| T3         | `runtime-facade.linked.test.ts`（链接态）                                                    | **10/10 通过**：建库+12 表、上游扫描、`motion_photo` 静图+视频同资产、`row-mappers` DTO 透传、`limit+1` 游标翻页不重叠、404 语义、**完整生命周期**（stop 后 `-wal` 已 checkpoint、可再次 start 恢复） |
| T4         | `nikkisync-handler.test.ts`                                                                  | **14/14 通过**（5 通道注册与顺序、参数校验、DTO 逐字段 `toEqual`、未组装 ⇒ `PRECONDITION_FAILED`、错误分类映射）                                                                                      |
| 装配       | `app/__tests__/nikkisync-runtime-setup.test.ts`                                              | **13/13 通过**（库落点、开关优先级、`initNikkiSyncRuntime` 注入与不自启、`stopNikkiSyncRuntime` 幂等）                                                                                                |
| 全量       | `npm run typecheck` / `npm run lint` / `npm run test`                                        | typecheck 退出码 0；lint **0 error**（11 个存量 BOM warning，未新增）；`npm run test` **370 files / 5792 passed / 2 skipped**                                                                         |
| 真装载回归 | `npm run test:main`（链接已建）                                                              | `runtime-loader.test.ts` 13 例（原 8 skipped → 现在真跑）、`protocol-drift.test.ts` 2 例真跑，均绿                                                                                                    |
| 环境无关   | 接线用例初跑因 dev 会话遗留的 `NIKKI_NIKKISYNC_RUNTIME` / `NIKKI_NIKKISYNC_GAME_ROOT` 假失败 | 已在 `beforeEach` 显式 `delete process.env[...]`（由各用例自设 flag），结果不再依赖宿主环境                                                                                                           |

装配层由接线用例拓出一个真 bug：`app_settings` 历史值/桩返回 `undefined` 时
`settingsFrom()` 直递造成 `.trim()` 崩溃。已收敛为「类型不匹配即回退 fallback」（
`nikkisync-runtime-setup.ts` 的 `settingsFrom`），并保留该用例。

### 10.2 打包与宿主校验

| 项                                             | 结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                                | 退出码 0；产出 `dist/main/main/app/nikkisync-probe.js` 与新增的 `nikkisync-runtime.js`                                                                                                                                                                                                                                                                                                                                                                                            |
| `verify:nikkisync` 折叠项                      | **zero `require("@nikkisync` hits across dist/main/main/app/\*.\*`**（含共享 chunk）⇒ R1 未回退                                                                                                                                                                                                                                                                                                                                                                                   |
| `verify:nikkisync` 其余项                      | 自包含 / 4 链接 / dist 产物 / migrations SQL / node:sqlite / electron 41.10.6 均 ✓                                                                                                                                                                                                                                                                                                                                                                                                |
| `verify:nikkisync` 唯一 blocking               | 「`app.asar.unpacked` 缺 @nikkisync schema」——来自 `release\win-unpacked`（2026-10-11 的 2.5.5 旧产物，早于建链）。本环境重跑 `npx electron-builder --dir` 失败：先报 `unable to verify the first certificate`，加 `--use-system-ca` 后下载 Electron 发行包 600s 超时（代理/证书环境），因此**打包lane 仅能到“配置已声明 + 旧产物不含”这一步**，待可行环境重跑 `npm run dist:win` 后复验（`scripts/pre-dist-check.ts` 已新增 `pc-companion/dist/src/server/row-mappers.js` 断言） |
| Electron 宿主直跑（代替 GUI 会话的打包前取证） | `ELECTRON_RUN_AS_NODE=1 electron.exe dist/main/main/app/nikkisync-runtime.js --game-root=H:\…` → `state=running tables=13`，`[scan] filesObserved=74`，`[query] assets=3`，退出码 0 ⇒ 真 CJS 产物在真宿主（Electron 41.10.6 / Node 24.18.0）上装载、建库、扫描、查询全链路可用                                                                                                                                                                                                    |
| 无游戏目录降级                                 | `--game-root=Q:\definitely-not-installed` → `state=degraded tables=13`，`[fail] Infinity Nikki installation was not found`，退出码 1；库文件仍正常创建，无堆栈崩溃                                                                                                                                                                                                                                                                                                                |

### 10.3 真机 app 会话（T5）

`NIKKI_NIKKISYNC_RUNTIME=1` + `NIKKI_NIKKISYNC_GAME_ROOT=H:\InfinityNikki Launcher\InfinityNikki` 启动 dev 会话，实测：

- `{userData}\wxnn-photo-manager\nikkisync\nikkisync.db`（+ `-wal` / `-shm`）已创建 ⇒ 验收项 1，且**未使用** `%LOCALAPPDATA%/NikkiSync`；
- `logs/main.log`：`[NIKKISYNC] nikkisync runtime started (gameRoot=H:\InfinityNikki Launcher\InfinityNikki)` 与
  `embedded runtime start result: state=running linkReady=true tables=13 error=none`；
- 只读统计该库：`tables=13`（含 `sqlite_sequence`）、`assets=31`（`photo` 25 + `motion_photo` 6）、
  `resources` 角色计数 `source_high_quality` 25 / `source_low_quality` 23 / `source_primary` 6 / `source_motion` 6，
  `change_journal=31`，`library_state.library_revision=31`，`sha256` 均为 64 字符；
- 构造副作用如实发生且仅限写库：`app_settings` 出现 `server.identity` 与 `server.tlsIdentity`（未绑端口、未组播）；
- 本会话未配 `metadataResolver`/`metadataDictionary*` ⇒ 无任何上游联网组件（字典/解析器表为空），符合 R6 规避；
- 退出链：dev 会话由外部 `taskkill` 结束，未走到应用内 `before-quit`（因此本次没有 GUI 会话内的
  `embedded runtime stopped` 日志）。该缺口由“完整生命周期”链接态用例补齐：真上游
  `scanner.stop()` + `database.close()` 后状态回 `idle`、`-wal` 已 checkpoint、可重新 `start()` 恢复，
  且 `cleanup.ts` 的调用点已接入 `stopNikkiSyncRuntime(ctx)`。

### 10.4 遗留项

1. 打包态复验（需可行网络/证书环境重跑 `npm run dist:win`）：`app.asar.unpacked` 内
   `@nikkisync/database/migrations/0001_initial.sql`、`pc-companion/dist/src/index.js`、
   `pc-companion/dist/src/server/row-mappers.js`、`wechat/GalleryRuntime.mjs` 四项均需存在。
2. 渲染层 UI（开关/资产列表）未做（本阶段只交付 IPC 与验证入口）。
3. 设置项 `nikkisync.runtimeEnabled` / `nikkisync.gameRoot` / `nikkisync.watcherEnabled` 当前只能经
   env 或直写 `app_settings` 开启，需阶段 5 的设置页接入。
4. `verify:nikkisync` 的旧 `release/win-unpacked` 误报：建议在下一步把“产物构建时间 vs 建链时间”作为
   该检查的额外判据（本轮不改 scripts，仅登记）。
