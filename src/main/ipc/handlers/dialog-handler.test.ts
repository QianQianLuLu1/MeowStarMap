/**
 * @layer L3
 * @module src/main/ipc/handlers/dialog-handler
 * @coverage dialog 域 IPC handler（selectDirectory / openFile / saveFile / showMessageBox）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeCtx, getHandler } from './_test-helpers'

const {
  handleMock,
  showOpenDialogMock,
  showSaveDialogMock,
  showMessageBoxMock,
  getFocusedWindowMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  showOpenDialogMock: vi.fn(),
  showSaveDialogMock: vi.fn(),
  showMessageBoxMock: vi.fn(),
  getFocusedWindowMock: vi.fn()
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

vi.mock('../validator', async () => await import('../../../../tests/mocks/mock-validator'))

import { registerDialogHandlers } from './dialog-handler'
import { pathGuard, assertFileReadPath, assertFileWritePath } from '../validator'

const assertFileReadPathMock = vi.mocked(assertFileReadPath)
const assertFileWritePathMock = vi.mocked(assertFileWritePath)
// selectDirectory 选中目录后需登记路径白名单
const pathGuardRegisterMock = vi.mocked(pathGuard.register)
// userPicked（用户显式选择即授权）登记
const pathGuardRegisterUserPickedMock = vi.mocked(pathGuard.registerUserPicked)
const pathGuardRegisterUserPickedDirMock = vi.mocked(pathGuard.registerUserPickedDir)

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
    pathGuardRegisterUserPickedMock.mockReset()
    pathGuardRegisterUserPickedDirMock.mockReset()
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
    // 选中目录须登记白名单（registerUserPickedDir 内部联动 register），否则后续 import 链路在路径校验处被拒
    expect(pathGuardRegisterUserPickedDirMock).toHaveBeenCalledWith('/selected')
  })

  it('dialog:selectDirectory 选中目录后调用 pathGuard.registerUserPickedDir（spyOn 验证）', async () => {
    const registerSpy = vi.spyOn(pathGuard, 'registerUserPickedDir')
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/selected'] })
    getFocusedWindowMock.mockReturnValue({ webContents: { send: vi.fn() } })
    registerDialogHandlers(makeCtx({}))
    await getHandler(handleMock, 'dialog:selectDirectory')()
    expect(registerSpy).toHaveBeenCalledWith('/selected')
    registerSpy.mockRestore()
  })

  it('dialog:selectDirectory 选中目录时登记目录集合（用户显式选择即授权）', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/selected'] })
    getFocusedWindowMock.mockReturnValue({ webContents: { send: vi.fn() } })
    registerDialogHandlers(makeCtx({}))
    await getHandler(handleMock, 'dialog:selectDirectory')()
    expect(pathGuardRegisterUserPickedDirMock).toHaveBeenCalledWith('/selected')
    // selectDirectory 只会返回目录，不该退回落进文件集合（scanner/settings 的短路判据在目录集合上）
    expect(pathGuardRegisterUserPickedMock).not.toHaveBeenCalled()
  })

  /**
   * 图片水印授权修复（docs/plans/2026-10-17-fix-image-watermark-media-auth.md §5 N1）
   *
   * 本组用例此前有一条反向断言「openFile 文件模式不得登记 userPicked」，它把缺陷本身锁成了
   * 契约：编辑器 WatermarkPanel 挑的 logo 因未登记，经 media:// 恒 403，水印静默消失。
   * 改写理由：registerUserPicked 的既有 doctrine 是「用户在系统对话框显式选中即授权」
   * （validator.ts addUserPicked 注释），该语义对单文件同样成立；风险由三处兜住——
   * isUserPicked 只做「根自身 / 根+sep」精确前缀匹配（登记文件只放行该文件本身，不外溢到
   * 同目录兄弟文件），展示面另设媒体扩展名闸门（见 media-protocol 规则 0），
   * 且文件形态不进目录集合（scanner:start / settings:set 只认 registerUserPickedDir）。
   * 原守卫意图（不得无授权登记）迁移到下方「取消时不登记」用例保留。
   */
  it('dialog:openFile 目录模式登记目录集合（registerUserPickedDir）', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/picked-dir'] })
    getFocusedWindowMock.mockReturnValue({ webContents: { send: vi.fn() } })
    registerDialogHandlers(makeCtx({}))
    await getHandler(handleMock, 'dialog:openFile')([{ properties: ['openDirectory'] }])
    expect(pathGuardRegisterUserPickedDirMock).toHaveBeenCalledWith('/picked-dir')
  })

  it('dialog:openFile 文件模式同样登记 userPicked（图片水印授权）', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/picked-file.png'] })
    getFocusedWindowMock.mockReturnValue({ webContents: { send: vi.fn() } })
    registerDialogHandlers(makeCtx({}))
    await getHandler(handleMock, 'dialog:openFile')([{ properties: ['openFile'] }])
    expect(pathGuardRegisterUserPickedMock).toHaveBeenCalledWith('/picked-file.png')
    // 边界：单个文件的授权不得进目录集合，否则它能冒充「显式授权的扫描根」
    expect(pathGuardRegisterUserPickedDirMock).not.toHaveBeenCalled()
  })

  it('dialog:openFile 未显式传 properties（默认 openFile）也登记 userPicked', async () => {
    // WatermarkPanel.handleSelectImage 的真实调用形态：只传 filters，不传 properties
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/logo.png'] })
    getFocusedWindowMock.mockReturnValue({ webContents: { send: vi.fn() } })
    registerDialogHandlers(makeCtx({}))
    await getHandler(
      handleMock,
      'dialog:openFile'
    )([{ filters: [{ name: 'image', extensions: ['png'] }] }])
    expect(pathGuardRegisterUserPickedMock).toHaveBeenCalledWith('/logo.png')
  })

  it('dialog:openFile multiSelections 下登记全部返回路径', async () => {
    // 返回值形状仍为 filePaths[0]（不改契约），但授权登记必须覆盖全量，否则第二个之后的
    // 选中文件仍会经 media:// 被拒
    showOpenDialogMock.mockResolvedValue({
      canceled: false,
      filePaths: ['/a.png', '/b.png', '/c.png']
    })
    getFocusedWindowMock.mockReturnValue({ webContents: { send: vi.fn() } })
    registerDialogHandlers(makeCtx({}))
    await getHandler(
      handleMock,
      'dialog:openFile'
    )([{ properties: ['openFile', 'multiSelections'] }])
    expect(pathGuardRegisterUserPickedMock.mock.calls.map((c) => c[0])).toEqual([
      '/a.png',
      '/b.png',
      '/c.png'
    ])
  })

  it('dialog:openFile 取消时不登记 userPicked（守卫：未真实选中不得授权）', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] })
    getFocusedWindowMock.mockReturnValue({ webContents: { send: vi.fn() } })
    registerDialogHandlers(makeCtx({}))
    await getHandler(handleMock, 'dialog:openFile')([{ properties: ['openFile'] }])
    expect(pathGuardRegisterUserPickedMock).not.toHaveBeenCalled()
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
