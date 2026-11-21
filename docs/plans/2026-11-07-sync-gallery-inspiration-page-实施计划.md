# 同步图库 · 灵感库升级为独立二级页 — 实施计划

> 日期：2026-11-07 · 状态：已确认（经实施前计划评审） · 范围：纯渲染层

## 一、背景与目标

灵感库面板 `SyncInspirationPanel`（N4，走既有 IPC `nikkisync:*inspiration*`，对应上游 `/v1/inspiration*` 协议）目前嵌在二级页 `SyncServicePage` 内部（`SyncServicePage.tsx:1019-1020`）。本任务将其升级为独立二级页：

1. 同步图库工具栏新增与「同步服务」同级且**纯导航**的「灵感库」按钮（`navigateTo('sync-inspiration')`），不承载任何服务启停语义；
2. 新建灵感库二级页 `SyncInspirationPage.tsx`（视图 ID `sync-inspiration`，层级 2，与 `sync-service` 同口径：不进侧边栏、返回走 viewStack `goBack`）；
3. **复用 `SyncInspirationPanel` 组件本体**，不重写功能逻辑；
4. 从 `SyncServicePage` **移除**面板挂载（移动而非复制，不允许两处重复挂载）；
5. 保留 `SyncServicePage` 中 `syncService.status.inspirationV1` 能力位状态行（能力观测，不是功能入口）。

**依赖声明**：无新增依赖。

**范围铁律**：不新增/不修改任何 IPC 通道、preload API、主进程代码；`docs/IPC_CONTRACT.md` 无需改动；灵感库后端能力（上游 `InspirationRepository` + LAN 协议）本轮完全不动。

## 二、现状锚点核实结果（含与任务书的偏差）

行号以 2026-11-07 实际代码为准：

| 锚点                                                                                                                                                                                          | 结论                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `App.tsx:93-107` ALL_VIEWS / `:111-126` VIEW_LEVEL_MAP（`'sync-service': 2`）/ `:308-348` renderPage（default 兜 GalleryPage）/ `:371-397` keep-alive（display:none + visitedViews 惰性挂载） | ✅ 与任务书一致；另需新增 lazy import（仿 `:56-59` SyncServicePage 模式）                                                                                                                                                                                                       |
| `uiStore.ts:61-75` ViewLevel 联合类型 / `:87-92` MULTI_SELECT_VIEWS（`sync-gallery` 刻意不在内）/ `:278-303` navigateTo 纯压栈、goBack 弹栈                                                   | ✅ 一致                                                                                                                                                                                                                                                                         |
| `Sidebar.tsx`                                                                                                                                                                                 | ✅ 显式 `navItems` 白名单，二级视图不进，**无需改动**；返回走侧边栏 `goBack`（`viewStack.length > 1` 驱动）                                                                                                                                                                     |
| `AppShell.tsx:19-50` getViewStatusLabel                                                                                                                                                       | ✅ `case 'sync-service'` 在 44-46 行，需仿照新增                                                                                                                                                                                                                                |
| `SyncGalleryToolbar.tsx:116-126` 同步服务按钮                                                                                                                                                 | ✅ 条件渲染 `{onOpenService ? ...}`、无 disabled（只导航不承载启停）；工具栏被 `SyncGalleryPage.tsx:180/208` **两处**调用，两处都要传新 prop                                                                                                                                    |
| `SyncInspirationPanel.tsx`（624 行）                                                                                                                                                          | ✅ **零轮询**（0 处 setInterval/setTimeout），事件驱动：details 首次展开 + `onLibraryChanged` 订阅 + 用户操作；`loadedRef` 缓存防重复 IPC；桥缺失 211 行静默 `return null`；根元素自带 `data-testid="sync-inspiration-panel"` / `sync-inspiration-summary` → **组件本体零改动** |
| `SyncServicePage.tsx:1012-1021`                                                                                                                                                               | ✅ 面板挂载在 1019-1020（含注释）；能力位状态行在 1012-1018；2s 轮询门控在 218-239                                                                                                                                                                                              |

**偏差 ①**：能力位字段实际名为 `status.inspirationV1`（`shared/types/electron-api.ts:995`），非任务书行文中的 `status.inspiration`。

**偏差 ②**：`SyncServicePage.test.tsx` 中**没有**面板渲染的正向断言（面板行为由 `SyncInspirationPanel.test.tsx` 组件级测试覆盖，与挂载位置无关）。「断言随功能迁移、不得净损失」落地为：新增 SyncServicePage 负向断言（不再渲染面板）+ 新页面正向断言（挂载面板），净覆盖只增不减。

**偏差 ③**：`sync-service-keys.test.ts` **无需改动**——能力位状态行保留 ⇒ `syncService` 子树 key 零增删，其等集断言不受影响（任务书预期需同步更新，经核实不适用）。

## 三、关键决策

1. **能力位状态行保留在 SyncServicePage**（不移走）。理由：它依赖该页本地 `status`（来自 2s `getServerStatus` 轮询），是服务状态总览的观测行，与「配对」「运行时」等状态行并列；新页定位为纯功能页，若承载能力位就得引入轮询（需 currentView 门控），违反「纯导航」语义与最小改动原则。
2. **i18n 仅新增 2 个 key**：`syncGallery.toolbar.inspiration`（按钮）与 `appShell.viewStatus.syncInspiration`（状态栏），12 包同批补齐；页面标题**复用既有** `syncGallery.inspiration.title`（「灵感库」，12 包已有译文），新 key 的各包译文逐包对齐该既有译文术语。并在 `sync-gallery-keys.test.ts` 加「按钮 = 状态栏 = inspiration.title 三处值一致」不变式（仿 `sync-service-keys.test.ts:303-314` 四处一致先例）。
3. **按钮**：`IconStar`（`src/renderer/icons/index.tsx:217` 已有），插在「同步服务」按钮之后、压尾「关于」按钮之前；`variant="secondary" size="sm"` 仿既有模式，无 disabled（运行时未启动照常可点）。
4. **面板零改动**：无轮询 ⇒ 无需 currentView 门控；keep-alive 隐藏态下 `onLibraryChanged` 订阅保持（事件驱动、便宜，与页面既有 `SyncPcCompanionSection` 同哲学）。

## 四、实施步骤（TDD 红绿闭环，每节点通过 `npm run verify` 后进下一步）

### 步骤 0 — 计划落盘

将本计划写入 `docs/plans/2026-11-07-sync-gallery-inspiration-page-实施计划.md`。

### 步骤 1 — i18n（红→绿）

- **需修改文件**：`src/renderer/i18n/locales/sync-gallery-keys.test.ts`（红）→ 12 个 `src/renderer/i18n/locales/*.json`（绿）。
- **输入/输出**：REQUIRED_KEYS 追加 `syncGallery.toolbar.inspiration`、`appShell.viewStatus.syncInspiration`；新增三处值一致不变式 → 12 包 JSON 同构补 key（zh-CN「灵感库」；其余 11 包对齐各自 `syncGallery.inspiration.title` 现有译文）。
- **验收标准**：`sync-gallery-keys.test.ts` 先红（key 缺失）后绿；12 包子树同构断言绿。

### 步骤 2 — 新页面（红→绿）

- **需修改文件**：新增 `src/renderer/pages/sync-gallery/SyncInspirationPage.test.tsx`（红）→ 新增 `src/renderer/pages/sync-gallery/SyncInspirationPage.tsx`（绿）。（新增两文件已删除——随 2026-11-21 sync-service-promote 轮）
- **输入/输出**：测试引用不存在的模块即为红。用例三类：①正常——渲染 PageHeader（标题「灵感库」）+ 面板 `sync-inspiration-summary` 可见；②异常——桥缺失时页面壳仍渲染、面板静默隐藏（`queryByTestId` 为 null）；③边界——面板折叠态不发 IPC（面板既有契约，页面级断言挂载即可）。mock 模式仿 `SyncServicePage.test.tsx`（整只替换 `window.electronAPI`）。
- **实现**：仿 `SyncServicePage` 页壳（`PageHeader` + `flex-1 min-h-0 overflow-y-auto px-6 py-4` 滚动容器 + `mx-auto max-w-2xl`），容器内仅 `<SyncInspirationPanel />`。
- **验收标准**：新测试文件先红后绿。

### 步骤 3 — 路由登记（红→绿）

- **需修改文件**：`src/renderer/App.view-registry.test.ts`、`src/renderer/stores/uiStore.test.ts`（红）→ `src/renderer/stores/uiStore.ts`、`src/renderer/App.tsx`、`src/renderer/components/layout/AppShell.tsx`（绿）。
- **输入/输出**：view-registry 仿 sync-service 三条专属断言（`'sync-inspiration': 2`、renderPage `case` 后 200 字符内含 `SyncInspirationPage`、getViewStatusLabel `case` 后含 `appShell.viewStatus.syncInspiration`；ALL_VIEWS/VIEW_LEVEL_MAP 由既有循环断言自动强制）；uiStore.test 仿 `:126-163` 加「sync-inspiration 二级页导航契约」describe（ViewLevel 登记、压栈/出栈、不清空选中集）→ 实现：ViewLevel 加 `'sync-inspiration'`；App.tsx ALL_VIEWS / VIEW_LEVEL_MAP / lazy import / renderPage case 四处；AppShell 加 case。
- **验收标准**：两组测试先红后绿。

### 步骤 4 — 工具栏按钮与接线（红→绿）

- **需修改文件**：`src/renderer/pages/sync-gallery/SyncGalleryToolbar.test.tsx`、`SyncGalleryPage.test.tsx`（红）→ `SyncGalleryToolbar.tsx`、`SyncGalleryPage.tsx`（绿）。（涉及四文件已删除——随 2026-11-21 sync-service-promote 轮）
- **输入/输出**：Toolbar 三条契约（未传 `onOpenInspiration` 不渲染、传入后点击回调恰好一次、`runtimeState: null` 时不得禁用）；Page 测试断言 `navigateTo('sync-inspiration')` → 实现加可选 prop + 按钮；SyncGalleryPage 两处调用点传 `onOpenInspiration={() => navigateTo('sync-inspiration')}`。
- **验收标准**：两组测试先红后绿。

### 步骤 5 — 移除面板挂载（红→绿）

- **需修改文件**：`src/renderer/pages/sync-gallery/SyncServicePage.test.tsx`（红）→ `src/renderer/pages/sync-gallery/SyncServicePage.tsx`（绿）。
- **输入/输出**：负向断言「页面不再渲染灵感库面板（`queryByTestId('sync-inspiration-summary')` 为 null）」→ 删除 1019-1020 行（注释 + `<SyncInspirationPanel />`）及对应 import。
- **保持不动**：能力位状态行（1012-1018）、2s 轮询门控（218-239）、既有 (bj)/(bk)/(r) 用例、灵感四通道 mock（无害保留）。
- **验收标准**：负向断言先红后绿；(bj)/(bk)/(r) 回归锚持续绿。

### 步骤 6 — 全量回归

`npm test`（全量）+ `npm run typecheck:e2e`，无新增失败项。

## 五、启动/验证方式

- 每步骤：`npm run verify`（只读；typecheck / lint / core-gate / format / test 5 项）。改动全部位于 `src/renderer` 与 i18n locales，不触及 core-path 保护路径（`src/main/preload/api`、`ipc/handlers`、`services`、`shared/errors`），无需 `@core-change` 授权注释。
- 最终：`npm test` 全量 + `npm run typecheck:e2e`；改动留在工作区，不提交。

## 六、错误处理

- **桥缺失**：面板自带 `bridgeMissing` 静默隐藏（面板 211 行 `return null`）；新页面壳零 IPC 调用，不会因桥缺失崩溃——步骤 2 用例②钉住。
- **能力位缺席**：新页不涉及；SyncServicePage 原语义保留（键缺席不渲染「未启用」行，既有 (bk) 用例钉住）。
- **keep-alive 隐藏态**：面板无轮询（已核实），重复进入/返回由 keep-alive 保留组件状态（折叠态/已加载数据），`loadedRef` 防重复 IPC；`onLibraryChanged` 事件订阅事件驱动可接受。
- **状态栏 key 缺失**：i18n 回退显示 key 原文（软失败）——由 12 包同构断言 + REQUIRED_KEYS 兜住。

## 七、参数校验

不涉及后端输入校验（纯渲染层任务，无新增 IPC/preload/主进程改动）；`navigateTo('sync-inspiration')` 入参受 `ViewLevel` 联合类型编译期约束；新 prop 为可选回调，语义与 `onOpenService` 完全同构。

## 八、修改文件清单

**改**：`src/renderer/stores/uiStore.ts`、`src/renderer/App.tsx`、`src/renderer/components/layout/AppShell.tsx`、`src/renderer/pages/sync-gallery/SyncGalleryToolbar.tsx`、`SyncGalleryPage.tsx`（两者已随 2026-11-21 sync-service-promote 轮删除）、`SyncServicePage.tsx`、12 个 `src/renderer/i18n/locales/*.json`、`sync-gallery-keys.test.ts`、`src/renderer/App.view-registry.test.ts`、`src/renderer/stores/uiStore.test.ts`、`SyncGalleryToolbar.test.tsx`、`SyncGalleryPage.test.tsx`（测试亦已删除）。

**增**：`src/renderer/pages/sync-gallery/SyncInspirationPage.tsx` + `SyncInspirationPage.test.tsx`（已删除——随 2026-11-21 sync-service-promote 轮）、本计划文档。

**不改**：`Sidebar.tsx`、`SyncInspirationPanel.tsx`（零改动）、`sync-service-keys.test.ts`、主进程/preload/shared 全部、`docs/IPC_CONTRACT.md`。

## 九、基础测试用例（可判定）

| 类别 | 用例                                                                  | 判定                                                                       |
| ---- | --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 正常 | 新页面渲染 PageHeader「灵感库」+ 面板 summary 可见                    | `getByText` / `findByTestId` 命中                                          |
| 正常 | 工具栏传入 `onOpenInspiration` 后按钮可点、回调恰好一次               | `getByTitle('灵感库')` + mock 调用数 === 1                                 |
| 正常 | `navigateTo('sync-inspiration')` 压栈、`goBack()` 回到 `sync-gallery` | viewStack 断言 `['sync-gallery','sync-inspiration']` → `['sync-gallery']`  |
| 异常 | 桥缺失时新页面壳仍渲染、面板静默隐藏                                  | 页面标题可见 + `queryByTestId('sync-inspiration-summary')` 为 null         |
| 异常 | 未传 `onOpenInspiration` 时工具栏不渲染灵感库按钮                     | `queryByTitle('灵感库')` 为 null                                           |
| 边界 | `runtimeState: null` 时灵感库按钮不得禁用                             | button.disabled === false                                                  |
| 边界 | 进入 `sync-inspiration` 不清空图库选中集/多选态                       | selectedMediaIds 保持、multiSelectMode 保持                                |
| 边界 | SyncServicePage 不再渲染面板，能力位状态行保留                        | `queryByTestId('sync-inspiration-summary')` null + 「灵感同步 v1」行可断言 |
| 边界 | 三处 i18n 值一致（按钮 = 状态栏 = 页面标题）                          | 12 包逐包相等断言                                                          |

## 十、剩余风险 / 需手工验收

- keep-alive 下「同步图库 ↔ 灵感库 ↔ 同步服务」反复进出时滚动位置与面板折叠态的实机表现（单测无法覆盖）。
- 非基准语言包新译文的措辞（以各包 `syncGallery.inspiration.title` 现有译文为准，建议抽查 1-2 种语言）。
- `SyncGalleryPage.test.tsx` 若存在按钮顺序/数量类快照断言，执行时按最小调整原则同步（预计无）。
