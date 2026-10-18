# 图片编辑器实时预览性能修复（2026-10-18）

- 日期：2026-10-18
- 分支 / 基线 HEAD：`feat/gallery-runtime-embed` @ `672d4af`
- 状态：已执行。§9 为逐节点红/绿与实测读数，§10 为入库前独立审查的三项红灯修复
- 范围已与用户确认三项决策：① 本轮含 Web Worker 卸载；② 拖动代理档 = 1024 长边；③ 验证到「单元级 + 手工 DevTools trace」，e2e P11 不强制

## 0. 背景（Context）

用户反馈：图片编辑器修改各项数值或拖动滑块时，画面无法实时刷新，出现明显延迟与卡顿。
要求定位链路、分析根因（含高频重绘、主线程同步处理、节流/防抖与增量渲染、重复计算与重渲染、
GPU/离屏画布缓存利用），按影响程度给出优化方案与优先级，并给出可验证帧率与单次重绘耗时的方法。

### 根因（四条叠加，均有行号证据）

1. **调度器在拖动期间一帧都不产出。** `src/renderer/hooks/useImageProcessor.ts:113-117` 是纯尾沿
   `setTimeout(PREVIEW_DEBOUNCE_MS=80)`；而每次参数变更都会重建 `renderPreview` 身份
   （useCallback deps `:158`）→ effect `:218-221` 重新执行 → `clearTimeout` 再重新挂表。
   **连续拖动时定时器被无限重置，预览只在指针停止 80ms 后才跑一次全量管线。**
   这是「画面无法实时刷新」的直接原因。
   ⚠️ Worker 不解决这一条：搬进 worker 后若无帧合并调度，拖动期仍是 0 帧。故 N1/N2 无论走哪条路都必须先做。
2. **那唯一一次渲染贵到冻结主线程。** `src/renderer/utils/imageProcessor.ts:528-731`
   `processImageData` 在渲染进程主线程同步跑完整像素循环，且每帧重复与参数无关的重活：
   全分辨率高质量重采样 `:573-589`（无缓存）、`getImageData` 回读 `:591`、三次整幅 canvas 分配
   （`:533`/`:960`/`:1022`），再同步 `toDataURL`（`:1029`）产出多 MB base64 塞进 React state，
   `<img src>`（`src/renderer/pages/EditorPage.tsx:953`）解码一次、
   `src/renderer/components/editor/Histogram.tsx:104-120` 再 `new Image()` 解码第二次。
3. **拖动能见的分辨率失控。** `useImageProcessor.ts:26` `DEFAULT_MAX_PREVIEW_SIZE = Infinity`，
   `EditorPage.tsx:93-104` 按「显示区 × DPR(≤4) × 缩放(≤8)」推导
   （`src/renderer/utils/preview-resolution.ts:53-79`，上限 65535）
   → 8× 缩放时按原图分辨率逐像素循环，单帧量级为秒。
4. **GPU / 离屏缓存完全未利用。** 全库无 WebGL、无 `OffscreenCanvas`、无 `ctx.filter`、无预览缓存；
   渲染层 `new Worker(` 命中数为 0（现存 worker 皆主进程 `utilityProcess`，按文件路径驱动）。

预期：拖动期由 **0 帧/秒 → 20~30 帧/秒（Phase A）→ 接近 60 帧/秒（Phase B）**；settle 帧画质不变。
**以上为估算，必须以 §7 实测为准。**

## 1. 链路定位

| 环节 | 文件:行                                                                                                                                 | 关键事实                                                                                                                                                                                                                                                                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 滑块 | `src/renderer/components/common/SliderControl.tsx:57-72`                                                                                | 受控 `<input type="range">`，`onChange` 每像素触发；`onCommit` 绑 `onPointerUp`/`onKeyUp`（`:63-66`）。无数值输入框（`type="number"` 全库 0 命中）                                                                                                                                                                                                                           |
| 面板 | `EditorTabs.tsx:95-129`（14 基础 + 5 分离色调，已 `useCallback`）、`:313-332`（36 个 HSL 滑块，内联箭头）、`WatermarkPanel.tsx:436-646` | 零 `React.memo`                                                                                                                                                                                                                                                                                                                                                              |
| 状态 | `useImageProcessor.ts:82-90`                                                                                                            | **编辑器无 Zustand store**（`stores/` 下仅 media/ui/theme/plugin/resonance/syncGallery/operationHistory），全为 hook 内 `useState`；写入口 `:233-258`                                                                                                                                                                                                                        |
| 调度 | `useImageProcessor.ts:109-158`、`:164-167`、`:218-231`                                                                                  | `pendingRef` token 仅在昂贵工作**完成后**丢弃（`:118/126`）；降级重试 `:132-149`                                                                                                                                                                                                                                                                                             |
| 像素 | `imageProcessor.ts:528-731`                                                                                                             | 主循环 `:607-672`；`applyHSL:294`（`:300` 无条件 `rgbToHsl`，`:308` 有零值早退）、`applyTemperature:329`（**无早退**且每像素返回元组）、`applyVibrance:350`/`applyDehaze:456`/`applySplitTone:473` 有早退但仍分配元组、卷积 `:686-708`、`applyVignette:742`（每像素 `sqrt`/`**`）、`applyWatermark:955-990`（第二次 `getImageData`）、`drawImageWatermark:905` 每帧重取 logo |
| 显示 | `EditorPage.tsx:953`、`:818`（Histogram）、`:843`（CompareView）                                                                        | `previewUrl` 消费者**仅此四处**（grep 确认），无 Storybook/e2e 引用 EditorPage                                                                                                                                                                                                                                                                                               |
| IPC  | 预览路径 **0 次**跨进程调用                                                                                                             | 仅保存/导出跨 `editor:save` → `src/main/services/editor-service.ts:141`                                                                                                                                                                                                                                                                                                      |

**`processImageData` 全部调用方**（决定能否安全改造）：`useImageProcessor.ts:121/135`（预览）、
`:277`（导出）、`EditorPage.tsx:638`（批量应用）、`FilterPanel.tsx:158`（滤镜缩略图 120px）。
→ **主线程实现保留**给后三类，Worker 仅接管预览。

**重复计算补充**：`src/renderer/utils/filter.ts:15` 在**已选滤镜预设时**每事件
`JSON.parse(JSON.stringify(params))` 深拷贝（`:13` 无预设则原样返回）；`EditorPage` 956 行整体
随每事件重渲染（ms 级，非主瓶颈）。

## 2. Phase A：调度与增量（先做，收益最大且不可被 Worker 替代）

### 依赖声明

**不新增任何依赖。** 仓库无 lodash / es-toolkit / throttle-debounce，亦无共享 throttle 工具
（最接近的是 `src/renderer/hooks/useGallerySearch.ts:4` 内联 setTimeout）；rAF 合并约 15 行。
Phase B 亦**不引入 comlink**：消息类型仅 6 个，手写 postMessage 更省，且新增依赖要过
CI `npm run audit` 与 `package.json` 打包 `files` 白名单两道关。

- **N1 rAF 合并 + 在飞守卫**（`useImageProcessor.ts:109-158, 218-231`）：变更 → 写 `latestRef` →
  `ensureRaf()`；帧回调内若 `inFlight` 则置 `dirty` 返回，完成后若 `dirty` 或档位已变则再排一帧。
  每帧最多一次、恒用最新参数、不丢尾帧。
  验收（红灯）：20 次连续变更（每 20ms 驱动一帧）后 `processImageData` 调用次数 ≥ 8；**当前恒为 1**。
- **N2 两档预算**（`preview-resolution.ts` 新增 + hook）：`DRAG_PROXY_MAX_SIZE = 1024`、
  `computeDragProxyMaxSize(real) = min(real, 1024)`（**只降不升**）；判档靠事件时间戳
  `Date.now() - lastChangeAt < PREVIEW_BURST_WINDOW_MS(200)` ⇒ proxy，尾沿 `PREVIEW_SETTLE_MS(140)`
  补一帧 final。**不改 `SliderControl` / `EditorTabs` / `EditorPage:93-104`**。
  离散操作（点击、方向键、双击复位）首帧即 final，画质不受损。
  验收（红灯）：proxy 帧 `maxSize===1024` 且末帧 `===Infinity`；`computeDragProxyMaxSize(65535)===1024`、
  `(512)===512`、非有限值原样返回。
- **N3 base 缓存 + 缓冲复用**（`imageProcessor.ts:533-591` + hook）：新增 `buildPreviewBase(source, maxSize)`，
  `ProcessOptions` 增可选 `base`/`scratch`。缓存**归 hook**（LRU-2 恰好容纳 proxy+final，
  `MAX_PIXELS=4_000_000` 以上不缓存）。
  ⚠️ **正确性陷阱**：`:607` 循环**原地写 `data`**，缓存 base 会被污染 → 每帧必须拷入 scratch；
  命中前须校验 `source === imageRef.current`（**对象身份**，非 URL 字符串，防同图重载命中陈旧位图）
  - 尺寸一致，不符即重建。Phase B 落地后本项降级为 **worker 不可用时的兜底路径**
    （对齐 `src/main/thumbnail/worker-bridge.ts:50` 的 inline-sharp fallback 先例），不是白做。
    验收（红灯）：同 source 连续 3 帧，`createImageBitmap` 计数 3→1，且第 2 帧输出与第 1 帧一致。
- **N4 logo 缓存**：`Map<path, HTMLImageElement>` 上限 4 + `clearWatermarkLogoCache()` 随 source 切换。
  **失败结果不得入缓存**，否则 `2026-10-17-fix-image-watermark-media-auth.md` §5 N2 修好的
  「水印失败可见」退化为永久静默。仅预览路径 `cacheLogo: true`。
  验收（红灯）：2 帧构造器调用 1 次；桩失败后 2 帧仍调用 2 次。
- **N5 热循环去冗余**：新增纯函数 `planPasses(params)`（把「该 pass 是否激活 / 哪些 HSL 键非零」
  提到循环外），`applyHSL` 只遍历非零键，`applyTemperature/Vibrance/Dehaze/SplitTone` 改就地标量
  消除每像素元组分配，`applyVignette` 改增量距离表。**逐像素输出必须等价**，由 N0 表征测试守护。
  因 worker 复用同一批纯函数，本项收益自动延续到 Phase B。
  验收（红灯）：`planPasses` 三类用例直测（全默认 → 无激活 pass / 单键非零 → 仅该键 / NaN → 视为未激活）。
  分配消除不做时钟断言（CI 抖动），改由 §7 实测体现。
- **N7 重渲染隔离（条件触发）**：`React.memo(SliderControl)` 对「基础」页签 14 个滑块**确实有效**
  （`EditorTabs.tsx:95-129` 已 `useCallback`），但对 36 个 HSL（`:318/324/330` 内联箭头）恒判不等，
  需另做行级 memo + 稳定回调。`src/renderer/AGENTS.md` §1 明文「实测卡顿前不强制 `React.memo`」
  → **仅当手工 trace 显示单次 commit > 8ms 才做**。

## 3. Phase B：Web Worker + OffscreenCanvas 卸载

### 前置事实（逐一核实，直接决定设计）

| 事实                                                                                                                              | 出处                                                                              | 影响                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 渲染层为 ESM，`base: './'`                                                                                                        | `electron.vite.config.ts:156`、`src/renderer/index.html:22`                       | `new URL('./x.worker.ts', import.meta.url)` 可解析出 `app://renderer/assets/*.js`，与文档同源                                                                         |
| 渲染层**无** `worker` 配置块                                                                                                      | `electron.vite.config.ts:155-200`                                                 | Vite 默认 `worker.format: 'iife'`；管线内不得有 top-level await / 动态 import                                                                                         |
| CSP 无 `worker-src`，`default-src 'self'`                                                                                         | `src/main/app/window-manager.ts:14-16` 与 `index.html:11`（注释要求**逐字一致**） | 同源 worker 脚本理论上被放行，但 **CSP 仅在非 dev 生效**（`window-manager.ts:50` `if (!isDev)` + `stripCspMetaInDev`）→ **dev 验证不到，必须打包验证**                |
| `img-src` 不含 `blob:`                                                                                                            | 同上两处                                                                          | **不能**把预览换成 blob URL，除非同时改两处 CSP（安全关键面）。`src/main/app/__tests__/window-manager.test.ts:239` 只断言 `script-src`，不会替你发现遗漏              |
| `fetch('media://…')` 受 `connect-src` 管，而 `media:` 只在 `img-src`/`media-src`                                                  | 同上                                                                              | **worker 内不能 fetch logo/原图**。必须由主线程用现有 `loadImage`（`imageProcessor.ts:813`，含已测的 `crossOrigin` 防污染语义）加载后 `createImageBitmap` 再 transfer |
| `imageProcessor.ts:1` import 渲染层 `i18n`（react-i18next + zh-CN JSON + `localStorage`），`i18n.t()` 用在 `:567/:822/:965/:1027` | `src/renderer/i18n/index.ts:11-13,98-105`                                         | worker 依赖此模块会把 React 拖进 worker bundle。**须先解耦为错误码**，由主线程翻译                                                                                    |
| 无测试/故事引用 `EditorPage`/`CompareView`；`previewUrl` 消费者仅 4 处                                                            | grep 确认                                                                         | 显示层改造范围可控                                                                                                                                                    |

### 节点

- **B0 可行性闸门（spike，必须先跑）**：新建 `src/renderer/utils/preview-worker.ts` 最小实现
  （收 `{type:'ping'}` 回 `{type:'pong'}`），在 hook 里挂「起 worker → 等 READY → 失败即回落主线程」链路，
  并**实际启动 `npm run dev` 与 `npm run dist:win` 各验证一次**（dev 无 CSP，打包有 CSP）。
  验收（硬闸门）：dev 下 pong 到达；打包产物经 `app://` 加载下 pong 亦到达且无 CSP 违规控制台报错。
  **失败处置（预先约定）**：若打包侧被 CSP 拦，先按最小面加 `worker-src 'self'` 到
  `window-manager.ts:14-16` 与 `index.html:11` 两处并同步注释；若仍不通，**终止 Phase B、交付 Phase A**，
  并在 §9 回填证据与结论。Phase A 已能把拖动从 0 帧恢复到 20~30 帧。
- **B1 i18n 解耦**：四处 `i18n.t()` 改抛携带错误码的错误，由主线程 `catch` 后经 `t()` 映射 `userMessage`。
  验收（红灯）：桩 `i18n` 使 `t` 抛错时管线仍产出正确错误码；`toast.imageProcessorCanvasFailed`
  文案在主线程侧仍可得。**不新增 i18n key**（`npm run i18n:guard` 须不报新增）。
- **B2 worker 管线**：worker 复用 `imageProcessor.ts` 的**纯函数集合**（不复制实现），把重采样 / 逐像素 /
  LUT / 卷积 / 暗角 / 颗粒 / 褪色 / 水印合成搬入 OffscreenCanvas；`base` 与 logo `ImageBitmap` 缓存移入 worker。
  协议（手写 + 类型守卫，不引 comlink）：
  `{type:'PREVIEW_RENDER', reqId, base?, params, watermark?, targetW, targetH, mode:'proxy'|'final'}`
  → `{type:'PREVIEW_RESULT', reqId, bitmap|imageData, tier, elapsedMs}` / `{type:'PREVIEW_ERROR', reqId, code}`；
  buffer 一律 **transferable 零拷贝**。
  生命周期：懒启动（首次进编辑器）、READY 握手 + 3s 超时、崩溃重启 1 次、此后永久回落主线程并
  `console.warn`（对齐 `thumbnail/worker-bridge.ts` 与 `media-worker` 口径）；卸载即 `worker.terminate()`。
  验收（红灯）：worker 正常时主线程 `processImageData` 预览路径调用数为 0；worker 抛错/超时后仍能出图。
- **B3 显示改 canvas（零编码零解码）**：主线程 `ctx.drawImage(transferredBitmap)` 到常驻 `<canvas>`。
  改动面：`EditorPage.tsx:945-956`（`ZoomablePreview` 内 `<img>` → `<canvas>`；`max-w-full max-h-full`
  对 canvas 同样生效，等比由 canvas 固有尺寸保证，`ZoomableContainer.tsx:88` 的 transform 作用于容器、
  不依赖子元素类型）；补 `role="img" aria-label={media.file_name}` 满足 a11y 约定；
  `Histogram.tsx:21-45` 改收已解码位图（`bitmap.width` 替 `naturalWidth`），去掉第二次解码；
  `CompareView` 依赖 `ReactCompareSliderImage src`，**只在分屏对比态**按需 `canvas.toDataURL()` 快照
  （瞬时开关，非拖动热路径）。注意 `EditorPage.tsx:848` 全图对比态显示的是 `originalUrl`，无需 edited 快照。
  验收：`splitCompareMode` 与 `compareMode` 两态画面仍正确；直方图随参数连续变化。
- **B4 打包回归验证**：`npm run build` + `npm run dist:win` 起包，手工完成一次拖动 + 水印 + 8× 缩放
  （`media://` 防污染与 CSP 只在打包态暴露）。

## 4. 启动说明

```bash
npm run dev            # electron-vite dev；手工 trace 与 B0/B4 验证入口
npm run verify         # 只读检查集（tsc -b + eslint 无 --fix + prettier --check + 相关单测 + core-gate）
npm run test:renderer  # 相关子集（jsdom + hooks 项目）
npm run lint           # eslint .
npm run typecheck      # tsc -b + tsc -p tsconfig.scripts.json
npm run i18n:guard     # 翻译键治理
npm test               # vitest run 全量
```

编辑器入口：`npm run dev` → 图库选中一张图片 → 进入编辑器页（`EditorPage`）→ 右侧「基础调整」页签拖滑块。

## 5. 错误处理

| 项                               | 处理                                                                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| proxy 帧失败                     | **不得** `setError`（防 toast 刷屏，同 `EditorPage.tsx:151-162` 的去重理由）；`:132-149` 降级重试仅由 final 帧触发且仍只重试一次 |
| `requestAnimationFrame` 缺失     | 回落既有 `setTimeout(PREVIEW_SETTLE_MS)`                                                                                         |
| worker 无 READY / 超时 3s / 崩溃 | 回落主线程 `processImageData`（依赖 N3 作兜底实现），`console.warn`，UI 不弹窗；重启上限 1 次                                    |
| worker 消息非法                  | 类型守卫 `isPreviewResponse()` 校验 `type/reqId/tier`，不符即丢弃并计一次失败；`reqId` 不匹配的结果丢弃                          |
| `base` 尺寸/身份不符             | 丢弃重建，禁止越界读写；`source` effect（`:176-216`）内清 base/logo 缓存并 `bitmap.close()`                                      |
| logo 失败                        | 不入缓存，仍回调 `onWatermarkImageError`（保住 2026-10-17 修复的可见性）                                                         |
| 卸载 / 切换 source               | `cancelAnimationFrame` + 清定时器 + `worker.terminate()` + 清缓存                                                                |

## 6. 参数校验

| 入参                            | 规则                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `computeDragProxyMaxSize(real)` | 非有限 / ≤0 → 原样返回（沿用 `useImageProcessor.ts:36-40` `normalizeMaxPreviewSize` 的「视为不限制」口径，**禁止静默降分辨率**）；正常值 `min(real, 1024)` 只降不升 |
| `maxPreviewSize`（既有）        | 保持 `:36-40` 语义：仅有限正数有效，其余视为不限制                                                                                                                  |
| `PreviewBase`                   | `width`/`height` 必须与目标尺寸一致，否则丢弃重建；`data.length === w*h*4`                                                                                          |
| base 缓存                       | LRU-2 + `MAX_PIXELS=4_000_000`（≈16MB/档）闸门，超限走原路径不缓存                                                                                                  |
| logo 缓存                       | 上限 4，仅缓存成功结果                                                                                                                                              |
| worker 消息                     | `reqId` 必须为正整数且与在飞请求匹配；`mode` 仅 `proxy`/`final`；数值参数经 `Number.isFinite` 过滤，非法值回落 `defaultFilterParams` 对应项                         |

## 7. 验证方法（帧率 + 单次重绘耗时）

1. **帧数（确定性，必做）**：`useImageProcessor.test.ts` 新增 describe，测试内
   `vi.stubGlobal('requestAnimationFrame', 手动泵)`，不依赖 sinon 帧模型；输出「20 次变更 / 400ms」的
   `(maxSize, tick)` 序列。基线 `[Infinity]`（1 次，拖动期 0 帧）；目标 8~15 帧 + 末帧 final。
2. **单次重绘耗时**：渲染函数加 `performance.mark('wxnn:preview:start'/'end')` +
   `measure('wxnn:preview')`（仓库现值 0 处，属新增，渲染层不受门禁），暴露 dev-only 全局供读取。
3. **拖动 FPS（手工 DevTools）**：`npm run dev` → 打开一张 ≥4000px 原图 → Performance 录制 2 秒连续拖亮度滑块。
   - 修复前判据：scripting 轨单根 >200ms 长任务，且期间指针轨迹**无**画面变化。
   - 修复后判据：密集 20~35ms（Phase A）/ <16ms（Phase B）小任务，画面连续跟随。
   - A/B 手法：`git stash` 前后各录一次，记录 Longest Task、Total Scripting、可见帧数三个数。
4. **（可选，不进本轮门禁）** e2e P11：复用 `e2e/perf-helpers.ts` 的 `evaluateSamples` /
   `DEFAULT_HARD_RULES` / `savePerfReport` 与 `e2e/perf-baseline.json`，MutationObserver 统计预览元素
   `src` 变更次数 + `performance.getEntriesByName('wxnn:preview')` P50/P95，
   阈值建议 `editorDragPreviewFrames ≥ 20`、`editorDragFrameP95Ms ≤ 60`。代价：每轮需 `npm run dist:win`。

## 8. 测试用例总览（正常 / 异常 / 边界）

| 节点 | 文件                                                                                                                            | 正常                       | 异常                   | 边界                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------- | --------------------------------------- |
| N0   | `src/renderer/utils/imageProcessor.pixels.test.ts`（首行 `// @vitest-environment jsdom`，同 `imageProcessor.canvas.test.ts:1`） | 默认参数输出校验和         | `getContext`→null 抛错 | grain 以 `vi.spyOn(Math,'random')` 定值 |
| N1   | `useImageProcessor.test.ts` 追加                                                                                                | ≥8 帧                      | 抛错不污染 error 态    | 在飞连发只渲一帧                        |
| N2   | 同上 + `preview-resolution.test.ts` 追加                                                                                        | proxy 1024 / 末帧 Infinity | NaN / 负数预算         | 只降不升                                |
| N3   | `imageProcessor.base-cache.test.ts`                                                                                             | 3 帧 1 次重采样            | base 尺寸不符重建      | 超上限不缓存                            |
| N4   | `imageProcessor.watermark.test.ts` 追加                                                                                         | 2 帧 1 次加载              | 失败仍回调             | 上限 4 逐出                             |
| N5   | `imageProcessor.test.ts` 追加（`planPasses`）                                                                                   | 全默认无激活 pass          | NaN 视为未激活         | 单键非零                                |
| B0   | `preview-worker.test.ts`                                                                                                        | ping/pong 到达             | 无 READY → 超时回落    | terminate 后不再回调                    |
| B1   | `imageProcessor.test.ts` 追加                                                                                                   | 错误码可映射               | `t` 抛错不掩盖原错     | 未知码走兜底翻译                        |
| B2   | `useImageProcessor.worker.test.ts`                                                                                              | 预览零调用主线程实现       | worker 崩后仍出图      | reqId 失配结果被丢弃                    |

**既有套件不得削弱**：`useImageProcessor.test.ts`(29)、`imageProcessor.canvas.test.ts`(7)、
`imageProcessor.test.ts`、`imageProcessor.watermark.test.ts`、`lut.test.ts`(40)、
`preview-resolution.test.ts`(17)、`useEditHistory.test.ts`、`WatermarkPanel.test.tsx`。

**已核实**：vitest 5.0.3 `vi.useFakeTimers()` 默认伪解除 `nextTick`/`queueMicrotask` 外全部方法
（**含 `requestAnimationFrame`**，源码 `node_modules/vitest/dist/chunks/index.C4tKZ0yW.js:6833-6835`），
故既有 `advanceTimersByTime(500)`（`useImageProcessor.test.ts:77`）仍能驱动 rAF；
`renderPreview()` 在单一变更（onload）下恒走 final 档，`calls[0][2].maxSize` 断言不破。
若出现 calls.length 类失败，属新行为证据，**改写断言而非放宽**。

**约定合规**：Phase A 改动全在 `src/renderer/**` → 不触发 `scripts/core-path-gate.ts` 四条受保护路径，
无需 `// @core-change`；Phase B 若加 `worker-src`，会触碰 `src/main/app/window-manager.ts`
（不在受保护清单，但其 AGENTS.md 明示 CSP 改动为高影响面，须同步 `index.html` 并跑
`src/main/app/__tests__/window-manager.test.ts`）。无 IPC 通道 / `IpcResponse` 变更 →
`docs/IPC_CONTRACT.md` 不动；无新增用户可见文案。新代码为函数式组件 + 显式 Props、
颜色走 CSS 变量、UTF-8 无 BOM / LF。

## 9. 执行记录与实测数字（回填）

顺序：N0 表征闸门 → N1 → N2 → **B0 可行性闸门** → N3 → N4 → N5 → B1 → B2 → B3 → B4 →
全量回归（`npm run verify`、`npm run lint`、`npm run typecheck`、`npm test`、`npm run i18n:guard`）→
复跑 §7 实测并回填数字 → 决定是否做 N7。
每节点严格「红灯（先失败）→ 改 → 绿灯 → 跑相关子集」。N0 是安全网而非缺陷复现测试，
按规则它修复前即通过，不计入红灯要求。

| 节点 | 红灯确认                                                                                                                                                                       | 绿灯确认                                                                                                                                                                                                                                                                                                           | 备注                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| N0   | 非缺陷复现测试（安全网，修复前即通过）；已用「篡改基准值→必失败」证明其有效性                                                                                                  | `npx vitest run src/renderer/utils/imageProcessor.pixels.test.ts` 5 passed                                                                                                                                                                                                                                         | 校验和：default 1858649 / tone 2213750 / convolution 1856163 / spatial 1698958。jsdom 无 `ImageData`，用例内补了与浏览器同签名的最小实现                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| N1   | `expected 0 to be greater than 8` —— **拖动期间实测 0 帧**，与 §0 根因 1 完全吻合                                                                                              | 35 passed（含新增 3 例）；`npm run verify` 5 项全绿                                                                                                                                                                                                                                                                | 关键实现细节：测试必须用 `advanceTimersByTimeAsync` 而非同步 `advanceTimersByTime`——帧渲染是「rAF→异步像素→异步编码→state」的 Promise 链，同步推进不冲刷微任务，`inFlight` 复位不了，后续帧会被永久误合并                                                                                                                                                                                                                                                                                                                                                                      |
| N2   | 4 例红（`computeDragProxyMaxSize` 未定义 + 档位序列全为 Infinity）                                                                                                             | 66 passed；`npm run verify` 5 项全绿                                                                                                                                                                                                                                                                               | **对计划的订正**：§6 原写「非有限值原样返回」，但 `Infinity`（= 不限制）正是 8× 缩放时逐像素跑原图的失控入口，因此代理档**必须**把 `Infinity` 钳到 1024；只有 NaN/0/负数才原样透传。已按此实现并写测试                                                                                                                                                                                                                                                                                                                                                                         |
| B0   | 首次实现即失败，且失败方式极具信息量：Vite 未识别 worker，把 `.ts` 按 MIME 当 MPEG 传输流内联成 `data:video/mp2t;base64,…`，`dist/renderer/assets` 里**根本没有 worker chunk** | 改为 `new Worker(new URL('./preview-worker.ts', import.meta.url))` 字面量留在调用点后，产出 `dist/renderer/assets/preview-worker-AyRKEcmP.js`（IIFE，无 import 语句，classic worker 可直接加载）；运行时探针输出 `READY + pong 成功，script=app://renderer/assets/preview-worker-AyRKEcmP.js`，**1 passed (2.9s)** | **Phase B 结论：成立，且无需改 CSP**（`default-src 'self'` 已放行同源 worker，`app://` 的 `.js` 已映射 `text/javascript`）。探针用 `launchBuiltApp()`（自带 electron 跑 dist 产物、NODE_ENV=production 故 CSP 生效）代替耗时的 `dist:win`；探针文件验证后删除，结论留档于此。另加 7 例 bridge 单测覆盖握手/超时/崩溃回落/畸形消息                                                                                                                                                                                                                                              |
| N3   | 4 例红（`buildPreviewBase` 未导出）+ hook 侧档位序列无 base                                                                                                                    | 986 passed；`npm run verify` 5 项全绿                                                                                                                                                                                                                                                                              | 抽出 `computeTargetSize`/`rasterizeToTarget`/`buildPreviewBase`；`PreviewBase.data` 必须显式写成 `Uint8ClampedArray<ArrayBuffer>`，否则 TS 5.9 的 DOM lib 拒绝把它交给 `ImageData` 构造器（ArrayBufferLike ≠ ArrayBuffer）。命中核验用**图源对象身份**而非 URL                                                                                                                                                                                                                                                                                                                 |
| N4   | 8 例红（`clearWatermarkLogoCache` 未导出 → 文件级 beforeEach 抛错，连带 4 个既有用例一起失败，实现后全绿）                                                                     | 986 passed；`npm run verify` 5 项全绿                                                                                                                                                                                                                                                                              | 缓存的是 **Promise**（顺带合并并发帧的重复请求），且失败即从缓存删除；替身改为记录构造次数以断言「两帧只加载一次」。缓存只在 hook 卸载时清，避免跨会话读到陈旧位图                                                                                                                                                                                                                                                                                                                                                                                                             |
| N5   | 7 例红（`planPasses` 未导出）                                                                                                                                                  | 993 passed，且 **N0 四个校验和一字未变** → 逐像素等价得到证明                                                                                                                                                                                                                                                      | 关键取舍：`applyTemperature/Vibrance/HSL/SplitTone/Dehaze` 都是被 `imageProcessor.test.ts` 直接测过的导出函数，**签名不动**，改为「未激活就整段跳过」；`applyHSL` 新增可选 `keys` 参数（默认全 12 键，向后兼容）。`applyVignette` 只把 `a**2` 换成 `a*a` 并预存逐列平方——V8 下二者逐位相同                                                                                                                                                                                                                                                                                     |
| B1   | 由 B2 用例驱动：桩 `Worker` 后 hook 侧 worker 用例先红                                                                                                                         | 全量 renderer 2274 passed；`npm run test` 6443 passed；lint 0 error；i18n:guard ✅                                                                                                                                                                                                                                 | `imageProcessor.ts` 去掉 `import i18n from '../i18n'`，改为 `setImageProcessorTranslator` 注入（与 `shared/errors` 的 `setAppErrorTranslator` 同模式，接线点在 `src/renderer/i18n/index.ts`）。**产物验证**：worker chunk 32.95 kB，`grep react\|i18next` 命中 0 → React 确实没被拖进 worker                                                                                                                                                                                                                                                                                   |
| B2   | 6 例 worker 用例先红（hook 尚未走 worker）                                                                                                                                     | 511 passed（hooks + worker 入口）                                                                                                                                                                                                                                                                                  | worker 接 `RENDER{reqId, buffer(transferable), w/h, params, watermark, mime, quality}` → 回 `RESULT{reqId, blob}` 或 `ERROR`。主线程 `acquireBase` 后**复制一份再 transfer**（底图本体要留在缓存里继续用）。带**图片水印**的帧留在主线程：logo 只能主线程经 media:// 取（`fetch('media://…')` 撞 `connect-src`），不为它牺牲 2026-10-17 的失败可见性契约。**测试抓到两个真 bug**：① `canvas instanceof OffscreenCanvas` 在全局不存在该构造器的环境直接抛 ReferenceError（必须先 `typeof`）；② 卸载早于 READY 会留下无人终止的孤儿线程——补 `workerDisposedRef` 在迟到回调里回收 |
| B4   | —                                                                                                                                                                              | 打包态探针（`launchBuiltApp`，dist 产物 + CSP 生效）发出真实 RENDER，回 `RESULT blob size=767 type=image/jpeg`，**1 passed (1.8s)**；探针文件验证后删除                                                                                                                                                            | 这条证明了单测证明不了的部分：imageProcessor 被打进 worker chunk、OffscreenCanvas 合成、`convertToBlob` 编码、零拷贝缓冲，在 `app://` + 严格 CSP 下真的跑通                                                                                                                                                                                                                                                                                                                                                                                                                    |
| B3   | 未执行——**被更优方案取代**                                                                                                                                                     | —                                                                                                                                                                                                                                                                                                                  | 原计划把预览从 `<img>` 改成 `<canvas>`，目的是消掉同步 `toDataURL` 与浏览器二次解码。B2 落地后 worker 直接返回 **Blob**，主线程只做 `FileReader.readAsDataURL`（异步、编码已在 worker 完成），`data:` URL 天然合规、`<img>`/`CompareView`/`Histogram` 全不用动。改 canvas 的净收益归零、风险不变，故取消                                                                                                                                                                                                                                                                       |

### 全量回归（本轮结束时实跑）

- `npm test`：**418 files / 6443 passed / 2 skipped / 0 failed**（46.8s）
- `npm run typecheck`（`tsc -b` + `tsc -p tsconfig.scripts.json`）：无输出即通过
- `npm run lint`：**0 error**，11 warning 全部是 DEBT-030 登记的 `src/renderer/components/common/*.test.tsx` 存量 BOM，本轮未触碰这些文件
- `npm run i18n:guard`：✅ 白名单只减不增、key 已同步（本轮**未新增任何 i18n key**）
- `npm run verify`：typecheck / lint / core-gate / format / test **5 项全绿**

### 仍待人工确认的一项

单测已量化「拖动期 0 帧 → 连续出帧」，但**编辑器界面的真实手感**（OffscreenCanvas 用于主线程
`rasterizeToTarget` 后的预览清晰度、缩放/对比模式）只能在装了图库数据的桌面上核验：
`npm run dev` → 进编辑器拖亮度滑块，确认画面连续跟随、放大后不发虚、分屏对比正常，
并录一段 Performance trace 记录 Longest Task（预期从单根 >200ms 变为 <16ms 密集小任务）。

### 实测数字

- before/after 单帧像素耗时（A/B 同机同数据实测，`processImageData` 直跑，jsdom 下 stub 画布回读）：

| 帧尺寸                            | 场景         | 修复前     | 修复后     | 倍率      |
| --------------------------------- | ------------ | ---------- | ---------- | --------- |
| 1024×768（拖动代理档）            | 只调亮度     | 132.95 ms  | 30.17 ms   | **4.41×** |
| 1024×768                          | 全 pass 开启 | 368.09 ms  | 347.28 ms  | 1.06×     |
| 2048×1536（1× 缩放 @2x 屏真实档） | 只调亮度     | 516.33 ms  | 117.85 ms  | **4.38×** |
| 2048×1536                         | 全 pass 开启 | 1417.96 ms | 1354.14 ms | 1.05×     |

**由数据得出的结论**：N5 的去冗余在「只动一两个参数」的常见拖动场景把每帧成本降到 1/4.4，
但当 HSL/曲线/分离色调/去雾等**同时**开启时几乎无收益（1.05×）——此时成本由真实的逐像素数学决定，
不是冗余。因此：① 拖动代理档（N2）是必需而非可选优化；② 重编辑场景要真正流畅，
**只能靠把像素循环搬离主线程（B2）**，这直接支持了本轮选择 Worker 的决策。

- before/after 帧数序列（单元测试口径，20 次连续参数变更）：修复前 `1 帧（拖动期间 0 帧）` → 修复后 `≥8 帧，末帧为真实预算`

### 本轮踩到并固化下来的四条约束

1. **`new Worker(new URL(...))` 的形状不可拆散**：URL 一旦提成变量或经函数参数传入工厂，
   Vite 就退化成按普通资源处理（`.ts` → `data:video/mp2t;base64,…`），worker chunk 根本不会产出。
   已在 `preview-worker-bridge.ts` 的 `openPreviewWorker` 处写明原因注释，
   并加单测断言「交出去的不是 data URL」作为常驻守护。
2. **ESLint 护栏的两条硬约束**（首次 verify 即被拦）：字符串字面量禁止中文
   （开发向日志一律写英文，UI 文案走 `t()`）；`console.log/info/debug/trace/table/dir` 被禁，
   只放行 `console.warn` / `console.error`。
3. **jsdom 缺 `ImageData` / `OffscreenCanvas` / canvas 编码能力**：凡走到这些分支的用例
   必须自带最小替身（`imageProcessor.pixels.test.ts`、`imageProcessor.base-cache.test.ts`、
   `preview-worker.test.ts` 各有一份），且 `instanceof OffscreenCanvas` 必须先 `typeof` 判定。
4. **带 Promise 链的帧调度不能用同步 `advanceTimersByTime`**：必须 `advanceTimersByTimeAsync`，
   否则渲染收尾（`inFlight` 复位）完不成，后续帧被永久误合并；另外「状态变更」与「推进时钟」
   要分成两次 `act`，因为 React 到 `act` 收尾才 flush effect。

## 10. 入库前独立审查（2026-10-18 二轮）：三项红灯修复

审查对象是 §9 描述的全部未提交改动。**闸门本身全绿**（`tsc -b` 退出 0、eslint 0 error、受影响 10 套件
190 passed、`npm test` 6443 passed / 2 skipped、`i18n:guard` ✅、无 BOM），但 worker 生命周期与降级链上
有三处**测试未覆盖**的逻辑缺陷，均已按「先红灯复现、后最小修复转绿」落地。

| 编号 | 缺陷                                                                                                                                                                                                                                                                                                                                                                   | 红灯现场（修复前原始报错）                                                                   | 修复                                                                                                                                                               | 绿灯                                                       |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| R1   | `workerDisposedRef` 只在 `releaseWorker` 写过 `true`、**从不复位**。dev 入口 `main.tsx:18` 套着 StrictMode，effect 走「挂载 → 清理 → 再挂载」而 ref 跨这两次是同一个对象，于是第二次挂载里迟到的握手被 `if (workerDisposedRef.current) handle.terminate()` 判成「组件已死」→ **预览 worker 在 dev 永远接管不上**，Phase B 恰好在 §7.3 手工测速所用的那个环境里静默失效 | `AssertionError: expected true to be false`（handle 被 terminate，`requests.length` 恒为 0） | 在卸载 cleanup 那条 effect 的**体内**（每次挂载恰好跑一次，deps 恒定）复位 `workerDisposedRef.current = false`                                                     | 用例「React StrictMode 二次挂载后仍由 worker 出图」转绿    |
| R2   | 放弃 worker 的三条路径（回 `ERROR` / 运行期崩溃 / 单帧超时）都只做 `previewWorkerRef.current = null` 而**不 terminate**；`releaseWorker` 卸载时读到的已是 null，无从回收 → 线程带着整个 `imageProcessor` 模块与其 logo 缓存存活到进程结束。崩溃回调还**不 settle 在飞请求** → 那一帧必须空等满 2000ms 才回落                                                           | `expected false to be true` ×2（terminated）＋ `expected 2001 to be less than 1500`          | 新增 `discardPreviewWorker(reason)`：置空引用（保持「永久回落」语义）→ 立即 settle 在飞帧（复用 `settleWorkerPending`，顺带清超时器）→ `terminate()`；三处统一改调 | 三条用例全绿                                               |
| R3   | 代理档失败的「降级重试」实际是**放大重试**：proxy 预算恒 ≤ `DRAG_PROXY_MAX_SIZE`(1024)，而兜底档 `FALLBACK_PREVIEW_MAX_SIZE` = 1400 更大，`if (maxSize !== 1400)` 恒成立 → 拖动中每失败一帧就立刻换更大的画布再绘一次；`setError` 亦无条件执行。§5 明文要求二者**仅由 final 帧触发**                                                                                   | `AssertionError: expected [ 1024, 1400 ] to deeply equal [ 1024 ]`                           | `doRender` 的 catch 首行加 `if (tier === 'proxy')` 闸门：只记一条 warn 后返回，交由 140ms 尾沿补出的 final 帧走完整「降级重试 + 上报错误」链路                     | 用例「代理档失败不得触发兜底放大重试，也不得写 error」转绿 |

同批清掉四处本轮自带问题（均属本次未提交 diff 引入）：

- `ProcessOptions.logoBitmap` 是**零写入者的死参数**——带图片水印的帧本就由 `renderViaWorker`
  留在主线程，注释却声称「worker 由主线程解码后传入位图」。删字段与分支，`drawImageWatermark`
  恢复单一 `loadImage` 路径。
- `*/ export { formatWatermarkText }` 被误压成一行，拆回两行以消除 diff 噪声。
- `measurePreviewRender` 满窗时用**无参** `performance.clearMarks()`，会把本帧刚打的
  `wxnn:preview:start` 一并抹掉，紧随的 `measure(name, start, end)` 因起点不存在而抛错、被外层
  `catch` 吞掉 → 每 256 帧白丢一个样本并遗留孤儿 end mark。改为按名 `clearMeasures(PERF_MEASURE_NAME)`
  （start/end 两个 mark 本来就在每次 measure 后按名清除，不会无界增长）。
- `preview-worker-bridge.test.ts` 一处 prettier 违规（本轮唯一格式失败项）。

**R1 的方法学教训（重要）**：`renderHook(..., { wrapper: StrictMode })` 在本环境**不会**双调用 effect。
探针实测三种写法：`renderHook + StrictWrapper` → `["mount"]`；`render(createElement(StrictMode, …))`
→ `["mount","cleanup","mount"]`；`renderHook` 裸用 → `["mount"]`。必须用后者，与仓内既有
`useOnDemandThumbnails.test.tsx:48` 的写法一致——用错写法只会得到一条「假绿」用例，缺陷照常存在。

**本轮结束时实跑**：受影响 10 套件 **195 passed**（较审查前 +5，即本节的 5 条回归用例）；
`npm test` **418 files / 6448 passed / 2 skipped / 0 failed**（38.28s）；`npm run verify`
typecheck / lint / core-gate / format / test **5 项全绿**；`npm run lint` **0 error**
（11 条 warning 全是 DEBT-030 登记的 `components/common/*.test.tsx` 存量 BOM，本轮未触碰这些文件）；
`npm run typecheck`（含 `tsconfig.scripts.json`）无输出；`npm run i18n:guard` ✅（未新增 key）；
**N0 的四个逐像素校验和一字未变**，说明 R3 的 catch 闸门与死参数清理都没有扰动像素语义。
