# 果冻开关（Jelly Toggle）优化实施计划

> 日期：2026-10-24 ｜ 状态：已完成（红绿证据见文末执行记录）
> 需求：点击后圆点滑向另一端，滑动途中先横向拉长成胶囊形，到达终点回弹恢复圆形；底色从灰色渐变为绿色；时长约 350ms，带回弹的弹簧曲线。

## 一、背景与现状差距

项目内所有开关（`Switch.tsx` 与 `SettingsToggle` 共 15 处生产引用）共用 `src/renderer/styles/globals.css` L1062-1117 的 `.settings-elastic-switch` / `.settings-elastic-switch-knob` 样式，组件 TSX 零动画代码。与目标的差距：

| 需求                 | 现状                                 | 差距             |
| -------------------- | ------------------------------------ | ---------------- |
| 滑动途中拉长成胶囊   | 仅 `:active` 按压时 `scaleX(1.35)`   | 拉伸不在滑动途中 |
| 到达终点回弹恢复圆形 | 无（按压松开后回弹）                 | 缺终点回弹       |
| 底色灰→绿            | 灰→`var(--accent)`（默认主题为蓝色） | 颜色不符         |
| ~350ms 弹簧曲线      | 260ms（曲线已是过冲弹簧）            | 时长不符         |

## 二、方案选型（为什么是纯 CSS）

- **改动面最小**：只改 `globals.css` 一个文件 + 新增一个守卫测试，组件 TSX 零改动，15 处引用自动生效。
- **符合仓库既有约定**：`shared.tsx` 注释明确「交互态微动画统一走 CSS、compositor 合成、不触发 React 重渲染」；`globals.css` L80 已定义 `--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1)`（过冲弹簧）但全仓无消费者，本次正好复用；绿色复用既有 `--success: #10b981` / `--success-deep: #16a34a` 色板。
- **不引入动画库**：项目虽有 `motion` v12，但单测全局 mock 了 `motion/react`（动画不可测）、且会破坏上述 CSS 约定，改动面大。「开/关双向各挂一个 keyframes 动画名，状态翻转即名字变化 → 动画必然重触发」是纯 CSS 开关的成熟通用手法，不算造轮子。
- **关键技术点**：位移（`left`）走 transition、途中拉伸（`transform: scaleX`）走 keyframes——两个属性分离，避免 transition 与 animation 在同一属性上级联竞争（transition 优先级更高会压制 keyframes）；现有 `:active` 按压拉伸正是在 `transform` 上冲突，必须移除。弹簧曲线作用于 keyframes 每一段，末段（1.35→1）自然「掠过 1 再回落」= 终点回弹恢复圆形；`left` 过冲弹簧 = 位置掠过终点再回落。

## 三、依赖声明

**无新增/变更依赖**。纯 CSS + 纯函数测试（fs 读源码断言），不执行 `npm install`。复用令牌：`--ease-spring`、`--ease-standard`、`--success`、`--success-deep`（均已存在于 `globals.css`）。

## 四、子任务与红绿流程

### Step 0：写入计划文件

- 文件：`docs/plans/2026-10-24-jelly-toggle-optimization.md`（本文件）

### Node 1：滑块 350ms 弹簧滑动 + 途中胶囊拉伸 + 终点回弹

1. **红灯**——新建守卫测试 `src/renderer/styles/settings-elastic-switch.test.ts`（node 项目，复刻 `layer-budget.test.ts` 的「剥注释 + 规则块断言」范式）。断言：
   - 正常：knob 规则块 `transition` 含 `left 350ms var(--ease-spring)`
   - 正常：基础块声明 `animation: settings-elastic-switch-jelly-off 350ms var(--ease-spring)`；`[aria-checked='true']` knob 块覆盖 `animation-name: settings-elastic-switch-jelly-on`（双向重触发）
   - 正常：两个 `@keyframes` 均含中途 `scaleX(>1)` 帧与首尾 `scaleX(1)` 帧
   - 边界：拉伸峰值 ≤ 1.4（18px 滑块不溢出 44px 轨道）
   - 异常：源码不得残留 `settings-elastic-switch:active`（transition 会压制 keyframes）
   - 运行 `npx vitest run src/renderer/styles/settings-elastic-switch.test.ts` 确认失败
2. **改代码**——编辑 `globals.css`（L1062-1117 开关块 + L241）：
   - knob `transition` 改为 `left 350ms var(--ease-spring)`（移除 transform 段）
   - 基础 knob 块新增 `animation: settings-elastic-switch-jelly-off 350ms var(--ease-spring)`；checked knob 块新增 `animation-name: settings-elastic-switch-jelly-on`
   - 新增两个同形 keyframes（`0%: scaleX(1)` → `45%: scaleX(1.35)` → `100%: scaleX(1)`）
   - 删除 `:active` 拉伸规则（L1114-1117）与两处 `transform-origin` 声明（对称拉伸用默认 center；锚定端声明反而会在终点溢出）
   - 删除 L241 reduce-motion 组中的死选择器（全局零时长规则 L195-202 已自动降级新动画）
   - 更新块头注释为果冻行为描述
   - 保留 `will-change: left, transform`（既有，`layer-budget` 守卫只盯 `.media-card`）
3. **绿灯**：重跑该测试确认通过
4. **回归子集**：`npx vitest run src/renderer/styles/ src/renderer/pages/settings/shared.test.tsx src/renderer/components/common/Switch.test.tsx src/renderer/pages/settings/general-sections.test.tsx src/renderer/pages/settings/appearance-sections.test.tsx src/renderer/pages/settings/scan-sections.test.tsx`

输入：globals.css 源码；输出：上述 CSS 规则；验收：新测试红→绿 + 回归子集全绿。

### Node 2：轨道底色灰→绿（350ms 渐变）

1. **红灯**——在同一测试文件追加 describe：
   - 正常：`[aria-checked='true']` 轨道块 `background: var(--success)`、`border-color: var(--success-deep)`
   - 正常：轨道颜色 transition 350ms
   - 边界：该块不得再引用 `var(--accent)`（防回归蓝色；focus-visible 的 accent 不在断言范围）
   - 运行确认失败
2. **改代码**：轨道 `transition` 200ms→350ms（改用 `var(--ease-standard)` 令牌）；开启态 `var(--accent)`→`var(--success)` / `var(--success-deep)`
3. **绿灯 + 回归子集**：同 Node 1

### 全局回归（两节点完成后）

按序运行并要求全绿、无新增失败：`npm test`（全量）→ `npm run typecheck` → `npm run typecheck:e2e` → `npm run lint` → `npm run verify`。仓库无内置安全扫描 npm script；`verify` 已含核心路径授权闸门（本次仅改 CSS + 新增测试，不触受保护路径）。`i18n:guard` 不涉及（零文案变更）。

## 五、启动说明与验证方式

- 环境：现有 `node_modules` 即可，无需安装。目测：`npm run dev` → 设置页任意开关（含「动效减弱」开关本身）。动画规格（时长/曲线/帧值/颜色）全部由守卫测试钉死；Playwright e2e 需打包产物且其开关用例断言的是文案与 aria 行为，不受 CSS 动画影响，不在本次范围重跑。

## 六、错误处理与降级

- **reduce-motion**：既有全局规则把所有 animation/transition 时长压至 0.01ms，新动画自动降级，无需新代码。
- **动画不可用兜底**：`left` 与背景色由规则本身定义终态，keyframes 只负责途中 transform——无动画环境直接呈现静止圆形终态，优雅降级。
- **中途反向点击**：`left` 走 transition 可从当前位置平滑重定向（优于纯 keyframes 会跳回 0% 帧）。
- 无新增日志（纯 CSS，无 JS 执行路径）。

## 七、参数校验/边界（由守卫测试锁定）

时长必须 350ms；`scaleX` 峰值 ∈ (1, 1.4]；两方向动画名必须不同；组件 props 契约不变（`checked/onChange/disabled` 等，既有 `Switch.test.tsx`、`shared.test.tsx` T18 继续守护类名挂载点）。

## 八、已知副作用与不改动项

1. **挂载脉冲**：纯 CSS 双态 keyframes 手法在元素首次渲染时也会播一遍——开关挂载瞬间会原地轻微 squash 一次（无位移，350ms）。为该手法的固有代价，接受；如后续觉得干扰可加 mounted 门控收敛。
2. 开启态 focus-visible 焦点环仍为 `--accent` 蓝色（仅聚焦瞬时可见），超出本次需求，不动。
3. 绿色走 `--success` 令牌，柔粉主题未覆盖该令牌 → 两主题一致为绿（符合「灰色渐变为绿色」的明确要求）。

## 九、执行记录（2026-10-24）

- **Node 1**：红灯 5/5 失败（keyframes 不存在、时长 260ms、`:active` 残留）→ 改 globals.css → 绿灯 5/5；期间修复测试助手 `keyframesBlockOf` 的嵌套花括号截断 bug（改深度配平）。回归子集 9 文件 / 79 用例全绿。
- **Node 2**：红灯 3/3 失败（`--accent` 残留、过渡 200ms）→ 轨道改 `--success`/`--success-deep` + 350ms → 绿灯 8/8；回归子集 9 文件 / 82 用例全绿。
- **全局回归**：`npm test` 441 文件 / 6794 通过 / 0 失败；`npm run typecheck`、`npm run typecheck:e2e`、`npm run lint`、`npm run verify` 全部通过；新增测试文件补过 prettier（verify 增量检查不含未跟踪文件）。
- 变更文件：`src/renderer/styles/globals.css`（开关块 + reduce-motion 死选择器清理）、`src/renderer/styles/settings-elastic-switch.test.ts`（新增守卫）、本计划文档。
