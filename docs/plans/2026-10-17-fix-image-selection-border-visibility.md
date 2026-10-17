# 修复图库卡片选中态边框不显眼（2026-10-17）

## 1. 依赖声明

**新增/变更依赖：零新增。**

- 不引入任何第三方 UI 库、动画库或 CSS-in-JS 方案。
- 不新增 npm 依赖、不改 `package.json` 的 dependencies/devDependencies。
- 复用的现有 CSS / UI 基础设施（均已实测存在）：
  - `src/renderer/styles/globals.css`：`.media-card` 卡片基类（L1239–1270）、`:root` 主题变量体系（L13–122）、`html.reduce-motion` 动效减弱覆盖（L192–199）。
  - `src/renderer/styles/themes/soft-pink-luxury.css`：柔粉主题覆盖（`.soft-pink-luxury .media-card:hover::after`，L244–260）。
  - `tailwind.config.ts`：`theme.extend` 的 colors / borderRadius / boxShadow / animation / transitionTimingFunction 令牌。
  - CSS 原生 `transition`（160ms ease-out）+ 既有 `--accent*` / `--bg-*` / `--shadow-*` 变量，不使用额外动画方案。

## 2. 视觉与交互设计

### 2.1 缺陷根因

| #   | 根因                                                                                                                                   | 证据                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| R1  | `ring-offset-2` 的偏移色只设了 `--tw-ring-color`，未设 `--tw-ring-offset-color`，Tailwind 默认偏移色恒为 `#fff`                        | 四视图均只写 `{'--tw-ring-color': 'var(--accent)'}`     |
| R2  | 选中态用 `ring`（宿主 box-shadow）绘制，hover 态用 `.media-card:hover::after` 的 `border` 绘制，两套机制叠加时互相吞没，选中态失去层次 | `globals.css` L1252 与 `VirtualImageGrid.tsx` L501 对照 |
| R3  | `globals.css` 中 `.media-card` 完全没有选中态规则，选中样式散落在组件内联，无法被主题覆盖                                              | `globals.css` L1239–1270 无 `:selected`/`is-selected`   |
| R4  | `tailwind.config.ts` 的 `theme.extend` 无 `ringColor` / `ringOffsetColor`，裸用 `ring-2` 恒为默认蓝 `#3b82f6`，不跟随主题              | `tailwind.config.ts` L6–63                              |

### 2.2 设计策略

**把 hover 与 selected 统一到同一条常驻 `::after` 描边层，只过渡颜色，杜绝伪元素闪现与布局抖动。**

原实现中 `::after` 只在 `:hover` 时通过 `content` 生成；选中/取消时若沿用该写法会出现「content 从无到有」的瞬变。改为**常驻 `::after` + `border-color: transparent`**，hover/selected 只切换颜色与阴影，过渡为纯颜色插值。

### 2.3 选中态视觉规格

| 层         | 声明                                                                                                  | 作用                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 外发光层   | `box-shadow: var(--shadow-lg, 0 4px 20px rgba(0,0,0,.15)), 0 0 0 3px var(--accent-soft, transparent)` | 主题色 12% 透明度 3px 外扩光晕，让选中卡片从网格背景「浮起」                              |
| 主题色描边 | `::after { border-color: var(--accent); border: 2px solid }`                                          | 与 hover 同层同宽，但颜色与内衬叠加后层次更重                                             |
| 内衬分隔线 | `::after { box-shadow: inset 0 0 0 2px var(--bg-primary, #fff) }`                                     | 描边内侧 2px 背景色衬线，形成「主题色–背景色–图片」双线框，亮底/暗底/柔粉底均有稳定对比度 |
| 阴影加深   | 宿主 `var(--shadow-lg)`                                                                               | 与 hover 同档阴影，但叠加外发光后观感更重                                                 |
| 过渡       | `transition: border-color 160ms ease-out, box-shadow 160ms ease-out`                                  | 仅过渡颜色与阴影（合成友好），**不做 transform 缩放**                                     |
| hover 叠加 | `.media-card.is-selected:hover::after { border-color: var(--accent-deep, var(--accent)) }`            | 选中卡悬停时描边加深一档，保留「选中 ≠ 悬停」的层次区分                                   |

**关键取舍**：`.is-selected` 不加 `transform: scale()`。`.media-card:hover` 已有 `transform: scale(1.02)`，缩放叠加会在虚拟网格滚动时造成抖动与相邻卡片重叠；视觉层次改由「描边 + 内衬 + 阴影 + 外发光」四层承担。

### 2.4 主题适配（亮/暗）

- 全部颜色走 CSS 变量：`--accent` / `--accent-soft` / `--accent-deep` / `--bg-primary` / `--shadow-lg`。
- 当前仓库只有 `default`（浅色，`--accent: #0078d4`、`--bg-primary: #f5f5f5`）与 `soft-pink-luxury`（柔粉，`rgba(226,164,188,.55)`）两个主题（`themeStore.ts` 在 `<html>` 上挂类名切换，**不存在暗色主题**）。
- 本次**不新增暗色主题文件**（超出视觉优化范围）。因选中态不写死任何颜色字面量，未来新增暗色主题只需重写 `--accent*` / `--bg-primary` 即可自动适配，等价于「暗色就绪」。
- `soft-pink-luxury.css` 补一条 `.soft-pink-luxury .media-card.is-selected::after`，沿用该主题已有的粉色语言。
- `html.reduce-motion` 下 `transition-duration: 0.01ms !important` 已由 `globals.css` L192–199 的 `*::after` 通配覆盖，新增过渡自动降级，无需额外规则。

## 3. 启动与验证说明

### 3.1 环境准备

工作目录：`d:/Zcode项目/WXNN YD - 副本/WXNN XiangCe`（`package.json` name = `wxnn-photo-manager`）。
依赖已安装（本机 npm 有 Safe-Delete 网关，禁止 `npm ci`，如需补依赖只用 `npm install`）。

### 3.2 命令（均为仓库真实存在）

| 目的           | 命令                                                              |
| -------------- | ----------------------------------------------------------------- |
| 单文件测试     | `npx vitest run src/renderer/styles/media-card-selection.test.ts` |
| 渲染器子集     | `npm run test:renderer`                                           |
| 全量测试       | `npm test`                                                        |
| 静态检查       | `npm run lint`                                                    |
| 类型检查       | `npm run typecheck`                                               |
| Storybook 手验 | `npm run storybook`（端口 6006）                                  |
| Dev 手验       | `npm run dev`                                                     |

### 3.3 视觉验证方式

1. **Storybook（主）**：`npm run storybook` → `Gallery/VirtualImageGrid` → `WithSelection`（已存在，`selectedIds: ['1','3']`）与新增的 `WithMultiSelect`（`multiSelectMode: true`）。用 Storybook 工具栏的 theme 装饰器（`.storybook/decorators/theme.tsx`）在 default / soft-pink-luxury 两主题下分别查看。
2. **Dev 模式（辅）**：`npm run dev` → 图库页进入多选模式，切换网格 / 时间线 / 事件时间线 / 瀑布流四个视图，逐一确认选中态。
3. 验收点：
   - 选中卡片在 default 与 soft-pink-luxury 下描边均清晰可见（不再有白色偏移圈）。
   - 选中/取消选中过渡平滑，无闪烁、无相邻卡片抖动。
   - 网格快速滚动时无卡顿（本次不新增 DOM 节点、不新增合成层、`will-change` 不入场）。
   - 选中态与 hover 态可区分（hover 在选中卡上描边加深一档）。

## 4. 子任务清单（TDD 节点）

### Node 0 — 计划落盘

- 文件：本文档 `docs/plans/2026-10-17-fix-image-selection-border-visibility.md`
- 验收：文件存在且含以下六段结构。

### Node 1 — `globals.css` 选中态样式

| 项                 | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 修改文件           | `d:/Zcode项目/WXNN YD - 副本/WXNN XiangCe/src/renderer/styles/globals.css`、`.../src/renderer/styles/themes/soft-pink-luxury.css`                                                                                                                                                                                                                                                                                                                                                                        |
| 新测试             | `d:/Zcode项目/WXNN YD - 副本/WXNN XiangCe/src/renderer/styles/media-card-selection.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                              |
| 输入               | 无（纯 CSS）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 输出               | 新增 `.media-card::after` 常驻透明描边层；`.media-card:hover::after` 改为只切 `border-color`；新增 `.media-card.is-selected` / `.media-card.is-selected::after` / `.media-card.is-selected:hover::after`；`soft-pink-luxury.css` 补主题覆盖                                                                                                                                                                                                                                                              |
| 验收标准（可判定） | ① 结构断言 `.media-card.is-selected` 规则体包含 `var(--accent-soft`；② 结构断言 `.media-card.is-selected::after` 规则体包含 `border-color: var(--accent)` 且包含 `inset 0 0 0 2px var(--bg-primary`；③ 结构断言 `.media-card::after` 规则体包含 `border: 2px solid transparent` 与 `transition:`；④ 结构断言 `.media-card.is-selected:hover::after` 规则体包含 `var(--accent-deep`；⑤ 结构断言 `.soft-pink-luxury .media-card.is-selected::after` 规则体存在；⑥ 既有 `layer-budget.test.ts` 三条断言全绿 |
| 红灯构造           | 先写测试并在**未改 CSS 前**运行，①–⑤ 全部失败                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### Node 2 — `tailwind.config.ts` ring 令牌

| 项       | 内容                                                                                                                                                                                                                        |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 修改文件 | `d:/Zcode项目/WXNN YD - 副本/WXNN XiangCe/tailwind.config.ts`                                                                                                                                                               |
| 新测试   | 同 `src/renderer/styles/media-card-selection.test.ts` 增补用例                                                                                                                                                              |
| 输入     | 无                                                                                                                                                                                                                          |
| 输出     | `theme.extend.ringColor = { DEFAULT: 'var(--accent)', accent: 'var(--accent)', 'accent-soft': 'var(--accent-soft)' }`；`theme.extend.ringOffsetColor = { DEFAULT: 'var(--bg-primary)' }`                                    |
| 验收标准 | ① 导入配置对象断言 `ringColor.DEFAULT === 'var(--accent)'`；② `ringOffsetColor.DEFAULT === 'var(--bg-primary)'`；③ grep 全量 `ring-` 用法确认 `CategoriesPage.tsx:679`、`ShareCodeDecoderDialog.tsx:126` 为显式指定不受影响 |
| 红灯构造 | 未改配置前 `ringColor` 为 `undefined`，断言失败                                                                                                                                                                             |

### Node 3 — 四视图改用语义类

| 项       | 内容                                                                                                                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 修改文件 | `src/renderer/components/gallery/VirtualImageGrid.tsx`（L499–511）、`TimelineView.tsx`（L193–205）、`EventTimelineView.tsx`（L284–296）、`MasonryView.tsx`（L76–85）                                                              |
| 新测试   | `src/renderer/components/gallery/media-card-selection.test.tsx`                                                                                                                                                                   |
| 输入     | Props 不变（`selectedIds` / `multiSelectMode` / `onToggleSelection` 保持原签名）                                                                                                                                                  |
| 输出     | className 计算逻辑：`${isSelected ? 'ring-2 ring-offset-2' : ''}` → `${isSelected ? 'is-selected' : ''}`；删除内联 `--tw-ring-color` 扩展；VirtualImageGrid 的焦点 `outline` / `outlineOffset` 保持不变                           |
| 验收标准 | ① 四文件源码结构断言：不含 `ring-offset-2`、不含 `--tw-ring-color`、含 `is-selected`；② MasonryView 渲染级断言：选中卡片 `className` 含 `is-selected`，未选中不含，且均不含 `ring-offset`；③ `aria-selected` 仍为 true/false 正确 |
| 红灯构造 | 未改码前①（含 `ring-offset-2`）与②（无 `is-selected`）均失败                                                                                                                                                                      |

### Node 4 — Storybook 手验 story

| 项       | 内容                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| 修改文件 | `src/renderer/components/gallery/VirtualImageGrid.stories.tsx`                                                  |
| 输出     | 新增 `WithMultiSelect` story（`multiSelectMode: true` + `onToggleSelection: fn()`）                             |
| 验收标准 | `npm run storybook` 起服务，`Gallery/VirtualImageGrid` 下 `WithSelection` 与 `WithMultiSelect` 可正常渲染与交互 |

### Node 5 — 全局回归

- 命令：`npm test`、`npm run lint`、`npm run typecheck`
- 验收：与基线（见第 6 节矩阵）相比无新增失败项；新增用例全绿。

## 5. 错误处理与降级

| 场景                                     | 兜底策略                                                                                                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--accent-soft` 缺失（自定义主题未定义） | `box-shadow` 的外发光段写为 `var(--accent-soft, transparent)`，变量缺失时光晕退化为透明，描边与内衬仍在（声明分离，不会整条失效）                          |
| `--bg-primary` 缺失                      | 内衬写为 `var(--bg-primary, #fff)`，退化为白色衬线                                                                                                         |
| `--shadow-lg` 缺失                       | 宿主阴影写为 `var(--shadow-lg, 0 4px 20px rgba(0,0,0,.15))`                                                                                                |
| `--accent-deep` 缺失                     | hover 叠加态写为 `var(--accent-deep, var(--accent))`                                                                                                       |
| 图片加载失败 / 缩略图 404                | `::after` 描边绘制在宿主卡片上，与 `<img>` 是否加载成功无关；`MediaThumbPlaceholder` / `CorruptedBadge` 仍居中显示且不被描边遮挡（`pointer-events: none`） |
| 损坏 / 丢失文件（`opacity: 0.45`）       | 描边为独立伪元素层，不受宿主 `opacity` 之外的裁剪影响，选中仍可辨                                                                                          |
| 极小卡片（如 40px）                      | 描边 2px + 内衬 2px 固定像素不随尺寸缩放，小卡占比偏高但仍完整可见；不使用 `em`/百分比避免失真                                                             |
| 极大卡片 / 瀑布流超高卡片                | `::after` 为 `inset: 0` + `border-radius: inherit`，随宿主尺寸自适应，无需额外规则                                                                         |
| 多选重叠（相邻卡片同时选中）             | 外发光为 3px 外扩 box-shadow，不参与布局、不触发重排；相邻选中卡光晕叠加但不遮挡描边                                                                       |
| 动效减弱                                 | `globals.css` L192–199 `html.reduce-motion *::after { transition-duration: 0.01ms !important }` 已覆盖，无需新增规则                                       |
| 样式加载失败（CSS 未注入）               | 降级为无选中描边，`aria-selected` 与 `MediaCheckbox`（`role="checkbox" aria-checked`）仍提供无障碍层面的选中标识                                           |
| 图层预算                                 | 新增规则**不得**引入 `will-change`（`layer-budget.test.ts` 硬性约束，虚拟网格同屏上百卡片）                                                                |

## 6. 基础测试用例矩阵

测试文件：

- `src/renderer/styles/media-card-selection.test.ts`（node 环境，CSS + Tailwind 令牌源码结构断言）
- `src/renderer/components/gallery/media-card-selection.test.tsx`（jsdom，MasonryView 渲染级 + 四视图源码结构断言）

| 类别 | 用例                                         | 断言要点                                                                                                         |
| ---- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 正常 | 未选中卡片无选中样式                         | `className` 不含 `is-selected`，`aria-selected="false"`                                                          |
| 正常 | 选中卡片带选中语义类                         | `className` 含 `is-selected`，`aria-selected="true"`                                                             |
| 正常 | `.media-card.is-selected` 外发光规则         | 规则体含 `var(--accent-soft`                                                                                     |
| 正常 | `.media-card.is-selected::after` 描边 + 内衬 | 含 `border-color: var(--accent)` 与 `inset 0 0 0 2px var(--bg-primary`                                           |
| 正常 | 常驻描边层存在且透明                         | `.media-card::after` 含 `border: 2px solid transparent` 与 `transition:`                                         |
| 正常 | Tailwind ring 令牌                           | `ringColor.DEFAULT === 'var(--accent)'`、`ringOffsetColor.DEFAULT === 'var(--bg-primary)'`                       |
| 正常 | 四视图不再使用临时 ring 拼装                 | 四文件均不含 `ring-offset-2` 与 `--tw-ring-color`，且含 `is-selected`                                            |
| 正常 | 多选勾选框仍可用                             | `data-testid="media-checkbox"` 的 `aria-checked` 随选中态切换                                                    |
| 异常 | 主题切换                                     | `soft-pink-luxury.css` 存在 `.soft-pink-luxury .media-card.is-selected::after` 覆盖规则                          |
| 异常 | 主题变量缺失降级                             | CSS 源码中 `--accent-soft` / `--bg-primary` / `--shadow-lg` / `--accent-deep` 引用均带 `var(…, fallback)` 兜底值 |
| 异常 | 图片加载失败                                 | `MediaThumbPlaceholder` 存在时，卡片仍带 `is-selected` 且描边层 `pointer-events: none`（源码断言）               |
| 异常 | 动效减弱                                     | 新规则不引入 `will-change`；过渡由 `html.reduce-motion *::after` 通配覆盖                                        |
| 边界 | 极小/极大卡片                                | `::after` 为 `inset: 0` + `border-radius: inherit`，尺寸无关（源码断言）                                         |
| 边界 | 多选重叠                                     | 选中态不含 `transform: scale(`，避免相邻卡片抖动与重叠                                                           |
| 边界 | hover 与选中叠加                             | `.media-card.is-selected:hover::after` 含 `var(--accent-deep`，与纯 hover 态可区分                               |
| 边界 | 图层预算回归                                 | `.media-card` 规则体不含 `will-change`；`.media-card:hover` 仍含 `transform: scale(`                             |

### 基线记录

执行前先跑一次 `npm test` 记录通过/失败数作为基线，所有新增失败项必须归零后才可收尾。

## 7. 执行结果（TDD 闭环实录）

| 节点                 | 红灯                                                                        | 改码                                                                                                                   | 绿灯                                                                           |
| -------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Node 1 计划落盘      | —                                                                           | `docs/plans/2026-10-17-fix-image-selection-border-visibility.md`                                                       | 文件已落盘                                                                     |
| Node 2 CSS 选中态    | `media-card-selection.test.ts` **11 failed / 0 passed**（先跑测试确认全红） | `globals.css` 新增 `.media-card::after` 常驻描边层 + `.media-card.is-selected` 系列；`soft-pink-luxury.css` 补主题覆盖 | 11 passed                                                                      |
| Node 3 Tailwind 令牌 | 新增 3 条令牌断言 → **3 failed**                                            | `tailwind.config.ts` 补 `ringColor` / `ringOffsetColor`                                                                | 14 passed                                                                      |
| Node 4 四视图        | `media-card-selection.test.tsx` **12 failed / 0 passed**                    | 四视图 `ring-2 ring-offset-2` → `is-selected`，删除内联 `--tw-ring-color`                                              | 12 passed（相关子集 62 passed）                                                |
| Node 5 Storybook     | —                                                                           | 新增 `WithMultiSelect` story                                                                                           | `npm run storybook` 起服务并预览 `gallery-virtualimagegrid--with-multi-select` |
| Node 6 全局回归      | —                                                                           | —                                                                                                                      | 见下                                                                           |

### 回归数据

| 检查                | 基线                                     | 修复后                                                               |
| ------------------- | ---------------------------------------- | -------------------------------------------------------------------- |
| `npm test`          | 405 files / **6262 passed** \| 2 skipped | 407 files / **6288 passed** \| 2 skipped（+2 文件 +26 用例，0 失败） |
| `npm run typecheck` | 通过                                     | 通过                                                                 |
| `npm run lint`      | 0 error / 11 warning（既有 BOM）         | 0 error / 11 warning（无新增）                                       |
| `npm run audit`     | Passed（既有 allowlist）                 | Passed（零新增依赖，无新增供应链面）                                 |

### 改动清单

- 新增：`src/renderer/styles/media-card-selection.test.ts`、`src/renderer/components/gallery/media-card-selection.test.tsx`、本文档
- 修改：`src/renderer/styles/globals.css`、`src/renderer/styles/themes/soft-pink-luxury.css`、`tailwind.config.ts`、`VirtualImageGrid.tsx`、`TimelineView.tsx`、`EventTimelineView.tsx`、`MasonryView.tsx`、`VirtualImageGrid.stories.tsx`
- 依赖变更：**无**
