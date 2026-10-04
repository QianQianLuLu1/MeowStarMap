# AGENTS.md — `src/renderer`（渲染进程）

本文件为 Agent 与新协作者提供 **渲染进程模块级** 速览与约定。顶层项目速览见根目录 [`AGENTS.md`](../../AGENTS.md)；五条硬性编码约定（IPC / AppError / CSS 变量 / 函数式组件 / 源文件编码）见 [`docs/CODING_CONVENTIONS.md`](../../docs/CODING_CONVENTIONS.md)（唯一真相源；IDE 的 always-on 规则文件仅为它的本地镜像）。本文件只补充 **本模块内** 的落地细节与目录导航，不重复规则原文。

## 模块概述

React 19 + TypeScript（strict）+ Zustand + Tailwind CSS 3 + i18next 的前端层，运行于 Electron 沙箱渲染进程（`nodeIntegration:false`、`sandbox:true`）。**所有与主进程的交互一律经 `window.electronAPI.*` 桥**，禁止 `import('electron')`、Node 模块或 `fetch` 外部 HTTP API（更新检查/分享等走主进程 handler）。

入口：`main.tsx` → `App.tsx`；另有独立预览入口 `preview-entry.tsx`（经 `vite.preview.config.ts` 构建）。

## 目录导航

- `pages/` — 页面级视图：Gallery、Detail、Editor、Duplicates、Categories、OutfitGallery、RecycleBin、ResonanceRecords、Settings
- `components/` — 按域分层：`common/`、`editor/`、`gallery/`、`layout/`、`resonance/`、`scanner/`、`video/`
- `stores/` — Zustand 全局状态（见下）
- `hooks/` — 自定义 Hook，文件名一律 `useXxx.ts`（如 `useIpcCall`、`useErrorToast`、`useFileOperations`、`useBatchOperations`、`useFilteredMediaFiles`）
- `styles/` — 全局样式与 **主题系统**（`styles/themes/`）
- `i18n/` — i18next 初始化与 `locales/*.json`
- `search/`、`preview/`、`plugins/`、`types/`、`utils/`、`assets/`、`icons/`

单元测试与源码同目录，命名 `*.test.ts(x)`（Vitest + jsdom，`npm run test:renderer`）。

## 1. 组件约定（函数式组件 + Hooks）

- 全部组件写成函数式组件，对齐现有格式：`export const Xxx: React.FC<XxxProps> = ({ ... }) => {...}`（`TitleBar.tsx`、`Sidebar.tsx`、`AppShell.tsx`、`MasonryView.tsx` 为范例）。**禁止新增 `class Xxx extends React.Component`。**
- Props 必须显式声明 `interface XxxProps` / `type XxxProps`，**禁止** `props: any`、禁止不带泛型的 `React.FC`。
- 状态：组件内局部 UI 状态用 `useState`，副作用/生命周期用 `useEffect`，引用用 `useRef`；跨组件共享状态一律走 Zustand（见第 2 节），**禁止 Redux、禁止用 Context 手搓全局 store**。
- 复杂数据变换不得写在 JSX 的内联三元/`&&` 里，抽为 `useMemo`。
- 可访问性：交互元素保留 `type="button"`；`label` 用 `id`/`htmlFor` 关联；自定义控件补 `role` 与 `aria-*`（范例：`pages/settings/shared.tsx` 的 `labelId`/`descId` 写法）。
- Memo/虚拟滚动：列表元素组件实测卡顿前不强制 `React.memo`；大数据视图复用现有 `VirtualImageGrid` / `MasonryView`，不另起虚拟列表。

## 2. 状态管理（Zustand，`stores/`）

- 用 `create<State>()(...)` 建立 store，命名 `useXxxStore`（如 `useMediaStore`、`useUIStore`、`useThemeStore`、`useResonanceStore`、`usePluginStore`、`useOperationHistoryStore`）。
- 需要持久化的状态用 `zustand/middleware` 的 `persist`，显式配置 `name`（storage key）与 `partialize`（只存必要字段）——范例见 `stores/themeStore.ts`（`name: 'wxnn-ui-theme'`，`partialize` 仅存 `theme`）。
- **跨 store 依赖方向要单向**：如 `mediaStore` 读 `uiStore` 状态时由 `mediaStore` 引 `uiStore`，被引方 **不得** 反向 import（历史上 `uiStore↔mediaStore` 循环依赖已通过 `C-S2` 从 `shared` 直接导入消除，改动前确认不复活循环依赖）。
- 与主进程共享的类型/枚举从 `../../shared/*` 导入（如 `SceneCategory`、`MediaFile` 相关契约），**禁止** 在渲染层跨边界 import 主进程模块。

## 3. 主题系统（CSS 变量优先）

- 主题注册中心：`styles/themes/index.ts` 定义 `UITheme` 联合类型、`themes: ThemeConfig[]`、`getThemeConfig()`。**新增主题两步**：① 在 `themes` 数组注册 `{ id, nameKey, className }`；② 添加同名 CSS 变量赋值文件（如 `styles/themes/soft-pink-luxury.css`）并在 `globals.css` 引入。主题切换通过 `document.documentElement` 上挂/摘 `className` 实现，切换逻辑在 `themeStore` 的 `applyThemeClass`（已按 `themes` 自动派生 className 列表，无需手动维护）。
- **主题变量块的选择器必须写 `html.<主题类>`**（如 `soft-pink-luxury.css` 的两个变量块）：主题文件经 `@import` 位于 `globals.css` 的 `:root` 之前，同特异性（0,1,0）下后源序的 `:root` 会整块压掉主题变量覆写；`html.` 前缀（0,1,1）保证变量真正生效。块内的 scoped 规则（`.soft-pink-luxury .glass-card` 等）特异性已足够，无需改动。
- 颜色/背景/边框/强调色 **必须** 走 CSS 变量或 `tailwind.config.ts` 已 extend 的 token（`accent`、`bg-primary/secondary/tertiary`、`text-primary/secondary/tertiary` 等，均映射到 `var(--*)`）。优先写 Tailwind 类名（`className="text-primary bg-tertiary"`）；仅动态计算/内联覆盖时用 `style={{ color: 'var(--text-primary)' }}`（见 `pages/settings/appearance-sections.tsx`、`tools-sections.tsx`）。
- **禁止**：硬编码 `#xxxxxx`/`rgb()`/`hsl()` 色值、在 tsx 里定义局部色值常量对象、用 `dark:` 前缀手写两套颜色（主题靠 CSS 变量重写，`dark:` 不适用）。允许例外须注释说明原因：缩略图/渐变上的纯白纯黑对比色、SVG/Canvas 内部色、仅限调试面板用的 Tailwind 灰色系。
- **设计令牌清单（视觉体系 v3，定义于 `globals.css :root`）**：
  - 表面/边框：`--surface-glass(-strong)`（玻璃面板渐变底色）、`--border-subtle/strong`（极细边框）、`--focus-ring`（输入聚焦光环）
  - 阴影：`--shadow-xs/sm/md/lg/xl`（多层冷灰蓝色调化阴影，双层结构 = 贴地 + 环境）
  - 圆角：`--radius-sm/md/lg/xl/pill`（Tailwind `rounded-*` 已全部映射到这些变量，勿再用 Tailwind 默认值语义理解）
  - 动效曲线：`--ease-standard/emphasized/decelerate/spring`（CSS 侧）；motion 侧统一走 `utils/motionPresets.ts`（含 `staggerContainer/staggerItem` 级联入场），禁止组件内硬编码
  - 间距：`--space-1/2/3/4/6/8`（4px 基）与既有语义 `--space-card-*`/`--space-nav-*`/`--space-toolbar-gap` 并存
  - 纹理：`--texture-grain`（内联 SVG 噪点 data-URI）+ `--grain-opacity`
  - 工具：`utils/cn.ts` 的 `cn()` 为类名拼接统一入口（零依赖）
- **基础组件（`components/common/`，新 UI 一律复用，不再手写等价结构）**：`Button`（变体/尺寸/loading）、`Switch`/`Checkbox`/`Select`（统一表单控件）、`SegmentedControl`（药丸切换，radiogroup 语义）、`Tooltip`（portal + 视口钳制，替代原生 `title`）、`Drawer`（侧滑抽屉）、`Progress`（确定/不定态）、`PageHeader`（统一页头）、`FloatingActionBar`（底部浮动操作栏）、`FormField`（label 上置 + helper/error + aria 关联）、`ToastProvider`（全局 Toast Context，`pages/settings/shared.tsx` 仅保留 re-export）。
- **氛围层**（`AppShell` 内 `.ambient-bg`，全局唯一实例）：环境光斑（`.ambient-blob-*`）+ 漂浮几何体（`.ambient-shape-*`）+ 颗粒纹理（`.ambient-grain`）。用户可经设置开关（`display.ambientGrain`/`display.ambientShapes`，App.tsx 启动时挂 `html.grain-off`/`html.shapes-off`）独立关闭；`html.glass-lite` 与 `prefers-reduced-transparency` 整层隐藏，`reduce-motion` 下动画静止。改动氛围层时必须维持这条降级链。
- **性能红线**：虚拟列表（Virtuoso/masonic/VirtualImageGrid）内禁逐项入场动画；动效仅限 transform/opacity；毛玻璃容器避免 `filter`（会破坏子级 backdrop-filter）。

## 4. i18n 使用（`i18n/`）

- 组件内用 `react-i18next` 的 `const { t } = useTranslation()` 取翻译；**禁止** 硬编码用户可见文本。
- 中文 `zh-CN` 为基准语言静态加载，其余 12 种语言（`en`/`ja`/`ko`/`fr`/`de`/`es`/`pt`/`ru`/`th`/`vi`/`zh-TW`，含 `auto`）经 `import()` 动态加载以拆分 chunk；语言偏好持久化到 `localStorage`，`'auto'` 跟随 `navigator.language`。对外 API：`SUPPORTED_LANGUAGES`、`changeLanguage`、`getCurrentLanguage`、`detectSystemLanguage`。
- 新增/修改文案 key 后运行 `npm run i18n:guard` 校验缺失键；提交信息涉及 i18n key 新增需在 PR 描述登记。
- `AppError` 的 UI 展示文案经 `extractUserMessage(error)`（`shared/errors/app-error.ts`）获取，`useErrorToast` 钩子已封装此优先级（`userMessage` > `message` > `String(error)` > 兜底翻译），业务代码直接复用 `useErrorToast`，`SUPPORTED_LANGUAGES` 中的语言 endonym（自称名）按国际惯例不翻译，属有意豁免。

## 5. 与主进程交互（IPC 调用侧）

- 通过 `window.electronAPI.<namespace>.<method>` 调用；必须 `try/catch`，并用 `err instanceof window.IpcError` 或 `AppError` 类型守卫做分支处理。
- **注意双层 `success` 结构**：主进程 `wrapHandler` 包为 `IpcResponse<T>`，preload 的 `call<T>()` **只透出 `res.data`**，外层 `success` 被丢弃——渲染层拿到的 `res` 即 handler 的原始返回对象。若前端要检查 `res.success`，须确认对应 handler 真的返回了 `success: true` 字段（见 `docs/IPC_CONTRACT.md` §2 通道清单），否则改用 `try/catch` + `IpcError` 判断。
- 复用 `hooks/useIpcCall.ts`（统一调用/解包）与 `hooks/useErrorToast.ts`（统一错误展示），不在组件内手写重复的调用/错误样板。
- 修改任何通道名 / `electronAPI` 方法签名 / `IpcResponse`·`IpcError` 结构时，**必须** 同步更新顶层 `docs/IPC_CONTRACT.md` 并保持向后兼容。
