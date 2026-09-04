/**
 * 导入文件解析（本地不可信输入的结构守卫 + 逐记录校验 + 差异计数）。
 *
 * 数据模型与合并语义复用自 gongeo.us-nikki-tracker（MIT, dastrokes）的
 * processJsonImport / trackerDataMerge；逐记录校验与定位为本仓库新增逻辑。
 *
 * 设计：
 * - 顶层结构用 zod 宽松壳校验（结构非法 → 抛 ImportStructureError）；
 * - 逐记录字段校验循环执行（坏记录计数并采样定位，不整体拒绝）；
 * - 时间统一规范化为 "YYYY-MM-DD HH:mm:ss"（缺秒补 :00），保证幂等键稳定；
 * - 全程零副作用：解析与计数不写库，落库由主进程 importCommit 负责。
 */
import {
  MAX_TOTAL_IMPORT_RECORDS,
  resonanceImportFileSchema
} from '../../../shared/types/resonance'
import type {
  ResonanceEditRow,
  ResonanceEvoRow,
  ResonancePearpalRow,
  ResonancePullRow
} from '../../../shared/types/resonance'
import { normalizeWardrobeData, type WardrobeData } from './wardrobe'
import type { EditRecord, EvoRecord, PearpalTrackerItem, PullRecord } from './types'

export type ResonanceImportFileFormat = 'legacy' | 'current'

export interface ImportInvalidRecord {
  /** 定位描述，如 "卡池 2 / 第 3 条" */
  location: string
  /** 机读原因码，配合 i18n 文案使用 */
  reason: string
}

export interface ParsedImportData {
  format: ResonanceImportFileFormat
  version: number | null
  /** 文件声明版本高于当前支持版本（需用户确认后 force 导入） */
  versionMismatch: boolean
  pulls: Record<number, PullRecord[]>
  edits: Record<number, EditRecord[]>
  evo: Record<number, EvoRecord[]>
  pearpal: Record<number, PearpalTrackerItem[]>
  wardrobe: WardrobeData | null
  invalid: ImportInvalidRecord[]
  /** 无效记录总数（invalid 仅是前若干条采样） */
  invalidCount: number
  /** 规范化后的有效记录总数 */
  totalValidRecords: number
}

/** 顶层结构失败：携带机读原因，由调用方映射 i18n 文案 */
export class ImportStructureError extends Error {
  readonly reason: string
  constructor(reason: string, message: string) {
    super(message)
    this.name = 'ImportStructureError'
    this.reason = reason
  }
}

const TS_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/
const ITEM_ID_PATTERN = /^\d{5,12}$/
const OUTFIT_ID_PATTERN = /^\d{5}$/

/** 时间规范化：缺秒补 :00；非法返回 null */
export function normalizeImportTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (!TS_PATTERN.test(value)) return null
  return value.length === 16 ? `${value}:00` : value
}

const isValidItemId = (value: unknown): value is string =>
  typeof value === 'string' && ITEM_ID_PATTERN.test(value)

const isValidOutfitId = (value: unknown): value is string =>
  typeof value === 'string' && OUTFIT_ID_PATTERN.test(value)

const MAX_INVALID_SAMPLES = 5

function pushInvalid(list: ImportInvalidRecord[], location: string, reason: string): void {
  if (list.length < MAX_INVALID_SAMPLES) {
    list.push({ location, reason })
  }
}

function isValidPearpalItem(value: unknown): value is PearpalTrackerItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.card_pool_id === 'string' &&
    typeof v.pool_cnt === 'number' &&
    Number.isInteger(v.pool_cnt) &&
    v.pool_cnt >= 0 &&
    isValidItemId(v.result) &&
    typeof v.times_from_last_five_stars === 'number' &&
    Number.isInteger(v.times_from_last_five_stars) &&
    v.times_from_last_five_stars >= 0 &&
    typeof v.times_from_last_four_stars === 'number' &&
    Number.isInteger(v.times_from_last_four_stars) &&
    v.times_from_last_four_stars >= 0 &&
    typeof v.rarity === 'string' &&
    /^\d+$/.test(v.rarity)
  )
}

function parsePullRecords(
  bannerId: number,
  rawList: unknown[],
  invalid: ImportInvalidRecord[]
): PullRecord[] {
  const valid: PullRecord[] = []
  rawList.forEach((entry, index) => {
    const location = `卡池 ${bannerId} / 第 ${index + 1} 条`
    if (!Array.isArray(entry) || entry.length !== 2) {
      pushInvalid(invalid, location, 'invalidShape')
      return
    }
    const ts = normalizeImportTimestamp(entry[0])
    if (!ts) {
      pushInvalid(invalid, location, 'invalidTimestamp')
      return
    }
    if (!isValidItemId(entry[1])) {
      pushInvalid(invalid, location, 'invalidItemId')
      return
    }
    valid.push([ts, entry[1]])
  })
  return valid
}

function parseEvoRecords(
  bannerId: number,
  rawList: unknown[],
  invalid: ImportInvalidRecord[]
): EvoRecord[] {
  const valid: EvoRecord[] = []
  rawList.forEach((entry, index) => {
    const location = `卡池 ${bannerId} / 进化第 ${index + 1} 条`
    if (!Array.isArray(entry) || entry.length !== 2) {
      pushInvalid(invalid, location, 'invalidShape')
      return
    }
    if (!isValidOutfitId(entry[0])) {
      pushInvalid(invalid, location, 'invalidOutfitId')
      return
    }
    if (
      typeof entry[1] !== 'number' ||
      !Number.isInteger(entry[1]) ||
      entry[1] < 0 ||
      entry[1] > 4
    ) {
      pushInvalid(invalid, location, 'invalidEvoLevel')
      return
    }
    valid.push([entry[0], entry[1]])
  })
  return valid
}

/**
 * 解析导入文件文本。结构非法抛 ImportStructureError；
 * 记录级错误计入 invalid 并采样定位。
 */
export function parseImportFileText(text: string): ParsedImportData {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new ImportStructureError('jsonParseFailed', 'resonance.error.importJsonParseFailed')
  }

  const shell = resonanceImportFileSchema.safeParse(json)
  if (!shell.success) {
    throw new ImportStructureError('invalidStructure', 'resonance.error.importInvalidStructure')
  }
  const raw = shell.data

  // 形态识别：current 格式带 pulls/edits/evo/pearpal/wardrobe 段
  const isCurrent =
    typeof raw === 'object' &&
    raw !== null &&
    !Array.isArray(raw) &&
    ('pulls' in raw || 'edits' in raw || 'evo' in raw || 'pearpal' in raw || 'wardrobe' in raw)

  const invalid: ImportInvalidRecord[] = []
  const pulls: Record<number, PullRecord[]> = {}
  const edits: Record<number, EditRecord[]> = {}
  const evo: Record<number, EvoRecord[]> = {}
  const pearpal: Record<number, PearpalTrackerItem[]> = {}
  let version: number | null = null
  let wardrobe: WardrobeData | null = null
  let rawTotal = 0

  const collectPulls = (source: Record<string, unknown[]>): void => {
    for (const [bannerIdStr, rawList] of Object.entries(source)) {
      const bannerId = Number(bannerIdStr)
      rawTotal += rawList.length
      const valid = parsePullRecords(bannerId, rawList, invalid)
      if (valid.length > 0) {
        pulls[bannerId] = [...(pulls[bannerId] ?? []), ...valid]
      }
    }
  }

  if (isCurrent) {
    const obj = raw as {
      version?: number
      pulls?: Record<string, unknown[]>
      edits?: Record<string, unknown[]>
      evo?: Record<string, unknown[]>
      pearpal?: Record<string, unknown[]>
      wardrobe?: unknown
    }
    version = obj.version ?? null
    if (obj.pulls) collectPulls(obj.pulls)
    if (obj.edits) {
      for (const [bannerIdStr, rawList] of Object.entries(obj.edits)) {
        const bannerId = Number(bannerIdStr)
        rawTotal += rawList.length
        const valid = parsePullRecords(bannerId, rawList, invalid)
        if (valid.length > 0) edits[bannerId] = valid
      }
    }
    if (obj.evo) {
      for (const [bannerIdStr, rawList] of Object.entries(obj.evo)) {
        const bannerId = Number(bannerIdStr)
        rawTotal += rawList.length
        const valid = parseEvoRecords(bannerId, rawList, invalid)
        if (valid.length > 0) evo[bannerId] = valid
      }
    }
    if (obj.pearpal) {
      for (const [bannerIdStr, rawList] of Object.entries(obj.pearpal)) {
        const bannerId = Number(bannerIdStr)
        rawTotal += rawList.length
        const valid: PearpalTrackerItem[] = []
        rawList.forEach((entry, index) => {
          if (isValidPearpalItem(entry)) {
            valid.push(entry)
          } else {
            pushInvalid(
              invalid,
              `卡池 ${bannerId} / Pearpal 第 ${index + 1} 条`,
              'invalidPearpalItem'
            )
          }
        })
        if (valid.length > 0) pearpal[bannerId] = valid
      }
    }
    if (obj.wardrobe !== undefined) {
      const normalized = normalizeWardrobeData(obj.wardrobe)
      wardrobe = normalized
    }
  } else {
    // 旧格式：Record<bannerId, PullRecord[]>
    collectPulls(raw as Record<string, unknown[]>)
  }

  const totalValidRecords =
    Object.values(pulls).reduce((acc, l) => acc + l.length, 0) +
    Object.values(edits).reduce((acc, l) => acc + l.length, 0) +
    Object.values(evo).reduce((acc, l) => acc + l.length, 0) +
    Object.values(pearpal).reduce((acc, l) => acc + l.length, 0)

  if (totalValidRecords > MAX_TOTAL_IMPORT_RECORDS) {
    throw new ImportStructureError('tooManyRecords', 'resonance.error.importTooManyRecords')
  }

  // 无效总数 = 原始记录数 − 有效记录数（invalid 数组仅保留前 N 条采样定位）
  const invalidCount = Math.max(rawTotal - totalValidRecords, 0)

  const CURRENT_SUPPORTED_VERSION = 1

  return {
    format: isCurrent ? 'current' : 'legacy',
    version,
    versionMismatch: version !== null && version > CURRENT_SUPPORTED_VERSION,
    pulls,
    edits,
    evo,
    pearpal,
    wardrobe,
    invalid,
    invalidCount,
    totalValidRecords
  }
}

/** 与库内既有记录比对幂等键，得到 新增/重复 计数（预览用，零写入） */
export function countImportDiff(
  parsed: ParsedImportData,
  existing: {
    pulls: Pick<ResonancePullRow, 'banner_id' | 'obtained_at' | 'item_id'>[]
    edits: Pick<ResonanceEditRow, 'banner_id' | 'item_id'>[]
    pearpal: Pick<ResonancePearpalRow, 'banner_id' | 'item_id' | 'pool_cnt'>[]
    evo: Pick<ResonanceEvoRow, 'banner_id' | 'outfit_id'>[]
  }
): { added: number; duplicate: number } {
  let added = 0
  let duplicate = 0

  const pullKeys = new Set(
    existing.pulls.map((r) => `${r.banner_id}|${r.obtained_at}|${r.item_id}`)
  )
  for (const [bannerIdStr, records] of Object.entries(parsed.pulls)) {
    for (const [ts, itemId] of records) {
      if (pullKeys.has(`${bannerIdStr}|${ts}|${itemId}`)) duplicate++
      else added++
    }
  }

  const editKeys = new Set(existing.edits.map((r) => `${r.banner_id}|${r.item_id}`))
  for (const [bannerIdStr, records] of Object.entries(parsed.edits)) {
    for (const [, itemId] of records) {
      if (editKeys.has(`${bannerIdStr}|${itemId}`)) duplicate++
      else added++
    }
  }

  const pearpalKeys = new Set(
    existing.pearpal.map((r) => `${r.banner_id}|${r.item_id}|${r.pool_cnt}`)
  )
  for (const [bannerIdStr, records] of Object.entries(parsed.pearpal)) {
    for (const item of records) {
      if (pearpalKeys.has(`${bannerIdStr}|${item.result}|${item.pool_cnt}`)) duplicate++
      else added++
    }
  }

  const evoKeys = new Set(existing.evo.map((r) => `${r.banner_id}|${r.outfit_id}`))
  for (const [bannerIdStr, records] of Object.entries(parsed.evo)) {
    for (const [outfitId] of records) {
      if (evoKeys.has(`${bannerIdStr}|${outfitId}`)) duplicate++
      else added++
    }
  }

  return { added, duplicate }
}
