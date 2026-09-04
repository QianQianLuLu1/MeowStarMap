/**
 * @layer L3
 * @module src/main/ipc/handlers/editor-metadata-handler
 * @coverage editor:readMetadata 双层读路径白名单校验（媒体白名单优先 + PathGuard 兜底）
 *
 * 模式参照 file.test.ts 的 file:getExif 双层用例：
 * ../validator 不 mock——wrapHandler / schemas / pathGuard 均为真实实现，
 * 命中媒体白名单时跳过 PathGuard 的行为性证明依赖「路径未注册进 pathGuard」。
 *
 * 安全边界验证：越权路径（双白名单均不命中）抛 IPC_PATH_FORBIDDEN 且
 * editorService.readMetadata 零调用；写通道（导出类）不在本文件范围内。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HandlerContext } from '../handler-context'
import { IPC_ERROR_CODES } from '../../../shared/types/ipc-types'
import { pathGuard } from '../validator'

const { handleMock, isMediaPathAllowedMock, editorService } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  isMediaPathAllowedMock: vi.fn(),
  // 仅 editor:readMetadata 在用例中被调用；导出类方法留桩避免 undefined 调用
  editorService: {
    readMetadata: vi.fn(),
    exportWithMetadata: vi.fn(),
    batchExportWithMetadata: vi.fn()
  }
}))

vi.mock('electron', () => ({
  // validator.ts 顶层 import electron；PathGuard 仅在显式调用时用到 app
  app: { getPath: () => 'C:\\test\\userdata', getName: () => 'test', getAppPath: () => 'C:\\test' },
  ipcMain: { handle: handleMock, on: vi.fn() },
  dialog: { showMessageBox: vi.fn(), showOpenDialog: vi.fn() },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] }
}))

// 媒体白名单由测试按分支控制返回值（默认 false，走 PathGuard 兜底）
vi.mock('../../app/media-protocol', () => ({
  isMediaPathAllowed: isMediaPathAllowedMock
}))

// 编辑器服务整体 mock，隔离 sharp / fs 等重依赖
vi.mock('../../services/editor-service', () => ({
  editorService,
  buildEditorMetadata: vi.fn((input: unknown) => input)
}))

// assertMediaReadPath 命中白名单时记录 debug 日志，mock logger 隔离磁盘写入
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

import { registerEditorMetadataHandlers } from './editor-metadata-handler'

// 用例使用的合法根目录（注册进 pathGuard 白名单，避免被默认拒绝）
const ROOT = 'C:\\test\\root'

function makeCtx(): HandlerContext {
  return {
    dbManager: {
      getDatabase: vi.fn(() => ({})),
      getSetting: vi.fn(),
      setSetting: vi.fn(),
      getWorkerBridge: vi.fn(() => undefined),
      getDbPath: vi.fn(() => '/mock/db.sqlite')
    },
    getMainWindow: () => null,
    notifyMediaUpdated: vi.fn(),
    invalidateMediaPathCache: vi.fn()
  } as unknown as HandlerContext
}

type WrappedFn = (...args: unknown[]) => Promise<unknown>

function getHandler(channel: string): WrappedFn {
  for (const call of handleMock.mock.calls) {
    if (call[0] === channel) return call[1] as WrappedFn
  }
  throw new Error(`未找到 channel: ${channel}`)
}

interface IpcResponseLike {
  success: boolean
  data?: unknown
  error?: { code: string; message: string }
}

describe('editor:readMetadata（双层读路径白名单校验）', () => {
  beforeEach(() => {
    handleMock.mockClear()
    isMediaPathAllowedMock.mockReset()
    editorService.readMetadata.mockReset().mockResolvedValue(null)
    pathGuard.register(ROOT)
    registerEditorMetadataHandlers(makeCtx())
  })

  it('命中已索引媒体白名单时跳过 PathGuard 并成功返回元数据', async () => {
    isMediaPathAllowedMock.mockReturnValue(true)
    const metadata = { params: { zoom: 1 } }
    editorService.readMetadata.mockResolvedValue(metadata)
    // 行为性证明：该路径未注册进 pathGuard，若仍走 assertFileReadPath 必然 PATH_FORBIDDEN
    const res = (await getHandler('editor:readMetadata')(
      {},
      'D:/games/InfinityNikki/photo/001.jpg'
    )) as IpcResponseLike
    expect(res.success).toBe(true)
    expect(res.data).toEqual(metadata)
    expect(editorService.readMetadata).toHaveBeenCalledTimes(1)
    expect(editorService.readMetadata).toHaveBeenCalledWith('D:/games/InfinityNikki/photo/001.jpg')
  })

  it('越权路径（双白名单均不命中）抛 IPC_PATH_FORBIDDEN', async () => {
    isMediaPathAllowedMock.mockReturnValue(false)

    const res = (await getHandler('editor:readMetadata')(
      {},
      'C:\\Windows\\System32\\drivers\\etc\\hosts'
    )) as IpcResponseLike
    expect(res.success).toBe(false)
    expect(res.error?.code).toBe(IPC_ERROR_CODES.PATH_FORBIDDEN)
    expect(editorService.readMetadata).not.toHaveBeenCalled()
  })

  it('未命中媒体白名单但 PathGuard 放行时兜底成功', async () => {
    isMediaPathAllowedMock.mockReturnValue(false)
    const metadata = { params: { zoom: 2 } }
    editorService.readMetadata.mockResolvedValue(metadata)

    const res = (await getHandler('editor:readMetadata')(
      {},
      `${ROOT}\\not-indexed.jpg`
    )) as IpcResponseLike
    expect(res.success).toBe(true)
    expect(res.data).toEqual(metadata)
    expect(editorService.readMetadata).toHaveBeenCalledWith(`${ROOT}\\not-indexed.jpg`)
  })
})
