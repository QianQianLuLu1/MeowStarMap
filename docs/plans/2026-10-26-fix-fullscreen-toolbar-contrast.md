# 全屏预览顶部工具栏标识对比度修复 · 实施计划

> 日期：2026-10-26
> 目标：修复「图片全屏预览模式下顶部任务栏内标识看不清」。
> 约束：不改布局结构与交互逻辑，只调前景色 / 图标填充 / 描边 / 透明度 / 背景遮罩；复用现有设计变量，禁止硬编码色值；最小化改动。

---

## 0. 根因（已核实）

| 项                   | 事实                                                                                                                                                                                                                                                                                                                                                                                                               | 位置                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| 全屏查看器           | `FullscreenViewer` 是应用内全屏遮罩层（`fixed inset-0`，`background: rgba(0,0,0,0.92)`），非原生 Fullscreen API；由 `App.tsx:401` 全局单例挂载                                                                                                                                                                                                                                                                     | `src/renderer/components/gallery/FullscreenViewer.tsx:384-407`        |
| 顶部工具栏           | 内嵌于查看器，**不是独立组件**，未被其它页面复用                                                                                                                                                                                                                                                                                                                                                                   | `FullscreenViewer.tsx:473-618`                                        |
| **主因（CSS 级联）** | 工具栏按钮写作 `className="icon-btn text-[var(--text-on-overlay)]"`。Tailwind 工具类在第 4~6 行的 `@tailwind utilities` 中展开，而 `.icon-btn { color: var(--text-secondary) }`（#666666）是**裸 CSS、源序在第 820 行**；两者同为 (0,1,0) 特异性 → 后源序的 `.icon-btn` 胜出。图标实际渲染为中灰 `#666666`，hover 时 `.icon-btn:hover`（第 900 行）再把它改成 `#1a1a1a`（近黑），压在黑色遮罩/暗色照片上几乎不可见 | `globals.css:4-6 / 820-834 / 900-904`                                 |
| 次因（背景遮罩）     | 工具栏背景 `linear-gradient(to bottom, rgba(0,0,0,0.6), transparent)`，56px 高的下半段完全透明，按钮下半部直接压在照片上，无任何承载底                                                                                                                                                                                                                                                                             | `FullscreenViewer.tsx:477`                                            |
| 次因（左右导航）     | 上一张/下一张按钮同样带 `.icon-btn`，且内联 `style={{ background: 'rgba(0,0,0,0.4)' }}`（硬编码），白图标最坏仅 2.85:1                                                                                                                                                                                                                                                                                             | `FullscreenViewer.tsx:622-642`                                        |
| 图标取色             | 全部来自 `src/renderer/icons/index.tsx` 的 `BaseIcon`：`stroke="currentColor"`（`IconPlay/IconPause` 为 `fill="currentColor"`）→ **改按钮 `color` 即可生效，无需改 SVG**                                                                                                                                                                                                                                           | `icons/index.tsx:7-29`                                                |
| 主题现状             | 项目只有两个**浅色**主题（`default` / `soft-pink-luxury`），无 dark 主题；`tailwind.config.ts` 未配 `darkMode`。因此「浅色/深色图片背景」指**照片底色**，不是 UI 主题                                                                                                                                                                                                                                              | `styles/themes/index.ts:6-21`                                         |
| 主题冲突             | `.soft-pink-luxury .icon-btn:hover { color: var(--accent-deep) }` 为 (0,3,0)，与新变体的 hover 同分；`.storybook/preview.ts` 刻意在 globals.css **之后**引入主题 CSS（源序反转），故必须加 `:not()` 守卫与源序解耦                                                                                                                                                                                                 | `soft-pink-luxury.css:176`；先例见 `selection-prominence.test.ts:141` |

**已确认的两项决策**：① 工具栏 3 秒自动隐藏保持不动；② 采用「深色半透明胶囊底 + 纯白前景 + 浅色描边」方案。

---

## 1. 依赖声明

| 类别           | 结论                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新增第三方依赖 | **无**。图标、样式、测试全部复用仓库既有能力                                                                                                                                                                                                                                                                                                                                                                                      |
| 变更依赖       | **无**                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 安装方式       | **无需执行 `npm install`**。`node_modules` 已就绪（vitest 5 / @testing-library/react / jsdom 已在用）                                                                                                                                                                                                                                                                                                                             |
| 复用清单       | ① 设计变量沿用 `globals.css :root` 既有 `--text-on-overlay`、`--radius-pill`；② CSS 变体沿用 `.icon-btn.batch-act-btn`（globals.css:838）的「叠加类」既有范式；③ 测试 helper 逐字复用 `src/renderer/styles/selection-prominence.test.ts` 的 `readStripped` + `ruleBlockOf`；④ 组件测试沿用 `FullscreenViewer.keyboardNav.test.tsx` 的 `file()` / `openFullscreen()` 范式；⑤ 主题守卫沿用 `.media-card:not(.is-selected)` 既有手法 |

---

## 2. 改动清单（按文件）

### 2.1 `src/renderer/styles/globals.css`

**输入**：现有 `:root` 变量块（第 13-125 行）与 `.icon-btn` 规则簇（第 820-1031 行）。
**输出**：新增 14 个遮罩控件令牌 + 4 条变体规则块。

**改动点 A —— `:root` 内新增令牌**（插在 `--overlay-gradient-bottom`（124 行）之后、`:root` 闭合 `}` 之前）：

```css
/* 遮罩控件（全屏查看器等压在照片上的图标按钮）三件套：底 / 描边 / 前景。
     与 --text-on-overlay、--overlay-bg*、--overlay-gradient-bottom 同族：它们压在照片上，
     对比度由照片而非 UI 主题决定，故两主题共用同一组值、不进主题变量块。
     取值口径：60% 黑胶囊压纯白照片合成 sRGB 0.4，纯白图标对比度 5.74:1（最坏情况），
     压纯黑照片 21:1；hover 底 0.72 时最坏 9.23:1。本注释正文不得出现注释收尾符号 */
--overlay-control-bg: rgba(0, 0, 0, 0.6);
--overlay-control-bg-hover: rgba(0, 0, 0, 0.72);
--overlay-control-bg-active: rgba(0, 0, 0, 0.78);
--overlay-control-border: rgba(255, 255, 255, 0.28);
--overlay-control-border-hover: rgba(255, 255, 255, 0.45);
--overlay-control-border-active: rgba(255, 255, 255, 0.65);
--overlay-control-fg: var(--text-on-overlay);
--overlay-control-fg-disabled: rgba(255, 255, 255, 0.5);
/* 焦点双色环：外侧白描边 + 内侧暗环，两环直接相邻 21:1，任意照片底色上至少一环可辨
     （单色环在纯白或纯黑照片上必有一端失效） */
--overlay-control-ring: #ffffff;
--overlay-control-ring-shadow: 0 0 0 2px rgba(0, 0, 0, 0.78);
--overlay-gradient-top: linear-gradient(to bottom, rgba(0, 0, 0, 0.6), transparent);
--overlay-title-shadow: 0 1px 3px rgba(0, 0, 0, 0.7), 0 0 10px rgba(0, 0, 0, 0.45);
/* --favorite(#fd79a8) 压在最坏情况（纯白照片上的胶囊）仅 2.32:1，低于 1.4.11 的 3:1；
     提亮后最坏 3.58:1、纯黑底 13.1:1，深浅照片下都能认出「已收藏」 */
--favorite-on-overlay: #ffb8d9;
```

> `--overlay-gradient-top` 取值与现状**逐字相同**（仅去硬编码），视觉零变化。

**改动点 B —— 新增变体规则块**（插在 `.icon-btn:focus-visible`（906-909 行）之后、`.social-btn` 之前）。
⚠️ **必须裸写，绝不能包进 `@layer components`**（globals.css:255 有该层；一旦入层，会被裸的 `.icon-btn` 反向压掉，修复静默失效）。

```css
/* 遮罩上的图标按钮变体（.icon-btn 的叠加态，仅全屏查看器使用）。
   根因：.icon-btn 是裸 CSS，源序在 @tailwind utilities（本文件第 4~6 行）之后，
   Tailwind 工具类 text-[var(--text-on-overlay)] 与它同特异性 (0,1,0) 且源序在前，
   会被整条盖成 --text-secondary(#666666)、hover 再变 --text-primary(#1a1a1a)，
   压在深色遮罩与照片上几乎不可见。
   解法：用两个类把特异性抬到 (0,2,0)，并显式覆盖 hover/focus/disabled 三个态，
   不再与 .icon-btn 的源序赛跑。本块必须裸写：一旦包进 @layer 就会反被 .icon-btn 压掉。
   注意：只声明颜色/描边/圆角，不声明 transform，hover 缩放仍由 .icon-btn:hover 提供 */
.icon-btn.icon-btn-on-overlay {
  color: var(--overlay-control-fg);
  background: var(--overlay-control-bg);
  border: 1px solid var(--overlay-control-border);
  border-radius: var(--radius-pill);
}

.icon-btn.icon-btn-on-overlay:hover {
  color: var(--overlay-control-fg);
  background: var(--overlay-control-bg-hover);
  border-color: var(--overlay-control-border-hover);
}

.icon-btn.icon-btn-on-overlay:focus-visible {
  outline: 2px solid var(--overlay-control-ring);
  outline-offset: 2px;
  box-shadow: var(--overlay-control-ring-shadow);
}

/* 禁用态：压过 .icon-btn:disabled 的 opacity 0.5（半透明会让胶囊在浅色照片上失效），
   改用降透明度前景色区分。WCAG 1.4.3 明确豁免非活动控件的对比度要求 */
.icon-btn.icon-btn-on-overlay:disabled {
  color: var(--overlay-control-fg-disabled);
  background: var(--overlay-control-bg);
  border-color: var(--overlay-control-border);
  opacity: 1;
}
```

**不动清单**：`.icon-btn` 本体、`.icon-btn:hover`、`.icon-btn:focus-visible`、`.icon-btn:disabled`、涟漪 `::after` **一字不改**（由安全网用例 N10/N11 锁死）。

### 2.2 `src/renderer/styles/themes/soft-pink-luxury.css`

**改动点 C —— 第 176 行加守卫**（第 181 行 `.icon-btn.active` 不改）：

```css
/* 排除遮罩变体：本规则与 .icon-btn.icon-btn-on-overlay:hover 同为 (0,3,0)，
   只能靠源序决胜，而 .storybook/preview.ts 刻意在 globals.css 之后再引入本文件
   （源序反转），不守卫的话 Storybook 下全屏工具栏 hover 会被染成 --accent-deep 深粉。
   守卫后与源序解耦，同 .media-card:not(.is-selected) 手法 */
.soft-pink-luxury .icon-btn:hover:not(.icon-btn-on-overlay) {
```

**不动**：不往主题变量块同步 `--overlay-control-*`（对比度由照片决定，与主题无关；同步会触发 `check-preview-drift` 漂移告警）。

### 2.3 `src/renderer/components/gallery/FullscreenViewer.tsx`（9 处按钮 + 4 处配色）

| 行              | 改前                                                                             | 改后                                                                                                      |
| --------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 477             | `background: 'linear-gradient(to bottom, rgba(0,0,0,0.6), transparent)'`         | `background: 'var(--overlay-gradient-top)'`                                                               |
| 483             | 标题 span                                                                        | 追加 `style={{ textShadow: 'var(--overlay-title-shadow)' }}`                                              |
| 499             | `className="icon-btn text-[var(--text-on-overlay)]"`（播放/暂停）                | `className="icon-btn icon-btn-on-overlay"`                                                                |
| 515             | `className="icon-btn text-[var(--text-on-overlay)] text-xs ml-1"`（间隔）        | `className="icon-btn icon-btn-on-overlay text-xs ml-1"`                                                   |
| 542             | `{ color: 'var(--accent)', fontWeight: 600 }`                                    | `{ color: 'var(--accent-light)', fontWeight: 600 }`                                                       |
| 570             | `color={currentFile.is_favorite ? 'var(--favorite)' : 'var(--text-on-overlay)'}` | `'var(--favorite-on-overlay)'`                                                                            |
| 576             | `className="icon-btn text-[var(--text-on-overlay)]"`（信息）                     | `className="icon-btn icon-btn-on-overlay"`                                                                |
| 588             | `style={showInfoPanel ? { background: 'rgba(255,255,255,0.18)' } : undefined}`   | `{ background: 'var(--overlay-control-bg-active)', borderColor: 'var(--overlay-control-border-active)' }` |
| 594 / 602 / 610 | 另存为 / 删除 / 关闭 同 499                                                      | 同 499                                                                                                    |
| 623 / 635       | 左右导航 className 尾部 `text-[var(--text-on-overlay)]`                          | `icon-btn-on-overlay`                                                                                     |
| 625 / 637       | `style={{ background: 'rgba(0,0,0,0.4)' }}`                                      | **整行删除**（底由变体类统一提供）                                                                        |

**不采用 `is-active` 类**：激活态仅 1 处且需随状态切换，用内联 `var()` 覆盖最小，`src/renderer/AGENTS.md:44` 明文许可（「仅动态计算/内联覆盖时用 `style={{ color: 'var(--x)' }}`」）；且 `active` 已被 EditorToolbar/GalleryToolbar/SlideshowPlayer 占用，改名易踩粉主题 `.icon-btn.active`。

**明确不动（防顺手重构）**：3 秒自动隐藏（含 `opacity` / `pointerEvents`）、552 行分隔线 `bg-white/20`、527 行间隔菜单底、491 行 WCO 避让 `marginRight`、519 行 `minWidth/padding`、信息浮层配色（657-661）、按钮 DOM 结构与 `aria-label` 全集。

### 2.4 新增测试文件

| 文件                                                                        | 环境  | 说明                                                |
| --------------------------------------------------------------------------- | ----- | --------------------------------------------------- |
| `src/renderer/styles/fullscreen-toolbar-contrast.test.ts`                   | node  | CSS 契约测试（沿用 `readStripped` + `ruleBlockOf`） |
| `src/renderer/components/gallery/FullscreenViewer.toolbarContrast.test.tsx` | jsdom | 真实渲染 + DOM 断言                                 |

---

## 3. 对比度取值依据（可复算）

- 相对亮度 `L = 0.2126R' + 0.7152G' + 0.0722B'`，`c' = ((c+0.055)/1.055)^2.4`；对比度 `C = (L₁+0.05)/(L₂+0.05)`。
- 胶囊合成（浏览器 sRGB 行为）：`胶囊 = (1-α)·照片`；计算时**忽略**工具栏渐变（下半段已近全透明，保守取值）。

| 胶囊 α   | 纯白照片合成 | L          | 纯白图标对比度                                        |
| -------- | ------------ | ---------- | ----------------------------------------------------- |
| 0.50     | 0.500        | 0.2140     | 3.98 ✗                                                |
| 0.55     | 0.450        | 0.1706     | 4.76 勉强                                             |
| **0.60** | **0.400**    | **0.1329** | **5.74 ✅**（正文 4.5 / 非文本 3.0 双达标，余量 27%） |

- 静息底 0.6 → 最坏 **5.74:1**、纯黑照片 **21:1**；hover 底 0.72 → 最坏 **9.23:1**；激活底 0.78 → 最坏 **11.7:1**。
- 描边 hover 0.45 白 vs 胶囊内 **3.28:1**、激活 0.65 白 **6.03:1** → hover/激活/静息三态互相可辨。
- 禁用态前景 0.5 白 → 2.72:1（WCAG 1.4.3 豁免非活动控件）。
- 间隔菜单选中色：现状 `--accent` #0078d4 压 `rgba(30,41,59,0.95)` 仅 **2.78:1** ✗；改 `--accent-light` → 默认主题 #60cdff **7.01:1**、粉主题 #f5d7e3 **9.43:1** ✅（两主题均已定义，零新增变量，保留主题色相）。
- 收藏激活色：`--favorite` #fd79a8 最坏 2.32:1 ✗ → `--favorite-on-overlay` #ffb8d9 最坏 **3.58:1** ✅ / 纯黑 13.1:1；与未收藏态靠「实心 vs 描边」区分，语义不丢。
- 标题 `text-shadow` 属「感知可辨」而非可公式计算项（现状纯白照片 + 渐变透明处为白压白 1:1）。若评审要求标题也合规，最小改法是给同一 span 补 `background: var(--overlay-control-bg)` + 圆角内边距，不改 DOM。

---

## 4. 启动说明与环境准备

```bash
# 环境（仓库已具备，无需重新安装依赖）
node -v        # 要求 >=22.12.0
# 工作目录
cd "D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe"
```

**开发启动（人工验证用）**

```bash
npm run dev          # electron-vite dev，启动桌面应用
```

**Storybook（可选，验证主题守卫是否生效）**

```bash
npm run storybook    # http://localhost:6006，FullscreenViewer.stories.tsx
```

**如何进入图片全屏预览进行验证（人工验收路径）**

1. `npm run dev` 启动应用 → 进入「图库」页（需先有扫描到的照片；仓库 `data/*.db` 与 `dist/` 已存在，直接看图库即可）。
2. **入口 A（主路径）**：单击任意图片卡片 → 打开全屏预览（`GalleryPage.tsx:362` `openFullscreen(fileIndex)`）。
3. **入口 B**：图片卡片右键菜单 →「打开」；图库时间线 / 事件时间线同样走 `useFileOperations.handleOpen`。
4. **入口 C**：详情页 `DetailPage.tsx:427` 点击图片 → `openFullscreen(currentIndex)`。
5. **入口 D**：重复文件页 `DuplicatesPage.tsx:352` 点击「打开」（该入口显式携带文件列表）。
6. **入口 E**：同步图库页 `SyncGalleryPage.tsx:108`。
7. 打开后观察顶部工具栏（高 56px）：左侧标题，右侧依次为 幻灯片播放/暂停、播放间隔（`3s`）、收藏、图片信息、另存为、删除、关闭；左右两侧中部为上一张/下一张。
8. **验收动作**：① 分别用一张**纯白/高亮**照片与一张**纯黑/暗色**照片打开全屏，确认 7 个图标与标题都清晰；② 鼠标悬停各按钮，确认 hover 态与静息态可区分；③ 点击「图片信息」打开浮层，确认按钮激活态可辨；④ 打开「播放间隔」菜单，确认选中项（默认 3s）可辨；⑤ 点击收藏，确认实心粉心在浅底照片上可辨；⑥ Tab 键走查焦点环；⑦ 切换主题到「柔粉轻奢」（设置 → 外观）后重走 ①-⑥，确认一致。

---

## 5. 错误处理与兜底策略

| 场景                                          | 兜底                                                                                                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新令牌缺失（主题/预览环境未加载 globals.css） | 每个 `var()` 均带既有变量或同文件内就近定义的兜底：`--overlay-control-fg` 回落到 `var(--text-on-overlay)`；按钮缺失令牌时退化为 `.icon-btn` 原样，不会白屏或错位 |
| 变量链断裂                                    | 不在主题块同步 `--overlay-control-*`，杜绝「主题切换后令牌为空」的分支                                                                                           |
| 焦点环在极端底色失效                          | 双色环（外白 + 内暗）互为兜底，任一端失效另一端仍 ≥3:1                                                                                                           |
| 注释提前闭合导致后续规则被解析器丢弃          | 新注释正文**禁止出现注释收尾符号**（既有安全网用例 `expect(globalsCss.includes('*/')).toBe(false)` 守护）                                                        |
| 误把新规则塞进 `@layer`                       | 由用例 N4「源序必须晚于 `.icon-btn:hover`」兜底拦截                                                                                                              |
| jsdom 不解析 `var()`                          | 组件测试只断言**内联 style 字符串**与 class，不依赖 computed 值；若实测 jsdom 丢弃 `var()` 则改为断言 `getAttribute('style')` 原文（执行时先跑一条探针确认）     |
| 测试红灯不红                                  | 执行时**先跑一次**确认 15 条红灯用例全部失败；若有任一修复前即绿，重写该用例后重跑                                                                               |

## 6. 参数校验

本次无新增函数入参；校验落在「CSS 契约」与「DOM 契约」两层：

| 校验对象                               | 必填/边界/非法值处理                                                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `.icon-btn.icon-btn-on-overlay` 规则块 | 必填 `color` / `background` / `border` 三项，缺任一即测试失败                                                                                 |
| 变体源序                               | 必须 `> globalsCss.indexOf('.icon-btn:hover {')`，等于或小于即判失败（等价于「未被塞进更早的 @layer」）                                       |
| hover 块                               | 必须声明 `background: var(--overlay-control-bg-hover)`，且**禁止**出现 `color: var(--text-primary)`（即禁止回落到近黑）                       |
| focus 块                               | 必须声明白环 + 暗环，且**禁止**出现 `var(--accent)`（蓝环在深底仅 2.78:1）                                                                    |
| disabled 块                            | 必须 `opacity: 1`（压过 P2-U7 的 0.5），前景用 `--overlay-control-fg-disabled`                                                                |
| 主题守卫                               | 必须精确匹配 `.soft-pink-luxury .icon-btn:hover:not(.icon-btn-on-overlay) {`；同时禁止残留无守卫的 `.soft-pink-luxury .icon-btn:hover {`      |
| 令牌不越界                             | `softPinkCss` 不得包含 `--overlay-control-` / `--favorite-on-overlay`                                                                         |
| 全局类不被污染                         | `.icon-btn` 本体仍为 `color: var(--text-secondary)`、无 `border:` / `border-radius:`；`.icon-btn:hover` 仍含 `transform: scale(1.1)`          |
| 组件 DOM                               | 全屏树内所有 `button.icon-btn`（≥7 个）必须带 `icon-btn-on-overlay`；`style.background` 必须为空字符串（禁止残留硬编码 `rgba(0, 0, 0, 0.4)`） |
| 交互不回归                             | 7 个 `aria-label` 全集（幻灯片/间隔/收藏/信息/另存为/删除/关闭）仍可查得                                                                      |
| 禁止事项                               | 四个新块一律不得出现 `!important`                                                                                                             |

---

## 7. 基础测试用例

### 7.1 `src/renderer/styles/fullscreen-toolbar-contrast.test.ts`（node 工程）

| #   | 用例                                | 关键断言                                                                                                   | 修复前 |
| --- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------ |
| N1  | 定义 60% 黑胶囊底                   | `toContain('--overlay-control-bg: rgba(0, 0, 0, 0.6);')`                                                   | 🔴     |
| N2  | 前景复用既有变量                    | `toContain('--overlay-control-fg: var(--text-on-overlay);')`                                               | 🔴     |
| N3  | 变体基规则三项齐全                  | `ruleBlockOf('.icon-btn.icon-btn-on-overlay')` 含 color / background / border                              | 🔴     |
| N4  | **源序闸门**（同时防 @layer 误放）  | `indexOf('.icon-btn.icon-btn-on-overlay {') > indexOf('.icon-btn:hover {')`                                | 🔴     |
| N5  | hover 不回落近黑                    | hover 块含 `background: var(--overlay-control-bg-hover);` 且 `not.toContain('color: var(--text-primary)')` | 🔴     |
| N6  | 焦点双色环                          | focus 块含白环 + `box-shadow: var(--overlay-control-ring-shadow);`，且 `not.toContain('var(--accent)')`    | 🔴     |
| N7  | 禁用态压过 opacity 0.5              | disabled 块含 `color: var(--overlay-control-fg-disabled);` + `opacity: 1;`                                 | 🔴     |
| N8  | 粉主题 hover 守卫                   | `toContain('.soft-pink-luxury .icon-btn:hover:not(.icon-btn-on-overlay) {')`；且不含无守卫旧写法           | 🔴     |
| N9  | 令牌不进主题块（安全网）            | `softPinkCss` 不含 `--overlay-control-` / `--favorite-on-overlay`                                          | 🟢     |
| N10 | 全局 `.icon-btn` 未被污染（安全网） | 仍含 `color: var(--text-secondary);`；不含 `border:` / `border-radius:`                                    | 🟢     |
| N11 | hover 缩放未丢失（安全网）          | `.icon-btn:hover` 含 `transform: scale(1.1)`                                                               | 🟢     |
| N12 | 不用 `!important`（安全网）         | 四个新块均不含 `!important`                                                                                | 🟢     |

### 7.2 `src/renderer/components/gallery/FullscreenViewer.toolbarContrast.test.tsx`（jsdom 工程）

沿用 `keyboardNav.test.tsx` 的 `file()` / `openFullscreen()` / `beforeEach` 复位范式；`slideshowConfig.interval` 默认 3000（`uiStore.ts:269`）。

| #   | 用例                        | 关键断言                                                                                                                           | 修复前                                  |
| --- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| R1  | 全部 `.icon-btn` 都带变体类 | `querySelectorAll('button.icon-btn')` ≥7，每个 `classList.contains('icon-btn-on-overlay')`                                         | 🔴（0/9）                               |
| R2  | 无内联硬编码底              | 每个按钮 `style.background === ''`                                                                                                 | 🔴（导航按钮为 `'rgba(0, 0, 0, 0.4)'`） |
| R3  | 标题可辨                    | 标题 span `style.textShadow === 'var(--overlay-title-shadow)'`                                                                     | 🔴                                      |
| R4  | 间隔菜单选中项高对比        | 开菜单后，选中项（`fontWeight` 为 `600`）`style.color === 'var(--accent-light)'`                                                   | 🔴                                      |
| R5  | 信息按钮激活态              | 点击后 `style.background === 'var(--overlay-control-bg-active)'` 且 `style.borderColor === 'var(--overlay-control-border-active)'` | 🔴                                      |
| R6  | 工具栏渐变令牌化            | 工具栏容器 `style.background === 'var(--overlay-gradient-top)'`                                                                    | 🔴                                      |
| R7  | 收藏激活态                  | `is_favorite: true` 时图标 `svg.getAttribute('fill') === 'var(--favorite-on-overlay)'`                                             | 🔴                                      |
| R8  | 结构未变（安全网）          | 7 个 `aria-label` 仍可查得                                                                                                         | 🟢                                      |

**红灯合计 15 条（N1-N8 + R1-R7），安全网 5 条。执行前必须先跑一次确认 15 条全红。**

---

## 8. 分步验证（每个节点红灯 → 改码 → 绿灯）

| 节点   | 内容                                                                        | 验收标准（可判定）                                                                                                                                                                                                                         |
| ------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **S0** | 把本计划写入仓库 `docs/plans/2026-10-26-fix-fullscreen-toolbar-contrast.md` | 文件存在且内容完整                                                                                                                                                                                                                         |
| **S1** | 先写两个测试文件，**暂不改源码**                                            | `npx vitest run src/renderer/styles/fullscreen-toolbar-contrast.test.ts src/renderer/components/gallery/FullscreenViewer.toolbarContrast.test.tsx` → **15 条红灯用例全部失败**，5 条安全网通过；若某条红灯用例修复前即绿，重写该用例后重跑 |
| **S2** | 改 `globals.css`（令牌 A + 变体 B）                                         | 重跑上述命令 → N1-N7 转绿                                                                                                                                                                                                                  |
| **S3** | 改 `soft-pink-luxury.css`（守卫 C）                                         | 重跑 → N8 转绿                                                                                                                                                                                                                             |
| **S4** | 改 `FullscreenViewer.tsx`（9 按钮 + 4 配色）                                | 重跑 → R1-R7 转绿；**20 条用例全绿**                                                                                                                                                                                                       |
| **S5** | 渲染层回归                                                                  | `npm run test:renderer` 全绿（含既有 6 个 FullscreenViewer 测试 + 4 个样式契约测试）                                                                                                                                                       |
| **S6** | 静态检查                                                                    | `npm run typecheck` / `npm run lint` / `npm run format:check` / `npm run i18n:check` 均无新增失败                                                                                                                                          |
| **S7** | 聚合闸                                                                      | `npm run verify` 通过；`npm run preview:check` 退出码 0（新增 `:root` 变量只报 WARN）                                                                                                                                                      |
| **S8** | 全量测试                                                                    | `npm test` 全绿，无新增失败项（与改动前基线对比）                                                                                                                                                                                          |
| **S9** | 人工验证                                                                    | `npm run dev` 后按 §4 的 5 个入口进入全屏预览，按 8 步验收动作逐条确认；柔粉主题下复验                                                                                                                                                     |

---

## 9. 风险评估与影响面

- **对其它页面无影响**，三道保险：① 新规则全部为 `.icon-btn.icon-btn-on-overlay*`，只有显式带该类才生效（26 个使用 `.icon-btn` 的文件中仅 FullscreenViewer 会加）；② `.icon-btn` 本体及 `:hover`/`:focus-visible`/`:disabled` 一字不改（N10/N11 锁死）；③ 粉主题只加 `:not()` 守卫，对不带该类的按钮行为完全不变。
- **工具栏本身不是全局复用组件**：运行时仅 `App.tsx:401` 挂载；其它页面通过 `uiStore.openFullscreen()` 触发，不直接 import。
- **同根因的其它现场（本次不改，仅记债）**：`SlideshowPlayer.tsx` 8 处 `icon-btn text-white`（298/316/328/350/358/380/389/413），其中 316/328 带内联 `rgba(0,0,0,0.4)`；`ZoomableContainer.tsx:98` 1 处。后续修复可直接复用本次的 `.icon-btn-on-overlay` 与令牌，零新增成本。
- **门禁无关**：三个改动文件均不在 `core-path-gate` 受保护路径（`src/main/preload/api`、`src/main/ipc/handlers`、`src/main/services`、`src/shared/errors`）内，无需 `// @core-change:` 注释。
- **i18n**：不新增/修改文案 key，`npm run i18n:check` 应无变化；新增中文注释不受 i18n guard 约束（只拦 JSXText/Literal 中文，且测试文件在 `eslint.config.js:454` 整体豁免）。

---

## 10. 交付说明（完成后需向用户回报）

1. 改动文件：`src/renderer/styles/globals.css`、`src/renderer/styles/themes/soft-pink-luxury.css`、`src/renderer/components/gallery/FullscreenViewer.tsx`，新增 2 个测试文件 + 本计划文件。
2. 关键样式调整点：`.icon-btn.icon-btn-on-overlay` 变体（前景 / 胶囊底 / 描边 / 圆角 + hover / focus-visible / disabled 三态）、14 个新增令牌（`--overlay-control-*` · `--overlay-gradient-top` · `--overlay-title-shadow` · `--favorite-on-overlay`）、粉主题 hover 守卫。
3. 进入全屏预览验证的路径（§4）。
