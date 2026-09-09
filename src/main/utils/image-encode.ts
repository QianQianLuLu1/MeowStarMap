/**
 * 图片保存/转码的编码决策（纯函数，无 IO）
 *
 * 抽成独立工具模块的原因：editor-service 与 xmp-metadata-service 都需要同一套
 * 「目标格式 → 无损/最高质量编码参数」规则，而 editor-service 又依赖
 * xmp-metadata-service，二者不能直接互相 import（会形成循环依赖）。
 */

/**
 * 转码时的 JPEG 质量。
 *
 * 渲染层导出时已编码一次，主进程若再降质会累积成双代损失，故转码统一取最高质量。
 */
const LOSSLESS_JPEG_QUALITY = 100
/** 支持无损/最高质量转码的目标格式；不在其中的格式只能直写 */
const TRANSCODE_FORMATS: readonly string[] = ['jpg', 'png', 'webp']

/** 归一化格式名：去空白 / 前导点 / 小写，jpeg → jpg */
export function normalizeImageFormat(format?: string): string {
  if (typeof format !== 'string' || format.trim() === '') return ''
  const normalized = format.trim().toLowerCase().replace(/^\./, '')
  return normalized === 'jpeg' ? 'jpg' : normalized
}

/** MIME → 格式名；无法识别返回空串 */
export function mimeToFormat(mimeType: string): string {
  const normalized = (mimeType || '').trim().toLowerCase().split(';')[0]
  if (normalized === 'image/png') return 'png'
  if (normalized === 'image/webp') return 'webp'
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpg'
  return ''
}

/**
 * 决定保存策略：目标格式与渲染层产出一致时直写（零二次编码），否则转码
 *
 * @param sourceMimeType dataUrl 的 MIME（渲染层产出格式）
 * @param requestedFormat 调用方请求的目标格式（通常来自原文件扩展名）
 */
export function resolveSaveStrategy(
  sourceMimeType: string,
  requestedFormat?: string
): { sourceFormat: string; targetFormat: string; needsTranscode: boolean } {
  const sourceFormat = mimeToFormat(sourceMimeType)
  const targetFormat = normalizeImageFormat(requestedFormat) || sourceFormat
  const needsTranscode = targetFormat !== sourceFormat && TRANSCODE_FORMATS.includes(targetFormat)
  return { sourceFormat, targetFormat, needsTranscode }
}

/**
 * 获取无损/最高质量的转码参数；不支持的格式返回 null
 *
 * 注意：PNG 的 quality < 100 会让 sharp 启用调色板量化（有损），必须显式 `palette: false`。
 */
export function getLosslessEncodeOptions(
  format: string
): import('sharp').JpegOptions | import('sharp').PngOptions | import('sharp').WebpOptions | null {
  switch (normalizeImageFormat(format)) {
    case 'jpg':
      return {
        quality: LOSSLESS_JPEG_QUALITY,
        chromaSubsampling: '4:4:4',
        mozjpeg: true,
        progressive: true
      }
    case 'png':
      return { compressionLevel: 9, adaptiveFiltering: true, palette: false, quality: 100 }
    case 'webp':
      return { quality: 100, nearLossless: true, smartSubsample: true }
    default:
      return null
  }
}
