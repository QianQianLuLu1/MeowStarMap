# NikkiSync 上游同步 · 阶段 4：能力层（K1–K8）与收尾（F）执行记录

> 路径作用域：文中未注明「本仓」的源码路径（`apps/pc-companion/`、上游 `dist/src/**`、`runtime.js` 等）均指**上游 NikkiSync 仓**（`node_modules/@nikkisync/*` junction 指向的检出根），不在本仓；标注「本仓」的路径以仓库根为基准。

- **上游锚定**：`b422193`（兼容层 C1–C6 已对齐；本轮能力层全程上游仓 0 行 porcelain，零上游源码修改）
- **本仓基线**：`6402cb5`（阶段 3 兼容层收尾提交）→ 本轮起点 `fb17ee5`（K6 已闭合）
- **计划依据**：`docs/plans/2026-10-25-nikkisync-upstream-sync-02-实施计划.md`（2026-10-25 已批准，§14 Q1–Q6 按提案裁示）
- **状态**：K1–K8 全部闭合；F 收尾（CHANGELOG 补记 + §9 十步矩阵 + dist:win + e2e）随本文档同批完成
- **节点提交**：K1 `332e0de`（20 文件 +389/−5）→ K2 `54e5e21`（28 文件 +956/−22）→ K3 `3c7ab84`（27 文件 +376/−26）→ K4 `6f4e44d`（22 文件 +428/−2）→ K5 `476182b`（25 文件 +370/−30）→ K6 `fb17ee5`（27 文件 +1004/−16）→ K7 `887103d`（23 文件 +336/−13）→ K8 `9cf6bfc`（34 文件 +1998/−15）

## 1. 逐节点记录

### K1 启动阶段观测 + 缓存解码元数据接线（`332e0de`）

- **上游依据**：`runtime.ts onStartupStage` + `PcStartupStage` 六阶段；`CachedDecodedMetadataService`。边界事实照计划执行：本仓编排不调 `PcCompanionRuntime.start()`（会无条件绑 0.0.0.0），只记**真实发生**的阶段（`scanner` / `runtime-ready` / `lan-listen` / `cached-metadata`），`dictionary-enrichment` / `background-services` 永不记录。
- **分层**：`runtime-manager.ts` 阶段记录器（幂等、teardown 清空、失败不谎报）+ `driveCachedMetadata`（仅启动后与手动扫描后各一次、void 驱动不挂 IPC 返回路径、失败 log warn 不静默）；`runtime-status` 响应体带 `startupStages?` 可选段（无新通道）；`SyncServicePage` 状态卡「启动阶段」行（未知阶段回退原样英文短码）。
- **证据**：manager 假会话用例（正常序列 / startSyncServer 后含 lan-listen / 重复 start 幂等 / 失败中断保留已发生阶段）+ 页面 (s)/(s2) 用例 + `sync-service-keys.test.ts` 12 locale；`runtime-manager` 套件全绿。

### K2 元数据在线解析许可/隐私开关（`54e5e21`）

- **上游依据**：`MetadataOnlineConsent` / `MetadataPrivacyPanel` / `RemoteJsonMetadataResolver`。
- **K2-0 外发字段清单（落档位，同意披露 UI 逐字如实）**：endpoint `https://nuan5.pro/api/decode-photo2`；recipients `[{name: 'Nuan5 metadata service', fields: ['photo UID', 'NUAN5 JPEG-prefix parameter MD5 digest']}]`。
- **分层**：facade 深入口 `METADATA_ONLINE_CONSENT_DEEP_ENTRY`（`consentFile={userData}/nikkisync/metadata-online-consent.json`，`initiallyDisabled=true`，resolver 经 `consent.guard` 包装；仅 `metadataResolverEnabled` 时构造）；通道 `nikkisync:get/set-metadata-consent`（zod `{enabled, policyVersion 1..64}`；未装配 → `PRECONDITION_FAILED`；policyVersion 不匹配 → `VALIDATION_ERROR`；关闭时上游 `abortPending()` 自动生效）；preload `getMetadataConsent()/setMetadataConsent()`；`SyncServicePage` 同意折叠块（端点已脱敏 + policyVersion 原串带回 + 外发字段清单）。
- **默认安全姿态**：`initiallyDisabled=true`（严于上游 fresh-install 默认放行）叠加既有 `nikkisync.metadataResolverEnabled` 默认 false——实际出站为双重门；同意文件损坏（非法 JSON）→ fail-closed 视为未同意；未同意时 `runOnce()` 零出站（解析失败计入既有 failureCategories）。
- **证据**：handler 三支单测 + 损坏文件 fail-closed 用例 + 页面用例 (t)(u)(v)；12 locale。

### K3 游戏版本推断展示（`3c7ab84`）

- **上游依据**：`server/GameVersionCalendar.ts` 静态表（纯本地、无出站）；明确不做 `GameVersionUpdateService` 远程刷新与 Steam 英文名（§14-Q6）。
- **K3-1 实测边界值（落档位）**：`2025-04-01T00:00:00.000Z → '1.4'`（边界日命中）；早于 1.0 的时刻 → 两键缺省；未来时刻 → 最新版本；非法/缺省输入原样下传由上游判缺省返回 `{}`、不抛错。
- **分层**：facade 深入口 `GAME_VERSION_CALENDAR_DEEP_ENTRY`；通道 `nikkisync:resolve-game-version`（zod 只做长度界不做日期格式校验）；preload + `SyncAssetDrawer`「游戏版本」行（有 version 才显示；C4 同步后 metadata 自带 `identity.gameVersionEnglishName` 并列展示）。
- **证据**：纯函数表驱动用例 + handler 三支（有参命中/未命中/缺省）+ drawer 渲染用例；12 locale。

### K4 连接诊断面（`6f4e44d`）

- **上游依据与收窄**：上游实现主体在其 C# windows-shell（`ConnectionDiagnosticsCollector`），不可复用；本仓自建**纯观测**面——只聚合既有状态，不 ping、不扫端口、不扫子网。
- **分层**：`sync-server-view.ts` 纯函数 `buildSyncDiagnosticsSnapshot`（running/host/port/secure/mdnsEnabled/pairedDeviceCount/tlsFingerprintSha256 尾 8 位/connectionHosts?/lastError?/updatedAt）；`runtime-manager.syncStatus()` 组装处填 `diagnostics` 段；`IPC_CONTRACT` §8.2 落档；`SyncServicePage` 诊断折叠卡。
- **证据**：纯函数三类单测（运行中全字段 / 未组装回落 / 端口占用归一 `PORT_IN_USE`）+ 页面 (w)(x)；12 locale。

### K5 多 host 配对（`476182b`）

- **上游依据**：`server/LanAddress.ts`、协议 `connectionHosts`/`hosts`、`buildPairingUri` 多 host 分支（vendored 真相源已在 C4 对齐）。
- **分层**：装配点深入口 `listLanIpv4`/`selectLanIpv4`（默认关时一次都不装载）；`nikkisync.multiHostPairing` 设置键（默认 **false**）；`pairingCode()` 开关关 → 单参 `NS1|` 七段逐字节不变，开关开 → `nikki-sync://pair?` 查询串 + `hosts` 回填（≤8）；`parsePairingUri` 双格式解析（NS1 分支行为逐字节不变）；`PairingQrDialog` 备选地址清单（hosts>1 才显示）。
- **互操作前提**：多 host URI 仅在开关开启后产生；第三方旧版 Android 客户端在开关关闭时行为与升级前完全一致（回归锚：默认态 content 以 `NS1|` 开头且 6 个 `|`）。
- **证据**：链接态配对回归锚 + `parsePairingUri` 新格式正常/缺参/坏 port/坏 tls→null/hosts 超限截断 + 组件用例；12 locale。

### K6 额外照片目录（`fb17ee5`）

- **上游依据**：`scanner/ExtraScanDirectories.ts` + `ExtraScanDirectoriesPanel.ts` + ScannerService 接线；上限 16、模式 `native|images`、重叠折叠全由上游承担，本仓零二次实现。
- **K6 state()/proposal 剔除清单（落档位）**：`state()` 剔除 `message`（上游中文 UI 串）；`inspect()` 提案剔除 `hint`；`id/roots/images/videos/limited` 原样保留。
- **分层**：facade 深入口 `EXTRA_SCAN_DIRECTORIES_DEEP_ENTRY`（文件 `{userData}/nikkisync/extra-scan-directories.json`，上游 0600 JSON 即单一真相源，不落设置键）；五通道 `get-extra-directories` / `inspect-extra-directory`（path 1..4096 绝对路径）/ `add-extra-directory` / `remove-extra-directory` / `rescan-extra-directories`；八错误短码映射表（输入形态类 → `VALIDATION_ERROR`，会话状态类 → `PRECONDITION_FAILED`，映射表落 `toAppError` 旁逐码注释）；页面第 ④ 节（目录列表 / 添加 dialog → inspect 预览 → 确认 add / 手动重扫；文案注明仅作用同步库扫描器）。
- **证据**：handler 每短码一断言 + 未装配支 + 假实例往返（zod 不重复设上限，避免双真相源）+ 页面 (y)(y2)(z)；12 locale。

### K7 扫描诊断观测面（`887103d`，本轮闭合）

- **上游依据与收窄**：1.0.23 的「live index repair」在上游**无用户可调用 API**（`apps/pc-companion/src/scanner/` grep `repair|rebuild` 零命中）；本仓不发明修复按钮、不新增协议动作。
- **分层**：facade 深入口 `SCAN_DIAGNOSTICS_DEEP_ENTRY`（`dist/src/scanner/ScanDiagnostics.js`）+ 会话闭包绑定 `runtime.scanner`；manager 扫描成功后取 `scanDiagnosticSummary(scanner)` 快照（上游承诺仅计数、绝不序列化路径/UID/文件名/原始错误），`runtime-status` 增 `scanDiagnostics?` 可选段（未扫描缺省、teardown 清空、老链接不挂面）；`SyncServicePage` K4 诊断卡并排「上次扫描」七计数行（观察/收录/忽略/新建/更新/删除/错误，段缺失不渲染）；`vite-env.d.ts` 镜像；`IPC_CONTRACT` §8.1.5 落档；i18n 12 locale + `sync-service-keys` 守卫扩展。
- **红灯证据**：manager K7-m1/m2（未扫描缺省 / 老链接不抛）+ facade K7-f1/f2（闭包绑定会话 scanner、逐字透传 / 深入口缺席不挂面）+ 页面 (x2)/(x3) 先行确认红。
- **绿灯证据**：`runtime-manager` + `runtime-facade` 103 passed；K7 全子集 311 passed（18 文件）；`npm run verify` 5 项全绿。
- **会话前遗留修复**：`runtime-facade.test.ts` 兼容夹具 K3 方法名 typo（`inferInfinityNikuGameVersion` → `inferInfinityNikkiGameVersion`）还原——该 typo 使既有 K3 用例红灯（TypeError: not a function），非 K7 语义，随本节点还原。

### K8 批量删除/离线整理（`9cf6bfc`，本轮闭合，最大节点）

- **上游契约核实**（`node_modules/@nikkisync/pc-companion/dist/src/organizer/DeletionQueue.js`）：`list()` 行形状 `{id, assetId, state, message(上游中文), online, files[{name,size,folder?}], count}`；`decide/approveMany` 抛 `not_pending/phone_offline/stopping/invalid_ids`；`activity()` = metrics+queued+active；helper 调用 `execFile(env.NIKKISYNC_RECYCLE_HELPER, ['--recycle-file', path, sha256, String(size)], {windowsHide: true, timeout: 120000})`；env 未设置 → `recycle_unavailable`（fail-safe）；`runtime.js:29` 构造期必建 `deletions`；11 态与计划枚举一致。
- **K8-a 回收 helper**：`resources/nikkisync/recycle-helper.cs`（四参解析 → 文件存在 + size 匹配 → 流式 SHA256 复核 → `Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile(OnlyErrorDialogs, SendToRecycleBin)` → 退出 0；失败 stderr 英文非零退出）+ `scripts/build-recycle-helper.cjs`（win32 走 `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:exe /r:Microsoft.VisualBasic.dll`；csc 缺失/编译失败/产物缺失非零退出可诊断；非 win32 跳过退出 0；纯函数导出供单测）+ `package.json`（`build:recycle-helper` 插 `dist:win` 链首、`extraResources` 收 `resources/nikkisync`→`nikkisync` 的 `*.exe`、`files` 排除 `!resources/nikkisync/*.exe` 防双入 asar）+ 装配点 `resolveRecycleHelperPath`（dev=仓内产物、打包=`{resourcesPath}/nikkisync/`）注入 `NIKKISYNC_RECYCLE_HELPER`（exe 未构建时 warn 保持未设置，上游 `recycle_unavailable` 兜底）。
- **K8-b**：`settings-keys.ts` 白名单增 `nikkisync.organizerEnabled`（布尔默认 **false**，注释消费点）。
- **K8-c**：`runtime-manager` 三方法——`organizerStatus()`（`list()` 逐行剔除中文 `message` + `activity()` 计数）、`organizerDecide(id, approve)`、`organizerApproveMany(ids)`（薄委托、上游错误原样上抛，与 `revokeDevice` 先例同口径）。
- **K8-d**：三通道 `nikkisync:get-organizer-queue` / `nikkisync:decide-organizer-item`（id `/^[a-zA-Z0-9-]{16,64}$/` 与上游同规）/ `nikkisync:approve-organizer-items`（ids 1..500）；**开关门**：三通道先读 `nikkisync.organizerEnabled`，false → `PRECONDITION_FAILED`（文案指向同步服务页开关）；映射表逐码注释：`not_pending/invalid_ids` → `VALIDATION_ERROR`、`phone_offline` → `PRECONDITION_FAILED`、`stopping` → `CANCELED`。
- **K8-e**：preload 三方法 + `electron-api.ts` 类型（`NikkiSyncOrganizerItemInfo/ViewInfo/DecideInput/ApproveInput/ApproveResultInfo`）+ `vite-env.d.ts` 镜像。
- **K8-f**：`SyncServicePage`「整理队列」区——区头开关读写 `nikkisync.organizerEnabled`；11 态 i18n 映射（未知回退原样英文短码，K1 同款口径）；文件数与 online 指示；单条批准（破坏性确认弹窗）/拒绝（非破坏性直调）；批量批准（确认后仅 actionable 且在线的 id）；确认弹窗列明将移入 Windows 回收站的文件总数与去向；仅开关开且本页可见时 2s 轮询（沿 `STATUS_POLL_MS` 模式）；通道失败降级「不可用」提示而非报错弹窗。
- **红灯证据**：构建脚本 8 例（参数拼装/路径探测 mock/主流程分支）+ manager 5 例（透传与 message 剔除/参数逐字透传/错误上抛/unavailable）+ handler 7 例（开关关三通道全拒且句柄零调用/往返零转换锁死/正则与 500 界拒收/四短码映射/未装配）+ 页面 8 例（开关读写/列表渲染/未知态回退/确认弹窗拦截/拒绝路径/批量批准 id 收敛/空态/通道失败降级）+ settings 写通 1 例，均先行确认红再实现。
- **绿灯证据**：K8 全子集 490 passed（26 文件）；`npm run verify` 5 项全绿；`npm run build:recycle-helper` 本机实跑产物存在（5120 B）且 usage 分支实测退出 2；pre-commit 全过。
- **测试红线**：全套测试未构造真实文件触发 `executing`；真实回收 + 回收站恢复归 §13 人工验证。链接态仅断言至 `queued` 之前（本轮链接态套件维持既有形态，未新增 executing 路径用例）。

### F 收尾（随本文档同批闭合）

- **F-1**：`CHANGELOG.md` 于 [2.5.5] 节追加 2026-10-25 条目（版本号不动，发布轮另做）。
- **F-2**：§9 十步矩阵逐项执行（结果见 §2；过程中抓出并修复 `scripts` 工程一处类型错 + 旧名台账两处欠账，见 §3 偏差表）。
- **F-3**：`npm run dist:win`（含 `build:recycle-helper` 链首段）+ `verify:dist --verify-asar`。
- **F-4**：`npm run e2e:smoke` + `npx playwright test e2e/nikkisync-runtime.e2e.ts`（未链接环境整套 skip 语义保持）。

## 2. §9 全局验证矩阵结果（F-2 执行读数）

| #   | 命令                                   | 结果                                                                                                                                                                                                                                                                                                                           |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `npm run verify`                       | ✓ 五步全绿（K7/K8 节点收尾各跑一轮；F-2 复核时目标集为残余改动，同样 0 失败）                                                                                                                                                                                                                                                  |
| 2   | `npm run typecheck` + `typecheck:e2e`  | ✓ 双绿（**修复后**；首轮抓出 `build-recycle-helper.test.ts` 一处 TS2352，见偏差 #12）                                                                                                                                                                                                                                          |
| 3   | `npm run lint`                         | ✓ 零 error                                                                                                                                                                                                                                                                                                                     |
| 4   | `npx prettier --check`（闸门作用域）   | ✓ 零 diff（两轮各修一次变更文件格式后通过）                                                                                                                                                                                                                                                                                    |
| 5   | `npm test`（全量 vitest）              | ✓ 444 文件 / 6942 通过 / 12 skip（既有预期项：identity-service 平台 2 + ci-linux 仿真未激活 10，与 GPU 轮基线一致；链接态套件全部真实执行，无意外 skip；首轮两处既有欠账见偏差 #12/#13）                                                                                                                                       |
| 6   | `npm run verify:nikkisync`             | ✓ 12 项全 ✓，blocking failures: 0                                                                                                                                                                                                                                                                                              |
| 7   | `npm run i18n:check` + `i18n:guard`    | ✓ 12 locale 键对齐（K7 +8 / K8 +28 键）；白名单基线不回归                                                                                                                                                                                                                                                                      |
| 8   | `npm run build` → `verify:nikkisync`   | ✓ 构建成功，第 7 项折叠检查绿                                                                                                                                                                                                                                                                                                  |
| 9   | `npm run dist:win`                     | ✓ 四段链全过（`build:recycle-helper` → build → pre-dist-check → NSIS `MeowStarMap-Setup-2.5.5.exe` 签名出包 → verify:dist）；`--verify-asar` 原生二进制 + `@nikkisync` migrations + 32 条禁串逐项 OK；**K8-a 专项核验**：helper exe 落 `win-unpacked/resources/nikkisync/`（5120 B）、7 个深入口产物齐备于 `app.asar.unpacked` |
| 10  | `npm run e2e:smoke` + nikkisync N 套件 | ✓ e2e:smoke 全绿；`npx playwright test --config e2e/playwright.config.ts e2e/nikkisync-runtime.e2e.ts` 6/6（N1/N2/N3/N3b/N3c/N4 链接态真实执行；未链接环境的整套 skip 语义由 `e2e/nikkisync-guard.ts` 保持）                                                                                                                   |

## 3. 遗留与偏差表

**继承自兼容层/K1–K6 的既有登记（03 记录 §7.2 + 会话计划三项）**

| #   | 项                                                                                             | 处置                                                            |
| --- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | C4 红灯用例系工作区预置（会话外来稿，逐行审查后采纳）                                          | 已登记（03 #1）                                                 |
| 2   | C4-1 计划文字「capture 块」系笔误（实为 camera 块）                                            | 已登记（03 #2）                                                 |
| 3   | C6 无独立提交（证据型节点，零文件变更）                                                        | 已登记（03 #3）                                                 |
| 4   | K2 `initiallyDisabled` 语义修正（比上游 fresh-install 默认放行更严，fail-closed）              | 已按计划落实现（会话计划遗留项）                                |
| 5   | K5-1① 配对 host 保留仓内 `resolveLanHost`（默认路由优先），上游 `listLanIpv4` 仅作备选地址来源 | 装配点注释已落档（`nikkisync-runtime-setup.ts` K5-1① 偏差裁示） |
| 6   | K2 handler 会话外 CJK 判据修正采纳（含 CJK 的上游原生文案改写英文，不透传）                    | 已落实现（`consentErrorToAppError`）                            |
| 7   | K2–K6 期间 `preload.test.ts` 方法清单断言停在 17 个（K2/K3/K6 的 8 个方法未入清单）            | **随 K8 补全**：17 → 28 并补三通道名命中断言（见 #9）           |

**本轮（K7/K8/F）新增偏差与决策**

| #   | 项                                                                                                                                                                                                      | 处置与理由                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8   | K7 会话前 WIP 中 `runtime-facade.test.ts` 夹具 K3 方法名 typo（`inferInfinityNikuGameVersion`）                                                                                                         | 非 K7 语义的意外破坏（使既有 K3 用例红灯），随 K7 还原；K7 语义面按计划重写                                                                       |
| 9   | preload 方法清单历史缺口（17 → 28）                                                                                                                                                                     | 按 `src/main/preload/AGENTS.md` 第③步随 K8 一并补全（清单断言覆盖整个命名空间，K8 加方法必须触碰该断言）                                          |
| 10  | K8-d zod **不去重**（计划表格写「ids 1..500 去重」）                                                                                                                                                    | 取「逐字透传」验收为准：重复 id 由上游 `invalid_ids` 拒绝（单一真相源），本层去重会破坏「委托参数逐字透传」口径                                   |
| 11  | `package-lock.json` 48 行 `"libc"` 字段剥离（npm 版本差异遗留）                                                                                                                                         | 按计划 §10 不入本轮任何提交、不还原，保持工作区既有状态                                                                                           |
| 12  | F-2 首轮全量测试抓出 `scripts/__tests__/build-recycle-helper.test.ts` 一处 TS2352（`tsc -b` 收不到 scripts 工程，verify 未覆盖）                                                                        | `as unknown as` 中转修复；暴露的闸门覆盖面事实（typecheck 含 scripts 工程、verify 只跑 `tsc -b`）如实登记                                         |
| 13  | F-2 首轮全量测试抓出旧名台账两处欠账（`runtime-loader.ts` 未核账 +1、`runtime-loader.test.ts` 未登记；**在 K6 提交点 `fb17ee5` 实测已红**，系兼容层 C2 引入 `normalizeNikkiGalleryPhoto` 后未同批核账） | 按台账设计流程核账：补登记两文件（reason：上游桶导出符号名，非产品自称）+ `expectedTotal` 170 → 172；守卫强度不减                                 |
| 14  | K1 页面用例 (s) 在 444 文件全量负载下单次超时抖动（隔离复跑 3×38 全绿）                                                                                                                                 | 首轮复现一次；后续全量复跑（台账核账 + 04 落档后）连续绿，按最小化改动不加超时，留观                                                              |
| 15  | `resources/nikkisync/*.exe` 构建产物不入仓                                                                                                                                                              | `.gitignore` 增排除（产物由 `build:recycle-helper` 在打包链生成）                                                                                 |
| 16  | md-links 守卫 8 处死引用（**在 K6 提交点 `fb17ee5` 实测已红**：01 三处上游路径 + 02 四处写错的 `src/main/nikkisync/nikkisync-handler.ts`）                                                              | 01/02 头部补「路径作用域」声明行（checker 既有约定，上游路径降级为提醒）；02 四处 handler 路径订正为 `src/main/ipc/handlers/nikkisync-handler.ts` |
| 17  | F-4 的 `npx playwright test e2e/nikkisync-runtime.e2e.ts` 裸跑报 No tests found                                                                                                                         | 本仓 playwright 配置在 `e2e/playwright.config.ts`，须携 `--config`；计划表格命令为简写，按实际形态执行                                            |

## 4. 人工验证清单移交（02 §13 未入自动化部分）

- K8-a helper 真实回收 + Windows 回收站恢复（构造真实文件走一次完整 `executing → recycled` 链，手机端需 NikkiSync App ≥ 1.0.21）。
- K2 同意 UI 与上游 `MetadataPrivacyPanel` 的实际外发行为核对（真机抓包）。
- K5 多 host 开关开启后的真机配对（双端在多网段环境的备选地址可用性）。
- F-3 产物安装态冒烟（NSIS 安装 → 首启 → 同步服务页全区块渲染）。
