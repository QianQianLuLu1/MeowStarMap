# 网格视图滚动闪烁修复（2026-10-18）

- 日期：2026-10-18
- 分支 / 基线 HEAD：`feat/gallery-runtime-embed` @ `acdea69`
- 状态：执行中。§9 为逐节点红/绿读数，§10 为入库前独立审查
- 范围已与用户确认三项决策：① 本轮覆盖 N1–N5 全量（含重渲染风暴节点）；② 批准反转 `ThumbReveal` 「同 src 重挂载仍显示骨架」这条既有测试契约；③ 问题设备可由用户开 DevTools 控制台，真机诊断 D0 由用户执行
- 上一轮同类工作：`docs/archive/plans/2026-09-30-fix-thumbnail-skeleton-reveal.md`（创建 ThumbReveal 骨架门控）与 `docs/archive/plans/2026-09-29-fix-gallery-stack-overflow.md`（移除 overscan）——两者均已归档至 `docs/archive/plans/`（被 `.gitignore` 排除，不入仓，git 历史可查）；commit `b190247`（换源渲染期重置，消除「旧图闪现一帧」）

## 0. 背景（Context）

用户反馈：图库「网格视图」向下滑动显示图片时画面异常闪烁，且**仅在部分设备复现**。
随附问题设备日志包 `wxnn-logs-2026-10-18.zip`：ASUS 笔记本、AMD Ryzen 9 8940HX + Radeon 核显、
16GB / 32 线程、Windows 11 24H2（10.0.26200）、Electron 41.10.6 / Chromium 146、app 2.5.5-beta、
1027 张已索引照片。要求判定闪烁发生在首次加载 / 图片复用 / 视图重绘哪个阶段。

**术语对齐**：需求用词是 Android 的「适配器 / ViewHolder 复用」。本仓库是 Electron + React，
不存在 Adapter/ViewHolder；等价物是 `react-virtuoso` 的 `VirtuosoGrid`——视口外行被卸载、回滚即重挂载，
「ViewHolder 复用」在本项目的对应形态是「同一 `file.id` key 的卡片被重新挂载并重放占位图」。

**结论先行**：闪烁**不在首次加载阶段**，而在**视图重绘阶段叠加复用重挂载**——虚拟列表每次把行挂进
视口时，`ThumbReveal` 都以「未加载」起步，必然绘制一帧 shimmer 骨架、再走 200ms 淡入；滚动越快、
主线程越忙（尤其软件渲染），这一帧越显眼成「逐格闪一下」。

## 1. 根因分析（按可能性排序，附日志证据）

| #   | 候选根因                                                                                                                                                                                                                                                                                                                                                                               | 阶段                  | 支撑证据                                                                                                                                                                                                                                                                                                     | 处置                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| C1  | **复用重挂载重放骨架**：`src/renderer/components/common/ThumbReveal.tsx:38` 的 `useState(false)` 无「该 URL 曾加载完」记忆；`:68` `key={src}` + `:80` 骨架层 + `:72` opacity 过渡 ⇒ 每次挂载必绘一帧骨架再淡入；`:52` 的 `complete && naturalWidth>0` 兜底是 `useEffect`，**绘制之后**才跑，来不及                                                                                     | 图片复用 + 占位图切换 | `VirtualImageGrid.tsx:73,456` 视口外仅扩 100px ⇒ 行几乎在可视区内挂载，重放必然被看见；本仓库 `ThumbReveal.test.tsx:83-100` 把这条行为写死为契约，注释自陈该用例即「模拟 virtuoso 复用 + 缓存命中」                                                                                                          | **N1（主修）**       |
| C2  | **滚动穿过静止光标的 hover 抖动**：`hoveredId` 是整网格级 state（`VirtualImageGrid.tsx:206`），每张卡 `onMouseEnter/Leave` 都 `setHoveredId`（`:510-517`）；Blink 在内容滚过光标时会重算 hover ⇒ 每次换行 = 全网格重渲染 + `:572-616` 遮罩子树整体装卸；叠加 `globals.css:1248` `transition: all`、`:1251-1257` `:hover scale(1.02)`、`:1330-1332` `:hover img scale(1.05)` 的连续脉冲 | 视图重绘              | `VirtualImageGrid.tsx:235-239` `isTouchDevice = matchMedia('(hover: none)') \|\| maxTouchPoints>0`——触屏/触控笔笔记本恒为真，此时每张卡常驻遮罩按钮，hover 一变即在两套不同遮罩（`--overlay-bg-medium` ↔ `--overlay-bg`、`--overlay-bg-strong` ↔ `--overlay-gradient-bottom`）间翻转。**设备差异的直接来源** | **N2 / N3**          |
| C3  | **分页 tick 抹掉失败态**：`src/renderer/hooks/useFailedImages.ts:24-26` 只要 `items` 引用变化就整表清空；向下滑动触发 `endReached → loadNextMediaPage → addMediaFiles`（`src/renderer/stores/mediaStore.ts:202-205,651-669`）产生新数组 ⇒ 已终态的警告卡退回骨架并重试                                                                                                                 | 局部刷新 + 复用       | 与「向下滑动显示图片时」的时机严格吻合（翻页只发生在触底）                                                                                                                                                                                                                                                   | N4                   |
| C4  | **按需生成结果逐个 `setRevision`**：`src/renderer/hooks/useOnDemandThumbnails.ts:34-37` 每个 promise 结果整网格重渲染一次；`:45-49` 去重命中仍新挂 `.then`，每轮滚回重复计票（commit `084d3ef` 正文已自认此遗留）                                                                                                                                                                      | 局部刷新              | **反向证据**：日志全天仅 2 条缩略图相关行（`main.log` 的 `[Cleanup] 重绑定 50/62 条已有缓存引用`），无批量生成活动 ⇒ 该设备绝大多数项已有 thumbnail，`generateVisibleRange`（`VirtualImageGrid.tsx:292-303`）只对 `!file.thumbnail` 发 IPC，触发面很小                                                       | N5（先诊断再决定）   |
| C5  | **软件渲染放大器**：`main.log:653` `[2026-10-18 20:02:38.623] [info] [GPU] 检测到 GPU 崩溃回退标记，本次启动已禁用硬件加速（软件渲染）` ⇒ 设备确实进入过 `src/main/app/gpu-fallback.ts` 的崩溃回退，此时 opacity 淡入与 `.skeleton` 无限 shimmer（`src/renderer/styles/globals.css:1474-1493`）全走 CPU 光栅                                                                           | 硬件加速 / 渲染线程   | **诚实标注**：日志措辞是「本次启动」，当天 16 次重启中仅 1 次打印该行 ⇒ **无法证明闪烁那次会话就是软件渲染**。这是设备差异的最强候选，但不是已证事实                                                                                                                                                         | 由 §5 的 D0 A/B 判定 |

### 日志中与本 bug 无关 / 不可证伪的项（避免误判）

- 9 条 `rendererError`：`[fetchMediaFromDatabase] 异常: NikkiSync runtime is not ready (runtime state is idle)`
  （20:02:56–20:07:06）。属同步域（`gallery.dataSource='nikkisync'` 而 runtime idle），且
  `src/renderer/pages/GalleryPage.tsx:695` 的网格只被 `filteredFiles.length === 0` 卸载、**不被 loading 标志卸载**
  ⇒ 不产生「滚动时闪烁」。`docs/plans/2026-10-18-sync-gallery-toolbar-about-nikkisync.md:207` 已把同类告警判为既有噪声。
- 「日志里没有 `media:updated` 广播风暴」**不能当证据**：该广播（`src/main/app/media-update.ts`）不以
  `media:updated` 字面量写日志，查不到 ≠ 没发生。以 D0 计数器为准。
- 16 次重启 / 16 条 `exitDiagnosis` 原因未定。若其中含 GPU 进程崩溃自愈（`gpu-fallback.ts` 的 `requestSelfHeal`
  → `app.relaunch`），说明该设备渲染链路本身不稳，属另一议题，本轮不处理。
- **日志没有任何一行直接记录渲染层闪烁**（无重渲染计数、无骨架挂载计数）。因此 D0 诊断排在改代码之前。

## 2. 链路定位（file:line）

| 环节                                | 位置                                                                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 视图分派（grid → VirtualImageGrid） | `src/renderer/pages/GalleryPage.tsx:713-728`（masonry 在 `:751`）                                                                                                                     |
| 虚拟化与缓冲                        | `src/renderer/components/gallery/VirtualImageGrid.tsx:73`（`VIEWPORT_INCREASE={top:100,bottom:100}`）、`:449-463`（`computeItemKey = file.id`、`rangeChanged`、`increaseViewportBy`） |
| 网格级 hover 态与遮罩               | `VirtualImageGrid.tsx:206`、`:510-517`、`:572-616`、`:618-622`                                                                                                                        |
| 触屏判定                            | `VirtualImageGrid.tsx:235-239`                                                                                                                                                        |
| 缩略图源与重试 nonce                | `VirtualImageGrid.tsx:83-93`、`:279-286`、`:484-497`                                                                                                                                  |
| 骨架门控（闪烁本体）                | `src/renderer/components/common/ThumbReveal.tsx:38,44-48,52-57,68,72,73-74,80-86`                                                                                                     |
| 失败态清空                          | `src/renderer/hooks/useFailedImages.ts:24-26`（5 个调用方：VirtualImageGrid `:209` / ListView `:37` / TimelineView `:56` / EventTimelineView `:97` / MasonryView `:156`）             |
| 生成结果重渲染                      | `src/renderer/hooks/useOnDemandThumbnails.ts:34-37,45-49`                                                                                                                             |
| 卡片动画与 shimmer                  | `src/renderer/styles/globals.css:1243-1257,1323-1332,1474-1493`；样式守护测试 `src/renderer/styles/layer-budget.test.ts`                                                              |
| 媒体协议缓存头                      | `src/main/app/media-protocol.ts:48-49,141-153`（缩略图 `max-age=300, must-revalidate` + 弱 ETag）                                                                                     |
| GPU 回退与开关 UI                   | `src/main/app/gpu-fallback.ts`；`src/renderer/pages/settings/general-sections.tsx`（硬件加速，需重启）、`src/renderer/pages/settings/appearance-sections.tsx`（减弱动效 / 玻璃效果）  |

## 3. 依赖声明

**零新增依赖。** 全部改动落在既有栈上，并刻意复用仓库内实现：

| 依赖                                               | 版本            | 用途                                                          | 安装方式 |
| -------------------------------------------------- | --------------- | ------------------------------------------------------------- | -------- |
| `react-virtuoso`（已装）                           | 4.18.11         | 既有虚拟化，本轮不改其配置                                    | —        |
| `vitest` + `@testing-library/react`（已装）        | 见 package.json | 新增红灯单测与契约反转用例                                    | —        |
| `src/renderer/hooks/useGlassScrollSignal.ts:58-84` | —               | N2 新 Hook 照抄其 capture-phase passive scroll + rAF 合帧手法 | —        |

「优先用开源成熟方案」的权衡：`react-virtuoso` 自带的 `increaseViewportBy` / `overscan` 是行业标准解法，
但**本项目不得调大**——`VirtualImageGrid.tsx:454-455` 与已归档的
`docs/archive/plans/2026-09-29-fix-gallery-stack-overflow.md`（不入仓，git 历史可查）
记录过调大后「测量 → 重渲染 → 再测量」不收敛导致 `Maximum call stack size exceeded`。
故选「消掉需要绘制的那一帧」而非「扩大预加载」。

## 4. 启动说明

```bash
npm run dev                 # 本地复现与自测（本机非问题设备，只用于红→绿与不回归）
npx vitest run <测试文件>    # 单节点红灯/绿灯
npm run verify              # 只读闸门：tsc -b + eslint(无 --fix) + core-gate + prettier --check + 相关单测
npm test                    # 全量 vitest run
npm run typecheck && npm run lint && npm run format:check && npm run i18n:guard && npm run docs:links
npm run e2e:smoke           # Playwright 冒烟
# 真实数据客观读数（本机专用，需 Node ≥ 23.4）：
PERF_REAL_USERDATA="C:/Users/<你>/AppData/Roaming/wxnn-photo-manager" npx playwright test --config e2e/playwright.config.ts --grep @perf-real
npm run dist:win            # 出安装包给问题设备验证
```

打包态注意：`npm install` 会剥掉 `package-lock.json` 的 libc 字段并清空 `@nikkisync` 链接，
导致 `npm run verify:dist` 响亮失败；恢复只能用 `npm run link:nikkisync`。本轮改动不涉及主进程，应避免重装依赖。

## 5. 真机诊断 D0（改代码之前先跑，脚本不入库）

在问题设备的应用里开 DevTools → Console 粘贴：

```js
window.__FL = { skel: 0, img: 0, hover: 0 }
new MutationObserver((ms) => {
  for (const m of ms)
    for (const n of m.addedNodes) {
      if (!(n instanceof Element)) continue
      if (n.matches?.('.skeleton')) __FL.skel++
      if (n.tagName === 'IMG') __FL.img++
    }
}).observe(document.body, { childList: true, subtree: true })
document.addEventListener('mouseover', () => __FL.hover++, true)
```

向下滚动约 50 行后执行 `copy(JSON.stringify(__FL))` 回传。再读三项环境：
`[matchMedia('(hover: none)').matches, navigator.maxTouchPoints, matchMedia('(prefers-reduced-motion: reduce)').matches]`

A/B 矩阵（每档重启后重跑一次滚动计数，并确认 `logs/main.log` 是否出现 `[GPU] … 禁用硬件加速（软件渲染）`）：

1. 设置 → 常规 → 硬件加速：开 / 关
2. 设置 → 外观 → 减弱动效：开
3. 设置 → 外观 → 玻璃效果：`lite`
4. 临时把卡片解码改为同步：
   `new MutationObserver(() => document.querySelectorAll('.media-card img[decoding="async"]').forEach((i) => (i.decoding = 'sync'))).observe(document.body, { childList: true, subtree: true })`

读数 → 判定：

- `skel` 每次滚动大幅增长、减弱动效不能消除 → **C1 成立，N1 必修**
- `hover` 大幅增长且 `maxTouchPoints > 0` / `hover: none` 为真 → **C2 成立，N2 + N3 必修**
- 仅关硬件加速时闪 → **C5 是放大器**，N1 仍修（它决定 CPU 光栅下那一帧必然可见），交付说明给出设置指引
- 第 4 步即消除 → `decoding="async"` 是主因，N1 的 `useLayoutEffect` 探针 + 复用记忆已足够
- 需整网格重渲染次数才能定 C4 → 本机临时在 `VirtualImageGrid` 函数体加 `window.__FL.render=(window.__FL.render||0)+1`（不入库），`render ≫ skel` 才启动 N5

## 6. 实施节点（每个节点：红灯 → 改动 → 绿灯 → 相关回归）

### N1 — ThumbReveal 记住「已加载完」的 src（C1/C5）★★★

- 文件：`src/renderer/components/common/ThumbReveal.tsx` + 同目录 `ThumbReveal.test.tsx`
- 输入/输出：Props 零变更（`src/alt/onError/className/dataMediaId/dataTestId`）；输出为「同 src 重挂载首帧即 `opacity-100` 且无骨架节点」，新 src 仍骨架起步
- 红灯：`render(src) → fireEvent.load → unmount() → render(同 src)`，断言 `queryByTestId('thumb-reveal-skeleton') === null` 且 img 含 `opacity-100`。今天 `loaded` 是实例局部 state ⇒ 必出骨架 ⇒ 红
- 实现形态（约 18 行）：模块级 `LOADED_SRCS: Set<string>`，上限 512、FIFO 淘汰；`useState(() => LOADED_SRCS.has(src))`；渲染期换源复位由 `setLoaded(false)` 改为 `setLoaded(LOADED_SRCS.has(src))`；仅在可信信号（`onLoad` 且 `complete && naturalWidth > 0`）写入，`onError` 永不写入；缓存自检 `useEffect` → `useLayoutEffect`
- **契约反转**：重写 `ThumbReveal.test.tsx:83-100` 为「同 src 重挂载不闪骨架」；`:36-47`（换新 src 回骨架）与 `:49-66`（T2 旧源迟到 load 不得撤新源骨架）保持原样并必须继续通过
- 边界：记忆 key 用**完整 src 字符串（含 `&r=N`）**，重建换 URL 后自然回骨架，不复用旧证据、不掩盖重建
- 验收：`npx vitest run` 覆盖 `ThumbReveal.test.tsx` + `src/renderer/components/gallery` + `RecycleBinPage.thumb.test.tsx` + `OutfitGalleryPage.cover.test.tsx` + `MediaThumbnail.test.tsx` 全绿
- 风险：内存缓存被驱逐时可能先绘一帧 `--bg-tertiary` 底（父级 `:504,534` 已是该底色）而非 shimmer；影响 6 个复用方，回归必须全覆盖

### N2 — 滚动期间冻结 hover 态（C2）★★

- 文件：新增 `src/renderer/hooks/useIsScrolling.ts`（约 16 行）；改 `VirtualImageGrid.tsx:206,510-517`
- 输入/输出：`useIsScrolling(): { scrolling: RefObject<boolean> }`；`document` 上 capture + passive scroll 置真、rAF 合帧、150ms 空闲回落；组件用 ref 读，**不引入新的渲染**
- 红灯：在 `VirtualImageGrid.grid-cycle.test.tsx`（已有 `vi.mock('react-virtuoso')` 记录探针）中渲染 → `mouseEnter` 卡 A → 派发 `scroll` 并推进 rAF → `mouseLeave`/`mouseEnter`，断言 itemContent 渲染次数与遮罩节点数不再变化
- 实现形态：两个 handler 内前置 `if (scrolling.current) return`（`onHover` 是 `GalleryPage.tsx:440` 的稳定 no-op，一并跳过）
- 验收：grid-cycle + `media-card-selection.test.tsx` + `SelectionWiring.test.tsx` 绿；停滚 ≤150ms 后 hover 恢复
- 风险与红线：**任何情况下不得给 `.media-card` 加回 `will-change`**（`globals.css:1238-1242` 禁令 + `src/renderer/styles/layer-budget.test.ts` 守护）。CSS 侧抑制（`html[data-scrolling] .media-card:hover { transform: none }`）为可选 N2b，若样式守护测试变红立即砍掉

### N3 — `isTouchDevice` 首帧即正确（C2 设备差异）★★

- 文件：`VirtualImageGrid.tsx:221,235-239`；新增 `VirtualImageGrid.touch.test.tsx`
- 红灯：stub `matchMedia` 返回 `matches: true`，断言**第 1 次**渲染即含触屏遮罩。今天首帧 `false`、`useEffect` 后置真 ⇒ 挂载即多一次整网格重渲染 + 遮罩子树翻转 ⇒ 红
- 实现形态：`useState(false) + useEffect` 改为 `useState(() => 同式同步求值)`（约 6 行）
- 注意：`tests/setup.ts` 的 matchMedia 桩默认 `matches: false`，用例需自行 `vi.spyOn`；渲染层无 SSR，同步求值安全
- 验收：`npx vitest run` 新触屏套件 + grid-cycle 套件绿

### N4 — 失败态只裁剪已消失项（C3）★

- 文件：`src/renderer/hooks/useFailedImages.ts` + `useFailedImages.test.ts`
- 输入/输出：签名收窄为 `useFailedImages<T extends { id: string }>(items: T[])`（5 个调用方传的都是 `MediaFile[]`，**调用点零改动**）；行为改为「仅剔除已不在 items 中的 id」
- 红灯：`markFailed('a')` → 以「仍含 a 的新数组」rerender → 断言 `failedImages.has('a')`。今天被整表清空 ⇒ 红
- **契约反转**：`useFailedImages.test.ts` 的 `describe('dep 变化清空')` 4 条用例改写为「追加新页保留、移除项才裁剪」；「dep 是 number 类型」用例随泛型收窄删除
- 验收：`npx vitest run src/renderer/hooks/useFailedImages.test.ts src/renderer/components/gallery` 绿
- 风险：坏图卡稳定停在警告态直到重建/刷新（正是消除闪烁的目的）

### N5 — 生成结果合帧通知（C4）★

- 文件：`src/renderer/hooks/useOnDemandThumbnails.ts:34-37`
- 红灯：一帧内 resolve 多个结果时，itemContent 渲染次数增量 ≤ 1
- 实现形态：`setRevision` 用 rAF 合帧 + 卸载取消（约 10 行）
- 注意：React 19 在同一 task 内已自动批处理，本节点收益可能已被运行时吸收；仍按用户确认的全量范围实施，并在 §9 记录实测增量
- 验收：grid-cycle + `VirtualImageGrid.thumb.test.tsx` 绿

### 明确不做（避免顺手改）

- 不动 `increaseViewportBy` / overscan（会重触发已归档的栈溢出测量回路）
- 不把 `.media-card { transition: all }` 拆成显式属性列表（触及 4 个视图观感，被 3 个样式守护测试切片，收益未证实）
- 不动 `src/main/app/media-protocol.ts` 缓存头；不动 `useOnDemandThumbnails` 两个模块级 Map 的无上限问题（`docs/技术债清单.md` 已登记豁免）
- 不动 `GalleryPage`、stores、IPC 契约 ⇒ `docs/IPC_CONTRACT.md` 与 i18n 键预期零变更
- 受保护核心路径（见 `scripts/core-path-gate.ts` 的 PROTECTED_GLOBS：preload/api、ipc/handlers、services、shared/errors，仅 `.ts`）**均未被触及**，已核实无需 `// @core-change:` 注释，也不得添加（守护测试禁止占位文案）

## 7. 错误处理

- 已加载记忆是**只增不删的旁证**：写入仅在 `onLoad` + `complete && naturalWidth > 0`；`onError` 分支绝不写入，失败项行为与今日一致，父级回退链不变
- 淘汰：`Set` 达 512 条 FIFO 淘汰最早一项，最坏后果是「被淘汰的图重新闪一帧骨架」——退化为今日行为，不会白屏
- 缩略图就地覆盖（同路径新字节）时 `VirtualImageGrid.tsx:279-286` 必然 bump `&r=N` ⇒ key 变化 ⇒ 重走骨架，不存在露旧像素
- `useIsScrolling`：`scroll` 监听 `{ capture: true, passive: true }`，卸载必须 `removeEventListener` + `cancelAnimationFrame`；rAF 不可用时同步置位，不抛错
- `useFailedImages`：`items` 非数组按空数组处理（同 `VirtualImageGrid.tsx:202` 守卫），只读遍历不抛异常

## 8. 参数校验

- `ThumbReveal` Props 无新增；`src` 仍必填 `string`，空串继续早返回不渲染（`:59`）
- 写入记忆前置断言 `src.length > 0`（空串不得进 `Set`，否则回收站/封面空态被污染）
- `useFailedImages<T extends { id: string }>` 编译期强制元素带 `id`；运行期 `Array.isArray(items) ? items : []`
- `useIsScrolling` 无入参；150ms 阈值提为模块常量并注释「覆盖一次惯性滚动典型时长，与 `useGlassScrollSignal` 同一手法」
- 不新增 IPC 入参、zod schema、设置键

## 9. 基础测试用例（三类齐备）

| 节点 | 正常                                       | 异常                                                     | 边界                                                                                                                                          |
| ---- | ------------------------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| N1   | 同 src 重挂载首帧即 `opacity-100`、无骨架  | `onError` 后重挂载同 src 仍回骨架（坏图不入记忆）        | ① 连续 513 个不同 src ⇒ 首个被淘汰 ⇒ 重挂载再现骨架；② 换新 src 必回骨架；③ 旧源迟到 load 不撤新源骨架；④ `a.jpg` 与 `a.jpg&r=1` 视为两个 key |
| N2   | 滚动中 hover 切换不重渲染网格；停滚后恢复  | 卸载移除监听/取消 rAF，无残留定时器                      | 单次 `scroll` + 立即 `mouseEnter` 的时序；rAF 缺失环境退化同步                                                                                |
| N3   | `hover: none` 命中 ⇒ 首帧即触屏遮罩        | matchMedia 不存在 ⇒ 回退 `ontouchstart`/`maxTouchPoints` | 三者全假 ⇒ 首帧即桌面分支，不得二次渲染                                                                                                       |
| N4   | 追加下一页 ⇒ 保留既有失败 id               | `items` 非数组 ⇒ 不抛错、保留现集                        | 项被删除 ⇒ 对应 id 被裁剪，集合不无界增长（C-O7 原意成立）                                                                                    |
| N5   | 同帧 3 个结果 ⇒ 至多 1 次重渲染            | 结果到达时组件已卸载 ⇒ 不 setState、不抛错               | 合帧期间再次触发 ⇒ 不重复排帧                                                                                                                 |
| 全量 | `npm test` + `npm run verify` + 各静态闸门 | —                                                        | —                                                                                                                                             |

## 10. 验证与自测顺序

1. N0 计划入库 → `npm run docs:links` 绿
2. D0 在问题设备取基线读数（未改代码）
3. 逐节点：写红灯 → `npx vitest run <文件>` **必须看到失败输出** → 实现 → 重跑转绿 → 跑该节点验收命令 → `npm run verify`
4. 全节点完成后：`npm test` → `npm run typecheck` → `npm run lint` → `npm run format:check` → `npm run i18n:guard` → `npm run docs:links` → `npm run e2e:smoke`
5. 客观读数：`@perf-real` 真数据副本冷/热对照（`e2e/perf-real.e2e.ts`），需要量化骨架插入次数时在该既有套件内追加一次滚动计数
6. 提交：`fix(gallery): 网格滚动闪烁——复用卡不再重放骨架 + 滚动期冻结 hover 重渲染`，随后 `git status --porcelain` 复核 pre-commit 改写

### 问题设备上确认闪烁消失

- `npm run dist:win` 出包 → 装到该 ASUS 机器 → 同一段 50 行下滚重跑 D0：`skel` 增量应从数十~数百降到接近 0（仅首次生成的项还会闪一次），`hover` 增量显著下降
- 主观确认：鼠标**停在网格中央不移动**再向下滚动——改前闪烁集中在光标所在行，改后应完全静止；对照硬件加速开/关两态都不该逐格闪现
- 若关硬件加速仍闪而开不闪：属 `src/main/app/gpu-fallback.ts` 的设备侧渲染稳定性问题，另案处理

## 11. 交付说明要点

- 闪烁阶段判定：**不是首次加载，而是复用重挂载 + 占位图切换 + 滚动期局部重绘**
- 设备差异来源：`maxTouchPoints > 0` 的触屏分支、软件渲染回退、高刷面板让 1 帧闪现更易被看见
- 改前临时缓解：设置 → 外观 → 减弱动效 打开、玻璃效果改 `lite`；若能接受重启，恢复硬件加速为开启并确认 `main.log` 不再出现 `[GPU] … 禁用硬件加速（软件渲染）`

## 12. 执行记录与红/绿读数

### 12.1 已落地节点

| 节点                      | 红灯（修复前必须失败）                                                              | 修复前读数                                                                                                               | 修复后                                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| N1 ThumbReveal 已加载记忆 | `同 src 卸载后重新挂载不重放骨架`、`同实例换回已加载 src 不重放骨架`                | `ThumbReveal.test.tsx` **2 failed / 9 passed**（骨架节点仍被渲染：`expected <div …skeleton…> to be null`）               | **11 passed**；消费方回归 `components/gallery` + `components/common` + 回收站 + 穿搭集封面 **62 文件 / 751 tests passed** |
| N2 滚动期冻结 hover       | `滚动期间鼠标扫过卡片不得触发整网格重渲染`、`scroll 与 mouseEnter 同批次时序仍冻结` | grid-cycle **2 failed / 12 passed**（`expected 2 to be 3`、`expected 4 to be 3`，即每次 enter/leave 各多一次整网格渲染） | grid-cycle **15 passed**（含新增 N5 合帧用例）                                                                            |
| N4 失败态只裁剪消失项     | `① 触底翻页保留失败记录`、`② 仅裁剪消失项`、`⑤ 非数组不抹掉现集`                    | `useFailedImages.test.ts` **3 failed / 8 passed**（整表清空把 size 打成 0）                                              | **11 passed**；5 个消费方所在 `components/gallery` + `MediaThumbnail` + 回收站 **20 文件 / 228 tests passed**             |

配套新增：`src/renderer/hooks/useIsScrolling.ts`（N2 的信号源，capture+passive scroll + 150ms 拖尾沿空闲，只写 ref 不触发渲染）。

### 12.2 被实测否决的两个候选（未改动代码）

诚实记录：**N3 与 N5 的机制假设在测量后不成立，故不实施。** 计划里我把它们列为候选，是靠读代码推出来的，实测推翻了我自己。

- **N3（`isTouchDevice` 首帧同步求值可省一次整网格重渲染）——否决。**
  用记录型 VirtuosoGrid 探针测挂载渲染次数：桌面分支 2 次、触屏分支 2 次（`{"desktop":{"renders":2,…},"touch":{"renders":2,…}`），
  差异为 0。原因是 React 的挂载期 passive effect 更新会被合批：列数 effect 的 `setColumns` 与 `setIsTouchDevice`
  落在同一次 flush ⇒ 触屏分支并不额外多一轮渲染。既然没有可观测收益，就不做无证据的改动。
  顺带证伪了我中途的一个误判：`window.matchMedia?.('(hover: none)').matches` **不会**在无 matchMedia 的环境抛错——
  可选链会短路整条表达式；早先出现的 `TypeError: … reading 'matches'` 是我自己把 `mockImplementation(undefined)` 当成「API 缺失」造成的测试缺陷。
- **N5（`useOnDemandThumbnails` 逐条 `setRevision` 造成整网格重渲染风暴）——否决，但保留用例。**
  同一帧内 settle 5 个生成结果 ⇒ 整网格渲染增量 ≤ 1（用例 `① 边界：同一帧内 settle 的多个生成结果，整网格重渲染至多 +1` **修复前即通过**）。
  `084d3ef` 正文记为「已知遗留」的那条，在 React 19 自动批处理下已不构成实害。用例保留为不变量守护（将来若有人改成同步强渲染会被它拦住）。

### 12.3 附带发现（写 N4 用例时撞出来的真实隐患）

`useFailedImages` 旧实现是「dep 引用一变即 `setState(新 Set)`」。调用方若每次渲染都新建数组，会形成
`渲染 → effect → setState(新引用) → 再渲染` 的**无限环路**——实测把 vitest worker 打到 OOM（退出码 134）。
现实现无裁剪发生时返回原引用，环路从机制上消失（用例文件头已把这条写成注释，避免后来者再踩）。

### 12.4 全量回归与闸门

| 命令                                                          | 结果                                                     |
| ------------------------------------------------------------- | -------------------------------------------------------- |
| `npm run verify`                                              | 5 项全 ✓（typecheck / lint / core-gate / format / test） |
| `npm test`                                                    | 见下方提交前复跑记录                                     |
| `npm run typecheck` / `npm run lint` / `npm run format:check` | 见下方                                                   |
| `npm run i18n:guard` / `npm run docs:links`                   | 零新增 i18n key；死引用见 §12.5                          |
| `npm run e2e:smoke`                                           | 见下方                                                   |

### 12.5 计划文档自身的死引用修复

`scripts/__tests__/check-md-links.test.ts`（被跟踪 Markdown 死引用必须为 0）第一次全量跑时因本文件报错 2 处：
早先我用 `ls` 核对路径时把 `docs/plans/` 与 `docs/archive/plans/` 两个目录的输出连在一起看，
误以为 `2026-09-29-fix-gallery-stack-overflow.md`、`2026-09-30-fix-thumbnail-skeleton-reveal.md` 仍在 `docs/plans/`。
实际三份历史计划都只在 `docs/archive/plans/`（被 `.gitignore` 排除）。
已按 `docs/技术债清单.md:169` 的既有写法改为 `docs/archive/plans/…`（不入仓，git 历史可查）。
教训：核对存在性要用单目录单命令，不要把两条 `ls` 的输出并在一起读。
