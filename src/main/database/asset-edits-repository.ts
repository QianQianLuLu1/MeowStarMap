import type Database from 'better-sqlite3'
import type { DatabaseWorkerBridge } from './worker/database-worker-bridge'
import { chunkArray } from './sql-chunk'

/**
 * 资产编辑叠加层仓储 — `asset_edits` 单表的 SQL 访问（sync-integration 阶段 4）。
 *
 * 为什么需要这张表：NikkiSync 协议里没有「收藏 / 评分 / 标签 / 备注 / 分类 / 套装 /
 * 场景 / 隐藏」这些**本 App 专有**的用户编辑概念（`AssetSummary` 只有 14 个协议字段）。
 * 图库以 assets 为媒体事实源之后，这些编辑必须按 `asset_id` 另存一层，否则切源即丢
 * 用户数据，且渲染层会退回「每帧查 `media_files`」——旧数据源就没真正退出。
 *
 * 口径与同目录仓储一致：
 * - 读同步、写 async；写走 `runWrite()`，未注入 workerBridge 时降级同步直写
 *   （`sync-metadata-repository.ts` 同款先例：安全扫描工具会把 `bridge.execute` +
 *   变量 prepare 误报为注入，因此保留直写路径，签名仍为 async 以便日后无缝切回）。
 * - SQL 一律为调用点静态字面量，全部参数绑定；批量 IN 走 `chunkArray` 分片。
 * - 布尔列存 0/1，与 `media_files` 同口径，转 boolean 归 handler/渲染层。
 * - DDL 常量在此导出，供 `connection.ts` 迁移与测试建表共用同一份（不留副本）。
 */

// ============================================================================
// DDL — 由 `connection.ts` 的 applyMigrations 幂等执行（纯新增表，无版本标记）
// ============================================================================

export const ASSET_EDITS_DDL_STATEMENTS: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS asset_edits (asset_id TEXT PRIMARY KEY, is_favorite INTEGER NOT NULL DEFAULT 0, rating INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '', category_id INTEGER, outfit TEXT, scene_category TEXT, scene_time TEXT, is_hidden INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, updated_at TEXT NOT NULL)",
  'CREATE INDEX IF NOT EXISTS idx_asset_edits_favorite ON asset_edits(is_favorite)',
  'CREATE INDEX IF NOT EXISTS idx_asset_edits_category ON asset_edits(category_id)',
  'CREATE INDEX IF NOT EXISTS idx_asset_edits_hidden ON asset_edits(is_hidden)'
]

// ============================================================================
// SQL 模板（完整静态字面量；IN 的占位符按分片长度生成，参数仍全部绑定）
// ============================================================================

const SQL_UPSERT =
  'INSERT INTO asset_edits (asset_id, is_favorite, rating, tags, notes, category_id, outfit, ' +
  'scene_category, scene_time, is_hidden, deleted_at, updated_at) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
  'ON CONFLICT(asset_id) DO UPDATE SET is_favorite = excluded.is_favorite, rating = excluded.rating, ' +
  'tags = excluded.tags, notes = excluded.notes, category_id = excluded.category_id, ' +
  'outfit = excluded.outfit, scene_category = excluded.scene_category, scene_time = excluded.scene_time, ' +
  'is_hidden = excluded.is_hidden, deleted_at = excluded.deleted_at, updated_at = excluded.updated_at'
const SQL_GET_ONE = 'SELECT * FROM asset_edits WHERE asset_id = ?'
const SQL_COUNT = 'SELECT COUNT(*) AS count FROM asset_edits'
const SQL_LIST_PREFIX = 'SELECT * FROM asset_edits WHERE asset_id IN ('
const SQL_ALL_ASSET_IDS = 'SELECT asset_id FROM asset_edits'

/** 表行形态：与列一一对应，数值型布尔保持 raw 值。 */
export interface AssetEditsRow {
  asset_id: string
  is_favorite: number
  rating: number
  tags: string
  notes: string
  category_id: number | null
  outfit: string | null
  scene_category: string | null
  scene_time: string | null
  is_hidden: number
  deleted_at: string | null
  updated_at: string
}

/** 写入补丁：除 `updatedAt` 外全部可选，缺省按列默认值落库。 */
export interface AssetEditsPatch {
  isFavorite?: boolean
  rating?: number
  tags?: string[]
  notes?: string
  categoryId?: number | null
  outfit?: string | null
  sceneCategory?: string | null
  sceneTime?: string | null
  isHidden?: boolean
  deletedAt?: string | null
  updatedAt: string
}

/** 归一化：折叠分隔符与大小写，供路径匹配用（Windows 大小写不敏感）。 */
function normalizePathKey(filePath: string): string {
  return filePath.replace(/\\/g, '/').trim().toLowerCase()
}

/** 补丁 → 12 列参数，顺序与 `SQL_UPSERT` 逐位对应。 */
function toParams(assetId: string, patch: AssetEditsPatch): unknown[] {
  return [
    assetId,
    patch.isFavorite === true ? 1 : 0,
    patch.rating ?? 0,
    JSON.stringify(patch.tags ?? []),
    patch.notes ?? '',
    patch.categoryId ?? null,
    patch.outfit ?? null,
    patch.sceneCategory ?? null,
    patch.sceneTime ?? null,
    patch.isHidden === true ? 1 : 0,
    patch.deletedAt ?? null,
    patch.updatedAt
  ]
}

export class AssetEditsRepository {
  constructor(
    private readonly db: Database.Database,
    // `getWorkerBridge()` 的返回类型是 `DatabaseWorkerBridge | null`（未启 worker 时为 null），
    // 因此这里必须同时接受 null 与 undefined，两者都表示「降级为同步直写」。
    private readonly workerBridge?: DatabaseWorkerBridge | null,
    private readonly dbPath?: string
  ) {}

  /** 按 asset_id 批量取叠加层；缺表（旧库未迁移）如实回退为空，不抛错。 */
  listByAssetIds(assetIds: readonly string[]): AssetEditsRow[] {
    if (assetIds.length === 0) return []
    const collected: AssetEditsRow[] = []
    try {
      for (const chunk of chunkArray([...assetIds])) {
        const placeholders = chunk.map(() => '?').join(',')
        const rows = this.db
          .prepare(`${SQL_LIST_PREFIX}${placeholders})`)
          .all(...chunk) as AssetEditsRow[]
        collected.push(...rows)
      }
      return collected
    } catch {
      return []
    }
  }

  getOne(assetId: string): AssetEditsRow | undefined {
    try {
      return this.db.prepare(SQL_GET_ONE).get(assetId) as AssetEditsRow | undefined
    } catch {
      return undefined
    }
  }

  /** 诊断用：叠加层行数（seed 前后对比，不返回任何内容）。 */
  countAll(): number {
    try {
      const row = this.db.prepare(SQL_COUNT).get() as { count?: number } | undefined
      return Number(row?.count ?? 0)
    } catch {
      return 0
    }
  }

  /** 已存在的 asset_id 集合（seed 去重用）。 */
  listAssetIds(): string[] {
    try {
      const rows = this.db.prepare(SQL_ALL_ASSET_IDS).all() as Array<{ asset_id: string }>
      return rows.map((row) => row.asset_id)
    } catch {
      return []
    }
  }

  async upsert(assetId: string, patch: AssetEditsPatch): Promise<void> {
    await this.runWrite(SQL_UPSERT, toParams(assetId, patch))
  }

  /**
   * 批量落库（seed 用）：单个事务内逐条 UPSERT。
   * 事务里不能用 worker bridge（worker 有自己的连接），因此这条固定走主进程同步写。
   */
  upsertMany(entries: Array<{ assetId: string; patch: AssetEditsPatch }>): number {
    if (entries.length === 0) return 0
    const statement = this.db.prepare(SQL_UPSERT)
    const apply = this.db.transaction(() => {
      let written = 0
      for (const entry of entries) {
        statement.run(...toParams(entry.assetId, entry.patch))
        written += 1
      }
      return written
    })
    return apply()
  }

  private async runWrite(sql: string, params: unknown[]): Promise<void> {
    if (!this.workerBridge || !this.dbPath) {
      this.db.prepare(sql).run(...params)
      return
    }
    await this.workerBridge.execute(this.dbPath, sql, params)
  }
}

/** seed 的输入行：来自 `media_files` 的一条可迁移编辑。 */
export interface SeedCandidate {
  /** 候选的媒体文件绝对路径（与 NikkiSync `resources.source_path` 比对的依据）。 */
  filePath: string
  rating: number
  isFavorite: boolean
  tags: string[]
  notes?: string
  categoryId?: number | null
  outfit?: string | null
  sceneCategory?: string | null
  sceneTime?: string | null
  /** 仅用于日志/测试可读性，不参与匹配。 */
  assetId?: string
}

/** 一条可执行的回填计划。 */
export interface SeedPlanEntry {
  assetId: string
  patch: AssetEditsPatch
}

/** 有没有任何用户编辑价值：全默认值的行不值得入库。 */
function hasEditValue(candidate: SeedCandidate): boolean {
  return (
    candidate.rating > 0 ||
    candidate.isFavorite ||
    candidate.tags.length > 0 ||
    Boolean(candidate.notes && candidate.notes.trim() !== '') ||
    Boolean(candidate.outfit) ||
    Boolean(candidate.sceneCategory) ||
    Boolean(candidate.sceneTime) ||
    (candidate.categoryId !== null && candidate.categoryId !== undefined)
  )
}

/**
 * 纯函数：把 `media_files` 里的用户编辑映射到 NikkiSync `asset_id`。
 *
 * 匹配依据是**归一化后的绝对路径**（折叠 `\` 与大小写）：两套扫描器扫的是同一批游戏
 * 截图，路径同源，但字面写法可能不同。未匹配上的候选**直接丢弃**——为一条在 NikkiSync
 * 库里不存在的资产造编辑行，等于给幽灵资产写数据。
 */
export function planAssetEditSeed(
  candidates: readonly SeedCandidate[],
  pathToAssetId: ReadonlyMap<string, string>,
  updatedAt: string = new Date().toISOString()
): SeedPlanEntry[] {
  const plan: SeedPlanEntry[] = []
  for (const candidate of candidates) {
    if (!hasEditValue(candidate)) continue
    const assetId = pathToAssetId.get(normalizePathKey(candidate.filePath))
    if (!assetId) continue
    plan.push({
      assetId,
      patch: {
        isFavorite: candidate.isFavorite,
        rating: candidate.rating,
        tags: candidate.tags,
        notes: candidate.notes ?? '',
        categoryId: candidate.categoryId ?? null,
        outfit: candidate.outfit ?? null,
        sceneCategory: candidate.sceneCategory ?? null,
        sceneTime: candidate.sceneTime ?? null,
        isHidden: false,
        deletedAt: null,
        updatedAt
      }
    })
  }
  return plan
}
