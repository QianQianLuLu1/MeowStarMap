/**
 * @layer L3
 * @module src/main/ipc/handlers/decrypt-handler
 * @coverage decrypt 域 IPC handler 注册与执行（decodeFile / encodeCameraParams / decodeClothDiy / decodeHomeBuild）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeCtx, getHandler } from './_test-helpers'

const {
  handleMock,
  decodeFileParamsMock,
  encodeCameraParamsMock,
  decodeClothDiyShareCodeMock,
  decodeHomeBuildShareCodeMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  decodeFileParamsMock: vi.fn(),
  encodeCameraParamsMock: vi.fn(),
  decodeClothDiyShareCodeMock: vi.fn(),
  decodeHomeBuildShareCodeMock: vi.fn()
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
    assertFileReadPathMock.mockReset()
    assertFileWritePathMock.mockReset()
  })

  it('应注册 4 个 decrypt channel', () => {
    registerDecryptHandlers(makeCtx({}))
    const channels = handleMock.mock.calls.map((c) => c[0])
    expect(channels).toContain('decrypt:decodeFile')
    expect(channels).toContain('decrypt:encodeCameraParams')
    expect(channels).toContain('decrypt:decodeClothDiy')
    expect(channels).toContain('decrypt:decodeHomeBuild')
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

  it('decrypt:decodeClothDiy 返回 timestamp/uidBytes/networkData', async () => {
    decodeClothDiyShareCodeMock.mockResolvedValue({
      success: true,
      timestamp: 123,
      uidBytes: Buffer.from([1, 2]),
      networkData: { k: 'v' }
    })
    registerDecryptHandlers(makeCtx({}))
    const result = (await getHandler(handleMock, 'decrypt:decodeClothDiy')(['code'])) as {
      success: true
      data: { ok: boolean; data: { timestamp: number; uidBytes: string; networkData: unknown } }
    }
    expect(result.data.ok).toBe(true)
    expect(result.data.data.timestamp).toBe(123)
    expect(result.data.data.uidBytes).toBe('0102')
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
})
