import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ImportRootRepository, normalizeRootPath } from './import-root-repository'
import type Database from 'better-sqlite3'
import type { DatabaseWorkerBridge } from './worker/database-worker-bridge'

/**
 * ImportRootRepository 单元测试
 *
 * 真实 better-sqlite3 是按 Electron ABI 编译的，vitest（Node ABI）下无法加载，
 * 因此用一个自带的最小 fake DB —— 只识别本 Repository 实际发出的 4 条 SQL 模板：
 *   - INSERT OR IGNORE INTO import_roots (root_path, created_at) VALUES (?, datetime(...))
 *   - SELECT root_path FROM import_roots ORDER BY id
 *   - DELETE FROM import_roots WHERE LOWER(root_path) = LOWER(?)
 * 不做通用 SQL 解析，避免 mock 复杂度反过来掩盖被测逻辑。
 */

interface ImportRootRow {
  id: number
  root_path: string
  created_at: string
}

class FakeDb {
  rows: ImportRootRow[] = []
  /** 表缺失开关：用于模拟旧库尚未执行迁移的场景 */
  tableMissing = false
  /** 记录实际执行过的 SQL，供断言写操作确实走了预期语句 */
  executed: Array<{ sql: string; params: unknown[] }> = []

  private nextId = 1

  prepare(sql: string): {
    run: (params?: unknown[]) => { changes: number; lastInsertRowid: number }
    all: (...params: unknown[]) => ImportRootRow[]
  } {
    return {
      run: (params: unknown[] = []) => this.run(sql, params),
      all: () => this.all(sql)
    }
  }

  private run(sql: string, params: unknown[]): { changes: number; lastInsertRowid: number } {
    this.assertTableExists()
    this.executed.push({ sql, params })

    if (/^INSERT OR IGNORE INTO import_roots/i.test(sql)) {
      const rootPath = String(params[0])
      // 复刻 UNIQUE(root_path) + OR IGNORE 语义：已存在则静默跳过
      if (this.rows.some((r) => r.root_path === rootPath)) {
        return { changes: 0, lastInsertRowid: 0 }
      }
      const id = this.nextId++
      this.rows.push({ id, root_path: rootPath, created_at: '2024-01-01 10:00:00' })
      return { changes: 1, lastInsertRowid: id }
    }

    if (/^DELETE FROM import_roots WHERE LOWER\(root_path\) = LOWER\(\?\)/i.test(sql)) {
      const target = String(params[0]).toLowerCase()
      const before = this.rows.length
      this.rows = this.rows.filter((r) => r.root_path.toLowerCase() !== target)
      return { changes: before - this.rows.length, lastInsertRowid: 0 }
    }

    throw new Error(`FakeDb: 未覆盖的 SQL: ${sql}`)
  }

  private all(sql: string): ImportRootRow[] {
    this.assertTableExists()
    if (/^SELECT root_path FROM import_roots ORDER BY id$/i.test(sql)) {
      return [...this.rows].sort((a, b) => a.id - b.id)
    }
    throw new Error(`FakeDb: 未覆盖的 SQL: ${sql}`)
  }

  private assertTableExists(): void {
    if (this.tableMissing) {
      throw new Error('no such table: import_roots')
    }
  }
}

/** FakeDb 只实现被测代码用到的接口子集，转型收敛在此处 */
function asDb(fake: FakeDb): Database.Database {
  return fake as unknown as Database.Database
}

describe('normalizeRootPath', () => {
  it('反斜杠转正斜杠', () => {
    expect(normalizeRootPath('H:\\Photos\\Nikki')).toBe('H:/Photos/Nikki')
  })

  it('去除尾部分隔符与首尾空白', () => {
    expect(normalizeRootPath('  H:\\Photos\\  ')).toBe('H:/Photos')
    expect(normalizeRootPath('H:/Photos///')).toBe('H:/Photos')
  })

  it('保留原始大小写', () => {
    expect(normalizeRootPath('H:/Photos/NikkiHQ')).toBe('H:/Photos/NikkiHQ')
  })

  it('纯空白归一化为空串', () => {
    expect(normalizeRootPath('   ')).toBe('')
  })
})

describe('ImportRootRepository', () => {
  let fake: FakeDb
  let repo: ImportRootRepository

  beforeEach(() => {
    fake = new FakeDb()
    repo = new ImportRootRepository(asDb(fake))
  })

  describe('addImportRoot', () => {
    it('登记后可被 listImportRoots 读到', async () => {
      await repo.addImportRoot('H:\\Photos\\Nikki')
      expect(repo.listImportRoots()).toEqual(['H:/Photos/Nikki'])
    })

    it('写入前归一化：反斜杠与尾部分隔符被规整', async () => {
      await repo.addImportRoot('  H:\\Photos\\Nikki\\  ')
      expect(fake.rows[0].root_path).toBe('H:/Photos/Nikki')
    })

    it('重复登记（归一化后相同）不产生第二行', async () => {
      await repo.addImportRoot('H:\\Photos\\Nikki')
      await repo.addImportRoot('H:/Photos/Nikki/')
      expect(repo.listImportRoots()).toEqual(['H:/Photos/Nikki'])
    })

    it('多个导入根按登记顺序返回', async () => {
      await repo.addImportRoot('H:/A')
      await repo.addImportRoot('H:/B')
      await repo.addImportRoot('H:/C')
      expect(repo.listImportRoots()).toEqual(['H:/A', 'H:/B', 'H:/C'])
    })

    it('空路径抛错且不写库', async () => {
      await expect(repo.addImportRoot('   ')).rejects.toThrow('addImportRoot')
      expect(fake.executed).toHaveLength(0)
      expect(repo.listImportRoots()).toEqual([])
    })

    it('走 INSERT OR IGNORE，参数为归一化后的路径', async () => {
      await repo.addImportRoot('H:\\Photos')
      expect(fake.executed).toHaveLength(1)
      expect(fake.executed[0].sql).toMatch(/^INSERT OR IGNORE INTO import_roots/)
      expect(fake.executed[0].params).toEqual(['H:/Photos'])
    })

    it('注入 workerBridge 时写操作经 worker，不直写主进程 db', async () => {
      const execute = vi.fn().mockResolvedValue({ changes: 1, lastInsertRowid: 1 })
      const bridge = { execute } as unknown as DatabaseWorkerBridge
      const workerRepo = new ImportRootRepository(asDb(fake), bridge, 'C:/db/app.db')

      await workerRepo.addImportRoot('H:\\Photos')

      expect(execute).toHaveBeenCalledTimes(1)
      expect(execute).toHaveBeenCalledWith(
        'C:/db/app.db',
        expect.stringMatching(/^INSERT OR IGNORE INTO import_roots/),
        ['H:/Photos']
      )
      // 未降级同步直写
      expect(fake.executed).toHaveLength(0)
    })
  })

  describe('listImportRoots', () => {
    it('空表返回空数组', () => {
      expect(repo.listImportRoots()).toEqual([])
    })

    it('跳过脏数据（null / 空串 root_path）', async () => {
      await repo.addImportRoot('H:/Valid')
      fake.rows.push({ id: 99, root_path: '', created_at: '2024-01-01 10:00:00' })
      fake.rows.push({
        id: 100,
        root_path: null as unknown as string,
        created_at: '2024-01-01 10:00:00'
      })
      expect(repo.listImportRoots()).toEqual(['H:/Valid'])
    })

    it('表不存在时抛错，由调用方决定降级', () => {
      fake.tableMissing = true
      expect(() => repo.listImportRoots()).toThrow('no such table')
    })
  })

  describe('removeImportRoot', () => {
    it('移除后不再返回', async () => {
      await repo.addImportRoot('H:/A')
      await repo.addImportRoot('H:/B')
      await repo.removeImportRoot('H:/A')
      expect(repo.listImportRoots()).toEqual(['H:/B'])
    })

    it('大小写不同也能移除（Windows 路径大小写不敏感）', async () => {
      await repo.addImportRoot('H:/Photos/Nikki')
      await repo.removeImportRoot('h:\\photos\\nikki')
      expect(repo.listImportRoots()).toEqual([])
    })

    it('移除不存在的根为无操作', async () => {
      await repo.addImportRoot('H:/A')
      await expect(repo.removeImportRoot('H:/NotThere')).resolves.toBeUndefined()
      expect(repo.listImportRoots()).toEqual(['H:/A'])
    })

    it('空路径抛错且不写库', async () => {
      await expect(repo.removeImportRoot('')).rejects.toThrow('removeImportRoot')
      expect(fake.executed).toHaveLength(0)
    })
  })
})
