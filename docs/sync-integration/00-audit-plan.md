# 同步集成 · 阶段 0+：NikkiSync PC Companion 运行时嵌入盘点计划（00-audit-plan）

> 路径作用域：本文为阶段计划/审计报告快照，文中 `src/xxx`、`scripts/xxx` 形式的路径混指本仓与上游 NikkiSync 仓；属上游或当时设计未落地的项按原文保留、不覆写，读者请勿默认它们能在本仓解析。

> 状态：已批准（2026-10-12）
> 对应交付物：工作区根 `00-nikkisync-pc-audit-report.md`（唯一真相源），`docs/sync-integration/` 留存同名副本。
> 本阶段为**只读探查 + 运行时探针 + 文档**，不修改两个项目的任何 `.ts/.tsx/.json/.cjs/.mjs` 源码、配置或既有测试。

## 0. 与既有阶段 0 的关系（互补，不重做、不推翻）

`00-code-audit-plan.md` / `00-code-audit-report.md`（阶段 0）已从**双仓对照**视角回答 10 问，并实测「Electron 41.10.6 内置 Node 24.18.0、`node:sqlite` 可用」。本次是同一主线上的一次定向补查，聚焦** NikkiSync PC Companion 自身作为可嵌入运行时** 的视角，只补既有报告未覆盖的空白：

| 问题                                                                                                                     | 阶段 0 报告     | 本次                     |
| ------------------------------------------------------------------------------------------------------------------------ | --------------- | ------------------------ |
| Runtime 生命周期（`runtime.ts` 导出/构造/`start`/`stop`/`createPcCompanionContext`）                                     | 仅提及文件存在  | **Q1 详解**              |
| 逐模块导出 API 清单（`src/` 共 62 个文件：根 8 + desktop 9 + metadata 17 + remote 4 + scanner 9 + server 12 + wechat 4） | 仅 server/ 有表 | **Q2 全量**              |
| 完整 DDL（逐表逐列）                                                                                                     | 只列表名        | **Q3 全贴**              |
| Node/Electron 兼容性                                                                                                     | 已结论          | **Q4 复验 + 嵌入硬约束** |
| 依赖冲突矩阵                                                                                                             | 无              | **Q5 新建**              |
| 测试入口与运行方式                                                                                                       | §10 概述        | **Q6 逐文件**            |
| 环境变量与配置文件                                                                                                       | 分散提及        | **Q7 汇总**              |

既有报告结论凡与本次冲突处，以本次**带 `路径:行号` 的复核实测**为准并在报告中标注差异；不删除既有报告任何内容。

## 1. 目标

产出可直接指导「把 NikkiSync PC Companion 运行时嵌入 WXNN XiangCe」的盘点报告，回答 7 个问题（运行时入口、功能模块清单、数据库 schema、Node.js 兼容性、依赖冲突、测试入口、配置项），并给出「可直接 import 复用」vs「需包装」两份清单与风险清单。

不在本阶段（明确排除）：

- 不做「直嵌 NikkiSync Runtime」vs「继续维护 `src/main/sync/**` 移植」的路线裁定（用户选定增量补全）；报告只陈述可行性证据与代价。
- 不修 `NikkiSync/scripts/build-wechat-runtime.mjs` 构建顺序缺陷、不加 `.gitattributes`、不把 `@nikkisync/*` 装进 XiangCe、不动 XiangCe 阶段 7 在途改动。

## 2. 依赖声明

- **外部依赖**：本机 Node v26.3.0、npm 11.16.0、git 2.55.0（三者已实测在库）；同时满足 XiangCe `engines >=22.12.0` 与 NikkiSync `engines >=24.0.0`。
- **仓库依赖**：
  - `NikkiSync/`：node_modules 已存在（顶层 66 包 + `@esbuild`/`@nikkisync`/`@types` 等 scope，无原生编译模块）；`apps/pc-companion/dist/`、`packages/*/dist/` 已编译存在。本阶段执行 `npm install` 幂等确认。
  - `WXNN XiangCe/`：node_modules 已存在（electron 实装 41.10.6、better-sqlite3 12.11.1、vitest 5.0.3、qrcode、esbuild 均在）。本阶段执行 `npm install` 幂等确认。
- **本阶段新增依赖**：无。运行时探针只用 `ELECTRON_RUN_AS_NODE=1` + XiangCe 已有的 `node_modules/electron/dist/electron.exe`，不落任何临时文件（脚本经 PowerShell stdin 管道传入）。

## 3. 启动 / 验证方式

| 动作                  | 命令（执行目录见括号）                                                                                                                                                                              | 期望                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| NikkiSync 幂等装依赖  | `npm install`（`NikkiSync/`）                                                                                                                                                                       | 退出码 0，无 package-lock 变更                                             |
| XiangCe 幂等装依赖    | `npm install`（`WXNN XiangCe/`）                                                                                                                                                                    | 退出码 0，无 package-lock 变更                                             |
| NikkiSync 全量测试    | `npm test`（`NikkiSync/`）                                                                                                                                                                          | 131/131 通过（已作为 WIP 检查点前置基线实测）                              |
| NikkiSync 类型检查    | `npm run typecheck`                                                                                                                                                                                 | 退出码 0                                                                   |
| NikkiSync schema 校验 | `npm run db:validate`                                                                                                                                                                               | schema OK + foreign_key_check ok + quick_check ok（12 表）                 |
| XiangCe 类型检查      | `npm run typecheck`                                                                                                                                                                                 | **预期 2 个 TS 错误**（阶段 7 未提交 WIP 自身引入，见 §4.3），非本阶段新增 |
| XiangCe lint          | `npm run lint`                                                                                                                                                                                      | 0 error（存量 warning 允许）                                               |
| XiangCe 测试          | `npm run test:main`                                                                                                                                                                                 | 记录通过/失败数，失败项须举证是否 WIP 引入                                 |
| 既有阶段 0 校验复跑   | `node --test docs/sync-integration/verify-audit.mjs`（`WXNN XiangCe/`）                                                                                                                             | 9/9 绿（证明新增文档未破坏既有校验）                                       |
| 探针 P1 运行时版本    | `ELECTRON_RUN_AS_NODE=1` + `electron.exe -` 打印 `process.versions`                                                                                                                                 | `node=24.18.0 electron=41.10.6`                                            |
| 探针 P2 SQLite 驱动   | 同上，`require('node:sqlite')` + 建表/插入/查询                                                                                                                                                     | `node:sqlite=OK`，行数返回正确                                             |
| 探针 P3 运行时直嵌    | 同上 `--input-type=module`，`import()` 加载 `apps/pc-companion/dist/src/{index,runtime}.js` → `new PcCompanionRuntime({server:{host:'127.0.0.1',port:0,mdns:false}})` → `server.start()` → `stop()` | 打印导出数、监听端口、`secure=true`、`STOP-OK`                             |
| 探针 P4 互操作边界    | 同上，`createRequire(...)('...packages/database/dist/src/index.js')`                                                                                                                                | `ERR_REQUIRE_ASYNC_MODULE`（证明只能用动态 `import()`）                    |

## 4. 错误处理策略

1. **禁止假设**：每条结论必须先 `Read`/`Grep` 源码确认，报告内文一律附 `路径:行号`；文件路径在收尾时逐条 `Test-Path` 核验。
2. **探针失败即停**：任一探针非预期结果（如 P3 起不来）不猜测原因，先把完整 stderr 记入报告「验证记录」，再定位（优先怀疑 dist 产物过期 → `npm run build` 后重跑）。
3. **回归失败甄别**：XiangCe `typecheck` 的 2 个错误已确认由未提交的阶段 7 WIP（`src/main/database/sync-read-repository.ts` 删掉 `import type Database from 'better-sqlite3'`、`getAssetDetail` 返回类型改 `ExtendedAssetDetail` 后一处分支缺 `revision`）引入。用户已决定**不提交该 WIP**，故该失败按「他阶段在途状态」如实记录，本阶段不修复、不掩盖。其余任何新增失败必须修复后才进下一步。
4. **不放宽断言变绿**：不得为了让门禁通过而修改既有源码或降低校验强度。

## 5. 参数校验规则

- 版本比较用数字主版本比较，不做字符串比较：`Number(process.versions.node.split('.')[0]) >= 24`。
- 环境变量清单用 `process\.env\.([A-Z_0-9]+)` 全量正则采集后去重，不靠人工记忆。
- 导出口径统一用 `^export ` 行首匹配（`class|function|const|interface|type`），避免漏掉 `export *` 再导出与 `export default`。
- DDL 采集只取 `packages/database/migrations/0001_initial.sql` 原文，不从 ORM 类型反推。
- 依赖冲突只比对**声明区间 + 实装版本**两栏，实装版本从各自 `node_modules/<pkg>/package.json` 读取。

## 6. 需探查文件清单（报告引用前均已确认存在）

**NikkiSync（`NikkiSync/` 下）**

- 根与运行时：`apps/pc-companion/src/runtime.ts`、`src/index.ts`、`src/dev-server.ts`、`src/windows-app.ts`、`src/qr.ts`、`src/RuntimeMemoryMaintenance.ts`、`src/WindowsInstallationHints.ts`、`src/game-directory-discovery.ts`
- `apps/pc-companion/src/scanner/`（9）：`index.ts`、`ScannerService.ts`、`ScannerDiscovery.ts`、`ScannerWatcher.ts`、`ScanCoordinator.ts`、`ScanReconciler.ts`、`ResourceClassifier.ts`、`FileStabilityGuard.ts`、`types.ts`
- `apps/pc-companion/src/server/`（12）：`index.ts`、`LocalSyncServer.ts`、`AuthService.ts`、`PairingService.ts`、`WebSocketHub.ts`、`MdnsAdvertiser.ts`、`LocalTlsIdentityService.ts`、`row-mappers.ts`、`ClothingSearchIndex.ts`、`SuitSearchIndex.ts`、`ProfileStatsIndex.ts`、`GameVersionCalendar.ts`
- `apps/pc-companion/src/metadata/`（17）：`MetadataResolverPipeline.ts`、`MetadataResolverService.ts`、`MetadataResolverConfigFile.ts`、`MetadataDictionaryService.ts`、`MetadataDictionaryUpdateService.ts`、`MetadataDictionaryProvider.ts`、`MetadataDictionaryConfigFile.ts`、`MetadataDictionaryRemoteConfigFile.ts`、`MetadataStartupComposition.ts`、`MetadataThumbnailCache.ts`、`Nuan5CompatibleResolver.ts`、`RemoteJsonMetadataResolver.ts`、`RemoteJsonMetadataDictionaryProvider.ts`、`NikkiAlbumsMetadataDictionaryProvider.ts`、`NikkiGalleryMetadataDictionaryProvider.ts`、`VerifiedClothingNames.ts`、`types.ts`
- `apps/pc-companion/src/remote/`（4）：`RemoteBridgeService.ts`、`RemoteRoutes.ts`、`RemoteSessionStore.ts`、`RemoteConnection.ts`
- `apps/pc-companion/src/desktop/`（9）：`DesktopControlServer.ts`、`DesktopPage.ts`、`DesktopPageScript.ts`、`DesktopStatusService.ts`、`DesktopIcons.ts`、`AppDataDirectory.ts`、`RemoteBridgePanel.ts`、`WeChatGalleryPanel.ts`、`StartupFailure.ts`
- `apps/pc-companion/src/wechat/`（4 + 生成脚本）：`WeChatGalleryService.ts`、`WeChatIconProvider.ts`、`GalleryRuntime.mjs`、`GalleryRuntime.d.mts`、`scripts/build-wechat-runtime.mjs`
- 包：`packages/core/src/{types,resolver,metadata-dictionary,path-key,index}.ts`、`packages/database/src/*.ts`（11）+ `migrations/0001_initial.sql` + `scripts/validate-schema.mjs`、`packages/protocol/src/index.ts`
- 测试：`apps/pc-companion/test/`（20 文件）、`packages/{core,protocol,database}/test/`（5 文件）、根 `package.json` 的 `test`/`typecheck`/`build*`/`test:wxnn-e2e`/`db:validate` 脚本
- 配置：根 `package.json`、`apps/pc-companion/package.json`、`packages/*/package.json`、`tools/*/package.json`、`apps/pc-companion/tsconfig.json`

**WXNN XiangCe（`WXNN XiangCe/` 下，仅作对照与约束来源）**

- `package.json`（electron 41.10.6 / better-sqlite3 / qrcode / typescript 等依赖声明）
- `electron.vite.config.ts`（main 为 CJS lib 产物 + `externalizeNodeModules()`；renderer external 列表）
- `src/main/sync/`、`src/shared/sync/`、`src/main/database/sync-*.ts`（既有移植实现，只盘点不改）
- `AGENTS.md`、`docs/sync-integration/verify-audit.mjs`

## 7. 需新增文件及输入输出

| 路径（绝对）                                                                              | 操作 | 输入 → 输出                                                                                                    |
| ----------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------- |
| `d:\Zcode项目\WXNN YD\WXNN XiangCe\docs\sync-integration\00-audit-plan.md`                | 新建 | 本计划                                                                                                         |
| `d:\Zcode项目\WXNN YD\00-nikkisync-pc-audit-report.md`                                    | 新建 | 7 问答案 + 模块清单 + DDL + 兼容结论 + 冲突矩阵 + 测试入口 + 配置项 + 复用清单 + 风险 + 验证记录（唯一真相源） |
| `d:\Zcode项目\WXNN YD\WXNN XiangCe\docs\sync-integration\00-nikkisync-pc-audit-report.md` | 新建 | 根报告副本（入 git 跟踪，顶部注明真相源位置）                                                                  |

## 8. 可判定的验收标准

1. 报告内 7 问小节均非空且每条结论带 `路径:行号`；全文「待确认」出现次数 = 0。
2. 报告引用的文件路径 100% 真实存在（收尾用脚本逐条核验，列出条数）。
3. Runtime 启动方式有明确说明并含代码示例（`runtime.ts` 导出、构造参数、`start`/`stop` 顺序、`createPcCompanionContext` 返回值差异）。
4. Electron/Node 兼容性有明确结论 + 四条探针实测输出 + 推荐方案。
5. 两项目 `npm install` 退出码 0；NikkiSync `typecheck`/`test`/`db:validate` 全绿；XiangCe `lint` 0 error；XiangCe `typecheck` 若为红须举证归因（当前已知为阶段 7 WIP，见 §4.3）。
6. `verify-audit.mjs` 复跑仍 9/9 绿。
7. 两仓各自在 `feat/gallery-runtime-embed` 上完成一次文档提交（XiangCe 只 `git add` docs 路径，不裹入阶段 7 WIP）。

## 9. 分支与提交（用户已裁定）

- NikkiSync：阶段 7 WIP（`wxnn-cross-server.test.ts` + `test:wxnn-e2e`）已在 `feat/sync-07-write-driver` 提交为检查点 `b2eb337`（提交前 `npm test` 131/131 绿）；`feat/gallery-runtime-embed` 自该检查点切出。
- WXNN XiangCe：阶段 7 WIP **不提交**，保持脏工作区随 `feat/gallery-runtime-embed`（自 `feature/sync-integration-07-bidirectional-sync` HEAD `0de20d8` 切出）携带；本阶段提交只 add `docs/sync-integration/` 两份新文档。
- NikkiSync 提交作者沿用该仓库历史身份 `ToStardust <ToStardust@users.noreply.github.com>`（以 `git -c` 单次传入，不修改任何 git 配置）。
