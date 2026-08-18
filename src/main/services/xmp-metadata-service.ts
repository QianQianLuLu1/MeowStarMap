/**
 * XMP 元数据写入/读取服务
 *
 * 职责：
 * - 构建自定义命名空间的 XMP packet（wxnn: 前缀）
 * - 将 EditorMetadata 序列化为 XMP XML，写入图片元数据
 * - 从图片 XMP 读取并反序列化为 EditorMetadata
 * - 支持单图与批量写入；批量写入不阻塞主流程
 *
 * 设计原则：
 * - 复用项目已有的 sharp 与 exifr，不新增重型依赖
 * - 绝不修改原图：所有写入操作均输出到新文件路径
 * - 自描述：XMP 同时保存人类可读字段（FilterName/LutName/ExportTimestamp）与完整 JSON
 * - 向前兼容：通过 schemaVersion 字段标识结构版本
 *
 * XMP 命名空间：xmlns:wxnn="http://wxnn.qianlu.com/xmp/1.0/"
 * 核心字段：
 * - wxnn:EditorData  —— base64 编码的 EditorMetadata JSON（完整自描述）
 * - wxnn:FilterName  —— 滤镜名（人类可读）
 * - wxnn:LutName     —— LUT 文件名（人类可读）
 * - wxnn:ExportTimestamp —— 导出时间（ISO 字符串）
 * - wxnn:AppVersion   —— 应用版本
 * - wxnn:SchemaVersion —— 元数据结构版本
 */
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import sharp from 'sharp'
import exifr from 'exifr'
import { app } from 'electron'
import { getUniqueFilePath } from '../utils/file-utils'
import { isImageExt } from '../utils/media-constants'
import {
  EDITOR_METADATA_SCHEMA_VERSION,
  type EditorMetadata
} from '../../shared/types/editor-metadata'
import { logger } from '../utils/logger'

// 自定义 XMP 命名空间 URI，写入与读取需保持一致
const WXNN_NS_URI = 'http://wxnn.qianlu.com/xmp/1.0/'
const WXNN_NS_PREFIX = 'wxnn'

// XMP packet 包装模板（标准 Adobe XMP 结构）
const XMP_PACKET_HEADER = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>`
const XMP_PACKET_FOOTER = `<?xpacket end="w"?>`

/**
 * 转义 XML 属性值中的特殊字符
 *
 * XMP 属性值必须转义 5 个字符：& < > " '
 * base64 编码的 EditorData 不含这些字符，但可读字段（FilterName 等）可能含中文/符号，仍需转义。
 */
function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * 构建 XMP packet XML 字符串
 *
 * 同时写入：
 * 1. 完整 JSON（base64 编码）到 wxnn:EditorData
 * 2. 人类可读字段到独立 XMP 属性
 *
 * @param metadata 编辑器元数据
 * @returns 完整的 XMP packet XML 字符串
 */
export function buildXmpPacket(metadata: EditorMetadata): string {
  // 完整 JSON 序列化后 base64 编码，避免 XML 转义问题
  const jsonData = JSON.stringify(metadata)
  const editorDataBase64 = Buffer.from(jsonData, 'utf-8').toString('base64')

  // 人类可读字段（便于其他工具直接读取，无需解析 JSON）
  const filterName = metadata.filter?.name ?? ''
  const lutName = metadata.params.lut ?? ''
  const filterCategory = metadata.filter?.category ?? ''

  return [
    XMP_PACKET_HEADER,
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    `    <rdf:Description xmlns:${WXNN_NS_PREFIX}="${WXNN_NS_URI}"`,
    `      ${WXNN_NS_PREFIX}:EditorData="${escapeXmlAttribute(editorDataBase64)}"`,
    `      ${WXNN_NS_PREFIX}:SchemaVersion="${metadata.schemaVersion}"`,
    `      ${WXNN_NS_PREFIX}:AppVersion="${escapeXmlAttribute(metadata.appVersion)}"`,
    `      ${WXNN_NS_PREFIX}:ExportTimestamp="${escapeXmlAttribute(metadata.exportTimestamp)}"`,
    `      ${WXNN_NS_PREFIX}:FilterName="${escapeXmlAttribute(filterName)}"`,
    `      ${WXNN_NS_PREFIX}:FilterCategory="${escapeXmlAttribute(filterCategory)}"`,
    `      ${WXNN_NS_PREFIX}:FilterIntensity="${metadata.filterIntensity}"`,
    `      ${WXNN_NS_PREFIX}:LutName="${escapeXmlAttribute(lutName)}"`,
    `      ${WXNN_NS_PREFIX}:HasWatermark="${metadata.watermark ? 'true' : 'false'}"`,
    '    />',
    '  </rdf:RDF>',
    '</x:xmpmeta>',
    XMP_PACKET_FOOTER
  ].join('\n')
}

/**
 * 从 XMP XML 字符串中解析 EditorMetadata
 *
 * 优先解析 wxnn:EditorData（base64 JSON），失败时回退到可读字段拼装（仅基本信息）。
 *
 * @param xmpString XMP XML 字符串
 * @returns 解析成功返回 EditorMetadata，无 XMP 或解析失败返回 null
 */
export function parseXmpPacket(xmpString: string): EditorMetadata | null {
  if (!xmpString || typeof xmpString !== 'string') return null

  // 提取 wxnn:EditorData 属性值（base64 编码的 JSON）
  const editorDataMatch = xmpString.match(new RegExp(`${WXNN_NS_PREFIX}:EditorData="([^"]*)"`))
  if (!editorDataMatch) return null

  try {
    const jsonData = Buffer.from(editorDataMatch[1], 'base64').toString('utf-8')
    const parsed = JSON.parse(jsonData) as EditorMetadata

    // 基本校验：必须包含 schemaVersion 与 params
    if (
      typeof parsed.schemaVersion !== 'number' ||
      typeof parsed.params !== 'object' ||
      parsed.params === null
    ) {
      logger.warn('[XmpMetadata] 解析成功但结构无效，schemaVersion 或 params 缺失')
      return null
    }

    // 当前版本兼容：schemaVersion <= 当前版本均接受
    if (parsed.schemaVersion > EDITOR_METADATA_SCHEMA_VERSION) {
      logger.warn(
        `[XmpMetadata] 元数据 schemaVersion ${parsed.schemaVersion} 高于当前支持的 ${EDITOR_METADATA_SCHEMA_VERSION}，可能存在兼容性问题`
      )
    }

    return parsed
  } catch (err) {
    logger.warn('[XmpMetadata] 解析 EditorData 失败:', err)
    return null
  }
}

/**
 * 写入元数据到图片文件（输出到新路径，绝不修改原图）
 *
 * 使用 sharp 读取源图 → withMetadata 设置 XMP → 输出到 targetPath
 * 支持 jpg/png/webp 格式转换。
 *
 * @param sourcePath 源图片绝对路径
 * @param targetPath 目标图片绝对路径
 * @param metadata 编辑器元数据
 * @param options 格式/质量选项
 * @returns 写入成功返回 true
 */
export async function writeMetadataToFile(
  sourcePath: string,
  targetPath: string,
  metadata: EditorMetadata,
  options: { format?: 'jpg' | 'jpeg' | 'png' | 'webp'; quality?: number } = {}
): Promise<boolean> {
  const ext = path.extname(sourcePath).toLowerCase()
  if (!isImageExt(ext)) {
    throw new Error(`不支持的图片格式: ${ext}`)
  }

  const xmpPacket = buildXmpPacket(metadata)
  const xmpBuffer = Buffer.from(xmpPacket, 'utf-8')

  // 格式优先级：options.format > 源文件扩展名
  const format = options.format ?? (ext.replace('.', '') as 'jpg' | 'jpeg' | 'png' | 'webp')
  const quality = options.quality ?? 92

  // sharp 0.35 的 WriteableMetadata 类型声明未包含 xmp 字段，但运行时已支持
  // 用扩展类型 + 变量声明绕过 excess property check
  type WriteableMetadataWithXmp = import('sharp').WriteableMetadata & { xmp?: Buffer }
  const metadataOptions: WriteableMetadataWithXmp = { xmp: xmpBuffer }
  let pipeline = sharp(sourcePath).withMetadata(metadataOptions)

  if (format === 'jpg' || format === 'jpeg') {
    pipeline = pipeline.jpeg({ quality, progressive: true, mozjpeg: true })
  } else if (format === 'png') {
    pipeline = pipeline.png({ quality: Math.min(quality, 100), progressive: true })
  } else if (format === 'webp') {
    pipeline = pipeline.webp({ quality })
  } else {
    throw new Error(`不支持的输出格式: ${format}`)
  }

  await pipeline.toFile(targetPath)
  return true
}

/**
 * 从图片文件读取 XMP 元数据
 *
 * 使用 exifr 解析 XMP 段，提取 wxnn:EditorData 字段。
 *
 * @param filePath 图片绝对路径
 * @returns 解析成功返回 EditorMetadata，无数据或失败返回 null
 */
export async function readMetadataFromFile(filePath: string): Promise<EditorMetadata | null> {
  const ext = path.extname(filePath).toLowerCase()
  if (!isImageExt(ext)) {
    return null
  }

  try {
    // exifr xmp 模式：仅解析 XMP 段，输出原始字符串与解析后对象
    // exifr v7 的 ifd0 类型仅接受 FormatOptions 对象（注释明确 cannot be disabled）
    // 故不传 ifd0 字段；其余禁用项保持 false
    const result = (await exifr.parse(filePath, {
      xmp: true,
      iptc: false,
      exif: false,
      jfif: false,
      ihdr: false,
      icc: false,
      tiff: false
    })) as Record<string, unknown> | null

    if (!result) return null

    // exifr 会将自定义命名空间属性挂在 _xmp 属性下，或直接平铺
    // 兼容两种访问方式
    const xmpRoot = (result._xmp as Record<string, unknown> | undefined) ?? result
    const editorData = xmpRoot[`${WXNN_NS_PREFIX}:EditorData`] as string | undefined

    if (!editorData) {
      // 部分图片可能将 XMP 作为整段字符串返回
      const rawObj = result._raw as { xmp?: string } | undefined
      const rawXmp = (result.xmp as string | undefined) ?? rawObj?.xmp
      if (rawXmp) {
        return parseXmpPacket(rawXmp)
      }
      return null
    }

    // editorData 是 base64 编码的 JSON
    try {
      const jsonData = Buffer.from(editorData, 'base64').toString('utf-8')
      const parsed = JSON.parse(jsonData) as EditorMetadata
      if (
        typeof parsed.schemaVersion !== 'number' ||
        typeof parsed.params !== 'object' ||
        parsed.params === null
      ) {
        logger.warn('[XmpMetadata] 读取成功但结构无效')
        return null
      }
      return parsed
    } catch (err) {
      logger.warn('[XmpMetadata] 反序列化 EditorData 失败:', err)
      return null
    }
  } catch (err) {
    // exifr 在无 XMP 段时不抛错而是返回 null，此处仅记录真实异常
    logger.warn('[XmpMetadata] 读取图片 XMP 失败:', err)
    return null
  }
}

/**
 * 批量写入元数据
 *
 * 逐张处理，单张失败不影响其他文件。返回成功/失败明细。
 *
 * @param items 批量写入任务列表
 * @param options 共享格式/质量选项
 * @returns 处理结果（成功路径列表 + 失败明细）
 */
export async function batchWriteMetadata(
  items: Array<{
    sourcePath: string
    metadata: EditorMetadata
    targetFileName?: string
  }>,
  targetDir: string,
  options: { format?: 'jpg' | 'jpeg' | 'png' | 'webp'; quality?: number } = {}
): Promise<{
  successCount: number
  failedCount: number
  outputPaths: string[]
  failures: Array<{ sourcePath: string; error: string }>
}> {
  await fsp.mkdir(targetDir, { recursive: true })

  const outputPaths: string[] = []
  const failures: Array<{ sourcePath: string; error: string }> = []
  let successCount = 0
  let failedCount = 0

  for (const item of items) {
    try {
      const ext = path.extname(item.sourcePath).toLowerCase()
      const baseName = path.basename(item.sourcePath, ext)
      const format = options.format ?? (ext.replace('.', '') as 'jpg' | 'jpeg' | 'png' | 'webp')
      const targetExt = format === 'jpeg' ? '.jpg' : `.${format}`
      const finalBaseName = item.targetFileName ?? `${baseName}_编辑`
      const targetPath = await getUniqueFilePath(targetDir, finalBaseName, targetExt)

      await writeMetadataToFile(item.sourcePath, targetPath, item.metadata, options)

      outputPaths.push(targetPath)
      successCount++
    } catch (err) {
      failedCount++
      const errorMsg = err instanceof Error ? err.message : String(err)
      failures.push({ sourcePath: item.sourcePath, error: errorMsg })
      logger.warn(`[XmpMetadata] 批量写入失败: ${item.sourcePath}`, err)
    }
  }

  return { successCount, failedCount, outputPaths, failures }
}

/**
 * 获取当前应用版本（写入元数据时使用）
 *
 * 在 app.ready 之前调用时返回 '0.0.0' 兜底。
 */
export function getAppVersion(): string {
  try {
    return app.getVersion()
  } catch {
    return '0.0.0'
  }
}

/**
 * 同步检查文件是否存在（用于 writeMetadataToFile 前置校验，避免 sharp 抛出晦涩错误）
 */
export function ensureFileExists(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(`源文件不存在: ${filePath}`)
  }
}
