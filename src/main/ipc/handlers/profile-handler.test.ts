/**
 * @layer L3
 * @module src/main/ipc/handlers/profile-handler
 * @coverage profile:transferFiles 批量数组校验上限回归
 *
 * 修复回归点：profile:transferFiles 从 schemas.mediaIdArray（1000 上限）切换到
 * schemas.mediaIdArrayBulk。与 media.test.ts 不同，本文件不 mock ../validator——
 * wrapHandler 与 schemas 均为真实实现，zod 校验真实执行：
 * 若回退到 capped schema，1500 个 id 的用例必然失败，构成真回归防线。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HandlerContext } from '../handler-context'
import { IPC_ERROR_CODES } from '../../../shared/types/ipc-types'

const { handleMock, repoMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  repoMock: {
    getProfileByUid: vi.fn(),
    transferFilesToProfile: vi.fn()
  }
}))

vi.mock('electron', () => ({
  // validator.ts 顶层 import electron；PathGuard 仅在显式调用时用到 app
  app: { getPath: () => '/tmp', getName: () => 'test', getAppPath: () => '/tmp' },
  ipcMain: { handle: handleMock, on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('../../database/media-repository', () => ({
  MediaRepository: vi.fn(() => repoMock)
}))

import { registerProfileHandlers } from './profile-handler'

function makeCtx(): HandlerContext {
  return {
    dbManager: {
      getDatabase: vi.fn(() => ({})),
      getWorkerBridge: vi.fn(() => undefined),
      getDbPath: vi.fn(() => '/mock/db.sqlite')
    },
    getMainWindow: () => null,
    notifyMediaUpdated: vi.fn()
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
  data?: { transferred?: number }
  error?: { code: string; message: string }
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1)

describe('profile:transferFiles（mediaIdArrayBulk 切换回归）', () => {
  beforeEach(() => {
    handleMock.mockClear()
    repoMock.getProfileByUid.mockReset().mockReturnValue({ uid: 'nikki' })
    repoMock.transferFilesToProfile.mockReset().mockResolvedValue(undefined)
    registerProfileHandlers(makeCtx())
  })

  it('1500 个合法 id 校验通过并全量下发 repo（修复前 1000 上限会拒绝）', async () => {
    const res = (await getHandler('profile:transferFiles')(
      {},
      ids(1500),
      'nikki'
    )) as IpcResponseLike
    expect(res.success).toBe(true)
    expect(res.data?.transferred).toBe(1500)
    expect(repoMock.transferFilesToProfile).toHaveBeenCalledTimes(1)
    expect(repoMock.transferFilesToProfile).toHaveBeenCalledWith(ids(1500), 'nikki')
  })

  it('1001（旧上限边界 +1）与 3000 个 id 均通过', async () => {
    const handler = getHandler('profile:transferFiles')
    const r1 = (await handler({}, ids(1001), 'nikki')) as IpcResponseLike
    expect(r1.success).toBe(true)
    const r2 = (await handler({}, ids(3000), 'nikki')) as IpcResponseLike
    expect(r2.success).toBe(true)
    expect(repoMock.transferFilesToProfile).toHaveBeenCalledWith(ids(3000), 'nikki')
  })

  it('空数组仍被 min(1) 拒绝（安全边界不降）', async () => {
    const res = (await getHandler('profile:transferFiles')({}, [], 'nikki')) as IpcResponseLike
    expect(res.success).toBe(false)
    expect(res.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    expect(repoMock.transferFilesToProfile).not.toHaveBeenCalled()
  })

  it('含 0/负数/小数/非数字的元素仍被正整数校验拒绝', async () => {
    const bad = [1, 0, -5, 1.5, 'x' as unknown as number]
    const res = (await getHandler('profile:transferFiles')({}, bad, 'nikki')) as IpcResponseLike
    expect(res.success).toBe(false)
    expect(res.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    expect(repoMock.transferFilesToProfile).not.toHaveBeenCalled()
  })

  it('目标档案不存在时返回 NOT_FOUND（业务分支不受 schema 放宽影响）', async () => {
    repoMock.getProfileByUid.mockReturnValue(undefined)
    const res = (await getHandler('profile:transferFiles')({}, ids(3), 'ghost')) as IpcResponseLike
    expect(res.success).toBe(false)
    expect(res.error?.code).toBe(IPC_ERROR_CODES.NOT_FOUND)
    expect(repoMock.transferFilesToProfile).not.toHaveBeenCalled()
  })
})
