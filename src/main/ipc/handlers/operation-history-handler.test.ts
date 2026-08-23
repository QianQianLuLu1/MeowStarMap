/**
 * @layer L3
 * @module src/main/ipc/handlers/operation-history-handler
 * @coverage operation-history 域 IPC handler（add / list / remove / clear / checkConflict）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeCtx, getHandler } from './_test-helpers'

const { handleMock } = vi.hoisted(() => ({
  handleMock: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock, on: vi.fn() } }))

// R8：MediaRepository 被 handler 直接 import 用于读取 updated_at，需 mock
const { getMediaUpdatedAtMock } = vi.hoisted(() => ({
  getMediaUpdatedAtMock: vi.fn()
}))
vi.mock('../../database/media-repository', () => ({
  MediaRepository: vi.fn().mockImplementation(() => ({
    getMediaUpdatedAt: getMediaUpdatedAtMock
  }))
}))

vi.mock('../validator', async () => await import('../../../../tests/mocks/mock-validator'))

import { registerOperationHistoryHandlers } from './operation-history-handler'
import { assertFileReadPath, assertFileWritePath } from '../validator'

const assertFileReadPathMock = vi.mocked(assertFileReadPath)
const assertFileWritePathMock = vi.mocked(assertFileWritePath)

describe('registerOperationHistoryHandlers', () => {
  beforeEach(() => {
    handleMock.mockClear()
    assertFileReadPathMock.mockReset()
    assertFileWritePathMock.mockReset()
    getMediaUpdatedAtMock.mockReset()
  })

  it('应注册 5 个 operation-history channel', () => {
    registerOperationHistoryHandlers(makeCtx({}))
    const channels = handleMock.mock.calls.map((c) => c[0])
    expect(channels).toContain('operation-history:add')
    expect(channels).toContain('operation-history:list')
    expect(channels).toContain('operation-history:remove')
    expect(channels).toContain('operation-history:clear')
    expect(channels).toContain('operation-history:checkConflict')
  })

  it('operation-history:add 成功时返回自增 id', async () => {
    const runMock = vi.fn(() => ({ lastInsertRowid: 5n }))
    const db = { prepare: vi.fn(() => ({ run: runMock })) }
    registerOperationHistoryHandlers(makeCtx({ db }))
    const payload = {
      operationType: 'edit',
      payload: { k: 1 },
      description: '描述',
      createdAt: '2026-01-01'
    }
    const result = (await getHandler(handleMock, 'operation-history:add')([payload])) as {
      success: true
      data: { id: number }
    }
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO operation_history')
    )
    // R8：INSERT 现在含 6 个字段（+ snapshot_updated_at），无 mediaId 时第 6 个参数为 null
    expect(runMock).toHaveBeenCalledWith(
      'edit',
      null,
      JSON.stringify({ k: 1 }),
      '描述',
      '2026-01-01',
      null
    )
    expect(result.data.id).toBe(5)
  })

  it('R8 operation-history:add 带 mediaId 时读取 updated_at 作为 snapshot', async () => {
    const runMock = vi.fn(() => ({ lastInsertRowid: 10n }))
    const db = { prepare: vi.fn(() => ({ run: runMock })) }
    getMediaUpdatedAtMock.mockReturnValue('2026-07-31 10:00:00')
    registerOperationHistoryHandlers(makeCtx({ db }))
    const payload = {
      operationType: 'rating_update',
      mediaId: 42,
      payload: { oldRating: 3 },
      description: '修改评分',
      createdAt: '2026-07-31T10:00:00.000Z'
    }
    await getHandler(handleMock, 'operation-history:add')([payload])
    // 验证读取了 mediaId=42 的 updated_at
    expect(getMediaUpdatedAtMock).toHaveBeenCalledWith(42)
    // 验证 snapshot_updated_at 作为第 6 个参数写入
    expect(runMock).toHaveBeenCalledWith(
      'rating_update',
      42,
      JSON.stringify({ oldRating: 3 }),
      '修改评分',
      '2026-07-31T10:00:00.000Z',
      '2026-07-31 10:00:00'
    )
  })

  it('operation-history:add 数据库未初始化时抛 preconditionFailed', async () => {
    registerOperationHistoryHandlers(makeCtx({ db: null }))
    const payload = { operationType: 't', payload: {}, description: 'd', createdAt: '2026-01-01' }
    const result = (await getHandler(handleMock, 'operation-history:add')([payload])) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_PRECONDITION_FAILED')
  })

  it('operation-history:list 默认 limit=50', async () => {
    const allMock = vi.fn(() => [
      {
        id: 1,
        operation_type: 't',
        media_id: null,
        payload: '{}',
        description: 'd',
        created_at: '2026-01-01',
        snapshot_updated_at: null
      }
    ])
    const db = { prepare: vi.fn(() => ({ all: allMock })) }
    registerOperationHistoryHandlers(makeCtx({ db }))
    const result = (await getHandler(handleMock, 'operation-history:list')([undefined])) as {
      success: true
      data: { records: Array<{ id: number; snapshotUpdatedAt: string | null }> }
    }
    expect(allMock).toHaveBeenCalledWith(50)
    expect(result.data.records[0].id).toBe(1)
    expect(result.data.records[0].snapshotUpdatedAt).toBeNull()
  })

  it('operation-history:list 自定义 limit 时透传', async () => {
    const allMock = vi.fn(() => [])
    const db = { prepare: vi.fn(() => ({ all: allMock })) }
    registerOperationHistoryHandlers(makeCtx({ db }))
    await getHandler(handleMock, 'operation-history:list')([10])
    expect(allMock).toHaveBeenCalledWith(10)
  })

  it('operation-history:list 数据库未初始化时抛 preconditionFailed', async () => {
    registerOperationHistoryHandlers(makeCtx({ db: null }))
    const result = (await getHandler(handleMock, 'operation-history:list')([undefined])) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_PRECONDITION_FAILED')
  })

  it('operation-history:remove 调用 DELETE 语句', async () => {
    const runMock = vi.fn()
    const db = { prepare: vi.fn(() => ({ run: runMock })) }
    registerOperationHistoryHandlers(makeCtx({ db }))
    const result = (await getHandler(handleMock, 'operation-history:remove')([3])) as {
      success: true
      data: { removed: boolean }
    }
    expect(db.prepare).toHaveBeenCalledWith('DELETE FROM operation_history WHERE id = ?')
    expect(runMock).toHaveBeenCalledWith(3)
    expect(result.data.removed).toBe(true)
  })

  it('operation-history:clear 清空所有记录', async () => {
    const runMock = vi.fn()
    const db = { prepare: vi.fn(() => ({ run: runMock })) }
    registerOperationHistoryHandlers(makeCtx({ db }))
    const result = (await getHandler(handleMock, 'operation-history:clear')()) as {
      success: true
      data: { cleared: boolean }
    }
    expect(db.prepare).toHaveBeenCalledWith('DELETE FROM operation_history')
    expect(result.data.cleared).toBe(true)
  })

  it('operation-history:clear 数据库未初始化时抛 preconditionFailed', async () => {
    registerOperationHistoryHandlers(makeCtx({ db: null }))
    const result = (await getHandler(handleMock, 'operation-history:clear')()) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_PRECONDITION_FAILED')
  })

  // R8：checkConflict 冲突检测
  describe('R8 operation-history:checkConflict', () => {
    it('操作记录不存在时返回 conflict=false, reason=not_found', async () => {
      const getMock = vi.fn(() => undefined)
      const db = { prepare: vi.fn(() => ({ get: getMock })) }
      registerOperationHistoryHandlers(makeCtx({ db }))
      const result = (await getHandler(handleMock, 'operation-history:checkConflict')([99])) as {
        success: true
        data: { conflict: boolean; reason: string }
      }
      expect(result.data.conflict).toBe(false)
      expect(result.data.reason).toBe('not_found')
    })

    it('snapshot_updated_at 为 NULL（旧记录）时跳过冲突检测', async () => {
      const getMock = vi.fn(() => ({
        media_id: 42,
        snapshot_updated_at: null
      }))
      const db = { prepare: vi.fn(() => ({ get: getMock })) }
      registerOperationHistoryHandlers(makeCtx({ db }))
      const result = (await getHandler(handleMock, 'operation-history:checkConflict')([1])) as {
        success: true
        data: { conflict: boolean; reason: string }
      }
      expect(result.data.conflict).toBe(false)
      expect(result.data.reason).toBe('no_snapshot')
    })

    it('media_id 为 NULL 时跳过冲突检测', async () => {
      const getMock = vi.fn(() => ({
        media_id: null,
        snapshot_updated_at: '2026-07-31 10:00:00'
      }))
      const db = { prepare: vi.fn(() => ({ get: getMock })) }
      registerOperationHistoryHandlers(makeCtx({ db }))
      const result = (await getHandler(handleMock, 'operation-history:checkConflict')([1])) as {
        success: true
        data: { conflict: boolean; reason: string }
      }
      expect(result.data.conflict).toBe(false)
      expect(result.data.reason).toBe('no_media')
    })

    it('当前 updated_at 与 snapshot 一致时返回 conflict=false', async () => {
      const getMock = vi.fn(() => ({
        media_id: 42,
        snapshot_updated_at: '2026-07-31 10:00:00'
      }))
      const db = { prepare: vi.fn(() => ({ get: getMock })) }
      getMediaUpdatedAtMock.mockReturnValue('2026-07-31 10:00:00')
      registerOperationHistoryHandlers(makeCtx({ db }))
      const result = (await getHandler(handleMock, 'operation-history:checkConflict')([1])) as {
        success: true
        data: { conflict: boolean; reason: string }
      }
      expect(result.data.conflict).toBe(false)
      expect(result.data.reason).toBe('match')
    })

    it('当前 updated_at 与 snapshot 不一致时返回 conflict=true', async () => {
      const getMock = vi.fn(() => ({
        media_id: 42,
        snapshot_updated_at: '2026-07-31 10:00:00'
      }))
      const db = { prepare: vi.fn(() => ({ get: getMock })) }
      getMediaUpdatedAtMock.mockReturnValue('2026-07-31 11:00:00')
      registerOperationHistoryHandlers(makeCtx({ db }))
      const result = (await getHandler(handleMock, 'operation-history:checkConflict')([1])) as {
        success: true
        data: { conflict: boolean; reason: string }
      }
      expect(result.data.conflict).toBe(true)
      expect(result.data.reason).toBe('modified')
    })

    it('media 已被物理删除（updated_at 为 NULL）时返回 conflict=false', async () => {
      const getMock = vi.fn(() => ({
        media_id: 42,
        snapshot_updated_at: '2026-07-31 10:00:00'
      }))
      const db = { prepare: vi.fn(() => ({ get: getMock })) }
      getMediaUpdatedAtMock.mockReturnValue(null)
      registerOperationHistoryHandlers(makeCtx({ db }))
      const result = (await getHandler(handleMock, 'operation-history:checkConflict')([1])) as {
        success: true
        data: { conflict: boolean; reason: string }
      }
      expect(result.data.conflict).toBe(false)
      expect(result.data.reason).toBe('media_missing')
    })

    it('数据库未初始化时抛 preconditionFailed', async () => {
      registerOperationHistoryHandlers(makeCtx({ db: null }))
      const result = (await getHandler(handleMock, 'operation-history:checkConflict')([1])) as {
        success: false
        error: { code: string }
      }
      expect(result.error.code).toBe('IPC_PRECONDITION_FAILED')
    })
  })
})
