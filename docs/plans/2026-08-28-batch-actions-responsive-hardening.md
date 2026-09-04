# 底部批量操作栏「字体显示不全」响应式加固实施计划

- 创建日期：2026-08-28
- 关联计划：`docs/plans/fix-batch-actions-text-clipping.md`(2026-08-26)、`docs/plans/fix-batch-actions-responsive-clipping.md`(2026-08-28)
- 关联提交：`034388e fix(gallery): 底部批量操作栏按钮文字截断自适应`、`320c4ea fix(renderer): 修复 Masonry 重叠与批量操作文本截断`

## 0. 用户需求

分析并修复「图库板块单击图片后，底部居中弹出的批量操作浮动工具栏（BatchActions）中字体无法完整显示」的问题；并补充覆盖**不同分辨率、屏幕尺寸、窗口宽度与系统缩放（125%/150%/175%）**场景的响应式优化，确保常见显示环境中文字不被截断、遮挡、溢出、不可见，且横向溢出时滚动条可被用户察觉。

执行约束：

1. 只修改与该问题直接相关的样式、布局、响应式逻辑和必要测试；严禁顺带重构、调整或影响无关功能。
2. 优先复用项目现有组件、样式系统、Tailwind/CSS 能力，以及 GitHub 等开源平台已有的成熟工具栏或响应式方案，避免从零自行编写复杂逻辑。
3. 如必须自行实现，应保持代码最小化，并优先复用现有代码、现有设计模式和已有测试方式。
4. 开始任何代码改动前，先制定本 MD 实施计划文档并保存至项目文档目录，计划内容确认后再执行。

## 1. 现状分析（基线，已审阅源码 + git log 确认）

既有根因修复已提交并落地（非本次新建）：

- **`.icon-btn.batch-act-btn`**（src/renderer/styles/globals.css 约 L407，特异性 (0,2,0)）覆盖 `.icon-btn` 的 `width:36px` 与 `overflow:hidden` → 按钮随中文标签自适应、文字不被裁（改为 `width:auto; min-width:36px; flex-shrink:0; overflow:visible`）。
- **容器 `flex-nowrap overflow-x-auto batch-actions-root max-w-[calc(100vw-32px)]`**（BatchActions.tsx L68）→ 单行滚动 + 细滚动条 + 超宽屏上限。
- **`.batch-actions-root`**（globals.css 约 L429）常驻 4px 细滚动条（Firefox thin + WebKit 4px），hover 加深；`bottom:44px` 留白防裁切。
- **响应式降级 `@media (max-width:960px)` 与 `@media (max-width:640px)`**（globals.css 约 L457 / L463）隐藏 `.batch-act-label`，仅留图标（title / aria-label 保留语义）——覆盖缩放（CSS px 断点：1920@150%→1280px、1440@150%→960px 等均落入图标态）。
- 各文字按钮标签包裹 `.batch-act-label`；ShareMenuButton 分享标签亦包裹（ShareMenuButton.tsx L68）。
- 测试/故事已覆盖：BatchActions.test.tsx T01–T13（含 T02 容器 overflow-x-auto/flex-nowrap/batch-actions-root/max-w、T11/T12 分享 label=batch-act-label、T13 图标态降级）；BatchActions.stories.tsx（IconOnlyNarrow / IconOnlyMedium）。

`globals.css` 中 `.glass-card` 无 `overflow:hidden`（已审阅），与容器 `overflow-x-auto` 无冲突；新增滚动条样式只作用于 `.batch-actions-root`，不影响其它滚动容器。

## 2. 仍存在 / 需加固的盲区（本次目标）

- **G1（一致性）**：`ShareMenuButton` 按钮 `className="icon-btn batch-act-btn ${sizeClass} gap-1"`（ShareMenuButton.tsx L60）**缺 `whitespace-nowrap`**，而同栏 BatchActions 各按钮都有。按钮 `width:auto` 不会触发换行，但 CJK 标签在极端约束下仍可能折行，且与同栏不一致，属隐患。
- **G2（可发现性）**：细滚动条静止态 thumb 用 `var(--divider)` 较浅，用户在非 hover 静止态可能仍不易察觉「可横向滚动」——正是用户点名场景。需静止态略提升对比、hover 进一步加深（纯 CSS 双态，复用成熟方案）。
- 其余（缩放 / 超宽屏 / 窄屏 / 长文案）已被现有断点 + 细滚动条 + overflow:visible 覆盖，无需返工，仅做验证确认。

## 3. 依赖声明

- **不引入任何新 npm 依赖。** 纯 CSS（media query + 滚动条伪元素）+ 现有 Tailwind / 玻璃拟态体系 + 现有 tests / stories。
- 复用成熟方案：shadcn / Radix 同款「容器细滚动条 + 静止/悬停双态对比」纯 CSS 模式（零运行时成本）。
- 不新增 JS 滚动侦测逻辑（避免范围蔓延）；若后续确需边缘渐隐阴影，作为可选后续，不在本次。

## 4. 实施子任务

### T1 — 编写本 MD 实施计划文档

- **文件**：`docs/plans/2026-08-28-batch-actions-responsive-hardening.md`（新建，不覆盖既有计划）
- **输入**：本计划内容。
- **输出**：含依赖声明 / 启动说明 / 错误处理 / 参数校验 / 基础测试用例的 MD 文档；每个子任务含文件、输入输出、验收。
- **验收**：文档落盘；结构与用户要求一致。

### T2 — G1：ShareMenuButton 补 whitespace-nowrap

- **文件**：`src/renderer/components/common/ShareMenuButton.tsx`
- **输入**：L60 `className={`icon-btn batch-act-btn ${sizeClass} gap-1`}`
- **输出**：改为 `icon-btn batch-act-btn ${sizeClass} gap-1 whitespace-nowrap`（不动其它逻辑 / 回调 / 无障碍）。
- **验收**：按钮 className 含 `whitespace-nowrap`；分享交互（点击外部 / Esc 关闭、渠道 onSelect）不变；现有 ShareMenuButton.test.tsx 全绿。

### T3 — G2：静止态滚动条可见性加固

- **文件**：`src/renderer/styles/globals.css`
- **输入**：`.batch-actions-root` WebKit 滚动条 thumb 静止态 `var(--divider)`（约 L439–L449）。
- **输出**：静止态 thumb 改用跨主题可见浅灰 `rgba(120,120,120,0.5)`，hover 态加深为 `rgba(80,80,80,0.85)`；保持 4px 高、`bottom:44px` 留白不裁切；Firefox `scrollbar-color` 同步调整。
- **验收**：静止态细滚动条肉眼可辨、hover 更清晰；不影响玻璃拟态视觉；≥961px 文字完整、溢出可横滚且滚动条可被发现。

### T4 — 测试补齐

- **文件**：`src/renderer/components/common/ShareMenuButton.test.tsx`（扩）、确认 `src/renderer/components/gallery/BatchActions.test.tsx`
- **输入**：现有 T01–T13 与 ShareMenuButton 单测（无 batch-act-label 断言）。
- **输出**（jsdom 可读 className 的断言，不依赖 CSS 计算）：
  - 新增：分享按钮 label 元素含 `batch-act-label` 类（参与响应式降级）。
  - 新增：`size=sm` 时按钮 className 含 `whitespace-nowrap`（对应 T2）。
  - 说明：media query 实际隐藏行为 jsdom 不解析，降级视觉以 Storybook / 人工验证清单覆盖。
- **验收**：`npx vitest run src/renderer/components/common/ShareMenuButton.test.tsx src/renderer/components/gallery/BatchActions.test.tsx` 全绿（偶发 setup 报错重试即可）。

### T5 — 类型 / Lint / 单测验证

- **输入**：T2–T4 改动后源码。
- **输出**：
  - `npx tsc -b` 本次改动文件无类型错误。
  - ESLint 指定文件 0 error。
  - vitest 全绿（见 T4）。
- **验收**：三项通过；失败当场修复，不带着错误推进。

## 5. 启动说明（命令）

- 开发预览：`npm run dev`（或 `npm run storybook` 看 BatchActions 故事）
- 类型检查（仅本次改动文件需无错）：`npx tsc -b`
- Lint（指定文件）：
  `npx eslint src/renderer/components/common/ShareMenuButton.tsx src/renderer/components/gallery/BatchActions.tsx src/renderer/styles/globals.css`
- 单测：
  `npx vitest run src/renderer/components/common/ShareMenuButton.test.tsx src/renderer/components/gallery/BatchActions.test.tsx`
- 可视化验证：Storybook 中 BatchActions 的 IconOnlyNarrow / IconOnlyMedium，或 `npm run dev` 选中图片后在多视口下观察。

## 6. 错误处理（边界与容错）

- **窄屏（≤640 / ≤960 CSS px）**：`.batch-act-label` 隐藏仅留图标，title / aria-label 保留语义无障碍；不会因标签消失而丢失功能。
- **超宽屏**：容器 `max-w-[calc(100vw-32px)]` 上限，避免无限拉伸、留白过多。
- **不同系统缩放（125% / 150% / 175%）**：断点基于 CSS px，缩放自动换算（如 1920@150%→1280px 显示标签；1440@150%→960px 图标态），无需为 DPI 单独处理。
- **文案长度变化（长中文 / i18n 长串）**：按钮 `overflow:visible` + 容器 `overflow-x-auto`，过长不裁切、可横滚。
- **容器溢出**：始终 `overflow-x-auto` + 常驻细滚动条，用户可被发现横滚。
- **CSS 未生效（Tailwind / build 缓存）**：`npx tsc -b` + ESLint + vitest 结构断言可兜底发现 className 缺失；极端情况重启 dev server。
- **滚动条不可见**：G2 提升静止态对比；hover 加深；Webkit / Firefox 双实现。

## 7. 参数校验

- 本次改动不涉及新增组件入参 / 配置项：G1 仅追加既有 className 字面量；G2 仅改 CSS 值；T4 仅加断言。均无需新增参数校验。
- 原因：既有 `ShareMenuButton` 的 props（onSelect / label / title / size / disabled）已有类型与既有测试覆盖，本任务不改动其签名或行为，故不引入校验逻辑，避免无关改动与范围蔓延。

## 8. 基础测试用例清单（通过标准）

| 类型        | 用例                                                                                        | 通过标准                                               |
| ----------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 单测        | ShareMenuButton 分享 label 含 batch-act-label                                               | 断言命中，验证参与响应式降级                           |
| 单测        | size=sm 按钮含 whitespace-nowrap                                                            | 断言 className 含该字面量                              |
| 单测        | BatchActions 容器含 overflow-x-auto / flex-nowrap / batch-actions-root / max-w              | T02 / T13 断言通过                                     |
| 单测        | 选中态降级：≤960 时按钮仅图标（DOM 仍有 batch-act-label，视觉隐藏）                         | T11 / T12 通过                                         |
| 交互        | 点击图片 → 底部栏出现；分享按钮 toggle / 渠道 onSelect / 外部关闭                           | 行为不变                                               |
| 视觉        | 1920×1080@100% / 125% / 150%、1440@150%、1366@125%、超宽 2560、窄 1024 / 960 / 640 CSS 视口 | 文字完整、无截断 / 遮挡 / 溢出；溢出可横滚且滚动条可见 |
| 视觉        | 长文案 / i18n 长串标签                                                                      | 不裁切、可横滚                                         |
| 类型 / Lint | tsc -b 改动文件 0 错、ESLint 0 error                                                        | 通过                                                   |
