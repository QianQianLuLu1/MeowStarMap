# 整合 · 阶段 9：遗留债务修复计划（09-legacy-debt-remediation-plan）

> 状态：已批准（2026-10-13）｜ 分支：`feat/gallery-runtime-embed`（HEAD `9815e68`）
> 目标：修复 4 项已登记的遗留债务——① 2 个 TypeScript 类型错误（阻塞 `.husky/pre-commit` 的 `tsc -b`）；② `file:../NikkiSync/...` 导致 CI `npm ci` 无法解析；③ 打包态 asar × ESM × `migrations` 资源路径未验证；④ 协议双真相源（`src/shared/sync/protocol.ts` 与 `@nikkisync/protocol`）分叉。
> 前置阅读：[`01-dependency-link-plan.md`](./01-dependency-link-plan.md)（§14 R1/R3/R4 即本次要关闭的三项风险）、[`07-bidirectional-sync-plan.md`](./07-bidirectional-sync-plan.md)（阶段 7 红灯 WIP 的归属）
> 核心原则：最小化改动、不顺手实现阶段 7 写端点、不伪造或弱化任何失败结果。

## 0. 取证基线（2026-10-13 本机实测，非假设）

| 门禁                 | 命令（`WXNN XiangCe/`）                                                                                                                                                                                 | 实测结果                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 类型检查             | `npx tsc --noEmit -p src/main/tsconfig.json`                                                                                                                                                            | 退出码 2，**6 错**：`sync-read-repository.ts(125,26) TS2503`、`(231,5) TS2322`、`runtime-loader.ts(13/14/15/16)` **4×TS2307**                                   |
| Lint                 | `npx eslint .`                                                                                                                                                                                          | `12 problems (1 error, 11 warnings)`；error = `sync-read-repository.ts:6:8 'AssetDetailResponse' is defined but never used`；11 warnings 为存量 BOM（DEBT-030） |
| nikkisync 用例       | `npx vitest run src/main/nikkisync`                                                                                                                                                                     | `Test Files 2 failed`、`Tests 11 failed / 7 passed (18)`                                                                                                        |
| 阶段 7 读侧/路由用例 | `npx vitest run src/main/database/sync-read-repository.test.ts src/main/database/sync-row-mappers.test.ts src/main/sync/server/api-router.test.ts src/main/sync/server/sync-server.integration.test.ts` | `Test Files 3 failed / 1 passed`、`Tests 17 failed / 108 passed`（read-repo 2 例 = S14a/S14b；api-router 10 例；集成 5 例）                                     |
| 阶段 7 缺实现        | `npx vitest run src/main/sync/server/annotations.test.ts src/main/database/sync-write-repository.test.ts`                                                                                               | `Test Files 2 failed`：`Cannot find module './annotations'`、`'./sync-write-repository'`                                                                        |
| 依赖链接诊断         | `npx tsx scripts/verify-nikkisync-link.ts`                                                                                                                                                              | 退出码 1，3 项阻塞失败（link 缺失 / 四包未编译 / `migrations` SQL 不可读）                                                                                      |
| 环境事实             | `Get-ChildItem node_modules\@nikkisync`、`Test-Path 'D:\Zcode项目\WXNN YD\NikkiSync'`、`git ls-remote https://github.com/QianQianLuLu1/NikkiSync`                                                       | 四条 junction 指向 `D:\Zcode项目\WXNN YD\NikkiSync\...`；该目录 **False 不存在**（全盘 depth-3 无 `NikkiSync`）；远端 `Repository not found`                    |

### 根因结论

1. **TS2503**：`sync-read-repository.ts` 用了 `Database.Database` 却没有 `import type Database from 'better-sqlite3'`（同目录 `sync-metadata-repository.ts:2`、`media-repository.ts` 均为正确先例）。
   **TS2322**：`getAssetDetail` 声明返回 `ExtendedAssetDetail`（= `AssetDetailResponse & { revision: Revision; annotations?: AssetAnnotations }`，见 `src/shared/sync/protocol-extension.ts:71`），但只返回 `{ asset }`，缺必填 `revision`；`annotations` 也被塞进 `asset` 内而非顶层，导致 S14a/S14b 两条既有红灯断言 `detail!.annotations` 失败。
2. **CI 红**：`package.json` 的 4 条 `file:../NikkiSync/...` 在只 checkout 本仓的 CI 环境无法解析（`01-dependency-link-plan.md` §14 R1 已登记，当时用户选择"不动 build.yml"）。本机同一缺失另产生 4×TS2307（`runtime-loader.ts` 的 `import type` 锚点）。
3. **打包态隐患**：`electron-builder` 只打包已声明的生产依赖，`build.files` 当前为 `dist/**/* + resources/**/*` + 负向排除；一旦 `@nikkisync/*` 不再是声明依赖而改为开发机 junction（自包含方案的必然结果），打包产物内必然缺包。且 `src/main/nikkisync/probe.ts:104` 调 `manager.initialize()` 无参，依赖 NikkiSync 内部 `new URL('../../migrations/0001_initial.sql', import.meta.url)`（`01-dependency-link-plan.md` §2 探查表），asar 内该相对路径不可靠——§10 已预定处置"显式传 `schemaSql`，不改 NikkiSync 源码"。
4. **协议双源**：`src/shared/sync/protocol.ts`（10 个非测试文件引用的运行时契约）与 `@nikkisync/protocol`（仅 `runtime-loader.ts` 4 行 `import type` 锚点 + `NIKKISYNC_REQUIRED_EXPORTS.protocol` 运行时检查）并存；全仓 `grep "from '@nikkisync"` 命中仅该 4 行。

## 1. 决策与边界

- **依赖方向 = 自包含**：`@nikkisync/*` 不再作为声明依赖参与 `npm ci` / `tsc -b`；开发机经 `npm run link:nikkisync` 建 junction。未链接是受支持的默认态（相关测试 skip、诊断降级为 warn），CI 只 checkout 本仓即全绿。
- **协议唯一真相源 = 仓内 vendored**：`src/shared/sync/protocol.ts` + `domain-types.ts` + `protocol-extension.ts`。`@nikkisync/protocol` 降级为"链接态漂移比对对象"，不再是契约来源。
- **不在范围**（越界即视为违规）：阶段 7 写端点实现（`sync-write-repository.ts` / `annotations.ts` / `api-router.ts` 写分支 / `types.ts` 写方法 / `launch-server.ts` 扩展）。这些红灯是 TDD 既定状态，不修不掩盖。
- **协议语义零变更**：`protocol.ts` / `domain-types.ts` / `protocol.test.ts` 冻结不动。

## 2. 依赖声明（新增 / 变更 / 移除）

| 类别                       | 内容                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新增 npm 公开包            | **无**（不引入任何第三方包；junction 用 Node 内置 `fs.symlink`，路径解析用 `node:path` + `node:url`）                                                                           |
| 移除声明依赖               | `dependencies` 中 `@nikkisync/core`、`@nikkisync/database`、`@nikkisync/pc-companion`、`@nikkisync/protocol` 四条 `file:../NikkiSync/...`                                       |
| 变更 lockfile              | `package-lock.json` 由 `npm install` 重写（剪除 `file:../NikkiSync` link 条目与四个包节点）                                                                                     |
| 新增 npm scripts           | `link:nikkisync` = `tsx scripts/link-nikkisync.ts`；`link:nikkisync:check` = `tsx scripts/link-nikkisync.ts --check`                                                            |
| 变更 electron-builder 配置 | `build.files` 追加 `"node_modules/@nikkisync/**/*"`（链接态打包面补回）；`build.asarUnpack` 保留 `"**/@nikkisync/**"`                                                           |
| 对 NikkiSync 的依赖形态    | 由"声明依赖 + npm 自动 link"改为"开发机 junction + 显式命令"（`01-dependency-link-plan.md` §3 的方案 D，作为常规态而非降级路径）；类型面锚点退役，改由运行时探针 + 只读诊断保证 |
| 本地布局前提               | 开发机需有 NikkiSync 检出，按候选序解析：`NIKKISYNC_ROOT` 环境变量 → `../NikkiSync`（同级）→ `./vendor/NikkiSync`（仓内 vendor）                                                |

## 3. 启动 / 验证方式（命令表，分步门禁：每步通过才进下一步）

| 步  | 节点        | 命令（`WXNN XiangCe/`）                                                                                                                                                                                                      | 通过判据                                                                                                                                                     |
| --- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0   | 基线        | 本文件 §0 全部命令                                                                                                                                                                                                           | 与 §0 表逐字一致（已取证）                                                                                                                                   |
| 1   | 红灯        | `npx vitest run src/main/database/sync-read-repository.test.ts`                                                                                                                                                              | S14a/S14b FAIL（修复前必红）                                                                                                                                 |
| 2   | 问题 1      | 同上 + `npx tsc --noEmit -p src/main/tsconfig.json`                                                                                                                                                                          | 该文件 26 例全绿；输出不含 TS2503/TS2322                                                                                                                     |
| 3   | 问题 2 红灯 | `npx vitest run scripts/__tests__/self-contained-deps.test.ts`                                                                                                                                                               | 必红（存在 `file:../` 依赖、`build.files` 缺 `node_modules/@nikkisync/**/*`）                                                                                |
| 4   | 问题 2      | `npm install` → `npx tsc --noEmit -p src/main/tsconfig.json` → `npx vitest run src/main/nikkisync scripts/__tests__`                                                                                                         | `package-lock.json` 无 `file:../NikkiSync`；`Test-Path node_modules/@nikkisync` = False；typecheck 退出码 **0**；nikkisync 用例 0 failed（linked 套件 skip） |
| 5   | 问题 4      | `npx vitest run src/main/nikkisync src/shared/sync` → `Grep "from '@nikkisync" src/**`                                                                                                                                       | 全绿（linked skip）；grep 命中 **0**                                                                                                                         |
| 6   | 问题 3      | `npx vitest run src/main/nikkisync/embedding-paths.test.ts src/main/nikkisync/probe.test.ts` → `npm run build` → `Select-String dist\main\main\app\*.js -Pattern 'require\(.@nikkisync'` → `npm run verify:nikkisync --json` | 用例全绿；build 退出码 0；grep 命中 0；新增检查项以 warn/skip 形态呈现且无 blocking fail                                                                     |
| 7   | 全局回归    | `npm run typecheck` / `npm run lint` / `npm run format:check` / `npm test` / `npm run i18n:guard` / `npm run verify`                                                                                                         | 失败集合 ⊆ §0（仅 4 个阶段 7 文件），零新增失败                                                                                                              |
| 8   | 提交闸门    | `git add <本次文件>` → `npx tsx scripts/core-path-gate.ts --staged` → `npx --no-install tsc -b` → `npx tsx scripts/run-precommit-tests.ts <staged>`                                                                          | 三者退出码 0                                                                                                                                                 |
| 9   | 待链接复验  | §6 命令表（NikkiSync 到位后执行）                                                                                                                                                                                            | 逐条判据满足                                                                                                                                                 |

## 4. 节点拆解（文件 / 输入输出 / 验收）

### 节点 1 — 问题 1：2 个类型错误

| 文件                                             | 操作 | 输入 → 输出                                                                                                                                                                                                                                                                               |
| ------------------------------------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/database/sync-read-repository.ts`      | 修改 | ① 补 `import type Database from 'better-sqlite3'`；② 删除未使用的 `type AssetDetailResponse`；③ `getAssetDetail` 返回 `{ asset, revision: row.derived_revision, annotations: buildAnnotations(row) }`（同时满足 `ExtendedAssetDetail` 必填 `revision` 与 S14a/S14b 的顶层 `annotations`） |
| `src/main/database/sync-read-repository.test.ts` | 追加 | 新增 `S14d 顶层 revision 取日志派生值`：`seedJournal(9,'1')` → `detail!.revision === 9`；未播种 → `0`                                                                                                                                                                                     |

验收：`npx tsc --noEmit -p src/main/tsconfig.json` 无 TS2503/TS2322；`npx vitest run src/main/database/sync-read-repository.test.ts` 0 failed；`npx eslint src/main/database/sync-read-repository.ts` 0 error。

### 节点 2 — 问题 2：自包含依赖图 + 消 4×TS2307

| 文件                                                             | 操作               | 输入 → 输出                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `package.json`                                                   | 修改               | 删 4 条 `@nikkisync/*` 依赖；加 2 个 script；`build.files` 追加 `"node_modules/@nikkisync/**/*"`                                                                                                                                                                                                                                                                                                 |
| `package-lock.json`                                              | `npm install` 生成 | 无 `file:../NikkiSync` 条目                                                                                                                                                                                                                                                                                                                                                                      |
| `scripts/link-nikkisync.ts`                                      | 新增               | 输入：`process.env.NIKKISYNC_ROOT` + 候选根 + `--check`；输出：`node_modules/@nikkisync/<name>` junction、逐行 `[link:nikkisync]` 状态、退出码（0 就绪/建立，1 未找到根或校验失败）。纯函数 `resolveNikkiSyncRoot(candidates, isDirectory)` 与 `planLinks(root, packages, exists)` 可单测                                                                                                        |
| `scripts/__tests__/link-nikkisync.test.ts`                       | 新增               | 纯函数三类用例（见 §5）                                                                                                                                                                                                                                                                                                                                                                          |
| `scripts/__tests__/self-contained-deps.test.ts`                  | 新增               | 读真实 `package.json` 的契约测试：无任何 `file:../` 依赖 spec；`build.files` 含 `node_modules/@nikkisync/**/*`；`build.asarUnpack` 含 `**/@nikkisync/**`                                                                                                                                                                                                                                         |
| `src/main/nikkisync/runtime-loader.ts`                           | 修改               | 删除 4 行 `import type ... from '@nikkisync/*'` 与 `NikkiSyncTypeSurface`；文件头注释改写（类型锚点退役理由 + 链接改由 `npm run link:nikkisync`）。其余导出（`NIKKISYNC_PACKAGES`/`NIKKISYNC_PACKAGE_NAMES`/`NIKKISYNC_REQUIRED_EXPORTS`/`specifierFor`/`loadNikkiSyncPackage`/`loadAllNikkiSyncPackages`/`nikkisyncExport`/`isNikkiSyncLinked`/`NikkiSyncLoadError`/`resolveLoadHint`）保持不变 |
| `src/main/nikkisync/runtime-loader.test.ts`、`probe.test.ts`     | 修改               | `LINKED` 判定改为 `existsSync(node_modules/@nikkisync/core/package.json)`（悬空 junction → false → 正确 skip），消除 11 例假失败                                                                                                                                                                                                                                                                 |
| `scripts/verify-nikkisync-link.ts`                               | 修改               | 首项检查反转为"依赖图自包含"（`@nikkisync/*` 出现在 dependencies 即 blocking fail）；未链接 → **warn**（提示 `npm run link:nikkisync`）；已链接但 `dist/` 未编译 → blocking；回落根解析复用 `resolveNikkiSyncRoot`；§6 两项打包态只读检查                                                                                                                                                        |
| `scripts/__tests__/verify-nikkisync-link.test.ts`                | 修改               | 新语义的正常/异常/边界断言                                                                                                                                                                                                                                                                                                                                                                       |
| `src/main/nikkisync/AGENTS.md`、`scripts/AGENTS.md`、`AGENTS.md` | 修改               | 链接来源与"未链接是受支持默认态"的口径；scripts 表补 `link-nikkisync.ts` 行。受 `scripts/__tests__/verify-format-scope.test.ts` 契约守护：嵌套指引必须引用 `docs/CODING_CONVENTIONS.md`                                                                                                                                                                                                          |
| `.github/workflows/build.yml`                                    | **不改**           | `npm ci` 已不触仓库外路径；防回归由 `self-contained-deps.test.ts` 在既有 `npm test` 内长期承担                                                                                                                                                                                                                                                                                                   |

参数校验：`NIKKISYNC_ROOT` 为空串/非目录 → 拒绝并打印 `candidate is not a directory`；包名只接受 `NIKKISYNC_PACKAGE_NAMES` 四项；目标根必须含 `packages/core`、`packages/database`、`packages/protocol`、`apps/pc-companion` 四个子目录，缺一即失败；路径段禁止 `..` 逃逸。
错误处理：不抛裸栈，统一 `process.stderr` + `[link:nikkisync]` 前缀；`--check` 模式零写入；已存在且 realpath 相同的 link → `skip`，realpath 不同 → 替换并打印新旧目标（可回滚线索）。

验收：`npm install` 退出码 0；`Select-String package-lock.json -Pattern 'file:\.\./NikkiSync'` 命中 0；`Test-Path node_modules/@nikkisync` = False；`npm run typecheck` 退出码 **0**；`npx vitest run src/main/nikkisync scripts/__tests__` 0 failed；`npm run link:nikkisync:check` 在无 NikkiSync 时输出可执行提示且退出码 1（不把缺失伪装成就绪）。

### 节点 3 — 问题 4：协议单一真相源 + 漂移守护

| 文件                                               | 操作           | 输入 → 输出                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/nikkisync/protocol-contract.ts`          | 新增           | `collectVendoredContract()` → 快照（`PROTOCOL_VERSION`、`API_ROUTES` 全 12 键含 4 个函数路由的编码结果、`API_ERROR_CODES`、`CHANGE_TYPES`、`ASSET_TYPES`、`RESOURCE_ROLES`、`ASSET_STATES`、`METADATA_SCHEMA_VERSION`）；`diffProtocolContract(vendored, upstream): string[]` 逐条差异（缺失/多余/值不等）；`VENDORED_CONTRACT_SYMBOLS` 名单。零 Node 依赖（值面从 `shared/sync` 静态 import，属本仓内源码，不受 `@nikkisync` 护栏约束） |
| `src/main/nikkisync/protocol-contract.test.ts`     | 新增           | CI 必跑的纯函数三类用例                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/main/nikkisync/protocol-drift.test.ts`        | 新增           | `describe.skipIf(!LINKED)`：`loadNikkiSyncPackage('protocol'                                                                                                                                                                                                                                                                                                                                                                             | 'core')`取真实上游运行时值 →`diffProtocolContract`断言`[]` |
| `src/shared/sync/README.md`                        | 修改           | 新增"唯一真相源"小节；维护规则指向漂移守护；删除"收敛属后续阶段决策"的悬置表述                                                                                                                                                                                                                                                                                                                                                           |
| `docs/sync-integration/01-dependency-link-plan.md` | 修改           | §14 R1/R3/R4 标注处置结论并回指本文件；§5 依赖声明补"四条 file: 已移出 dependencies"                                                                                                                                                                                                                                                                                                                                                     |
| `docs/sync-integration/01-protocol-port-plan.md`   | 修改（结论行） | vendored 为唯一真相源 + 漂移守护                                                                                                                                                                                                                                                                                                                                                                                                         |

验收：`src/**`（含测试）内 `from '@nikkisync` 命中 **0**；`npx vitest run src/main/nikkisync src/shared/sync` 0 failed；`npx eslint .` 0 error；`npx tsc --noEmit -p src/main/tsconfig.json` 退出码 0。

### 节点 4 — 问题 3：打包态 ESM 与 migrations 路径

| 文件                                         | 操作 | 输入 → 输出                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/nikkisync/embedding-paths.ts`      | 新增 | 纯函数（注入 `ctx = { isPackaged, resourcesPath, projectRoot }` 与 `existsSync`）：`resolveModuleRoot(specifier)`（打包态 → `<resourcesPath>/app.asar.unpacked/node_modules/@nikkisync/<name>`，未命中回退 asar 内路径并置 `fellBackToAsar: true`；dev → `<projectRoot>/node_modules/...`）；`resolveEntryUrl(root)` = `pathToFileURL(join(root,'dist/src/index.js')).href`；`resolveMigrationsSqlPath(root)` = `<root>/migrations/0001_initial.sql`；`readMigrationsSql(path)` 读文本，缺失抛 `NikkiSyncAssetError`（消息含实际绝对路径 + `npm run link:nikkisync` / NikkiSync `npm run build` 指令）。入参校验：specifier 必须匹配 `^@nikkisync/[a-z-]+$`，路径段禁 `..` |
| `src/main/nikkisync/embedding-paths.test.ts` | 新增 | 三类用例（§5）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/main/nikkisync/runtime-loader.ts`       | 修改 | `loadNikkiSyncPackage`：先按 bare specifier 装载（保留阶段 1 已验证行为），失败且 `isPackaged` 时用 `resolveEntryUrl` 得到的 `file://` URL（变量，非字面量）再试一次；仍失败则 `NikkiSyncLoadError` 的 hint 增补 unpacked 路径                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/main/nikkisync/probe.ts`                | 修改 | `manager.initialize(readMigrationsSql(resolveMigrationsSqlPath(...)))`——显式传 SQL，落实 `01-dependency-link-plan.md` §10 预定处置；`NikkiSyncDatabaseRecord` 增 `schemaSource`，`formatNikkiSyncLinkProbeReport()` 打印来源路径                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `scripts/verify-nikkisync-link.ts`           | 修改 | 两项只读检查：① `dist/main/main/app/*.js` 全 chunk `require("@nikkisync` 命中数必须为 0（固化阶段 1 手工 grep 为闸门）；② `release/**/app.asar.unpacked` 存在时必须能读到 `node_modules/@nikkisync/database/migrations/0001_initial.sql`（无 release → warn/skip）                                                                                                                                                                                                                                                                                                                                                                                                         |
| `scripts/pre-dist-check.ts`                  | 修改 | `--verify-asar` 分支：`@nikkisync` 存在 → 断言其在 `app.asar.unpacked` 且 SQL 可读；不存在 → 打印显式 `SKIP` 行（不把"未链接"伪装成"已验证"）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

验收（当场可判）：`npx vitest run src/main/nikkisync/embedding-paths.test.ts src/main/nikkisync/probe.test.ts` 0 failed；`npm run build` 退出码 0；`Select-String dist\main\main\app\*.js -Pattern 'require\(.@nikkisync'` 命中 0；`npm run verify:nikkisync --json` 含新增两项且无 blocking fail。

### 待链接复验清单（NikkiSync 到位后一次性执行，逐条判据固定）

| #   | 命令（`WXNN XiangCe/`）                                                                                        | 判据                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | `npm run link:nikkisync` → `npm run verify:nikkisync`                                                          | 前者退出码 0；后者退出码 0 且四包 link 全 ✓                                                                                                                                                          |
| V2  | `npm run build` → `Select-String dist\main\main\app\*.js -Pattern 'require\(.@nikkisync'` / `'await import\('` | 命中 0 / ≥ 1                                                                                                                                                                                         |
| V3  | `npx electron-builder --dir --win --x64`                                                                       | 产出 `release/win-unpacked`；`resources/app.asar.unpacked/node_modules/@nikkisync/**` 存在（证明 `build.files` 补丁生效）                                                                            |
| V4  | `npm run verify:dist`                                                                                          | `@nikkisync` 断言通过（不再 SKIP）                                                                                                                                                                   |
| V5  | `$env:NIKKI_NIKKISYNC_PROBE='1'; & .\release\win-unpacked\无限暖暖相册管理工具.exe`                            | electron-log 出现 `[NIKKISYNC] ... ok=true ... dbTables=13 ... schemaSource=<...app.asar.unpacked\node_modules\@nikkisync\database\migrations\0001_initial.sql>`；日志检索 `ERR_REQUIRE_ASYNC_MODULE | ERR_MODULE_NOT_FOUND | ENOENT` 命中 0 |
| V6  | `npx vitest run src/main/nikkisync`                                                                            | linked 套件由 skip 转 pass，`protocol-drift.test.ts` 差异为 `[]`                                                                                                                                     |

## 5. 基础测试用例（覆盖正常 / 异常 / 边界三类）

| 文件                                                          | 正常                                    | 异常                                                                                                                                   | 边界                                                                                               |
| ------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/main/database/sync-read-repository.test.ts`（追加 S14d） | 播种 journal(9) → 顶层 `revision === 9` | 非法 assetId 仍抛错（既有 S10）                                                                                                        | 无 journal 记录 → `revision === 0`                                                                 |
| `scripts/__tests__/link-nikkisync.test.ts`                    | 首个候选命中 → 返回该根                 | 无候选可用 / 候选目录缺 `packages/core` → 抛可诊断错误                                                                                 | `NIKKISYNC_ROOT` 为空串被忽略；多候选同时存在时按声明优先级取首个                                  |
| `scripts/__tests__/self-contained-deps.test.ts`               | 真实 `package.json` 无 `file:../` 依赖  | 出现 `file:../` spec → 断言失败（修复前必红）                                                                                          | `build.files` 缺 `node_modules/@nikkisync/**/*` 亦判失败                                           |
| `scripts/__tests__/verify-nikkisync-link.test.ts`             | 自包含 + 已链接已编译 → 全 ✓            | dependencies 仍声明 `@nikkisync/*` → blocking fail                                                                                     | 未链接 → warn（非阻塞）；`dist/` 半编译 → blocking                                                 |
| `src/main/nikkisync/protocol-contract.test.ts`                | 上游快照全等 → `[]`                     | 路由值漂移 / 错误码数组不等 / upstream 非对象 → 精确差异条目                                                                           | 函数路由 `asset('7/1')` 编码一致；上游多出一个导出 → 记"多余"不判失败外溢                          |
| `src/main/nikkisync/protocol-drift.test.ts`                   | 链接态真实上游值喂入 → `[]`             | 若上游改名/漂移则报差异                                                                                                                | 未链接整件 skip（CI 安全）                                                                         |
| `src/main/nikkisync/embedding-paths.test.ts`                  | dev 与 packaged 两条解析路径            | SQL 缺失 → `NikkiSyncAssetError` 文案含路径与修复指令；非法 specifier（`@nikkisync/../x`、`react`）→ 抛错；`resourcesPath` 为空 → 抛错 | unpacked 不存在 → 回退 asar 路径且 `fellBackToAsar === true`；`@nikkisync/pc-companion` 连字符包名 |
| `src/main/nikkisync/probe.test.ts`（追加）                    | 报告含 `schemaSource` 行                | SQL 读不到时 `[database] ok=false` 且 error 指向显式路径                                                                               | 未链接态纯函数用例仍跑、链接用例 skip                                                              |

## 6. 回归与提交

- 即时回归：每个节点完成后立即跑该节点相关测试子集（§3 命令表），失败即停在本节点修复，不带病推进。
- 收尾全量：`npm run typecheck`（判据 0）、`npm run lint`（0 error，11 存量 BOM warning 不新增）、`npm run format:check`、`npm test`（失败文件集合 ⊆ 阶段 7 的 4 个文件：`annotations.test.ts`、`sync-write-repository.test.ts`、`api-router.test.ts`、`sync-server.integration.test.ts`；其余用例保持通过）、`npm run i18n:guard`、`npm run verify`。
- 覆盖率：`npm run test:coverage` 在本树仍不可评定（`01-dependency-link-plan.md` §14 R9 已举证：存在失败测试文件时 vitest 不产出覆盖率输出），沿用其"可计算稀释口径"记录，不改 `vitest.config.ts` 阈值。
- 提交闸门：只 stage 本次改动文件 → `npx tsx scripts/core-path-gate.ts --staged`（本次未触 `src/main/preload/api`、`src/main/ipc/handlers`、`src/main/services`、`src/shared/errors` 四类受保护目录，无需 `@core-change` 注释）→ `npx --no-install tsc -b` 退出码 0 → `npx tsx scripts/run-precommit-tests.ts <staged>`。阶段 7 红灯 WIP 保持未提交，不混入同一笔。
- 提交拆分（待用户确认后执行）：`fix(sync): 补全 getAssetDetail 契约返回并修复类型导入` / `build(deps): 将 NikkiSync 依赖改为开发机 junction 链接以恢复 CI` / `refactor(sync): 收敛协议契约至 vendored 单一真相源并加漂移守护` / `fix(nikkisync): 打包态模块入口与 migrations 路径解析` / `docs(sync-integration): 阶段 9 遗留债务修复计划`。

## 7. 风险与兜底

| 风险                                                              | 兜底                                                                                                                                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm install` 因镜像/网络无法重写 lockfile                        | `npm install --package-lock-only --offline`；仍失败则手工移除 lock 中 4 个 `@nikkisync` 节点后 `npm install --prefer-offline` 校验一致性                                                    |
| 删除 `NikkiSyncTypeSurface` 失去"四包 `.d.ts` 可解析"的编译期告警 | 三层替代：`verify:nikkisync` 文件级双存在检查（`dist/src/index.js` + `dist/src/index.d.ts`）+ 探针 12 项必需导出断言 + `protocol-drift.test.ts`；本文件显式记录该取舍为自包含方案的必然代价 |
| npm 可能把 undeclared 的 `node_modules/@nikkisync` 判为外物剪枝   | 未链接态是受支持默认态（warn + 精确指令）；`link:nikkisync` 幂等可重跑                                                                                                                      |
| 新增文件拖低覆盖率阈值（statements 69）                           | 全部为带三类用例的纯函数；按 §6 口径记录稀释量，不改阈值                                                                                                                                    |
| 打包产物内 ESM 仍可能解析失败（当场无法证实）                     | 不谎报：交付路径解析 + 显式 `schemaSql` + 闸门脚本 + 单测；`electron-builder --dir` 与 exe 实跑列在 §4「待链接复验清单」，命令与判据已写死                                                  |
| `tsc -b` 增量缓存可能掩盖模块解析回归                             | 判定命令统一加 `--noEmit -p src/main/tsconfig.json` 直跑；闸门复验用 `npm run typecheck`                                                                                                    |

## 8. 执行记录

执行窗口：2026-10-13（本地 Node v26.3.0 / npm 11.16.0；Electron 实装 41.10.6；分支
`feat/gallery-runtime-embed` HEAD `9815e68`）。全部命令由 Agent 亲自执行，未使用 `--no-verify`，未绕过任何闸门。

### 8.1 基线（步骤 0）

与 §0 表逐字一致（6 错 typecheck / 12 problems lint / nikkisync 11 例假失败 / 阶段 7 17 例失败 + 2 文件模块缺失）。

### 8.2 节点 1（问题 1）

- 红灯原文：`npx vitest run src/main/database/sync-read-repository.test.ts` →
  `S14a`、`S14b`、新追加的 `S14d` 均 `AssertionError: expected undefined to ...`（`Tests 3 failed | 23 passed (26)`）；
  `npx tsc --noEmit -p src/main/tsconfig.json` 含 TS2503/TS2322。
- 修后绿灯：同一命令 `Test Files 1 passed`、`Tests 26 passed (26)`；`npx eslint` 该文件 `ESLINT_EXIT=0`；
  `npx --no-install tsc -b` → **退出码 0**（即 `.husky/pre-commit` Step 3 的同一命令）。
- 偏差：无。

### 8.3 节点 2（问题 2 + 4×TS2307）

- 红灯原文：新文件 `scripts/__tests__/self-contained-deps.test.ts` 首跑 `6 tests | 6 failed`
  （`collectOutOfRepoSpecs is not a function`、`expected [ '@nikkisync/core', … ] to deeply equal []`、
  `expected [ Array(30) ] to include 'node_modules/@nikkisync/**/*'）；
`scripts/**tests**/link-nikkisync.test.ts`首跑`Error: Cannot find module '../link-nikkisync'`。
- 落地：`package.json` 删 4 条 `file:` 依赖 + 新增 2 个 script + `build.files` 追加
  `node_modules/@nikkisync/**/*`；`npm install` 退出码 0（仅 allow-scripts 警告）；
  `Select-String package-lock.json -Pattern 'file:\.\./NikkiSync'` 命中 **0**；`node_modules/@nikkisync/core/package.json` 不存在（hasNikkiSyncLink → false）。
- 修后绿灯：`npm run typecheck` 退出码 **0**；`npx vitest run scripts/__tests__ src/main/nikkisync` →
  `Test Files 11 passed`、`Tests 162 passed | 11 skipped`；`npm run verify:nikkisync` 退出码 **0**（8 项全 ✓，未链接为 warn）；
  `npm run link:nikkisync:check` 在无 NikkiSync 时退出码 1 并逐候选给出拒绝原因（不把缺失伪装成就绪）。
- **CI 模拟的偏差与理由**：未跑真 `npm ci`（会删重建 node_modules 并因 `--ignore-scripts` 跳过 electron 两二进制下载，
  破坏本机 dev/e2e 环境），改用同等的解析面验证：`npm ci --dry-run --ignore-scripts` 退出码 **0**
  （当前环境本来就没有 `../NikkiSync`，等价于 CI 的只 checkout 本仓条件）+ lockfile grep 0 命中 + `tsc -b` 0。
- 实现偏差 D1：`hasNikkiSyncLink()` 最初自行用 `import.meta.url` 推项目根，`src/main/tsconfig.json` 为
  `module: commonjs` 而报 **TS1343**；改为 `hasNikkiSyncLink(projectRoot: string)`，由测试侧传入自身目录（规则仍单一真相源）。
- 实现偏差 D2：原计划将折叠/打包两项只读检查归入节点 4，因 `NikkiSyncLinkFacts` 形状在同一文件里只能改一次，
  已提前在节点 2 一并实现（节点 4 只消费）。
- 实现偏差 D3：未链接但 `release/` 残留旧产物（2.5.5）时，“打包态缺 SQL”会误报 blocking fail；
  改为仅“当前已链接 + 产物内确实缺 SQL”才硬阻断，否则 warn，并补对应边界用例。

#### 8.3.1 二级审计后的补齐处理（同一节点内完成）

逐项对账 Spec 后发现并补齐的 4 项：

1. **“fallback 根解析复用 `resolveNikkiSyncRoot`”未落实** → 已落实：`verify-nikkisync-link.ts` 现在 import
   `toRootCandidates` + `resolveNikkiSyncRoot`（与链接脚本共用优先级与必需子目录判定），新增第 9 项只读检查
   `a NikkiSync checkout is discoverable for linking`（warn 不阻断）：未链接但找得到检出→给出路径与
   `npm run link:nikkisync`；找不到→列出三个候选根与 clone/`NIKKISYNC_ROOT` 指令；已链接→`skipped`。
   先写 3 例新用例取红灯（`Tests 1 failed`：`ok` 布尔方向写反，由 `!linked || …` 改为 `linked || …`）→ 16 例全绿。
2. **验收行 `Test-Path node_modules/@nikkisync` = False 未字面成立**：`npm install` 剪枝后残留空作
   用域目录（含 0 项，对解析无任何影响）。已删除该空目录，现在 `Test-Path 'node_modules\@nikkisync'` → **False**；
   真正的就绪判据仍是 `hasNikkiSyncLink(projectRoot)`（探测包内 `package.json`）。
3. **根 `AGENTS.md` 未同步**：装载缝导航行原写“类型/值面分工…链接前置条件”，与类型锚点退役矛盾；
   已改为“不引用上游类型（协议真相源在 `shared/sync`）…链接由 `npm run link:nikkisync` 建立”。
4. **提交闸门证据缺失**（§7 表第 8 行）：先取不改 index 的两份证据
   （`npx tsx scripts/core-path-gate.ts` 工作区模式、`… core-path-gate.ts <本次 14 个文件>` 显式模式，
   均输出“不涉及核心路径受保护文件，跳过”并退出码 0），再按 §7 字面流程取**暂存区模式**证据：
   `git add` 本次 27 个文件 → `npx tsx scripts/core-path-gate.ts --staged` 退出码 **0** →
   `npx --no-install tsc -b` 退出码 **0** → `npx tsx scripts/run-precommit-tests.ts <13 个 staged src TS>`
   → `找到 6 个相关测试文件`、`5 passed | 1 skipped`、`60 passed | 13 skipped`、退出码 **0**
   （probe-cli.ts 与 index.ts 无匹配套件 → 仅告警）。取完证据后 `git reset` 已把索引恢复原状（未提交）。
   `npm run verify:nikkisync --json` 输出 **9** 项检查且 `ok=true`（结构化输出与文本模式同源）。

### 8.4 节点 3（问题 4）

- 新文件：`protocol-contract.ts`（+ `.test.ts` 12 例全绿）、`protocol-drift.test.ts`（未链接整件 skip）。
- 验收：`Get-ChildItem src -Recurse -Include *.ts | Select-String "from '@nikkisync"` 命中 **0**；
  `npx vitest run src/main/nikkisync src/shared/sync` → `Test Files 5 passed | 1 skipped`、`Tests 51 passed | 13 skipped`；
  `npm run typecheck` 退出码 0。`src/shared/sync/protocol.ts`、`domain-types.ts`、`protocol.test.ts` 本次零改动。

### 8.5 节点 4（问题 3）

- 新文件：`embedding-paths.ts` + `embedding-paths.test.ts`（13 例）；`runtime-loader.ts` 增加打包态
  `file://` 兜底装载；`probe.ts` 在收到 context 时改传显式 `schemaSql` 并在报告输出 `schemaSource`；
  `src/main/index.ts` 探针钩子与 `probe-cli.ts` 按 `app.isPackaged` / `process.resourcesPath` 下传 context；
  `scripts/pre-dist-check.ts --verify-asar` 补 `@nikkisync` 入包/SQL/四包入口断言（未入包时输出 `⊘ SKIP` 不影响退出码）。
- **红灯约束的偏差与补偿**：本节点的新文件是“测试与实现同步写”，未观察到预期的“模块不存在”红灯。
  为证明测试非空洞，做了变异验证：（a）去掉 unpacked→asar 回落、（b）去掉空 SQL 校验
  → `Tests 2 failed | 11 passed (13)`，且恰好命中“边界：unpacked 缺失时回落”与“异常：空文本视为未编译”两例；
  随后已逐字恢复实现。
- 当场可验验收：`npx vitest run src/main/nikkisync` → `Test Files 4 passed | 1 skipped`、`Tests 34 passed | 13 skipped`；
  `npm run build` 退出码 0；`Select-String dist\main\main\app\*.js -Pattern 'require\(.@nikkisync'` 命中 **0**（`await import(` 命中 4）；
  `npm run verify:nikkisync` 退出码 0（含折叠闸门）；`npm run verify:dist` 退出码 0（输出两行 `⊘ SKIP` 说明未建链）。
- **仍未证实**：asar 内的真实 ESM 装载与 `migrations` 实读（需 NikkiSync 就位），见 §4「待链接复验清单」。

### 8.6 节点 5（全局回归）

| 门禁             | 命令                                                       | 本次结果                                                                                               | 相对基线                                                                                                                                                                                                                                 |
| ---------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 类型             | `npm run typecheck` / `npx tsc -b`                         | 退出码 **0**                                                                                           | 基线 6 错 → 0（问题 1 硬指标达成）                                                                                                                                                                                                       |
| Lint             | `npx eslint .`                                             | `11 problems (0 errors, 11 warnings)`                                                                  | 基线 1 error → **0 error**；warnings 不增                                                                                                                                                                                                |
| 全量测试         | `npx vitest run`                                           | `Test Files 4 failed \| 363 passed \| 1 skipped (368)`；`Tests 15 failed \| 5731 passed \| 15 skipped` | 失败集合 ⊆ 基线（仅阶段 7 写端点 4 个文件）；nikkisync 11 例假失败与 read-repo 2 例已转绿                                                                                                                                                |
| i18n             | `npm run i18n:guard` / `npm run i18n:check`                | 退出码 **0**                                                                                           | 持平                                                                                                                                                                                                                                     |
| 提交面测试子集   | `npx tsx scripts/run-precommit-tests.ts <本次 5 个源文件>` | `5 files passed`、`60 passed \| 11 skipped`、退出码 **0**                                              | 新增用例均绿                                                                                                                                                                                                                             |
| 打包面           | `npm run verify:dist`                                      | 退出码 **0**                                                                                           | 新增 @nikkisync SKIP 行                                                                                                                                                                                                                  |
| 格式             | `prettier --check`（本次 25 个相关文件）                   | 仅 `scripts/pre-dist-check.ts` 仍 FAIL                                                                 | 已举证为**存量**：`git show HEAD:scripts/pre-dist-check.ts \| prettier --check --stdin-filepath` 同样失败；仓内全量 `format:check` 因本机 `core.autocrlf=true` 有 617 个文件报红（含未触碰的 `scripts/i18n/guard.ts`），本次未顺手格式化 |
| `npm run verify` | 汇总只读闸门                                               | typecheck ✓ / lint ✓ / core-gate ✓ / format ✗（上述存量）/ test ✗（阶段 7 红灯）                       | 两项失败均可逐字归因到存量，无本次新增                                                                                                                                                                                                   |

### 8.7 本次改动面

- 修改（已跟踪）：`AGENTS.md`（根，导航行口径）、`package.json`、`src/main/database/sync-read-repository.ts`（+ 其 `.test.ts`）、
  `src/main/index.ts`、`scripts/pre-dist-check.ts`、`scripts/AGENTS.md`、`src/shared/sync/README.md`。`package-lock.json` 经
  `npm install` 后与 HEAD 一致（四条 link 条目是阶段 1 的未提交改动，移除后回归原状，因此 `git status` 不再列它）。
- 修改（阶段 1 未跟踪 WIP）：`src/main/nikkisync/runtime-loader.ts`（+ test）、`probe.ts`（+ test）、`probe-cli.ts`、`AGENTS.md`、`scripts/verify-nikkisync-link.ts`（+ test）、
  `docs/sync-integration/01-dependency-link-plan.md`。
- 新增：`scripts/link-nikkisync.ts`、`scripts/__tests__/link-nikkisync.test.ts`、`scripts/__tests__/self-contained-deps.test.ts`、
  `src/main/nikkisync/embedding-paths.ts`（+ test）、`protocol-contract.ts`（+ test）、`protocol-drift.test.ts`、本文件。
- 未改：`.github/workflows/build.yml`、`vitest.config.ts`、`src/main/sync/**`、`src/shared/sync/protocol.ts` 与 `domain-types.ts`、NikkiSync 侧（本机不存在）。
- **未执行 `git commit`**（等待用户确认拆包与是否一并处置阶段 7 WIP）；未使 `--no-verify`。

### 8.8 遗留项

1. 阶段 7 写端点实现（`sync-write-repository.ts` / `annotations.ts` / `api-router` 写分支）仍为红灯，不属本次范围。
2. 打包态 ESM/migrations 的真实复验待 NikkiSync 检出（§4 清单 V1–V6）。
3. `scripts/pre-dist-check.ts` 的存量格式债（HEAD 即不合规）建议单独一笔清偿。
4. `01-dependency-link-plan.md` §11 用例 2、§7 描述的“`import type` 锚点”已退役，历史执行记录保留不改，本文件 §8.3/§4 为现行口径。
