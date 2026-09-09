# 全屏预览过渡动画卡顿/掉帧修复实施计划

- 文档编号：`PLAN-FULLSCREEN-TRANSITION-JANK`
- 适用版本：2.5.1
- 创建日期：2026-09-09
- 状态：执行中
- 作者：AI 结对编程

---

## 0. 背景与问题定义

从图库 / 截图 / 重复文件页点击图片进入全屏预览时，基于 View Transitions API 的共享元素过渡（缩略图 → 全屏图放大、全屏图 → 缩略图缩小）存在肉眼可见的卡顿与掉帧，典型表现为「点击后先顿一下，再糊着放大」。

本文定义**根因证据链**、**逐节点的 TDD 修复步骤**、可直接复制执行的命令与客观验收标准。全部文件、行号、命令均已在仓库中实际核对，不存在假设项。

---

## 1. 依赖声明

### 1.1 新增依赖：**无**

本方案不安装任何新包。全部能力来自已存在于 `package.json` 的运行时与 API：

| 能力                                      | 来源                                              | 已存在证据                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `document.startViewTransition`            | Chromium 原生 View Transitions API                | `src/renderer/stores/uiStore.ts:23-33` 已在用                                                                                             |
| `flushSync`（强制同步提交 DOM）           | `react-dom`（React 19 自带）                      | `package.json` dependencies：`react`、`react-dom`                                                                                         |
| `HTMLImageElement.decode()`（离屏预解码） | Chromium 原生                                     | 标准 DOM API                                                                                                                              |
| 缩略图 URL                                | `MediaFile.thumbnail?: string`                    | `src/renderer/stores/mediaStore.ts:33`；图库网格 `src/renderer/components/common/MediaThumbnail.tsx:90-97` 已加载同一 URL，浏览器缓存命中 |
| `toFileUrl()` / `needsAnonymousCors()`    | 仓库内工具                                        | `src/renderer/stores/mediaStore.ts`、`src/renderer/utils/file.ts`                                                                         |
| 测试设施                                  | vitest 1.6 / jsdom 29 / @testing-library/react 16 | `vitest.config.ts`、`tests/setup.ts`                                                                                                      |

### 1.2 明确不引入的库（含理由）

- **GSAP / framer-motion（motion）手写 FLIP 兜底**：`motion@^12.42.2` 已在依赖中但未用于过渡；手写 FLIP 属重复造轮子，且无法解决「快照时机」这一真正瓶颈。降级路径保持「无动画直接开关」，只保证状态正确。
- **任何 XML/二进制资源、polyfill**：View Transitions 在 Electron 40（Chromium 13x）原生可用，无需 polyfill。

### 1.3 受影响文件清单（最终交付）

| 动作   | 完整相对路径                                                           | 说明                                                                  |
| ------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------- |
| NEW    | `docs/plans/fix-fullscreen-transition-jank.md`                         | 本文件                                                                |
| NEW    | `src/renderer/utils/view-transition.ts`                                | 能力判定 + `view-transition-name` 生命周期管理（纯函数 + 受控副作用） |
| NEW    | `src/renderer/utils/view-transition.test.ts`                           | 上述模块的单元红灯测试                                                |
| NEW    | `src/renderer/stores/uiStore.fullscreen-vt.test.ts`                    | 同步提交契约、参数校验、降级链                                        |
| NEW    | `src/renderer/components/gallery/FullscreenViewer.transition.test.tsx` | 缩略图先行 + 延迟换源 + 兜底                                          |
| MODIFY | `src/renderer/stores/uiStore.ts`                                       | `openFullscreen` / `closeFullscreen`                                  |
| MODIFY | `src/renderer/components/gallery/FullscreenViewer.tsx`                 | 图片分支首图策略、`handleClose` 登记方式                              |
| MODIFY | `src/renderer/pages/GalleryPage.tsx`                                   | 点击分支标记源元素（去重复判定）                                      |
| MODIFY | `src/renderer/styles/globals.css`                                      | `::view-transition-*` 规则                                            |

**不触碰**：`App.tsx` keep-alive 结构、`uiStore` 的 `partialize` 持久化清单、`mediaStore` 数据模型、`GalleryPage` 多选语义分支、VideoPlayer 分支。

---

## 2. 根因证据链（已读码确认）

| 编号    | 根因                                                                                                                               | 代码位置                                                                                                      | 为何导致卡顿/掉帧                                                                                                                                                                                                                   |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RC1** | VT 回调内只做 zustand `set()`，React 走默认 lane 并发调度，DOM 未在新快照拍摄前同步提交                                            | `src/renderer/stores/uiStore.ts:387-399`                                                                      | 浏览器在回调 resolve 后的下一渲染机会捕获新快照，而 `FullscreenViewer` 挂载 + `selectMedia` 触发的网格重渲染被并发调度切分到多帧：轻则新快照迟到/抓到不完整 DOM（共享元素丢失、视觉瞬切），重则动画已开始主线程仍在跑 render → 掉帧 |
| **RC2** | 共享元素 `<img>` 直接指向数 MB 的游戏截图原文件，无占位图、无预解码                                                                | `src/renderer/components/gallery/FullscreenViewer.tsx:339-348`                                                | ①打开瞬间图未加载，新快照抓到无固有尺寸的盒子 → group 起终点尺寸失真；②加载完成触发重排，动画进行中盒子尺寸跳变撕裂动画；③4K 图解码落在 ~250ms 动画窗口内抢占主线程                                                                 |
| **RC3** | 拍新快照前执行 `document.querySelectorAll('[style*="view-transition-name"]')` 全文档扫描 + 逐元素写内联样式                        | `uiStore.ts:393, 421, 441`                                                                                    | 属性子串选择器遍历全文档（keep-alive 已访问视图 + 虚拟网格，节点量级千级），每次写内联样式都使样式失效；紧接着浏览器必须重算样式才能拍快照 —— 纯可消除的同步开销                                                                    |
| **RC4** | 全仓库 0 条 `::view-transition-*` 规则，全程走 UA 默认动画                                                                         | `src/renderer/styles/globals.css`（已全量搜索确认无命中）                                                     | 默认 group 动画同时驱动 transform 与 width/height，old/new 两个镜像每帧按新尺寸重新采样/合成 → 铺满视口的 4K 图逐帧重栅格化                                                                                                         |
| **RC5** | `GalleryPage` 连续两次 store 写入（`selectMedia` + `openFullscreen`）；`startViewTransition` 存在性与 `reduce-motion` 判定散在三处 | `GalleryPage.tsx:296-308`、`uiStore.ts:401, 434`                                                              | 前者把整屏网格重渲染压在过渡窗口上；后者语义重复且易漂移，缺少统一的边界处理                                                                                                                                                        |
| **RC6** | 不支持 VT / 开启动效减弱时为瞬切；VideoPlayer 分支与 Duplicates、Detail、`useFileOperations` 三个入口无源元素                      | `uiStore.ts:409, 453`、`DuplicatesPage.tsx:347-356`、`DetailPage.tsx:401-402`、`useFileOperations.ts:138-144` | 降级本身不产生卡顿，但需确认降级路径零异常、状态必然正确                                                                                                                                                                            |

---

## 3. 修复方案总览

三段式策略：**时机正确化 → 内容轻量化 → 合成最小化**。

1. **时机正确化（治 RC1/RC3/RC5）**：新增 `src/renderer/utils/view-transition.ts` 承载能力判定与 `view-transition-name` 生命周期（O(1) 元素引用登记/清理）；`uiStore` 的 `apply()` 内改用 `flushSync` 强制同步提交，保证浏览器捕获新快照前拿到最终 DOM。
2. **内容轻量化（治 RC2）**：动画窗口内只允许出现缓存命中、尺寸已知的 `currentFile.thumbnail`；原图在 `transition.finished`（或不支持时的下一帧）之后经 `img.decode()` 预解码再原子换源。
3. **合成最小化（治 RC4）**：`globals.css` 增加 `::view-transition-group/old/new(fullscreen-media)` 规则，固定 old/new 尺寸、`object-fit: contain`、关闭其默认的逐帧尺寸采样，缩短 root 整页 cross-fade。

复杂度收益：

- 快照前 DOM 操作：**O(全文档节点数)** → **O(1)**。
- 动画窗口内解码数据量：**O(原图，数 MB)** → **O(缩略图，数十 KB)**。

既定取舍：缩略图先行会产生「先略糊后清晰」的两级观感，与编辑器预览的「预算优先」策略一致；通过 `decode()` 完成后单帧内原子换源把切换抖动压到不可感知。

---

## 4. 环境与验证说明

### 4.1 环境准备（本机已存在，无需安装）

```powershell
cd (Resolve-Path 'd:\Qode*\WXNN*').Path
node -v          # 需 Node 20+
npm -v
```

> 若 `node_modules` 缺失，只能用 `npm install`（增量）。**禁止** `npm ci` 与 `Remove-Item node_modules` —— 本机 npm Safe-Delete 网关（阈值 500）会拦截，见 `MEMORY.md`「环境备注」。

### 4.2 启动命令（实际可用性分级）

| 命令                                 | 状态                  | 说明                                                                            |
| ------------------------------------ | --------------------- | ------------------------------------------------------------------------------- |
| `npm test` / `npx vitest run <file>` | ✅ 可用（主验收手段） | vitest 不受 npm allow-scripts 影响                                              |
| `npm run typecheck`                  | ✅ 可用               | `tsc -b`                                                                        |
| `npm run lint`                       | ✅ 可用               | `eslint .`                                                                      |
| `npx electron-vite build`            | ✅ 可用               | 规避 `npm run build` clean 步被 Safe-Delete 拦截（若 clean 被拦，直接用本命令） |
| `npm run e2e:smoke`                  | ⚠️ 条件可用           | 需 Chromium playwright 浏览器已安装                                             |
| `npm run dev`                        | ❌ 本机不可用         | npm allow-scripts 拦截导致 electron 二进制不可用                                |

### 4.3 卡顿复现 / 验证方式

**A. 自动化验证（本机阻塞性验收）**

以「过渡窗口内不得发生全文档 DOM 扫描、不得并发提交」为可测代理指标，通过 Vitest 断言。这是本机唯一可稳定复现的机制性验收。

**B. 真机 / 浏览器验证（仅在 `npm run dev` 可用时为补充）**

1. 启动应用，进入图库，滚动至含数百张 4K 截图的列表；
2. DevTools Performance 面板开启录制（勾选 Screenshots + Web Vitals）；
3. 点击任意卡片进入全屏，观察共享元素放大期间的帧序列：修复前应出现 >50ms 的 Long Task 与掉帧；修复后动画窗口内不应出现由我们控制的 Long Task；
4. 按 Esc 退出全屏，重复 3 次取平均值。

---

## 5. 错误处理与兜底策略

| 异常分支                                                | 检测                                            | 兜底                                                          | 日志                                                                                                          |
| ------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 环境无 `document`（SSR / node 测试）                    | `typeof document === 'undefined'`               | `canUseViewTransition()` 返回 `false`，走无动画直接开关       | 无（静默，属正常分支）                                                                                        |
| 浏览器不支持 View Transitions                           | `typeof doc.startViewTransition !== 'function'` | 同上，直接 `apply()`                                          | 无                                                                                                            |
| `startViewTransition` 脱绑 `this` 抛 Illegal invocation | 既有回归用例覆盖                                | try/catch → `apply()`                                         | ESLint 禁中文字面量，日志统一英文：`console.warn('[fullscreen] view transition failed, fallback to instant')` |
| `startViewTransition` 同步抛其它错                      | try/catch                                       | → `apply()`                                                   | 同上                                                                                                          |
| `flushSync` 抛错（处于 React 渲染期等）                 | try/catch                                       | 回落为普通 `set()`，状态仍必然置位                            | `console.warn('[fullscreen] flushSync unavailable, fallback to async commit')`                                |
| `transition.finished` 被拒绝                            | `.catch(() => {})`                              | 吞掉，不影响已置位状态；清理逻辑仍在 `finally` 执行           | 无（避免未处理 Promise 拒绝）                                                                                 |
| 清理元素引用时 DOM 操作抛错                             | 逐个 try/catch                                  | 单个失败不影响其余，异常不外泄                                | 无                                                                                                            |
| 用户开启动效减弱（`html.reduce-motion`）                | `classList.contains('reduce-motion')`           | 同降级路径（无动画）                                          | 无                                                                                                            |
| 原图预解码失败 / `decode()` 不支持                      | `catch` + `'decode' in img` 探测                | 降级为「加载完成后直接换源」（`onLoad` 路径），与当前行为一致 | `console.warn('[fullscreen] original image pre-decode failed')`                                               |
| `thumbnail` 缺失（null/undefined）                      | 空值判定                                        | 直接显示原图（维持现状，不恶化）                              | 无                                                                                                            |
| 图片加载失败                                            | 既有 `imgError`                                 | 维持现有错误占位 UI                                           | 无                                                                                                            |
| 组件卸载后异步回调返回                                  | cleanup flag                                    | 不再 setState，避免内存泄漏与 React 警告                      | 无                                                                                                            |

**不变量（任何分支都必须成立）**：调用 `openFullscreen` 后 `fullscreenOpen === true`；调用 `closeFullscreen` 后 `fullscreenOpen === false`；任何异常不得向外抛出。

---

## 6. 参数校验

### 6.1 `openFullscreen(index, files?)`

| 参数    | 类型                       | 必填 | 边界与非法值处理                                                                                                                                                                                                                                                                               |
| ------- | -------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index` | `number`                   | 是   | 非 `number` / `NaN` / `Infinity` / `< 0` → 直接 return，不打开（**既有行为，保留**）                                                                                                                                                                                                           |
| `files` | `MediaFile[] \| undefined` | 否   | `undefined` / `null` → 语义为「沿用图库 `filteredFiles`」；非数组（`Array.isArray` 为 false） → 忽略本参数并按 `null` 处理；空数组 `[]` 或 `index >= files.length` → **拒绝打开**（越界下标会导致 `activeFiles[index]` 为 `undefined`，组件早退返回 `null`，即"点了没反应"，属应拦截的非法态） |

> 说明：越界校验仅在显式传入 `files` 时生效，避免破坏图库路径（图库不传 `files`，由组件侧 `!currentFile` 早退兜底，语义不变，`DuplicatesPage.fullscreen.test.tsx` 的既有断言不受影响）。

### 6.2 `closeFullscreen()`

无入参。内部消费 `fullscreenTargetImg`，无论其是否为 null 都必须把 `fullscreenOpen` 置为 `false`。

### 6.3 `canUseViewTransition(doc?)`

| 参数  | 类型                            | 处理                                                                                                                                                       |
| ----- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doc` | `Document \| null \| undefined` | 缺省取 `globalThis.document`；`null`/`undefined`/非对象 → `false`；无 `startViewTransition` 函数 → `false`；`documentElement` 含 `reduce-motion` → `false` |

### 6.4 `markFullscreenSource(el)`

| 参数 | 类型                           | 处理                                                                                              |
| ---- | ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `el` | `Element \| null \| undefined` | 空值 → 空操作（不抛错）；重复调用 → 旧引用先被清理后顶替，保证同一时刻最多一个 `fullscreen-media` |

### 6.5 `clearFullscreenSource()`

无入参。清理当前登记的所有元素引用并清空登记表；单个元素清理抛错不影响其余。

---

## 7. 测试设计（正常 / 异常 / 边界）

测试文件与源码同目录（`*.test.ts(x)`）。**`src/renderer/utils/` 与 `src/renderer/stores/` 下的测试默认落 node 环境**（`vitest.config.ts:20-23` 的 `environmentMatchGlobs` 只让 `src/renderer/**/*.test.tsx` 与 `src/renderer/hooks/**/*.test.ts` 命中 jsdom），因此其首行必须写 `// @vitest-environment jsdom`（与既有 `src/renderer/stores/uiStore.test.ts:1` 一致）。

### 7.1 `src/renderer/utils/view-transition.test.ts`

| 类别 | 用例                                            | 期望                                                  |
| ---- | ----------------------------------------------- | ----------------------------------------------------- |
| 正常 | 存在 `startViewTransition` 且无 `reduce-motion` | `canUseViewTransition()` → `true`                     |
| 正常 | `markFullscreenSource(img)` 后                  | `img.style.viewTransitionName === 'fullscreen-media'` |
| 正常 | `clearFullscreenSource()` 后                    | 该元素 `style` 中不再含 `view-transition-name`        |
| 异常 | `document.startViewTransition` 缺失             | → `false`                                             |
| 异常 | 注入的 `startViewTransition` 非函数（如 `{}`）  | → `false`                                             |
| 异常 | `documentElement` 含 `reduce-motion` 类         | → `false`                                             |
| 边界 | `doc` 传 `null` / `undefined`                   | → `false`，不抛                                       |
| 边界 | `markFullscreenSource(null)` / `(undefined)`    | 不抛错，登记表为空                                    |
| 边界 | 连续登记两个元素                                | 仅最后一个保留 `view-transition-name`（旧引用已清理） |
| 边界 | 清理时元素已被移除 DOM                          | 不抛错                                                |

### 7.2 `src/renderer/stores/uiStore.fullscreen-vt.test.ts`

| 类别             | 用例                                                                                        | 期望                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **正常（核心）** | mock `startViewTransition` 在回调 resolve 后同步读取 `useUIStore.getState().fullscreenOpen` | 必须为 `true` —— 证明 DOM/状态在回调返回前已同步提交（修复前并发调度下不稳定） |
| **正常（核心）** | mock 在回调返回后立即做 DOM 断言（`[data-fullscreen-img]` 存在）                            | 存在 —— 证明组件已挂载                                                         |
| 正常             | `openFullscreen(2, files)`                                                                  | `fullscreenFiles` === `files`                                                  |
| 异常             | `openFullscreen` 时 `startViewTransition` 抛错                                              | 降级且 `fullscreenOpen === true`                                               |
| 异常             | `flushSync` 抛错（mock `react-dom`）                                                        | 回落普通 `set`，`fullscreenOpen === true`                                      |
| 异常             | 清理阶段 DOM 抛错                                                                           | 状态仍置位，无外泄异常                                                         |
| 边界             | `index` 为 `NaN` / `-1` / `Infinity`                                                        | 不开（既有行为保持）                                                           |
| 边界             | `files` 为 `'not-an-array'`（非数组）                                                       | 当作未提供，按图库语义处理                                                     |
| 边界             | `files` 为 `[]`，`index=0`                                                                  | 拒绝打开，`fullscreenOpen === false`                                           |
| 边界             | `index >= files.length`                                                                     | 拒绝打开                                                                       |
| 边界             | 关闭时 `fullscreenTargetImg` 为 null                                                        | `fullscreenOpen === false`，不抛                                               |
| 边界             | `transition.finished` 拒绝                                                                  | 无未处理拒绝，`fullscreenOpen === false`                                       |

### 7.3 `src/renderer/components/gallery/FullscreenViewer.transition.test.tsx`

（自动命中 jsdom；复用 `DuplicatesPage.fullscreen.test.tsx` 的 `window.electronAPI` Proxy 占位与 mock 风格）

| 类别             | 用例                                               | 期望                                                                        |
| ---------------- | -------------------------------------------------- | --------------------------------------------------------------------------- |
| **正常（核心）** | 文件同时具备 `thumbnail` 与 `file_path` 时打开全屏 | 首帧 `img[data-fullscreen-img]` 的 `src` 为缩略图 URL（原图不在动画窗口内） |
| 正常             | 原图 `decode()` 完成后                             | `src` 切换为原图 URL，且不触发额外的 `imgError`                             |
| 正常             | 关闭全屏                                           | `fullscreenOpen === false`，目标缩略图元素被登记                            |
| 异常             | 原图 `decode()` 拒绝                               | 仍尝试按 `onLoad` 换源 / 至少保持缩略图可见，不进入错误态                   |
| 异常             | 图片加载失败（`onError`）                          | 维持现有错误占位 UI（不回归）                                               |
| 边界             | `thumbnail` 为 `null`                              | 直接以原图为 `src`（与现状一致）                                            |
| 边界             | `thumbnail === file_path`（无独立缩略图）          | 不重复换源，只 render 一次 src                                              |
| 边界             | 快速连续切换下一张再返回                           | 无竞态（旧文件的异步回调被丢弃，不覆盖新文件）                              |

### 7.4 既有回归（必须继续通过）

- `src/renderer/stores/uiStore.test.ts` 4 例（this 绑定契约 + T2 兜底与参数校验）
- `src/renderer/pages/DuplicatesPage.fullscreen.test.tsx`
- `src/renderer/pages/GalleryPage.test.tsx`、`GalleryPage.share.test.tsx`
- `src/renderer/hooks/useFileOperations.test.ts`

---

## 8. TDD 子任务清单（红灯 → 绿灯 → 逐步推进）

> 顺序执行。**每个节点必须先看到红灯（测试失败），再实现，再看到绿灯。** 若某节点测试在修复前就通过，说明未覆盖该 bug，必须重写测试。

### 节点 1：`view-transition.ts` 能力判定与名称生命周期

- **输入**：`docs/plans/fix-fullscreen-transition-jank.md`（本文件）第 6.3–6.5、7.1 节
- **产出文件**：
  - NEW `src/renderer/utils/view-transition.ts`
  - NEW `src/renderer/utils/view-transition.test.ts`
- **实现要点**：`FULLSCREEN_VT_NAME = 'fullscreen-media'`；`canUseViewTransition(doc?)`；`markFullscreenSource(el)` 写入 `style.viewTransitionName` 并登记到模块级引用；`clearFullscreenSource()` 仅清理已登记引用（O(1)，不扫全文档）。全部内部 DOM 操作受 try/catch 保护。
- **红灯验证**：`npx vitest run src/renderer/utils/view-transition.test.ts` 必须失败（模块不存在）
- **绿灯验收**：同一命令全部通过，且 `npx vitest run src/renderer/utils/view-transition.test.ts --reporter=verbose` 显示 10 个用例全通过

### 节点 2：`uiStore` 同步提交 + O(1) 清理 + 参数校验

- **产出文件**：MODIFY `src/renderer/stores/uiStore.ts`、NEW `src/renderer/stores/uiStore.fullscreen-vt.test.ts`
- **实现要点**：
  - 删除 `getViewTransitionStarter()` 内联判定，改用节点 1 的 `canUseViewTransition()`；
  - `apply()` 内用 `flushSync(() => set({...}))`，`flushSync` 抛错时回落 `set()`；
  - 以 `markFullscreenSource` / `clearFullscreenSource` 替换三处 `querySelectorAll('[style*="view-transition-name"]')`；
  - 补 §6.1 的参数校验（`files` 非数组忽略、数组时校验越界）；
  - 保留既有 this 绑定调用方式与降级链，不得修改 `partialize`。
- **红灯验证**：`npx vitest run src/renderer/stores/uiStore.fullscreen-vt.test.ts` 失败
- **绿灯验收**：上述命令全通过 **且** `npx vitest run src/renderer/stores/uiStore.test.ts` 既有 4 例仍全通过

### 节点 3：FullscreenViewer 缩略图先行 + 延迟原子换源

- **产出文件**：MODIFY `src/renderer/components/gallery/FullscreenViewer.tsx`、NEW `src/renderer/components/gallery/FullscreenViewer.transition.test.tsx`
- **实现要点**：
  - 新增「当前展示 src」状态，初值为 `currentFile.thumbnail ?? fileUrl`；
  - 原图通过 `new Image()` + `decode()`（不支持时回落 `onLoad`）预解码，就绪后原子替换；
  - 切换时机避开动画窗口：有 transition 时等 `finished`，无 transition 时用 `requestAnimationFrame`；
  - 用 ref 记录「当前 src 对应的文件」防止快速切图竞态；卸载时 cleanup flag；
  - **hooks 数量与顺序必须保持不变**（`useFavoriteToggle` 仍在 `return null` 之前），新增 state/effect 一律置于 `if (!fullscreenOpen || !currentFile) return null` 之前；
  - `handleClose` 改用节点 1 的登记函数。
- **红灯验证**：`npx vitest run src/renderer/components/gallery/FullscreenViewer.transition.test.tsx` 失败
- **绿灯验收**：通过 **且** `npx vitest run src/renderer/pages/DuplicatesPage.fullscreen.test.tsx` 仍通过

### 节点 4：CSS 合成最小化 + GalleryPage 触发侧统一

- **产出文件**：MODIFY `src/renderer/styles/globals.css`、MODIFY `src/renderer/pages/GalleryPage.tsx`
- **实现要点**：
  - `globals.css` 新增
    ```css
    ::view-transition-old(fullscreen-media),
    ::view-transition-new(fullscreen-media) {
      width: 100%;
      height: 100%;
      object-fit: contain;
      overflow: clip;
      animation: none;
    }
    ::view-transition-group(fullscreen-media) {
      animation-duration: 220ms;
      animation-timing-function: cubic-bezier(0.32, 0.72, 0, 1);
    }
    ::view-transition-old(root),
    ::view-transition-new(root) {
      animation-duration: 140ms;
    }
    ```
    （置于既有 `html.reduce-motion` 块之前或之后均不得影响该块的降级语义）
  - `GalleryPage.tsx`：删除 L296-306 的内联存在性判定与 `querySelector` 写 style，改为调用节点 1 的 `markFullscreenSource(card.querySelector('img[data-media-id]'))`。
- **验收**：`npx vitest run src/renderer/pages/GalleryPage.test.tsx src/renderer/pages/GalleryPage.share.test.tsx` 全通过；`npm run typecheck` exit 0；`npm run lint` exit 0

### 节点 5：全局回归与校验

- 命令（均已在 `package.json` 中存在）：
  ```powershell
  Start-Process cmd.exe "/c npx vitest run > .x.log 2>&1"   # 全量，后台跑后轮询 .x.log
  npm run typecheck
  npm run lint
  npx electron-vite build
  ```
- **验收标准**：全量测试 ≥ 4627 用例且 0 失败（基线：273 文件 / 4627 用例）；`typecheck` exit 0；`lint` exit 0；构建成功。

---

## 9. 风险与回滚

| 风险                                                    | 影响         | 缓解                                                                     |
| ------------------------------------------------------- | ------------ | ------------------------------------------------------------------------ |
| `flushSync` 在 React 渲染期调用会告警                   | 控制台噪音   | try/catch 回落 + 调用点位于事件异步延续而非渲染期                        |
| 缩略图先行造成短暂模糊                                  | 观感         | 既有麦克风气已被普遍采用（macOS/iOS 相册）；换源在 `decode()` 后单帧完成 |
| `::view-transition-*` 规则影响既有 `reduce-motion` 降级 | 动效减弱失效 | 规则置于降级块之前，且 §5 已有 `reduce-motion` → 无动画的独立保证        |
| `files` 越界校验收紧导致某入口打不开                    | 功能回归     | 仅对显式传 `files` 的路径生效；`DuplicatesPage` 用例直接覆盖该路径       |

回滚：改动集中在 4 个源文件 + 1 个 CSS + 3 个新测试文件，`git diff` 可一键回退；新测试文件删除即可。
