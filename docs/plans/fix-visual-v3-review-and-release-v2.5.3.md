# 视觉体系 v3 未提交改动审查修复 + v2.5.3 发布实施计划

> 状态：已批准执行 | 范围：全部未提交改动（12 个新通用组件 + cn 工具 + 设计令牌 + 页面接入 + i18n）的代码审查修复，随后按 v2.5.2 发布流程（e2ff622 同构）升级版本号至 2.5.3 并重新打包。

## 0. 审查结论

三路并行深审（组件库 / 页面与 i18n / 发布与构建链路）结论：**无 P0**；i18n 12 语言新增 key 全对齐无缺失；`display.ambientGrain/ambientShapes` 设置链路（settings-keys → store → 开关 → CSS 根类）读写闭环完整。发现 **3 个 P1、约 10 个 P2**，处置如下。

### 修复清单（TDD 红-绿闭环）

| #   | 级别 | 问题                                                                                                   | 位置                                                      | 修法                                                                                                                                              |
| --- | ---- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | P1   | SegmentedControl 声称"方向键可切换"但未实现，违反 ARIA APG radiogroup 键盘模式                         | `src/renderer/components/common/SegmentedControl.tsx`     | 容器 `onKeyDown`（ArrowLeft/Right/Up/Down 循环跳相邻非 disabled 项并 onChange + 聚焦）；radio roving tabindex（active 为 0，其余 -1）             |
| 2   | P1   | Drawer 硬编码 `titleId='drawer-title'`，双 Drawer 并开 aria-labelledby 串号                            | `src/renderer/components/common/Drawer.tsx:50`            | `useId()` 生成                                                                                                                                    |
| 3   | P1   | FloatingActionBar `z-[60]` 高于 Toast/TaskProgressOverlay（z-50），操作反馈可被底栏遮挡（旧实现 z-40） | `src/renderer/components/common/FloatingActionBar.tsx:31` | 改 `z-40`；同时修 className 契约（移至内层内容行、默认间距对齐旧实现 `gap-2 px-4 py-2`）、`ariaLabel` 改必填、缓动令牌化 `var(--ease-decelerate)` |
| 4   | P2   | FormField error 存在时 describedby 仍引用不渲染的 helperId（悬空引用）                                 | `src/renderer/components/common/FormField.tsx:54`         | `error ? errorId : helperId`                                                                                                                      |
| 5   | P2   | Tooltip 气泡无 aria-describedby 关联；useLayoutEffect 缺 content 依赖；键盘无法 Esc 关闭               | `src/renderer/components/common/Tooltip.tsx`              | useId 气泡 id + cloneElement 并入 `aria-describedby`；deps 补 content；trigger 补 onKeyDown(Escape→hide)                                          |
| 6   | P2   | `.ambient-shape-c` 静态 `rotate(45deg)` 被动画覆盖永不生效（死代码）                                   | `src/renderer/styles/globals.css:481`                     | 删除该行（渲染效果不变）                                                                                                                          |
| 7   | P2   | 预览 mock `uiTheme.set` 写裸值，与 zustand persist JSON 同 key 双形态冲突                              | `src/renderer/preview/mock/database-mock.ts:651`          | 写 persist 同构 JSON `{"state":{"theme":...},"version":0}`；get 保留双形态兼容                                                                    |
| 8   | P2   | OutfitGalleryPage 空值占位由 `'—'` 改 `'--'`，硬编码不一致                                             | `src/renderer/pages/OutfitGalleryPage.tsx:117,267`        | 回退 `'—'`                                                                                                                                        |
| 9   | P2   | ToastProvider 测试 `vi.useRealTimers()` 在用例体内，失败时 fake timers 泄漏                            | `src/renderer/components/common/ToastProvider.test.tsx`   | 移入 afterEach                                                                                                                                    |
| 10  | P2   | SegmentedControl 头注释声称"统一四处"与实际接入（仅 ResonanceRecordsPage）失实                         | 同 #1                                                     | 注释改为实际状态                                                                                                                                  |

### 明确不改（记录理由）

- **柔粉主题 `--text-on-accent` 深色化**：视觉设计决策需设计确认，维持现状（回落 `:root` 白色，与改造前一致，非回归）。
- **CategoriesPage Select aria-label 复用既有文案**：需新增 12 语言 key 与翻译，属文案语义优化非缺陷，本轮不做。
- **Tailwind 圆角/阴影令牌重映射、全局 `:focus-visible` 描边**：视觉体系 v3 的改造目标本身，非缺陷（前者属全量视觉变更，随本版本发布）。
- **7 个暂零消费的新组件**（Button/Checkbox/Drawer/FormField/PageHeader/Progress/Tooltip/Switch）：组件库预备，自带测试与 stories，非缺陷。

## 1. 依赖声明

**零新增依赖、零版本变更。** `cn` 为仓库内 15 行零依赖工具（刻意不引 clsx/tailwind-merge），全部修复仅改既有文件；测试沿用既有 Vitest + @testing-library/react + `tests/setup.ts` 的 motion/react mock（已含 `useReducedMotion`）。

## 2. 环境准备与运行说明

- Node.js ≥ 20；依赖已安装且 `node_modules/electron` 精确等于 package.json 声明的 40.10.6（pre-dist-check 原生 ABI 闸门要求）；本机已有 2.5.1/2.5.2 安装包产物，证明 NSIS + npmRebuild + VC++ DLL 工具链可用。
- 局部验证：`npx vitest run src/renderer/components/common`、`npx vitest run src/renderer/pages`。
- 全局回归：`npm run typecheck && npm run lint && npm test`。
- 打包：`npm run dist:win`（build → pre-dist-check → electron-builder NSIS → verify:dist），产物 `release/NikkiGallery-Setup-2.5.3.exe`。

## 3. 错误处理与兜底

| 分支                                       | 行为                                            | 兜底                       |
| ------------------------------------------ | ----------------------------------------------- | -------------------------- |
| 基线测试存在预存失败                       | 清单化记录，后续步骤不得扩大失败面              | 一票否决线只约束"新增失败" |
| 打包闸门（pre-dist-check/verify:dist）失败 | 中止打包，按报错修复后重跑                      | 不影响已提交代码           |
| commitlint/lint-staged 钩子拒绝提交        | 按 lint-staged 自动修复结果重查，人工修正后重提 | —                          |
| 环境级硬阻碍（缺 DLL/构建工具链）          | 如实报告，停在已完成提交上                      | —                          |

## 4. 参数校验

- `FloatingActionBar.ariaLabel` 由可选改必填（TS 编译期约束）；两处调用方（DuplicatesPage:1207、RecycleBinPage:392）均已传值，编译安全。
- SegmentedControl 键盘导航遍历时跳过 `disabled` 项（循环步进 + 全 disabled 时不动）；active 项永不为 disabled（value 契约）。
- Tooltip `aria-describedby` 与 children 已有同名属性合并（空格拼接），不覆盖调用方。

## 5. 基础测试用例（正常 / 异常 / 边界）

**SegmentedControl（新增）**：① 正常——ArrowRight/ArrowLeft 从当前项切换到相邻项并触发 onChange（红→绿）；② 边界——首项按 ArrowLeft 循环到末项、相邻项 disabled 时跳过至下一个可用项；③ 异常——点击 disabled 项不触发 onChange（既有行为补断言）；④ roving tabindex——仅 active 项 tabIndex=0。
**Drawer（新增）**：① 异常（复现 Bug）——同时打开两个 Drawer，title id 互不相同且各自 `aria-labelledby` 精确指向自己的标题（修复前必失败）；② 正常——单个 Drawer 的 labelledby 关联。
**FloatingActionBar（更新）**：断言 `z-40`、`role="toolbar"` + aria-label、内容行拿到调用方 className。
**FormField（新增）**：① 异常——helper+error 同传时 describedby 仅含 errorId；② 正常——仅 helper 时含 helperId；③ 边界——两者皆无时 undefined。
**Tooltip（新增）**：① 正常——显示后气泡 id 与触发元素 `aria-describedby` 关联；② 异常——Esc 按下即隐藏；③ 边界——空 content 不渲染且不设置 describedby。
**回归**：`npm test` 全量无新增失败；`npm run typecheck`、`npm run lint` 零错误。

## 6. 子任务三要素

| 子任务          | 涉及文件                                                                                                                            | 输入 / 输出                                                               | 验收标准                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| S1 P1 修复      | SegmentedControl(.tsx/.test.tsx)、Drawer(.tsx/.test.tsx)、FloatingActionBar(.tsx/.test.tsx)、DuplicatesPage.tsx、RecycleBinPage.tsx | 输入：既有组件与调用点；输出：键盘导航、唯一 aria id、z-40 层级与契约修正 | 新增测试先红后绿；`npx vitest run src/renderer/components/common` 全绿                          |
| S2 P2 修复      | FormField(.tsx/.test.tsx)、Tooltip(.tsx/.test.tsx)、globals.css、database-mock.ts、OutfitGalleryPage.tsx、ToastProvider.test.tsx    | 输入：缺陷清单；输出：aria 关联修正、死代码消除、mock 同构、占位符统一    | 同上局部回归 + `npx vitest run src/renderer/pages` 全绿                                         |
| S3 全局回归     | —                                                                                                                                   | 输入：全部修复；输出：回归报告                                            | `npm run typecheck && npm run lint && npm test` 无新增失败                                      |
| S4 安全扫描     | —                                                                                                                                   | mimosa normal 深度 + focusFiles（本次改动文件）                           | 无新增高危发现                                                                                  |
| S5 feat 提交    | 全部未提交改动 + 修复 + 本计划文档                                                                                                  | 单提交 `feat(renderer): 视觉体系 v3——新增通用组件库与设计令牌并接入页面`  | husky 钩子通过，`git status` 干净                                                               |
| S6 版本升级     | package.json、package-lock.json、database-mock.ts、README.md、AGENTS.md、ARCHITECTURE(.en).md、DEVELOPMENT(.en).md、CHANGELOG.md    | 输入：2.5.2；输出：2.5.3 全量同步 + 新 CHANGELOG 条目                     | `tsx scripts/check-doc-versions.ts` 通过；grep 无残留 2.5.2（排除游戏版本数据/依赖行/历史描述） |
| S7 release 提交 | S6 全部文件                                                                                                                         | `chore(release): 发布 v2.5.3 并同步版本号、文档与变更日志`                | commitlint 通过                                                                                 |
| S8 打包         | release/                                                                                                                            | `npm run dist:win`                                                        | 退出码 0；`release/NikkiGallery-Setup-2.5.3.exe` 存在；verify:dist 通过                         |
