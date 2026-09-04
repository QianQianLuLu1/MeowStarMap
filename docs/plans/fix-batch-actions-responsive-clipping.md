# 修复图库「批量操作栏」文字显示不全 — 全场景响应式优化

- 创建日期：2026-08-28
- 关联计划：`fix-batch-actions-responsive-clipping`
- 前置计划：`docs/plans/fix-batch-actions-text-clipping.md`（已于 2026-08-26 落地 T1-T3 基础修复）

## 1. 问题范围（本次目标）

在已落地的基础修复之上，补充覆盖 **不同分辨率、屏幕尺寸、窗口宽度连续变化、系统缩放（125%/150%/175%）** 场景的响应式优化，确保批量操作栏文字在所有常见显示环境下：

- 不被截断（overflow 兜底 + 自适应宽度）；
- 不被遮挡 / 不溢出 / 不不可见；
- 横向溢出时滚动条**可被发现**（hover 可见细滚动条），避免用户不知可滚动。

基础修复已完成的事实（无需重做）：

- `.icon-btn.batch-act-btn` 组合选择器覆盖 `.icon-btn` 的固定 `width:36px` 与 `overflow:hidden`，中文标签不再被裁（T1）。
- 容器改为 `flex-nowrap + overflow-x-auto + .batch-actions-root`，移除 `scrollbar-hide`，细滚动条提供可发现性（T2）。
- `≤640px` 窄屏下 `.batch-act-label` 隐藏文字仅留图标，`title`/`aria-label` 保留语义（T3）。

本次新增盲区：

- **中段断点缺失**：当前只有 `≤640px` 才图标化。`641px–960px` 窗口在 150%/175% 系统缩放下，物理密度抬升，长中文标签（导出到默认、WiFi 分享）仍易溢出、只能靠横滚，体验差。需补 `≤960px` 中段降级。
- **缩放可发现性**：缩放使工具栏 CSS 高度随 DPI 放大，需保证 `hover` 细滚动条不被 `-translate-y` 裁切、始终可见。
- **超宽屏**：`max-w-[calc(100vw-32px)]` 已防过宽，确认居中合理即可。

## 2. 依赖声明

- **不引入任何新 npm 依赖**。纯 CSS media query + Tailwind 工具类 + 现有 `.batch-actions-root` 体系。
- 复用成熟方案：shadcn / Radix ScrollArea 同款「中段断点图标化 + 细滚动条可发现性」纯 CSS 模式（与现有 L443 一致），无运行时成本。

## 3. 实施子任务

### T1 — 编写本 MD 计划文档

- 输出：本文件 `docs/plans/fix-batch-actions-responsive-clipping.md`。
- 验收：文档包含依赖声明 / 启动说明 / 错误处理 / 参数校验 / 基础测试用例，且每个子任务含文件、输入输出、验收标准。

### T2 — 新增中段断点 + 细化滚动条

- 修改文件：`src/renderer/styles/globals.css`
- 输入：现有 L427 `.batch-actions-root` 与 L443 `@media (max-width:640px)`。
- 输出：
  1. 在 L443 之上新增 `@media (max-width:960px) { .batch-actions-root .batch-act-label { display:none } }`（中段降级，覆盖 641–960px 缩放盲区）。
  2. 保留 `L443` 的 `≤640px` 窄屏降级（更激进场景，语义一致）。
  3. 细化 `.batch-actions-root` 滚动条：WebKit 下 `height:4px` 细条在容器 hover 时更清晰可见（`scrollbar-color` 已含 Firefox thin）；确保 `-translate-y` 不裁切 hover 滚动条（容器 `bottom:44px` 留白充足）。
- 验收：两个 media query 断点均存在；`≥961px` 文字完整显示；`≤960px` 文字隐藏仅图标；细滚动条可被发现。

### T3 — 分享标签补降级锚点

- 修改文件：`src/renderer/components/gallery/BatchActions.tsx`
- 输入：当前 `onShareClipboard && <ShareMenuButton label={t('batch.actions.share')} ... />`（label 直接作为按钮文本，无 `batch-act-label` 包裹）。
- 输出：在 `ShareMenuButton` 外层按钮文本处补 `batch-act-label` 包裹，使其中段/窄屏降级与其它文字按钮一致（仅改标签 span class，不改交互/回调）。
  - 注：`ShareMenuButton` 内部若直接渲染 `label` 文本而非可注入 span，则在 `BatchActions` 侧无法简单包裹；改为在 `ShareMenuButton` 的 `label` 渲染节点加 `batch-act-label` 类（复用其现有 className 注入能力）。若 `ShareMenuButton` 不支持 label className 注入，则在 `BatchActions` 传入前用 `<span className="batch-act-label">` 包裹 `label` 字符串不可行（label 为字符串 prop）。**最终方案**：给 `ShareMenuButton` 增加可选 `labelClassName` prop，在内部 label span 应用，保持最小改动、不动其它使用方。
- 验收：分享按钮文本带 `batch-act-label`，中/窄屏降级生效；现有分享交互（点击外部关闭、Esc 关闭）不变。

### T4 — Stories 补真实视口参数

- 修改文件：`src/renderer/components/gallery/BatchActions.stories.tsx`
- 输入：现有 `IconOnlyNarrow` 故事（普通故事，未设真实窄视口）。
- 输出：
  1. `IconOnlyNarrow` 增加 `parameters.viewport.defaultViewport` 设为窄视口（如 `mobile1` 375 / 自定义 375×720），便于 Storybook 直接验证降级。
  2. 新增 `IconOnlyMedium` 故事，设 `viewport ≤960`（如 960×720）验证中段降级。
  3. 保留 `Default` / `FullFeatured` / `AllSelected`。
- 验收：两个故事挂载不报错；在对应视口下文字隐藏仅图标。

### T5 — 测试补中屏降级断言

- 修改文件：`src/renderer/components/gallery/BatchActions.test.tsx`
- 输入：现有 T01–T11（结构级防回归：toolbar 角色、batch-actions-root/overflow-x-auto/flex-nowrap、必选按钮、选中计数、条件渲染、交互、batch-act-label 锚点）。
- 输出：
  - 新增结构断言：分享按钮文本渲染在 `.batch-act-label`（T12），验证 T3 锚点挂载。
  - 降级行为由 CSS media query 生效，单测仅校验结构挂载点（jsdom 不解析 media query 实际隐藏），保持 T01–T11 全绿。
- 验收：`npx vitest run src/renderer/components/gallery/BatchActions.test.tsx` 全部通过（本机偶发 setup 报错重试即可）。

### T6 — 类型 / Lint / 单测验证

- 输入：T2–T5 改动后源码。
- 输出：
  - `npx tsc -b`：本次改动文件无类型错误。
  - `npm run lint`：ESLint 0 error。
  - `npx vitest run src/renderer/components/gallery/BatchActions.test.tsx` 全绿。
- 验收：三项均通过；如失败当场修复，不带着错误推进。

## 4. 启动说明

```bash
# 开发态 UI 验证（最轻量，推荐）
npm run storybook            # 打开 http://localhost:6006，查看 Gallery/BatchActions，切换 viewport 320/375/640/960/1920 验证

# 类型与 lint（仅关注本次改动文件无错）
npx tsc -b
npm run lint

# 单测（本机 vitest 偶发 setup.ts 第3行报错属 worker 问题，重试即可）
npx vitest run src/renderer/components/gallery/BatchActions.test.tsx

# 受限环境构建序列（避开 Safe-Delete 网关）
npx electron-vite build
node -e "require('fs').writeFileSync('dist/main/package.json',JSON.stringify({type:'commonjs'}))"
```

## 5. 错误处理

- **窄屏 (≤640px) / 中屏 (≤960px)**：纯 CSS media query 隐藏文字仅图标，无 JS 运行时、无异常分支；即使 CSS 未加载，`title`/`aria-label` 仍提供完整可读文案（无障碍兜底）。
- **超宽屏**：`max-w-[calc(100vw-32px)]` 限制最大宽度并居中，避免顶边/裁切；缩放不改变 CSS 断点（media query 基于 CSS 像素），行为正确。
- **文案长度变化（多语言长词）**：`whitespace-nowrap + flex-shrink:0 + overflow:visible` 保证按钮随文案自适应且文字不被裁；超出则横向滚动（细滚动条 hover 可见）而非截断。
- **容器溢出**：`overflow-x-auto` + 细滚动条提供可发现性；已移除 `scrollbar-hide`。
- **CSS 未生效**：保留 `max-w` 安全上限与 `flex-nowrap` 结构兜底；结构级单测（batch-actions-root/overflow-x-auto/flex-nowrap/batch-act-label）防回归。
- **构建若触发 Safe-Delete 网关 EPERM**：按第 4 节受限序列分步执行，不调用 `npm run build` 的 clean 步。

## 6. 参数校验

- `BatchActions` 为纯展示组件，props 均为 React 回调 / 标量，无外部输入解析；无新增参数校验需求。
- 响应式断点 `640px / 960px` 为常见移动/小窗阈值，复用 Tailwind 默认断点语义；可按 stories 实测微调。
- `max-w-[calc(100vw-32px)]` 保留为安全上限，避免工具栏宽于视口导致无法滚动到两端。
- `ShareMenuButton` 新增 `labelClassName` 为可选 prop（向后兼容，所有现有使用方不受影响）。

## 7. 基础测试用例清单

| 编号 | 用例                                                                                    | 类型      | 验收                         |
| ---- | --------------------------------------------------------------------------------------- | --------- | ---------------------------- |
| T01  | 渲染 `role="toolbar"` 容器                                                              | 单测      | `getByRole('toolbar')` 存在  |
| T02  | 容器含 `batch-actions-root`、不含 `scrollbar-hide`、含 `overflow-x-auto`、`flex-nowrap` | 单测      | className 断言               |
| T03  | 必选按钮（全选/反选/删除/导出/移动/水印）渲染                                           | 单测      | `getByText` 命中             |
| T04  | 选中计数文案 `{{count}} / {{total}} 项已选择`                                           | 单测      | 正则匹配                     |
| T05  | 清除选择按钮通过 `aria-label` 可访问                                                    | 单测      | `getByLabelText('清除选择')` |
| T06  | 仅当传入可选回调时渲染对应按钮                                                          | 单测      | 传入命中、不传为 null        |
| T07  | 未传入可选回调时不渲染对应按钮                                                          | 单测      | `queryByText` 为 null        |
| T08  | 文字按钮渲染 `.batch-act-label` 包裹（窄屏降级锚点）                                    | 单测      | 父元素 class 断言            |
| T09  | 分享按钮文本渲染在 `.batch-act-label`（本次新增锚点）                                   | 单测      | class 断言                   |
| T10  | 点击全选/删除/清除触发对应回调                                                          | 单测      | 回调调用一次                 |
| T11  | `IconOnlyNarrow` 故事设真实窄视口(≤640) 挂载不报错                                      | Storybook | 图标可见                     |
| T12  | `IconOnlyMedium` 故事设视口 ≤960 验证中屏降级                                           | Storybook | 文字隐藏仅图标               |
| V1   | 视觉验证：默认视口(≥961)「导出到默认」完整显示无截断                                    | 人工/截图 | 无截断                       |
| V2   | 视觉验证：viewport 375/640 文字隐藏仅图标、`title` 可读                                 | 人工/截图 | 降级生效                     |
| V3   | 视觉验证：150%/175% 系统缩放下 960px 视口文字不溢出、可横滚且滚动条可见                 | 人工/截图 | 无截断、可发现滚动           |
