# 同步服务剥离设置页 → 迁入「同步图库」二级子页

> 生成日期 2026-10-16 · 基线 Gallery `6a6e531`（branch `feat/gallery-runtime-embed`，工作树干净）· 版本 2.5.5
> 范围依据：任务委托方说明 + 本文件 §0 前提取证
> 铁律：纯渲染层重构 —— 不碰主进程 · 不碰 `nikkisync:*` IPC 通道 · 不碰 preload · 不碰 Runtime 生命周期 · 不碰数据仓储层 · 不新增侧边栏入口 · 不新增 npm 依赖

## 0. 前提取证（执行前必须读的一段）

任务描述自带 4 条状态假设。逐条只读取证后，**2 条不成立**，已改道；其余 2 条成立，是本计划的实际内容。

| 前提（请求的假设）                  | 取证命令 / 位置                                                                | 观察到的输出                                                                                                               | 判定                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 侧边栏需新增「同步图库」导航入口    | `sed -n '38,49p' src/renderer/components/layout/Sidebar.tsx`                   | `navItems` 第 5 项（L43）已是 `{ id: 'sync-gallery', labelKey: 'nav.syncGallery', icon: <IconSync/> }`                     | **不成立**，已存在                                      |
| uiStore 需新增 ViewLevel 及路由切换 | `uiStore.ts:61-73`、`App.tsx:89-102 / 106-119 / 301-337`、`AppShell.tsx:17-45` | `'sync-gallery'` 已在 ViewLevel 联合类型、`ALL_VIEWS`、`VIEW_LEVEL_MAP`（值 1）、`renderPage` case、状态栏 case 全链路打通 | **不成立**，已存在（commit `9dd96d5`，已随 2.5.5 出货） |
| 设置页仍有「同步服务」分组待移除    | `sed -n '140,151p' src/renderer/pages/SettingsPage.tsx`                        | `SETTINGS_GROUPS` 内存在 `id: 'sync'` → 唯一 section `sync-service` → `SyncServiceSection`                                 | **成立**                                                |
| 同步服务 UI 需重组进多层级界面      | 读 `src/renderer/pages/sync-gallery/SyncGalleryPage.tsx`（216 行全文）         | 只渲染 PageHeader + SyncGalleryToolbar + VirtualImageGrid + SyncAssetDrawer + ShareCardDialog，**无任何同步服务控件**      | **成立**                                                |

**改道结论**：真实待办是把 `SyncServiceSection`（402 行）从设置页剥离，落成「同步图库」板块下的**新二级子页** `sync-service`；侧边栏入口与 `'sync-gallery'` 层级无需新增。

`Sidebar.test.tsx` 硬断言 navItems 共 10 项、index 3 必须是共鸣录、index 4 必须是同步图库 —— **本次绝不新增侧边栏入口**，否则三条断言集体打红。

## 0.1 决策（已获任务委托方确认）

| 决策项    | 选定                                                                                                                                   | 备选与理由                                                                                                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 承载形态  | 新增 ViewLevel `'sync-service'`（层级 2），从同步图库工具栏 `navigateTo('sync-service')` 进入，复用既有 `viewStack` + Sidebar 返回按钮 | 备选「页内 SegmentedControl Tab」（参考 `ResonanceRecordsPage.tsx:23-84`）与「Drawer 面板」；栈式子页与仓库既有 gallery→detail→editor 层级范式一致，且不会让同步图库变成双职责页 |
| 迁移范围  | 现 `SyncServiceSection` 的全部 6 项控件都迁走，设置页 `sync` 分组整体删除                                                              | 备选「元数据开关留设置页」；本次要求完整剥离，不留半个分组                                                                                                                       |
| i18n 口径 | 新建顶层命名空间 `syncService.*`，`settings.sync.*` 全部改名并删除旧键，12 语言包同步                                                  | 备选「原地复用 `settings.sync.*`」；键留在 `settings.*` 下会与实际渲染位置语义漂移                                                                                               |

## 0.2 目标层级结构

```
同步图库  (sync-gallery, 层级 1, 已存在)
  └─ 工具栏新增「同步服务」按钮 → navigateTo('sync-service')
       └─ 同步服务  (sync-service, 层级 2, 本次新增)
            ①状态总览 + 总开关 / 数据源 / 元数据(+披露常驻)   ← SectionShell「同步服务」
            ②配对新设备 → PairingQrDialog 弹窗（覆盖层）      ← SectionShell「配对」标题
            ③已配对设备管理列表 → 撤销 ConfirmDialog          ← SectionShell「已配对设备」
```

---

## 1. 依赖声明

**无。** 不新增、不变更、不删除任何 npm 依赖，不引入第三方库。全部复用仓库既有原语：
`SectionShell` / `SettingsRow` / `SettingsToggle` / `SettingsCard`（`pages/settings/shared.tsx:60/103/153/234`）、`PageHeader`、`Button`、`EmptyState`、`ConfirmDialog`、`BaseDialog`、`PairingQrDialog`、`useErrorToast`、`useGlobalToast`。

**跨目录复用 `../settings/shared` 的理由**（不做搬迁，避免越界重构）：仓库已有 8 个非 settings 文件在 import 它（`components/common/WifiShareDialog.tsx` 与 resonance 下 5 个组件等，`grep -rln "pages/settings/shared"` 实测）。`useGlobalToast` 当初搬到 `components/common/ToastProvider` 是因为有 10+ 跨页消费点；这 4 个原语的既有消费点全在 `pages/settings/` 内，本次是唯一一个外部落点 —— 为 1 个落点搬 10+ 文件的 import 属顺手重构，不做。新页面 import 处留一行中文注释说明。

安装方式：无需安装（`npm ci` 即可，且本仓有约定：装依赖会剪掉 `@nikkisync/*` junction，使链接态用例降级为 skip，非必要时不动）。

## 2. 启动与验证说明

环境准备：`npm ci`。e2e 复验需要 `npm run link:nikkisync` 且本机 28080 空闲；未建链时 N3c 用 `test.skip` 兜底，属受支持的默认态。

```bash
npm run dev              # electron-vite dev 开发启动
npm run test:renderer    # 渲染层全量（本次主战场）
npm run typecheck        # tsc -b
npm run lint             # eslint .
npm run i18n:guard       # CI 守卫（单向 missing 检查）
npm run i18n:check       # 12 包双向对齐（CI 不跑，必须手工）
npm run typecheck:e2e    # e2e 唯一静态守卫（e2e 不在 npm test 内）
npm run verify           # 变更后只读验证闸门
npm test                 # 全量收口
```

手动验证清单（T5 必做，单测覆盖不到的部分）：

1. 点侧边栏「同步图库」→ 工具栏出现「同步服务」按钮；**运行时未启动状态下该按钮也必须可点**。
2. 点进去 → 侧边栏返回按钮出现；底部状态栏显示「同步服务」而非空白；毛玻璃层级为 2（与详情页同级观感）。
3. 开/关总开关 → toast 文案正常；状态卡 2s 内由「已停止」转「运行中」；地址 / 服务 ID / TLS 指纹出现且可点击复制。
4. 点「配对新设备」→ 二维码弹窗出现、倒计时递减、「重新生成」与「复制内容」可用；服务关闭时该按钮为禁用态。
5. 设备列表 → 无设备时是空态而非空白；有设备时点「撤销」→ 确认框带设备名 → 确认后列表刷新 + toast。
6. 回设置页 → 左导航不再有「同步」分组与「同步服务」节；用残留过 `settings-active-section='sync-service'` 的旧配置启动，设置页应正常落在「启动行为」，不崩不白屏。
7. 在二级页停留后切回图库 → DevTools Network/Console 确认 `nikkisync:getServerStatus` 调用频率归零（轮询门控生效，keep-alive 不后台常驻）。
8. 切语言到 en / ja / th 各一遍 → 新板块无 `syncService.xxx` 形式的裸 key 泄漏。

## 3. 错误处理

沿用现有实现，不新增错误分支、不弱化任何既有兜底：

| 场景                              | 现有策略（`sync-sections.tsx` 行号）                                                          | 迁移后   |
| --------------------------------- | --------------------------------------------------------------------------------------------- | -------- |
| `getServerStatus` 抛错            | L66-68 catch 后静默，下一轮轮询重试；桥未组装时返回 `available:false` 不抛                    | 逐字保留 |
| `getPairedDevices` 抛错           | L62 `.catch(() => [])`，设备区退化为空态                                                      | 逐字保留 |
| 服务启停失败                      | L197-206 `persistEnabled(!value)` 回滚两处设置 + 本地态 + `showError`；回滚自身失败仅保本地态 | 逐字保留 |
| 数据源切换持久化失败              | L143-150 回滚 `gallerySource` + `useMediaStore.setSource(previous)`                           | 逐字保留 |
| 元数据开关写失败                  | L170-174 回滚布尔值 + `showError`                                                             | 逐字保留 |
| 撤销设备失败                      | L221-223 `showError`，`finally` 关确认框并刷新                                                | 逐字保留 |
| 二维码生成失败                    | `PairingQrDialog.tsx:130/133` 弹窗内 `pairing.loadFailed` + 「重试」                          | 逐字保留 |
| 剪贴板失败                        | L235-237 `showError(err)`                                                                     | 逐字保留 |
| 设置读不回（`settings.get` 抛错） | L77-79 / L96-98 / L112-114 保持默认关闭态，绝不默认生效                                       | 逐字保留 |

**本次新引入的唯一行为差异**：keep-alive 下页面切走不再卸载（旧实现切到别的设置节即卸载并清定时器），2s 定时器会后台常驻。对策 = 轮询按 `currentView` 门控（`if (currentView !== 'sync-service') return`），与 `SyncGalleryPage.tsx:67-71` 同口径。该差异必须留一行中文注释在文件头，并有假时钟用例锁死。

**日志规范**：渲染层错误一律经 `useErrorToast` / `extractUserMessage`（`shared/errors/app-error.ts`），不新增 `console.*`。`SyncGalleryPage.tsx:96` 现有那条 `console.error('[sync-gallery] ...')` 不动。

## 4. 参数校验

- 新组件 `SyncServicePage: React.FC`（无 props，对齐原 `SyncServiceSection` 现状）。若拆出子组件，必须显式 `interface XxxProps`，禁止 `props: any`、禁止无泛型 `React.FC`；禁止 class 组件。
- `SyncGalleryToolbar` 新增 `onOpenService?: () => void` 为**可选**：未传则不渲染入口按钮。这是向后兼容点 —— 既有 3 条工具栏用例与 `SyncGalleryPage` 加载态分支（该分支提前 return，本就没有工具栏）都不会因新 prop 变红。
- IPC 入参沿用 preload 侧既有签名，零改动；不新增通道、不改 `docs/IPC_CONTRACT.md`。
- 设置键仍只用 `src/shared/settings-keys.ts` 白名单内的 4 个既有键（`nikkisync.syncServerEnabled` / `nikkisync.runtimeEnabled` / `gallery.dataSource` / `nikkisync.metadataResolverEnabled`），不新增键。
- `gallerySource` 值域仍是 `'local' | 'nikkisync'`；读回值非 `'nikkisync'` 时按 `'local'` 处理（现有实现 L95 已如此）。
- `SettingsToggle` 的 `label` 非空校验由原语内部 `console.error`（`shared.tsx:170-172`）承担，不在业务层重复实现。
- i18n 插值占位必须随键搬运，不得丢失：`gallerySourceApplied` 的 `{{source}}`、`devices.revokeConfirmMessage` 的 `{{name}}`、`pairing.expiresIn` 的时间参数。
- 颜色一律走 CSS 变量 / Tailwind token，禁止硬编码色值（搬移时不引入新色值；`sync-sections.tsx` 现有 `var(--accent, #22c55e)` 属既有写法，逐字搬运不新增违规）。
- 源文件 UTF-8 无 BOM + LF；`git mv` 不改变内容编码。

## 5. 基础测试用例（正常 / 异常 / 边界）

**正常**：开关开 → `startServer` 被调、两处设置写 `true`、状态卡转「运行中」；开关关 → `stopServer`、toast「同步服务已关闭」；数据源切 `nikkisync` → 写键 + `mediaStore.setSource` + `startScan`；点工具栏入口 → `navigateTo('sync-service')`；`goBack()` → 栈复位且 `currentView` 回 `'sync-gallery'`；三段 SectionShell 标题同页存在；配对弹窗打开/关闭；撤销确认 → `revokeDevice(deviceId)` + 列表刷新 + toast。

**异常**：`startServer` 抛错 → 两处设置与本地态三处回滚 + `showError`，开关显示原态；`getServerStatus` reject → 不崩、下轮重试；`getPairedDevices` reject → 空态而非报错页；`settings.get` reject → 保持默认关闭（切源/元数据绝不默认生效）；二维码生成失败 → `loadFailed` 文案 + 点「重试」后成功；剪贴板 reject → `showError`；`revokeDevice` 抛错 → 确认框不吞错误。

**边界**：`status.available === false` → 显示「同步组件未就绪」且**不出现**地址 / 服务 ID / TLS 三行；`running === false` → 「配对新设备」为 `disabled`，但**工具栏入口按钮在 `runtimeState: null` 时不得 disabled**；`devices === []` → 空态而非空白；`activeSection` 残留 `'sync-service'` → 回退「启动行为」不崩；`currentView !== 'sync-service'` 时假时钟推进**不触发**轮询；`onOpenService` 未传 → 入口不渲染；设备无 `lastSeenAt` → 显示「从未」；`appVersion` 缺失 → 不拼出 `vundefined`；12 包漏改 → `runtimeOff` 精确负向断言 + 旧键 `undefined` 反向锁各抓一次。

---

## 6. 子任务拆解（每步红灯 → 改动 → 绿灯）

顺序设计原则：每步结束时 `test:renderer` + `typecheck` + `lint` 全绿才进下一步。T2（搬移：只动路径与结构）与 T4（改名：只动字符串）故意分离，两步失败面互不重叠。

### T-0 · 本文件落盘

- 新增：`docs/plans/2026-10-16-sync-service-to-sync-gallery.md`
- 验收：文件存在、命名对齐既有 `YYYY-MM-DD-<slug>.md`；含依赖声明 / 启动验证 / 错误处理 / 参数校验 / 测试用例五个必备小节。

### T0 · 基线冻结（不改任何文件）

- 命令：`npm run test:renderer`、`npm run typecheck`、`npm run lint`、`npm run i18n:guard`、`npm run i18n:check`、`npm run test:coverage`（记录四项百分比与阈值 66/58/59/68 的余量）。
- 验收：六条全绿。**任一条本来就红 → 先清基线，不带病开工。**

### T1 · ViewLevel 全链路登记 + 骨架页

- 新增：`src/renderer/App.view-registry.test.ts`（node 环境，fs 读源码做结构断言）、`src/renderer/i18n/locales/sync-service-keys.test.ts`（v1，只锁 1 个键）、`src/renderer/pages/sync-gallery/SyncServicePage.tsx`（骨架：PageHeader + 空 body）、`src/renderer/pages/sync-gallery/SyncServicePage.test.tsx`
- 修改：`stores/uiStore.ts`（联合类型 +`'sync-service'`）、`App.tsx`（lazy import + `ALL_VIEWS` + `VIEW_LEVEL_MAP` 值 2 + `renderPage` case）、`components/layout/AppShell.tsx`（`case 'sync-service'`）、12 个 locale（补 `appShell.viewStatus.syncService` + `syncService.page.title`，值搬自 `settings.sections.syncService`；**此步不删旧键**）
- 输入：0.2 的层级结构 · 输出：`navigateTo('sync-service')` 能渲染出一个带正确标题与状态栏文案的空页
- **必须锁死的静默位点**（漏了不报编译错、只静默出错）：

| 位点                          | 漏了的后果                                             | 手段                                                         |
| ----------------------------- | ------------------------------------------------------ | ------------------------------------------------------------ |
| `App.tsx ALL_VIEWS`           | keep-alive 永不挂载 → 点进去整块空白、无报错           | 结构断言                                                     |
| `App.tsx renderPage`          | `default` 兜到 `GalleryPage` → 图库被画两遍            | 结构断言锚在 `case` 上（只 grep 字面量会被注释里的命中骗过） |
| `AppShell getViewStatusLabel` | `default: ''` → 状态栏该页一片空白                     | 结构断言                                                     |
| i18n 键 ×12                   | 直接渲染裸 key                                         | `sync-service-keys.test.ts`                                  |
| `VIEW_LEVEL_MAP`              | **编译失败**（全仓唯一的 `Record<ViewLevel, number>`） | typecheck 天然守卫                                           |
| `MULTI_SELECT_VIEWS`          | 误加 → 进入该页无谓清空图库选中集                      | 反向断言「进入 sync-service 不得清空 `selectedMediaIds`」    |

- 验收：

```bash
npx vitest run src/renderer/App.view-registry.test.ts src/renderer/stores/uiStore.test.ts \
               src/renderer/i18n/locales/sync-service-keys.test.ts \
               src/renderer/pages/sync-gallery/SyncServicePage.test.tsx    # 全绿
npx vitest run src/renderer/components/layout/Sidebar.test.tsx             # 仍绿 = 没动 navItems
npm run typecheck && npm run i18n:guard
```

### T2 · 整体搬移 + 设置页剥离 + 轮询门控

- 移动（`git mv`，保住阶段 3/4/6 的决策注释与 blame）：
  - `pages/settings/sync-sections.tsx` → `pages/sync-gallery/SyncServicePage.tsx`
  - `pages/settings/sync-sections.test.tsx` → `pages/sync-gallery/SyncServicePage.test.tsx`
  - 源文件内**唯一** import 变化：`'./shared'` → `'../settings/shared'`（两目录同为 `pages/` 下两级，其余相对路径全部不变）
- 修改：`SettingsPage.tsx`（删 L27 导入项 + L140-151 sync 分组）、`pages/settings/sections.tsx`（删 L33-34 导出）、`src/shared/settings-keys.ts`（L20 注释里的消费点路径；纯注释，不在核心路径闸门保护面内）
- 结构：外层 `flex h-full flex-col` → `PageHeader` → `flex-1 min-h-0 space-y-4 overflow-y-auto` 包三段 SectionShell；「配对新设备」按钮从段①搬到段②独立成节（`disabled={!running}` 原样保留）；两个对话框留在最外层。组件改名 `SyncServiceSection` → `SyncServicePage`。
- 轮询门控：`refresh` 的 mount effect 加 `if (currentView !== 'sync-service') return` 并列入依赖；三个一次性设置读回 effect **不加**门控（无定时器）。
- 红灯测试（搬移引入的净新增行为 + 剥离面，必须先红）：
  1. 假时钟门控：`currentView='gallery'` 下推进 `STATUS_POLL_MS*2`，断言 `getServerStatus` 调用次数不增长；切到 `'sync-service'` 后恢复轮询。
  2. 三段结构：`getByRole('heading', { level: 3, name })` 断言三个 SectionShell 标题同页存在（**不加 `data-*` 测试钩子** —— `SectionShell` 的标题本就是 `<h3>`）。
  3. 新建 `pages/SettingsPage.test.tsx`：① `queryByText('同步服务')` 为 null；② 边界：`localStorage.setItem('settings-active-section','sync-service')` 后 render 不抛错，并 `findByRole('switch',{name:'启动时自动扫描'})` 命中（= 回退到 `SETTINGS_GROUPS[0].sections[0]`）。把「旧用户残留是否安全」从推断升级为锁死。
- 验收：

```bash
npx vitest run src/renderer/pages/sync-gallery src/renderer/pages/SettingsPage.test.tsx   # 绿
npm run test:renderer        # 绿；PairingQrDialog.test.tsx 未动却仍绿 = 文案值没漂移
npm run typecheck && npm run lint && npm run verify
grep -rn "SyncServiceSection\|sync-sections" src e2e .storybook tests                    # 仅剩待 T3 改的 e2e
git log --follow --oneline src/renderer/pages/sync-gallery/SyncServicePage.tsx | head     # 识别为 rename
```

### T3 · 工具栏入口 + 空态指引 + e2e 接线

- 入口落点判定：**加在 `SyncGalleryToolbar`，不是 PageHeader。** 依据：① 空态分支（`SyncGalleryPage.tsx:158`）已渲染工具栏，而「运行时未启动」正是最需要点进去的场景 —— 桥缺失路径把 `loading` 归 false 后走空态，工具栏可达；加载态分支（L122-133）无工具栏，但 `syncGalleryStore.loadFirst` 三条出口都会把 `loading` 归位，该态是瞬态；② PageHeader 有 3 处重复调用点，改它要么复制三遍要么抽 helper，属越界；③ `SyncGalleryToolbar.tsx:40` 那句失效注释本就在该文件。
- 修改：`SyncGalleryToolbar.tsx`（`onOpenService?` + `Button variant="secondary" size="sm"`，**绝不 disabled** —— 运行时关的时候才是最需要点它的时刻；重写 L40-41 失效注释）、`SyncGalleryPage.tsx`（从 `useUIStore` 取 `navigateTo`，空态与正常态两处传 `onOpenService`）、12 个 locale（+`syncGallery.toolbar.service`，改写 `syncGallery.empty.runtimeOff`）、`e2e/nikkisync-runtime.e2e.ts`（N3c 导航段）、`SyncGalleryPage.test.tsx`、`SyncGalleryToolbar.test.tsx`、`i18n/locales/sync-gallery-keys.test.ts`
- 红灯测试：
  1. 工具栏 3 条：未传 `onOpenService` ⇒ 入口不渲染；传了 ⇒ 可点并回调 1 次；**`runtimeState: null`（未启动档）时 `disabled === false`**（本次最容易写错的一条）。
  2. `SyncGalleryPage.test.tsx:197` 现有断言 `expect(screen.getByText(/设置页开启 NikkiSync 运行时/)).toBeTruthy()` 必须先改红（zh-CN 现值 `"内嵌服务未启动：请在设置页开启 NikkiSync 运行时后重试"` 含该子串）→ 改为 `/工具栏的「同步服务」/`。
  3. 空态点入口 ⇒ `expect(navigateTo).toHaveBeenCalledWith('sync-service')`。
  4. `runtimeOff` 改写守卫：12 包逐条 ①不等于 §7 D 表旧值（精确负向，专抓「漏改某一个语言包」）②含该包自己的 `syncGallery.toolbar.service` 值。
- e2e：`nikkisync-runtime.e2e.ts:471` 现在靠 `localStorage.setItem('settings-active-section','sync-service')` 直达设置页同步节 —— 分组删除后该用例必红。改为 `getByTitle('同步图库')` → `getByTitle('同步服务')`，其余断言（`启用同步服务` / `运行中` / `暂无已配对设备` / `配对新设备` / `.sync-qr-surface svg` / `:28080` / `有效期`）**逐字不改**，它们同时是「文案值未漂移」的端到端证据。
- 验收：

```bash
npx vitest run src/renderer/pages/sync-gallery src/renderer/i18n/locales    # 绿
npm run typecheck:e2e                                                       # e2e 不在 npm test 内，这是它唯一的静态守卫
npm run test:renderer && npm run i18n:guard && npm run i18n:check
```

有链接的机器上补跑 `npm run e2e:smoke -- -g N3c` 复验（CI 不执行）。

### T4 · i18n 改名 + 删旧键（纯字符串层，一步收口）

- 修改：12 个 locale JSON + `SyncServicePage.tsx`（32 处 `t()`）+ `PairingQrDialog.tsx`（9 处）。
- **零新译硬约束**：§7 A 表 37 个键的**值逐字不动**。这是低风险根因 —— 值不变，`SyncServicePage.test.tsx` 与 `PairingQrDialog.test.tsx` 在改名步一条都不会红；任何 12 包的值重写都不许混进本次。
- 批量改法：无现成的 locale 键改名脚本（已盘过 `scripts/i18n/`：`guard.ts` 只单向校验、`codemod.ts`/`extract-i18n.ts` 是「中文硬编码 → t()」方向，与键改名无关）。用一次性 `node -e` 做值搬运，写回格式必须逐字对齐 `JSON.stringify(j, null, 2) + '\n'`（locale 在 lint-staged 的 prettier 作用域内，格式不一致会被钩子改写并二次暂存）。
- **⚠ 全程禁止跑 `npm run sync-i18n-keys`**：它以 zh-CN 为基线删掉其他 11 包的全部 extra 键、新键补空串。中途误跑 = 12 包译文批量蒸发；若已误跑，`git checkout -- src/renderer/i18n/locales` 整体回退重做 T4。
- 红灯测试：把 `sync-service-keys.test.ts` 扩到终态 ——
  ①`REQUIRED_KEYS` = 38 个 `syncService.*` 叶子 + `appShell.viewStatus.syncService`，12 包非空 string；
  ②`leafKeys` 子树与 zh-CN 同构；
  ③**等集断言（键集 == 消费键集，机制性拒绝死键）**；
  ④**反向锁**：12 包 `settings.sync` / `settings.groups.sync` / `settings.sections.syncService` 必须 `undefined`（专补 `i18n:guard` 只做单向 missing、抓不到 extra 残留的洞 —— 这是本迁移最大的假绿通道）；
  ⑤语义不变式平移：`metadata.disclosure` 仍含 `nuan5.pro` 且含「配对」「局域网」，三个插值占位仍在；
  ⑥交叉一致：`syncService.page.title == appShell.viewStatus.syncService == syncGallery.toolbar.service == syncService.service.title`（12 包）。
- 验收：

```bash
npx vitest run src/renderer/i18n/locales                                    # 两个守卫全绿
npx vitest run src/renderer/components/sync/PairingQrDialog.test.tsx         # 未改动却仍绿 = 值未漂移
npm run test:renderer
grep -rn "settings\.sync\.\|settings\.groups\.sync\|settings\.sections\.syncService" src   # 0 命中
npm run i18n:check && npm run i18n:guard
git diff --stat src/renderer/i18n/locales | tail -1   # 12 个文件、增删行数一致
```

### T5 · 全局收口

`npm test` → `npm run lint` → `npm run typecheck` → `npm run i18n:guard` → `npm run i18n:check` → `npm run test:coverage` → `npm run verify` → §2 手动验证 1–8。

提交切分（Conventional Commits，scope ≤24 字符小写、header ≤100、subject 不以「。」结尾）：

```
T1  feat(ui-store): 新增 sync-service 视图层级并登记全部路由位点
T2  refactor(sync-gallery): 同步服务从设置页迁出为板块内二级子页
T3  feat(sync-gallery): 工具栏增加同步服务入口并改写运行时未启动空态指引
T4  i18n(sync-service): 新建顶层命名空间并删除 settings.sync 旧键
```

T4 单独成 commit，便于「PR 描述登记 i18n key 变更」这条硬要求可追溯。

**CHANGELOG 陷阱**：`scripts/check-changelog-release.ts` 会因 `[Unreleased]` 下出现 `- ` 条目阻断打包。本次不写 `[Unreleased]`，留到发版收口一并处理。

---

## 7. i18n 映射表

### A. `settings.sync.*` → `syncService.*`（37 键平移，值逐字不动）

前缀替换，叶子路径不变：`service.{title,description}`、`enable`、`enableDesc`、`gallerySource{,Desc,Applied}`、`status.{label,running,stopped,unavailable,address,serverId,tlsFingerprint,copied}`、`pairing.{title,open,hintRunning,hintDisabled,expiresIn,refresh,copyContent,loadFailed,retry}`、`devices.{title,empty,emptyHint,lastSeen,never,revoke,revokeConfirmTitle,revokeConfirmMessage,revokeConfirm,revoked}`、`metadata.{enable,enableDesc,disclosure}`。

★ 其中被组件测试按**中文文本**定位的键（改值即打红，故必须逐字不动）：`status.running`、`status.unavailable`、`status.copied`（`PairingQrDialog.tsx:108/118/156` 三处）、`pairing.{title,open,expiresIn,refresh,loadFailed,retry}`（`PairingQrDialog.tsx:125/147/162/176/184`）、`devices.{title,empty,revoke,revokeConfirm}`、`metadata.enable`、`metadata.disclosure`。

### B. 删除

- `settings.sync.status.connections` —— 死键，全仓零消费点（上游 `WebSocketHub.sockets` 私有、无公开计数，渲染层早已不展示，`sync-sections.tsx:38-39` 注释记录了这一点）；原测试 (h) 按渲染文本断言，与键在不在无关；由 T4 ③ 的等集断言机制性拒绝任何未来死键。
- `settings.groups.sync`（唯一消费点 `SettingsPage.tsx:143`）
- `settings.sections.syncService`（唯一消费点 `SettingsPage.tsx:147`）

### C. 新增 ×12（值全部搬自旧键，零新译）

| 新键                              | 值来源                          | 用途              |
| --------------------------------- | ------------------------------- | ----------------- |
| `syncService.page.title`          | `settings.sections.syncService` | 二级页 PageHeader |
| `appShell.viewStatus.syncService` | 同上                            | 底部状态栏        |
| `syncGallery.toolbar.service`     | 同上                            | 工具栏入口按钮    |

守卫不变式：三者逐字相等，且与 `syncService.service.title` 也相等（zh-CN 四处都是「同步服务」）。

### D. 改写 `syncGallery.empty.runtimeOff`（守卫的精确负向表，T0 实测 12 包现值）

| 包    | 改写前现值（守卫断言「不得等于」）                                                                             | 该包服务名值（正向断言须包含） |
| ----- | -------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| zh-CN | 内嵌服务未启动：请在设置页开启 NikkiSync 运行时后重试                                                          | 同步服务                       |
| zh-TW | 內嵌服務未啟動：請在設定頁開啟 NikkiSync 執行期後重試                                                          | 同步服務                       |
| en    | Embedded service is not running: enable the NikkiSync runtime in Settings and retry                            | Sync Service                   |
| ja    | 組み込みサービスが起動していません。設定で NikkiSync ランタイムを有効にして再試行してください                  | 同期サービス                   |
| ko    | 내장 서비스가 실행 중이 아닙니다. 설정에서 NikkiSync 런타임을 켠 후 다시 시도하세요                            | 동기화 서비스                  |
| fr    | Service intégré non démarré : activez le runtime NikkiSync dans les Paramètres, puis réessayez                 | Service de synchronisation     |
| de    | Eingebetteter Dienst nicht gestartet: aktiviere NikkiSync-Laufzeit in den Einstellungen und versuche es erneut | Synchronisierungsdienst        |
| es    | El servicio integrado no está iniciado: activa el runtime de NikkiSync en Ajustes y vuelve a intentarlo        | Servicio de sincronización     |
| pt    | Serviço embutido não iniciado: ative o runtime NikkiSync em Configurações e tente novamente                    | Serviço de sincronização       |
| ru    | Встроенная служба не запущена: включите среду NikkiSync в настройках и повторите                               | Служба синхронизации           |
| th    | Embedded service is not running: enable the NikkiSync runtime in Settings and retry（现值为英文）              | บริการซิงค์                    |
| vi    | Dịch vụ nhúng chưa chạy: bật runtime NikkiSync trong Cài đặt rồi thử lại                                       | Dịch vụ đồng bộ                |

zh-CN 终态：`内嵌服务未启动：请点击工具栏的「同步服务」，在其中开启 NikkiSync 运行时后重试`。其余 11 包同构改写：把「设置页」指称换成本包 `syncGallery.toolbar.service` 的值，句子其余部分保留。`th` 现值本就是英文，改写后须含泰文服务名 `บริการซิงค์`。

### E. 不动

`toast.syncEnabled` / `toast.syncDisabled`（在 `toast.*` 下，按决策保留）、`syncGallery.*` 其余键（除 C 新增 `toolbar.service` 与 D 改写 `empty.runtimeOff`）。

### F. 新命名空间叶子全集

`syncService` = A 表 37 + `page.title` = **38 叶子**。`REQUIRED_KEYS` 必须与之等集，多一少一皆红。

## 8. 风险与兜底

| 风险                                  | 判定                                                                                                                                                                                                       | 兜底                                                                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 旧 localStorage 残留 `'sync-service'` | `findSection` 返回 undefined → `\|\| SETTINGS_GROUPS[0].sections[0]` 回退（`SettingsPage.tsx:236`），安全但不彻底：L223-225 的 effect 会把旧值原样写回，左导航无高亮项（视觉瑕疵，不崩不白屏）             | T2 测试锁死「不崩 + 渲染默认节」；**刻意不加自愈清理**（改 effect 逻辑属越界）；产品若要消除无高亮态，另起 commit 在 L219 初始化里做归一化 |
| 12 包漏改                             | `i18n:guard` 只做单向 missing（`scripts/i18n/guard.ts:78`），**抓不到 extra 残留** = 本迁移最大的假绿通道                                                                                                  | 三重锁：旧键 `undefined` 反向断言 + `leafKeys` 子树同构 + 手工 `npm run i18n:check`（双向 extra，但它不在 CI）                             |
| 中途误跑 `sync-i18n-keys`             | 11 包译文批量蒸发                                                                                                                                                                                          | 计划显式禁用；误跑则 `git checkout -- src/renderer/i18n/locales` 整体回退重做 T4                                                           |
| keep-alive 后台常驻 2s 轮询           | 真实行为变化（旧实现切设置节即卸载清定时器）                                                                                                                                                               | `currentView` 门控 + 假时钟用例                                                                                                            |
| 误加 Sidebar 入口                     | 同时打红 `Sidebar.test.tsx` 三条断言（项数 10 / index 3 共鸣录 / index 4 同步图库）                                                                                                                        | 决策已定不新增；T1 验收显式跑该文件                                                                                                        |
| 覆盖率阈值抖动                        | 不击穿：实测 lines 69.11 / stmts 67.54 / funcs 60.12 / branches 59.19 vs 阈值 68/66/59/58，最小余量 1.12pt；1pt ≈ 274 行 / 182 分支 / 301 语句，本次净增有效代码 <15 行且 `App.tsx` 在 coverage exclude 内 | T5 第 6 步；若 branches 掉幅 >0.05pt 说明新代码没被覆盖 → **回去补测试，禁止改阈值或扩 exclude**（`vitest.config.ts:93` 注释明令）         |
| e2e 不在 `npm test` 内                | N3c 接错不会被单测抓到                                                                                                                                                                                     | `npm run typecheck:e2e` 静态守卫 + 有链接机器人工复验 `-g N3c`                                                                             |
| pre-commit 钩子改写文件               | 钩子 `eslint --fix` + `prettier --write` 会二次暂存；`src/**/*.json` 在 prettier 作用域内                                                                                                                  | locale 写回严格用 `JSON.stringify(_, null, 2) + '\n'`；提交后 `git status --porcelain` 复核                                                |
| 页面标题与段①卡片标题都是「同步服务」 | 零新译约束下的必然结果（给段①另起标题需为 12 种语言新写文案，超出「迁移」范围）                                                                                                                            | 显式接受；产品否决则 T4 多写 12×1 条新译，另起 commit，不混进本次                                                                          |

## 9. 不改动清单（防止越界）

`src/main/**`（含 `preload/**`、`ipc/handlers/**`、`nikkisync/**`、`sync/**`、`database/**`）· `src/shared/types/electron-api.ts` · `docs/IPC_CONTRACT.md` · `package.json` 依赖 · `vitest.config.ts` 覆盖率阈值与 exclude · `Sidebar.tsx` 的 `navItems` · `uiStore` 的 `navigateTo`/`goBack`/`MULTI_SELECT_VIEWS` · `syncGalleryStore.ts` · `mediaStore.ts` · 12 包中除本次列明键以外的任何文案。

---

## 10. 执行记录（2026-10-16 完成）

### 10.1 基线与收口对照（现场实测，非引用计划预期）

| 校验                    | 基线（T0）                          | 收口（T5）                                               | 判定                                                                 |
| ----------------------- | ----------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------- |
| `npm test`              | 397 files / 6177 passed / 2 skipped | 397 files / 6177 passed / 2 skipped                      | 无新增失败                                                           |
| `npm run test:renderer` | 173 files / 2068 passed             | 176 files / 2094 passed                                  | +3 文件 / +26 用例                                                   |
| `npm run typecheck`     | 退出码 0                            | 退出码 0                                                 | 绿                                                                   |
| `npm run typecheck:e2e` | —                                   | 退出码 0                                                 | 绿                                                                   |
| `npm run lint`          | 0 errors / 11 warnings              | 0 errors / 11 warnings                                   | 警告为既有 DEBT-030（`components/common/*.test.tsx` 带 BOM），未新增 |
| `npm run i18n:guard`    | ✅                                  | ✅                                                       | 绿                                                                   |
| `npm run i18n:check`    | ✅ 3932 键对齐                      | ✅ 对齐                                                  | 绿                                                                   |
| `npm run verify`        | —                                   | 5 项全 ✓（typecheck / lint / core-gate / format / test） | 绿                                                                   |
| 覆盖率 lines            | 69.11                               | **69.25**                                                | ↑ 阈值 68                                                            |
| 覆盖率 statements       | 67.54                               | **67.68**                                                | ↑ 阈值 66                                                            |
| 覆盖率 functions        | 60.12                               | **60.34**                                                | ↑ 阈值 59                                                            |
| 覆盖率 branches         | 59.19                               | **59.26**                                                | ↑ 阈值 58                                                            |

四项覆盖率全部**上升**，未触碰阈值与 exclude。

### 10.2 每步红灯 → 绿灯实况

| 步  | 红灯（修复前实测）                                                                                                                                                                                                                                                                  | 绿灯                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| T1  | `App.view-registry.test.ts` 5 条结构断言全红（`ViewLevel 缺 'sync-service': expected [gallery, detail, editor, …(9)] to include`）；`sync-service-keys.test.ts` 2 红；`SyncServicePage.test.tsx` 红在 `Failed to resolve import "./SyncServicePage"`；`uiStore.test.ts` 新增组 1 红 | 5 文件 35 用例全绿；`Sidebar.test.tsx` 仍绿（证明未动 navItems）                     |
| T2  | 20 条全红（`Tests 20 failed (20)`）：(a)–(r) 因骨架页无控件、`SettingsPage.test.tsx` 因分组未删                                                                                                                                                                                     | 20 条全绿；`test:renderer` 176 files 全绿                                            |
| T3  | 7 条红（工具栏 2 条 + 页面 2 条 + i18n 3 条）                                                                                                                                                                                                                                       | `sync-gallery` + `i18n/locales` 57 用例全绿                                          |
| T4  | `sync-service-keys.test.ts` 8 条红（新键缺失 / 旧键残留 / 值未定位 / 插值丢失 / 披露断言）                                                                                                                                                                                          | 10 条全绿；**`PairingQrDialog.test.tsx` 一行未改却仍绿 = 12 包文案值零漂移的硬证据** |

红灯计数逐条留档，无「修复前就已通过」的假测试。

### 10.3 计划外发现并已处理（3 处）

1. **`tests/setup.ts` 的 electronAPI Proxy 不足以支撑整页渲染**：它对每次属性访问返回**新的** `vi.fn`，故 `electronAPI.settings.get` 取到 `undefined`；`general-sections.tsx:16` 的 `load()` 未被 await → 新写的 `SettingsPage.test.tsx` 以 unhandled rejection 炸掉整轮（`npm run test:renderer` 并行时侥幸不报，`npm run verify` 隔离跑必红）。修法：在该测试内显式装 `settings.get/set` 最小替身，**不改被测组件**（真实环境 preload 必装 settings）。
2. **结构断言的两个自坑点**：① `extractArrayLiteral` 起初用 `indexOf('[')` 会命中类型标注 `ViewLevel[]` 的方括号 → 改为锚 `'= ['`；② `VIEW_LEVEL_MAP` 的键混用 `gallery: 1` 与 `'sync-gallery': 1`，`toContain("'gallery'")` 会漏判 → 改为抠键名集合再比对。两处均在红灯阶段被自己的测试抓到并修掉。
3. **新页面缺宽度约束**：三段表单行不设上限会被拉满整窗（标签与控件隔空）。补 `mx-auto max-w-2xl`，沿用设置页口径。

### 10.4 真实界面核验（构建产物 + 浏览器）

`npm run dev` 无法用于核验：**5173 端口被另一检出的 dev server 占用**（`electron.vite.config.ts:158` 是 `strictPort: true`，本仓 dev 直接 abort；取该端口提供的 `Sidebar.tsx` 中 `sync-gallery` 命中数为 **0**，证明它服务的是别的代码）。改走 `npm run build` + 静态服务 5199 端口核验构建产物，结束后已停服并确认 5173 未受影响。

浏览器视口 403×553，低于应用 `minWidth: 900`（`window-manager.ts:57`），故对 shell 根节点强制 1400×900 后再看布局。实测确认：

- 侧边栏第 5 项为「同步图库」，进入后工具栏出现「同步服务」，**运行时「未启动」态下该按钮未禁用**；
- 点进去 → h2「同步服务」页头 + 三段 h3（同步服务 / 配对新设备 / 已配对设备）+ 三个开关 + 披露常驻 + 运行状态「同步组件未就绪」+ 设备空态；「配对新设备」按钮在未运行时为 disabled，符合设计；
- 侧边栏「返回」可回到同步图库；底部状态栏显示「同步服务」（非空白）；全程无裸 i18n key；
- 设置页左导航 9 个分组（通用/外观/扫描/角色档案/数据管理/日志与诊断/关于/工具/插件），**无「同步」分组与「同步服务」节**；
- 残留 `settings-active-section='sync-service'` 刷新后，设置页正常落在「启动行为」，不崩不白屏。

**未能在本环境验证的部分（如实声明）**：真实 Electron 窗口下的服务启停、二维码出图、设备撤销这三条依赖 `window.electronAPI` 的链路，浏览器静态产物里 preload 缺失、IPC 不可用；对应证据由 `e2e/nikkisync-runtime.e2e.ts` N3c（已改写导航段并通过 `typecheck:e2e`）覆盖，需在有 `npm run link:nikkisync` 链接且 28080 空闲的机器上跑 `npm run e2e:smoke -- -g N3c` 复验。

### 10.5 改动面

`git status` 计 32 项：2 个 `git mv`（`sync-sections.tsx(.test.tsx)` → `SyncServicePage.tsx(.test.tsx)`，rename 检测生效、blame 保留）、26 个修改、4 个新增（`App.view-registry.test.ts`、`sync-service-keys.test.ts`、`SettingsPage.test.tsx`、本计划文档）。12 个 locale 各改 114 行、增删对称。主进程 / preload / IPC 通道 / Runtime / 仓储层零改动，核心路径闸门 `@core-change` 无需授权注释即通过。

### 10.6 未做（按边界刻意不做）

- 不给 `SettingsPage` 的 `activeSection` 加自愈归一化（残留值只造成「左导航无高亮」的视觉瑕疵）；
- 不把 `SectionShell` 等 4 个原语从 `pages/settings/shared.tsx` 搬进 `components/common`（单一外部落点，搬迁要波及 10+ 文件 import）；
- 不给段①另起区别于页头的标题文案（需为 12 种语言新写，超出迁移范围）；
- 不写 `CHANGELOG` 的 `[Unreleased]` 条目（`check-changelog-release.ts` 会因 bullet 阻断打包）。
