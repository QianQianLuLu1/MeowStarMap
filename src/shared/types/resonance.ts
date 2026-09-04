/**
 * 共鸣录板块共享类型与 zod schema。
 *
 * 数据模型逻辑复用自开源项目 gongeo.us-nikki-tracker（dastrokes，MIT License）
 * 的 shared/types/{pull,banner,wardrobe,api}.ts，持久化语义映射为宿主 SQLite 行。
 * 本文件同时被主进程（IPC 入口校验）与渲染层（UI 轻量二次校验）引用。
 */
import { z } from 'zod'

// ============ 原始记录形态（与源项目导出格式同构） ============

/** 抽卡记录原始二元组：[获得时间, 物品 id]，时间格式 "YYYY-MM-DD HH:mm(:ss)?" */
export type PullRecord = [string, string]
/** 手动补录二元组，与 PullRecord 同构 */
export type EditRecord = [string, string]
/** 进化覆盖记录：[套装 id, 等级 0-4] */
export type EvoRecord = [string, number]
/** Pearpal 手账单条记录（仅承接本地文件导入，不联网获取） */
export interface PearpalTrackerItem {
  card_pool_id: string
  pool_cnt: number
  result: string
  times_from_last_five_stars: number
  times_from_last_four_stars: number
  rarity: string
}

// ============ SQLite 行（主进程 ↔ 渲染层 DTO） ============

export type ResonancePullSource = 'json' | 'manual-import'

export interface ResonancePullRow {
  id: number
  banner_id: string
  item_id: string
  obtained_at: string
  source: ResonancePullSource
  created_at: string
}

export interface ResonanceEditRow {
  id: number
  banner_id: string
  item_id: string
  obtained_at: string
  created_at: string
}

export interface ResonancePearpalRow {
  banner_id: string
  item_id: string
  pool_cnt: number
  obtained_at: string
  /** 原始 PearpalTrackerItem（含 times_from_last_* / rarity），保证导出 round-trip 保真 */
  raw: PearpalTrackerItem
}

export interface ResonanceEvoRow {
  banner_id: string
  outfit_id: string
  level: number
  updated_at: string
}

export type ResonanceWardrobeCategory = 'item' | 'makeup' | 'momo' | 'prop' | 'eureka_color'

export interface ResonanceWardrobeEntry {
  category: ResonanceWardrobeCategory
  itemId: number
  updatedAt: string
}

/** 衣橱数据（导出文件同构形态，与源 WardrobeData 一致） */
export interface ResonanceWardrobeData {
  version: 1
  ownedItemIds: number[]
  ownedMakeupIds: number[]
  ownedMomoIds: number[]
  ownedPropIds: number[]
  ownedEurekaColorIds: number[]
  updatedAt: string
}

export interface ResonanceGetDataResult {
  pulls: ResonancePullRow[]
  edits: ResonanceEditRow[]
  pearpal: ResonancePearpalRow[]
  evo: ResonanceEvoRow[]
  wardrobe: ResonanceWardrobeData
}

// ============ 导入 / 导出 ============

export type ResonanceImportFileFormat = 'legacy' | 'current'

/** 导入预览结果（零写入；counts 基于与库内既有记录的幂等键比对） */
export interface ResonanceImportPreview {
  format: ResonanceImportFileFormat
  /** 文件内声明的 schema 版本；源站文件无版本字段时为 null */
  version: number | null
  /** 声明版本高于当前支持版本 → UI 给「兼容导入/放弃」选择 */
  versionMismatch: boolean
  totalRecords: number
  counts: { added: number; duplicate: number; invalid: number }
  /** 前几条无效记录的位置描述（用于错误定位，最多 5 条） */
  invalidSamples: string[]
  sections: {
    pulls: boolean
    edits: boolean
    pearpal: boolean
    evo: boolean
    wardrobe: boolean
  }
  wardrobe: ResonanceWardrobeData | null
}

export interface ResonanceImportOptions {
  includeWardrobe: boolean
}

export interface ResonanceImportCommitResult {
  imported: number
  wardrobeApplied: boolean
}

export interface ResonanceExportOptions {
  filePath: string
  includePulls: boolean
  includeEdits: boolean
  includePearpal: boolean
  includeEvo: boolean
  includeWardrobe: boolean
}

export interface ResonanceExportResult {
  path: string
  recordCount: number
}

export interface ResonanceWardrobeUpdateInput {
  adds: Array<{ category: ResonanceWardrobeCategory; itemId: number }>
  removes: Array<{ category: ResonanceWardrobeCategory; itemId: number }>
}

export interface ResonanceWardrobeUpdateResult {
  wardrobe: ResonanceWardrobeData
}

// ============ zod schema ============

/** 时间格式：源项目 "YYYY-MM-DD HH:mm:ss"，容许省略秒 */
export const resonanceTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/, 'resonance.error.invalidTimestamp')

export const resonanceBannerIdSchema = z
  .string()
  .regex(/^\d{1,6}$/, 'resonance.error.invalidBannerId')

export const resonanceItemIdSchema = z.string().regex(/^\d{5,12}$/, 'resonance.error.invalidItemId')

export const resonanceOutfitIdSchema = z
  .string()
  .regex(/^\d{5}$/, 'resonance.error.invalidOutfitId')

const pullRecordSchema = z.tuple([resonanceTimestampSchema, resonanceItemIdSchema])
export const resonanceEditRecordSchema = z.tuple([resonanceTimestampSchema, resonanceItemIdSchema])
export const resonanceEvoRecordSchema = z.tuple([
  resonanceOutfitIdSchema,
  z.number().int().min(0).max(4)
])

export const MAX_PULLS_PER_BANNER = 50_000
export const MAX_TOTAL_IMPORT_RECORDS = 200_000
export const MAX_WARDROBE_BATCH = 5_000
export const MAX_IMPORT_FILE_BYTES = 64 * 1024 * 1024

/** 单卡池记录数组（用于 IPC 单条增改与测试） */
export const resonancePullRecordListSchema = z.array(pullRecordSchema).max(MAX_PULLS_PER_BANNER)

const pullRecordMapLooseSchema = z.record(
  z.string().regex(/^\d{1,6}$/),
  z.array(z.unknown()).max(MAX_PULLS_PER_BANNER)
)
const editRecordMapLooseSchema = z.record(
  z.string().regex(/^\d{1,6}$/),
  z.array(z.unknown()).max(MAX_PULLS_PER_BANNER)
)
const evoRecordMapLooseSchema = z.record(
  z.string().regex(/^\d{1,6}$/),
  z.array(z.unknown()).max(MAX_PULLS_PER_BANNER)
)
const pearpalItemLooseSchema = z.record(z.string(), z.unknown())
const pearpalMapLooseSchema = z.record(
  z.string().regex(/^\d{1,6}$/),
  z.array(pearpalItemLooseSchema).max(MAX_PULLS_PER_BANNER)
)

const wardrobeLooseSchema = z.object({
  version: z.literal(1).optional(),
  ownedItemIds: z.array(z.unknown()).max(20_000).optional(),
  ownedMakeupIds: z.array(z.unknown()).max(20_000).optional(),
  ownedMomoIds: z.array(z.unknown()).max(20_000).optional(),
  ownedPropIds: z.array(z.unknown()).max(20_000).optional(),
  ownedEurekaColorIds: z.array(z.unknown()).max(20_000).optional(),
  updatedAt: z.string().max(64).optional()
})

/**
 * 导入文件顶层结构（宽松壳校验；逐条字段校验由 importParse 逐记录执行，
 * 以便统计无效条数并定位到 卡池/行号 而非整文件拒绝）。
 */
export const resonanceImportFileSchema = z.union([
  // 当前格式（源站导出同构）：{ version?, pulls?, edits?, evo?, pearpal?, wardrobe? }
  // version 允许 1..99 以便识别“未来版本”文件；>1 时由解析层标记 versionMismatch，
  // 预览层给出「兼容导入/放弃」选择，commit 需 force 确认。
  z
    .object({
      version: z.number().int().min(1).max(99).optional(),
      pulls: pullRecordMapLooseSchema.optional(),
      edits: editRecordMapLooseSchema.optional(),
      evo: evoRecordMapLooseSchema.optional(),
      pearpal: pearpalMapLooseSchema.optional(),
      wardrobe: wardrobeLooseSchema.optional()
    })
    .refine(
      (v) =>
        v.pulls !== undefined ||
        v.edits !== undefined ||
        v.evo !== undefined ||
        v.pearpal !== undefined ||
        v.wardrobe !== undefined,
      { message: 'resonance.error.importEmpty' }
    ),
  // 旧格式：Record<bannerId, PullRecord[]>（至少含一个卡池键，空对象视为无数据拒绝）
  z
    .record(z.string().regex(/^\d{1,6}$/), z.array(z.unknown()).max(MAX_PULLS_PER_BANNER))
    .refine((v) => Object.keys(v).length > 0, { message: 'resonance.error.importEmpty' })
])

// ---- IPC 入参 schema ----

/** 手动补录（写 edits 表；与源站 EditRecord 语义一致） */
export const resonanceAddManualRecordArgs = z.tuple([
  resonanceBannerIdSchema,
  resonanceItemIdSchema,
  resonanceTimestampSchema
])

export const resonanceUpdateManualRecordArgs = z.tuple([
  z.number().int().positive(),
  resonanceTimestampSchema
])

export const resonanceDeleteRecordArgs = z.tuple([
  z.object({
    kind: z.enum(['pull', 'edit']),
    id: z.number().int().positive()
  })
])

export const resonanceImportPreviewArgs = z.tuple([z.string().min(1).max(1024)])

/** 主进程读入导入文件的返回（解析在渲染层纯函数中完成） */
export interface ResonanceReadImportFileResult {
  content: string
  sizeBytes: number
}

export const resonanceReadImportFileArgs = z.tuple([z.string().min(1).max(1024)])

/** 单次提交批次的行数上限（渲染层按此分批，批间更新进度/检查取消） */
export const MAX_COMMIT_BATCH_ROWS = 2_000

const commitPullRow = z.object({
  bannerId: resonanceBannerIdSchema,
  itemId: resonanceItemIdSchema,
  obtainedAt: resonanceTimestampSchema
})
const commitPearpalRow = z.object({
  bannerId: resonanceBannerIdSchema,
  itemId: resonanceItemIdSchema,
  poolCnt: z.number().int().min(0).max(1_000_000),
  obtainedAt: resonanceTimestampSchema,
  raw: z.record(z.string(), z.unknown())
})

/**
 * 导入提交批次（渲染层解析、逐记录校验后分批送达主进程；
 * 主进程对本通道做同等强度的 schema 守卫，写入为单事务）。
 */
export const resonanceCommitImportArgs = z.tuple([
  z
    .object({
      pulls: z.array(commitPullRow).max(MAX_COMMIT_BATCH_ROWS),
      edits: z.array(commitPullRow).max(MAX_COMMIT_BATCH_ROWS),
      pearpal: z.array(commitPearpalRow).max(MAX_COMMIT_BATCH_ROWS),
      evo: z.array(
        z.object({
          bannerId: resonanceBannerIdSchema,
          outfitId: resonanceOutfitIdSchema,
          level: z.number().int().min(0).max(4)
        })
      ),
      /** 仅最后一个批次携带（全量覆盖衣橱） */
      wardrobe: wardrobeLooseSchema.optional(),
      includeWardrobe: z.boolean().optional()
    })
    .refine(
      (v) =>
        v.pulls.length > 0 ||
        v.edits.length > 0 ||
        v.pearpal.length > 0 ||
        v.evo.length > 0 ||
        (v.includeWardrobe === true && v.wardrobe !== undefined),
      { message: 'resonance.error.importEmptyBatch' }
    )
])

export interface ResonanceCommitImportBatch {
  pulls: Array<{ bannerId: string; itemId: string; obtainedAt: string }>
  edits: Array<{ bannerId: string; itemId: string; obtainedAt: string }>
  pearpal: Array<{
    bannerId: string
    itemId: string
    poolCnt: number
    obtainedAt: string
    raw: Record<string, unknown>
  }>
  evo: Array<{ bannerId: string; outfitId: string; level: number }>
  wardrobe?: Record<string, unknown>
  includeWardrobe?: boolean
}

export interface ResonanceCommitImportResult {
  imported: number
}

/** 导出载荷（渲染层纯函数组装，主进程写盘前做 envelope 守卫） */
export const resonanceExportPayloadSchema = z.object({
  version: z.literal(1),
  app: z.literal('nikkigallery'),
  exportedAt: z.string().max(64),
  pulls: z.record(
    z.string().regex(/^\d{1,6}$/),
    z.array(z.tuple([z.string(), z.string()])).max(MAX_PULLS_PER_BANNER)
  ),
  edits: z.record(
    z.string().regex(/^\d{1,6}$/),
    z.array(z.tuple([z.string(), z.string()])).max(MAX_PULLS_PER_BANNER)
  ),
  evo: z.record(
    z.string().regex(/^\d{1,6}$/),
    z.array(z.tuple([z.string(), z.number()])).max(MAX_PULLS_PER_BANNER)
  ),
  pearpal: z.record(
    z.string().regex(/^\d{1,6}$/),
    z.array(z.record(z.string(), z.unknown())).max(MAX_PULLS_PER_BANNER)
  ),
  wardrobe: wardrobeLooseSchema.optional()
})

export const resonanceExportArgs = z.tuple([
  z.object({
    filePath: z.string().min(1).max(1024)
  }),
  resonanceExportPayloadSchema
])

/** 导出文件载荷类型（与 resonanceExportPayloadSchema 同构；渲染层 exportPayload.ts 组装） */
export interface ResonanceExportPayload {
  version: 1
  app: 'nikkigallery'
  exportedAt: string
  pulls: Record<string, Array<[string, string]>>
  edits: Record<string, Array<[string, string]>>
  evo: Record<string, Array<[string, number]>>
  pearpal: Record<string, Array<Record<string, unknown>>>
  wardrobe?: Record<string, unknown>
}

const wardrobeEntrySchema = z.object({
  category: z.enum(['item', 'makeup', 'momo', 'prop', 'eureka_color']),
  itemId: z.number().int().positive()
})

export const resonanceUpdateWardrobeArgs = z.tuple([
  z
    .object({
      adds: z.array(wardrobeEntrySchema).max(MAX_WARDROBE_BATCH),
      removes: z.array(wardrobeEntrySchema).max(MAX_WARDROBE_BATCH)
    })
    .refine((v) => v.adds.length > 0 || v.removes.length > 0, {
      message: 'resonance.error.wardrobeEmptyUpdate'
    })
])

// ---- 渲染层 UI 二次轻校验复用 ----

export const wardrobeCategorySchema = z.enum(['item', 'makeup', 'momo', 'prop', 'eureka_color'])
