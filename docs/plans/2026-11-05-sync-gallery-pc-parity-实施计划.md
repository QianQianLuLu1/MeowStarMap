# 同步图库 · 与上游 NikkiSync PC 端功能对齐 实施计划

> 日期：2026-11-05　状态：**待确认，确认后逐节点执行**
> 本文件是 Plan 模式下唯一可写落点。**N0 的第一个动作**是把同一份计划原样写入仓库
> `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/docs/plans/2026-11-05-sync-gallery-pc-parity-实施计划.md`，满足「先出计划并写入仓库、确认后再执行」。

## 路径约定（下文 `ROOT/` `UP/` 展开即为完整绝对路径）

- `ROOT` = `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe`
- `UP` = `D:/Workbuddy 项目/WXNN YD - 副本/NikkiSync`
- 第 9 节给出**逐字完整路径清单**，不使用相对路径。

---

## 0. 已核实的事实基线（只读实测，非假设）

| 项           | 实测结论                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 上游检出     | `UP` 是独立 git 仓库，`HEAD = 589b932ebb5f3d7c18f7109cb91091f8eb563e2f`（tag `v1.0.30-public-beta.1`，与 GitHub `origin/main` 一致），`git -C UP status --porcelain` 为空                                                                                                                                                                                                                                                                                       |
| 链接方式     | `ROOT/node_modules/@nikkisync/{core,database,protocol,pc-companion}` 是 4 条 junction，指向 `UP/packages/*` 与 `UP/apps/pc-companion`；**不在** `package.json` 依赖声明内，`npm install` 会剪链                                                                                                                                                                                                                                                                 |
| 上游产物     | `UP/apps/pc-companion/dist/src/` 下 `desktop/`、`wechat/`（`GalleryRuntime.mjs`）、`remote/`、`inspiration/`、`metadata/`、`server/`、`scanner/` 均齐全（已 `ls` 实测）                                                                                                                                                                                                                                                                                         |
| 上游资源     | 4 份 legal 文档 `UP/docs/store-submission/{PRIVACY_POLICY,USER_AGREEMENT,PERMISSIONS_DATA,SDK_SERVICES}.md`、品牌图 `UP/assets/branding/momo-camera.png`、3 个 PS 脚本 `UP/tools/wechat-gallery/{resize-icon,resize-preview,rotate-png}.ps1` 均存在                                                                                                                                                                                                             |
| 上游 ffmpeg  | **上游仓内无 `ffmpeg*.exe`**；本仓已有 `ffmpeg-static@^5.3.0`(`package.json:130`)、`ffprobe-static@^3.1.0`(`:131`)、`qrcode@^1.5.4`(`:140`)，且 `asarUnpack` 已含 `**/ffmpeg-static/**`(`:267`)、`**/ffprobe-static/**`(`:268`)、`**/qrcode/**`(`:264`) ⇒ 可直接复用，零新增 npm 依赖                                                                                                                                                                           |
| desktop 入口 | `DesktopControlServer.ts:46` `createDesktopControlServer()` 返回 `http.Server`；根路径 `/` 免 token 返回内嵌 token 的页面（`:229`），API 才校验 `x-nikkisync-desktop-token`(`:63-69`)；`windows-app.ts:241` 监听 `127.0.0.1` 随机端口，`:243` 取 `dashboard.address().port` ⇒ 本仓可用 `shell.openExternal('http://127.0.0.1:<port>/')` 开页                                                                                                                    |
| 真实命令     | 全部逐字核对存在：`dev` / `build` / `dist:win` / `lint` / `typecheck` / `typecheck:e2e` / `test` / `test:main` / `test:renderer` / `test:coverage` / `verify` / `verify:nikkisync` / `link:nikkisync` / `link:nikkisync:check` / `e2e:smoke` / `i18n:guard` / `audit` / `verify:dist` / `docs:links` / `preview:check` / `format:check`（`ROOT/package.json:31-91`）。**不存在** `test:unit` / `e2e:all` / `verify:all`；`npm run e2e` 是误输入守卫（退出码 1） |
| 测试基座     | vitest 5，双 project（`vitest.config.ts:31-55`），`tests/setup.ts:232-245` 注入 `window.electronAPI` Proxy；`scripts/find-related-tests.ts:7-13` 只取首个同名测试文件 ⇒ **`npm run verify` 不会自动覆盖本轮全部新增测试，每节点必须显式跑子集**                                                                                                                                                                                                                 |
| 闸门         | 受保护路径 `src/main/preload/api/**`、`src/main/ipc/handlers/**`、`src/main/services/**`、`src/shared/errors/**` 实质改动须在文件顶部前 5 行放**至多一条** `// @core-change: <真实中文原因>`（`scripts/core-path-gate.ts`）；改 `handlers/**` 或 `preload/**` 必须同批改 `docs/IPC_CONTRACT.md`（`.github/workflows/build.yml:84-110`）                                                                                                                         |

---

## 1. 根因（四层，每条带证据）

### 1.1 层一：「已同步最新提交」只同步了产物代次与镜像，不是上游产品码

三轮同步提交 `6d759fe`（协议镜像/漂移守卫）、`d5afded`（一行灵感状态）、`cf1364f`（`SyncInsightPanel` + 12 语包，零新 IPC）、`2531316`（mDNS 复测装置）、`65c9843`（文档）、`8ecac26`（账号作用域）、`c9bfcd3`（外部依赖解包闸门）——**`UP/apps/pc-companion/src/**` 一行源码都没进本仓**。本仓消费的是 4 条 junction 指向的 `dist/` 产物。`ROOT/docs/plans/2026-11-02-nikkisync-upstream-align-02-实施计划.md:22-24` 白纸黑字裁决「不做灵感库列表/编辑器、`remote/*`、`wechat/*`、`desktop/*`、词典型在线管线、`GameVersionUpdateService`、`RuntimeMemoryMaintenance`、重打包」。**这是主动裁决，不是代码缺陷**。

### 1.2 层二：代码与配置断点（旧逻辑残留 / 有接线无调用方）

| #   | 断点                                                                                                                                                                                                                      | 证据                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | 5 个默认常量全 `false`，首次进入同步图库必为空态                                                                                                                                                                          | `ROOT/src/main/app/nikkisync-runtime-setup.ts:61-66`；`ROOT/src/renderer/pages/sync-gallery/SyncGalleryPage.tsx:143-158` 空态分档                                                                          |
| B2  | `PcCompanionRuntime` 构造参数缺 `remoteBridge`、缺 `metadataDictionary*`、缺组合版 `metadataResolver`                                                                                                                     | `ROOT/src/main/nikkisync/runtime-facade.ts:640-700` 只下发 `databaseFile/scanner/server/onStartupStage/metadataFragment`；对比 `UP/apps/pc-companion/src/windows-app.ts:88-173`                            |
| B3  | **本仓不调上游 `runtime.start()`** ⇒ 上游 `start()` 里的 `server.start()`、`CachedDecodedMetadataService.runOnce()`、`reenrichResolvedAssets()`、两个 dictionary updater `start()`、`metadataResolver.start()` 全部不发生 | `ROOT/src/main/nikkisync/runtime-manager.ts:9-12, :250, :488`；`UP/apps/pc-companion/src/runtime.ts:103-123`。**只翻开关补不齐，必须显式编排**（本计划 N3）                                                |
| B4  | 同意门 fail-closed：首次安装同意文件不存在 ⇒ `initiallyDisabled=true`，零出站                                                                                                                                             | `ROOT/src/main/nikkisync/runtime-facade.ts:641-665`                                                                                                                                                        |
| B5  | 移植面 `sync:*` 6 通道已注册已暴露、渲染层零调用；`PORTED_SYNC_AUTOSTART_ENABLED=false` 常量恒关；`sync.serverEnabled` 是死开关                                                                                           | `ROOT/src/main/app/sync-server-setup.ts:63`、`:235-242`；`ROOT/src/main/ipc/handlers/sync-handler.ts:24-97`；`ROOT/src/main/preload/api/sync.ts:11-21`；`ROOT/src/shared/settings-keys.ts:28`              |
| B6  | 灵感库只有一行只读状态；`/v1/inspiration*` 端点上游无条件挂载但本仓零通道                                                                                                                                                 | `ROOT/src/renderer/pages/sync-gallery/SyncServicePage.tsx:966-972`；`UP/apps/pc-companion/src/server/LocalSyncServer.ts:143,165,241-242`；`UP/apps/pc-companion/src/inspiration/InspirationRoutes.ts:8-37` |
| B7  | 检索命中只出文本榜，不回捞资源铺网格                                                                                                                                                                                      | `ROOT/src/renderer/pages/sync-gallery/SyncInsightPanel.tsx:13-16` 自述「本轮刻意不做」                                                                                                                     |
| B8  | 详情抽屉改走本地 `decrypt:decodeFile`，不读上游 `metadata`                                                                                                                                                                | `ROOT/src/renderer/pages/sync-gallery/SyncAssetDrawer.tsx:23-30`；而 `nikkisync:get-asset-detail` 通道已在 `ROOT/docs/IPC_CONTRACT.md:431` 登记、`runtime-facade.ts` 零转换透传                            |
| B9  | 整理队列三通道被 `organizerEnabled` 默认 `false` 挡死                                                                                                                                                                     | `ROOT/src/main/ipc/handlers/nikkisync-handler.ts:244-255`                                                                                                                                                  |
| B10 | preview 版 `nikkisync` 命名空间缺失，Proxy 抛 `PREVIEW_UNSUPPORTED`（**不是返回 undefined**）                                                                                                                             | `ROOT/src/renderer/preview/mock/install.ts:22-27, :55-75`                                                                                                                                                  |

### 1.3 层三：打包态断层

- `c9bfcd3` 修了「`@nikkisync` 解包后 `GalleryRuntime.mjs` 的 bare import `qrcode` 无法解析 ⇒ 装机版扫描整体失效」；现役 `release/MeowStarMap-Setup-2.5.7-beta.exe`（11-05 18:09）解包树已含 `589b932` 代次产物，但**未做逐字节比对、最终 e2e 读数未回写**。
- 本轮新增深入口/资源后，`ROOT/scripts/verify-nikkisync-link.ts:47-123` 四张表（`SYNC_SERVER_REQUIRED_ARTIFACTS` / `METADATA_REQUIRED_ARTIFACTS` / `NIKKISYNC_CAPABILITY_ARTIFACTS` / `CHAIN_REQUIRED_ARTIFACTS` + `LOAD_CHAIN_ROOTS` 13 根）必须同批扩容，否则 `pre-dist-check` 红灯或装机版 `ERR_MODULE_NOT_FOUND`。
- `ROOT/src/main/nikkisync/embedding-paths.ts` 的 `buildPackagingContext()` 在 `app.isPackaged` 下走 `app.asar.unpacked`；任何新深入口必须经 `resolveDeepEntryUrl()` 变量式装载，否则 dev 与打包态分叉。

### 1.4 层四：安全 stance 与上游相反

上游干净安装**默认联网**（在线解析/字典、mDNS、远程桥接、版本检查）；本仓为隐私与安全刻意 fail-closed 全关。用户已确认本轮**全部翻转为开**，代价是启动即产生扫描 IO、`0.0.0.0:28080` 监听、mDNS 组播、以及向 `nuan5.pro` / `nikki.ranaxro.com` / `www.nikkigallery.vip` / 官网+Steam 的出站请求。兜底见 §4.3。

---

## 2. 用户确认的口径（执行中不得再改）

1. **症状范围**：运行期失效 + 上游功能缺失 + 打包/dev 不一致，三类全排查，最终给出「仍存在未同步项」清单。
2. **对齐边界**：只搬上游 **PC 端 `apps/pc-companion` 全部内容**（含 `wechat/*` 与 `desktop/*` 两块，**两块都接**）；WPF `windows-shell` 的托盘 / 开机自启 / 自动更新**明确不搬**。
3. **验证基线**：dev 与打包都要（`npm run dev` + `npm run dist:win` 重打包 + `npm run e2e:smoke`）。
4. **红灯口径**：**仅新增/改写、针对本 bug 的测试必须先红后绿**；既有全量回归按「修复前后均通过、零新增失败」验收。用户已明确放弃「每个既有回归测试修复前必须失败」这一不可行要求。
5. **默认值**：全部翻转为开，含 `nikkisync.*` 五个开关、在线元数据解析/字典、mDNS、整理队列、远程外桥、版本检查；**在线元数据「同意门」也翻转为默认放行**（与上游干净安装逐字一致）。
6. 由我亲自运行全部命令、亲自修复报错；不跳过测试、不伪造绿灯；未通过全部回归任务不得结束。

---

## 3. 改动范围边界

### 3.1 允许改（仅限同步图库相关）

`ROOT/src/main/nikkisync/**`、`ROOT/src/main/app/nikkisync-runtime-setup.ts`、`ROOT/src/main/ipc/handlers/nikkisync-handler.ts`、`ROOT/src/main/preload/api/nikkisync.ts`、`ROOT/src/shared/types/electron-api.ts`（只追加 `NikkiSync*` 类型）、`ROOT/src/shared/settings-keys.ts`（只追加同步布尔键）、`ROOT/src/renderer/pages/sync-gallery/**`、`ROOT/src/renderer/components/sync/**`（只复用不新建通用件）、`ROOT/src/renderer/stores/syncGalleryStore.ts`、`ROOT/src/renderer/preview/mock/**`、`ROOT/src/renderer/i18n/locales/*.json`（12 包，仅 `syncGallery.*` / `syncService.*` 段）、`ROOT/scripts/verify-nikkisync-link.ts` + `ROOT/scripts/__tests__/verify-nikkisync-link.test.ts` + `ROOT/scripts/pre-dist-check.ts`（复用同一清单，不抄第二份）、**新建** `ROOT/scripts/stage-nikkisync-pc-assets.ts` + 配套测试、`ROOT/resources/nikkisync/pc/**`（由脚本生成的资源暂存目录）、`ROOT/package.json`（仅 `build.extraResources` / `build.asarUnpack` 中与 nikkisync 资源相关条目 + `dist:win` 前置链一行，不改 scripts 其余与版本）、`ROOT/docs/IPC_CONTRACT.md`、`ROOT/docs/plans/**`、`ROOT/src/main/nikkisync/AGENTS.md`、`ROOT/src/main/sync/AGENTS.md`（仅注释订正）、`ROOT/e2e/nikkisync-*.e2e.ts`。

### 3.2 禁止改（越界即违反「不影响其他模块」）

- `ROOT/src/main/sync/**` 全部产品码、`ROOT/src/main/app/sync-server-setup.ts` 的 `PORTED_SYNC_AUTOSTART_ENABLED=false`（两个 LAN 服务同屏会分裂手机端）。
- `ROOT/src/renderer/pages/GalleryPage.tsx`、主图库、`ROOT/src/renderer/stores/mediaStore.ts` 的源分流、`gallery.dataSource` 默认值保持 `local`（翻它会改主图库，属于其他模块）。
- 其他 IPC handler / preload 命名空间、其他 store、其他页面、通用组件库、`eslint.config.js`、`vitest.config.ts`、`electron.vite.config.ts`、`.github/workflows/build.yml`、CI 配置。
- `UP/**` **任何源文件**；`ROOT/node_modules/@nikkisync/**`。全程 `git -C UP status --porcelain` 必须为 0。
- 不跑 `npm install` / `npm update`（会剪掉 4 条 junction）。

### 3.3 保证不越界的机制

1. 所有新能力挂在内嵌面 `nikkisync:*` 命名空间；`syncGalleryStore` 保持独立列表；`gallery.dataSource` 不动。
2. 新增 IPC 通道只增不减、响应体只加可选字段；`docs/IPC_CONTRACT.md` 同批更新。
3. `ROOT/src/main/ipc/handlers/nikkisync-handler.ts:1` 与 `ROOT/src/main/preload/api/nikkisync.ts:1` 的 `// @core-change:` **替换首行原因**为本轮真实中文原因（至多一条，不叠加）；`docs/IPC_CONTRACT.md` 同批（CI 闸门）。
4. 新增 `*_DEEP_ENTRY` 常量必须同步 `LOAD_CHAIN_ROOTS` 与能力清单——`ROOT/scripts/__tests__/verify-nikkisync-link.test.ts` 从 facade 源码文本抽常量逐项比对，漂移即红。
5. 新 i18n key 落在既有 `syncGallery.*` / `syncService.*` 命名空间下，12 包行级插入、真译文、插值用 `{{n}}` **不用 `{{count}}`**；主进程/handler 字符串保持英文（eslint 禁硬编码中文）。

---

## 4. 五项强制计划内容

### 4.1 依赖声明

| 项             | 声明                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm 依赖       | **零新增、零变更，不跑 `npm install`/`npm update`**。已存在且复用：`ffmpeg-static@^5.3.0`、`ffprobe-static@^3.1.0`、`qrcode@^1.5.4`、`fluent-ffmpeg@^2.1.3`（`ROOT/package.json:130-140`）。上游 `MetadataStartupComposition` / `RemoteBridgeService` / `DesktopControlServer` / `WeChatGalleryService` / `GameVersionUpdateService` / `RuntimeMemoryMaintenance` 全是上游 `dist/src/**` 内纯 `fetch`/纯本地实现，不引入新外部包 |
| `@nikkisync/*` | 保持 junction（候选根 `NIKKISYNC_ROOT` → `../NikkiSync` → `vendor/NikkiSync`）。前置仅在 `UP` 内跑 `npm run build`；`npm run link:nikkisync:check` = OK、`npm run verify:nikkisync` = `blocking failures: 0`。**绝不改 `UP` 任何源文件**                                                                                                                                                                                         |
| 上游资源暂存   | 新建 `ROOT/scripts/stage-nikkisync-pc-assets.ts`（纯函数导出 + dry-run 默认，遵循 `ROOT/scripts/AGENTS.md`）：把 4 份 legal 文档、品牌图、3 个 PS 脚本从 `UP` 拷到 `ROOT/resources/nikkisync/pc/`；上游根缺失时 **warn 并返回 skipped，不阻断**（CI `npm ci` 无 junction，与既有 `verify:nikkisync` warn-only 口径一致）。`ROOT/package.json` 的 `extraResources` 增加该项，`asarUnpack` 不新增（PS 脚本/文档不走 asar）         |
| 打包依赖面     | 仅当 `ROOT/scripts/pre-dist-check.ts:970-1038` 的外部 bare 依赖闭包扫描报缺包时，按报告追加 `build.asarUnpack`（形如既有 `**/qrcode/**`），不改 `dependencies`、不装包                                                                                                                                                                                                                                                           |

### 4.2 启动说明（环境准备 → 启动 → 验证）

```bash
# ① 上游产物前置（顺序即前置；绝不改 UP 源文件）
git -C "D:/Workbuddy 项目/WXNN YD - 副本/NikkiSync" rev-parse HEAD       # 期望 589b932…
git -C "D:/Workbuddy 项目/WXNN YD - 副本/NikkiSync" status --porcelain    # 期望空
cd "D:/Workbuddy 项目/WXNN YD - 副本/NikkiSync" && npm run build && npm test   # 退出 0
cd "D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe"
npm run link:nikkisync && npm run link:nikkisync:check                    # check OK
npm run verify:nikkisync                                                   # blocking failures: 0
npm test && npm run typecheck && npm run typecheck:e2e && npm run lint      # N0 基线全绿

# ② dev 启动与验证
npm run dev
# 一级菜单「同步图库」→ 工具栏「同步服务」→ sync-service 二级页
# 验证点：进页即出资产（不再恒空态）；服务 available/running=true；灵感库可增删改；
#         抽屉显示上游 metadata 的相机/穿搭字段；检索命中铺进网格；
#         同步服务页出现「PC 控制页 / 微信画廊」入口且可打开
# 逃生阀 A/B：NIKKI_NIKKISYNC_RUNTIME=0 npm run dev ⇒ 回到旧「默认全关」形态

# ③ 打包与真机冒烟
npm run dist:win        # 内含 build:recycle-helper + build + pre-dist-check + electron-builder + verify:dist
npm run verify:dist
npm run e2e:smoke
```

- 打包版 `wechat` 的 `ffmpeg`/`ffprobe` 路径由 `ffmpeg-static` / `ffprobe-static` 包导出的可执行文件路径注入（不依赖上游 exe）；`qrSvg` 复用 `qrcode` 的 `QRCode.toString`（与 `ROOT/src/renderer/components/sync/PairingQrDialog.tsx` 同款）。
- `desktop` 控制页绑 `127.0.0.1` 随机端口，入口 URL 取 `dashboard.address().port`（`UP/windows-app.ts:241-243` 同款），用 `shell.openExternal` 打开；wechat 会话**按需启动**（上游也是从控制页触发，不是开机自启），默认开仅表示能力可用。

### 4.3 错误处理（异常分支 / 兜底 / 日志）

| 场景                                       | 处理                                                                                                                                                                         | 日志 / 用户可见                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 新深入口装载失败（老链接、缺 `dist`）      | 沿用 `runtime-facade.ts` 的「可选面」惯例 `...(surface.x ? {...} : {})`，该能力整节不挂出、会话其余能力照常，**不吞成静默成功**                                              | `runtimeLog('warn', '<module> deep entry unavailable; run npm run build in NikkiSync')` |
| `remoteBridge:true` 但 TLS 缺失            | 上游 `runtime.ts:95-100` 自动补 `LocalTlsIdentityService`；若仍抛，`createRuntimeSession` 的 `try/catch` 先 `runtime.database.close()` 再上抛，不泄漏 SQLite 句柄            | `runtimeLog('error', ...)`，状态机 `state='error'`                                      |
| 在线解析/字典/版本检查出站失败             | 交上游服务自身收敛（abort + 重试冷却）；本仓只记短码与端点域名，**不回显响应体/UID/字典正文**；聚合计数进 `metadataResolutionDiagnostics`                                    | 单条失败不弹窗，聚合计数进状态快照                                                      |
| 同意门翻转后用户反悔                       | 保留 `metadata-online-consent.json` 与两个 `enabled:false` JSON 离线开关；`MetadataOnlineConsent.setEnabled(false)` + `metadataResolver.stop()` 立即零出站                   | 控制页隐私面板可见状态                                                                  |
| 新增 IPC 校验失败                          | `wrapHandlerNoArgs` / `wrapHandlerRaw` + zod，映射 `VALIDATION_ERROR` / `PRECONDITION_FAILED` / `NOT_FOUND`，复用 `toAppError`                                               | toast（`useErrorToast`），整节降级隐藏不阻塞其余设置                                    |
| 灵感写入冲突 / 超限                        | 逐码透传上游 `conflict`→409 语义为 `PRECONDITION_FAILED`、`too_large`→`VALIDATION_ERROR`、`invalid_entry`→`VALIDATION_ERROR`（`InspirationRoutes.ts:32-37`），不造第二套判据 | 内联错误 + 日志                                                                         |
| 后台服务 / wechat / desktop `start()` 抛错 | 与 `driveCachedMetadata` 同口径：`try/catch` 只落日志，不影响已 `running` 的主状态                                                                                           | `runtimeLog('warn', 'nikkisync <service>.start failed: <短码>')`                        |
| `stop()` 抛错 / 超时                       | 插入 `teardown()`（`runtime-manager.ts:406-445`）停止链，每步独立 `try/catch` + 超时；任何一步失败仍继续 `session.dispose()` 关库、`dashboard.close()`、`wechat.stop()`      | 逐条 warn，退出链不卡死                                                                 |
| 回收 helper 未构建                         | `nikkisync-runtime-setup.ts:242-249` 已有 warn，升级为「organizer 默认开但 helper 未构建」可诊断文案；删除任务标 `failed`，**绝不退化为永久删除**                            | warn + 队列 `failed`                                                                    |
| 未建链（CI 常态）                          | 链接态用例整件 `hasNikkiSyncLink()` skip；`verify:nikkisync` 只 warn；资源暂存脚本 warn + skipped                                                                            | 不改为目录存在判定、不加 `it.skip`                                                      |
| preview 桥                                 | `PREVIEW_UNSUPPORTED` 兜底语义保留；N6 补桩后空态分支仍在                                                                                                                    | 明确标注「预览数据」，不伪装真实资产                                                    |

日志纪律：只记开关名 / 端口 / 错误短码；**禁止**写 UID、绝对路径、灵感条目正文、元数据信封（`ROOT/src/main/nikkisync/AGENTS.md:125`）。资源用完立即释放：监听器、定时器、http.Server、SQLite 句柄、wechat listener 全部配套销毁。

### 4.4 参数校验（复用既有 zod 与 `wrapHandler` 家族）

| 面                                           | 复用 / 新增                                                                                                                                                                                                                                                              | 边界与非法值                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 既有 34 条通道                               | 全部复用 `ROOT/src/main/ipc/handlers/nikkisync-handler.ts:67-213` 的 `scanSchema` / `listSchema`(limit 1..500) / `resourceSchema` / `changesSchema` / `searchSchema` / `consentSetSchema` / `gameRootSetSchema` / `accountSelectionSchema` / `organizerApproveSchema` 等 | 不改形状、不放松上界                                                                                                                      |
| `nikkisync:inspiration-list`                 | 新增 `{after?: string(0..128), limit: number.int().min(1).max(100).default(100)}`                                                                                                                                                                                        | 对齐 `InspirationRoutes.ts:16-17`；非法 `limit` 由 zod 回落 100                                                                           |
| `nikkisync:inspiration-save`                 | 新增 `{entry: unknown（透传上游 save 自判）, baseRevision: number.int().min(0)}`                                                                                                                                                                                         | `entry` 不做本仓二次形状校验（`InspirationRepository.save` 是单真相源）；只挡 `baseRevision` 非数/负/非整（`InspirationRoutes.ts:27-29`） |
| `nikkisync:inspiration-image-put`            | 新增 `{sha256: /^[a-f0-9]{64}$/, mimeType: startsWith('image/'), bytes: ≤15*1024*1024}`                                                                                                                                                                                  | 对齐 `InspirationRoutes.ts:9,13,24`；拒非 image、拒 >15 MiB、拒形态错                                                                     |
| `nikkisync:inspiration-image-get`            | 新增 `{sha256: /^[a-f0-9]{64}$/}`                                                                                                                                                                                                                                        | 同上正则                                                                                                                                  |
| `nikkisync:desktop-*` / `nikkisync:wechat-*` | 新增 `{action: enum}`，端口/token 由主进程持有，**不接受渲染层传入 URL 或路径**                                                                                                                                                                                          | 防路径注入；无入参通道用 `wrapHandlerNoArgs`                                                                                              |
| 状态响应                                     | 只加可选 `remoteBridgeEnabled?` / `metadataDictionaryActive?` / `desktopPort?` / `wechatState?`，缺省不下发                                                                                                                                                              | 键缺席 = 该构建没这一面，不写死 `true`                                                                                                    |
| 外部输入                                     | 所有新通道先 `zod.safeParse` 再进 `wrapHandlerRaw`；`entry`/`bytes`/PS 脚本路径视为不可信，不拼路径、不 eval、不写日志                                                                                                                                                   | —                                                                                                                                         |

### 4.5 基础测试用例矩阵（每节点均含正常 / 异常 / 边界三类，具体测试名见各节点）

统一约定：

- 红灯测试一律放在**未建链也必跑**的纯函数/假注入用例（`runtime-facade.test.ts`、`runtime-manager.test.ts`、`nikkisync-handler.test.ts`、组件测试、`scripts/__tests__/*.test.ts`）；链接态 `*.linked.test.ts` 只作搭载证明，不承担红灯。
- 无天然红灯的节点（如默认值翻转）用**变异检验**取证：改回旧值即复红，读数写入 §8 表。
- 每节点先跑红灯取失败读数 → 改码 → 重跑转绿 → 立即跑该节点完整子集 + `npm run verify`。

---

## 5. 逐节点实施（严格闭环：红灯 → 改码 → 转绿）

依赖图：`N0 → N1 → N2 → N3 → (N4 ∥ N5 ∥ N6) → N7 → N8 → N9`

### N0 · 计划落仓 + 上游产物前置 + 基线

- **文件**：新建 `ROOT/docs/plans/2026-11-05-sync-gallery-pc-parity-实施计划.md`（本计划原样落盘）；只读复核 `UP/apps/pc-companion/src/{windows-app,runtime}.ts`、`ROOT/src/main/{nikkisync,sync}/AGENTS.md`。
- **输入/输出**：已批准计划 + `UP@589b932` → 仓内可追溯文档 + 同代次 `dist/` + 可比对基线读数。
- **红灯**：本节点为环境与文档，不造无意义红灯；以 `npm run docs:links` 对新建文档做链接校验。
- **动作**：§4.2 ① 的命令全跑一遍，记录 `npm test` 文件数 / passed / skipped、`verify:nikkisync` 的 `blocking failures` / `resolved` 模块数 / 根数。
- **验收（可判定）**：文档被 git 跟踪；`docs:links` 退出 0；`git -C UP rev-parse HEAD` = `589b932…` 且 `porcelain` 空；`verify:nikkisync` 输出 `blocking failures: 0`；`npm test` / `typecheck` / `typecheck:e2e` / `lint` 全退出 0；基线读数写入 §8。
- **节点后立即跑**：`npm run verify` + `npm run verify:nikkisync`。

### N1 · 默认值全部翻转为开 + 同意门默认放行 + 安全兜底与日志

- **文件**：`ROOT/src/main/app/nikkisync-runtime-setup.ts`、`ROOT/src/main/nikkisync/runtime-facade.ts`（同意门 `initiallyDisabled`）、`ROOT/src/main/nikkisync/sync-server-view.ts`（仅注释）、`ROOT/src/main/ipc/handlers/nikkisync-handler.ts`（`requireOrganizerEnabled` fallback）、`ROOT/src/shared/settings-keys.ts`（仅追加同步布尔键）、`ROOT/src/main/app/__tests__/nikkisync-runtime-setup.test.ts`、`ROOT/src/main/nikkisync/{runtime-facade,sync-server-view}.test.ts`、`ROOT/src/main/ipc/handlers/nikkisync-handler.test.ts`、`ROOT/docs/plans/2026-11-05-...实施计划.md`（安全面声明回写）。
- **输入/输出**：5 个 `*_DEFAULT` 常量 → 全 `true`；`resolveRuntimeEnabled/SyncEnabled/MetadataResolverEnabled` fallback 同步；`organizerEnabled` 缺省 `true`；同意门 `initiallyDisabled` 改为「仅当用户显式拒绝」；新增 `REMOTE_BRIDGE/DICTIONARY/VERSION_UPDATES/MEMORY_MAINTENANCE/WECHAT/DESKTOP` 六个默认开常量 + 对应 `NIKKI_NIKKISYNC_*=0` 逃生阀；`buildSessionOptions()` 缺省出参含全部开位。
- **红灯（正常/异常/边界）**：
  1. `nikkisync-runtime-setup.test.ts` › `all runtime switches default to true`（断言 5 个导出常量 `=== true`）→ 修复前失败（读到 `false`）。
  2. `nikkisync-runtime-setup.test.ts` › `buildSessionOptions exposes remoteBridge and dictionary switches by default` → 修复前失败（键不存在）。
  3. `runtime-facade.test.ts` › `consent gate allows online resolution on a fresh install`（断言首次安装 `initiallyDisabled === false`）→ 修复前失败。
  4. 异常：`nikkisync-runtime-setup.test.ts` › `env NIKKI_NIKKISYNC_RUNTIME=0 overrides enabled defaults`（既有绿，按前后均通过验收）。
  5. 边界：`sync-server-view.test.ts` › `explicit mdns:false still disables advertisement`（既有绿 + 补断言，钉住 `SYNC_SERVER_DEFAULT_MDNS=true`）。
  6. 变异取证：任一常量改回 `false`，用例 1 当场复红。
- **验收**：`npx vitest run src/main/app/__tests__/nikkisync-runtime-setup.test.ts src/main/nikkisync/runtime-facade.test.ts src/main/nikkisync/sync-server-view.test.ts src/main/ipc/handlers/nikkisync-handler.test.ts` 全绿、`0 skipped`；`npm run typecheck` 退出 0；`npm run lint` 退出 0；`NIKKI_NIKKISYNC_RUNTIME=0` 逃生阀用例仍绿。
- **节点后立即跑**：上述子集 + `npm run verify`。

### N2 · `PcCompanionRuntime` 构造参数对齐 `windows-app.ts`（remoteBridge + 在线字典 + 组合解析器）

- **文件**：`ROOT/src/main/nikkisync/runtime-facade.ts`（新 `*_DEEP_ENTRY`、`RuntimeSurface` 字段、`createRuntimeSession` 构造参数）、`ROOT/src/main/nikkisync/runtime-types.ts`、`ROOT/src/main/nikkisync/metadata-resolver-driver.ts`（扩 `metadataDictionary*` 片段，不改三条不可让步判据）、`ROOT/src/main/app/nikkisync-runtime-setup.ts`（下传配置路径）、`ROOT/src/main/nikkisync/runtime-facade.test.ts`、`ROOT/src/main/nikkisync/runtime-facade.linked.test.ts`、`ROOT/src/main/nikkisync/sync-server.linked.test.ts`、`ROOT/scripts/verify-nikkisync-link.ts`（四表扩容）、`ROOT/scripts/__tests__/verify-nikkisync-link.test.ts`、`ROOT/src/main/nikkisync/AGENTS.md`。
- **输入/输出**：经 `resolveDeepEntryUrl()` 变量式装载上游 `dist/src/metadata/{MetadataStartupComposition,MetadataResolverConfigFile,MetadataDictionaryConfigFile,MetadataDictionaryRemoteConfigFile,MetadataDictionaryService,MetadataDictionaryUpdateService,MetadataResolverPipeline,RemoteJsonMetadataResolver,NikkiAlbumsMetadataDictionaryProvider,NikkiGalleryMetadataDictionaryProvider,MetadataThumbnailCache}.js` 与 `dist/src/remote/RemoteBridgeService.js` → 构造参数补齐 `remoteBridge:true`、`metadataDictionary` / `Supplement` / `Remote` / `SupplementRemote`、`metadataResolver`（`composeMetadataResolver` 组合器版）、`server.metadataThumbnailCache`；逐字复刻 `UP/windows-app.ts:88-173` 组装顺序，端点不硬编码。
- **红灯**：`runtime-facade.test.ts` › `passes remoteBridge:true to PcCompanionRuntime`（修复前 `undefined`）；`passes online dictionary providers when enabled`（修复前无键）；`composes resolver via upstream composeMetadataResolver`（修复前是裸 `Nuan5CompatibleResolver`）。异常：`deep entry absent keeps session usable without the new capability`（缺面 ⇒ 不下发该键、会话照常）。边界：`metadata-resolver-driver.test.ts` › `still omits intervalMs and returns {} when disabled`（前后均绿，三条判据不得破坏）。链接态搭载：`sync-server.linked.test.ts` › `GET /remote/... is 401 not 404 when remoteBridge enabled`、`GET /v1/inspiration unauthenticated is 401 not 404`。
- **验收**：`npx vitest run src/main/nikkisync/runtime-facade.test.ts src/main/nikkisync/metadata-resolver-driver.test.ts scripts/__tests__/verify-nikkisync-link.test.ts` 全绿；`npm run verify:nikkisync` `blocking failures: 0` 且 `resolved` 模块数 ≥ N0；`npm run typecheck` / `npm run lint` 退出 0（无字面量 `@nikkisync` import）；`git -C UP status --porcelain` 仍空。
- **节点后立即跑**：上述子集 + `npm run verify` + `npm run verify:nikkisync`。

### N3 · 显式编排上游后台服务（补偿「不调 `runtime.start()`」）

- **文件**：`ROOT/src/main/nikkisync/runtime-manager.ts`（`start()` 成功后启、`teardown()` 停止链、`status()` 快照）、`ROOT/src/main/nikkisync/runtime-types.ts`、`ROOT/src/main/nikkisync/runtime-facade.ts`（`GameVersionUpdateService` / `RuntimeMemoryMaintenance` 深入口 + session 薄委托）、`ROOT/src/main/app/nikkisync-runtime-setup.ts`、`ROOT/src/main/nikkisync/runtime-manager.test.ts`、`ROOT/src/main/nikkisync/runtime-facade.test.ts`、`ROOT/src/main/nikkisync/runtime-facade.linked.test.ts`、`ROOT/src/main/nikkisync/AGENTS.md`、`ROOT/scripts/verify-nikkisync-link.ts` + 配套测试。
- **输入/输出**：N2 挂出的 `runtime.metadataDictionaryUpdater` / `SupplementUpdater` / `metadataResolver` / `metadataDictionary` + 新装载的两个服务 → 在 `start()`（`runtime-manager.ts:487-507`）`scanner.start()` 成功后显式 `start()`；在 `teardown()`（`:406-445`）`stopMetadataResolver()` 同段显式 `stop()`；`status()` 追加可选 `backgroundServices` 聚合布尔位。
- **约束**：**不改**「不调 `runtime.start()`」的决策（改它会无条件 `server.start()`，牵动 LAN 默认态与幂等，属顺手重构，禁止）。`RuntimeMemoryMaintenance` 在 Node/Electron 下 `collect()` 是 no-op（上游只调 `globalThis.Bun?.gc`），本轮只做 `schedule()/stop()` 形式对齐并在文档标注。`GameVersionUpdateService` 6h 出站端点写进 §1.4 安全面与日志。
- **红灯**：`runtime-manager.test.ts` › `start() starts dictionary updaters and metadata resolver after scanner.start succeeds`（修复前 0 次）；`teardown() stops every background service before disposing database`（修复前 0 次）；异常 `a failing background start does not flip state away from running`；边界 `session without background handles starts without extra calls`；`runtime-facade.test.ts` › `GameVersionUpdateService and RuntimeMemoryMaintenance are constructed only when enabled`（修复前未装载）。
- **验收**：`npx vitest run src/main/nikkisync/runtime-manager.test.ts src/main/nikkisync/runtime-facade.test.ts` 全绿；`npm run typecheck` 退出 0；`verify:nikkisync` 闭包含两个新根且 `blocking failures: 0`；`npm run verify` 退出 0。
- **节点后立即跑**：上述子集 + `npm run verify` + `npm run verify:nikkisync`。

### N4 · 灵感库列表/编辑器 + 4 条新 IPC 通道

- **文件**：`ROOT/src/main/ipc/handlers/nikkisync-handler.ts`（替换首行 `@core-change:` + 4 通道 + zod）、`ROOT/src/main/preload/api/nikkisync.ts`（替换首行 + 4 方法）、`ROOT/src/shared/types/electron-api.ts`、`ROOT/src/main/nikkisync/runtime-types.ts`、`ROOT/src/main/nikkisync/runtime-facade.ts`（从 `runtime.server.inspirations` 挂委托，`LocalSyncServer.ts:143,165` 已确认该属性存在）、`ROOT/src/main/ipc/handlers/nikkisync-handler.test.ts`、`ROOT/src/main/preload/__tests__/preload.test.ts`、`ROOT/src/renderer/stores/nikkisyncContractTypes.test.ts`、**新建** `ROOT/src/renderer/pages/sync-gallery/SyncInspirationPanel.tsx` + `.test.tsx`、`ROOT/src/renderer/pages/sync-gallery/SyncServicePage.tsx` + `.test.tsx`、`ROOT/src/renderer/i18n/locales/*.json`（12 包）、`ROOT/src/renderer/i18n/locales/sync-service-keys.test.ts`、`ROOT/docs/IPC_CONTRACT.md`（同批）。
- **输入/输出**：上游 `InspirationRepository` → `nikkisync:inspiration-list` / `inspiration-save` / `inspiration-image-put` / `inspiration-image-get` 四通道 → `nikkisyncAPI` → `SyncInspirationPanel` 列表/新建/编辑/删除/图片。形状逐字对齐 `UP/.../InspirationRoutes.ts:8-37`。
- **红灯**：`nikkisync-handler.test.ts` › `registers four nikkisync:inspiration-* channels`（修复前红）；`inspiration-image-put rejects non-image mimeType and oversized body`（异常/边界，通道不存在即红）；`preload.test.ts` › `nikkisyncAPI exposes the four inspiration methods`（修复前红）；`SyncInspirationPanel.test.tsx` › `renders inspiration entries from inspiration-list`（正常）、`shows inline error when save conflicts`（异常）、`empty list and bridge-missing render nothing`（边界）；`sync-service-keys.test.ts` › `all 12 locales contain syncService.inspiration.* keys`（先扩 `REQUIRED_KEYS` 后红）。
- **验收**：`npx vitest run src/main/ipc/handlers/nikkisync-handler.test.ts src/main/preload/__tests__/preload.test.ts src/renderer/pages/sync-gallery src/renderer/stores/nikkisyncContractTypes.test.ts src/renderer/i18n/locales/sync-service-keys.test.ts` 全绿；`npm run typecheck` / `npm run i18n:guard` / `npm run format:check` 退出 0；`npx eslint src/renderer/pages/sync-gallery` 零 error；`docs/IPC_CONTRACT.md` 与 handler/preload 在同一 diff。
- **节点后立即跑**：上述子集 + `npm run verify` + `npm run i18n:guard`。

### N5 · 渲染层数据对齐：抽屉读上游 `metadata` + 检索命中回捞铺网格

- **文件**：`ROOT/src/renderer/pages/sync-gallery/{SyncAssetDrawer,SyncInsightPanel,SyncGalleryPage}.tsx` + 各自 `.test.tsx`、`ROOT/src/renderer/stores/syncGalleryStore.ts`、`ROOT/src/renderer/utils/assetViewModel.ts`（只加映射函数，不改既有面板）、`ROOT/src/renderer/i18n/locales/*.json` + `sync-gallery-keys.test.ts`、`ROOT/docs/plans/2026-11-05-...实施计划.md`（订正两处「刻意不做 / 恒空」自述）。
- **输入/输出**：`nikkisync.getAssetDetail(file.id)` → `asset.metadata`（上游 `row-mappers.ts:78-133` 已产出完整 `InfinityPhotoMetadata`）→ 抽屉五个参数面板；`searchSuits/searchClothing` 命中 `assetId` → `getResourceRecords({assetIds, mode:'path'|'meta'})` → `media://` 授权 → 铺进网格。
- **红灯**：`SyncAssetDrawer.test.tsx` › `loads upstream asset metadata via getAssetDetail when opened`（修复前 0 次调用）；异常 `falls back to local decoded metadata when getAssetDetail fails`；边界 `bridge without getAssetDetail keeps legacy rendering`；`SyncInsightPanel.test.tsx` › `search hits are resolved into gallery items via getResourceRecords`（修复前只出文本榜）；异常 `failed resource backfill keeps text hits and shows inline notice`；边界 `empty hits and repeated submit do not issue duplicate IPC`。
- **验收**：`npx vitest run src/renderer/pages/sync-gallery src/renderer/i18n/locales/sync-gallery-keys.test.ts` 全绿；`npm run i18n:guard` / `npm run typecheck` / `npm run format:check` 退出 0；`npx eslint src/renderer/pages/sync-gallery` 零 error。
- **节点后立即跑**：上述子集 + `npm run verify` + `npm run i18n:guard`。

### N6 · preview 版补齐 `nikkisync` 命名空间桩

- **文件**：**新建** `ROOT/src/renderer/preview/mock/nikkisync-mock.ts` + `.test.ts`、`ROOT/src/renderer/preview/mock/install.ts`（`IMPLEMENTED_NAMESPACES` 加 `nikkisync`）、`ROOT/src/renderer/preview/mock/install.test.ts`（不存在则新建）。
- **输入/输出**：`installPreviewMock()` 暴露 `window.electronAPI.nikkisync`，覆盖 `getRuntimeStatus` / `getAssets` / `getResourceRecords` / `getAssetDetail` / `getServerStatus` / `searchSuits` / `searchClothing` / `profileStats` / `getSyncAccounts` / `getExtraDirectories` / `getOrganizerQueue` / `inspirationList` / `onLibraryChanged` 等，返回结构正确的桩数据（不抛 `PREVIEW_UNSUPPORTED`、不返回 `undefined`）。
- **红灯**：`nikkisync-mock.test.ts` › `installPreviewMock exposes a nikkisync namespace with async methods`（修复前 Proxy 抛 `PREVIEW_UNSUPPORTED`）；`install.test.ts` › `IMPLEMENTED_NAMESPACES includes nikkisync`（修复前红）；异常 `preview nikkisync calls never throw PREVIEW_UNSUPPORTED`；边界 `unimplemented nikkisync methods still fall back to PREVIEW_UNSUPPORTED`。
- **验收**：`npx vitest run src/renderer/preview/mock` 全绿；`npm run preview:check` 退出 0（若报漂移按实测输出补白名单，不臆造）；`npm run typecheck` / `npm run lint` 退出 0。
- **节点后立即跑**：上述子集 + `npm run verify` + `npm run preview:check`。

### N7 · 接入 `wechat/*` 微信画廊 + `desktop/*` 本机控制页（用户确认「两块都接」）

- **文件**：**新建** `ROOT/src/main/nikkisync/pc-companion-services.ts`（薄装配：变量式动态 import + 构造 + 启停委托，不重写上游协议）、`ROOT/src/main/nikkisync/pc-companion-services.test.ts`、`ROOT/scripts/stage-nikkisync-pc-assets.ts` + `ROOT/scripts/__tests__/stage-nikkisync-pc-assets.test.ts`、`ROOT/src/main/nikkisync/runtime-facade.ts`（挂出 `runtime.server.inspirations` / `accounts` / `deletions` / `remoteBridge` 等供控制页使用）、`ROOT/src/main/nikkisync/runtime-manager.ts`（把控制页/wechat 的 `start/stop` 接进 N3 的后台服务链）、`ROOT/src/main/app/nikkisync-runtime-setup.ts`（下传资源目录与 ffmpeg/ffprobe 路径）、`ROOT/src/main/ipc/handlers/nikkisync-handler.ts`（新增 `desktop-open` / `wechat-start` / `wechat-stop` / `wechat-status` 通道，`@core-change:` 原因同批替换）、`ROOT/src/main/preload/api/nikkisync.ts`（同批 4 方法）、`ROOT/src/shared/types/electron-api.ts`、`ROOT/src/renderer/pages/sync-gallery/SyncServicePage.tsx` + `.test.tsx`（新增「PC 端」分区：控制页入口 + 微信画廊启停/状态/二维码）、`ROOT/src/renderer/i18n/locales/*.json` + `sync-service-keys.test.ts`、`ROOT/docs/IPC_CONTRACT.md`（同批）、`ROOT/package.json`（`extraResources` 增 `resources/nikkisync/pc/**`；`dist:win` 前置链增 `stage:nikkisync-pc` 一步）、`ROOT/scripts/verify-nikkisync-link.ts` + 配套测试（新深入口入四表）、`ROOT/e2e/nikkisync-runtime.e2e.ts`（新增默认开与两块服务断言）。
- **输入/输出**：上游 `dist/src/desktop/DesktopControlServer.js`（`createDesktopControlServer`）、`dist/src/desktop/DesktopStatusService.js`、`dist/src/wechat/WeChatGalleryService.js`、`dist/src/wechat/GalleryRuntime.mjs`（`createIndexedPreviewSource`）、`dist/src/wechat/WeChatIconProvider.js`、暂存的 4 份 legal 文档 + 品牌图 + 3 个 PS 脚本、以及 `ffmpeg-static`/`ffprobe-static`/`qrcode` → 一个绑 `127.0.0.1` 随机端口的本机控制页 + 按需启停的微信画廊 → 同步服务页入口可打开控制页、可启停微信画廊并显示状态/二维码。
- **关键约束**：① 复刻 `UP/windows-app.ts:196-254` 的组装与 shutdown 顺序（`wechat.stop()` → `dashboard.close()` → `runtime.stop()`），不自行实现 HTTP/PS/协议；② 上游用 `import.meta.dirname` 拼 `UP` 仓内资源路径，打包态不可用 ⇒ 全部资源路径由本仓 `PackagingContext` / 暂存目录显式注入；③ `qrSvg` 复用 `qrcode` 的 `QRCode.toString`；④ `exportLive`/`rotatePng`/`resize*` 的 PS 脚本路径指向暂存目录，`ffmpeg`/`ffprobe` 指向 `ffmpeg-static`/`ffprobe-static` 导出的 exe；⑤ 控制页 token 由上游内嵌在根页面 HTML（`DesktopControlServer.ts:229`），入口用 `shell.openExternal('http://127.0.0.1:<port>/')`，**不**自行造 token；⑥ 资源暂存脚本在 `UP` 缺失时 warn + skipped，不阻断 CI。
- **红灯（正常/异常/边界）**：`pc-companion-services.test.ts` › `constructs DesktopControlServer and WeChatGalleryService from upstream deep entries`（修复前 0 次构造）；`staged pc assets include four legal docs, brand image and three ps1 scripts`（修复前资源不存在）；`SyncServicePage.test.tsx` › `renders PC control entry and wechat start/stop controls`（修复前无入口）；`nikkisync-handler.test.ts` › `registers desktop-open and wechat-* channels`（修复前红）；异常 `a failing wechat start surfaces an inline error and keeps runtime running`；边界 `upstream root missing stages nothing and reports skipped`、`desktop page port is taken from dashboard.address() and bound to 127.0.0.1`。
- **验收**：`npx vitest run src/main/nikkisync/pc-companion-services.test.ts src/main/ipc/handlers/nikkisync-handler.test.ts src/main/preload/__tests__/preload.test.ts src/renderer/pages/sync-gallery src/renderer/i18n/locales/sync-service-keys.test.ts scripts/__tests__/stage-nikkisync-pc-assets.test.ts scripts/__tests__/verify-nikkisync-link.test.ts` 全绿；`npm run typecheck` / `npm run i18n:guard` / `npm run format:check` 退出 0；`npm run verify:nikkisync` `blocking failures: 0`；`git -C UP status --porcelain` 仍空。
- **节点后立即跑**：上述子集 + `npm run verify` + `npm run i18n:guard` + `npm run verify:nikkisync`。

### N8 · 打包态与 dev 一致性：清单扩容 + 重打包 + 真机冒烟

- **文件**：`ROOT/scripts/verify-nikkisync-link.ts`（四表最终态）、`ROOT/scripts/__tests__/verify-nikkisync-link.test.ts`、`ROOT/scripts/pre-dist-check.ts`（复用同一判定核，不抄第二份）、`ROOT/package.json`（仅条件性 `asarUnpack`/`extraResources`）、`ROOT/e2e/nikkisync-runtime.e2e.ts`、`ROOT/e2e/nikkisync-game-root.e2e.ts`、`ROOT/docs/plans/2026-11-05-...实施计划.md`（读数回写）。
- **输入/输出**：N2/N3/N7 新增深入口与暂存资源 → `app.asar.unpacked/node_modules/@nikkisync/**` 与 `resources/nikkisync/pc/**` 逐项存在、外部 bare 依赖闭包可解析 → 重生成 `release/MeowStarMap-Setup-2.5.7-beta.exe` 与 `release/win-unpacked/` → `e2e:smoke` 读数。
- **红灯**：`scripts/__tests__/verify-nikkisync-link.test.ts` › `LOAD_CHAIN_ROOTS matches every *_DEEP_ENTRY in runtime-facade.ts`（先加断言再补清单，修复前红）；`capability artifacts include metadata composition, remote bridge, desktop and wechat entries`（修复前红）；`scripts/__tests__/pre-dist-check.test.ts` › `packed capability artifacts verdict covers the new entries`（既有绿，前后均通过）；`e2e/nikkisync-runtime.e2e.ts` › `built app starts with all nikkisync switches enabled by default`（重打包前用旧包 ⇒ 失败）。
- **验收（可判定）**：`npm run dist:win` 退出 0（内含 `build:recycle-helper` 产出 helper exe、`pre-dist-check` 三段全绿、`electron-builder --win --publish never`）；`npm run verify:dist` 退出 0；`npm run e2e:smoke` 退出 0；`npm run typecheck:e2e` 退出 0；`release/win-unpacked/resources/app.asar.unpacked/node_modules/@nikkisync/pc-companion/dist/src/` 新增 `.js` 与 `UP/apps/pc-companion/dist/src/` 同名文件哈希一致（`Get-FileHash` / `sha256sum`），读数写入 §8；**不信任 11-05 18:09 旧包**。
- **节点后立即跑**：`npm run verify` + `npm run verify:nikkisync` + `npm run verify:dist` + `npm run e2e:smoke`。

### N9 · 文档回写 + 全量回归 + 未同步项清单

- **文件**：`ROOT/src/main/nikkisync/AGENTS.md`、`ROOT/src/main/sync/AGENTS.md`（保留「移植面默认静默」定性，补一句「本轮仅内嵌面默认翻开」）、`ROOT/docs/IPC_CONTRACT.md`（最终态）、`ROOT/docs/sync-integration/README.md`、`ROOT/docs/技术债清单.md`、`ROOT/docs/debt-registry.json`（如适用）、`ROOT/docs/plans/2026-11-05-...实施计划.md`（§8 逐项读数 + §7 未同步项）、`ROOT/CHANGELOG.md`。
- **三类用例（回归性质）**：正常 = 全量退出 0；异常 = 任一命令非零即停轮并记 `not-run` 原因，不伪造绿灯；边界 = `skipped` 口径与 N0 基线一致、零新增失败。
- **判据**：见 §6；`git -C UP status --porcelain` = 0；本仓 `git status --porcelain` 无钩子遗留；每节点一个 Conventional Commit（红灯与修复同提交，**禁止 `--no-verify`**）。

---

## 6. 分步验证与全局校验

### 6.1 每节点门槛（顺序即闸门）

1. 先写该节点红灯测试 → 实跑 `npx vitest run <新测试文件>` 取**失败读数**写入 §8。
2. 改产品码 → 重跑 `npx vitest run <本节点完整子集>` 转绿、链接态除外 `0 skipped`。
3. `npm run verify`（只读：`tsc -b` + eslint 只读 + core-path-gate + prettier --check + 相关单测）。
4. 涉及 `handlers/**`/`preload/**`：核 `docs/IPC_CONTRACT.md` 与 `@core-change:` 同批。
5. 涉及 `runtime-facade.ts` 深入口：额外 `npm run verify:nikkisync`。
6. 涉及 locale：额外 `npm run i18n:guard` + `npx eslint src/renderer/pages/sync-gallery` + `npm run format:check`。
7. **不得**只依赖 `npm run verify` 覆盖新增测试（`scripts/find-related-tests.ts` 只取首个同名文件）。

### 6.2 全量顺序（N9，逐项记退出码）

```bash
npm test
npm run lint
npm run typecheck
npm run typecheck:e2e
npm run format:check
npm run i18n:guard
npm run docs:links
npm run verify:nikkisync       # blocking failures: 0
npm run audit                  # 需网络；失败如实记 not-run 并附原因
npm run verify
npm run dev                    # 人工：同步图库出资产 / 服务全开 / 灵感库 / 抽屉上游 metadata /
                               #       命中铺网格 / 控制页与微信画廊入口可用
npm run dist:win               # 含 build:recycle-helper + build + pre-dist-check + electron-builder + verify:dist
npm run verify:dist
npm run e2e:smoke
```

**通过判据**：可跑项全部退出 0；`npm test` 文件数 ≥ N0、`failed=0`、`skipped` 与 N0 相同；`git -C UP status --porcelain` = 0；提交后无钩子遗留。已知既有现象（不以其为判据）：`npm run test:ci-linux` 在开发机为红；`npm run audit` 网络失败记 `not-run`。

### 6.3 因未建链 skip 的套件与本机真实执行方式

| 套件                                                                 | 未建链表现                                         | 门控依据                                                    |
| -------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------- |
| `ROOT/e2e/nikkisync-runtime.e2e.ts`、`nikkisync-game-root.e2e.ts`    | 整件 skip                                          | `ROOT/e2e/nikkisync-guard.ts:34-48` `decideNikkiSyncGate()` |
| `ROOT/src/main/nikkisync/*.linked.test.ts`、`protocol-drift.test.ts` | 整件 `describe.skip`                               | `ROOT/src/main/nikkisync/AGENTS.md:92-98`                   |
| `npm run e2e:smoke`（S1–S8）                                         | 不 skip（不依赖链接），但需 `release/win-unpacked` | `ROOT/e2e/smoke.e2e.ts`                                     |

本机建链后真实执行（N0 已建链，重打包机复核）：

```bash
cd "D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe"
npm run link:nikkisync && npm run link:nikkisync:check
npm run verify:nikkisync
npm run build
npx playwright test --config e2e/playwright.config.ts e2e/nikkisync-runtime.e2e.ts e2e/nikkisync-game-root.e2e.ts
npx vitest run src/main/nikkisync/runtime-facade.linked.test.ts src/main/nikkisync/metadata-resolver.linked.test.ts src/main/nikkisync/sync-server.linked.test.ts src/main/nikkisync/protocol-drift.test.ts
npm run e2e:smoke
```

判据：链接态 `0 skipped` 全 passed；`nikkisync-runtime.e2e.ts` 日志含 `embedded runtime start result`、`sync server autostart: running=true`、`nikkisync runtime stopped`；退出后 28080 端口释放、WAL checkpoint、上游默认库读数不变。

---

## 7. 仍存在未同步项（诚实清单）

| #   | 上游能力                                                                                                               | 状态                           | 原因 / 后续建议                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | windows-shell 托盘 / 开机自启 / 自动更新 / 网络诊断包 / 临时热点 / 单文件 `NikkiSync-PC.exe`                           | **明确不搬（用户口径）**       | 属 WPF 外壳，不在 `apps/pc-companion`；保持不做                                                                                                                                                      |
| R2  | `RuntimeMemoryMaintenance` 的实际 GC 效果                                                                              | 形式对齐                       | 上游只调 `globalThis.Bun?.gc(true)`，Electron/Node 无 Bun ⇒ `collect()` no-op；本轮只接 `schedule()/stop()`。需真实回收须另立 Electron 侧方案                                                        |
| R3  | `GameVersionUpdateService` 官网 HTML / Steam 公告解析结果逐字一致、`versionAssetPages` / `updateEnglishNames`          | 形式对齐                       | 解析器在上游内部，本仓只实例化 + 启停；需要结果一致时另立通道透出                                                                                                                                    |
| R4  | `metadataThumbnailCache` 2GB 服装缩略图缓存                                                                            | 部分                           | N2 注入 `MetadataThumbnailCache` 构造，但缓存目录与逐项失效策略沿用上游默认，未做本仓侧独立治理                                                                                                      |
| R5  | `gallery.dataSource` 默认切 `nikkisync`                                                                                | **不翻**                       | 消费点是主图库 `GalleryPage.tsx`，翻转会改其他模块；由用户在设置页自行切换                                                                                                                           |
| R6  | 移植面 `sync:*` 自研 HTTPS+WS 服务（27124）                                                                            | 保持静默                       | `PORTED_SYNC_AUTOSTART_ENABLED=false` 不动；两个 LAN 服务同屏会分裂手机端                                                                                                                            |
| R7  | 上游 U4/U5/U6/U7/U9 的 LAN 端点级逐字复刻（`video` 扫描、`queue_full`、413/Range 409、nonce 窗口、跨设备 mDNS browse） | 部分                           | 随 `589b932` dist 产物自动生效；`queue_full` 经 02 计划实测为无判据死码（不加死码）；413/409 纯 LAN 语义本仓无通道；跨设备 mDNS 需双机实测，另立节点                                                 |
| R8  | 微信小程序端 / Android 端本体                                                                                          | 不接                           | 独立产品形态，非 PC 端内容；本轮只接 PC 侧 `wechat/*` 服务端                                                                                                                                         |
| R9  | preview 版桩数据真实性                                                                                                 | 桩                             | `preview.html` 无主进程、无 `@nikkisync` 运行时，只能给结构正确的桩数据；保持明确「预览数据」标注                                                                                                    |
| R10 | 旧 `release/MeowStarMap-Setup-2.5.7-beta.exe`（18:09）逐字节比对与最终 e2e 读数                                        | **未做（用户口径「不打包」）** | `dist/` 已于 11-06 00:21 重建，但 `release/` 仍是 11-05 18:09 旧包；`dist:win` / `verify:dist` / 产物哈希比对 / 8 件资源随包校验全部记 not-run。装机版暂不含本轮任何改动，需下一轮单独重打包         |
| R11 | 控制页 4 份 legal 文档的**中文译文/法务有效性**                                                                        | 原样搬运                       | 上游文档按原文暂存，本仓不改写、不做合规背书                                                                                                                                                         |
| R12 | `DesktopStatusService` 空 database / 控制页配对串空串 / 微信画廊扫描根空数组（「有二维码无照片」）                     | **C1 已修复**                  | 新增只读 `pcCompanionContext()`（`state.session` 的 `runtime.database` / `scanner.getScanRoots()` / `pairingUri(host)`），并把 PC 服务装配移到 `manager.start()` 之后；红灯 7 failed → 绿灯 137 用例 |

**分级**：已完成且可判定 = N1–N7 与 C1；形式对齐 = R2/R3；超出边界 = R1/R6/R8；需另立节点 = R4/R7 的真机级验证与 R10 的重打包；已修复 = R12。

---

## 8. 风险、回滚与实测读数表（执行时逐项填写，勿预填）

| 风险                                                        | 处置                                                                                                                                                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 默认全开后启动即扫描 + `0.0.0.0` 监听 + 出站                | 六个 `NIKKI_NIKKISYNC_*=0` 逃生阀、两个 `enabled:false` JSON、`MetadataOnlineConsent.setEnabled(false)` 一键回退；`runtimeLog` 汇总开关位；同意门虽默认放行但保留显式关闭入口 |
| 新增深入口在装机版 `ERR_MODULE_NOT_FOUND`                   | N8 四张清单 + `pre-dist-check` 闭包 + 逐字节哈希三道闸；缺件即 `dist:win` 红灯，不带病发包                                                                                    |
| 上游资源路径用 `import.meta.dirname` 拼仓内路径，打包态失效 | N7 全部经 `PackagingContext` / 暂存目录显式注入；`stage-nikkisync-pc-assets.ts` 在 `UP` 缺失时 warn + skipped                                                                 |
| ffmpeg 二进制上游没有                                       | 复用本仓 `ffmpeg-static` / `ffprobe-static`（已核对存在且已 `asarUnpack`），零新增依赖                                                                                        |
| `npm ci` 的 CI 不建 junction                                | 链接态用例整件 skip、`verify:nikkisync` warn-only、资源暂存 skipped；与既有 CI 口径一致，不改为硬失败                                                                         |
| 后台服务停不掉卡住退出链                                    | `teardown()` 每步独立 try/catch + 超时，停不动也继续 `dispose()` / `dashboard.close()` / `wechat.stop()`                                                                      |
| `npm run verify` 漏跑新增测试                               | §6.1 第 7 条：每节点显式 `npx vitest run <完整子集>`                                                                                                                          |
| 回滚                                                        | 每节点一个 Conventional Commit；默认值翻转是「单常量 + 单提交」，可即时 `git revert`；禁止 `--no-verify`                                                                      |

| 读数项                                                              | 结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| N0 `npm test` 基线（文件数 / passed / skipped / 退出码）            | **475 files / 7638 passed / 20 skipped / exit 0**（系统 Node 26.3.0）                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| N0 `verify:nikkisync`（blocking failures / resolved 模块数 / 根数） | **blocking failures: 0 / resolved 53 modules / 13 roots / exit 0**                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| N0 上游 `npm run build` + `npm test`                                | **exit 0**（`pass 252` + `pass 31`，`fail 0`）；`git -C UP status --porcelain` 为空                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| N0 `typecheck` / `typecheck:e2e` / `lint` / `docs:links`            | **全部 exit 0**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| N0 环境结论（重要）                                                 | WorkBuddy 会话默认把自带 **Node 22.22.2** 插在 PATH 最前，导致 `probe.test.ts:176`（要求宿主 Node ≥24）基线失败、上游 `--test-isolation=none` 也报 `bad option`。本机 `C:/Program Files/nodejs` 实为 **Node 26.3.0**。**后续所有命令统一前置 `PATH="/c/Program Files/nodejs:$PATH"`**。首次 Node 26 全量跑曾遇 1 次 `disk.test.ts` forks worker 启动超时（偶发），复跑即全绿，已记录不掩盖                                                                                                                                                 |
| N1 红灯 → 绿灯                                                      | **红：4 failed / 30 passed**（新增 4 条断言全失败）→ **绿：4 文件 223 用例全通过**；`verify` 5/5 全绿（首次 `format` 红，仅对本次改动文件 `prettier --write` 后转绿）                                                                                                                                                                                                                                                                                                                                                                      |
| N1 变异检验                                                         | 把 `RUNTIME_ENABLED_DEFAULT` 改回 `false` ⇒ **3 failed / 31 passed（复红）**，恢复后 **186 用例全绿**，证明红灯用例钉住默认能力位                                                                                                                                                                                                                                                                                                                                                                                                          |
| N1 连带改写                                                         | `metadata-resolver.linked.test.ts` K2 同意门用例按「干净安装默认放行 / 显式撤回零出站 / 跨会话持久化 / 重新同意恢复」重写，7 用例全绿                                                                                                                                                                                                                                                                                                                                                                                                      |
| N1 广域回归                                                         | 首轮出现 1 次渲染层 `waitFor` 偶发超时（非确定性），随后**连续两次 108 文件 / 1864 用例全绿、exit 0**；完整输出留档 `C:/Users/45001/AppData/Local/Temp/n1-broad-regression.log`                                                                                                                                                                                                                                                                                                                                                            |
| N2 红灯 → 绿灯                                                      | **红：3 failed / 50 passed**（`runtime-facade.test.ts` 新增 remoteBridge / 字典 provider / composeMetadataResolver 三条断言全失败）→ **绿：3 文件 140 用例全通过**                                                                                                                                                                                                                                                                                                                                                                         |
| N2 真实装载与闸门                                                   | `verify:nikkisync` **blocking failures: 0 / resolved 61 modules / 17 roots**（N0 为 53/13）；链接态 3 文件 **40 用例全绿**；`typecheck` / `lint` / `verify`（5/5）全 0                                                                                                                                                                                                                                                                                                                                                                     |
| N2 清单同步                                                         | `verify-nikkisync-link.ts` 能力清单 7→11、`LOAD_CHAIN_ROOTS` 13→17，配套结构契约测试同步（17 根 / 11 产物）                                                                                                                                                                                                                                                                                                                                                                                                                                |
| N3 红灯 → 绿灯                                                      | **红：4 failed / 89 passed**（`runtime-manager.test.ts` 新增 5 条用例中 4 条失败）→ **绿：2 文件 146 用例全通过**；`typecheck` / `lint` 全 0，链接态 3 文件 40 用例全绿                                                                                                                                                                                                                                                                                                                                                                    |
| N6 红灯 → 绿灯                                                      | **红：4 failed / 1 passed**（`nikkisync-mock.test.ts`）→ **绿：2 文件 8 用例全通过**；`npm run preview:check` exit 0（PASS=5 / WARN=5 / FAIL=0）；`typecheck` exit 0。子代理实现，主代理亲自复核                                                                                                                                                                                                                                                                                                                                           |
| N4–N7 各节点红灯 → 绿灯                                             | **N4+N7**：红 `4 failed / 193 passed` → 绿 `4 files / 201 passed`；最终定向 **11 files / 309 passed**。**N5**：6 条红灯全失败 → 绿，整目录 **115 passed**。**N6**：红 `4 failed / 1 passed` → 绿 `8 passed`，`preview:check` exit 0。`verify:nikkisync` 扩到 **24 roots / 18 artifacts / blocking 0**（`resolved 78 modules`）。子代理实现，主代理亲自复核                                                                                                                                                                                 |
| N7 `i18n:guard` / `verify:nikkisync` 读数                           | 12 语包补 29 个新 key（7 N5 + 15 N4 + 7 N7，含 `{{state}}` 插值），两处 key 守卫同步；`i18n:guard` exit 0、守卫 **22 passed**；`verify:nikkisync` **blocking 0 / 24 roots / 18 artifacts**；静态检查 `typecheck` / `typecheck:e2e` / `lint` / `format:check` / `docs:links` / `verify`(5/5) 全 0                                                                                                                                                                                                                                           |
| N8 `dist:win` / `verify:dist` / 产物哈希比对                        | **未执行（用户口径「暂不打包」）**：`dist/` 已于 11-06 15:44 按本轮源码重建（为让链接态 e2e 跑在新代码上），但 `release/` 仍是 **2026-11-05 18:09 旧包**；`dist:win` / `verify:dist` / 解包树 11 项 `.js` 逐字节哈希 / `win-unpacked/resources/nikkisync/pc/` 8 件资源随包校验全部记 not-run。**装机版暂不含本轮任何改动**                                                                                                                                                                                                                 |
| C1 三处 PC 端降级补齐                                               | 红 **7 failed / 130 passed**（5 条真实能力缺口 + 2 条新增 describe 缺 `mockClear` 的夹具噪声）→ 绿 **3 files / 137 passed**；广域回归 `src/main/nikkisync src/main/app` **47 files / 925 passed / exit 0**；`typecheck` / `typecheck:e2e` / `lint` / `format:check` 全 0                                                                                                                                                                                                                                                                   |
| N9 全量逐项退出码 + `git -C UP status --porcelain`                  | 字典缺陷修复后的**最终全量**：`npm test` **480 files / 7694 passed / 20 skipped / exit 0**；`lint` / `typecheck` / `typecheck:e2e` / `format:check` / `i18n:guard` / `docs:links` / `verify:nikkisync`(blocking 0) / `pre-dist-check` / `audit` / `verify`(**5/5**) 全部 **exit 0**；`git -C UP status --porcelain` 为空                                                                                                                                                                                                                   |
| not-run 清单与原因                                                  | ① `dist:win` / `verify:dist` / 产物级哈希与 8 件资源随包校验 —— 用户口径「暂不打包」；② `npm run dev` 5 项人工 GUI 判据 —— 本环境无 GUI，未做人工目视验收（链接态 e2e 已覆盖大部分启动/桥面/退出链证据，见下两行）；③ 沙箱安全策略阻止 `reg.exe`（GPU 注册表偏好写入）——未绕过、未重试，e2e 21 用例未因此失败                                                                                                                                                                                                                              |
| C4 字典配置缺陷（真机 e2e 暴露）                                    | 首次 `e2e:smoke` **2 failed / 9 did not run / 10 passed**，根因 `state=error hint=metadata dictionary schemaVersion must be 1`：N2 把 `composeMetadataDictionaryProvider()` 的 provider 错放进上游 `config.metadataDictionary`（该位要 manifest）。补红灯回归 `runtime-facade.test.ts`（红 `1 failed / 53 passed` → 绿 `54 passed`），改码为干净安装不下传该两键、provider 只走 Remote/SupplementRemote；重建 `dist` 后 **`e2e:smoke` 21 passed / exit 0**（`linkGate=run`、N 套件 12 条 + G 套件 3 条 + S1–S8 + 诊断用例全绿，0 skipped） |
| C4 链接态与 PC 装配实证                                             | 链接态 vitest 四件套 **4 files / 45 passed / 0 skipped / exit 0**；主进程日志实测：六个能力位全 `true`、`embedded runtime start result: state=running tables=17`、`sync server autostart: running=true port=28080`、`pc companion services started: http://127.0.0.1:3349/`、`pc companion services stopped`。注意 `e2e:smoke` 中 S1–S8 打在 **11-05 18:09 旧 `win-unpacked`** 上，其绿灯不代表本轮产物                                                                                                                                    |

---

## 9. 需修改/新建文件的完整绝对路径清单

**新建**

- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/docs/plans/2026-11-05-sync-gallery-pc-parity-实施计划.md`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/renderer/pages/sync-gallery/SyncInspirationPanel.tsx` + `.test.tsx`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/renderer/preview/mock/nikkisync-mock.ts` + `.test.ts`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/renderer/preview/mock/install.test.ts`（若不存在）
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/main/nikkisync/pc-companion-services.ts` + `.test.ts`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/scripts/stage-nikkisync-pc-assets.ts`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/scripts/__tests__/stage-nikkisync-pc-assets.test.ts`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/resources/nikkisync/pc/**`（脚本生成的资源暂存目录）

**修改（主进程 / 契约）**

- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/main/app/nikkisync-runtime-setup.ts`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/main/nikkisync/runtime-facade.ts`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/main/nikkisync/runtime-manager.ts`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/main/nikkisync/runtime-types.ts`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/main/nikkisync/metadata-resolver-driver.ts`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/main/nikkisync/sync-server-view.ts`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/main/nikkisync/AGENTS.md`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/main/sync/AGENTS.md`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/main/ipc/handlers/nikkisync-handler.ts`（core-path）
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/main/preload/api/nikkisync.ts`（core-path）
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/shared/types/electron-api.ts`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/shared/settings-keys.ts`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/docs/IPC_CONTRACT.md`

**修改（渲染层 / 语包）**

- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/renderer/pages/sync-gallery/SyncGalleryPage.tsx`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/renderer/pages/sync-gallery/SyncServicePage.tsx`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/renderer/pages/sync-gallery/SyncAssetDrawer.tsx`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/renderer/pages/sync-gallery/SyncInsightPanel.tsx`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/renderer/stores/syncGalleryStore.ts`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/renderer/utils/assetViewModel.ts`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/renderer/preview/mock/install.ts`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/renderer/i18n/locales/{de,en,es,fr,ja,ko,pt,ru,th,vi,zh-CN,zh-TW}.json`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/renderer/i18n/locales/sync-gallery-keys.test.ts`、`sync-service-keys.test.ts`

**修改（测试 / 脚本 / 打包 / 文档）**

- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/main/app/__tests__/nikkisync-runtime-setup.test.ts`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/main/nikkisync/{runtime-facade,runtime-manager,sync-server-view,metadata-resolver-driver}.test.ts`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/main/nikkisync/{runtime-facade,sync-server}.linked.test.ts`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/main/ipc/handlers/nikkisync-handler.test.ts`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/main/preload/__tests__/preload.test.ts`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/renderer/stores/nikkisyncContractTypes.test.ts`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/src/renderer/pages/sync-gallery/*.test.tsx`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/scripts/verify-nikkisync-link.ts`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/scripts/pre-dist-check.ts`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/scripts/__tests__/verify-nikkisync-link.test.ts`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/package.json`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/e2e/nikkisync-runtime.e2e.ts`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/e2e/nikkisync-game-root.e2e.ts`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/docs/sync-integration/README.md`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/docs/技术债清单.md`、`docs/debt-registry.json`
- `D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/CHANGELOG.md`

**只读、不修改**：`D:/Workbuddy 项目/WXNN YD - 副本/NikkiSync/**`（仅在其内跑 `npm run build` / `npm test`）、`D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe/node_modules/@nikkisync/**`。
