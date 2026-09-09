/**
 * @layer L3
 * @module src/main/ipc/handlers/file
 * @coverage file:delete 批量路径数组上限回归
 *
 * 修复回归点：file:delete 等批量文件通道从 schemas.filePathArray（1000 上限）切换到
 * schemas.filePathArrayBulk。本文件不 mock ../validator——wrapHandler 与 schemas 均为真实实现，
 * zod 校验真实执行：若回退到 capped schema，1500 个路径的用例必然失败，构成真回归防线。
 *
 * 安全边界验证：元素级路径白名单（assertFileReadPath / pathGuard）与 schema 元素级校验
 * （非空 + 1-1024 字符）仍生效——空数组、非法元素、非白名单路径分别被 VALIDATION_ERROR /
 * PATH_FORBIDDEN 拦截。放开仅限数组长度这一人为上限。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { dialog } from 'electron'
import type { HandlerContext } from '../handler-context'
import { IPC_ERROR_CODES } from '../../../shared/types/ipc-types'
import { pathGuard } from '../validator'

const { handleMock, isMediaPathAllowedMock, fileService } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  isMediaPathAllowedMock: vi.fn(),
  // 仅 file:delete / file:getExif 在用例中被调用；其余方法留桩避免 undefined 调用
  fileService: {
    moveToRecycleBin: vi.fn(),
    copyFiles: vi.fn(),
    moveFiles: vi.fn(),
    exportFiles: vi.fn(),
    deletePermanent: vi.fn(),
    getExif: vi.fn(),
    saveAs: vi.fn(),
    renameFile: vi.fn(),
    batchRename: vi.fn()
  }
}))

vi.mock('electron', () => ({
  // validator.ts 顶层 import electron；PathGuard 仅在显式调用时用到 app
  app: { getPath: () => 'C:\\test\\userdata', getName: () => 'test', getAppPath: () => 'C:\\test' },
  ipcMain: { handle: handleMock, on: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }
}))

// 媒体白名单由测试按分支控制返回值（默认 false，不影响 file:delete 既有防线）
vi.mock('../../app/media-protocol', () => ({
  isMediaPathAllowed: isMediaPathAllowedMock
}))

// assertMediaReadPath 命中白名单时记录 debug 日志，mock logger 隔离磁盘写入
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

import { registerFileHandlers } from './file'

// 用例使用的合法根目录（注册进 pathGuard 白名单，避免被默认拒绝）
const ROOT = 'C:\\test\\root'
const paths = (n: number) =>
  Array.from({ length: n }, (_, i) => `${ROOT}\\file-${String(i).padStart(5, '0')}.jpg`)

function makeCtx(): HandlerContext {
  return {
    fileService,
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
  data?: { deleted?: number }
  error?: { code: string; message: string }
}

describe('file:delete（filePathArrayBulk 切换回归）', () => {
  beforeEach(() => {
    handleMock.mockClear()
    // 默认未命中媒体白名单，既有防线全部走 PathGuard 兜底（不受 getExif 双层改造影响）
    isMediaPathAllowedMock.mockReset()
    isMediaPathAllowedMock.mockReturnValue(false)
    // 注册白名单根目录，使合法绝对路径通过 assertFileReadPath
    pathGuard.register(ROOT)
    fileService.moveToRecycleBin
      .mockReset()
      .mockImplementation((ps: string[]) => Promise.resolve({ deleted: ps.length, failed: [] }))
    registerFileHandlers(makeCtx())
  })

  it('1500 个合法路径校验通过并全量下发 moveToRecycleBin（修复前 1000 上限会拒绝）', async () => {
    const res = (await getHandler('file:delete')({}, paths(1500))) as IpcResponseLike
    expect(res.success).toBe(true)
    expect(res.data?.deleted).toBe(1500)
    expect(fileService.moveToRecycleBin).toHaveBeenCalledTimes(1)
    expect(fileService.moveToRecycleBin).toHaveBeenCalledWith(paths(1500))
  })

  it('1001（旧上限边界 +1）与 3000 个路径均通过', async () => {
    const handler = getHandler('file:delete')
    const r1 = (await handler({}, paths(1001))) as IpcResponseLike
    expect(r1.success).toBe(true)
    const r2 = (await handler({}, paths(3000))) as IpcResponseLike
    expect(r2.success).toBe(true)
    expect(fileService.moveToRecycleBin).toHaveBeenCalledWith(paths(3000))
  })

  it('空数组仍被 min(1) 拒绝（安全边界不降）', async () => {
    const res = (await getHandler('file:delete')({}, [])) as IpcResponseLike
    expect(res.success).toBe(false)
    expect(res.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    expect(fileService.moveToRecycleBin).not.toHaveBeenCalled()
  })

  it('含空串元素仍被元素级校验拒绝', async () => {
    const res = (await getHandler('file:delete')({}, [
      paths(1)[0],
      '',
      paths(1)[1]
    ])) as IpcResponseLike
    expect(res.success).toBe(false)
    expect(res.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    expect(fileService.moveToRecycleBin).not.toHaveBeenCalled()
  })

  it('非白名单路径被 PATH_FORBIDDEN 拦截（逐元素安全边界不降级）', async () => {
    const res = (await getHandler('file:delete')({}, [
      'relative-not-absolute.jpg'
    ])) as IpcResponseLike
    expect(res.success).toBe(false)
    expect(res.error?.code).toBe(IPC_ERROR_CODES.PATH_FORBIDDEN)
    expect(fileService.moveToRecycleBin).not.toHaveBeenCalled()
  })

  /**
   * 变异验证（手动）：将 file.ts 的 `schemas.filePathArrayBulk` 临时改回
   * `schemas.filePathArray` 后重跑本 describe，1500 / 3000 / 1001 用例必须失败、
   * 空数组/非法元素用例仍通过。恢复 bulk 后全部通过，证明回归防线有效。
   */
  it('变异验证基准：bulk 语义当前生效（>1000 通过、空数组拒绝）', async () => {
    const ok = (await getHandler('file:delete')({}, paths(1200))) as IpcResponseLike
    expect(ok.success).toBe(true)
    const bad = (await getHandler('file:delete')({}, [])) as IpcResponseLike
    expect(bad.success).toBe(false)
  })
})

describe('file:getExif（双层读路径白名单校验）', () => {
  beforeEach(() => {
    handleMock.mockClear()
    isMediaPathAllowedMock.mockReset()
    fileService.getExif.mockReset().mockResolvedValue({})
    pathGuard.register(ROOT)
    registerFileHandlers(makeCtx())
  })

  it('命中已索引媒体白名单时跳过 PathGuard 并成功返回 EXIF', async () => {
    isMediaPathAllowedMock.mockReturnValue(true)
    // 行为性证明：该路径未注册进 pathGuard，若仍走 assertFileReadPath 必然 PATH_FORBIDDEN
    const res = (await getHandler('file:getExif')(
      {},
      'D:/games/InfinityNikki/photo/001.jpg'
    )) as IpcResponseLike
    expect(res.success).toBe(true)
    expect(fileService.getExif).toHaveBeenCalledTimes(1)
    expect(fileService.getExif).toHaveBeenCalledWith('D:/games/InfinityNikki/photo/001.jpg')
  })

  it('越权路径（双白名单均不命中）抛 IPC_PATH_FORBIDDEN', async () => {
    isMediaPathAllowedMock.mockReturnValue(false)

    const res = (await getHandler('file:getExif')(
      {},
      'C:\\Windows\\System32\\drivers\\etc\\hosts'
    )) as IpcResponseLike
    expect(res.success).toBe(false)
    expect(res.error?.code).toBe(IPC_ERROR_CODES.PATH_FORBIDDEN)
    expect(fileService.getExif).not.toHaveBeenCalled()
  })

  it('未命中媒体白名单但 PathGuard 放行时兜底成功', async () => {
    isMediaPathAllowedMock.mockReturnValue(false)

    const res = (await getHandler('file:getExif')(
      {},
      `${ROOT}\\not-indexed.jpg`
    )) as IpcResponseLike
    expect(res.success).toBe(true)
    expect(fileService.getExif).toHaveBeenCalledWith(`${ROOT}\\not-indexed.jpg`)
  })
})

describe('file:delete / file:deletePermanent 删除白名单对齐（assertMediaDeletePath）', () => {
  beforeEach(() => {
    handleMock.mockClear()
    isMediaPathAllowedMock.mockReset()
    isMediaPathAllowedMock.mockReturnValue(false)
    fileService.moveToRecycleBin
      .mockReset()
      .mockImplementation((ps: string[]) => Promise.resolve({ deleted: ps.length, failed: [] }))
    fileService.deletePermanent
      .mockReset()
      .mockImplementation((ps: string[]) => Promise.resolve({ deleted: ps.length, failed: [] }))
    pathGuard.register(ROOT)
    registerFileHandlers(makeCtx())
  })

  // 修复目标场景：游戏装在 Program Files 形态下，已入库媒体（媒体白名单命中）
  // 旧链路被 isSensitivePath 黑名单硬拒 → 报「路径不在白名单内」；新守卫放行
  it('D1 已入库媒体（敏感目录形态）经 file:delete 删除成功', async () => {
    isMediaPathAllowedMock.mockReturnValue(true)
    const steamPhoto =
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\InfinityNikki\\X6Game\\ScreenShot\\001.jpg'

    const res = (await getHandler('file:delete')({}, [steamPhoto])) as IpcResponseLike
    expect(res.success).toBe(true)
    expect(fileService.moveToRecycleBin).toHaveBeenCalledWith([steamPhoto])
  })

  it('D2 未入库但位于已注册根下的路径删除成功（PathGuard 兜底保留）', async () => {
    const res = (await getHandler('file:delete')({}, [
      `${ROOT}\\not-indexed.jpg`
    ])) as IpcResponseLike
    expect(res.success).toBe(true)
    expect(fileService.moveToRecycleBin).toHaveBeenCalledWith([`${ROOT}\\not-indexed.jpg`])
  })

  it('D3 未入库且未注册路径仍被 PATH_FORBIDDEN 拦截（安全边界不放宽）', async () => {
    const res = (await getHandler('file:delete')({}, ['Q:\\nowhere\\a.jpg'])) as IpcResponseLike
    expect(res.success).toBe(false)
    expect(res.error?.code).toBe(IPC_ERROR_CODES.PATH_FORBIDDEN)
    expect(fileService.moveToRecycleBin).not.toHaveBeenCalled()
  })

  it('D4 已入库媒体（敏感目录形态）经 file:deletePermanent 删除成功（不再弹原生确认）', async () => {
    isMediaPathAllowedMock.mockReturnValue(true)
    // #fix-permanent-delete-error-toast：渲染端 ConfirmDialog 已承担二次确认，
    // 主进程不得再弹原生对话框（修复前用户需重复确认，取消时还会误报错误）
    const steamPhoto =
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\InfinityNikki\\X6Game\\ScreenShot\\002.jpg'

    const res = (await getHandler('file:deletePermanent')({}, [steamPhoto])) as IpcResponseLike
    expect(res.success).toBe(true)
    expect(fileService.deletePermanent).toHaveBeenCalledWith([steamPhoto])
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('D5 file:copy 源路径不接入删除守卫（通道口径不变）', async () => {
    isMediaPathAllowedMock.mockReturnValue(true)

    const res = (await getHandler('file:copy')({}, ['Q:\\nowhere\\a.jpg'], ROOT)) as IpcResponseLike
    expect(res.success).toBe(false)
    expect(res.error?.code).toBe(IPC_ERROR_CODES.PATH_FORBIDDEN)
    expect(fileService.copyFiles).not.toHaveBeenCalled()
  })
})
