/**
 * @layer L3
 * @module src/main/ipc/handlers/decrypt-handler（decrypt:lookupCloth 校验面）
 * @coverage decrypt:lookupCloth 的真实 zod 入参校验（正整数 / 批量上限 50 / 非空 / 类型）
 * @remarks decrypt-handler.test.ts 用共享 mock-validator 会跳过 schema，故本文件不 mock
 *          validator，循 favorites-handler.test.ts 的真实校验先例（首参传伪 event）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeCtx, getHandler } from './_test-helpers'

const { handleMock, lookupClothDataMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  lookupClothDataMock: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock, on: vi.fn() } }))

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

vi.mock('../../services/cloth-data-service', () => ({
  lookupClothData: lookupClothDataMock
}))

import { registerDecryptHandlers } from './decrypt-handler'

interface LookupResult {
  success: boolean
  data?: { ok: boolean; data: Record<string, unknown> }
  error?: { code: string }
}

describe('decrypt:lookupCloth 参数校验（真实 zod）', () => {
  beforeEach(() => {
    handleMock.mockClear()
    lookupClothDataMock.mockReset()
  })

  it('合法正整数 ID 数组通过校验并透传 service 结果', async () => {
    lookupClothDataMock.mockResolvedValue(new Map([[1020100001, { name: '时光讯号' }]]))
    registerDecryptHandlers(makeCtx({}))
    const res = (await getHandler(handleMock, 'decrypt:lookupCloth')(
      {},
      [1020100001]
    )) as LookupResult
    expect(res.success).toBe(true)
    expect(res.data?.ok).toBe(true)
    expect(res.data?.data['1020100001']).toEqual({ name: '时光讯号' })
    expect(lookupClothDataMock).toHaveBeenCalledWith([1020100001])
  })

  it('批量超过 50 个 ID 拒绝（IPC_VALIDATION_ERROR），service 不被调用', async () => {
    registerDecryptHandlers(makeCtx({}))
    const ids = Array.from({ length: 51 }, (_, i) => 1020100001 + i)
    const res = (await getHandler(handleMock, 'decrypt:lookupCloth')({}, ids)) as LookupResult
    expect(res.success).toBe(false)
    expect(res.error?.code).toBe('IPC_VALIDATION_ERROR')
    expect(lookupClothDataMock).not.toHaveBeenCalled()
  })

  it('非法 ID（0 / -1 / 1.5 / 字符串）逐个拒绝（IPC_VALIDATION_ERROR）', async () => {
    registerDecryptHandlers(makeCtx({}))
    for (const bad of [0, -1, 1.5, 'x']) {
      const res = (await getHandler(handleMock, 'decrypt:lookupCloth')({}, [bad])) as LookupResult
      expect(res.success).toBe(false)
      expect(res.error?.code).toBe('IPC_VALIDATION_ERROR')
    }
    expect(lookupClothDataMock).not.toHaveBeenCalled()
  })

  it('空数组拒绝（IPC_VALIDATION_ERROR）', async () => {
    registerDecryptHandlers(makeCtx({}))
    const res = (await getHandler(handleMock, 'decrypt:lookupCloth')({}, [])) as LookupResult
    expect(res.success).toBe(false)
    expect(res.error?.code).toBe('IPC_VALIDATION_ERROR')
    expect(lookupClothDataMock).not.toHaveBeenCalled()
  })
})
