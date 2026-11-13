# 同步图库 PC 端对齐上游 `a49764bb` 实施计划

> 路径前缀（下文所有 `ROOT/`、`UP/` 均为此完整绝对路径的展开）：
> `ROOT = D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe`
> `UP   = D:/Workbuddy 项目/WXNN YD - 副本/NikkiSync`
> 审批通过后**第一步**把本文件落到 `ROOT/docs/plans/2026-11-13-nikkisync-pc-align-1.0.40-实施计划.md`（plan 模式只能写系统计划文件）。

## 0. 决策与边界（已逐项确认）

| 项        | 裁决                                                                                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PC 端范围 | 维持 R1：只补齐 `apps/pc-companion` 的 TS 运行时能力；**唯一扩展**是引入服装图标静态包（见下）。C# WPF 自动更新 / xdelta3 差分 / 托盘自启 / 支持网关 / UpdateWindow / Android / 小程序本体仍不搬 |
| 图标包    | **从官方 `MomoCamera-PC-1.0.40.exe` 提取整包并随仓分发**；扩展边界「仅限图标包」，不含自动更新/验签通道。上游第三方署名段落同步到本仓（工程步骤）                                                |
| 上游克隆  | 授权 fetch / checkout `a49764bb` / 完整 build；本仓写基准钉子测试锁 SHA 与新产物存在性                                                                                                           |
| 存量库    | **撤销自研 DDL**。上游 `DatabaseManager.initialize()` 实测无条件 `exec(0001_initial.sql)`（全文 `IF NOT EXISTS`），老库自动补 2 表 1 索引；改为「表闭集 + 索引断言 + 旧库升级回归测试」          |
| 验证      | **不 `git commit`、不打包**（`dist:win` / `verify:dist` / `e2e:smoke` 一律 not-run）；代码级全量验证照跑                                                                                         |
| 硬约束    | 最小化改动、优先复用上游、禁止重复造轮子；每小节点 **红灯 → 改 → 绿灯**，修复前已通过必须重写测试；每节点后立即跑相关子集；不得跳过/弱化失败                                                     |

## 1. 核对的提交范围与差异清单

基准 `4cb71e24a60d0c911c8ebc01f46cee74186ec1d7`（v1.0.31，本地克隆当前 HEAD）→ `a49764bbf98fcb26a84f2356b78d48c459d3da2e`（main HEAD / v1.0.40-public-beta.2），共 4 提交：

| SHA        | 时间(UTC)   | 分类                                                             |
| ---------- | ----------- | ---------------------------------------------------------------- |
| `bc3f636b` | 11-11 13:02 | 1.0.39，PC TS 运行时主变更（159 文件）                           |
| `6c967831` | 11-11 13:16 | 纯测试/文档，二进制零变化                                        |
| `ec139a2c` | 11-11 16:52 | 1.0.40，51 文件，滤镜图标与分享效果                              |
| `a49764bb` | 11-11 16:58 | 纯文档/测试（README + release note + `tools/ui-theme.test.mjs`） |

**必须补齐**：① 克隆推进 + 完整 rebuild + 钉子锁基准；② 4 个新深路径产物 `dist/src/metadata/{LocalClothingIconPack,LocalPhotoMetadataResolver,MetadataInputFingerprint,VerifiedPhotographyNames}.js` 的清单/装载链/打包面；③ 22 项滤镜图标资源（`manifest.json` + `effects/filter-1090020{001..017,019..022}.webp`，缺 0018）；④ **服装图标主包**（约 74 MiB、9000+ 张，含 pose/lighting 效果）落入 `resources/nikkisync/pc/clothing-icons/`；⑤ `loadLocalClothingIconPack` / `withLocalPhotoEffectIcons` 装载、路径注入、`server.localClothingIcons` 完整 pack、画廊侧 `localClothingIcons` + `convertLocalWebp`、有包时停建 `MetadataThumbnailCache` / `WeChatIconProvider` / `loadIcon`；⑥ 表闭集 16→18 + 索引 + 旧库升级测试；⑦ `GalleryRuntime.mjs` 重 build 后的非破坏性核验；⑧ 文档与全量回归。

**零变化、明确不动**：`packages/{core,database,protocol}/src/index.ts` 与 `apps/pc-companion/src/index.ts` 两端 blob SHA 一致 → `NIKKISYNC_REQUIRED_EXPORTS`、`probe.ts`、`runtime-loader.ts` 不改；`packages/protocol/src/index.ts` 契约逐值未变 → `src/shared/sync/**`、`protocol-contract.ts`、漂移守护不改；根与 pc-companion `package.json`、`build-wechat-runtime.mjs` 未变 → 无新依赖/新构建步骤；上游无新增 IPC/协议字段/能力位 → **不新增 `nikkisync:*` 通道、不改 IPC handler / preload / `docs/IPC_CONTRACT.md` / i18n 键 / UI 开关**。受保护核心路径零改动，不需要 `// @core-change:`，但必须用 `npm run verify` 核验 `core-path-gate` 无本轮命中。

**明确不搬（R1，证据）**：C# `IconPackUpdater.cs`（仅取它释放的静态包，不搬代码）、`DesktopUpdates.cs` / `UpdateInstaller.cs` / `UpdateWindow.xaml`、`LocalPhotoDecoder.cs`、`SupportGatewayClient.cs`、`tools/icon-update/*`、`tools/support-gateway/*`、`assets/tools/xdelta3/*`、`scripts/sign-*.ps1`、`apps/mobile/**`、`apps/wechat-mini-program/**` 本体、上游 `docs/releases/*`。证据：这些 `.cs/.xaml/.ps1/.java/.xml/二进制` 均不在 `dist/src/**`、不在 `LOAD_CHAIN_ROOTS` / `NIKKISYNC_CAPABILITY_ARTIFACTS`、不在 esbuild entry；本仓已有 `electron-updater ^6.8.9`，重写即重复。`1.0.32` release「二进制含未同步本地修改」以仓库源码 `a49764bb` 为唯一基准。

**已核实的关键事实**：`createPreviewSource.icon()` 中 `if(localClothingIcons){…return}` 优先且无 `loadIcon` 回退；`outfitDescriptors` 在有 pack 时 `candidates=[]`；`LocalSyncServer.clothingThumbnailSource()` 在有 pack 时 `sourceUrls=[]`；`row-mappers.mapAssetDetail` 第三参为 bool。因此**必须有主包**（`entries` 非空）才能启用本地模式而不退化 —— 这正是引入 74 MiB 主包的原因。`server.localClothingIcons` 必须传完整 pack（`read`/`readEffect` 会调），只传 `{cacheVersion}` 会 TypeError。

## 2. 依赖声明

- **新增 npm 依赖：无**。`ROOT/package.json` 的 `dependencies` / `devDependencies` / `optionalDependencies` 与 `@nikkisync/*` 声明面一律不动（`verify-nikkisync-link.ts` 的 `collectOutOfRepoSpecs` 硬阻断 `file:../` / `workspace:` 逃逸）。
- **上游**：`UP/package.json` `engines.node >=24.0.0`，devDeps `esbuild 0.28.2` / `@types/node ^24.0.0` / `typescript ^5.9.0`；`UP/node_modules`、`node_modules/.bin/{tsc,esbuild}`、`package-lock.json` 已齐备，**无需 `npm ci`**（仅当 checkout 后与锁文件不一致才执行，仍用 Node 26 PATH）。
- **运行时分工**：构建上游必须显式 `export PATH="/c/Program Files/nodejs:$PATH"`（该 node = **v26.3.0**）；本仓测试用默认 `C:\Users\45001\.workbuddy\binaries\node\versions\22.22.2-6\node.exe`（**v22.22.2**）。本仓 `engines.node >=22.12.0` 不变。
- **外部资产（非 npm 依赖，需联网下载一次）**：GitHub release `v1.0.40-public-beta.2` 的 `MomoCamera-PC-1.0.40.exe`（271 MB），SHA256 `7d4aad76d9fe7355cea9d695cf7e67f32be09dfe0e4b1e9d65533953932bf250`。内嵌全量图标包 `NikkiSync.Icons.Full.zip`：`InitialPackSize = 77678905` B、`InitialPackSha256 = ddd70fbf87ebeb9722e37365a76a5d159951f1104c2e378578316e884e840b4f`、`InitialManifestSha256 = c39e0f672867c7ee59fe9f7865510d95a0f2bbbf6d47f56a21f9a95e134752f0`（来自 `IconPackUpdater.cs` / `MainWindow.xaml.cs`）。
- **本机工具（已实测存在）**：`curl`、`python 3.13.14`、`dotnet`、`unzip`、`tar`、`git`；**无 `7z`/`7za`** → 解包走 Python ZIP carving（见 N0.5）。

## 3. 启动说明（环境准备 / 启动 / 验证）

```bash
# (1) 上游克隆推进 + 完整 rebuild（N0）
cd "D:/Workbuddy 项目/WXNN YD - 副本/NikkiSync"
git fetch origin
git checkout --detach a49764bbf98fcb26a84f2356b78d48c459d3da2e
git rev-parse HEAD                    # 必须 = a49764bb...
git status --porcelain                # 必须为空
export PATH="/c/Program Files/nodejs:$PATH" && node -v   # 必须 v26.x
npm run build   # build:core → protocol → database → pc（含 build-wechat-runtime.mjs 双写 GalleryRuntime.mjs）

# (2) junction 复验（指向目录未变，无需重建）
cd "D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe"
export NIKKISYNC_ROOT="D:/Workbuddy 项目/WXNN YD - 副本/NikkiSync"
npm run link:nikkisync:check          # 4 条 ok
npm run verify:nikkisync              # blocking 0
```

- `NIKKISYNC_ROOT` 可省：`scripts/link-nikkisync.ts` 默认候选 `../NikkiSync` 已命中 `UP`。`npm install` 会剪掉 junction，装依赖后须重跑 `npm run link:nikkisync`。
- **命令偏差**：`ROOT/package.json:41` 的 `stage:nikkisync-pc` **已带 `--apply`**（会直接写盘）。dry-run 必须用 `npx tsx scripts/stage-nikkisync-pc-assets.ts`（无参）。
- 启动：`npm run dev`（=`electron-vite dev`）。人工判据：设 `gallery.dataSource='nikkisync'` → `nikkisync:runtime-status` 的 `tables` 含 18 张业务表、`state=running`；控制页能出图；微信画廊能出码出图与分享图三类效果图标；日志无 `[NIKKISYNC] error`。**本轮不打包，人工 GUI 判据记录为「已/未人工复核」，不冒充装机实测**。
- 验证：§8 全量命令表 + 每节点子集；验收读数逐节点回写 N0 落档的 MD。

## 4. 错误处理

| 类别               | 位置                                                                                                                                    | 行为                                                                                                                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fail-closed / 上抛 | `createRuntimeSession` 内任一装载/注入抛错                                                                                              | 复用既有 `try{...}catch{runtime.database.close(); throw}`（`runtime-facade.ts:896`）：**先关库再上抛**，`runtime-manager.start()` 归一为 `state=error` + `status.error`。不吞错、不放空 catch、不新建第二 SQLite 句柄             |
| fail-closed        | 钉子测试：SHA 不符 / 产物缺失 / 图标包 SHA 或 manifest 不符 / 计数漂移                                                                  | 红灯，阻断进入下一节点；不得用「假设产物存在」蒙混                                                                                                                                                                                |
| fail-closed        | `verify:nikkisync` `blocking>0`、`closureLoadChain` 有 `dangling`/`unreadable`、`core-path-gate` 命中本轮改动、闭集/索引断言红          | 不降级                                                                                                                                                                                                                            |
| warn 降级不阻断    | `loadLocalClothingIconPack(dir)` 返回 `undefined`（目录不存在）或 `valid:false`（manifest 损坏）                                        | **不注入** `server.localClothingIcons` / 画廊侧 `localClothingIcons`，保持在线模式（`MetadataThumbnailCache` + `WeChatIconProvider` + `loadIcon`），`log('warn', '[NIKKISYNC] icon pack unavailable: <dir> …')`；会话其余能力照常 |
| warn 降级          | `loadOptional` 深入口缺失、`stagePcAssets` 单件缺失、`startPcCompanionServices` 装配失败                                                | 沿用既有 `pc-companion-services.ts:180-189` / `stage-nikkisync-pc-assets.ts:139-142` 行为，其余照常                                                                                                                               |
| 日志               | 统一 `runtimeLog(level, message)`（diagLog + electronLogger 双通道）或 `options.log`；`src/**` 字符串字面量保持英文，中文只进注释与文档 |
| 资产门禁           | N0.5 任一 SHA / `unzip -t` / manifest 校验失败                                                                                          | **立即停止并报阻塞项**，不注入半套图标包、不伪造资源                                                                                                                                                                              |

## 5. 参数校验（外部输入默认不可信）

| 入参                                                                 | 类型 / 必填                                                                                             | 边界与非法值                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loadLocalClothingIconPack(directory)`                               | 必填、绝对路径（`path.isAbsolute` 预检）                                                                | 空串/相对路径/非字符串 → 不调用并 warn；上游内部校验：manifest ≤4 MiB、单图 ≤256 KiB、边长 ≤192、`entries ≤30000`、`effectEntries ≤5000`、`id /^[1-9]\d{0,11}$/`、`sha256 /^[a-f0-9]{64}$/`、`schemaVersion 2 && imageFormat==='webp'`、WebP 静态（拒 ANIM/ANMF）、逐文件 SHA 复核 |
| `NikkiSyncSessionOptions.clothingIconsDir?` / `photoFilterIconsDir?` | 可选，绝对路径                                                                                          | dev = `ROOT/resources/nikkisync/pc/{clothing-icons,photo-filter-icons}`；打包 = `process.resourcesPath/nikkisync/pc/...`（`extraResources` 的 `to:"nikkisync/pc"`）。缺省 → 不装载、warn、不阻断                                                                                   |
| `server.localClothingIcons`                                          | 完整 `LocalClothingIconPack`（`valid/cacheVersion/sha256For/read/effectSha256For/readEffect`）          | **仅 `valid===true` 注入**；不得只传 `{cacheVersion}`；`cacheVersion` 必须是 64 hex（`MetadataDictionaryService` 拼 `:local-icons-`，`outfit.mjs` 用正则剥离）                                                                                                                     |
| `createIndexedPreviewSource` options                                 | 第三参整体可选                                                                                          | 有 pack 时注入 `localClothingIcons` + `convertLocalWebp`（必须是 `(bytes:Uint8Array)=>Promise<Uint8Array>`，委托上游 `convertWeChatWebp(bytes, ffmpegPath)`，失败回落 `resizeIcon`），并**省略** `loadIcon`；`reads`/`exportCopies`/`cacheSecret` 一律不传（缺省安全）             |
| `withLocalPhotoEffectIcons(main, supplement)`                        | `main` 必填且 `valid===true`；`supplement` 可缺席                                                       | `supplement?.valid` 为假时原样返回主包；合并后 `cacheVersion = sha256(main+supplement)`                                                                                                                                                                                            |
| 图标包文件                                                           | `manifest.json` + `icons/<id>.webp` + `fallbacks/<sha256>.webp` + `effects/<kind>-<id>.webp`            | `kind ∈ {pose,lighting,filter}`；逐文件存在性 + SHA + 静态 WebP 结构；主包 `entries` 非空（否则服装图标全退化）                                                                                                                                                                    |
| 表闭集 / 旧库                                                        | `readTableNames()`                                                                                      | 恰好 14 迁移表 + 4 运行期表 + `sqlite_sequence`；`schema_migrations` 恰好 1 行 `version=1`；`idx_assets_resolver_fingerprint` 存在                                                                                                                                                 |
| 其它                                                                 | `pcOn()` 只认显式 `true`；`scanRoots` 只收 string 且逐个 `realpath` 过滤；`options.database ?? {}` 判空 |

## 6. 基础测试用例（正常 / 异常 / 边界 + 修复前必红断言）

| 节点 | 正常                                                                                                                                                  | 异常                                                        | 边界                                                          | **红灯断言（修复前必失败）**                                                                                                                                                                                                                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N0   | HEAD=`a49764bb`、4 个新 `dist/src/metadata/*.js`、`GalleryRuntime.mjs` >277961 B、迁移含 2 表 1 索引                                                  | HEAD 停在 `4cb71e2` / 产物缺失 → 红                         | detached HEAD；未设 `NIKKISYNC_ROOT` 时 sibling 候选仍命中    | `ROOT/scripts/__tests__/nikkisync-baseline-pin.test.ts`：`expect(headSha).toBe('a49764bbf98fcb26a84f2356b78d48c459d3da2e')`、`expect(existsSync('UP/apps/pc-companion/dist/src/metadata/LocalClothingIconPack.js')).toBe(true)`                                                                                                 |
| N0.5 | EXE SHA 匹配；carve 出的 ZIP = 77678905 B、`unzip -t` 通过；`manifest.json` SHA = `c39e0f67…`；主包 `entries.length >= 9000`                          | 下载失败 / SHA 不符 / ZIP 损坏 / manifest 不符 → 停并报阻塞 | 只有补充包、无主包 → 不启用本地模式                           | 同钉子测试：`expect(clothingManifestSha).toBe('c39e0f67…')`、`expect(entries.length).toBeGreaterThanOrEqual(9000)`、`expect(existsSync('ROOT/resources/nikkisync/pc/clothing-icons/manifest.json')).toBe(true)`                                                                                                                 |
| N1   | 旧库（16 表）启动新版后含 18 表 + 索引                                                                                                                | 表集合多/少一张 → 红；`schema_migrations` 非 1 行 → 红      | 二次启动幂等、不覆盖数据                                      | `ROOT/src/main/nikkisync/runtime-facade.linked.test.ts:185` 闭集 `toEqual` 与新 `expect(indexNames).toContain('idx_assets_resolver_fingerprint')`；新「旧库升级」用例 `expect(tablesAfter).toContain('nuan5_resolution')`                                                                                                       |
| N2   | 24 项能力产物 / 27 根 / 闭包 `visited>=50`、`dangling=[]`                                                                                             | 缺任一产物 → blocking                                       | 未建链时 warn skipped                                         | `ROOT/scripts/__tests__/verify-nikkisync-link.test.ts`：`toHaveLength(24)`、`toHaveLength(27)`、逐项 `toEqual`、facade 常量与根表逐项相等                                                                                                                                                                                       |
| N3   | 31 项 spec、dry-run `planned=31 copied=0`、apply `copied=31 skipped=0`                                                                                | 单件缺失 warn+skipped；目标逃逸抛错                         | UP 根缺失 → 零写盘 skipped                                    | `ROOT/scripts/__tests__/stage-nikkisync-pc-assets.test.ts`：`expect(PC_ASSET_SPECS).toHaveLength(31)`、`expect(manifest.effectEntries).toHaveLength(21)`                                                                                                                                                                        |
| N4   | 主包+补充包合并注入、`server.localClothingIcons.cacheVersion` 64 hex、画廊侧 options 含 `localClothingIcons`+`convertLocalWebp` 且**不含** `loadIcon` | 目录缺失 / `valid:false` → warn 且回落在线模式              | `supplement` 无效时只用主包；`convertLocalWebp` 非法 → 不注入 | `ROOT/src/main/nikkisync/pc-companion-services.test.ts` 新增：`expect(previewOptions.localClothingIcons).toBeDefined()`、`expect(previewOptions.convertLocalWebp).toBeTypeOf('function')`、`expect(previewOptions.loadIcon).toBeUndefined()`、`expect(serverConfig.localClothingIcons?.cacheVersion).toMatch(/^[a-f0-9]{64}$/)` |
| N5   | `GalleryRuntime.mjs` 新符号在位、协议零差异                                                                                                           | 产物仍是旧 277961 B → 红                                    | `mapAssetDetail` 两参等价 `false`；必需导出表计数不变         | **恒绿断言必须改写**：`expect(text).toContain('shareDetails')` 在 N0 rebuild 后修复前即通过，改为 `expect(stat.size).toBeGreaterThan(277961)` + `expect(stat.mtimeMs).toBeGreaterThan(checkoutStamp)`                                                                                                                           |
| N6   | 全量表全绿                                                                                                                                            | 任一红 → 回对应节点重做 TDD 闭环                            | `audit` 联网失败记阻塞项不弱化                                | 无新增红灯                                                                                                                                                                                                                                                                                                                      |

## 7. 逐节点实施（每节点：完整路径 / 输入输出 / 可判定验收 / 红→改→绿 / 节点后子集 / 顺序依赖）

### N0 — 计划落档 + 基准推进 + 钉子测试

- **修改文件**：新增 `ROOT/docs/plans/2026-11-13-nikkisync-pc-align-1.0.40-实施计划.md`、新增 `ROOT/scripts/__tests__/nikkisync-baseline-pin.test.ts`；工作区外推进 `UP`（fetch/checkout/build）。钉子测试须在**无克隆的 CI 环境**优雅 skip（复用 `scripts/link-nikkisync.ts` 的 `toRootCandidates` / `NIKKISYNC_ROOT`，不得硬编码 `UP` 存在）。
- **输入 / 输出**：本计划 + `UP` git 对象 + junction → 落档 MD、钉子测试、`UP@a49764bb` 且完整 build、`link:nikkisync:check` 4 条 ok。
- **验收标准**：`git -C "D:/Workbuddy 项目/WXNN YD - 副本/NikkiSync" rev-parse HEAD` = `a49764bb…`；`npm run verify:nikkisync` 输出 `OK (blocking failures: 0)`；`npx vitest run scripts/__tests__/nikkisync-baseline-pin.test.ts` → `0 failed`；`GalleryRuntime.mjs` 字节数 > 277961。
- **红灯 → 修复 → 绿灯**：先在旧基准跑钉子测试（HEAD 断言 + 4 个 `existsSync` 必 `1 failed`）→ 按 §3 checkout + 完整 build（**不改上游源码**）→ 复跑同命令转绿。
- **节点后子集**：钉子测试、`npm run verify:nikkisync`、`npm run link:nikkisync:check`、`npx tsx scripts/stage-nikkisync-pc-assets.ts`（dry-run 基线，**勿用 `npm run stage:nikkisync-pc`**）。
- **依赖**：N0 全绿才进 N0.5 / N1。

### N0.5 — 官方 EXE 资产门禁（新增，因「从 EXE 提取整包」裁决）

- **修改文件**：不新增生产代码；新增一次性脚本 `ROOT/scripts/extract-nikkisync-icon-pack.py`（纯 Python，可复用/可重跑，落档说明）与 `ROOT/scripts/__tests__/nikkisync-icon-pack.test.ts`（纯函数/文件校验）；产出目录 `ROOT/resources/nikkisync/pc/clothing-icons/`（manifest + icons/ + fallbacks/ + effects/，约 74 MiB，随工作区保留、**不 commit**）；`ROOT/THIRD_PARTY_NOTICES.md` 追加上游图标包署名段落（MIT 署名合规工程步骤）。
- **输入 / 输出**：输入 = GitHub release 的 `MomoCamera-PC-1.0.40.exe` + 4 个已知 SHA；输出 = 校验通过的完整图标包目录 + 钉子测试可读的 `manifest.json`。
- **确切步骤（不得假设）**：
  1. `curl -L --fail -o <temp>/MomoCamera-PC-1.0.40.exe https://github.com/ToStardust/NikkiSync/releases/download/v1.0.40-public-beta.2/MomoCamera-PC-1.0.40.exe`，校验 SHA256 = `7d4aad76…`。
  2. Python 扫描 PE 中的 ZIP local header `PK\x03\x04` 与 EOCD `PK\x05\x06`，按 `InitialPackSize=77678905` 精确 carve 候选；校验 SHA256 = `ddd70fbf…`；`unzip -t` 通过。
  3. `unzip` 到临时目录，校验 `manifest.json` SHA256 = `c39e0f67…`、`entries.length >= 9000`、`schemaVersion===2 && imageFormat==='webp'`、`icons/` 与 `effects/` 存在；抽样 10 个 `icons/<id>.webp` 复核逐文件 SHA。
  4. 拷贝整树到 `ROOT/resources/nikkisync/pc/clothing-icons/`。
  5. **回退**：若 carving 失败，改用 `dotnet` + .NET single-file bundle 解析（或让官方 EXE 首次运行自行释放到 `%LOCALAPPDATA%\NikkiSync\clothing-icons` 后拷贝）；**任何路径都必须通过第 3 步全部校验**，否则停并报阻塞项。
- **验收标准（可判定）**：4 个 SHA 全部匹配、`unzip -t` 输出 `No errors detected`、`entries.length >= 9000`、目录文件数与 manifest `entries` 一致、`ROOT/scripts/__tests__/nikkisync-icon-pack.test.ts` `0 failed`。
- **红灯 → 修复 → 绿灯**：钉子测试中 `expect(existsSync(clothingIconsDir/manifest.json)).toBe(true)` 与 SHA 断言在资产落位前必 `1 failed` → 执行上述门禁 → 复跑转绿。
- **节点后子集**：`npx vitest run scripts/__tests__/nikkisync-icon-pack.test.ts scripts/__tests__/nikkisync-baseline-pin.test.ts`、`npm run format:check`（`.prettierignore` 已整目录豁免 `resources/nikkisync/pc/`）。
- **依赖**：N0 绿 → N0.5；N0.5 绿 → N1（且 N4 依赖资源在位）。

### N1 — 表闭集 + 索引 + 旧库升级回归测试（**不写自研 DDL**）

- **修改文件**：`ROOT/src/main/nikkisync/runtime-facade.linked.test.ts`（`MIGRATION_TABLES` 12→14 加 `nuan5_resolution` / `nuan5_endpoint_state`、注释 16→18 张、`:353` 用长度自动跟随、新增索引断言、**新增「模拟旧库 → 新版启动 → 断言补表」用例**：用 `git -C "D:/Workbuddy 项目/WXNN YD - 副本/NikkiSync" show 4cb71e2:packages/database/migrations/0001_initial.sql` 的旧 SQL 在临时文件建库，再 `createRuntimeSession({databaseFile})`）、`ROOT/src/main/nikkisync/AGENTS.md`（订正节）。**不新增** `schema-compat.ts`，不改生产代码。
- **输入 / 输出**：旧 schema 临时 DB + 新版 `initialize()` → 断言 18 表 + 索引 + `schema_migrations` 1 行。
- **验收标准**：`npx vitest run src/main/nikkisync/runtime-facade.linked.test.ts` 从 `1 failed` 转 `0 failed`；`npm run typecheck` 0 error。
- **红灯 → 修复 → 绿灯**：N0 rebuild 后新库多 2 表，`:185` 闭集与索引断言必红 → 更新常量/注释/新增用例 → 复跑转绿。
- **节点后子集**：上述 + `npx vitest run src/main/nikkisync/probe.test.ts src/main/nikkisync/runtime-loader.test.ts`。
- **依赖**：N0.5 绿 → N1；N1 绿 → N2。

### N2 — 4 个新深路径产物 + 四张表同步

- **修改文件**：`ROOT/scripts/verify-nikkisync-link.ts`（`NIKKISYNC_CAPABILITY_ARTIFACTS` 20→24 加 4 个 `dist/src/metadata/*.js`；`LOAD_CHAIN_ROOTS` 26→**27**，只加 `dist/src/metadata/LocalClothingIconPack.js`）、`ROOT/scripts/__tests__/verify-nikkisync-link.test.ts`（计数 24/27 + 逐项 `toEqual` + facade 常量等集）、`ROOT/src/main/nikkisync/runtime-facade.ts`（新增 `export const LOCAL_CLOTHING_ICON_PACK_DEEP_ENTRY = ['metadata','LocalClothingIconPack.js'] as const`、`RuntimeSurface` 加字段）、`ROOT/scripts/__tests__/nikkisync-baseline-pin.test.ts`（回写读数）、`ROOT/src/main/nikkisync/AGENTS.md`（27 roots / 24 artifacts）。
- **输入 / 输出**：N0 的 4 个新产物 → 能力清单 24 项、根表 27 项、`pre-dist-check.ts` 经 `missingPackedCapabilityArtifacts(NIKKISYNC_CAPABILITY_ARTIFACTS, ...)` **复用同一常量，不抄第二份**。
- **说明**：另 3 个产物是上游静态传递依赖，本仓不主动装载（依 `AGENTS.md:278`「不预载未用符号」），由 `closureLoadChain` 沿既有边自动 visit。
- **验收标准**：`npx vitest run scripts/__tests__/verify-nikkisync-link.test.ts` `0 failed`；`npm run verify:nikkisync` `blocking 0` 且 `24 项 / 27 root(s)`。
- **红灯 → 修复 → 绿灯**：计数与逐项 `toEqual`（修复前 20/26）必红 → 按上表改 → 复跑 + `npm run verify:nikkisync` 转绿。
- **节点后子集**：上述 + `npx vitest run scripts/__tests__/pre-dist-check.test.ts`。
- **依赖**：N1 绿 → N2；N2 绿 → N3。

### N3 — 22 项滤镜图标资源 + 打包面断言

- **修改文件**：`ROOT/scripts/stage-nikkisync-pc-assets.ts`（`PC_ASSET_SPECS` 9→31：1 条 `manifest.json` + 21 条 `effects/filter-1090020NNN.webp`，NNN ∈ `0001..0017,0019..0022`，目标 `photo-filter-icons/` 下与上游同构）、`ROOT/scripts/__tests__/stage-nikkisync-pc-assets.test.ts`（计数 31、spec 的 `to` 集合 == manifest `file` 集合 ∪ {manifest.json}）、`ROOT/scripts/pre-dist-check.ts`（新增 `missingPhotoFilterIconAssets(root, exists)` 纯函数 + 断言 `package.json.extraResources` 覆盖 `resources/nikkisync/pc` 的 `{clothing-icons,photo-filter-icons}` 两目录）、`ROOT/scripts/__tests__/pre-dist-check.test.ts`、新增资源文件（由 apply 生成）。**`ROOT/package.json` 核对后不改**（`build.files` 含 `resources/**/*`、`extraResources` 的 `{from:"resources/nikkisync/pc",to:"nikkisync/pc",filter:["**/*"]}`、`asarUnpack` 已覆盖；`.prettierignore` 已整目录豁免）。
- **输入 / 输出**：`UP/assets/photo-filter-icons/**` → `ROOT/resources/nikkisync/pc/photo-filter-icons/**`。
- **验收标准**：`npx tsx scripts/stage-nikkisync-pc-assets.ts` 输出 `status=dry-run planned=31 copied=0`；`npm run stage:nikkisync-pc` 输出 `status=applied planned=31 copied=31 skipped=0`；22 个新文件存在；两个资源测试 `0 failed`。
- **红灯 → 修复 → 绿灯**：两个 `toHaveLength(31)`（修复前 9）必红 → 加 22 条 spec + 断言 → **先 dry-run 再 apply** → 复跑转绿。
- **节点后子集**：上述 + `npm run format:check`。
- **依赖**：N2 绿 → N3；N3 绿 → N4。

### N4 — 图标包装载 + 服务端/画廊侧注入（核心功能节点）

- **修改文件**：
  - `ROOT/src/main/nikkisync/runtime-facade.ts`：`loadRuntimeSurface` 变量式装载 `LOCAL_CLOTHING_ICON_PACK_DEEP_ENTRY`；`createRuntimeSession` 内 `await` 两次 `loadLocalClothingIconPack(clothingIconsDir / photoFilterIconsDir)`，`withLocalPhotoEffectIcons(main, supplement)`，仅 `main.valid===true` 时把**完整 pack** 注入 `server.localClothingIcons`；有 pack 时**不构造** `MetadataThumbnailCache`、不注入 `serverConfig.metadataThumbnailCache`；会话 handle 挂出 `localClothingIcons`。
  - `ROOT/src/main/nikkisync/runtime-types.ts`：`NikkiSyncSessionOptions` + `clothingIconsDir?` / `photoFilterIconsDir?`；`NikkiSyncRuntimeSession` / `PcCompanionSessionContext` + `localClothingIcons?`。
  - `ROOT/src/main/app/nikkisync-runtime-setup.ts`：`buildSessionOptions()` 加两个目录（dev `resolvePcAssetsDir(...)` 下、打包 `process.resourcesPath/nikkisync/pc/` 下）；`assemblePcCompanionServices()` 透传 `localClothingIcons`。
  - `ROOT/src/main/nikkisync/runtime-manager.ts`：`pcCompanionContext()` 透传 `localClothingIcons`（复用既有 `thumbnailCache` 模式）。
  - `ROOT/src/main/nikkisync/pc-companion-services.ts`：`PcCompanionServicesOptions` / `StartPcCompanionOptions` + `localClothingIcons?: unknown`；`PcCompanionSurface` + `convertWeChatWebp`（从 `WECHAT_ICON_PROVIDER_DEEP_ENTRY` pick）；pack 在位时 `createIndexedPreviewSource` options 注入 `localClothingIcons` + `convertLocalWebp`（委托 `convertWeChatWebp(bytes, ffmpegPath)`，失败回落 `resizeIcon`），并**省略** `loadIcon`、不构造 `WeChatIconProvider`；pack 缺席时行为与现状逐字一致。
  - `ROOT/src/main/nikkisync/pc-companion-services.test.ts`：新增正常/异常/边界用例。
- **输入 / 输出**：两个绝对目录 + 上游 loader → `server.localClothingIcons` 完整 pack、`MetadataDictionaryService` 第三参 `localIconVersion`、`LocalSyncServer.streamEffectThumbnail` / `clothingThumbnailSource`、画廊分享图三类效果图标可用且服装图标不退化。
- **验收标准（可判定）**：`npx vitest run src/main/nikkisync/pc-companion-services.test.ts src/main/nikkisync/runtime-facade.test.ts` `0 failed`；`npm run typecheck` 0 error；`npm run verify:nikkisync` blocking 0；`runtime-facade.linked.test.ts` 会话仍能建库、`metadataResolver` 面不回退；`previewOptions.loadIcon` 在有 pack 时为 `undefined`。
- **红灯 → 修复 → 绿灯**：§6 N4 四条断言修复前必红 → 字段追加 + 装载 + 合并 + 注入 + 有包时切离线图标路径 → 复跑 + `npm run verify` 转绿。
- **节点后子集**：上述 + `npx vitest run src/main/nikkisync/runtime-manager.test.ts src/main/nikkisync/runtime-facade.linked.test.ts`、`npm run typecheck`、`npm run lint`、`npm run verify:nikkisync`。
- **依赖**：N3 + N0.5 绿（两目录资源在位）→ N4；N4 绿 → N5。

### N5 — GalleryRuntime / 传递导出面「非破坏性」核验 + 文档

- **修改文件**：`ROOT/scripts/__tests__/nikkisync-baseline-pin.test.ts`（`GalleryRuntime.mjs` 字节数/mtime 断言）、`ROOT/src/main/nikkisync/pc-companion-services.test.ts`（`GallerySource` 新字段形状用例）、`ROOT/src/main/nikkisync/AGENTS.md`（新增「2026-11-13 对齐 a49764bb」订正节：新基准、27 roots / 24 artifacts、31 项资源、18 张业务表、图标包目录与注入口径）。**不改** `src/shared/sync/**`、`protocol-contract.ts`、`runtime-loader.ts`、`probe.ts`。
- **输入 / 输出**：重 build 产物 → 核验记录（无行为改动）：`GallerySource` 5 个新字段与 `GalleryEvents.expiryChanged?` 全为追加/可选化；`mapAssetDetail` 第三参可选、本仓两参等价 `false`；`WeChatIconProvider` 构造 `(cache, resize, timeoutMs=15000)` 未变；B 组传递导出（`MetadataResolutionOutcome`、`MetadataResolutionFailure`、`resolveBatch`、`batchSize`）由 `export *` 带出但必需导出表是子集 → 探针不误报；`packages/protocol` 零变化 → `protocol-drift.test.ts` 零差异。
- **验收标准**：`npx vitest run src/main/nikkisync/protocol-drift.test.ts src/main/nikkisync/probe.test.ts src/main/nikkisync/runtime-loader.test.ts scripts/__tests__/nikkisync-baseline-pin.test.ts` `0 failed`；`npm run verify` 的 `core-path-gate` 无本轮命中。
- **红灯 → 修复 → 绿灯**：恒绿断言 `toContain('shareDetails')` 按硬约束改写为字节数/mtime 断言（§6 N5）→ 本节点只补断言与文档，不改生产代码。
- **节点后子集**：上述 + `npm run verify`、`npm run i18n:guard`、`npm run i18n:check`。
- **依赖**：N4 绿 → N5；N5 绿 → N6。

### N6 — 全量回归 + 验收记录回写 + 最终报告

- **修改文件**：`ROOT/docs/plans/2026-11-13-nikkisync-pc-align-1.0.40-实施计划.md`（逐节点回写实测读数）、`ROOT/src/main/nikkisync/AGENTS.md` / `ROOT/scripts/AGENTS.md` / 根 `AGENTS.md`（仅当目录结构或脚本清单变化才补一行，预计不改，如实记录）。
- **输入 / 输出**：N0–N5 全部改动 → §8 全量表执行完毕 + 最终报告。
- **验收标准**：全量表逐条通过（`audit` 联网失败按 §8 记阻塞项）；`git status --porcelain` 改动文件 ⊆ 本计划清单；`git log -1` 执行前后一致（未 commit）。
- **节点后子集**：§8 全表。

## 8. 回归与全局校验命令表（真实存在，逐条）

| #   | 命令                                                                                                                                                                                                                                                         | 通过判据                                                                                                 | 失败处置                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `npm test`                                                                                                                                                                                                                                                   | `vitest run` 全量 `0 failed`                                                                             | 定位失败文件回对应节点重做 TDD，不得 skip/弱化                                                                                        |
| 2   | `npm run lint`                                                                                                                                                                                                                                               | `eslint .` 0 error                                                                                       | 修 lint，不格式化无关文件                                                                                                             |
| 3   | `npm run typecheck`                                                                                                                                                                                                                                          | `tsc -b && tsc -p tsconfig.scripts.json` 0 error                                                         | 修类型；新增字段全链路可选                                                                                                            |
| 4   | `npm run typecheck:e2e`                                                                                                                                                                                                                                      | 0 error                                                                                                  | 修 e2e 类型                                                                                                                           |
| 5   | `npm run format:check`                                                                                                                                                                                                                                       | `prettier --check` 全通过                                                                                | 仅格式化本次改动 `.ts`/`.md`；资源目录已被 `.prettierignore` 豁免                                                                     |
| 6   | `npm run i18n:guard` / 7 `npm run i18n:check`                                                                                                                                                                                                                | 0 error（无新增 i18n key）                                                                               | 报警说明误加 key，撤销                                                                                                                |
| 8   | `npm run verify`                                                                                                                                                                                                                                             | 串联 tsc -b / eslint / **core-path-gate** / prettier / 相关单测全绿                                      | core-path-gate 可能命中工作区既有未提交改动：逐条核对是否本轮引入，非本轮引入如实记录、不顺手修、不为转绿弱化                         |
| 9   | `npm run verify:nikkisync`                                                                                                                                                                                                                                   | `OK (blocking failures: 0)`、`24 项`、`27 root(s)`、闭包 `visited>=50` / `dangling=[]` / `unreadable=[]` | `blocking>0` → 回 N0/N2                                                                                                               |
| 10  | `npm run link:nikkisync:check`                                                                                                                                                                                                                               | 4 条 `ok`                                                                                                | 重跑 `npm run link:nikkisync`                                                                                                         |
| 11  | `npm run audit`                                                                                                                                                                                                                                              | `audit-ci --config ./audit-ci.jsonc` 通过                                                                | **需联网官方 registry**；`ENOTFOUND`/超时/403 如实记为**阻塞项（not-pass）**，写明网络原因，不记为绿、不用 `npm audit --offline` 替代 |
| 12  | `npx tsx scripts/stage-nikkisync-pc-assets.ts`                                                                                                                                                                                                               | `status=dry-run planned=31 copied=0 skipped=0`                                                           | 缺件 → 回 N3                                                                                                                          |
| 13  | `npm run stage:nikkisync-pc`                                                                                                                                                                                                                                 | `status=applied planned=31 copied=31 skipped=0`（**含 `--apply`**）                                      | 目标逃逸 → 查 spec `to`；单件缺失 → warn+skipped 回 N3                                                                                |
| 14  | `npx vitest run scripts/__tests__/verify-nikkisync-link.test.ts scripts/__tests__/stage-nikkisync-pc-assets.test.ts scripts/__tests__/pre-dist-check.test.ts scripts/__tests__/nikkisync-baseline-pin.test.ts scripts/__tests__/nikkisync-icon-pack.test.ts` | 5 个脚本测试 `0 failed`                                                                                  | 回对应节点                                                                                                                            |
| 15  | `npx vitest run src/main/nikkisync/runtime-facade.linked.test.ts src/main/nikkisync/pc-companion-services.test.ts src/main/nikkisync/protocol-drift.test.ts src/main/nikkisync/runtime-manager.test.ts`                                                      | 链接态 + 纯函数档 `0 failed`                                                                             | 回 N1/N4/N5                                                                                                                           |

**不存在的命令（不得假设）**：`test:unit`、`test:e2e`、`verify:all`；`npm run e2e` 是误输入守卫（exit 1），不是测试入口，不跑。
**因「不打包」not-run**：`npm run dist:win`、`npm run verify:dist`、`npm run e2e:smoke`，以及依赖 `dist/main` 的 `pre-dist-check` 主体；其新增资源断言靠 #14 单测覆盖。

## 9. 剩余风险 / 阻塞项（最终报告口径）

1. **资产获取门禁**：271 MiB EXE 下载、SHA 校验、ZIP carving 与 `unzip -t` 任一失败 → 停并报阻塞；回退路径见 N0.5。`curl` 网络受限时不得用「假设产物存在」蒙混。
2. **不打包**：`build.files` / `extraResources` / `asarUnpack` 覆盖、`pre-dist-check --verify-asar`、装机版 74 MiB 图标包可读性只能静态判据（#14 单测），不能替代装机实测；列为 not-run 剩余风险。
3. **Node 22 vs Node 26**：上游 `engines.node>=24`；本仓 `*.linked.test.ts` 在默认 Node 22 真装载上游（`node:sqlite` 实验性）。若出现建库/`exec`/`prepare` 差异，用 Node 26 PATH 复跑链接态子集并如实记录两套读数，不改 `probe.ts` 下界或 `verify-nikkisync-link.ts` 判据。
4. **`GalleryRuntime.mjs` 是生成物、未入库**：只跑 `tsc` 不产出它，必须完整 `npm run build`（含 `build-wechat-runtime.mjs`）；旧产物 277961 B 不含 `shareDetails` 等新字段，由 `SYNC_SERVER_REQUIRED_ARTIFACTS` 与钉子测试双点名拦截。
5. **`git fetch` 网络回退**：`UP` 当前为 detached `4cb71e2`。若 fetch 失败，先 `git cat-file -t a49764bb…` 确认对象已在本地直接 checkout；对象不在则 `git fetch --depth=… origin <sha>`；仍失败 → 钉子测试必红，停并报阻塞。
6. **旧库事实更正**：上游 `initialize()` 无条件 exec 全文迁移且幂等，原「version=1 不重跑」前提不成立；本轮按裁决撤销自研 DDL，改用旧库升级回归测试作为证据。
7. **`1.0.32` 二进制与源码不一致**：release 明写「二进制包含尚未同步到仓库的本地修改」；本轮以仓库源码 `a49764bb` 为唯一基准，不追二进制。
8. **体积**：`resources/nikkisync/pc/clothing-icons/` 约 74 MiB（9000+ 文件）进入工作区，未 commit、未打包；`git status` 与仓库体积读数在 N6 如实回写。
9. **`core-path-gate` 与工作区既有未提交改动**：若报警须核对是否本轮引入，非本轮引入如实记录、不顺手修。

## 10. 最终输出模板（任务完成时按此结构汇报）

- **核对的提交范围**：4 个 SHA + 起止基准 + 分类（§1）。
- **差异与待同步清单**：必须补齐 / 零变化不动 / 明确不搬三组（§1）。
- **已完成的修改**：逐节点改动文件（完整路径）+ 实际落位资产 + 每节点红→绿实测读数。
- **验证结果**：§8 全量表逐条 pass/fail + not-run 项 + `git status` / `git log -1`（未 commit）读数。
- **剩余风险或阻塞项**：§9 九条，含 `audit` 联网结果。

**验收记录表（随 N0 落档建立，逐节点绿灯后立即回写 stdout 实测值，禁止誊抄预期判据）**：N0 `rev-parse HEAD` / `GalleryRuntime.mjs` 字节数 / `verify:nikkisync` blocking；N0.5 四个 SHA / `entries.length` / 文件数；N1 表数 / 索引 / `schema_migrations` 行数 / 红→绿失败数；N2 24 / 27 / `closureLoadChain` 读数；N3 31 / dry-run 与 apply 的 `planned/copied/skipped`；N4 `cacheVersion` / `previewOptions` 键集合 / `loadIcon` 缺席；N5 新旧字节数 / 协议差异数 / core-gate 命中数；N6 全量表 pass/fail / 未 commit 判据。

## 验收记录（实测回写）

| 节点                               | 实测读数                                                                                                                                                                                                                                                          | 采集命令 / 状态                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| N0 红灯                            | `8 failed (8)`                                                                                                                                                                                                                                                    | `npx vitest run scripts/__tests__/nikkisync-baseline-pin.test.ts`（旧基准 `4cb71e2`） |
| N0 绿灯                            | `1 passed / 8 passed (8)`                                                                                                                                                                                                                                         | 同上，推进后                                                                          |
| N0                                 | `HEAD = a49764bbf98fcb26a84f2356b78d48c459d3da2e`；`git status --porcelain` 空                                                                                                                                                                                    | `git -C UP rev-parse HEAD`                                                            |
| N0                                 | `GalleryRuntime.mjs = 297158 B`（旧 277961 B）                                                                                                                                                                                                                    | `wc -c`                                                                               |
| N0                                 | 4 个新 metadata `dist/src/*.js` 全部存在；迁移 `0001_initial.sql:169/179/185` 含 2 表 1 索引                                                                                                                                                                      | `ls` + `grep`                                                                         |
| N0                                 | `link:nikkisync:check` = 4 条 ok + `check OK`；`verify:nikkisync` = `OK (blocking failures: 0)`、`resolved 82 module(s) reachable from 26 root(s)`                                                                                                                | npm scripts                                                                           |
| N0                                 | stage dry-run 基线：`status=dry-run planned=9 copied=0 skipped=0`                                                                                                                                                                                                 | `npx tsx scripts/stage-nikkisync-pc-assets.ts`                                        |
| N0                                 | 上游构建 `node=v26.3.0`，`npm run clean && npm run build` 退出码 0                                                                                                                                                                                                | Node 26 PATH                                                                          |
| N0.5 红灯                          | `1 failed (1) / no tests`（模块 `../extract-nikkisync-icon-pack` 缺失）                                                                                                                                                                                           | `npx vitest run scripts/__tests__/nikkisync-icon-pack.test.ts`                        |
| N0.5 绿灯                          | `9 passed (9)`（含真实资产断言，0 skipped）                                                                                                                                                                                                                       | 同上，资产落位后                                                                      |
| N0.5                               | EXE `284094868 B` / SHA `7d4aad76…` 匹配；内嵌 ZIP `77678905 B` / SHA `ddd70fbf…` 匹配；`unzip -t` 通过；manifest SHA `c39e0f67…` 匹配                                                                                                                            | `curl` + `sha256sum` + `npx tsx scripts/extract-nikkisync-icon-pack.ts --exe …`       |
| N0.5                               | `entries=9162`、`samplesVerified=10`；落位 `resources/nikkisync/pc/clothing-icons/` 共 `9578` 文件 / `98M`                                                                                                                                                        | 提取脚本 `--apply` + `find`/`du`                                                      |
| N0.5                               | `THIRD_PARTY_NOTICES` 新增第 6 节署名并澄清第 1 节在线通道口径；`prettier --check` 三个新脚本全通过                                                                                                                                                               | 只读核对                                                                              |
| N1 红灯                            | `3 failed / 17 passed (20)`，三条均因 `MIGRATION_TABLES` 仍为 12 张（缺 `nuan5_resolution` / `nuan5_endpoint_state`）                                                                                                                                             | `npx vitest run src/main/nikkisync/runtime-facade.linked.test.ts`                     |
| N1 绿灯                            | `20 passed (20)`                                                                                                                                                                                                                                                  | 同上，闭集更新后                                                                      |
| N1                                 | 业务表 `14 迁移 + 4 运行期 + sqlite_sequence = 19`；`idx_assets_resolver_fingerprint` 存在；`schema_migrations` 恰好 1 行 `{version:1,name:'initial_asset_resource_sync_schema'}`                                                                                 | 新版与「4cb71e2 旧库 → 新版启动」两用例                                               |
| N1                                 | `npm run typecheck` 退出码 0                                                                                                                                                                                                                                      | `tsc -b && tsc -p tsconfig.scripts.json`                                              |
| N1                                 | 既有环境断言：`probe.test.ts:176` 要求宿主 Node ≥24。Node 22 默认 → `1 failed / 7 passed`；Node 26 → `22 passed (22)`。本轮未改该判据，两套读数如实记录                                                                                                           | 两套 PATH 复跑                                                                        |
| N2 红灯                            | `2 failed / 51 passed (53)`：能力清单期望 24 实为 20、根表期望 27 实为 26                                                                                                                                                                                         | `npx vitest run scripts/__tests__/verify-nikkisync-link.test.ts`                      |
| N2 绿灯                            | `128 passed (128)`（verify-nikkisync-link + pre-dist-check 两文件）                                                                                                                                                                                               | 同上 + `pre-dist-check.test.ts`                                                       |
| N2                                 | `NIKKISYNC_CAPABILITY_ARTIFACTS=24`、`LOAD_CHAIN_ROOTS=27`、`runtime-facade.ts` 26 个 `*_DEEP_ENTRY`；`closureLoadChain` = `83 module(s) / 27 root(s)`、`dangling=[]`                                                                                             | `npm run verify:nikkisync`                                                            |
| N2                                 | `npm run typecheck` 退出码 0                                                                                                                                                                                                                                      | `tsc -b && tsc -p tsconfig.scripts.json`                                              |
| N3 红灯                            | `4 failed / 8 passed (12)` + `pre-dist-check.test.ts` 整件导入失败（新增导出尚未存在）                                                                                                                                                                            | `npx vitest run` 两个测试文件                                                         |
| N3 绿灯                            | `91 passed (91)`；N2+N3 合并子集 `144 passed (144)`                                                                                                                                                                                                               | 同上 + verify-nikkisync-link.test.ts                                                  |
| N3                                 | dry-run `status=dry-run planned=31 copied=0 skipped=0`；apply `status=applied planned=31 copied=31 skipped=0`；`photo-filter-icons/` 22 文件                                                                                                                      | `npx tsx scripts/stage-nikkisync-pc-assets.ts` / `npm run stage:nikkisync-pc`         |
| N3                                 | `PHOTO_FILTER_ICON_IDS=21`（缺 0018）；`prettier --check` 9 个改动文件全通过                                                                                                                                                                                      | 只读核对                                                                              |
| N4 红灯                            | `5 failed / 87 passed (92)`：`server.localClothingIcons` 缺失、画廊侧未注入、无 warn、补充包无效时未只用主包                                                                                                                                                      | `npx vitest run` runtime-facade.test.ts + pc-companion-services.test.ts               |
| N4 绿灯                            | `92 passed (92)`；节点后 5 文件子集 `261 passed (261)`                                                                                                                                                                                                            | 同上 + runtime-manager / linked / nikkisync-runtime-setup                             |
| N4                                 | 真实上游 loader 实读：`mainValid=true`、`suppValid=true`、`mergedValid=true`、`cacheVersion=f3e0f192…`（64 hex）、`entries=9162`、主包 `effectEntries=394`；`read('1020100001')` → 9588 B `image/webp`；`readEffect('filter','1090020001')` → 3946 B `image/webp` | `node --input-type=module -e` 直调上游 `LocalClothingIconPack.js`                     |
| N4                                 | `npm run typecheck` 0 error、`npm run lint` 0 error、改动 7 文件 `prettier --check` 通过、`verify:nikkisync` blocking 0                                                                                                                                           | 只读核对                                                                              |
| N4                                 | 画廊侧互斥判据：`localClothingIcons` + `convertLocalWebp` 注入、`loadIcon` 缺席、`WeChatIconProvider` 零构造；转换器缺席时 warn 并回落在线模式                                                                                                                    | 三个新增用例                                                                          |
| N5                                 | `GalleryRuntime.mjs` 277961 B → **297158 B**；新字段 `shareDetails`(4) / `cachedDetails`(5) / `previewCacheKeys`(5) / `galleryItemLimit`(2) / `refreshIfIndexChanged`(3) / `expiryChanged`(1) / `localClothingIcons`(12) / `convertLocalWebp`(2) 均在产物中       | `wc -c` + `grep -c`                                                                   |
| N5                                 | 四个入口 `index.ts` 在 `4cb71e2..a49764bb` 的 `git diff --stat` 为空 ⇒ 协议/包根导出零变化，vendored 契约无需同步                                                                                                                                                 | 只读 git diff                                                                         |
| N5                                 | `core-path-gate`：「本次变更不涉及核心路径受保护文件，跳过」（0 命中）；`npm run verify` = 5 项 / 0 失败 / 相关单测 `405 passed`，`core-gate ✓`、`format ✓`                                                                                                       | `npx tsx scripts/core-path-gate.ts`、`npm run verify`（Node 26）                      |
| N5                                 | 子集 `119 passed (119)`（协议漂移/探针/必需导出表/契约/钉子/图标包/文档链接）；`i18n:guard` 与 `i18n:check` 均通过                                                                                                                                                | 定向 vitest + npm scripts                                                             |
| N5                                 | 文档订正：`src/main/nikkisync/AGENTS.md` 新增 2026-11-13 节；`scripts/AGENTS.md` 计数 81→84、stage 行 9→31 项、新增 3 行登记表                                                                                                                                    | 文档修改                                                                              |
| N5                                 | 为达成「全量回归零失败」修复 5 处文档死引用（**仅措辞、未改闸门逻辑**）：既有 3 处在 11-12 计划（标注「计划新增且未实施」）、本轮 2 处在 AGENTS.md（标注「尚未纳入版本控制」）；`check-md-links.test.ts` 由 1 failed 转 `24 passed`                               | 同行注解命中既有 `GONE_MARKERS`                                                       |
| N5                                 | 说明：本节点为核验节点，**未新增恒绿断言**（N0 的 `size > 277961` 已真实经历红灯→绿灯），按「不伪造红灯」处理                                                                                                                                                     | —                                                                                     |
| N6 全量 `npm test`（Node 26）      | **512 files / 8339 passed / 20 skipped / 0 failed**，EXIT=0，71.78s                                                                                                                                                                                               | `npm test`（`PATH=/c/Program Files/nodejs:$PATH`）                                    |
| N6 全量 `npm test`（默认 Node 22） | `510 files / 1 failed / 8306 passed / 20 skipped`，EXIT=1；唯一失败为**既有** `probe.test.ts:176` 宿主 Node≥24 断言（本轮未改该判据）                                                                                                                             | `npm test`（默认 PATH），如实记录两套读数                                             |
| N6 静态/类型/格式                  | `typecheck` 0、`typecheck:e2e` 0、`lint` 0、`format:check` 0（All matched files use Prettier code style）                                                                                                                                                         | 四条 npm scripts                                                                      |
| N6 i18n / 闸门                     | `i18n:guard` 0、`i18n:check` 0（12 语包 4277 keys 对齐）；`verify` 5 项 0 失败（相关单测 405 passed，core-gate ✓ / format ✓）；`verify:nikkisync` blocking 0（83 modules / 27 roots）；`link:nikkisync:check` 4 条 ok                                             | 五条 npm scripts                                                                      |
| N6 安全                            | `npm run audit` EXIT=0「Passed npm security audit.」（既有 allowlist 生效，无新增豁免）                                                                                                                                                                           | `audit-ci --config ./audit-ci.jsonc`                                                  |
| N6 资源                            | dry-run `planned=31 copied=0 skipped=0`；apply `planned=31 copied=31 skipped=0`；`photo-filter-icons` 22 文件 / `clothing-icons` 9578 文件                                                                                                                        | stage 两条命令                                                                        |
| N6 定向组                          | A（5 个脚本闸门）`161 passed`；B（4 个装载缝）`158 passed`                                                                                                                                                                                                        | 定向 vitest                                                                           |
| N6 未 commit                       | `git diff --cached --name-only` 为空；`git log -1` = `9b1ea80aad065d59ecfcfdea8b4cb1bfaccba624`；本轮未执行任何 `git commit`/`git add`                                                                                                                            | 只读 git                                                                              |
| N6 未打包                          | `release/MeowStarMap-Setup-2.5.7-beta.exe` mtime `2026-11-12 23:12:18`（早于本轮），大小 `189174797` B 未变；`dist:win` / `verify:dist` / `e2e:smoke` **not-run**                                                                                                 | `stat` + 命令未执行                                                                   |
| N6 改动范围                        | tracked 改动 18 文件（623 insertions / 34 deletions）；untracked 6 个顶层条目（计划 MD、2 个资源目录、2 个测试、1 个提取脚本）；上游克隆 HEAD = `a49764bb…`                                                                                                       | `git status` / `git diff --stat`                                                      |
| N6 既有失败处置                    | 为达成全量零失败修 5 处文档死引用（3 处 11-12 计划既有 + 2 处本轮新增），仅措辞、未改 `check-md-links.ts` 判据；`check-md-links.test.ts` 由 `1 failed` 转 `24 passed`                                                                                             | N5 记录                                                                               |

## 复核发现、按已批准范围未纳入的项（诚实清单）

**上游 1.0.39「电脑端优先本地解析照片」的宿主装配未接线。** 复核证据：
`apps/pc-companion/src/windows-app.ts:136-137` 调
`createLocalPhotoMetadataResolver(process.env.NIKKISYNC_RECYCLE_HELPER, path.dirname(process.execPath), onlineResolver, () => onlineConsent.enabled())`，
再由 `:141` 以 `resolver = localResolver ?? (nuan5Endpoints.length === 0 ? onlineResolver : undefined)` 优先本地解码。
`LocalPhotoMetadataResolver.ts` 的守卫要求 `win32` + 绝对 helper 路径 + `existsSync(path.join(directory,'nuan5_decryption.dll'))`。

本仓虽已有 `resources/nuan5_decryption.dll`(507392 B) 与
`resources/nikkisync/nikkisync-recycle-helper.exe`(5120 B)，且 `initNikkiSyncRuntime()` 已注入
`NIKKISYNC_RECYCLE_HELPER` env，但存在三点与批准范围冲突，故本轮未改：

1. **布局不等价**：上游 C# 单文件 EXE 把 DLL 放在 `path.dirname(process.execPath)`；本仓 Electron
   的 DLL 在 `resources/` 下，且 `build.extraResources` 的 `resources/nikkisync` 项 filter 仅
   `*.exe`，**打包态 DLL 未必在 helper 可见的磁盘位置**。本轮「不打包」，无法实测装机态。
2. **会改动 K2 同意门链路**：本仓 `createRuntimeSession` 的 `createResolver` 回调把在线 resolver
   交 `metadataConsent.guard()` 包装（fail-closed 出站门）；插入本地 resolver 需重新编排 guard
   与 `buildMetadataResolverConfig`，属于对已交付在线解析链路的实质改动，回归风险高。
3. **超出已批准计划的「必须补齐」清单**：计划明确「另 3 个新 metadata 产物为上游静态传递依赖，
   由 `closureLoadChain` 覆盖，不预载未用符号」。复核修正了当初「依赖 C# 外壳、R1 不搬」的判断
   （实际依赖的是本仓已有的 helper/DLL），但按「确认后再执行」口径不擅自扩大范围。

**若需另立节点，具体补齐面**（供决策，不代表本轮已做）：新增第 28 个深入口
`LOCAL_PHOTO_RESOLVER_DEEP_ENTRY` 并同步 `LOAD_CHAIN_ROOTS` / 闭集计数；新增 2 个 session options
（helper 绝对路径、DLL 目录）由 `buildSessionOptions` 注入；在 `createRuntimeSession` 的
`createResolver` 回调里以 `createLocalPhotoMetadataResolver` 包装 guarded resolver，缺席/异常时
回落现状；`package.json` extraResources 增加 DLL；补正常/异常/边界 TDD 用例后重跑全量回归。

**其余上游能力的归属（均已随本轮生效或不搬）**：批量请求 / 统一限流 / 跨重启重试
（`Nuan5CompatibleResolver` + `MetadataResolverService` + `MetadataInputFingerprint`）、
中文摄影名校验（`VerifiedPhotographyNames`）、输入指纹失效索引、桌面 9 个面板、
`LocalSyncServer` / `row-mappers` / 微信画廊与分享图三类效果图标均随完整 rebuild 与本次接线生效；
Android「最近拍摄」分组、C# 程序自动更新 / 图标差量通道 / 托盘自启 / 支持网关按 R1 明确不搬。
