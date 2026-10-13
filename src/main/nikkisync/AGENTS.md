# AGENTS.md — `src/main/nikkisync`（NikkiSync 外部包装载缝 · 主进程侧唯一入口）

本目录是 WXNN XiangCe 消费 **NikkiSync 包**（`@nikkisync/core` / `@nikkisync/database` /
`@nikkisync/protocol` / `@nikkisync/pc-companion`）的**唯一入口**。顶层项目速览见根目录
[`AGENTS.md`](../../AGENTS.md)，四条硬性编码约定与校验/提交口径见
[`docs/CODING_CONVENTIONS.md`](../../docs/CODING_CONVENTIONS.md)（唯一真相源）。整合计划与选型依据见
[`docs/sync-integration/01-dependency-link-plan.md`](../../docs/sync-integration/01-dependency-link-plan.md)，
阶段 9 自包含改造见 [`docs/sync-integration/09-legacy-debt-remediation-plan.md`](../../docs/sync-integration/09-legacy-debt-remediation-plan.md)。

## 与 `src/main/sync/` 的分工

| 目录                  | 角色                           | 依赖面                                                                          |
| --------------------- | ------------------------------ | ------------------------------------------------------------------------------- |
| `src/main/sync/`      | 移植面服务层（自有实现）       | 只依赖 node 内置 + `src/shared/sync/` + `database` 仓储                         |
| `src/main/nikkisync/` | 外部包装载缝（复用 NikkiSync） | 依赖 `npm run link:nikkisync` 建链后 `node_modules/@nikkisync/*` 指向的编译产物 |

两者当前**并存**，但职责已分定（阶段 9 决策）：协议契约的唯一真相源是移植面
`src/shared/sync/protocol.ts`（含 `domain-types.ts` / `protocol-extension.ts`）；本目录不再引用任何
`@nikkisync/*` 类型或值，上游包只作为**链接运行时探测与漂移比对对象**（见 `protocol-drift.test.ts`）。

## 文件职责

| 文件                     | 职责                                                                                                                                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime-loader.ts`      | 装载缝：包名/specifier 表、必需导出表、变量式 `await import()`、`hasNikkiSyncLink()` skip 门控、可诊断错误类型                                                                                                                                        |
| `probe.ts`               | `runNikkiSyncLinkProbe()`：四包导出存在性 + `:memory:` 建表 + pc-companion Context 校验，返回结构化报告；`formatNikkiSyncLinkProbeReport()` / `isNikkiSyncProbeErrorLine()` 为输出层纯函数                                                            |
| `probe-cli.ts`           | 入口薄壳（electron-vite main 的 `nikkisync-probe` 入口）：只跑探针 → 分流 stdout/stderr → 定退出码；文本内容不在本文件生成                                                                                                                            |
| `protocol-contract.ts`   | 协议契约快照纯函数（零依赖）：`collectVendoredContract()` / `upstreamSnapshotFromModules()` / `diffProtocolContract()` 与 `VENDORED_CONTRACT_SYMBOLS` 清单——vendored 为唯一真相源后的防分叉底座                                                       |
| `protocol-drift.test.ts` | 链接态漂移守护：把上游 `@nikkisync/protocol`（+ `core` 兜底）实测值喂给同一套纯函数并断言零差异；未链接整件 skip                                                                                                                                      |
| `embedding-paths.ts`     | 打包态资源路径纯函数：`buildPackagingContext()` / `resolveModuleRoot()`（优先 `app.asar.unpacked`，未命中回落 `app.asar` 并置 `fellBackToAsar`）/ `resolveEntryUrl()` / `resolveMigrationsSqlPath()` / `readMigrationsSql()` 与 `NikkiSyncAssetError` |
| `runtime-loader.test.ts` | Vitest node project 测试（计划 §11 用例 1-7）                                                                                                                                                                                                         |
| `probe.test.ts`          | 4 例纯函数（`formatNikkiSyncLinkProbeReport` 的正/负例、n/a 降级、schemaSource 行条件输出，不依赖链接）+ 3 例在本地 Node（>= 24）上跟真实装载链，与 Electron 侧 `nikkisync-probe.js` 共用同一实现                                                     |

## 硬性约定

1. **禁止静态值导入 `@nikkisync/*`**：NikkiSync 的 ESM 图含 top-level await，静态值导入会被
   打包器折叠成 `require()`，运行时必现 `ERR_REQUIRE_ASYNC_MODULE`。该禁令由 `eslint.config.js`
   两层护栏固化（已实测）：`no-restricted-imports`（`group: ['@nikkisync/*']` +
   `allowTypeImports: true`）拦静态 import/export，`no-restricted-syntax` 的
   `ImportExpression[source.value=/^@nikkisync\//]` 补拦字面量 `import()`。
   - 类型 → **不再引用**（阶段 9 起 `@nikkisync/*` 不是声明依赖，`import type` 在 CI 下会报
     TS2307；历史类型锚点 `NikkiSyncTypeSurface` 已退役）。
   - 值 → 一律 `await loadNikkiSyncPackage(...)` / `loadAllNikkiSyncPackages()`。
2. **interface 型导出不做运行时断言**：`NikkiAsset` / `MediaResource` 等是 interface，无运行时
   值。上游 `.d.ts` 的可解析性不再由编译期锚点保证，改由三层守卫承担：
   `npm run verify:nikkisync`（`dist/src/index.js` + `index.d.ts` 双存在）、本目录
   `NIKKISYNC_REQUIRED_EXPORTS` 运行时探针、`protocol-drift.test.ts` 契约比对；
   运行时等价断言用同包常量导出（`ASSET_TYPES` / `RESOURCE_ROLES` 等）。
3. **探针不得启动任何东西**：不调 `PcCompanionRuntime.start()`，不实例化 `LocalSyncServer` /
   `ScannerService` / `MdnsAdvertiser`（`start()` 以"找到游戏安装目录"为硬前置，且会占用端口、
   发起组播、写 TLS 身份）。数据库只允许 `':memory:'`，用完必须 `close()`。
4. **打包态必须传 PackagingContext**：入口（`src/main/index.ts` 的探针钩子、`probe-cli.ts`）
   在 `app.isPackaged` / `process.resourcesPath` 存在时构造并下传 context；否则上游
   `DatabaseManager.initialize()` 靠 `import.meta.url` 定位 `migrations/0001_initial.sql` 在 asar 内
   不可靠，且 `@nikkisync/*` 解包后真实落点在 `app.asar.unpacked`。开发态不传 context
   （保持阶段 1 已验证行为）。
5. **`import type` 之外的包名不散落**：新增/改名包只能改 `NIKKISYNC_PACKAGES` 与
   `NIKKISYNC_REQUIRED_EXPORTS` 两处单一真相源，测试与探针共用。
6. **依赖前置**：链接由 `npm run link:nikkisync` 建立（候选根：`NIKKISYNC_ROOT` → `../NikkiSync` →
   `vendor/NikkiSync`），消费的是 NikkiSync 的 `dist/` 产物。**未链接是受支持的默认态**：
   装载类测试整件 skip、`verify:nikkisync` 只给 warn，不得把环境缺失伪装成逻辑失败。
   链接就绪但 NikkiSync 未 `npm run build` 时，装载错误会显式指向该修复动作
   （`npm run verify:nikkisync` 给出完整事实表）。skip 门控必须用
   `hasNikkiSyncLink(projectRoot)`（按包内 `package.json` 可解析判定）而非目录存在判定，
   否则悬空 junction 会造成假失败。
7. **字符串字面量保持英文**：`src/**` 的中文硬编码护栏（`no-restricted-syntax`）为 error；
   中文只出现在注释与文档中。同一护栏块禁止 `console.log/info/debug`：入口壳用
   `process.stdout.write`，失败行用允许的 `console.error`。
8. **输出层必须是纯函数**：报告→文本形态（`formatNikkiSyncLinkProbeReport`）与错误分流判据
   （`isNikkiSyncProbeErrorLine`）留在 `probe.ts` 内可单测；`probe-cli.ts` 不得再增加业务逻辑
   （否则入口壳的 0% 覆盖面会随功能增长，把真实覆盖率问题藏进排除项）。
