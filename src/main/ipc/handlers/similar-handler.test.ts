/**
 * @layer L3
 * @module src/main/ipc/handlers/similar-handler
 * @coverage media:findSimilar（相似检测迁移到 media-worker 后的接线与轻量聚合）
 * @dependencies electron / MediaRepository / duplicate-scoring / thumbnail-phash-service / media-worker/manager
 *
 * 迁移后 media:findSimilar 不再在主进程执行 O(n²) 汉明比对，也不全量载入 pHash 行：
 * 主进程仅派发 worker（ctx.mediaWorkerManager.startSimilarFind）→ 消费候选边 + 行元数据
 * → 做 O(E·α(N)) 的 Union-Find 轻量聚合。本测试 mock mediaWorkerManager 验证
 * 阈值透传 / 空库快速路径 / 分组正确 / 取消四组行为（来自 media.test.ts 的迁移用例）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HandlerContext } from '../handler-context'
import type { SimilarRowMeta } from '../../media-worker/worker-protocol'
import type { ScanResult } from '../../shared/types/duplicate'

const {
  handleMock,
  showMessageBoxMock,
  pickBestIdMock,
  repoMock,
  generatePhashForUnprocessedMock,
  mediaWorkerManagerMock
} = vi.hoisted(() => {
  return {
    handleMock: vi.fn(),
    showMessageBoxMock: vi.fn(),
    pickBestIdMock: vi.fn(),
    repoMock: {
      getPhashCount: vi.fn().mockReturnValue(0),
      getPhashStaleSample: vi.fn().mockReturnValue([]),
      getPhashRows: vi.fn().mockReturnValue([])
    },
    generatePhashForUnprocessedMock: vi.fn(),
    mediaWorkerManagerMock: {
      startSimilarFind: vi.fn(),
      stopSimilarFind: vi.fn()
    }
  }
})

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: vi.fn() },
  dialog: { showMessageBox: showMessageBoxMock },
  // ProgressThrottle / taskRegistry 内部调用 BrowserWindow.getAllWindows 推送进度
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('../../database/media-repository', () => ({
  MediaRepository: vi.fn(() => repoMock)
}))

vi.mock('../../services/thumbnail-phash-service', () => ({
  generatePhashForUnprocessed: generatePhashForUnprocessedMock
}))

vi.mock('../../utils/duplicate-scoring', () => ({ pickBestId: pickBestIdMock }))

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

vi.mock('../validator', async () => await import('../../../../tests/mocks/mock-validator'))

import { registerSimilarHandlers } from './similar-handler'

function makeCtx(): HandlerContext {
  return {
    dbManager: {
      getDatabase: vi.fn(() => ({})),
      getWorkerBridge: vi.fn(() => undefined),
      getDbPath: vi.fn(() => '/mock/db.sqlite')
    },
    mediaWorkerManager: mediaWorkerManagerMock as unknown as HandlerContext['mediaWorkerManager'],
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

const rowA: SimilarRowMeta = {
  id: 1,
  file_path: '/a',
  file_name: 'a',
  file_type: 'image',
  file_size: 100,
  modified_at: '2026-01-01',
  width: 1,
  height: 1,
  is_favorite: 0,
  rating: 0
}
const rowB: SimilarRowMeta = {
  id: 2,
  file_path: '/b',
  file_name: 'b',
  file_type: 'image',
  file_size: 100,
  modified_at: '2026-01-02',
  width: 1,
  height: 1,
  is_favorite: 0,
  rating: 0
}

describe('media:findSimilar（迁移到 media-worker 后）', () => {
  beforeEach(() => {
    handleMock.mockClear()
    showMessageBoxMock.mockReset()
    pickBestIdMock.mockReset()
    generatePhashForUnprocessedMock.mockReset()
    mediaWorkerManagerMock.startSimilarFind.mockReset()
    mediaWorkerManagerMock.stopSimilarFind.mockReset()
    repoMock.getPhashCount.mockReturnValue(0)
    repoMock.getPhashStaleSample.mockReturnValue([])
    repoMock.getPhashRows.mockReturnValue([])
  })

  it('应注册 media:findSimilar 与 media:generatePhash', () => {
    registerSimilarHandlers(makeCtx())
    const channels = handleMock.mock.calls.map((c) => c[0])
    expect(channels).toContain('media:findSimilar')
    expect(channels).toContain('media:generatePhash')
  })

  it('空库（getPhashCount < 2）时快速返回空结果，不派发 worker', async () => {
    repoMock.getPhashCount.mockReturnValue(0)
    registerSimilarHandlers(makeCtx())
    const result = (await getHandler('media:findSimilar')([undefined])) as {
      success: true
      data: { success: boolean; totalGroups: number; threshold: number }
    }
    expect(mediaWorkerManagerMock.startSimilarFind).not.toHaveBeenCalled()
    expect(result.data.totalGroups).toBe(0)
    expect(result.data.threshold).toBe(5)
    expect(result.data.success).toBe(true)
  })

  it('自定义 threshold 透传给 mediaWorkerManager.startSimilarFind', async () => {
    repoMock.getPhashCount.mockReturnValue(5)
    mediaWorkerManagerMock.startSimilarFind.mockResolvedValue({
      success: true,
      message: 'ok',
      cancelled: false,
      rows: [],
      candidates: []
    })
    registerSimilarHandlers(makeCtx())
    const result = (await getHandler('media:findSimilar')([{ threshold: 10 }])) as {
      success: true
      data: { success: boolean; threshold: number }
    }
    expect(mediaWorkerManagerMock.startSimilarFind).toHaveBeenCalledWith({ threshold: 10 })
    expect(result.data.threshold).toBe(10)
    expect(result.data.success).toBe(true)
  })

  it('worker 返回候选边时主进程聚合成 1 组（O(E·α(N)) Union-Find）', async () => {
    repoMock.getPhashCount.mockReturnValue(2)
    pickBestIdMock.mockReturnValue(1)
    mediaWorkerManagerMock.startSimilarFind.mockResolvedValue({
      success: true,
      message: 'ok',
      cancelled: false,
      rows: [rowA, rowB],
      candidates: [{ a: 1, b: 2, dist: 3 }]
    })
    registerSimilarHandlers(makeCtx())
    const result = (await getHandler('media:findSimilar')([{ threshold: 5 }])) as {
      success: true
      data: { success: boolean; totalGroups: number; totalFiles: number; wastedBytes: number }
    }
    expect(result.data.totalGroups).toBe(1)
    expect(result.data.totalFiles).toBe(2)
    expect(result.data.wastedBytes).toBe(100)
    expect(result.data.success).toBe(true)
  })

  it('worker 回传行含 thumbnail 时，输出 items 透传 thumbnail（缺失为 null）', async () => {
    repoMock.getPhashCount.mockReturnValue(2)
    pickBestIdMock.mockReturnValue(1)
    mediaWorkerManagerMock.startSimilarFind.mockResolvedValue({
      success: true,
      message: 'ok',
      cancelled: false,
      rows: [
        { ...rowA, thumbnail: '/cache/a.jpg' },
        { ...rowB, thumbnail: null }
      ],
      candidates: [{ a: 1, b: 2, dist: 3 }]
    })
    registerSimilarHandlers(makeCtx())
    const result = (await getHandler('media:findSimilar')([{ threshold: 5 }])) as {
      success: boolean
      data: ScanResult
    }
    const group = result.data.duplicates[0]
    const withThumb = group.find((it) => it.id === 1)!
    const withoutThumb = group.find((it) => it.id === 2)!
    expect(withThumb.thumbnail).toBe('/cache/a.jpg')
    expect(withoutThumb.thumbnail).toBeNull()
  })

  it('worker 返回 cancelled=true 时返回空结果且标记 cancelled', async () => {
    repoMock.getPhashCount.mockReturnValue(2)
    mediaWorkerManagerMock.startSimilarFind.mockResolvedValue({
      success: true,
      message: '已取消',
      cancelled: true,
      rows: [rowA, rowB],
      candidates: [{ a: 1, b: 2, dist: 3 }]
    })
    registerSimilarHandlers(makeCtx())
    const result = (await getHandler('media:findSimilar')([undefined])) as {
      success: true
      data: { success: boolean; totalGroups: number; cancelled?: boolean }
    }
    expect(result.data.cancelled).toBe(true)
    expect(result.data.totalGroups).toBe(0)
    expect(result.data.success).toBe(true)
  })

  it('worker 返回 success=false 时透传失败信息', async () => {
    repoMock.getPhashCount.mockReturnValue(5)
    mediaWorkerManagerMock.startSimilarFind.mockResolvedValue({
      success: false,
      message: '相似检测启动失败: boom',
      cancelled: false,
      rows: [],
      candidates: []
    })
    registerSimilarHandlers(makeCtx())
    const result = (await getHandler('media:findSimilar')([undefined])) as {
      success: true
      data: { success: boolean; message: string; totalGroups: number }
    }
    expect(result.data.success).toBe(false)
    expect(result.data.message).toContain('boom')
    expect(result.data.totalGroups).toBe(0)
  })

  it('超大单组（N=200000 行全部相连）不应触发 Maximum call stack size exceeded', async () => {
    const N = 200_000
    repoMock.getPhashCount.mockReturnValue(N)
    pickBestIdMock.mockReturnValue(1)
    const rows: SimilarRowMeta[] = []
    for (let i = 1; i <= N; i++) {
      rows.push({
        id: i,
        file_path: `/f${i}`,
        file_name: `f${i}`,
        file_type: 'image',
        file_size: 100 + (i % 2),
        modified_at: '2026-01-01',
        width: 1,
        height: 1,
        is_favorite: 0,
        rating: 0
      })
    }
    // 链式相连：1-2-...-N 全部聚成单一超大组
    const candidates: Array<{ a: number; b: number; dist: number }> = []
    for (let i = 1; i < N; i++) candidates.push({ a: i, b: i + 1, dist: 3 })
    mediaWorkerManagerMock.startSimilarFind.mockResolvedValue({
      success: true,
      message: 'ok',
      cancelled: false,
      rows,
      candidates
    })
    registerSimilarHandlers(makeCtx())
    const result = (await getHandler('media:findSimilar')([{ threshold: 5 }])) as {
      success: boolean
      data: ScanResult
    }
    expect(result.data.totalGroups).toBe(1)
    expect(result.data.totalFiles).toBe(N)
  })
})
