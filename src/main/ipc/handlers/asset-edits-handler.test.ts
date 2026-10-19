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
  it('恰好注册 2 条通道（列表 / 写入）', () => {
    registerAssetEditsHandlers(makeContext(createDbStub().db))
    expect(handleMock.mock.calls.map((call) => call[0])).toEqual([
      'asset-edits:list',
      'asset-edits:set'
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
