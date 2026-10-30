# NikkiSync 上游同步 · 01 影响评估（新一轮 阶段 1：只读盘点，不改业务代码）

> 生成日期：2026-10-29 · 本仓 `main` @ `c45e3f400b12b933c9ecf6d899bc72cfa7535715`（`meow-star-map 2.5.6-beta`；工作区仅未跟踪 `release-sync/`，本阶段未触碰）
> 上游 NikkiSync：基线 `b4221933be9714fde0c260b1f19bdaa6d1337fd3`（1.0.23，上一轮结案锚点）→ 目标 `b397e0eb6ca1b4748f13a72f13bb1702a549410e`（`origin/main` HEAD，即 tag `v1.0.27-public-beta.1`）
> 路径作用域：本文未注明「本仓」的源码路径（`packages/`、`apps/`、`scripts/` 等）均指**上游 NikkiSync 仓**检出根 `../NikkiSync`，不在本仓解析范围内。
> 结论速览：**上游 2 提交、总 83 文件 +2674/−199；消费面内 34 文件（core 0 / protocol 1 / database 3 / pc-companion 30 / 根构建 0）。本仓链接建成、`verify:nikkisync` 12 项全 ✓（blocking 0）；域测试 16 文件 / 276 用例真实执行、skip 0，但有 1 条红灯：`runtime-facade.linked.test.ts:408` 断言未来时刻推断为 `2.10`，上游本轮在静态日历新增 `2.11` 行使实测值变为 `2.11`。除该条外全绿（275 passed）。协议与数据库均无破坏性变更（新增字段/参数全部可选、`0001_initial.sql` 就地新增一条索引但机制上每次开库幂等重放 ⇒ 既有用户库自动补齐）；真正需要动作的是本仓 3 处：K3 日历硬编码断言、`runtime-facade.ts:548` 的增量变更判据已与上游漂移、`row-mappers.js` 新增对闸门清单外产物 `MediaFingerprint.js` 的静态依赖。**
> **停止门判定：未达成「绿灯基线」——存在 1 条由本轮上游数据变更直接触发的红灯。本阶段按约定不修代码，只把红项归因、判据与处置选项写清，交裁决后再进下一阶段。**

---

## 1. 环境事实盘点

| 项                 | 事实                                                                                                                                                                                                                                                                                                        | 证据命令                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Node               | v26.3.0（同时满足本仓 engines `>=22.12.0` 与上游 `>=24.0.0`）                                                                                                                                                                                                                                               | `node -v`；两个 `package.json` 的 `engines`                                         |
| npm                | 11.16.0                                                                                                                                                                                                                                                                                                     | `npm -v`                                                                            |
| git                | 2.55.0.windows.2                                                                                                                                                                                                                                                                                            | `git --version`                                                                     |
| `NIKKISYNC_ROOT`   | 未设置（空）⇒ 建链候选根走同级 `../NikkiSync`                                                                                                                                                                                                                                                               | `echo $NIKKISYNC_ROOT`                                                              |
| 本仓分支/HEAD      | `main` @ `c45e3f4`                                                                                                                                                                                                                                                                                          | `git rev-parse --abbrev-ref HEAD`；`git rev-parse HEAD`                             |
| 本仓工作区         | 仅 `?? release-sync/`（内含 `win-unpacked/resources/app.asar` 与 `default_app.asar`，为上一轮 `dist:win` 的遗留解包副本，本阶段未删未改）                                                                                                                                                                   | `git status --porcelain`；`ls -R release-sync`                                      |
| 仓内 vendor        | 不存在 `vendor/` 目录                                                                                                                                                                                                                                                                                       | `ls vendor` → No such file or directory                                             |
| 上游检出           | `D:\Workbuddy 项目\WXNN YD - 副本\NikkiSync`，remote = `https://github.com/ToStardust/NikkiSync`（fetch+push），分支 `main`                                                                                                                                                                                 | `git -C ../NikkiSync remote -v`                                                     |
| 上游工作区         | **fetch 前 / ff 后 / 构建后三次复查均为 0 行 porcelain**；`git diff --name-only` 空 ⇒ 上游被跟踪文件零修改                                                                                                                                                                                                  | `git -C ../NikkiSync status --porcelain \| wc -l` → `0`                             |
| 网络通道（重要）   | `github.com:443` **间歇性不通**：首次 `git ls-remote` 报 `Failed to connect to github.com:443 after 21117 ms`，随后两次重试均成功；`curl https://github.com` 超时、`raw.githubusercontent.com` 被 reset，但 `api.github.com` 稳定 200、`codeload.github.com` 301 可达。`git fetch origin` **第 1 次即成功** | 见附录「网络取证」                                                                  |
| 本仓 `npm install` | **本阶段全程未执行**（会剪 `node_modules/@nikkisync` junction）                                                                                                                                                                                                                                             | 无 install 记录；建链前四条 junction 已在位（`ls -la` 显示 mtime 2026-10-28 19:49） |

## 2. 上游基线 / 目标 SHA 与提交清单

### 2.1 基线双向交叉认定（通过）

- 上一轮结案文档记载的上游锚点：`b422193`（[05 结案报告 §2.1](2026-10-25-nikkisync-upstream-sync-05-结案报告.md)）。
- 本轮检出 fetch 前实际 HEAD：`b4221933be9714fde0c260b1f19bdaa6d1337fd3`（`git -C ../NikkiSync rev-parse HEAD`，fetch 前）。
- 两者**逐字一致 ⇒ 采信 `b422193` 为本轮基线**，无矛盾、无需停止询问。
- 前进后二次复核：`git -C ../NikkiSync merge-base --is-ancestor b422193 origin/main` 退出 0（基线确为目标祖先）。

### 2.2 整合目标与前进方式

| 步骤        | 命令                                                                   | 实测读数                                              |
| ----------- | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| fetch       | `git -C ../NikkiSync fetch origin`                                     | `b422193..b397e0e main -> origin/main`；新增 2 个 tag |
| 目标 SHA    | `git -C ../NikkiSync rev-parse origin/main`                            | `b397e0eb6ca1b4748f13a72f13bb1702a549410e`            |
| 分叉判定    | `git -C ../NikkiSync rev-list --left-right --count main...origin/main` | `0	2` ⇒ **零分叉**，允许 ff                            |
| 前进        | `git -C ../NikkiSync merge --ff-only origin/main`                      | `Updating b422193..b397e0e` / `Fast-forward`          |
| 前进后 HEAD | `git -C ../NikkiSync rev-parse HEAD`                                   | `b397e0e…`，`status --porcelain` 仍 **0 行**          |

区间内近期 tag（供核对；本轮目标可锚定为 tag 而非滚动 main，直接缓解上一轮 R5）：

| tag                     | 指向      | 说明                      |
| ----------------------- | --------- | ------------------------- |
| `v1.0.25-public-beta.1` | `fc39fd2` | 区间内第 1 个（由旧到新） |
| `v1.0.27-public-beta.1` | `b397e0e` | **= 本轮目标**            |
| `v1.0.23-public-beta.1` | `b422193` | 上一轮锚点（本轮基线）    |

### 2.3 完整提交清单（旧→新，`git -C ../NikkiSync log --oneline --no-decorate b422193..b397e0e`）

| #   | SHA       | 日期       | 主题                                                                  | 全部/消费面内文件 | 体量         | 分类                                                                                                                                                                                                                                                                                            |
| --- | --------- | ---------- | --------------------------------------------------------------------- | ----------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `fc39fd2` | 2026-10-25 | feat: release 1.0.25 large library cache and verified batch recycling | 43 / **15**       | +1426 / −99  | **消费面相关**：`0001_initial.sql` 新增 gallery 排序索引（§4-B）、`ExtraScanDirectories` 目录来源标记、`DeletionQueue` 批量校验/回收批处理、`ScannerService.exactExportCopies`、移动端大库缓存                                                                                                  |
| 2   | `b397e0e` | 2026-10-27 | feat: release 1.0.27 account sync scopes and cache recovery           | 62 / **24**       | +1295 / −147 | **强相关**：`AccountSyncSettings` 账号作用域（`SyncReadRepository` 构造期注入作用域）、`GameVersionCalendar` 新增 `2.11` 行 + `tentative` 语义、`GameVersionUpdateService` 官方公告解析、`AssetSummary` 9 个可选新键、`MediaFingerprint`/`VersionAssetPages`/`NativeMediaOperations` 三个新模块 |

逐提交计数证据：`git show --name-only --format= <sha> | grep -cE "^(packages/\|apps/pc-companion/\|package\.json\|tsconfig\|scripts/)"`。

## 3. 文件级影响面分类

总量（`git diff --stat b422193..b397e0e | tail -1`）：**83 files changed, 2674 insertions(+), 199 deletions(-)**。

- **消费面内 34 文件**（`git diff --name-only b422193..b397e0e -- packages apps/pc-companion package.json tsconfig.base.json scripts | wc -l`）：
  - `packages/core/` **0**（四包中 core 本轮零变化）；
  - `packages/protocol/` **1** = `src/index.ts`（+12/−0，纯可选字段追加）；
  - `packages/database/` **3** = `migrations/0001_initial.sql`（+1）、`src/sync-read-repository.ts`（+33/−7）、`test/database.test.ts`（+7）；
  - `apps/pc-companion/` **30** = src 21 + test 9；
  - 根构建配置 `package.json` / `tsconfig.base.json` / `scripts/` **0**（⇒ 见 §4-D）。
- **消费面外 49 文件 +1911/−104**（`git diff --stat b422193..b397e0e -- . ':!packages' ':!apps/pc-companion' ':!package.json' ':!scripts' ':!tsconfig.base.json' | tail -1`）：`apps/mobile` 32、`apps/windows-shell` 7、`apps/windows-shell.Tests` 3、`docs/releases` 6、`README.md` 1。
- **消费面内但与本仓装载缝无关的上游自有面**：`desktop/AccountSyncPanel.ts`(新)、`desktop/DesktopControlServer.ts`、`desktop/DesktopPage.ts`/`DesktopPageScript.ts`、`windows-app.ts` —— 属上游自家 Electron 壳，本仓不装载（判据：本仓 `src/main/nikkisync/runtime-facade.ts` 的 `*_DEEP_ENTRY` 常量清单里无这些路径）。

## 4. 五类风险面实证

### A. 四包桶导出与桶外深入口产物 —— 零删除零改名，破坏性为 0

- 桶导出实测：`git diff --stat b422193..b397e0e -- packages/core/src/index.ts packages/database/src/index.ts packages/protocol/src/index.ts` → **只有 `packages/protocol/src/index.ts` 变化（+12/−0）**，core 与 database 桶导出逐字节未动。
- `packages/protocol/src/index.ts` 的唯一改动是 `AssetSummary` **interface** 追加 9 个**可选**字段（`thumbnailSha256?`、`previewSha256?`、`fullPreviewResourceId?`、`fullPreviewSha256?`、`mediaFingerprint?`、`sourcePath?`、`sourceFolder?`、`sizeBytes?`，加上原 `gameVersion` 系已有）。interface 无运行时值 ⇒ `NIKKISYNC_REQUIRED_EXPORTS` 探针与 `protocol-drift.test.ts` 都**不可能**捕获其形状漂移（本仓 `src/main/nikkisync/AGENTS.md` 硬约束 2 早已言明该局限）。
- 装载链产物逐项点名核查：目标态 17 个路径**全部存在**（`test -f apps/pc-companion/dist/src/<path>`），组成为本仓 `runtime-facade.ts` 的 **12 个 `*_DEEP_ENTRY` 常量**所指产物（`server/{row-mappers,SuitSearchIndex,ClothingSearchIndex,ProfileStatsIndex,LanAddress,GameVersionCalendar}.js`、`metadata/{Nuan5CompatibleResolver,MetadataResolutionDiagnostics,CachedDecodedMetadataService,MetadataOnlineConsent}.js`、`scanner/{ExtraScanDirectories,ScanDiagnostics}.js`）+ `verify:nikkisync` 清单额外点名的 `server/LocalSyncServer.js`、`wechat/GalleryRuntime.mjs`、`organizer/DeletionQueue.js` + 本轮新进入依赖链的 `server/MediaFingerprint.js` + 上游新模块 `scanner/ScanIndexFailure.js` ⇒ 无删除、无改名。
- **签名兼容性逐条实测（无破坏）**：
  - `SyncReadRepository` 构造器 `constructor(database, allowedUids?, sourceGroups?)` —— 后两参**可选**；本仓 `runtime-facade.ts:434` 的 `new ReadRepoCtor(runtime.database)` 是**单参构造**（其本地类型标注在 `:431-433`，也只声明一个 `database` 参）⇒ `scope()` 走 `uids === undefined → {sql:'1=1'}` 分支，**行为与本仓基线完全一致**（零适配）。
  - `ExtraScanDirectories` 构造器新增第 4 个可选参 `onSourcesChanged?`；`inspect(selected, source?)` 新增**可选**第 2 参（传非 `spinning_momo` 值会抛 `invalid_source`）；新增公开方法 `setSource(id, source)`。本仓 `ExtraScanDirectoriesLike`（`runtime-types.ts:170-176`）只声明 `state/inspect/add/remove/rescan` 且以 3 参构造（`runtime-facade.ts:718`）⇒ 兼容，但拿不到新能力。
  - `DeletionQueue`：`DeleteIntent` 追加 3 个可选字段（`mediaFingerprint?`/`batchVerification?`/`resultAck?`）、`list(device?, requested?)` 追加可选第 2 参、新增公开 `dismiss(ids, allFailures=false)`、新增导出类型 `FilePlan`/`FileResult`/`DeletionQueueOptions`。本仓不自行构造它（`grep "new DeletionQueue" src/` 零命中），只经 `runtime.deletions` 拿引用；`DeletionQueueLike`（`runtime-types.ts:156-161`）声明的 5 个方法 `list/decide/approveMany/activity/stop` 在目标态**签名全部保留** ⇒ 兼容。
  - `PcCompanionRuntime` 内部把 `DeletionQueue` 的第 7 个实参换成 `{exportsFor, recycleMany, preview}` —— 上游自有装配，本仓不构造。
  - `ScannerService` 新增公开 `exactExportCopies(source)`（纯追加）。
- **`mapAssetSummary` 载荷新增键 = 本仓透传面自动带出**（`row-mappers.ts` +13/−0）：新增 `mediaFingerprint`、`sourcePath`、`sourceFolder`、`sizeBytes`、`thumbnailSha256`、`previewSha256`、`fullPreviewResourceId`、`fullPreviewSha256`。本仓 `createQuerySurface()` 对上游 DTO 是**零转换透传**，故这些键会经 `nikkisync:*` 通道流向渲染层；其中 `sourcePath`/`sourceFolder` 是**本机绝对路径与父目录**（上游注释自陈「shared only through the authenticated LAN gallery」）。实测本轮链接态套件无一断言 DTO 精确形状（否则 `toEqual` 会因多余键先红），故当前不红，但属**新增外泄面**，见 §8-R7。

### B. 数据库 migrations 与初始化机制 —— 就地新增一条索引；机制上既有库会自动补齐（零适配、零风险）

**这是本轮与上一轮最大的差别**：上一轮该面为「零变化」，本轮 `0001_initial.sql` 被**就地改写**。

- 变更内容（`git diff b422193..b397e0e -- packages/database/migrations`，全文只有一行新增）：

  ```sql
  + CREATE INDEX IF NOT EXISTS idx_assets_gallery_order ON assets(COALESCE(captured_at, discovered_at) DESC, asset_id ASC);
  ```

  归属提交 `fc39fd2`（`git log --oneline b422193..b397e0e -- packages/database/migrations` → 仅此 1 条）。

- 迁移文件集合未变：`ls packages/database/migrations` 仍**仅** `0001_initial.sql`（无 `0002_*`）；`git diff --stat b422193..b397e0e -- packages/database/src/database-manager.ts packages/database/scripts` 输出为空 ⇒ 应用机制与校验脚本未动。
- **关键判据（决定既有用户库是否缺对象）**：`packages/database/src/database-manager.ts:45-51` 的 `initialize()` 实现是

  ```ts
  initialize(schemaSql?: string): void {
    const migrationFile = ... new URL('../../migrations/0001_initial.sql', import.meta.url)
    const sql = schemaSql ?? readFileSync(migrationFile, 'utf8')
    this.connection.exec(sql)
  }
  ```

  —— **没有任何版本门控**（不查 `schema_migrations` 决定是否重放），每次调用都全量 `exec` 整份 SQL；而 SQL 内所有对象均为 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` + `INSERT OR IGNORE`（`schema_migrations` 表本身在 SQL 第 6 行建立、第 172 行 `INSERT OR IGNORE` 登记）。
  ⇒ 结论：**既有 `{userData}/nikkisync/nikkisync.db` 在下一次开库时即自动补建 `idx_assets_gallery_order`，不存在「新装库有、老库没有」的形状分叉**。本仓零适配、无老库升级风险。

- 与本仓既有实测互证：`runtime-facade.linked.test.ts` 的「同一库文件二次 `createRuntimeSession` 重开（兼容层 C3-3：老库零迁移升级路径）」用例本轮**真实执行且通过**，其断言为「重开后表清单与首次一致、`schema_migrations` 可读且版本为 1（零迁移执行）」⇒ 重开路径在新 SQL 下仍绿。
- 性能面（推断，非实测基准）：该索引服务 `ORDER BY COALESCE(captured_at, discovered_at) DESC, asset_id ASC` 的分页排序（正是 `SyncReadRepository.listSuitSearchAssets()` 与 `VersionAssetPages` 使用的序），对应上游 1.0.25 的「large library cache」主题。本仓查询面受益，无需动作。
- 另一处 SQL 语义变化需知晓（**非 migrations**）：`SyncReadRepository.listSuitSearchResources()` 由 `SELECT * FROM resources` 改为 `SELECT resources.* FROM resources JOIN assets ON assets.asset_id=resources.asset_id WHERE <scope>`。在本仓调用形态（scope 恒 `1=1`）下，**唯一差异是「无对应 asset 行的孤儿 resource 不再返回」**；本仓 `runtime-facade.ts:461` 消费该方法建 suit 搜索面，其 `FakeSyncReadRepository` 桩不受影响，链接态实测通过。判定：随上游游标语义收敛，本仓无需动作，但列入 §8-R6 观察项。

### C. HTTP/WS 协议面 —— 版本与路由零变化；三处可选扩展 + 一处本仓判据漂移

- `packages/protocol/src/index.ts` 的 diff 仅 `AssetSummary` 一处 hunk（§4-A）⇒ **`PROTOCOL_VERSION` 未动、`API_ROUTES` 键集合与顺序未动、`buildPairingUri()` 未动、鉴权/配对/分片相关常量未动**。实测复证：`protocol-drift.test.ts`（2 例）与 `runtime-loader.test.ts`（含 `PROTOCOL_VERSION === 1` 常量契约）**本轮全绿**。
- 服务器侧 `apps/pc-companion/src/server/LocalSyncServer.ts`（+6/−2）三处：
  1. `LocalSyncServerConfig` 新增可选 `accountSourceDirectories?: () => readonly ExtraScanRoot[]`；
  2. `LocalSyncServer` 新增 `readonly accounts: AccountSyncSettings`，并把 `new SyncReadRepository(database)` 改为 `new SyncReadRepository(database, () => this.accounts.selection(), () => this.accounts.sourceGroups())` —— **上游自家服务从此按「账号作用域」过滤资产**；
  3. `GET /v1/changes` 判定式由 `fullResyncRequired = minimum !== undefined && after < minimum - 1` 改为 `fullResyncRequired = after < this.accounts.revision() || minimum !== undefined && after < minimum - 1`。
- **本仓漂移点（本轮唯一需要主动跟随的协议语义）**：本仓 `src/main/nikkisync/runtime-facade.ts:548` 仍是**上游旧判据**逐字拷贝：

  ```ts
  const fullResyncRequired = minimum !== undefined && after < minimum - 1
  ```

  而 `src/main/nikkisync/AGENTS.md` 对 `runtime-facade.test.ts` 的职责描述明写「增量变更（判据**逐字同上游** `GET /v1/changes`）」⇒ 该表述自本轮起**失真**。语义影响：上游新增的第一支是在「用户改变了同步账号勾选（作用域修订号前进）」时强制客户端全量重同步；本仓查询面不走账号作用域（`allowedUids === undefined`），故**当前无行为差异**，但一旦后续接入账号作用域，本仓侧会漏发 `fullResyncRequired`。列入 §10-Q2 待裁决。

- 对旧版第三方客户端的兼容性：**全部新增字段可选**，未新增/删除任何 `API_ROUTES` 路由，未新增硬编码路由（本轮无 `organizer/sync` 那类未登记路由的情况）⇒ 旧客户端配对、鉴权、Range、WS 事件面不受影响。
- 本轮**未执行**上游仓自身 `npm test`（上游 22 个 pc-companion 测试文件 + 三包测试），故「上游自测全绿」属 **not-run**，不作为本阶段结论支撑。

### D. 上游构建链 —— 零变化（构建一次直跑成功，退出码 0）

- 区间内根 `package.json`、`tsconfig.base.json`、`scripts/` **变更文件数 0**（`git diff --name-only b422193..b397e0e -- package.json tsconfig.base.json scripts | wc -l` → `0`）⇒ 构建命令、`build:pc` 编排序（上一轮 R10 修复后的 `tsc && build-wechat-runtime.mjs`）、产物布局**均未变**；上游依赖声明未变 ⇒ 本阶段**未在上游执行 `npm install`**。
- 实测构建：`cd ../NikkiSync && npm run build` 两次执行，`BUILD_EXIT=0`，stdout 无 error/warn；产物 mtime `2026-10-29 18:47`，含 4 个本轮新模块的编译产物（`dist/src/server/{AccountSyncSettings,MediaFingerprint,VersionAssetPages}.js`、`dist/src/organizer/NativeMediaOperations.js`）。
- 构建后上游 `status --porcelain` 仍 **0 行** ⇒ `dist/` 被上游自身 gitignore 覆盖，本阶段未污染上游仓；`git diff --name-only` 空 ⇒ 零被跟踪文件改动（铁律守住）。
- 被本仓打包核查点名的产物：`scripts/pre-dist-check.ts:726` 单独点名 `row-mappers.js`（缺失即 fail 并点名）；`scripts/verify-nikkisync-link.ts` 的三张清单 `SYNC_SERVER_REQUIRED_ARTIFACTS`(2) + `METADATA_REQUIRED_ARTIFACTS`(2) + `NIKKISYNC_CAPABILITY_ARTIFACTS`(7) 在目标态**全部在位**（`verify:nikkisync` 第 5/6/7 项实测 ✓）。
- **清单缺口（新发现的闸门盲区）**：目标态 `dist/src/server/row-mappers.js` 第 1-3 行静态 `import { mediaFingerprint } from './MediaFingerprint.js'`，而 `server/MediaFingerprint.js` **不在上述任何闸门清单**（也不在 `pre-dist-check` 点名项）。后果：打包态若该文件未被解包，`row-mappers.js` 装载即 `ERR_MODULE_NOT_FOUND`，但闸门不会先红——属「缺件被推迟到运行期」。列入 §8-R4 与 §10-Q3。

### E. 新配置项与新服务能力（逐项定位上游实现位置）

| 新能力/配置                                    | 上游实现位置【事实】                                                                                                                                                                                                                                                            | 引入提交  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 账号同步作用域（哪些账号/来源目录参与同步）    | `apps/pc-companion/src/server/AccountSyncSettings.ts`（新增 54 行）；`LocalSyncServer` 构造期接入；`packages/database/src/sync-read-repository.ts` 的 `sourceScopePredicate`/`scope()`                                                                                          | `b397e0e` |
| 目录来源标记（`spinning_momo` / `other`）      | `apps/pc-companion/src/scanner/types.ts`（`ExtraScanRoot.source?`）+ `scanner/ExtraScanDirectories.ts`（`inspect(source?)`、`setSource`、`onSourcesChanged`）                                                                                                                   | `b397e0e` |
| 媒体指纹（批量删除的幂等校验依据）             | `apps/pc-companion/src/server/MediaFingerprint.ts`（新增，仅依赖 `node:crypto`）；`organizer/DeletionQueue.ts` 用 `plan.mediaFingerprint` 取代纯 revision 比对                                                                                                                  | `b397e0e` |
| 版本优先分页（gallery 按游戏版本分组）         | `apps/pc-companion/src/server/VersionAssetPages.ts`（新增 12 行）；被 `GameVersionEnglishNames`/`GameVersionUpdateService` 的 `for (const row of versionAssetPages(db))` 取代原 `assets.list()` 全表扫描                                                                        | `b397e0e` |
| 原生媒体操作（导出副本枚举 / 批量回收 / 预览） | `apps/pc-companion/src/organizer/NativeMediaOperations.ts`（`nativePreview`、`recycleMany`）；`runtime.ts:66` 注入 `DeletionQueue` 第 7 参（行号实读目标态）                                                                                                                    | `b397e0e` |
| 游戏版本 `tentative` 语义 + 官方公告精确边界   | `server/GameVersionCalendar.ts`（`VersionRelease.tentative?` + `2.11` 行 + `setRemoteGameVersionReleases` 覆盖规则）；`server/GameVersionUpdateService.ts`（新增 `parseOfficialReleaseNotices()`、`fetchOfficialPage(signal,url)` 双源候选、`OFFICIAL_NOTICES` Steam 公告端点） | `b397e0e` |
| 大库缓存与批量回收核验（回收站「已核实」链路） | `organizer/DeletionQueue.ts`（+142/−29：预览 LRU 96 项/32MB 上限、`dismiss()`、整批 `authorized:` 批准、`recycleMany` 分块 1000）；`scanner/ScannerService.ts`（`exactExportCopies`、`exportsByImage` 索引 `ScreenShot` 目录）                                                  | `fc39fd2` |
| gallery 排序索引                               | `packages/database/migrations/0001_initial.sql`（`idx_assets_gallery_order`）                                                                                                                                                                                                   | `fc39fd2` |
| NUAN5 解析器请求完成冷却                       | `metadata/Nuan5CompatibleResolver.ts`（`finally` 内 `nextRequestAt = max(nextRequestAt, now + (minIntervalMs ?? 1000))`）                                                                                                                                                       | `b397e0e` |
| Steam 公告英文名校验放宽                       | `server/GameVersionEnglishNames.ts`（标题正则 `\b(?:Version\s*\|V)`；`if(!changed.size)return` 提前返回）                                                                                                                                                                       | `b397e0e` |

## 5. 本仓现状基线（链接 → 构建 → 体检 → 测试）

1. **建链**：`npm run link:nikkisync` → `[link:nikkisync] root=D:\Workbuddy 项目\WXNN YD - 副本\NikkiSync source=sibling mode=apply`，四行 `ok`（core/database/protocol/pc-companion），`done (0 link(s) written)`（四条早已在位，本次为幂等复核）。
2. **只读检查**：`npm run link:nikkisync:check` → `[link:nikkisync] check OK (all four links in place)`。
3. **链接体检**：`npm run verify:nikkisync` → **12 项全 ✓，`OK (blocking failures: 0)`**，exit 0。第 10 项「a NikkiSync checkout is discoverable」为 `skipped (links already in place; candidate root is irrelevant)`（受支持的正常语义，非失败）。逐项含：依赖图自包含、四条链在位、四包 `dist/src/index.js + index.d.ts` 双存在、`migrations/0001_initial.sql` 可读、`LocalSyncServer.js` + `GalleryRuntime.mjs`、`Nuan5CompatibleResolver.js` + `MetadataResolutionDiagnostics.js`、能力深入口 7 件、`dist/main/main/app/*.js` 零 `require("@nikkisync` 折叠、`app.asar.unpacked` 含 schema、`node:sqlite` 可导入（node 26.x）、electron 41.10.6。
4. **测试读数（全部真实执行，skip 计数为 0）**：

   | 口径                         | 命令                                                                                                                                                                       | 实测读数                                                                                                  |
   | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
   | 域测试（上一轮 §5.2 同口径） | `npx vitest run src/main/nikkisync`                                                                                                                                        | **Test Files 1 failed \| 15 passed (16)；Tests 1 failed \| 275 passed (276)；Duration 22.30s；0 skipped** |
   | 链接/自包含脚本套件          | `npx vitest run scripts/__tests__/{link-nikkisync,verify-nikkisync-link,self-contained-deps}.test.ts`                                                                      | **Test Files 3 passed (3)；Tests 44 passed (44)；Duration 490ms**                                         |
   | 合并口径（上一轮 §5 同口径） | `npx vitest run src/main/nikkisync scripts/__tests__/link-nikkisync.test.ts scripts/__tests__/verify-nikkisync-link.test.ts scripts/__tests__/self-contained-deps.test.ts` | **Test Files 1 failed \| 18 passed (19)；Tests 1 failed \| 319 passed (320)；Duration 22.51s；0 skipped** |
   - 文件数与用例总数（16 / 276）与上一轮结案基线**逐位相同** ⇒ 本仓在上一轮之后未增删域内用例；变化的只是 1 条用例的判定结果。
   - **链接门控用例 skip = 0**（无任何 `skipped` 行）⇒ `hasNikkiSyncLink()` 为真、链接态集成真实执行：`runtime-facade.linked`（真实扫描入库）、`sync-server.linked`（13 例，真起 TLS 服务 + Ed25519 + 配对 + Range + WS，21.75s）、`metadata-resolver.linked`、`metadata-resolver.isolation`（`node:sqlite` 真跑上游 SQL）、`probe`、`protocol-drift` 全部到位。
   - 与上一轮对照（仅对照，非照抄）：上一轮合并口径 19 files / 259 tests 全绿；本轮 19 files / 320 tests（本仓 45 个后续提交新增了用例）。

### 5.1 唯一红灯：K3 游戏版本日历边界断言（归因、判据与实测证据）

| 维度         | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 失败点       | `src/main/nikkisync/runtime-facade.linked.test.ts:408` → `expect(infer('2027-01-01T00:00:00.000Z')).toBe('2.10')`，实收 `'2.11'`（`AssertionError: expected '2.11' to be '2.10'`）                                                                                                                                                                                                                                                                                              |
| 被测对象     | `surface.gameVersionCalendar.inferInfinityNikkiGameVersion`（上游深入口 `server/GameVersionCalendar.js`，本仓装载真实产物、非桩）                                                                                                                                                                                                                                                                                                                                               |
| 归因         | **上游数据变更触发，非本仓既存失败**。判据一：`git -C ../NikkiSync log --oneline -S"version:'2.11'" b422193..b397e0e -- apps/pc-companion/src/server/GameVersionCalendar.ts` → `b397e0e`（本轮目标提交新增该行）。判据二：`git show b422193:...GameVersionCalendar.ts \| grep -c "2\.11"` → **0**；`git show b397e0e:...` → **2**（注释 + 数据行）。判据三：该用例自带注释「实测表（b422193）：…最新 2.10=2026-09-24T03:00Z」，即断言把**基线时点的上游表内容**硬编码为永久期望 |
| 实测读数     | 直接 import 目标态 `dist/src/server/GameVersionCalendar.js`：`releases count = 24`；`newest = {version:'2.11', effectiveAt:'2026-10-30T07:00:00.000Z', uncertainFrom:'2026-10-29T19:49:00.000Z', tentative:true}`；`second newest = {version:'2.10', effectiveAt:'2026-09-24T03:00:00.000Z'}`；`infer(2026-10-29T10:53Z 即当下) = '2.10'`；`infer(2027-01-01) = '2.11'`                                                                                                         |
| 用户可见影响 | **今日无错标**：`2.11` 的 `effectiveAt` 是 2026-10-30T07:00Z（晚于当下），故对现有照片的实际推断仍为 `2.10`；2026-10-30 07:00Z 起自动变为 `2.11`。红灯只发生在「取未来时刻 ⇒ 期望等于当前最新稳定版」这一断言形态上                                                                                                                                                                                                                                                             |
| 性质判定     | 上游侧属**合法数据演进**（新增一个版本边界行 + `tentative` 语义），非 API 破坏；本仓侧属**测试判据选型缺陷**——把随时间必然变化的上游数据表内容当作不变量钉住。同类脆弱点在 `runtime-facade.linked.test.ts:404-407`（历史边界 1.4/1.3/早于 1.0）仍有效，因为只有历史边界不会变；仅「未来时刻」这一支会被任何一次新版本发布打红                                                                                                                                                   |
| 半径         | 全仓 `grep -rn "2\.10" src/` 中与上游日历相关的**仅此一处**（`:403` 注释 + `:408` 断言）。其余 `2.10` 命中经逐条甄别为无关：`src/renderer/utils/resonance/*` 是本仓自有卡池快照口径的「上游 2.10.1 图鉴」（游戏数据，不是 NikkiSync 日历）；`src/main/utils/fluent-ffmpeg-shim*`、`src/main/thumbnail/generator.eftype.test.ts` 是 npm 包 `async@0.2.10`。`grep -rn "2\.11" src/` → **0 命中**                                                                                  |
| 本阶段处置   | **不修**（阶段一禁改业务代码）。处置选项见 §10-Q1，需用户裁决后在阶段二落地                                                                                                                                                                                                                                                                                                                                                                                                     |

## 6. 能力对齐清单（上游新能力/新符号 vs 本仓对应面）

判定方法：`grep -rl <符号> src/ --include="*.ts" --include="*.tsx"`（命中后再人工甄别同名）。四类判定 = 已有对应面 / 零对应面（可选接入项）/ 随链接自动生效无需动作 / 不适用。

| #   | 上游新能力或新符号                                                                                             | 引入提交  | 本仓 `src/` 命中【事实】                                                                                                                                                                                        | 判定                                     | 说明与依赖                                                                                                                                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `AccountSyncSettings`（账号同步作用域）                                                                        | `b397e0e` | **零命中**（`AccountSync` 全域 0）                                                                                                                                                                              | 零对应面（可选接入项）                   | 上游据此过滤 `SyncReadRepository` 读面并推 `accounts.revision()`；接入要配设置键 + UI + #6 漂移跟随                                                                                                             |
| 2   | `MediaFingerprint` / `AssetSummary.mediaFingerprint`                                                           | `b397e0e` | **零命中**                                                                                                                                                                                                      | 零对应面（可选接入）+ **闸门清单缺口**   | 但 `row-mappers.js` 已静态依赖它 ⇒ 打包态缺件风险见 §8-R4                                                                                                                                                       |
| 3   | `VersionAssetPages`                                                                                            | `b397e0e` | **零命中**                                                                                                                                                                                                      | 不适用（上游内部查询优化）               | 服务于上游自家英文名/日历刷新任务，本仓不调度该服务                                                                                                                                                             |
| 4   | `NativeMediaOperations`（`recycleMany` / `nativePreview`）                                                     | `b397e0e` | **零命中**                                                                                                                                                                                                      | 随链接自动生效（经 `runtime.deletions`） | 由上游 `runtime.ts` 装配进 `DeletionQueue`；本仓不构造 ⇒ 行为自动升级，但 K8 回收批处理语义需在真机复验                                                                                                         |
| 5   | `DeletionQueue.dismiss()` / `list(device, requested?)` / `FilePlan` / `FileResult` / 整批 `authorized:`        | `b397e0e` | `dismiss` 命中 12 个渲染层文件，**逐条甄别为本仓自有 Toast/Dialog `dismiss()` API，与上游无关**；`DeletionQueueLike` 未声明 `dismiss`                                                                           | 零对应面（可选接入项）                   | 若要接「批量忽略失败项」需在 `runtime-types.ts` 扩声明 + 新通道 + i18n                                                                                                                                          |
| 6   | `ExtraScanRoot.source?` / `ExtraScanDirectories.setSource()` / `onSourcesChanged`                              | `b397e0e` | `setSource` 命中 5 个渲染层/store 文件，**逐条甄别为本仓自有 `mediaStore.setSource` 等，无关键**；本仓 K6 面 `ExtraScanDirectoriesLike` 未声明 `setSource`                                                      | 已有对应面（K6），新字段/方法未接入      | `state().directories[].source` 会经 `nikkisync:extra-directories` 透传到渲染层（`stripExtraDirectoriesState` 只删顶层 `message`）——契约新增键，见 §10-Q4                                                        |
| 7   | `ScannerService.exactExportCopies()` / `exportsByImage`（`ScreenShot` 精确字节抑制）                           | `fc39fd2` | **零命中**                                                                                                                                                                                                      | 随链接自动生效（上游扫描内部）           | 影响同步库的去重判定，本仓无需动作；若接入需先定义与本仓自有扫描器的关系                                                                                                                                        |
| 8   | `VersionRelease.tentative?` + 官方公告精确边界（`parseOfficialReleaseNotices`、Steam `OFFICIAL_NOTICES` 端点） | `b397e0e` | `tentative` **零命中**；本仓 K3 面仅消费 `inferInfinityNikkiGameVersion`                                                                                                                                        | 已有对应面（K3），新语义未接入           | 接入 `tentative` 需处理「日期级边界可被精确维护时间覆盖」的展示口径；`GameVersionUpdateService` 是**出站 HTTP**，本仓从不 arm 它                                                                                |
| 9   | `AssetSummary` 的 `sourcePath` / `sourceFolder` / `sizeBytes` / `*Sha256` / `fullPreviewResourceId`            | `b397e0e` | `sourceFolder`、`fullPreviewResourceId`、`thumbnailSha256` 等**零命中**                                                                                                                                         | 随链接自动生效（本仓 DTO 零转换透传）    | **本机绝对路径与父目录自此进入 `nikkisync:*` 响应载荷**；隐私与契约影响见 §8-R7，需裁决是否显式过滤                                                                                                             |
| 10  | `Nuan5CompatibleResolver` 完成冷却（`minIntervalMs ?? 1000`）                                                  | `b397e0e` | `minIntervalMs` 在本仓**只出现在 `runtime-facade.ts:103` 的注释里**（记录上游构造参清单）；实际构造点是 `runtime-facade.ts:654` 的 `new ResolverCtor({ endpoint })` ⇒ **本仓不下发该键**，冷却取上游默认 1000ms | 随链接自动生效（默认值生效）             | 解析节流变严 ⇒ 本仓有界驱动循环（`metadata-resolver-driver.ts`，以 `runOnce()` 返回 0 收敛）会更早结束（吞吐变化，非失败）；`metadata-resolver.linked` 本轮实测通过。若要保持既定吞吐需显式下发 `minIntervalMs` |
| 11  | `GET /v1/changes` 判据新增 `after < accounts.revision()` 一支                                                  | `b397e0e` | 本仓 `runtime-facade.ts:548` 仍为旧判据（逐字比对已漂移）                                                                                                                                                       | 已有对应面（需跟随）                     | 当前无行为差（本仓不走作用域）；接入 #1 时必须同步，否则漏发全量重同步。见 §10-Q2                                                                                                                               |
| 12  | `SyncReadRepository` 构造期 `allowedUids` / `sourceGroups` + `sourceScopePredicate()`                          | `b397e0e` | 本仓以单参构造（`runtime-facade.ts:434`），`sourceScopePredicate` **零命中**                                                                                                                                    | 兼容保留（scope = `1=1`）                | 若接入作用域需同时扩 `SyncReadRepositoryLike` 声明与 `row-mappers` 面                                                                                                                                           |
| 13  | `idx_assets_gallery_order`（大库分页索引）                                                                     | `fc39fd2` | 本仓不写上游 SQL（`metadata-isolation-guards` 表级隔离谓词）                                                                                                                                                    | 随链接自动生效                           | 机制上每次 `initialize()` 全量幂等重放 ⇒ 老库自动补齐（§4-B）                                                                                                                                                   |
| 14  | 上游 `desktop/AccountSyncPanel.ts`、`DesktopControlServer.ts`、`windows-app.ts` 变更                           | 两者      | 不在本仓 `*_DEEP_ENTRY` 装载清单；本仓桌面壳为 Electron `src/main/app/`                                                                                                                                         | 不适用（同上一轮 #11/#12 口径）          | 上游自家壳/服务进程拓扑，本仓无对应拓扑                                                                                                                                                                         |

## 7. 建议的后续阶段大纲（供评审取舍，非承诺）

- **阶段 2（必做，唯一被迫项）**：修 §5.1 红灯——把「未来时刻」这一支从硬编码常量改为**从上游表实读**（`getGameVersionReleases()[0].version` 派生期望），或在断言里显式钉住「取到的是当前表内最新项」。同时把 `:403` 的「实测表（b422193）」注释加时间限定，避免下次同步再被当事实读。
- **阶段 2 同期**：`runtime-facade.ts:548` 判据与 `src/main/nikkisync/AGENTS.md` 的「逐字同上游」表述二选一处置（跟随上游加作用域修订支，或在注释里写明本仓刻意不含作用域的理由与影响面）。
- **阶段 2 闸门补齐**：把 `server/MediaFingerprint.js`（以及若接入的 `VersionAssetPages.js`/`AccountSyncSettings.js`）纳入 `NIKKISYNC_CAPABILITY_ARTIFACTS` 或 `pre-dist-check` 点名清单——判据是「被静态 import 且已在本仓装载链上」。
- **阶段 3（隐私与契约卫生，需产品/安全裁示）**：决定是否在 `nikkisync-handler` 侧显式过滤 `sourcePath`/`sourceFolder`/`sizeBytes`/`*Sha256`（或反向：正式登记进 `docs/IPC_CONTRACT.md` 与 `runtime-types.ts` 声明面）。
- **阶段 4（可选能力接入）**：`AccountSyncSettings` 作用域面（#1，含 #11 判据跟随）、`DeletionQueue.dismiss`（#5）、`ExtraScanDirectories.setSource` 与目录来源标注（#6）、`VersionRelease.tentative` 展示口径（#8）。
- 每阶段含代码改动，须先落盘独立实施计划并经批准；触碰 `src/main/ipc/handlers/`、`src/main/preload/api/`、`src/main/services/`、`src/shared/errors/` 时携带 `// @core-change:` 注释并过提交面闸门。

## 8. 风险登记册

| #   | 风险                                                                                         | 等级   | 现状与缓解（含实测判据）                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 本仓 `npm install` 剪掉 `node_modules/@nikkisync` junction                                   | 中     | 本阶段全程未 install（建链前后各复核四条在位）。后续任何 install 后必须 `npm run link:nikkisync` + `npm run verify:nikkisync` 复验，否则链接态用例集体降级 skip、把真实回归藏起来                                                                                       |
| R2  | 上游可达性不稳定（`github.com:443` 间歇不通）                                                | 中     | 本阶段实测：`ls-remote` 首试失败、重试即通，`fetch` 一次成功。后续阶段若 fetch 失败应换通道重试（`-c http.version=HTTP/1.1`），不要一次失败即判定阻断；亦不得改用 API-only 评估冒充链接态证据                                                                           |
| R3  | 上游公测节奏导致「测试断言钉上游时点数据」反复打红（本轮已发生）                             | **高** | 本轮唯一红灯即此类（§5.1）。缓解：阶段 2 把「最新版本/未来时刻」类期望改为从产物派生；历史边界断言保持不变                                                                                                                                                              |
| R4  | 深入口产物新增静态依赖，但目标文件不在任何闸门清单 ⇒ 缺件推迟到运行期暴露                    | 中     | 事实：`dist/src/server/row-mappers.js:3` `import { mediaFingerprint } from './MediaFingerprint.js'`；`MediaFingerprint.js` 未被 `verify:nikkisync` 三张清单与 `pre-dist-check` 点名项覆盖。缓解：阶段 2 补清单（§7）                                                    |
| R5  | vendored 契约（`src/shared/sync/`）与上游形状长期漂移，运行时断言不可捕获                    | 中     | `AssetSummary` 9 个新可选键在 vendored 类型面**无对应**（`domain-types.ts` 零命中）；`protocol-drift.test.ts` 本轮绿只证明**运行时值面**零差异，不覆盖 interface。缓解：阶段 3 做类型面跟进并明确「刻意不同步」的条目                                                   |
| R6  | `listSuitSearchResources()` 语义收窄（孤儿 resource 不再返回）                               | 低     | 本仓 `runtime-facade.ts:461` 消费该方法；本仓链接态与桩测试全绿。缓解：后续若上游库出现孤儿资源场景，按实测复核，不预设问题                                                                                                                                             |
| R7  | `AssetSummary.sourcePath`/`sourceFolder` 经透传进入 IPC 响应载荷（本机绝对路径外泄至渲染层） | 中-高  | 判据：本仓查询面为零转换透传 + `stripExtraDirectoriesState` 类过滤器不覆盖该键；渲染层目前无消费点（`sourceFolder` 零命中）。缓解：阶段 3 显式裁示过滤或登记；在裁示前不得新增把这些键写入日志/分享卡片/导出元数据的路径                                                |
| R8  | 新能力接入触碰核心路径闸门                                                                   | 中     | `src/main/ipc/handlers/`、`src/main/preload/api/`、`src/main/services/`、`src/shared/errors/` 改动需 `// @core-change:` 真实原因注释 + `scripts/core-path-gate.ts` 同批放行                                                                                             |
| R9  | 破坏性能力（批量删除回收）行为面变更但无自动化真机证据                                       | 中     | `DeletionQueue` +142/−29（预览 LRU、整批 `authorized:`、`recycleMany` 分块 1000、`mediaFingerprint` 取代纯 revision 比对）；本仓 K8 全套用例刻意不触发 `executing` 态（上一轮 §6.1/§8-M3 已记「无自动化证据」）。缓解：后续阶段必须补真机验证清单，不得以单测绿冒充可用 |
| R10 | 隐私合规面：上游新增出站抓取（Steam 公告 `OFFICIAL_NOTICES`）与账号作用域                    | 中     | 本仓从不 arm `GameVersionUpdateService`（`runtime-facade` 仅消费日历表纯函数）⇒ 当前零出站。缓解：任何后续接入须带与 K2 同级 fail-closed 同意门                                                                                                                         |
| R11 | 上游自测未跑（本轮 not-run）                                                                 | 低     | 本阶段只跑本仓链接态套件；「上游自身 22 个 pc-companion 测试全绿」**未取证**，若需要须在上游 `npm test` 单独取证                                                                                                                                                        |

## 9. 验收自检（本阶段停止门）

- [x] 基线双向交叉认定通过：上一轮记载 `b422193` == fetch 前检出 HEAD `b422193`（无矛盾，无需询问）
- [x] 上游零分叉、仅 fast-forward 前进（`rev-list --left-right --count` = `0 2` → `merge --ff-only`）
- [x] 上游被跟踪文件零修改、零改动丢失：fetch 前 / ff 后 / 构建后三次 `status --porcelain` = **0 行**，`git diff --name-only` 空
- [x] 上游完整构建真实执行且 `BUILD_EXIT=0`，17 个深入口产物逐项在位
- [x] 链接真实建成（四 junction + `check OK`），`verify:nikkisync` **12 项全 ✓ / blocking failures: 0 / exit 0**
- [x] 本阶段未执行 `npm install`（无剪链事实需登记）
- [x] 链接门控用例 **skip = 0**，链接态 5 个集成/守护套件真实执行
- [ ] **绿灯基线不达成**：域测试 1 failed / 275 passed（§5.1 红灯已归因到上游 `b397e0e` 新增 `2.11` 日历行，非本仓既存、非环境伪装）
- [x] 每条结论附命令与实测读数；未取证项显式标注（`R11` 上游自测 = not-run）
- [x] 未修改本仓任何业务代码、未做任何 git 提交（工作区仍只有既存的未跟踪 `release-sync/`）
- **停止门结论：本阶段到此停止。红灯 + 3 处待裁决项须先裁示，不得带问题进入阶段二。**

## 10. 需要裁决的事项（评审时请逐条给结论）

| #   | 待裁决                                                                                                                    | 我的建议                                                                                  | 若不同意的影响                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Q1  | §5.1 红灯的修法方向：**把「未来时刻」期望改为从上游表派生**，还是仅把常量从 `2.10` 更新为 `2.11`                          | 前者（派生）。后者每遇一次上游版本发布必再红一次，R3 不闭环                               | 选后者则接受「每次同步都要手改一行测试」的固定成本                                             |
| Q2  | `runtime-facade.ts:548` 增量变更判据漂移：现在跟随上游加 `accounts.revision()` 一支，还是留到接入账号作用域（#1）时一起改 | 留到 #1 接入时一起改，但**现在**就把 `AGENTS.md` 的「逐字同上游」表述加时间限定与差异说明 | 现在跟随则需为本仓不存在的作用域设计 `revision()` 取值来源（本仓不构造 `AccountSyncSettings`） |
| Q3  | 是否把 `MediaFingerprint.js` 纳入产物闸门清单（R4）                                                                       | 纳入（它已在被装载的 `row-mappers.js` 的静态依赖链上）                                    | 不纳入则打包态缺件只能在运行期以 `ERR_MODULE_NOT_FOUND` 暴露                                   |
| Q4  | `AssetSummary` 新增的 `sourcePath`/`sourceFolder` 等键：显式过滤，还是正式登记进契约并声明面                              | 先显式过滤（保持「渲染层拿不到本机绝对路径」的既有姿态），接入需求出现再登记              | 不处理则新增外泄面在无人登记的状态下长期存在（R7）                                             |
| Q5  | 本轮同步锚点是否改用 tag（`v1.0.27-public-beta.1` = `b397e0e`，与当前 `origin/main` HEAD 同值）                           | 文档同时记 SHA 与 tag，后续阶段按 tag 复核                                                | 仅记滚动 main 则上一轮 R5（节奏漂移）风险重现                                                  |

### 10.1 裁决结论（2026-10-29 阶段二评审落地，Q1–Q5 全部按建议采纳）

| #   | 结论                                                                                                                                                                                                                                                   | 落点                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| Q1  | **从上游产物表派生期望**：取 `getGameVersionReleases()` 中 `effectiveAt` 最大行，断言 `infer(该行 effectiveAt + 1000ms)` 等于该行 `version`；不钉版本常量、不钉「当下时刻」                                                                            | N1（`runtime-facade.linked.test.ts:398-412`） |
| Q2  | **仅订正文档**，不动 `runtime-facade.ts:548` 行为；四处同源表述加时间限定与豁免理由                                                                                                                                                                    | N2                                            |
| Q3  | **纳入闸门**，且范围由本文原记的 1 个模块订正为 **3 个**（见下「订正」），机制为新增一张共享清单而非并入 capability 清单                                                                                                                               | N3                                            |
| Q4  | **显式过滤** `sourcePath`/`sourceFolder`，落点在 `runtime-manager.ts` 委托层（不碰 handler，避开核心路径闸门与身份 `toBe` 钉测）；`sizeBytes`/`*Sha256`/`fullPreviewResourceId`/`mediaFingerprint` 不过滤也不登记，保持 vendored `AssetSummary` 不扩面 | N4                                            |
| Q5  | 文档同时记 SHA `b397e0e…` 与 tag `v1.0.27-public-beta.1`，后续阶段按 tag 复核                                                                                                                                                                          | N0/N5，已落盘文档均按此记载                   |

**对本文 §4-A / §10-Q3 的事实订正（阶段二实测）**：本轮 `b422193..b397e0e` 新增 **3 条**静态 import 边，把 **3 个全新模块**推进本仓装载链，三者都不在任何闸门清单内——`server/MediaFingerprint.js`（← `row-mappers.js:3`，本仓深入口）、`server/AccountSyncSettings.js`（← `LocalSyncServer.js`，该文件已闸门但此依赖未闸门）、`organizer/NativeMediaOperations.js`（← `runtime.js`，在桶导出 `index.js:4` 闭包内）。闭包实测法：以 `dist/src/index.js` + 12 个 `*_DEEP_ENTRY` 为根递归解析相对 `import`/`export from`，得 50 个装载链模块、34 个未被任何清单点名（33 个属既存缺口，本轮新增缺口即上述 3 个）。`VersionAssetPages.js` 与 `desktop/AccountSyncPanel.ts` 不在闭包内，本文 §6#3「不适用」判定成立。

**阶段二追加的七项默认裁决（用户授权按计划推荐值执行，未再逐条回问）**：Q-a 本轮不重打包（`verify:dist` 新块未建链时 `skip`，打包面证据推到下一次发布计划）；Q-b 另起 `03-执行记录` + `05-结案报告`；Q-c 登记一条技术债（新清单是命名清单而非闭包）；Q-d 不清理与本轮无关的失效序号，只在结案记为已知失真；Q-e 补跑上游自测取证（R11 由 not-run 转正或如实记录失败）；Q-f K8 真机破坏性删除链尽力取证，做不到即显式记 not-run 不以单测绿冒充可用；Q-g 本评估与 02 计划一并入仓。

明细、节点三要素、验证矩阵与回滚方案见 [02 实施计划](../../2026-10-29-nikkisync-upstream-sync-02-实施计划.md)。

## 附：证据命令附录（全部于 2026-10-29 在本机实际运行，读数以原文为准）

```bash
# ── 环境与本仓 ─────────────────────────────────────────────────────────────
node -v && npm -v && git --version && echo "NIKKISYNC_ROOT=[$NIKKISYNC_ROOT]"
git rev-parse --abbrev-ref HEAD && git rev-parse HEAD && git status --porcelain
node -e "const p=require('./package.json');console.log(p.name,p.version,JSON.stringify(p.engines))"
ls vendor                      # → No such file or directory
ls -la node_modules/@nikkisync # 四条 junction
ls src/main/nikkisync | wc -l  # 31

# ── 上游检出与网络 ─────────────────────────────────────────────────────────
git -C ../NikkiSync remote -v
git -C ../NikkiSync rev-parse HEAD                 # fetch 前 → b422193（基线交叉认定）
git -C ../NikkiSync status --porcelain | wc -l     # 0
git ls-remote origin refs/heads/main               # 首试失败(21s 超时)，重试 2 次 → b397e0e
curl -sS --ssl-no-revoke -m 15 -o /dev/null -w "%{http_code}" https://github.com              # 28 超时
curl -sS --ssl-no-revoke -m 15 -o /dev/null -w "%{http_code}" https://api.github.com          # 200
curl -sS --ssl-no-revoke -m 15 -o /dev/null -w "%{http_code}" https://codeload.github.com     # 301
curl -sS --ssl-no-revoke -m 15 -o /dev/null -w "%{http_code}" https://raw.githubusercontent.com # 35 reset
curl -sS --ssl-no-revoke "https://api.github.com/repos/ToStardust/NikkiSync/compare/b422193...b397e0e"  # ahead_by 2 / 83 files / 消费面内 34（plan 期只读取证）

# ── 上游整合与构建 ─────────────────────────────────────────────────────────
git -C ../NikkiSync fetch origin
git -C ../NikkiSync rev-parse origin/main
git -C ../NikkiSync rev-list --left-right --count main...origin/main    # 0	2
git -C ../NikkiSync merge-base --is-ancestor b422193 origin/main        # exit 0
git -C ../NikkiSync merge --ff-only origin/main
git -C ../NikkiSync status --porcelain | wc -l                          # 0（ff 后）
git -C ../NikkiSync tag --points-at fc39fd2 && git -C ../NikkiSync tag --points-at b397e0e
git -C ../NikkiSync log --oneline --no-decorate b422193..b397e0e
cd ../NikkiSync && npm run build                                        # BUILD_EXIT=0（两次）
git -C ../NikkiSync status --porcelain | wc -l                          # 0（构建后）
git -C ../NikkiSync diff --name-only | head                             # 空（零被跟踪改动）

# ── 体量与分类 ─────────────────────────────────────────────────────────────
git -C ../NikkiSync diff --stat b422193..b397e0e | tail -1              # 83 files, +2674, −199
git -C ../NikkiSync diff --name-only b422193..b397e0e -- packages apps/pc-companion package.json tsconfig.base.json scripts | wc -l   # 34
git -C ../NikkiSync diff --stat b422193..b397e0e -- . ':!packages' ':!apps/pc-companion' ':!package.json' ':!scripts' ':!tsconfig.base.json' | tail -1   # 49 files +1911 −104
git -C ../NikkiSync diff --name-only b422193..b397e0e -- package.json tsconfig.base.json scripts | wc -l    # 0
for s in fc39fd2 b397e0e; do git -C ../NikkiSync show --stat --format="%h %ad %s" --date=short $s | tail -1; done
for s in fc39fd2 b397e0e; do git -C ../NikkiSync show --name-only --format= $s | grep -cE "^(packages/|apps/pc-companion/|package.json|tsconfig|scripts/)"; done

# ── 五风险面实证 ───────────────────────────────────────────────────────────
git -C ../NikkiSync diff --stat b422193..b397e0e -- packages/core/src/index.ts packages/database/src/index.ts packages/protocol/src/index.ts
git -C ../NikkiSync diff b422193..b397e0e -- packages/protocol/src/index.ts packages/core/src/types.ts
git -C ../NikkiSync diff b422193..b397e0e -- packages/database/migrations        # 唯一 +1 行索引
git -C ../NikkiSync diff --stat b422193..b397e0e -- packages/database/src/database-manager.ts packages/database/scripts   # 空
git -C ../NikkiSync log --oneline b422193..b397e0e -- packages/database/migrations   # fc39fd2
git -C ../NikkiSync show b397e0e:packages/database/src/database-manager.ts | sed -n '45,51p'    # initialize() 全量 exec、无版本门控
git -C ../NikkiSync diff b422193..b397e0e -- packages/database/src/sync-read-repository.ts apps/pc-companion/src/server/row-mappers.ts apps/pc-companion/src/server/LocalSyncServer.ts apps/pc-companion/src/runtime.ts apps/pc-companion/src/scanner/types.ts apps/pc-companion/src/scanner/ScannerService.ts apps/pc-companion/src/scanner/ExtraScanDirectories.ts apps/pc-companion/src/metadata/Nuan5CompatibleResolver.ts apps/pc-companion/src/server/GameVersionCalendar.ts apps/pc-companion/src/server/GameVersionEnglishNames.ts apps/pc-companion/src/server/GameVersionUpdateService.ts
git -C ../NikkiSync show b422193:apps/pc-companion/src/server/GameVersionCalendar.ts | grep -c "2\.11"   # 0
git -C ../NikkiSync show b397e0e:apps/pc-companion/src/server/GameVersionCalendar.ts | grep -c "2\.11"   # 2
git -C ../NikkiSync log --oneline -S"version:'2.11'" b422193..b397e0e -- apps/pc-companion/src/server/GameVersionCalendar.ts   # b397e0e
git -C ../NikkiSync show b422193:apps/pc-companion/src/organizer/DeletionQueue.ts | grep -nE "^\s*(readonly |async )?[a-zA-Z_]+\(.*\).*[:{]|^export (interface|type|class|function)"   # 公开面前后对照
git -C ../NikkiSync show b397e0e:apps/pc-companion/src/organizer/DeletionQueue.ts | grep -nE "^\s*(readonly |async )?[a-zA-Z_]+\(.*\).*[:{]|^export (interface|type|class|function)"
grep -n "^import" ../NikkiSync/apps/pc-companion/dist/src/server/row-mappers.js            # 含 ./MediaFingerprint.js
for f in server/row-mappers.js server/SuitSearchIndex.js server/ClothingSearchIndex.js server/ProfileStatsIndex.js metadata/Nuan5CompatibleResolver.js metadata/MetadataResolutionDiagnostics.js metadata/CachedDecodedMetadataService.js metadata/MetadataOnlineConsent.js server/LanAddress.js server/GameVersionCalendar.js server/LocalSyncServer.js server/MediaFingerprint.js scanner/ExtraScanDirectories.js scanner/ScanDiagnostics.js scanner/ScanIndexFailure.js organizer/DeletionQueue.js wechat/GalleryRuntime.mjs; do [ -f "../NikkiSync/apps/pc-companion/dist/src/$f" ] && echo "OK $f" || echo "MISS $f"; done   # 17/17 OK
node --input-type=module - <<'EOF'   # 上游日历真实推断读数
const m = await import('file:///D:/Workbuddy%20%E9%A1%B9%E7%9B%AE/WXNN%20YD%20-%20%E5%89%AF%E6%9C%AC/NikkiSync/apps/pc-companion/dist/src/server/GameVersionCalendar.js');
console.log(m.inferInfinityNikkiGameVersion(new Date().toISOString()), m.getGameVersionReleases().length);  # 2.10 / 24
EOF

# ── 建链、体检与测试 ───────────────────────────────────────────────────────
npm run link:nikkisync && npm run link:nikkisync:check
npm run verify:nikkisync          # 12 ✓ / blocking failures: 0 / exit 0
npx vitest run src/main/nikkisync                                              # 1 failed | 15 passed (16)；275 passed | 1 failed (276)；0 skipped
npx vitest run scripts/__tests__/link-nikkisync.test.ts scripts/__tests__/verify-nikkisync-link.test.ts scripts/__tests__/self-contained-deps.test.ts   # 3 files / 44 tests 全绿
npx vitest run src/main/nikkisync scripts/__tests__/link-nikkisync.test.ts scripts/__tests__/verify-nikkisync-link.test.ts scripts/__tests__/self-contained-deps.test.ts   # 19 files / 320 tests，1 failed，0 skipped

# ── 本仓消费面对齐（能力清单与方法声明核对）────────────────────────────────
grep -rn "inferInfinityNikkiGameVersion\|resolveGameVersion\|gameVersionCalendar" src/ --include="*.ts" --include="*.tsx"
grep -rn "fullResync\|minimumJournalRevision\|listChangesAfter" src/main/nikkisync/*.ts src/shared/sync/*.ts
grep -n "fullResyncRequired" src/main/nikkisync/runtime-facade.ts             # :548 仍为旧判据
grep -rn "new DeletionQueue" src/                                             # 零命中
sed -n '156,176p' src/main/nikkisync/runtime-types.ts                          # DeletionQueueLike / ExtraScanDirectoriesLike
sed -n '233,246p' src/main/ipc/handlers/nikkisync-handler.ts                   # strip* 仅删顶层 message/hint
grep -rn "listSuitSearchResources\|SyncReadRepository" src/main/nikkisync/runtime-facade.ts
grep -rn "2\.10" src/ | head -20 ; grep -rn "2\.11" src/                       # 2.11 零命中
for sym in AccountSyncSettings MediaFingerprint VersionAssetPages NativeMediaOperations exactExportCopies mediaFingerprint fullPreviewResourceId sourceFolder batchVerification resultAck tentative setSource dismiss; do grep -rl --include="*.ts" --include="*.tsx" "$sym" src/; done
grep -n "REQUIRED_ARTIFACTS\|NIKKISYNC_CAPABILITY_ARTIFACTS" -A 14 scripts/verify-nikkisync-link.ts | head -45
grep -n "row-mappers" scripts/pre-dist-check.ts                               # :726 单独点名
```

---

## 11. 与前序系列的衔接（登记，不处理）

- 上一轮系列：[01 影响评估](2026-10-25-nikkisync-upstream-sync-01-影响评估.md) → [05 结案报告](2026-10-25-nikkisync-upstream-sync-05-结案报告.md)。本轮基线即上一轮目标，结构沿用其 01 骨架。
- 上一轮 01 §8 的 R4（vendored 契约与上游形状长期漂移）**本轮仍未闭环**，且新增 9 个 interface 可选字段使其进一步偏离（本文 R5）；上一轮 R5（建议锚定 tag）本轮由 Q5 重新提出；上一轮 R6/R7（核心路径闸门、删除语义）本轮继续适用。
- 上一轮 §8-M3/M4/M5 手动清单（K8 批量删除真机链）本轮**未重跑**，而 `DeletionQueue` 在本轮有 +142/−29 的行为面改动 ⇒ 若上一轮手动清单尚未执行，应在接入前一次性覆盖新行为（整批 `authorized:` 批准、`recycleMany` 分块、`mediaFingerprint` 校验）；此为 R9 的具体内容。
