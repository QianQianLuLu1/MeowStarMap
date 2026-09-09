# 修复图片编辑器「预览模糊 / 导出降质」

- 状态：已确认，执行中
- 版本：2.5.1
- 范围：图片编辑器预览链路 + 保存/另存为/批量应用/带元数据导出链路

## 0. 问题与根因

编辑器加载的确实是原图（`media://` 协议直返原始文件字节，无缩放），模糊与降质由代码自身引入：

| 编号 | 位置                                                                                                                                | 问题                                                                                                                                               |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1   | `src/renderer/hooks/useImageProcessor.ts:18` `DEFAULT_MAX_PREVIEW_SIZE = 1400` + `src/renderer/pages/EditorPage.tsx:86` 显式传 1400 | 预览长边被硬钳到 1400。3840×2160 只剩 34% 像素，6000×4000 只剩 12%                                                                                 |
| F2   | 编辑器预览全链路                                                                                                                    | 无 `devicePixelRatio` 补偿（全仓库仅 `VirtualImageGrid.tsx:24` 有 DPR 处理）。2x 屏上显示需求 2400，实际只给 1400                                  |
| F3   | `src/renderer/pages/EditorPage.tsx:878-888` + `ZoomableContainer.tsx:71-79`                                                         | 1400 位图被 `object-contain` + `scale(≤8)` 上采样到全屏，浏览器插值放大                                                                            |
| F4   | `src/renderer/utils/imageProcessor.ts:528`                                                                                          | `ctx.drawImage(source, 0, 0, w, h)` 未设 `imageSmoothingQuality`，也未用 `createImageBitmap` 高质量重采样，大比例缩小走浏览器默认低质量滤波        |
| F5   | `src/renderer/hooks/useImageProcessor.ts:22` `PREVIEW_JPEG_QUALITY = 0.92`                                                          | 预览每次渲染都过一道有损 JPEG                                                                                                                      |
| F6   | `src/renderer/hooks/useImageProcessor.ts:95` + `src/main/services/editor-service.ts:194-202`                                        | 双重有损编码：渲染层 `toDataURL('image/jpeg', 0.95)` 编码一次 → 主进程 sharp 以 `q95 + mozjpeg` 再编码一次；`png({quality:95})` 还会触发调色板量化 |
| F7   | `src/renderer/pages/EditorPage.tsx:581`                                                                                             | 批量应用残留 `maxSize: 4096`，长边 >4096 的原片被静默降采样后写回原路径（单图路径已在 `useImageProcessor.ts:230` 修过，批量漏改）                  |
| F8   | `src/renderer/pages/EditorPage.tsx:302-309` + `src/main/services/file-service.ts:508-519`                                           | 另存为传 `format:'jpg'`，但 `saveDataUrl` 忽略 format 直接写 buffer；源为 PNG 时产出 `.jpg` 扩展名的 PNG 字节                                      |

## 1. 依赖声明

**无新增依赖。** 不安装、不升级任何 npm 包。

- 缩放/重采样复用浏览器原生能力：`createImageBitmap(source, { resizeQuality: 'high' })` + Canvas 2D `imageSmoothingQuality`
- 主进程转码复用既有 `sharp ^0.35.3`（`package.json` dependencies），仅调整参数，不引入新图像处理库
- 测试复用既有 `vitest ^1.6.1` + `jsdom` + `@testing-library/react`

若执行中发现缺包，只允许用 `npm install <pkg>` 增量安装（本机 Safe-Delete 网关会拦截 `npm ci` 与删除 `node_modules`）。

## 2. 目标与验收口径

1. **预览**：预览渲染分辨率 = `min(原图, 显示区尺寸 × devicePixelRatio × 当前缩放)`。放大到 1:1 时按原图全分辨率渲染；适应窗口时像素量与显示需求一致（不再被 1400 截断、不再被 CSS 上采样）。
2. **导出**：导出图片分辨率与原图 100% 一致；同格式时**只编码一次**（主进程直写渲染层字节），跨格式转码使用无损/最高质量参数。

## 3. 子任务清单

### 节点 1：预览尺寸预算纯函数（T1、T2）

- **目标文件**：`src/renderer/utils/preview-resolution.ts`（新建）
- **输入 / 输出**：

```ts
export const PREVIEW_SIZE_QUANTUM = 256
export const FALLBACK_PREVIEW_MAX_SIZE = 1400
export const MIN_PREVIEW_MAX_SIZE = 256
export const MAX_PREVIEW_MAX_SIZE = 65535 // Chromium canvas 单边上限

/** @returns 预览长边预算(px)，已向上量化到 256 的倍数 */
export function computePreviewMaxSize(
  boxWidth: number,
  boxHeight: number,
  dpr: number,
  scale: number
): number

/** 首帧容器未测量时的估算值；window 不可用回落 FALLBACK_PREVIEW_MAX_SIZE */
export function estimateInitialPreviewMaxSize(win?: Window | null): number
```

- **算法**：`raw = max(boxW, boxH) × clamp(dpr,1,4) × clamp(scale,1,8)`；非法输入（NaN/Infinity/≤0/非数字）→ `FALLBACK_PREVIEW_MAX_SIZE`；结果 `clamp(ceil(raw/256)*256, 256, 65535)`。
- **验收标准**：`npx vitest run src/renderer/utils/preview-resolution.test.ts` 全部通过（红灯阶段必须先失败）。

### 节点 2：高质量重采样 + maxSize 校验（T3–T6）

- **目标文件**：`src/renderer/utils/imageProcessor.ts`
- **改动点**：
  1. `processImageData` 的 `maxSize` 解析改为「仅接受有限正数，其余视为不限制」（原 `options.maxSize || 1600`）
  2. 需要缩放时优先 `createImageBitmap(source, { resizeWidth, resizeHeight, resizeQuality: 'high' })`，失败/缺失回退 `imageSmoothingEnabled = true` + `imageSmoothingQuality = 'high'` 的 `drawImage`
  3. 无需缩放时 `drawImage(source, 0, 0)` 三参 1:1 直绘（零重采样）
- **验收标准**：`npx vitest run src/renderer/utils/imageProcessor.canvas.test.ts` 全部通过（红灯阶段必须先失败）；`FilterPanel` 的 `maxSize: 120` 滤镜缩略图行为不变。

### 节点 3：hook 预览尺寸与导出编码（T7–T10）

- **目标文件**：`src/renderer/hooks/useImageProcessor.ts`、`src/renderer/utils/imageProcessor.ts`
- **改动点**：
  1. `DEFAULT_MAX_PREVIEW_SIZE` 1400 → `Number.POSITIVE_INFINITY`（不指定即不限制），并对 `maxPreviewSize` 做有限正数校验
  2. `PREVIEW_JPEG_QUALITY` 0.92 → 0.95
  3. `EXPORT_JPEG_QUALITY` 0.95 → 1（同格式直写后质量只能由渲染层决定）
  4. 新增并复用纯函数 `resolveExportEncoding(extOrMime)` → `{ mimeType, quality }`（`exportDataUrl` 与批量分支共用）。
     落地位置为独立模块 `src/renderer/utils/export-encoding.ts`：`useImageProcessor` 的单测整体 mock 了
     `../utils/imageProcessor`，放在其中会被 mock 吞掉而无法验证真实行为
  5. `renderPreview` 失败时用 `FALLBACK_PREVIEW_MAX_SIZE` 兜底重试一次，仍失败才 `setError`
- **验收标准**：`npx vitest run src/renderer/hooks/useImageProcessor.test.ts` 全部通过（红灯阶段必须先失败）。

### 节点 4：EditorPage 接线与批量修复（T11）

- **目标文件**：`src/renderer/components/common/ZoomableContainer.tsx`、`src/renderer/pages/EditorPage.tsx`
- **改动点**：
  1. `ZoomableContainer` 新增可选 prop `onScaleChange?: (scale: number) => void`，`useEffect` 同步（不传则零副作用，DetailPage 不受影响）
  2. EditorPage：预览容器 `ref` + `ResizeObserver` 测 `boxW/boxH`；`useMemo` 计算 `previewMaxSize` 并传给 `useImageProcessor`
  3. 批量应用 `maxSize: 4096` → 不限制，并按目标扩展名取导出编码
  4. `handleSaveAs` 显式传 `mimeTypeOverride = 'image/jpeg'`
- **验收标准**：`npx vitest run src/renderer/components/common/ZoomableContainer.test.tsx` 通过；`npm run typecheck` 无新增错误。

### 节点 5：主进程零二次编码（T12–T15）

- **目标文件**：`src/main/utils/image-encode.ts`（新建）、`src/main/services/editor-service.ts`、`src/main/services/xmp-metadata-service.ts`、`src/renderer/i18n/locales/*.json`
- **改动点**：
  1. 新建 `src/main/utils/image-encode.ts`：`resolveSaveStrategy` / `getLosslessEncodeOptions` / `normalizeImageFormat` / `mimeToFormat`。
     editor-service 依赖 xmp-metadata-service，二者不能互相 import，故编码决策抽到共享工具模块
  2. `save()`：目标格式 == dataUrl 格式 → `fs.promises.writeFile` 直写（sharp 完全不介入）；否则 sharp 转码
  3. 转码参数：JPEG `{ quality: 100, chromaSubsampling: '4:4:4', mozjpeg: true }`；PNG `{ compressionLevel: 9, palette: false, adaptiveFiltering: true, quality: 100 }`；WebP `{ quality: 100, nearLossless: true, smartSubsample: true }`
  4. `xmp-metadata-service.ts` 参数对齐（复用同一函数）
  5. 新增 3 个 i18n key：`main.editor.log.directWriteNoReencode`、`main.editor.log.transcode`、`main.editor.error.emptyImageData`
     （`npm run sync-i18n-keys` 已同步至全部 12 个语言文件）
- **验收标准**：`npx vitest run src/main/services/editor-service.test.ts` 通过；`npm run i18n:check` 无缺失 key。

### 节点 6：全局回归

- `npm test`（基线 263 文件 / 4476 用例，只允许新增不减少）
- `npm run typecheck`、`npm run lint`、`npm run i18n:check`
- 手动验证（见 §5）

## 4. 参数校验

| 函数                            | 参数                                    | 必填 | 边界 / 非法值处理                                                                                                                                               |
| ------------------------------- | --------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `computePreviewMaxSize`         | `boxWidth`, `boxHeight`, `dpr`, `scale` | 是   | 任一为 `NaN`/`Infinity`/`≤0`/非数字 → 返回 `FALLBACK_PREVIEW_MAX_SIZE`(1400)；`dpr` 夹 `[1,4]`；`scale` 夹 `[1,8]`；结果夹 `[256, 65535]` 并向上量化到 256 倍数 |
| `estimateInitialPreviewMaxSize` | `win?`                                  | 否   | `win` 缺失或 `innerWidth/innerHeight/devicePixelRatio` 非法 → 1400                                                                                              |
| `processImageData`              | `options.maxSize`                       | 否   | 仅有限正数生效；`undefined`/`0`/负数/`NaN`/`Infinity` 一律视为「不限制」（不放大、不缩小）                                                                      |
| `resolveExportEncoding`         | `extOrMime`                             | 否   | 空值/未知值 → `{ mimeType: 'image/jpeg', quality: 1 }`；识别 `png/webp/jpg/jpeg`，大小写与前导 `.`、查询串均兼容                                                |
| `useImageProcessor`             | `maxPreviewSize`                        | 否   | 非法值（≤0/NaN）→ `Infinity`；正常值原样透传                                                                                                                    |
| `exportDataUrl`                 | `fullSize`, `mimeTypeOverride`          | 否   | `imageRef` 为空 → 返回 `null`；`mimeTypeOverride` 非白名单值 → 回落 `image/jpeg`                                                                                |
| `editorService.save`            | `filePath`, `dataUrl`, `options`        | 是   | 空 buffer → 抛错并走既有回滚；未知格式 → 回落 `getExtFromMime`；路径非已索引媒体 → 既有 `onlyIndexedPath` 拦截                                                  |

## 5. 启动与验证说明

### 环境准备

```powershell
cd (Resolve-Path 'd:\Qode*\WXNN*').Path
npm install          # 增量安装；禁止 npm ci / Remove-Item node_modules（Safe-Delete 网关会拦截）
```

### 单元测试（逐节点）

```powershell
npx vitest run src/renderer/utils/preview-resolution.test.ts
npx vitest run src/renderer/utils/imageProcessor.canvas.test.ts
npx vitest run src/renderer/utils/export-encoding.test.ts
npx vitest run src/renderer/hooks/useImageProcessor.test.ts
npx vitest run src/renderer/components/common/ZoomableContainer.test.tsx
npx vitest run src/main/services/editor-service.test.ts
```

### 全局校验

```powershell
npm run typecheck
npm run lint
npm run i18n:check
npm test
```

全量 vitest 建议后台跑再轮询：

```powershell
Start-Process cmd.exe "/c npx vitest run > .x.log 2>&1"
```

### 手动验证路径

1. `npm run dev`
2. 图库选一张 ≥3840×2160 的截图进入编辑器
3. 适应窗口：预览应无可见软化（2x 屏上应明显比修复前锐利）
4. 滚轮放大到 100%：逐像素锐利；开启「对比模式」左右应无肉眼差异
5. 点「保存」后在资源管理器查看文件属性：**分辨率与原图完全一致**
6. 批量应用 10 张（含长边 ≥4096 的原片）后逐一核对分辨率未被降低
7. 另存为：确认落盘文件扩展名与实际编码一致（JPEG 魔数 `FFD8`）

## 6. 错误处理与日志

| 场景                                 | 处理                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `createImageBitmap` 抛错或环境不支持 | 静默回退 `drawImage` + `imageSmoothingQuality='high'`；不向用户报错                                     |
| `getContext('2d')` 返回 null         | 抛 `toast.imageProcessorCanvasFailed`（既有行为，保留）                                                 |
| 预览渲染异常（如超大图 OOM）         | `renderPreview` catch 后用 1400 兜底重试一次并 `console.warn`；仍失败才 `setError`，UI 显示既有失败文案 |
| 主进程直写失败                       | 沿用既有「备份 → 写入 → 失败回滚」链路，异常向上抛给 handler                                            |
| 未知目标格式                         | 回落 `getExtFromMime(mimeType)`，不直写                                                                 |
| 空 buffer / 极小图 / 超大图          | 参数校验拦截，不抛未捕获异常                                                                            |

**日志设计**：主进程新增 2 处 `logger.info`，每次保存各最多 1 条，内容为「目标格式 + 字节数 + 是否重编码」，**不打印图片数据**。

- `main.editor.log.directWriteNoReencode`
- `main.editor.log.transcode`

新增 key 后必须执行 `npm run sync-i18n-keys` 与 `npm run i18n:check`（注意：正确脚本名是 `i18n:check`，不存在 `check-i18n-keys`）。

## 7. 基础测试用例矩阵

| 编号 | 层级                  | 场景                                                        | 预期                                                                      | 修复前                     |
| ---- | --------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------- |
| T1   | preview-resolution    | 1200×800 / dpr1 / scale1 → 1280；dpr2 → 2560；scale4 → 4864 | 长边预算随 DPR 与缩放线性增长                                             | 红灯（函数不存在）         |
| T2   | preview-resolution    | 竖构图、超宽全景、scale>8、dpr>4、NaN、负数、0、未测量      | 分别取 `max(boxW,boxH)` 与夹持值；非法输入回落 1400                       | 红灯                       |
| T3   | imageProcessor.canvas | 6000×4000 + maxSize 1500                                    | 走 `createImageBitmap(resizeQuality:'high')`，canvas 1500×1000            | 红灯（当前无高质量重采样） |
| T4   | imageProcessor.canvas | 无 `createImageBitmap` 环境                                 | 回退 `drawImage` 且 `ctx.imageSmoothingQuality === 'high'`                | 红灯                       |
| T5   | imageProcessor.canvas | 800×600 + maxSize 1500                                      | canvas 保持 800×600，`drawImage` 三参 1:1 直绘                            | 红灯（当前恒传 5 参）      |
| T6   | imageProcessor.canvas | maxSize 为 undefined / 0 / -1 / NaN                         | 不缩放，canvas 等于原图尺寸                                               | 红灯（当前回落 1600）      |
| T7   | useImageProcessor     | 默认（不传 maxPreviewSize）                                 | `processImageData` 收到 `Infinity`                                        | 红灯（当前 1400）          |
| T8   | useImageProcessor     | 传 2600 原样透传；传 0 / -5 / NaN 回落 `Infinity`           | 尺寸预算不再被静默截断                                                    | 红灯                       |
| T9   | useImageProcessor     | `exportDataUrl(true)` 对 jpg 源                             | mime=`image/jpeg`，quality=`1`                                            | 红灯（当前 0.95）          |
| T10  | useImageProcessor     | `exportDataUrl(true,'image/jpeg')`；非法 mime               | 使用 override；非法值回落 jpeg                                            | 部分红灯                   |
| T11  | ZoomableContainer     | `onScaleChange` 随滚轮 / 双击 / 复位回调                    | 回调值与内部 `scale` 一致                                                 | 红灯（prop 不存在）        |
| T12  | editor-service        | 目标格式 == dataUrl 格式                                    | `sharp` 完全未被调用，走 `writeFile`                                      | 红灯（当前恒走 sharp）     |
| T13  | editor-service        | 需转码                                                      | jpeg 含 `quality:100 + chromaSubsampling:'4:4:4'`；png 含 `palette:false` | 红灯                       |
| T14  | editor-service        | 输出分辨率 == 输入分辨率                                    | 分辨率 100% 一致（sharp 可用性门控 `it.runIf`）                           | 红灯                       |
| T15  | 边界                  | 空 buffer / 未知格式 / 1×1 / >40MP                          | 不抛未捕获异常                                                            | 红灯                       |

## 8. 风险与权衡

1. **JPEG 导出体积增大**：`EXPORT_JPEG_QUALITY` 0.95 → 1，体积约增 2–3 倍。这是「单次高质量编码」取舍的直接代价；如需回退只改一个常量。
2. **1:1 大图预览耗时**：24MP 原图逐像素调色约 0.8–3s。缓解：适应窗口时预算≈显示像素（与当前 1400 同量级）；缩放触发的重渲染被 80ms 防抖合并，停手后才渲染一次；渲染期间保留旧 `previewUrl`，不闪黑。
3. **内存**：1:1 预览 24MP 时 ImageData 约 96MB（RGBA）+ canvas + dataUrl。属可接受范围，并已有失败兜底。
4. **不做的事**：不改动图库缩略图档位（320/q85、512/q90）、不改动 `FilterPanel` 的 `maxSize:120`、不重构/格式化无关代码、不改 IPC 通道与 preload 契约、不动视频编辑与直方图。
