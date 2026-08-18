/**
 * @layer L3
 * @module src/main/ipc/handlers/thumbnail-handler
 * @coverage thumbnail 域 IPC handler（thumbnail:generate）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '../../../shared/errors/app-error'
import { createSchemasMock, makeCtx, getHandler } from './_test-helpers'

const { handleMock, assertFileReadPathMock, assertFileWritePathMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  assertFileReadPathMock: vi.fn(),
  assertFileWritePathMock: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock, on: vi.fn() } }))

vi.mock('../validator', () => ({
  wrapHandler: vi.fn(
    (ctx: unknown, _schema: unknown, handler: (args: unknown[]) => unknown) =>
      async (...args: unknown[]) => {
        try {
          const data = await handler(args.length === 1 && Array.isArray(args[0]) ? args[0] : args)
          return { success: true as const, data }
        } catch (e) {
          if (e instanceof AppError) return { success: false as const, error: e.toIpcError() }
          return {
            success: false as const,
            error: {
              code: 'IPC_INTERNAL_ERROR',
              message: e instanceof Error ? e.message : String(e)
            }
          }
        }
      }
  ),
  wrapHandlerNoArgs: vi.fn(),
  wrapHandlerRaw: vi.fn(),
  schemas: createSchemasMock(),
  assertFileReadPath: assertFileReadPathMock,
  assertFileWritePath: assertFileWritePathMock
}))

import { registerThumbnailHandlers } from './thumbnail-handler'

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
