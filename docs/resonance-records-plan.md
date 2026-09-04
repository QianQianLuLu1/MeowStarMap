# 实施计划：左侧菜单新增「共鸣录」占位板块

## 1. 需求概述

在左侧菜单栏「收藏」（`favorites`）与「缓存」（`launcher-cache`）之间，新增「共鸣录」（`resonance-records`）导航项。点击后进入一个**占位页面**，当前不含任何业务内容，仅居中展示四段固定文案：

- 品牌：`无限暖暖`
- 板块名：`暖暖共鸣录`
- 功能描述：`无限暖暖共鸣记录与搭配助手`
- 状态：`即将上线`

即整体呈现：`无限暖暖 暖暖共鸣录 无限暖暖共鸣记录与搭配助手 即将上线`。

## 2. 依赖声明

| 依赖                        | 来源                                            | 说明                                    |
| --------------------------- | ----------------------------------------------- | --------------------------------------- |
| `react` / `react-dom`       | 项目既有                                        | 无需新增                                |
| `react-i18next` / `i18next` | 项目既有                                        | 复用 `t()` 与现有 locale 文件，无需新增 |
| `EmptyState` 组件           | `src/renderer/components/common/EmptyState.tsx` | 复用既有空态 UI，不新写样式             |
| `IconMessage` 图标          | `src/renderer/icons/index.tsx`                  | 复用既有图标，禁止新建 SVG              |
| Vitest + RTL                | `devDependencies`                               | 复用既有测试基础设施，无需新增          |

**结论：本次改动零新增依赖（no new npm package）。**

## 3. 启动说明

```bash
# 开发预览（Electron 渲染进程）
npm run dev

# 类型检查
npx tsc --noEmit

# 单元测试（仅本次新增用例）
npx vitest run src/renderer/pages/ResonanceRecordsPage.test.tsx

# 全量单元测试
npx vitest run
```

> 注：本机存在 Safe-Delete 网关限制，构建/全量 `npm ci` 受限，但 `npm run dev`、`npx vitest`、`npx tsc` 均不受影响。

## 4. 错误处理

- **i18n 缺失兜底**：`react-i18next` 在键缺失时回退为键名（如 `resonance.title`），不会崩溃；本计划在全部 12 个 locale 补齐键，避免任一语言显示键名。
- **懒加载失败兜底**：`App.tsx` 中 `ResonanceRecordsPage` 经 `lazy()` 加载，外层已包裹 `ErrorBoundary` + `Suspense`（`PageFallback`），chunk 加载失败由既有错误边界兜底。
- **渲染容错**：`EmptyState` 对 `title`/`subtitle` 为空有默认渲染分支（`displayTitle` 兜底为空串仍渲染 `<p>`），传入文案恒非空，无空指针风险。
- **IPC 无关**：该页为纯静态占位，不触达 `mediaStore` / `useFilteredMediaFiles` 的 favorites/cache 过滤分支，无数据库/IPC 调用，零运行时错误面。

## 5. 参数校验

- **类型级校验（编译期）**：`ViewLevel` 为 `string` 字面量联合类型，`navigateTo(view: ViewLevel)` 仅接受合法成员；新增 `'resonance-records'` 后仍由 TS 在编译期强制约束，调用方传入非法值直接编译失败。
- **导航守卫（运行时）**：既有 `navigateTo` 实现已含去重守卫：
  ```ts
  navigateTo: (view) => {
    const { viewStack } = get()
    if (viewStack[viewStack.length - 1] !== view) {
      set({ currentView: view, viewStack: [...viewStack, view] })
    }
  }
  ```
  重复点击「共鸣录」不会重复压栈，状态稳定。
- **路由注册校验（编译期）**：`App.tsx` 中 `ALL_VIEWS: ViewLevel[]` 与 `VIEW_LEVEL_MAP: Record<ViewLevel, number>` 为全量枚举，新增成员若遗漏注册会在 `tsc` 阶段报错，迫使两处同步注册。

## 6. 基础测试用例

文件：`src/renderer/pages/ResonanceRecordsPage.test.tsx`

- 用例 1（渲染四段文案）：渲染 `<ResonanceRecordsPage />`，断言以下文本节点均存在：
  - `无限暖暖`（品牌行）
  - `暖暖共鸣录`（EmptyState 主标题）
  - `无限暖暖共鸣记录与搭配助手 即将上线`（EmptyState 副标题）
- 用例 2（无控制台错误）：渲染时不抛出、无未捕获错误。
- 用例 3（图标渲染）：`IconMessage` 图标节点被渲染（通过 `EmptyState` 的 icon 容器断言存在图标元素）。

## 7. 子任务清单（每项含：修改文件 / 输入输出 / 验收标准）

### 子任务 A：扩展视图类型

- **修改文件**：`src/renderer/stores/uiStore.ts`
- **输入**：`ViewLevel` 联合类型（第 29-39 行）。
- **输出**：联合类型新增 `'resonance-records'`。
- **验收**：`npx tsc --noEmit` 通过；`navigateTo('resonance-records')` 类型合法。

### 子任务 B：侧边栏新增菜单项

- **修改文件**：`src/renderer/components/layout/Sidebar.tsx`
- **输入**：`navItems` 数组（第 32-41 行）与图标导入（第 9-22 行）。
- **输出**：导入 `IconMessage`；在 `favorites` 与 `launcher-cache` 间插入 `{ id: 'resonance-records', labelKey: 'nav.resonanceRecords', icon: <IconMessage size={20} /> }`。
- **验收**：`npx tsc --noEmit` 通过；`npm run dev` 后菜单在「收藏」下方出现「共鸣录」图标+文字（折叠态仅图标）。

### 子任务 C：路由注册

- **修改文件**：`src/renderer/App.tsx`
- **输入**：`lazy` 导入区、`ALL_VIEWS`（75-86）、`VIEW_LEVEL_MAP`（90-101）、`renderPage` switch（266-294）。
- **输出**：新增 `ResonanceRecordsPage` 懒加载；`ALL_VIEWS` 与 `VIEW_LEVEL_MAP` 加入 `'resonance-records': 1`；`renderPage` 新增 `case 'resonance-records': return <ResonanceRecordsPage />`。
- **验收**：`npx tsc --noEmit` 通过；点击菜单项能挂载 `ResonanceRecordsPage`（不再回退到 `GalleryPage`）。

### 子任务 D：占位页面组件

- **新建文件**：`src/renderer/pages/ResonanceRecordsPage.tsx`
- **输入**：`EmptyState` + `IconMessage` + i18n 键 `resonance.{brand,title,subtitle}`。
- **输出**：渲染品牌行 + `EmptyState`（icon/title/subtitle），四段文案完整。
- **验收**：`npx tsc --noEmit` 通过；`ResonanceRecordsPage.test.tsx` 用例 1/2/3 通过。

### 子任务 E：i18n 键补齐（12 语言）

- **修改文件**：`src/renderer/i18n/locales/{zh-CN,zh-TW,en,ja,ko,de,fr,es,pt,ru,th,vi}.json`
- **输入**：各文件 `nav` 对象与顶层结构。
- **输出**：`nav.resonanceRecords` 各语言翻译；顶层新增 `resonance.{brand,title,subtitle}` 四段文案。
- **验收**：`npx tsc` 通过；JSON 合法（`node -e` 校验）；12 文件均含 `resonanceRecords` 键。

### 子任务 F：状态栏标题同步

- **修改文件**：`src/renderer/components/layout/AppShell.tsx`
- **输入**：`getViewStatusLabel` switch（第 71-116 行）。
- **输出**：新增 `case 'resonance-records': rightText = t('nav.resonanceRecords')`。
- **验收**：`npx tsc --noEmit` 通过；进入该视图时状态栏右侧显示「共鸣录」。

### 子任务 G：单元测试

- **新建文件**：`src/renderer/pages/ResonanceRecordsPage.test.tsx`
- **输入**：`ResonanceRecordsPage` 组件与既有 i18n 测试环境（`tests/setup.ts` 默认 zh-CN）。
- **输出**：3 个用例（见第 6 节）。
- **验收**：`npx vitest run src/renderer/pages/ResonanceRecordsPage.test.tsx` 全绿。

### 子任务 H：端到端验证

- **输入**：以上全部改动。
- **输出**：类型检查 + 单测 + 启动自测。
- **验收**：
  1. `npx tsc --noEmit` 通过；
  2. `npx vitest run` 全量通过（含新增用例）；
  3. `npm run dev` 启动后点击「共鸣录」，主区居中显示四段文案、无控制台报错、状态栏标题正确、折叠/展开态均正常。

## 8. 验证纪律

- 每段代码**仅审查一次**，审查项具体到：类型是否通过、键是否补齐、用例是否覆盖四段文案、控制台是否报错；无严重缺陷即推进。
- 每步**先验证通过再进入下一步**，报错当即在当前步修复（如 JSON 非法、tsc 报错、用例失败）。
- 不循环指派重复验证同一产出。
