/**
 * @layer L3
 * @module src/main/ipc/handlers/thumbnail-handler
 * @coverage thumbnail 域 IPC handler（thumbnail:generate）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeCtx, getHandler } from './_test-helpers'

const { handleMock, mediaAccessMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  // round2 N2：thumbnail:generate 的读取守卫改为「已授权媒体」口径（与 media:// 展示同口径）
  mediaAccessMock: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock, on: vi.fn() } }))

vi.mock('../validator', async () => await import('../../../../tests/mocks/mock-validator'))

// 显式接管媒体守卫，避免真实 isMediaPathAllowed 的进程级白名单缓存在多文件间串味
vi.mock('../media-read-guard', () => ({
  assertMediaAccessPath: mediaAccessMock,
  assertMediaReadPath: vi.fn(),
  assertMediaDeletePath: vi.fn()
}))

import { registerThumbnailHandlers } from './thumbnail-handler'
import { assertFileReadPath, assertFileWritePath } from '../validator'

const assertFileReadPathMock = vi.mocked(assertFileReadPath)
const assertFileWritePathMock = vi.mocked(assertFileWritePath)

describe('registerThumbnailHandlers', () => {
  beforeEach(() => {
    handleMock.mockClear()
    mediaAccessMock.mockReset()
    assertFileReadPathMock.mockReset()
    assertFileWritePathMock.mockReset()
  })

  it('应注册 thumbnail:generate channel', () => {
    registerThumbnailHandlers(makeCtx({}))
    const channels = handleMock.mock.calls.map((c) => c[0])
    expect(channels).toContain('thumbnail:generate')
  })

  it('thumbnail:generate 调用 thumbnailGen.generate', async () => {
    const thumbnailGen = {
      generate: vi.fn().mockResolvedValue('/thumb/path'),
      getCacheDir: vi.fn()
    }
    const ctx = makeCtx({ thumbnailGen })
    registerThumbnailHandlers(ctx)
    const result = (await getHandler(handleMock, 'thumbnail:generate')(['/file', 'high'])) as {
      success: true
      data: string
    }
    // 守卫口径：媒体读取走「已授权媒体」守卫，不再用裸 PathGuard
    // （裸 PathGuard 对未注册盘上的已入库媒体恒拒绝，本机实测 4/4 被拒、DB thumbnail 恒 NULL）
    expect(mediaAccessMock).toHaveBeenCalledWith(ctx, '/file')
    expect(assertFileReadPathMock).not.toHaveBeenCalled()
    expect(thumbnailGen.generate).toHaveBeenCalledWith('/file', 'high')
    expect(result.data).toBe('/thumb/path')
  })
})
