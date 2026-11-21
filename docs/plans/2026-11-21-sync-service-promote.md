# 计划：「同步图库」界面层级替换 — 同步服务控制台提升为二级界面

- 日期：2026-11-21
- 目标：删除侧边栏「同步图库」入口页（图 1，`SyncGalleryPage`）的全部界面内容/入口/专属组件（**不动**同步数据、图片、保存记录与持久化数据），把「同步服务」控制台（图 2，`SyncServicePage` → `SyncConsoleLayout`，即「暖暖相册」）提升到该侧边栏位置成为新二级界面。
- 已确认决策：
  1. 侧边栏入口与底部状态栏改名为「同步服务」（侧边栏新增 `nav.syncService` 键、状态栏复用既有 `appShell.viewStatus.syncService`；实施勘察发现 `nav.syncService` 并不存在——原报告误将 `appShell.viewStatus.syncService` 当作 nav 键——故按各包 `appShell.viewStatus.syncService` 同值在 12 语言包补齐 `nav.syncService`）。
  2. 独立 `sync-inspiration` 二级视图一并移除（控制台内已有「灵感库」页签，同一块 `SyncInspirationPanel`）。
- 约束：最小化改动；i18n 键一律不删（`sync-console-keys.test.ts` ③ 明确禁止清理 `syncService.*`/`syncGallery.*` 旧命名空间）。

## 背景勘察结论

- 自定义视图路由（无 react-router）：`uiStore.ViewLevel` 字面量联合 + `viewStack` 压栈（`navigateTo`）/出栈（`goBack`），侧边栏返回按钮由 `viewStack.length > 1` 驱动。
- 5 处注册契约由 `src/renderer/App.view-registry.test.ts` 焊死：ViewLevel 联合 / `ALL_VIEWS`（keep-alive）/ `VIEW_LEVEL_MAP`（毛玻璃层级）/ `renderPage` case / `AppShell.getViewStatusLabel` case。
- 控制台全部轮询按 `currentView === 'sync-service'` 门控（`SyncConsoleLayout` ×2、`ConnectView` ×3、`SettingsView` ×2、`OrganizerView` ×1、`InspirationView` ×1）——提升后必须翻转为 `'sync-gallery'`，否则资产总览永远显示「不可用」。
- 旧页专属组件：`SyncGalleryPage` / `SyncGalleryToolbar` / `SyncInsightPanel` / `SyncAssetDrawer` / `syncGalleryStore` / `SyncInspirationPage`。
- 必须保留：`SyncInspirationPanel(+test)`（控制台灵感库页签在用）、`SyncServicePage(+test)`（提升后的承载壳）、`console/*`、`components/sync/ShareCardDialog`（DetailPage 在用）、`mediaStore.fetchAssetPage`（图库数据源链在用）。

## 依赖声明

无新增/无变更依赖，纯仓库内源码改动。

## 启动说明

- 环境：Node 已就绪（仓库 node_modules 已安装）；Electron 应用。
- 开发：`npm run dev`；手动验证路径：点侧边栏「同步服务」→ 控制台渲染（页头「暖暖相册」+ 五页签 + 底栏）→ 底部状态栏显示「同步服务」→ 侧边栏返回按钮回图库。
- 验证命令：`npm test`、`npm run typecheck`、`npm run lint`、`npm run i18n:guard`、`npm run e2e:smoke`。

## 错误处理

- 各视图既有路由级 `ErrorBoundary` 与 `renderPage` `default` 兜底保留，不新增异常路径。
- 控制台轮询「离开视图即清零定时器」纪律随门控翻转原样保留（`SYNC_CONSOLE_HOST_VIEW` 单点定义，门控语义不变）。
- NikkiSync 桥缺失时资产总览显示「不可用」而非报错（既有契约不变）。

## 参数校验

- `ViewLevel` 为编译期字面量联合：删除 `'sync-service'` / `'sync-inspiration'` 字面量后，所有遗留比较点由 `tsc` 直接报错拦截。
- `console/console-views.ts` 新增 `SYNC_CONSOLE_HOST_VIEW: ViewLevel = 'sync-gallery'` 作为控制台宿主视图的唯一真相源；`isConsoleView` 继续兜住 localStorage 非法子视图值（旧值仍合法）。

## 基础测试用例

- 正常：点侧边栏「同步服务」→ 控制台渲染（h2「暖暖相册」+ connect/settings/organizer/inspiration/about 五页签 + 底栏）；状态栏文案「同步服务」；返回按钮回图库。
- 异常：桥缺失 → 资产总览「不可用」，无未捕获异常；路由级 ErrorBoundary 兜底。
- 边界：旧 `localStorage['syncConsole.view']` 值仍被 `isConsoleView` 接受；viewStack 栈顶重复压栈不追加；`goBack` 到栈底（viewStack.length === 1）不再弹出。

## 子任务与验收标准

### 0. 计划落盘

- 文件：`docs/plans/2026-11-21-sync-service-promote.md`（本文件）。
- 验收：文件存在。

### 1. 红灯：测试改写为新契约

- `src/renderer/App.view-registry.test.ts`：删除 sync-service/sync-inspiration 登记断言；新增反向锁（ViewLevel 不得含两字面量）、`renderPage case 'sync-gallery'` 渲染 `SyncServicePage`、`getViewStatusLabel case 'sync-gallery'` 引用 `appShell.viewStatus.syncService`。
- `src/renderer/stores/uiStore.test.ts`：删除「sync-service 二级页导航契约」「sync-inspiration 二级页导航契约」describe；新增反向锁 + sync-gallery 压栈/goBack 契约。
- `src/renderer/components/layout/Sidebar.test.tsx`：第 5 项断言「同步图库」→「同步服务」（textContent / getByTitle；navigateTo 目标不变仍为 `'sync-gallery'`）。
- `src/renderer/pages/sync-gallery/console/sync-console-test-utils.tsx`：`currentView: 'sync-service'` → `'sync-gallery'`。
- 输入/输出：只改测试与测试工具；输出为新契约下的红灯（旧实现不满足）。
- 验收：`npx vitest run <上述文件>` 按预期失败（红灯确认）。

### 2. 绿灯：注册表与路由翻转

- `src/renderer/stores/uiStore.ts`：ViewLevel 删除两字面量；更新头部与 `MULTI_SELECT_VIEWS` 注释（syncGalleryStore 随后删除）。
- `src/renderer/App.tsx`：删除 `SyncGalleryPage` / `SyncInspirationPage` 懒加载与两个 case；`case 'sync-gallery'` 改渲染 `<SyncServicePage />`；`ALL_VIEWS` / `VIEW_LEVEL_MAP` 移除两项（`'sync-gallery'` 保持层级 1）。
- `src/renderer/components/layout/AppShell.tsx`：删除两个 case；`case 'sync-gallery'` → `t('appShell.viewStatus.syncService')`。
- `src/renderer/components/layout/Sidebar.tsx`：入口 labelKey `'nav.syncGallery'` → `'nav.syncService'`（id 仍 `'sync-gallery'`，位置不变）。
- 输入/输出：视图注册表五处登记翻转；导航入口改名。
- 验收：`npx vitest run src/renderer/App.view-registry.test.ts src/renderer/stores/uiStore.test.ts src/renderer/components/layout/Sidebar.test.tsx` 全绿。

### 3. 绿灯：控制台可见性门控翻转

- `console/console-views.ts`：新增 `SYNC_CONSOLE_HOST_VIEW`，更新头注释。
- `SyncConsoleLayout.tsx`（2 处）、`ConnectView.tsx`（3 处）、`SettingsView.tsx`（2 处）、`OrganizerView.tsx`（1 处）、`InspirationView.tsx`（1 处）：`currentView === 'sync-service'` → `=== SYNC_CONSOLE_HOST_VIEW`。
- `pages/sync-gallery/SyncInspirationPanel.tsx`：缺省门控 `'sync-inspiration'` → `SYNC_CONSOLE_HOST_VIEW`。
- 输入/输出：9 处门控常量翻转；轮询语义不变。
- 验收：`npx vitest run src/renderer/pages/sync-gallery` 全绿。

### 4. 删除旧二级界面 UI（只删 UI，不动数据链）

- 删除：`SyncGalleryPage.tsx(+test)`、`SyncGalleryToolbar.tsx(+test)`、`SyncInsightPanel.tsx(+test)`、`SyncAssetDrawer.tsx(+test)`、`SyncInspirationPage.tsx(+test)`、`stores/syncGalleryStore.ts(+test)`。
- 输入/输出：移除旧页 UI 组件与其专属 store；数据、IPC 通道、取数链（`mediaStore.fetchAssetPage`）不动。
- 验收：`npm run typecheck` 通过（无悬空引用）。资产仍可在「图库」经控制台「同步设置 → 图库数据源」浏览。

### 5. e2e 与文档同步

- `e2e/nikkisync-runtime.e2e.ts` N3c：点侧边栏 `getByTitle('同步服务')` 后控制台直接渲染，删除旧工具栏入口点击步骤。
- `src/renderer/AGENTS.md`：pages 契约行更新（移除 SyncGalleryPage / SyncInspirationPage，注明 `'sync-gallery'` 视图由 `SyncServicePage` 承载）。
- 验收：`npm run typecheck:e2e` 通过。

### 6. 全局回归

- 命令：`npm test`（全量 vitest）、`npm run typecheck`、`npm run lint`、`npm run i18n:guard`；环境允许时 `npm run e2e:smoke`。
- 验收：无新增失败项；发现即修，未全绿不交付。

## 实施结果（2026-11-21 回填）

- `npm test`：549 个测试文件，8924 通过 / 0 失败 / 20 跳过（跳过为既有门控，非本次引入）。
- `npm run typecheck`、`npm run typecheck:e2e`、`npm run lint`、`npm run i18n:guard`、`npm run format:check`：全部通过。
- `npm run dist:win` + `npm run e2e:smoke`（新打包产物）：24/24 通过，其中
  N3c「同步服务控制台真实渲染」（真实窗口：侧边栏「同步服务」→ 控制台 → 开关起服务 → 二维码 SVG 与设备列表）
  与 G2「真实 UI 路径：照片目录保存即生效」直接覆盖本次提升后的导航与控制台交互。
- 变更集：删除旧页 12 个文件（SyncGalleryPage/Toolbar/InsightPanel/AssetDrawer/SyncInspirationPage/syncGalleryStore 及各自测试）；
  注册表五处登记翻转；控制台 9 处门控收敛到 `SYNC_CONSOLE_HOST_VIEW`；12 语言包新增 `nav.syncService`（与各包
  `appShell.viewStatus.syncService` 同值）；e2e N3c/G2 导航改写；`src/renderer/AGENTS.md` pages 契约行更新。
- 说明：工作区中 `src/main/**` 等存在与本任务无关的既有未提交改动，本次未触碰。
