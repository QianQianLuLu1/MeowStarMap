# 修复：软件运行时窗口无法正常拖动

> 状态：**已完成**（用户已批准，2026-10-29 执行完毕）。原始规划稿见
> `C:\Users\45001\.workbuddy\plans\stellar-aurora-turing-ekXFx5f3.md`，本文件为入仓副本。
> 仓库根：`D:\Workbuddy 项目\WXNN YD - 副本\WXNN XiangCe`（下文路径均为绝对路径）。

## 0. 执行结果记录（2026-10-29）

- **改动落地**：`globals.css`（+19 行，`.no-select` 后新增 `.app-drag`/`.app-no-drag`）；
  新建 `app-drag-region.test.ts`（86 行，9 用例）。受保护路径核对：无。
- **红→绿闭环**：阶段0 全红（9 failed）→ 节点1（5 passed，节点2/边界仍红 4 failed）→
  节点2（2 passed）→ 节点3 边界（2 passed）→ 整文件 9 passed 全绿。
  额外做「漏写无前缀 app-region」临时构造复验：该用例由绿转红，证明非恒绿凑数，随后还原。
- **回归与全局校验**：`npm test` 全量收敛为 `1 failed | 452 passed (453)`；
  `typecheck` / `lint` / `format:check` / `npm run build`（完整 clean+build）/ `verify`（显式纳入新文件，5 项 0 失败）
  全部通过；干净产物 `dist/renderer/assets/index-BRqT79kY.css` 实证含 `-webkit-app-region` 与 `app-region`
  的 drag/no-drag 四条声明（未被 Tailwind purge/esbuild 剥离）。
- **0 新增失败项的硬证明**：全量唯一失败 `src/main/nikkisync/probe.test.ts`
  （断言宿主 Node ≥24，当前环境 Node v22.22.2）。用 `git stash -u` 回到**无任何本次改动的基线态**
  再跑全量，失败项完全相同（同为 probe.test.ts `expected 22 to be >= 24`）→ 证明系既有环境前置失败，
  与本次 CSS 改动无关。另有 `sync-server.linked.test.ts` 曾出现一次 60s 超时（真起 TLS 的时序敏感用例），
  单独重跑 13 passed、第三次全量亦通过，判定为并发抖动 flaky，非回归。
- **未覆盖项（如实声明）**：OS 级窗口拖拽手感无法在无 GUI 交互环境自动化验证，
  逐项目视清单见 §12，需真人在 dev / 打包态窗口前确认；本次未做 GUI 手工拖拽。

---

## 1. 问题定位与根因（证据链，已三方交叉印证）

**结论先行：这不是"拖拽逻辑有 bug"，而是"拖拽功能从未接线"。** 用户列举的坐标系计算、状态更新、事件绑定环节在代码中根本不存在实现——无需调试计算逻辑，只需补齐缺失的声明。

| 环节       | 证据                                                                                                                                                                                                                              | 判定                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 窗口模式   | `src\main\app\window-manager.ts:55-75`：`titleBarStyle: 'hidden'` + `titleBarOverlay:{height:40}`（WCO 窗口控制叠加）。`frame` 走默认 true，**非** `frame:false`                                                                  | 隐藏了系统可抓取标题栏                            |
| 官方规则   | Electron 官方 Custom Title Bar 教程：`titleBarStyle:'hidden'` 后"窗口无法移动"，**必须**在渲染层用 CSS `app-region: drag` / `-webkit-app-region: drag` 显式声明可拖拽区                                                           | 本项目缺失该声明                                  |
| 渲染层意图 | `src\renderer\components\layout\TitleBar.tsx:9` 的类名含 `app-drag`；`TitleBar.stories.tsx:17`、`ARCHITECTURE.md:953`、`src\renderer\vite-env.d.ts:1446`（`WebkitAppRegion?: 'drag'\|'no-drag'` 类型）均把它记成"Electron 拖拽区" | 设计意图齐全                                      |
| **根因**   | 全仓检索 `app-drag\|app-region\|webkit-app-region\|no-drag`：`globals.css`、`themes\soft-pink-luxury.css`、`tailwind.config.ts` **均无对应规则**。仅 4 处"引用/描述"，零"定义"                                                    | `.app-drag` 是悬空类，`app-region: drag` 从未生效 |
| 排除项     | 主进程全文无 `setMovable(false)` / `setIgnoreMouseEvents` / `startDragging`；渲染层无 `mousedown` 拖拽、无 `window-drag` IPC、preload 无窗口控制桥                                                                                | 排除"被程序化禁用""JS 拖拽兜底失效"               |

**一句话**：WCO 隐藏系统标题栏后没有任何可抓取区域，`.app-drag` 类被引用却从未被 CSS 定义，导致窗口无法拖动。

---

## 2. 方案选型与关键技术核查

**采用：在 `globals.css` 定义 `.app-drag` / `.app-no-drag`（CSS-only，零 JSX 改动）。** 保持 WCO 液态玻璃外观不变；不回退系统标题栏、不做 IPC 自定义拖拽（后者触碰受保护路径、需 `@core-change` 授权，属自造轮子，已排除）。

### 2.1 `backdrop-filter` 与 `app-region` 冲突核查（决定"补一行"是否够）

- TitleBar 同时带 `.title-bar`（`backdrop-filter`，globals.css:283）与 `.liquid-glass`（SVG 折射滤镜 `:416-423`，`::before/::after` 为 `pointer-events:none; z-index:-1`）。
- 核查结论：**同一元素上的 `backdrop-filter` 直接破坏 `app-region` 未被权威证实**（app-region 合成基于 layout/style 树，非绘制合成层）；Electron 41.10.6 已越过已知时序 bug（electron#43371 于 36.5.0 修复）。
- 真正会"吃掉"拖拽区的是**全局 `no-drag` 层的几何相减**（Chromium 按 `union(drag) − union(no-drag)` 合成，`pointer-events:none` 不能豁免，见 dsh-web#1907）——本项目全仓无任何 `app-region` 声明，该失败模式**不存在**。
- 伪元素 `::before/::after` 是拖拽元素的**后代**，继承 `drag`（几何相同，只加不减），不构成相减风险。
- ⇒ **首选方案充分**：直接在现有 TitleBar div 上声明 `app-region: drag`。

### 2.2 CSS 放置位置（已核实）

`globals.css` 结构：`@tailwind`(4-6) → `:root` → `@layer components` 块1(277,.title-bar)/块2(338) → `@media (prefers-reduced-transparency: reduce)`(688-713) → 大量**无 layer** 组件类。
放在 **`.no-select`（1578-1581）之后、`.ellipsis` 之前的无 `@layer` 全局区**。理由：

1. 无 layer 样式层叠优先级高于所有 `@layer`（含 utilities），不被意外覆盖；
2. 不被 Tailwind purge 扫描遗漏；
3. `prefers-reduced-transparency` 块（688-713）只关 `backdrop-filter`/`background`，**不含 `app-region`**；柔粉主题 `.soft-pink-luxury .title-bar`（themes:73-78）只覆盖 `background/backdrop-filter/border/box-shadow`，**不含 `app-region`** → 双主题与降级模式均存活；
4. 新增规则只加 `app-region`/`user-select`，**不碰 `position`/`z-index`**，故 `TitleBar` 的 `fixed`/`z-50`（utilities 层）不受影响。

> 注意：`globals.css:1571` 的 `/* 拖拽区域 */ .drag-over` 是**文件拖放高亮**，与窗口拖拽无关；新增规则须用注释明确区分，禁止改名复用。

### 2.3 右上角 WCO 原生按钮避让

TitleBar **不需要** `env(titlebar-area-*)` 避让：WCO 的最小化/最大化/关闭按钮由系统在非客户区自行命中，优先于 web 内容拖拽区（官方教程即把 `app-region: drag` 铺满整条标题栏）。`FullscreenViewer.tsx:490-498`、`SlideshowPlayer.tsx:297-305` 的 `env()` 是**非原生全屏浮层自定义按钮**的避让，与 TitleBar 无关。

### 2.4 双前缀决策

项目为 Electron 41；官方 42.1 教程已用无前缀 `app-region`，而旧生态广泛用 `-webkit-app-region`。**两者都写**：`-webkit-` 保底兼容当前 Chromium，无前缀面向新标准，任一生效即可。测试强制要求两条都在（见 §6）。

---

## 3. 改动范围与文件清单（最小化）

| #   | 文件（绝对路径）                                                                                | 动作                                                              | 是否受保护路径                     |
| --- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------- |
| 1   | `D:\Workbuddy 项目\WXNN YD - 副本\WXNN XiangCe\src\renderer\styles\app-drag-region.test.ts`     | **新建**（红灯测试，先于任何修复）                                | 否（且 `*.test.ts` 豁免）          |
| 2   | `D:\Workbuddy 项目\WXNN YD - 副本\WXNN XiangCe\src\renderer\styles\globals.css`                 | **改**：`.no-select` 后新增 `.app-drag` / `.app-no-drag` 两条规则 | 否                                 |
| 3   | `D:\Workbuddy 项目\WXNN YD - 副本\WXNN XiangCe\docs\plans\2026-10-29-fix-window-drag-region.md` | **新建**：确认后拷贝本计划                                        | 否（不在 `format:check` 覆盖范围） |

**默认不改**：`TitleBar.tsx`、`window-manager.ts`、`preload/**`、`ipc/handlers/**`、`shared/**`。
**受保护路径核对**：`src\main\preload\api\**`、`src\main\ipc\handlers\**`、`src\main\services\**`、`src\shared\errors\**` 全部**不涉及**，故核心路径授权闸门（`// @core-change:`）**不触发**，`eslint` 的 `local/core-path-guard` 亦无新增要求。

---

## 4. 依赖声明（必填项 1）

- **新增 npm 依赖：无**。`app-region` 是 Electron/Chromium 内建 CSS 能力，无第三方包。
- **变更依赖：无**。不修改 `package.json` / `package-lock.json`。
- 测试用依赖均已在 devDependencies：`vitest@^5.0.3`（`npm test` = `vitest run`）；`fs`/`path` 为 Node 内建。
- 构建链既有：`tailwindcss@3.4.19` + `postcss` + `electron-vite@5`。
- **安装方式**：无需安装。执行前仅确认 `node_modules` 已存在（当前仓库已有）。

---

## 5. 启动与环境说明（必填项 2）

**环境**：Windows x64（当前 win32）+ 已安装依赖。编辑器主题 light（不影响 CSS）。

**命令（全部来自 `package.json`，已逐条核实存在）**：

```bash
# 立红灯 / 单节点转绿（文件级）
npx vitest run src/renderer/styles/app-drag-region.test.ts
# 按 describe 名过滤子集（-t，中文名可用）
npx vitest run src/renderer/styles/app-drag-region.test.ts -t "节点1"
npx vitest run src/renderer/styles/app-drag-region.test.ts -t "节点2"
npx vitest run src/renderer/styles/app-drag-region.test.ts -t "边界"

# 全量回归
npm test                 # vitest run，仓库真实全量（node + jsdom 两 project）
npm run typecheck        # tsc -b && tsc -p tsconfig.scripts.json
npm run lint             # eslint .
npm run format:check     # prettier --check --end-of-line auto "src/**/*.{ts,tsx,js,jsx,json,css,md}" ...
npm run build            # clean + electron-vite build + 写 dist/main/package.json
npm run verify           # tsx scripts/verify-changes.ts（含核心路径授权闸门、格式检查）
# 产物实证：确认 app-region 真的进了打包 CSS
grep -r "app-region" dist/renderer/assets/*.css

# 真实窗口（人工拖拽验证用）
npm run dev              # electron-vite dev，自动开 DevTools
```

**验证方式分层（已如实告知用户）**：

- **可自动化**：静态 CSS 契约测试红→绿、构建/类型/lint/格式/安全闸门、产物 `grep` 出 `app-region`。
- **不可自动化**：OS 级窗口拖拽手感——vitest/jsdom 不应用样式表、Playwright 不驱动真实 OS 窗口。由人工清单（§12）验证。

---

## 6. 分步实施（红→绿闭环，严守"修复前必红灯"铁律）

**编排逻辑**：因铁律要求"每个回归测试修复前必须失败"，必须**先一次性写全测试并确认全红**（这是铁律的证明点，记录失败用例数），再按节点逐步落 CSS、逐子集转绿。每节点：改代码 → 跑子集 → 记录通过数。

### 阶段 0 · 立红灯（先于任何修复代码）

- 新建 `app-drag-region.test.ts`（完整代码见 §6.5）。
- 运行 `npx vitest run src/renderer/styles/app-drag-region.test.ts`。
- **验收标准（可判定）：全部用例 FAILED**。当前 `globals.css` 无 `.app-drag`/`.app-no-drag` 块，`ruleBlockOf` 返回 `''`，所有 `.not.toBe('')` 与 `toMatch` 必然失败。记录红灯读数作为铁律证明。
- 若任一用例此时通过 → 视为未覆盖 bug，**按铁律重写该用例**后重跑至全红，方可进入节点 1。

### 节点 1 · `.app-drag` 核心拖拽区（红→绿）

- 在 `globals.css` 的 `.no-select` 后新增 `.app-drag` 规则（含双前缀 + `user-select:none`）。
- 运行 `npx vitest run src/renderer/styles/app-drag-region.test.ts -t "节点1"`。
- **验收标准**：`节点1` 组全部 PASSED；`节点2` / `边界` 组此时**仍为红**（其前置依赖 `.app-no-drag` 尚未加），符合逐步推进。

### 节点 2 · `.app-no-drag` 排除区工具（红→绿）

- 新增 `.app-no-drag` 规则（双前缀 no-drag）。
- 运行 `npx vitest run src/renderer/styles/app-drag-region.test.ts -t "节点2"`。
- **验收标准**：`节点2` 组全部 PASSED。

### 节点 3 · 边界契约完整性（红→绿）

- 无需额外代码（前置两块已存在）。
- 运行 `npx vitest run src/renderer/styles/app-drag-region.test.ts -t "边界"`。
- **验收标准**：`边界` 组全部 PASSED。
- 再跑整文件 `npx vitest run src/renderer/styles/app-drag-region.test.ts`：**验收 = 全绿**。

### 6.4 待新增 CSS（`globals.css`，`.no-select` 之后）

```css
/* 窗口可拖拽区：titleBarStyle:'hidden' + WCO 隐藏原生标题栏后，必须由渲染层
   用 app-region 显式声明可拖拽区，否则窗口无法移动。
   注意：上方 .drag-over（1571）是「文件拖放高亮」，与本区无关。
   置于无 @layer 全局区：层叠优先级高于所有 @layer、不被 Tailwind purge；
   prefers-reduced-transparency 与柔粉主题均不覆盖 app-region，故本区始终存活。
   标题栏内子元素（图标+标题）为非交互文本，继承 drag，无需单独 no-drag；
   .app-no-drag 作为工具保留，供日后在标题栏内新增按钮/输入时排除命中。 */
.app-drag {
  -webkit-app-region: drag;
  app-region: drag;
  -webkit-user-select: none;
  user-select: none;
}

.app-no-drag {
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
```

> **`ruleBlockOf` 定位约束**：规则选择器必须严格写成 `.app-drag {` / `.app-no-drag {`（`{` 前恰好一个空格）——测试用 `indexOf('.app-drag {')` 定位，格式偏差会导致假红。prettier 默认即此格式。

### 6.5 待新增测试（`app-drag-region.test.ts`，node 环境）

沿用仓库既有 `media-card-selection.test.ts` / `selection-prominence.test.ts` 的源码结构断言范式（`readStripped` 剥离注释 + `ruleBlockOf` 截取规则体），helper 逐字复制、**不抽公共模块**（守护测试文件不宜被动）。已核实：`*.test.ts` 位于 `src/renderer/styles/` 命中 vitest **node** project 的 `./src/**/*.test.ts`，且不落在其 exclude，仅运行一次。

```ts
/**
 * @layer L3
 * @module src/renderer/styles/globals.css
 * @coverage 隐藏标题栏（titleBarStyle:'hidden' + WCO）窗口可拖拽区 window-drag-region
 * @dependencies fs、path（纯源码结构断言，node 环境即可）
 * @remarks
 *   缺陷：WCO 隐藏原生标题栏后，渲染层必须用 app-region: drag 显式声明可拖拽区；
 *   TitleBar.tsx:9 已引用 .app-drag 类，但 globals.css / 主题 CSS / tailwind.config
 *   均无对应规则 → 窗口无法拖动。
 *   CSS 为静态资源、jsdom 不应用样式表，故沿用仓库既有源码结构断言范式
 *   （readStripped + ruleBlockOf，helper 逐字复制不抽公共模块）。
 *   铁律：修复前（阶段 0）本文件所有用例必须 FAILED；逐节点落 CSS 后转绿。
 *   局限：OS 级窗口拖拽无法在 vitest/jsdom 中行为级复现，真实手感见人工清单。
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const readStripped = (...segments: string[]): string => {
  const raw = fs.readFileSync(path.resolve(process.cwd(), ...segments), 'utf-8')
  return raw.replace(/\/\*[\s\S]*?\*\//g, '')
}

const globalsCss = readStripped('src', 'renderer', 'styles', 'globals.css')

function ruleBlockOf(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) return ''
  const bodyStart = css.indexOf('{', start)
  const bodyEnd = css.indexOf('}', bodyStart)
  if (bodyStart < 0 || bodyEnd < 0) return ''
  return css.slice(start, bodyEnd + 1)
}

describe('窗口可拖拽区 CSS 契约（window-drag-region）', () => {
  describe('节点1 · .app-drag 拖拽区声明与非法值防护', () => {
    it('正常：globals.css 定义 .app-drag 规则块', () => {
      expect(ruleBlockOf(globalsCss, '.app-drag'), '未找到 .app-drag 规则块').not.toBe('')
    })
    it('正常：声明带前缀 -webkit-app-region: drag', () => {
      expect(ruleBlockOf(globalsCss, '.app-drag')).toMatch(
        /^[ \t]*-webkit-app-region:[ \t]*drag[ \t]*;/m
      )
    })
    it('正常：声明无前缀 app-region: drag（行锚定，缺此声明即红）', () => {
      // 行锚定至关重要：裸 /app-region:/ 会命中 -webkit-app-region 子串 → 假绿灯
      expect(ruleBlockOf(globalsCss, '.app-drag')).toMatch(/^[ \t]*app-region:[ \t]*drag[ \t]*;/m)
    })
    it('正常：拖拽区禁用文本选择（拖动不误选标题文字）', () => {
      expect(ruleBlockOf(globalsCss, '.app-drag')).toMatch(/^[ \t]*user-select:[ \t]*none[ \t]*;/m)
    })
    it('异常/非法值：.app-drag 块内不得把 app-region 写成 no-drag/none/initial', () => {
      const block = ruleBlockOf(globalsCss, '.app-drag')
      expect(block, '前置：.app-drag 块必须存在').not.toBe('')
      expect(block).not.toMatch(/^[ \t]*-?webkit-app-region:[ \t]*(no-drag|none|initial)[ \t]*;/m)
      expect(block).not.toMatch(/^[ \t]*app-region:[ \t]*(no-drag|none|initial)[ \t]*;/m)
    })
  })

  describe('节点2 · .app-no-drag 排除区工具', () => {
    it('正常：定义 .app-no-drag 规则块', () => {
      expect(ruleBlockOf(globalsCss, '.app-no-drag'), '未找到 .app-no-drag 规则块').not.toBe('')
    })
    it('正常：.app-no-drag 同时声明双前缀 no-drag', () => {
      const block = ruleBlockOf(globalsCss, '.app-no-drag')
      expect(block).toMatch(/^[ \t]*-webkit-app-region:[ \t]*no-drag[ \t]*;/m)
      expect(block).toMatch(/^[ \t]*app-region:[ \t]*no-drag[ \t]*;/m)
    })
  })

  describe('边界 · 拖拽区契约完整性', () => {
    it('边界：.app-drag 与 .app-no-drag 为两个独立块，且 drag 块不含 no-drag', () => {
      const drag = ruleBlockOf(globalsCss, '.app-drag')
      const noDrag = ruleBlockOf(globalsCss, '.app-no-drag')
      expect(drag, '前置：.app-drag 块必须存在').not.toBe('')
      expect(noDrag, '前置：.app-no-drag 块必须存在').not.toBe('')
      expect(drag).not.toMatch(/no-drag/)
    })
    it('边界：body/:root/html 上不得声明全局 no-drag（否则整片拖拽区被几何减掉）', () => {
      expect(ruleBlockOf(globalsCss, '.app-drag'), '前置：拖拽区契约须已落地').not.toBe('')
      expect(ruleBlockOf(globalsCss, '.app-no-drag'), '前置：排除区契约须已落地').not.toBe('')
      const offenders = globalsCss.match(/(?:body|:root|html)[^{}]*\{[^}]*no-drag/g) ?? []
      expect(offenders, '存在全局级 no-drag，会减掉拖拽区').toEqual([])
    })
  })
})
```

**每组用例修复前红灯的成因**：`.app-drag`/`.app-no-drag` 块不存在 → `ruleBlockOf` 返回 `''` → 所有 `.not.toBe('')` 与 `toMatch(regex)` 均失败；异常/边界组额外含 `.not.toBe('')` 前置，杜绝 "not.toMatch('') 恒通过" 的假绿灯。**满足铁律：阶段 0 全红。**

**部分实现的防假绿灯验证（可选加跑一次）**：临时把 `.app-drag` 改写成"只保留 `-webkit-app-region`、`app-region` 缺失"→ 重跑应仍红（第 3 条行锚定断言捕获）→ 立即还原正确写法 → 全绿。此步证明测试确实覆盖"漏写无前缀"这一非法实现，非恒绿凑数。

---

## 7. 每个子任务：文件 / 输入 / 输出 / 验收标准

| 子任务       | 需修改文件（完整路径）                                     | 输入                               | 输出                            | 可判定验收标准                                                                 |
| ------------ | ---------------------------------------------------------- | ---------------------------------- | ------------------------------- | ------------------------------------------------------------------------------ |
| 0 立红灯     | 新建 `...\src\renderer\styles\app-drag-region.test.ts`     | 读取 `globals.css` 源码            | 12 条断言                       | `npx vitest run src/renderer/styles/app-drag-region.test.ts` **全部 FAILED**   |
| 1 核心拖拽区 | 改 `...\src\renderer\styles\globals.css`                   | 在 `.no-select` 后插入 `.app-drag` | 源码含双前缀 drag + user-select | `-t "节点1"` **全部 PASSED**；`-t "节点2"/"边界"` 仍红                         |
| 2 排除区工具 | 改 `...\src\renderer\styles\globals.css`                   | 插入 `.app-no-drag`                | 源码含双前缀 no-drag            | `-t "节点2"` **全部 PASSED**                                                   |
| 3 边界       | 无（代码已就位）                                           | ——                                 | ——                              | `-t "边界"` **全部 PASSED**；整文件**全绿**                                    |
| 4 全量回归   | 上述全部                                                   | ——                                 | ——                              | §11 全量命令全绿；`grep -r "app-region" dist/renderer/assets/*.css` **有命中** |
| 5 计划落盘   | 新建 `...\docs\plans\2026-10-29-fix-window-drag-region.md` | 本计划                             | 仓库内 MD                       | 文件存在且内容与本计划一致                                                     |
| 兜底(条件)   | 改 `...\src\renderer\components\layout\TitleBar.tsx`       | 仅当人工清单任一拖拽失败           | 独立无滤镜拖拽层（§8 Option B） | 人工拖拽恢复；静态契约测试仍绿                                                 |

---

## 8. 错误处理与兜底策略（必填项 3）

- **无运行时异常分支**：CSS 声明式修复，`app-region` 由 Electron 合成 `union(drag) − union(no-drag)`，无入参、无抛错路径。
- **兜底层级**：
  1. 首选：现有 TitleBar div 上直接 `.app-drag`（本计划默认）。
  2. **Option B（条件触发，默认不做）**：若人工清单（§12）发现拖拽仍失效（残留 SVG 折射 `backdrop-filter` 干扰假设），把拖拽类移到**无 backdrop-filter / 无伪元素**的专属层：
     ```tsx
     <div className="h-10 flex items-center justify-between px-4 fixed top-0 left-0 right-0 z-50 title-bar liquid-glass liquid-glass--bar">
       <div className="app-drag absolute inset-0" aria-hidden="true" />
       <div
         className="relative flex items-center gap-2 text-sm font-medium"
         style={{ color: 'var(--glass-ink-2)' }}
       >
         <IconImage size={18} />
         {t('titleBar.appTitle')}
       </div>
     </div>
     ```
     外层去掉 `app-drag`；`.app-drag` CSS 规则不变 → 静态契约测试**仍绿**，无需改测试。
  3. **极端兜底（明确排除，不在本次范围）**：`win.startDragging()` 的 IPC 桥会触碰受保护路径 `preload/api`、`ipc/handlers`，需 `// @core-change:` 授权并重新决策，用户已排除。
- **降低透明度 / 双主题**：`backdrop-filter:none !important` 生效但 `app-region` 不动，无错误分支。
- **右键**：拖拽区被 Electron 视为非客户区，会弹**系统窗口菜单**，属预期；禁止在标题栏加自定义右键菜单。
- **日志**：纯 CSS 无需新增日志；窗口生命周期已有 `diagLog`/`logFault` 覆盖。若走 IPC 兜底再按既有约定加 `diagLog`。
- **错误不静默**：测试失败立即停下修复，不 skip、不弱化断言。

---

## 9. 参数与契约校验（必填项 4）

> 本修复为纯 CSS 声明，无运行时函数入参。以下"参数校验"映射为**契约校验**（必填声明 / 非法值 / 边界几何），是本场景下的等价物；硬套"入参类型"不适用，如实说明。

| 校验项                                                           | 类型     | 必填           | 边界 / 非法值处理                                                                              | 落地位置                                               |
| ---------------------------------------------------------------- | -------- | -------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `.app-drag` 双前缀                                               | CSS 属性 | 是             | 缺无前缀 `app-region` → 行锚定断言仍红（防假绿灯）；写成 `no-drag/none/initial` → 非法值断言红 | 测试节点1                                              |
| `.app-drag` 禁选                                                 | CSS 属性 | 是             | 缺 `user-select:none` → 红                                                                     | 测试节点1                                              |
| `.app-no-drag` 双前缀                                            | CSS 属性 | 是             | 缺任一前缀 → 红                                                                                | 测试节点2                                              |
| 全局级 `no-drag`                                                 | 选择器   | 禁止           | `body/:root/html` 出现 `no-drag` → 边界断言红（几何相减）                                      | 测试边界                                               |
| 两规则块独立性                                                   | 结构     | 是             | drag 块含 `no-drag` 或两选择器合并 → 边界断言红                                                | 测试边界                                               |
| `titleBarStyle==='hidden'`                                       | 窗口配置 | 是（人工核对） | 若被改回 default 则 WCO 前提消失、拖拽失效                                                     | 人工清单；**不写自动化测试**（修复前即通过，违反铁律） |
| `titleBarOverlay.height===40` 与 `TitleBar` 的 `h-10`(40px) 对齐 | 数值     | 是（人工核对） | 不一致则原生按钮与拖拽条错位                                                                   | 人工清单；同上不写绿灯测试                             |

---

## 10. 基础测试用例（必填项 5：正常 / 异常 / 边界）

- **正常（修复前红 → 修复后绿）**：`.app-drag` 块存在；`-webkit-app-region: drag`；`app-region: drag`（行锚定）；`user-select: none`；`.app-no-drag` 块存在；`.app-no-drag` 双前缀。
- **异常（残缺/错误实现必须仍红，防假绿灯）**：① 规则存在但漏写无前缀 `app-region` → 行锚定断言红（§6.5 已给临时构造复验法）；② `.app-drag` 内把值写成 `no-drag/none/initial` → 非法值断言红。
- **边界（均以"两块存在"为前置，故修复前亦红）**：① `.app-drag` 与 `.app-no-drag` 独立且 drag 块不含 `no-drag`；② `body/:root/html` 无全局 `no-drag`（防几何相减）。
- **人工边界（自动化无法覆盖，见 §12）**：双主题、降低透明度、最大化还原拖拽、双击标题栏、原生按钮可点、dev/打包态。

**铁律自证**：阶段 0 记录全红读数；三组用例修复前无任何一条通过。若发现某条修复前即通过 → 按铁律重写该用例后重跑至全红。

---

## 11. 回归与全局校验（分步验证，每步通过才进下一步）

**每节点后**：跑对应 `-t` 子集（§6），记录 PASS/FAIL，失败当场修复。

**全部节点完成后，依次运行（任一失败不得结束任务）**：

```bash
npm test                 # 全量单测（node + jsdom 两 project）
npm run typecheck        # 类型检查
npm run lint             # 静态检查（含 local/core-path-guard）
npm run format:check     # 格式检查（新增 test.ts 与改动的 globals.css 在覆盖范围内）
npm run build            # 构建
grep -r "app-region" dist/renderer/assets/*.css   # 产物实证：规则未被 purge/剥离
npm run verify           # 综合校验（含核心路径授权闸门）
```

**预期与注意**：

- `npm run verify` 的核心路径闸门：本次三文件均不在受保护目录 → 应打印"不涉及核心路径受保护文件，跳过"并通过。执行前先 `git status` 确认工作区仅本次改动（探索时工作区 clean、领先 origin 15 提交）；若有无关改动，改用 `npm run verify:staged` 或 `npx tsx scripts/verify-changes.ts <文件路径>` 限定范围。
- `format:check` 覆盖 `src/**/*`，新增 `app-drag-region.test.ts` 与改动的 `globals.css` 须符合 prettier（单引号、无分号、2 空格；`--end-of-line auto` 已规避 CRLF 误报）。**只对本次改动文件跑格式化，禁止 `npm run format` 全量格式化**（避免无关改动）。
- `docs/plans/*.md` 不在 `format:check` 覆盖范围（脚本 pattern 仅 `src/**`、`scripts/**`、`.storybook/**`、根 `*.md`），拷贝计划不会触发格式门禁。

---

## 12. 人工拖拽验证清单（真实窗口，自动化无法替代）

在 **dev（`npm run dev`）** 与 **打包态（`npm run build` 后出包/安装版）** 各跑一遍：

1. 标题栏空白处按住左键移动 → 窗口跟随光标。
2. 最大化后拖动标题栏 → 还原为普通尺寸并跟随。
3. 空白处双击标题栏 → 最大化/还原切换。
4. 切换 default ↔ soft-pink-luxury 主题 → 拖拽仍有效。
5. 系统"降低透明度"开启（玻璃退化实底）→ 拖拽仍有效。
6. 右上角原生 最小化 / 最大化 / 关闭 逐个点击 → 正常，拖拽区未吞点击。
7. dev 与打包态两态都验（dev 自动开 DevTools，确认 Electron 41 下拖拽不受影响）。
8. 从图标/文字处抓取也能拖动，且拖动时文字不被误选（`user-select:none` 生效）。
9. 标题栏右键弹出系统窗口菜单（预期），无自定义菜单冲突。
10. **任一失败 → 判定 Option A 在该环境不成立，启用 §8 Option B 后重跑本清单 + 静态契约测试。**

> 分工声明：以上逐项目视**需真人在窗口前操作**。我（执行阶段）能亲自完成的是：`npm run dev` 启动进程确认不崩溃且日志无错、打包产物 `grep` 出 `app-region`、以及全部自动化红绿。若当前环境无 GUI 交互能力，我不会伪装成"已亲手拖拽验证"，会如实回报并交付清单。

---

## 13. 风险与边界声明

1. **SVG 折射 `backdrop-filter` 干扰（低、未证实）**：Option A 唯一残留风险，兜底 Option B 已备（§8）。
2. **CSS 非标准属性被剥离（低）**：`app-region` 非标准；用无 layer 放置 + 构建后 `grep dist/renderer/assets/*.css` 实证（esbuild 默认保留未知属性、Tailwind 不 purge 无 layer 规则）。
3. **产物 vs 源码**：静态测试读的是源码，产物 grep 是独立实证，两者都过才算稳。
4. **全屏浮层叠加（低）**：`BaseDialog z-[100]` 覆盖标题栏期间标题栏不可达，但它们无 `app-region`、不减拖拽 union，关闭后恢复。**切勿给任何全屏浮层加 `app-region:no-drag`**（dsh-web#1907 教训）。
5. **`verify` 依赖工作区 diff**：见 §11 的 `git status` 前置核对。
6. **格式门禁**：只对本次改动文件格式化，避免无关 diff。
7. **铁律冲突已按用户裁决处理**：用户选择"严格只写红灯" → **不新增**任何修复前即通过的绿灯守卫（放弃 `window-manager.test.ts` 的 WCO 配置断言、`TitleBar` 类名消费断言）；相应价值以人工清单（§12）覆盖。这是为满足铁律的主动取舍，非遗漏。

---

## 14. 还原方案

改动仅两处代码 + 一份计划文档，回滚成本极低：

- 删除 `src\renderer\styles\app-drag-region.test.ts`；
- 撤销 `globals.css` 中 `.app-drag` / `.app-no-drag` 两条规则（`.no-select` 之后的整段）；
- 删除 `docs\plans\2026-10-29-fix-window-drag-region.md`。
- 不涉及数据、迁移、配置或依赖变更，无残留副作用。
