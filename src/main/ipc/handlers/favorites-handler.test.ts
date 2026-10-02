/**
 * @layer L3
 * @module src/main/ipc/handlers/favorites-handler
 * @coverage favorites 域 IPC handler（favorites:list / favorites:add / favorites:remove）
 *
 * schema 守卫：favorites 表 DDL 必须真实存在于主进程 schema（connection.ts），
 * 防止回归「handler 已注册但 schema 从未建表 → 调用必抛 no such table」的缺表 Bug。
 * 表 DDL 在 beforeEach 从 connection.ts 源码文本提取后建入 FakeFavoritesStore；
 * 提取不到即全套用例失败（红），与生产行为一致。
 *
 * 注：真实 better-sqlite3 按 Electron ABI 编译，vitest（Node ABI）下无法加载，
 * 与 import-root-repository.test.ts 同款采用文件内最小仿真，
 * 仅覆盖 favorites-handler 实际使用的 4 条语句。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeCtx, getHandler, type MakeCtxOpts } from './_test-helpers'
import { registerFavoritesHandlers } from './favorites-handler'

const { handleMock } = vi.hoisted(() => ({
  handleMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: vi.fn() },
  BrowserWindow: { getFocusedWindow: () => null }
}))

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

/** favorites 建表 DDL 的提取模式（与 favorites-handler 的查询/写入列一致） */
const FAVORITES_DDL_PATTERN = /CREATE TABLE IF NOT EXISTS favorites \(([^)]+)\)/

/** 最小仿真：仅支持 favorites-handler 用到的 SELECT / INSERT / DELETE 语句 */
class FakeFavoritesStore {
  private rows: Array<{ id: number; media_id: number; created_at: string }> = []
  private nextId = 1
  /** 建表时记录的列名，供 schema 守卫断言列结构 */
  columns: string[] = []

  /** 建表：解析 schema 守卫提取的 DDL，记录列名 */
  applyDdl(ddl: string): void {
    const createMatch = ddl.trim().match(/^CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]+)\)$/i)
    if (!createMatch || createMatch[1].toLowerCase() !== 'favorites') {
      throw new Error('schema 守卫提取的建表语句不是 favorites 表')
    }
    this.columns = createMatch[2].split(',').map((col) => col.trim().split(/\s+/)[0].toLowerCase())
  }

  /** better-sqlite3 兼容面：favorites-handler 只调用 prepare */
  prepare(statement: string) {
    const normalized = statement.replace(/\s+/g, ' ').trim()
    if (
      /^SELECT id, media_id, created_at FROM favorites ORDER BY created_at DESC$/i.test(normalized)
    ) {
      // datetime("now") 秒级精度下并列时按 id 倒序兜底，仿真生产排序意图
      return {
        all: () =>
          [...this.rows].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)
      }
    }
    if (/^SELECT id FROM favorites WHERE media_id = \?$/i.test(normalized)) {
      return { get: (mediaId: number) => this.rows.find((row) => row.media_id === mediaId) }
    }
    if (
      /^INSERT INTO favorites \(media_id, created_at\) VALUES \(\?, datetime\("now"\)\)$/i.test(
        normalized
      )
    ) {
      return {
        run: (mediaId: number) => {
          const row = { id: this.nextId++, media_id: mediaId, created_at: new Date().toISOString() }
          this.rows.push(row)
          return { changes: 1, lastInsertRowid: row.id }
        }
      }
    }
    if (/^DELETE FROM favorites WHERE media_id = \?$/i.test(normalized)) {
      return {
        run: (mediaId: number) => {
          const before = this.rows.length
          this.rows = this.rows.filter((row) => row.media_id !== mediaId)
          return { changes: before - this.rows.length, lastInsertRowid: 0 }
        }
      }
    }
    throw new Error(
      'FakeFavoritesStore prepare 未匹配任何 favorites 语句模式（SELECT/INSERT/DELETE）'
    )
  }
}

/** 从 connection.ts 源码文本提取 favorites DDL；缺失 = schema 缺表 = 抛错（红） */
function extractFavoritesDdl(): string {
  const source = readFileSync(
    path.resolve(process.cwd(), 'src', 'main', 'database', 'connection.ts'),
    'utf-8'
  )
  const match = source.match(FAVORITES_DDL_PATTERN)
  if (!match) {
    throw new Error(
      'schema 缺失 favorites 建表 DDL：connection.ts 未创建 favorites 表，' +
        'favorites:* 通道一旦调用必抛 no such table（缺表 Bug 回归）'
    )
  }
  return match[0]
}

let store: FakeFavoritesStore

beforeEach(() => {
  store = new FakeFavoritesStore()
  store.applyDdl(extractFavoritesDdl())
  handleMock.mockClear()
  registerFavoritesHandlers(makeCtx({ db: store as unknown as NonNullable<MakeCtxOpts['db']> }))
})

describe('favorites:list', () => {
  it('空表返回空列表（正常路径）', async () => {
    const res = (await getHandler(handleMock, 'favorites:list')({})) as {
      success: boolean
      data?: { favorites: unknown[] }
    }
    expect(res).toMatchObject({ success: true, data: { favorites: [] } })
  })

  it('返回已收藏的媒体（正常路径）', async () => {
    await getHandler(handleMock, 'favorites:add')({}, 1)
    await getHandler(handleMock, 'favorites:add')({}, 2)
    const res = (await getHandler(handleMock, 'favorites:list')({})) as {
      success: boolean
      data?: { favorites: Array<{ media_id: number }> }
    }
    expect(res.success).toBe(true)
    expect(res.data?.favorites.map((row) => row.media_id).sort()).toEqual([1, 2])
  })
})

describe('favorites:add', () => {
  it('新增收藏返回记录 id 且 list 可见（正常路径）', async () => {
    const res = (await getHandler(handleMock, 'favorites:add')({}, 1)) as {
      success: boolean
      data?: { id: number }
    }
    expect(res.success).toBe(true)
    expect(typeof res.data?.id).toBe('number')
    const listRes = (await getHandler(handleMock, 'favorites:list')({})) as {
      data?: { favorites: Array<{ media_id: number }> }
    }
    expect(listRes.data?.favorites.map((row) => row.media_id)).toContain(1)
  })

  it('重复收藏同一媒体返回 IPC_VALIDATION_ERROR（异常路径）', async () => {
    await getHandler(handleMock, 'favorites:add')({}, 1)
    const res = (await getHandler(handleMock, 'favorites:add')({}, 1)) as {
      success: boolean
      error?: { code: string }
    }
    expect(res.success).toBe(false)
    expect(res.error?.code).toBe('IPC_VALIDATION_ERROR')
  })

  it('mediaId 为 0 / -1 / 1.5 时被参数校验拒绝（边界）', async () => {
    for (const bad of [0, -1, 1.5]) {
      const res = (await getHandler(handleMock, 'favorites:add')({}, bad)) as {
        success: boolean
        error?: { code: string }
      }
      expect(res.success).toBe(false)
      expect(res.error?.code).toBe('IPC_VALIDATION_ERROR')
    }
  })
})

describe('favorites:remove', () => {
  it('移除已收藏媒体返回 removed: true 且 list 不再可见（正常路径）', async () => {
    await getHandler(handleMock, 'favorites:add')({}, 1)
    const res = (await getHandler(handleMock, 'favorites:remove')({}, 1)) as {
      success: boolean
      data?: { removed: boolean }
    }
    expect(res).toMatchObject({ success: true, data: { removed: true } })
    const listRes = (await getHandler(handleMock, 'favorites:list')({})) as {
      data?: { favorites: Array<{ media_id: number }> }
    }
    expect(listRes.data?.favorites.map((row) => row.media_id)).not.toContain(1)
  })

  it('移除不存在的媒体返回 IPC_NOT_FOUND（异常路径）', async () => {
    const res = (await getHandler(handleMock, 'favorites:remove')({}, 999)) as {
      success: boolean
      error?: { code: string }
    }
    expect(res.success).toBe(false)
    expect(res.error?.code).toBe('IPC_NOT_FOUND')
  })
})

describe('schema 守卫：favorites 表 DDL', () => {
  it('connection.ts 必须包含 favorites 建表 DDL 且列结构与 handler 查询匹配', () => {
    store.applyDdl(extractFavoritesDdl())
    expect(store.columns).toEqual(expect.arrayContaining(['id', 'media_id', 'created_at']))
  })
})
