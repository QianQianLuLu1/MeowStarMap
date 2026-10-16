# 阶段 6：同步元数据解析能力补充（NikkiSync resolver 注入）

> 生成日期 2026-10-16 · 基线 Gallery `f124e28`（branch `feat/gallery-runtime-embed`）· 上游 NikkiSync `d4ca7d7`
> 唯一真相源：`src/shared/sync/protocol.ts`（协议契约）；范围依据：任务委托方阶段 6 说明 + 本文件 §0 取证
> 铁律：原有扫描器主权不可侵犯 · 不碰 `media_files` 及任何原有表 · 不碰 NikkiSync 任何源文件 · 不新增第二个 SQLite 连接 · 不 commit / push

## 0. 步骤 0 执行记录（代码同步与现状取证，已完成）

| 动作           | 现场命令                                                                                                                                                                                                                                         | 原始输出与判定                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 上游同步       | `git fetch origin`（在 `NikkiSync/`）                                                                                                                                                                                                            | 无新对象；`git rev-list --left-right --count origin/main...HEAD` ⇒ `0 0`，HEAD `d4ca7d7` 即 GitHub 最新；`git status --short` 空 ⇒ **无需 pull / 无本地改动**             |
| 核心源文件复核 | 读 `runtime.ts` / `MetadataResolverService.ts` / `Nuan5CompatibleResolver.ts` / `MetadataResolutionDiagnostics.ts` / `SuitSearchIndex.ts` / `ClothingSearchIndex.ts` / `row-mappers.ts` / `asset-repository.ts` / `change-journal-repository.ts` | API 无破坏性变更；`capture` 不在 resolver 返回键集内（校正 A）；`clothes` 契约为裸数字数组（校正 B）                                                                      |
| 两套扫描机制   | 读 `src/main/scanner/**`（原有扫描器，utilityProcess + `media_files`）与 `apps/pc-companion/src/scanner/**`（内嵌面，`node:sqlite` + `assets/resources`）                                                                                        | 原有扫描器**没有任何文件监听器**（全仓 `fs.watch/chokidar` 命中为零），增量靠 mtime 比对；两侧扫描各写各表，重叠根目录的代价是双份 sha256（既有已记录，本阶段不新增监听） |
| 依赖链接       | `npm run link:nikkisync:check`                                                                                                                                                                                                                   | 四包 junction 全 `ok`，`check OK`                                                                                                                                         |
| 装载面诊断     | `npm run verify:nikkisync`                                                                                                                                                                                                                       | 10 项全绿，`blocking failures: 0`                                                                                                                                         |
| 基线可构建     | `npm run typecheck`                                                                                                                                                                                                                              | `tsc -b && tsc -p tsconfig.scripts.json` ⇒ 退出码 0                                                                                                                       |
| 未执行         | ~~`npm install`~~                                                                                                                                                                                                                                | **刻意跳过**：`src/main/nikkisync/AGENTS.md` 硬性约定 6 —— install 会剪掉四个 junction，使链接态用例集体降级为 skip，把真实回归藏起来                                     |

### 0.1 本阶段新增的、会改变方案的取证

| 事实                                                                 | 证据                                                                                                                                                                                              | 后果                                                                                                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本机 25/25 静图三件齐（token + payload ~48KB + 合法 32 位 MD5）      | 只读 SQL `metadataResolutionDiagnostics` 口径：`withCompleteEnvelope=25/25`、`minChars 47936 / maxChars 48236`、`md5HexLooksValid=25`                                                             | **准入门 PASS**：不存在「resolver 100% 写 failed」的退化分支                                                                                            |
| `capture` 由上游扫描器写死为空对象                                   | `NikkiSync/apps/pc-companion/src/scanner/ScanReconciler.ts:106` 字面量 `capture: {}, camera: {}`；`Nuan5CompatibleResolver.ts:53-61` 返回键集**不含** `capture`                                   | 验收目标里的「`capture` 非空」不可达，改为「`camera` 停止为空对象」                                                                                     |
| NUAN5 的 `clothes` 是裸数字数组，两个搜索索引第一行就丢              | `apps/pc-companion/test/metadata-resolver.test.ts:175/198`（fixture 与断言）+ `server/SuitSearchIndex.ts:132` / `ClothingSearchIndex.ts:73`（`objectOf(rawClothing); if (!clothing) continue`）   | 只接 resolver **不会**让 `search-suits`/`search-clothing` 可用；需字典 manifest ⇒ 列为 Phase 6b（`runtime.ts:24` 接受本地内存对象，无需第二个网络出口） |
| `hasMetadata` 只看非空                                               | `row-mappers.ts:132` `Boolean(row.metadata_json)`，本机 31/31 已非空                                                                                                                              | 抽屉那一行现在就是「是」，本阶段不改变它                                                                                                                |
| 本仓拆除路径既不调 `runtime.start()` 也不调 `runtime.stop()`         | `runtime-manager.ts:10-12` 头注释 + `teardown:195-223` 只做 `server.stop → scanner.stop → dispose`；上游 `runtime.ts:99` 是 `metadataResolver.start()` 唯一 arm 点、`:108` 是 `stop()` 唯一调用点 | 15s 定时器今天**靠巧合**不会被 armed ⇒ 节点 5 把它焊成契约测试                                                                                          |
| `intervalMs` 用 `??` 取值、`enabled:false` 让 `runOnce()` 直接返回 0 | `MetadataResolverService.ts:49` / `:68`                                                                                                                                                           | 禁止下发 `intervalMs:0`；「关闭」的落地形态必须是**连键都不下发**                                                                                       |

## 1. 依赖声明

- 上游四包经 `npm run link:nikkisync` 建的 junction 引入，`package.json` 依赖节零改动（`scripts/__tests__/self-contained-deps.test.ts` 会拦截仓库外 `file:`/`workspace:`）。
- 本阶段新增使用的上游符号与取法（`apps/pc-companion/dist/src/index.js` 的桶只 re-export `metadata/MetadataResolverPipeline.js` 与 `metadata/types.js`，已实测）：
  - `Nuan5CompatibleResolver` ⇒ 深入口 `['metadata','Nuan5CompatibleResolver.js']`（该模块只 `import type`，运行时零上游依赖，装载它不产生网络副作用）。
  - `metadataResolutionDiagnostics` ⇒ 深入口 `['metadata','MetadataResolutionDiagnostics.js']`（纯 SELECT 聚合计数，绝不序列化行 / 原始信封 / 错误原文）。
- `NIKKISYNC_REQUIRED_EXPORTS` **不新增**这两项：`probe.ts:249` 是在**桶导出**上做存在性判定，桶外符号写进去会让探针在正确的构建产物上报红。产物守卫改由 `scripts/verify-nikkisync-link.ts` 的 `METADATA_REQUIRED_ARTIFACTS` 承担（节点 2）。此例外已在 `runtime-facade.ts` 深入口常量注释与 `src/main/nikkisync/AGENTS.md` 记录。
- 网络出口：新增**恰好一个** `https://nuan5.pro/api/decode-photo2`，默认关闭、需显式开启。**不**接远端字典 provider、**不**接图标下载缓存 —— 阶段 5 §9 的其余禁令继续有效。
- 本阶段**推翻**阶段 5 §9 中「不接远端 resolver」一条（由任务委托方在选择中明确授权），其余不动。

## 2. 启动与运行说明

- 设置键 `nikkisync.metadataResolverEnabled`，默认 `false`；env 逃生阀 `NIKKI_NIKKISYNC_METADATA=1/0` 优先于设置项。
- 关闭 ⇒ 传给 `PcCompanionRuntime` 的配置里**没有 `metadataResolver` 这个键**（不是 `{enabled:false}`；上游 `runOnce()` 首行 `if (!this.config.enabled) return 0` 会让手动驱动一起空转）。
- **不使用上游 15s 自轮询**：上游 `runtime.start()` 把 `scanner.start()` 当硬前置并随后无条件 `server.start()`（绑 `0.0.0.0`），与本仓「LAN 服务显式 opt-in」的边界冲突；改由本仓在**扫描结束后**有界驱动 `runOnce()`，且**不挂在扫描 IPC 的返回路径上**（fire-and-forget）。
- 驱动参数：`batchSize: 4`（上游默认 12，收窄以摊薄 revision 抖动与单轮墙上时间）、`maxPasses` 默认 50（⇒ 单次最多 200 条，够中型库一次扫完；上限只防「候选持续非零」的异常情形）、`retryAfterMs` 吃上游默认 10 分钟、**绝不下发 `intervalMs`**。
- 生效时机：设置改动需重建会话（重启，或换根 / 改端口触发的重建）。UI 文案写「需重启应用后生效」，本阶段不做 apply-now。

## 3. 架构决策

- **D-1 单缝注入，不建独立服务**。新建服务需自行 compose `ScanCoordinator`+`ScanReconciler`+`MetadataResolverService`，会新增**第二个 `node:sqlite` 句柄指向同一个 `nikkisync.db`**（该库有既有事故记录：句柄泄漏在 Windows 上锁死库直至重启，见 `runtime-facade.ts:416-418/456-463`），且违反「不新增第二个 SQLite 连接」。→ 否决。
- **D-2 不用 `composeMetadataResolver`**：它静态 import 4 个字典 provider 模块，为一个只要 NUAN5 的场景把远端字典出口拖进模块图。→ 直取 `Nuan5CompatibleResolver` 深入口。
- **D-3 不用 `MetadataResolverConfigFile`**：上游磁盘 hot-update 面，endpoint 可被外部 JSON 改写且本仓不校验。→ 显式下传常量端点，使披露文案与实际出口同源。
- **D-4 渲染层零改动**：五个面板已由本地解密链出值；而 `interactions` 无任何上游写入路径、`filter/lighting` 只有 ID 无名字（需字典）→ 做 metadata 优先层会得到「覆盖面更小的数据压过本地解密」的净退化。阶段 5 §11.3 的 D-C 层继续推迟。
- **D-5 不加新 IPC 通道**：解析状态挂进 `NikkiSyncRuntimeStatus` 的可选 `metadata` 段，由现有 `nikkisync:runtime-status`（`wrapHandlerNoArgs` 逐字透传）带出 → 不触受保护路径、不触发 `@core-change` 闸门、不动 `preload.test.ts` 键数断言、不动 `vite-env.d.ts`。
- **D-6 不尝试 LIVE 解析**：6 条 motion_photo 封面用 `%PAPERGAMES%` 成对分隔符，上游 `ResourceClassifier` 从不解析；它们因候选 SQL 要求 `$.raw.nativeParamToken IS NOT NULL` 而天然不入队，无需额外过滤。
- **D-7 驱动改为不挂扫描返回路径**（执行期决策）：初版 `await driveMetadata()` 会让 `nikkisync:start-scan` 被上百条候选阻塞数十秒；且 `maxPasses=5` 时单次只能推进 20 条，大库永不收敛（正是上游 `467b590 fix(pc): continue first-run metadata parsing beyond the first batch` 修过的饥饿问题）。

## 4. 子任务分解

| #   | 修改/新增文件                                                                                                                                                                                | 输入 → 输出                                                                            | 验收标准                                                                                                                                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0-1 | 无改动（只读取证）                                                                                                                                                                           | 本机 db → `withCompleteEnvelope/25`                                                    | ≥20/25 三件齐才继续；实测 **25/25 PASS**，退出码 0                                                                                                                                                            |
| 0-2 | 无改动（人工，需逐条同意）                                                                                                                                                                   | 1 个本机信封 → 端点响应结构摘要                                                        | 判定 `clothes` 是裸 number 还是带 `name/suitName` 的对象。**本阶段未执行**（一次真实第三方请求，须显式授权）                                                                                                  |
| 1   | `runtime-facade.ts`（两个深入口常量 + `RuntimeSurface` 两面 + 两条 `loadDeepModule`）、`runtime-facade.test.ts`                                                                              | projectRoot → 两个 `file://` URL 且导出名存在                                          | 红灯 1 failed/17 passed → 绿灯 18 passed；真装载实测 `Nuan5CompatibleResolver` 是 function、`id='nuan5-compatible'`                                                                                           |
| 2   | `scripts/verify-nikkisync-link.ts`（`METADATA_REQUIRED_ARTIFACTS` + 新检查项）、`scripts/__tests__/verify-nikkisync-link.test.ts`                                                            | 缺产物 → fail 级并点名                                                                 | 红灯 2 failed → 22 passed；`npm run verify:nikkisync` 现场打印 `present: dist\src\metadata\...`；实测 `asarUnpack` 首项 `**/@nikkisync/**` 已覆盖 ⇒ **package.json 无需改**                                   |
| 3   | **新** `src/main/nikkisync/metadata-resolver-driver.ts` + `.test.ts`                                                                                                                         | `(env,settings)→bool`；`(input)→配置片段`；`(service,{maxPasses,generation})→驱动结果` | 15 例：OFF 不建键、ON `batchSize===4` 且永不含 `intervalMs`、端点必须 https、`runOnce` reject ⇒ 驱动 resolve 且 warn 恰一次、代次变更即停轮                                                                   |
| 4   | `runtime-facade.ts:408` 注入缝 + 会话返回 `stopMetadataResolver`/`metadataRunOnce`/`metadataDiagnostics`；`runtime-types.ts`（窄面 + `metadata?` 状态 + 计数形状）；`runtime-facade.test.ts` | options → `RuntimeCtor` 配置                                                           | 红灯 6 failed/18 passed → 24 passed；`src/main/nikkisync` 全量 186/186（含链接态真实会话）；构造失败句柄归还逻辑一行未改                                                                                      |
| 5   | `runtime-manager.ts`（代次 + `teardown` 最前插 `metadataResolver.stop` + 扫描后不挂返回路径的有界驱动 + `status().metadata`）、`runtime-manager.test.ts`、`FakeSessionPlan` 扩容             | stop() → 拆除序列；scan() → 结果 + 后台驱动                                            | 45 例：`runtime.start` 间谍恒 0 次、`stopMetadataResolver` 恰 1 次且早于 `dispose`、其抛错不阻断其余清理、扫描失败 ⇒ 0 轮、扫描已返回而驱动仍在飞 ⇒ 拆除后不再发起第二轮                                      |
| 6   | **新** `metadata-isolation-guards.ts` + `.test.ts`、**新** `metadata-resolver.isolation.test.ts`                                                                                             | SQL 文本 / `:memory:` 真库 → 不变量                                                    | 两档：结构档（任何 Node 必跑，同步面源码不含指向原有库表的 SQL 引用）+ 语义档（`node:sqlite` 逐字执行上游三条 SQL，`media_files` 行数/列结构/内容三不变）；15 passed                                          |
| 7   | `nikkisync-runtime-setup.ts`（设置键/env/默认关/判定/塞值）、`src/shared/settings-keys.ts`、`sync-sections.tsx`（开关 + 常驻披露段）、12 个 locale `settings.sync.metadata.*`、两份测试      | 渲染层写 → 主进程读                                                                    | 25 + 16 + 8 例；`i18n:check` 3932 键全语言对齐；`i18n:guard` 通过；披露含「发 UID+信封给 nuan5.pro」「写本机库」「随局域网下发已配对设备」「需重启生效」「搜索仍需字典」                                      |
| 8   | **新** `metadata-resolver.linked.test.ts`（`hasNikkiSyncLink` 门控 + `preloadedSurface` 注入假解析器，零网络）                                                                               | 播种 25 photo + 6 motion → 真上游                                                      | 6 passed：`camera` 落库、**只有 25 条入队**且 6 条 motion 恒 `{}`、`asset.updated` 恰 25 条、`library_revision` 恰 25、裸数字 `clothes` 下两个搜索 `items` 为 `[]`（把「resolver 不足以让搜索可用」钉成回归） |
| 9   | 本文件、`docs/IPC_CONTRACT.md`、`src/main/nikkisync/AGENTS.md`、`docs/技术债清单.md`                                                                                                         | —                                                                                      | §11 逐节点红灯→改动→绿灯→真实退出码；§11.1 偏差记录                                                                                                                                                           |

## 5. 错误处理与兜底

- **驱动层绝不把 resolver 错误上抛给扫描链**：整体 `try/catch` → `log('warn')`，不改 `scan()` 返回值（上游 `ScanResult` 逐字透传，被 `nikkisync-handler.test.ts:192-199` 既有断言锁定）。
- `MetadataResolverService.runOnce()` 外层只有 `try/finally` **无 `catch`** ⇒ 候选 SELECT 或 `updateMetadata` 的 DB 错直接上抛；不兜住就是 `unhandledRejection`，会打向 `app/error-handlers.ts` 的分级策略（可能弹致命报告窗）。
- **不假装能取消在飞请求**：`runWithTimeout` 超时只让 Promise resolve，**不中断**在跑的 `runOnce`，会让拆除期与 `updateMetadata` 事务重叠。做法是 generation token —— 拆除递增代次，驱动在**每轮开始前**比对，代次变了只停止发起下一轮；在飞 fetch 由上游 12s abort 看门狗收敛，结果因代次失效丢弃。
- 单轮墙上时间：`batchSize=4` ⇒ ~4×(1s 节流 + RTT)；端点全挂 ⇒ ~48s/轮。
- `stopMetadataResolver` 是**同步幂等**调用 ⇒ 用普通 `try/catch` 而非 `withTimeout` 包（包一层只会凭空造出一个要等的定时器）；它在拆除序列最前，早于 `server.stop`。
- 退出链：`cleanup.ts:127 stopNikkiSyncRuntime` 已在 `:156 dbManager.close()` 之前；未开 resolver 时 `runtime.metadataResolver === undefined` ⇒ no-op。
- fail-open 语义不得反转：Runtime 关闭 / 未建链 / 无游戏目录时应用照常启动（阶段 2 验收 5），本阶段零新增阻塞路径。

## 6. 参数校验

- env 只认 `'1'`/`'0'`，其他值视为未设置；设置值必须是布尔 `true` 才判开（脏值 `'true'`/`1` 一律判关 —— 开启即出站请求，绝不能被一条脏数据静默打开）。
- `batchSize` 钳到 `[1,12]`、`maxPasses` 钳到 `[1,200]`，非有限/非正回落默认（驱动层自校验，不依赖上游 `Math.max(1, Math.floor(x))`）。
- `endpoint` 构造期校验：必须是 https；空值与非法 URL 各给可定位原因。该值只由主进程常量决定，**不经 IPC 传参**、不接受渲染层任意字符串。
- 深入口段名沿用 `resolveDeepEntryUrl` 既有校验（纯名字、`.js`/`.mjs` 结尾、拒绝 `.`/`..`/分隔符/非 ASCII）。

## 7. 风险

- **R1 期望差**：`dressing.clothes` 是裸 ID ⇒ 套装/服装搜索仍为空。已由节点 8 的链接态断言固定；文案与 §9 明说。
- **R2 隐私与局域网响应体扩大**：`row-mappers.ts:19-31 publicMetadata()` **只**剥 `raw.nativeParamPayload` 与 `raw.nativeParamNuan5Md5`；`mapDecodedPhoto` 写的 `raw.nuan5`（整个远端 photo 对象）与 `MetadataResolverService.ts:156` 写的 `raw.resolverResponse` **不剥离** ⇒ 已配对手机会收到第三方解码结果全文。已写进设置页披露文案。
- **R3 单调膨胀**：`asset-repository.ts:10-19 mergeMetadata` 深合并**不清旧键** ⇒ `raw.nuan5`/`raw.resolverResponse` 一旦写入只叠加不回收。
- **R4 revision 抖动**：每解析 1 条 `library_revision` +1；`searchSourceCache` 按 revision 缓存 ⇒ 下一次搜索整库重建；`resource-allowlist` 在 revision 变化时整表 clear（`media-protocol` 规则 4 只是 fast-path，未命中回落 DB 规则 ⇒ 已入 `media_files` 索引的资产不裂图，未入索引者存在回归风险）。`batchSize:4` 分批 + 只在扫描后跑，缓解不消除；开启后需人工翻页复验。
- **R5 泄漏安全靠巧合**：今天 15s interval 不 armed 仅因 `runtime.start()` 永不被调；节点 5 的断言把这个巧合焊成契约。
- **R6 覆盖率**：阈值 66/58/59/68 且 `all: true`，`*.linked.test.ts` 缺 junction 整件 skip ⇒ 每个新源文件都配了非门控单测。
- **R7 不可单测项**：真机开关联调、真实端点响应形态、上百张串行解析的实际墙钟耗时 —— 不得从单测宣称绿色。

## 8. 明确不做的事

1. 不碰 `src/main/scanner/**`、`src/main/media-worker/**`、`src/main/thumbnail/**`。
2. 不碰 `media_files` 及任何原有表：不写、不加列、不改索引（阶段 2 的 `sha256` 先例不援引）。
3. 不改 NikkiSync 任何源文件（只 import）。
4. 不接远端字典 provider、不接图标下载缓存、不建第二个网络出口。
5. 不动 `nikkisync.watcherEnabled`（false）、不动 `nikkisync.syncMdnsEnabled`（false，上游组播自反馈 ~35k 包/秒）。
6. 不做 motion_photo 的 LIVE 解析；不为其伪造或借用相似照片的参数。
7. 不做渲染层 D-C metadata 优先层、不加新 IPC 通道、不建独立同步元数据服务、不开第二个 SQLite 连接。
8. **不执行 `npm install`**；**不执行 git commit / push**。

## 9. 验证

```bash
npm run link:nikkisync:check && npm run verify:nikkisync
npx vitest run src/main/nikkisync src/main/app src/renderer/pages/settings scripts/__tests__
npx vitest run src/main/scanner src/main/media-worker        # 原有扫描器回归
npm run typecheck && npm run lint && npm run i18n:guard && npm run i18n:check
npm test && npm run test:coverage
git status --porcelain
```

手工验收（本机装有游戏时）：

1. 开关**关闭**下扫描：零 `nuan5.pro` 请求；`camera` 仍 `{}`；原有扫描/缩略图/pHash/重复检测正常；关同步服务后原有功能不受影响。
2. 开关**开启**后重启并扫描：`withCamera` 计数 = 非空 `camera` 的资产数；`raw.nuan5`/`raw.resolverResponse` 出现（预期副作用，非缺陷）。
3. 五个参数面板仍从本地解密链出值且未退化；同步图库翻页无裂图（R4）。
4. `media_files` 行数与 `PRAGMA table_info` 与开关前逐字节一致。

## 10. 开放项（需委托方决定）

- 节点 0-2 是一次**真实的第三方请求**（含 UID + 参数信封），执行前需逐条同意，不由本阶段自动发起。
- Phase 6b：本地字典 manifest（零网络出口，让套装/服装搜索真正可用）是否纳入下一轮。
- R2 的下发面扩大是否可接受：零改动前提下本仓无法阻止上游写 `raw.resolverResponse`，只能向 NikkiSync 上游提 issue。

## 11. 执行记录（回填）

### 11.0 基线（改动前）

| 命令                            | 退出码 | 原始输出                                                                                               |
| ------------------------------- | ------ | ------------------------------------------------------------------------------------------------------ |
| `git fetch origin`（NikkiSync） | 0      | `origin/main...HEAD = 0 0`，HEAD `d4ca7d7`                                                             |
| `npm run link:nikkisync:check`  | 0      | `check OK (all four links in place)`                                                                   |
| `npm run verify:nikkisync`      | 0      | 10 项全 ✓，`blocking failures: 0`                                                                      |
| `npm run typecheck`             | 0      | 无输出                                                                                                 |
| 节点 0-1 只读取证               | 0      | `withCompleteEnvelope=25/25`、payload 47936–48236 字符、`resolved=0`、`withCamera=0`、`motionPhotos=6` |

### 11.1 节点 1 · 深入口装载面

- 红灯：`runtime-facade.test.ts` 新增「两个 metadata 深入口常量」用例 ⇒ `1 failed | 17 passed`，退出码 1（`Received: undefined`）。
- 改动：`NUAN5_RESOLVER_DEEP_ENTRY` / `METADATA_DIAGNOSTICS_DEEP_ENTRY` + `RuntimeSurface` 两面 + `loadRuntimeSurface` 两条 `loadDeepModule`；并注释说明**为何不进 `NIKKISYNC_REQUIRED_EXPORTS`**。
- 绿灯：`24 tests` 同文件通过（该阶段时点 18 passed），退出码 0。
- 真实装载实测（本地已建链）：`Nuan5CompatibleResolver: function`、实例 `id = 'nuan5-compatible'`、`metadataResolutionDiagnostics: function`。

### 11.2 节点 2 · 打包态产物闸门

- 红灯：`verify-nikkisync-link.test.ts` 3 例新用例 ⇒ `2 failed | 20 passed`（第三例「字段缺省时整条检查缺席」本就为真）。
- 改动：`METADATA_REQUIRED_ARTIFACTS` + `metadataArtifactsMissing` 事实字段 + 独立检查项 + 采集循环；缺失时给 `npm run build` 修复指令。
- 绿灯：`22 passed`，退出码 0；`npm run verify:nikkisync` 现场输出新增一行 `✓ ... present: dist\src\metadata\Nuan5CompatibleResolver.js, dist\src\metadata\MetadataResolutionDiagnostics.js`，`blocking failures: 0`。
- 实测 `package.json` `asarUnpack` 首项为 `**/@nikkisync/**`、`build.files` 显式整目录拷 `node_modules/@nikkisync` ⇒ **打包面已覆盖 metadata 子目录，无需改动**。

### 11.3 节点 3 · 驱动纯函数层

- 红灯：新模块不存在 ⇒ `Test Files 1 failed / Tests no tests`，退出码 1。
- 绿灯：`14 passed` → 加端点常量断言后 `15 passed`，退出码 0。

### 11.4 节点 4 · 单缝注入

- 红灯：`6 failed | 18 passed`。首轮失败原因之一是本仓夹具缺 `SyncReadRepository`/`MetadataDictionaryRepository` 假类（`createQuerySurface` 在组装期即 new），补假面后仍为真实红灯。
- 改动：注入缝按开关条件展开 `metadataFragment`；会话新增 `stopMetadataResolver` / `metadataRunOnce?` / `metadataDiagnostics`；`runtime-types.ts` 新增 `MetadataResolverServiceLike` 与 `metadata?` 状态形状。
- 类型检查首轮报 `Nuan5ResolverSurface` 缺索引签名不能喂 `nikkisyncExport` ⇒ 显式转型并注释原因。
- 绿灯：`24 passed`；`npx vitest run src/main/nikkisync` **13 files / 186 passed**（含 `runtime-facade.linked.test.ts` 真实建会话、`sync-server.linked.test.ts` 真起 TLS 服务），退出码 0；`tsc -b` 0。

### 11.5 节点 5 · 生命周期与有界驱动

- 红灯：`10 failed | 34 passed`（8 个新用例 + 2 个既有拆除顺序断言，后者因不变量确实改变而必须同步更新）。
- 改动：`generation` 作废 + `teardown` 最前置 `metadataResolver.stop` + `scan()` 成功后 fire-and-forget 驱动 + `status().metadata`。
- 自纠两处**用例前提错**（非实现错）：① 原 C-12b 用 `startError` 想表达「扫描失败」，但假 `fullScan` 不受它影响 ⇒ 新增 `fullScanThrows` 注入点；② 原 `maxPasses=5` 使单次仅能推进 20 条、且驱动挂在扫描返回路径上 ⇒ D-7 改不挂返回路径并把默认抬到 50。
- 绿灯：`45 passed`；`src/main/nikkisync` + `src/main/app` **38 files / 613 passed**，退出码 0。

### 11.6 节点 6 · 表级隔离护栏

- 首跑两处失败，均为**我的断言与上游真实行为不符**，据实修正而非放宽：
  1. 护栏模块自己的头注释里逐字写了 `UPDATE media_files …`，被自家谓词命中 ⇒ 改写为散文，并把该约定写进注释（结构档同时守护它）。
  2. 断言「缺 payload 就不入队」与上游不符：候选 SQL 只校验 `uid` + `$.raw.nativeParamToken`，缺载荷者照样入队、要到本地组包才抛 ⇒ 断言改为事实形态，并注明节点 0-1 的 25/25 齐备才是这一档不入队的真正保证。
- 绿灯：`metadata-isolation-guards` 8 passed + `metadata-resolver.isolation` 7 passed（**语义档在 `node:sqlite` 下实际执行，非跳过**），退出码 0；`tsc -b` 0。

### 11.7 节点 7 · opt-in 设置与隐私披露

- 红灯三段：装配面 `5 failed | 20 passed`；语言包 `3 failed`（`zh-CN.json 缺失 settings.sync.metadata.enable`）；设置页 `4 failed | 12 passed`。
- 改动：设置键 + env 逃生阀 + `resolveMetadataResolverEnabled` + `buildSessionOptions` 塞值 + `RENDERER_PREF_KEYS` + `sync-sections.tsx` 开关与常驻披露段 + 12 语言包各 3 键。
- 一处**实现自纠**：`buildMetadataResolverConfig` 校验完端点却丢弃返回值，被 `no-unused-vars` 抓出 ⇒ 改为把校验过的端点下传给 `createResolver(endpoint)`，使「校验的」与「用的」同源。
- 绿灯：装配 `25 passed`、语言包 `8 passed`、设置页 `16 passed`；`prettier --check` 12 个 JSON 全通过；`npm run i18n:check` 全语言 3932 键对齐；`npm run i18n:guard` 通过。

### 11.8 节点 8 · 链接态集成

- 首跑失败：上游 `assets` 表 `created_at` / `updated_at` 为 NOT NULL ⇒ 读 `migrations/0001_initial.sql:22-38` 后补齐播种列（禁止假设，按 DDL 原文改）。
- 两处断言加固：搜索返回值先要求 `{query, items}` 形状存在，避免 `?? []` 把断言掏成恒真；补 `resolverConfigSeen` 断言确认端点确实被显式下传。
- 绿灯：`6 passed`，退出码 0。关键实测：25 条静图在 `batchSize=4` 下恰好 `ceil(25/4)=7` 轮解析完；6 条 motion `metadata_json` 仍 `{}`、`revision` 仍 0；`asset.updated` 恰 25 条、`library_revision` 恰 25；裸数字 `clothes` 下 `searchClothing`/`searchSuits` 的 `items` 为 `[]`。

### 11.9 收口验证（真实输出）

| 命令                                                 | 退出码 | 原始结果                                                                                                                                                      |
| ---------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                  | 0      | `tsc -b && tsc -p tsconfig.scripts.json` 无输出                                                                                                               |
| `npm run lint`                                       | 0      | `✖ 11 problems (0 errors, 11 warnings)` — 11 条全部是既有 DEBT-030 的 `components/common/*.test.tsx` BOM warning，与本阶段无关                                |
| `npx prettier --check --end-of-line auto <改动文件>` | 0      | `All matched files use Prettier code style!`                                                                                                                  |
| `npm run i18n:check`                                 | 0      | 全语言 `key 对齐成功 (3932 keys)`                                                                                                                             |
| `npm run i18n:guard`                                 | 0      | `✅ 白名单只减不增、清零必移除、key 已同步，守卫通过`                                                                                                         |
| `npm run link:nikkisync:check`                       | 0      | 四包全 `ok`                                                                                                                                                   |
| `npm run verify:nikkisync`                           | 0      | 新增 `✓ ships the metadata resolver artifacts`，`blocking failures: 0`                                                                                        |
| `npm run test:coverage`                              | 0      | `Test Files 394 passed (394)`；`Tests 6151 passed \| 2 skipped (6153)`；覆盖率 `67.54 / 59.19 / 60.12 / 69.11` vs 阈值 `66 / 58 / 59 / 68` ⇒ 四项全部越线通过 |
| `npm test`（格式化前的一次全量）                     | 0      | `394 files / 6150 passed \| 2 skipped`                                                                                                                        |

- 基线对照：阶段 5 收口为 `390 files / 6066 passed | 2 skipped` ⇒ 本阶段 **+4 测试文件 / +85 用例，0 新增失败**。
- 改动面清点（`git status --short`）：12 个既有源/测文件修改 + 13 个 locale 文件（12 JSON + 1 键守护测试）+ 6 个新文件 + 本计划文件。
  **`src/main/scanner/**`、`src/main/media-worker/**`、`src/main/thumbnail/**`、`src/main/database/connection.ts` 与 NikkiSync 全部零改动。**
- 未执行 `git commit` / `git push`，改动保留在工作区。

### 11.10 偏差记录（与计划文件的出入）

| #   | 计划写法                                                            | 实际落地                                    | 原因                                                                                                                                                    |
| --- | ------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 步骤 0 含「项目根执行 `npm install`」                               | **未执行**                                  | `npm install` 剪掉 `node_modules/@nikkisync` 四个 junction，链接态用例集体降级 skip；改用 `link:nikkisync:check` + `verify:nikkisync`                   |
| 2   | 拆除期 `stopMetadataResolver` 用 `withTimeout` 包（与其余步骤同款） | 用普通 `try/catch`                          | 上游 `stop()` 是同步幂等调用，包超时只会凭空多出一个待等的定时器                                                                                        |
| 3   | 既有两条 teardown 顺序断言不动                                      | 同步改为含 `metadataResolver.stop` 的新序列 | 被改的正是本阶段要建立的不变量本身；不改断言等于把新顺序藏起来                                                                                          |
| 4   | 驱动 `await` 在 `scan()` 返回之前；`maxPasses=5`                    | 改 fire-and-forget；`maxPasses` 默认 50     | 前者会让 `start-scan` 被上百条候选阻塞数十秒；后者单次只能推进 20 条，大库永不收敛（上游 `467b590` 正是为此而修）。见 D-7                               |
| 5   | 开关旁加一条成功 toast                                              | 不做                                        | 会多出一个需同步 12 个语言包的键；开关状态本身即反馈，只为失败路径报错并回滚                                                                            |
| 6   | 新增文件记入 `docs/技术债清单.md`                                   | 未记                                        | 该清单是 **i18n 专项**（DEBT-NNN + `debt-registry.json` + `i18n:guard` 联动），R2/R3 属上游行为后果，塞进去会误分类并可能触发守护。已记在本文件 §7 风险 |
| 7   | 计划把 `metadataRunOnce` 写成方法                                   | 写成属性签名                                | 契约是「已绑定闭包」，驱动层会把它摘下来单独调用，不能依赖 `this`                                                                                       |
