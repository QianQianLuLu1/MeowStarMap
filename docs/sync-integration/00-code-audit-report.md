# 代码探查报告（阶段 0 · 00-code-audit-report）

> 生成日期：2026-10-11
> 范围：`WXNN XiangCe/`（NikkiGallery / wxnn-photo-manager v2.5.3）与 `NikkiSync/`（v0.0.1-m0）
> 验证方式：本报告全部论断经 `WXNN XiangCe/docs/sync-integration/verify-audit.mjs`（node:test，9 个断言测试）程序化校验；文中所有文件路径均已在报告中引用时刻确认真实存在。
> 唯一真相源：工作区根 `00-code-audit-report.md`（工作区根目录不是 git 仓库，故本文件为入 git 跟踪的副本；更新时两处同步）。

---

## 执行摘要（验收关键结论）

1. **WXNN XiangCe 的 Electron 内置 Node 版本 = 24.18.0，≥ 24，满足 NikkiSync 的 Node ≥ 24 要求。** 实测方式：`ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe -e "console.log(process.versions.node)"` → `24.18.0`（Electron 实装 41.10.6，与 package.json 声明一致）。
2. **WXNN XiangCe 的 media_files 表不包含 sha256 字段。** 建表语句（`src/main/database/connection.ts` L1079-1101）共 19 个基础列，无任何 hash/checksum 列；仅有感知哈希列 `phash TEXT`（经 `safeEnsureColumn` 增量添加，L1662，用于相似图片查找，非内容完整性哈希）。sha256 目前只在运行时计算不落库（见 §5）。
3. **`node:sqlite`（NikkiSync 的 SQLite 驱动）在 WXNN XiangCe 的 Electron 运行时内实测可用**：`ELECTRON_RUN_AS_NODE=1` 下 `require('node:sqlite')` 成功，`DatabaseSync` 建表、参数绑定插入、查询全部通过。NikkiSync 的 `packages/database` 可原样运行于 WXNN 主进程，无需更换驱动。
4. 两个项目依赖均已安装成功（NikkiSync 新装 75 包、WXNN 幂等确认，均退出码 0）。

---

## 1. 运行时与工具链

### WXNN XiangCe（`WXNN XiangCe/package.json`）

| 项        | 值                                                                                                                                                        | 证据                           |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Node 要求 | engines `>=22.12.0`（L24-26）；`.node-version` = `22`；本机实跑 v26.3.0                                                                                   | package.json                   |
| Electron  | **41.10.6**（devDependencies 精确锁定，实装一致），内置 Node **24.18.0**（实测）                                                                          | package.json L171；实测输出    |
| 包管理器  | **npm**（仅 package-lock.json，无 pnpm/yarn lock；`.npmrc` 配置镜像）                                                                                     | 目录清单                       |
| 构建      | `dev`/`build` = electron-vite；`build` 额外写 `dist/main/package.json` 为 `type: commonjs`；`dist:win` = electron-builder --win                           | package.json scripts           |
| 测试      | `test` = `vitest run`（vitest **5.0.3**）；分片 `test:main` / `test:renderer` / `test:db`；e2e = `@playwright/test` **1.62.1**（`e2e:smoke`、`e2e:perf`） | package.json；vitest.config.ts |
| 类型检查  | `typecheck` = `tsc -b && tsc -p tsconfig.scripts.json`                                                                                                    | package.json L47               |
| Lint      | `lint` = `eslint .`（ESLint 9 flat config）+ prettier                                                                                                     | package.json L43               |
| 变更验证  | `npm run verify`（typecheck + eslint + core-gate + prettier + 相关单测）                                                                                  | AGENTS.md L104-142             |

### NikkiSync（`NikkiSync/package.json`）

| 项           | 值                                                                                                                                                                                | 证据                                                |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Node 要求    | engines **`>=24.0.0`**（硬要求：SQLite 驱动用内置 `node:sqlite`）                                                                                                                 | package.json L6-8                                   |
| 仓库形态     | npm workspaces：`apps/*`、`packages/*`、`tools/*`；TypeScript **5.9.3**；esbuild 0.28.2（仅用于 `scripts/build-wechat-runtime.mjs` 打包微信运行时）                               | package.json L9-13, L40-44                          |
| 构建         | `build` = `build:core` → `build:protocol` → `build:database` → `build:pc`（前三者各为包内 `tsc -p tsconfig.json` 产出 `dist/`；`build:pc` 先 esbuild 打包 wechat runtime 再 tsc） | package.json L23-34                                 |
| 测试         | **node:test**（`node --test --test-isolation=none`，跑 dist/ 编译产物）；`npm test` = build + 22 个测试文件                                                                       | package.json L36                                    |
| 类型检查     | `typecheck` = build 链 + pc-companion `tsc --noEmit`                                                                                                                              | package.json L35                                    |
| Windows 打包 | Bun 1.3.14 `--smol` 编单文件 exe + `apps/windows-shell`（.NET 8 WPF/WinForms 壳）                                                                                                 | `apps/pc-companion/package.json` L11；AGENTS.md L29 |
| CI           | windows-latest + Node 24：`npm ci && npm run mobile:validate && npm test`                                                                                                         | `NikkiSync/.github/workflows/ci.yml` L14-23         |

依赖安装状态：**两边均安装成功**（NikkiSync 全新 `npm install` 75 包退出码 0；esbuild postinstall 被本机 allow-scripts 策略拦截但平台二进制 `@esbuild/win32-x64` 完整、`import('esbuild')` 实测可用；WXNN 幂等安装退出码 0，node_modules 827 项）。

## 2. NikkiSync 协议层（packages/protocol）

源码仅一个文件：`NikkiSync/packages/protocol/src/index.ts`（338 行）。`PROTOCOL_VERSION = 1`（L47）。

**路由（`API_ROUTES`，L261-276，共 12 条）**：
`/v1/server`、`/v1/pair`、`/v1/assets`、`/v1/assets/:assetId`、`/v1/assets/:assetId/metadata`、`/v1/assets/:assetId/resources/:resourceId`、`/v1/assets/:assetId/clothing/:clothingId/thumbnail`、`/v1/search/suits`、`/v1/search/clothing`、`/v1/profile/stats`、`/v1/changes`、WebSocket `/ws/v1`。

**错误码（`API_ERROR_CODES`，L278-289，共 9 个）**：`bad_request`、`unauthorized`、`pairing_expired`、`pairing_invalid`、`not_found`、`revision_too_old`、`protocol_mismatch`、`resource_not_ready`、`internal_error`。错误响应体统一 `ApiErrorBody` = `{ error: { code, message, requestId? } }`（L291-297）。

**认证头（`AuthHeaders`，L254-259，共 4 个）**：`X-NikkiSync-Device-Id`、`X-NikkiSync-Timestamp`、`X-NikkiSync-Nonce`、`X-NikkiSync-Signature`。认证流程实现于 `NikkiSync/apps/pc-companion/src/server/AuthService.ts`：Ed25519 签名验证（L49-54），canonical 串 = `method\nurl\ntimestamp\nnonce\nsha256(body)`（L41-47），时间戳容差 ±5 分钟（L23、L35），nonce 内存 Map 防重放（L36-38）。设备凭据在配对时建立：`PairingService.ts` 生成一次性 token（`randomBytes(24).base64url`，默认 5 分钟过期，L50-52）→ 客户端提交 Ed25519 公钥（`PairRequest`）→ 下发 32 字节 `deviceCredential`，服务端只存 sha256（L69-77）。

**主要 DTO**：`AssetSummary`（L54-71，列表项）、`CursorPage<T>`（L73-77，base64url 游标分页 + libraryRevision）、`ServerInfoResponse`（L79-93，含 capabilities）、套装/服装搜索与个人统计系列（L95-166）、`AssetListQuery/Response`、`AssetDetailResponse`、`ChangeRecord`/`ChangesResponse`（L179-194，增量拉取，含 `fullResyncRequired`）、`WsEvent` 联合类型（L196-220：asset.created/updated/deleted、library.rescan.started/completed、server.hello）、配对三件套 `PairingQrPayload`/`PairRequest`/`PairResponse`（L222-252）。配对二维码负载为管道分隔文本 `NS1|serverId|host|port|token|expiresEpochSec|tlsFingerprint`（`buildPairingUri`，L326-329），TLS 指纹 pinning 配合 `LocalTlsIdentityService` 的自签证书。

**消息/帧格式**：REST 层为普通 JSON over HTTP(S)（时间戳 ISO-8601 UTC，motion 时间戳微秒）；无二进制帧协议；WebSocket 为服务端手写 RFC6455 实现（见 §4）。

## 3. NikkiSync 数据模型（packages/core）

源码：`NikkiSync/packages/core/src/types.ts`（148 行，核心类型）、`resolver.ts`（218 行）、`metadata-dictionary.ts`（148 行）、`path-key.ts`。常量：`METADATA_SCHEMA_VERSION = 1`、`ASSET_TYPES = ['photo','motion_photo','video','unknown']`（L9-10）、`RESOURCE_ROLES = ['source_primary','source_high_quality','source_low_quality','source_motion','derived_thumbnail','derived_preview']`（L12-20）、`ASSET_STATES = ['ready','resolving','missing','deleted']`（L22-23）。

- **NikkiAsset**（L110-126）：`schemaVersion:1`、`assetId`、`type`、`state`、`source{game:'infinity_nikki', uid?, discoveredAt, capturedAt?}`、`resources: MediaResource[]`、`motion?`、`metadata?`、`revision:number`、`deletedAt?`。
- **MediaResource**（L25-39）：`resourceId`、`role`、`fileName`、`mimeType`、`fileExt`、`sizeBytes`、**`sha256`（全部必填）**；可选 `width?`、`height?`、`durationMs?`、`modifiedAt?`、`sourcePathHint?`（注释注明仅 PC 内部/调试使用）。
- **MotionAssetInfo**（L41-52）：`stillResourceId`、`motionResourceId`、`presentationTimestampUs?`（-1 表示未知）、`sourceCodec?`、`sourceContainer?`、`resolver?{method, confidence}`。
- **InfinityPhotoMetadata**（L54-108）：`schemaVersion`；`identity{uid?, gameVersion?, sourceAssetId?}`；`capture{capturedAt?}`；`camera{focalLength?、apertureSection?、exposure?、brightness?、contrast?、saturation?、vibrance?、highlights?、shadows?、vignetteIntensity?、bloomIntensity?、bloomThreshold?、portraitMode?}`；`filter?{id?,name?,strength?}`；`lighting?{...}`；`photography?`/`nikki?`（Record 透传）；`dressing?{clothes?, eureka?}`；`interactions?`；`location?{id?,name?}`；`raw?`（无损转义仓，含 socialPhoto、cameraParams、dictionary 溯源）。
- 辅助类型：`TemplatePhotoContext`（L128-138）、`AssetResolverCandidate`（L140-147）、`MetadataDictionaryEntry`/`Manifest`（`metadata-dictionary.ts` L6-29，kind = clothing/filter/lighting/pose/location）。
- 核心服务：`AssetResolver`（`resolver.ts`）——静态图 + 动态视频按 uid + 规范化文件名分组配对，评分制（`_cover` +140、同名 +90、时间差衰减、uid 不等硬拒等，硬拒 score=-1，confidence=score/180，L106-217）；`toPathKey`（`path-key.ts`）——路径规范化为跨平台键（win32 小写）；`enrichPhotoMetadataWithDictionary` 用字典丰富元数据。

## 4. NikkiSync PC Companion 服务端（apps/pc-companion/src/server）

| 文件                                   | 职责                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LocalSyncServer.ts`（608 行）         | 核心 LAN API：`http(s).createServer`（L177-179）+ 手写 if/正则路由（`handle` L222-264）；WS upgrade（L180）；Range 解析与 206/416（L108-127）；base64url 游标；JSON body 上限；资源流式传输 `streamResource`（L509-541，stat + Range + `ETag: "sha256:<hash>"` + `X-NikkiSync-SHA256` 响应头 + `createReadStream().pipe(res)`）；change journal 轮询广播（L581-607） |
| `AuthService.ts`（67 行）              | 4 认证头校验、±5min 时间戳、nonce 防重放、Ed25519 验签（canonical 串见 §2）                                                                                                                                                                                                                                                                                          |
| `PairingService.ts`（93 行）           | 服务器身份 Ed25519 密钥生成并持久化到 app_settings（L20-41）；一次性配对 token；deviceCredential 签发（只存 sha256，L69-77）                                                                                                                                                                                                                                         |
| `LocalTlsIdentityService.ts`（130 行） | 手写 DER/X.509：RSA-2048 自签证书（CN=NikkiSync Local，SAN nikkisync.local，10 年），SHA-256 指纹持久化供 QR pinning（L75-129）                                                                                                                                                                                                                                      |
| `MdnsAdvertiser.ts`（88 行）           | **手写 mDNS**（无第三方库）：`node:dgram` udp4 组播 224.0.0.251:5353，服务 `_nikkisync._tcp.local`，PTR/SRV/TXT/A 记录，30s 周期 + 查询响应（L55-79）                                                                                                                                                                                                                |
| `WebSocketHub.ts`（85 行）             | 手写 RFC6455 服务端：握手（固定 GUID，L32）、text 帧构造（0x81 + 7/16/64 位长度前缀，L8-19）、ping/pong/close，`broadcast`/`send`                                                                                                                                                                                                                                    |
| `row-mappers.ts`（148 行）             | DB 行 → protocol DTO；`publicMetadata` 剥离 `raw.nativeParamPayload/nativeParamNuan5Md5` 再下发（L24-29）；gameVersion 显式→推断→unknown（L33-51，配合 `GameVersionCalendar.ts`）                                                                                                                                                                                    |
| 搜索/统计                              | `SuitSearchIndex.ts`、`ClothingSearchIndex.ts`、`ProfileStatsIndex.ts`                                                                                                                                                                                                                                                                                               |
| `index.ts`                             | re-export 上述全部                                                                                                                                                                                                                                                                                                                                                   |

**SQLite 依赖点**：LocalSyncServer 构造时组装 `SyncReadRepository`/`AssetRepository`/`MetadataDictionaryRepository`（`LocalSyncServer.ts` L152-157）；所有仓储统一通过 `database.connection.prepare(sql).get()/.all()/.run()` 参数绑定访问（范式见 `packages/database/src/sync-read-repository.ts` L16-19、L32-37）。驱动选择在 `packages/database/src/database-manager.ts` L14-18：**Bun 环境用 `bun:sqlite`，否则用 Node 内置 `node:sqlite`**——无任何第三方 SQLite 依赖。schema 为单迁移文件 `packages/database/migrations/0001_initial.sql`（10+ 表：`schema_migrations`、`library_state`、`assets`、`resources`（`sha256` 列 length=64，L64）、`resolver_candidates`、`change_journal`、`paired_devices`、`device_sync_state`、`pairing_sessions`、`app_settings`、`metadata_dictionary_state`、`metadata_dictionary_entries`；PRAGMA WAL + foreign_keys + busy_timeout 5000，L1-4）；`npm run db:validate` 用内存库执行整个 SQL 并做 foreign_key_check/quick_check（`packages/database/scripts/validate-schema.mjs`）。

server 之外 pc-companion 还有：`scanner/`（ScannerService 流水线：Discovery→FileStabilityGuard→ScanCoordinator→ResourceClassifier→AssetResolver→ScanReconciler→Watcher）、`metadata/`（16 个文件的元数据解析与字典服务）、`desktop/`（本机控制页，127.0.0.1 + token `timingSafeEqual`）、`remote/`（限时外链会话）、`wechat/`（Noise 加密 TCP 图库）、`qr.ts`（`qrcode` 包渲染 SVG，L167-169）、`runtime.ts`/`windows-app.ts`/`dev-server.ts`。

## 5. WXNN XiangCe 数据库层

- **驱动**：**better-sqlite3 ^12.11.1**（实装 12.11.1），惰性动态导入：`src/main/database/connection.ts` L3 类型导入、L23 `await import('better-sqlite3')`。
- **media_files 完整字段**：基础建表 19 列（connection.ts L1079-1101）——`id`(INTEGER PK AUTOINCREMENT)、`file_path`(TEXT NOT NULL **UNIQUE**)、`file_name`、`file_type`('image'|'video')、`file_ext`、`file_size`、`width`、`height`、`duration`(REAL)、`created_at`、`modified_at`、`source_path`、`thumbnail`、`tags`(TEXT DEFAULT '[]')、`category_id`、`rating`(DEFAULT 0)、`is_favorite`(DEFAULT 0)、`notes`(DEFAULT '')、`indexed_at`。此后经 `safeEnsureColumn` 增量加列（约 15 个）：`is_missing`/`missing_count`（L1652-1653）、**`phash`**（L1662）+ `phash_mtime`/`phash_file_size`（L1665-1666）、`account_uid`（L1676）、`album_type`（L1691）、`is_duplicate`/`original_id`（L1754-1755）、`media_source`（L1765）、`is_corrupted`/`corrupted_count`/`corrupted_reason`（L1780-1782）、`scene_time`（L1816）、`outfit`（L1824）、`is_deleted`/`deleted_at`（L1829-1830）、`delete_origin`（L1846）、`updated_at`（L1869）、`scene_category`（L1877）、`editor_metadata`（L1880）。
- **sha256 结论**：**无 sha256/checksum/md5 列**（建表块与全文件均确认）。最接近的是 `phash`（感知哈希，64 字符 0/1 串，相似图片查找用，非内容完整性）。运行时 sha256 计算已存在：`src/main/utils/file-utils.ts` L122 `calculateFileHash(filePath)`（**完整文件流式 sha256，64 字符 hex**，用于重复检测）；`src/main/thumbnail/generator.ts` L963 与 `src/main/media-worker/worker-entry.ts` L214 是“前 1MB sha256 取前 16 字符”的缓存键变体（不可混用）。
- **读写分离架构**：存在。SELECT 在主进程同步走 better-sqlite3；INSERT/UPDATE/DELETE 经 `DatabaseWorkerBridge` 走 utilityProcess 的 `database-worker.ts`（worker 独立开连接，PRAGMA 同主进程 + busy_timeout=5000，L88-107），仅响应写指令；未注入 bridge 时降级同步直写（connection.ts L131、L160-203）。模块级规范见 `src/main/database/AGENTS.md`（WAL 并发、Repository 模式、FakeDb 测试约定）。唯一的 readonly 连接实例是完整性门禁（L749），非常态。
- **库文件**：`%APPDATA%/wxnn-photo-manager/database/wxnn_photo_manager.db`（connection.ts L147-153）；仓库内 `data/album_index.db` 仅为开发样例。
- **迁移**：`initialize()`（L205）→ `runMigrations()`（L855，`KNOWN_MIGRATION_VERSIONS=[1,2,3]`）→ `applyMigrations()` 单事务原子迁移（L1046），迁移前 `VACUUM INTO` 备份（L889-910），损坏自恢复 `attemptRecovery()`（L473）。

## 6. WXNN XiangCe 媒体类型定义

- **MediaRow**（DB 完整行）：`src/main/database/media-repository.ts` L108-141。字段：`id, file_path, file_name, file_type:'image'|'video', file_ext, file_size, width:number|null, height:number|null, duration:number|null, created_at, modified_at, thumbnail:string|null, tags:string[], category_id:number|null, rating, is_favorite:number, notes, scene_category:string|null, scene_time, outfit, account_uid, album_type, is_deleted:number, deleted_at:string|null, is_missing:number, is_duplicate:number, original_id:number|null, media_source, is_corrupted:number, corrupted_count:number, corrupted_reason:string|null`。
- **MediaFile**（扫描 worker → 主进程协议类型）：`src/main/scanner/worker-protocol.ts` L49-81。字段：`file_path, file_name, file_type, file_ext, file_size, width?, height?, duration?, created_at, modified_at, source_path, indexed_at, scene_category, scene_time?, outfit?, account_uid, album_type, media_source:'game'|'launcher'|'cloud'|'local_screenshot', thumbnail?, editor_metadata?`（无 id/tags/rating——扫描时尚未入库）。
- **MediaFile**（渲染层 Zustand store）：`src/renderer/stores/mediaStore.ts` L21-64，以字符串 `id` 为主键，含 UI 态字段（is_favorite:boolean 等）。

## 7. WXNN XiangCe 扫描器架构

- 入口 `ScannerManager extends EventEmitter`（`src/main/scanner/index.ts` L27），薄壳经 `ScannerWorkerBridge` 转发到 utilityProcess worker；核心方法 `startScan`(L87)/`stopScan`(L119)/`scanRoot`(L128)/`setDbPath`(L144)。worker 侧核心在 `src/main/scanner/worker-entry.ts`（`startScan` L1300、`scanDirectory` L700、`saveBatchToDatabase` L1130），worker 独立开 better-sqlite3 连接。
- **完成通知机制（三层链路）**：
  1. worker → 主进程：`WorkerEvent.SCAN_COMPLETE`（`src/main/scanner/worker-protocol.ts` L94-102）；worker 崩溃时 bridge 合成失败事件（`scanner-worker-bridge.ts` L344-368）。
  2. 主进程内事件：`ScannerManager.subscribeBridgeEvents()` → `this.emit('complete', payload)`（`index.ts` **L69**；事件名 `'progress'`/`'complete'`/`'restoredComplete'`，L55）。
  3. IPC 推送到 renderer：`scanner:complete`（`src/main/ipc/handlers/scanner-handler.ts` **L107**）与 `scanner:progress`（`src/main/app/ipc-setup.ts` L60-71）。
- **钩子/事件注册点**：`ScannerManager.on('complete'|'progress'|'restoredComplete')`；扫描完成后的链式动作集中在 `runPostScanActions`（scanner-handler.ts L78-110：缩略图入队、登记 import_root、广播、`notifyMediaUpdated()`）——**同步集成（触发 NikkiSync 增量扫描）应挂接此链路**。恢复扫描经 `restoredComplete`（L113-115）。
- 扫描通道定义：`src/main/scanner/scan-channels.ts` `resolveScanChannels()`（L88）。

## 8. WXNN XiangCe IPC 组织与设置页

- **注册**：`src/main/app/ipc-setup.ts` `setupIPC(ctx)`（L82 起）按域调用 40+ 个 `registerXxxHandlers`（L86-128），域文件在 `src/main/ipc/handlers/`，各自 `ipcMain.handle('域:动作', wrapHandler(...))`。
- **校验**：入参 zod schema + 包装器在 `src/main/ipc/validator.ts`（`wrapHandler/wrapHandlerNoArgs/wrapHandlerRaw`）；handler 上下文 `src/main/ipc/handler-context.ts`。
- **命名规范**：`域:动作` 小驼峰（如 `scanner:start`、`share:startWifi`、`db:execute`），**无集中 channel 常量表**（内联字符串）；渲染端推送事件同风格（`scanner:progress`、`scanner:complete`、`media:updated`）；契约文档 `docs/IPC_CONTRACT.md`。preload 在 `src/main/preload/api/**`（受核心路径保护）。
- **设置页**：`src/renderer/pages/SettingsPage.tsx` `SETTINGS_GROUPS`（L46-195）10 个分组：general、appearance、scan、profile、data、diagnostics、about、tools、plugins（+ language 区段）；子组件在 `src/renderer/pages/settings/`（`general-sections.tsx`、`scan-sections.tsx`、`data-sections.tsx` 等 13 个文件）。**新增“设备同步”分组应在此扩展**。

## 9. 可复用工具函数

**NikkiSync 侧（纯 Node，无 Electron 耦合）**：

| 能力                                            | 位置                                                               | 适配需求                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 协议 DTO/路由/错误码/配对 URI                   | `packages/protocol/src/index.ts`                                   | 无（零依赖，直接复用）                                                             |
| 领域模型 + 资产配对评分器 + path-key            | `packages/core/src/*`                                              | 无（零依赖，直接复用）                                                             |
| SQLite schema + 仓储层（node:sqlite，参数绑定） | `packages/database/src/*`、`migrations/0001_initial.sql`           | 低——已实测在 Electron 内置 Node 24.18 可用；需注意与 better-sqlite3 并存的事务边界 |
| Ed25519 认证/配对                               | `apps/pc-companion/src/server/AuthService.ts`、`PairingService.ts` | 低——需注入仓储依赖（现在从 LocalSyncServer 构造传入）                              |
| 自签 TLS 证书（DER/X.509 手写）                 | `apps/pc-companion/src/server/LocalTlsIdentityService.ts`          | 无（纯 node:crypto）                                                               |
| mDNS 广播                                       | `apps/pc-companion/src/server/MdnsAdvertiser.ts`                   | 无（纯 node:dgram）                                                                |
| WebSocket 服务端                                | `apps/pc-companion/src/server/WebSocketHub.ts`                     | 低——需挂到宿主 http server 的 upgrade 事件                                         |
| 二维码 SVG                                      | `apps/pc-companion/src/qr.ts`（`qrSvg`）                           | 低——需把 `qrcode` 依赖加到 WXNN（NikkiSync 已有 `qrcode ^1.5.4`）                  |
| LAN API 服务（路由/Range/流式传输/游标）        | `apps/pc-companion/src/server/LocalSyncServer.ts`                  | 中——核心逻辑可整体复用，生命周期/日志/路径需适配 Electron 宿主                     |
| 文件 sha256 流式哈希                            | `apps/pc-companion/src/scanner/ResourceClassifier.ts`              | 参考实现（WXNN 已有等价 `calculateFileHash`）                                      |

**WXNN XiangCe 侧**：

| 能力                                                      | 位置                                                                                                      | 说明                                                                 |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 全文件 sha256（流式，64 hex）                             | `src/main/utils/file-utils.ts` L122 `calculateFileHash`                                                   | 同步去重/完整性比对直接可用                                          |
| LAN HTTP 服务先例（http + PIN + Range + network-address） | `src/main/services/share-wifi-service.ts`（L104 createServer）+ `src/main/ipc/handlers/share.ts`          | WiFi 分享服务模式可参照（会话管理、仅绑定局域网 IP、一次性会话超时） |
| 测试 mock 基建                                            | `tests/mocks/electron.ts`（`createElectronMock`）、`tests/mocks/sqlite/require-hook.ts`、`tests/setup.ts` | 后续阶段为同步 IPC/db 写测试直接复用                                 |
| 扫描完成事件                                              | §7 的 `'complete'` 事件与 `runPostScanActions`                                                            | 同步触发的挂接点                                                     |
| 游戏解密/分享码                                           | `src/main/services/decryption-service.ts`                                                                 | 与同步无直接关系，仅备查                                             |

## 10. 测试框架与组织

**WXNN XiangCe**：Vitest 5.0.3，`vitest.config.ts` 用 projects 分片——`jsdom` project（`src/renderer/**/*.test.tsx` + hooks）与 `node` project（`src/**` + `scripts/**/*.test.ts`），`pool:'forks'`，`setupFiles:['./tests/setup.ts']`，alias `@main`→`src/main`，coverage v8 带阈值（statements 69/branches 80）。测试与源码同目录（共 332 个 `.test.ts(x)`）；数据库子集 7 个文件（`src/main/database/**.test.ts` + `worker/` 2 个）；electron 通过 `tests/mocks/electron.ts` 组合式 mock（`vi.hoisted` + `vi.mock('electron')`，ipcMain 可收集 handle 并手动 invoke）；better-sqlite3 原生模块有 `tests/mocks/sqlite/require-hook.ts`。e2e 为 Playwright（`e2e/playwright.config.ts`）。

**NikkiSync**：node:test（`node --test --test-isolation=none`），断言 `node:assert/strict`，**顶层 `test()` 函数、无 describe/it**；测试源码在 `packages/*/test/` 与 `apps/pc-companion/test/`（19 个），但运行的是 dist 编译产物（`npm test` 先 build 再跑 22 个 dist 测试文件——**改动源码后忘记 build 会跑旧测试**）；测试内联 setup、无共享 mock 库（用对象替换，如 `local-sync-server.test.ts` L13-15 覆写仓储方法）；`local-sync-server.test.ts` 内含完整配对 + 签名请求示例（L36-40 起），可作接入方参考。

---

## 11. 可直接从 NikkiSync 复用的文件/模块清单

| #   | 模块                                                   | 复用方式                                                         | 是否需适配                                                            |
| --- | ------------------------------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1   | `packages/protocol`（整包）                            | 直接作为依赖引入/源码引入                                        | **否**                                                                |
| 2   | `packages/core`（整包）                                | 同上                                                             | **否**                                                                |
| 3   | `packages/database`（schema + 仓储 + DatabaseManager） | 原样引入，驱动 node:sqlite 已实测可跑在 Electron 内置 Node 24.18 | 低：与 WXNN better-sqlite3 并存时分开管理事务；路径注入 WXNN userData |
| 4   | `MdnsAdvertiser.ts`                                    | 原样复制/引用                                                    | **否**（纯 node:dgram）                                               |
| 5   | `LocalTlsIdentityService.ts`                           | 原样                                                             | **否**（纯 node:crypto）                                              |
| 6   | `WebSocketHub.ts`                                      | 原样                                                             | 低：挂接到宿主 server 的 upgrade                                      |
| 7   | `AuthService.ts` + `PairingService.ts`                 | 原样                                                             | 低：仓储依赖注入                                                      |
| 8   | `LocalSyncServer.ts` 路由/Range/流式传输核心           | 复用核心逻辑                                                     | 中：生命周期、日志、静态路径需接 Electron 宿主                        |
| 9   | `qr.ts`（qrSvg）                                       | 原样                                                             | 低：需在 WXNN 加 `qrcode` 依赖                                        |
| 10  | `ResourceClassifier` 的 sha256 流式哈希                | 参考（WXNN 已有 `calculateFileHash`）                            | **否**                                                                |

## 12. 需要重写或新建（适配）的模块清单及原因

| #   | 模块                                                              | 动作                                                                          | 原因                                                                                                                                       |
| --- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | WXNN 主进程同步服务（新，如 `src/main/services/sync-service.ts`） | **新建**                                                                      | 承载 NikkiSync database+server 的宿主编排；WXNN 无任何同步雏形（§9 全仓搜索确认零命中 nikkisync/companion/mdns）                           |
| 2   | WXNN IPC 域 `sync:*` handler + preload API + 共享类型             | **新建**                                                                      | 遵循 `域:动作` 规范；注意受保护路径需 `// @core-change:` 注释（AGENTS.md L44-62）                                                          |
| 3   | 设置页“设备同步”分组                                              | **新建**（`SettingsPage.tsx` SETTINGS_GROUPS + `settings/sync-sections.tsx`） | 现有 10 组无同步入口                                                                                                                       |
| 4   | media_files ↔ NikkiSync assets/resources 映射层                   | **新建**                                                                      | 两者模型差异大（§13）；WXNN 无 sha256 列，需在同步边界计算 sha256（可复用 `calculateFileHash`），是否落库为 media_files 新列待后续阶段决策 |
| 5   | 扫描完成 → 同步触发的桥接                                         | **新建**（挂 `runPostScanActions` / `ScannerManager.on('complete')`）         | NikkiSync 有自己的 ScannerService，需决定“以谁为准”的扫描策略，避免双扫描器竞争同一目录                                                    |
| 6   | NikkiSync LocalSyncServer 的生命周期/日志适配                     | **适配不重写**                                                                | 其 runtime/windows-app.ts 面向 Bun exe/独立进程；嵌入 Electron 主进程需替换宿主接口                                                        |
| 7   | renderer 实时推送桥                                               | **新建**                                                                      | NikkiSync 用 WebSocket 事件（WsEvent），WXNN renderer 用 `webContents.send`；二者需一个转换层                                              |

## 13. 两个项目的关键技术差异点

| 维度        | WXNN XiangCe                                                                        | NikkiSync                                                                         | 集成影响                                                                                                                                              |
| ----------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite 驱动 | better-sqlite3 12.11.1（原生、CJS、同步 API、需按 Electron ABI 编译）               | node:sqlite（Node 内置，`DatabaseSync`，参数绑定）                                | 同进程可并存（已实测）；但连接/事务/PRAGMA 各自独立，不能跨驱动共享连接                                                                               |
| 数据模型    | 扁平单表 `media_files`（file_path UNIQUE 主键语义 + 增量列）                        | 规范化 `assets`/`resources`/`change_journal` + revision 游标                      | 需双向映射层；NikkiSync 侧 sha256 必填而 WXNN 不落库                                                                                                  |
| 身份键      | `file_path`（UNIQUE）+ `phash` 相似去重                                             | `asset_id`（sha256 派生，`ScanReconciler.ts` L5）+ `path_key`（win32 小写规范化） | 跨库对账需 path_key ↔ file_path 规范化（复用 `toPathKey`）                                                                                            |
| 运行时      | Electron 主进程（electron-vite 产 CJS main）+ utilityProcess worker；engines ≥22.12 | 纯 ESM NodeNext，要求 Node ≥24；Windows 分发为 Bun 单文件 exe                     | Electron 内置 Node 24.18 满足；NikkiSync 包为 ESM——Electron main 构建链需确认 ESM 互操作（dist/main 声明为 commonjs，需验证 import ESM 包或调整构建） |
| 测试        | Vitest（源码同目录、mock 工厂、projects 分片）                                      | node:test（跑 dist 产物、断言内置）                                               | 各自维持；WXNN 侧新测试用 Vitest，NikkiSync 改动必须先 build 再测                                                                                     |
| 打包        | electron-builder（NSIS，`dist:win`）                                                | Bun --smol 单文件 exe + .NET 8 壳                                                 | 若同步服务随 WXNN 分发则走 electron-builder；NikkiSync 独立 exe 模式可并存                                                                            |
| git/流程    | Conventional Commits + husky + core-path 闸门 + `npm run verify`                    | AGENTS.md：改前读 GPT_HANDOFF 文档、TDD 强制、证据留痕                            | 双仓库双流程，PR 分别提交                                                                                                                             |

## 14. 潜在风险点清单

1. **ESM/CJS 互操作（高，需下一阶段首先验证）**：NikkiSync 包是 ESM（`"type":"module"`，NodeNext），WXNN 主进程构建产物声明 `type: commonjs`（`build` 脚本显式写入）。CJS 主进程 `require()` ESM 包需动态 `import()` 或把同步集成模块以 ESM chunk 构建——electron-vite 支持但需配置验证。
2. **双 SQLite 驱动并存（中）**：better-sqlite3 与 node:sqlite 同进程访问不同库文件没有技术障碍，但若两者需要访问同一个库文件（例如未来把同步状态写进 wxnn_photo_manager.db），WAL 下跨驱动并发写需谨慎；建议同步库独立文件（NikkiSync 0001_initial.sql 自带 schema_migrations，天然独立）。
3. **sha256 计算成本（中）**：NikkiSync `MediaResource.sha256` 必填；WXNN 首次接入需对全量媒体计算完整文件 sha256（`calculateFileHash` 全文件读），大库（数万张 + 视频）I/O 开销显著；应增量计算并考虑落库缓存（新增列受核心路径闸门约束）。
4. **双扫描器竞争（中）**：WXNN scanner worker 与 NikkiSync ScannerService 可能同时扫描同一游戏目录（游戏目录只读约束见双方 AGENTS.md）；应二选一为主，另一侧只消费事件。
5. **核心路径保护闸门（流程，必触发）**：后续阶段的 `src/main/ipc/handlers/**`、`src/main/services/**`、`src/main/preload/api/**`、`src/shared/errors/**` 改动都必须带 `// @core-change: <原因>` 顶部注释，否则 ESLint `local/core-path-guard` 与 `scripts/core-path-gate.ts`（pre-commit）拦截。
6. **NikkiSync 侧流程约束（流程）**：改动前必读 `docs/GPT_HANDOFF_2026-09-04.md`；先写失败测试；本阶段零源码改动故留在 main，后续任何 NikkiSync 源码改动须先 `git checkout -b`。
7. **npm allow-scripts 策略（低，环境）**：本机 npm 拦截 install scripts（esbuild/electron/better-sqlite3 等）。当前两边依赖完好（esbuild 二进制完整、WXNN node_modules 早已装好）；但**将来重装 WXNN 依赖**（含 native 模块 electron/better-sqlite3 下载）时可能需要 `npm approve-scripts`，参照 `docs/troubleshooting-npm-audit-mirror.md`。
8. **mDNS/组播与防火墙（低，部署）**：`MdnsAdvertiser` 用 224.0.0.251:5353 组播，Windows 防火墙首次会弹授权；electron-builder 打包后需在安装器/文档中声明防火墙规则。
9. **报告文件位置（记录）**：工作区根不是 git 仓库，根目录报告无法直接提交；本报告已复制到 `WXNN XiangCe/docs/sync-integration/` 入库跟踪，**根目录版为唯一真相源**，后续阶段更新时两处同步。
10. **NikkiSync 全新检出的构建顺序缺陷（中，已实测复现）**：`npm test` / `npm run typecheck` 的构建链中 `build:pc` 先跑 `scripts/build-wechat-runtime.mjs`（esbuild 打包 `tools/wechat-gallery/source.mjs`、`browse.mjs`），而这两者静态 import `apps/pc-companion/dist/src/...`（`GameVersionCalendar.js`、`RemoteFileProvider.js`、`game-directory-discovery.js`）；pc-companion 的 tsc 在其后才执行——**无 dist 的全新检出必然失败**（报 `Could not resolve`）。本阶段绕过方式：先 `npm exec --workspace @nikkisync/pc-companion -- tsc -p tsconfig.json` 产出 dist，再跑 `npm test`（实测通过）。是否调整 package.json 构建顺序属源码改动，留待后续阶段在独立分支修复并提 PR。
11. **行尾管理缺失（低，已复现并处理）**：NikkiSync 仓库无 `.gitattributes`，本机 `core.autocrlf=true`。阶段期间发现 `tools/sample-analyzer/analyze.mjs` 出现幻影 M 状态——工作区副本被改为混合行尾（454 个 CRLF 行）而 HEAD 为纯 LF，经字节级比对确认**内容完全一致、仅行尾差异**后用 `git checkout --` 恢复，git 状态回到基线。建议后续阶段在 NikkiSync 仓库加 `.gitattributes`（`* text=auto eol=lf`）一劳永逸（属源码改动，需独立分支提 PR）。
12. **既有基线（记录）**：WXNN 工作区存在大量历史日志/临时文件（sb-*.log、vitest-run.log 等）与 `wxnn-photo-manager/` 嵌套目录，属仓库噪声，未影响本次探查，不在本阶段清理范围（最小化改动纪律）。

---

## 附：验证记录（阶段收尾实测数据）

**红灯 → 绿灯（`node --test docs/sync-integration/verify-audit.mjs`，WXNN XiangCe 根目录执行）**

- 红灯：9 测试中 1 失败——T6 报告缺失（报告未写时的预期失败），其余 8 项事实断言通过。
- 绿灯：报告写入后重跑 → **9/9 通过**（lint 修复后复跑仍 9/9）。

**回归门禁**

| 门禁                                         | 结果                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| WXNN `npm test`（vitest 全量）               | **338 个测试文件 / 5356 个测试全部通过**                                                                                                          |
| WXNN `npm run typecheck`（tsc -b + scripts） | 通过（退出码 0）                                                                                                                                  |
| WXNN `npm run lint`（eslint .）              | **0 error**；11 个 warning 全部为存量问题（`src/renderer/components/common/*.test.tsx` 的 BOM 警告，本阶段未触碰这些文件，git status 确认无改动） |
| NikkiSync `npm test`（build + node --test）  | **131/131 通过**（退出码 0；前置：先单独编译 pc-companion，见风险 10）                                                                            |
| NikkiSync `npm run typecheck`                | 通过（退出码 0）                                                                                                                                  |
| NikkiSync `npm run db:validate`              | schema OK，foreign_key_check ok，quick_check ok（12 表）                                                                                          |

**关键实测**

- `ELECTRON_RUN_AS_NODE=1 electron.exe -e "console.log(process.versions.node)"` → `24.18.0`。
- Electron 运行时内 `require('node:sqlite')` → DatabaseSync 建表/参数绑定插入/查询全部通过。
- NikkiSync `npm install` 新装 75 包（退出码 0）；WXNN `npm install` 幂等（退出码 0）。
- 本阶段 lint 红灯→绿灯：verify-audit.mjs 初版有 2 个 error（`process` 未定义）+ 1 个 BOM 警告，修复（`import process from 'node:process'` + 去 BOM）后 0 error。
