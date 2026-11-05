# 同步图库对齐 NikkiSync `589b932`（v1.0.30）· 实施计划

- 日期：2026-11-02
- 本仓基线：`main` @ `10f7055`（`meow-star-map 2.5.6`），`git status --porcelain` = 0
- 上游锚点（起点）：`ToStardust/NikkiSync` `main` @ `b397e0eb6ca1b4748f13a72f13bb1702a549410e` = tag `v1.0.27-public-beta.1`
- 上游目标（本轮采纳）：`main` @ `589b932ebb5f3d7c18f7109cb91091f8eb563e2f` = tag `v1.0.30-public-beta.1`（`git ls-remote origin HEAD` 实测）
- 本地链接检出：`D:\Workbuddy 项目\WXNN YD - 副本\NikkiSync`（四条 junction 指向其 `packages/*` 与 `apps/pc-companion`）
- 上一轮：`docs/plans/archive/2026-Q4/2026-10-31-nikkisync-upstream-align-01-实施计划.md`（N0–N6 全部执行，读数在其 §7）
- 落盘状态：2026-11-02 经用户批准入仓；执行读数回写于 §7

## Context（为什么做这件事）

「同步图库」板块运行的是**内嵌面**：`src/main/nikkisync/` 通过四条 junction 装载兄弟检出 `../NikkiSync` 的 `dist/` 产物（`@nikkisync/{core,database,protocol,pc-companion}`），装载锚点停在 `b397e0e`（v1.0.27，2026-10-27）。上游今天已到 `589b932`（v1.0.30），本仓落后 3 个提交，其中 **`a5a43f9` 含 30 个 PC 侧文件改动**，新增一整个 `inspiration/` 子系统并改了协议能力位。本轮目标：把 `589b932` 的全部 PC 端能力真正搭载进本仓，并顺手点亮「代码已接通、界面却没接」与「被陈旧理由摁死」的既有能力。

> 用户原文第二处链接写作 `qithub.com`，按唯一命中仓 `github.com/ToStardust/NikkiSync` 解析（`search_repositories` 唯一结果，`updated_at = 2026-11-02T05:09:53Z`）。

### 已核实的边界（用户裁决）

| 裁决项   | 内容                                                                                                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 范围     | **差量 + 点亮**：补上游 `b397e0e..589b932` 全部 PC 差量，并点亮 mDNS 默认位、套装/服装检索与角色档案统计三块无调用方的能力                                                 |
| 灵感     | 端点随上游 `LocalSyncServer` 自动上线；本仓只做**只读能力位标记**上同步服务页，不做灵感库列表/编辑器                                                                       |
| 环境     | 允许 `git fetch` + `checkout 589b932` + `npm run build` 动 `../NikkiSync`；**绝不改上游任何源文件**，`git -C ../NikkiSync status --porcelain` 全程为 0                     |
| 本轮不做 | `npm run dist:win` 重打包、`npm install`（剪 junction）、`remote/*`、`wechat/*`、`desktop/*`、元数据词典型在线管线、`GameVersionUpdateService`、`RuntimeMemoryMaintenance` |

---

## 0. 差异结论（先核账，再动手）

`git ls-remote origin HEAD` = `589b932`；本地检出 HEAD = `b397e0e`，`git cat-file -t a5a43f9` 报 `Not a valid object` ⇒ 三个差量提交**尚未 fetch**，N0 必须先 fetch。上游 `packages/protocol` 自锚点以来**只有 1 行改动**，移植面 `src/shared/sync/protocol.ts` 的冻结判据依然成立。

### 0.1 PC 侧差量清单（逐条来自 `.patch` 全文，非 API 截断列表）

| #   | 上游改动                                                                                                                                                                                                                                                                                                         | 本仓影响                                                                                                                                                                                                                                                                                                              | 落点节点           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| U1  | 新增 `inspiration/{InspirationRepository,InspirationRoutes}.ts`；`LocalSyncServer` 构造期**无条件** `new InspirationRepository(db)`，自建 `inspiration_sync_clock / _entries / _images` 三表（`CREATE TABLE IF NOT EXISTS`，无新迁移文件）；`/v1/inspiration*` 在所有路由之前挂载，逐请求走 `auth.verifyRequest` | ① `ServerInfoResponse.capabilities.inspirationV1` 本仓 vendored 缺此键；② 链接态用例只钉了 12 张迁移表 + `>=12`，对真值 17 个对象仍绿——**实测订正**：`tableNames()` 真值是 12 迁移 + 4 运行期自建（含自 K8 就在、却从未入列的 `organizer_deletions`）+ `sqlite_sequence`，原计划的「12→15」不成立，旧断言本就欠钉一张 | N1/N2/N3           |
| U2  | `packages/protocol`：`capabilities` 新增 `inspirationV1?: true`；`/v1/server` 恒为 true                                                                                                                                                                                                                          | 漂移守卫看不见它：`protocol-drift.test.ts` 只比 `AssetSummary` 成员集 + `API_ROUTES` 键数（12），`extractInterfaceMembers` 只扫深度 0，而 `capabilities` 是深度 1 嵌套                                                                                                                                                | N1                 |
| U3  | `row-mappers.ts`：`hasMotion` 改为要求 `asset_type === 'motion_photo'`；新增 `sourceParametersPresent/Complete/Checked`；剔除 `previousSourceMetadata`                                                                                                                                                           | 链接态 motion 聚合与样例断言需按上游翻转；渲染层 `src/renderer/components/sync/ShareCardDialog.tsx:99`（`type==='motion_photo' \|\| hasMotion`）仍成立，**不改**                                                                                                                                                      | N2                 |
| U4  | `scanner/types.ts`：`AssetSnapshot.assetType` 增 `'video'`、`DiscoveredResource.standaloneAllowed?`；新增 `scanner/NativePhotoLayout.ts`；`ExtraScanDirectories.inspect()` 把 HQ 选择收窄到本账号目录、拒 `CloudPhotos_LowQuality` 与 `Collage/LowQuality`                                                       | 本仓 `src/shared/sync/domain-types.ts:21` `ASSET_TYPES` **已含** `'video'`、`src/renderer/utils/assetViewModel.ts:85` 已按 video 分支 ⇒ 无产品码改动，仅 K6 目录夹具判据需核对                                                                                                                                        | N2                 |
| U5  | `server/AuthService.ts`：nonce 过期从 `now + skew` 改 `Math.max(now, ts) + skew + 1`                                                                                                                                                                                                                             | 只作用于 LAN 客户端；本仓移植面 `src/main/sync/auth-service.ts` 是**同语义自研**，须同步判据（否则两面分叉）                                                                                                                                                                                                          | N3                 |
| U6  | `organizer/DeletionQueue.ts`：`planFailure()` 把 hard-link/link/scope/ENOENT… 写成中文 `plan` 文案；整批拒绝 `queue_full`（`activeCount + additions > 500`）                                                                                                                                                     | **实测证伪**：`queue_full` 只在 `deletions.sync()` 抛出（上游 `LocalSyncServer.ts:240` catch 成 `400 bad_request`），而本仓 organizer 三面只调 `list/activity/decide/approveMany`（`runtime-manager.ts:936-949`）⇒ **不加 `ORGANIZER_ERROR_CODES` 映射**（加了就是无判据死码）                                        | N3（覆盖，不改码） |
| U7  | `LocalSyncServer`：`/v1/organizer/sync` 体上限 128→256 KiB；溢出改抛 `RequestBodyTooLarge` → **413**；`video/mp4` 的 Range 请求若 size/mtime 与索引不符 → **409 `resource_not_ready`**                                                                                                                           | 纯 LAN 语义，本仓无 handler 改动，仅真起上游服务的链接态用例补覆盖                                                                                                                                                                                                                                                    | N3                 |
| U8  | `server/AccountSyncSettings.state()`：账号 `samples` 加 `hasImage` EXISTS 判据（只取有稳定 `image/%` 预览者）；中文 label 文案改「…的照片和视频」                                                                                                                                                                | 本仓 handler 已剔 `label`、渲染层按 uid + i18n 出文案 ⇒ 仅「视频-only 账号样例为 0」的期望值需核对                                                                                                                                                                                                                    | N2                 |
| U9  | `server/MdnsAdvertiser` 重写：`listLanIpv4()` 每网卡独立 socket + `generation` + `retire()` + `setInterval(refresh,15_000)`                                                                                                                                                                                      | 本仓 `SYNC_SERVER_DEFAULT_MDNS=false` 的注释证据引自 `d4ca7d7`（2026-10-14）的 1,568,807 包/45s 自激实测；**防自环闸门（answer count==0 即返回）在锚点 b397e0e 已存在**（diff 里它是 context 行）⇒ 该默认值的理由已陈旧，必须复测再裁决                                                                               | N5                 |
| U10 | `MetadataResolverService` 增 `inputIsCurrent()` 在途失效复核；`packages/database/src/asset-repository.ts` 源字节替换时保留 `raw.previousSourceMetadata`、superseded 释放面拓宽到 `source_motion\|source_primary\|source_high_quality`                                                                            | 上游内部行为，随产物自动生效；装载链自 DEBT-040 修复后按 **import 闭包**校验，新模块自动入闸，`LOAD_CHAIN_ROOTS`（13 根）**不需改**                                                                                                                                                                                   | N0 读数            |
| U11 | `47ff829`：`ScanCoordinator.scanRoot` 增第 4 参 `validateExtraRoot`，`ScannerService` 对**合成** `ScreenShot` 根传 `false`，不再误报 `Directory unavailable`                                                                                                                                                     | 正是 **DEBT-041**（`docs/技术债清单.md:580`，`extra-scan-directories.test.ts:61` 撞 `resources.path_key` 唯一约束）的候选修复；技术债已写明「下一轮第一步复跑上游 `npm test` 销账」                                                                                                                                   | N0                 |

### 0.2 本轮要消灭的两个「静默搭载失败」机制

1. **能力位漂移盲区**（U2）：扩展漂移守卫到 `ServerInfoResponse` 顶层 + 深度 1 `capabilities` 成员集。
2. **表集欠钉**（U1）：由「12 张迁移表 `toContain` + `>=12`」改为 **16 名业务表闭集逐名相等**（12 迁移 + 4 运行期自建），派生的 `sqlite_sequence` 单列，让上游再加/删/改名表当场可见。

---

## 1. 依赖声明

| 项             | 事实 / 动作                                                                                                                                                                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm 依赖       | **零新增、零变更**（不 `npm install`/`npm update`——会剪断四条 junction，链接态用例集体降级为 skip）                                                                                                                                                                                                      |
| `@nikkisync/*` | 仍不在 `package.json` 声明；沿用 `npm run link:nikkisync` 建链（候选根 `NIKKISYNC_ROOT` → `../NikkiSync` → `vendor/NikkiSync`）                                                                                                                                                                          |
| 上游产物       | N0 推进检出的目标是 `589b932ebb5f3d7c18f7109cb91091f8eb563e2f`；`npm run build` 于 `../NikkiSync` 内执行，产物 `dist/src/**` 必须晚于全部源文件                                                                                                                                                          |
| 上游源码       | **一个字节都不改**；`git -C ../NikkiSync status --porcelain` 每节点复验为 0                                                                                                                                                                                                                              |
| 运行环境       | Node/Electron 不变；`../NikkiSync` 的 `npm test` 与 mDNS 探针需 `ELECTRON_RUN_AS_NODE=1 electron --import tsx`（原生 better-sqlite3 是 Electron ABI）                                                                                                                                                    |
| 新增文件       | 仅两类（三个脚本为**拟新增**，由 N5 落盘；本行即同行去向交代）：本计划文档、`scripts/sync-e2e/mdns-loop-probe.ts`（拟新增） + `scripts/sync-e2e/mdns-loop-verdict.ts`（拟新增）（U9 复测装置，纯判据函数与壳分离，沿用 `scripts/sync-e2e/launch-args.ts` 的分层与 `scripts/AGENTS.md` 的纯函数导出约定） |

---

## 2. 启动说明与验证方式

### 2.1 环境准备（顺序即前置）

```bash
git -C ../NikkiSync fetch origin
git -C ../NikkiSync checkout 589b932
git -C ../NikkiSync rev-parse HEAD                # 期望 589b932ebb5f3d7c18f7109cb91091f8eb563e2f
git -C ../NikkiSync status --porcelain | wc -l    # 期望 0
cd ../NikkiSync && npm run build && npm test      # 后者同时给 DEBT-041 销账读数
cd - && npm run link:nikkisync && npm run link:nikkisync:check   # 期望 check OK
npm run verify:nikkisync                          # 期望 blocking failures: 0，闭包命中 inspiration/*.js 与 scanner/NativePhotoLayout.js
```

### 2.2 开发启动

```bash
npm run dev
```

界面路径：图库数据源切「同步图库」→ 工具栏检索入口（N6）/ 同步服务页 → 「同步服务」状态区看 inspiration 能力位（N4）与 mDNS 开关（N5）。

### 2.3 验证命令（逐一在 `package.json` 核实存在，已实测键名）

| 目的         | 命令                                                                                                                                                                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 域内单测     | `npx vitest run src/shared/sync src/main/nikkisync src/main/preload src/main/ipc/handlers/nikkisync-handler.test.ts src/renderer/pages/sync-gallery src/renderer/stores/nikkisyncContractTypes.test.ts src/renderer/i18n/locales/sync-service-keys.test.ts` |
| 变更只读闭环 | `npm run verify` / `npm run verify:staged`                                                                                                                                                                                                                  |
| 类型三面     | `npm run typecheck` / `npm run typecheck:e2e`                                                                                                                                                                                                               |
| 静态与格式   | `npm run lint` / `npm run format:check`                                                                                                                                                                                                                     |
| i18n / 文档  | `npm run i18n:guard` / `npm run docs:links`                                                                                                                                                                                                                 |
| 装载链体检   | `npm run verify:nikkisync`                                                                                                                                                                                                                                  |
| 全量与覆盖率 | `npm test`（与 N0 基线对比**零新增失败**）/ `npm run test:coverage`                                                                                                                                                                                         |
| 依赖安全     | `npm run audit`（需网络；失败如实记 not-run 并附原因）                                                                                                                                                                                                      |
| mDNS 复测    | `ELECTRON_RUN_AS_NODE=1 electron --import tsx scripts/sync-e2e/mdns-loop-probe.ts --mdns true --seconds 60`（`--mdns false` 同窗口对照）                                                                                                                    |
| 打包态       | `npm run e2e:smoke` **本轮不跑**（需 `npm run build` 产物且用户裁决不重打包）；`dist:win` 明确不做                                                                                                                                                          |

已知既有现象：`npm run test:ci-linux` 在开发机为红（sharp 平台包 + 装置置根不可写），沿用 align-01 口径，不以它为判据。

---

## 3. 错误处理与参数校验

### 3.1 错误处理矩阵

| 场景                                                 | 处理                                                                                                     | 用户可见结果             |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------ |
| `../NikkiSync` fetch/checkout/build 任一失败         | 当场停轮，如实报读数；**不得**退回旧锚点继续改本仓（会造成「产物与源码不同代」假绿）                     | 无（开发期）             |
| `porcelain` 非 0                                     | 视为上游被污染，停轮并请用户裁示                                                                         | 无                       |
| `verify:nikkisync` blocking > 0                      | 按输出定位缺产物，先修产物代次再改码                                                                     | 无                       |
| 漂移守卫新用例红（`missing: [inspirationV1]`）       | 红灯即本轮目标状态；补 vendored 后转绿                                                                   | 无                       |
| 未链接（CI 常态）                                    | 链接态用例整件 `hasNikkiSyncLink()` skip，**不得**改成目录存在判定、**不得**加 `it.skip`                 | 无                       |
| 上游 `capabilities` 无 `inspirationV1`（老产物）     | 状态位**缺省不下发**（`...(x?{inspirationV1:true}:{})`），UI 不显示该行；不硬编码 true                   | 同步服务页少一行，不崩页 |
| 搜索/统计 IPC 失败                                   | 复用 `useErrorToast` + `extractUserMessage`；整节失败隐藏该节，不阻塞其余同步设置                        | toast / 区块隐藏         |
| 渲染层拿到 `asset_type:'video'` 且 `hasMotion=false` | 不改现有判据（`ShareCardDialog.tsx:99` 已同时看 type 与 hasMotion）                                      | 实况标识与上游一致       |
| mDNS 复测仍自激（≥300 包/60s）                       | **保持 `SYNC_SERVER_DEFAULT_MDNS=false`**，仅把注释证据更新为 `589b932` 实测数字，并把复测结论写入技术债 | 行为不变                 |

日志：不新增用户数据日志；`wrapHandler` 既有错误日志已覆盖。**禁止**把 UID 列表、绝对路径、灵感条目正文写入日志。

### 3.2 参数校验（zod，主进程单一入口）

本轮**不新增通道**，因此不新增 zod schema；下表为各节点复用的既有校验面（`src/main/ipc/handlers/nikkisync-handler.ts`）。

| 通道                                                                                    | schema                                                                     | 边界                                                                               |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `nikkisync:get-server-status`                                                           | 无参                                                                       | 响应新增**可选**字段 `inspirationV1?: boolean`（向后兼容：旧字段语义不变）         |
| `nikkisync:search-suits` / `:search-clothing`                                           | 既有 `searchSchema`                                                        | query 非空、长度上限沿用现值；N6 只加调用方，不改形状                              |
| `nikkisync:profile-stats`                                                               | 无参                                                                       | —                                                                                  |
| `nikkisync:start-server`                                                                | 既有 `syncStartSchema`（含 `mdnsEnabled: z.boolean().optional()`，`:122`） | N5 若翻默认位，须同步核 `:355` 的 `mdnsEnabled: false` 兜底对象是否仍与常量同源    |
| `nikkisync:get-organizer-queue` / `:decide-organizer-item` / `:approve-organizer-items` | 既有 `organizerIdSchema` / `organizerApproveSchema`                        | U6 的 `queue_full` 不经本通道 ⇒ 本轮不改 `ORGANIZER_ERROR_CODES`（避免无判据死码） |

---

## 4. 节点设计（每节点：文件 / 输入→输出 / 红灯 / 验收）

依赖图：`N0 → N1 → (N2 ∥ N3) → N4 → (N5 ∥ N6) → N7`。

### N0 · 落盘计划 + 推进上游检出 + DEBT-041 销账

- 文件：`docs/plans/2026-11-02-nikkisync-upstream-align-02-实施计划.md`（本文件入仓）
- 输入 → 输出：已批准计划 + 上游 `589b932` → 仓内可追溯文档 + 新代次 `dist/` 产物
- 取证：`npm -C ../NikkiSync test` 的 `extra-scan-directories.test.ts:61` 结果（DEBT-041 销账或续挂）；`npm test` 基线计数；`npm run verify:nikkisync` 闭包读数
- 验收：文档被跟踪；`npm run docs:links` 退出 0；`git -C ../NikkiSync rev-parse HEAD` = `589b932…` 且 `porcelain` = 0；基线与销账读数写入 §7
- 提交：`docs(plans): 落盘同步图库对齐 589b932 计划`

### N1 · 契约镜像补 `capabilities.inspirationV1` + 漂移守卫覆盖深度 1

- 文件：`src/shared/sync/protocol.ts`、`src/shared/sync/README.md`（锚点溯源 `b397e0e`→`589b932`）、`src/main/nikkisync/protocol-contract.ts`、`src/main/nikkisync/protocol-contract.test.ts`、`src/main/nikkisync/protocol-drift.test.ts`、`src/shared/sync/protocol.test.ts`
- 输入 → 输出：上游 `ServerInfoResponse`（含嵌套 `capabilities`）→ vendored 同形 + 「深度 1 成员集」比对能力
- 实现要点：① `inspirationV1?: true` **逐字按上游顺序**插入 `profileStats` 之后；② `protocol-contract.ts` 新增纯函数 `extractNestedObjectMembers(source, iface, member)`（深度 1 成员名集，零依赖、注释/可选标记不误判）；③ `protocol-drift.test.ts` 增两条链接态用例：`ServerInfoResponse` 顶层成员集零差异、`capabilities` 嵌套成员集零差异
- 红灯：新用例先失败，差异清单含 `missing: [inspirationV1]`
- 验收：`npx vitest run src/shared/sync src/main/nikkisync/protocol-contract.test.ts src/main/nikkisync/protocol-drift.test.ts` 全绿且 `0 skipped`；变异抽查（把 vendored 字段删掉）当场复红
- 提交：`fix(sync): vendored capabilities 对齐 589b932 并补深度 1 漂移守卫`

### N2 · 链接态断言随上游行为翻转

- 文件：`src/main/nikkisync/runtime-facade.linked.test.ts`（`BUSINESS_TABLES` `:40`、`>=12` `:331`、motion 聚合与 K9 样例夹具）、`src/main/nikkisync/metadata-resolver.isolation.test.ts`（若表集枚举涉及）
- 输入 → 输出：真上游会话产物 → 16 名业务表闭集 + `hasMotion` 新语义 + `samples` 只算有图账号
- 实现要点：① `BUSINESS_TABLES` 拆成 `MIGRATION_TABLES`（12）与 `RUNTIME_DDL_TABLES`（4：三张 inspiration + 早就存在的 `organizer_deletions`），`:331` 由 `>=12` 改按常量求和的精确数；② 会话创建用例改**闭集逐名相等**（含单列的 `sqlite_sequence`），不再用「至少包含」；③ motion/`video` 与 `samples` 两支以夹具实测为准——本仓夹具不经过被改动的分支（证据：推进检出后旧断言原样全绿），因此**不为凑红灯造夹具**，改由上游自有套件（`row-mappers.test.ts` / `account-sync.test.ts`）与本仓零转换透传断言承担
- 红灯：闭集断言在补表名前失败（少 4 名）；变异检验——从 `RUNTIME_DDL_TABLES` 删掉 `inspiration_sync_images` 一条即复红并在 diff 里点名该表
- 验收：`npx vitest run src/main/nikkisync/runtime-facade.linked.test.ts` 全绿、`0 skipped`
- 提交：`test(nikkisync): 表集闭集断言对齐 589b932（12 迁移 + 4 运行期自建）`

### N3 · LAN 新语义覆盖（只加测试 + 移植面 nonce 判据同步）

- 文件：`src/main/nikkisync/sync-server.linked.test.ts`、`src/main/sync/auth-service.ts`、`src/main/sync/auth-service.test.ts`、`docs/sync-integration/00-code-audit-report.md` §2（若签名基串记载需同步）
- 输入 → 输出：真起上游服务 → `GET /v1/server` 广告 `capabilities.inspirationV1 === true`、`/v1/inspiration*` 未签名 401 / 签名后可用（空列表、`limit` 边界、图片 PUT 的 sha256+magic byte 双校验与伪造哈希拒绝、条目幂等重放与改写冲突 409）、`/v1/organizer/sync` 300 KiB ⇒ 413 与 200 KiB ⇒ 401（后者才钉住上限 128→256）；移植面 `AuthService` nonce 过期判据改 `Math.max(now, ts) + skew + 1`。<br>**执行时订正**：变更视频 Range 的 409 `resource_not_ready` 不在本仓复刻——上游 `apps/pc-companion/test/local-sync-server.test.ts:112,152` 已钉且 roster 全绿，本仓复刻需新增视频种子夹具并改共享 `seedAsset`，属镀金，记为不做
- 红灯：移植面重放用例在改动前失败（超前时钟的请求被重放接受）；LAN 用例是「搭载证明」性质，其判别力由 401-vs-404、413-vs-401 两组对照断言保证（路由没挂或上限没抬都会红）
- 验收：`npx vitest run src/main/nikkisync/sync-server.linked.test.ts src/main/sync/auth-service.test.ts` 全绿；`grep -n "queue_full" src/main/ipc/handlers/nikkisync-handler.ts` **零命中**（证明未加无判据死码）
- 提交：`test(nikkisync): 覆盖 inspiration 端点与 413/409 LAN 语义；同步移植面 nonce 窗口判据`

### N4 · inspiration 能力位上屏（只读，零新通道）

- 文件：`src/main/nikkisync/runtime-types.ts`（`NikkiSyncSyncServerStatus` 增 `inspirationV1?: boolean`）、`src/main/nikkisync/sync-server-view.ts`（`buildSyncStatusSnapshot` 增可选入参并条件展开）、`src/main/nikkisync/sync-server-view.test.ts`、`src/main/nikkisync/runtime-manager.ts` / `runtime-facade.ts`（读真实 `serverInfo` 的能力位透传，不硬编码）、`src/main/ipc/handlers/nikkisync-handler.ts`（`@core-change` 替换）、`src/main/ipc/handlers/nikkisync-handler.test.ts`、`src/shared/types/electron-api.ts`（`NikkiSyncServerStatusInfo` 增可选字段）、`src/renderer/vite-env.d.ts`、`src/renderer/stores/nikkisyncContractTypes.test.ts`、`src/renderer/pages/sync-gallery/SyncServicePage.tsx` + `.test.tsx`、12 个 locale JSON、`src/renderer/i18n/locales/sync-service-keys.test.ts`、`docs/IPC_CONTRACT.md`
- 输入 → 输出：上游 `/v1/server` 的 `capabilities` → 状态 DTO → 同步服务页一行「灵感同步 v1：已启用/未启用」
- 红灯：`serverInfo` 注入含/不含该键两分支——不含时字段必须**缺省**且 UI 不渲染该行
- 验收：`npx vitest run src/main/nikkisync/sync-server-view.test.ts src/main/ipc/handlers/nikkisync-handler.test.ts src/main/preload src/renderer/pages/sync-gallery src/renderer/stores/nikkisyncContractTypes.test.ts` 全绿；`npm run typecheck` 退出 0；`npm run i18n:guard` 退出 0
- 提交：`feat(nikkisync): 同步服务页展示上游 inspirationV1 能力位`

### N5 · mDNS 默认位复测与裁决

- 文件：`scripts/sync-e2e/mdns-loop-probe.ts`（拟新增，探针壳：启服务 → 组播计数 → 输出读数）、`scripts/sync-e2e/mdns-loop-verdict.ts`（拟新增，纯函数 `classifyMdnsLoopReadings({onPackets, offPackets, seconds})` → `no_loop` / `feedback_loop` / `inconclusive`）、`scripts/__tests__/mdns-loop-verdict.test.ts`（拟新增）、`src/main/nikkisync/sync-server-view.ts`（常量 + 注释证据）、`docs/sync-integration/03-sync-server-plan.md` §15、`docs/技术债清单.md`（DEBT-041 销账 + mDNS 结论）
- 输入 → 输出：`589b932` 产物上 `mdns:true` / `mdns:false` 各 60s 的本次 serverId 公告包数 → 裁决 + 证据回写
- 判据（写进纯函数，不靠人眼）：`mdns:false` 同窗口 = 0 且 `mdns:true` < 300 包/60s（≈<5/s，对照旧证据 34,862/s）⇒ `no_loop`，翻 `SYNC_SERVER_DEFAULT_MDNS = true`；否则 `feedback_loop` ⇒ 保持 false，只更新注释为 `589b932` 实测数字
- 红灯：`npx vitest run scripts/__tests__/mdns-loop-verdict.test.ts` 先以缺文件失败（按仓库红-绿口径，壳不得长判据）
- 验收：单测全绿（正常/异常/边界三类）；`npx vitest run src/main/nikkisync/sync-server-view.test.ts` 随默认位翻转而同步（含 `resolveSyncServerConfig` 默认支）；A/B 两条读数写入 §7
- 提交：`feat(nikkisync): 复测并裁决 mDNS 默认位（589b932 证据回写）`

### N6 · 点亮检索与统计（`searchSuits` / `searchClothing` / `profileStats` 现零调用方）

- 文件：`src/renderer/pages/sync-gallery/SyncGalleryPage.tsx` + `SyncGalleryToolbar.tsx`（检索入口，复用既有 `MasonryView`/`VirtualImageGrid` 出结果）、`src/renderer/stores/syncGalleryStore.ts`（结果注入，沿用其按 asset id 去重与 `reset/loadFirst` 语义）、`src/renderer/pages/sync-gallery/*.test.tsx`、`src/renderer/pages/sync-gallery/SyncServicePage.tsx`（档案统计区块，复用 `SectionShell`/`Button`/`Switch` 与 CSS 变量，禁硬编码色）、`src/renderer/i18n/locales/*.json`（12 包真译文）+ `sync-service-keys.test.ts`、`docs/IPC_CONTRACT.md`（仅补「渲染层消费方」说明）
- 输入 → 输出：查询词 → `window.electronAPI.nikkisync.searchSuits/searchClothing` → 命中资产喂给现有列表；`profileStats()` → 统计卡片
- 实现要点：**不新增 IPC/preload 方法**（三面已在契约里），不新建 store，不改 `mediaStore.fetchAssetPage` 的分页协议；结果态经 `useMemo` 派生，禁止 JSX 内联变换；`getAssetDetail`/`getResource` 本轮不动（无实测价值判据，避免镀金）
- 红灯：页面用例先失败——搜索框发起 `searchSuits` 并把命中渲染为列表；档案统计在 `profileStats` 失败时整节隐藏且出 toast
- 验收：`npx vitest run src/renderer/pages/sync-gallery src/renderer/i18n/locales/sync-service-keys.test.ts` 全绿；`npm run i18n:guard` 退出 0；`npx eslint src/renderer/pages/sync-gallery` 零 error；`npm run format:check` 退出 0
- 提交：`feat(sync-ui): 同步图库接入套装/服装检索与角色档案统计（12 语言）`

### N7 · 文档回写 + 全量回归

- 文件：`src/main/nikkisync/AGENTS.md`（文件职责表补 `resource-allowlist.ts` 与本轮新事实；硬性约定补「能力位须从真实 serverInfo 读取」）、`src/main/sync/AGENTS.md`（nonce 判据同步说明）、`docs/IPC_CONTRACT.md`、`docs/sync-integration/README.md`、`docs/技术债清单.md` + `docs/debt-registry.json`（DEBT-041 销账；如复测仍未修则如实续挂）、本计划 §7
- 全量（逐项退出码记账）：`npm run typecheck`、`npm run typecheck:e2e`、`npm run lint`、`npm run format:check`、`npm run i18n:guard`、`npm run docs:links`、`npm run verify:nikkisync`、`npm test`（与 N0 基线**零新增失败**）、`npm run test:coverage`（阈值门）、`npm run audit`
- 验收：以上可跑项全部退出 0；`git -C ../NikkiSync status --porcelain` 仍为 0；提交后 `git status --porcelain` 无钩子遗留
- 提交：`docs(nikkisync): 回写 589b932 对齐读数与契约`

---

## 5. 基础测试用例矩阵

| 模块         | 正常                                        | 异常                                            | 边界                                                    |
| ------------ | ------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| 漂移守卫     | `capabilities` 成员集与上游零差异           | 上游缺 `ServerInfoResponse` 时给出 missing 清单 | 深度 1 不误扫深度 0；注释/可选标记不误判                |
| 契约镜像     | `inspirationV1?: true` 随 `/v1/server` 出现 | 老产物无该键 ⇒ 字段缺省                         | 上游顺序逐字一致                                        |
| 表集         | 16 名业务表闭集逐名相等                     | 缺任一 inspiration 表即红                       | 含 `sqlite_sequence` 单列；计数按常量求和               |
| `hasMotion`  | `motion_photo` + `source_motion` 为真       | `video` 带 `source_motion` 资源仍为假           | 本仓夹具不经过该分支 ⇒ 由上游自有套件覆盖，记录不造红灯 |
| 账号样例     | 有稳定图像预览的账号出 ≤3 样例              | 预览缺失不报错                                  | 视频-only 账号样例为 0（同上，夹具不覆盖）              |
| LAN 覆盖     | inspiration 端点签名可达                    | 免鉴权 401；体超 256 KiB 413；变更视频 409      | 空列表 `after=''`；`limit` 1..100                       |
| nonce 判据   | `ts` 为未来且 `< ts+skew` 接受              | 超出窗口拒绝、统一 401                          | `now == ts` 不越界；重放同 nonce 拒绝                   |
| 状态位上屏   | 一行「已启用」                              | `serverInfo` 读失败整节不留假值                 | 键缺席不渲染该行                                        |
| mDNS 判据    | on<300 且 off=0 → `no_loop`                 | 输入非整数/负数报错                             | on=300 临界归 `feedback_loop`；秒数 0 拒绝              |
| 检索/统计 UI | 命中渲染、统计出卡                          | `IpcError` → toast / 整节隐藏                   | 空结果、未装配、连点不重复发请求                        |
| i18n         | 12 包 key 等集                              | 缺键即红                                        | 全部非空串                                              |

---

## 6. 风险、回滚与不做项

| 风险                                                     | 处置                                                                                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 推进检出后，产物与本仓断言不同代                         | 严格执行 N0 顺序（fetch→checkout→build→link→verify）；任何节点失败即停轮，不混跑两代读数                                                                                  |
| inspiration 三表落进 `{userData}/nikkisync/nikkisync.db` | 上游 `CREATE TABLE IF NOT EXISTS` 自愈，本仓不加迁移；N2 精确钉表名以显形                                                                                                 |
| 翻 `SYNC_SERVER_DEFAULT_MDNS` 等于默认绑组播、TTL 255    | 仅在 A/B 实测达阈值时翻；否则保持 false 并更新证据；翻转是**单常量 + 单提交**，可即时回滚                                                                                 |
| 搜索/统计上线带来的路径与载荷面                          | 三者返回均为上游既有 DTO（含 `sourcePath`/`sourceFolder`，align-01 N2 已撤销裁剪），不新增授权面；`media://` 读取沿用 `src/main/nikkisync/resource-allowlist.ts` 既有规则 |
| 全量 `npm test` 时长 / `audit` 网络失败                  | 如实记录读数与 not-run 原因，不伪造绿灯                                                                                                                                   |

**不做项（附理由）**：`remote/*`、`wechat/*`、`desktop/*`（上游自带 UI/中继面，不在本仓应用表面，align-01 已记为不做项）；元数据词典型在线管线、`GameVersionUpdateService`、`RuntimeMemoryMaintenance`；灵感库列表/编辑器 UI；`ORGANIZER_ERROR_CODES` 的 `queue_full` 映射（实测不经本仓通道，加了即无判据死码）；`npm run dist:win` 重打包；`npm install`。

---

## 7. 实测读数回写位（执行时填写）

| 项                          | 读数                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 上游锚点复核                | `git -C ../NikkiSync rev-parse HEAD` = `589b932ebb5f3d7c18f7109cb91091f8eb563e2f`，`git tag --points-at HEAD` = `v1.0.30-public-beta.1`，`porcelain` = 0；`npm run link:nikkisync` 四条 links 全部 `ok`（`0 link(s) written`，本已在位）、`link:nikkisync:check` = **check OK**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 上游 `npm test`（DEBT-041） | **退出码 0**（构建 + 全 roster）。主 roster `tests 252 / pass 252 / fail 0`，末组 `tests 31 / pass 31 / fail 0`。DEBT-041 单文件隔离复跑 `apps/pc-companion/dist/test/extra-scan-directories.test.js` = `tests 26 / pass 26 / fail 0`，目标用例「default ScreenShot supplements collages without duplicating native photos and updates on native changes」由登记时的 17/16/**1 fail** 转 **✔ (14.861ms)** ⇒ **DEBT-041 销账**（修复来自上游 `47ff829` 的 `validateExtraRoot` + `a5a43f9` 的 `asset-repository` superseded 释放拓宽）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| N0 `npm test` 基线          | 推进检出**之前**实测：`465 passed (465)` 文件、`7391 passed \| 20 skipped (7411)`、53.90s、退出码 0。<br>推进检出**之后**、本仓零代码改动时复跑：`1 failed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 464 passed (465)`、`1 failed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 7390 passed | 20 skipped (7411)`——唯一失败是 `scripts/**tests**/check-md-links.test.ts > runCheck() 的死引用数为 0`，由本计划文档引用三个拟新增脚本路径触发（已按仓库约定补同行「拟新增」去向注解清偿）。<br>**关键取证**：装载锚点从 `b397e0e`推进到`589b932` 后，`src/main/nikkisync` 全部链接态用例（表集 / hasMotion / 扫描入库 / 真起 TLS 服务）**一条都没有转红** ⇒ §0.2 的「静默搭载失败」被实测证实而非推断，因此 N1/N2 守卫先行的顺序是必须的 |
| `verify:nikkisync` 闭包     | **blocking failures: 0**；`load chain closure resolves` = `resolved: 53 module(s) reachable from 13 root(s)`（上一轮为 50/13 ⇒ 新增 `inspiration/InspirationRepository.js`、`inspiration/InspirationRoutes.js`、`scanner/NativePhotoLayout.js` 自动入链，无需改 `LOAD_CHAIN_ROOTS`，DEBT-040 的闭包闸门按预期生效）；`inspirationV1?: true` 已在 `@nikkisync/protocol/dist/src/index.d.ts:68` 的 `capabilities` 末位确认                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| N1 红 → 绿读数              | 红（两段）：① 新纯函数与深度 1 用例先以 `TypeError: extractNestedObjectMembers is not a function` 失败（`4 failed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 52 passed (56)`）；② 函数实现后、补 vendored 字段前，漂移用例复红并报 **`missing: ['inspirationV1']`**——这一步才是真正的「搭载不全」复现，同时等价于变异检验（删字段即红）。绿：`npx vitest run src/shared/sync src/main/nikkisync/protocol-contract.test.ts src/main/nikkisync/protocol-drift.test.ts` = 3 文件 / **56 passed (56)**、**0 skipped**。如实记账：`ServerInfoResponse` 顶层成员集用例修复前即绿（它钉的是未来漂移面，不为凑红灯而伪造失败）。`extractInterfaceMembers`由按行切改为深度游标（与新函数共用`collectZeroDepthMembers`），原有 3 条纯函数用例与 AssetSummary 漂移用例同批转绿 ⇒ 重构无行为漂移                                                                                                                                                                                                       |
| N2 / N3 链接态              | **N2 完成**：红=闭集断言初次实跑报出真值差（`expected […15] to deeply equal […10]`，多出 3 张 inspiration 表 + 早该在册的 `organizer_deletions` + `sqlite_sequence`，据此把计划里的「12→15」订正为「12 迁移 + 4 运行期自建 + 1 派生」）；绿=`npx vitest run src/main/nikkisync/runtime-facade.linked.test.ts` **19 passed (19)**、`0 skipped`；变异检验=从 `RUNTIME_DDL_TABLES` 删 `inspiration_sync_images` 一条即复红并点名该表；同批 `src/main/nikkisync` 全域 **16 文件 / 330 passed (330)**、`metadata-resolver.isolation` + `metadata-isolation-guards` 15 passed，`npm run verify` 5 项全过。<br>**如实记账**：`hasMotion`（U3）与账号 `samples`（U8）两支未产生红灯——本仓夹具根本不经过被改动的分支（证据即 N0 那条「推进检出后旧断言原样全绿」），按「不为凑红灯造夹具」的原则交由上游自有套件（`row-mappers.test.ts` / `account-sync.test.ts`，本轮上游 26/26 与 252/252 全绿）覆盖，本仓不写只能恒绿的断言。<br>**N3 完成**：移植面 nonce 缺口先红——`expected { ok: true } to match { ok: false, reason: 'replayed_nonce' }`（`1 failed                                                                                                                                                                                                                                                                                                                                                                         | 25 passed (26)`），即超前时钟的请求在 `(now+窗口, ts+窗口]`区间可被重放；改`Math.max(now, ts) + skew + 1`后 **26 passed (26)**。LAN 侧新增灵感同步 v1 用例首跑即暴露一处**我的预期错了**：上游在冲突判定之前先比字节，同条目原样重放是幂等 200 而非 409，据此改成「幂等重放返回原 revision + 改写内容配陈旧 baseRevision 才 409」，并加`limit=0⇒400`、伪造 sha256⇒400、图片 GET 回原字节；organizer 一支写成正反两条（300 KiB⇒413 与 **200 KiB⇒401**），只有后者才能钉住「128→256」这条上限变化——单断 413 在上限没抬时也会绿。`sync-server.linked.test.ts` **14 passed (14)**、`0 skipped`。<br>**订正不做的一项**：变更视频 Range 的 409 `resource_not_ready`不在本仓复刻——上游`apps/pc-companion/test/local-sync-server.test.ts:112,152`已钉且本轮该 roster 全绿，本仓要复刻需新增视频种子夹具（改共享`seedAsset`），属镀金 |             |
| N4 状态位                   | **设计订正（计划原文不成立）**：上游 `LocalSyncServer.serverInfo()` 是**私有方法**，能力位没有公开读取面 ⇒ 无法「读真实 serverInfo」。改为观测装载事实 `server.inspirations`（上游在同一提交里既无条件构造该实例、又恒广告该位），并用链接态断言把「代理」钉成「等价」：`Boolean(session.server.inspirations) === (capabilities.inspirationV1 === true)`——上游哪天改成条件构造或摘掉广告位，这条当场分叉。<br>另一处订正：`nikkisync:server-status` 是 `{ available: true, ...runtime.syncStatus() }` 原样展开 ⇒ **不需要改受保护的 handler，也不需要 `@core-change`**，计划里那一列属多余。<br>读数：`npx vitest run sync-server-view.test.ts runtime-manager.test.ts sync-gallery sync-service-keys.test.ts nikkisyncContractTypes.test.ts` = 8 文件 / **234 passed (234)**；`npm run i18n:guard` 退出 0；`npm run verify` 5 项全过。<br>**判别力以变异取证替代红灯**：① 删 `buildSyncStatusSnapshot` 的条件展开 ⇒ 纯函数正向用例 + manager 用例复红（负向用例按设计仍绿，它防的是假阳性）；② 把渲染层门控改成 `status &&` ⇒ 缺席用例 (bk) 复红；合跑 `3 failed / 190 passed`，逐条可归位。12 语言包各 +2 行（行级插入，未重排 JSON）                                                                                                                                                                                                                                                                                    |
| N5 mDNS A/B 包数与裁决      | 判据先红（`Cannot find module '../sync-e2e/mdns-loop-verdict'` → 6 例；补 `parseMdnsProbeArgs` 前再红 3 例）→ 绿：**9 passed (9)**。实跑 `npx tsx scripts/sync-e2e/mdns-loop-probe.ts --seconds 60`（先用 12s 短窗验机件，`on=1 off=0`）：正式窗口 **`on=4` / `off=0` / 60s**，速率 0.067 包/秒，阈值 5 包/秒 ⇒ **`no_loop`**，与旧证据 34,862 包/秒差约 52 万倍（4 条 = t=0/15/30/45 的周期公告，正是健康形态）。据此按预案翻 `SYNC_SERVER_DEFAULT_MDNS = true`；翻转当场暴露 3 条把旧默认写死的用例（`sync-server-view.test.ts` 默认值例、`runtime-manager.test.ts` 回落例与会话重建例），逐条改为新现实，并把会话重建用例改成「显式关 mdns」方向以保留其判别意图 ⇒ `src/main/nikkisync + app + ipc + preload + sync-gallery` **93 文件 / 1675 passed**、0 失败。<br>证据回写：`docs/sync-integration/03-sync-server-plan.md` §15 末新增「复测订正」块（保留 10-14 原文备查），并同步该文件配置表行、验收项 8、§13/§14 指针与「待翻回」条目；`scripts/AGENTS.md` 登记两个新脚本与「脚本 import 主进程模块」的**例外三**（零 electron import、plain Node 可跑）                                                                                                                                                                                                                                                                                                                                                           |
| N6 渲染与 i18n              | 新增 `SyncInsightPanel.tsx`（折叠面板：套装/服装检索 + 档案统计），挂进 `SyncGalleryPage` 正常分支。**零新通道、零新 preload 方法**——三条通道与 DTO 早已在册，缺的只是调用方。<br>设计订正两处：① 原计划「命中喂进现有网格」不成立——网格项需要 `resources` + `pathsByResourceId` 才能出图，而 `searchSuits/searchClothing` 只回 `photos[].asset` 摘要，补齐要按 assetId 回捞资源记录并走 `media://` 授权；本轮改为**文本命中榜**（含命中部件名/所属套装，解释「为什么命中」），把回捞留作后续，避免顺手扩大改动面。② 插值参数刻意用 `{{n}}` 而不是 `{{count}}`：i18next 见 `count` 会走复数键查找，12 个语言包就得各写 `_one/_other`。<br>统计段**首次展开才发请求**（本页 keep-alive 常驻，无条件拉取会让每次进图库多两次 IPC），用例钉住「折叠时 0 次、展开 1 次、重复展开不再发」。<br>读数：`SyncInsightPanel.test.tsx` **7 passed (7)**（桥缺失不渲染 / 套装命中 / 服装命中且不误打套装通道 / 空关键词不发请求 + 无命中空态 / 检索失败内联 / 统计懒加载 / 统计失败降级）；`src/renderer/pages/sync-gallery + i18n` **11 文件 / 136 passed**；17 个 `syncGallery.insight.*` 落进 12 包并通过 `sync-gallery-keys.test.ts` 的 REQUIRED_KEYS 与同构检查；`npm run i18n:guard` 退出 0；`npm run typecheck`（含 scripts 面）通过；`npm run verify` 5 项全过。<br>**如实记账（流程偏差）**：本节点的组件与用例同批写成，未取到「修复前红灯」；改以变异检验补证判别力——把作用域分支强制成 `suits` 后服装用例即复红（`1 failed | 6 passed`），复原后转绿。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| N7 全量回归 + coverage      | 逐项退出码：`typecheck` 0 / `typecheck:e2e` 0 / `lint` 0 / `format:check` 首轮 **1**（我把两枚 AGENTS.md 的表格手搓对齐、未过 prettier，`--write` 后转 0）/ `i18n:guard` 0 / `docs:links` 0 / `verify:nikkisync` 0（blocking failures: 0）/ `npm test` **467 passed (467)**、`7418 passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 20 skipped (7438)`、0 失败 / `test:coverage`0（All files 71.45 / 62.96 / 64.5 / 73.05，阈值门过，较上一轮 70.46 / 61.93 / 63.4 / 72.11 上移）/`audit` 0（`Passed npm security audit.`，仅既有 allowlist 提示）。<br>与 N0 基线对比：`465 → 467` 文件、`7391 → 7418` 用例（+27），**零新增失败**；`20 skipped` 口径不变。`git -C ../NikkiSync status --porcelain`全程 0，HEAD 仍为`589b932`。                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| not-run 清单                | ① `npm run dist:win` 未跑（用户裁决本轮不重打包）⇒ **2.5.6 安装包内的上游产物仍是 `b397e0e` 代次**，灵感端点、ScreenShot 别名修复、mDNS 默认位与能力位都要等下一次打包才真正进用户机器；② `npm run e2e:smoke` 未跑（需 `npm run build` 产物树，且 `dist/main` 与打包态守卫相连，本轮不产生产物）；③ Electron GUI 手工冒烟未跑——新面板 (N6) 与能力位行 (N4) 由 7 + 2 条组件用例覆盖，复现命令 `npm run dev` 后进「图库数据源=同步图库」看折叠面板、「同步服务」页看灵感行与 mDNS 开关；④ mDNS **跨设备发现**未实测：探针只证明本机不再有自激洪水（发送侧安静），真机 browse/解析是另一件事，§15 的「未验证」边界保持不变；⑤ 上游 `remote/*`、`wechat/*`、`desktop/*`、词典型在线管线等未移植（用户裁决的范围内不做，见 §6）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

---

## 8. 提交边界与执行纪律

- 每节点一个 Conventional Commit；**红灯与修复同一提交**（lint-staged 会拒带失败用例的提交，禁止 `--no-verify`）。
- 受保护路径（`src/main/ipc/handlers/**`、`src/main/preload/api/**`）实质改动须**替换**为一条本轮真实原因的 `// @core-change:` 注释，同批提交。
- 通道响应形状变更必须同步 `docs/IPC_CONTRACT.md`，只加可选字段（向后兼容）。
- 最小 diff：不夹带格式化/重构；`npm run format` 只作用于改动文件；新脚本走 `tsx` 且入口壳与纯判据分离。
- 每节点完成即跑该节点验收命令 + `npm run verify`；全部节点完成才进 N7 全量回归。回归未全绿，任务不得结束。
