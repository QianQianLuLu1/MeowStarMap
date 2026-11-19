# NikkiSync PC 端对齐补齐 · 同步控制台实施计划（2026-11-19）

## 一、核对基准与范围

- 上游仓库：`github.com/ToStardust/NikkiSync`。
- 基准提交：`6bdab4b4b29b0af5103aafb2d3223e7903c6306c`（main HEAD = tag `v1.0.41-public-beta.2`，author 2026-11-15T05:24:52Z，"fix: export large JPEG photos with metadata"）。父提交链：`860ff0f7`（v1.0.41-public-beta.1）← `a49764bb`（v1.0.40-public-beta.2）。
- GitHub API 实测（2026-11-19）：main 无更新提交、无更新 tag ⇒ **本轮零上游推进**。本仓钉子 `scripts/__tests__/nikkisync-baseline-pin.test.ts` 的 `EXPECTED_HEAD`、本地克隆 `../NikkiSync`（detached HEAD 同 SHA、dist 已重建、四条 `node_modules/@nikkisync` junction 在位）三方一致；新增 `src/shared/nikkisync-version.ts` 常量与该钉子机械比对防漂移。
- diff 覆盖：`apps/pc-companion`（desktop 控制页 14 文件 / wechat / inspiration / scanner / metadata）、`packages/{core,database,protocol}`、`apps/windows-shell`（仅作设计参照与宿主适配判据，不搬本体）。
- 协议/迁移/四包入口自 `589b932` 起零漂移（`protocol-drift.test.ts` 守护）；`src/shared/sync/**`、`NIKKISYNC_REQUIRED_EXPORTS`、stage 清单 31 项、装载链 30 roots 本轮零变化。

### 差异四分类

| 分类           | 内容                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 已同步无需修改 | 运行时装配链、协议契约、18 表闭集、扫描/账号作用域/整理队列/额外目录（含 1.0.41 `selection_expired` 收预览）、配对/设备/微信画廊启停、K2 同意门、`legalDocuments` 装配（`pc-companion-services.ts` 已接线）、灵感库 entry 白名单（已含 tags/categories/status/code）                                                                                                                     |
| 零变化         | `packages/protocol`、迁移 SQL、`src/shared/sync/**`、必需导出表、stage 清单、装载链清单                                                                                                                                                                                                                                                                                                  |
| 必须补齐       | ①前端五视图信息架构+板块底栏；②connect 统计卡/首次内联 QR/首次引导/selfCheck 自查卡；③灵感库搜索/分类/状态筛选/刷新+字段编辑；④网络权限授权/撤销/检查/修复/撤销修复（原 `network-repair` 恒 unavailable）；⑤热点真实实现（原 `Set-HotspotEnabled` 为不存在 cmdlet）+独立结束+系统设置入口；⑥legal 三链接渲染层入口；⑦底栏版本/重启同步服务/导出诊断包；⑧OS 开机自启开关绑定；⑨about 视图 |
| 明确不搬       | 见第六节                                                                                                                                                                                                                                                                                                                                                                                 |

## 二、总体架构决策

1. `sync-service` 视图改造为「同步控制台」：板块内左侧子导航（connect 手机连接 / settings 同步设置 / organizer 最近删除 / inspiration 灵感库 / about 关于，对齐上游 `DesktopPage.ts` 五视图）+ 板块底部状态栏（对齐壳 `NativeRecoveryPanel`）。**不新增 ViewLevel**：`App.tsx` 的 ALL_VIEWS/VIEW_LEVEL_MAP/keep-alive/viewStack 全不动；子视图用组件 state + `localStorage('syncConsole.view')` 持久化。
2. 一级页 `SyncGalleryPage`（网格+检索面板+抽屉，宿主超出上游的功能）保留为板块首页；connect 子视图承接上游「资产总览/连接」职责，二者经工具栏互通。
3. 视觉走宿主 CSS 变量与公共组件；子导航复用 Sidebar 的 glass/`--space-nav-*` 语汇；板块内滚动条按主题变量定制。
4. 6 个 opt-in 外壳能力默认 false 保持（2026-11-13 用户裁决）；本轮把「开了之后真的能用」补齐，关闭时 UI 如实呈现未启用态。
5. 上游控制页兜底保留：`desktop-open` 外部浏览器入口不删。

## 三、依赖声明

- **零新增 npm 依赖**。netsh/PowerShell 为 Windows 内置；`safeStorage`（Electron 内置，Windows 后端即 DPAPI）；`qrcode` 已在仓。
- 上游 junction 由既有 `npm run link:nikkisync` 维护（`npm install` 会剪掉 junction，装完依赖须重跑）。
- 新增共享契约：`src/shared/types/electron-api.ts` 增 6 组 DTO；`src/shared/nikkisync-version.ts` 基准常量；`src/renderer/vite-env.d.ts` 增 6 个方法声明。

## 四、启动说明与验证操作

```bash
npm run link:nikkisync:check   # 确认四条 junction 在位
npm run verify:nikkisync       # 装载面只读诊断
npm run dev                    # 链接态开发启动
```

验证操作步骤：同步图库 → 工具栏「同步服务」进入控制台 → 五视图逐一切换 → connect 统计卡 2s 刷新 / 首次内联 QR / 微信折叠 → settings 自启开关 / legal 三链接 / 网络权限五按钮 / 热点三按钮 → organizer 角标与批量批准 → inspiration 搜索/分类/状态/刷新/新建编辑 → 底栏版本双显 / 重启同步服务 / 导出诊断包。

## 五、子任务清单（依赖序，每个红→绿闭环）

### T0 计划落仓 + 共享契约（本文件 + 契约类型 + 版本常量）

- 文件：本文件、`src/shared/types/electron-api.ts`、`src/shared/nikkisync-version.ts`（+`.test.ts`）、`src/renderer/vite-env.d.ts`。
- 验收：`nikkisync-version.test.ts` 绿（与钉子 EXPECTED_HEAD 逐字一致）；`npm run docs:links` 无死引用。

### T1 控制台骨架拆分（纯重构，行为不变）

- 新增 `src/renderer/pages/sync-gallery/console/`：`SyncConsoleLayout.tsx`、`ConnectView.tsx`、`SettingsView.tsx`、`OrganizerView.tsx`、`InspirationView.tsx`、`AboutView.tsx`、`SyncStatusBar.tsx`、`useSyncOverview.ts`。
- 节迁移：service 状态卡/诊断折叠+pairing+devices+微信卡→Connect；photoDirectories+extraDirectories+syncAccounts+K2 同意块+shell opt-in 开关→Settings；organizer K8→Organizer；SyncInspirationPanel 复用→Inspiration。`SyncServicePage.tsx` 收缩为装配壳（导出名/lazy 路径不变）。
- 测试：`SyncServicePage.test.tsx` 断言逐节随迁（禁重写判据）；新增 `SyncConsoleLayout.test.tsx`。
- i18n：新 `syncConsole.nav.*` 等；旧 `syncService.*` 键全保留。
- 验收：`npx vitest run src/renderer/pages/sync-gallery` 全绿；`selection_expired` 收预览等钉住行为零丢失。

### T2 `nikkisync:library-overview`

- 文件：`pc-companion-services.ts`（暴露 `libraryOverview()`，调已实例化上游 `DesktopStatusService.getStatus()`）、`runtime-types.ts`、`nikkisync-handler.ts`、`preload/api/nikkisync.ts`、`docs/IPC_CONTRACT.md`。
- 形状：无参 → `{available:boolean, assets?:number, pairedDevices?:number, firstRun?:boolean}`；PC 服务缺席 ⇒ `available:false` 不抛。零新 SQL。
- 受保护路径置 `// @core-change:`。测试：透传/缺席两例（假 surface）。
- 验收：`npx vitest run src/main/nikkisync` 绿；契约文档含新通道。

### T3 Connect 视图补齐

- 统计卡（`useSyncOverview` 仅 connect 可见时 2s 轮询，切走清 timer）；`firstRun` 内联 QR（抽 `usePairingQr` hook 与对话框共用）；Android 卡（生成新二维码/APK 直链/连接失败导出诊断包=`log:exportZip`）；微信卡（折叠 key 逐字 `momo.wechat-entry.seen.v1`）；首次引导 `<details>`；`SelfCheckCard.tsx`（掉线自动展开）。
- i18n `syncConsole.connect.*`（12 语包）。测试：轮询启停（`vi.getTimerCount()===0`）、firstRun 内联 QR、掉线展开、微信折叠持久化。

### T4 Settings 静态项 + 自启 + legal

- 两条纯静态说明行（相册更新/关闭窗口后，上游即静态行）；自启开关绑定既有 `launchAtLogin`（零主进程改动）；legal 三链接 = `desktopOpen().url + '/legal/privacy|terms|services'` 经 `shell:openExternal`（`schemas.httpUrl` 已放行 http://127.0.0.1），PC 服务缺席禁用+Tooltip。
- 测试：开关读写走 settings 通道、说明行静态、legal URL 拼接与禁用态。

### T5 网络权限主进程真实实现

- 新 `src/main/app/shell/network-authorization.ts`：规则组名逐字 `"MomoCamera LAN Authorization v1"`；authorize/revoke/status 经 netsh（TCP、localport=syncStatus().port、remoteip=localsubnet、profile=private,public，绝不动域网络）；输出纯函数解析；非管理员经 `powershell Start-Process netsh -Verb RunAs` 自提权，拒绝 ⇒ `elevation-declined` 不抛。
- 扩 `network-conflict-repair.ts`：`parseNetshRules()` 枚举解析；journal 落 `{userData}/nikkisync/network-repair-journal.json`（safeStorage 加密，不可用明文降级+warn）；Restore 读 journal 还原清档。
- 通道：`nikkisync:network-auth` `{action:'authorize'|'revoke'|'status'}`、`nikkisync:network-conflict` `{action:'inspect'|'repair'|'restore'}`；旧 `network-repair` 保留为 repair 别名。同受 `nikkisync.shellNetworkRepairEnabled` opt-in 门（默认 false，关闭零子进程）。
- 测试（先红后绿）：netsh 解析（正常/空/畸形/多规则）、journal 闭环、opt-in 零 execFile、提权拒绝、命令串快照。真机 netsh 属 not-run（需管理员），execFile 桩替代。

### T6 热点真实实现

- 重写 `temporary-hotspot.ts` 副作用层（保留 `nextHotspotState` 纯函数）：PowerShell WinRT `NetworkOperatorTetheringManager` + StartTetheringAsync（AsTask 等待），回读 SSID/Passphrase/状态；`startedHere` 持久化 `{userData}/nikkisync/hotspot-state.json`，stop 仅关自己开的。
- 通道：`nikkisync:hotspot-control` `{action:'start'|'stop'|'status'}`；旧 `hotspot-toggle` 保留映射；`nikkisync:open-hotspot-settings` 无参固定常量 `ms-settings:network-mobilehotspot`（不放宽 shell:openExternal 白名单）。
- 测试：状态持久化、stop 不关外来热点、脚本串快照、disabled 零子进程。真机热点 not-run（需无线网卡）。

### T7 Settings 网络/热点 UI

- 网络权限卡 5 按钮（inspect 冲突列表、restore 无 canRestore 禁用）；热点卡 3 按钮 + SSID/密码（掩码可点开）；opt-in 关闭整卡「未启用」+跳转开关。
- i18n `syncConsole.settings.network.*`/`.hotspot.*`。测试：按钮→action 映射、disabled 态、restore 禁用判据。

### T8 灵感库过滤/刷新（纯前端，判据对齐上游 InspirationPanel.ts）

- 新 `inspiration-filter.ts`：`filterEntries`（q 对 title/notes/code.rawCode/tags/categories 小写 includes；category 精确；status 五值 self/want/reproduced/tried/archived；恒滤 deletedAt）；`insCandidates()`（1 开头 11 位字母数字，容忍 #）。
- `SyncInspirationPanel.tsx`：拉全量（limit=100+after 循环）、过滤条、刷新按钮、15s 节流自动刷新（编辑器打开跳过）。
- 测试：过滤判据逐条 + fake timers 节流。

### T9 灵感库编辑器字段

- Draft 增 tags/categories/status/code.rawCode（type/parsedState/snapshotJson 不伪造保留 base）；列表卡 status 徽章+tags chips+分享码片段。走既有 `inspiration-save`。
- i18n `syncGallery.inspiration.*` 增量。测试：保存含新字段、409 后 base 保留、回显一致。

### T10 Organizer 视图 + 角标

- 待批数角标 5s 轮询（仅控制台挂载）、批量失败聚合、「打开最近删除」入口。测试：角标 3→批准→0、卸载清 timer。

### T11 底栏 + About

- `SyncStatusBar`：版本双显（`app:getVersion` + `NIKKISYNC_ALIGNED_VERSION`）；重启 → `nikkisync:restart-server`（manager `restartSyncService()` 复刻 applyGameRoot 重建语义：wasServing→teardown→重建→onSessionStarted 重装配→wasServing 则 startSyncServer，失败归一不上抛）；导出诊断包复用 `log:exportZip`。
- `AboutView`：版本卡/下载四外链（逐字搬上游 URL+注释锚定）/检查更新接宿主 electron-updater/诊断与反馈/6 仓库外链+解码署名。
- 测试：restart 状态机两分支/teardown 失败不外抛/重装配回调；底栏版本双显；About 外链快照。

### T12 Mock/预览/收口

- `nikkisync-mock.ts` 增 6 方法（形状与真实 handler 一致）；灵感种子补五状态/分享码多样性；`npm run preview:check` 过闸；全量收口验证。

## 六、明确不搬清单

| 项                                                       | 原因                                                       |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| Windows Shell WPF 本体 / NativeRecoveryPanel XAML        | Electron 宿主以 React 等价复刻语义                         |
| Android APK / 微信小程序本体                             | 只搬直链与入口图，构建物不在本仓                           |
| 签名图标增量/程序差分 feed、CNB 工单凭据、支持网关服务端 | 私钥/凭据不在本仓，通道维持 unavailable（2026-11-13 裁决） |
| 上游 about「一键更新」EXE 自替换                         | 宿主 electron-updater 成熟链路                             |
| 上游托盘/OS 自启注册表直写                               | 宿主 tray-service.ts/login-item.ts 已有，只做绑定          |
| 6 个 opt-in 默认值翻转                                   | 用户裁决保持 false                                         |
| 移动端/小程序/非 PC 端专属功能                           | 任务边界排除                                               |
| 移植面 `src/main/sync/`                                  | 默认静默轨道，不动                                         |
| WeGameApps 候选等非本轮 diff                             | 最小改动                                                   |

## 七、错误处理与参数校验

- 所有新通道走 `wrapHandler` + AppError 家族；opt-in 关闭 ⇒ `{status:'disabled'}` 零子进程；能力缺席 ⇒ `available:false`/`unavailable` 如实呈现不伪成功；UAC 拒绝 ⇒ `elevation-declined`；子进程失败 ⇒ `failed` + 脱敏 reason（不含完整路径/密钥）；journal/hotspot 状态文件读写容错不抛。
- 新通道 action 用 zod 枚举；端口取自主进程 syncStatus 不由渲染层传入；open-hotspot-settings 无参固定常量；灵感库 tags/categories 元素 trim+长度上限；渲染层一律 try/catch + IpcError 分支 + useErrorToast。

## 八、基础测试用例（正常/异常/边界）

- 正常：library-overview 透传计数；network-auth authorize 后 status=present；conflict inspect→repair→restore 闭环；hotspot start 回 SSID/密码、stop 仅关自开；restart 后 wasServing 复原；灵感过滤五状态命中；控制台五视图切换与持久化。
- 异常：PC 服务缺席 available:false；opt-in 关闭 disabled 零子进程；UAC 拒绝 elevation-declined；netsh 畸形输出解析不抛；journal 损坏容错；409 冲突 base 保留；重启 teardown 失败不外抛。
- 边界：netsh 空规则集；分享码 10/12 位/非 1 开头拒绝；tags 空串 trim；轮询切走清零；restore 无 journal ⇒ nothing-to-restore；hotspot 外来热点 stop ⇒ unchanged。

## 九、验证矩阵

| 节点       | 命令                                                                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 每节点     | `npm run verify`（只读）                                                                                                                                                                       |
| UI 节点    | `npx vitest run src/renderer/pages/sync-gallery src/renderer/components/sync`                                                                                                                  |
| 主进程节点 | `npx vitest run src/main/nikkisync src/main/app/shell`                                                                                                                                         |
| i18n 每批  | `npm run sync-i18n-keys` → 补译 → `npm run i18n:guard` + `npm run i18n:check`                                                                                                                  |
| 全量收口   | `npm run lint && npm run typecheck && npm run typecheck:e2e && npm test && npm run i18n:guard && npm run e2e:smoke && npm run preview:check && npm run verify:nikkisync && npm run docs:links` |

预计 not-run（如实标记）：真机 netsh 授权/修复（需管理员+UAC）、真实热点启停（需无线网卡）、真机 LAN 手机配对首跑（需真机）——替代：execFile 桩断言命令串逐字、纯解析器喂真实 netsh 样例、链接态集成测试（junction 在位全跑；未建链 skip 不计为通过）。

## 十、风险与对策

1. 1575 行测试迁移逐节搬断言，禁重写；1.0.41 钉住行为原样保留。
2. i18n 旧键只增不改名；新键两批，守卫测试同批更新，12 语包补译。
3. 核心路径闸门：handler/preload 每文件前 5 行 `// @core-change:` 真实中文原因，每轮替换。
4. 轮询泄漏：connect 2s/organizer 5s/inspiration 15s 绑定可见性，fake timers 断言清零。
5. 预览 mock 与 UI 同批交付，unavailable/disabled 形状与真实 handler 一致。
6. 外链逐字搬上游常量+注释锚定，打开失败 Toast 兜底。
7. Conventional Commits；每节点 verify 通过后提交，提交后 `git status --porcelain` 复核。
