# NikkiSync 上游同步 · 03 兼容层执行记录（阶段 3：C1–C6）

> 生成日期：2026-10-25 · 执行依据：已批准的 [`02-实施计划`](2026-10-25-nikkisync-upstream-sync-02-实施计划.md) §5
> 批准方式：用户裁示「计划整体批准，§14 六项待确认按提案裁示」（2026-10-25，已回填 02 文档状态行与 §14 裁示记录）
> 本仓 `main` 起点 `dc9f085`；阶段内提交：`b8c78e9`（docs(plans) 计划入库+批准回填）→ `c48a037`（feat(nikkisync) C2）→（后续节点按序追加）
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
