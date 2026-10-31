/**
 * @layer L3
 * @module src/main/ipc/handlers/decrypt-handler
 * @coverage decrypt 域 IPC handler 注册与执行（decodeFile / encodeCameraParams / decodeClothDiy / decodeHomeBuild / lookupCloth）
 * @remarks lookupCloth 的真实 zod 校验面在 decrypt-handler.lookupCloth.test.ts（本文件 mock validator 跳过 schema）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeCtx, getHandler } from './_test-helpers'

const {
  handleMock,
  decodeFileParamsMock,
  encodeCameraParamsMock,
  decodeClothDiyShareCodeMock,
  decodeHomeBuildShareCodeMock,
  lookupClothDataMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  decodeFileParamsMock: vi.fn(),
  encodeCameraParamsMock: vi.fn(),
  decodeClothDiyShareCodeMock: vi.fn(),
  decodeHomeBuildShareCodeMock: vi.fn(),
  lookupClothDataMock: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock, on: vi.fn() } }))

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

vi.mock('../../services/decryption-service', () => ({
  decodeFileParams: decodeFileParamsMock,
  encodeCameraParams: encodeCameraParamsMock,
  decodeClothDiyShareCode: decodeClothDiyShareCodeMock,
  decodeHomeBuildShareCode: decodeHomeBuildShareCodeMock
}))

vi.mock('../../services/cloth-data-service', () => ({
  lookupClothData: lookupClothDataMock
}))

vi.mock('../validator', async () => await import('../../../../tests/mocks/mock-validator'))

import { registerDecryptHandlers } from './decrypt-handler'
import { assertFileReadPath, assertFileWritePath } from '../validator'

const assertFileReadPathMock = vi.mocked(assertFileReadPath)
const assertFileWritePathMock = vi.mocked(assertFileWritePath)

describe('registerDecryptHandlers', () => {
  beforeEach(() => {
    handleMock.mockClear()
    decodeFileParamsMock.mockReset()
    encodeCameraParamsMock.mockReset()
    decodeClothDiyShareCodeMock.mockReset()
    decodeHomeBuildShareCodeMock.mockReset()
    lookupClothDataMock.mockReset()
    assertFileReadPathMock.mockReset()
    assertFileWritePathMock.mockReset()
  })

  it('应注册 5 个 decrypt channel', () => {
    registerDecryptHandlers(makeCtx({}))
    const channels = handleMock.mock.calls.map((c) => c[0])
    expect(channels).toContain('decrypt:decodeFile')
    expect(channels).toContain('decrypt:encodeCameraParams')
    expect(channels).toContain('decrypt:decodeClothDiy')
    expect(channels).toContain('decrypt:decodeHomeBuild')
    expect(channels).toContain('decrypt:lookupCloth')
  })

  it('decrypt:decodeFile 调用 decodeFileParams 并返回 { ok, data, message }', async () => {
    decodeFileParamsMock.mockResolvedValue({ params: { a: 1 } })
    registerDecryptHandlers(makeCtx({}))
    const result = (await getHandler(
      handleMock,
      'decrypt:decodeFile'
    )(['/file', 'albumType', 'uid'])) as {
      success: true
      data: { ok: boolean; data: unknown }
    }
    expect(assertFileReadPathMock).toHaveBeenCalledWith('/file')
    expect(decodeFileParamsMock).toHaveBeenCalledWith('/file', 'albumType', 'uid', undefined)
    expect(result.data.ok).toBe(true)
  })

  it('decrypt:decodeFile 返回 error 时 ok=false', async () => {
    decodeFileParamsMock.mockResolvedValue({ error: '解码失败' })
    registerDecryptHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'decrypt:decodeFile')(['/f', 'a'])) as {
      success: true
      data: { ok: boolean; message: string }
    }
    expect(result.data.ok).toBe(false)
    expect(result.data.message).toBe('解码失败')
  })

  it('decrypt:encodeCameraParams 返回 base64 字符串', async () => {
    encodeCameraParamsMock.mockResolvedValue({ success: true, data: Buffer.from([1, 2, 3]) })
    registerDecryptHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'decrypt:encodeCameraParams')(['{}'])) as {
      success: true
      data: { ok: boolean; data: string }
    }
    expect(encodeCameraParamsMock).toHaveBeenCalledWith('{}')
    expect(result.data.ok).toBe(true)
    expect(result.data.data).toBe(Buffer.from([1, 2, 3]).toString('base64'))
  })

  it('decrypt:encodeCameraParams 失败时不返回 data', async () => {
    encodeCameraParamsMock.mockResolvedValue({ success: false, error: '加密失败' })
    registerDecryptHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'decrypt:encodeCameraParams')(['{}'])) as {
      success: true
      data: { ok: boolean; data: undefined }
    }
    expect(result.data.ok).toBe(false)
    expect(result.data.data).toBeUndefined()
  })

  it('decrypt:decodeClothDiy 返回 timestamp/uidBytes/networkData/structured', async () => {
    const structured = {
      clothes: [{ id: 1020100001, clothType: 10, state: 0, species: 102, outfitFeature: 1 }]
    }
    decodeClothDiyShareCodeMock.mockResolvedValue({
      success: true,
      timestamp: 123,
      uidBytes: Buffer.from([1, 2]),
      networkData: { k: 'v' },
      structured
    })
    registerDecryptHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'decrypt:decodeClothDiy')(['code'])) as {
      success: true
      data: {
        ok: boolean
        data: { timestamp: number; uidBytes: string; networkData: unknown; structured: unknown }
      }
    }
    expect(result.data.ok).toBe(true)
    expect(result.data.data.timestamp).toBe(123)
    expect(result.data.data.uidBytes).toBe('0102')
    // structured 原样透传（阶段 1）
    expect(result.data.data.structured).toEqual(structured)
  })

  it('decrypt:decodeClothDiy structured 缺省时透传 undefined（网络失败路径）', async () => {
    decodeClothDiyShareCodeMock.mockResolvedValue({ success: true, timestamp: 1 })
    registerDecryptHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'decrypt:decodeClothDiy')(['code'])) as {
      success: true
      data: { ok: boolean; data: { structured: unknown } }
    }
    expect(result.data.data.structured).toBeUndefined()
  })

  it('decrypt:decodeHomeBuild 返回 server/networkData', async () => {
    decodeHomeBuildShareCodeMock.mockResolvedValue({
      success: true,
      server: 's1',
      networkData: { k: 1 }
    })
    registerDecryptHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'decrypt:decodeHomeBuild')(['code'])) as {
      success: true
      data: { ok: boolean; data: { server: string } }
    }
    expect(result.data.ok).toBe(true)
    expect(result.data.data.server).toBe('s1')
  })

  it('decrypt:lookupCloth 透传 service 结果并转为 Record（键为 ID 十进制字符串）', async () => {
    lookupClothDataMock.mockResolvedValue(
      new Map([
        [1020100001, { name: '时光讯号', iconUrl: 'https://cdn.example.test/x.png' }],
        [1020100002, {}]
      ])
    )
    registerDecryptHandlers(makeCtx({}))
    // mock-validator 约定：第一个实参即参数元组；单元素元组（元素为数组）故传 [[ids]]
    const result = (await getHandler(
      handleMock,
      'decrypt:lookupCloth'
    )([[1020100001, 1020100002]])) as {
      success: true
      data: { ok: boolean; data: Record<string, unknown>; message?: string }
    }
    expect(lookupClothDataMock).toHaveBeenCalledWith([1020100001, 1020100002])
    expect(result.data.ok).toBe(true)
    expect(result.data.data['1020100001']).toEqual({
      name: '时光讯号',
      iconUrl: 'https://cdn.example.test/x.png'
    })
    // 未收录的 ID 对应空对象
    expect(result.data.data['1020100002']).toEqual({})
    expect(result.data.message).toBeUndefined()
  })
})
