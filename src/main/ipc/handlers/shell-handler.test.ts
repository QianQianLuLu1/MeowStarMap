/**
 * @layer L3
 * @module src/main/ipc/handlers/shell-handler
 * @coverage shell 域 IPC handler（openExternal / openPath / showItemInFolder）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '../../../shared/errors/app-error'
import { createSchemasMock, makeCtx, getHandler } from './_test-helpers'

const {
  handleMock,
  shellOpenExternalMock,
  shellOpenPathMock,
  shellShowItemInFolderMock,
  validateNonSensitivePathMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  shellOpenExternalMock: vi.fn(),
  shellOpenPathMock: vi.fn(),
  shellShowItemInFolderMock: vi.fn(),
  validateNonSensitivePathMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: vi.fn() },
  shell: {
    openExternal: shellOpenExternalMock,
    openPath: shellOpenPathMock,
    showItemInFolder: shellShowItemInFolderMock
  }
}))

vi.mock('../../utils/ipc-validate', () => ({
  validateNonSensitivePath: validateNonSensitivePathMock
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
  wrapHandlerNoArgs: vi.fn(),
  wrapHandlerRaw: vi.fn(),
  schemas: createSchemasMock()
}))

import { registerShellHandlers } from './shell-handler'

describe('registerShellHandlers', () => {
  beforeEach(() => {
    handleMock.mockClear()
    shellOpenExternalMock.mockReset()
    shellOpenPathMock.mockReset()
    shellShowItemInFolderMock.mockReset()
    // 默认放行；敏感目录用例会临时覆盖为 { valid: false }
    validateNonSensitivePathMock.mockReturnValue({ valid: true })
  })

  it('应注册 3 个 shell channel', () => {
    registerShellHandlers(makeCtx({}))
    const channels = handleMock.mock.calls.map((c) => c[0])
    expect(channels).toContain('shell:openExternal')
    expect(channels).toContain('shell:openPath')
    expect(channels).toContain('shell:showItemInFolder')
  })

  it('shell:openExternal 成功时返回 { opened: true }', async () => {
    shellOpenExternalMock.mockResolvedValue(undefined)
    registerShellHandlers(makeCtx({}))
    const result = (await getHandler(
      handleMock,
      'shell:openExternal'
    )(['https://example.com'])) as {
      success: true
      data: { opened: boolean }
    }
    expect(shellOpenExternalMock).toHaveBeenCalledWith('https://example.com')
    expect(result.data.opened).toBe(true)
  })

  it('shell:openExternal 抛错时返回 INTERNAL_ERROR', async () => {
    shellOpenExternalMock.mockRejectedValue(new Error('无法打开'))
    registerShellHandlers(makeCtx({}))
    const result = (await getHandler(
      handleMock,
      'shell:openExternal'
    )(['https://example.com'])) as {
      success: false
      error: { code: string; message: string }
    }
    expect(result.error.code).toBe('IPC_INTERNAL_ERROR')
    expect(result.error.message).toContain('打开外部链接失败')
  })

  it('shell:openPath 校验路径并返回 opened', async () => {
    shellOpenPathMock.mockResolvedValue('')
    registerShellHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'shell:openPath')(['/some/dir'])) as {
      success: true
      data: { opened: boolean }
    }
    expect(validateNonSensitivePathMock).toHaveBeenCalledWith('/some/dir')
    expect(result.data.opened).toBe(true)
  })

  it('shell:openPath 抛错时返回 INTERNAL_ERROR', async () => {
    shellOpenPathMock.mockRejectedValue(new Error('拒绝访问'))
    registerShellHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'shell:openPath')(['/d'])) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_INTERNAL_ERROR')
  })

  // FIX(组5-1): openPath 等效双击，可执行/脚本文件必须拦截，防止任意程序执行通道
  it('shell:openPath 拒绝 .exe 可执行文件并返回 IPC_PATH_FORBIDDEN', async () => {
    shellOpenPathMock.mockResolvedValue('')
    registerShellHandlers(makeCtx({}))
    const result = (await getHandler(
      handleMock,
      'shell:openPath'
    )(['D:\\malware\\payload.exe'])) as {
      success: false
      error: { code: string; message: string }
    }
    expect(result.error.code).toBe('IPC_PATH_FORBIDDEN')
    expect(result.error.message).toContain('可执行')
    expect(shellOpenPathMock).not.toHaveBeenCalled()
  })

  it('shell:openPath 拒绝 .scr/.bat/.ps1 等脚本文件', async () => {
    registerShellHandlers(makeCtx({}))
    for (const p of ['C:\\tmp\\evil.scr', 'C:\\tmp\\run.bat', 'C:\\tmp\\a.ps1', 'C:\\tmp\\b.lnk']) {
      const result = (await getHandler(handleMock, 'shell:openPath')([p])) as {
        success: false
        error: { code: string }
      }
      expect(result.error.code).toBe('IPC_PATH_FORBIDDEN')
    }
    expect(shellOpenPathMock).not.toHaveBeenCalled()
  })

  it('shell:openPath 对普通媒体文件仍放行', async () => {
    shellOpenPathMock.mockResolvedValue('')
    registerShellHandlers(makeCtx({}))
    const result = (await getHandler(
      handleMock,
      'shell:openPath'
    )(['C:\\Games\\InfinityNikki\\ScreenShot\\img_001.jpg'])) as {
      success: true
      data: { opened: boolean }
    }
    expect(result.data.opened).toBe(true)
    expect(shellOpenPathMock).toHaveBeenCalledWith(
      'C:\\Games\\InfinityNikki\\ScreenShot\\img_001.jpg'
    )
  })

  it('shell:showItemInFolder 对可执行文件仍放行（仅定位选中，不执行）', async () => {
    shellShowItemInFolderMock.mockImplementation(() => undefined)
    registerShellHandlers(makeCtx({}))
    const result = (await getHandler(
      handleMock,
      'shell:showItemInFolder'
    )(['C:\\Games\\tool\\setup.exe'])) as {
      success: true
      data: { opened: boolean }
    }
    expect(shellShowItemInFolderMock).toHaveBeenCalledWith('C:\\Games\\tool\\setup.exe')
    expect(result.data.opened).toBe(true)
  })

  it('shell:showItemInFolder 调用 shell API', async () => {
    registerShellHandlers(makeCtx({}))
    await getHandler(handleMock, 'shell:showItemInFolder')(['/file'])
    expect(shellShowItemInFolderMock).toHaveBeenCalledWith('/file')
  })

  it('shell:showItemInFolder 抛错时返回 INTERNAL_ERROR', async () => {
    shellShowItemInFolderMock.mockImplementation(() => {
      throw new Error('not found')
    })
    registerShellHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'shell:showItemInFolder')(['/f'])) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_INTERNAL_ERROR')
  })

  it('shell:openPath 命中系统敏感目录时返回 IPC_PATH_FORBIDDEN', async () => {
    validateNonSensitivePathMock.mockReturnValue({
      valid: false,
      message: '出于安全考虑，不允许操作系统敏感目录'
    })
    registerShellHandlers(makeCtx({}))
    const result = (await getHandler(
      handleMock,
      'shell:openPath'
    )(['C:\\Windows\\System32\\x.dll'])) as {
      success: false
      error: { code: string; message: string }
    }
    expect(result.error.code).toBe('IPC_PATH_FORBIDDEN')
  })

  it('shell:showItemInFolder 命中系统敏感目录时返回 IPC_PATH_FORBIDDEN', async () => {
    validateNonSensitivePathMock.mockReturnValue({
      valid: false,
      message: '出于安全考虑，不允许操作系统敏感目录'
    })
    registerShellHandlers(makeCtx({}))
    const result = (await getHandler(
      handleMock,
      'shell:showItemInFolder'
    )(['C:\\Windows\\System32\\x.dll'])) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_PATH_FORBIDDEN')
  })

  it('shell:showItemInFolder 对图库内的游戏目录截图放行（核心回归用例）', async () => {
    validateNonSensitivePathMock.mockReturnValue({ valid: true })
    shellShowItemInFolderMock.mockImplementation(() => undefined)
    registerShellHandlers(makeCtx({}))
    const gameShot = 'C:\\Games\\InfinityNikki\\ScreenShot\\img.jpg'
    const result = (await getHandler(handleMock, 'shell:showItemInFolder')([gameShot])) as {
      success: true
      data: { opened: boolean }
    }
    expect(validateNonSensitivePathMock).toHaveBeenCalledWith(gameShot)
    expect(shellShowItemInFolderMock).toHaveBeenCalledWith(gameShot)
    expect(result.data.opened).toBe(true)
  })
})
