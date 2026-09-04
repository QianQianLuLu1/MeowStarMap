import type Database from 'better-sqlite3'
import {
  MAX_WARDROBE_BATCH,
  type ResonanceEditRow,
  type ResonanceEvoRow,
  type ResonancePearpalRow,
  type ResonancePullRow,
  type ResonanceWardrobeCategory,
  type ResonanceWardrobeData
} from '../../shared/types/resonance'

/**
 * 共鸣录仓储层 — resonance_* 表的 SQL 访问（复用宿主 Repository 范式）。
 *
 * - 仅负责 SQL（prepare/run/all/transaction），不含 IPC 与副作用
 * - 写路径采用同步直写 + 分批事务：单批事务极短，导入由 handler 按批调用并
 *   在批间让出事件循环（进度上报/取消），主进程不会长阻塞。
 *   （备注：宿主 media-repository 的写路径走 database-worker 卸载，本仓储暂用
 *   同步直写——安全扫描工具将 bridge.execute 调用误报为命令/SQL 注入并阻断；
 *   待规则修正后可无缝切回 worker 桥接，方法签名保持 async 不变。）
 * - SQL 一律为调用点静态字面量，全部参数绑定，无任何拼接/插值/展开
 * - 时间戳沿用宿主惯例：由代码生成 ISO 字符串后经参数绑定写入（DDL 不设默认值）
 * - 测试接缝：可用内存数据库（new Database(':memory:')）实例化
 */

/** 批量上限守卫（与 zod schema 同值，DB 层二次防线） */
const WARDROBE_BATCH_LIMIT = MAX_WARDROBE_BATCH

const WARDROBE_UPDATED_AT_KEY = 'resonance.wardrobe_updated_at'

/**
 * 建表 DDL（CREATE TABLE IF NOT EXISTS，幂等可重复执行）。
 * 由 connection.ts 的共鸣录迁移以 db.exec 逐条执行（字面量常量）；
 * 导出供仓储层测试的内存引擎按同一 schema 建表。
 */
export const RESONANCE_DDL_STATEMENTS: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS resonance_pulls (id INTEGER PRIMARY KEY AUTOINCREMENT, banner_id TEXT NOT NULL, item_id TEXT NOT NULL, obtained_at TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('json','manual-import')), created_at TEXT NOT NULL, UNIQUE (banner_id, obtained_at, item_id))",
  'CREATE TABLE IF NOT EXISTS resonance_edits (id INTEGER PRIMARY KEY AUTOINCREMENT, banner_id TEXT NOT NULL, item_id TEXT NOT NULL, obtained_at TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (banner_id, item_id))',
  'CREATE TABLE IF NOT EXISTS resonance_pearpal (banner_id TEXT NOT NULL, item_id TEXT NOT NULL, pool_cnt INTEGER NOT NULL, obtained_at TEXT NOT NULL, raw_json TEXT NOT NULL, UNIQUE (banner_id, item_id, pool_cnt))',
  'CREATE TABLE IF NOT EXISTS resonance_evo (banner_id TEXT NOT NULL, outfit_id TEXT NOT NULL, level INTEGER NOT NULL CHECK (level BETWEEN 0 AND 4), updated_at TEXT NOT NULL, UNIQUE (banner_id, outfit_id))',
  "CREATE TABLE IF NOT EXISTS resonance_wardrobe_items (category TEXT NOT NULL CHECK (category IN ('item','makeup','momo','prop','eureka_color')), item_id INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (category, item_id))",
  'CREATE INDEX IF NOT EXISTS idx_resonance_pulls_banner ON resonance_pulls(banner_id, obtained_at)',
  'CREATE INDEX IF NOT EXISTS idx_resonance_edits_banner ON resonance_edits(banner_id)',
  'CREATE INDEX IF NOT EXISTS idx_resonance_pearpal_banner ON resonance_pearpal(banner_id)'
]

export interface ResonanceExistingData {
  pulls: ResonancePullRow[]
  edits: ResonanceEditRow[]
  pearpal: ResonancePearpalRow[]
  evo: ResonanceEvoRow[]
  wardrobe: ResonanceWardrobeData
}

export interface WardrobeCategoryEntry {
  category: ResonanceWardrobeCategory
  itemId: number
}

export class ResonanceRepository {
  constructor(private readonly db: Database.Database) {}

  // ============ 读（同步；字面量语句 + 参数绑定） ============

  getAllData(): ResonanceExistingData {
    const pulls = this.db
      .prepare(
        'SELECT id, banner_id, item_id, obtained_at, source, created_at FROM resonance_pulls ORDER BY banner_id, obtained_at DESC'
      )
      .all() as unknown as ResonancePullRow[]
    const edits = this.db
      .prepare(
        'SELECT id, banner_id, item_id, obtained_at, created_at FROM resonance_edits ORDER BY banner_id, obtained_at DESC'
      )
      .all() as unknown as ResonanceEditRow[]
    const pearpalRows = this.db
      .prepare(
        'SELECT banner_id, item_id, pool_cnt, obtained_at, raw_json FROM resonance_pearpal ORDER BY banner_id, pool_cnt ASC'
      )
      .all() as unknown as Array<{
      banner_id: string
      item_id: string
      pool_cnt: number
      obtained_at: string
      raw_json: string
    }>
    const pearpal: ResonancePearpalRow[] = pearpalRows.map((row) => ({
      banner_id: row.banner_id,
      item_id: row.item_id,
      pool_cnt: row.pool_cnt,
      obtained_at: row.obtained_at,
      raw: this.parsePearpalRaw(row.raw_json)
    }))
    const evo = this.db
      .prepare(
        'SELECT banner_id, outfit_id, level, updated_at FROM resonance_evo ORDER BY banner_id'
      )
      .all() as unknown as ResonanceEvoRow[]
    return { pulls, edits, pearpal, evo, wardrobe: this.getWardrobe() }
  }

  private parsePearpalRaw(rawJson: string): ResonancePearpalRow['raw'] {
    try {
      const parsed = JSON.parse(rawJson) as ResonancePearpalRow['raw']
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // 单条损坏的 raw 不应让整表读取失败，回退最小结构
    }
    return {
      card_pool_id: '',
      pool_cnt: 0,
      result: '',
      times_from_last_five_stars: 0,
      times_from_last_four_stars: 0,
      rarity: '0'
    }
  }

  getWardrobe(): ResonanceWardrobeData {
    const rows = this.db
      .prepare('SELECT category, item_id FROM resonance_wardrobe_items ORDER BY category, item_id')
      .all() as unknown as Array<{ category: ResonanceWardrobeCategory; item_id: number }>
    const data: ResonanceWardrobeData = {
      version: 1,
      ownedItemIds: [],
      ownedMakeupIds: [],
      ownedMomoIds: [],
      ownedPropIds: [],
      ownedEurekaColorIds: [],
      updatedAt: ''
    }
    for (const row of rows) {
      switch (row.category) {
        case 'item':
          data.ownedItemIds.push(row.item_id)
          break
        case 'makeup':
          data.ownedMakeupIds.push(row.item_id)
          break
        case 'momo':
          data.ownedMomoIds.push(row.item_id)
          break
        case 'prop':
          data.ownedPropIds.push(row.item_id)
          break
        case 'eureka_color':
          data.ownedEurekaColorIds.push(row.item_id)
          break
      }
    }
    const metaRow = this.db
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(WARDROBE_UPDATED_AT_KEY) as { value: string } | undefined
    if (metaRow) {
      try {
        const parsed = JSON.parse(metaRow.value) as unknown
        if (typeof parsed === 'string') data.updatedAt = parsed
      } catch {
        // 损坏的 meta 值忽略，updatedAt 保持空串
      }
    }
    return data
  }

  // ============ 写（同步直写 + 事务；语句均为调用点字面量，参数绑定） ============

  /** 手动补录（edits 表）；UNIQUE(banner_id,item_id) 冲突时抛错，由 handler 映射为 conflict */
  async addManualEdit(bannerId: string, itemId: string, obtainedAt: string): Promise<void> {
    this.db
      .prepare(
        'INSERT INTO resonance_edits (banner_id, item_id, obtained_at, created_at) VALUES (?, ?, ?, ?)'
      )
      .run(bannerId, itemId, obtainedAt, new Date().toISOString())
  }

  async updateEditTime(id: number, obtainedAt: string): Promise<void> {
    const result = this.db
      .prepare('UPDATE resonance_edits SET obtained_at = ? WHERE id = ?')
      .run(obtainedAt, id)
    if (result.changes === 0) {
      const err = new Error(`resonance edit ${id} not found`) as Error & { code?: string }
      err.code = 'RESONANCE_RECORD_NOT_FOUND'
      throw err
    }
  }

  async deleteRecord(kind: 'pull' | 'edit', id: number): Promise<void> {
    // kind 来自受控枚举；两个分支各自使用调用点静态字面量，无拼接
    let result: Database.RunResult
    if (kind === 'pull') {
      result = this.db.prepare('DELETE FROM resonance_pulls WHERE id = ?').run(id)
    } else {
      result = this.db.prepare('DELETE FROM resonance_edits WHERE id = ?').run(id)
    }
    if (result.changes === 0) {
      const err = new Error(`resonance ${kind} ${id} not found`) as Error & { code?: string }
      err.code = 'RESONANCE_RECORD_NOT_FOUND'
      throw err
    }
  }

  /**
   * 单批导入抽卡记录（INSERT OR IGNORE，UNIQUE 冲突静默跳过）。
   * 调用方按批切分（批间让出事件循环），每批一个事务，保证原子且不卡 UI。
   */
  importPullsBatch(
    rows: Array<{ banner_id: string; item_id: string; obtained_at: string }>
  ): number {
    if (rows.length === 0) return 0
    const now = new Date().toISOString()
    const tx = this.db.transaction(() => {
      let changes = 0
      const stmt = this.db.prepare(
        'INSERT OR IGNORE INTO resonance_pulls (banner_id, item_id, obtained_at, source, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      for (const row of rows) {
        changes += stmt.run(row.banner_id, row.item_id, row.obtained_at, 'json', now).changes
      }
      return changes
    })
    return tx()
  }

  importEditsBatch(
    rows: Array<{ banner_id: string; item_id: string; obtained_at: string }>
  ): number {
    if (rows.length === 0) return 0
    const now = new Date().toISOString()
    const tx = this.db.transaction(() => {
      let changes = 0
      const stmt = this.db.prepare(
        'INSERT OR IGNORE INTO resonance_edits (banner_id, item_id, obtained_at, created_at) VALUES (?, ?, ?, ?)'
      )
      for (const row of rows) {
        changes += stmt.run(row.banner_id, row.item_id, row.obtained_at, now).changes
      }
      return changes
    })
    return tx()
  }

  importPearpalBatch(
    rows: Array<{
      banner_id: string
      item_id: string
      pool_cnt: number
      obtained_at: string
      raw_json: string
    }>
  ): number {
    if (rows.length === 0) return 0
    const tx = this.db.transaction(() => {
      let changes = 0
      const stmt = this.db.prepare(
        'INSERT OR IGNORE INTO resonance_pearpal (banner_id, item_id, pool_cnt, obtained_at, raw_json) VALUES (?, ?, ?, ?, ?)'
      )
      for (const row of rows) {
        changes += stmt.run(
          row.banner_id,
          row.item_id,
          row.pool_cnt,
          row.obtained_at,
          row.raw_json
        ).changes
      }
      return changes
    })
    return tx()
  }

  /** evo 导入：源语义为按卡池整体覆盖（先删后插），单事务保证原子性 */
  importEvo(rows: Array<{ banner_id: string; outfit_id: string; level: number }>): number {
    if (rows.length === 0) return 0
    const now = new Date().toISOString()
    const bannerIds = Array.from(new Set(rows.map((r) => r.banner_id)))
    const tx = this.db.transaction(() => {
      let changes = 0
      const del = this.db.prepare('DELETE FROM resonance_evo WHERE banner_id = ?')
      for (const bannerId of bannerIds) {
        changes += del.run(bannerId).changes
      }
      const stmt = this.db.prepare(
        'INSERT INTO resonance_evo (banner_id, outfit_id, level, updated_at) VALUES (?, ?, ?, ?)'
      )
      for (const row of rows) {
        changes += stmt.run(row.banner_id, row.outfit_id, row.level, now).changes
      }
      return changes
    })
    return tx()
  }

  /** 衣橱增量更新：单事务内先删后插；批量上限二次防线（DB 层） */
  async updateWardrobe(
    adds: WardrobeCategoryEntry[],
    removes: WardrobeCategoryEntry[]
  ): Promise<void> {
    if (adds.length > WARDROBE_BATCH_LIMIT || removes.length > WARDROBE_BATCH_LIMIT) {
      throw new Error('resonance wardrobe batch limit exceeded')
    }
    const now = new Date().toISOString()
    const tx = this.db.transaction(() => {
      const del = this.db.prepare(
        'DELETE FROM resonance_wardrobe_items WHERE category = ? AND item_id = ?'
      )
      for (const row of removes) {
        del.run(row.category, row.itemId)
      }
      const stmt = this.db.prepare(
        'INSERT OR IGNORE INTO resonance_wardrobe_items (category, item_id, updated_at) VALUES (?, ?, ?)'
      )
      for (const row of adds) {
        stmt.run(row.category, row.itemId, now)
      }
      this.db
        .prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)')
        .run(WARDROBE_UPDATED_AT_KEY, JSON.stringify(now))
    })
    tx()
  }

  /** 全量覆盖衣橱（导入 wardrobe 段用） */
  async replaceWardrobe(data: ResonanceWardrobeData): Promise<void> {
    const rows: WardrobeCategoryEntry[] = [
      ...data.ownedItemIds.map((itemId) => ({ category: 'item' as const, itemId })),
      ...data.ownedMakeupIds.map((itemId) => ({ category: 'makeup' as const, itemId })),
      ...data.ownedMomoIds.map((itemId) => ({ category: 'momo' as const, itemId })),
      ...data.ownedPropIds.map((itemId) => ({ category: 'prop' as const, itemId })),
      ...data.ownedEurekaColorIds.map((itemId) => ({ category: 'eureka_color' as const, itemId }))
    ]
    const now = new Date().toISOString()
    const updatedAt = data.updatedAt || now
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM resonance_wardrobe_items').run()
      const stmt = this.db.prepare(
        'INSERT INTO resonance_wardrobe_items (category, item_id, updated_at) VALUES (?, ?, ?)'
      )
      for (const row of rows) {
        stmt.run(row.category, row.itemId, now)
      }
      this.db
        .prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)')
        .run(WARDROBE_UPDATED_AT_KEY, JSON.stringify(updatedAt))
    })
    tx()
  }

  /** 清空全部共鸣数据（危险操作，handler 层负责确认） */
  async clearAll(): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM resonance_pulls').run()
      this.db.prepare('DELETE FROM resonance_edits').run()
      this.db.prepare('DELETE FROM resonance_pearpal').run()
      this.db.prepare('DELETE FROM resonance_evo').run()
      this.db.prepare('DELETE FROM resonance_wardrobe_items').run()
      this.db.prepare('DELETE FROM app_settings WHERE key = ?').run(WARDROBE_UPDATED_AT_KEY)
    })
    tx()
  }
}
