/**
 * @layer L3
 * @module src/main/ipc/handlers/asset-edits-handler
 * @coverage 资产编辑叠加层（阶段 4）：两条通道的注册、参数校验、缺表回退、
 *           数值型布尔的响应塑形、以及「库未就绪 ⇒ PRECONDITION_FAILED」。
 *
 * 断言口径：叠加层是本 App 专有数据，不属于 NikkiSync 协议 DTO，因此这里**允许**塑形
 * （0/1 → boolean、tags JSON 文本 → string[]），但字段语义必须与 media_files 同口径，
 * 否则同一份渲染层代码在两个数据源下会读出不同结果。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeCtx, getHandler } from './_test-helpers'
import { registerAssetEditsHandlers } from './asset-edits-handler'
import { IPC_ERROR_CODES } from '../../../shared/types/ipc-types'

const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: vi.fn() },
  BrowserWindow: { getFocusedWindow: () => null }
}))

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

/** 只记录被调 SQL 的最小 db 桩：仓储层已有自己的真值测试，这里只测 handler 塑形与校验。 */
function createDbStub(rows: unknown[] = []) {
  const executed: Array<{ sql: string; params: unknown[] }> = []
  const db = {
    prepare: (sql: string) => ({
      run: (...params: unknown[]) => {
        executed.push({ sql, params })
        return { changes: 1 }
      },
      get: (...params: unknown[]) => {
        executed.push({ sql, params })
        if (sql.startsWith('SELECT COUNT(*)')) return { count: rows.length }
        return rows[0]
      },
      all: (...params: unknown[]) => {
        executed.push({ sql, params })
        return rows
      }
    }),
    transaction: (work: () => unknown) => work()
  }
  return { db, executed }
}

function makeContext(db: unknown) {
  // makeCtx 的注入键是 `db`：getDatabase() 返回它，getWorkerBridge() 给 null（⇒ 写路径降级直写），
  // getDbPath() 给固定串。传 `db: null` 即模拟「库未就绪」。
  return makeCtx({ db } as never)
}

const ROW = {
  asset_id: 'a/1',
  is_favorite: 1,
  rating: 4,
  tags: '["花","夜"]',
  notes: 'n',
  category_id: 7,
  outfit: 'spring',
  scene_category: 'screenshot',
  scene_time: 'night',
  is_hidden: 0,
  deleted_at: null,
  updated_at: '2026-10-14T00:00:00.000Z'
}

beforeEach(() => {
  handleMock.mockClear()
})

describe('asset-edits handler 注册面', () => {
  it('恰好注册 3 条通道（列表 / 写入 / 隐藏集分页）', () => {
    registerAssetEditsHandlers(makeContext(createDbStub().db))
    expect(handleMock.mock.calls.map((call) => call[0])).toEqual([
      'asset-edits:list',
      'asset-edits:set',
      'asset-edits:listHidden'
    ])
  })
})

describe('asset-edits:list', () => {
  it('空 assetIds 直接给空数组，不查库', async () => {
    const { db, executed } = createDbStub()
    registerAssetEditsHandlers(makeContext(db))
    const handler = getHandler(handleMock, 'asset-edits:list')
    const res = (await handler({}, [])) as { success: boolean; data?: unknown }
    expect(res.success).toBe(true)
    expect(res.data).toEqual({ edits: [] })
    expect(executed).toHaveLength(0)
  })

  it('raw 行被塑形为 boolean 与 string[]（与 media_files 同口径）', async () => {
    const { db } = createDbStub([ROW])
    registerAssetEditsHandlers(makeContext(db))
    const handler = getHandler(handleMock, 'asset-edits:list')
    const res = (await handler({}, ['a/1'])) as { data: { edits: unknown[] } }
    expect(res.data.edits).toEqual([
      {
        assetId: 'a/1',
        isFavorite: true,
        rating: 4,
        tags: ['花', '夜'],
        notes: 'n',
        categoryId: 7,
        outfit: 'spring',
        sceneCategory: 'screenshot',
        sceneTime: 'night',
        isHidden: false,
        deletedAt: null,
        updatedAt: '2026-10-14T00:00:00.000Z'
      }
    ])
  })

  it('tags 列脏数据（非法 JSON）降级为空数组而不是抛错', async () => {
    const { db } = createDbStub([{ ...ROW, tags: 'not-json' }])
    registerAssetEditsHandlers(makeContext(db))
    const handler = getHandler(handleMock, 'asset-edits:list')
    const res = (await handler({}, ['a/1'])) as { data: { edits: Array<{ tags: string[] }> } }
    expect(res.data.edits[0].tags).toEqual([])
  })

  it('非数组入参与超长 id 走 VALIDATION_ERROR', async () => {
    const { db } = createDbStub()
    registerAssetEditsHandlers(makeContext(db))
    const handler = getHandler(handleMock, 'asset-edits:list')
    for (const raw of ['a/1', [`${'x'.repeat(129)}`], [``], {}]) {
      const res = (await handler({}, raw)) as { success: boolean; error?: { code: string } }
      expect(res.success).toBe(false)
      expect(res.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    }
  })

  it('库未就绪时给 PRECONDITION_FAILED（不静默空列表）', async () => {
    registerAssetEditsHandlers(makeContext(null))
    const handler = getHandler(handleMock, 'asset-edits:list')
    const res = (await handler({}, ['a/1'])) as { error?: { code: string } }
    expect(res.error?.code).toBe(IPC_ERROR_CODES.PRECONDITION_FAILED)
  })
})

describe('asset-edits:set', () => {
  it('合法补丁写入并回塑形后的行', async () => {
    const { db } = createDbStub([ROW])
    registerAssetEditsHandlers(makeContext(db))
    const handler = getHandler(handleMock, 'asset-edits:set')
    const res = (await handler({}, { assetId: 'a/1', patch: { rating: 4 } })) as {
      success: boolean
      data: { edit: { rating: number } }
    }
    expect(res.success).toBe(true)
    expect(res.data.edit.rating).toBe(4)
  })

  it('rating 越界、tags 超量、空 assetId 一律 VALIDATION_ERROR', async () => {
    const { db } = createDbStub()
    registerAssetEditsHandlers(makeContext(db))
    const handler = getHandler(handleMock, 'asset-edits:set')
    const bad: unknown[] = [
      { assetId: '', patch: {} },
      { assetId: 'a/1', patch: { rating: 6 } },
      { assetId: 'a/1', patch: { rating: -1 } },
      { assetId: 'a/1', patch: { tags: Array.from({ length: 51 }, (_, i) => `t${i}`) } },
      { assetId: 'a/1', patch: { notes: 'x'.repeat(5001) } }
    ]
    for (const input of bad) {
      const res = (await handler({}, input)) as { success: boolean; error?: { code: string } }
      expect(res.success, JSON.stringify(input)).toBe(false)
      expect(res.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    }
  })

  it('时间戳由主进程生成（渲染层不参与写入时刻）', async () => {
    const { db, executed } = createDbStub()
    registerAssetEditsHandlers(makeContext(db))
    const handler = getHandler(handleMock, 'asset-edits:set')
    const before = Date.now()
    await handler({}, { assetId: 'a/1', patch: { isFavorite: true } })
    const write = executed.find((item) => item.sql.startsWith('INSERT INTO asset_edits'))
    expect(write).toBeDefined()
    const updatedAt = String(write?.params[write?.params.length - 1])
    expect(Number.isNaN(Date.parse(updatedAt))).toBe(false)
    expect(Date.parse(updatedAt)).toBeGreaterThanOrEqual(before - 1000)
  })
})

describe('asset-edits:set 合并语义（部分补丁不 wipe 既有编辑）', () => {
  // params 位序与 SQL_UPSERT 逐位对应：
  // 0 asset_id / 1 is_favorite / 2 rating / 3 tags / 4 notes / 5 category_id /
  // 6 outfit / 7 scene_category / 8 scene_time / 9 is_hidden / 10 deleted_at / 11 updated_at
  function findWrite(executed: Array<{ sql: string; params: unknown[] }>) {
    const write = executed.find((item) => item.sql.startsWith('INSERT INTO asset_edits'))
    expect(write).toBeDefined()
    return write!.params
  }

  it('已有行上只改 isFavorite，rating/tags/notes/categoryId 原样保留', async () => {
    const { db, executed } = createDbStub([ROW])
    registerAssetEditsHandlers(makeContext(db))
    const handler = getHandler(handleMock, 'asset-edits:set')
    const res = (await handler({}, { assetId: 'a/1', patch: { isFavorite: false } })) as {
      success: boolean
    }
    expect(res.success).toBe(true)
    const params = findWrite(executed)
    expect(params[1]).toBe(0)
    expect(params[2]).toBe(4)
    expect(params[3]).toBe('["花","夜"]')
    expect(params[4]).toBe('n')
    expect(params[5]).toBe(7)
    expect(params[6]).toBe('spring')
  })

  it('无既有行时部分补丁的其余字段落列默认值', async () => {
    const { db, executed } = createDbStub([])
    registerAssetEditsHandlers(makeContext(db))
    const handler = getHandler(handleMock, 'asset-edits:set')
    await handler({}, { assetId: 'a/1', patch: { isFavorite: true } })
    const params = findWrite(executed)
    expect(params[1]).toBe(1)
    expect(params[2]).toBe(0)
    expect(params[3]).toBe('[]')
    expect(params[4]).toBe('')
    expect(params[5]).toBeNull()
  })

  it('isHidden=true 落 deletedAt=now（既有 deleted_at 为空时）', async () => {
    const { db, executed } = createDbStub([ROW])
    registerAssetEditsHandlers(makeContext(db))
    const handler = getHandler(handleMock, 'asset-edits:set')
    const before = Date.now()
    await handler({}, { assetId: 'a/1', patch: { isHidden: true } })
    const params = findWrite(executed)
    expect(params[9]).toBe(1)
    const deletedAt = String(params[10])
    expect(Number.isNaN(Date.parse(deletedAt))).toBe(false)
    expect(Date.parse(deletedAt)).toBeGreaterThanOrEqual(before - 1000)
  })

  it('重复隐藏保留首次 deletedAt，不刷新时间戳', async () => {
    const first = '2026-11-01T00:00:00.000Z'
    const { db, executed } = createDbStub([{ ...ROW, is_hidden: 1, deleted_at: first }])
    registerAssetEditsHandlers(makeContext(db))
    const handler = getHandler(handleMock, 'asset-edits:set')
    await handler({}, { assetId: 'a/1', patch: { isHidden: true } })
    const params = findWrite(executed)
    expect(params[9]).toBe(1)
    expect(params[10]).toBe(first)
  })

  it('isHidden=false 清空 deletedAt（恢复语义）', async () => {
    const { db, executed } = createDbStub([
      { ...ROW, is_hidden: 1, deleted_at: '2026-11-01T00:00:00.000Z' }
    ])
    registerAssetEditsHandlers(makeContext(db))
    const handler = getHandler(handleMock, 'asset-edits:set')
    await handler({}, { assetId: 'a/1', patch: { isHidden: false } })
    const params = findWrite(executed)
    expect(params[9]).toBe(0)
    expect(params[10]).toBeNull()
  })

  it('未给 isHidden 时保留既有隐藏态与 deletedAt', async () => {
    const first = '2026-11-01T00:00:00.000Z'
    const { db, executed } = createDbStub([{ ...ROW, is_hidden: 1, deleted_at: first }])
    registerAssetEditsHandlers(makeContext(db))
    const handler = getHandler(handleMock, 'asset-edits:set')
    await handler({}, { assetId: 'a/1', patch: { rating: 5 } })
    const params = findWrite(executed)
    expect(params[2]).toBe(5)
    expect(params[9]).toBe(1)
    expect(params[10]).toBe(first)
  })

  it('显式 undefined 键不覆盖既有值（zod/structured clone 会保留 undefined 键）', async () => {
    const { db, executed } = createDbStub([ROW])
    registerAssetEditsHandlers(makeContext(db))
    const handler = getHandler(handleMock, 'asset-edits:set')
    await handler({}, { assetId: 'a/1', patch: { isFavorite: undefined, rating: 5 } })
    const params = findWrite(executed)
    expect(params[1]).toBe(1)
    expect(params[2]).toBe(5)
  })
})

describe('asset-edits:listHidden', () => {
  it('返回塑形后的隐藏行与总数', async () => {
    const hidden = { ...ROW, is_hidden: 1, deleted_at: '2026-11-01T00:00:00.000Z' }
    const { db } = createDbStub([hidden])
    registerAssetEditsHandlers(makeContext(db))
    const handler = getHandler(handleMock, 'asset-edits:listHidden')
    const res = (await handler({}, { limit: 200, offset: 0 })) as {
      success: boolean
      data: { edits: Array<{ assetId: string; isHidden: boolean }>; total: number }
    }
    expect(res.success).toBe(true)
    expect(res.data.edits).toHaveLength(1)
    expect(res.data.edits[0].assetId).toBe('a/1')
    expect(res.data.edits[0].isHidden).toBe(true)
    expect(res.data.total).toBe(1)
  })

  it('limit/offset 越界、非整数、缺参一律 VALIDATION_ERROR', async () => {
    const { db } = createDbStub()
    registerAssetEditsHandlers(makeContext(db))
    const handler = getHandler(handleMock, 'asset-edits:listHidden')
    const bad: unknown[] = [
      { limit: 0, offset: 0 },
      { limit: 501, offset: 0 },
      { limit: 1.5, offset: 0 },
      { limit: 200, offset: -1 },
      { limit: 200 },
      {}
    ]
    for (const input of bad) {
      const res = (await handler({}, input)) as { success: boolean; error?: { code: string } }
      expect(res.success, JSON.stringify(input)).toBe(false)
      expect(res.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    }
  })

  it('空隐藏集给 { edits: [], total: 0 }', async () => {
    const { db } = createDbStub([])
    registerAssetEditsHandlers(makeContext(db))
    const handler = getHandler(handleMock, 'asset-edits:listHidden')
    const res = (await handler({}, { limit: 200, offset: 0 })) as {
      data: { edits: unknown[]; total: number }
    }
    expect(res.data).toEqual({ edits: [], total: 0 })
  })

  it('库未就绪时给 PRECONDITION_FAILED', async () => {
    registerAssetEditsHandlers(makeContext(null))
    const handler = getHandler(handleMock, 'asset-edits:listHidden')
    const res = (await handler({}, { limit: 200, offset: 0 })) as { error?: { code: string } }
    expect(res.error?.code).toBe(IPC_ERROR_CODES.PRECONDITION_FAILED)
  })
})
