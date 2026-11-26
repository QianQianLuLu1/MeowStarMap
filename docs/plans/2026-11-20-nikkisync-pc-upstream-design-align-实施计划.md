# MeowStarMap「同步图库」NikkiSync PC 上游对齐与功能补齐实施计划

> 状态：待确认。确认后第一件事是把本文件落库到
> `D:\项目\软件\MeowStarMap\MeowStarMap\docs\plans\2026-11-20-nikkisync-pc-upstream-design-align-实施计划.md`，
> 再进入开发；未落库、未确认前不改任何业务代码。

## 0. 结论先行

1. **上游基准未推进**：截至 2026-11-20，NikkiSync `main` HEAD 仍为
   `6bdab4b4b29b0af5103aafb2d3223e7903c6306c`，与发布 tag
   `v1.0.41-public-beta.2` 指向同一提交；本仓 `NIKKISYNC_ALIGNED_VERSION` 已是该版本。
   因此本轮不存在“新提交需要追”的 backend 增量。
2. **真正的缺口在前端产品化对齐**：当前 `同步图库 → 同步服务` 的 React 控制台是“宿主设置页”外观
   （`PageHeader` + 白色列表卡 + 文字子导航），而上游 PC 控制页 `DesktopPage.ts` 是
   “188px 品牌子导航 + 页面标题/状态 chip + 大圆角卡片网格 + 全宽底栏”的结构。
   用户提供的 7 张截图正是后者。两边的页面结构、卡片节奏、连接页信息架构、空/加载/错误态呈现均不一致。
3. **不能直接 iframe 复用上游 HTML**：上游 `DesktopControlServer` 明确发送
   `X-Frame-Options: DENY` 与 `Content-Security-Policy: frame-ancestors 'none'`，页面还依赖
   `X-NikkiSync-Desktop-Token`。因此宿主必须保留 React 适配层，按上游 `DesktopPage.ts` 的
   CSS/HTML 结构重做展示层，**后端、协议、数据库、资源装载全部复用现有实现，不重复造轮子**。
4. 本轮的实施主体是：**全量差异审计 + 前端设计语言/交互结构对齐 + 微信入口补齐 + 验证闭环**；
   若审计发现真实 backend 缺口，才进入对应最小修复，不预先假设缺口存在。

## 1. 唯一核对基准

| 项                    | 值                                                                                                           | 证据                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| 上游仓库              | `ToStardust/NikkiSync`（默认分支 `main`）                                                                    | GitHub refs API / 本地克隆                                              |
| 基准提交（main HEAD） | `6bdab4b4b29b0af5103aafb2d3223e7903c6306c`                                                                   | `GET /repos/ToStardust/NikkiSync/git/ref/heads/main`（2026-11-20 复核） |
| 关联 tag              | `v1.0.41-public-beta.2`（与 HEAD 同一 SHA）                                                                  | 本地 `NikkiSync/.git/packed-refs`                                       |
| 提交日期              | 2026-11-15（+08:00）                                                                                         | 上游 tag 提交时间                                                       |
| 父提交                | `860ff0f`                                                                                                    | 上游提交元数据                                                          |
| 上一核对锚点          | `a49764b`                                                                                                    | 本仓 `docs/plans/2026-11-18-nikkisync-1.0.41-beta2-对齐-实施计划.md`    |
| 上游净差异            | 12 个文件、约 +106/−16；覆盖桌面控制页、微信画廊、额外目录、账号节、整理队列、灵感库、服务端扫描、迁移与回填 | 同上计划 + 本轮逐文件复核                                               |
| 本仓版本钉            | `NIKKISYNC_ALIGNED_VERSION = 1.0.41-beta.2`                                                                  | `src/shared/nikkisync-version.ts`                                       |

**基线门禁**：执行第一步运行 `git ls-remote https://github.com/ToStardust/NikkiSync.git refs/heads/main`
与 `git -C D:\项目\软件\NikkiSync rev-parse HEAD`。若 main 已前进：

- 停止 UI 开发，先产出新提交的 PC 端 diff 清单与四类分类；
- 同步更新版本钉、`scripts/__tests__/nikkisync-baseline-pin.test.ts` 与协议漂移测试；
- 先跑红→绿，再回到本计划其余节点。

## 2. 严格范围

### 2.1 处理范围

- 上游：`apps/pc-companion`（runtime、desktop、server、wechat、assets）、`packages/database`、`packages/core`、`packages/protocol` 中与 PC 同步图库直接相关的实现。
- 本仓：`src/main/nikkisync/**`、`src/main/ipc/handlers/nikkisync-handler.ts`、`src/preload/**`、`src/shared/**`（仅 NikkiSync 契约）、`src/renderer/pages/sync-gallery/**`、`src/renderer/i18n/locales/*`、`resources/nikkisync/**`。
- 文档：`docs/plans/**`、`docs/sync-integration/**`。

### 2.2 明确排除

- 移动端 App / 微信小程序源码本体（只保留其协议与 PC 侧入口）。
- Windows Shell（WPF、签名源、EXE 自更新、托盘注册）——本仓已有 Electron 宿主外壳，不再引入第二套外壳。
- 非 PC 端专属能力、上游实验性 RemoteBridge（`/api/remote/*`，微信“下载照片”测试入口）——本仓未开该产品面，且不属于“同步图库”主链路；本轮仅在报告中标注。
- 任何全局 UI 重构、无关格式化、无关依赖升级。

## 3. 差异扫描与分类方法

### 3.1 逐文件映射

以基准提交的 tree 为唯一真相源，逐项落到本仓：

| 上游模块                                                                                                   | 本仓对应                                                   | 本轮核对重点                           |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------- |
| `apps/pc-companion/src/runtime.ts`、`windows-app.ts`                                                       | `src/main/nikkisync/runtime-*`、`pc-companion-services.ts` | 启动阶段、服务编排、能力位、开关默认值 |
| `apps/pc-companion/src/server/**`                                                                          | `src/main/nikkisync/sync-server*`、`nikkisync-handler.ts`  | 路由、鉴权、资源流、协议字段           |
| `apps/pc-companion/src/database/**`、`packages/database/**`                                                | `src/main/nikkisync/migrations` / 上游运行时库             | 表/索引/迁移版本/回填                  |
| `packages/core/**`                                                                                         | 上游原样依赖 + 本仓适配                                    | change journal、扫描、资源 id          |
| `packages/protocol/**`                                                                                     | `src/shared/sync/protocol*`、`protocol-contract.test.ts`   | schema 版本、DTO、错误码               |
| `apps/pc-companion/src/desktop/DesktopPage.ts`                                                             | `src/renderer/pages/sync-gallery/console/**`               | 页面骨架、卡片、文案、交互态           |
| `.../DesktopPageScript.ts`、`DesktopStatusService.ts`                                                      | 现有 hooks/IPC                                             | 2s 状态、资产总览、首跑、二维码        |
| `.../WeChatGalleryPanel.ts`、`.../AccountSyncPanel.ts`、`.../OrganizerPanel.ts`、`.../InspirationPanel.ts` | Connect / Settings / Organizer / Inspiration               | 入口、状态、空态、错误态               |
| `.../DesktopPage.ts` 内嵌品牌资源                                                                          | `resources/nikkisync/pc/**`                                | 品牌图、小程序入口图、二维码渲染       |

### 3.2 四类分类（最终报告必须逐项带代码位置）

1. **必须补齐**：上游有、本仓完全没有，或本仓实现与基准语义/结构不一致。
2. **已同步无需修改**：本仓已按基准实现，且测试/契约已钉住。
3. **零变化**：基准相对上一锚点无改动，或仅上游内部重构、无对外行为变化。
4. **明确不搬**：移动端、小程序、Windows Shell、RemoteBridge 等，需写明原因与依赖边界。
5. **需要本仓宿主适配后搭载**：上游有源码/行为，但形态是独立 HTML/WPF/浏览器页，必须改写成宿主 React/Electron 形态；本轮前端对齐主要落在此类。

> 说明：分类不是“是否写代码”的标签，而是“差异性质”。本轮要求所有“必须补齐”和“需要宿主适配”项都要落地；后者同样按上游源码逐块适配，不得自创。

### 3.3 已识别的结构性差异（初步，待 N1 以行号证据钉死）

| #   | 差异                                                                                                                                                            | 证据                                                                                         | 初步分类             | 处理                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------- |
| D1  | 控制台没有 188px 品牌子导航、品牌图、侧栏页脚；导航只有文字，无图标/激活态                                                                                      | `SyncConsoleLayout.tsx` vs `DesktopPage.ts` 的 `sidebar/brand/nav-link`                      | 必须补齐（宿主适配） | 新建 scoped CSS + 图标 + 品牌块                   |
| D2  | 页头固定“同步服务”，各视图再各自渲染 h3；上游是“当前视图 h1 + 副标题 + 状态 chip”，一页一个标题                                                                 | `SyncConsoleLayout.tsx` + 各 View 顶部 h3 vs `DesktopPage.ts` `page-head/title-chip`         | 必须补齐（宿主适配） | 标题随视图切换，移除重复 h3；chip 接状态          |
| D3  | Connect 页是纵向设置卡列表；上游是“资产大数字卡 → 双通道卡网格（Android/微信）→ 首跑二维码 → 首次使用引导 → 连接自查 → 隐私脚注”                                | `ConnectView.tsx` return vs `DesktopPage.ts` connect 区                                      | 必须补齐             | 重排 JSX，保留全部 handler/testid                 |
| D4  | 微信入口被折叠为“PC 端”details，且没有上游的“微信小程序”入口图/入门三步/对等卡片                                                                                | `ConnectView.tsx` 795-855 vs `WeChatGalleryPanel.ts`                                         | 必须补齐             | 作为第二张 channel card，保留启停/二维码/状态通道 |
| D5  | 底栏是内嵌小卡，缺少“电脑端版本 + 构建/对齐版本 + 服务恢复提示”的全宽固定底栏观感                                                                               | `SyncStatusBar.tsx` vs 截图底栏                                                              | 需要宿主适配         | 全宽底栏 + 双版本 + 提示                          |
| D6  | Settings 是宿主 `SectionShell` 节奏，账号同步独立大节、元数据解析夹在连接里；上游是“同步与连接（含账号折叠）→ 启动偏好 → 网络权限 → 额外目录 → 热点 → 在线解析” | `SettingsView.tsx` vs `DesktopPage.ts` settings 区                                           | 需要宿主适配         | 外层换 ConsoleSection，账号并入连接卡，顺序对齐   |
| D7  | 卡片是玻璃白卡/小标题；上游是 #FFFCF7 实底、23px 圆角、顶部标题、分隔行                                                                                         | `settings/shared.tsx` + 主题 CSS vs `DesktopPage.ts` `--surface/--card-radius/settings-card` | 需要宿主适配         | scoped CSS 覆盖，不动全局组件                     |
| D8  | Organizer / Inspiration / About 的页头与卡片节奏不一致                                                                                                          | 三个 View vs 上游横向面板                                                                    | 需要宿主适配         | 统一 ConsoleSection + 卡内行；不改业务逻辑        |
| D9  | 后端通道、DB 迁移、协议契约、资源装载、版本钉已齐                                                                                                               | `nikkisync-handler.ts`、`packages/protocol` 测试、`resources/nikkisync/pc`                   | 已同步               | 只审计，不改                                      |

## 4. 实施节点与验收

> 每个节点都遵守“先写失败测试（红灯）→ 最小实现 → 目标测试转绿 → 相关子集回归”。
> 所有文件路径为完整路径；`$REPO` 仅为阅读缩写，实际操作一律绝对路径。

### N0 基线锁定与工作区保护

- **动作**：`git status --porcelain`、`git rev-parse HEAD`、`git ls-remote`、上游 `rev-parse HEAD`、`git diff --stat`；记录未提交改动，禁止覆盖。
- **输出**：基线记录写入报告 §1；若有本地未提交改动，先按文件归属判断是否为本轮既有工作，保留。
- **验收**：HEAD/tag/父提交/日期四项齐全；main 与 tag 关系有命令输出；后续代码改动文件清单可追溯到 `git status`。
- **注意**：本轮不提交、不改 git 配置、不切分支，除非用户另行要求。

### N1 全量差异扫描与分类报告

- **新增文件**：`D:\项目\软件\MeowStarMap\MeowStarMap\docs\sync-integration\12-nikkisync-pc-2026-11-20-alignment-audit.md`
- **输入**：基准提交 tree、本仓当前工作树、既有 7 张截图、已有审计文档。
- **输出**：逐文件矩阵（上游文件 → 本仓文件 → 差异 → 证据行号 → 四类标签 → 处理方式）；必须覆盖 §2.1 全部路径，不能有“未核对”。
- **验收标准**：
  - 每一条差异都有“上游路径:行 / 本仓路径:行 / 行为影响”；
  - 四个主分类 + 宿主适配类计数闭合；
  - “明确不搬”项逐条写原因与契约边界；
  - 报告由 `docs:links` 检查无死链。
- **测试**：本节点只读，不写测试；以报告结构清单 + 人工复核为验收。若发现 backend 缺口，追加 N1.1 子节点（见下）。

### N1.1（条件触发）真实 backend 缺口修复

- **触发**：仅当 N1 发现“必须补齐”的后端差异。
- **文件**：对应 `src/main/nikkisync/**`、`src/shared/**`、`src/preload/**` 及测试；不改无关模块。
- **验收**：新增失败测试 → 修复 → 目标测试绿；协议漂移测试零新增；数据库迁移可重入。
- **若无缺口**：在报告中写明“零 backend 代码改动”，不虚增。

### N2 控制台设计系统与壳层

- **新增文件**：
  - `D:\项目\软件\MeowStarMap\MeowStarMap\src\renderer\pages\sync-gallery\console\sync-console.css`
  - `D:\项目\软件\MeowStarMap\MeowStarMap\src\renderer\pages\sync-gallery\console\ConsoleIcons.tsx`
  - `D:\项目\软件\MeowStarMap\MeowStarMap\src\renderer\pages\sync-gallery\console\console-ui.tsx`
  - `D:\项目\软件\MeowStarMap\MeowStarMap\src\renderer\pages\sync-gallery\console\brand-assets.ts`
  - `D:\项目\软件\MeowStarMap\MeowStarMap\src\renderer\pages\sync-gallery\console\sync-console-design.test.ts`
- **修改文件**：
  - `D:\项目\软件\MeowStarMap\MeowStarMap\src\renderer\pages\sync-gallery\console\SyncConsoleLayout.tsx`
  - `D:\项目\软件\MeowStarMap\MeowStarMap\src\renderer\pages\sync-gallery\console\SyncStatusBar.tsx`
- **输入**：上游 `DesktopPage.ts` 的 token/尺寸/断点；宿主主题 token；现有 i18n key。
- **输出**：
  - `.sync-console` 作用域 token（背景、surface、tint、border、radius、shadow、字号），全部映射宿主主题变量，不硬编码整页颜色；
  - `ConsoleIcon`（移植上游 12 个 SVG path，统一 24 viewBox、1.65 描边）；
  - `ConsoleSection / ConsoleCard / ConsoleRow / ConsoleBadge / ConsoleHint` 展示组件；
  - 品牌图/小程序入口图通过 Vite `?url` 导入（复用 `resources/nikkisync/pc/**`，不复制二进制）。
- **验收标准**：
  - CSS 中所有选择器都在 `.sync-console` 作用域内，无 `:root`/`body`/全局 `*` 改写；
  - 控制台根节点为 `.sync-console`，含 188px 子导航、品牌图、5 个带图标入口、侧栏页脚；
  - 页面背景有上游同款柔和渐变层次，但颜色来自宿主 token；
  - `npx vitest run src/renderer/pages/sync-gallery/console/sync-console-design.test.ts` 通过；
  - `npm run typecheck` 通过。
- **红灯用例**：
  - 设计测试先断言 CSS 文件存在、含 `.sc-page-header`、`.sc-connection-grid`、`.sc-chip[data-state='ready']`，当前 fail；
  - 布局测试先断言品牌文字与 5 个 nav 图标，当前 fail。

### N3 页头、状态 chip、导航与底栏

- **修改文件**：
  - `D:\项目\软件\MeowStarMap\MeowStarMap\src\renderer\pages\sync-gallery\console\SyncConsoleLayout.tsx`
  - `D:\项目\软件\MeowStarMap\MeowStarMap\src\renderer\pages\sync-gallery\console\SyncStatusBar.tsx`
  - `D:\项目\软件\MeowStarMap\MeowStarMap\src\renderer\pages\sync-gallery\console\console-views.ts`（仅标题/副标题映射）
  - 五个 View 的标题 h3 移除：`ConnectView.tsx`、`SettingsView.tsx`、`OrganizerView.tsx`、`InspirationView.tsx`、`AboutView.tsx`
  - 测试：`SyncConsoleLayout.test.tsx`、`SyncStatusBar.test.tsx`、`SyncServicePage.test.tsx`
- **输入/输出**：
  - 输入：`currentView`、`NIKKISYNC_ALIGNED_VERSION`、host `app.getVersion`、服务器状态快照。
  - 输出：当前视图标题/副标题（h2 + p）；右上状态 chip（ready/offline/unavailable 三态，含 `role="status"`）；底栏双版本 + “服务恢复入口始终在此，无需切换页面” + 重启/导出。
- **实现约束**：
  - 状态 chip 不做常驻 2s 全局定时器：Layout 在视图切换时取一次快照；ConnectView 可见时沿用自身 2s 轮询，并通过可选 `onServerStatusChange` 回传，chip 实时更新；
  - 切换到 About 后不得留下 Layout 定时器；现有“切走停表”回归保持；
  - 所有 nav 保留 `data-testid="sync-console-nav-*"` 与角标。
- **验收标准**：
  - 默认视图 h2 为“暖暖相册”，切换后分别为“同步设置/最近删除/灵感库/关于”；
  - 五个视图内无重复页面级 h3（业务段内 h3 允许保留）；
  - chip：running=true → “同步服务运行中”；available=false → “同步组件未就绪”；其余 → “同步服务已停止”；
  - 底栏显示宿主版本与 `1.0.41-beta.2`；点击重启/导出仍走既有 handler；
  - `npx vitest run src/renderer/pages/sync-gallery/console/SyncConsoleLayout.test.tsx src/renderer/pages/sync-gallery/console/SyncStatusBar.test.tsx src/renderer/pages/sync-gallery/SyncServicePage.test.tsx` 全绿；
  - 无未清理定时器（`vi.getTimerCount() === 0`）。

### N4 连接页上游同款重排 + 微信入口补齐

- **修改文件**：
  - `D:\项目\软件\MeowStarMap\MeowStarMap\src\renderer\pages\sync-gallery\console\ConnectView.tsx`
  - `D:\项目\软件\MeowStarMap\MeowStarMap\src\renderer\pages\sync-gallery\console\SelfCheckCard.tsx`
  - `D:\项目\软件\MeowStarMap\MeowStarMap\src\renderer\pages\sync-gallery\console\console-ui.tsx`
  - `D:\项目\软件\MeowStarMap\MeowStarMap\src\renderer\pages\sync-gallery\console\sync-console.css`
  - 测试：`ConnectView.test.tsx`
- **目标结构（按上游顺序）**：
  1. 资产总览大数字卡（素材数 / 设备数；不可用时诚实文案）；
  2. “连接到手机”双通道网格：
     - Android 卡：图标、标题、说明、三步引导、首跑内联二维码（`sync-first-run-qr`）、已配对提示、生成新二维码、APK/网盘/GitHub 发布入口、查看最近删除；
     - 微信小程序卡：图标、`开发测试` tag、三步引导、启动/停止、状态、二维码、入口图（`wechat-mini-entry.png`）、同 Wi-Fi 提示；
  3. “首次使用？”四入口（安装 App / 打开控制页 / 认识 PC 端 / 浏览文档）；
  4. 连接自查（掉线自动展开的既有逻辑保留）；
  5. 隐私脚注；
  6. 宿主增强区：“服务与设备”卡（同步服务开关/地址/启动阶段/诊断 + 配对新设备 + 已配对设备），保留既有 h3 与 testid。
- **输入/输出**：
  - 输入：`status`、`devices`、`overview`、`wechatStatus`、`qrSvg`、i18n。
  - 输出：上述 DOM；所有既有 testid（`sync-console-stats`、`sync-first-run-qr`、`sync-service-pc-section`、`pc-wechat-*`、`pc-error`）保留。
- **行为不变**：启停写两个设置项、失败双回滚、设备撤销、轮询门控、首跑条件、微信折叠持久化键（如保留 details）；只改呈现与入口归属。
- **验收标准**：
  - `sync-console-stats` 在一个大数字卡内，含 342/7 的既有断言；
  - firstRun+运行中 → 二维码出现在 Android 卡内，不再单独成段；
  - `sync-service-pc-section` 作为第二张 channel card，含微信入口图、状态、二维码；
  - APK/网盘/GitHub 三个 link 与 `upstream-links.ts` 逐字一致；
  - 隐私脚注不链接外网、不承诺上传；
  - `npx vitest run src/renderer/pages/sync-gallery/console/ConnectView.test.tsx` 全绿（结构断言按新 IA 更新，行为断言不改判据）。
- **红灯用例**：先加“双通道卡”“微信入口图”“首跑码在 Android 卡内”断言，当前失败；实现后转绿。

### N5 设置页上游节奏对齐

- **修改文件**：
  - `D:\项目\软件\MeowStarMap\MeowStarMap\src\renderer\pages\sync-gallery\console\SettingsView.tsx`
  - `D:\项目\软件\MeowStarMap\MeowStarMap\src\renderer\pages\sync-gallery\console\NetworkPermissionCard.tsx`
  - `D:\项目\软件\MeowStarMap\MeowStarMap\src\renderer\pages\sync-gallery\console\ExtraDirectoriesPanel.tsx`（若存在；不存在则只改 SettingsView 内联块）
  - `D:\项目\软件\MeowStarMap\MeowStarMap\src\renderer\pages\sync-gallery\console\sync-console.css`
  - 测试：`SettingsView.test.tsx`
- **目标**：
  - 连接卡：服务地址/图库数据源/相册更新/关闭窗口继续同步（静态行）+ 账号同步卡；账号节保留全部 K9 行为与可见性，默认展开，外层按上游 `settings-card` 视觉；
  - 启动偏好：两个宿主开关（自动启用 + 开机启动）按上游 settings-card 行；
  - 本地网络权限、额外照片目录、热点、在线参数解析依次成卡；元数据同意不删、不默认开启；
  - Windows 外壳/法律声明作为宿主增强卡留在末尾，样式统一。
- **不改**：任何写入键、回滚语义、选择器单飞、错误 Toast、K9 全选/逐项逻辑、i18n key 语义。
- **验收标准**：
  - 上述 6 个上游区块顺序可由 DOM 顺序断言；
  - 账号同步仍可在默认视图直接操作（K9 全部测试绿）；
  - 额外目录 `inspect → 提案 → 确认/过期` 测试全绿；
  - 网络权限按钮文案/危险层级与上游一致；
  - `npx vitest run src/renderer/pages/sync-gallery/console/SettingsView.test.tsx` 全绿。

### N6 最近删除 / 灵感库 / 关于 的卡片与页头对齐

- **修改文件**：
  - `D:\项目\软件\MeowStarMap\MeowStarMap\src\renderer\pages\sync-gallery\console\OrganizerView.tsx`
  - `D:\项目\软件\MeowStarMap\MeowStarMap\src\renderer\pages\sync-gallery\console\InspirationView.tsx`
  - `D:\项目\软件\MeowStarMap\MeowStarMap\src\renderer\pages\sync-gallery\console\AboutView.tsx`
  - `D:\项目\软件\MeowStarMap\MeowStarMap\src\renderer\pages\sync-gallery\SyncInspirationPanel.tsx`（仅新增 `embedded?: boolean` 以隐藏宿主页头，不改数据逻辑）
  - `D:\项目\软件\MeowStarMap\MeowStarMap\src\renderer\pages\sync-gallery\console\sync-console.css`
  - 测试：`OrganizerView.test.tsx`、`InspirationView.test.tsx`、`AboutView.test.tsx`
- **目标**：
  - 页头统一由 Layout 提供；视图内不再重复大标题；
  - 最近删除：开关卡 + 队列卡 + 批量操作条，采用上游 `organizer-card` 的行/角标/空态；
  - 灵感库：上游搜索/分类/状态筛选与卡片网格视觉，空态/加载态/错误态同款；嵌入模式不重复标题；
  - 关于：版本卡 + 下载渠道卡 + 来源五链卡，保留宿主旧址过滤规则。
- **验收标准**：
  - 三个视图无重复页面级 h3；卡片含 `.sc-card`；
  - 灵感筛选/记录/刷新行为与现测试一致；
  - 关于外链仍走 `shell.openExternal`，旧仓库地址仍不出现；
  - 三个测试套件全绿。

### N7 i18n、资源与构建

- **修改文件**：
  - `D:\项目\软件\MeowStarMap\MeowStarMap\src\renderer\i18n\locales\zh-CN.json` 及 `zh-TW/en/ja/ko/fr/de/es/pt/ru/th/vi.json`
  - 若新增 key：对应 `syncConsole.*` 命名空间；不新建平行命名。
- **新增文案**（中英先定，其他语言同结构翻译）：
  - `syncConsole.shell.brandName` / `brandLatin` / `footerCompat` / `footerDisclaimer`
  - `syncConsole.status.running` / `stopped` / `unavailable`
  - `syncConsole.connect.channels.title` / `wechatTag` / `wechatSteps.*` / `wechatEntryHint`
  - `syncConsole.statusBar.recoveryHint`
- **验收**：
  - `npm run i18n:check` 通过；
  - 12 语言 key 完整，无空值；
  - 品牌图/入口图在生产构建产物中可加载（`npm run build` 后 assets 含 hash 文件）。

### N8 全量验证与交付报告

- **新增报告**：`D:\项目\软件\MeowStarMap\MeowStarMap\docs\sync-integration\13-nikkisync-pc-2026-11-20-alignment-report.md`
- 报告必须按用户要求的六段结构：核对范围 / 差异清单 / 已完成修改 / 验证结果 / 剩余风险 / 结论。
- **验证矩阵**见 §7。

## 5. 依赖声明

- **新增运行时依赖**：无。
- **新增开发依赖**：无。
- **复用既有**：React、i18next、qrcode（已用于配对码）、Vite 静态资源导入、现有 `SettingsToggle/SettingsRow`、现有 IPC/preload 通道。
- **上游源码**：只读引用 `D:\项目\软件\NikkiSync`，不修改、不提交、不复制后端；`resources/nikkisync/pc/**` 沿用已有 staged 资产。
- **安装方式**：无新增包；若 `node_modules` 缺失，先 `npm ci`（需网络；失败则记录 `not-run`，不伪造）。

## 6. 启动与验证说明

### 环境准备

```powershell
node -v                        # 期望 >= 22.12
npm -v
Test-Path D:\项目\软件\MeowStarMap\node_modules
npm run link:nikkisync:check   # 校验上游链接与 staged 资源
npm run verify:nikkisync
```

### 启动

```powershell
cd D:\项目\软件\MeowStarMap
npm run dev
```

打开应用 → 侧栏「同步图库」→「同步服务」，逐页核对五个视图；连接页需看到双通道卡、首跑二维码、微信入口图。

### 验证操作步骤

1. 打开同步图库入口（不报错、不白屏）；
2. 启动 PC 后台服务（开关开 → `running`，地址可见）；
3. 切换五个视图（标题/副标题/状态 chip 正确，无重复标题）；
4. 打开桌面控制页（浏览器 200，含 token 页面）；
5. 生成首跑二维码（SVG 可渲染）；
6. 微信入口启停（状态/二维码变化）；
7. 额外目录选择/预览/确认；
8. 关闭应用重开，设置读回一致。

## 7. 验证矩阵

| 检查           | 命令                                                                                                                                                                                                       | 通过判据                       | 失败处理                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------- |
| 静态检查       | `npm run lint`                                                                                                                                                                                             | 0 error，0 新增 warning        | 修复后重跑                               |
| 类型检查       | `npm run typecheck`                                                                                                                                                                                        | 0 TS error                     | 修复后重跑                               |
| 目标单测       | `npx vitest run src/renderer/pages/sync-gallery/console src/renderer/pages/sync-gallery/SyncServicePage.test.tsx`                                                                                          | 全绿                           | 红灯→修复→绿                             |
| 后端/协议/服务 | `npx vitest run src/main/nikkisync/pc-companion-services.test.ts src/main/nikkisync/sync-server.linked.test.ts src/main/nikkisync/protocol-drift.test.ts src/main/nikkisync/runtime-facade.linked.test.ts` | 全绿                           | 同左                                     |
| 全量回归       | `npm test`                                                                                                                                                                                                 | 无新增失败                     | 必须修完再交付                           |
| i18n           | `npm run i18n:check`                                                                                                                                                                                       | 通过                           | 补 key/翻译                              |
| 构建           | `npm run build`                                                                                                                                                                                            | 成功，renderer assets 含品牌图 | 修复资源路径                             |
| 预览构建       | `npm run build:preview`                                                                                                                                                                                    | 成功                           | 可选                                     |
| 链接/资源      | `npm run verify:nikkisync`                                                                                                                                                                                 | 通过                           | 修正 staged 资源                         |
| 文档链接       | `npm run docs:links`                                                                                                                                                                                       | 通过                           | 修正链接                                 |
| 冒烟（桌面）   | `npm run dev` + 手动/截图核对                                                                                                                                                                              | 入口/服务/五页正常             | 若无法交互，记 `not-run`                 |
| E2E            | `npm run e2e:smoke`                                                                                                                                                                                        | 通过                           | 需已构建/已打包；失败记 `not-run` + 原因 |
| 安装包         | `npm run dist:win`                                                                                                                                                                                         | 构建成功 + `verify:dist`       | 视网络/签名/时长；未跑记 `not-run`       |

**not-run 规则**：任何因缺少真实 Android 设备、无法打开 GUI、网络/签名/打包门禁导致的未执行项，必须在报告中写明命令、阻塞点、已替代的验证（如协议测试/HTTP 200 测试），不得写成“通过”。

## 8. 错误处理与兜底

| 场景                            | 处理                                                      | 日志/提示                  |
| ------------------------------- | --------------------------------------------------------- | -------------------------- |
| 上游链接/staged 资源缺失        | 页面隐藏对应入口而非白屏；`verify:nikkisync` fail-closed  | 主进程 warn + 报告         |
| 服务不可用（`available:false`） | chip 灰态“同步组件未就绪”；connect 仍可打开，操作按钮禁用 | 不弹红 Toast，避免常态告警 |
| 状态通道 reject                 | chip 保持上次快照，不覆盖为 error；Connect 行内提示       | 渲染层 debug 日志          |
| 品牌图/入口图导入失败           | 回退到图标 + 文案布局，不留破图                           | 构建期报错优先拦截         |
| 二维码生成失败                  | 保留重试按钮，显示“生成失败，请重试”                      | 复用现有 `pc-error`        |
| i18n key 缺失                   | `i18n:check` fail；不硬编码中文兜底                       | CI 拦截                    |
| 窄窗口                          | 子导航 188→150→横向；卡片 2 列→1 列；不横向溢出           | 视觉验收                   |
| 旧 preload/老桥面               | 保持现有能力位缺席语义：不渲染、不谎报                    | 现有测试钉住               |

## 9. 参数校验

- 新增展示组件 props 全部 `readonly`，可空字段显式 `null | undefined`；`ConsoleSection.title` 必填，`description/aside/children` 可选。
- `onServerStatusChange?: (status: NikkiSyncServerStatusInfo \| null) => void`，只在有值时回调；不把异常对象塞进 state。
- 品牌资源 `src` 必须由构建器产出；运行时若为空，`<img onError>` 隐藏并保留图标，不输出本地绝对路径。
- 状态 chip 的 `state` 仅允许 `'ready' | 'offline' | 'unavailable'`；未知值收敛为 `unavailable`。
- 所有数值统计只做展示：`undefined/null/NaN` → “不可用”，绝不显示 0 冒充。
- 不新增 IPC 入参；现有通道入参照旧契约，不改。

## 10. 基础测试用例（正常/异常/边界）

| 节点           | 正常                                      | 异常                                           | 边界                                            |
| -------------- | ----------------------------------------- | ---------------------------------------------- | ----------------------------------------------- |
| N2             | `.sync-console` + 5 nav + 品牌 + 页脚渲染 | 品牌图缺失回退图标                             | 无 i18n key 时构建检查失败                      |
| N3             | 五视图标题/副标题切换；chip running       | `available:false`、status reject               | 切换 About 后 timer=0；连续快速切换             |
| N4             | 双通道卡、首跑码、微信入口图              | overview reject、wechatStatus 失败、二维码失败 | firstRun=false 不渲染码；未运行不生成；窄窗单列 |
| N5             | 六区块顺序、账号卡可见                    | 设置写失败回滚、目录过期                       | 空目录列表、无账号、长路径换行                  |
| N6             | 队列/灵感/关于渲染                        | 队列不可用、预览失败                           | 空队列、无筛选结果、无外链                      |
| N1.1（若触发） | 通道返回契约 DTO                          | 上游拒绝码映射                                 | 空数据/旧库缺表                                 |

## 11. 交付物结构（最终回复必须按此顺序）

1. **核对的提交范围**：基准 SHA、tag、日期、父提交、diff 覆盖文件/模块、main 与 tag 关系。
2. **差异与待同步清单**：每条含路径、证据、影响、分类、处理；明确不处理项写原因。
3. **已完成的修改**：文件路径、关键适配点、新增资源、构建/测试/文档变更。
4. **验证结果**：命令、结果、通过/失败/`not-run` + 原因。
5. **剩余风险或阻塞项**：外部依赖、资源、环境、未覆盖场景、潜在回归。
6. **结论**：是否达成“可搭载且实际运行可用”，未达成项明确。

## 12. 风险与边界

- **R1 上游 HTML 不能内嵌**：`X-Frame-Options: DENY` + `frame-ancestors 'none'`；只能 React 适配，像素级一致需人工截图比对，jsdom 不能证明。
- **R2 宿主主题差异**：截图是上游浅色粉系；宿主有 default / soft-pink-luxury 两套主题。结构/字号/圆角/间距对齐，颜色走宿主 token，不强行改全局主题。
- **R3 现有测试编码旧 IA**：N3/N4/N5 会改动部分结构断言；只更新“结构判据”，业务断言（写入、回滚、轮询、K9 等）不改判据，防功能回归。
- **R4 大改 SettingsView 风险**：以“外层换卡 + 顺序调整”为主，不重写业务 hooks；每步跑 SettingsView 全量套件。
- **R5 无真实设备/GUI**：真机配对、桌面截图、安装包只能 `not-run`；以协议测试 + HTTP 200 + DOM 渲染替代，并如实标注。
- **R6 工作树已有未提交改动**：N0 先盘点，绝不 `git checkout`/清理；只编辑本轮明确文件。

## 13. 预计改动文件清单

**新增**

- `src/renderer/pages/sync-gallery/console/sync-console.css`
- `src/renderer/pages/sync-gallery/console/ConsoleIcons.tsx`
- `src/renderer/pages/sync-gallery/console/console-ui.tsx`
- `src/renderer/pages/sync-gallery/console/brand-assets.ts`
- `src/renderer/pages/sync-gallery/console/sync-console-design.test.ts`
- `docs/plans/2026-11-20-nikkisync-pc-upstream-design-align-实施计划.md`
- `docs/sync-integration/12-nikkisync-pc-2026-11-20-alignment-audit.md`
- `docs/sync-integration/13-nikkisync-pc-2026-11-20-alignment-report.md`

**修改**

- `src/renderer/pages/sync-gallery/console/SyncConsoleLayout.tsx`
- （原 `SyncStatusBar.tsx` 已并入 `SyncConsoleLayout.tsx`）
- `src/renderer/pages/sync-gallery/console/ConnectView.tsx`
- `src/renderer/pages/sync-gallery/console/SettingsView.tsx`
- `src/renderer/pages/sync-gallery/console/OrganizerView.tsx`
- `src/renderer/pages/sync-gallery/console/InspirationView.tsx`
- `src/renderer/pages/sync-gallery/console/AboutView.tsx`
- `src/renderer/pages/sync-gallery/console/SelfCheckCard.tsx`
- `src/renderer/pages/sync-gallery/console/NetworkPermissionCard.tsx`
- `src/renderer/pages/sync-gallery/SyncInspirationPanel.tsx`（仅 `embedded`）
- `src/renderer/i18n/locales/*.json`（12 个）
- 对应 5 个 console 测试套件 + `SyncServicePage.test.tsx`

**明确不改**

- `NikkiSync/**`（只读）
- 移动端/小程序/Windows Shell
- `src/main/nikkisync/**` 后端逻辑（除 N1.1 条件触发）
- 全局主题/AppShell/其他板块 UI
</content>
