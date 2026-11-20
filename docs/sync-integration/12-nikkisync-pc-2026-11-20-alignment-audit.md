# 2026-11-20「同步图库」NikkiSync PC 端上游对齐审计

> 生成时间：2026-11-20 17:20（+08:00）
> 基准：`ToStardust/NikkiSync@6bdab4b4b29b0af5103aafb2d3223e7903c6306c`（tag `v1.0.41-public-beta.2`）
> 本仓：`D:\项目\软件\MeowStarMap\MeowStarMap`，HEAD `8e02afc4c1c7707669f6891c8587401db4201047`（main，工作树干净）
> 上游只读克隆：`D:\项目\软件\MeowStarMap\NikkiSync`（同 SHA，detached tag）

## 1. 核对范围

| 项               | 值                                                                            |
| ---------------- | ----------------------------------------------------------------------------- |
| `main` 远端 HEAD | `6bdab4b4b29b0af5103aafb2d3223e7903c6306c`（`git ls-remote` 2026-11-20 复核） |
| 关联 tag         | `v1.0.41-public-beta.2`（同一 SHA）                                           |
| 提交时间         | 2026-11-15 13:24:52 +0800                                                     |
| 父提交           | `860ff0f7ed06cecab42a6fe4f8a46b0e3f9472c1`                                    |
| 上一核对锚点     | `a49764bbf98fcb26a84f2356b78d48c459d3da2e`（v1.0.40-public-beta.2）           |
| 区间差异         | 12 files, +106/−16                                                            |
| 本仓版本钉       | `1.0.41-beta.2`                                                               |

区间文件（`git diff --name-status a49764b..6bdab4b`）：

| 状态 | 文件                                                         | PC 同步图库相关性                                |
| ---- | ------------------------------------------------------------ | ------------------------------------------------ |
| M    | `apps/pc-companion/src/desktop/ExtraScanDirectoriesPanel.ts` | 额外扫描目录：`selection_expired` 后收起提案预览 |
| M    | `apps/pc-companion/src/game-directory-discovery.ts`          | 安装目录发现（APP/NIKKI 变体）                   |
| M    | `apps/pc-companion/src/scanner/ExtraScanDirectories.ts`      | 目录提案过期语义                                 |
| M    | `apps/pc-companion/src/server/LocalSyncServer.ts`            | 本机服务/大 JPEG 导出边界                        |
| M    | `apps/pc-companion/src/wechat/GalleryRuntime.d.mts`          | 微信画廊运行时类型                               |
| M    | `apps/pc-companion/test/desktop-page.test.ts`                | 控制页契约                                       |
| M    | `apps/pc-companion/test/extra-scan-directories.test.ts`      | 目录过期契约                                     |
| M    | `apps/pc-companion/test/game-directory-discovery.test.ts`    | 目录发现契约                                     |
| M    | `apps/pc-companion/test/local-sync-server.test.ts`           | 导出边界契约                                     |
| A    | `docs/releases/v1.0.41-public-beta.1.md`                     | 发布说明（非代码）                               |
| M    | `tools/wechat-gallery/export.test.mjs`                       | 移动端画廊导出测试（不搬）                       |
| M    | `tools/wechat-gallery/photo-export.mjs`                      | 大 JPEG 保留元数据（小程序侧，不搬）             |

## 2. 上游 PC 端模块 → 本仓映射

| 上游模块（`apps/pc-companion/src/**`）                               | 本仓承接                                                                                 | 本轮结论                                                                                          |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `runtime.ts` / `index.ts` / `windows-app.ts`                         | `src/main/nikkisync/runtime-manager.ts`、`runtime-loader.ts`、`pc-companion-services.ts` | 已同步；`windows-app` 的 WPF/Bun 外壳不搬，Electron 宿主自持                                      |
| `desktop/DesktopControlServer.ts`                                    | `src/main/nikkisync/pc-companion-services.ts`                                            | 已同步；token、`X-Frame-Options: DENY`、`frame-ancestors 'none'` 保持                             |
| `desktop/DesktopStatusService.ts`                                    | `useSyncOverview.ts` + `pc-companion-services.ts`                                        | 已同步；2s 观测面、firstRun、assets/pairedDevices                                                 |
| `desktop/DesktopPage.ts` 壳层/connect/settings/about                 | `console/SyncConsoleLayout.tsx`、`ConnectView.tsx`、`SettingsView.tsx`、`AboutView.tsx`  | **宿主适配缺口**：结构/视觉与上游不一致（见 §4）                                                  |
| `desktop/DesktopPageScript.ts`                                       | ConnectView/SettingsView hooks                                                           | 已同步；轮询、二维码、开关、诊断                                                                  |
| `desktop/AccountSyncPanel.ts`                                        | `SettingsView.tsx` K9                                                                    | 已同步；账号三态、全选、样例、保存                                                                |
| `desktop/OrganizerPanel.ts`                                          | `OrganizerView.tsx`                                                                      | 已同步；11 态、批量 approve、回收站入口                                                           |
| `desktop/InspirationPanel.ts`                                        | `InspirationView.tsx` + `SyncInspirationPanel.tsx`                                       | 已同步；筛选/记录/刷新                                                                            |
| `desktop/ExtraScanDirectoriesPanel.ts`                               | `SettingsView.tsx` K6                                                                    | 已同步；`selection_expired`、预览保留语义                                                         |
| `desktop/WeChatGalleryPanel.ts`                                      | `ConnectView.tsx` `SyncPcCompanionSection`                                               | **宿主适配缺口**：被折叠、非对等 channel card、缺入口图                                           |
| `desktop/MetadataPrivacyPanel.ts`                                    | `SettingsView.tsx` K2                                                                    | 已同步；同意面仅在解析开启时出现                                                                  |
| `server/**`（LocalSyncServer/Auth/Pairing/WebSocket/row-mappers 等） | `src/main/nikkisync/sync-server*` + 上游运行时                                           | 已同步；协议/配对/资源流由 `sync-server.linked.test.ts` 钉住                                      |
| `scanner/**`                                                         | 上游运行时直接装载                                                                       | 已同步；目录发现/稳定器/分类器/协调器为上游原实现                                                 |
| `wechat/**`                                                          | `nikkisync-handler` wechat 四通道 + 上游 runtime                                         | 已同步；PC 只是入口，小程序本体不搬                                                               |
| `metadata/**`                                                        | 上游 metadata resolver + 宿主设置面                                                      | 已同步；在线同意/离线缓存/K2                                                                      |
| `organizer/**`                                                       | 上游 `DeletionQueue` + 宿主 Organizer                                                    | 已同步                                                                                            |
| `remote/**`（RemoteBridge）                                          | 无产品面                                                                                 | **明确不搬**：上游“微信下载照片”实验入口，需 `/api/remote/*` 与 remoteToken；不属于同步图库主链路 |
| `packages/database/migrations/0001_initial.sql`                      | 上游运行时库                                                                             | 已同步；12 张表 + sqlite_sequence，`protocol-drift.test.ts` 钉住                                  |
| `packages/protocol/**`                                               | `src/shared/sync/protocol*`                                                              | 已同步；协议版本、DTO、错误码                                                                     |
| `packages/core/**`                                                   | 上游原样依赖                                                                             | 已同步（零变化）                                                                                  |
| `tools/wechat-gallery/**`                                            | 不搬                                                                                     | 明确不搬（小程序页面/导出器）                                                                     |
| `desktop/AppDataDirectory.ts`、`StartupFailure.ts`                   | 宿主 `runtime-manager` 等价实现                                                          | 已同步；路径/启动失败语义                                                                         |
| `WindowsInstallationHints.ts` / `windows-app.ts`                     | Electron 宿主外壳                                                                        | 明确不搬（第二套 WPF/Bun 外壳）                                                                   |

## 3. 分类汇总

| 分类                   | 数量 | 条目                                                                                                                        |
| ---------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------- |
| 必须补齐               | 3    | D1 控制台壳层；D2 页头/状态 chip；D4 微信入口对等卡                                                                         |
| 需要本仓宿主适配后搭载 | 5    | D3 Connect IA；D5 底栏；D6 Settings 节奏；D7 卡片视觉；D8 三视图卡片                                                        |
| 已同步无需修改         | 18   | 运行时、服务、协议、DB、扫描、账号、目录、整理、灵感、元数据、微信通道、资源装载、版本钉、诊断、配对、i18n 既有键、测试基线 |
| 零变化                 | 2    | 基准相对上一锚点无新增 PC 后端行为（12 文件已在上一轮落地）；其余 93 个上游 PC 源文件未被本轮基准触碰                       |
| 明确不搬               | 5    | 移动端 App、微信小程序本体、Windows Shell/WPF、RemoteBridge、Bun 单文件 EXE 打包链                                          |

> 说明：D1/D2/D4 标“必须补齐”是因为上游有明确 DOM/交互契约而本仓完全没有对应结构；D3/D5/D6/D7/D8 属于“上游有、本仓形态不同”，按宿主 React 适配。

## 4. 前端结构性差异（证据）

| #   | 本仓现状                                                                                                 | 上游基准                                                                                    | 影响                               |
| --- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------- |
| D1  | `SyncConsoleLayout.tsx:125-159`：`PageHeader` + 160px 文字 nav，无品牌/页脚/图标                         | `DesktopPage.ts:21,73-76`：188px `.sidebar` + `.brand` + 图标 nav + `.sidebar-footer`       | 首屏观感与上游不一致，截图核对失败 |
| D2  | `SyncConsoleLayout.tsx:127` 固定 `syncService.page.title`；各 View 再渲染 h3（如 `ConnectView.tsx:267`） | `DesktopPage.ts:77`：`#desktop-title` 随视图切换，右上 `.chip`                              | 标题层级重复，无全局服务状态提示   |
| D3  | `ConnectView.tsx:264-686`：纵向 8 个 SectionShell，资产卡/首跑/服务/配对/设备/Android/微信/引导/自查顺序 | `DesktopPage.ts:78-82`：资产卡 → 双通道网格 → 引导 → 自查 → 隐私脚注                        | 信息架构倒置，首屏不是“连接手机”   |
| D4  | `ConnectView.tsx:585-602` 微信是 `<details>` 折叠块；`SyncPcCompanionSection` 只有按钮/状态/二维码       | `WeChatGalleryPanel.ts`：与 Android 对等 `.connection-card`，含 tag/三步/入口码/入门图      | 微信入口不可见、缺产品化说明       |
| D5  | `SyncStatusBar.tsx:62-92` 圆角小卡，无恢复提示                                                           | 截图底栏：全宽、双版本、右侧两操作                                                          | 底栏层级弱，服务恢复入口不显著     |
| D6  | `SettingsView.tsx` 以 `SectionShell` 纵向堆叠；账号独立大节、元数据夹在连接节                            | `DesktopPage.ts:84-89`：settings-card 节奏（连接含账号 → 启动 → 网络 → 目录 → 热点 → 解析） | 页面节奏与上游不一致               |
| D7  | `settings/shared.tsx` glass-card + bg-tertiary 子卡                                                      | `DesktopPage.ts:19,23-26`：#FFFCF7 surface、23px 圆角、settings-card 分隔行                 | 卡片密度/层级不同                  |
| D8  | Organizer/Inspiration/About 各自标题与卡片                                                               | `DesktopPage.ts:91-111` + 上游 panel CSS                                                    | 三视图页头重复、卡片语言不统一     |

## 5. 后端/协议/DB 核验

- 协议：`src/main/nikkisync/protocol-contract.test.ts`、`protocol-drift.test.ts` 在基线绿；基线区间无 `packages/protocol` 变更。
- 数据库：上游 `0001_initial.sql` 未变；宿主由上游运行时建库，`pc-companion-services.test.ts` 覆盖 overview/restart。
- 服务：`sync-server.linked.test.ts` 覆盖真实 LAN server start/stop、配对、鉴权；无基线差异。
- 资源：`resources/nikkisync/pc` 含 `momo-camera.png`、`wechat-mini-entry.png`、wechat/clothing-icons 等；`verify:nikkisync` 负责字节与 pin 校验。
- 结论：**本轮无 backend “必须补齐”项**；不进行任何后端重写。

## 6. 明确不处理项与原因

1. **移动端 App / 微信小程序正文**：上游 `tools/wechat-gallery/photo-export.mjs` 的 JPEG 元数据修复属于小程序运行时，宿主只承接协议与入口，不复制页面。
2. **Windows Shell**：WPF、签名源、EXE 自更新、托盘注册是第二套外壳；本仓已有 Electron 托盘/更新链，重复接入会形成双写。
3. **RemoteBridge `/api/remote/*`**：上游实验性“微信下载照片”通道，依赖 remoteToken 与独立 session store；不在同步图库主链路，宿主未开产品面。
4. **Bun 单文件 EXE**：与 Electron 打包链冲突，明确不搬。
5. **上游 `windows-app.ts` 的默认 28080 端口/托盘菜单**：宿主有自己的端口与托盘策略，只复用运行时 API。

## 7. 审计结论

- 基准未推进：`main == tag == 6bdab4b`，无新增 PC 端提交。
- 后端全量已同步，无需改代码。
- 本轮实际工作集中在 8 项前端宿主适配：壳层、页头/chip/底栏、Connect IA、微信入口、Settings 节奏、卡片视觉、三视图、资源/文案。
- 下一节点 N2 起按上游 `DesktopPage.ts` 的 CSS/DOM 逐块落地；每项有对应单测红灯与绿灯记录。

## 8. 已完成修改（N2–N7 回填）

- **壳层/设计系统**：新增 `sync-console.css`（全部选择器限定 `.sync-console`）、`console-ui.tsx`、`ConsoleIcons.tsx`（移植上游 12 个 SVG path）、`brand-assets.ts`（导入 `resources/nikkisync/pc/momo-camera.png`、`wechat-mini-entry.png`）。
- **页头/导航/底栏**：188px 品牌侧栏 + 五入口图标 nav + 页脚双行；页面级 h2 随视图切换；右上 `sc-chip` 三态（ready/offline/unavailable）；`sc-status-bar` 全宽双版本 + 恢复提示 + 重启/导出。
- **Connect IA**：按上游重排为资产总览（大数字 + 设备数）→「连接到手机」标题 + 同 Wi-Fi 提示 → Android/微信双通道卡 → 首次引导 → 连接自查 → 隐私脚注 → 宿主增强区（服务开关/配对/设备管理）。Android 卡改为 `connection-card`，含 tag、三步、首配二维码、配对提示、新二维码、APK/导出。微信卡与 Android 对等，含入口码 details（`momo.wechat-entry.seen.v1`）、三步、启停、连接码、入口图、打开控制页。
- **Settings 节奏**：全部 `SectionShell` → `ConsoleSection`（h2 标题），`SettingsCard/SettingsRow` → `sc-service-rows/ConsoleRow`；账号同步作用域并入「同步与连接」卡；网络权限/热点前移到照片目录之前；保留上游静态行（相册更新/关闭窗口后/地址）。
- **三视图**：Organizer 改 `ConsoleSection` + 统一行；About 改 `ConsoleSection` + 统一行；Inspiration 面板新增 `embedded`，控制台内嵌时隐藏折叠摘要、默认展开并挂载即拉首屏，独立页保持折叠。
- **i18n**：`sync-console-keys.test.ts` 等集白名单补齐 23 个新叶子；12 个 locale 全部补齐并本地化；`i18n:check` 通过。
- **测试**：新增设计契约 `sync-console-design.test.ts`、Layout chip 三态与品牌/图标断言；更新 Connect 微信入口码 helper、SyncServicePage 页头 h2 断言。

## 9. 验证结果（本轮）

| 命令                                                     | 结果                                        |
| -------------------------------------------------------- | ------------------------------------------- |
| `npx vitest run src/renderer/pages/sync-gallery/console` | 9 files / 163 tests passed                  |
| `npm test`                                               | 544 files / 8878 passed, 20 skipped         |
| `npm run typecheck`                                      | passed                                      |
| `npm run lint`                                           | passed                                      |
| `npm run build`                                          | passed（electron-vite 三端产物生成）        |
| `npm run i18n:check`                                     | 12 locale、4567 keys 对齐                   |
| `npm run i18n:guard`                                     | passed                                      |
| `npm run verify:nikkisync`                               | 0 blocking failures                         |
| `npm run link:nikkisync:check`                           | 四链接均 ok                                 |
| `npm run docs:links`                                     | 无死引用（200 处历史提醒）                  |
| `npm run e2e:smoke`                                      | **not-run**（未启动打包/Electron 实机会话） |

## 10. 审计后残余

- 未做 Electron 实机截图比对：本轮以源码/CSS/DOM 契约与截图事实对齐，视觉像素级核对仍待启动应用后人工确认。
- 微信通道能力位：宿主 `NikkiSyncServerStatusInfo` 无 `wechat` 能力位，控制台按“存在入口即展示”处理；未装载构建的操作会以不可用提示收敛，不伪造连接。
- 12 语言新增文案为本次按上游语义本地化，建议母语者复核用语。
