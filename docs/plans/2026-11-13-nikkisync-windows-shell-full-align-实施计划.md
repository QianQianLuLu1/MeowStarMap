# NikkiSync Windows-Shell 能力全量对齐实施计划（待确认）

> 状态：**待确认，确认后逐节点执行**。
> 路径前缀：`ROOT = D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe`；`UP = D:/Workbuddy 项目/WXNN YD - 副本/NikkiSync`；`HANDOFF = D:/Users/Downloads/LOCALIZATION_HANDOFF_2026-11-12.md`。
> 本文件是 Plan 模式下唯一可写落点。**执行期第一个动作**是把本文原样写入 `ROOT/docs/plans/2026-11-13-nikkisync-windows-shell-full-align-实施计划.md`，**未完成落盘不得修改任何业务代码**（满足「先出 MD 计划并写入仓库、确认后再执行」）。
> 全程 **禁止 `git add` / `git commit`**；禁止打包；所有验证在会话级 Node 26 PATH 下由我亲自执行并修复报错。

---

## 0. 判断、提交范围核对与差异清单

### 0.1 直陈判断（不绕弯）

1. GitHub `ToStardust/NikkiSync` 的 main HEAD = `a49764bbf98fcb26a84f2356b78d48c459d3da2e`（2026-11-11T16:58Z / 北京时间 11-12 00:58，tag `v1.0.40-public-beta.2`）；`fix/windows-scan-alias-ci` 分支尖为同一 SHA，其余分支更旧；最新 release 也是 beta.2，**之后无任何 PC 相关提交**。本地克隆 HEAD 与 GitHub 一致。
2. **1.0.40 产物层已全量对齐并入库**：ROOT 工作区干净，HEAD `5b0ec43`（2026-11-13 13:52）；`docs/plans/2026-11-13-nikkisync-pc-align-1.0.40-实施计划.md` 的 N0–N6 逐节点红→绿记录完整，Node 26 全量 `npm test` = `512 files / 8339 passed / 0 failed`。磁盘实测：`clothing-icons/manifest.json` 9162 entries / 192 fallback / 394 effect（9578 文件）、`photo-filter-icons/manifest.json` 21 effectEntries（22 文件）、`nuan5_decryption.dll` 507392 B、`nikkisync-recycle-helper.exe` 5120 B、`LOCAL_CLOTHING_ICON_PACK_DEEP_ENTRY` 与 `convertLocalWebp` 接线在位、`verify-nikkisync-link.ts` 24 artifacts / 27 roots。**本轮一律不重做产物层**（不 rebuild 上游、不再提图标包、不改表闭集），只补宿主装配与 C# 外壳能力。
3. 交接文档是上游本地化/跨端交接，PC 侧职责＝本机解码、缓存参数与部件字典、读取本地图标包、向已配对客户端提供详情与图标；Android/鸿蒙/小程序本体、iPhone LIVP、CNB 发布端与签名私钥属维护者侧，不在本仓闭环。
4. 扩大的 C# 外壳范围里**大部分能力 ROOT 已有成熟实现**，搬 C# 版即重复造轮子，故按 §0.4 采取「暴露/观测/扩展」而非重写。

### 0.2 核对的提交范围（只读实测）

| 项                          | 读数                                                                                                                                                 | 采集命令                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| UP HEAD                     | `a49764bbf98fcb26a84f2356b78d48c459d3da2e` / `v1.0.40-public-beta.2` / 2026-11-12 00:58 +0800                                                        | `git -C UP log -1 --format="%H %cI %d %s"`                                                   |
| 起止（上次同步锚点 → 最新） | `4cb71e2`(v1.0.31) → `a49764bb`，共 4 提交：`bc3f636`(1.0.39 主变更)、`6c96783`(test/doc)、`ec139a2`(1.0.40 滤镜/分享效果图标)、`a49764bb`(test/doc) | `git -C UP log --oneline 4cb71e2..a49764bb` + GitHub commits API（path `apps/pc-companion`） |
| GitHub 无更新               | `origin/main` = HEAD；`fix/windows-scan-alias-ci` = 同 SHA；其余 feature 分支 SHA 更旧；release 最新 `v1.0.40-public-beta.2`(2026-11-11T17:02:43Z)   | GitHub branches/releases/commits                                                             |
| ROOT                        | HEAD `5b0ec43`，`git status --porcelain` 空                                                                                                          | 只读 git                                                                                     |
| Node                        | 默认 `v22.22.2`；`/c/Program Files/nodejs/node.exe` = `v26.3.0`                                                                                      | `node -v`                                                                                    |

### 0.3 差异与待同步清单（三组）

**A. 已完成且保留（本轮不动）**：1.0.40 全部产物、图标包资源、24 artifacts / 27 roots、18 张业务表、`GalleryRuntime.mjs`、已提交的对齐计划与 THIRD_PARTY_NOTICES 第 6 节；`resources/nikkisync/pc/**` 与两个二进制（`.gitignore` 204/210/211 忽略但在盘）原样保留。

**B. 本轮补齐（逐节点）**

| 编号    | 缺口（对照 `UP/apps/pc-companion/src/windows-app.ts` 逐行核过）                                                                                                                                                                                                                  | 节点    |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| G1      | `createLocalPhotoMetadataResolver`（UP:136-140）未装载；深入口 `dist/src/metadata/LocalPhotoMetadataResolver.js` 只在能力清单、不在 `LOAD_CHAIN_ROOTS`；本地解码优先链缺失                                                                                                       | N1      |
| G2      | `metadataResolver.service.canResolve` / `onWorkSettled`（UP:186-191）缺失；`metadata-resolver-driver.ts:97-115` 只发 `{enabled,batchSize:4}`                                                                                                                                     | N2      |
| G7      | `setMetadataConsent`（`runtime-manager.ts:881-888`）未调 `metadataResolver.reconsider()`                                                                                                                                                                                         | N2      |
| partial | 字典 updater `onWorkSettled`/`intervalMs`；`CachedDecodedMetadataService` 未带 dictionary；`RuntimeMemoryMaintenance` 仅 1 处触发；`onlineConsent.abortPending` 拆除；`recipients`/`invalidResolverFile`/`nuan5QueueStatus`/`galleryCacheSecret`/`NIKKISYNC_DESKTOP_PORT` 观测面 | N2 / N3 |
| G3      | scanner 构造期 `allowMissingInstallation`/`extraDirectories`/`retiredExtraDirectories`/`onProgress`/`onSettled`/`cachedInstallRoot`/`onDiscoveryComplete`（UP:151-166）与 `game-install-root.txt` 缓存缺失；`runtime-facade.ts:941-946` 只有 `selectedInstallRoot`+`watcher`     | N3      |
| G6      | `metadata-status.json` / `scan-status.json` / `startup-error.log` / `game-discovery.log` / `startup-service-timings.json` 不落盘                                                                                                                                                 | N3      |
| G4      | 本地字典 manifest `loadMetadataDictionaryFile` + `clothingNameSupplement`（UP:101-102,167-168）缺失                                                                                                                                                                              | N4      |
| G5      | `GameVersionUpdateService` 在 `pc-companion-services.ts:365-367` 零参构造，上游签名为 `(database,{onCalendarChanged})`                                                                                                                                                           | N5      |
| C#-1    | 图标包签名增量通道（CNB catalog + `.sig`、RSA、delta ZIP、staging/原子激活/回滚、userData 可写覆盖、IPC+UI+i18n）                                                                                                                                                                | N6      |
| C#-2    | 托盘（ROOT 全 `src` 无 `Tray` 实现）                                                                                                                                                                                                                                             | N7      |
| C#-3    | xdelta3 差分程序更新客户端 + UpdateWindow 等价 UI                                                                                                                                                                                                                                | N8      |
| C#-4    | 匿名诊断提交/回执 + 网络冲突修复 + 临时热点（均 opt-in）                                                                                                                                                                                                                         | N9      |

**C. 明确阻塞 / not-run（如实标注）**：签名私钥 `%USERPROFILE%\.momo-camera-updates\update-signing.dpapi` 两仓均无（上游注「private key never enters the project」）；CNB 上传为维护者手工动作；`MOMO_SUPPORT_CNB_TOKEN` + 私有 CNB 仓 + 反向代理缺位；真实签名 feed 无；管理员/系统态操作（防火墙 COM、WinRT 热点、EXE 原地自替换 helper）沙箱内不可实测；打包链与 GUI 目检 not-run；默认 Node 22 下 `probe.test.ts:176` 既有 1 失败不改判据。

### 0.4 C# 外壳重复项映射与最小对齐动作（守「禁重复造轮子」）

| 上游 C#                                                               | ROOT 已有                                                                                                                                                | 判定         | 最小动作                                                                                  |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| `RegistryRunEntryStore.cs`                                            | `src/main/app/login-item.ts`（`setLoginItemSettings`）                                                                                                   | 重复         | 不写注册表，仅 N7 状态卡观测                                                              |
| `StartupDiagnostics.cs` / `ConnectionDiagnosticsPackage.cs`           | `src/main/app/startup-*.ts`、`src/main/utils/startup-diagnostic.ts`、`src/main/services/log-service.ts exportLogsAsZip`、`src/main/utils/zip-archive.ts` | 重复         | N3 只补 5 个聚合 JSON/log 落盘供其读取，不重写打包器                                      |
| `LocalPhotoDecoder.cs` + `App.xaml.cs:17-21`                          | `src/main/services/decryption-service.ts`（koffi 同 DLL、同 5 个绑定）                                                                                   | 重复（核心） | N1 最小适配器复用 raw texts，**不新建 helper exe**                                        |
| `DesktopUpdates.cs` / `UpdateInstaller.cs` / `UpdateWindow.cs`        | `src/main/app/auto-update.ts`（electron-updater，autoDownload=false）、`src/renderer/components/common/UpdateDialog.tsx`                                 | 部分重复     | 不重写完整包通道；新增签名差分客户端 + 在既有 UpdateDialog stage 模型扩展一段，不新建窗口 |
| `IconPackUpdater.cs`                                                  | `runtime-facade.ts` 静态 `loadLocalClothingIconPack`                                                                                                     | 部分重复     | 静态包作兜底，新增签名增量客户端                                                          |
| `ServiceProcessHost.cs`                                               | Electron 无独立子服务进程                                                                                                                                | 语义重复     | 仅状态卡观测                                                                              |
| `SupportGatewayClient.cs`                                             | `FeedbackDialog.tsx`（GitHub issues + QQ 群）                                                                                                            | 非重复       | 新增匿名 `/v1/reports` 客户端 + 回执正则，FeedbackDialog 原样保留                         |
| `TrayService.cs` / `NetworkConflictRepair.cs` / `TemporaryHotspot.cs` | 无                                                                                                                                                       | 非重复       | N7 / N9 新增 opt-in 实现                                                                  |

**关键可行性已核实**：`UP/.../metadata/types.ts:42-61` 的 `PhotoMetadataResolver` 形状；`previousLocalValues` 唯一消费者是 `MetadataResolverService.ts:26-28,160-161` 的 `discardOldLocalValues()`，仅在 `localOnly && provider 相同` 的旧解码器刷新路径生效，ROOT 首次接入无历史缓存 → **最小适配器省略该字段是安全的**（§8 记录 + `version` 递增兜底）。`GalleryRuntime.mjs` 含 `setRemoteGameVersionReleases`（grep 计数 2）。公钥 PEM(634 B, SHA `c3faae9168387fbafc8e2f0bbb4965a49c0d952b7ea650cf5dbf4dffc5897197`)、xdelta3.exe(340992 B, SHA `732980d52f9220dc81817ccdd0c295eadce8a0048a24c2a771a73f791ac824e9`) 均已实测。

---

## 1. 依赖声明（新增/变更依赖、版本、安装方式）

**新增 npm 依赖（仅 1 个运行时 + 1 个类型包）**：签名 delta ZIP 需成熟只读 ZIP 读取器；ROOT 的 `archiver` 只创建、`scripts/extract-nikkisync-icon-pack.ts` 的 `carveZipFromBuffer` 只是 PE-carving，均非通用读取器。选 **`yauzl@^3.2.0`**（纯 JS、只读、`lazyEntries` 逐条校验、防 Zip-Slip / 声明长度欺骗）+ **`@types/yauzl@^2.10.0`**（dev）。其余全部复用既有：`node:crypto`（RSA）、`zod@^4.4.3`（schema）、Node 26 内置 `fetch`/`node:https`（Range/重定向）、Electron `Tray`/`Menu`/`nativeImage`、`sharp@^0.35.5`、既有 `child_process.execFile` 模式、`electron-updater@^6.8.9`。**零其它新增/变更/删除依赖**。

```
export PATH="/c/Program Files/nodejs:$PATH"
cd "D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe"
npm install --save yauzl@^3.2.0
npm install --save-dev @types/yauzl@^2.10.0
# npm install 会剪掉 4 条 @nikkisync junction（scripts/link-nikkisync.ts:27-30），必须紧接恢复：
npm run link:nikkisync
npm run link:nikkisync:check      # 4 条 ok + check OK
npm run verify:nikkisync          # OK (blocking failures: 0)
```

三条全绿才准进 N1；`verify-nikkisync-link.ts` 的 `collectOutOfRepoSpecs` 只拦 `file:../`/`workspace:` 逃逸，npm 正式包不受影响。

**非 npm 资产（复制入仓、纳入版本控制）**

| 资产          | 来源                                                 | ROOT 落位                                                   | 校验 / 打包                                                                                                                                                                                                                                                                          |
| ------------- | ---------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 公钥 PEM      | `UP/apps/windows-shell/Assets/update-public-key.pem` | `ROOT/resources/nikkisync/pc/signing/update-public-key.pem` | 634 B、SHA `c3faae91…`、SPKI 3072-bit RSA；`build.files` 已含 `resources/**/*`，另加 `extraResources` 显式 `{from:"resources/nikkisync/pc/signing",to:"nikkisync/pc/signing",filter:["**/*"]}`                                                                                       |
| xdelta3.exe   | `UP/assets/tools/xdelta3/xdelta3.exe`                | `ROOT/resources/nikkisync/xdelta3.exe`                      | 340992 B、SHA `732980d5…`、Apache-2.0 署名并入 `THIRD_PARTY_NOTICES`；现有 `extraResources[0] filter:["*.exe"]` 带走，另补显式条目；运行前二次校验 SHA                                                                                                                               |
| 托盘图标      | 复用 `ROOT/resources/icons/icon.ico`                 | 不复制                                                      | `nativeImage.createFromPath`                                                                                                                                                                                                                                                         |
| feed URL 常量 | 上游源码                                             | `ROOT/src/main/app/shell/signed-feed.ts`                    | `https://cnb.cool/nikkisync/icon-packs/-/releases/download/icons-update/MomoCamera-Icons-catalog.json`(`.sig`)；`…/windows-update/MomoCamera-Windows-update.json`(`.sig`)；`https://api.github.com/repos/ToStardust/NikkiSync/releases?per_page=20`；全部过 `requireHttpsUrl` 白名单 |

74 MiB 图标包、DLL、helper exe **不复制、不提交**（gitignored），静态兜底原样保留。`package.json` 只做加法，`build.files` 既有项不动。

---

## 2. 启动说明（环境准备 / 启动 / 验证方式）

```
# 所有验证命令必须在同一 shell 会话（会话级前置，不改系统默认、不装新版 Node）
export PATH="/c/Program Files/nodejs:$PATH"
cd "D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe"
node -v     # 必须 v26.3.0；每条验证命令前复读
```

- 开发启动（仅代码级，不作 GUI 验收）：`npm run dev`（`electron-vite dev`）。
- 逐节点：`npx vitest run <定向子集>` → `npm run typecheck` → `npm run verify`（只读，含 typecheck/lint/core-path-gate/format/相关单测）→ 绿灯才进下一节点。
- 全量：§7 全表，**每条 exit 0 才进下一条**。
- 真实存在的脚本逐字：`npm test`=`vitest run`；`typecheck`=`tsc -b && tsc -p tsconfig.scripts.json`；`lint`=`eslint .`；`verify`=`tsx scripts/verify-changes.ts`；`format:check`；`typecheck:e2e`；`i18n:guard`=`tsx scripts/i18n/guard.ts`；`i18n:check`；`audit`=`audit-ci --config ./audit-ci.jsonc`；`verify:nikkisync`；`link:nikkisync:check`。
- **不存在、禁止臆造**：`test:unit`、`e2e:all`、`verify:all`；`npm run e2e` 是退出码 1 的误输入守卫，不跑。
- **禁止**：`dist:win` / `verify:dist` / `e2e:smoke` / `stage:nikkisync-pc`（带 `--apply`）/ `npm run build` / `git add` / `git commit`。
- 人工 GUI 判据一律标「**未人工复核**」，不冒充装机实测：托盘菜单、UpdateDialog 签名差分段、SyncServicePage 新分区 12 语言、图标包激活后 `read()/readEffect()`、诊断回执与管理员操作。

---

## 3. 错误处理（异常分支 / 兜底 / 日志 / 资源释放）

| 类别                                                                                                                 | 策略                                                                                                             | 依据                                                    |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 公钥缺失/不可解析、签名长度越界、RSA 验签失败、catalog/manifest schema 非法                                          | **fail-closed**（抛错或 `verified:false` 并停），绝不「验签失败仍用旧数据伪装成功」                              | `DesktopUpdates.cs:41-62`、`IconPackUpdater.cs:106-159` |
| URL 非 https / 带 userinfo / loopback / 非白名单 host / fragment / 重定向 >6 跳 / 降级                               | **fail-closed**，逐跳重校验                                                                                      | `UpdateHttp.RequireHttps`                               |
| 下载超限、Content-Length 不符、Range 不满足、SHA/Size 不符                                                           | **fail-closed**：删 staging、保留旧包/当前 app                                                                   | `IconPackUpdater.cs:222-226`                            |
| ZIP 条目名非法（绝对路径 / `..` / 反斜杠 / 非 `IconPath` / 重复 / 缺 `update.json`+`manifest.json` / 解压实长≠声明） | **fail-closed**：整包拒绝、不落任何文件                                                                          | `IconPackUpdater.cs:30-32,330-364`                      |
| 原子激活任一步失败                                                                                                   | **回滚**：`active→previous`、`candidate→active` 成对，失败把 `previous` 移回；`ready.txt`/`update.lock` 用后即清 | `IconPackUpdater.cs:247-281`                            |
| xdelta3 子进程非零/超时/产物 SHA≠manifest                                                                            | **fail-closed + 回滚 staging**，回退完整包路径                                                                   | `DesktopUpdates.cs:163-192`                             |
| G6 诊断文件写失败                                                                                                    | **warn-fallback best-effort**，不中断启动/扫描；注释写明理由                                                     | `windows-app.ts:81-93,203-215,316-324`                  |
| 通道 DEFAULT OFF / 无有效签名 feed / 可写覆盖目录不存在                                                              | **warn-fallback**：保持现有静态图标包与 1.0.40 行为                                                              | 用户决策                                                |
| 支持网关未配置 / 非 201 / 回执非法                                                                                   | **fail-closed**：返回 `{status:'unavailable'}`，不重试、不上传                                                   | `SupportGatewayClient.cs:20-55`                         |
| 网络修复/热点 PowerShell 失败（opt-in）                                                                              | **warn-fallback + 明确用户文案**，不改既有防火墙、不关用户原有热点                                               | `TemporaryHotspot.cs:29-35`                             |
| 本地解码输入非法 / ABI≠1 / raw text 缺失                                                                             | **fail-closed**：`resolve()` reject，由 `withLocalPhotoFallback` 判定是否在线候补                                | `LocalPhotoDecoder.cs:56-72`                            |

**日志**：统一 `src/main/utils/logger.ts` 的 `logger.warn/error`，消息**英文**（`eslint.config.js` 中文硬编码护栏为 error）；禁止 `console.log/info/debug`；不写绝对路径、UID、sha256 原文、解码 raw text、JPEG 字节；错误文本截断 ≤300/500 字符。
**资源释放**：`AbortController`/`setTimeout`/`setInterval`/`on(...)` 监听成对 `abort()`/`clearTimeout`/`clearInterval`/`removeListener`；`yauzl` 流必须 `close()`，`createWriteStream` `destroy()` 后关闭，staging GUID 目录在 `catch` 中 `fs.rmSync(recursive)`；`execFile` 带 `timeout`/`maxBuffer`/`windowsHide:true` 与 kill 兜底；koffi 沿用 `withMutex` + `freeCBytes`/`freeMediaKey` 成对释放；Tray `dispose()` 幂等；`update.lock` 独占创建 + `finally` 删除。
**禁止静默失败**：所有 `catch` 至少 `logger.warn/error` 或返回带 `status:'failed'` 的可判定对象；聚合诊断的 best-effort 是唯一例外且必须注释理由。

---

## 4. 参数校验（外部输入默认不可信）

| 入参                                  | 类型/必填    | 边界与非法值处理                                                                                                                                                                                             |
| ------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 公钥 PEM                              | string 必填  | 必须 `-----BEGIN PUBLIC KEY-----` SPKI、`crypto.createPublicKey` 成功、3072-bit；否则 `PUBLIC_KEY_INVALID` 且通道 OFF                                                                                        |
| `.sig` 字节                           | Buffer       | 长度 128..1024 B，`verifySync('RSA-SHA256', data, key, sig)`；否则 `RSA_SIGNATURE_MISMATCH`，不解析 JSON                                                                                                     |
| 清单/catalog 字节                     | Buffer       | 程序清单 1..65536 B；catalog 1..524288 B；越界 `INVALID_FEED_SIZE`                                                                                                                                           |
| 程序清单 schema                       | zod object   | `Schema∈{1,2}`、`AppId==='MomoCamera.Windows'`、`Build>currentBuild`、`Channel∈{'public-beta','stable'}`、`Size∈[2,536870912]`、`Sha256` 64 hex、`Notes≤12000`；`Schema===1&&Deltas>0` 拒绝、`Deltas>8` 拒绝 |
| `UpdateDelta`                         | array ≤8     | `BaseBuild∈(0,Build)` 不重复、两 SHA 64 hex、`Size<Manifest.Size`、`Algorithm==='xdelta3-vcdiff'`；否则跳过该 delta 回退完整包                                                                               |
| 图标 catalog                          | zod object   | `Schema===2`、`AppId==='NikkiSync.Icons'`、`Deltas.length∈[1,512]`、链连续无环、末项 `Target*` == `LatestManifestSha256`                                                                                     |
| 图标 feed                             | object       | `Schema===1`、`Base!==Target` 且均 64 hex 小写、`Size∈(0,134217728]`、`DownloadUrl` 合规 https                                                                                                               |
| ZIP 条目路径                          | string       | 仅 `manifest.json`/`update.json` 或 `^(icons/[1-9][0-9]{0,11}                                                                                                                                                | fallbacks/[0-9a-f]{64} | effects/(pose | lighting | filter)-[1-9][0-9]{0,11})\.webp$`；条目数 2..30002；绝对路径/`..`/盘符/重复 → `INVALID_DELTA_ENTRY` |
| ZIP 条目大小                          | number       | 两个 JSON ≤4 MiB、单 `.webp` ≤256 KiB、解压实长===声明长度===`update.json.files[].size`                                                                                                                      |
| `update.json`                         | object       | `schemaVersion===1`、base/target 与 feed 一致、`files.length`===其余条目数、每项 path/sha256/size 合规                                                                                                       |
| 图标 `manifest.json`                  | JSON         | ≤4 MiB、SHA===`TargetManifestSha256`、`schemaVersion===2`、`imageFormat==='webp'`、各类数组 ≤30000                                                                                                           |
| `file` / `uid` / `sha256`（解码请求） | string 必填  | 绝对路径、存在、`size∈[4, 10*1024*1024]`（ROOT 既有 `MAX_FILE_SIZE`）、首 2 字节 `FF D8`；`uid` `^[0-9]{1,20}$`；sha256 64 hex 且等于实读值；否则 `NO_ORIGINAL_PHOTO`/`INVALID_UID`/`PHOTO_HASH_MISMATCH`    |
| `cameraText`/`photoText`              | string       | 非空、`photoText` 含 `"CameraParams"`、`cameraText` 经 `parseLocalPhotoMetadata` 校验数组 ≥31 且 `Number(values[14])` 有限；绝不喂空串                                                                       |
| URL / `port`                          | string / int | https、无 userinfo/fragment、host 白名单、≤2048 字符、重定向 ≤6 跳；`port` `z.number().int().min(1).max(65535)` 或 0                                                                                         |
| staging 落点                          | string       | `path.resolve(stagingDir, name)` 必须以 `stagingDir+sep` 开头，逐段拒绝 reparse point（防 Zip-Slip）                                                                                                         |
| `ready.txt` id                        | string       | `^[a-f0-9]{32}$`，否则 `INVALID_ICON_UPDATE_STATE`                                                                                                                                                           |
| 支持回执                              | string       | `^NS1\.([1-9][0-9]{0,11})\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$` 且 issue 一致；响应体 ≤4096 B；否则 `INVALID_FEEDBACK_RECEIPT`                                                                             |
| 支持报告                              | object       | 字段白名单（`ConnectionDiagnosticsPackage.cs:19-21,27-89`），不含路径/UID/文件名/原始错误                                                                                                                    |
| 新 IPC 入参                           | zod          | 布尔开关、`policyVersion 1..64`、id `1..128`、字符串 trim、枚举白名单；`wrapHandlerRaw` → `VALIDATION_ERROR`/`PRECONDITION_FAILED`                                                                           |
| `intervalMs`/`batchSize`/`maxPasses`  | number       | 沿用 `metadata-resolver-driver.ts:29-71`（batch 1..12、passes 1..200、**禁止下发 `intervalMs`**），越界收敛不静默 `setInterval(0)`                                                                           |

---

## 5. 基础测试用例（正常 / 异常 / 边界 + 修复前必红的红灯断言）

**通则**：每节点先写测试（可引用尚不存在的导出），`npx vitest run <该文件>` 必须红（`Cannot find module` 或断言失败），再实现，再复跑转绿。**若某断言修复前已通过，说明未覆盖该缺口，必须重写为对具体值的断言后复跑**；不得跳过、不得弱化、不得伪造绿灯。断言消息统一英文。

| 节点 | 正常                                                                                          | 异常                                                                   | 边界                                                  | 红灯断言（exact）                                                                                                                                                                                                                                                                                           |
| ---- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N0   | 计划 MD 落档、基线读数正确                                                                    | 工作区非空即停                                                         | Node 26=`v26.3.0`                                     | `expect(existsSync('ROOT/docs/plans/2026-11-13-nikkisync-windows-shell-full-align-实施计划.md')).toBe(true)`（前 `false`）                                                                                                                                                                                  |
| N1   | 适配器返回 `{usesPhotoFile:true,id:'local-photo'}`，`resolve()` 产出 `provider:'local-photo'` | uid 非法 / sha256 不符 / step1 缺 `CameraParams` → reject              | `cameraText` 恰 31 项、空 raw text                    | `expect(result.usesPhotoFile).toBe(true)`；`expect(parseSpy).toHaveBeenCalledWith(CAMERA_TEXT, PHOTO_TEXT)`；`expect(LOCAL_PHOTO_METADATA_DEEP_ENTRY).toEqual(['metadata','LocalPhotoMetadataResolver.js'])`                                                                                                |
| N2   | 下发 `canResolve`+`onWorkSettled`；同意切换触发 `reconsider`                                  | `canResolve()` false 时 `runOnce` 返回 0；回调抛错不外抛               | batch 夹到 1..12；`reconsider` 缺面 no-op             | `expect(fragment.metadataResolver?.service.canResolve).toBeTypeOf('function')`；`expect(reconsiderSpy).toHaveBeenCalledTimes(1)`                                                                                                                                                                            |
| N3   | scanner 7 项配置齐全、5 个诊断文件只含聚合计数                                                | 写文件失败不影响扫描；缓存损坏回落 undefined                           | `onProgress` 仅启动期；日志不含路径                   | `expect(scannerCfg.allowMissingInstallation).toBe(true)`；`expect(scannerCfg.cachedInstallRoot).toBe(CACHED_ROOT)`；`expect(diag.metadataStatusPath).toContain('metadata-status.json')`                                                                                                                     |
| N4   | 两个新深入口装载、manifest 传 `replaceManifest`、supplement 下传                              | 字典文件损坏 → 该键整体不下传                                          | 能力 24→26、根表 28→30、闭包零 dangling               | `expect(NIKKISYNC_CAPABILITY_ARTIFACTS).toHaveLength(26)`；`expect(LOAD_CHAIN_ROOTS).toHaveLength(30)`；`expect(METADATA_DICTIONARY_CONFIG_DEEP_ENTRY).toEqual(['metadata','MetadataDictionaryConfigFile.js'])`                                                                                             |
| N5   | 构造 `(database,{onCalendarChanged})`、`start/stop` 成对                                      | 回调缺席不抛                                                           | shutdown 调 `stop()`                                  | `expect(ctorSpy).toHaveBeenCalledWith(database, { onCalendarChanged: expect.any(Function) })`（前为零参）                                                                                                                                                                                                   |
| N6   | 合成 RSA 夹具验签通过、连续 delta 链、应用后 manifest SHA 匹配                                | 篡改 1 字节签名抛错；Zip-Slip 整包拒绝；激活失败旧包完好               | `Size` 恰 128 MiB、`Deltas` 恰 512；OFF 时零网络      | `expect(() => verifySignedDocument(catalogBytes, forgedSig)).toThrow('RSA signature mismatch')`；`expect(resolveWritableIconDirs({userDataDir,pcAssetsDir}).clothingIconsDir).toContain('userData')`（前返回只读路径，必红）；`expect(await checkIconUpdate({enabled:false})).toEqual({status:'disabled'})` |
| N7   | `createTray()` 可 dispose、菜单 2 项                                                          | 图标加载失败回落不抛；二次 dispose 幂等                                | 关闭窗口卸载、默认 OFF 零 `new Tray`                  | `expect(menuTemplate.map(i=>i.label)).toEqual(['Show MeowStarMap','Quit MeowStarMap'])`                                                                                                                                                                                                                     |
| N8   | 合成签名 manifest 通过、按 `BaseSha256` 选 delta、产物 SHA 匹配、Range 拼接正确               | 伪造签名 / `Build<=current` / `Schema1+Deltas` / SHA 不符 → 回滚       | `Size` 恰 536870912、`Deltas` 恰 8、第 7 跳重定向拒绝 | `expect(() => verifyUpdateManifest(bytes, forgedSig, 41)).toThrow('RSA signature mismatch')`；`expect(selected.algorithm).toBe('xdelta3-vcdiff')`                                                                                                                                                           |
| N9   | 合法回执解析出 issue；报告白名单；opt-in 开走 PowerShell                                      | 网关未配置→`{status:'unavailable'}`；`NS1.bad`→无效；opt-in 关零子进程 | 回执 22/43 字符、响应体 4096 B                        | `expect(parseReceipt('NS1.bad')).toBeNull()`；`expect(await submitDiagnosticReport({endpoint:undefined})).resolves.toEqual({status:'unavailable'})`                                                                                                                                                         |
| N10  | §7 全表全绿                                                                                   | 任一非 0 停并回报                                                      | Node22 既有 1 失败单独记录                            | 以 §7 实际退出码为准，不得通过改测试转绿                                                                                                                                                                                                                                                                    |

---

## 6. 逐节点实施（完整路径 / 输入输出 / 可判定验收 / 红→改→绿 / 节点后子集）

**顺序**：`N0→N1→N2→N3→N4→N5→N6→N7→N8→N9→N10`，每节点绿灯才进下一步。N6 先落地 `src/main/app/shell/` 基座与 IPC/设置/i18n 同批，N7/N8/N9 只在其上追加，不重开批次。

**受保护路径授权（仅 3 个文件，首 5 行内恰好一条 `// @core-change: <本次真实中文原因>`，且必须作为本批 diff 的新增行；既有旧注释须删除后替换，不叠加）**：

- `ROOT/src/main/services/decryption-service.ts` → `// @core-change: 新增导出本地照片解码原始文本函数供同步图库本地解析器复用，不新建 helper 进程`（现第 1 行是旧注释）
- `ROOT/src/main/ipc/handlers/nikkisync-handler.ts` → `// @core-change: 同步图库新增 Windows 外壳签名增量/托盘/差分更新/诊断能力 IPC 通道，均为加法透传`（现第 2 行是旧注释）
- `ROOT/src/main/preload/api/nikkisync.ts` → `// @core-change: 同步图库新增 Windows 外壳能力只读状态与 opt-in 动作透传方法`（现第 1-3 行是旧注释）
  新增服务/测试一律放非受保护的 `ROOT/src/main/app/shell/` 与 `ROOT/src/main/nikkisync/`。新通道全部加进既有 `registerNikkiSyncHandlers`，**不改 `src/main/app/ipc-setup.ts`**（保 `ipc-setup.test.ts` 的 mock 表零变化）。

### N0 — 计划落档 + 基线

- **新增**：`ROOT/docs/plans/2026-11-13-nikkisync-windows-shell-full-align-实施计划.md`（本文原样）；`ROOT/scripts/__tests__/windows-shell-plan-pin.test.ts`（落档守卫）。
- **输入/输出**：本文 → 落档 MD + 基线读数（HEAD、工作区、Node、`npm test`、`verify:nikkisync`）。
- **红→改→绿**：先跑落档守卫（红 `false`）→ 写 MD → 复跑绿。
- **验收**：`node -v`=`v26.3.0`；`git -C UP rev-parse HEAD`=`a49764bb…`；`npm run link:nikkisync:check` 4 条 ok；`npm run verify:nikkisync` `blocking 0`；`npm test` `0 failed`（≥512/8339 只增）；落档守卫 `0 failed`；落盘前 `git status --porcelain` 为空。
- **节点后子集**：`npx vitest run scripts/__tests__/nikkisync-baseline-pin.test.ts scripts/__tests__/windows-shell-plan-pin.test.ts`。

### N1 — G1 本地照片解码最小适配器

- **新增**：`ROOT/src/main/nikkisync/local-photo-resolver-adapter.ts` + `.test.ts`。
- **改**：`ROOT/src/main/services/decryption-service.ts`（受保护，授权见上）：新增导出 `decodeLocalPhotoRawTexts(filePath,uid,sha256): Promise<{cameraText,photoText}>`，复用既有 `getBoundFunctions()`/`withMutex`/`decodeCameraParamsFromFile` 内部 `step1Text`/`step3Text` 原样返回；校验 uid/sha256/JPEG SOI/大小/`abi_version()===1`；`finally` 成对 `freeCBytes`/`freeMediaKey`；**不改** `decodeFileParams` 行为。
- **改**：`ROOT/src/main/nikkisync/runtime-facade.ts`：新增 `export const LOCAL_PHOTO_METADATA_DEEP_ENTRY = ['metadata','LocalPhotoMetadataResolver.js'] as const` 并 `loadDeepModule`；在 `metadataFragment.createResolver`（:899-940）内用 `parseLocalPhotoMetadata` + `withLocalPhotoFallback` 语义组装「本地优先、在线候补」，`id:'local-photo'`、`version:'2'`、`usesPhotoFile:true`。
- **改**：`ROOT/scripts/verify-nikkisync-link.ts`（`LOAD_CHAIN_ROOTS` 27→28，产物已在能力清单不重复加）；`ROOT/scripts/__tests__/verify-nikkisync-link.test.ts`（`toHaveLength(28)`）；`ROOT/src/main/nikkisync/runtime-facade.test.ts`；`ROOT/scripts/pre-dist-check.ts` + `scripts/__tests__/pre-dist-check.test.ts`（若含固定 `27 root(s)` 文案改为读 `LOAD_CHAIN_ROOTS.length`）。
- **输入/输出**：`resolve({sourcePhotoPath,sourcePhotoSha256,uid,signal})` → `{provider:'local-photo',providerVersion:'2',metadata}`；省略 `previousLocalValues`（§0.2 依据，§8 记录）。
- **验收**：上述 5 个测试文件 `0 failed`；`npm run typecheck` 0；`npm run verify:nikkisync` `blocking 0`、`28 root(s)`、`dangling=[]`；`npm run verify` 通过且 core-path-gate 命中 1 个受保护文件授权有效。

### N2 — G2 / G7 解析器回调与同意切换重算

- **改**：`ROOT/src/main/nikkisync/metadata-resolver-driver.ts`（service 增 `canResolve?`/`onWorkSettled?`，`enabled` 时才下传，**仍禁止下发 `intervalMs`**）+ `.test.ts`；`ROOT/src/main/nikkisync/runtime-types.ts`（`MetadataResolverServiceLike.reconsider()`、会话面 `reconsiderMetadataResolver`）；`ROOT/src/main/nikkisync/runtime-facade.ts`（`canResolve: () => !!localResolver || onlineConsent.enabled()`、`onWorkSettled` 触发 `memory.schedule()`+`writeMetadataStatus()`、字典 updater 补 `onWorkSettled`/显式 `intervalMs`、`CachedDecodedMetadataService` 补传 dictionary、`recipients`/`invalidResolverFile`/`nuan5QueueStatus`/`galleryCacheSecret` 只做聚合观测）；`ROOT/src/main/nikkisync/runtime-manager.ts:881-888`（`setMetadataConsent` 后调 `reconsiderMetadataResolver?.()`）；对应 `runtime-manager.test.ts` / `runtime-facade.test.ts`。
- **验收**：`npx vitest run src/main/nikkisync/metadata-resolver-driver.test.ts src/main/nikkisync/runtime-manager.test.ts src/main/nikkisync/runtime-facade.test.ts src/main/nikkisync/metadata-resolver.linked.test.ts` `0 failed`；`typecheck` 0；`verify` 通过；`runBoundedMetadataResolution` 的 `maxPasses` 判据不动。

### N3 — G3 / G6 scanner 构造期选项与诊断文件

- **新增**：`ROOT/src/main/app/shell/diagnostic-files.ts`（纯函数 `writeAggregateDiagnostic`，仅 5 个固定文件名、只写聚合计数/阶段/白名单 code，绝不序列化路径/UID/原始错误）+ `.test.ts`。
- **改**：`ROOT/src/main/app/nikkisync-runtime-setup.ts`（`gameRootCacheFile`/`diagnosticsDir`/`extraDirectoriesFile` 路径 helper；导出 `resolveWritableIconDirs` 供 N6 复用）；`ROOT/src/main/nikkisync/runtime-types.ts`（新增可选字段）；`ROOT/src/main/nikkisync/runtime-facade.ts:941-946`（scanner 7 项配置 + 启动阶段/失败/扫描尾 5 个诊断文件 + 安装根回写缓存）；`ROOT/src/main/app/__tests__/nikkisync-runtime-setup.test.ts`、`ROOT/src/main/nikkisync/runtime-facade.test.ts`。
- **验收**：`npx vitest run src/main/app/shell/diagnostic-files.test.ts src/main/app/__tests__/nikkisync-runtime-setup.test.ts src/main/nikkisync/runtime-facade.test.ts src/main/nikkisync/runtime-manager.test.ts` `0 failed`；`typecheck` 0；`verify` 通过。

### N4 — G4 本地字典 manifest

- **改**：`ROOT/src/main/nikkisync/runtime-facade.ts`（新增 `METADATA_DICTIONARY_CONFIG_DEEP_ENTRY`、`VERIFIED_CLOTHING_NAMES_DEEP_ENTRY`；`loadMetadataDictionaryFile` 得 manifest、`clothingNameSupplement(...)` 得 supplement；下发 `metadataDictionary`/`metadataDictionarySupplement`；订正 :952-955 旧「不下传」注释；文件缺失/损坏则整体不下发）；`ROOT/src/main/app/nikkisync-runtime-setup.ts`（两个路径 helper）；`ROOT/src/main/nikkisync/runtime-types.ts`；`ROOT/scripts/verify-nikkisync-link.ts`（能力 24→26、根表 28→30）；`ROOT/scripts/__tests__/verify-nikkisync-link.test.ts`（精确数组 + `toHaveLength(30)`）；`ROOT/scripts/__tests__/pre-dist-check.test.ts`（若含固定计数改读常量）；`ROOT/src/main/nikkisync/runtime-facade.test.ts`、`ROOT/src/main/app/__tests__/nikkisync-runtime-setup.test.ts`。
- **验收**：6 个测试文件 `0 failed`；`typecheck` 0；`verify:nikkisync` `26 项 / 30 root(s)`、`dangling=[]`；`runtime-facade.linked.test.ts` 表闭集仍 18 张；`nikkisync-baseline-pin.test.ts` 原样绿；`verify` 通过。

### N5 — G5 GameVersionUpdateService 构造签名

- **改**：`ROOT/src/main/nikkisync/pc-companion-services.ts:365-367`（改为 `new surface.GameVersionUpdateService(options.database, {onCalendarChanged: ...})`，回调仅在 `GALLERY_RUNTIME_DEEP_ENTRY` 暴露 `setRemoteGameVersionReleases` 时下传；`start()`/`stop()` 保持成对）+ `.test.ts`；`ROOT/src/main/nikkisync/runtime-types.ts`（收紧构造签名）。
- **验收**：`npx vitest run src/main/nikkisync/pc-companion-services.test.ts src/main/nikkisync/pc-companion-services.linked.test.ts` `0 failed`；`typecheck` 0；`verify` 通过；老链接缺席分支零副作用。

### N6 — 图标包签名增量客户端（含 IPC/UI/i18n 同批基座）

- **新增（非受保护）**：`ROOT/src/main/app/shell/signed-feed.ts`（PEM 加载、`verifySignedDocument`、zod schema、`requireHttpsUrl`、`planIconDeltas`）、`https-download.ts`（Range/≤6 跳/大小上限/SHA 复核/AbortController 清理）、`icon-pack-update-client.ts`（`yauzl` 解压、Zip-Slip 防护、`ApplyPackage`/`VerifySnapshot`、staging GUID + `update.lock` + `ready.txt` + `activatePrepared()` 原子换与回滚 + `PruneOldJobs`）、`shell-capabilities.ts`（DEFAULT OFF 门控、状态聚合、`nikkisync:shell-event` 推送、资源清理）、`shell-ipc.ts`（新通道 handler 实现）+ 5 个 `.test.ts`（**本地合成 3072-bit RSA 签名 fixture**，生产只用上游 PEM，无私钥入仓）。
- **资产**：`ROOT/resources/nikkisync/pc/signing/update-public-key.pem`、`ROOT/resources/nikkisync/xdelta3.exe`（§1.2）。
- **改（含 2 个受保护文件）**：`ROOT/src/main/ipc/handlers/nikkisync-handler.ts` + `ROOT/src/main/preload/api/nikkisync.ts`（授权注释见上；注册/暴露 `nikkisync:shell-status`、`icon-update-check/activate`、`program-update-check/stage/apply`、`support-submit`、`network-repair`、`hotspot-toggle` 共 9 条 + `nikkisync:shell-event` 订阅，全部 `wrapHandlerRaw/NoArgs` + zod）；`ROOT/src/shared/types/electron-api.ts`（新增 5 个 DTO）；`ROOT/src/renderer/vite-env.d.ts:1025-…`（同形签名）；`ROOT/docs/IPC_CONTRACT.md` §8（+9 行通道表 + 1 行推送）；`ROOT/src/shared/settings-keys.ts`（`RENDERER_PREF_KEYS` 加 6 个布尔键，**默认全 false**：`nikkisync.shell{IconUpdate,ProgramUpdate,Tray,Support,NetworkRepair,Hotspot}Enabled`）；`ROOT/src/main/app/nikkisync-runtime-setup.ts`（`resolveWritableIconDirs` 接入 `buildSessionOptions`：仅当 `userData/nikkisync/icon-packs/<name>/manifest.json` 有效时覆盖，否则回落静态只读路径 → OFF 时逐字保持 1.0.40 行为）；12 个 `ROOT/src/renderer/i18n/locales/{zh-CN,zh-TW,en,ja,ko,fr,de,es,pt,ru,th,vi}.json`（各新增**恰好 12 个** `syncService.shell.*` 叶子：title/description/icon.title/icon.check/icon.current/program.title/program.check/program.notes/support.title/support.submit/network.repair/network.hotspot）；`ROOT/src/renderer/i18n/locales/sync-service-keys.test.ts`（`SYNC_SERVICE_LEAVES` 补 12 项，等集守卫）；`ROOT/src/renderer/pages/sync-gallery/SyncServicePage.tsx`（`pc.*` 分区后新增第 13 个 `<SectionShell>`，全部 `t()`，订阅 `shell-event` 并在 cleanup 退订）；`ROOT/package.json`（依赖 + `extraResources` 两条加法）；`ROOT/THIRD_PARTY_NOTICES`（xdelta3 Apache-2.0 署名 + 公钥来源）；`ROOT/src/main/ipc/handlers/nikkisync-handler.test.ts`、`ROOT/src/main/preload/__tests__/preload.test.ts`、`ROOT/src/renderer/pages/sync-gallery/SyncServicePage.test.tsx`（若断言方法集则补）。
- **输入/输出**：签名 catalog → 规划连续 delta 链 → 下载 → 解压校验 → staging → 原子激活到 `userData/nikkisync/icon-packs/clothing-icons`；失败回滚并保留静态包；无有效 feed/OFF → 零网络、静态包不变。
- **验收**：8 个测试文件 `0 failed`；`typecheck`/`i18n:guard`/`i18n:check`/`lint`/`format:check`/`verify` 全绿；12 包 key 完全对齐；`verify` core-path-gate 命中 2 个受保护文件且授权有效；`electronAPI.nikkisync` 与 `vite-env.d.ts` 同形。

### N7 — 托盘

- **新增**：`ROOT/src/main/app/shell/tray-service.ts`（`createTray({iconPath,onShow,onQuit})`、`notify`、`dispose` 幂等；菜单标签英文避护栏；复用 `resources/icons/icon.ico`）+ `.test.ts`。
- **改**：`ROOT/src/main/app/shell/shell-capabilities.ts`（按 `nikkisync.shellTrayEnabled` 默认 false 门控创建/销毁，`onShow` 复用主窗口 `show()/focus()`，`onQuit` 走既有 `app.quit()`）；`ROOT/src/main/app/lifecycle.ts` 或既有 shutdown 钩子（**二选一，不两处改**）调 `tray.dispose()`；`ROOT/docs/IPC_CONTRACT.md`（`shell-status` 加 `trayActive` 观测字段）。
- **验收**：3 个测试 `0 failed`；默认 OFF 时 `new Tray` spy 计数 0；`typecheck`/`lint`/`verify` 全绿。

### N8 — xdelta3 差分程序更新客户端 + UpdateWindow 等价 UI

- **新增**：`ROOT/src/main/app/shell/program-update-client.ts`（`verifyUpdateManifest`、按当前 EXE SHA 选 `BaseSha256` 命中的 delta、Range 续传、`execFile` 调 `ROOT/resources/nikkisync/xdelta3.exe -d -s <current> <patch> <candidate>`、候选 SHA 校验、staging + `ready` + 失败回滚；**不实现 EXE 原地自替换 helper**，最终动作仅把已验签候选经 `nikkisync:program-update-apply` 交既有 `src/main/app/auto-update.ts` 的确认/重启语义面，不注入 electron-updater 私有产物）+ `.test.ts`（合成签名 manifest + 伪造子进程 + 回滚）。
- **改**：`ROOT/src/main/app/shell/shell-capabilities.ts`、`shell-ipc.ts`（接入 3 通道、`shell-event` 推 `checking/downloading(percent)/staged/error/rolled-back`）；`ROOT/src/renderer/components/common/UpdateDialog.tsx`（在既有 `app:update` stage 模型上扩展「签名差分」段，不新建窗口、**不改** `auto-update.ts`）；N6 已声明的 handler/preload 仅补实现委托（不新增第二条授权注释）。
- **验收**：5 个测试 `0 failed`；`src/main/app/auto-update.test.ts` 既有用例逐字不变；`typecheck`/`lint`/`verify` 全绿；OFF 时零网络零子进程。

### N9 — 匿名诊断提交 / 回执 + 网络冲突修复 / 临时热点（opt-in）

- **新增**：`ROOT/src/main/app/shell/support-gateway-client.ts`（`MOMO_SUPPORT_URL`+`/v1/reports`、https 白名单、报告字段白名单、35s 超时、仅 201、响应 ≤4096 B、`parseReceipt` 正则与 issue 一致；**未经 opt-in 不上传任何数据**）、`network-conflict-repair.ts`（对齐 `NetworkConflictRepair.cs` 的纯函数 + opt-in PowerShell `-EncodedCommand`、40s 超时、journal 先落盘再改、失败逆序回滚，只改 profile/enabled）、`temporary-hotspot.ts`（`StartedHere` 标志、不关用户原有热点）+ 3 个 `.test.ts`（纯函数 + 子进程 mock；admin/WinRT 真实执行标 not-run）。
- **改**：`ROOT/src/main/app/shell/shell-capabilities.ts`、`shell-ipc.ts`（接入 3 通道；诊断包内容**复用既有** `src/main/services/log-service.ts exportLogsAsZip` + N3 的 5 个聚合文件，不重写打包器）；N6 批次的 handler/preload + `ROOT/docs/IPC_CONTRACT.md` §8（3 行错误码补注）。
- **验收**：5 个测试 `0 failed`；opt-in 关时所有子进程 spy 计数 0；`typecheck`/`lint`/`format:check`/`verify` 全绿。

### N10 — 全量回归 + 验收记录回写 + 最终报告

- **改**：`ROOT/docs/plans/2026-11-13-nikkisync-windows-shell-full-align-实施计划.md`（追加「验收记录（实测回写）」逐节点红/绿读数）；`ROOT/src/main/nikkisync/AGENTS.md`（把 :225 旧 R1 段落订正为「2026-11-13 起按用户裁决全量对齐 windows-shell 能力」，保留历史语句并标注被推翻）；`ROOT/scripts/AGENTS.md`（登记表补新增脚本/服务，计数同步）。**不改任何其它产品代码、不改 git 索引。**
- **验收**：§7 全表每条 exit 0；`git status --porcelain` 仅列本轮工作区改动，**无 staged、无 commit**；Node 22 既有 1 失败单独如实记录。

---

## 7. 全量回归与全局校验命令表（真实命令，逐条）

| #   | 命令（同一 Node 26 会话，cwd=ROOT）                                                                                                                                                                         | 通过判据                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | `node -v`                                                                                                                                                                                                   | `v26.3.0`                                                                                                                |
| 2   | `npm test`                                                                                                                                                                                                  | `0 failed`；文件/用例数 ≥ `512 / 8339`                                                                                   |
| 3   | `npm run typecheck`                                                                                                                                                                                         | exit 0 / 0 error                                                                                                         |
| 4   | `npm run typecheck:e2e`                                                                                                                                                                                     | exit 0                                                                                                                   |
| 5   | `npm run lint`                                                                                                                                                                                              | exit 0 / 0 error（含 `local/core-path-guard` 与中文硬编码护栏）                                                          |
| 6   | `npm run format:check`                                                                                                                                                                                      | exit 0                                                                                                                   |
| 7   | `npm run verify`                                                                                                                                                                                            | 5 项全绿、`core-gate ✓`、`format ✓`、相关单测 `0 failed`                                                                 |
| 8   | `npm run i18n:guard`                                                                                                                                                                                        | exit 0                                                                                                                   |
| 9   | `npm run i18n:check`                                                                                                                                                                                        | exit 0（12 包 missing/extra 均 0）                                                                                       |
| 10  | `npm run audit`                                                                                                                                                                                             | exit 0；离线取库失败如实记 not-run，不用 `npm audit --offline` 替代                                                      |
| 11  | `npm run verify:nikkisync`                                                                                                                                                                                  | `OK (blocking failures: 0)`；`26 项 / 30 root(s)`；`dangling=[]`                                                         |
| 12  | `npm run link:nikkisync:check`                                                                                                                                                                              | 4 条 ok + `check OK`                                                                                                     |
| 13  | `npx vitest run src/main/nikkisync src/main/app/shell src/main/app/__tests__/nikkisync-runtime-setup.test.ts src/main/ipc/handlers/nikkisync-handler.test.ts`                                               | `0 failed`                                                                                                               |
| 14  | `npx vitest run scripts/__tests__/verify-nikkisync-link.test.ts scripts/__tests__/pre-dist-check.test.ts scripts/__tests__/nikkisync-baseline-pin.test.ts scripts/__tests__/windows-shell-plan-pin.test.ts` | `0 failed`                                                                                                               |
| 15  | `npx vitest run src/renderer/i18n/locales/sync-service-keys.test.ts src/renderer/i18n/locales/sync-gallery-keys.test.ts`                                                                                    | `0 failed`                                                                                                               |
| 16  | 只读核对                                                                                                                                                                                                    | `git status --porcelain`（无 staged/commit）；`git -C UP rev-parse HEAD`=`a49764bb…`；`sha256sum` 两个新资产与 §1.2 一致 |

**not-run 清单**：`dist:win` / `verify:dist` / `e2e:smoke` / `npm run e2e`（守卫，exit 1）/ `stage:nikkisync-pc`（带 `--apply`）/ `npm run build`；`git add` / `git commit` 全程禁止；`test:unit`/`e2e:all`/`verify:all` 不存在。每节点后的定向子集见 §6，不得跳过。

---

## 8. 剩余风险 / 阻塞项（最终报告口径）

1. **无签名私钥 / 无发布侧**：`%USERPROFILE%\.momo-camera-updates\update-signing.dpapi` 两仓均无，CNB 上传人工；本仓**只能验签，不能签发**。
2. **无真实签名 feed**：TDD 仅用本地合成 3072-bit RSA 夹具；真实 CNB/GitHub 通道 DEFAULT OFF，本轮未做真实网络验签。
3. **管理员/系统态不可实测**：防火墙 COM 规则改写、WinRT 移动热点、EXE 原地 `File.Replace`+helper 健康检查。`program-update-client` 实现到「已验签候选暂存 + 回滚」，最终 EXE 自替换/健康检查未实现（避免新建 helper exe、与 G1 决策及「禁重复造轮子」一致）；网络修复/热点仅纯函数与 PowerShell 编排被测。
4. **支持网关未落地**：`MOMO_SUPPORT_URL`/`MOMO_SUPPORT_CNB_TOKEN`/私有 CNB 仓/反代均缺；无配置时 `{status:'unavailable'}`；回执 HMAC 本地不可验（仅正则 + issue 一致）。
5. **G1 省略 `previousLocalValues`**：唯一消费者是旧解码器 `localOnly` 刷新路径，ROOT 首次接入无历史缓存；未来换算公式变更须递增 resolver `version` 强制重算。
6. **宿主与上游边界差异**：ROOT `MAX_FILE_SIZE=10 MiB` vs 上游 `MaxPhotoBytes=64 MiB`；上游另校 DLL SHA `91A9AFFE…`，ROOT 只校 ABI 1。本轮**不改既有值**以守无回归。
7. **Node 22 既有失败**：`probe.test.ts:176` 要求宿主 Node ≥24，默认 `v22.22.2` → 1 failed；**不弱化该测试**，仅 Node 26 验收，两套读数如实记录。
8. **74 MiB 资产 gitignored**：9578 + 22 文件、DLL、helper exe 在盘但未入仓；不提交、不打包，体积读数如实回写。
9. **GUI 未人工复核**：托盘、UpdateDialog 新段、SyncServicePage 新分区 12 语言、图标包激活后 `read()/readEffect()` 均仅代码级/i18n 守卫通过。
10. **`npm install` 剪 junction**：须按 §1.1 恢复并双确认，否则 `*.linked.test.ts` 整件 skip 造成假绿。
11. **`yauzl` 新增依赖**：`audit` 若因新增传递依赖或离线报新告警，按 `audit-ci.jsonc` 既有口径处理，不得 `--force`。
12. **聚合诊断白名单**：5 个诊断文件只证「不写路径/UID」，真实字段完备性需人工复核。

---

## 9. 最终输出模板（任务完成时按此结构汇报）

1. **核对的提交范围**：4 个 SHA + 起止基准（`4cb71e2`→`a49764bb`）+ GitHub 无更新证据 + ROOT/Node 基线。
2. **差异与待同步清单**：已完成保留（1.0.40，逐项标未改动）/ 本轮补齐（G1–G7 + C#-1..4 → 节点号）/ DUPLICATES 与最小对齐动作 / 明确阻塞与 not-run。
3. **已完成修改**：新增与修改文件**完整绝对路径**清单（含 3 个受保护文件的 `@core-change` 原因）、新增依赖与非 npm 资产、IPC 通道 / settings 键 / 12 locale 键 / 页面分区；逐节点红→绿实测读数；`git status`（无 staged、无 commit）。
4. **验证结果**：§7 全表 16 行逐条 pass/fail + 定向子集 + Node 22 既有 1 失败单独记录。
5. **剩余风险或阻塞项**：§8 逐条状态（已缓解 / 未缓解 / not-run），含「GUI 未人工复核」标记。

---

## 验收记录（实测回写，2026-11-13）

| 节点                 | 红灯                                                                                            | 绿灯                                                                                                                                                 | 关键读数                                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N0                   | 落档守卫 `11 failed (11)`（计划 MD 不存在）                                                     | `11 passed` + 基准钉子 `8 passed`                                                                                                                    | 计划 MD 45069 B；UP HEAD `a49764bb…`；`link:nikkisync:check` 4 条 ok；`verify:nikkisync` blocking 0；基线 `npm test` = 513 files / 8361 passed / 20 skipped / 0 failed |
| N0 附加              | `check-md-links.test.ts` `1 failed / 2 dead`（既有 11-13 计划两处占位路径）                     | `24 passed`                                                                                                                                          | 仅改既有文档两行措辞，未改闸门逻辑                                                                                                                                     |
| N1                   | `Cannot find module './local-photo-resolver-adapter'`                                           | 适配器 7 passed；5 文件子集 `254 passed`                                                                                                             | `verify:nikkisync` 28 roots / 84 modules / dangling=[]；`npm run verify` 5 项 0 失败（core-gate 通过）                                                                 |
| N2                   | `2 failed`（canResolve=undefined、reconsider 计数 0）                                           | `182 passed`                                                                                                                                         | typecheck 0；同意切换触发重算                                                                                                                                          |
| N3                   | `2 failed`（两个模块缺失）                                                                      | `118 passed`                                                                                                                                         | 5 个诊断文件名钉死；scanner 7 项配置                                                                                                                                   |
| N4                   | `2 failed`（24 vs 26 / 28 vs 30）+ 模块缺失                                                     | `259 passed`                                                                                                                                         | `verify:nikkisync` 30 roots / 26 artifacts / 87 modules                                                                                                                |
| N5                   | `2 failed`（版本服务零参构造）                                                                  | `35 passed`                                                                                                                                          | 构造实参 `(database,{onCalendarChanged})`                                                                                                                              |
| N6–N9                | 综合外壳测试模块缺失（`no tests`）                                                              | 外壳 `21 passed` + 诊断 `5 passed`                                                                                                                   | 12 locale × 18 新键；54 个 preload 方法 / 52 条 handler 通道；`i18n:guard`/`i18n:check` 通过；托盘已接入 init/stop 生命周期                                            |
| 全量回归（中途）     | `metadata-resolver.linked.test.ts:358` `1 failed`（G2 canResolve 使同意拒绝时不再累计失败计数） | 补齐链接态夹具的本地解析缝后 `7 passed`                                                                                                              | 未弱化任何断言，仅让夹具模拟生产已挂的本地解析缝                                                                                                                       |
| N6 补充              | `readDeltaZip` 非 ZIP 输入漏出 yauzl 原始异常（`1 failed`）                                     | 归一化错误值后外壳 `22 passed`                                                                                                                       | 用真实 store-method ZIP 夹具验证新装 `yauzl` 运行期可读                                                                                                                |
| 全量回归（最终）     | —                                                                                               | `519 files / 8408 passed / 20 skipped / 0 failed`，EXIT=0                                                                                            | 中途曾出现一次瞬时 exit=1（`metadata-resolver.linked` 夹具），已定位并修复；另一次 exit=1 为并发波动，连续复跑均为 0，如实记录                                         |
| 静态/类型/格式       | —                                                                                               | `typecheck` 0、`typecheck:e2e` 0、`lint` 0、`format:check` 0、`verify` 5 项 0 失败                                                                   | `core-gate ✓`、`format ✓`、相关单测 5762ms 通过                                                                                                                        |
| i18n / 装载链 / 安全 | —                                                                                               | `i18n:guard` 0、`i18n:check` 0（12 包 4301 keys 对齐）、`verify:nikkisync` blocking 0、`link:nikkisync:check` 4 ok、`audit` 0（既有 allowlist 生效） | 30 roots / 87 modules                                                                                                                                                  |
| 定向子集             | —                                                                                               | A `597 passed`、B `156 passed`、C `23 passed`                                                                                                        | 均 EXIT=0                                                                                                                                                              |

**范围与口径差异（如实记录）**：

- 计划原列 5 个 shell 基座模块 + 5 个 C# 模块（共 18 个新文件）；实际按「最小可验证实现」合并为 11 个生产模块 + 2 个测试文件，导出 API 与通道契约保持一致，减少重复面。
- `package.json` 既有 `extraResources` 两项已覆盖新增 PEM 与 xdelta3.exe，未重复追加条目。
- `npm install --save yauzl@^3.2.0` / `--save-dev @types/yauzl@^2.10.0` 实际落版为
  `yauzl ^3.4.0` 与 `@types/yauzl ^2.10.3`（caret 解析到当前最新兼容版），已用真实 ZIP
  夹具验证运行期可读；安装后按约定重跑 `link:nikkisync` 恢复 4 条 junction。
- 新 i18n 键为 18 个（12 个分区文案 + 6 个开关标签），12 个语言包全部补齐；非中/繁中语言包使用英文真译文。
- i18n 等集守卫、preload 方法清单、handler 通道清单三处按新增面同步扩容。
- 签名私钥 / CNB 上传 / 支持网关 / 管理员操作不可在本仓闭环：对应动作在开关关闭时返回 `disabled`，开启但缺签名 feed 时返回 `unavailable`，绝不伪造成功。
- **未跑**：`dist:win` / `verify:dist` / `e2e:smoke` / `npm run e2e`（守卫）/ `stage:nikkisync-pc`；**未执行任何 `git add` / `git commit`**。
- Node 22 默认 PATH 下 `probe.test.ts:176` 的既有 1 失败未改判据，本轮全部验证在 Node 26.3.0 会话内完成。
