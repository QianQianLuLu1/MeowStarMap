/**
 * @layer L3
 * @module src/main/ipc/handlers/file-export-handler
 * @coverage file:export / file:saveAs 源图读路径校验口径，及同族 file:copy / file:move /
 *           file:rename / file:batchRename 的源路径读校验
 *
 * 回归 Bug（用户报障「导出无法使用，选目录导出与导出到默认都不行」）：
 * 源图读校验用裸 assertFileReadPath（严格 PathGuard 白名单），而它**先于**目标目录写校验
 * 执行，所以两种导出方式以完全相同的 IPC_PATH_FORBIDDEN 失败。已入库媒体并不必然命中
 * PathGuard：官方启动器默认装在 `C:\Program Files\InfinityNikki Launcher\...`，命中
 * isSensitivePath 黑名单，而 validator.ts 的判定顺序是「黑名单先于 roots」，即便扫描根已
 * 登记也恒拒绝；图库经 media:// 能正常显示这些照片，于是形成「看得见、导不出」。
 *
 * 同族先例：editor-metadata-handler.ts 的 batchExportWithMetadata 与 file.ts 的
 * file:delete / file:deletePermanent 已迁到三级校验（userPicked → 已入库媒体白名单 →
 * PathGuard 兜底），本文件把导出/另存为/复制/移动/重命名这几路补齐同一口径。
 *
 * 模式与 editor-metadata-handler.test.ts / file.test.ts 一致：`../validator` **不 mock**
 * （wrapHandler / schemas / pathGuard 均真实执行），isMediaPathAllowed 由用例按分支控制。
 * 「放行」的结论只能由「该路径未登记进 pathGuard 根」这一前提证明。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HandlerContext } from '../handler-context'
import { IPC_ERROR_CODES } from '../../../shared/types/ipc-types'
import { pathGuard } from '../validator'

const { handleMock, isMediaPathAllowedMock, fileService } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  isMediaPathAllowedMock: vi.fn(),
  fileService: {
    exportFiles: vi.fn(),
    saveAs: vi.fn(),
    copyFiles: vi.fn(),
    moveFiles: vi.fn(),
    renameFile: vi.fn(),
    batchRename: vi.fn()
  }
}))

vi.mock('electron', () => ({
  // validator.ts 顶层 import electron；PathGuard 仅在显式调用时用到 app
  app: { getPath: () => 'C:\\test\\userdata', getName: () => 'test', getAppPath: () => 'C:\\test' },
  ipcMain: { handle: handleMock, on: vi.fn() },
  dialog: {
    showMessageBox: vi.fn(),
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn()
  },
  shell: { showItemInFolder: vi.fn(), trashItem: vi.fn() },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] }
}))

// 媒体白名单由测试按分支控制返回值（默认 false，走 PathGuard 兜底）
vi.mock('../../app/media-protocol', () => ({
  isMediaPathAllowed: isMediaPathAllowedMock
}))

// 命中媒体白名单/userPicked 时记录 debug 日志，mock logger 隔离磁盘写入
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

import { registerFileExportHandlers } from './file-export-handler'
import { registerFileHandlers } from './file'
import { registerFileRenameHandlers } from './file-rename-handler'

// 用例使用的合法根目录（注册进 pathGuard 白名单，供目标目录写校验与兜底放行）
const ROOT = 'C:\\test\\root'
// 官方启动器默认安装形态：Program Files 命中 isSensitivePath 黑名单
const PF_SOURCE =
  'C:\\Program Files\\InfinityNikki Launcher\\InfinityNikki\\X6Game\\Saved\\GamePlayPhotos\\12345678\\NikkiPhotos_HighQuality\\photo.jpg'
// 已入库但目录未登记为 pathGuard 根
const UNREGISTERED_SOURCE = 'D:/games/InfinityNikki/photo/001.jpg'

function makeCtx(): HandlerContext {
  return {
    fileService,
    dbManager: {
      getDatabase: vi.fn(() => ({})),
      getSetting: vi.fn(() => null),
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

beforeEach(() => {
  handleMock.mockClear()
  isMediaPathAllowedMock.mockReset()
  isMediaPathAllowedMock.mockReturnValue(false)
  pathGuard.register(ROOT)
  fileService.exportFiles
    .mockReset()
    .mockResolvedValue({ success: true, message: '已导出 1 个文件' })
  fileService.saveAs
    .mockReset()
    .mockResolvedValue({ success: true, message: '另存为成功', newPath: `${ROOT}\\photo.jpg` })
  fileService.copyFiles
    .mockReset()
    .mockResolvedValue({ success: true, message: '已复制 1 个文件', copied: [], failed: [] })
  // renamed 置空：跳过 syncMediaFilesAfterRename 的 DB 写入分支，聚焦读校验口径
  fileService.moveFiles
    .mockReset()
    .mockResolvedValue({ success: true, message: '已移动 1 个文件', renamed: [], failed: [] })
  fileService.renameFile
    .mockReset()
    .mockResolvedValue({ success: true, message: '重命名成功', renamed: [], failed: [] })
  fileService.batchRename
    .mockReset()
    .mockResolvedValue({ success: true, message: '成功重命名 1 个文件', renamed: [], failed: [] })
  registerFileExportHandlers(makeCtx())
  registerFileHandlers(makeCtx())
  registerFileRenameHandlers(makeCtx())
})

describe('file:export（源图读路径白名单校验）', () => {
  it('E1 已入库媒体位于 Program Files（敏感目录形态）时导出成功', async () => {
    isMediaPathAllowedMock.mockReturnValue(true)

    const res = (await getHandler('file:export')({}, [PF_SOURCE], ROOT, {})) as IpcResponseLike

    expect(res.success).toBe(true)
    expect(fileService.exportFiles).toHaveBeenCalledTimes(1)
    expect(fileService.exportFiles).toHaveBeenCalledWith(
      [PF_SOURCE],
      ROOT,
      expect.anything(),
      undefined
    )
  })

  it('E2 已入库但未登记进 pathGuard 根的媒体导出成功', async () => {
    isMediaPathAllowedMock.mockReturnValue(true)

    const res = (await getHandler('file:export')(
      {},
      [UNREGISTERED_SOURCE],
      ROOT,
      {}
    )) as IpcResponseLike

    expect(res.success).toBe(true)
    expect(fileService.exportFiles).toHaveBeenCalledTimes(1)
  })

  /**
   * 安全护栏（修复前后皆绿）：本节点只把口径放宽到「DB 已索引媒体 ∪ 用户显式选过的目录」，
   * 未入库且未授权的路径必须仍被拒绝。评审最关心的一条，禁止后续被"顺手放宽"。
   */
  it('E3 未入库且未 userPicked 的路径仍被 IPC_PATH_FORBIDDEN 拦截（边界不放宽）', async () => {
    isMediaPathAllowedMock.mockReturnValue(false)

    const res = (await getHandler('file:export')(
      {},
      ['Q:\\nowhere\\a.jpg'],
      ROOT,
      {}
    )) as IpcResponseLike

    expect(res.success).toBe(false)
    expect(res.error?.code).toBe(IPC_ERROR_CODES.PATH_FORBIDDEN)
    expect(fileService.exportFiles).not.toHaveBeenCalled()
  })

  it('E4 未命中媒体白名单但源在已注册根下时兜底成功（PathGuard 兜底保留）', async () => {
    isMediaPathAllowedMock.mockReturnValue(false)

    const res = (await getHandler('file:export')(
      {},
      [`${ROOT}\\not-indexed.jpg`],
      ROOT,
      {}
    )) as IpcResponseLike

    expect(res.success).toBe(true)
    expect(fileService.exportFiles).toHaveBeenCalledWith(
      [`${ROOT}\\not-indexed.jpg`],
      ROOT,
      expect.anything(),
      undefined
    )
  })

  it('E5 目标目录经系统对话框登记（userPicked）且源为已入库媒体时导出成功', async () => {
    isMediaPathAllowedMock.mockReturnValue(true)
    const picked = 'E:\\picked\\out'
    pathGuard.registerUserPickedDir(picked)

    const res = (await getHandler('file:export')(
      {},
      [UNREGISTERED_SOURCE],
      picked,
      {}
    )) as IpcResponseLike

    expect(res.success).toBe(true)
    expect(fileService.exportFiles).toHaveBeenCalledWith(
      [UNREGISTERED_SOURCE],
      picked,
      expect.anything(),
      undefined
    )
  })
})

describe('file:saveAs（源图读路径白名单校验）', () => {
  it('S1 源图为 Program Files 已入库媒体时另存为成功', async () => {
    isMediaPathAllowedMock.mockReturnValue(true)

    const res = (await getHandler('file:saveAs')({}, PF_SOURCE, ROOT)) as IpcResponseLike

    expect(res.success).toBe(true)
    expect(fileService.saveAs).toHaveBeenCalledWith(PF_SOURCE, ROOT, undefined)
  })

  it('S2 未入库且未授权源仍被 IPC_PATH_FORBIDDEN 拦截', async () => {
    isMediaPathAllowedMock.mockReturnValue(false)

    const res = (await getHandler('file:saveAs')({}, 'Q:\\nowhere\\a.jpg', ROOT)) as IpcResponseLike

    expect(res.success).toBe(false)
    expect(res.error?.code).toBe(IPC_ERROR_CODES.PATH_FORBIDDEN)
    expect(fileService.saveAs).not.toHaveBeenCalled()
  })
})

describe('同族右键菜单操作（copy / move / rename / batchRename 源路径口径对齐）', () => {
  it('C1 file:copy 源为已入库媒体（敏感目录形态）时成功', async () => {
    isMediaPathAllowedMock.mockReturnValue(true)

    const res = (await getHandler('file:copy')({}, [PF_SOURCE], ROOT)) as IpcResponseLike

    expect(res.success).toBe(true)
    expect(fileService.copyFiles).toHaveBeenCalledWith([PF_SOURCE], ROOT)
  })

  it('M1 file:move 源为已入库媒体（敏感目录形态）时成功', async () => {
    isMediaPathAllowedMock.mockReturnValue(true)

    const res = (await getHandler('file:move')({}, [PF_SOURCE], ROOT)) as IpcResponseLike

    expect(res.success).toBe(true)
    expect(fileService.moveFiles).toHaveBeenCalledWith([PF_SOURCE], ROOT)
  })

  it('R1 file:rename 源为已入库媒体（敏感目录形态）时成功', async () => {
    isMediaPathAllowedMock.mockReturnValue(true)

    const res = (await getHandler('file:rename')({}, PF_SOURCE, 'new-name.jpg')) as IpcResponseLike

    expect(res.success).toBe(true)
    expect(fileService.renameFile).toHaveBeenCalledWith(PF_SOURCE, 'new-name.jpg')
  })

  it('B1 file:batchRename 源为已入库媒体（敏感目录形态）时成功', async () => {
    isMediaPathAllowedMock.mockReturnValue(true)

    const res = (await getHandler('file:batchRename')({}, [
      { oldPath: PF_SOURCE, newName: 'a.jpg' }
    ])) as IpcResponseLike

    expect(res.success).toBe(true)
    expect(fileService.batchRename).toHaveBeenCalledWith([{ oldPath: PF_SOURCE, newName: 'a.jpg' }])
  })

  it('X1 未入库且未授权源在 copy / move / rename 上仍被拦截（边界不放宽）', async () => {
    isMediaPathAllowedMock.mockReturnValue(false)

    const copy = (await getHandler('file:copy')(
      {},
      ['Q:\\nowhere\\a.jpg'],
      ROOT
    )) as IpcResponseLike
    const move = (await getHandler('file:move')(
      {},
      ['Q:\\nowhere\\a.jpg'],
      ROOT
    )) as IpcResponseLike
    const rename = (await getHandler('file:rename')(
      {},
      'Q:\\nowhere\\a.jpg',
      'b.jpg'
    )) as IpcResponseLike

    expect(copy.error?.code).toBe(IPC_ERROR_CODES.PATH_FORBIDDEN)
    expect(move.error?.code).toBe(IPC_ERROR_CODES.PATH_FORBIDDEN)
    expect(rename.error?.code).toBe(IPC_ERROR_CODES.PATH_FORBIDDEN)
    expect(fileService.copyFiles).not.toHaveBeenCalled()
    expect(fileService.moveFiles).not.toHaveBeenCalled()
    expect(fileService.renameFile).not.toHaveBeenCalled()
  })
})
