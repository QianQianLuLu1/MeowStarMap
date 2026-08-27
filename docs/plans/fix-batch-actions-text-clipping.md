# 修复图库「批量操作栏」文字显示不全

- 创建日期：2026-08-26
- 状态：执行中
- 关联 Plan：`fix-gallery-batch-actions-text-clipping`（80b95b2fdb8b47fbb5143a70b088710f）

## 1. 问题现象

在「图库」板块单击图片后，底部居中弹出的批量操作浮动工具栏（`BatchActions`）中，
部分按钮的中文标签被截断（典型：`导出到默认 → 导出到默`、`WiFi 分享 → WiFi 分`）。

## 2. 根因分析

组件：`src/renderer/components/gallery/BatchActions.tsx`，样式：`src/renderer/styles/globals.css`。

工具栏容器当前为：

```
fixed left-1/2 -translate-x-1/2 glass-card px-4 py-2 flex items-center gap-2 z-40
flex-nowrap overflow-x-auto scrollbar-hide max-w-[calc(100vw-32px)]
```

- `.icon-btn`（裸 CSS，未分层）定义 `width:36px; overflow:hidden`。
- `.batch-act-btn`（裸 CSS，未分层，源顺序在 `.icon-btn` 之后）已覆盖为
  `width:auto; min-width:36px; flex-shrink:0`，**但未覆盖 `overflow:hidden`**。
- 两者均为未分层单一类选择器，源顺序 `.batch-act-btn` 在后 ⇒ `width:auto` 确实覆盖
  `width:36px`，单按钮文字本身不会被裁（已确认 CSS 层叠行为）。
- **真正的根因**：容器 `flex-nowrap + overflow-x-auto + max-w-[calc(100vw-32px)] + scrollbar-hide`。
  多按钮 + 中文长标签时内容总宽超过 `max-w` 限制，右侧按钮被推到可视区外并被裁切，
  同时 `scrollbar-hide` 隐藏滚动条，用户无法感知可横向滚动，视觉上等同于「字体显示不全」。
- 次要隐患：`.icon-btn` 的 `overflow:hidden` 在按钮被任何方式压缩时会裁文字，应一并消除。

结论：需要（a）确保文字按钮 `overflow:visible` 兜底；（b）提供横向滚动的可发现性；
（c）窄屏下响应式降级为「仅图标」以从根本上避免溢出。

## 3. 依赖声明

- 纯 CSS + Tailwind 工具类实现，**不引入任何新 npm 依赖**。
- 复用的成熟方案：shadcn / Radix ScrollArea 同款的「容器细滚动条 + hover 提示」与
  「窄屏图标化降级」响应式工具栏模式（均为纯 CSS / media query，无运行时成本）。
- 开发与验证依赖（均已在 `package.json` 中）：`vitest`、`@testing-library/react`、
  `jsdom`、`@storybook/react-vite`、`electron-vite`、`typescript`、`eslint`。

## 4. 实施子任务

### T1 — CSS 加固 `.batch-act-btn`

- 修改文件：`src/renderer/styles/globals.css`
- 输入：现有 `.icon-btn` / `.batch-act-btn` 规则
- 输出：提高特异性为 `.icon-btn.batch-act-btn` 并加 `overflow:visible`
- 验收：`.icon-btn.batch-act-btn` 特异性 (0,2,0) > `.icon-btn` (0,1,0)，覆盖 `overflow:hidden`；
  不改变其他使用 `.icon-btn` 的纯图标按钮（如关闭按钮）行为。

### T2 — 容器滚动可发现性

- 修改文件：`src/renderer/styles/globals.css`、`BatchActions.tsx`（容器 className）
- 输入：容器 `scrollbar-hide` + `overflow-x-auto`
- 输出：移除 `scrollbar-hide`，改由 `.batch-actions-root` 提供细滚动条
  （始终可滚动，hover 时滚动条可见，保持毛玻璃视觉）
- 验收：容器 className 含 `batch-actions-root`、不含 `scrollbar-hide`；横向内容可滚动且可见滚动条。

### T3 — 响应式降级（窄屏图标化）

- 修改文件：`globals.css`、`BatchActions.tsx`、`ShareMenuButton.tsx`
- 输入：各文字按钮的标签文本直接作为子节点
- 输出：标签文本包裹 `<span className="batch-act-label">`；
  `@media (max-width:640px)` 下 `.batch-actions-root .batch-act-label { display:none }`
  （保留 `title` / `aria-label` 完整语义，窄屏仅显示图标）
- 验收：`batch-act-label` 类存在；窄屏下文字不可见、图标与tooltip仍可访问。

### T4 — 测试与 Storybook 场景

- 修改文件：`BatchActions.test.tsx`、`BatchActions.stories.tsx`
- 输入：现有测试与故事
- 输出：
  - 测试新增：容器含 `batch-actions-root` 且不含 `scrollbar-hide`；文字按钮渲染
    `.batch-act-label`；条件渲染按钮（导出到默认等）仍正确显示。
  - 故事新增：`NarrowViewport`（窄视口）展示图标化降级。
- 验收：`vitest run src/renderer/components/gallery/BatchActions.test.tsx` 通过
  （本机 vitest 环境损坏，需在正常环境或 CI 执行；本机以 ESLint + tsc 兜底）。

### T5 — 构建与视觉验证

- 修改文件：无（验证步骤）
- 输入：改动后的源码
- 输出：类型检查 + Lint 通过；Storybook 或构建产物中确认工具栏文字完整 / 可滚动 / 窄屏降级
- 验收：`npx tsc -b` 新增文件无类型错误；`eslint` 0 error；
  `npm run storybook` 或 `npx electron-vite build` 产物中工具栏无文字截断。

## 5. 启动说明

```bash
# 开发态 UI 验证（推荐，最轻量）
npm run storybook          # 打开 http://localhost:6006，查看 Gallery/BatchActions

# 类型与 lint
npx tsc -b                 # 类型检查（仅关注本次改动文件）
npm run lint               # ESLint 0 error

# 单测（本机 vitest 环境损坏，需在正常环境运行）
npx vitest run src/renderer/components/gallery/BatchActions.test.tsx

# 受限环境构建序列（避开 Safe-Delete 网关）
npx electron-vite build
node -e "require('fs').writeFileSync('dist/main/package.json',JSON.stringify({type:'commonjs'}))"
```

## 6. 错误处理

- CSS 改动保持向后兼容：`.icon-btn` 纯图标按钮（如清除选择）行为不变；
  仅 `.icon-btn.batch-act-btn` 组合受影响，范围限定批量栏文字按钮。
- 响应式降级使用纯 CSS media query，无 JS 运行时，不存在运行时异常分支；
  窄屏下即使 CSS 未加载，`title` / `aria-label` 仍提供完整可读文案（无障碍兜底）。
- 构建若触发 Safe-Delete 网关 EPERM，按第 5 节受限序列分步执行，不调用 `npm run build` 的 clean 步。

## 7. 参数校验

- `BatchActions` 为纯展示组件，props 均为 React 回调 / 标量，无外部输入解析，无新增参数校验需求。
- `max-w-[calc(100vw-32px)]` 保留为安全上限，避免工具栏宽于视口导致无法滚动到两端。
- 响应式断点 `640px` 为常见移动/小窗阈值，可按 `BatchActions.stories.tsx` 实测微调。

## 8. 基础测试用例清单

| 编号 | 用例                                                                                    | 类型      | 验收                                        |
| ---- | --------------------------------------------------------------------------------------- | --------- | ------------------------------------------- |
| T01  | 渲染 `role="toolbar"` 容器                                                              | 单测      | `getByRole('toolbar')` 存在                 |
| T02  | 容器含 `batch-actions-root`、不含 `scrollbar-hide`、含 `overflow-x-auto`、`flex-nowrap` | 单测      | className 断言                              |
| T03  | 必选按钮（全选/反选/删除/导出/移动/水印）渲染                                           | 单测      | `getByText` 命中                            |
| T04  | 选中计数文案 `{{count}} / {{total}} 项已选择`                                           | 单测      | 正则匹配                                    |
| T05  | 文字按钮渲染 `.batch-act-label` span                                                    | 单测      | `getByText` + 父元素 class 断言             |
| T06  | 条件按钮（导出到默认等）按 props 渲染                                                   | 单测      | 传入时命中、不传时为 null                   |
| T07  | 点击触发对应回调                                                                        | 单测      | `onSelectAll`/`onDelete`/`onClear` 调用一次 |
| T08  | 窄视口故事 `NarrowViewport` 渲染不报错                                                  | Storybook | 组件挂载、图标可见                          |
| T09  | 视觉验证：Storybook 默认视口下「导出到默认」完整显示                                    | 人工/截图 | 无截断                                      |
| T10  | 视觉验证：窄视口（≤640px）下文字隐藏、仅图标、`title` 可读                              | 人工/截图 | 降级生效                                    |

</content>
</invoke>
