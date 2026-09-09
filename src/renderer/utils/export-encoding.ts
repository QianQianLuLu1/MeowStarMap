/**
 * 导出编码决策（纯函数，无 DOM 依赖）
 *
 * 编辑器导出时有三个入口需要使用同一套「扩展名/MIME → 编码参数」规则：
 * 单图保存、另存为、批量应用。此前三处各写各的（其中批量分支硬编码
 * `image/jpeg` + 0.95），源图为 PNG 时会被静默转成有损 JPEG。
 */

export type ExportMimeType = 'image/jpeg' | 'image/png' | 'image/webp'

/**
 * 导出 JPEG 质量（0-1）。
 *
 * 主进程在「目标格式 == dataUrl 格式」时直接写盘、不再用 sharp 二次编码，
 * 因此最终文件的质量完全由渲染层这一次编码决定，必须取最高质量。
 */
export const EXPORT_JPEG_QUALITY = 1

/** PNG / WebP 走无损档 */
export const LOSSLESS_QUALITY = 1

export interface ExportEncoding {
  mimeType: ExportMimeType
  quality: number
}

/**
 * 由扩展名或 MIME 推断导出编码
 *
 * @param extOrMime 扩展名（`jpg` / `.PNG` / `webp`）或 MIME（`image/png`）；
 *                  允许带查询串（media:// URL 解析产物）与任意大小写
 * @returns `{ mimeType, quality }`；无法识别时回落 `image/jpeg`
 */
export function resolveExportEncoding(extOrMime?: string | null): ExportEncoding {
  const raw = typeof extOrMime === 'string' ? extOrMime.trim().toLowerCase() : ''
  const normalized = raw.replace(/^\./, '').split('?')[0]

  let mimeType: ExportMimeType = 'image/jpeg'
  if (normalized === 'png' || normalized === 'image/png') {
    mimeType = 'image/png'
  } else if (normalized === 'webp' || normalized === 'image/webp') {
    mimeType = 'image/webp'
  }

  return {
    mimeType,
    quality: mimeType === 'image/jpeg' ? EXPORT_JPEG_QUALITY : LOSSLESS_QUALITY
  }
}
