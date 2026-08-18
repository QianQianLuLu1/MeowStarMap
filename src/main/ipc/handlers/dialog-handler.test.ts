/**
 * @layer L3
 * @module src/main/ipc/handlers/dialog-handler
 * @coverage dialog 域 IPC handler（selectDirectory / openFile / saveFile / showMessageBox）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '../../../shared/errors/app-error'
import { createSchemasMock, makeCtx, getHandler } from './_test-helpers'

const {
  handleMock,
  showOpenDialogMock,
  showSaveDialogMock,
  showMessageBoxMock,
  getFocusedWindowMock,
  assertFileReadPathMock,
  assertFileWritePathMock,
  pathGuardRegisterMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  showOpenDialogMock: vi.fn(),
  showSaveDialogMock: vi.fn(),
  showMessageBoxMock: vi.fn(),
  getFocusedWindowMock: vi.fn(),
  assertFileReadPathMock: vi.fn(),
  assertFileWritePathMock: vi.fn(),
  pathGuardRegisterMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: vi.fn() },
  BrowserWindow: { getFocusedWindow: () => getFocusedWindowMock() },
  dialog: {
    showOpenDialog: showOpenDialogMock,
    showSaveDialog: showSaveDialogMock,
    showMessageBox: showMessageBoxMock
  }
}))

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
  wrapHandlerNoArgs: vi.fn((ctx: unknown, handler: () => unknown) => async () => {
    try {
      const data = await handler()
      return { success: true as const, data }
    } catch (e) {
      if (e instanceof AppError) return { success: false as const, error: e.toIpcError() }
      return {
        success: false as const,
        error: { code: 'IPC_INTERNAL_ERROR', message: e instanceof Error ? e.message : String(e) }
      }
    }
  }),
  wrapHandlerRaw: vi.fn(),
  schemas: createSchemasMock(),
  assertFileReadPath: assertFileReadPathMock,
  assertFileWritePath: assertFileWritePathMock,
  // selectDirectory 选中目录后需登记路径白名单，mock 必须提供该成员
  pathGuard: { register: pathGuardRegisterMock }
}))

import { registerDialogHandlers } from './dialog-handler'
import { pathGuard } from '../validator'

describe('registerDialogHandlers', () => {
  beforeEach(() => {
    handleMock.mockClear()
    showOpenDialogMock.mockReset()
    showSaveDialogMock.mockReset()
    showMessageBoxMock.mockReset()
    getFocusedWindowMock.mockReturnValue(null)
    assertFileReadPathMock.mockReset()
    assertFileWritePathMock.mockReset()
    pathGuardRegisterMock.mockReset()
  })

  it('应注册 4 个 dialog channel', () => {
    registerDialogHandlers(makeCtx({}))
    const channels = handleMock.mock.calls.map((c) => c[0])
    expect(channels).toContain('dialog:selectDirectory')
    expect(channels).toContain('dialog:openFile')
    expect(channels).toContain('dialog:saveFile')
    expect(channels).toContain('dialog:showMessageBox')
  })

  it('dialog:selectDirectory 取消时返回 null', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] })
    getFocusedWindowMock.mockReturnValue({ webContents: { send: vi.fn() } })
    registerDialogHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'dialog:selectDirectory')()) as {
      success: true
      data: string | null
    }
    expect(result.data).toBeNull()
  })

  it('dialog:selectDirectory 选择目录时返回路径', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/selected'] })
    getFocusedWindowMock.mockReturnValue({ webContents: { send: vi.fn() } })
    registerDialogHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'dialog:selectDirectory')()) as {
      success: true
      data: string
    }
    expect(result.data).toBe('/selected')
    // 选中目录须登记白名单，否则后续 import 链路在路径校验处被拒
    expect(pathGuardRegisterMock).toHaveBeenCalledWith('/selected')
  })

  it('dialog:selectDirectory 选中目录后调用 pathGuard.register（spyOn 验证）', async () => {
    const registerSpy = vi.spyOn(pathGuard, 'register')
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/selected'] })
    getFocusedWindowMock.mockReturnValue({ webContents: { send: vi.fn() } })
    registerDialogHandlers(makeCtx({}))
    await getHandler(handleMock, 'dialog:selectDirectory')()
    expect(registerSpy).toHaveBeenCalledWith('/selected')
    registerSpy.mockRestore()
  })

  it('dialog:selectDirectory 主窗口不存在时抛 preconditionFailed', async () => {
    registerDialogHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'dialog:selectDirectory')()) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_PRECONDITION_FAILED')
  })

  it('dialog:openFile 取消时返回 null', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] })
    getFocusedWindowMock.mockReturnValue({ webContents: { send: vi.fn() } })
    registerDialogHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'dialog:openFile')([undefined])) as {
      success: true
      data: string | null
    }
    expect(result.data).toBeNull()
  })

  it('dialog:openFile 选择文件时返回路径', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/file.txt'] })
    getFocusedWindowMock.mockReturnValue({ webContents: { send: vi.fn() } })
    registerDialogHandlers(makeCtx({}))
    const result = (await getHandler(
      handleMock,
      'dialog:openFile'
    )([{ properties: ['openFile'] }])) as {
      success: true
      data: string
    }
    expect(result.data).toBe('/file.txt')
  })

  it('dialog:saveFile 取消时返回 null', async () => {
    showSaveDialogMock.mockResolvedValue({ canceled: true, filePath: '' })
    getFocusedWindowMock.mockReturnValue({ webContents: { send: vi.fn() } })
    registerDialogHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'dialog:saveFile')([undefined])) as {
      success: true
      data: string | null
    }
    expect(result.data).toBeNull()
  })

  it('dialog:saveFile 成功时返回路径', async () => {
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: '/out.txt' })
    getFocusedWindowMock.mockReturnValue({ webContents: { send: vi.fn() } })
    registerDialogHandlers(makeCtx({}))
    const result = (await getHandler(
      handleMock,
      'dialog:saveFile'
    )([{ defaultPath: '/out.txt' }])) as {
      success: true
      data: string
    }
    expect(result.data).toBe('/out.txt')
  })

  it('dialog:showMessageBox 返回 response 索引', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 1 })
    getFocusedWindowMock.mockReturnValue({ webContents: { send: vi.fn() } })
    registerDialogHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'dialog:showMessageBox')([{ message: 'hi' }])) as {
      success: true
      data: number
    }
    expect(result.data).toBe(1)
  })
})
