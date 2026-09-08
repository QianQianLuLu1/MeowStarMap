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

// ============================================================================
// editor:exportWithMetadata / editor:batchExportWithMetadata 源图读路径校验
//
// 回归 Bug：编辑页「导出含参数副本」→ 用户在系统对话框选完保存目录后失败，
// 提示「路径不在白名单内，禁止 读取 操作」（op=read，定位在源图读校验而非
// 目标目录写校验）。源图是图库中已入库、media:// 可正常展示并在编辑器中打开的
// 媒体，却因 PathGuard 敏感目录黑名单（官方启动器默认装在 Program Files）或
// 目录未登记为白名单根，被裸 assertFileReadPath 拒绝。
//
// 模式与上方 editor:readMetadata 一致：../validator 不 mock（pathGuard 真实），
// isMediaPathAllowed 由用例按分支控制；A1/A2/B1/B2 为本次 Bug 的红灯用例。
// ============================================================================
const METADATA_INPUT = {
  params: { zoom: 1 },
  filter: null,
  filterIntensity: 100,
  watermark: null
}
// 官方启动器默认安装形态：Program Files 命中 isSensitivePath 黑名单
const PF_SOURCE =
  'C:\\Program Files\\InfinityNikki Launcher\\InfinityNikki\\X6Game\\Saved\\GamePlayPhotos\\12345678\\NikkiPhotos_HighQuality\\photo.jpg'
// 已入库但目录未登记为 pathGuard 根
const UNREGISTERED_SOURCE = 'D:/games/InfinityNikki/photo/001.jpg'

function mockExportOk(): void {
  editorService.exportWithMetadata.mockReset().mockResolvedValue({
    success: true,
    message: '已导出含参数副本: photo_编辑.jpg',
    outputPath: `${ROOT}\\photo_编辑.jpg`
  })
}

function mockBatchExportOk(): void {
  editorService.batchExportWithMetadata.mockReset().mockResolvedValue({
    success: true,
    successCount: 1,
    failedCount: 0,
    outputPaths: [`${ROOT}\\photo_编辑.jpg`],
    failures: [],
    message: '批量导出完成：成功 1 张'
  })
}

describe('editor:exportWithMetadata（源图读路径白名单校验）', () => {
  beforeEach(() => {
    handleMock.mockClear()
    isMediaPathAllowedMock.mockReset()
    mockExportOk()
    pathGuard.register(ROOT)
    registerEditorMetadataHandlers(makeCtx())
  })

  it('A1 已入库媒体位于 Program Files（敏感目录形态）时导出成功', async () => {
    isMediaPathAllowedMock.mockReturnValue(true)

    const res = (await getHandler('editor:exportWithMetadata')({}, PF_SOURCE, METADATA_INPUT, {
      targetDir: ROOT,
      format: 'jpg',
      quality: 95
    })) as IpcResponseLike

    expect(res.success).toBe(true)
    expect(editorService.exportWithMetadata).toHaveBeenCalledTimes(1)
    expect(editorService.exportWithMetadata).toHaveBeenCalledWith(
      PF_SOURCE,
      expect.anything(),
      expect.objectContaining({ targetDir: ROOT, format: 'jpg', quality: 95 })
    )
  })

  it('A2 已入库但未登记进 pathGuard 根的媒体导出成功', async () => {
    isMediaPathAllowedMock.mockReturnValue(true)

    const res = (await getHandler('editor:exportWithMetadata')(
      {},
      UNREGISTERED_SOURCE,
      METADATA_INPUT,
      { targetDir: ROOT, format: 'jpg', quality: 95 }
    )) as IpcResponseLike

    expect(res.success).toBe(true)
    expect(editorService.exportWithMetadata).toHaveBeenCalledWith(
      UNREGISTERED_SOURCE,
      expect.anything(),
      expect.objectContaining({ targetDir: ROOT })
    )
  })

  it('A3 越权路径（双白名单均不命中）返回 IPC_PATH_FORBIDDEN 且服务层零调用', async () => {
    isMediaPathAllowedMock.mockReturnValue(false)

    const res = (await getHandler('editor:exportWithMetadata')(
      {},
      'C:\\Windows\\System32\\drivers\\etc\\hosts',
      METADATA_INPUT,
      { targetDir: ROOT }
    )) as IpcResponseLike

    expect(res.success).toBe(false)
    expect(res.error?.code).toBe(IPC_ERROR_CODES.PATH_FORBIDDEN)
    expect(editorService.exportWithMetadata).not.toHaveBeenCalled()
  })

  it('A4 目标目录经系统对话框登记（userPicked）时写入校验通过', async () => {
    isMediaPathAllowedMock.mockReturnValue(true)
    const picked = 'E:\\picked\\out'
    pathGuard.registerUserPicked(picked)

    const res = (await getHandler('editor:exportWithMetadata')(
      {},
      UNREGISTERED_SOURCE,
      METADATA_INPUT,
      { targetDir: picked }
    )) as IpcResponseLike

    expect(res.success).toBe(true)
    expect(editorService.exportWithMetadata).toHaveBeenCalledWith(
      UNREGISTERED_SOURCE,
      expect.anything(),
      expect.objectContaining({ targetDir: picked })
    )
  })

  it('A5 未命中媒体白名单但路径在已注册根下时兜底成功', async () => {
    isMediaPathAllowedMock.mockReturnValue(false)

    const res = (await getHandler('editor:exportWithMetadata')(
      {},
      `${ROOT}\\not-indexed.jpg`,
      METADATA_INPUT,
      { targetDir: ROOT }
    )) as IpcResponseLike

    expect(res.success).toBe(true)
    expect(editorService.exportWithMetadata).toHaveBeenCalledTimes(1)
  })
})

describe('editor:batchExportWithMetadata（源图读路径白名单校验）', () => {
  beforeEach(() => {
    handleMock.mockClear()
    isMediaPathAllowedMock.mockReset()
    mockBatchExportOk()
    pathGuard.register(ROOT)
    registerEditorMetadataHandlers(makeCtx())
  })

  it('B1 已入库媒体（Program Files 形态）批量导出成功', async () => {
    isMediaPathAllowedMock.mockReturnValue(true)

    const res = (await getHandler('editor:batchExportWithMetadata')(
      {},
      [PF_SOURCE, UNREGISTERED_SOURCE],
      METADATA_INPUT,
      { targetDir: ROOT, format: 'jpg', quality: 95 }
    )) as IpcResponseLike

    expect(res.success).toBe(true)
    expect(editorService.batchExportWithMetadata).toHaveBeenCalledTimes(1)
    expect(editorService.batchExportWithMetadata).toHaveBeenCalledWith(
      [PF_SOURCE, UNREGISTERED_SOURCE],
      expect.anything(),
      expect.objectContaining({ targetDir: ROOT, format: 'jpg', quality: 95 })
    )
  })

  it('B2 批次中含 1 条越权路径时整批拒绝且服务层零调用', async () => {
    isMediaPathAllowedMock.mockReturnValue(false)

    const res = (await getHandler('editor:batchExportWithMetadata')(
      {},
      [`${ROOT}\\ok.jpg`, 'C:\\Windows\\System32\\drivers\\etc\\hosts'],
      METADATA_INPUT,
      { targetDir: ROOT }
    )) as IpcResponseLike

    expect(res.success).toBe(false)
    expect(res.error?.code).toBe(IPC_ERROR_CODES.PATH_FORBIDDEN)
    expect(editorService.batchExportWithMetadata).not.toHaveBeenCalled()
  })
})
