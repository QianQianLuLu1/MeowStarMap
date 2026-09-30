# 修复「分享图标显示不完全（截断 / 溢出隐藏 / 比例失调）」实施计划

- 状态：已批准（2026-09-30，经 ExitPlanMode 流程确认）
- 关联：`src/renderer/icons/index.tsx`（IconShare）、`src/renderer/components/common/ShareMenuButton.tsx`
- 影响页面：图库 / 截图 / 收藏 / 启动器缓存（同一 `GalleryPage`）、重复文件（`DuplicatesPage` 复用同一右键菜单工厂）、顶部工具栏
- 执行约束：最小改动、零新 npm 依赖、严格 TDD（红→绿）、全量回归通过后才算完成

## 1 根因分析

### 1.1 页面复用关系（为何多个页面同一问题）

- 图库 / 收藏 / 启动器缓存 / 截图四个视图全部渲染同一个 `GalleryPage`（`src/renderer/App.tsx:290-304`）。
- 批量操作栏 `BatchActions` 仅 `src/renderer/pages/GalleryPage.tsx:722` 一处使用。
- 右键菜单项由 `src/renderer/utils/gallery.tsx` 的 `getContextMenuItems` 工厂构建；分享项图标 `icons.share` = `<IconShare size={16} />`（`gallery.tsx:58`，分享子菜单 124-153）。
- 重复文件页 `src/renderer/pages/DuplicatesPage.tsx:1334` 经 `src/renderer/utils/duplicateContextMenu.ts` 适配后复用同一工厂。
- 顶部工具栏 `src/renderer/components/gallery/GalleryToolbar.tsx:392` 也使用 `ShareMenuButton`。

结论：所有入口最终共享同一批图标组件，图标字形级缺陷会在全部页面一致复现。

### 1.2 根因 1（主因）：IconShare 首条弧线终点越出 viewBox

`src/renderer/icons/index.tsx:473`：

```tsx
<path d="M12 3a17 17 0 0 1 12 5" /> // 终点 (12+12, 3+5) = (24, 8)，恰好压在 viewBox 右缘 x=24
```

`BaseIcon`（`icons/index.tsx:7-29`）固定 `viewBox="0 0 24 24"`、`strokeWidth="2"`、`strokeLinecap="round"`。SVG 根元素默认 `overflow: hidden`：终点 (24, 8) 处描边半宽 1、圆头沿切线方向再延伸 ≈0.71，外弧右端描边极值 x≈24.71 > 24 → 圆头被竖直切平，视觉上"分享图标右侧缺一块"。该图标用于：

| 使用位置                                                         | 尺寸 |
| ---------------------------------------------------------------- | ---- |
| 批量栏分享触发按钮（ShareMenuButton，`ShareMenuButton.tsx:114`） | 14   |
| 批量栏 WiFi 分享按钮（`BatchActions.tsx:185`）                   | 14   |
| 右键菜单分享项（`utils/gallery.tsx:58`）                         | 16   |
| 顶部工具栏 ShareMenuButton（size='md'）                          | 16   |

**修复**：`M12 3a17 17 0 0 1 12 5` → `M12 3a17 17 0 0 1 11 4.5`（终点 (23, 7.5)）。几何核算：弦长 √(11²+4.5²)≈11.88，圆心 (11.47, 19.99)，|终点−圆心| = 17.000（闭合无误差）；描边极值 ≈ 23.74 < 24；顶部极值 y≈2 > 0。视觉差异仅为外弧略缩短 ≈1 单位，不可感知。

### 1.3 根因 2（防御加固）：ShareMenuButton 包装层缺 flex-shrink 保护

`src/renderer/components/common/ShareMenuButton.tsx:104` 的触发器包装 `<div className="relative">` 是批量操作栏中唯一未显式 `flex-shrink: 0` 的 flex 项——兄弟按钮均经 `.icon-btn.batch-act-btn`（`globals.css:551-558`）获得 `flex-shrink: 0`。容器 `overflow-x-auto`（`BatchActions.tsx:71`）下空间紧张时该项优先被压缩，存在挤压分享按钮的风险。加固：`relative` → `relative flex-shrink-0`。

### 1.4 已核实、明确不修（已否决的备选方案）

| 备选                                               | 结论                                                                                                                 |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 给 `BaseIcon` 加 `overflow="visible"` 全局放开裁剪 | 否决：影响全部 60+ 图标，贴边图标可能溢出叠加相邻内容，违反最小改动                                                  |
| 引入 lucide-react 等第三方图标库                   | 否决：新增依赖，且现有手绘风格需整体迁移                                                                             |
| 调整批量栏容器 `overflow-x-auto` / `flex-wrap`     | 否决：既有设计（细滚动条 + ≤960px 图标化降级，`globals.css:598-619`），且 `BatchActions.test.tsx` T02 已有防回归断言 |
| `ContextMenu.tsx` 菜单项布局                       | 已核实无需修：图标包在 `flex-shrink-0`（`ContextMenu.tsx:217`），被 `truncate` 截断的只有文字（218 行）              |

## 2 依赖声明

**无新增 / 变更 npm 依赖。** 复用既有设施：

- 测试：vitest 1.6 + @testing-library/react 16 + jsdom（`vitest.config.ts` 的 `environmentMatchGlobs` 已覆盖 `src/renderer/**/*.test.tsx`；`tests/setup.ts` 全局提供 cleanup 等）。
- 视觉验证：Storybook 10（已有 41 个 stories，`npm run storybook` 端口 6006）。

## 3 启动与验证说明

```bash
# 环境准备：常规 Node/npm 环境，依赖已就绪（npm install 后无需额外步骤）

# TDD 红灯 / 绿灯（按子任务逐个运行）
npx vitest run src/renderer/icons/index.test.tsx
npx vitest run src/renderer/components/common/ShareMenuButton.test.tsx

# 局部回归
npm run test:renderer

# 全局回归（全部完成后）
npm test && npm run typecheck && npm run lint

# 视觉验证
npm run storybook   # http://localhost:6006 → Icons/ShareIconFamily、Common/ContextMenu、Gallery/BatchActions
# 降级方案：npm run dev 手工路径——图库选中图片→右键→「分享」项；多选→底部批量栏「分享 / WiFi 分享」按钮
```

## 4 修复方案（子任务与验收标准）

### T1 红灯测试 — 新建 `src/renderer/icons/index.test.tsx`

- 输入：`IconShare` / `IconWeChat` / `IconQQ` / `IconVivo` 渲染后的 svg（jsdom）。
- 输出：几何守卫断言（描边安全区 [0.5, 23.5]，预留 `strokeWidth/2 = 1` 余量）。
- 实现：测试文件内内置 ~50 行轻量 path 端点扫描器（支持 M/L/H/V/C/S/Q/T/A/Z 及小写相对命令、隐式重复参数组；遇未知命令**显式抛错**防静默漏检）；另覆盖 circle（cx±r, cy±r）、polyline、line、rect 的边界。
- 用例：
  1. **红灯用例（复现 bug）**：4 个图标的全部路径端点 ∈ [0.5, 23.5]。当前 IconShare 端点 (24, 8) → 断言失败；其余 3 个渠道图标本就合规（已手工核算）。
  2. 防回归（正常渲染）：svg `width === height === size`（比例 1:1 不失调）、`viewBox="0 0 24 24"`、`stroke-width="2"`、`stroke-linecap="round"`，覆盖 size = 14 / 16 / 28。
  3. 异常状态：扫描器遇未知命令抛错。
- 验收：`npx vitest run src/renderer/icons/index.test.tsx` —— 用例 1 **修复前必须失败（红灯）**，用例 2/3 通过。

### T2 绿灯修复 — `src/renderer/icons/index.tsx:473`（仅一行）

- `d="M12 3a17 17 0 0 1 12 5"` → `d="M12 3a17 17 0 0 1 11 4.5"`。
- 验收：同命令重跑全绿；批量栏（14）、右键菜单（16）、故事（64）三档渲染正常。

### T3 红灯→修复 — `src/renderer/components/common/ShareMenuButton.tsx:104`

- 先在既有 `src/renderer/components/common/ShareMenuButton.test.tsx` 追加用例：触发按钮的 `parentElement.className` 包含 `flex-shrink-0`（当前红灯）。
- 修复：`className="relative"` → `className="relative flex-shrink-0"`（仅一行）。
- 验收：`npx vitest run src/renderer/components/common/ShareMenuButton.test.tsx` 全绿，新用例先红后绿，既有用例零回归。

### T4 Storybook 故事 — 新建 `src/renderer/icons/index.stories.tsx`

- title `Icons/ShareIconFamily`：4 个分享图标 × 14 / 16 / 28 / 64 尺寸网格；64px 供目检外弧右端圆头完整；附 docs 说明修复背景与验收点。
- 既有 `Common/ContextMenu`（分享项+子菜单）、`Gallery/BatchActions`（FullFeatured 双分享按钮）、`Common/ShareMenuButton` 故事无需改动，直接作为回归视觉面。
- 验收：`npm run storybook` 启动无错，64px 下 IconShare 外弧右端圆头完整无切平。

## 5 错误处理

- 图标为纯展示组件，无异步 / IO / IPC 分支。
- 防护策略：单测几何守卫拦截未来路径越界回归；扫描器对未知路径命令显式抛错（宁可测试失败也不静默漏检）。
- UI 降级：svg 渲染异常时按钮仍保留 `title` / `aria-label` 完整文案兜底；Storybook 不可用时走 `npm run dev` 手工目检路径。

## 6 参数校验

- `IconProps`（`size?: number`）与 `ShareMenuButtonProps` 均为 TS strict 编译期约束，本次不新增运行时校验（最小改动，纯展示组件无非法值风险面）。
- 测试矩阵覆盖 size 边界：14 / 16 / 28（单测）+ 64（Storybook 放大目检）；未传 size 时 BaseIcon 默认 16。

## 7 基础测试用例矩阵

| 类别     | 用例                                                     | 期望                    |
| -------- | -------------------------------------------------------- | ----------------------- |
| 正常渲染 | IconShare 渲染 svg + 3 path + 1 circle，关键描边属性正确 | 结构完整                |
| 正常渲染 | ShareMenuButton 触发 / 三渠道（既有用例）                | 全绿不回归              |
| 边界尺寸 | 分享家族 4 图标端点 ∈ [0.5, 23.5]；size=14/16/28 方形    | 修复前红灯 → 修复后绿灯 |
| 异常状态 | 扫描器未知命令抛错；disabled / Esc 关闭（既有）          | 显式失败 / 行为不变     |

## 8 改动边界（明确不动）

`BatchActions.tsx`、`ContextMenu.tsx`、`globals.css`、其余 60+ 图标、i18n 文案均不动；不引入图标库；不加 `@ts-ignore`；不顺手格式化无关代码。

## 9 执行记录（2026-09-30 已完成）

- [x] T1 红灯确认：`npx vitest run src/renderer/icons/index.test.tsx` → **1 failed | 9 passed**，失败信息正是根因：`path 端点 (24, 8) 越界，d="M12 3a17 17 0 0 1 12 5"`。期间发现并修正扫描器自身缺陷（S/Q 命令终点应取 args[2..3]，误按 C 的 args[4..5] 处理导致 IconWeChat 误报）。
- [x] T2 绿灯确认：`icons/index.tsx` 首条弧线 `M12 3a17 17 0 0 1 12 5` → `M12 3a17 17 0 0 1 11 4.5`（终点 (23, 7.5)），重跑 → **10 passed (10)**。
- [x] T3 红灯→绿灯确认：`ShareMenuButton.test.tsx` 新增用例先红（`expected 'relative' to contain 'flex-shrink-0'`，1 failed | 23 passed）→ `ShareMenuButton.tsx` 包装层改为 `relative flex-shrink-0` 后 **24 passed (24)**。
- [x] T4 Storybook 验证：`npm run storybook` 启动无编译错误（v10.5.10，preview 207ms）；新故事 `Icons/ShareIconFamily` iframe 正常渲染；浏览器截图目检 64px 档——IconShare 外弧右端圆头完整、无切平，右侧留白正常。
- [x] 局部回归：`npm run test:renderer` → **127 文件 / 1697 测试全绿**。
- [x] 全局回归：`npm test` → **294 文件 / 4905 测试全绿**；`npm run typecheck`（tsc -b）→ **0 错误**；`npm run lint`（eslint .）→ **0 错误**。

### 本次改动文件清单

| 文件                                                      | 变更                                                   |
| --------------------------------------------------------- | ------------------------------------------------------ |
| `src/renderer/icons/index.tsx`                            | IconShare 首条弧线终点收进安全区（1 行 + 注释）        |
| `src/renderer/components/common/ShareMenuButton.tsx`      | 触发器包装层加 `flex-shrink-0`（1 行 + 注释）          |
| `src/renderer/icons/index.test.tsx`                       | 新建：分享家族图标几何守卫 + 方形比例 + 扫描器异常用例 |
| `src/renderer/components/common/ShareMenuButton.test.tsx` | 追加包装层 flex-shrink-0 防回归用例                    |
| `src/renderer/icons/index.stories.tsx`                    | 新建：Icons/ShareIconFamily 多尺寸视觉验收故事         |
| `docs/plans/2026-09-30-fix-share-icon-clipping.md`        | 本计划与执行记录                                       |

### 最终用户验收路径

1. `npm run storybook` → `Icons/ShareIconFamily`：64px 档放大目检 IconShare 外弧右端圆头完整；`Common/ContextMenu`（分享子菜单）、`Gallery/BatchActions`（FullFeatured）、`Common/ShareMenuButton` 同步可视验收。
2. `npm run dev` 手工路径：图库 / 截图 / 收藏 / 启动器缓存选中图片 → 右键 →「分享」项及子菜单图标完整；多选 → 底部批量栏「分享」「WiFi 分享」按钮图标完整；重复文件页右键同理。
