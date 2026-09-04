/**
 * @layer L3
 * @module src/main/ipc/handlers/thumbnail-handler
 * @coverage thumbnail 域 IPC handler（thumbnail:generate）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeCtx, getHandler } from './_test-helpers'

const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock, on: vi.fn() } }))

vi.mock('../validator', async () => await import('../../../../tests/mocks/mock-validator'))

import { registerThumbnailHandlers } from './thumbnail-handler'
import { assertFileReadPath, assertFileWritePath } from '../validator'

const assertFileReadPathMock = vi.mocked(assertFileReadPath)
const assertFileWritePathMock = vi.mocked(assertFileWritePath)

describe('registerThumbnailHandlers', () => {
  beforeEach(() => {
    handleMock.mockClear()
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
    registerThumbnailHandlers(makeCtx({ thumbnailGen }))
    const result = (await getHandler(handleMock, 'thumbnail:generate')(['/file', 'high'])) as {
      success: true
      data: string
    }
    expect(assertFileReadPathMock).toHaveBeenCalledWith('/file')
    expect(thumbnailGen.generate).toHaveBeenCalledWith('/file', 'high')
    expect(result.data).toBe('/thumb/path')
  })
})
