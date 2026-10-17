# 图库选中态显著度与遮挡修复（2026-10-17）

- 日期：2026-10-17
- 分支 / 基线 HEAD：`feat/gallery-runtime-embed` @ `0a1be73`
- 状态：已执行完毕（TDD 落地与实测读数见 §10；本文档随本轮改动一并入库）
- 上一轮同类工作：`docs/archive/plans/2026-10-17-fix-image-selection-border-visibility.md`
  （已归档；它引入的「常驻 `::after` 描边层 + 双线内衬」被 3 个守护测试锁死，本轮在其之上做增量）

## 0. 背景（Context）

用户反馈：图片选择场景（图库网格多选、导入向导预览等）下，选中态图片边框**不显眼、被遮挡、
缺乏视觉层次、辨识度低**。

实测结论：用户描述的选中态**此前已被修过一次**。现状是 `src/renderer/styles/globals.css`
里一套「常驻 `::after` 描边层（2px `var(--accent)`）+ 2px `var(--bg-primary)` 双线内衬」，
并由下列守护测试钉死，改动必须保持它们全绿：

| 守护测试                                                        | 锁定的内容                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/renderer/styles/media-card-selection.test.ts`              | `::after` 必须含 `border: 2px solid transparent`；`.media-card.is-selected` 必须含 `var(--accent-soft,` 与 `var(--shadow-lg,`；`is-selected::after` 必须含 `border-color: var(--accent)` 与 `inset 0 0 0 2px var(--bg-primary`；`:hover::after` 必须含 `var(--accent-deep,`；选中态四个选择器**禁** `transform:` 与 `will-change`；全部 `var()` 带 fallback；`tailwind.config.ts` 的 `ringColor.DEFAULT` / `ringOffsetColor.DEFAULT` |
| `src/renderer/styles/layer-budget.test.ts`                      | `.media-card` 不得有 `will-change`；`.media-card:hover` 必须保留 `transform: scale(`                                                                                                                                                                                                                                                                                                                                                 |
| `src/renderer/components/gallery/media-card-selection.test.tsx` | 四视图必须含 `'is-selected'` 且**禁** `ring-offset-2` / 内联 `--tw-ring-color`                                                                                                                                                                                                                                                                                                                                                       |

因此「选中态加 `ring-2 ring-primary`」与「微缩放动画」两条直觉方案**都会直接踩破上述断言**
（ring-offset 恒为 `#fff` 正是上一轮修掉的缺陷；`transform` 缩放被明确禁止，避免与 hover
的 `scale(1.02)` 打架造成网格抖动）。

本轮**不重做**，只修上次改动确实没解决的两个残留缺陷：

1. **遮挡（主因，已 grep 证实）**：`.media-card*` 全部规则里**没有任何 `z-index`**
   （`globals.css` 现有 6 处 `z-index:` 均与卡片无关）。而 `.media-card:hover`
   （L1247-1250）带 `transform: scale(1.02)`，**会新建层叠上下文**——于是「悬停中的邻居卡片」
   绘制在「已选中但静止的卡片」之上，把选中外环与描边直接盖掉。多选时鼠标划过相邻图片，
   选中态时有时无，即用户所说「被遮挡」。
2. **不显眼（已实测数值）**：选中态唯一的外向信号是 `0 0 0 3px var(--accent-soft)`
   （L1278-1282），而 `--accent-soft` 默认仅 **12% alpha**（`globals.css:24`）、柔粉主题
   **14%**（`soft-pink-luxury.css:20`），3px 光环在深底上近乎不可见。

预期结果：选中卡片在默认 / 柔粉两套主题下都有「贴边实色环 + 光晕 + 柔光 + 浮起阴影」四层
重量，且任何情况下不被相邻卡片覆盖；键盘焦点卡片的描边同样不被遮挡。

**范围（已与用户确认收窄）**：只动 `src/renderer/styles/globals.css` 的 `.media-card` 规则
与一处 CSS 注释语法 bug。**不改任何组件 `.tsx`**；ListView / DuplicatesPage / RecycleBinPage /
ImportWizard 各自的选中态缺陷登记在 §7「本次不做」，另行立项。

---

## 1. 依赖声明

**零新增依赖。** 不引入 shadcn/ui、不引入任何 UI 库、不引入动画库（仓库已有 `motion@12.42.2`，
本轮用不到——选中态过渡沿用 `::after` 既有的纯颜色插值，杜绝闪现与重排）。

复用的既有 CSS / UI 方案：

| 复用项                                                                          | 出处                                                                                 | 用途                                                         |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `color-mix(in srgb, var(--accent) N%, transparent)` 派生令牌手法                | `globals.css:42` `--focus-ring`、`globals.css:654` `.card-hover`                     | 新增 `--selection-halo`                                      |
| `--shadow-lg` / `--accent` / `--accent-soft` / `--accent-deep` / `--bg-primary` | `globals.css:13-122` `:root`，柔粉主题逐条覆写                                       | 选中态四层视觉                                               |
| `--accent` 主题派生链                                                           | `soft-pink-luxury.css:16` `--accent: #e2a4bc`（挂在 `html.soft-pink-luxury` 变量块） | 新令牌自动跟随主题，**主题文件零改动**                       |
| fs 源码结构断言范式（`readStripped` + `ruleBlockOf`）                           | `styles/media-card-selection.test.ts:32-49`、`styles/layer-budget.test.ts:26-42`     | 新测试逐字复用同一对 helper                                  |
| `reduce-motion` 降级链                                                          | `globals.css:192-240`、`globals.css:1496-1535`                                       | 零新增分支：`z-index` 不是 transform，减动效下选中态照样成立 |

## 2. 视觉与交互设计

改 `src/renderer/styles/globals.css`，共四处新增/替换 + 一处注释修复。

**(a) 新增令牌**（`:root`，紧跟 L42 `--focus-ring` 之后）：

```css
/* 选中态外扩光晕：由 --accent 派生（同 --focus-ring 手法），主题切换自动跟随——
     不直接用 --accent-soft（默认 12%/柔粉 14% alpha），3px 光环在深底上近乎不可见 */
--selection-halo: color-mix(in srgb, var(--accent) 38%, transparent);
```

派生原理（已核实）：主题变量块选择器是 `html.soft-pink-luxury`（特异性 0,1,1 > `:root` 的 0,1,0）
且作用在**同一个 html 元素**上，故该元素上 `--accent` 计算为粉色后，`--selection-halo` 的
`color-mix()` 在同一元素求值得到粉色光环，再向下继承。与既有 `--focus-ring` 完全同一机制，
柔粉主题无需任何改动。

**(b) 悬停抬层**（替换 L1247-1250；`transform: scale(` 必须保留，被
`layer-budget.test.ts:51-55` 锁定）：

```css
.media-card:hover {
  z-index: 1;
  transform: scale(1.02);
  box-shadow: var(--shadow-lg);
}
```

**(c) 选中态四层视觉 + 抬层**（整块替换 L1278-1282）：

```css
.media-card.is-selected {
  z-index: 2;
  /* 由内而外：贴边 2px 实色 accent 环（最高对比）→ 5px 主题光晕带 → 柔光 → 浮起阴影。
     box-shadow 列表前者压后者，故实色环不被光晕冲淡；::after 的双线内衬原样保留 */
  box-shadow:
    0 0 0 2px var(--accent, #0078d4),
    0 0 0 5px var(--selection-halo, var(--accent-soft, transparent)),
    0 0 14px 5px var(--accent-soft, transparent),
    var(--shadow-lg, 0 4px 20px rgba(0, 0, 0, 0.15));
}
```

设计取舍：

- **保留** `::after` 的「2px accent 描边 + 2px `--bg-primary` 内衬」双线框语义，只**加外缘重量**，
  churn 最小；「选中 ≠ 悬停」的层次区分仍由 `--accent-deep` 承担（L1290-1292 不动）。
- 实色环 2px 紧贴卡片边缘、与 `::after` 描边之间无间隙，视觉读作「加粗实色外框」，
  辨识度远高于单纯提高光环 alpha，且不依赖任何 alpha 数值猜测。
- 光环带最外 **5px**，小于网格间距 16px（`VirtualImageGrid.tsx:222`、`MasonryView.tsx:31`、
  `TimelineView.tsx:34`、`EventTimelineView.tsx:35`），**相邻两张选中卡的光环不会粘连**。
- 全部颜色走主题变量并带硬编码 fallback，符合 `.qoder/rules/project-conventions.md` §3
  「CSS 变量优先于硬编码颜色值」（fallback 值属既有同类写法，见 L1280 现状）。

**(d) 层叠排序**（新增于 L1292 之后，写成两条独立规则以便 `ruleBlockOf` 逐条断言）：

```css
/* 遮挡修复：层序 未选中(0) < 悬停(1) < 选中(2) < 选中且悬停 / 键盘焦点(3)。
   `.media-card:hover` 与 `.media-card.is-selected` 同为 (0,2,0)，靠源序（L1278 晚于 L1247）
   让选中压悬停；再补 (0,3,0) 保证「选中且悬停」不被后续 DOM 兄弟中的悬停卡追平 */
.media-card.is-selected:hover {
  z-index: 3;
}

.media-card:focus-visible {
  z-index: 3;
}
```

焦点抬层仅在卡片可聚焦的视图生效（`VirtualImageGrid.tsx:520`、`TimelineView.tsx:208`、
`EventTimelineView.tsx:299` 带 `tabIndex`；`MasonryView` 无），对其余视图是无害空规则。

**(e) CSS 注释提前闭合 bug**（L277-282）：注释正文含 `.btn-*/`，其中 `*/` **提前闭合注释块**，
使 L279 变成非法选择器垃圾串，导致其后

```css
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

这条**全局键盘焦点可见性基线被 CSS 解析器整条丢弃**（node 实测：按 `/\*[\s\S]*?\*/` 剥离注释后
全文恰残留 **1 个** `*/`，即截断点）。把注释正文改写为 `.btn-* / .icon-btn / .select /
.input-field` 形式，让规则真正生效。它与「键盘多选的辨识度」直接相关，故纳入本轮。

## 3. 启动与验证说明

环境：仓库根目录，Windows x64，无需额外准备。`node -v` 实测 **v26.3.0**（满足 `package.json` 的 `engines`）；注意别与 Qoder 运行时内置的 Node 24.18.0 混淆——闸门命令都在开发机 shell 里跑，读数以 `node -v` 为准。

```bash
npm test -- src/renderer/styles              # 样式目录（新测试 + 3 个既有守护测试）
npm run test:renderer                        # 渲染层全量
npm run verify                               # 只读：tsc -b + eslint + core-gate + prettier --check + 相关单测
npm test                                     # 全量回归（本轮基线规模读数 408 文件 / 6312 测试）
npm run typecheck && npm run lint            # 静态检查
npx prettier --write src/renderer/styles/globals.css
npm run storybook                            # 视觉验收，见 §5
npm run dev                                  # 备选：真实应用内验收
```

**格式化注意事项（会造成断言假失败）**：`globals.css` 在 lint-staged 的 prettier 作用域内
（`src/**/*.{js,jsx,json,css,md}`），且**当前该文件 prettier-clean**。因此每个 CSS 节点写完后
必须先 `npx prettier --write`，再按 prettier 落地后的字面量核对测试里的 `toContain(...)` 串，
尤其是多行 `box-shadow` 的缩进与换行。

**为何走源码结构断言**：jsdom 不应用 CSS 文件，CSS 规则改动只能靠 fs 读取源码断言
（仓库既有范式即如此）。本轮不改任何 className 计算，故无需新增渲染级测试。

**无需 `@core-change` 授权注释**：`scripts/core-path-gate.ts` 的 `PROTECTED_GLOBS` 只覆盖
`src/main/preload/api`、`src/main/ipc/handlers`、`src/main/services`、`src/shared/errors`，
不含 `src/renderer`。

## 4. 子任务清单（TDD 节点）

每个节点严格执行「红灯 → 改码 → 绿灯 → 子集回归」，逐节点推进，不跳步。

### T0 计划落盘

- **文件**：新建 `docs/plans/2026-10-17-selection-prominence-and-occlusion.md`（本文档）。
- **输入 / 输出**：输入为已批准的实施计划；输出为仓库内 MD 计划文件，含 §1–§6 六节结构。
- **验收标准**：文件存在且六节齐全；slug 不与归档的
  `docs/archive/plans/2026-10-17-fix-image-selection-border-visibility.md` 冲突；
  编码为 UTF-8 无 BOM、行尾 LF；`scripts/check-md-links.ts` 死引用守护对其通过。

### T1 红灯：新建显著度 / 遮挡测试

- **文件**：新建 `src/renderer/styles/selection-prominence.test.ts`。
  `.test.ts` 落在 vitest **node** 项目（`vitest.config.ts` 的 jsdom 项目只收
  `src/renderer/**/*.test.tsx` 与 `src/renderer/hooks/**/*.test.ts`），与
  `media-card-selection.test.ts`、`layer-budget.test.ts` 同环境。
- **输入 / 输出**：输入为 §2 的目标样式；输出为一个必然多红的断言文件。
  helper `readStripped()` / `ruleBlockOf(css, selector)` 从 `media-card-selection.test.ts:32-49`
  **逐字复制**，不抽公共模块（两处均已内联，守护测试文件不宜被动）。
- **红灯断言**（每条今天都失败）：
  1. `:root` 派生令牌：`expect(globalsCss).toContain('--selection-halo: color-mix(in srgb, var(--accent) 38%, transparent);')`
  2. 贴边实色环：`expect(ruleBlockOf(globalsCss, '.media-card.is-selected')).toContain('0 0 0 2px var(--accent,')`
  3. 光晕走新令牌：同上选择器 `toContain('var(--selection-halo,')`
  4. 柔光层保留 `--accent-soft`：同上选择器 `toContain('0 0 14px 5px var(--accent-soft,')`
  5. 三档层序递增：`.media-card:hover` 含 `z-index: 1`；`.media-card.is-selected` 含 `z-index: 2`；
     `ruleBlockOf(globalsCss, '.media-card.is-selected:hover')` 含 `z-index: 3`（今天该规则不存在
     → 返回空串 → 失败）
  6. 焦点卡抬层：`ruleBlockOf(globalsCss, '.media-card:focus-visible')` 含 `z-index: 3`
- **安全网断言**（写在同文件，今天即通过，非红灯）：对 `.media-card::after`、
  `.media-card.is-selected`、`.media-card.is-selected::after`、`.media-card.is-selected:hover::after`、
  `.media-card.is-selected:hover`、`.media-card:focus-visible` 六个选择器逐一断言
  `block.includes('transform:') === false` 与 `block.includes('will-change') === false`，
  证明本轮没有为了好看踩破「虚拟列表动效仅限 transform/opacity + 图层预算」红线。
- **验收标准**：`npm test -- src/renderer/styles/selection-prominence` **失败**，
  且失败原因全部是断言不匹配（不是文件读不到 / TS 语法错误）；失败用例数 ≥ 6。

### T2 绿灯：落地 §2 的 (a)(b)(c)(d)

- **文件**：`src/renderer/styles/globals.css`，仅四处——`:root` L42 后、L1247-1250、L1278-1282、L1292 后。
- **输入 / 输出**：输入为 T1 的断言字面量；输出为上述 CSS 规则。
- **验收标准**：先 `npx prettier --write src/renderer/styles/globals.css`，随后
  `npm test -- src/renderer/styles` **全绿**（新测试与 3 个既有守护测试一起绿）。
  子集回归：`npm test -- src/renderer/styles src/renderer/components/gallery`。

### T3 强化既有守护测试（只增不减）

- **文件**：`src/renderer/styles/media-card-selection.test.ts`，在
  `选中态规则（R3…）` describe 内**追加**用例。
- **输入 / 输出**：输入为 T2 已落地的 CSS；输出为一条新断言
  `expect(ruleBlockOf(globalsCss, '.media-card.is-selected')).toContain('z-index:')`
  及中文注释「遮挡根因：选中卡层序必须高于悬停邻居」。
- **禁止**：修改或删除任何既有断言。逐条复核新 CSS 仍满足
  `border: 2px solid transparent`、`var(--accent-soft,`、`var(--shadow-lg,`、
  `inset 0 0 0 2px var(--bg-primary`、`var(--accent-deep,`、禁 transform / 禁 will-change、
  ring 令牌断言；`var(--selection-halo, var(--accent-soft, transparent))` 的嵌套兜底
  保持「每个 `var()` 都有 fallback」不变。
- **验收标准**：`npm test -- src/renderer/styles/media-card-selection` 绿；
  `git diff` 对该文件**只见新增行、无删除行**。

### T4 红 → 绿：注释截断 bug

- **文件**：`src/renderer/styles/selection-prominence.test.ts`（追加一个 describe）、
  `src/renderer/styles/globals.css:277-282`。
- **红灯**（已实测确定失败）：
  ```ts
  it('核心：全局 :focus-visible 基线未被提前闭合的注释吞掉', () => {
    // 剥离 /* */ 后仍残留 '*/'，说明某处注释正文含 '*/' 提前闭合，其后规则整条被解析器丢弃
    expect(globalsCss.includes('*/'), 'globals.css 存在提前闭合的注释').toBe(false)
    expect(globalsCss).toContain(':focus-visible {')
  })
  ```
  ⚠️ **假绿灯陷阱**：第二条 `toContain(':focus-visible {')` **今天就通过**（垃圾串尾部恰好带
  该文本），真正的红灯是第一条。不得只写第二条。
- **改码**：改写 L277-279 注释正文（`.btn-*/` → `.btn-* / .icon-btn` 等安全写法），
  保证注释成对闭合、规则体完整。
- **验收标准**：`npm test -- src/renderer/styles/selection-prominence` 全绿；
  残留 `*/` 计数由 1 变 0。

### T5 全局回归 + 视觉验收

- **命令**：`npm run verify` → `npm test` → `npm run typecheck` → `npm run lint`。
  CI 另跑 `npm run i18n:guard`；本轮零新增文案 key，预期无变化。
- **提交**：Conventional Commits，
  `fix(gallery): 选中态贴边实色环与层序抬升，修复悬停邻居遮挡`。**不 push**（需另行授权）。
- **验收标准**：全部通过，`git status --porcelain` 无钩子遗留改动；§5 勾选项全部落地。

## 5. 视觉手动验收（Dev / Storybook）

入口：`npm run storybook` → `Gallery/VirtualImageGrid` → **`WithMultiSelect`** story
（`src/renderer/components/gallery/VirtualImageGrid.stories.tsx:56-66`，上一轮留下的既定入口），
工具栏 `theme` global 可切 default ↔ soft-pink-luxury。

- [ ] 默认主题：选中卡的 2px 实色环 + 光晕清晰可辨，双线内衬未被外环糊成一片。
- [ ] 柔粉主题：外环随 `--accent` 自动变粉（`#e2a4bc`），无蓝色残留、无白圈。
- [ ] **遮挡专项**：鼠标划过选中卡的**相邻**图片，选中环不被盖住、不闪、不消失。
- [ ] 选中 / 取消过渡平滑：无 `content` 从无到有的闪现、无布局抖动（`::after` 仍只过渡颜色）。
- [ ] 键盘 Tab：焦点卡描边可见且不被邻居遮挡。
- [ ] 快速滚动：无卡顿；DevTools Layers 面板确认无新增常驻合成层（`will-change` 仍为 0 处）。
- [ ] 设置开启「减少动效」（`html.reduce-motion`）：`transform` 归零后选中态**依然醒目**。
- [ ] 极端尺寸：网格滑到最小 / 最大缩略图，外环不与相邻光环粘连，边缘行光晕裁切可接受。

## 6. 错误处理与降级

| 场景                                                                                                  | 行为                                                                                     | 兜底                                                                                         |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `--selection-halo` 缺失（旧主题文件未更新 / 变量块选择器写错）                                        | `var(--selection-halo, var(--accent-soft, transparent))` 双层兜底                        | 退化为改动前的 12% 光环，不会出现「无描边」                                                  |
| `--accent` / `--shadow-lg` / `--accent-soft` 缺失                                                     | 每条声明都带硬编码 fallback（`#0078d4` / `0 4px 20px rgba(0,0,0,0.15)` / `transparent`） | 卡片仍有实色环与阴影；守护测试断言的正是「每个 `var()` 均带 fallback」                       |
| 主题文件误用 `.<class>` 而非 `html.<class>` 声明变量                                                  | `:root` 同特异性、后源序会整块压掉覆写（`src/renderer/AGENTS.md` §3 已明文禁止）         | 派生令牌退回默认蓝；本轮不改主题文件，靠既有约定与 §5 柔粉勾选项拦截                         |
| 样式表加载失败（CSS 404）                                                                             | `is-selected` 语义类仍在 DOM 上，`aria-selected` 仍正确                                  | 选中状态仍可由 `MediaCheckbox` 勾选态表达，功能不依赖描边                                    |
| 极端小图（几 px），外环宽度可能超过卡片本身                                                           | 2px / 5px 固定像素环                                                                     | 视觉退化为「实心小块」，仍可辨识；不引入容器查询（超范围）                                   |
| 边缘行被滚动容器 `overflow-hidden` 裁掉光环（`AppShell.tsx:154/171/172`、`VirtualImageGrid.tsx:443`） | 最外圈 5px 光晕在贴边行被裁                                                              | **已知限制**：故光环 spread 压到 ≤5px；不给滚动容器改 `overflow: visible`（会破坏 Virtuoso） |
| `reduce-motion`                                                                                       | 仅 `transform` 被 `!important` 归零，`z-index` 与 `box-shadow` 不受影响                  | 选中态在减动效下完整成立（§5 勾选项）                                                        |
| 图层预算风险                                                                                          | 只用 `z-index`，不新增 `will-change`                                                     | `layer-budget.test.ts` + T1 安全网断言双重拦截                                               |

层叠安全（已核实）：卡片 z-index 最大 3；全部浮层为 `fixed` 且 `z-40`…`z-[110]`
（`BatchActions.tsx:71`、`TitleBar.tsx:9`、`ContextMenu.tsx:171/233`、`BaseDialog.tsx:120`、
`Tooltip.tsx:146`），`.sidebar-gradient` 带 `isolation: isolate`（L336）把卡片层序封在本容器内；
`MediaCheckbox` 的 `z-10` 是卡片**子级**，卡片成为其层叠上下文根后内部顺序不变。

## 7. 基础测试用例矩阵

| 类别 | 用例                                                         | 手段                                                     | 落点                                              |
| ---- | ------------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------- |
| 正常 | 选中卡带贴边 2px 实色 accent 环                              | fs 源码断言                                              | T1#2                                              |
| 正常 | 未选中卡不带 `is-selected`，仅 hover 描边                    | 既有渲染断言（不改）                                     | `media-card-selection.test.tsx:79-85`             |
| 正常 | 光晕取自 `--selection-halo`，且 `:root` 由 accent 派生       | fs                                                       | T1#1、#3                                          |
| 遮挡 | `hover(1) < selected(2) < selected:hover(3)` 三档递增        | fs                                                       | T1#5                                              |
| 遮挡 | 键盘焦点卡 `:focus-visible` 抬到 3                           | fs                                                       | T1#6                                              |
| 异常 | 主题切换：柔粉 `--accent` 覆写使外环自动变粉                 | Storybook 手验（`color-mix` 引用 var，无法静态断言色值） | §5                                                |
| 异常 | CSS 注释提前闭合（残留 `*/` 为 0）                           | fs                                                       | T4                                                |
| 异常 | 主题变量缺失 → 每条声明带 fallback 仍成环                    | fs（沿用既有 fallback 断言）                             | `media-card-selection.test.ts:116-131` + T3       |
| 异常 | 缩略图加载失败降级为占位图后，选中语义仍在                   | jsdom 渲染（既有）                                       | `media-card-selection.test.tsx:131-138`           |
| 边界 | 选中态禁 `transform` / 禁 `will-change`（含新增两条 z 规则） | fs 安全网                                                | T1 安全网 + `media-card-selection.test.ts:90-113` |
| 边界 | 光环 spread ≤5px < 网格 gap 16px，多选相邻不粘连             | fs 断言 spread 字面量 + Storybook 手验                   | T1#3/#4、§5                                       |
| 边界 | 极小 / 极大缩略图、边缘行被 `overflow-hidden` 裁切           | Storybook + `npm run dev` 手验                           | §5                                                |
| 边界 | `reduce-motion` 下选中态仍醒目                               | Storybook 手验                                           | §5                                                |

## 8. 关键文件

- `src/renderer/styles/globals.css` — 唯一被改的生产文件（`:root` L42 后、L1247-1250、
  L1278-1282、L1292 后，另 L277-282 注释修复）
- `src/renderer/styles/selection-prominence.test.ts` — 新建
- `src/renderer/styles/media-card-selection.test.ts` — 仅追加断言
- 只读参照：`src/renderer/styles/layer-budget.test.ts`、
  `src/renderer/components/gallery/media-card-selection.test.tsx`、
  `src/renderer/styles/themes/soft-pink-luxury.css`、
  `src/renderer/components/gallery/VirtualImageGrid.stories.tsx`

## 9. 本次不做（已知问题，另行立项）

1. `src/renderer/components/gallery/ListView.tsx:123-128` — 选中行缩略图容器
   `opacity: isSelected ? 0.18 : 1`，而该容器**包含** `<ThumbReveal>`（L133），
   等于「选中即看不清」；同时整行实心反白 `background: var(--accent)` + 硬编码 `'white'`，
   与全站「`--accent-soft` 底 + `--accent` 标记」的选中芯片写法不一致。
2. `src/renderer/pages/DuplicatesPage.tsx:1589` — `opacity: selected ? 0.7 : 1`，
   选中比未选中**更不显眼**；且 L1584-1588 内联 `boxShadow` 顶掉了 `.glass-card` 自身投影。
   注：`--danger` 表达「标记待删」的语义应保留，只修显著度。
3. `src/renderer/pages/RecycleBinPage.tsx:523-526` — `ring-2` 类与内联
   `0 0 0 2px var(--accent)` 两套描边机制叠成双线环，内联 boxShadow 同样顶掉玻璃卡投影。
4. `src/renderer/components/gallery/ImportWizard.tsx:390` — 硬编码
   `rgba(255, 184, 0, 0.06)`（6% alpha，近乎不可见，应走 `--warning-bg` 令牌）+
   无效的 `hover:bg-opacity-50`。注：该向导预览只列图标与文件名，**没有缩略图网格**。
5. `src/renderer/pages/OutfitGalleryPage.tsx:79-131` — `OutfitCard` 无选中态；
   它本身是不可多选的导航按钮，属误列，无需处理。

## 10. 执行记录（2026-10-17）

状态：**已执行完毕**（本文档随本轮提交入库）。

### 落地改动

- `src/renderer/styles/globals.css` — `:root` 新增 `--selection-halo`；`.media-card:hover`
  加 `z-index: 1`；`.media-card.is-selected` 换为四层 `box-shadow` + `z-index: 2`；
  新增 `.media-card.is-selected:hover` 与 `.media-card:focus-visible`（均 `z-index: 3`）；
  修复 L280-282 注释提前闭合，恢复全局 `:focus-visible` 基线。
- `src/renderer/styles/themes/soft-pink-luxury.css` — **计划外新增**，见下方缺陷 D3。
- `src/renderer/styles/selection-prominence.test.ts` — 新建，17 用例。
- `src/renderer/styles/media-card-selection.test.ts` — 追加 1 条 z-index 断言（diff 7 增 0 删）。

### D3：计划 §2 的层叠推断有误，由浏览器实测抓出

计划原判断「主题文件 `@import` 位于 globals 之前，故 globals 的 `.media-card.is-selected`
源序在后必然胜出」只在生产环境的基础态成立。真实浏览器 computed style 实测：

- `.storybook/preview.ts:3-8` 为了让主题变量能覆盖 `:root`，**在 globals 之后二次引入主题 CSS**，
  源序反转 → `.soft-pink-luxury .media-card`（同为 0,2,0）把选中外环**整条吞掉**，
  computed `box-shadow` 只剩一层粉色柔光（`rgba(226,164,188,0.1) 0px 4px 14px`）。
- 更严重的是 `.soft-pink-luxury .media-card:hover` 为 **(0,3,0)**，无论源序都压过 (0,2,0)
  的选中态 ⇒ **生产环境里「悬停一张已选中的卡片」同样会让外环消失**。
  这正是用户所说「被遮挡」的另一半成因，纯源码结构断言无法发现。

修复：把主题对宿主阴影的两条声明限定为 `:not(.is-selected)`，让选中态归 globals 所有、
与源序解耦（不用 `!important`、不参与特异性军备竞赛）。先写 2 条红灯用例复现，再改码转绿。

### 验证方式与局限

**截图不可用**：Qoder 内置浏览器表面处于 hidden 状态
（`visibilityState=hidden`，`take_screenshot` 报 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`），
Virtuoso 也因 rAF 被挂起而不渲染列表项。因此**未做肉眼视觉确认**，改为读取真实浏览器
CSSOM 与 computed style 做程序化验证（比肉眼更能证明层序与色值）：

| 勾选项                  | 实测结果                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 默认主题选中卡          | `z-index: 2`，5 层阴影，第 1 层 `rgb(0,120,212) 0 0 0 2px`（实色环）、第 2 层 `color(srgb 0 .47 .83 / .38) 0 0 0 5px`（光晕） |
| 柔粉主题选中卡          | 第 1 层 `rgb(226,164,188) 0 0 0 2px` ⇒ **外环随 `--accent` 自动变粉，无蓝色残留**                                             |
| 柔粉主题未选中卡        | 仍为 `rgba(226,164,188,0.1) 0px 4px 14px` ⇒ 主题原有卡片质感未被本次改动破坏                                                  |
| `--selection-halo` 派生 | 默认解析为 `color-mix(in srgb, #0078d4 38%, transparent)`，加主题类后变 `#e2a4bc` ⇒ 证实「主题零改动即跟随」                  |
| 层序                    | `.media-card` 基态 `auto`；CSSOM 确认 hover=1 / is-selected=2 / is-selected:hover=3 / focus-visible=3                         |
| `reduce-motion` + 柔粉  | `transform: none` 下 `z-index: 2` 与实色环第 1 层**依然保留** ⇒ 选中态不依赖动效                                              |
| 注释截断修复            | 真实 CSSOM 现含 `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }` ⇒ 基线规则确已恢复                |
| 悬停邻居遮挡            | 无法用脚本触发 `:hover`；改由选择器本身证明——主题规则带 `:not(.is-selected)` 后，对选中卡片恒不匹配，与源序无关               |

**仍需人工肉眼复核的项**：实际缩略图上的观感与美观度、快速滚动帧率、极端尺寸下的观感、
边缘行光晕被 `overflow-hidden` 裁切的可视可接受度。建议在可见浏览器窗口打开
`http://localhost:6006/iframe.html?viewMode=story&id=gallery-virtualimagegrid--with-multi-select`
（当前 Storybook 已在 6006 端口运行）后用鼠标划过选中卡的相邻图片确认。

### 回归读数

| 项                          | 结果                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| `npm test`                  | 409 文件 / 6330 passed, 2 skipped（基线 408 / 6312 ⇒ +1 文件 +18 用例，全绿）                  |
| styles + gallery 子集       | 21 文件 / 227 passed                                                                           |
| `npm run typecheck`         | 通过（`tsc -b` + `tsconfig.scripts.json`）                                                     |
| `npm run lint`              | 0 errors；11 warnings 全部是既有 DEBT-030（`components/common/*.test.tsx` 的 BOM），本次未新增 |
| `npm run i18n:guard`        | 通过（本次零新增文案 key）                                                                     |
| `npm run verify`            | typecheck / lint / core-gate / test 通过；**format 仅 `README.md` 失败**                       |
| 编码                        | 4 个改动文件均 UTF-8 无 BOM、LF                                                                |
| `scripts/check-md-links.ts` | 无死引用                                                                                       |

**`verify` 的 format 失败项与本任务无关**：`README.md` 在本次会话开始前就已是
` M`（工作区未提交改动，31 增 32 删），且 `git show HEAD:README.md` 经 prettier 检查为
clean ⇒ 不合规来自那份既有改动，不是本轮引入。本轮 4 个文件单独跑
`prettier --check` 全部通过。该 session 未擅自格式化 `README.md`，以免覆盖他人在制内容；
后续审查轮次经用户确认「格式化后一并提交」，已以 `npx prettier --write README.md` 归一
（差异仅为行尾空格、表格竖线对齐、强调标记与空行，零文案变更），并作为独立一笔
`docs(root)` 提交——提交号与复验读数见文末执行记录。
另：工作区存在一条与本任务无关的历史 stash（`phase7-wip-parked`），未触碰。
