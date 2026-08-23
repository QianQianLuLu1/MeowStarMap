/**
 * @layer L3
 * @module src/main/ipc/handlers/data-handler
 * @coverage data 域 IPC handler（data:clear）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeCtx, getHandler } from './_test-helpers'

const { handleMock, showMessageBoxMock, fsReaddirMock, fsRmMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  showMessageBoxMock: vi.fn(),
  fsReaddirMock: vi.fn(),
  fsRmMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: vi.fn() },
  dialog: { showMessageBox: showMessageBoxMock }
}))

vi.mock('fs', () => ({
  default: {
    promises: {
      readdir: fsReaddirMock,
      rm: fsRmMock
    }
  }
}))

vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('path')>('path')
  return { default: actual }
})

vi.mock('../validator', async () => await import('../../../../tests/mocks/mock-validator'))

import { registerDataHandlers } from './data-handler'
import { assertFileReadPath, assertFileWritePath } from '../validator'

const assertFileReadPathMock = vi.mocked(assertFileReadPath)
const assertFileWritePathMock = vi.mocked(assertFileWritePath)

describe('registerDataHandlers', () => {
  beforeEach(() => {
    handleMock.mockClear()
    showMessageBoxMock.mockReset()
    fsReaddirMock.mockReset()
    fsRmMock.mockReset()
    assertFileReadPathMock.mockReset()
    assertFileWritePathMock.mockReset()
  })

  it('应注册 data:clear channel', () => {
    registerDataHandlers(makeCtx({}))
    expect(handleMock.mock.calls.map((c) => c[0])).toContain('data:clear')
  })

  it('data:clear 用户取消时抛 canceled', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 0 })
    const db = { exec: vi.fn(), transaction: vi.fn((fn: () => void) => () => fn()) }
    registerDataHandlers(makeCtx({ db }))
    const result = (await getHandler(handleMock, 'data:clear')()) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_CANCELED')
    expect(db.exec).not.toHaveBeenCalled()
  })

  it('data:clear 用户确认后清空所有表并清空缩略图目录', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 1 })
    const db = { exec: vi.fn(), transaction: vi.fn((fn: () => void) => () => fn()) }
    fsReaddirMock.mockResolvedValue(['a', 'b'])
    fsRmMock.mockResolvedValue(undefined)
    const ctx = makeCtx({
      db,
      thumbnailGen: { generate: vi.fn(), getCacheDir: vi.fn(() => '/cache') }
    })
    registerDataHandlers(ctx)
    const result = (await getHandler(handleMock, 'data:clear')()) as {
      success: true
      data: { message: string }
    }
    expect(db.exec).toHaveBeenCalledWith('DELETE FROM media_files')
    expect(db.exec).toHaveBeenCalledWith('DELETE FROM scan_history')
    expect(db.exec).toHaveBeenCalledWith('DELETE FROM filter_presets WHERE is_builtin = 0')
    expect(db.exec).toHaveBeenCalledWith('DELETE FROM watermark_templates WHERE is_builtin = 0')
    expect(db.exec).toHaveBeenCalledWith('DELETE FROM edit_history')
    expect(fsReaddirMock).toHaveBeenCalledWith('/cache')
    expect(fsRmMock).toHaveBeenCalledTimes(2)
    expect(ctx.notifyMediaUpdated).toHaveBeenCalled()
    expect(result.data.message).toContain('已清除')
  })

  it('data:clear 数据库未初始化时抛 preconditionFailed', async () => {
    registerDataHandlers(makeCtx({ db: null }))
    const result = (await getHandler(handleMock, 'data:clear')()) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_PRECONDITION_FAILED')
  })

  it('data:clear 缩略图目录读取失败时不影响清理', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 1 })
    const db = { exec: vi.fn(), transaction: vi.fn((fn: () => void) => () => fn()) }
    fsReaddirMock.mockRejectedValue(new Error('ENOENT'))
    registerDataHandlers(
      makeCtx({ db, thumbnailGen: { generate: vi.fn(), getCacheDir: vi.fn(() => '/cache') } })
    )
    const result = (await getHandler(handleMock, 'data:clear')()) as {
      success: true
      data: { message: string }
    }
    expect(result.success).toBe(true)
  })
})
