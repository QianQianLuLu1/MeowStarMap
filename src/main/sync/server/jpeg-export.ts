/**
 * 无损 JPEG 导出（export 扩展端点的像素无关派生，sync-integration 阶段 6）。
 *
 * 移植自 NikkiSync 上游 tools/wechat-gallery/photo-export.mjs（MIT，upstream 284d4a6）
 * 的 exportJpeg/exportMetadata —— 逐行为保持字节级语义一致（客户端按
 * X-NikkiSync-SHA256 校验导出字节并断言 Make/Model/Software 等 EXIF 字段）：
 * - 永不解码/重压缩像素：只在 JPEG 段结构上重写 APP1/Exif TIFF（orientation
 *   旋转改写 + 游戏参数 EXIF 注入），原扫描数据与未涉及段原样保留
 * - exportMetadata 只挑协议元数据中的白名单字段（camera 数值、identity.gameVersion、
 *   capture.capturedAt、filter/lighting/location.name、dressing.clothes[].name），
 *   raw 等其余字段（含 nativeParam* 敏感键）绝不进入导出文件
 * - 未移植 liveJpeg/contentIdentifier 分支：WXNN v1 不提供 Live Photo 打包
 */

const MAX = 16_777_216
const EXIF_HEADER = Buffer.from('Exif\0\0')

const CAMERA_KEYS = [
  'focalLength',
  'apertureSection',
  'exposure',
  'brightness',
  'contrast',
  'saturation',
  'vibrance',
  'highlights',
  'shadows',
  'vignetteIntensity',
  'bloomIntensity',
  'bloomThreshold'
] as const

const ORIENTATION_CLOCKWISE: Record<number, number> = {
  1: 6,
  6: 3,
  3: 8,
  8: 1,
  2: 7,
  7: 4,
  4: 5,
  5: 2
}

/** TYPE 尺寸表（Exif TIFF field type → 字节数） */
const TYPE_WIDTH: Record<number, number> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  6: 1,
  7: 1,
  8: 2,
  9: 4,
  10: 8,
  11: 4,
  12: 8,
  13: 4
}

function clean(value: unknown): string {
  if (typeof value !== 'string') return ''
  return (
    value
      // eslint-disable-next-line no-control-regex -- 目标就是控制字符：剥离 EXIF 字符串中的 C0 控制符与 DEL
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim()
      .slice(0, 120)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 协议元数据 → 导出 EXIF 白名单字段（上游 exportMetadata 逐行等价） */
export function exportExportMetadata(metadata: unknown): Record<string, unknown> {
  const camera: Record<string, number> = {}
  if (isRecord(metadata)) {
    const cameraSource = isRecord(metadata.camera) ? metadata.camera : {}
    for (const key of CAMERA_KEYS) {
      const value = cameraSource[key]
      if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100_000) {
        camera[key] = value
      }
    }
  }
  const result: Record<string, unknown> = { camera }
  const identity = isRecord(metadata) && isRecord(metadata.identity) ? metadata.identity : undefined
  const version = clean(identity?.gameVersion)
  if (/^\d{1,3}(\.\d{1,3}){1,2}$/.test(version)) result.version = version
  const capture = isRecord(metadata) && isRecord(metadata.capture) ? metadata.capture : undefined
  const capturedAt = capture?.capturedAt
  if (
    typeof capturedAt === 'string' &&
    /^\d{4}-\d\d-\d\dT/.test(capturedAt) &&
    Number.isFinite(Date.parse(capturedAt))
  ) {
    result.capturedAt = new Date(capturedAt).toISOString()
  }
  if (isRecord(metadata)) {
    for (const key of ['filter', 'lighting', 'location'] as const) {
      const section = metadata[key]
      const name = clean(isRecord(section) ? section.name : undefined)
      if (name) result[key] = name
    }
  }
  const dressing = isRecord(metadata) ? metadata.dressing : undefined
  const clothes = isRecord(dressing) && Array.isArray(dressing.clothes) ? dressing.clothes : []
  result.clothes = (clothes as unknown[])
    .slice(0, 100)
    .map((item) => clean(isRecord(item) ? item.name : undefined))
    .filter(Boolean)
  return result
}

interface JpegSegment {
  start: number
  end: number
  marker: number
  data: Buffer
}

/** 解析 JPEG 段结构（到 SOS 为止），校验 SOI/标记/长度 */
function layout(input: Uint8Array): { bytes: Buffer; segments: JpegSegment[]; sos: number } {
  if (!(input instanceof Uint8Array) || input.length < 4 || input.length > MAX) {
    throw new Error('JPEG export size')
  }
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (bytes[0] !== 255 || bytes[1] !== 216) throw new Error('JPEG required')
  const segments: JpegSegment[] = []
  let offset = 2
  let sos = -1
  while (offset < bytes.length) {
    const start = offset
    if (bytes[offset++] !== 255) throw new Error('JPEG marker')
    while (bytes[offset] === 255) offset++
    const marker = bytes[offset++]
    if (
      !marker ||
      marker === 0xd8 ||
      marker === 0xd9 ||
      marker === 1 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      throw new Error('JPEG header')
    }
    if (offset + 2 > bytes.length) throw new Error('JPEG truncated')
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) throw new Error('JPEG length')
    if (marker === 0xda) {
      sos = start
      break
    }
    segments.push({
      start,
      end: offset + length,
      marker,
      data: bytes.subarray(offset + 2, offset + length)
    })
    offset += length
  }
  if (sos < 0 || bytes.indexOf(Buffer.from([255, 217]), sos) < 0)
    throw new Error('JPEG scan missing')
  return { bytes, segments, sos }
}

interface TiffIfd {
  entries: Map<number, Buffer>
  next: number
}

interface TiffState {
  le: boolean
  root: TiffIfd
  exif: TiffIfd
  orientation: number
}

/** 读取 EXIF TIFF（IFD0 + Exif IFD + orientation），校验字节序/魔数/条目边界 */
function tiffReader(tiff: Buffer): TiffState {
  if (tiff.length < 8 || !['II', 'MM'].includes(tiff.toString('ascii', 0, 2))) {
    throw new Error('Invalid Exif')
  }
  const le = tiff[0] === 73
  const u16 = (p: number): number => {
    if (p < 0 || p + 2 > tiff.length) throw new Error('Exif offset')
    return le ? tiff.readUInt16LE(p) : tiff.readUInt16BE(p)
  }
  const u32 = (p: number): number => {
    if (p < 0 || p + 4 > tiff.length) throw new Error('Exif offset')
    return le ? tiff.readUInt32LE(p) : tiff.readUInt32BE(p)
  }
  if (u16(2) !== 42) throw new Error('Exif magic')
  function ifd(p: number): TiffIfd {
    if (p < 8) throw new Error('Exif IFD')
    const count = u16(p)
    if (count > 1024 || p + 2 + count * 12 + 4 > tiff.length) throw new Error('Exif count')
    const entries = new Map<number, Buffer>()
    for (let n = 0; n < count; n++) {
      const e = p + 2 + n * 12
      const tag = u16(e)
      const type = u16(e + 2)
      const number = u32(e + 4)
      const width = TYPE_WIDTH[type]
      if (!width || number > 65535) throw new Error('Exif type')
      const size = number * width
      if (size > 4 && u32(e + 8) + size > tiff.length) throw new Error('Exif value')
      if (entries.has(tag)) throw new Error('Duplicate Exif tag')
      entries.set(tag, Buffer.from(tiff.subarray(e, e + 12)))
    }
    return { entries, next: u32(p + 2 + count * 12) }
  }
  const root = ifd(u32(4))
  const exifEntry = root.entries.get(0x8769)
  const exif = exifEntry
    ? ifd(le ? exifEntry.readUInt32LE(8) : exifEntry.readUInt32BE(8))
    : { entries: new Map<number, Buffer>(), next: 0 }
  const orientationEntry = root.entries.get(0x112)
  let orientation = 1
  if (orientationEntry) {
    const type = le ? orientationEntry.readUInt16LE(2) : orientationEntry.readUInt16BE(2)
    const count = le ? orientationEntry.readUInt32LE(4) : orientationEntry.readUInt32BE(4)
    if (type !== 3 || count !== 1) throw new Error('Exif orientation')
    orientation = le ? orientationEntry.readUInt16LE(8) : orientationEntry.readUInt16BE(8)
    if (orientation < 1 || orientation > 8) throw new Error('Exif orientation')
  }
  return { le, root, exif, orientation }
}

export interface ExportJpegOptions {
  exif?: boolean
  rotation?: 0 | 90 | 180 | 270
}

/**
 * 无损导出：重写 orientation（顺时针 rotation 换算）并在 exif=true 时注入
 * Make 'Momo Camera' / Model 'Infinity Nikki' / Software 'NikkiSync' + 游戏参数
 * description + 拍摄时间。无 EXIF 且无旋转且无 contentIdentifier 时原样返回。
 */
export function exportJpeg(
  input: Uint8Array,
  metadata: unknown,
  options: ExportJpegOptions = {}
): Buffer {
  const exif = options.exif ?? true
  const rotation = options.rotation ?? 0
  if (typeof exif !== 'boolean' || ![0, 90, 180, 270].includes(rotation)) {
    throw new Error('Export options')
  }
  const { bytes, segments } = layout(input)
  if (!exif && !rotation) return Buffer.from(bytes)
  const existing = segments.filter(
    (x) => x.marker === 0xe1 && x.data.subarray(0, 6).equals(EXIF_HEADER)
  )
  if (existing.length > 1) throw new Error('Multiple Exif blocks')
  const original =
    existing[0]?.data.subarray(6) ?? Buffer.from([73, 73, 42, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  const state = tiffReader(original)
  const chunks: Buffer[] = [Buffer.from(original)]
  let position = original.length
  const put = (buffer: Buffer): number => {
    if (position % 2) {
      chunks.push(Buffer.alloc(1))
      position++
    }
    const offset = position
    chunks.push(buffer)
    position += buffer.length
    return offset
  }
  const u16 = (b: Buffer, v: number, p: number): void => {
    if (state.le) b.writeUInt16LE(v, p)
    else b.writeUInt16BE(v, p)
  }
  const u32 = (b: Buffer, v: number, p: number): void => {
    if (state.le) b.writeUInt32LE(v, p)
    else b.writeUInt32BE(v, p)
  }
  function tag(
    entries: Map<number, Buffer>,
    id: number,
    type: number,
    data: Buffer,
    count: number
  ): void {
    const entry = Buffer.alloc(12)
    u16(entry, id, 0)
    u16(entry, type, 2)
    u32(entry, count, 4)
    if (data.length <= 4) data.copy(entry, 8)
    else u32(entry, put(data), 8)
    entries.set(id, entry)
  }
  function short(entries: Map<number, Buffer>, id: number, value: number): void {
    const b = Buffer.alloc(2)
    u16(b, value, 0)
    tag(entries, id, 3, b, 1)
  }
  function ascii(entries: Map<number, Buffer>, id: number, value: string): void {
    const b = Buffer.from(value + '\0', 'ascii')
    tag(entries, id, 2, b, b.length)
  }
  function rational(entries: Map<number, Buffer>, id: number, value: number): void {
    if (!(value > 0 && value <= 10000)) return
    const numerator = Math.round(value * 10000)
    const b = Buffer.alloc(8)
    u32(b, numerator, 0)
    u32(b, 10000, 4)
    tag(entries, id, 5, b, 1)
  }
  function writeIfd(value: TiffIfd): number {
    const entries = Array.from(value.entries)
      .sort((a, b) => a[0] - b[0])
      .map((x) => x[1])
    const b = Buffer.alloc(2 + entries.length * 12 + 4)
    u16(b, entries.length, 0)
    entries.forEach((e, n) => e.copy(b, 2 + n * 12))
    u32(b, value.next, 2 + entries.length * 12)
    return put(b)
  }

  let orientation: number = state.orientation
  for (let n = 0; n < rotation / 90; n++)
    orientation = ORIENTATION_CLOCKWISE[orientation] ?? orientation
  short(state.root.entries, 0x112, orientation)

  if (exif) {
    const normalized = exportExportMetadata(metadata)
    const camera = isRecord(normalized.camera) ? (normalized.camera as Record<string, number>) : {}
    ascii(state.root.entries, 0x10f, 'Momo Camera')
    ascii(state.root.entries, 0x110, 'Infinity Nikki')
    ascii(state.root.entries, 0x131, 'NikkiSync')
    // 虚拟相机 f-number / focal（游戏参数，非硬件光学或 35mm 等效推断）
    rational(state.exif.entries, 0x829d, camera.apertureSection)
    rational(state.exif.entries, 0x920a, camera.focalLength)
    const description =
      'Infinity Nikki virtual photography; game parameters: ' +
      JSON.stringify(normalized).replace(
        /[^\x20-\x7e]/g,
        (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
      )
    // 12000 码元截断可能把末尾 \uXXXX 转义切成一半（产生畸形转义），剥离残缺片段
    ascii(state.root.entries, 0x10e, description.slice(0, 12000).replace(/\\u[0-9a-f]{0,3}$/, ''))
    if (typeof normalized.capturedAt === 'string') {
      const time = normalized.capturedAt.slice(0, 19).replace(/-/g, ':').replace('T', ' ')
      ascii(state.exif.entries, 0x9003, time)
      ascii(state.exif.entries, 0x9011, '+00:00')
    }
  }

  if (state.exif.entries.size) {
    const offset = writeIfd(state.exif)
    const b = Buffer.alloc(4)
    u32(b, offset, 0)
    tag(state.root.entries, 0x8769, 4, b, 1)
  }
  const root = writeIfd(state.root)
  const tiff = Buffer.concat(chunks)
  u32(tiff, root, 4)
  if (tiff.length + 8 > 65535) throw new Error('Exif segment too large')
  const app1 = Buffer.alloc(tiff.length + 10)
  app1[0] = 255
  app1[1] = 0xe1
  app1.writeUInt16BE(tiff.length + 8, 2)
  EXIF_HEADER.copy(app1, 4)
  tiff.copy(app1, 10)
  // 原 TIFF 内部相对偏移不受影响：未改写的原 TIFF 数据保持在相同相对位置
  const pieces: Buffer[] = [bytes.subarray(0, 2), app1]
  let previous = 2
  for (const old of existing) {
    pieces.push(bytes.subarray(previous, old.start))
    previous = old.end
  }
  pieces.push(bytes.subarray(previous))
  const output = Buffer.concat(pieces)
  if (output.length > MAX) {
    output.fill(0)
    throw new Error('Export size limit')
  }
  return output
}
