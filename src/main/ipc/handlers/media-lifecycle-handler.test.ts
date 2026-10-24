/**
 * @layer L3
 * @module src/main/ipc/handlers/media-lifecycle-handler
 * @coverage 媒体生命周期域：media:emptyRecycleBin 移除主进程二次确认（回收站语义修复 D5）
 *
 * 修复前：渲染端 ConfirmDialog 已确认后，主进程再弹一次原生 dialog.showMessageBox——
 * 用户需重复确认，且取消时抛 AppError.canceled 被渲染端误报「清空失败」红 Toast。
 * 修复后：二次确认职责完全回归渲染端（与 media:permanentDelete 同构），主进程不弹窗。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HandlerContext } from '../handler-context'

const { handleMock, showMessageBoxMock, repoMock, trashBatchMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  showMessageBoxMock: vi.fn(),
  repoMock: {
    hardDelete: vi.fn(),
    softDeleteBatch: vi.fn(),
    restoreBatch: vi.fn(),
    softDeleteForPermanentDelete: vi.fn(),
    hardDeleteBatch: vi.fn(),
    getMediaPathsByIds: vi.fn().mockReturnValue([]),
    getSoftDeletedMediaPaths: vi.fn().mockReturnValue([]),
    getMediaIdByPath: vi.fn().mockReturnValue(undefined)
  },
  trashBatchMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: vi.fn() },
  dialog: { showMessageBox: showMessageBoxMock }
}))

vi.mock('../../database/media-repository', () => ({
  // vitest 5：生产代码以 new MediaRepository(...) 使用桩，箭头函数不可构造会抛
  // "is not a constructor"，必须用 function 表达式返回实例
  MediaRepository: vi.fn(function createMediaRepositoryMock() {
    return repoMock
  })
}))

vi.mock('./_trash-utils', () => ({
  trashBatch: trashBatchMock,
  cleanupThumbnailsForRows: vi.fn().mockResolvedValue(0),
  makeNativeThumbRecordCleaner: vi.fn(() => vi.fn().mockResolvedValue(undefined))
}))

vi.mock('../validator', async () => await import('../../../../tests/mocks/mock-validator'))

import { registerMediaLifecycleHandlers } from './media-lifecycle-handler'

function makeCtx(): HandlerContext {
  return {
    dbManager: {
      getDatabase: vi.fn(() => ({})),
      getWorkerBridge: vi.fn(() => undefined),
      getDbPath: vi.fn(() => '/mock/db.sqlite')
    },
    thumbnailGen: { getCacheDir: () => 'C:\\cache\\thumbnails' },
    getMainWindow: () => null,
    notifyMediaUpdated: vi.fn(),
    invalidateMediaPathCache: vi.fn(),
    applyUITheme: vi.fn(),
    isThumbnailsGenerating: () => false,
    setThumbnailsGenerating: vi.fn()
  } as unknown as HandlerContext
}

function getHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  for (const call of handleMock.mock.calls) {
    if (call[0] === channel) return call[1]
  }
  throw new Error(`未找到 channel: ${channel}`)
}

describe('registerMediaLifecycleHandlers', () => {
  beforeEach(() => {
    handleMock.mockClear()
    showMessageBoxMock.mockReset()
    // 敌意默认值：若 handler 误弹原生确认框且用户「取消」（response: 0），用例必须失败
    showMessageBoxMock.mockResolvedValue({ response: 0 })
    vi.clearAllMocks()
    repoMock.getSoftDeletedMediaPaths.mockReturnValue([])
    trashBatchMock.mockResolvedValue({
      idsToDelete: [],
      movedCount: 0,
      missingCount: 0,
      failedPaths: []
    })
  })

  it('media:emptyRecycleBin 不再弹原生确认框，直接执行清空（D5）', async () => {
    repoMock.getSoftDeletedMediaPaths.mockReturnValue([{ id: 1, file_path: '/a' }])
    trashBatchMock.mockResolvedValue({
      idsToDelete: [1],
      movedCount: 1,
      missingCount: 0,
      failedPaths: []
    })
    registerMediaLifecycleHandlers(makeCtx())

    const result = (await getHandler('media:emptyRecycleBin')()) as {
      success: boolean
      data: { movedCount: number }
    }

    expect(showMessageBoxMock).not.toHaveBeenCalled()
    expect(trashBatchMock).toHaveBeenCalledWith([{ id: 1, file_path: '/a' }])
    expect(repoMock.hardDeleteBatch).toHaveBeenCalledWith([1])
    expect(result.success).toBe(true)
    expect(result.data.movedCount).toBe(1)
  })

  it('media:emptyRecycleBin 回收站为空时返回提示且不弹框（空态边界）', async () => {
    repoMock.getSoftDeletedMediaPaths.mockReturnValue([])
    registerMediaLifecycleHandlers(makeCtx())

    const result = (await getHandler('media:emptyRecycleBin')()) as {
      success: boolean
      data: { message: string; movedCount: number }
    }

    expect(showMessageBoxMock).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
    expect(result.data.movedCount).toBe(0)
    expect(result.data.message).toContain('为空')
  })
})
