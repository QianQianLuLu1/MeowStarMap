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
import type { HandlerContext } from '../handler-context'
import { IPC_ERROR_CODES } from '../../../shared/types/ipc-types'
import { pathGuard } from '../validator'

const { handleMock, fileService } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  // 仅 file:delete 在用例中被调用；其余方法留桩避免 undefined 调用
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
