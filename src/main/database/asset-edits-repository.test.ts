import { describe, expect, it, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import {
  ASSET_EDITS_DDL_STATEMENTS,
  AssetEditsRepository,
  planAssetEditSeed
} from './asset-edits-repository'

/**
 * AssetEditsRepository 单元测试（阶段 4 · 编辑叠加层）。
 *
 * 真实 better-sqlite3 按 Electron ABI 编译，vitest（Node ABI）下无法加载，
 * 因此沿用 `import-root-repository.test.ts` 的先例：只识别本仓储实际发出的
 * SQL 模板的最小 fake DB，不做通用 SQL 解析。
 *
 * 叠加层的存在理由是：NikkiSync 协议里没有「收藏 / 评分 / 标签 / 备注 / 分类 /
 * 套装 / 场景 / 隐藏」这些**本 App 专有**的用户编辑概念。图库以 assets 为媒体
 * 事实源之后，这些字段必须按 `asset_id` 另存一层，否则切源即丢编辑。
 */

interface FakeRow {
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

class FakeDb {
  rows: FakeRow[] = []
  executed: Array<{ sql: string; params: unknown[] }> = []
  /** 表缺失开关：模拟旧库尚未跑迁移 */
  tableMissing = false

  private find(assetId: string): FakeRow | undefined {
    return this.rows.find((row) => row.asset_id === assetId)
  }

  prepare(sql: string): {
    run: (...args: unknown[]) => { changes: number }
    get: (...args: unknown[]) => FakeRow | undefined
    all: (...args: unknown[]) => FakeRow[]
  } {
    // 仓储用 `run(...params)` / `all(...chunk)` 的展开形态调用，这里再收拢回数组
    const gather = (args: unknown[]): unknown[] =>
      args.length === 1 && Array.isArray(args[0]) ? (args[0] as unknown[]) : args
    return {
      run: (...args: unknown[]) => this.run(sql, gather(args)),
      get: (...args: unknown[]) => this.get(sql, gather(args)),
      all: (...args: unknown[]) => this.all(sql, gather(args))
    }
  }

  private run(sql: string, params: unknown[]): { changes: number } {
    this.executed.push({ sql, params })
    if (this.tableMissing) throw new Error('no such table: asset_edits')
    if (sql.startsWith('INSERT INTO asset_edits')) {
      const [assetId] = params as string[]
      const existing = this.find(assetId)
      if (existing) {
        Object.assign(existing, this.toColumns(params))
        return { changes: 1 }
      }
      this.rows.push(this.toColumns(params) as FakeRow)
      return { changes: 1 }
    }
    throw new Error(`FakeDb: 未覆盖的 SQL: ${sql}`)
  }

  /** 列顺序与仓储里的静态 SQL 字面量逐位对应（写歪一位即整表错位）。 */
  private toColumns(params: unknown[]): FakeRow {
    return {
      asset_id: String(params[0]),
      is_favorite: Number(params[1]),
      rating: Number(params[2]),
      tags: String(params[3]),
      notes: String(params[4]),
      category_id: params[5] === null ? null : Number(params[5]),
      outfit: params[6] === null || params[6] === undefined ? null : String(params[6]),
      scene_category: params[7] == null ? null : String(params[7]),
      scene_time: params[8] == null ? null : String(params[8]),
      is_hidden: Number(params[9]),
      deleted_at: params[10] == null ? null : String(params[10]),
      updated_at: String(params[11])
    }
  }

  private get(sql: string, params: unknown[]): FakeRow | undefined {
    if (this.tableMissing) throw new Error('no such table: asset_edits')
    if (sql.startsWith('SELECT * FROM asset_edits WHERE asset_id = ?')) {
      return this.find(String(params[0]))
    }
    if (sql.startsWith('SELECT COUNT(*) AS count FROM asset_edits')) {
      return { count: this.rows.length } as unknown as FakeRow
    }
    throw new Error(`FakeDb: 未覆盖的 SQL: ${sql}`)
  }

  private all(sql: string, params: unknown[]): FakeRow[] {
    if (this.tableMissing) throw new Error('no such table: asset_edits')
    if (sql.startsWith('SELECT * FROM asset_edits WHERE asset_id IN (')) {
      const wanted = params as string[]
      return this.rows.filter((row) => wanted.includes(row.asset_id))
    }
    if (sql.startsWith('SELECT asset_id FROM asset_edits')) {
      return this.rows.map((row) => ({ asset_id: row.asset_id }) as FakeRow)
    }
    throw new Error(`FakeDb: 未覆盖的 SQL: ${sql}`)
  }

  transaction<T>(work: () => T): T {
    return work()
  }
}

let db: FakeDb
let repo: AssetEditsRepository

beforeEach(() => {
  db = new FakeDb()
  repo = new AssetEditsRepository(db as unknown as Database.Database)
})

describe('AssetEditsRepository 读面', () => {
  it('空入参不发 SQL', () => {
    const spy = vi.spyOn(db, 'prepare')
    expect(repo.listByAssetIds([])).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })

  it('按 asset_id 集合取回，缺表时如实回退为空叠加层', () => {
    db.rows.push({
      asset_id: 'a/1',
      is_favorite: 1,
      rating: 4,
      tags: '["花"]',
      notes: 'n',
      category_id: 7,
      outfit: 'o',
      scene_category: 's',
      scene_time: 'dusk',
      is_hidden: 0,
      deleted_at: null,
      updated_at: '2026-10-14'
    })
    expect(repo.listByAssetIds(['a/1', 'a/none'])).toHaveLength(1)
    const got = repo.getOne('a/1')
    expect(got?.asset_id).toBe('a/1')
    expect(repo.getOne('a/none')).toBeUndefined()

    db.tableMissing = true
    expect(repo.listByAssetIds(['a/1'])).toEqual([])
    expect(repo.getOne('a/1')).toBeUndefined()
  })

  it('计数用于诊断（seed 前后对比）', () => {
    expect(repo.countAll()).toBe(0)
    db.rows.push({ asset_id: 'x' } as unknown as FakeRow)
    expect(repo.countAll()).toBe(1)
  })
})

describe('AssetEditsRepository 写面', () => {
  it('upsert 的列顺序与静态 SQL 逐位对应，tags 序列化为 JSON 文本', async () => {
    await repo.upsert('a/1', {
      isFavorite: true,
      rating: 3,
      tags: ['花', '夜'],
      notes: 'hi',
      categoryId: 9,
      outfit: 'spring',
      sceneCategory: 'screenshot',
      sceneTime: 'night',
      isHidden: false,
      deletedAt: null,
      updatedAt: '2026-10-14T00:00:00.000Z'
    })
    const params = db.executed[0].params
    expect(params[0]).toBe('a/1')
    expect(params[1]).toBe(1) // 布尔折叠为 0/1（与 media_files 同口径）
    expect(params[2]).toBe(3)
    expect(params[3]).toBe('["花","夜"]')
    expect(params[5]).toBe(9)
    expect(params[9]).toBe(0)
    expect(params[11]).toBe('2026-10-14T00:00:00.000Z')
  })

  it('未给的字段按缺省落库（false / 0 / [] / 空串 / null）', async () => {
    await repo.upsert('a/2', { updatedAt: '2026-10-14T00:00:00.000Z' })
    const row = repo.getOne('a/2')
    expect(row?.is_favorite).toBe(0)
    expect(row?.rating).toBe(0)
    expect(row?.tags).toBe('[]')
    expect(row?.notes).toBe('')
    expect(row?.category_id).toBeNull()
  })

  it('同 asset_id 二次写入是覆盖而非追加（主键语义）', async () => {
    await repo.upsert('a/3', { rating: 1, updatedAt: 't1' })
    await repo.upsert('a/3', { rating: 5, updatedAt: 't2' })
    expect(db.rows.filter((row) => row.asset_id === 'a/3')).toHaveLength(1)
    expect(repo.getOne('a/3')?.rating).toBe(5)
  })

  it('注入 workerBridge 时写操作改走 worker，不直写主进程连接', async () => {
    const bridge = { execute: vi.fn(async () => undefined) }
    const wired = new AssetEditsRepository(
      db as unknown as Database.Database,
      bridge as never,
      '/x.db'
    )
    await wired.upsert('a/4', { rating: 2, updatedAt: 't' })
    expect(bridge.execute).toHaveBeenCalledTimes(1)
    expect(db.executed).toHaveLength(0)
  })
})

describe('planAssetEditSeed 回填计划', () => {
  it('按归一化绝对路径匹配 assetId，未匹配项不进计划', () => {
    const plan = planAssetEditSeed(
      [
        { assetId: 'a/1', filePath: 'D:/Game/x/1.png', rating: 5, isFavorite: true, tags: ['好'] },
        {
          assetId: 'a/2',
          filePath: 'D:/Game/x/2.png',
          rating: 0,
          isFavorite: false,
          tags: [],
          notes: '备忘'
        },
        { assetId: 'a/3', filePath: 'D:/Game/x/3.png', rating: 3, isFavorite: false, tags: [] }
      ],
      new Map([
        ['d:/game/x/1.png', 'a/1'],
        ['d:/game/x/2.png', 'a/2']
      ])
    )
    // a/3 在 NikkiSync 库里不存在 ⇒ 不能凭空造一条指向幽灵资产的编辑
    expect(plan.map((item) => item.assetId)).toEqual(['a/1', 'a/2'])
    expect(plan[0].patch.rating).toBe(5)
    expect(plan[0].patch.isFavorite).toBe(true)
    expect(plan[1].patch.notes).toBe('备忘')
  })

  it('全空白/无编辑价值的行被剔除（不把默认值灌成噪声）', () => {
    const plan = planAssetEditSeed(
      [
        { assetId: 'a/1', filePath: 'D:/Game/x/1.png', rating: 0, isFavorite: false, tags: [] },
        { assetId: 'a/2', filePath: 'D:/Game/x/2.png', rating: 2, isFavorite: false, tags: [] }
      ],
      new Map([
        ['d:/game/x/1.png', 'a/1'],
        ['d:/game/x/2.png', 'a/2']
      ])
    )
    expect(plan).toHaveLength(1)
    expect(plan[0].assetId).toBe('a/2')
  })

  it('空输入给空计划，且路径匹配大小写不敏感', () => {
    expect(planAssetEditSeed([], new Map())).toEqual([])
    const plan = planAssetEditSeed(
      [{ assetId: 'a/1', filePath: 'D:/GAME/X/1.PNG', rating: 4, isFavorite: false, tags: [] }],
      new Map([['d:/game/x/1.png', 'a/1']])
    )
    expect(plan).toHaveLength(1)
  })
})

describe('ASSET_EDITS_DDL_STATEMENTS', () => {
  it('建表语句幂等且带主键与 updated_at（供迁移与测试共用同一份）', () => {
    expect(ASSET_EDITS_DDL_STATEMENTS[0]).toContain('CREATE TABLE IF NOT EXISTS asset_edits')
    expect(ASSET_EDITS_DDL_STATEMENTS[0]).toContain('asset_id TEXT PRIMARY KEY')
    expect(
      ASSET_EDITS_DDL_STATEMENTS.some((stmt) => stmt.includes('CREATE INDEX IF NOT EXISTS'))
    ).toBe(true)
  })
})
