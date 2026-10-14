# 阶段 3：启用 NikkiSync 自带 LocalSyncServer 计划（03-sync-server-plan）

> 生成日期：2026-10-14
> 范围：在已内嵌的 `PcCompanionRuntime` 之上，**直接启用 NikkiSync 自带的 LocalSyncServer**
> （HTTPS + Ed25519 鉴权 + 一次性配对 + WebSocket 事件 + mDNS 广播 + 自签 TLS 身份），
> 并在 WXNN XiangCe 侧新增服务启停控制、配对二维码与已配对设备管理。
> 唯一真相源：本文件。上游依据见
> [`00-nikkisync-pc-audit-report.md`](./00-nikkisync-pc-audit-report.md)（阶段 0+ 盘点）、
> [`01-dependency-link-plan.md`](./01-dependency-link-plan.md)（阶段 1 装载缝）与
> [`02-runtime-embed-plan.md`](./02-runtime-embed-plan.md)（阶段 2 内嵌 Runtime）。
> 铁律：**不重写网络层、不改 NikkiSync 源码、不新造协议 DTO、不假设端口/防火墙/上游 API。**

---

## 0. 步骤 0 执行记录（代码同步，已完成）

| 动作                 | 结果                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 探查定位             | `<nikkisync-path>` = `D:\Zcode项目\WXNN YD - 副本\NikkiSync`（项目根的**兄弟目录**，独立 git 仓库）。引入方式：`package.json` **不声明** `@nikkisync/*`（阶段 9 自包含决策），由 `npm run link:nikkisync` 在候选根 `NIKKISYNC_ROOT` → `../NikkiSync` → `vendor/NikkiSync` 中解析并以 **Windows junction** 挂到 `WXNN XiangCe/node_modules/@nikkisync/{core,database,protocol,pc-companion}`；消费的是编译后的 `dist/src/index.js`，**不是 TS 源码** |
| 确认远程             | `git remote -v` = `https://github.com/ToStardust/NikkiSync`（fetch/push 一致）✓                                                                                                                                                                                                                                                                                                                                                                     |
| 连通性               | `git ls-remote origin refs/heads/main` **首次超时失败**（`Failed to connect to github.com:443`），重试成功 ⇒ 本机 GitHub 连通性**分层且不稳**：判据只用 `git`，不得用 `curl` 结论下判断                                                                                                                                                                                                                                                             |
| 拉取最新             | `git fetch origin`（exit 0，无新对象）→ `git checkout main`（`Already on 'main'`）→ `git pull origin main`（`Already up to date.`）                                                                                                                                                                                                                                                                                                                 |
| 版本核验             | `HEAD == refs/remotes/origin/main == d4ca7d7a164d44ca91dcc3e7e7604b9839296ad3`（2026-10-13 `fix(android): save motion photos as rotated videos or LIVE`）；`git rev-list --left-right --count origin/main...HEAD` = `0 0` ⇒ 与 GitHub 最新一致，本次同步为 **no-op**；`git log --oneline -5` 已留证（`d4ca7d7 / 58f2ca8 / 131f301 / 467b590 / 85851c1`）                                                                                            |
| 本地改动处理         | 仅 `tools/sample-analyzer/analyze.mjs` 显示 `M`，`git diff --numstat` **为空** = 上游无 `.gitattributes` + 本机 `core.autocrlf=true` 的行尾幻影（阶段 2 风险 **R11**）。**不 stash、不提交、不改**（`git status --porcelain` 前后一致）                                                                                                                                                                                                             |
| **新发现的環境損壞** | `NikkiSync/node_modules/@nikkisync/*` 六个 workspace 链接同样被破坏成**空真实目录** ⇒ `npm run build:protocol` 报 `TS2307: Cannot find module '@nikkisync/core'`。修复：在 NikkiSync 根 `npm install`（`changed 6 packages in 233ms`，只动 `node_modules`，不触被跟踪文件），链接恢复为 `SYMLINK`                                                                                                                                                   |
| 构建                 | `npm run build` **一次通过**（R10 未复现，因 `dist/` 已存在）。产物核验：`apps/pc-companion/dist/src/server/LocalSyncServer.js` ✓、`dist/src/wechat/GalleryRuntime.mjs` ✓（`LocalSyncServer.ts:7` 静态依赖它，缺则整条链加载不了）、`packages/database/migrations/0001_initial.sql` ✓                                                                                                                                                               |
| 上游门禁             | `npm test` → **136 tests / 136 pass / 0 fail**；`npm run typecheck` → exit 0；`npm run db:validate` → `schema OK`（13 对象，`foreign_key_check: ok`、`quick_check: ok`）                                                                                                                                                                                                                                                                            |
| 建链（XiangCe 侧）   | 四个 junction 已被此前的 `npm install` 剪成空目录（`require.resolve` → MODULE_NOT_FOUND，`verify:nikkisync` 3 项 ✗）⇒ 重跑 `npm run link:nikkisync`（4 × `replace`）→ `link:nikkisync:check` **all four links in place**                                                                                                                                                                                                                            |
| 装载面诊断           | `npm run verify:nikkisync` → **8 项中 7 ✓ / 1 ✗**；唯一 ✗ 是「packed `app.asar.unpacked` 含 migrations」，判据打在 **2.5.5 旧 `release/win-unpacked`**（早于建链）上，属阶段 2 §10.4 遗留项 1，**非本阶段引入**；本阶段不重跑 `dist:win`（需可行网络/证书环境），仅登记                                                                                                                                                                             |
| API 核对             | 见 §11，逐条以 `d4ca7d7` 源码实测；与阶段 0+/阶段 2 记录**无破坏性变更**，但**修正两处**（见 §11 末）                                                                                                                                                                                                                                                                                                                                               |

> 本节结论：**代码同步已完成且为 no-op**，`<nikkisync-path>` 的引用、import、API 调用一律以 `d4ca7d7` 为准。

## 1. 依赖声明（不新增声明依赖）

| 项             | 口径                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `package.json` | **不新增** `@nikkisync/*` 依赖，**不新增任何第三方网络依赖**（上游 `WebSocketHub` 手写 RFC6455、`MdnsAdvertiser` 纯 `node:dgram`、`LocalTlsIdentityService` 纯 `node:crypto` + 手写 ASN.1，均无外部包）；QR 渲染复用已有 `qrcode` 依赖                                                                                                                                                                                                                             |
| 运行前置       | ① NikkiSync 检出于三个候选根之一；② 上游已 `npm run build`；③ `npm run link:nikkisync` 建链。**`npm install` 会剪掉 junction**（本阶段已实测复现两轮：XiangCe 侧与 NikkiSync 自身 workspace 侧），装完依赖必须重跑 link                                                                                                                                                                                                                                            |
| 装载方式       | 一律 `await loadNikkiSyncPackage(...)`（变量式 `await import()`）；不在桶导出内的深入口用 `resolveDeepEntryUrl` + `file://` URL。**禁止**字面量 `@nikkisync/...` 静态导入（`eslint.config.js` 两层护栏：`no-restricted-imports` + `no-restricted-syntax`）                                                                                                                                                                                                         |
| 桶导出事实     | `@nikkisync/pc-companion` 根 barrel 导出 `runtime` / `server/index`（六件套齐备：`LocalSyncServer`、`AuthService`、`PairingService`、`WebSocketHub`、`MdnsAdvertiser`、`LocalTlsIdentityService`）/ `scanner/index` / `metadata/MetadataResolverPipeline` / `metadata/types` / `game-directory-discovery` + `createPcCompanionContext`。**`MetadataThumbnailCache` 不在桶内**，实际深入口为 `dist/src/metadata/MetadataThumbnailCache.js`（**不在 `server/` 下**） |
| 类型           | 本仓自定义结构面类型（`runtime-types.ts`），**不 `import type` 上游包**（阶段 9 自包含决策，CI 未建链时 `import type` 会退化为 TS2307）                                                                                                                                                                                                                                                                                                                            |
| 打包           | 沿用 `build.files: node_modules/@nikkisync/**/*` + `asarUnpack: **/@nikkisync/**`；本阶段补产物断言（§6 #20）                                                                                                                                                                                                                                                                                                                                                      |

## 2. 服务启停方案

**核心事实（决定了本阶段的改动量）**：`PcCompanionRuntime` 构造函数**已经**组装好一台带 TLS 的服务器 ——
`runtime.ts:84-89` 在未显式传 `tls` 时自动 `new LocalTlsIdentityService(database).getOrCreate()` 并以
`{key,cert}` 构造 `new LocalSyncServer(database, {...serverConfig, tls})`。所以本阶段**不新建任何服务对象**，
只做「构造期把 LAN 配置传进去」+「运行期按开关调 `start()/stop()`」。

| 子项         | 方案                                                                                                                                                                                                                                                                                                                                                                  | 涉及文件                                | 客观验收                                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 构造期配置   | `createRuntimeSession()` 把会话选项里的 `syncServer: {host, port, mdns, name, journalPollMs}` 逐字传给 `PcCompanionRuntime` 的 `server` 字段；替换现存的常量 `EMBEDDED_SERVER_CONFIG`（`host:'127.0.0.1', port:0, mdns:false`）                                                                                                                                       | `src/main/nikkisync/runtime-facade.ts`  | 未调 `start()` 时：`netstat` 无监听端口、无 5353 组播（构造无网络副作用：`listen` 与 `mdns.start` 都只在 `LocalSyncServer.start()` 内发生） |
| 启动         | `startSyncServer()` → `session.server.start()`，返回上游 `{host, port, secure}` 原样存入 `state.syncAddress`                                                                                                                                                                                                                                                          | `src/main/nikkisync/runtime-manager.ts` | `nikkisync:server-status.running === true` 且 `port` 为配置值；`https GET /v1/server` 200                                                   |
| 幂等         | 依赖上游语义：`start()` 内 `if (this.server) return this.address!`（`LocalSyncServer.ts:175`），重复调用返回同一地址；本地不另设「是否在听」判断，只用 `state.syncAddress` 供状态展示                                                                                                                                                                                 | 同上                                    | 连续两次 `start-server` 不产生两个监听、端口不变                                                                                            |
| 停止         | `stopSyncServer()` → `session.server.stop()`；上游 `stop()` 清 poll timer → `mdns.stop()` → `sockets.close()` → `server.close()` 并置空 `server`/`address` ⇒ **可重启**（`LocalSyncServer.ts:193-201`）                                                                                                                                                               | 同上                                    | 停止后端口拒绝连接；再次 `start-server` 回到同一端口（验收项「服务可正常停止和重启」）                                                      |
| 停止顺序     | `teardown()` 改为 `server.stop()` → `scanner.stop()` → `dispose()`，各步 `withTimeout(3000)` 兜底                                                                                                                                                                                                                                                                     | `runtime-manager.ts`                    | 端口在 `database.close()` 之前释放；退出链不因上游卡死而挂                                                                                  |
| 惰性启动     | `startSyncServer()` 在无会话时先 `await start(defaults)`（沿用 `scan()` 既有惰性模式）；`degraded`（没装游戏/发现失败）**允许**起服务（库已建、内容为空），不把 scanner 当硬前置                                                                                                                                                                                      | `runtime-manager.ts`                    | 无游戏目录时服务仍可启动，`/v1/assets` 返回空页而非失败                                                                                     |
| 换端口       | `LocalSyncServerConfig` 冻结在构造期 ⇒ 端口/mdns 变更走既有 `teardown()` + `start()` 重建会话（与阶段 2「换根重建」同一路径，不新增机制）                                                                                                                                                                                                                             | `runtime-manager.ts`                    | 改端口后重开，新端口生效；SQLite 重新 `initialize()` 幂等（全 `CREATE ... IF NOT EXISTS`）                                                  |
| 生命周期挂载 | **不新增钩子**：沿用 `app/lifecycle.ts:344-350` 的 `initNikkiSyncRuntime(ctx)`（按设置自启）与 `app/cleanup.ts:123-128` 的 `stopNikkiSyncRuntime(ctx)`                                                                                                                                                                                                                | 无改动                                  | `before-quit` 后端口释放、`-wal` checkpoint（e2e 断言）                                                                                     |
| 移植面接管   | `src/main/sync/`（自有 HTTPS+Ed25519 实现，27124，数据源是 App 自己的 `media_files`）与真实服务**是两个服务、两份数据、两个二维码入口**。决策：**真实服务接管现有设置节**；`app/sync-server-setup.ts` 的组装**必须保留**（`ctx.syncEvents` 仍被 App 自有写路径依赖，删了会断写路径），仅把自启判定改为常量关闭并加中文注释说明接管关系；`sync:*` 六条通道原样保留兼容 | `src/main/app/sync-server-setup.ts`     | 启动应用后：27124 不再自动监听；28080 在用户开启后监听；设置页只有一条同步服务入口，其数据来自 NikkiSync 库                                 |

## 3. 端口配置

| 项         | 值                                                                                                                     | 依据（禁假设，逐条给出处）                                                                                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 默认端口   | **`28080`**                                                                                                            | 上游桌面版 `apps/pc-companion/src/windows-app.ts:128` = `Number(process.env.NIKKISYNC_PORT ?? 28080)`；**不用** `LocalSyncServer` 自身默认 `0`（ephemeral），因为配对二维码与防火墙规则需要稳定端口 |
| 用户可覆盖 | 设置项 `nikkisync.syncServerPort`（1–65535 整数；非法值回落默认并记日志）                                              | 与移植面 `sync.serverPort` 同型                                                                                                                                                                     |
| bind       | `0.0.0.0`                                                                                                              | 上游桌面版默认（`windows-app.ts:127`）；局域网可达与 mDNS 是需求前提。注意 `address.host` 回显的是**配置值**而非可路由 LAN IP                                                                       |
| 冲突处理   | **不重试**：`EADDRINUSE` 原样冒泡 → 状态标记 `PORT_IN_USE`                                                             | 上游 `start()` 对 listen error 直接 reject，无重试/无回退；分类判据 `description.includes('EADDRINUSE') ? 'PORT_IN_USE'` 逐字取自 `apps/pc-companion/src/desktop/StartupFailure.ts:8`               |
| 配对 host  | `resolveLanHost()`：默认路由优先 + 虚拟网卡名过滤 + `127.0.0.1` 兜底                                                   | **复用** `src/main/app/sync-server-setup.ts:243-261`（本阶段导出该函数，**不复制第二份**）。上游 `windows-app.ts:65` 的 `preferredLanIpv4()` 是文件私有、不可复用                                   |
| mDNS       | 设置项 `nikkisync.syncMdnsEnabled`，**本仓默认 `false`**（有意偏离上游默认）                                           | 上游 `windows-app.ts:129` 的口径是 `NIKKISYNC_MDNS !== '0'`（即默认开）。本仓实测 `MdnsAdvertiser` 有组播自激回环（§15），因此默认关；手机侧不依赖它——`NS1\|` 第 3/4 段已直接携带 `host:port`       |
| 自启       | 设置项 `nikkisync.syncServerEnabled`，**默认 `false`**（fail-closed）；UI 开启时一并写 `nikkisync.runtimeEnabled=true` | 绑 `0.0.0.0` 会把游戏照片库暴露到局域网，必须用户显式授权；与移植面 `SYNC_SERVER_ENABLED_DEFAULT = false` 一致                                                                                      |

三个新 key 必须加入 `src/shared/settings-keys.ts` 的 `RENDERER_PREF_KEYS`（渲染层需经 `settings:set` 写）。

## 4. TLS 证书存储位置

- **实测上游行为**：`LocalTlsIdentityService`（`apps/pc-companion/src/server/LocalTlsIdentityService.ts:117-129`）**不落盘**——把 `{keyPem, certPem, fingerprintSha256, createdAt}` 以 JSON 写入 SQLite 的 `app_settings['server.tlsIdentity']`；`getOrCreate()` 无目录参数、无路径注入点。Ed25519 服务身份同库存于 `app_settings['server.identity']`（`PairingService.ts:40-41`）。上游全仓**不存在** `certs/` 目录概念。
- **本阶段决策**（用户选定「遵循上游」）：**不改上游、不新增 certs 目录、不留明文私钥副本**。证书随库文件落在
  `{app.getPath('userData')}/nikkisync/nikkisync.db`
  （阶段 2 §3 已定：不用上游默认 `%LOCALAPPDATA%/NikkiSync`），满足「证书在 WXNN XiangCe userData 目录下」的原始要求。
- **TLS 指纹查询接口**：`GET` 语义经 `nikkisync:server-status.tlsFingerprintSha256` 提供，值取
  `new LocalTlsIdentityService(runtime.database).getOrCreate().fingerprintSha256`（64 位小写 hex，上游已剥冒号并转小写）。
  配对内容里的指纹由 `createPairingPayload()` 从 `config.tls.cert` 独立重算（`LocalSyncServer.ts:104-106`），二者同公式 ⇒ **不自造指纹逻辑**。
- 上游已知缺陷（登记，不改）：RSA-2048 私钥明文存于 SQLite，`docs/M1_1_LOCAL_SYNC_SERVER.md:77` 自标 P1（DPAPI 未做）。
- 客户端信任口径（写进文档以免误用）：证书自签、SAN 只有 `nikkisync.local` ⇒ 客户端必须 `servername: 'nikkisync.local'` + **pin 住二维码里的 SHA-256 指纹**，不得全局信任自签证书（`docs/M1_1:75`、`docs/INTEGRATION.md:18`）。

## 5. 配对 UI 方案

| 项         | 方案                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 二维码内容 | `session.runtime.createPairingUri(lanHost)`（`runtime.ts:116-119`）→ 内部 `buildPairingUri(server.createPairingPayload(host, ttlMs))`；产出 **`NS1\|serverId\|host\|port\|token\|expiresEpochSeconds\|tlsFingerprintSha256`**（`packages/protocol/src/index.ts:326-329`，7 段竖线，**不是 URL scheme**）。上游 `docs/M2_0` 仍写 `nikki-sync://pair?...` 为**过时文档**，Android 侧 `PairQrScannerActivity.java:91` 两种前缀都收 ⇒ 以 `NS1\|` 为准 |
| Token 语义 | `PairingService` 生成 `randomBytes(24).base64url`，**默认 TTL 5 分钟**、**只存 SHA-256**、`consumeSession` 在 `BEGIN IMMEDIATE` 内单次消费 ⇒ 二次使用 `401 pairing_invalid`、过期 `410 pairing_expired`。TTL 由上游生成，**不手搓过期时间**                                                                                                                                                                                                       |
| UI 落点    | **复用**现有设置节 `src/renderer/pages/settings/sync-sections.tsx`（`SETTINGS_GROUPS` 里的 `sync` 组已注册：开关 + 状态卡 + 二维码按钮 + 设备列表 + 撤销确认）与弹窗 `src/renderer/components/sync/PairingQrDialog.tsx`；**只改调用点**（`api.sync.*` → `api.nikkisync.*`），不新增页面、不新增组件、不新增弹窗                                                                                                                                   |
| i18n       | 全部沿用既有 `settings.sync.*` key ⇒ **零新增文案**，`npm run i18n:check` / `i18n:guard` 不受影响（12 个 locale 文件无需动）                                                                                                                                                                                                                                                                                                                      |
| 设备列表   | 上游 `PairingRepository`（`packages/database/src/pairing-repository.ts`）**有 `revoke()` / `getDevice()` / `countActiveDevices()`，但没有任何 list 方法**（全仓 grep 无 `listDevices`）⇒ 列表经 `runtime.database.connection.prepare()` 对 `paired_devices` 做**只读 SELECT**（`WHERE revoked_at IS NULL`），与本仓既有先例同型（`runtime-facade.ts:138-143` 读 `sqlite_master`）。撤销走上游 `revoke(deviceId)`，**不写裸 UPDATE**               |
| 敏感列     | 列表出参不含 `public_key` / `credential_hash`，形状复用共享类型 `SyncDeviceInfo`（`snake_case → camelCase` 仅用于管理视图，**协议 DTO 一律零转换**，沿用阶段 2 铁律 2）                                                                                                                                                                                                                                                                           |

## 6. 需修改 / 新增文件（完整路径，均在 `WXNN XiangCe/` 下）

| #   | 路径                                                                                                 | 动作 | 内容                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `docs/sync-integration/03-sync-server-plan.md`                                                       | 新增 | 本文件（先写后码）                                                                                                                                                                                 |
| 2   | `src/main/nikkisync/sync-server-view.ts`                                                             | 新增 | 纯函数：`embeddedServerConfig()` / `normalizeSyncPort()` / `isPortInUseError()` / `mapPairedDeviceRow()` / `buildSyncStatusSnapshot()`                                                             |
| 3   | `src/main/nikkisync/sync-server-view.test.ts`                                                        | 新增 | 上述纯函数 正常/异常/边界（端口 `0`、`65536`、`NaN`、非对象行、`revoked_at` 非空）                                                                                                                 |
| 4   | `src/main/nikkisync/runtime-types.ts`                                                                | 修改 | `LocalSyncServerLike`；`EmbeddedRuntimeLike` 加 `server` + `createPairingUri`；`NikkiSyncSessionOptions` 加 `syncServer`；`NikkiSyncRuntimeStatus` 加 `sync`；`NikkiSyncRuntimeHandle` 加 6 个方法 |
| 5   | `src/main/nikkisync/runtime-facade.ts`                                                               | 修改 | 会话传 `server` 配置（取代常量 `EMBEDDED_SERVER_CONFIG`）；装载面补 `LocalTlsIdentityService`（桶内）与 `PairingRepository`（database 桶内）；`pairedDevices()` 只读 SELECT；`tlsFingerprint()`    |
| 6   | `src/main/nikkisync/runtime-manager.ts`                                                              | 修改 | `startSyncServer` / `stopSyncServer` / `syncStatus` / `createPairingUri` / `listPairedDevices` / `revokeDevice`；teardown 顺序插 `server.stop`；`syncAddress` + `PORT_IN_USE` 分类；换端口重建会话 |
| 7   | `src/main/nikkisync/runtime-manager.test.ts`                                                         | 修改 | 假会话注入（不依赖链接）：幂等、未组装 precondition、`EADDRINUSE → PORT_IN_USE` 不外抛、换端口重建、teardown 三步顺序                                                                              |
| 8   | `src/main/nikkisync/sync-server.linked.test.ts`                                                      | 新增 | **TDD 红灯主战场**：链接门控 + 真起 TLS 服务逐端点断言（§10）                                                                                                                                      |
| 9   | `src/main/app/nikkisync-runtime-setup.ts`                                                            | 修改 | 读 3 个新设置项与默认、`syncServer` 选项下传、按 `syncServerEnabled` 自启、注入 `resolveLanHost`                                                                                                   |
| 10  | `src/main/app/nikkisync-runtime-setup.test.ts`                                                       | 修改 | 设置→选项映射、默认关闭、fail-open 不外抛                                                                                                                                                          |
| 11  | `src/main/app/sync-server-setup.ts`                                                                  | 修改 | 导出 `resolveLanHost()`；移植面自启改为常量关闭并注释接管关系                                                                                                                                      |
| 12  | `src/main/ipc/handlers/nikkisync-handler.ts`                                                         | 修改 | 6 条新通道（zod + `wrapHandler*`）；受保护路径 ⇒ 顶部加 `// @core-change: 阶段3 启用 NikkiSync LocalSyncServer，新增服务启停与配对通道`                                                            |
| 13  | `src/main/ipc/handlers/nikkisync-handler.test.ts`                                                    | 修改 | 每通道：成功 / 未组装 `preconditionFailed` / 参数非法 `validation` / 撤销不存在 `notFound`                                                                                                         |
| 14  | `src/main/preload/api/nikkisync.ts`                                                                  | 修改 | 6 个一行式 `call<T>()` 方法；受保护路径 ⇒ `@core-change` 注释                                                                                                                                      |
| 15  | `src/shared/types/electron-api.ts` + `src/renderer/vite-env.d.ts`                                    | 修改 | `NikkiSyncServerStatusInfo`；复用 `PairingQrInfo` / `SyncDeviceInfo`；四处同步口径（`electron-api`、`vite-env.d`、handler 头、e2e）                                                                |
| 16  | `src/renderer/pages/settings/sync-sections.tsx` + `src/renderer/components/sync/PairingQrDialog.tsx` | 修改 | 调用点改到 `window.electronAPI.nikkisync.*`                                                                                                                                                        |
| 17  | `src/shared/settings-keys.ts`                                                                        | 修改 | `RENDERER_PREF_KEYS` 增 3 key                                                                                                                                                                      |
| 18  | `docs/IPC_CONTRACT.md`                                                                               | 修改 | 补本阶段 6 条通道（阶段 1/2 欠下的同步义务本次补齐）                                                                                                                                               |
| 19  | `src/main/nikkisync/AGENTS.md`                                                                       | 修改 | 硬性约定 3「内嵌运行面**永不 `server.start()`**」改写为本阶段边界（运行面可启 LAN 服务；**探针仍禁启**）                                                                                           |
| 20  | `scripts/pre-dist-check.ts` + `scripts/verify-nikkisync-link.ts`                                     | 修改 | 产物断言补 `pc-companion/dist/src/server/LocalSyncServer.js` 与 `dist/src/wechat/GalleryRuntime.mjs`（缺任一，打包态服务加载必挂）+ 相应 `__tests__`                                               |
| 21  | `e2e/nikkisync-runtime.e2e.ts`                                                                       | 修改 | 真 app 会话：开启服务 → 端口在听 → `before-quit` 后端口释放                                                                                                                                        |

`electron.vite.config.ts` **不改**（`nikkisync-runtime` 入口已在阶段 2 建好）。
NikkiSync 仓库**不改、不提交**；若执行中发现必须改上游才能达成，**停下问用户**而不是 patch。

## 7. IPC 通道清单（kebab-case，与既有 `nikkisync:` 道一致）

| 通道                           | 入参                                                               | 出参                                                                                                                        | 失败语义                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `nikkisync:server-status`      | 无                                                                 | `{available, running, host, port, secure, serverId, mdnsEnabled, tlsFingerprintSha256, lanHost, pairedDeviceCount, error?}` | 未组装 ⇒ `available:false`（**不抛**，沿用 `sync:getStatus` 语义）                                                                               |
| `nikkisync:start-server`       | 可选 `{port?, mdnsEnabled?}`（`z.tuple`，`wrapHandlerRaw` 自校验） | 同上                                                                                                                        | 未建链 ⇒ `preconditionFailed`；端口占用 ⇒ `internal` 且 `error` 含 `PORT_IN_USE`                                                                 |
| `nikkisync:stop-server`        | 无                                                                 | 同上                                                                                                                        | 未组装 ⇒ `preconditionFailed`                                                                                                                    |
| `nikkisync:get-pairing-code`   | 无                                                                 | 复用 `PairingQrInfo`：`{content, expiresAt, serverId, host, port, tlsFingerprintSha256}`（`content` = `NS1\|…` 七段）       | 服务未运行 ⇒ `preconditionFailed`（上游 `createPairingPayload` 原生抛 `'Server must be started before creating a pairing payload'`，翻译后透出） |
| `nikkisync:get-paired-devices` | 无                                                                 | `SyncDeviceInfo[]`（仅 `revoked_at IS NULL`；不含公钥/凭据哈希）                                                            | 未组装 ⇒ `preconditionFailed`                                                                                                                    |
| `nikkisync:revoke-device`      | `deviceId: string(1..128)`                                         | 撤销后的 `SyncDeviceInfo[]`                                                                                                 | 不存在/已撤销 ⇒ `notFound`                                                                                                                       |

约定：全部经 `wrapHandlerNoArgs` / `wrapHandlerRaw`；错误一律 `AppError` 家族（禁 `throw new Error('字符串')`）；
主进程文案保持**英文**（`src/**` 中文硬编码护栏为 error），本地化由渲染层 `extractUserMessage` + i18n 承担；
返回值由 `wrapHandler` 包成 `IpcResponse`，`call<T>()` 只透出 `data`（渲染层不再检 `res.success`）。
`preload.test.ts` 断言的是**命名空间键数**（33 键 = reportReady + 32 命名空间），本阶段只加方法不加命名空间 ⇒ 计数不变；执行时确认该测无逐方法断言，有则同批更新。

## 8. 错误处理

| 场景                                             | 处理                                                                                                                                                                                                                                                         | 落点                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| 未建链 / 未构建                                  | `status.state = 'unavailable'` + `hint`（给出 `npm run link:nikkisync` + 上游 `npm run build` 的可执行指令）；启停通道 ⇒ `AppError.preconditionFailed`                                                                                                       | `runtime-manager.ts`（沿用阶段 2 既有语义，不新造码） |
| `EADDRINUSE`                                     | 归类 `PORT_IN_USE` 写入状态 `error`，**不重试、不回落**；UI 经 toast 显示并提示改端口                                                                                                                                                                        | `sync-server-view.ts` + `runtime-manager.ts`          |
| 无 LAN IPv4（配对 host 解析失败）                | `resolveLanHost()` 回落 `127.0.0.1`；配对二维码仍出，UI 明确显示该 host（不假装是局域网地址）                                                                                                                                                                | `app/sync-server-setup.ts`                            |
| `createPairingPayload` 抛错（未 start / 无 TLS） | 翻译为 `preconditionFailed`；无 TLS 分支理论上不可达（上游构造必带 TLS），**不为其写兼容性兜底**                                                                                                                                                             | `nikkisync-handler.ts`                                |
| 停止/重启                                        | 每步 `withTimeout(3000)` 兜底 + `warn` 日志，失败不阻塞退出链                                                                                                                                                                                                | `runtime-manager.teardown()`                          |
| mDNS 静默失败 + 自激回环                         | 上游把所有 socket/组播错误吞掉（`MdnsAdvertiser.ts:67,76`）⇒ **绝不把「start 成功」当作「广播成功」**；状态里的 `mdnsEnabled` 只表示配置意图。更严重的是它把自身公告经组播回环当成查询再次应答（`:69-71`），构成无速率限制的自激洪水（§15 实测）⇒ 本仓默认关 | `sync-server-view.ts` 默认值 + §15 取证               |
| 任何服务侧异常                                   | `electronLogger` + `diagLog('NIKKISYNC', …)` 双通道，fail-open，主进程绝不 crash                                                                                                                                                                             | `app/nikkisync-runtime-setup.ts`（沿用阶段 2）        |

## 9. 验收标准（逐条可判定）

1. 服务在配置端口监听（默认 28080，可覆盖）；未开启时无监听、无组播。
2. 端点可用性与响应体符合 NikkiSync Protocol v1 —— 以 §12 真值表为准（含 `PATCH …/metadata`、`…/export` 的实测口径）。
3. 未签名请求返回 `401 {error:{code:'unauthorized',message:'Request signature is missing or invalid'}}`。
4. 配对闭环：`get-pairing-code` 出 `NS1|…` 七段 → `POST /v1/pair` 带该 token 得 200 `PairResponse` → 设备行落 `paired_devices` → `get-paired-devices` 能列出 → 撤销后不再列出且再签名请求回 401。
5. 资源下载支持 Range：`bytes=0-99` ⇒ **206** + `Content-Range` + `Accept-Ranges: bytes`；越界 ⇒ **416** + `Content-Range: bytes */size`。
6. WebSocket：连接 `/ws/v1` 收到 `server.hello`；写 `change_journal` 后收到 `asset.created`（走上游 journal 轮询，不手播）。
7. TLS：首启在 `app_settings['server.tlsIdentity']` 生成自签身份；重启后指纹不变（持久化 + `getOrCreate()` 校验自愈）。
8. mDNS：**默认关闭**；显式开启时本机可观测到 `_nikkisync._tcp.local` 公告，且公告 TXT 的 `serverId` / `port` 与本次会话一致（§15 已实测）。因上游存在自激放大缺陷，本项不得默认开启；**跨设备发现仍需真机实测**，未实测就标「未验证」。
9. UI：设置-同步服务节能显示开关、状态（地址/服务 id/TLS 指纹/已配对数）、二维码、设备列表与撤销。
10. 停止后重启：`stop-server` → 端口拒绝 → `start-server` → 同端口恢复。
11. NikkiSync 自带 `local-sync-server.test.js`（等价门禁）与本仓集成用例同时通过。
12. 两侧全量门禁通过（§13）。

## 10. 测试用例与分步放行（红灯 → 绿灯）

**T-A 集成（`src/main/nikkisync/sync-server.linked.test.ts`，`hasNikkiSyncLink()` 未链整件 skip）**
构造口径：`{databaseFile: mkdtemp(...)/nikkisync.db, syncServer:{host:'127.0.0.1', port:0, mdns:false, journalPollMs:20}}`
（测试用 `127.0.0.1/0/false` 避开防火墙与端口争用；生产默认仍是 `0.0.0.0/28080/true`）。
`signedHeaders()` 与 `readWsText()` **逐字取自** `NikkiSync/apps/pc-companion/test/local-sync-server.test.ts:53-82`，不自创签名格式。

| #   | 用例                                        | 档        | 断言                                                                                                                       |
| --- | ------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | `GET /v1/server` 免鉴权                     | 正常      | 200 + `serverId`/`libraryRevision`                                                                                         |
| 2   | 配对 → 撤销 → 再请求                        | 正常      | 200 `PairResponse`；`paired_devices` 有行；撤销后签名请求 401                                                              |
| 3   | token 二次使用                              | 异常      | 410 `pairing_expired` 或 401 `pairing_invalid`                                                                             |
| 4   | 缺 `pairingToken`                           | 异常      | 400 `bad_request`                                                                                                          |
| 5   | 无签名头访问签名路由                        | 异常      | 401 + `error.code==='unauthorized'`                                                                                        |
| 6   | 时间戳偏斜 / nonce 重放                     | 边界      | 401（±5min 窗口与内存 nonce 表）                                                                                           |
| 7   | `/v1/assets` 分页 `limit` 1..500 + `cursor` | 正常/边界 | 正常页 + `nextCursor`；`limit=0`/`501` ⇒ 400                                                                               |
| 8   | `/v1/assets/{id}`                           | 正常/异常 | 200 且 `raw.nativeParamPayload` 被剥；未知 id 404                                                                          |
| 9   | `GET …/metadata`                            | 边界      | **404**（该 GET 路由不存在）；签名 `PATCH` 白名单字段成功                                                                  |
| 10  | `resources/{rid}` Range                     | 正常/边界 | 206 + `Content-Range`；`bytes=999999-` ⇒ 416                                                                               |
| 11  | `clothing/{cid}/thumbnail`                  | 正常/边界 | 注入 `dist/src/metadata/MetadataThumbnailCache.js`（fake `fetchImpl`）⇒ 200 + `X-NikkiSync-Thumbnail-Source`；未注入 ⇒ 404 |
| 12  | `/v1/changes?after=N`                       | 正常/异常 | revision 序列；缺 `after` ⇒ 400                                                                                            |
| 13  | `/v1/search/suits`、`/clothing`             | 正常/边界 | `q` 必填、≤80；命中排序                                                                                                    |
| 14  | `/v1/profile/stats`                         | 正常      | 200 结构                                                                                                                   |
| 15  | `WS /ws/v1`                                 | 正常      | `server.hello`；写 journal 后 `asset.created`                                                                              |
| 16  | 停止/重启                                   | 正常      | 停后拒绝连接；重启回同端口                                                                                                 |
| 17  | 端口占用                                    | 异常      | 预占端口 ⇒ `start()` 失败且分类 `PORT_IN_USE`，**不外抛、不影响 App 存活**                                                 |

**T-B 纯函数（`sync-server-view.test.ts`，不依赖链接）**：端口归一化（`0`/`-1`/`65536`/`NaN`/字符串）、`isPortInUseError`（`EADDRINUSE`/`EPERM`/普通 Error/非 Error）、设备行映射（缺 `app_version`/`last_seen_at`、非对象输入）、状态快照（未运行缺 `port`）。

**T-C 状态机（`runtime-manager.test.ts`，假会话）**：§8 各分支 + teardown 顺序。

**T-D 手工取证（不进 CI，输出贴进 §14 执行结果）**

```bash
curl -k https://127.0.0.1:28080/v1/server            # 免鉴权 200
curl -k -s -o /dev/null -w '%{http_code}\n' https://127.0.0.1:28080/v1/assets   # 未签名 401
```

> **curl 的真实边界**：9 条签名端点与 206/416 **curl 无法完成**（Ed25519 逐请求签名 + nonce + ±5min 时间戳），
> 由 T-A 覆盖；`/export` 明确拒绝 `Range` 头（给 400），不要用 curl 去证明它支持断点续传。
> mDNS 取证结论见 §15（实测：开启时 45s 内收到 1,568,807 条自激公告 ⇒ 本仓默认关；
> Windows 上 5353 常与 Bonjour 冲突、`0.0.0.0` 监听可能触发防火墙弹窗）。跨设备发现无真机 ⇒ 标未验证。

**分步放行**：步骤 0（§0，已完成 ✓）→ T-A/T-B 红灯留证 → 主进程实现绿灯 → IPC/preload 绿灯 → UI 实跑（`npm run dev`，须看到二维码真实渲染，不以单测代替）→ 文档/打包断言 → e2e → 全量门禁。每步不过不得进下一步。

## 11. API 核对结论（`d4ca7d7` 实测）

| 上游物                                                                       | 实测签名                                                                                                                                                                                                                                                                                                                                                                                                                                       | 与阶段 0+/2 记录                |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `PcCompanionRuntime`（`apps/pc-companion/src/runtime.ts:41-119`）            | 构造期即 `new DatabaseManager(databaseFile)` + `initialize()` + `new LocalSyncServer(...)`（未传 `tls` 则自动 `LocalTlsIdentityService.getOrCreate()`）；`readonly database/scanner/server/remoteBridge/…`；`start(): {scan, server}`；`stop()`（内含 `server.stop→scanner.stop→database.close`，**单实例一次性**）；`createPairingUri(host, ttlMs?)`。**无 `dispose()`**                                                                      | 一致                            |
| `LocalSyncServer`（`src/server/LocalSyncServer.ts`）                         | `new (DatabaseManager, LocalSyncServerConfig)`；`get serverId`；`start(): Promise<LocalSyncServerAddress>`（幂等，返回**实际**端口）；`stop(): Promise<void>`（置空句柄 ⇒ 可重启）；`createPairingPayload(host, ttlMs?)`；`createRemoteSession(...)`。`AuthService`/`PairingService`/`WebSocketHub`/`MdnsAdvertiser`/`AssetRepository`/`SyncReadRepository`/`MetadataDictionaryRepository` 全部**内部 new、不可注入**（TS-`private` 仅编译期） | 一致                            |
| `LocalSyncServerConfig`（`:39-55`，默认 `:159-169`）                         | `name?='NikkiSync PC'`、`host?='0.0.0.0'`、`port?=0`、`tls?`（缺则**降级纯 HTTP** 且 `secure:false`）、`journalPollMs?=250`、`mdns?=true`、`maxJsonBodyBytes?=1MiB`、`metadataThumbnailCache?`、`remoteBridge?`（设了则强制 TLS）                                                                                                                                                                                                              | 一致                            |
| `AuthService`（`src/server/AuthService.ts:23-62`）                           | `verifyRequest(req, body?)` → `deviceId \| undefined`；头 `x-nikkisync-{device-id,timestamp,nonce,signature}`；规范串 `METHOD\n<原始 req.url>\nTS\nNONCE\nsha256(body)hex`；时钟 ±5min；nonce 成功后才记账；公钥接受 PEM 或 base64url SPKI                                                                                                                                                                                                     | 一致                            |
| `PairingService`（`src/server/PairingService.ts:37-85`）                     | `createQrPayload({host, port, tlsFingerprintSha256, ttlMs?})`、`pair(request, serverName)`；token TTL 默认 5min、单次使用；`PairingError('pairing_expired'\|'pairing_invalid')`。**`deviceCredential` 目前不参与鉴权**（`verifyRequest` 只验公钥签名）                                                                                                                                                                                         | 一致（记为上游已知事实）        |
| `WebSocketHub`（`src/server/WebSocketHub.ts`）                               | 手写 RFC6455 文本帧；`upgrade/send/broadcast/close/size`；**`LocalSyncServer` 不暴露公开 emit API** ⇒ 事件只能由 `change_journal` 轮询产生                                                                                                                                                                                                                                                                                                     | 一致                            |
| `MdnsAdvertiser`（`src/server/MdnsAdvertiser.ts`）                           | `start({serverId, name, port})` / `stop()`；`_nikkisync._tcp.local`、TXT `serverId/protocol=1/port`、UDP 5353 → `224.0.0.251`、30s 重播、无 LAN IPv4 时直接 return、错误全吞                                                                                                                                                                                                                                                                   | 一致                            |
| `LocalTlsIdentityService`（`src/server/LocalTlsIdentityService.ts:117-129`） | 唯一方法 `getOrCreate(): {keyPem, certPem, fingerprintSha256, createdAt}`；**无路径参数**；指纹不符则静默重生成并覆写                                                                                                                                                                                                                                                                                                                          | 一致                            |
| `PairingRepository`（`packages/database/src/pairing-repository.ts`）         | `pairDevice/getDevice/countActiveDevices/createSession/consumeSession/touchDevice/acknowledgeRevision/revoke`；**无任何 list 方法**、无过期 session 清理                                                                                                                                                                                                                                                                                       | 一致（`revoke` 可用于撤销通道） |

**据实修正的两处（不得沿用旧措辞）：**

1. `GET /v1/assets/{id}/metadata` **不存在**：路由器只注册 `PATCH`（`LocalSyncServer.ts:231-236`），GET 该路径在签名后落 404。
   上游 `docs/INTEGRATION.md:26` 的表格行是**文档错误**（`docs/M1_1` 与 `GPT_HANDOFF` 写的是签名 `PATCH`）。
   ⇒ 验收按「签名 `PATCH metadata` + `GET /v1/assets/{id}`（元数据本就在详情里）」执行。
2. `MetadataThumbnailCache` 的深入口是 `dist/src/metadata/MetadataThumbnailCache.js`，**不是** `dist/src/server/...`；
   它不在桶导出内 ⇒ 仅测试用 `resolveDeepEntryUrl(['metadata','MetadataThumbnailCache.js'])` 装载，生产装配不注入（注入与否决定 thumbnail 路由 200/404，见 §10 用例 11）。

## 12. 端点真值表（`LocalSyncServer.handle():222-264`，代码为准）

| Method    | Path                                                  | 鉴权                                            | 备注                                                                                                  |
| --------- | ----------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| GET       | `/v1/server`                                          | 免                                              | 发现信息 + `libraryRevision`                                                                          |
| POST      | `/v1/pair`                                            | 免                                              | 400 缺字段 / 410 过期 / 401 无效 / 200 `PairResponse`                                                 |
| GET       | `/v1/assets`                                          | Ed25519                                         | `limit`(1..500,默认100)、`cursor`(base64url `{t,id}`)、`type`、`afterRevision`、`includeDeleted=true` |
| GET       | `/v1/assets/{id}`                                     | Ed25519                                         | 剥 `raw.nativeParamPayload` / `nativeParamNuan5Md5`                                                   |
| PATCH     | `/v1/assets/{id}/metadata`                            | Ed25519（**对 body 签名**）                     | allow-list：`capture,camera,filter,lighting,photography,nikki,dressing,interactions,location`         |
| GET\|HEAD | `/v1/assets/{id}/resources/{rid}`                     | Ed25519                                         | **Range/206/416** + `Accept-Ranges` + `ETag: "sha256:…"` + `X-NikkiSync-SHA256`                       |
| GET\|HEAD | `/v1/assets/{id}/resources/{rid}/export`              | Ed25519                                         | `exif`/`rotation` 各恰一个，多余键 400；**带 `Range` 反而 400**；单飞 429；源变更 409                 |
| GET\|HEAD | `/v1/assets/{id}/clothing/{cid}/thumbnail`            | Ed25519                                         | 需注入 cache，否则 404；上游全败 503                                                                  |
| GET       | `/v1/changes?after=N`                                 | Ed25519                                         | `after` 缺失/非法 400                                                                                 |
| GET       | `/v1/search/suits` / `/v1/search/clothing`            | Ed25519                                         | `q` 必填、trim、≤80                                                                                   |
| GET       | `/v1/profile/stats`                                   | Ed25519                                         | —                                                                                                     |
| WS        | `/ws/v1`                                              | Ed25519（空 body；`req.url` 含 query 参与签名） | `Sec-WebSocket-Version: 13`；失败直接 `socket.destroy()` 无 HTTP 响应                                 |
| GET\|HEAD | `/remote/session/{sid}/assets` / `.../resource/{rid}` | `X-NikkiSync-Remote-Token`                      | **本阶段不启** `remoteBridge`（启用需 TLS 且引入第二套鉴权与错误封套 `{error:'<string>'}`）           |
| —         | 其余                                                  | —                                               | 404 `not_found`；任何抛出 ⇒ 500 `internal_error`（`error.message` 原样回显）                          |

## 13. 分支与提交

| 侧           | 分支                                                | 提交策略                                                                                                                                                                                                                                                                                           |
| ------------ | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WXNN XiangCe | 延续 `feat/gallery-runtime-embed`（HEAD `eff0502`） | 按 §6 分组多次 commit（Conventional Commits）：`docs(sync-integration)` → `feat(nikkisync)` 服务启停 → `feat(ipc)` 通道 → `feat(renderer)` UI 接管 → `chore(packaging)` 断言。注意 `.husky/pre-commit` **会改写文件**（`eslint --fix` + `prettier --write`），提交后 `git status --porcelain` 复核 |
| NikkiSync    | 保持 `main`，**不产生提交**                         | 本阶段对其源码零改动；仅 `node_modules` 层面的链接修复（不被跟踪）                                                                                                                                                                                                                                 |

## 14. 执行结果（2026-10-14 回填）

### 14.1 门禁

| 侧        | 命令                                          | 基线（步骤 0）                                         | 本阶段结果                                                                                                         |
| --------- | --------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| NikkiSync | `npm test`                                    | 136 / 136 pass / 0 fail                                | **136 / 136 pass / 0 fail / 0 skip** ✓                                                                             |
| NikkiSync | `npm run typecheck` / `npm run db:validate`   | exit 0 / `schema OK`                                   | exit 0 / `schema OK`（13 对象，FK 与 quick_check ok）✓                                                             |
| NikkiSync | 源码改动                                      | —                                                      | **零改动**（`git status --porcelain` 仍只有 `tools/sample-analyzer/analyze.mjs` 的行尾幻影，与步骤 0 一致）        |
| XiangCe   | `npm run typecheck`                           | exit 0（`tsc -b` + `tsc -p tsconfig.scripts.json`）    | exit 0 ✓                                                                                                           |
| XiangCe   | `npm run lint`                                | exit 0，**0 error / 11 warning**（存量 `unicode-bom`） | 0 error / 11 warning（同一批存量）✓                                                                                |
| XiangCe   | `npm run format:check` / `npm run i18n:check` | 通过                                                   | 通过 ✓（12 个 locale 只改端口数字，无新增 key）                                                                    |
| XiangCe   | `npm test`                                    | **370 files 全过；5794 pass / 2 skip（共 5796）**      | **372 files / 5869 pass / 2 skip** ✓（新增 2 个测试文件、+75 例）                                                  |
| XiangCe   | `npm run test:coverage`                       | **未取**（本轮流程缺口，见 §14.3 之 2）                | **四项仍低于阈值：`66.70 / 58.19 / 59.23 / 68.28` vs `69 / 80 / 68 / 69`** ⇒ 既有债 DEBT-032，本阶段是抬升而非恶化 |
| XiangCe   | `npm run verify:nikkisync`                    | 7 ✓ / 1 ✗（旧 `release/win-unpacked` 判据）            | 9 项 8 ✓ / 1 ✗（同一既有项；新增的同步服务器产物项为 ✓）                                                           |
| XiangCe   | `npm run build` + `e2e/nikkisync-runtime`     | 5 passed                                               | **6 passed**（新增 N3b/N3c）✓                                                                                      |
| XiangCe   | `npm run typecheck:e2e`                       | —                                                      | exit 0 ✓                                                                                                           |

### 14.2 端点与协议取证

**A. 仓内集成用例（`sync-server.linked.test.ts`，真起上游 TLS 服务）** 12 例全绿，覆盖：
`GET /v1/server`（免鉴权 200 + `capabilities.profileStats`）、`POST /v1/pair`（200 / 重放 401 / 未知 token 401 / 真过期 410 / 缺字段 400）、
未签名一律 401 `unauthorized`、`GET /v1/assets`（分页 + `limit=0/501` 给 400）、`GET /v1/assets/{id}`（含上游脱敏断言）、
`GET …/metadata` **404**（该路由不存在）与签名 `PATCH` 200、`resources/{rid}` 的 200/206/416 + `Accept-Ranges`/`ETag`/`X-NikkiSync-SHA256`、
`clothing/{cid}/thumbnail` 404（未注入缓存）、`/v1/changes`（200 与缺 `after` 400）、`search/suits`、`search/clothing`、`profile/stats`、
`WS /ws/v1`（未签名 upgrade 被掐断 + 签名收 `server.hello` + 写 journal 后收 `asset.created`）、停止后拒绝连接并可重启、TLS 身份跨会话指纹不变。

**B. `curl` 现场取证**（临时脚本按**生产默认值** `0.0.0.0:28080` 起上游服务；取证后进程已停、端口已释放）：

| 判据               | 命令要点                                                                                                     | 实测                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| 免鉴权端点         | `curl -k https://127.0.0.1:28080/v1/server`                                                                  | 200，`{"protocolVersion":1,"serverId":"server_1340eaf9…","name":"NikkiGallery","libraryRevision":0,"capabilities":{…}}` |
| 未签名签名路由     | `curl -k …/v1/assets`                                                                                        | `{"error":{"code":"unauthorized","message":"Request signature is missing or invalid"}}`                                 |
| 坏配对 token       | `curl -k -X POST …/v1/pair`                                                                                  | 401 `pairing_invalid`                                                                                                   |
| **开启验证**的 TLS | `curl --cacert <库内证书> --resolve nikkisync.local:28080:127.0.0.1 https://nikkisync.local:28080/v1/server` | 200 且 `ssl_verify_result=0`（SAN `nikkisync.local`、CN `NikkiSync Local`、指纹 `a0d6f7e8…a00045`）                     |
| 局域网可路由       | `curl -k https://192.168.1.249:28080/v1/server`                                                              | 200（证明 `0.0.0.0` 绑定不是只回环）                                                                                    |
| 配对串             | `runtime.createPairingUri('192.168.1.249')`                                                                  | `NS1\|server_1340eaf9…\|192.168.1.249\|28080\|W9Ot…\|1791969330\|a0d6f7e8…`（7 段，第 7 段与 TLS 指纹逐字一致）         |
| 身份持久化         | 重启服务进程后再读 `serverId` / 指纹                                                                         | 与上一轮完全相同 ⇒ 库内身份确实持久化                                                                                   |

**C. 真实应用会话（e2e，非白盒）**：`N3b` 在真 Electron 主进程里起服务，由**外部进程**用库内自签证书作 CA + SNI 做**开启验证的** HTTP 请求（不关校验）；
`N3c` 在真实窗口点开关 → 状态卡「运行中」→ 二维码 SVG 出图（断言 markup 长度以排除空壳）→ 服务留活交由退出链关闭并断端口释放。
视觉证据：`test-results/nikkisync-pairing-qr.png`（可见服务 ID `server_6df471d3…`、TLS 指纹、二维码、`默认端口 28080` 文案、toast「同步服务已启用」）。

**D. mDNS**：见 §15（实测为上游自激回环缺陷 ⇒ 集成侧默认关）。

### 14.3 遗留项

1. **打包态未复验**：`verify:nikkisync` 唯一 ✗ 仍打在 2.5.5 的旧 `release/win-unpacked`（早于建链）。本轮只加了产物断言（§6 #20），没跑 `dist:win`（需可行网络/证书环境）；打包态四项产物（migrations SQL、四包 `dist/src/index.js`、`row-mappers.js`、`LocalSyncServer.js` + `GalleryRuntime.mjs`）仍待一次真打包复验。
   - **2026-10-14 复评（本项仍未关闭）**：本轮清除了挡在打包前的闸门缺陷——`scripts/pre-dist-check.ts` 第 4/5 项曾把修复点标记的检索作用域收窄在 `dist/main/main/app`，而 `tsc -b`（`.husky/pre-commit` 与 `npm run verify` 都会跑）会把 `app/` 下同名 rollup chunk 覆盖成 per-file 产物、令含 `.min(0)` 的依赖模块落到 `app/` 之外（实测同一文件从 860KB 的 rollup 版本被覆盖成 10KB 的 per-file 版本且不再含该标记），该断言因此随构建顺序反复无谓转红并阻断 `npm run dist:win`。作用域改为整个 main 输出根后布局无关（提交 `9c17889`，配注入式虚拟产物树单测 + 由已跟踪 `src/main/tsconfig.json` 推导的结构契约）。在本机重建 `dist/` 后，`npm run pre-dist-check` 三连（`pre-dist-check` + `check-doc-versions` + `check-changelog-release`）**全绿退出码 0**。**但按本轮口径只验到闸门为止，未调用 `electron-builder`**：`release/win-unpacked` 与 `NikkiGallery-Setup-2.5.5.exe` 仍是 2026-10-14 14:09 的旧产物、不含阶段 2/3 的 8 笔提交，故上述四项打包态产物**依旧未完成复验**。
2. **覆盖率门控红灯是既有债，不是本轮引入**：`CHANGELOG.md:59` 与 `docs/技术债清单.md`（DEBT-032）记录 Vitest 5 口径修正后同一套测试为 `64.65 / 55.67 / 57.12 / 66.21`，四项全不达标，当时的决定是「不降阈值、不扩 exclude、保持红灯」。本轮用**逐文件剔除法**实测：去掉本阶段改过的 12 个源文件后聚合仍为 `66.38 / 57.69 / 58.90 / 67.96`（照样低于阈值），而本阶段新代码自身为 `sync-server-view 97.91%` / `handler 98.86%` / `facade 98.61%` / `manager 91.42%` / `setup 98.14%` ⇒ 本阶段把四项**抬升**到 `66.70 / 58.19 / 59.23 / 68.28`，阈值一字未动。重新基线或补测试仍属 DEBT-032 的决策。流程缺口如实登记：步骤 0 只取了 typecheck/lint/test 基线，没取 coverage 基线。
3. **服装缩略图端点在嵌入态恒 404**：刻意不给 `LocalSyncServer` 注入 `metadataThumbnailCache`（它要向公共字典 CDN 外联，与本阶段「零外联」口径冲突；上游桌面版是注入的）。手机侧要显示服装图标就得单独决定何时放开外联。已用集成用例锁定「未注入 ⇒ 404」，不是漏测。
4. **设备列表是只读 SELECT 权宜**：上游 `PairingRepository` 无 `listDevices`；上游补齐后应改调它并删 `PAIRED_DEVICES_SQL`。
5. **mDNS 默认关待翻回**：上游修好自激回环（应答前判 QR 位 / 只单播回查询者 / 加最小发送间隔）后，把 `SYNC_SERVER_DEFAULT_MDNS` 翻回 `true` 并复测 §15.2。
6. **跨设备与防火墙未验证**：无 Android 真机在线 ⇒「局域网可发现」「跨主机可达」两项标**未验证**（本机 LAN IP 直连 200 只证明绑定面可路由，不证明对端可达）。
7. **上游 P1 已知缺陷照录**：RSA 私钥明文存于 `app_settings`（`docs/M1_1_LOCAL_SYNC_SERVER.md:77` 自标 P1，DPAPI 未做）。
8. **需求措辞据实修正**：`GET /v1/assets/{id}/metadata` 不存在（只有签名 `PATCH`），已按实现验收，并改正 `docs/INTEGRATION.md:26` 造成的误述。
9. **新坑记录（步骤 0 已补）**：`npm install` 不只剪本仓的 `@nikkisync` junction，也会把 **NikkiSync 自身的 workspace 链接**变成空目录，导致上游 `npm run build` 报 `TS2307: Cannot find module '@nikkisync/core'`；修复是在 NikkiSync 根跑 `npm install`（只动 `node_modules`，不触被跟踪文件）。

### 14.4 提交面

`feat/gallery-runtime-embed` 上 7 次提交（NikkiSync 侧零提交）：
`990211e` 计划与取证 → `3763c45` 主进程服务面 → `b83a288` IPC/preload/共享类型 →
`c5fa279` 渲染层改接 → `2deb805` 打包断言 → `0a52495` e2e → `4239d31` 契约与 AGENTS 边界。

## 15. mDNS 取证与上游缺陷（2026-10-14 实测）

**结论：上游 `MdnsAdvertiser` 存在组播自激回环，开启后会以约 3.5 万包/秒向局域网泛洪。本仓因此把 `nikkisync.syncMdnsEnabled` 默认改为 `false`（这是对已批准计划 §3「默认 true」的有意偏离，方向是更安全的一侧）。**

### 15.1 机制（读源码定位，非推测）

`NikkiSync/apps/pc-companion/src/server/MdnsAdvertiser.ts`：

| 行       | 事实                                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `:66-68` | 公告与应答共用**同一个** `dgram` socket，`send()` 把公告组播到 `224.0.0.251:5353`                                       |
| `:69-71` | `socket.on('message')` 的判据只有「字节里含 `_nikkisync` 且含 `_tcp`」——**不判 QR 位、不判是不是查询**，命中即 `send()` |
| `:65`    | 公告包体本身包含 `_nikkisync._tcp.local`（PTR/SRV/TXT 三条记录的名字段）                                                |
| `:72-77` | `bind(5353, reuseAddr)` + `addMembership` + `setMulticastTTL(255)`；**`setMulticastLoopback` 未关闭**（默认为真）       |
| 无       | 全文件**没有任何速率限制 / 去抖 / 应答抑制**                                                                            |

⇒ 自己发出的公告被组播回环送回自己 ⇒ 命中 `:70` 的判据 ⇒ 再发一条 ⇒ 自激正反馈。同网段内任意两台 NikkiSync PC 会互相放大（对方的公告同样命中判据）。

### 15.2 A/B 数据（同一台机器、同一监听脚本，只改 `mdns` 一个变量）

被动监听脚本：`dgram` 绑 5353（`reuseAddr`）→ 对每个 IPv4 网卡 `addMembership('224.0.0.251')` → **不发任何查询** → 统计含 `_nikkisync` 的包。

| 组  | 服务配置                                 | 监听时长 | 收到的 `_nikkisync` 包         | 内容核验                                                                                                            |
| --- | ---------------------------------------- | -------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| A   | `host:'0.0.0.0', port:28080, mdns:false` | 15s      | **0**                          | —                                                                                                                   |
| B   | `host:'0.0.0.0', port:28080, mdns:true`  | 45s      | **1,568,807**（≈34,862 包/秒） | 抽样包 356 字节、源 `192.168.1.249:5353`、含 `protocol=1`、`port=28080`、且含本次会话的 `serverId=server_1340eaf9…` |

A/B 只差 `mdns` 一个开关，且 B 组包内 `serverId` 与本次服务一致 ⇒ 归因确定：**洪水来自上游公告器自身**，不是本机其它 mDNS 程序（Windows Bonjour 等）。

补充：更早一次「主动发 PTR 查询」的探测得到 1,162,438 条同源包，说明查询/应答同样会被卷入回环；那次判读里「查询应答计数为 0」是我脚本的计数标签缺陷，不是服务未应答。

### 15.3 本阶段的处置

1. `SYNC_SERVER_DEFAULT_MDNS = false`（`src/main/nikkisync/sync-server-view.ts`，注释内写明实测数字与上游行号）。
2. 保留 `nikkisync.syncMdnsEnabled` 设置项：用户在知情前提下可开启（局域网调试需要时）。
3. 功能不受影响：手机侧发现路径本就依赖配对二维码里的 `host:port`（`NS1|` 第 3/4 段实测为 `192.168.1.249` / `28080`）。
4. **不修改上游**（本阶段铁律）。已具备提 issue 的完整复现：上表 A/B + `:69-71` 的判据 + 一句修复建议（应答前判 QR 位、或改为只回单播给查询者、或加最小发送间隔）。
5. 待办：向 NikkiSync 上游报告该缺陷；上游修复合入后，把本仓默认翻回 `true` 并复测 §15.2。

### 15.4 未验证项（不得当作已验收）

- **跨设备 mDNS 发现**：本轮无 Android 真机在线，只有本机回环证据 ⇒ 标记「未验证」。
- **防火墙放行**：`0.0.0.0:28080` 从本机 LAN IP `192.168.1.249` 直连取到 200（`curl` 实测），证明监听面确实可路由；但**跨主机**是否被 Windows 防火墙拦，未测。
- 上游默认（`mdns:true`）在本机复现了洪水；其它网卡形态（多网卡/VPN）下回环是否同样成立，未测。
