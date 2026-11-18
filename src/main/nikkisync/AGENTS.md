# AGENTS.md — `src/main/nikkisync`（NikkiSync 外部包装载缝 · 主进程侧唯一入口）

本目录是喵星图消费 **NikkiSync 包**（`@nikkisync/core` / `@nikkisync/database` /
`@nikkisync/protocol` / `@nikkisync/pc-companion`）的**唯一入口**。顶层项目速览见根目录
[`AGENTS.md`](../../../AGENTS.md)，四条硬性编码约定与校验/提交口径见
[`docs/CODING_CONVENTIONS.md`](../../../docs/CODING_CONVENTIONS.md)（唯一真相源）。整合计划与选型依据见
[`docs/sync-integration/01-dependency-link-plan.md`](../../../docs/sync-integration/01-dependency-link-plan.md)，
阶段 9 自包含改造见 [`docs/sync-integration/09-legacy-debt-remediation-plan.md`](../../../docs/sync-integration/09-legacy-debt-remediation-plan.md)。

## 与 `src/main/sync/` 的分工

| 目录                  | 角色                           | 依赖面                                                                          |
| --------------------- | ------------------------------ | ------------------------------------------------------------------------------- |
| `src/main/sync/`      | 移植面服务层（自有实现）       | 只依赖 node 内置 + `src/shared/sync/` + `database` 仓储                         |
| `src/main/nikkisync/` | 外部包装载缝（复用 NikkiSync） | 依赖 `npm run link:nikkisync` 建链后 `node_modules/@nikkisync/*` 指向的编译产物 |

两者当前**并存**，但职责已分定（阶段 9 决策）：协议契约的唯一真相源是移植面
`src/shared/sync/protocol.ts`（`protocol.ts` + `domain-types.ts`；曾拟新增的 `protocol-extension.ts` 从未提交，只存在于本机 `stash@{0}` 的阶段 7 WIP）；本目录不再引用任何
`@nikkisync/*` 类型或值，上游包只作为**链接运行时探测与漂移比对对象**（见 `protocol-drift.test.ts`）。

## 文件职责

| 文件                                  | 职责                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime-loader.ts`                   | 装载缝：包名/specifier 表、必需导出表、变量式 `await import()`、`hasNikkiSyncLink()` skip 门控、可诊断错误类型                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `probe.ts`                            | `runNikkiSyncLinkProbe()`：四包导出存在性 + `:memory:` 建表 + pc-companion Context 校验，返回结构化报告；`formatNikkiSyncLinkProbeReport()` / `isNikkiSyncProbeErrorLine()` 为输出层纯函数                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `probe-cli.ts`                        | 入口薄壳（electron-vite main 的 `nikkisync-probe` 入口）：只跑探针 → 分流 stdout/stderr → 定退出码；文本内容不在本文件生成                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `protocol-contract.ts`                | 协议契约快照纯函数（零依赖）：`collectVendoredContract()` / `upstreamSnapshotFromModules()` / `diffProtocolContract()` 与 `VENDORED_CONTRACT_SYMBOLS` 清单——vendored 为唯一真相源后的防分叉底座                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `protocol-drift.test.ts`              | 链接态漂移守护：把上游 `@nikkisync/protocol`（+ `core` 兜底）实测值喂给同一套纯函数并断言零差异；未链接整件 skip                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `embedding-paths.ts`                  | 打包态资源路径纯函数：`buildPackagingContext()` / `resolveModuleRoot()`（优先 `app.asar.unpacked`，未命中回落 `app.asar` 并置 `fellBackToAsar`）/ `resolveEntryUrl()` / `resolveDeepEntryUrl()`（阶段 2：不在桶导出内的 `dist/src/**` 深入口）/ `resolveMigrationsSqlPath()` / `readMigrationsSql()` 与 `NikkiSyncAssetError`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `runtime-types.ts`                    | 阶段 2 结构面类型 + 阶段 3 服务面类型 + K9 账号作用域类型：本仓自声明的 `EmbeddedRuntimeLike` / `ScannerServiceLike` / `DatabaseManagerLike` / `NikkiSyncQuerySurface` / `NikkiSyncRuntimeSession` / `NikkiSyncRuntimeStatus` / `NikkiSyncRuntimeHandle` / `LocalSyncServerLike` / `AccountSyncSettingsLike` / `NikkiSyncSyncServer*` / `NikkiSyncPairedDeviceView`（**不得** `import type` 上游包）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `runtime-facade.ts`                   | 阶段 2 装载 + 组装 + 只读查询，阶段 3 加服务面，K9 接账号作用域：`loadRuntimeSurface()`（含 `server/row-mappers.js` 深入口）、`createRuntimeSession()`（构造期下传 `syncServer` 配置 + 晚绑定 `accountSourceDirectories` 闭包；`ExtraScanDirectories` 第四参对齐上游 `windows-app` 的 `sourceDirectoriesChanged`）、`createQuerySurface()`（`SyncReadRepository` 双参注入账号选择/来源分组 + `row-mappers` 零转换透传）、`listChanges` 判据 `after < accounts.revision() \|\| after < minimum - 1`、`PAIRED_DEVICES_SQL`（上游缺 list API 的只读 SELECT）、`encodePageCursor/decodePageCursor`、`createManagerDependencies(defaults, log, pairingHostResolver?)`                                                                                                                                                                                                                                                                                                                                                                       |
| `runtime-facade.test.ts`              | 装载面与会话面用例（假 surface 注入，**不依赖链接**，未链接 CI 亦必跑）：深入口常量指向、`createQuerySurface` 的批量资源记录/增量变更（判据与上游 `GET /v1/changes` 逐字一致：`accounts.revision()` 与 `minimum - 1` 两支）/搜索与统计/`media://` 授权联动、`createRuntimeSession` 的各注入缝（C5 四缝、K2 同意门、K3 版本面、K6 额外目录、K7 扫描诊断、K9 账号作用域、阶段 6 元数据解析），以及「深入口缺席 ⇒ 会话不挂该面」的老链接降级支                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `sync-server-view.ts`                 | 阶段 3 纯函数层（零上游引用）：`resolveSyncServerConfig` / `embeddedServerConfig`（折算上游 `LocalSyncServerConfig`，刻意不传 `tls`）、`normalizeSyncPort` / `normalizeJournalPollMs`、`isPortInUseError` / `classifySyncStartError`（`PORT_IN_USE` 判据同上游 `StartupFailure.ts`）、`mapPairedDeviceRow`、`parsePairingUri`、`buildSyncStatusSnapshot`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `sync-server-view.test.ts`            | 上述纯函数的正常/异常/边界用例（不依赖链接）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `runtime-manager.ts`                  | 生命周期状态机（唯一依赖注入面）：`unavailable/idle/starting/running/scanning/degraded/stopping/error`；`start()` 永不外抛（无游戏目录 ⇒ `degraded`）；`scan()` 惰性启动与换根重建；照片目录生效通道 `applyGameRoot(gameRoot)`（刷新 `deps.defaults` 快照 + 复用 `scan()` 换根重建 + 原本在监听时复原 LAN 服务；失败原样上抛，由 handler 归一 `applyError`）；`stop()` 幂等 + 单步超时兜底；阶段 3 增 `startSyncServer`/`stopSyncServer`/`syncStatus`/`pairingCode`/`listPairedDevices`/`revokeDevice`（改端口 = 重建会话）；阶段 6 增会话代次（`generation`，拆除时递增，用于让在途解析驱动停止发起下一轮）与 `status().metadata` 快照，teardown 顺序改为 `metadataResolver.stop → server.stop → scanner.stop → dispose`（先停生产者）；上游 b397e0e 起查询面保持零转换（资产行含 `sourcePath`/`sourceFolder`，不再裁键）；K9 增账号作用域薄委托（`listSyncAccounts` / `previewSyncAccount` / `setSyncAccountSelection`）与目录来源标注（`setExtraDirectorySource`），`requireAccounts()` 缺席抛 unavailable；导出 `runWithTimeout()` |
| `runtime-manager.test.ts`             | 状态机用例（假 facade 注入，不依赖链接），含阶段 3 同步服务编排与查询零转换（顶层 + 嵌套 `photos[].asset` 均保留 `sourcePath`/`sourceFolder`；`path` 模式原值）、照片目录生效通道 `applyGameRoot`（换根重建 + 快照刷新不回退 + LAN 复原/不误启）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `runtime-facade.linked.test.ts`       | 链接态集成：建库 + **16 张业务表闭集**（12 张来自 `0001_initial.sql`，4 张由上游运行期自建：`organizer_deletions` 与三张 `inspiration_sync_*`；另有派生的 `sqlite_sequence`）、上游扫描、`motion_photo` 聚合、DTO 透传（含 `sourcePath`/`sourceFolder` 原样）、游标分页、K9 账号作用域（默认全选 / 选择过滤 / `[]` / `null` / 来源分组出现与消失 / `fullResyncRequired`）、**完整生命周期**（stop 后 `-wal` 已 checkpoint、可重新 start）；未建链整件 skip                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `sync-server.linked.test.ts`          | 阶段 3 链接态集成：真起上游 TLS 服务，逐端点验 Protocol v1（免鉴权 2 条 / 签名 9 条 / Range 206+416 / WS `server.hello`+`asset.created` / 配对与重放 / 停止重启 / 端口占用归类 / TLS 指纹持久化）；未建链整件 skip                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `runtime-cli-report.ts`               | 阶段 2 验证入口的输出层纯函数：`parseRuntimeCliArgs()` / `formatRuntimeRunLines()` / `isRuntimeRunErrorLine()`（与 `probe.ts` 同角色，壳不得长业务）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `metadata-resolver-driver.ts`         | 阶段 6：元数据解析的**零依赖纯函数层**（开关判定 / `metadataResolver` 配置片段折算 / 扫描后有界驱动）。不 import Electron、不 import `@nikkisync/*`、不发网络，故未建链的 CI 也必跑。**三条不可让步判据**：关闭时连配置键都不下发（上游 `runOnce()` 首行 `!enabled` 会直接返回 0）；绝不下发 `intervalMs`（上游用 `??`，传 0 会造出 `setInterval(fn,0)`）；驱动永不 reject（上游 `runOnce` 外层只有 try/finally 无 catch）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `metadata-isolation-guards.ts`        | 阶段 6：表级隔离谓词（只认 SQL 语句上下文里的表引用），把「同步面绝不写原有库表」折成可断言判据。禁用集刻意**不含** `app_settings` / `schema_migrations`（上游库里同名表也存在，列进来会让护栏恒真失效）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `metadata-resolver.isolation.test.ts` | 阶段 6：两档隔离守护，沿用 `scanner/__tests__/rescan-restore-sql.test.ts` 的形态——结构档（源码文本，任何 Node 必跑）+ 语义档（`node:sqlite` 真实执行上游三条 SQL，证明 `media_files` 行/列/内容三不变，**不需要** `better-sqlite3`，绕开 Electron ABI 与 `vi.mock` 对原生模块无效的限制）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `metadata-resolver.linked.test.ts`    | 阶段 6 链接态集成：经 `createRuntimeSession` 的 `preloadedSurface` 测试缝把上游 `Nuan5CompatibleResolver` 换成假解析器 ⇒ **零出站请求**下验证真上游确实构造服务、逐批落库、推进 revision/journal/诊断计数。未建链整件 skip                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `runtime-cli.ts`                      | 阶段 2 无 UI 验证入口（electron-vite main 的 `nikkisync-runtime` 入口）：`start → scan → query → stop`，只跑流程 + 分流 stdout/stderr + 定退出码                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `runtime-loader.test.ts`              | Vitest node project 测试（计划 §11 用例 1-7）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `probe.test.ts`                       | 4 例纯函数（`formatNikkiSyncLinkProbeReport` 的正/负例、n/a 降级、schemaSource 行条件输出，不依赖链接）+ 4 例在本地 Node（>= 24）上跑真实装载链（含「schema SQL 读取失败也必须 close 内存库」这条硬边界），与 Electron 侧 `nikkisync-probe.js` 共用同一实现                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `resource-allowlist.ts`               | `media://` 展示授权的第 4 条规则（精确路径白名单）：`registerNikkiSyncResourcePaths` 按会话登记可展示路径，`registerNikkiSyncResourcePath` 补单条预览项（ revision 滚动后旧单条仍需可见），`isNikkiSyncResourcePath` 判定，`clearNikkiSyncResourcePaths` 随会话拆除清零；带计数读数供诊断。**这份指引曾漏记本文件（它比表格其余行都新）**，2026-11-02 补上                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `pc-companion-services.ts`            | 2026-11-06 PC 对齐轮：复用上游 `createDesktopControlServer` / `WeChatGalleryService` 装配本机控制页（`desktop/*`）与微信画廊（`wechat/*`），经 `manager.pcCompanionContext()` 注入真实 database / 扫描根 / 配对串；可选面深入口缺件 ⇒ 整段降级不包装，不抛                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `dictionary-manifest.ts`              | G4（2026-11-13 windows-shell 对齐）：本地字典 manifest 与已核验服装名补充的宿主装配（对齐上游 `windows-app.ts` 的 `metadataDictionary` 键）。文件缺失/损坏时整个键不下发并给出可诊断 warning——绝不静默吞错，也不伪装成「用户关掉了字典」                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `local-photo-resolver-adapter.ts`     | G1：「电脑端优先本地解析照片」宿主适配器（上游 `windows-app.ts:136-140` 等价接线）——复用 `src/main/services/decryption-service.ts` 的 koffi 解码链产出原始文本，交给上游 `parseLocalPhotoMetadata` 归一化；纯函数层，不 import electron、不加载 DLL，外部能力选项注入                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `scanner-config.ts`                   | G3：上游 `ScannerService` 构造期选项集中纯函数（`selectedInstallRoot` / `watcher` / `extraDirectories` / `retiredExtraDirectories`），对齐上游构造期读取形状，保持「缺省键连键都不下发」的既有判据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

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
3. **探针不得启动任何东西**：`probe.ts` / `probe-cli.ts` 不调 `PcCompanionRuntime.start()`，不实例化
   `LocalSyncServer` / `ScannerService` / `MdnsAdvertiser`（`start()` 以"找到游戏安装目录"为硬前置，且会占用端口、
   发起组播、写 TLS 身份）。数据库只允许 `':memory:'`，用完必须 `close()`。
   - 阶段 2 的**内嵌运行面**（`runtime-facade.ts` + `runtime-manager.ts`）是有意跨过这条边界的另一层：
     它启 `scanner`（建库 + 发现 + 扫描）；Runtime 构造期不可避免会生成
     自签 TLS 身份并写 `app_settings['server.tlsIdentity']`（上游行为，不得为规避它改 NikkiSync 源码）。
     库文件落 `{userData}/nikkisync/nikkisync.db`，不走上游默认 `%LOCALAPPDATA%/NikkiSync`。
   - **阶段 3 起，运行面可以启 LAN 服务**（边界仅适用于探针）：`runtime-manager.startSyncServer()`
     调**上游自己的** `runtime.server.start()`（不新建任何 HTTP/TLS/WS/mDNS 实现）。三条硬约束：
     ① 自 N1（2026-11-06 对齐上游 PC 端）起**默认开启**：`nikkisync.syncServerEnabled`
     缺省 `true`（`app/nikkisync-runtime-setup.ts` 的 `SYNC_ENABLED_DEFAULT = true`）。
     绑 `0.0.0.0` 属敏感暴露，故保留 `NIKKI_NIKKISYNC_RUNTIME=0` 全局逃生阀、
     六个 `NIKKI_NIKKISYNC_*=0` 分项阀与两份 `enabled:false` 离线 JSON 回退；
     `probe.ts` 不启服务的边界不变；
     ② `probe.ts` / `probe-cli.ts` / `runtime-cli.ts` **仍绝不**调 `server.start()`（探针语义不变）；
     ③ 端口/mdns 冻结在上游构造期 ⇒ 变更只能重建会话，`syncServer` 配置必须由 `createRuntimeSession`
     传入而不是启动后再改。构造 `mdns:true` 不组播（`mdns.start()` 只在 `start()` 内被调）。
     状态与配对面的纯函数在 `sync-server-view.ts`；上游缺 `listDevices` 才允许对 `paired_devices`
     做只读 SELECT（`runtime-facade.PAIRED_DEVICES_SQL`），撤销必须走上游 `PairingRepository.revoke`。
4. **打包态必须传 PackagingContext**：入口（`src/main/index.ts` 的探针钩子、`probe-cli.ts`）
   在 `app.isPackaged` / `process.resourcesPath` 存在时构造并下传 context；否则上游
   `DatabaseManager.initialize()` 靠 `import.meta.url` 定位 `migrations/0001_initial.sql` 在 asar 内
   不可靠，且 `@nikkisync/*` 解包后真实落点在 `app.asar.unpacked`。开发态不传 context
   （保持阶段 1 已验证行为）。
5. **`import type` 之外的包名不散落**：新增/改名包只能改 `NIKKISYNC_PACKAGES` 与
   `NIKKISYNC_REQUIRED_EXPORTS` 两处单一真相源，测试与探针共用。
   - 阶段 6 例外（勿"顺手补上"）：**深入口符号不进 `NIKKISYNC_REQUIRED_EXPORTS`**。
     那张表由 `probe.ts` 拿去在**桶导出**（`dist/src/index.js`）上做存在性判定，而
     `Nuan5CompatibleResolver` / `metadataResolutionDiagnostics` 都在桶外（实测桶只 re-export
     `metadata/MetadataResolverPipeline.js` 与 `metadata/types.js`），加进去只会在正确的构建产物上
     误报红。产物存在性改由 `scripts/verify-nikkisync-link.ts` 的 `METADATA_REQUIRED_ARTIFACTS` 承担。
6. **依赖前置**：链接由 `npm run link:nikkisync` 建立（候选根：`NIKKISYNC_ROOT` → `../NikkiSync` →
   `vendor/NikkiSync`），消费的是 NikkiSync 的 `dist/` 产物。**未链接是受支持的默认态**：
   装载类测试整件 skip、`verify:nikkisync` 只给 warn，不得把环境缺失伪装成逻辑失败。
   链接就绪但 NikkiSync 未 `npm run build` 时，装载错误会显式指向该修复动作
   （`npm run verify:nikkisync` 给出完整事实表）。skip 门控必须用
   `hasNikkiSyncLink(projectRoot)`（按包内 `package.json` 可解析判定）而非目录存在判定，
   否则悬空 junction 会造成假失败。
   - **`npm install` 会剪掉 `node_modules/@nikkisync` junction**（它们不是声明依赖）：装完依赖后
     必须重跑 `npm run link:nikkisync`（必要时 `npm run verify:nikkisync` 复验），否则链接态用例会
     集体降级为 skip，把真实回归藏起来。
7. **字符串字面量保持英文**：`src/**` 的中文硬编码护栏（`no-restricted-syntax`）为 error；
   中文只出现在注释与文档中。同一护栏块禁止 `console.log/info/debug`：入口壳用
   `process.stdout.write`，失败行用允许的 `console.error`。
8. **输出层必须是纯函数**：报告→文本形态（`formatNikkiSyncLinkProbeReport`）与错误分流判据
   （`isNikkiSyncProbeErrorLine`）留在 `probe.ts` 内可单测；`probe-cli.ts` 不得再增加业务逻辑
   （否则入口壳的 0% 覆盖面会随功能增长，把真实覆盖率问题藏进排除项）。
9. **LAN 内容受账号作用域过滤**：`SyncReadRepository` 必须拿到账号选择与来源分组两枚闭包
   （`createQuerySurface` 的 `runtime.server.accounts`）；`null` 选择 = 全部、`[]` = 一条都不下发。
   选择变更会 bump `accounts.revision()` 且 `listChanges.fullResyncRequired` 随之触发——不得在读路径
   缓存/加锁绕过上游语义；`sourceGroups()` 是上游读路径上的写操作（写 `app_settings` / `change_journal`），
   本仓不得为「纯只读」外观改写它。

10. **上游能力位只能观测「挂载事实」，不得下钻私有实现、也不得写死**：`/v1/server` 的
    `capabilities`（如 `inspirationV1`）由上游 `LocalSyncServer.serverInfo()` 产出，而该方法是
    **私有** 的 ⇒ 本仓没有公开读取面。判据取构造期一定存在的实例本身（`server.inspirations`），
    并把「代理 = 等价」钉在 `sync-server.linked.test.ts`（同时断言 HTTP 广告位与实例存在），
    上游改成条件构造或摘掉广告位时当场分叉。**禁止**直接调私有方法、**禁止**在状态里恒写 `true`；
    键只在为真时下发，缺席表示当前构建没这一面，不等于用户关掉了它（渲染层因此不留「未启用」行）。

## 2026-11-06 对齐上游 PC 端的口径订正（本轮）

- 上表 `runtime-facade.ts` 另含 4 个 N2 深入口常量：`METADATA_STARTUP_COMPOSITION_DEEP_ENTRY`
  / `METADATA_RESOLVER_CONFIG_DEEP_ENTRY` / `METADATA_DICTIONARY_REMOTE_CONFIG_DEEP_ENTRY` /
  `METADATA_THUMBNAIL_CACHE_DEEP_ENTRY`，分别装载上游启动组合器与配置/缩略图缓存；
  构造参数据此对齐 `windows-app.ts`（`remoteBridge: true`、字典 provider/supplement、
  `composeMetadataResolver`、`MetadataThumbnailCache`）。`runtime-manager.ts` 增
  `startBackgroundServices` / `stopBackgroundServices` 编排，补偿本仓不调
  `runtime.start()` 导致的字典 updater / `reenrichResolvedAssets` / resolver 定时器缺失。
- `runtime-types.ts` 增 `PcCompanionSessionContext`；`runtime-manager.ts` 增只读
  `pcCompanionContext()`，从 `state.session` 现取 `runtime.database` /
  `scanner.getScanRoots()` / `pairingUri(host)`。装配层（`app/nikkisync-runtime-setup.ts`）
  必须**在 `manager.start()` 之后**才构造 PC 端服务，会话未建则 warn 跳过。
- 新增 `pc-companion-services.ts` / `pc-companion-services.test.ts`：复用上游
  `createDesktopControlServer` / `WeChatGalleryService` 装配本机控制页与微信画廊，
  经 `pcCompanionContext()` 拿到**真实** database、扫描根与配对串（旧版三处降级
  —— 空 database / 空串配对 / 空照片源 —— 已消除）。资源由
  `scripts/stage-nikkisync-pc-assets.ts` 暂存，深入口清单见
  `scripts/verify-nikkisync-link.ts`（24 roots / 18 artifacts）。
- `docs/IPC_CONTRACT.md` §8.2.7/§8.2.8 登记灵感库 4 通道与 PC 端 4 通道；
  §8.2.4 的整理队列开关自 N1 起默认 `true`（可显式关闭）。
- 全过程与未同步项见 `docs/plans/2026-11-05-sync-gallery-pc-parity-实施计划.md`。

### B6 风险口径（用户明确决策，仅补说明、不改行为默认值）

- K2 同意门恢复 **fail-closed**：`createRuntimeSession` 以 `!existsSync(consentFile)` 作为
  `MetadataOnlineConsent` 的 `initiallyDisabled` —— 同意文件不存在（干净安装）时强制不同意，
  用户显式同意前绝不向第三方元数据端点出站；文件存在则交上游按内容判定（坏 JSON 同样
  fail-closed）。叠加 `metadataResolverEnabled` 能力位，出站需同时越过两道门。
- **五个默认开启常量一律保持 `true`，不得撤销上游 PC 端干净安装的产品意图**：
  `app/nikkisync-runtime-setup.ts` 的 `RUNTIME_ENABLED_DEFAULT` /
  `WATCHER_ENABLED_DEFAULT` / `METADATA_RESOLVER_ENABLED_DEFAULT` /
  `MULTI_HOST_PAIRING_DEFAULT` / `SYNC_ENABLED_DEFAULT`。B6 只翻转同意门，不动这五项。
- 因此干净安装仍会：LAN 同步服务监听 `0.0.0.0`、发起 mDNS 组播、产生扫描 IO，并在能力位
  开启且用户同意后对第三方端点出站。**逃生阀**：`NIKKI_NIKKISYNC_RUNTIME=0` 全局关、
  六个 `NIKKI_NIKKISYNC_*=0` 分项关，以及两份 `enabled:false` 离线 JSON。
- 本目录的 `@nikkisync/*` 仍只许变量式动态 import；上述风险口径是文档说明，不得据此在
  探针里启动服务或修改上游类型引用。

## 2026-11-07 对齐上游 4cb71e2（v1.0.31）的口径订正

- 对齐锚点自 `589b932`（v1.0.30）前进到 `4cb71e2`（v1.0.31-public-beta.1）；**协议层未变**
  （`packages/protocol` 无改动，`src/shared/sync/` vendored 契约与 `protocol-drift.test.ts` 保持基准）。
- 新增两个微信画廊包装器深入口：`WECHAT_DELETION_DEEP_ENTRY` /
  `WECHAT_INSPIRATION_DEEP_ENTRY`（`wechat/WeChatDeletion.js` / `WeChatInspiration.js`），
  由 `pc-companion-services.loadPcCompanionSurface` 消费节点就地装载、按**可选面**声明
  （老链接缺件 ⇒ 整段降级不包装，不抛）；字节变换函数（`resizeForWeChat` /
  `resizeWeChatIcon` / `rotatePng` / `exportLive`）按必需面装载。深入口清单随之扩容：
  `verify-nikkisync-link.ts` 当时为 **26 roots / 20 artifacts**。
- `pc-companion-services` 组装对齐新版 `windows-app.ts`：scanRoots 逐个 `realpath` 过滤 →
  `createIndexedPreviewSource` → `withWeChatInspiration(source, inspirations, resize)` →
  `withWeChatDeletion(source, deletions)`；`WeChatGalleryService` 增 `hosts`（多网卡 QR）、
  dashboard 增 `wechatEntryImage`（暂存自 `assets/branding/wechat-mini-entry.png`）与控制页
  四面板（`inspirations` / `accounts` / `deletions` / `scanDirectories`，会话同一实例；
  目录 add/remove/rescan 成功后联动 `wechat.stop`）。**隐私面板仍走应用内 K2 同意块**
  （用户裁决，控制页 `metadataPrivacy` 键继续不挂）。
- 同轮修复五处宿主组装缺陷（D1–D5）：`resize`/`rotatePng` 误传脚本路径、`exportLive`
  误返回 options 对象、`WeChatIconProvider` 无参构造（上游契约 `(cache, resize)` 必填）、
  dashboard `getStatus` 误传 dashboard 自身端口（现取 LAN 同步服务实际端口）。
- 会话上下文（`PcCompanionSessionContext`）增只读透传字段：`inspirations` / `deletions` /
  `extraDirectories` / `accounts` / `thumbnailCache` / `syncPort`（缺席即不挂键）；
  `NikkiSyncRuntimeSession` 增 `thumbnailCache?`（与 server 共享的 `MetadataThumbnailCache` 单实例）。
- 全过程见 `docs/plans/2026-11-07-nikkisync-upstream-align-03-实施计划.md`。

## 2026-11-13 对齐上游 a49764bb（v1.0.40-public-beta.2）的口径订正

- 对齐锚点自 `4cb71e2`（v1.0.31）前进到 `a49764bbf98fcb26a84f2356b78d48c459d3da2e`
  （main HEAD / `v1.0.40-public-beta.2`），区间共 4 提交：`bc3f636b`（1.0.39 PC TS 主变更）、
  `6c967831`（纯测试/文档）、`ec139a2c`（1.0.40 滤镜图标）、`a49764bb`（纯文档/测试）。
  本地克隆由 `git fetch origin` + `checkout --detach <sha>` 推进，`npm run build`
  （Node ≥24，本机用 v26.3.0）重建；`dist/` 与 `GalleryRuntime.mjs` 未入库，**只跑 tsc 不够**。
- **零变化、明确不动**：四个 workspace 包的入口 `index.ts`、`packages/protocol/src/index.ts`、
  根与 pc-companion `package.json` 两端 blob 一致 ⇒ `NIKKISYNC_REQUIRED_EXPORTS`、`probe.ts`、
  `runtime-loader.ts`、`src/shared/sync/**`、`protocol-contract.ts` 全部不改；上游无新增
  IPC/协议字段/能力位 ⇒ 本轮**不新增 `nikkisync:*` 通道、不改 preload / handler / IPC_CONTRACT /
  i18n 键 / UI 开关**。受保护核心路径零改动，`// @core-change:` 无需新增。
- **装载链**：新增 `LOCAL_CLOTHING_ICON_PACK_DEEP_ENTRY`（`dist/src/metadata/LocalClothingIconPack.js`）
  为第 26 个深入口；`verify-nikkisync-link.ts` 当时为 **27 roots / 24 artifacts**（能力清单新增
  4 个 `metadata/*.js`，其中 3 个是上游静态传递依赖，由 `closureLoadChain` 覆盖，不另加根）。
- **资源**：`scripts/stage-nikkisync-pc-assets.ts` 清单 9 → **31 项**（新增 1 份
  `photo-filter-icons/manifest.json` + 21 张 `filter-1090020NNN.webp`，NNN ∈ 1..17、19..22，
  上游缺 0018）；另有 `resources/nikkisync/pc/clothing-icons/` 主包（9162 服装条目 +
  394 效果条目），由官方 `MomoCamera-PC-1.0.40.exe` 内嵌 ZIP 经
  `scripts/extract-nikkisync-icon-pack.ts` 四组 SHA 校验后落位，
  不经过 stage 清单。
- **图标包注入**（复刻上游 `windows-app.ts:103-117`）：`createRuntimeSession` 两次
  `loadLocalClothingIconPack`（主包 + 滤镜补充包）→ `withLocalPhotoEffectIcons` → 仅主包
  `valid===true` 时把**完整 pack** 注入 `server.localClothingIcons`（`LocalSyncServer` 会调
  `read()` / `readEffect()`，只给 `cacheVersion` 会 TypeError）。有包时**不再构造**
  `MetadataThumbnailCache`，会话句柄挂出 `localClothingIcons`，经 `pcCompanionContext()` →
  `assemblePcCompanionServices()` → `createPcCompanionServices()` 同一引用透传到画廊侧。
  画廊侧 `createIndexedPreviewSource` 注入 `localClothingIcons` + `convertLocalWebp`
  （委托上游 `convertWeChatWebp`，失败回落 `resizeWeChatIcon`），并**省略** `loadIcon`、
  不构造 `WeChatIconProvider`：上游 `source.mjs` 的 `icon()` 二选一且无回退，两套路径必须互斥。
  目录/深入口/转换器/manifest 任一不通过 ⇒ `warn` 并保持在线图标模式，绝不注入半套。
- **旧库事实更正**：上游 `DatabaseManager.initialize()` 无 `schema_migrations` 版本门禁，
  每次启动都 `exec(0001_initial.sql)` 全文（`CREATE TABLE IF NOT EXISTS` 幂等）⇒ 存量库
  自动补齐 `nuan5_resolution` / `nuan5_endpoint_state` / `idx_assets_resolver_fingerprint`。
  本仓**不写自研 DDL**，改由 `runtime-facade.linked.test.ts` 的「旧库 → 新版启动」用例钉住；
  业务表闭集 16 → **18 张**（14 迁移 + 4 运行期自建）。
- **历史 R1（已被 2026-11-13 用户裁决推翻，保留作沿革）**：C# WPF 自动更新 / xdelta3 差分 /
  托盘自启 / 支持网关 / `UpdateWindow` / Android / 小程序本体曾「仍不搬」；当时唯一扩展是
  **引入服装图标静态包**，不含其自动更新与验签通道。第三方署名见 `THIRD_PARTY_NOTICES` 第 6 节。
- **2026-11-13 起按用户裁决全量对齐 windows-shell 能力**：宿主装配补齐 G1–G7
  （本地照片解析优先、解析回调、scanner 构造期选项、诊断落盘、本地字典 manifest、
  版本服务构造签名、同意切换重算），并新增 6 个默认关闭的 opt-in 外壳能力
  （签名图标增量 / 签名程序差分 / 托盘 / 匿名诊断 / 网络冲突修复 / 临时热点）。
  G1/G4 使 `verify-nikkisync-link.ts` 装载清单扩至 **30 roots / 26 artifacts**
  （2026-11-14 复测实值；新增 `LocalPhotoMetadataResolver` / `MetadataDictionaryConfigFile` /
  `VerifiedClothingNames` 深入口）。
  已与 `electron-updater` / `login-item.ts` / `log-service.ts` / koffi 解码链重复的
  成熟实现一律不重写，只做最小对齐与观测。签名私钥、CNB 上传凭据与支持网关服务端
  不在本仓，无有效签名 feed 时通道如实返回 `unavailable`。详见
  `docs/plans/2026-11-13-nikkisync-windows-shell-full-align-实施计划.md` 与
  `docs/IPC_CONTRACT.md` §8.x；第三方署名见 `THIRD_PARTY_NOTICES` 第 7 节。
- 全过程与逐节点读数见 `docs/plans/2026-11-13-nikkisync-pc-align-1.0.40-实施计划.md`。

## 2026-11-18 对齐上游 6bdab4b（v1.0.41-public-beta.2）的口径订正

- 对齐锚点自 `a49764bb`（v1.0.40-public-beta.2）前进到 `6bdab4b4b29b0af5103aafb2d3223e7903c6306c`
  （main HEAD / `v1.0.41-public-beta.2`），区间 2 提交：`860ff0f`（beta.1：APP/NIKKI 发现 +
  confirm 幂等回执 + 控制页过期收预览）、`6bdab4b`（beta.2：大图 JPEG 导出 128MiB）。
  上游克隆 `checkout --detach` + `npm run build` 完整重建。**推进前实测到「dist 半新半旧」漂移**
  （ExtraScanDirectories/discovery 产物已含新行为而 GalleryRuntime.mjs 未再生）——基准钉子
  字节数下界因此提至 a49764bb 完整构建实测值 **297158**（新构建 297377），捕获「checkout 了没重建」。
- **零变化、明确不动**：`packages/protocol` / 数据库迁移 / 四包入口与 package.json 两端 blob 一致
  ⇒ `src/shared/sync/**`、`protocol-contract.ts`、`NIKKISYNC_REQUIRED_EXPORTS`、`runtime-loader.ts`、
  `verify-nikkisync-link.ts` 清单（30 roots / 26 artifacts）、`stage-nikkisync-pc-assets.ts` 31 项、
  18 张表闭集全部不改；无新增 `nikkisync:*` 通道、不改 preload。
- **自动流入面**（重建后经 junction 生效，宿主零复刻）：APP/NIKKI 容器发现（同步库走真上游
  discovery）、ExtraScanDirectories 幂等回执（`add` 成功保留 confirmed 回执 + TTL 续期，重复
  confirm 幂等返回 state；`remove` 清理对应回执）、控制页脚本 `selection_expired` 收预览、
  LocalSyncServer 导出上限 128MiB、GalleryRuntime `exportJpeg` 第 4 参 maxBytes。
  三个新行为由 `runtime-facade.linked.test.ts` 的「1.0.41 钉 A/B/C」suite 钉住
  （夹具落 `.cache/`、exe 非空、大 JPEG 断言用长度 + 扫描段采样避免 worker OOM）。
- **本轮有核心路径改动**（与 1.0.40 轮不同）：`nikkisync-handler.ts` 的 K6 错误映射两分支附带
  `details: {upstreamCode: <短码>}`（`// @core-change:` 已登记），渲染层 `SyncServicePage`
  `handleConfirmAdd` 据此在 `selection_expired` 时收起提案预览 + 新 i18n 键
  `syncService.extraDirectories.selectionExpired`（12 语包），其余拒绝保留预览可重试。
  判定走 details 结构化通道，**不得**改回 message 字符串匹配。`docs/IPC_CONTRACT.md` §8.2.3 已登记。
- **移植面跟进**（用户裁决）：`src/main/sync/server/jpeg-export.ts` 增第 4 参 maxBytes
  （默认/下界 16MiB、上限 128MiB、校验先于 options、输出余量 `maxBytes+65536`，逐字对齐上游
  photo-export.mjs），`api-router.ts` 记录尺寸上限同步 128MiB 并传第 4 参；wire 错误码/头名不变，
  `PORTED_SYNC_AUTOSTART_ENABLED=false` 不变。
- **宿主扫描器顺带补齐**（用户裁决）：`src/main/scanner/game-directory-discovery.ts`
  `getCommonLauncherInstallCandidates` 每盘符增 `APP\NIKKI` 启动器/裸装两模板（置于 pf 变体前
  镜像上游容器优先级）；不补 WeGameApps（非本轮 diff，最小改动）。
- 全过程与逐节点红绿读数见 `docs/plans/2026-11-18-nikkisync-1.0.41-beta2-对齐-实施计划.md`。
