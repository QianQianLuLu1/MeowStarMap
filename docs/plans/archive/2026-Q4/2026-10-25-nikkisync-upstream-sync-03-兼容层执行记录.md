# NikkiSync 上游同步 · 03 兼容层执行记录（阶段 3：C1–C6）

> 生成日期：2026-10-25 · 执行依据：已批准的 [`02-实施计划`](../../2026-10-25-nikkisync-upstream-sync-02-实施计划.md) §5
> 批准方式：用户裁示「计划整体批准，§14 六项待确认按提案裁示」（2026-10-25，已回填 02 文档状态行与 §14 裁示记录）
> 本仓 `main` 起点 `dc9f085`；阶段内提交：`b8c78e9`（docs(plans) 计划入库+批准回填）→ `c48a037`（feat(nikkisync) C2）→ `f43faa9`（docs(nikkisync) C3）→ `9bb771b`（feat(sync) C4）→ `505718c`（feat(nikkisync) C5）→ 收尾 `docs(plans)`（本档 + 02 §16 回填）
> 上游锚定 `b422193`（工作区全程 0 行 porcelain，本阶段零修改上游源码）
> 环境：Node v26.3.0 / npm 11.16.0 / git 2.55.0.windows.2 / electron 41.10.6；四条 junction 在位（12:53 建立），无需 install

---

## 0. 步骤 0 · 批准记录回填与计划入库

- 02 文档状态行由「等待人工批准」改为「已批准（计划整体批准，§14 按提案裁示）」；§14 追加裁示记录（Q1–Q6 全部按提案通过）。
- 提交 `b8c78e9`：01 影响评估 + 02 实施计划两文档入库（此前为未跟踪文件）。既有 `M package-lock.json` 全程不纳入任何提交。

## 1. C1 链接与基线复验（无代码，2026-10-25 14:00）

| #    | 命令                                                                                                                                                                       | 结果                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| C1-1 | `npm run link:nikkisync:check`                                                                                                                                             | `check OK (all four links in place)` ✓                               |
| C1-2 | `npm run verify:nikkisync`                                                                                                                                                 | 11 项全 ✓，`OK (blocking failures: 0)` ✓                             |
| C1-3 | `npx vitest run src/main/nikkisync scripts/__tests__/link-nikkisync.test.ts scripts/__tests__/verify-nikkisync-link.test.ts scripts/__tests__/self-contained-deps.test.ts` | Test Files 19 passed (19)，Tests 259 passed (259)，skip 0（16.06s）✓ |
| C1-4 | `git -C ../NikkiSync rev-parse HEAD && status --porcelain \| wc -l`                                                                                                        | `b4221933be9714fde0c260b1f19bdaa6d1337fd3`；0 行 ✓                   |

结论：与 01 影响评估 §5 的绿灯基线完全一致，环境就绪，直接进入 C2。

## 2. C2 探针必需导出表 + 深入口产物核查清单收紧（提交 `c48a037`）

### 2.1 红灯证据（先行写入、亲跑确认，2026-10-25 14:05）

`npx vitest run`（三个测试文件）→ **Tests 8 failed | 70 passed (78)**：

- `verify-nikkisync-link.test.ts`：能力检查四用例红——`AssertionError: expected [] to include '@nikkisync/pc-companion ships the cap…'`（第 12 项检查不存在）、`expected undefined to be true`（齐备支/未链接 warn 支）；结构契约红——`expected undefined to deeply equal [ …(7) ]`（`NIKKISYNC_CAPABILITY_ARTIFACTS` 尚不存在）。
- `pre-dist-check.test.ts`：断言核三用例红（`missingPackedCapabilityArtifacts` 尚不存在，导入失败）。
- `runtime-loader.test.ts`：`AssertionError: expected { …(6) } to match object { …(3) }`（core 导出表缺 decoded-metadata 三函数）。

覆盖意图：第 12 项链接检查的存在性与分档（缺件 fail / 未链接 warn / 字段缺席检查缺席）、7 项能力产物清单结构契约（与 pre-dist-check 共用单表）、打包断言核的缺失点名、core 桶导出探针面扩容。

### 2.2 改动文件清单

| 文件                                   | 改动                                                                                                                                                                                                                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/nikkisync/runtime-loader.ts` | `NIKKISYNC_REQUIRED_EXPORTS.core` 增 `mergePhotoMetadataGaps` / `normalizeNikkiGalleryPhoto` / `normalizeNuan5Photo → 'function'`（上游 b422193 桶导出，注释标注来源）                                                                                                                          |
| `scripts/verify-nikkisync-link.ts`     | 新常量 `NIKKISYNC_CAPABILITY_ARTIFACTS`（7 条 `path.join` 深入口产物）；`NikkiSyncLinkFacts.capabilityArtifactsMissing?`；`evaluateNikkiSyncLink` 第 12 项检查（已链接缺件=fail、未链接=warn skipped、字段缺席=检查缺席，沿 `metadataArtifactsMissing` 先例）；`collectNikkiSyncLinkFacts` 采集 |
| `scripts/pre-dist-check.ts`            | 引入共享表（单一真相源，不抄录）；新纯函数 `missingPackedCapabilityArtifacts(artifacts, exists)`（存在性探针注入，可单测）；`checkUnpackedNativeBinaries` 内 asar.unpacked 态逐项断言（齐→一条 pass、缺→逐项 fail 点名）                                                                        |
| 配套测试 ×3                            | 上述红灯用例（8 个）                                                                                                                                                                                                                                                                            |

### 2.3 绿灯与 verify 证据

- `npx vitest run`（同三文件）→ **78 passed (78)**，8 红全转绿。
- `src/main/nikkisync/probe.test.ts` → **8 passed (8)**（真实装载链上验证新三符号，探针逐个 OK）。
- `npm run verify:nikkisync` → **12 项全 ✓**（新增 `capability deep-entry artifacts` 项点名 7 产物全部 present），`OK (blocking failures: 0)`。
- `npm run verify` → 首跑 format ✗（pre-dist-check 长行），`prettier --write` 六文件后重跑 **5 项全 ✓**（typecheck 7766ms / lint / core-gate / format / test）。
- pre-commit（lint-staged + core-gate + tsc -b）全过，提交 `c48a037`，提交后 `git status --porcelain` 仅剩既有 `M package-lock.json`。

## 3. C3 迁移 SQL 收口（零适配）+ 老库升级安全分析

### 3.1 零适配事实（证据命令均于 2026-10-25 14:10–14:25 实跑）

| #   | 事实                       | 证据                                                                                                                                                                                                                               |
| --- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 上游本轮 migrations 零变化 | `git -C ../NikkiSync diff --stat d4ca7d7..b422193 -- packages/database/migrations packages/database/src/database-manager.ts packages/database/scripts` → **空输出**                                                                |
| 2   | 迁移文件仍仅一个           | `ls packages/database/migrations` → 仅 `0001_initial.sql`                                                                                                                                                                          |
| 3   | 建表全部幂等               | `grep -c "CREATE TABLE IF NOT EXISTS"` → **12**（全部业务表）                                                                                                                                                                      |
| 4   | 版本登记幂等且只此一条     | SQL 内 `CREATE TABLE IF NOT EXISTS schema_migrations` + `INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES (1, 'initial_asset_resource_sync_schema', …)`                                                   |
| 5   | 本仓单一真相源零改动       | schema 路径解析 = `src/main/nikkisync/embedding-paths.ts` 的 `resolveMigrationsSqlPath`/`readMigrationsSql` → 上游包内文件；**本仓无 vendored SQL 副本，无需任何适配**（C1 时 `verify:nikkisync` 第 4/8 项已实证可读、打包态可读） |

### 3.2 老库升级安全分析

既有 `{userData}/nikkisync/nikkisync.db` 用户在链接从 `d4ca7d7` 升到 `b422193` 后重开应用：

- `0001_initial.sql` 全 `CREATE TABLE IF NOT EXISTS`（幂等）+ `schema_migrations` 已登记版本 1 → **重开零迁移执行**；`INSERT OR IGNORE` 保证版本行不重复。已由 C3-3 链接态用例实证（§3.3）。
- 行为层变化仅两处，均为上游服务端内部语义、随链接自动生效，不触 schema：
  1. `AssetRepository.markMissingByRoots` 根路径比较从 `LIKE` 改为 `instr(r.path_key, ?) = 1`（物理目录别名修复，`cd44a41`）——占位符逐 root 绑定，**全参数绑定、无拼接注入面**；
  2. `reconcile` 在扫描完成上下文中清理「过时 LIVE 模糊匹配」孤儿资源（`asset.deleted` + 原因 `obsolete_motion_association`，事务内、FK 级联仅删候选，变更经 `supersededChanges` 带出）。
- **失败可诊断**：SQL 读取失败经 `readMigrationsSql` 归一为 `NikkiSyncAssetError`（消息内联双侧修复命令与实际路径）；装载失败经 `NikkiSyncLoadError` hint 指向 `npm run build` / `link:nikkisync`。
- **隔离护栏继续成立**：同步面写入仅落上游自有库文件 `nikkisync.db`，`metadata-isolation-guards.ts` 的表级隔离谓词与 `metadata-resolver.isolation.test.ts` 两档守护在本轮全量测试（C1-3 259 测）中全绿，未触碰本仓原有库表。

### 3.3 C3-3 链接态重开用例（零适配证明型）

`runtime-facade.linked.test.ts` 新增套件「同一库文件二次 createRuntimeSession 重开」：二次装配同一 db 文件 → 表清单与首次一致、`schema_migrations` 可读且恰为 `{version:1, name:'initial_asset_resource_sync_schema'}`、无异常。

**首跑即绿（11/11，2.83s）**——本用例属「零适配证明型」（节点目标是证明无需适配，而非暴露缺陷）：首跑绿即为结论证据；若红则零适配假设被推翻、须停止上报。本次结论：**老库重开升级路径安全、可重复、零迁移执行**。

### 3.4 回滚提示

上游四包导出只增不删、migrations 零变化 ⇒ 回滚任何兼容层节点都不产生 schema 变化，老库无兼容负担（与 02 计划 §12.5 一致）。

（C4/C5/C6/收尾记录随节点执行追加。）

## 4. C4 vendored 协议/域类型真相源同步（协议漂移归零）

### 4.1 执行偏差记录：红灯用例系工作区预置

C3 提交（`f43faa9`）之后、C4 开工之前，工作区出现三份**未提交**的预置改动：`src/shared/sync/protocol.test.ts`（多 host 五用例）、`src/main/nikkisync/protocol-contract.ts`（三组配对采样与快照键）、`src/main/nikkisync/protocol-contract.test.ts`（采样断言）——内容经逐行审查与 02 计划 C4-3/C4-4 **逐条一致且无越界**（采样值与上游语义吻合：host 参与去重、截断 8、`protocol` 数值串、单 host NS1 回归锚），按「红灯先行」语义采纳为本节点红灯用例，随节点一并提交；来源为会话外（用户或并行会话）预置，如实记录。

### 4.2 红灯证据（2026-10-25 14:35–15:10）

`npx vitest run src/shared/sync/protocol.test.ts src/main/nikkisync/protocol-contract.test.ts src/main/nikkisync/protocol-drift.test.ts` → **Tests 6 failed | 38 passed (44)**：

- `protocol.test.ts` 4 用例红：`AssertionError: expected false to be true`（双 host 前缀）、`expected null to be 'server_1'` / `'192.168.1.5,192.168.1.6'` / 截断串（现实现恒 NS1，query 解析为 null）。
- `protocol-contract.test.ts` 1 用例红：`expected 'NS1|server_1|…' to match /^nikki-sync:\/\/pair\?/`。
- 链接态 `protocol-drift.test.ts` 1 用例红，**3 条真实 drift**（vendored NS1 vs 上游 `nikki-sync://pair?serverId=…&hosts=…` 逐字节输出）——证明采样面扩展后漂移守护对多 host 分叉真实可判（堵住 R4 静默漂移）。

### 4.3 改动文件清单（实现侧）

| 文件                              | 改动                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/sync/domain-types.ts` | `identity.gameVersionEnglishName?: string`（gameVersion 之后，同上游位次）；**camera 块**追加 `rotation?/zoom?/cameraYaw?/cameraPitch?/cameraLoc?: Record<string, unknown>`（portraitMode 之后）；camera 与 filter 之间新增 `pose?: { id?: string; name?: string; strength?: number }`（上游内联单行形态逐字）；头部注释记录对齐来源                                |
| `src/shared/sync/protocol.ts`     | `ServerInfoResponse` 增 `connectionHosts?: readonly string[]`（置于块首，同上游位次）；`PairingQrPayload` 增 `hosts?: readonly string[]`（host 之后，注释同上游）；`buildPairingUri` 双分支逐字对齐（Set 去重含 host、`slice(0, 8)`、URLSearchParams 键序 serverId→host→port→token→protocol→expiresAt→tls→hosts、单 host NS1 七段逐字节保留）；头部注释记录对齐来源 |

注：02 计划 C4-1 行文写「capture.rotation…」，经上游 `packages/core/src/types.ts`（b422193 L65-85）实读，五个新字段的外层块是 **camera**（diff 上下文 `bloomThreshold/portraitMode` 所在块），`pose` 位于 camera 与 filter 之间——按上游文件形状对齐，计划文字系笔误，本条即澄清。

### 4.4 绿灯与漂移归零证据

- `npx vitest run src/shared/sync src/main/nikkisync/protocol-contract.test.ts src/main/nikkisync/protocol-drift.test.ts` → **Test Files 3 passed，Tests 44 passed (44)**：6 红全转绿；链接态漂移守护对三组新采样键**零差异**（vendored 与上游 b422193 的 `buildPairingUri` 输出逐字节一致）。

### 4.5 C4-5 wire 格式逐字比对与第三方 Android 互操作结论

逐字比对范围：签名基串（`NS1|` 七段与 `nikki-sync://pair?` query 键序）、头名（AuthHeaders 未动）、路由（`API_ROUTES` 12 键逐一相同）、DTO（`ServerInfoResponse`/`PairingQrPayload` 仅可选字段追加）、错误码（`API_ERROR_CODES` 9 项未动）、版本号（`PROTOCOL_VERSION === 1` 未动）。结论：

- **旧版第三方 Android 客户端互操作零影响**：全部协议扩展为可选字段；单 host 配对 URI 输出与升级前**逐字节一致**（协议测试 T5/T10/T9 与新增「去重后仅剩 host 自身 → NS1」回归锚双保险）；服务器不配置 `connectionHosts` 时 `/v1/server` 响应不含新键。
- **新 URI 方案（`nikki-sync://pair?`）仅在主动携带多 host 时产生**：行为面属 K5 节点（`nikkisync.multiHostPairing` 默认 false，§14-Q4 裁示），本轮未接任何行为面，vendored 升级不改变运行时行为。
- 上游 `POST /v1/organizer/sync` 硬编码路由未登记进 `API_ROUTES`、未注入时返回 404 兜底文案——本仓 K8 接入前无互操作影响（C1-3 链接态 259 测全绿已含同步服务面回归）。

（C5/C6/收尾记录随节点执行追加。）

## 5. C5 装载面结构跟随（提交 `505718c`）

### 5.1 红灯证据（2026-10-25 15:20）

`npx vitest run src/main/nikkisync/sync-server-view.test.ts src/main/nikkisync/runtime-facade.test.ts` → **Tests 5 failed | 48 passed (53)**：

- view 两支红：`AssertionError: expected undefined to be [Function connectionHosts]`（透传缺失）。
- facade 四缝红：config 未收到 `onStartupStage`/`server.connectionHosts`、`pairingUri` 三参调用被吞（`expected [ {host:'h1',…} ] to deeply equal […]` 逐参不符）、`session.deletions` undefined、`session.cachedMetadataRunOnce` undefined。

覆盖意图：两处透传缝的「存在 + 缺省连键都不下发」双支、三参透传的逐参形态、同引用透传不复制、闭包仅存在时挂出（老 surface 形态缺席）。

### 5.2 改动文件清单

| 文件                                     | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/nikkisync/runtime-types.ts`    | 十项声明扩展：新增 `DeletionQueueLike`（list/decide/approveMany/activity/stop 五方法，不含 sync/preview，注释说明 K8 归属与上游错误码）；`EmbeddedRuntimeLike` 增 `readonly deletions` 与 `createPairingUri` 第三参 `hosts?`；`ScannerServiceLike` 增 `getScanRoots/getAutomaticRoots/getExtraDirectoryCount/setExtraDirectories`；`NikkiSyncSessionOptions` 增 `onStartupStage?/consentFile?`；`NikkiSyncSyncServerConfig` 增 `connectionHosts?: () => string[]`；`NikkiSyncRuntimeStatus` 增 `startupStages?/scanDiagnostics?`；`NikkiSyncSyncServerStatus` 增 `connectionHosts?/diagnostics?`；`NikkiSyncPairingCode` 增 `hosts?`；`NikkiSyncRuntimeSession` 增 `deletions`、`pairingUri` 三参、`cachedMetadataRunOnce?: () => number` |
| `src/main/nikkisync/runtime-facade.ts`   | 四注入缝：构造 config 透传 `onStartupStage`（缺省连键都不下发）；三深入口装载（`CACHED_DECODED_METADATA_DEEP_ENTRY`/`LAN_ADDRESS_DEEP_ENTRY`/`GAME_VERSION_CALENDAR_DEEP_ENTRY` + `RuntimeSurface` 三字段，注释注明 K2/K6/K7 深入口在消费节点就地增载）；`session.deletions = runtime.deletions`（同引用）；`pairingUri` 三参分支透传；`cachedMetadataRunOnce` 闭包（模块在位时以 `runtime.database` 预构造上游服务，同步返回值逐字透传）                                                                                                                                                                                                                                                                                                 |
| `src/main/nikkisync/sync-server-view.ts` | `resolveSyncServerConfig`/`embeddedServerConfig` 的 `connectionHosts` 函数引用透传（缺省时键不存在）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 配套测试 ×2                              | 上述红灯用例（5 个）+ C5 专用夹具（记录 `createPairingUri` 调用、带 `deletions` 与 `CachedDecodedMetadataService` 假面）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### 5.3 绿灯与零回归证据

- 同两文件 → **53 passed (53)**，5 红全转绿。
- `npx vitest run src/main/nikkisync` → **229 passed (229)**，0 skip，域内零回归（含 C3-3 重开用例、链接态 sync-server/runtime-facade 全套）。
- `npm run verify` → 首跑 format ✗（新代码长行），prettier 后 **5 项全 ✓**；pre-commit（lint-staged + core-gate + tsc -b）全过，提交 `505718c`（commitlint 一条 body 行长 warning，非阻断）。

## 6. C6 打包收集核查（零配置改动实证，无独立提交）

| #    | 动作                                                                                                                                            | 结果                                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| C6-1 | `package.json` build.files 对象式 from/to（`node_modules/@nikkisync` → 同名目标，filter `**/*`）+ `asarUnpack: "**/@nikkisync/**"` 均为通配收集 | 新模块 dist 文件**自动收进**，无需配置改动；`git diff dc9f085..HEAD -- package.json` → **0 行**（本阶段零配置改动实证） |
| C6-2 | `npm run build`（5.04s 成功）→ `npm run verify:nikkisync`                                                                                       | 第 7 项折叠检查 ✓（zero `require("@nikkisync` hits across `dist/main/main/app/*.js`）；12 项全 ✓、0 blocking            |
| C6-3 | 链接源存在性核对（`node_modules/@nikkisync/pc-companion/dist/src/` 下 7 能力深入口 + `core/dist/src/decoded-metadata.js`）                      | 8/8 OK（逐项 test -f 输出）                                                                                             |

**与计划 §4 的偏差记录**：C6 预期提交类型 `chore(nikkisync)`，但本节点实证结论为零改动（产物断言已由 C2-3 落进 `pre-dist-check.ts`），无文件变更即无独立提交——证据型节点，结论入本档。完整安装包态（asar.unpacked 逐项 + dist:win）按计划归收尾节点 F（能力层之后）。

## 7. 阶段验收与遗留

### 7.1 验收自检（对照任务验收标准）

- [x] `verify:nikkisync` 通过且链接态事实正确（12 项全 ✓，第 12 项为 C2 新增；上游 `b422193` 工作区全程 0 行）
- [x] nikkisync 域链接态测试真实执行全绿（229/229，0 skip——非 skip 证据：`runtime-facade.linked`/`sync-server.linked`/`metadata-resolver.linked` 等真实装载上游产物）；未链接 skip 门控未破坏（新增测试全部走 `hasNikkiSyncLink`/假 surface 注入，无目录存在性判定）
- [x] protocol-drift 零差异（含 C4 新增三组配对 URI 采样键，链接态逐字节一致）
- [x] typecheck/lint/format 无新增失败（每节点 `npm run verify` 五项全绿；阶段末矩阵见 §7.3）
- [x] 本仓未改上游源码（上游仓 porcelain 全程 0 行）；未新增 `package.json` 的 `@nikkisync` 声明（C6-1 实证 0 行 diff）；未新增任何 npm 依赖
- [x] 节点独立提交：`b8c78e9` → `c48a037`（C2）→ `f43faa9`（C3）→ `9bb771b`（C4）→ `505718c`（C5）；全部走 pre-commit 钩子（无 --no-verify）；既有 `M package-lock.json` 未纳入任何提交

### 7.2 遗留与分歧项

| #   | 项                                | 说明                                                                                                                                                                                                                                  |
| --- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | C4 红灯用例系工作区预置           | C3 提交后工作区出现三份未提交改动（protocol.test.ts / protocol-contract.ts / protocol-contract.test.ts），经逐行审查与计划 C4-3/C4-4 一致后采纳为红灯用例随 C4 提交（§4.1）；来源为会话外（用户或并行会话），本会话全程未与该来源冲突 |
| 2   | C4-1 计划文字「capture 块」系笔误 | 实际对齐目标为上游 camera 块（§4.3 注），已按上游文件形状执行                                                                                                                                                                         |
| 3   | C6 无独立提交                     | 证据型节点零代码改动（§6 偏差记录）                                                                                                                                                                                                   |
| 4   | C3-3 证明型用例首跑即绿           | 与「红灯先行」总纲的偏差已在计划层面声明（零适配证明型），结论成立（§3.3）                                                                                                                                                            |
| 5   | commitlint 一条 warning           | `505718c` body 行超 120 字符（warning 非 error，未阻断）；后续节点注意换行                                                                                                                                                            |
| 6   | 能力层（K1–K8）与收尾（F）未开工  | 按阶段边界留给下一阶段；§14 六项已随计划批准按提案裁示（02 文档 §14 裁示记录）                                                                                                                                                        |

### 7.3 阶段末校验矩阵（2026-10-25 15:27 实跑）

| #   | 命令                                                                                                                                                    | 结果                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | `npm run verify`                                                                                                                                        | 5 项全 ✓（typecheck / lint / core-gate / format / test；各节点收尾亦均跑过） |
| 2   | `npm run typecheck && npm run typecheck:e2e`                                                                                                            | 双通过（tsc -b + tsconfig.scripts.json、tsc --noEmit -p e2e，零错误输出）    |
| 3   | `npx vitest run src/main/nikkisync src/shared/sync scripts/__tests__/{link-nikkisync,verify-nikkisync-link,self-contained-deps,pre-dist-check}.test.ts` | **339 passed (339)**，0 失败 0 skip（15.36s）                                |
| 4   | `npm run verify:nikkisync`                                                                                                                              | 12 项全 ✓，`OK (blocking failures: 0)`（C6 时点实测）                        |

阶段收尾提交：`docs(plans)`（本文档 C5/C6/§7 回填 + 02 §16 执行记录表回填）。
