# NikkiSync PC Companion 运行时嵌入盘点报告（阶段 0+ · 00-nikkisync-pc-audit-report）

> 路径作用域：本文为阶段计划/审计报告快照，文中 `src/xxx`、`scripts/xxx` 形式的路径混指本仓与上游 NikkiSync 仓；属上游或当时设计未落地的项按原文保留、不覆写，读者请勿默认它们能在本仓解析。

> 生成日期：2026-10-12
> 范围：`NikkiSync/apps/pc-companion/`（`@nikkisync/pc-companion` v0.0.1-m0）+ `NikkiSync/packages/{core,database,protocol}/`，对照 `WXNN XiangCe/`（wxnn-photo-manager v2.5.5）
> 定位：**阶段 0（`00-code-audit-report.md`）的增量补全**，聚焦「把 PC Companion 作为可嵌入运行时」视角。既有报告结论未被推翻，本次新采集的证据见 §11 验证记录。
> 唯一真相源：工作区根 `00-nikkisync-pc-audit-report.md`（工作区根目录不是 git 仓库，故本文件为入 git 跟踪的副本；更新时两处同步）。
> 行号口径：取自当前工作区副本。`NikkiSync/` 分支 `feat/gallery-runtime-embed`（自检查点 `b2eb337` 切出）；`WXNN XiangCe/` 分支 `feat/gallery-runtime-embed`（自 `0de20d8` 切出，携带未提交的阶段 7 WIP）。
> 本阶段零源码改动：所有论断均为只读探查（Read/Grep）+ Electron 运行时探针实测。

---

## 0. 执行摘要（7 问速答）

| #   | 问题          | 结论（一句话）                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | 运行时入口    | `runtime.ts` 唯一值导出 `class PcCompanionRuntime`（`apps/pc-companion/src/runtime.ts:42`），构造入参 `PcCompanionRuntimeConfig`（`runtime.ts:15-34`，9 个字段全可选），生命周期 `start()`/`stop()`（`:92`、`:107`）；`createPcCompanionContext()`（`src/index.ts:17`）只返回 `{database, protocolVersion}`，**不含 scanner/server**，与 Runtime 是两套入口 |
| Q2  | 功能模块      | `apps/pc-companion/src/` 共 62 个源文件（根 8 + desktop 9 + metadata 17 + remote 4 + scanner 9 + server 12 + wechat 4），7 个子系统，完整清单见 §2                                                                                                                                                                                                          |
| Q3  | 数据库 schema | 单一迁移 `packages/database/migrations/0001_initial.sql`（173 行）建 **12 张业务表 + `sqlite_sequence`**；`assets` 16 列、`resources` 19 列、`change_journal` 5 列、`paired_devices` 9 列，完整 DDL 见 §3                                                                                                                                                   |
| Q4  | Node 兼容性   | **无需任何妥协**：XiangCe 的 Electron 实装 41.10.6、内置 Node 24.18.0、`node:sqlite` 可用；整个 Runtime 已在 Electron 进程内实测 `import()` → `start()` → `stop()` 通过（§4）。唯一硬约束：NikkiSync ESM 图含 top-level await ⇒ **只能动态 `import()`，不能 `require()`**                                                                                   |
| Q5  | 依赖冲突      | 唯一实质分歧是 `@types/node`（NS 24.13.3 / WX 22.20.1）；`qrcode` 两侧同为 1.5.4；`typescript` 两侧同为 5.9.3；NikkiSync 无 sharp/ffmpeg/better-sqlite3 依赖（§5）                                                                                                                                                                                          |
| Q6  | 测试入口      | 根 `npm test` = 先 `npm run build` 再 `node --test` 跑 **23 个产物**（21 个 `dist/*.test.js` + 2 个 `tools/*.test.mjs`），实测 131/131 通过；`local-sync-server.test.ts` 是协议契约的可执行规格（6 个 test）；3 个测试文件不在默认 roster（§6）                                                                                                             |
| Q7  | 配置项        | 11 个 `NIKKISYNC_*` 环境变量 + 5 个 `APP_DATA` 配置文件 + 4 类运行产物（§7）；**不存在** `NIKKISYNC_DESKTOP_TOKEN`（桌面控制 token 每进程随机生成，`desktop/DesktopControlServer.ts:31`）                                                                                                                                                                   |

**三条决定性实测（可复现命令见 §11）**

1. Electron 41.10.6 内置 **Node 24.18.0**，`process.versions.modules`（原生 ABI）= 145，`process.versions.bun` = `undefined`；`require('node:sqlite')` + 建表/插入/查询通过。
2. `await import('apps/pc-companion/dist/src/index.js')` 在 Electron 内成功（18 个运行时值导出）；`new PcCompanionRuntime({server:{host:'127.0.0.1',port:0,mdns:false}})` → `server.start()` 实际监听 `127.0.0.1:9121`、`secure=true`，`createPairingUri()` 生成合法 `NS1|...` 配对串，`stop()` 干净退出。
3. `require()` 加载 `packages/database/dist/src/index.js` 抛 **`ERR_REQUIRE_ASYNC_MODULE`**（源于 `packages/database/src/database-manager.ts:15` 顶层 `await import(sqliteModuleName)`）⇒ 嵌入层必须以 `await import()` 为唯一入口。

**推荐方案（Q4 派生）**：主进程内直接 `await import()` 嵌入 Runtime（不升 Electron、不换 SQLite 驱动、不必起独立子进程）。独立子进程只是可选的故障隔离加固，不是技术前置。

---

## 1. Q1 运行时入口

### 1.1 `PcCompanionRuntime`（`apps/pc-companion/src/runtime.ts`）

导出：`interface PcCompanionRuntimeConfig`（`:15`）、`interface PcCompanionStartResult`（`:36`）、`class PcCompanionRuntime`（`:42`）。运行时值导出只有 `PcCompanionRuntime`（探针实测）。

构造参数 `PcCompanionRuntimeConfig`（全部可选，`:16-33`）：

| 字段                                 | 类型                                                                                                                                                       | 消费位置                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `databaseFile`                       | `string`（默认 `':memory:'`）                                                                                                                              | `runtime.ts:53`                                                                                      |
| `scanner`                            | `ScannerConfig`（`scanner/types.ts:41`：`stability/watcher/debounceMs/motionAssemblyGraceMs/onSettled` + 继承 `GameDiscoveryOptions` 7 字段）              | `runtime.ts:55`                                                                                      |
| `server`                             | `LocalSyncServerConfig`（`server/LocalSyncServer.ts:39-49`：`name/host/port/tls/journalPollMs/mdns/maxJsonBodyBytes/metadataThumbnailCache/remoteBridge`） | `runtime.ts:83-89`                                                                                   |
| `remoteBridge`                       | `boolean`                                                                                                                                                  | `runtime.ts:82`（`true` 自建 `RemoteBridgeService`；否则沿用 `config.server.remoteBridge` 注入实例） |
| `metadataResolver`                   | `{ resolver: PhotoMetadataResolver; service?: MetadataResolverServiceConfig }`                                                                             | `runtime.ts:74-81`                                                                                   |
| `metadataDictionary`                 | `MetadataDictionaryManifest`（离线种子）                                                                                                                   | `runtime.ts:56-58`                                                                                   |
| `metadataDictionarySupplement`       | `MetadataDictionaryManifest`（补充）                                                                                                                       | `runtime.ts:57`                                                                                      |
| `metadataDictionaryRemote`           | `{ provider; service? }`                                                                                                                                   | `runtime.ts:59-66`                                                                                   |
| `metadataDictionarySupplementRemote` | `{ provider; service? }`（强制 `mode:'supplement'`）                                                                                                       | `runtime.ts:67-72`                                                                                   |

构造顺序（`runtime.ts:52-90`，同步执行）：① `new DatabaseManager` + `initialize()`（`:53-54`，跑 `0001_initial.sql`）→ ② `new ScannerService`（`:55`，仅装配）→ ③ 任一 dictionary 配置存在时建 `MetadataDictionaryService` / `replaceManifest` / 两个 `MetadataDictionaryUpdateService`（`:56-73`）→ ④ `MetadataResolverService`（`:74-81`）→ ⑤ `RemoteBridgeService`（`:82`）→ ⑥ `LocalSyncServer`（`:84-89`）：**未显式传 `server.tls` 时自动 `new LocalTlsIdentityService(database).getOrCreate()` 生成/复用自签 RSA-2048 证书**，因此构造即可能写 `app_settings` 表。

公开成员（全部 `readonly`，`:43-50`）：`database`、`scanner`、`server`、`remoteBridge`、`metadataResolver`、`metadataDictionary`、`metadataDictionaryUpdater`、`metadataDictionarySupplementUpdater`。

生命周期：

- `async start(): Promise<PcCompanionStartResult>`（`:92-105`）⇒ 先 `scanner.start()`（全量扫描 + 起 watcher），再 `server.start()`；成功后依次 `metadataDictionary.reenrichResolvedAssets()`、两个 updater `start()`、`metadataResolver.start()`；**`server.start()` 抛错时回滚 `await scanner.stop()` 再 rethrow**（`:101-104`）。返回 `{ scan: ScanResult, server: LocalSyncServerAddress }`。
- `async stop(): Promise<void>`（`:107-114`）⇒ `metadataResolver.stop()` → 两个 updater `stop()` → `await server.stop()` → `await scanner.stop()` → `database.close()`。不提供重启语义，start/stop 一对一。
- `createPairingUri(host, ttlMs?): string`（`:116-118`）⇒ `server.createPairingPayload()` + `buildPairingUri()`；要求 server 已 `start()` 且启用 TLS，否则抛错（`LocalSyncServer.ts:204-205`）。

### 1.2 `createPcCompanionContext()`（`src/index.ts:17-21`）

返回 `PcCompanionContext = { database: DatabaseManager; protocolVersion: typeof PROTOCOL_VERSION }`，默认 `databaseFile=':memory:'`。探针实测：`context keys=database,protocolVersion protocolVersion=1`。

与 Runtime 的区别：**Context 只建库 + 暴露协议版本，不含 scanner / server / metadata 服务**，是给「只要数据库契约」的调用方（工具脚本、测试）用的轻量入口；嵌入要用的是 `PcCompanionRuntime`。

`src/index.ts` 桶导出（`:4-9`，6 条 `export *`）：`game-directory-discovery.js`、`runtime.js`、`scanner/index.js`、`server/index.js`、`metadata/MetadataResolverPipeline.js`、`metadata/types.js`。运行时值导出 18 个（§11 探针原文）：`AuthService FileStabilityGuard LocalSyncServer LocalTlsIdentityService MdnsAdvertiser MetadataResolverPipeline PairingError PairingService PcCompanionRuntime ResourceClassifier ScanCoordinator ScanReconciler ScannerDiscovery ScannerService ScannerWatcher WebSocketHub createPcCompanionContext discoverInfinityNikkiInstallation`。

注意：**`metadata/` 其余 16 个文件、`desktop/`、`remote/`、`wechat/`、`qr.ts`、`windows-app.ts`、`dev-server.ts` 不在桶导出内**，嵌入需深导入（如 `@nikkisync/pc-companion/dist/src/metadata/MetadataThumbnailCache.js`）。

### 1.3 启动方式与代码示例

| 入口          | 文件                                                     | 形态                                               | 关键差异                                                                                                                                                        |
| ------------- | -------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dev server    | `src/dev-server.ts`（54 行）                             | `npm run pc:serve` → `node dist/src/dev-server.js` | 读 `NIKKISYNC_DB/BIND/PORT/MDNS/HOST/METADATA_THUMBNAIL_CACHE`，端口默认 0，控制台打印配对 URI（`:35-42`）；**不接 metadata resolver/dictionary，不启 desktop** |
| 生产 exe 主体 | `src/windows-app.ts`（190 行）                           | Bun 单文件 exe / `npm run pc:exe`                  | 组装 metadata resolver + 两个 dictionary provider + thumbnail cache + remoteBridge + desktop 控制页（`:89-169`），端口默认 28080                                |
| 测试内联      | `apps/pc-companion/test/local-sync-server.test.ts:84` 起 | node:test                                          | 手工构造组件并跑配对/签名请求，最贴近「嵌入方」用法                                                                                                             |

嵌入 WXNN XiangCe 主进程的最小可用示例（与 §11 探针 P3 等价）：

```ts
// CJS 主进程内必须用动态 import：require 会抛 ERR_REQUIRE_ASYNC_MODULE
const { pathToFileURL } = await import('node:url')
const entry = pathToFileURL(
  path.join(runtimeRoot, 'apps/pc-companion/dist/src/index.js') // runtimeRoot = 仓库目录或 process.resourcesPath 下的解包位置
).href
const { PcCompanionRuntime } = await import(entry)

const runtime = new PcCompanionRuntime({
  databaseFile: path.join(app.getPath('userData'), 'nikkisync', 'nikkisync.sqlite'),
  server: { host: lanIp, port: 0, mdns: false, name: 'NikkiGallery 同步' }
})
const server = await runtime.server.start() // 绕开 scanner 硬前置，直接起 LAN
const pairingUri = runtime.createPairingUri(server.host)
// 退出前
await runtime.stop()
```

> 上例只调 `runtime.server.start()` 而非 `runtime.start()`，原因见 §9 风险 R2。

---

## 2. Q2 功能模块清单

行数口径：`(Get-Content).Count`。导出列只列 `export` 的类/函数/常量（类型单独标注）。

### 2.1 根层（8 文件）

| 文件                          | 行  | 职责                                                                                                                                                                                                                                                                  | 导出                                                                                                                                                                |
| ----------------------------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime.ts`                  | 119 | 进程级生命周期编排（scanner 先、LAN 后，共享一个 SQLite）                                                                                                                                                                                                             | `PcCompanionRuntime` L42                                                                                                                                            |
| `index.ts`                    | 21  | 包桶导出 + 轻量 Context                                                                                                                                                                                                                                               | `createPcCompanionContext` L17                                                                                                                                      |
| `dev-server.ts`               | 54  | 开发期独立进程入口                                                                                                                                                                                                                                                    | 无（副作用脚本）                                                                                                                                                    |
| `windows-app.ts`              | 190 | 生产 exe 组装（desktop + wechat + metadata + remoteBridge）                                                                                                                                                                                                           | 无（副作用脚本）                                                                                                                                                    |
| `game-directory-discovery.ts` | 267 | 游戏目录发现：来源优先级 `manual > cached > local-ancestor > registry > shortcut > common-location > running-process`（`L11`、`L237-265`）；产出 `{installRoot, x6GameRoot, photoRoots, motionRoots, source}`（`L25-31`；`photoRoots = <X6Game>/ScreenShot`，`L219`） | `discoverInfinityNikkiInstallation` L224；类型 `GameDiscoverySource` L11 / `GameDiscoveryReport` L13 / `InfinityNikkiInstallation` L25 / `GameDiscoveryOptions` L33 |
| `WindowsInstallationHints.ts` | 94  | 注册表 / 快捷方式 / 固定盘探测（`execFile` 调 PowerShell）                                                                                                                                                                                                            | `readWindowsInstallationHints` L78                                                                                                                                  |
| `qr.ts`                       | 169 | 配对 URI → SVG 二维码（依赖 `qrcode`）                                                                                                                                                                                                                                | `legacyQrSvg` L156、`qrSvg` L167                                                                                                                                    |
| `RuntimeMemoryMaintenance.ts` | 29  | 后台任务落定后的 `global.gc()` 节流                                                                                                                                                                                                                                   | `RuntimeMemoryMaintenance` L2                                                                                                                                       |

### 2.2 scanner/（9 文件）

| 文件                    | 行  | 职责                                                                                                                                                                                                                                                                                                                                 | 导出                                   |
| ----------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `ScannerService.ts`     | 95  | `start()` L25（发现→全量→起 watcher）/ `stop()` L35 / `fullScan()` L40 / `rescanPath()` L46（按 uid 目录收敛）/ `getStatus()` L92；`enqueueScan()` L56 用**微任务合并 + 父子根去重**折叠突发事件                                                                                                                                     | `ScannerService` L10                   |
| `ScannerDiscovery.ts`   | 6   | `discoverInfinityNikkiInstallation` 薄封装                                                                                                                                                                                                                                                                                           | `ScannerDiscovery` L3                  |
| `ScanCoordinator.ts`    | 35  | 递归 `readdir`；非忽略项**先等文件稳定再 stat+hash**（`L24-28`，保证 digest 与 size 一致）                                                                                                                                                                                                                                           | `ScanCoordinator` L7                   |
| `ResourceClassifier.ts` | 138 | 路径分类 `classifyKind()` L17（`high_quality/low_quality/motion_cover/motion_video/binary_companion/unknown_image/ignored`，含目录名拼写容错 L24-25）；uid = 路径中 ≥5 位数字段 L12；**全文件流式 sha256** L41；JPEG 尾部原生参数信封解析 L63（44 字符 base64 token / `[V2]N` 后缀 / 双 EOI 间可打印 payload / NUAN5 范围 MD5 L109） | `ResourceClassifier` L114              |
| `FileStabilityGuard.ts` | 31  | 轮询 `stat` + 试开直到稳定：默认 `poll 200ms / stableChecks 3 / maxWait 10s / assumeStableIfOlder 2s`（L4）                                                                                                                                                                                                                          | `FileStabilityGuard` L3                |
| `ScannerWatcher.ts`     | 40  | `fs.watch(recursive:true)` + 按路径 debounce（默认 250ms，L10、L26-32）                                                                                                                                                                                                                                                              | `ScannerWatcher` L6；`WatcherEvent` L4 |
| `ScanReconciler.ts`     | 119 | 资源→Asset 聚合：`idFor()` L7（`asset_` + sha256 前 32 位）、`resourceIdFor()` L8；photo 走 `AssetResolver.resolvePhotoResources` L50、motion 走 `resolveMotionCandidates` L65；调 `AssetRepository.reconcile()` L30 + `markMissingByRoots()` L35；写 `metadata.raw.nativeParam*` 三键 L108-112                                      | `ScanReconciler` L22                   |
| `types.ts`              | 104 | `ScannerStatus` L6、`DiscoveredResource` L9（含 3 个 native 参数）、`StabilityConfig` L33、`ScannerConfig` L41、`ScanResult` L49、`ScannerMetrics` L63、`AssetSnapshot` L73、`ReconcileMutation` L104                                                                                                                                | 类型                                   |
| `index.ts`              | 8   | 桶导出 8 个模块                                                                                                                                                                                                                                                                                                                      | —                                      |

### 2.3 server/（12 文件）

| 文件                         | 行  | 职责                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 导出                                                                                                        |
| ---------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `LocalSyncServer.ts`         | 608 | LAN HTTPS API 核心。`start()` L174（`tls?https:http` L177-179 → `listen` → 取实际端口 → `mdns.start()` L189）/ `stop()` L193（清 timer、`mdns.stop()`、`sockets.close()`、`remoteBridge.closeAllSessions()`、`server.close()`）/ `createPairingPayload()` L203 / `createRemoteSession()` L214 / `handle()` L222 手写路由 / `handleUpgrade()` L567（WS 仅 `/ws/v1` 且需验签）/ `broadcastJournal()` L581 / `updateJournalPolling()` L595（**仅在有 WS 订阅者时轮询**，timer `unref()`）/ `exportStill()` L544（全文件读 + 前后 stat 比对 + sha256 复算，失败 409，单飞锁 `exportBusy` L134）。默认值 L159-169：`name 'NikkiSync PC'`、`host '0.0.0.0'`、`port 0`、`journalPollMs 250`、`mdns true`、`maxJsonBodyBytes 1MB` | `LocalSyncServer` L133；`LocalSyncServerConfig` L39 / `LocalSyncServerAddress` L51                          |
| `AuthService.ts`             | 67  | Ed25519 验签：4 个头 L28-31；容差 ±5min（`clockSkewMs` L23）；canonical = `method\nurl\nts\nnonce\nsha256(body)` L41-47；**nonce 内存 Map 防重放 + 过期 prune** L21/L36-38/L64；公钥支持 PEM 或 base64url SPKI L14-17；成功返回 deviceId 并 `touchDevice` L56-58                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `AuthService` L19                                                                                           |
| `PairingService.ts`          | 92  | 服务端 Ed25519 身份（`generateKeyPairSync('ed25519')` L21，`serverId = server_ + 16B hex` L26，持久化到 `app_settings['server.identity']` L40-41）；`createQrPayload()` L44（token = `randomBytes(24).base64url`，默认 TTL 5min，只存 sha256）；`pair()` L66（消费 token、签 `randomBytes(32)` deviceCredential、只存 sha256）                                                                                                                                                                                                                                                                                                                                                                                            | `PairingService` L32、`PairingError` L88                                                                    |
| `WebSocketHub.ts`            | 85  | 手写 RFC6455：握手 L28-47（固定 GUID L6、只支持 version 13）、text 帧 L8-19（125/16bit/64bit 三种长度）、close/ping-pong L66-84、`broadcast()` L53、`close()` L58。**无第三方 ws 依赖**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `WebSocketHub` L23                                                                                          |
| `MdnsAdvertiser.ts`          | 88  | 手写 mDNS 组播：`224.0.0.251:5353` L4-5、服务名 **`_nikkisync._tcp.local`** L51、实例名 = 清洗后的 `name` L52-53、PTR/SRV/TXT/A 四记录 L55-65、TXT = `serverId=… protocol=1 port=…` L59、30s 周期重发 + 命中查询即回应 L68-78、优先 LAN IPv4 L35-41                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `MdnsAdvertiser` L43                                                                                        |
| `LocalTlsIdentityService.ts` | 130 | 手写 DER/X.509 自签：**RSA-2048 + SHA-256** L100-105 / L67；CN `NikkiSync Local` L78、SAN DNS `nikkisync.local` L81、有效期 -1d → +10y L76-77；身份（含私钥 PEM）持久化到 `app_settings['server.tlsIdentity']`，**不写独立文件**；`getOrCreate()` 校验指纹一致后复用 L119-129                                                                                                                                                                                                                                                                                                                                                                                                                                             | `LocalTlsIdentityService` L115；`LocalTlsIdentity` L4                                                       |
| `row-mappers.ts`             | 148 | DB 行 → 协议 DTO；`publicMetadata` 剥离 PC-only 的 `raw.nativeParamPayload/nativeParamNuan5Md5`；gameVersion 三态推导                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `mapResourceRow` L53、`mapAssetRow` L69、`mapAssetDetail` L109、`mapAssetSummary` L113、`mapChangeRow` L141 |
| `SuitSearchIndex.ts`         | 184 | 套装聚合检索（parts 匹配 + 相关度分层）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `searchSuitLibrary` L96、`SuitSearchAsset` L9                                                               |
| `ClothingSearchIndex.ts`     | 124 | 服装检索（exact > prefix > contains）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `searchClothingLibrary` L48                                                                                 |
| `ProfileStatsIndex.ts`       | 149 | 个人统计（top suits / top clothing / 字典状态）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `buildProfileStats` L58                                                                                     |
| `GameVersionCalendar.ts`     | 47  | 由 capturedAt 推断游戏版本                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `inferInfinityNikkiGameVersion` L39                                                                         |
| `index.ts`                   | 6   | 桶导出 6 个（**不含 row-mappers / 三个 Index / Calendar**）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | —                                                                                                           |

**REST 路由实际分支（`LocalSyncServer.ts:225-260`，15 条）**：`/remote/*` 前置委派（L225）、`GET /v1/server`（L229，免验签）、`POST /v1/pair`（L230，免验签）、`PATCH /v1/assets/:id/metadata`（L231，body 参与验签）、`GET /v1/assets`（L238）、`GET /v1/search/suits`（L239）、`GET /v1/search/clothing`（L240）、`GET /v1/profile/stats`（L241）、`GET /v1/changes`（L242）、`GET|HEAD /v1/assets/:id/clothing/:clothingId/thumbnail`（L243）、`GET /v1/assets/:id`（L252）、`GET|HEAD /v1/assets/:id/resources/:rid/export`（L256）、`GET|HEAD /v1/assets/:id/resources/:rid`（L257）、`WS /ws/v1`（L569）、其余 404（L260）。常量表 `API_ROUTES` 12 项在 `packages/protocol/src/index.ts:261-276`。

### 2.4 metadata/（17 文件）

| 文件                                        | 行  | 职责                                                                                                                                                                                                                                                                                                                      | 导出                                                                                                                                                                                                |
| ------------------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`                                  | 55  | 契约：`MetadataCapability`（`clothing/pose/camera/filter/lighting/location/thumbnail`）L3、`PhotoMetadataResolveRequest` L18（带 `nativeParamToken/Payload/Nuan5Md5`）、`PhotoMetadataResolver` L41、`MetadataResolverServiceConfig` L49                                                                                  | 类型                                                                                                                                                                                                |
| `MetadataResolverPipeline.ts`               | 103 | 多 provider 按优先级合并（**先前 provider 胜出，后续只补缺失嵌套字段**，数组/标量原子化 L18-32）；全失败抛 `AggregateError` L84；`id`/`version` 由成员拼接 L50-53                                                                                                                                                         | `MetadataResolverPipeline` L40；config L34                                                                                                                                                          |
| `MetadataResolverService.ts`                | 161 | 后台轮询解析：默认 `enabled true / intervalMs 15000 / batchSize 12 / retryAfterMs 600000`（L43-49）；按 `revision+provider+version` 去重与退避（L66）；`runOnce()` L63；`inputFingerprint()` L18；可挂字典 enricher L39                                                                                                   | `MetadataResolverService` L27、`PhotoMetadataDictionaryEnricher` L6                                                                                                                                 |
| `Nuan5CompatibleResolver.ts`                | 110 | **在线解析（默认 provider）**：端点默认 `https://nuan5.pro/api/decode-photo2`（L74）；把本地 token+payload 拼 base64 元组上送（L23-32）；限速 `minIntervalMs` 0.5s/张（L10）                                                                                                                                              | `Nuan5CompatibleResolver` L64、config L4                                                                                                                                                            |
| `RemoteJsonMetadataResolver.ts`             | 81  | 通用 remote-json provider（endpoint 必填，可注入 headers/timeout）                                                                                                                                                                                                                                                        | `RemoteJsonMetadataResolver` L17、config L4                                                                                                                                                         |
| `MetadataResolverConfigFile.ts`             | 106 | `metadata-resolver.json` 解析与容错（非法即整份视为无配置 L53-65）；`providers[]` 优先于 legacy `provider`（L91）；按 `priority` 稳定排序（L94）；`remote-json.endpoint` 必须 https（L47）                                                                                                                                | `loadMetadataResolverConfigFile` L53、`asRemoteResolverConfig` L67、`asNuan5ResolverConfig` L79、`orderedMetadataProviderConfigs` L90、`createMetadataResolverFromConfig` L98；类型 L13/L22/L30/L32 |
| `MetadataDictionaryService.ts`              | 222 | 服装/滤镜/灯光/姿势/地点字典（落 `metadata_dictionary_*` 两表）：`replaceManifest()`、`reenrichResolvedAssets()`、`enrichMetadata()`                                                                                                                                                                                      | `MetadataDictionaryService` L76、`parseMetadataDictionaryManifest` L48                                                                                                                              |
| `MetadataDictionaryUpdateService.ts`        | 129 | 远端字典定时拉取（`mode: replace \| supplement`），失败静默保留旧数据                                                                                                                                                                                                                                                     | `MetadataDictionaryUpdateService` L22、config L5                                                                                                                                                    |
| `MetadataDictionaryProvider.ts`             | 16  | provider 接口                                                                                                                                                                                                                                                                                                             | `MetadataDictionaryProvider` L13                                                                                                                                                                    |
| `MetadataDictionaryRemoteConfigFile.ts`     | 128 | `metadata-dictionary-remote.json` 解析 + provider 工厂                                                                                                                                                                                                                                                                    | `loadMetadataDictionaryRemoteConfigFile` L45、`createMetadataDictionaryProviderFromConfig` L108                                                                                                     |
| `MetadataDictionaryConfigFile.ts`           | 12  | 离线字典 JSON 读取                                                                                                                                                                                                                                                                                                        | `loadMetadataDictionaryFile` L6                                                                                                                                                                     |
| `NikkiAlbumsMetadataDictionaryProvider.ts`  | 437 | **联网**取公共热更字典：默认 `https://nikki.ranaxro.com/app_api/hot_update.json`（L9），仅无 body GET（L44-49 注释：绝不上送 uid/token/payload/媒体字节）；自带 messagepack/protobuf 解码与包体解密                                                                                                                       | `NikkiAlbumsMetadataDictionaryProvider` L51、`decryptNikkiAlbumsPackage` L151、`buildDictionaryManifest` L170、`decodeMessagePack` L343                                                             |
| `NikkiGalleryMetadataDictionaryProvider.ts` | 113 | 备用字典源 `https://www.nikkigallery.vip/api/v1/clothes/all`（L5）+ 缩略图根 L6                                                                                                                                                                                                                                           | `NikkiGalleryMetadataDictionaryProvider` L76、`NIKKI_GALLERY_ENDPOINT` L5                                                                                                                           |
| `RemoteJsonMetadataDictionaryProvider.ts`   | 67  | 自定义 JSON 字典端点适配                                                                                                                                                                                                                                                                                                  | `RemoteJsonMetadataDictionaryProvider` L20、config L8                                                                                                                                               |
| `MetadataThumbnailCache.ts`                 | 228 | 缩略图磁盘缓存（默认单条 2MB、10s 超时、只收 png/jpeg/webp L6-8）；按 `sourceUrl+versionKey` 键控、内容寻址文件名；`isIP` 参与 SSRF 防护 L3                                                                                                                                                                               | `MetadataThumbnailCache` L81、config L10、`CachedMetadataThumbnail` L20                                                                                                                             |
| `VerifiedClothingNames.ts`                  | 39  | 内置已校验服装名白名单 + 生成 supplement manifest                                                                                                                                                                                                                                                                         | `VERIFIED_CLOTHING_NAMES` L4、`clothingNameSupplement` L34                                                                                                                                          |
| `MetadataStartupComposition.ts`             | 41  | 三件套工厂：`composeMetadataResolver` L17（**无配置且无 env 时默认 `Nuan5CompatibleResolver` = 默认联网**；`enabled:false` → `undefined` → Runtime 不建 resolver 服务 = 离线）、`composeMetadataDictionaryProvider` L29（默认 NikkiAlbums zh-CN）、`composeMetadataDictionarySupplementProvider` L38（默认 NikkiGallery） | 3 个函数                                                                                                                                                                                            |

### 2.5 remote/（4）+ desktop/（9）+ wechat/（4）

| 模块           | 关键文件与行                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 职责                                                                                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Remote Bridge  | `RemoteBridgeService.ts:9`（`createSession` L18 限 1..100 张、`listResources` L30 校验 sha256 未变、`getResource` L42、`closeSession/closeAllSessions` L50-51、`listSelectablePhotos` L53）；`RemoteSessionStore.ts:31`（token 化会话 + 过期）；`RemoteFileProvider.ts:20`（只读照片资源，外发前剥离 `sourcePath/sha256`）；`RemoteRoutes.ts:45`（`/remote/*` 处理，由 `LocalSyncServer.ts:225` 委派）；`RemoteConnection.ts:8` 端点校验                                                                                                                   | 限时外链分享。**强依赖 TLS**（`LocalSyncServer.ts:176` 禁止无 TLS 起 remote）                                                                                                  |
| Desktop 控制页 | `DesktopControlServer.ts:30`（由调用方绑 `127.0.0.1`，`windows-app.ts:168`；L41-44 校验 Host 头防 DNS rebinding；`/api/status` L120、`/api/pairing` L123、`/brand.png` L117、`/` L127；`/api/remote/*` 与 `/api/wechat/*` 需 `x-nikkisync-desktop-token`：`randomBytes(32)` L31 + `timingSafeEqual` L48-50 + Origin/`Sec-Fetch-Site` 校验 L50-51）；`DesktopStatusService.ts:19`、`DesktopPage.ts:27`、`DesktopPageScript.ts:1`、`RemoteBridgePanel.ts`、`WeChatGalleryPanel.ts`、`DesktopIcons.ts:16`、`StartupFailure.ts:2`、`AppDataDirectory.ts:4/:10` | 本机配对/状态/分享控制台                                                                                                                                                       |
| WeChat 通道    | `WeChatGalleryService.ts:26`（Noise-over-TCP 图库会话，`start/stop/status`；`resizeForWeChat` L82 调 PowerShell）；`WeChatIconProvider.ts:7` + `resizeWeChatIcon` L54；`GalleryRuntime.mjs`（**4222 行 esbuild 生成物**，由 `scripts/build-wechat-runtime.mjs` 同时写入 `src/wechat/` 与 `dist/src/wechat/`）；`GalleryRuntime.d.mts`（24 行类型面：`createIndexedPreviewSource` L20、`exportLive` L21、`exportJpeg` L22、`rotatePng` L23）                                                                                                                | 微信小程序/局域网 Noise 通道 + JPEG/LivePhoto 导出。**`LocalSyncServer.ts:7` 直接 `import {exportJpeg} from '../wechat/GalleryRuntime.mjs'` ⇒ LAN 服务被微信运行时打包物绑住** |

`GalleryRuntime.mjs` 的外部依赖（bundle 时 `packages:'external'`、`external:['node:sqlite']`，见 `NikkiSync/scripts/build-wechat-runtime.mjs`）：`node:child_process spawn`（ffmpeg/ffprobe/PowerShell，路径由调用方注入，`windows-app.ts:145-149`）、`node:net`、`node:fs/promises`、`node:crypto`、**`qrcode`（裸包名 import）**、`node:sqlite`（经 `@nikkisync/database`）。

---

## 3. Q3 数据库完整 schema

来源：`packages/database/migrations/0001_initial.sql`（173 行，单文件、无版本演进；`schema_migrations` 仅登记 version=1 `initial_asset_resource_sync_schema`，L171-172）。
PRAGMA 头（L1-4）：`foreign_keys=ON`、`journal_mode=WAL`、`synchronous=NORMAL`、`busy_timeout=5000`；`DatabaseManager` 构造时再执行 `foreign_keys` + `busy_timeout`（`packages/database/src/database-manager.ts:42`）。`transaction()` 用 `BEGIN IMMEDIATE / COMMIT / ROLLBACK`（`:53-63`），全同步 API。

表清单（12 业务表 + `sqlite_sequence`，`npm run db:validate` 输出见 §11）：`schema_migrations`、`library_state`、`assets`、`resources`、`resolver_candidates`、`change_journal`、`paired_devices`、`device_sync_state`、`pairing_sessions`、`app_settings`、`metadata_dictionary_state`、`metadata_dictionary_entries`。

### 3.1 `assets`（16 列，DDL L22-39）

```sql
CREATE TABLE IF NOT EXISTS assets (
  asset_id TEXT PRIMARY KEY,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('photo','motion_photo','video','unknown')),
  asset_state TEXT NOT NULL DEFAULT 'resolving' CHECK (asset_state IN ('ready','resolving','missing','deleted')),
  game TEXT NOT NULL DEFAULT 'infinity_nikki' CHECK (game = 'infinity_nikki'),
  uid TEXT,
  captured_at TEXT,
  discovered_at TEXT NOT NULL,
  metadata_schema_version INTEGER,
  metadata_json TEXT,
  motion_presentation_timestamp_us INTEGER,
  motion_resolver_method TEXT CHECK (motion_resolver_method IS NULL OR motion_resolver_method IN ('embedded_id','filename','timestamp','heuristic','manual')),
  motion_resolver_confidence REAL CHECK (motion_resolver_confidence IS NULL OR (motion_resolver_confidence >= 0 AND motion_resolver_confidence <= 1)),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- 索引（L41-45）：idx_assets_captured_at(captured_at DESC, asset_id)、idx_assets_uid_captured_at、
--                idx_assets_type_captured_at、idx_assets_revision、idx_assets_state
```

### 3.2 `resources`（19 列，DDL L47-74）

```sql
CREATE TABLE IF NOT EXISTS resources (
  resource_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('source_primary','source_high_quality','source_low_quality',
                                     'source_motion','derived_thumbnail','derived_preview')),
  file_name TEXT NOT NULL,
  source_path TEXT NOT NULL,
  path_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  file_ext TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  modified_at TEXT,
  birth_time TEXT,
  stable_state TEXT NOT NULL DEFAULT 'stable' CHECK (stable_state IN ('discovered','writing','stable','missing')),
  is_derived INTEGER NOT NULL DEFAULT 0 CHECK (is_derived IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- 索引（L76-80）：idx_resources_asset_role、idx_resources_sha256、idx_resources_stable_state、
--                uq_resources_asset_role_source(asset_id, role, path_key) UNIQUE
```

要点：`path_key` 全局 UNIQUE（`packages/core/src/path-key.ts:4` `toPathKey`，win32 小写规范化）⇒ 同一物理文件不能同时属于两个库；`sha256` NOT NULL 且长度锁 64 ⇒ 沿用本 schema 就必须给真哈希（`ScanReconciler.ts:85` 缺哈希时写空串，会被 CHECK 拒绝）。

### 3.3 `change_journal`（5 列，DDL L100-108）

```sql
CREATE TABLE IF NOT EXISTS change_journal (
  revision INTEGER PRIMARY KEY CHECK (revision > 0),
  event_type TEXT NOT NULL CHECK (event_type IN ('asset.created','asset.updated','asset.deleted')),
  asset_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_change_journal_asset ON change_journal(asset_id, revision);
```

`revision` 即主键 ⇒ 全局单调无重复；配套 `library_state`（L12-20，单行 `id=1` + `library_revision`）由 `packages/database/src/change-journal-repository.ts:3` 与 `asset-repository.ts:21` 在事务内推进。增量同步语义 = `GET /v1/changes?after=N` + `fullResyncRequired`（`packages/protocol/src/index.ts:192-193`）。

### 3.4 配对/设备三表（DDL L110-139）

```sql
CREATE TABLE IF NOT EXISTS paired_devices (
  device_id TEXT PRIMARY KEY, device_name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios','android')),
  public_key TEXT NOT NULL, credential_hash TEXT NOT NULL, app_version TEXT,
  paired_at TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT
);   -- 9 列；索引 idx_paired_devices_active(revoked_at, last_seen_at DESC)
CREATE TABLE IF NOT EXISTS device_sync_state (
  device_id TEXT PRIMARY KEY REFERENCES paired_devices(device_id) ON DELETE CASCADE,
  last_ack_revision INTEGER NOT NULL DEFAULT 0 CHECK (last_ack_revision >= 0), updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pairing_sessions (
  pairing_token_hash TEXT PRIMARY KEY,  -- 只存 sha256(token)，明文 token 不落库
  server_id TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL
);
```

任务书所称「pairings 表」实际是 **`paired_devices` + `pairing_sessions` + `device_sync_state`** 三张。

### 3.5 其余 5 表（DDL L6-10、L82-98、L141-169）

| 表                            | 关键列                                                                                                                                                                  | 用途                                                                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `schema_migrations`           | `version` PK、`name` UNIQUE、`applied_at`                                                                                                                               | 迁移登记（当前 1 行）                                                                                                            |
| `resolver_candidates`         | `still_resource_id`/`motion_resource_id`（双 FK CASCADE）、`score`、`confidence`、`reasons_json`、`status IN ('pending','accepted','rejected')`、`UNIQUE(still,motion)` | 静图↔动图配对候选与人工纠正留痕                                                                                                  |
| `app_settings`                | `key` PK、`value_json`、`updated_at`                                                                                                                                    | 键值仓（`AppSettingsRepository`）：存 `server.identity`（**含 Ed25519 私钥 PEM**）与 `server.tlsIdentity`（**含 RSA 私钥 PEM**） |
| `metadata_dictionary_state`   | 单行 `id=1`、`schema_version=1` CHECK、`provider`、`provider_version`、`game_version?`、`generated_at?`、`fetched_at`                                                   | 字典来源与新鲜度                                                                                                                 |
| `metadata_dictionary_entries` | `kind IN ('clothing','filter','lighting','pose','location')` + `entity_id` 复合 PK、`name`、`category`、`rarity`、`thumbnail`、`raw_json`                               | 服装字典条目                                                                                                                     |

---

## 4. Q4 Node.js / Electron 兼容性

### 4.1 事实

| 项                        | 值                                                                       | 证据                                                                                     |
| ------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| NikkiSync 要求            | `engines.node >= 24.0.0`（硬要求：`node:sqlite`）                        | `NikkiSync/package.json:6-8`；驱动选择 `packages/database/src/database-manager.ts:14-18` |
| XiangCe Electron 声明     | `"electron": "41.10.6"`（**精确锁定，非任务书假设的 40**）               | `WXNN XiangCe/package.json:173`                                                          |
| XiangCe Electron 实装     | 41.10.6                                                                  | `node_modules/electron/package.json` + `electron --version` → `v41.10.6`                 |
| Electron 内置 Node        | **24.18.0**（≥ 24 ✅）                                                   | 探针 P1                                                                                  |
| Electron 原生 ABI         | `process.versions.modules = 145`                                         | 探针 P1                                                                                  |
| `node:sqlite` in Electron | **可用**（建表/插入/查询通过）                                           | 探针 P2                                                                                  |
| Bun 分支                  | `process.versions.bun = undefined` ⇒ 走 `node:sqlite`（非 `bun:sqlite`） | 探针 P1；`database-manager.ts:14`                                                        |
| XiangCe engines           | `>=22.12.0`                                                              | `WXNN XiangCe/package.json:24-26`                                                        |
| 本机 node/npm             | v26.3.0 / 11.16.0                                                        | 实测                                                                                     |

### 4.2 三条路线的可行性与改动量

| 选项                                                    | 可行性                                                                                                                                                                                                                                | 改动量                                            | 判定                                                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. 升级 Electron                                        | **不需要**，41.10.6 已含 Node 24.18                                                                                                                                                                                                   | 0                                                 | 无收益；升 Electron 反而牵动 better-sqlite3/sharp/koffi 原生重编译（`build.npmRebuild = true`、`asarUnpack` 清单 `WXNN XiangCe/package.json:244-255`） |
| B. 以 better-sqlite3 替换 `node:sqlite` 驱动层          | 可行但**不必要**。需把 `packages/database/src/database-manager.ts` 的 `SqliteConnection` 抽象映射到 better-sqlite3（`prepare().get/all/run` 语义基本一致，但要处理 `:memory:`、PRAGMA 位置、L14-18 的 Bun 分支与顶层 `await import`） | 中（1 个核心文件 + 131 测试全量回归）             | 仅当宿主 Node < 24 或 Electron 未编入 sqlite 时才值得；两条都不成立（探针 P2 已证）                                                                    |
| C. 独立子进程（`utilityProcess` / 独立 node）跑 Runtime | 可行                                                                                                                                                                                                                                  | 中-高（IPC 协议、端口与生命周期、日志、崩溃重启） | **非技术前置**，只是隔离性选择；代价是多一套进程与 IPC，且 mDNS 5353 组播、TLS 私钥归属都要按进程边界重做                                              |

### 4.3 推荐

**主进程内直接 `await import()` 嵌入（A/B/C 都不做）**，依据与硬约束：

1. 探针 P3 已证明 Runtime 全链（自签 TLS、配对 URI、监听、优雅停止）在 Electron 41 的 Node 24.18 中可跑。
2. **唯一硬约束**：`packages/database/src/database-manager.ts:15` 顶层 `await import(sqliteModuleName)` 使整个 ESM 图含 TLA ⇒ `require()` 直接 `ERR_REQUIRE_ASYNC_MODULE`（探针 P4）。而 XiangCe 主进程产物是 **CJS lib**（`WXNN XiangCe/electron.vite.config.ts:94` `formats: ['cjs']`，配 `build` 脚本写 `dist/main/package.json {type:"commonjs"}`，`package.json:35`），node_modules 被 `externalizeNodeModules()` 外部化（`electron.vite.config.ts:61-64`）⇒ 嵌入层必须写成 `await import(pathToFileURL(entry).href)` 这类**变量式动态 import**，并确保该 specifier 不被打包器静态折叠。
3. `@nikkisync/*` 产物解析路径需显式给定（workspaces 软链在 `NikkiSync/node_modules/@nikkisync/*`，XiangCe 侧未安装这些包）；打包态需 `files` / `asarUnpack` 策略——属后续阶段实施内容。

---

## 5. Q5 依赖冲突

NikkiSync 第三方面很小：根 `devDependencies = esbuild 0.28.2 / @types/node ^24.0.0 / typescript ^5.9.0`（`NikkiSync/package.json:41-45`）；`@nikkisync/pc-companion` 运行时依赖只有 **`qrcode ^1.5.4`** + `@nikkisync/database` / `@nikkisync/protocol`（`apps/pc-companion/package.json:13-20`）；`@nikkisync/{core,protocol,database}` 无任何第三方依赖（`packages/*/package.json`）。NikkiSync `node_modules` 顶层 66 个包 + 4 个 scope（`@esbuild`/`@nikkisync`/`@types`/…），**无原生编译模块**。

| 包                                                                     | NikkiSync 声明                                         | NS 实装     | XiangCe 声明            | WX 实装                                                                             | 冲突判定                                                                                                                                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------ | ----------- | ----------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typescript`                                                           | `^5.9.0`（root devDep）                                | **5.9.3**   | `^5.9.3`（L191）        | **5.9.3**                                                                           | 无（实装同版本）                                                                                                                                                                |
| `@types/node`                                                          | `^24.0.0`                                              | **24.13.3** | `^22.10.0`（L162）      | **22.20.1**                                                                         | **唯一实质分歧**。各自独立安装互不影响；若共享同一 hoisted 树或交叉引用类型需统一（Node 22 类型面缺 `node:sqlite`，XiangCe 要引 NikkiSync 类型须升 `@types/node ^24`）          |
| `qrcode`                                                               | `^1.5.4`（pc-companion dep）                           | **1.5.4**   | `^1.5.4`（L130）        | **1.5.4**                                                                           | 无（版本完全一致，两侧均已安装）                                                                                                                                                |
| `@types/qrcode`                                                        | `^1.5.5`                                               | **1.5.6**   | `^1.5.6`（L163）        | **1.5.6**                                                                           | 无                                                                                                                                                                              |
| `esbuild`                                                              | `0.28.2`（root devDep，精确）                          | **0.28.2**  | 未直接声明（传递依赖）  | 顶层 **0.25.12**，另有嵌套副本 `node_modules/tsx/node_modules/esbuild` = **0.28.1** | 无硬冲突：XiangCe 已同时容纳 0.25.12 与 0.28.1，说明引入 NikkiSync 的 0.28.2 只需嵌套共存。只有 NikkiSync 构建期用它（生成 `GalleryRuntime.mjs`），嵌入后运行时不再需要 esbuild |
| `better-sqlite3` / `@types/better-sqlite3`                             | 无                                                     | —           | `^12.11.1`（L116/L160） | 12.11.1                                                                             | 无冲突；注意 `node:sqlite` 与 better-sqlite3 会同进程并存（各自独立连接与事务）                                                                                                 |
| `sharp`、`ffmpeg-static`、`ffprobe-static`、`koffi`、`network-address` | 无                                                     | —           | 有（L120-128）          | 有                                                                                  | 无冲突。NikkiSync 的 ffmpeg/PowerShell 是**运行时按外部路径 spawn**（`GalleryRuntime.mjs` 内 `spawn`；路径由 `windows-app.ts:145-149` 注入），不依赖 npm 包                     |
| `noise-handshake`、`sodium-javascript`、`buffer`                       | `tools/wechat-crypto-spike` dep（`package.json:8-12`） | 已装        | 无                      | —                                                                                   | 无冲突：仅开发期 spike 使用，被 esbuild 打进 `GalleryRuntime.mjs`                                                                                                               |
| `zod`                                                                  | 无（协议校验全手写 if/typeof）                         | —           | `^4.4.3`（L139）        | 有                                                                                  | 无冲突，但**校验风格差异**要留意                                                                                                                                                |
| `engines.node`                                                         | `>=24.0.0`                                             | —           | `>=22.12.0`             | —                                                                                   | 合并安装取严：需 ≥ 24（本机 26.3.0 满足）                                                                                                                                       |

---

## 6. Q6 测试入口

**框架与形态**：`node:test` + `node:assert/strict`，**顶层 `test()` 函数、无 describe/it**；测试源码在 `packages/*/test/` 与 `apps/pc-companion/test/`，**运行的是 `dist/` 编译产物**（改源码不 build 会跑旧测试）。

| 命令（`NikkiSync/` 下执行）                                         | 行为                                                                                                                                                                             | 实测                                                        |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `npm test`                                                          | `npm run build` → `node --test --test-isolation=none` + **23 个文件参数**（21 个 `dist/*.test.js` + `tools/sample-analyzer/test/analyzer.test.mjs` + `tools/ui-theme.test.mjs`） | **131 tests / 131 pass / 0 fail**（脚本 `package.json:37`） |
| `npm run typecheck`                                                 | build core/protocol/database + wechat runtime，再对 pc-companion `tsc --noEmit`（`package.json:36`）                                                                             | 退出码 0                                                    |
| `npm run build`                                                     | `build:core → build:protocol → build:database → build:pc`（`package.json:35`）                                                                                                   | 通过                                                        |
| `npm run db:validate`                                               | `node packages/database/scripts/validate-schema.mjs`（内存库跑整份 DDL + `foreign_key_check` + `quick_check`）                                                                   | `schema OK` / 13 张表 / 两项 ok                             |
| `node --test apps/pc-companion/dist/test/local-sync-server.test.js` | 单文件跑协议契约测试                                                                                                                                                             | 6 个 test                                                   |
| `npm run test:wxnn-e2e`                                             | build 后跑 `dist/test/wxnn-cross-server.test.js`，需 `WXNN_E2E_INFO`（XiangCe `scripts/sync-e2e/launch-server.ts` 输出的 JSON，attach 模式）                                     | 本阶段未执行（需先起 XiangCe 服务）                         |
| `npm run test:performance`                                          | 6 个性能/回归文件，含 `runtime-memory.test.js`（`package.json:18`）                                                                                                              | 本阶段未执行（零源码改动）                                  |

**测试文件全清单（25 个源文件，括号为顶层 `test()` 数）**

- `apps/pc-companion/test/`（20）：`app-data-directory`(1)、`desktop-page`(6)、`game-directory-discovery`(11)、`local-sync-server`(6)、`metadata-dictionary-provider`(4)、`metadata-dictionary`(8)、`metadata-resolver-config`(7)、`metadata-resolver-pipeline`(3)、`metadata-resolver`(11)、`metadata-thumbnail-cache`(5)、`metadata-thumbnail-proxy`(2)、`nikki-albums-metadata-dictionary-provider`(4)、`nikki-gallery-metadata-dictionary-provider`(8)、`qr`(1)、`remote-bridge`(6)、`row-mappers`(3)、`runtime-memory`(1)、`scanner`(15)、`windows-app`(6)、`wxnn-cross-server`(13)
- `packages/core/test/`：`resolver`(8)、`metadata-dictionary`(3)；`packages/database/test/`：`database`(11)；`packages/protocol/test/`：`protocol`(4)

**不在默认 `npm test` roster 的 3 个 pc-companion 文件**：`metadata-resolver-config.test.ts`、`runtime-memory.test.ts`（归 `test:performance`）、`wxnn-cross-server.test.ts`（归 `test:wxnn-e2e`）。嵌入阶段若要靠测试守契约，必须显式点名这些文件。

**`local-sync-server.test.ts` 的 6 个用例即「可执行契约规格」**（`L17`、`L30`、`L84`、`L277`、`L292`、`L354`）：无订阅者时不轮询 journal、JPEG 导出的鉴权/源校验/非破坏/拒绝畸形参数、完整「配对 → 验签 → 分页 → Range 流式 → `/changes` → WebSocket 事件」主流程、TLS 身份一次性生成且指纹稳定、套装搜索分层排序、服装搜索 exact>prefix>contains。L84 起含配对与 Ed25519 签名请求的完整代码，可直接当接入样例。

**已知构建顺序缺陷（阶段 0 风险 10，本次确认路径）**：`build:pc`（`package.json:27`）先跑 `scripts/build-wechat-runtime.mjs`，而 `tools/wechat-gallery/{source,browse}.mjs` 静态 import `apps/pc-companion/dist/src/...`，pc-companion 的 `tsc` 在其后才执行 ⇒ **无 `dist/` 的全新检出必失败**。绕过顺序（本阶段实测可用）：

```
npm exec --workspace @nikkisync/pc-companion -- tsc -p tsconfig.json   # 先产出 dist
npm test                                                              # 再跑全量
```

---

## 7. Q7 配置项

### 7.1 环境变量（`process.env.NIKKISYNC_*` 全量正则采集，共 11 个）

| 变量                                  | 默认值                                                                                             | 消费位置                                 | 说明                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------- |
| `NIKKISYNC_DB`                        | `nikkisync.sqlite`（相对 cwd）                                                                     | `src/dev-server.ts:15-16`                | 值为 `:memory:` 时保持内存库，否则 `path.resolve()`                       |
| `NIKKISYNC_BIND`                      | `0.0.0.0`                                                                                          | `dev-server.ts:17`、`windows-app.ts:125` | 监听地址                                                                  |
| `NIKKISYNC_PORT`                      | dev `0`（随机）/ windows-app `28080`                                                               | `dev-server.ts:18`、`windows-app.ts:126` | 生产与开发默认不同，易踩                                                  |
| `NIKKISYNC_MDNS`                      | 启用（`!== '0'`）                                                                                  | `dev-server.ts:19`、`windows-app.ts:127` | **只有字符串 `'0'` 能关闭**                                               |
| `NIKKISYNC_HOST`                      | 首个非 internal IPv4                                                                               | `dev-server.ts:32`                       | 仅用于拼配对 URI，不改监听                                                |
| `NIKKISYNC_METADATA_THUMBNAIL_CACHE`  | 内存库 → `os.tmpdir()/nikkisync-metadata-thumbnails-dev`；文件库 → `<db 目录>/metadata-thumbnails` | `dev-server.ts:20-23`                    | 缩略图缓存目录                                                            |
| `NIKKISYNC_METADATA_RESOLVER_URL`     | 无                                                                                                 | `windows-app.ts:79-85`                   | 设了就优先 remote-json provider（覆盖 NUAN5 默认）                        |
| `NIKKISYNC_METADATA_RESOLVER_ID`      | `remote-json`                                                                                      | `windows-app.ts:81`                      | provider id                                                               |
| `NIKKISYNC_METADATA_RESOLVER_VERSION` | 无                                                                                                 | `windows-app.ts:82-84`                   | 变更会触发已解析照片重新 enrich                                           |
| `NIKKISYNC_GAME_ROOT`                 | 无                                                                                                 | `game-directory-discovery.ts:237`        | **优先级最高的手工指定**（等同 `selectedInstallRoot`，来源记为 `manual`） |
| `NIKKISYNC_DESKTOP_PORT`              | `0`（随机，绑 `127.0.0.1`）                                                                        | `windows-app.ts:168`                     | 桌面控制页端口                                                            |

非 NikkiSync 前缀：`LOCALAPPDATA`（`windows-app.ts:25`，数据目录首选）。
**不存在 `NIKKISYNC_DESKTOP_TOKEN`**：桌面控制 token 每次进程随机生成（`desktop/DesktopControlServer.ts:31`），只注入自家页面（L129）。

### 7.2 数据目录与文件布局

`APP_DATA = chooseWritableDataDirectory([...])`（`windows-app.ts:24-28`），候选顺序：① `%LOCALAPPDATA%\NikkiSync`（缺失时退 `os.homedir()/NikkiSync`）② `<process.execPath 目录>\data` ③ `<cwd>\data`；可写性用试写探测（`desktop/AppDataDirectory.ts:10-22`）。

| 文件                                  | 作用                                                                   | 结构                                                                                                                                                                                                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `nikkisync.sqlite`                    | 唯一 SQLite 主库（+ WAL/SHM 边文件）                                   | §3 schema                                                                                                                                                                                                                                                                |
| `metadata-resolver.json`              | 拍摄参数解析 provider 配置                                             | `{ enabled?, provider?, providers?[] }`；provider 形态 `type:'remote-json'`（endpoint 必须 https）或 `'nuan5-compatible'`，可带 `priority/capabilities/id/version/timeoutMs/headers`（`metadata/MetadataResolverConfigFile.ts:13-38`）；解析失败整份视为无配置（L62-64） |
| `metadata-dictionary.json`            | 离线主字典种子                                                         | `MetadataDictionaryManifest`（`packages/core/src/metadata-dictionary.ts`）                                                                                                                                                                                               |
| `metadata-dictionary-supplement.json` | 补充字典（与内置 `VERIFIED_CLOTHING_NAMES` 合并，`windows-app.ts:69`） | 同上                                                                                                                                                                                                                                                                     |
| `metadata-dictionary-remote.json`     | 远端字典开关与节奏                                                     | `{ enabled?, provider?.intervalMs?, gallery?: {enabled?, intervalMs?} }`（`metadata/MetadataDictionaryRemoteConfigFile.ts:24-45`）                                                                                                                                       |
| `game-install-root.txt`               | 上次成功发现的 installRoot 缓存                                        | 单行路径（读 `windows-app.ts:37-44`，写 L136）                                                                                                                                                                                                                           |
| `metadata-thumbnails/`                | 服装缩略图内容寻址缓存                                                 | `MetadataThumbnailCache`                                                                                                                                                                                                                                                 |
| `game-discovery.log`                  | 发现过程统计（只含计数/来源，不含个人路径）                            | `windows-app.ts:95-97`                                                                                                                                                                                                                                                   |
| `startup-error.log`                   | 崩溃前 `{timestamp, phase, message}`                                   | `windows-app.ts:182-189`                                                                                                                                                                                                                                                 |

离线/在线模式（`metadata/MetadataStartupComposition.ts:17-26`）：`metadata-resolver.json` 写 `{"enabled": false}` ⇒ `composeMetadataResolver` 返回 `undefined` ⇒ Runtime 不建 `MetadataResolverService` ⇒ **完全不联网**；无配置文件且无 env ⇒ 默认 `Nuan5CompatibleResolver`（`https://nuan5.pro/api/decode-photo2`，**默认联网**）。字典侧同理：`metadata-dictionary-remote.json` 的 `enabled:false` 同时关掉两个远端 provider（L32-33、L39）。

---

## 8. 复用清单

### 8.1 可直接 `import` 复用（零改造或仅需路径/依赖注入）

| 模块                                                                                                                                                            | 路径                                                                 | 前置条件                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 协议契约（DTO / `API_ROUTES` / 错误码 / `buildPairingUri`）                                                                                                     | `packages/protocol/src/index.ts`                                     | 零依赖                                                                                                                                            |
| 领域模型 + `AssetResolver` + `toPathKey` + 字典 enrich                                                                                                          | `packages/core/src/{types,resolver,path-key,metadata-dictionary}.ts` | 零依赖                                                                                                                                            |
| `DatabaseManager` + 9 个 Repository + `0001_initial.sql`                                                                                                        | `packages/database/src/*`、`packages/database/migrations/`           | Electron 内实测可用；`initialize()` 用 `import.meta.url` 相对定位 SQL（`database-manager.ts:48`），打包后需保证该相对路径成立或显式传 `schemaSql` |
| `MdnsAdvertiser`                                                                                                                                                | `server/MdnsAdvertiser.ts`                                           | 纯 `node:dgram`                                                                                                                                   |
| `LocalTlsIdentityService`                                                                                                                                       | `server/LocalTlsIdentityService.ts`                                  | 纯 `node:crypto` + `app_settings`                                                                                                                 |
| `WebSocketHub`                                                                                                                                                  | `server/WebSocketHub.ts`                                             | 纯 `Duplex`，可挂宿主 server 的 `upgrade`                                                                                                         |
| `AuthService` / `PairingService` / `PairingError`                                                                                                               | `server/{AuthService,PairingService}.ts`                             | 只需注入 `DatabaseManager`                                                                                                                        |
| `row-mappers`（含隐私字段剥离）                                                                                                                                 | `server/row-mappers.ts`                                              | 纯函数                                                                                                                                            |
| `SuitSearchIndex` / `ClothingSearchIndex` / `ProfileStatsIndex` / `GameVersionCalendar`                                                                         | `server/*.ts`                                                        | 纯函数                                                                                                                                            |
| `ResourceClassifier` / `FileStabilityGuard` / `ScanCoordinator` / `ScanReconciler` / `ScannerWatcher`                                                           | `scanner/*.ts`                                                       | 纯 `node:fs` / `node:crypto`                                                                                                                      |
| `game-directory-discovery` + `WindowsInstallationHints`                                                                                                         | 根层                                                                 | 依赖 `execFile` 调 PowerShell；与 WXNN 已有游戏目录能力需二选一                                                                                   |
| `qrSvg`                                                                                                                                                         | `qr.ts:167`                                                          | 只需 `qrcode`（两侧同为 1.5.4）                                                                                                                   |
| `MetadataResolverPipeline` / `MetadataResolverConfigFile` / `MetadataStartupComposition` / `MetadataDictionaryService` / `MetadataThumbnailCache` / 各 provider | `metadata/*.ts`                                                      | 逻辑可复用，联网副作用见 §8.2                                                                                                                     |
| `chooseWritableDataDirectory` / `isWritableDataDirectory`                                                                                                       | `desktop/AppDataDirectory.ts:4/:10`                                  | Electron 下应把 `app.getPath('userData')` 放候选首位                                                                                              |

### 8.2 需要包装 / 需要宿主决策

| 模块                                | 需要的包装                                                                                                       | 原因                                                                                                                                                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PcCompanionRuntime.start()`        | 拆成「先 server、按需 scanner」两段调用                                                                          | `start()` 把 `scanner.start()` 作为**硬前置**：找不到游戏安装即抛（`runtime.ts:93` + `ScannerService.ts:27`），而 WXNN 已有自己的目录配置态与扫描器                                                                                        |
| `LocalSyncServer`                   | 生命周期挂 Electron `before-quit`；日志接 `electron-log`；`journalPollMs`/`mdns` 暴露到设置 UI；端口与防火墙协同 | 它自建 http(s) server 与 timer，嵌入后需明确端口归属                                                                                                                                                                                       |
| `ScannerService` + `ScanReconciler` | 与 WXNN `src/main/scanner/**`（utilityProcess worker）**二选一**                                                 | 双扫描器同扫一份目录会争 IO 且各算一遍 sha256；`resources.path_key` UNIQUE 要求单一事实源                                                                                                                                                  |
| `metadata/` 全家                    | 显式离线开关 + provider 端点白名单 + 与宿主网络策略协同                                                          | 默认 provider 会向 `nuan5.pro` 上送**照片参数元组**（`Nuan5CompatibleResolver.ts:23-32`、`:74`）；两个字典 provider 会 GET `nikki.ranaxro.com`、`nikkigallery.vip`，服装名来源还含 `wiki.biligame.com`（`VerifiedClothingNames.ts:24-25`） |
| `wechat/` + `GalleryRuntime.mjs`    | 决定是否随嵌入引入；ffmpeg/ffprobe/PowerShell 路径需重新注入                                                     | `LocalSyncServer.ts:7` 使 LAN 服务硬依赖该 4222 行打包物；XiangCe 已有 `ffmpeg-static`/`ffprobe-static`/`sharp`，路径体系不同                                                                                                              |
| `desktop/` 控制页                   | 嵌入后多半不需要（WXNN 有自己的 renderer 设置页）                                                                | 若保留需避免与 WXNN 端口/UI 双份并存                                                                                                                                                                                                       |
| `remote/` Remote Bridge             | 决定是否引入                                                                                                     | 强绑 TLS（`LocalSyncServer.ts:176`）；新增一条对外临时链接通道，属安全面扩大                                                                                                                                                               |
| `windows-app.ts` / `dev-server.ts`  | 仅作参考实现，不直接复用                                                                                         | 面向 Bun 单文件 exe：`process.versions.bun` 分支、`import.meta.dirname` 相对资源路径（`windows-app.ts:74-76`、`:145-149`、`:157-159`）                                                                                                     |

---

## 9. 潜在风险点

| #   | 风险                                                                                                                                                                                           | 严重度               | 证据 / 触发条件                                                                                                                                                                                                                  | 缓解                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 打包态 ESM 可解析性：XiangCe CJS 主进程产物里 `await import()` 一个 `type: module` 的外部包，需保证 specifier 不被折叠、asar 路径可 `pathToFileURL`、`@nikkisync/*` 的 `exports.import` 能解析 | 高                   | `electron.vite.config.ts:61-64`（node_modules 外部化）、`package.json:35`（写 `{type:commonjs}`）、探针 P4                                                                                                                       | 后续阶段先做「dev + `dist:win` 两种形态各跑一次 P3 探针」的验证，再定 `file:` 依赖 / 复制 `dist/` 到 `resources/` / `asarUnpack` |
| R2  | `runtime.start()` 的 scanner 硬前置导致「未装游戏 / 未配目录」时整个 Runtime 起不来                                                                                                            | 高                   | `runtime.ts:93`、`ScannerService.ts:26-27`（`throw new Error('Infinity Nikki installation was not found')`）                                                                                                                     | 嵌入层不调 `runtime.start()`，而是分段 `server.start()` + 用户配好目录后再 `scanner.start()`；或包一层可降级启动器               |
| R3  | 双扫描器竞争：WXNN scanner worker 与 NikkiSync ScannerService 扫同一目录                                                                                                                       | 中-高                | `WXNN XiangCe/src/main/scanner/`（utilityProcess）+ `ScannerService.ts:29-32`（`fs.watch recursive`）；阶段 0 风险 4                                                                                                             | 只让一侧拥有目录扫描权；另一侧只消费事件；`scanner.watcher:false` 已可用                                                         |
| R4  | `sha256` 必填带来的全量哈希成本（`resources.sha256` NOT NULL + length 64 CHECK）                                                                                                               | 中                   | `0001_initial.sql:64`、`ResourceClassifier.ts:41-50`（全文件流式）、`ScanReconciler.ts:85`（空串会被 CHECK 拒）                                                                                                                  | 增量计算 + 落库缓存；复用 XiangCe `calculateFileHash`；首次接入可先只处理新增文件                                                |
| R5  | `path_key` 全局 UNIQUE + `asset_id` 由路径派生 ⇒ 目录改名/移动会当作全新资产重建（连带 revision 膨胀）                                                                                         | 中                   | `0001_initial.sql:60`、`ScanReconciler.ts:7`、`path-key.ts:4`                                                                                                                                                                    | 引入前先定义目录基准（与 XiangCe `file_path` UNIQUE 语义对齐）                                                                   |
| R6  | 默认联网解析（NUAN5 参数元组上送 + 两个公共字典源）与隐私/合规预期不一致                                                                                                                       | 中-高                | `MetadataStartupComposition.ts:25`、`Nuan5CompatibleResolver.ts:74`、`NikkiAlbums…:9`、`NikkiGallery…:5-6`                                                                                                                       | 嵌入时默认写 `metadata-resolver.json {"enabled":false}`，并在 UI 显式开关 + 告知上送内容                                         |
| R7  | `LocalSyncServer` ↔ `wechat/GalleryRuntime.mjs` 硬耦合（LAN 服务编译期依赖微信打包物）                                                                                                         | 中                   | `LocalSyncServer.ts:7`                                                                                                                                                                                                           | 后续阶段可提 PR 把 `exportJpeg` 改为可选注入；本阶段不改                                                                         |
| R8  | mDNS 组播 + Windows 防火墙：5353 组播首次会弹授权；electron-builder 分发后需声明规则                                                                                                           | 中                   | `MdnsAdvertiser.ts:4-5`、`L72-78`                                                                                                                                                                                                | 嵌入层默认 `mdns:false`，由用户在设置里开；文档写明防火墙预期                                                                    |
| R9  | 私钥入明文库：Ed25519 私钥与 RSA 私钥 PEM 存在 `app_settings.value_json`（未加密）                                                                                                             | 中                   | `PairingService.ts:40-41`、`LocalTlsIdentityService.ts:120-127`、§3.5                                                                                                                                                            | 库文件放在 `userData` 下且不入同步库备份；必要时用 Electron `safeStorage` 包裹（属后续阶段）                                     |
| R10 | NikkiSync 全新检出构建顺序缺陷（`build:pc` 先于 pc-companion tsc）                                                                                                                             | 中                   | `package.json:27`；§6                                                                                                                                                                                                            | 按规定顺序先编 pc-companion；修脚本属源码改动，本阶段不做                                                                        |
| R11 | NikkiSync 无 `.gitattributes`，本机 `core.autocrlf=true` ⇒ 幻影 M（阶段 0 风险 11）                                                                                                            | 低                   | `NikkiSync/.gitattributes` 不存在（已确认）                                                                                                                                                                                      | 文档型改动不受影响；提 PR 时先 `git diff --stat` 确认                                                                            |
| R12 | npm allow-scripts 策略可能拦截 esbuild/electron/better-sqlite3 安装脚本（阶段 0 风险 7）                                                                                                       | 低                   | 本阶段两侧 `npm install` 均退出码 0（§11）                                                                                                                                                                                       | 重装依赖时参照 `WXNN XiangCe/docs/troubleshooting-npm-audit-mirror.md`                                                           |
| R13 | XiangCe 工作区携带未提交的阶段 7 WIP，导致 `typecheck` / `lint` / `test:main` 三项基线为红（与本阶段无关）                                                                                     | 低（阶段归属已举证） | 实测：typecheck 2 错（`sync-read-repository.ts(125,26) TS2503`、`(231,5) TS2322`）、lint 1 error（`sync-read-repository.ts:6:8` 未使用项）、test:main 5 files / 17 tests 失败——**5 个失败文件全部在 WIP 清单内**（逐条见 §11.3） | 用户已决定不提交该 WIP；本阶段不修、不掩盖，仅如实记录。阶段 7 继续推进时这些失败即设想的红灯                                    |

---

## 10. 与阶段 0 报告的差异补充

| 项                       | 阶段 0 记录                        | 本次复核                                                                                                  |
| ------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Electron 内置 Node       | 24.18.0（实测）                    | 一致；新增 ABI = 145、`process.versions.bun = undefined`                                                  |
| `node:sqlite` 可用性     | 可用（建表/插入/查询）             | 一致；新增「整个 Runtime 可 `import()` 并 `start()/stop()`」与「`require()` 因 TLA 不可用」两条更硬的结论 |
| 表数量                   | 「12 表」（§4 正文列了 12 个名字） | 一致；`db:validate` 输出含 `sqlite_sequence` 共 13 个对象                                                 |
| 资源表列数               | 未细列                             | 本次逐列给出（19 列）+ `path_key` UNIQUE / `sha256` CHECK 后果                                            |
| `assets` 列数            | 未细列                             | 16 列（§3.1）                                                                                             |
| 「pairings 表」          | 未区分                             | 实际拆为 `paired_devices` / `pairing_sessions` / `device_sync_state`                                      |
| 风险 1（ESM/CJS 互操作） | 标为「高，需下一阶段首先验证」     | **已定论**：只能 `await import()`，探针 P3/P4 双向证明可行与边界                                          |

---

## 11. 验证记录

### 11.1 Electron 运行时四探针（均不落盘，脚本经 PowerShell stdin 传入）

通用前置（PowerShell，`NikkiSync/` 目录下）：

```powershell
$env:ELECTRON_RUN_AS_NODE="1"
$el="..\WXNN XiangCe\node_modules\electron\dist\electron.exe"
```

| 探针           | 命令要点                                                                                                                                                                                                                                                                       | 输出原文                                                                                                                                                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 运行时版本  | `"…console.log('P1 node='+process.versions.node+' electron='+…+' modules(ABI)='+process.versions.modules+' bun='+String(process.versions.bun))…" \| & $el 2>&1`                                                                                                                | `P1 node=24.18.0 electron=41.10.6 modules(ABI)=145 bun=undefined`                                                                                                                                                                                                                                                                |
| P2 SQLite 驱动 | 同上，`require('node:sqlite')` + `CREATE TABLE t` + 3 行插入 + `count(*)`                                                                                                                                                                                                      | `P2 node:sqlite OK rows=3`                                                                                                                                                                                                                                                                                                       |
| P3 运行时直嵌  | `\| & $el --input-type=module`；`await import()` `dist/src/index.js` 与 `dist/src/runtime.js` → `createPcCompanionContext()` → `new PcCompanionRuntime({server:{host:'127.0.0.1',port:0,mdns:false,name:'audit-probe'}})` → `server.start()` → `createPairingUri()` → `stop()` | `P3a index exports=18 runtime exports=PcCompanionRuntime context keys=database,protocolVersion protocolVersion=1`<br>`P3b listen host=127.0.0.1 port=9121 secure=true serverId=server_7228f17bd50f283214c50e994931c33a`<br>`P3c pairingUri=NS1\|server_7228f17bd50f283214c50e994931c33a\|127.0.0.1\|9121\|h...`<br>`P3d STOP-OK` |
| P4 互操作边界  | `createRequire(pathToFileURL(cwd+'/x.cjs').href)` 去 `require()` `packages/database/dist/src/index.js`                                                                                                                                                                         | `REQUIRE-ESM=ERR_REQUIRE_ASYNC_MODULE`（完整信息：`require() cannot be used on an ESM graph with top-level await. Use import() instead.`）                                                                                                                                                                                       |

补充：P3 的 `port` 为系统分配（两次运行分别得到 8851 / 9121），说明 `port:0` 语义在 Electron 内正常。

### 11.2 回归门禁

| 门禁                | 命令（目录）                                                            | 结果                                                                                                                                                                                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NikkiSync 装依赖    | `npm install`（`NikkiSync/`）                                           | 退出码 0，无 package-lock 变更                                                                                                                                                                                                                                                                          |
| NikkiSync 全量测试  | `npm test`（`NikkiSync/`）                                              | **131 tests / 131 pass / 0 fail / 0 skipped**                                                                                                                                                                                                                                                           |
| NikkiSync 类型检查  | `npm run typecheck`（`NikkiSync/`）                                     | 退出码 0                                                                                                                                                                                                                                                                                                |
| NikkiSync schema    | `npm run db:validate`（`NikkiSync/`）                                   | `schema OK`；tables: `app_settings, assets, change_journal, device_sync_state, library_state, metadata_dictionary_entries, metadata_dictionary_state, paired_devices, pairing_sessions, resolver_candidates, resources, schema_migrations, sqlite_sequence`；`foreign_key_check: ok`；`quick_check: ok` |
| XiangCe 装依赖      | `npm install`（`WXNN XiangCe/`）                                        | 退出码 0，幂等                                                                                                                                                                                                                                                                                          |
| XiangCe lint        | `npm run lint`（`WXNN XiangCe/`）                                       | **退出码 1：`12 problems (1 error, 11 warnings)`**。11 个 BOM warning 为阶段 0 已记录的存量问题；**1 个 error 来自阶段 7 未提交 WIP**（`src/main/database/sync-read-repository.ts:6:8` `AssetDetailResponse` 未使用），详 §11.3                                                                         |
| XiangCe 主进程测试  | `npm run test:main`（`WXNN XiangCe/`）                                  | **5 files / 17 tests 失败，3484 通过 / 2 跳过**；失败文件与 WIP 清单逐一对应（§11.3），本阶段未新增失败                                                                                                                                                                                                 |
| 既有阶段 0 校验复跑 | `node --test docs/sync-integration/verify-audit.mjs`（`WXNN XiangCe/`） | **9 tests / 9 pass / 0 fail**                                                                                                                                                                                                                                                                           |

### 11.3 XiangCe 基线失败的归因证据（均为阶段 7 未提交 WIP，与本阶段文档无关）

`npm run test:main`（`WXNN XiangCe/`）实测：**Test Files 5 failed | 183 passed (188)；Tests 17 failed | 3484 passed | 2 skipped (3503)；Duration 11.15s**。

失败文件逐个与 `git status` 的 WIP 清单完全重叠（无任何失败落在未改动文件上）：

| 失败文件                                               | 失败形式                                                                           | 属 WIP？           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------ |
| `src/main/database/sync-write-repository.test.ts`      | 套件加载失败：`Cannot find module './sync-write-repository'`（典型红灯：实现未写） | 是（未跟踪新文件） |
| `src/main/sync/server/annotations.test.ts`             | 套件加载失败：`Cannot find module './annotations'`                                 | 是（未跟踪新文件） |
| `src/main/sync/server/api-router.test.ts`              | 10 个失败，均在 `write endpoints (phase 7 bidirectional sync)` 组                  | 是（已修改）       |
| `src/main/sync/server/sync-server.integration.test.ts` | 5 个失败（DELETE/PATCH 写端点期望 200/400，实际 404/401）                          | 是（已修改）       |
| `src/main/database/sync-read-repository.test.ts`       | 2 个失败（详情回读 annotations）                                                   | 是（已修改）       |

`npm run lint`：`12 problems (1 error, 11 warnings)`，退出码 1。其中 11 个 BOM warning 为阶段 0 已记录的存量问题（`src/renderer/components/common/*.test.tsx`）；**唯一的 1 个 error 也来自 WIP 文件**：`src/main/database/sync-read-repository.ts:6:8 'AssetDetailResponse' is defined but never used`（WIP 把返回类型改成了 `ExtendedAssetDetail`）。

### 11.4 本次实际执行过的命令清单

| 命令                                                 | 目录            | 结果                                                                                                                  |
| ---------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------- |
| `npm install`                                        | `NikkiSync/`    | 退出码 0；git 干净（package.json/lock 无变更）；npm 仅报 `allow-scripts esbuild@0.28.2` 警告（与阶段 0 风险 12 一致） |
| `npm install`                                        | `WXNN XiangCe/` | 退出码 0；git 干净；同样仅 allow-scripts 警告（esbuild）                                                              |
| `npm test`                                           | `NikkiSync/`    | 131/131 通过                                                                                                          |
| `npm run typecheck`                                  | `NikkiSync/`    | 退出码 0                                                                                                              |
| `npm run db:validate`                                | `NikkiSync/`    | 见 §11.2 输出原文                                                                                                     |
| `npm run typecheck`                                  | `WXNN XiangCe/` | 退出码 2，2 错（§9 R13）                                                                                              |
| `npm run lint`                                       | `WXNN XiangCe/` | 1 error + 11 warnings（归因见 §11.3）                                                                                 |
| `npm run test:main`                                  | `WXNN XiangCe/` | 5 files / 17 tests 失败，全部落在 WIP 文件（§11.3）                                                                   |
| `node --test docs/sync-integration/verify-audit.mjs` | `WXNN XiangCe/` | **9 tests / 9 pass / 0 fail**（新增两份文档未破坏既有阶段 0 校验）                                                    |
| `electron --version`                                 | `WXNN XiangCe/` | `v41.10.6`                                                                                                            |
| 探针 P1/P2/P4                                        | `NikkiSync/`    | 见 §11.1                                                                                                              |
| 探针 P3                                              | `NikkiSync/`    | 见 §11.1（监听 9121、secure=true、STOP-OK）                                                                           |

### 11.5 路径核验

§12 列出的每条路径均用 `Test-Path` / 目录清单交叉核对。两个有意记为“不存在”的结论：`NikkiSync/.gitattributes` = **False**（支撑 R11）；XiangCe 侧 `node_modules/@nikkisync/*` = **不存在**（支撑 §4.3 第 3 条与 R1）。

---

## 12. 本报告引用的文件路径清单（已全部核实存在）

下列清单以目录分组简写（`{a,b,c}` = 同一目录下三个文件）。每一条均经 `Read` / `Glob` / `Get-ChildItem` / `Test-Path` 实际访问确认存在；两个**故意的“不存在”**结论（`NikkiSync/.gitattributes`、XiangCe 侧 `node_modules/@nikkisync/*`）已在 §11.5 与 R11/R1 分别标明。

**NikkiSync**：`package.json`、`apps/pc-companion/package.json`、`apps/pc-companion/tsconfig.json`、`scripts/build-wechat-runtime.mjs`、`apps/pc-companion/src/{runtime,index,dev-server,windows-app,qr,RuntimeMemoryMaintenance,game-directory-discovery,WindowsInstallationHints}.ts`、`scanner/{index,types,ScannerService,ScannerDiscovery,ScanCoordinator,ScanReconciler,ResourceClassifier,FileStabilityGuard,ScannerWatcher}.ts`、`server/{index,LocalSyncServer,AuthService,PairingService,WebSocketHub,MdnsAdvertiser,LocalTlsIdentityService,row-mappers,SuitSearchIndex,ClothingSearchIndex,ProfileStatsIndex,GameVersionCalendar}.ts`、`metadata/{types,MetadataResolverPipeline,MetadataResolverService,MetadataResolverConfigFile,MetadataStartupComposition,Nuan5CompatibleResolver,RemoteJsonMetadataResolver,MetadataDictionaryService,MetadataDictionaryUpdateService,MetadataDictionaryProvider,MetadataDictionaryConfigFile,MetadataDictionaryRemoteConfigFile,NikkiAlbumsMetadataDictionaryProvider,NikkiGalleryMetadataDictionaryProvider,RemoteJsonMetadataDictionaryProvider,MetadataThumbnailCache,VerifiedClothingNames}.ts`、`remote/{RemoteBridgeService,RemoteFileProvider,RemoteSessionStore,RemoteRoutes,RemoteConnection}.ts`、`desktop/{DesktopControlServer,DesktopStatusService,DesktopPage,DesktopPageScript,DesktopIcons,AppDataDirectory,RemoteBridgePanel,WeChatGalleryPanel,StartupFailure}.ts`、`wechat/{WeChatGalleryService,WeChatIconProvider,GalleryRuntime.mjs,GalleryRuntime.d.mts}`、`packages/{core,protocol,database}/package.json`、`packages/core/src/{types,resolver,path-key,metadata-dictionary}.ts`、`packages/database/{migrations/0001_initial.sql,scripts/validate-schema.mjs}`、`packages/database/src/{index,database-manager,asset-repository,resource-repository,change-journal-repository,pairing-repository,resolver-candidate-repository,app-settings-repository,metadata-dictionary-repository,sync-read-repository,models}.ts`、`packages/protocol/src/index.ts`、`apps/pc-companion/test/local-sync-server.test.ts`、`tools/wechat-crypto-spike/package.json`、`node_modules/@nikkisync/{core,database,pc-companion,protocol}`。

**WXNN XiangCe**：`package.json`、`electron.vite.config.ts`、`AGENTS.md`、`docs/sync-integration/{00-code-audit-plan.md,00-code-audit-report.md,verify-audit.mjs,00-audit-plan.md}`、`src/main/sync/`、`src/shared/sync/`、`src/main/database/`（`sync-read-repository.ts`、`sync-row-mappers.ts`、`connection.ts`）、`src/main/scanner/`、`src/main/services/share-wifi-service.ts`、`src/main/utils/file-utils.ts`、`node_modules/electron/package.json`、`node_modules/electron/dist/electron.exe`、`node_modules/qrcode`。
