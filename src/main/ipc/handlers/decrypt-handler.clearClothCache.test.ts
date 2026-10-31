/**
 * @layer L3
 * @module src/main/ipc/handlers/decrypt-handler（decrypt:clearClothCache 通道）
 * @coverage decrypt:clearClothCache 的注册、内层 {ok, data} 返回形态与 service 抛错转译（阶段 3）
 * @remarks 无参通道走 wrapHandlerNoArgs，无 zod 校验面；mock cloth-diy-cache 断言透传
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeCtx, getHandler } from './_test-helpers'

const { handleMock, clearClothDiyCacheMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  clearClothDiyCacheMock: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock, on: vi.fn() } }))

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

vi.mock('../../services/cloth-diy-cache', () => ({
  clearClothDiyCache: clearClothDiyCacheMock
}))

import { registerDecryptHandlers } from './decrypt-handler'

interface ClearResult {
  success: boolean
  data?: { ok: boolean; data: { clearedCount: number; clearedSize: number } }
  error?: { code: string }
}

describe('decrypt:clearClothCache（阶段 3 搭配码缓存清理通道）', () => {
  beforeEach(() => {
    handleMock.mockClear()
    clearClothDiyCacheMock.mockReset()
  })

  it('注册通道且调用透传 service 结果（内层 {ok, data} 形态）', async () => {
    clearClothDiyCacheMock.mockResolvedValue({ clearedCount: 3, clearedSize: 123 })
    registerDecryptHandlers(makeCtx({}))
    const res = (await getHandler(handleMock, 'decrypt:clearClothCache')({})) as ClearResult
    expect(res.success).toBe(true)
    expect(res.data?.ok).toBe(true)
    expect(res.data?.data).toEqual({ clearedCount: 3, clearedSize: 123 })
    expect(clearClothDiyCacheMock).toHaveBeenCalledTimes(1)
  })

  it('service 抛错 → success:false（handleError 转译 IPC_INTERNAL_ERROR），不崩溃', async () => {
    clearClothDiyCacheMock.mockRejectedValue(new Error('readdir failed'))
    registerDecryptHandlers(makeCtx({}))
    const res = (await getHandler(handleMock, 'decrypt:clearClothCache')({})) as ClearResult
    expect(res.success).toBe(false)
    expect(res.error?.code).toBe('IPC_INTERNAL_ERROR')
  })
})
