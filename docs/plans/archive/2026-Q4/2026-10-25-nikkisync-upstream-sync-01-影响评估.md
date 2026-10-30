# NikkiSync 上游同步 · 01 影响评估（阶段 1：只读盘点，不改业务代码）

> 生成日期：2026-10-25 · 本仓 `main` @ `dc9f085414e38e13988ff60e73b10dcbb879025b`（工作区仅既有 `M package-lock.json`）
> 上游 NikkiSync：基线 `d4ca7d7a164d44ca91dcc3e7e7604b9839296ad3`（2026-10-13）→ 目标 `b4221933be9714fde0c260b1f19bdaa6d1337fd3`（origin/main HEAD，2026-10-24 推送）
> 路径作用域：文中未注明「本仓」的源码路径（`packages/`、`apps/`、`scripts/`、`.github/` 等）均指**上游 NikkiSync 仓**检出根，不在本仓。
> 结论速览：**上游 12 提交、总 376 文件 +16421/−682；消费面内 74 文件。本仓链接建成后全量测试 259 通过 / 0 失败 / 0 skip，协议漂移守护绿，`verify:nikkisync` 11 项全绿——上游本轮演进对本仓现有消费面零破坏，全部上游新能力（批量删除、额外照片目录、连接诊断、多 host 配对等 13 项）在本仓均无对应面，属可选接入项而非被迫适配项。**

---

## 1. 环境事实盘点

| 项                | 事实                                                                                                                                | 证据命令                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Node              | v26.3.0（满足本仓 engines `>=22.12.0` 与上游 `>=24.0.0`）                                                                           | `node -v`                                               |
| npm               | 11.16.0                                                                                                                             | `npm -v`                                                |
| git               | 2.55.0.windows.2                                                                                                                    | `git --version`                                         |
| `NIKKISYNC_ROOT`  | 未设置（空）→ 建链候选根走同级 `../NikkiSync`                                                                                       | `echo $NIKKISYNC_ROOT`                                  |
| 本仓分支/HEAD     | `main` @ `dc9f085…`                                                                                                                 | `git rev-parse HEAD`；`git branch --show-current`       |
| 本仓工作区        | 仅既有 `M package-lock.json`（阶段开始前已存在，本阶段未触碰）                                                                      | `git status --porcelain`                                |
| 本仓 node_modules | 就绪（`.package-lock.json` 2026-10-25 12:05 更新）；`node_modules/@nikkisync` 起初为**空目录**（上次 install 剪链残留，不影响建链） | `ls node_modules/@nikkisync`                            |
| 上游检出          | 存在于 `D:\Workbuddy 项目\WXNN YD - 副本\NikkiSync`，remote = `https://github.com/ToStardust/NikkiSync`（fetch/push），分支 `main`  | `git -C ../NikkiSync remote -v`                         |
| 上游工作区        | **零改动**（`status --porcelain` 0 行）——无行尾幻影、无脏改动，无需取证分支                                                         | `git -C ../NikkiSync status --porcelain \| wc -l` → `0` |
| 仓内 vendor       | 不存在 `vendor/` 目录                                                                                                               | `ls vendor` → NO vendor dir                             |

阶段动作：本阶段**未执行**本仓 `npm install`（依赖已就绪，保护 `package-lock.json` 与 junction）；上游仓也无需 install（根 `package-lock.json` 与 `devDependencies` 在本轮区间零变化，构建一次直跑成功，见 §5-D）。

## 2. 上游基线 / 目标 SHA 与提交清单

- 基线：`d4ca7d7a164d44ca91dcc3e7e7604b9839296ad3`（2026-10-13，`fix(android): save motion photos as rotated videos or LIVE`）。本地检出 fetch 前 HEAD 与本仓文档记载（`docs/sync-integration/02-runtime-embed-plan.md` L22、`03-sync-server-plan.md` L25、`04-ui-bridge-plan.md` L24 等 5 文件 12 处）**完全一致**，无矛盾。证据：`git -C ../NikkiSync rev-parse HEAD`（fetch 前）。
- 目标：`b4221933be9714fde0c260b1f19bdaa6d1337fd3`。证据：`git fetch origin` 后 `git rev-parse origin/main`；`rev-list --left-right --count main...origin/main` = `0 12`（零分叉）→ `git merge --ff-only origin/main` 干净前进，前进后 `status --porcelain` 仍 0 行。
- fetch 附带拉到 11 个 `v1.0.x-public-beta.*` 标签（上游进入公测发布节奏）。

完整提交清单（旧→新，`git log --oneline --no-decorate d4ca7d7..origin/main` 倒序整理）：

| #   | SHA       | 主题                                                                         | 消费面内/全部文件数 | 分类                                                                                                                           |
| --- | --------- | ---------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `97fa60f` | feat: release Momo Camera 1.0.5 public beta                                  | 44/178              | **消费面相关**：metadata 全家（在线许可/隐私面板/缓存解码）、desktop 面板、core 新模块                                         |
| 2   | `0326dae` | fix: build PC runtime from a clean checkout                                  | 1/5                 | **消费面相关**：根 package.json `build:pc` 顺序修复（R10）                                                                     |
| 3   | `922e680` | docs: remove personal paths and private conversation reference               | 0/6                 | 消费面外（docs 隐私清理）                                                                                                      |
| 4   | `d1f03d6` | fix: restore automatic reconnect and publish 1.0.7 handoff                   | 9/44                | 消费面相关：MdnsAdvertiser、desktop 重连、MetadataOnlineConsent                                                                |
| 5   | `abecd4a` | fix: separate EXIF camera and lens names for 1.0.8 public beta               | 1/14                | 消费面内仅 pc-companion 测试（功能主体在 tools/wechat-gallery 与 mobile）                                                      |
| 6   | `d469a7d` | fix: deduplicate EXIF names and bound LIVE rotation memory for 1.0.10        | 0/30                | 消费面外（mobile native + tools）；但 database 的 obsolete motion 清理逻辑随本主题在 `b6ebb6c`/`b422193` 落入消费面（见 §5-B） |
| 7   | `eb2e782` | fix: support Android 11/12 and resilient startup in 1.0.11                   | 14/76               | 消费面相关：scanner 弹性化、LanAddress、MdnsAdvertiser、windows-app、WeChatGalleryService                                      |
| 8   | `b6ebb6c` | feat: release 1.0.15 with guided setup and extra photo folders               | 25/86               | **强相关**：ExtraScanDirectories(+Panel)、runtime 启动阶段化、database models/reconcile 扩展                                   |
| 9   | `cd44a41` | fix: compare physical directory aliases without changing resource identities | 3/7                 | 消费面相关：ExtraScanDirectories/ScannerService + database `markMissing` 路径比较语义（subst/junction 物理别名）               |
| 10  | `27a3f2f` | feat: release 1.0.21 offline organizer and batch deletion improvements       | 20/66               | **强相关**：organizer/DeletionQueue、OrganizerPanel、`POST /v1/organizer/sync` 路由、JpegImageBoundary、runtime.deletions      |
| 11  | `4fc1ac6` | feat: release 1.0.22 connection diagnostics and autostart repair             | 3/27                | 消费面相关：desktop 连接诊断/自启动修复面板（主体在上游自家 Electron 壳）                                                      |
| 12  | `b422193` | feat: release 1.0.23 live index repair and native service recovery           | 17/32               | **强相关**：ScanDiagnostics、ScanIndexFailure、windows-app 原生服务恢复、StartupFailure                                        |

（逐提交文件计数证据：`git show --name-only --format= <sha>` 按 `^(packages/|apps/pc-companion/|package\.json|tsconfig|scripts/)` 过滤）

## 3. 文件级影响面分类

总量（`git diff --stat d4ca7d7..b422193 | tail -1`）：**376 files, +16421, −682**。

- **消费面内 74 文件**（`git diff --name-only d4ca7d7..b422193 -- packages apps/pc-companion package.json tsconfig.base.json scripts | wc -l`）：
  - `packages/` 10 = core 5（`src/{index,types,metadata-dictionary}.ts` 改、`src/decoded-metadata.ts` 新、test 1）+ database 3（`src/{asset-repository,models}.ts` 改、test 1）+ protocol 2（`src/index.ts` 改、test 1）；
  - `apps/pc-companion/` 58 = src 40 + test 18；
  - 根构建 6 = `scripts/` 5（`build-wechat-runtime.mjs` 改；`build-official-android.ps1`、`package-public-beta.ps1`、`sign-desktop-update.ps1` 新；`build-brand-icons.ps1` 改）+ `package.json` 1。
- **消费面外 308 文件 +13131/−461**（`git diff --stat d4ca7d7..b422193 -- . ':!packages' ':!apps/pc-companion'`）：`apps/mobile`（Android 11/12、原生 C++ 旋转内存上限、EXIF）、`tools/`（wechat-gallery/live-probe/crypto-spike、windows-performance 验证脚本、releases 公测发布链）、`.github/workflows/ci.yml`、`docs/`、`assets/`、`desktop-launchers`、`apps/windows-shell*`、`apps/wechat-mini-program`。
- **影响构建的消费面外改动**：`tools/wechat-gallery/photo-export.mjs`（`exportJpeg` 增加 `cameraName`、`gameVersionEnglishName`/`setRemoteGameVersionNames` 导出）与 `apps/pc-companion/dist/src/server/GameVersionCalendar.js` 一起被 `scripts/build-wechat-runtime.mjs` 打进 `GalleryRuntime.mjs`——已随构建实证（§5-D）。

## 4. 五类风险实证

### A. 四包桶导出与深入口产物 —— 全部向后兼容，零删除零改名

- `packages/core/src/index.ts`：仅追加一行 `export * from './decoded-metadata.js'`（新模块导出 3 个纯函数：`normalizeNuan5Photo` / `normalizeNikkiGalleryPhoto` / `mergePhotoMetadataGaps`，120 行，从 pc-companion 的 `Nuan5CompatibleResolver` 上移并扩展 rotation/pose/eureka/interactions/diy/weather/vertical 映射）。证据：`git diff d4ca7d7..b422193 -- packages/core/src/index.ts`；`grep "^export" packages/core/src/decoded-metadata.ts`。
- `packages/core/src/types.ts`：`InfinityPhotoMetadata` 全部为**可选字段追加**（`identity.gameVersionEnglishName?`、capture 新增 `rotation?/zoom?/cameraYaw?/cameraPitch?/cameraLoc?`、新增 `pose?`）。
- `packages/database`：`AssetRepository.reconcile(input, scan?)` 增加可选第二参 `AssetReconcileScanContext`；`AssetReconcileResult` 增加可选 `supersededChanges`；新增 `countVisible()`。单参调用完全兼容。
- `packages/protocol`：见 §4-C，无导出删除。
- pc-companion 深入口产物构建后逐项存在（16/16 OK，含 verify 门禁点名的 `dist/src/server/LocalSyncServer.js`、`dist/src/wechat/GalleryRuntime.mjs`、`dist/src/metadata/{Nuan5CompatibleResolver,MetadataResolutionDiagnostics}.js` 与新模块 `organizer/DeletionQueue.js`、`scanner/{ExtraScanDirectories,ScanDiagnostics,ScanIndexFailure}.js`、`metadata/{CachedDecodedMetadataService,MetadataOnlineConsent}.js`、`server/{LanAddress,GameVersionUpdateService}.js`）。证据：本阶段 `ls` 逐项核查输出全 OK。
- `GalleryRuntime.d.mts`（wechat 深入口类型）：新增 `setRemoteGameVersionReleases` / `gameVersionEnglishName` / `setRemoteGameVersionNames`；`exportJpeg` options 新增**可选** `cameraName?`。
- 本仓 `runtime-loader.test.ts` 的 `NIKKISYNC_REQUIRED_EXPORTS` 探针实测全绿（§6），证明必需导出面无缺失。

### B. 数据库 migrations —— 零变化，无用户库升级风险

`git diff --stat d4ca7d7..b422193 -- packages/database/migrations packages/database/src/database-manager.ts packages/database/scripts` 输出**为空**；目标态 `ls packages/database/migrations` 仍仅 `0001_initial.sql`。schema 机制、`schema_migrations` 登记、`DatabaseManager.initialize()` 路径均未动。行为层变化仅两处且均为服务端内部语义：`markMissing` 根路径比较从 `LIKE` 改为 `instr(path_key, ?) = 1` + `toPathKey(root)+'/'`（物理目录别名修复，`cd44a41`），以及 `reconcile` 在扫描完成上下文中清理「过时 LIVE 模糊匹配」孤儿资源（`asset.deleted` + `obsolete_motion_association`，事务内、FK 级联仅删候选）。SQL 全部参数绑定，无拼接注入面。

### C. HTTP/WS 协议面 —— `PROTOCOL_VERSION` 与 `API_ROUTES` 未动，三处可选扩展

`git diff d4ca7d7..b422193 -- packages/protocol/src/index.ts` 仅三处：

1. `ServerInfoResponse` 新增可选 `connectionHosts?: readonly string[]`；
2. `PairingQrPayload` 新增可选 `hosts?: readonly string[]`（IPv4 备选，旧客户端继续用 `host`）；
3. `buildPairingUri()`：当去重后 hosts > 1 时输出新 URI 方案 `nikki-sync://pair?<query>`（含 `hosts` 逗号列表，上限 8）；单 host 时**逐字节保留旧 `NS1|…` 格式**。

`PROTOCOL_VERSION` 仍为 1；`API_ROUTES` 12 键未变。服务器侧（`LocalSyncServer.ts`）：`/info` 响应在配置了 `connectionHosts` 回调时附加该字段；新增**硬编码路由** `POST /v1/organizer/sync`（未登记进 `API_ROUTES`；未注入 `DeletionQueue` 时返回 404 `not_found` "Organizer requires a newer desktop"——旧桌面端语义安全）；`exportStill`（JPEG 导出）新增可选查询参数 `cameraName`（校验：需 `exif=true`、trim 一致、UTF-8 ≤256 字节、无控制字符）。对已配对旧客户端：全部新增面均可选，不破坏现有配对/鉴权/Range/WS 事件。

### D. 上游构建面 —— R10「clean checkout 构建失败」已修复（实测一次直跑成功）

`0326dae` 将根 `package.json` 的 `build:pc` 从 `node scripts/build-wechat-runtime.mjs && tsc` 反转为 `tsc && node scripts/build-wechat-runtime.mjs`（`typecheck` 同步调整）。原因：`build-wechat-runtime.mjs` 现在从 `apps/pc-companion/dist/src/server/GameVersionCalendar.js` 与 `tools/wechat-gallery/photo-export.mjs` 取导出，必须先有 pc-companion dist。本阶段在上游仓直接 `npm run build` **一次成功、零告警**（Node v26.3.0，无需绕过序、无需 install）。产物布局不变（`dist/src/**` + `dist/test/**`）。

### E. 新配置项 / 新服务能力（上游实现位置）

见 §7 能力对齐清单（逐项含文件路径）。

## 5. 本仓现状基线（链接 → 上游构建 → 诊断 → 测试）

1. **建链**：`npm run link:nikkisync` → `source=sibling mode=apply`，四条 junction `create`（`@nikkisync/core|database|protocol|pc-companion` → `…\NikkiSync\packages\*` / `apps\pc-companion`）；`npm run link:nikkisync:check` → `check OK (all four links in place)`。
2. **上游构建**：`cd ../NikkiSync && npm run build` 一次成功（§4-D）。
3. **诊断**：`npm run verify:nikkisync` → **11 项全 ✓，`OK (blocking failures: 0)`**（依赖图自包含、四链就绪、四包 dist 完备、migrations 可读、LocalSyncServer/GalleryRuntime 与 Nuan5CompatibleResolver/MetadataResolutionDiagnostics 产物在位、dist/main 零 `require("@nikkisync` 折叠、app.asar.unpacked 含 schema、根可发现、node:sqlite 可导入、electron 41.10.6）。
4. **测试**：`npx vitest run src/main/nikkisync scripts/__tests__/link-nikkisync.test.ts scripts/__tests__/verify-nikkisync-link.test.ts scripts/__tests__/self-contained-deps.test.ts` →
   **Test Files 19 passed (19)，Tests 259 passed (259)，skip 0**。要点：
   - `protocol-drift.test.ts`（2）**绿**：vendored 契约快照 vs 上游 `b422193` 真实模块逐值一致、`API_ROUTES` 仍 12 键——因上游协议扩展均为可选字段，`buildPairingUri` 采样输入（无 hosts）新旧输出一致；
   - `runtime-loader.test.ts`（13）绿：四包可装载、`NIKKISYNC_REQUIRED_EXPORTS` 全在、协议常量契约（含 `PROTOCOL_VERSION === 1`）成立；
   - 链接态 5 件全绿：`runtime-facade.linked`（10，真实扫描入库）、`sync-server.linked`（12，真实 HTTPS+TLS+Ed25519 鉴权+配对+Range/206/416+WS，14.9s）、`metadata-resolver.linked`（6）、`probe`（8）、加 `runtime-manager`（45）。
   - **结论：本轮升级在本仓是「绿灯基线」——没有被迫适配项；后续阶段全部是可选能力接入与真相源主动同步。**

## 6. 能力对齐清单（上游新能力 vs 本仓对应面）

本仓对应面判定方法：对 15 个上游新符号 `grep -rl <符号> src/ --include="*.ts" --include="*.tsx"`；**13 项零命中**。`LanAddress` 的 2 处命中经甄别为本仓自有函数 `isLanAddress`（`src/main/services/share-wifi-service.ts:637`、`src/main/app/sync-server-setup.ts:287`，用于 WiFi 分享选绑定地址），与上游 `apps/pc-companion/src/server/LanAddress.ts` 无关；`createPairingUri` 本仓已有双参消费面（`src/main/nikkisync/runtime-facade.ts:517-518`）。

| #   | 上游能力（版本/提交）                                | 上游实现位置【事实】                                                                                                                              | 本仓对应面【事实】                                                                                        | 建议接入层级【推断】                                                                                                                                             | 风险与依赖                                                                         |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | 批量删除 / 离线整理（1.0.21）                        | `apps/pc-companion/src/organizer/DeletionQueue.ts`；`LocalSyncServer` `POST /v1/organizer/sync`；`runtime.deletions`；`desktop/OrganizerPanel.ts` | 无（`organizer`/`DeletionQueue` 零命中）                                                                  | 主进程：RuntimeManager/facade 编排 `runtime.deletions`；IPC+preload 新通道；渲染层 sync-gallery 删除入口；i18n 12 locale；设置项（删除语义与本仓回收站策略对齐） | 手机端旧版本调用会得 404；本仓需定义删除与 RecycleBin/物理文件的关系；最大改造量项 |
| 2   | 额外照片目录（1.0.15）                               | `apps/pc-companion/src/scanner/ExtraScanDirectories.ts`；`desktop/ExtraScanDirectoriesPanel.ts`；`ScannerService`/`runtime` 接线                  | 无                                                                                                        | 主进程：扫描根配置持久化（设置键白名单）；IPC；设置页 UI；i18n                                                                                                   | 与本仓自有扫描器（`src/main/scanner/`）目录体系并存，需明确仅作用于同步库          |
| 3   | 连接诊断（1.0.22）                                   | `desktop/DesktopPage.ts` + `DesktopPageScript.ts`（`4fc1ac6`）                                                                                    | 无                                                                                                        | 渲染层 sync-gallery 诊断面板 + 主进程状态快照（本仓 `sync-server-view` 扩展）                                                                                    | 上游实现在其自家 Electron 壳，本仓需自建观测面                                     |
| 4   | 多 host 连接 / LAN 备选地址                          | `server/LanAddress.ts`；protocol `connectionHosts`/`hosts`；`LocalSyncServerConfig.connectionHosts`；`createPairingUri(host, ttlMs?, hosts?)`     | 无（本仓 `isLanAddress` 为自有无关函数）                                                                  | 主进程：配对 URI 生成传第三参（`runtime-facade.ts:517`）；可选同步 vendored `protocol.ts` 的 `hosts` 字段与 `buildPairingUri` 多 host 分支                       | 漂移测试当前绿（采样不含 hosts）；若同步 vendored 实现需同步扩采样键防回归         |
| 5   | 启动阶段回调（1.0.15）                               | `runtime.ts` `onStartupStage` + `PcStartupStage`（6 阶段）                                                                                        | 无                                                                                                        | 主进程 RuntimeManager 上报启动进度 → 渲染层首启体验                                                                                                              | 低风险纯增益                                                                       |
| 6   | 元数据在线解析许可 / 隐私控制（1.0.5/1.0.7）         | `metadata/MetadataOnlineConsent.ts`；`desktop/MetadataPrivacyPanel.ts`；`RemoteJsonMetadataResolver.ts`                                           | 无                                                                                                        | 主进程设置项（默认关闭语义需对齐上游）+ IPC + 设置页 + i18n                                                                                                      | **合规面**：NUAN5 在线解析把照片参数发往外部端点，接入前必须带用户同意开关         |
| 7   | 缓存解码元数据（1.0.5）                              | `metadata/CachedDecodedMetadataService.ts`；`runtime.start()` `cached-metadata` 阶段                                                              | 无                                                                                                        | 主进程：facade 启动接线（随 #5）                                                                                                                                 | 依赖 #6 的许可语义                                                                 |
| 8   | EXIF 相机名分离导出（1.0.8）                         | `LocalSyncServer.exportStill` `cameraName` 参数；`GalleryRuntime.exportJpeg` options                                                              | 无                                                                                                        | 【待确认】本仓导出/分享若走上游 exportStill 可透传；本仓自有水印/导出链是否受益需单独评估                                                                        | 参数校验严格（≤256B、无控制字符）                                                  |
| 9   | 游戏版本英文名 / 版本日历更新                        | `server/GameVersionEnglishNames.ts`、`GameVersionUpdateService.ts`、`GameVersionCalendar.ts`；`GalleryRuntime` 三新导出                           | 无（vendored `domain-types.ts` 亦无 `gameVersionEnglishName`）                                            | 渲染层 sync-gallery 元数据显示 + 主进程远程日历刷新                                                                                                              | 纯展示增强，低风险                                                                 |
| 10  | 索引修复（1.0.23）                                   | `scanner/ScanDiagnostics.ts`、`scanner/ScanIndexFailure.ts`                                                                                       | 无                                                                                                        | 主进程诊断 API + IPC + 设置页维护工具                                                                                                                            | 与本仓扫描器索引体系独立                                                           |
| 11  | 原生服务恢复 / 自启动修复（1.0.22/1.0.23）           | `windows-app.ts`、`desktop/StartupFailure.ts`                                                                                                     | 无                                                                                                        | 【待确认·大概率不适用】上游面向其自家 PC 壳（windows-shell）；本仓 Electron 生命周期由 `src/main/app/` 自理                                                      | 若接入仅为借鉴设计                                                                 |
| 12  | 自动重连（1.0.7）                                    | `server/MdnsAdvertiser.ts`、desktop 面                                                                                                            | 【待确认】本仓 sync-gallery 断线提示现状未逐屏核查                                                        | 渲染层重连提示                                                                                                                                                   | 低风险                                                                             |
| 13  | reconcile 扫描上下文 / 过时 LIVE 清理（1.0.10 主题） | `database/src/asset-repository.ts`                                                                                                                | 本仓不直调 `reconcile`（经 facade 查询面），链接态测试已绿                                                | 无需本仓动作                                                                                                                                                     | 上游内部行为，随库升级自动生效                                                     |
| 14  | 域类型新字段                                         | `packages/core/src/types.ts`（`gameVersionEnglishName`、`camera*`、`pose` 等）                                                                    | `src/shared/sync/domain-types.ts` 未同步（`gameVersionEnglishName`/`cameraYaw`/`pose`/`rotation` 零命中） | 阶段 2 真相源同步（可选字段追加，纯类型面）                                                                                                                      | 不同步不触发红灯（不在漂移比对面），但长期会造成 vendored 契约与上游形状漂移       |
| 15  | 目录别名身份修复（`cd44a41`）                        | `asset-repository.markMissing` `instr` 语义 + `core` `toPathKey`                                                                                  | 自动随链接生效                                                                                            | 无需动作                                                                                                                                                         | 影响 subst/junction 盘符用户的多目录扫描正确性                                     |

## 7. 建议的后续阶段大纲（供评审取舍，非承诺）

- **阶段 2（低风险纯同步）**：vendored 真相源跟进——`src/shared/sync/domain-types.ts` 补可选字段（#14）；可选：`protocol.ts` 的 `hosts`/`connectionHosts` 类型面与 `buildPairingUri` 多 host 分支 + 漂移采样键扩展（#4）；`protocol.test.ts` 补对应用例（先红后绿）。
- **阶段 3（观测与体验）**：启动阶段回调 + 缓存解码元数据接线（#5/#7）、连接诊断面（#3）、游戏版本英文名展示（#9）。
- **阶段 4（合规开关）**：元数据在线解析许可/隐私设置项（#6，含 12 locale i18n）。
- **阶段 5（能力大户，需产品决策）**：批量删除/离线整理（#1，含删除语义与本仓回收站关系的产品定义）与额外照片目录（#2）。
- 每阶段含代码改动，须先落盘独立 MD 实施计划并经批准（含三类测试），遵守核心路径两层闸门与 `@core-change` 注释规则。

## 8. 风险登记册

| #   | 风险                                        | 等级          | 现状/缓解                                                                                                                                 |
| --- | ------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 本仓 `npm install` 剪掉 junction            | 中            | 本阶段未 install；后续任何 install 后必须 `npm run link:nikkisync`（`src/main/nikkisync/AGENTS.md` L97-99）                               |
| R2  | Node 版本（上游 engines ≥24）               | 低            | 本机 v26.3.0 满足；CI 侧本仓 engines ≥22.12.0 不受上游约束（上游仅为检出仓）                                                              |
| R3  | `POST /v1/organizer/sync` 旧端 404          | 低            | 上游已内建 404 兜底文案；本仓未接入前无影响                                                                                               |
| R4  | vendored 域类型/协议与上游形状长期漂移      | 中            | 阶段 2 处理；当前漂移守护绿不报警是采样面未覆盖所致，需人工跟进                                                                           |
| R5  | 上游公测节奏（v1.0.x-public-beta 标签密集） | 中            | 建议后续同步锚定 tag 而非滚动 main；本阶段按任务指令锚定 origin/main HEAD                                                                 |
| R6  | 新能力接入触碰核心路径闸门                  | 中            | `src/main/ipc/handlers/`、`src/main/preload/api/`、`src/main/services/`、`src/shared/errors/` 改动需 `// @core-change:` 注释 + 提交面闸门 |
| R7  | 批量删除与文件系统/回收站语义冲突           | 高（若做 #1） | 阶段 5 前必须产品定义；技术上 DeletionQueue 有 `withDeferredWatchEvents` 防扫描风暴                                                       |

## 9. 验收自检（本阶段停止门）

- [x] 链接真实建成（四 junction + `link:nikkisync:check` OK）
- [x] 链接态测试真实执行（19 文件 259 测试 0 skip 全绿）
- [x] 每个关键结论附命令/文件证据（本文档各节内联）
- [x] 所有引用的 npm scripts 均真实存在（`link:nikkisync`/`link:nikkisync:check`/`verify:nikkisync` 见根 `package.json` L73-75）
- [x] 未修改本仓任何业务代码、未提交 git；上游仓零改动丢失（工作区始终 0 行 porcelain）
- [x] 待确认项已标注（#8/#11/#12）并给出原因
- **停止门：本文档完成后即停，等待人工评审，不进入代码修改。**

## 附：证据命令附录（均在 2026-10-25 实际运行）

```bash
# 环境
node -v && npm -v && git --version && echo "NIKKISYNC_ROOT=$NIKKISYNC_ROOT"
git rev-parse HEAD && git branch --show-current && git status --porcelain
# 上游
git -C ../NikkiSync remote -v && git -C ../NikkiSync rev-parse HEAD && git -C ../NikkiSync status --porcelain
git -C ../NikkiSync fetch origin && git -C ../NikkiSync rev-parse origin/main
git -C ../NikkiSync rev-list --left-right --count main...origin/main   # 0 12
git -C ../NikkiSync merge --ff-only origin/main
git -C ../NikkiSync log --oneline --no-decorate d4ca7d7..origin/main   # 12 提交
git -C ../NikkiSync diff --stat d4ca7d7..b422193 | tail -1            # 376 files +16421 −682
git -C ../NikkiSync diff --name-status d4ca7d7..b422193 -- packages apps/pc-companion package.json tsconfig.base.json scripts
git -C ../NikkiSync diff --stat d4ca7d7..b422193 -- packages/database/migrations packages/database/src/database-manager.ts packages/database/scripts  # 空
git -C ../NikkiSync diff d4ca7d7..b422193 -- packages/protocol/src/index.ts packages/core/src/index.ts packages/core/src/types.ts package.json scripts/build-wechat-runtime.mjs apps/pc-companion/src/server/LocalSyncServer.ts apps/pc-companion/src/wechat/GalleryRuntime.d.mts apps/pc-companion/src/metadata/Nuan5CompatibleResolver.ts apps/pc-companion/src/runtime.ts
# 链接与构建（本仓→上游→本仓）
npm run link:nikkisync && npm run link:nikkisync:check
cd ../NikkiSync && npm run build                                             # 一次成功
npm run verify:nikkisync                                                     # 11 ✓ / 0 blocking
npx vitest run src/main/nikkisync scripts/__tests__/link-nikkisync.test.ts scripts/__tests__/verify-nikkisync-link.test.ts scripts/__tests__/self-contained-deps.test.ts  # 19 files / 259 tests 全绿
```

---

## 10. 阶段 2 回写（2026-10-25）

> 阶段 2 实施计划已落盘：[`02-实施计划`](../../2026-10-25-nikkisync-upstream-sync-02-实施计划.md)。本文档 §6 表中三项「待确认」裁决如下（与计划 §11/§15 一致）：

| 评估条目                    | 裁决   | 理由                                                                                                                         |
| --------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| #8 EXIF 相机名分离导出      | 不接入 | `exportStill` 的 `cameraName` 是手机端拉图 API 的可选入参；本仓 PC 面经 `media://` 直读文件与自有水印/分享链，无该参数消费点 |
| #11 原生服务恢复/自启动修复 | 不适用 | 上游实现面向其 C# windows-shell 服务进程拓扑（`ServiceProcessHost` 等）；本仓 Electron 生命周期由 `src/main/app/` 自管       |
| #12 自动重连                | 不适用 | 上游为「桌面壳↔服务进程」跨进程重连语义；本仓 server 与 runtime 同进程，无此拓扑（手机侧重连属客户端行为）                   |

另：阶段 2 计划新增 6 项待确认（K8 删除语义与回收 helper 方案、在线解析同意默认 fail-closed、多 host 默认关、UI 归属页、出站刷新类不做），见计划 §14，随计划批准一并裁示。评估 §7 原五阶段大纲已被计划「兼容层 C1–C6 + 能力层 K1–K8 + 收尾 F」节点树取代。
