/**
 * @layer L3
 * @module src/main/ipc/handlers/reference-data-handler
 * @coverage refdata 域 5 通道：注册齐全、无参包装的内层 success 信封、
 *           refresh 读取镜像设置键并转发 force、查询面透传空态、
 *           resolve-image 的 zod 入参校验 / 图片镜像键转发 / fail-soft 透传。
 *
 * service 模块整体 mock（管道行为已有 reference-data-service.test.ts、
 * 取图与缓存行为已有 reference-image-service.test.ts 覆盖），
 * 这里只测 handler 层的注册与转发契约。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeCtx, getHandler } from './_test-helpers'
import { registerReferenceDataHandlers } from './reference-data-handler'
import { IPC_ERROR_CODES } from '../../../shared/types/ipc-types'
import { NETWORK_IMAGE_KINDS } from '../../../shared/network-image-kinds'

const serviceMock = vi.hoisted(() => ({
  getStatus: vi.fn(),
  checkForUpdate: vi.fn(),
  getWorldMapTiles: vi.fn(),
  getNetworkImageTemplates: vi.fn()
}))

vi.mock('../../services/reference-data-service', () => serviceMock)

const imageServiceMock = vi.hoisted(() => ({
  resolveReferenceImage: vi.fn()
}))

vi.mock('../../services/reference-image-service', () => imageServiceMock)

const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: vi.fn() }
}))

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

const STATUS = {
  available: true,
  packages: [{ id: 'nuan5_database', versionId: '5db41b98-8a05-4ff8-a6fd-bed301c2a2d1' }],
  lastCheckedAt: '2026-11-08T00:00:00.000Z',
  lastError: null,
  updating: false
}

const MANIFEST_KEY = 'referenceData.manifestBaseUrl'
const IMAGE_MIRROR_KEY = 'referenceData.imageMirrorBaseUrl'

function makeCtxWithSetting(value: unknown) {
  const ctx = makeCtx({})
  ;(ctx.dbManager.getSetting as ReturnType<typeof vi.fn>).mockReturnValue(value)
  return ctx
}

/** 按键分别返回设置值的 ctx（两个镜像键语义不同，不可共用一个 blanket mock） */
function makeCtxWithSettings(values: Record<string, unknown>) {
  const ctx = makeCtx({})
  ;(ctx.dbManager.getSetting as ReturnType<typeof vi.fn>).mockImplementation(
    (key: string, fallback?: unknown) => values[key] ?? fallback ?? ''
  )
  return ctx
}

beforeEach(() => {
  handleMock.mockClear()
  serviceMock.getStatus.mockReset()
  serviceMock.checkForUpdate.mockReset()
  serviceMock.getWorldMapTiles.mockReset()
  serviceMock.getNetworkImageTemplates.mockReset()
  imageServiceMock.resolveReferenceImage.mockReset()
})

describe('registerReferenceDataHandlers', () => {
  it('注册 refdata: 域全部 5 条通道', () => {
    registerReferenceDataHandlers(makeCtx({}))
    const channels = handleMock.mock.calls.map((call) => call[0])
    expect(channels).toEqual([
      'refdata:get-status',
      'refdata:refresh',
      'refdata:get-world-map-tiles',
      'refdata:get-network-image-templates',
      'refdata:resolve-image'
    ])
  })

  it('get-status：内层返回 success 信封包裹的状态', async () => {
    serviceMock.getStatus.mockReturnValue(STATUS)
    registerReferenceDataHandlers(makeCtx({}))

    const handler = getHandler(handleMock, 'refdata:get-status')
    const result = (await handler({}, null)) as { success: boolean; data: unknown }

    expect(result.success).toBe(true)
    expect(result.data).toEqual(STATUS)
    expect(serviceMock.getStatus).toHaveBeenCalledTimes(1)
  })

  it('refresh：读出镜像设置键并 force 转发给服务', async () => {
    serviceMock.checkForUpdate.mockResolvedValue(STATUS)
    registerReferenceDataHandlers(makeCtxWithSetting('https://mirror.example.test'))

    const handler = getHandler(handleMock, 'refdata:refresh')
    const result = (await handler({}, null)) as { success: boolean; data: unknown }

    expect(result.success).toBe(true)
    expect(result.data).toEqual(STATUS)
    expect(serviceMock.checkForUpdate).toHaveBeenCalledWith({
      force: true,
      manifestBaseUrl: 'https://mirror.example.test'
    })
  })

  it('refresh：设置缺省（getSetting 返回空串）→ 空镜像转发（服务用官方站点）', async () => {
    serviceMock.checkForUpdate.mockResolvedValue(STATUS)
    registerReferenceDataHandlers(makeCtxWithSetting(''))

    const handler = getHandler(handleMock, 'refdata:refresh')
    await handler({}, null)

    expect(serviceMock.checkForUpdate).toHaveBeenCalledWith({ force: true, manifestBaseUrl: '' })
  })

  it('get-world-map-tiles：返回 { tiles } 包裹，不可用时为空数组', async () => {
    serviceMock.getWorldMapTiles.mockReturnValue([])
    registerReferenceDataHandlers(makeCtx({}))

    const handler = getHandler(handleMock, 'refdata:get-world-map-tiles')
    const result = (await handler({}, null)) as { success: boolean; data: { tiles: unknown[] } }

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ tiles: [] })
  })

  it('get-network-image-templates：返回 { templates } 包裹', async () => {
    const template = {
      kind: 'cloth',
      baseUrl: 'https://cdn.example.test/img/{id}.png',
      replace: '{id}'
    }
    serviceMock.getNetworkImageTemplates.mockReturnValue([template])
    registerReferenceDataHandlers(makeCtx({}))

    const handler = getHandler(handleMock, 'refdata:get-network-image-templates')
    const result = (await handler({}, null)) as {
      success: boolean
      data: { templates: unknown[] }
    }

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ templates: [template] })
  })
})

describe('refdata:resolve-image（阶段 5 · 参考数据 CDN 图片按需解析）', () => {
  function registerAndGetHandler(ctx: ReturnType<typeof makeCtx>) {
    registerReferenceDataHandlers(ctx)
    return getHandler(handleMock, 'refdata:resolve-image')
  }

  it('正常：合法 kind+id → 转发服务并透传 { path, status }', async () => {
    const payload = { path: 'C:/ud/reference-data/reference-images/ab.webp', status: 'fetched' }
    imageServiceMock.resolveReferenceImage.mockResolvedValue(payload)
    const handler = registerAndGetHandler(makeCtxWithSettings({ [IMAGE_MIRROR_KEY]: '' }))

    const result = (await handler(null, 'light', 100)) as { success: boolean; data: unknown }

    expect(result.success).toBe(true)
    expect(result.data).toEqual(payload)
    expect(imageServiceMock.resolveReferenceImage).toHaveBeenCalledWith('light', 100, {
      mirrorBaseUrl: ''
    })
  })

  it('正常：读出图片镜像设置键并转发（与 manifest 镜像键互不串用）', async () => {
    imageServiceMock.resolveReferenceImage.mockResolvedValue({ path: null, status: 'cached' })
    const handler = registerAndGetHandler(
      makeCtxWithSettings({
        [MANIFEST_KEY]: 'https://manifest-mirror.example.test',
        [IMAGE_MIRROR_KEY]: 'https://image-mirror.example.test'
      })
    )

    await handler(null, 'filter', 7)

    expect(imageServiceMock.resolveReferenceImage).toHaveBeenCalledWith('filter', 7, {
      mirrorBaseUrl: 'https://image-mirror.example.test'
    })
  })

  it('fail-soft：服务返回 path=null 时仍是 success 信封（不转成 IPC 错误）', async () => {
    imageServiceMock.resolveReferenceImage.mockResolvedValue({
      path: null,
      status: 'unauthorized'
    })
    const handler = registerAndGetHandler(makeCtxWithSettings({}))

    const result = (await handler(null, 'cloth', 9001)) as {
      success: boolean
      data: { path: null; status: string }
    }

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ path: null, status: 'unauthorized' })
  })

  it.each([
    ['未登记的 kind', 'worldMapTile'],
    ['空串 kind', ''],
    ['非字符串 kind', 42],
    ['null kind', null]
  ])('异常：%s → VALIDATION_ERROR 且零服务调用', async (_label, kind) => {
    const handler = registerAndGetHandler(makeCtxWithSettings({}))

    const result = (await handler(null, kind, 1)) as {
      success: boolean
      error?: { code: string }
    }

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    expect(imageServiceMock.resolveReferenceImage).not.toHaveBeenCalled()
  })

  it.each([
    ['0', 0],
    ['负数', -1],
    ['小数', 1.5],
    ['非数值', '100'],
    ['null', null],
    ['NaN', Number.NaN]
  ])('异常：id 为%s → VALIDATION_ERROR 且零服务调用', async (_label, id) => {
    const handler = registerAndGetHandler(makeCtxWithSettings({}))

    const result = (await handler(null, 'light', id)) as {
      success: boolean
      error?: { code: string }
    }

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    expect(imageServiceMock.resolveReferenceImage).not.toHaveBeenCalled()
  })

  it('边界：id = 1 与 MAX_SAFE_INTEGER 均通过校验', async () => {
    imageServiceMock.resolveReferenceImage.mockResolvedValue({ path: null, status: 'cached' })
    const handler = registerAndGetHandler(makeCtxWithSettings({}))

    expect((await handler(null, 'light', 1)).success).toBe(true)
    expect((await handler(null, 'light', Number.MAX_SAFE_INTEGER)).success).toBe(true)
    expect(imageServiceMock.resolveReferenceImage).toHaveBeenCalledTimes(2)
  })

  it('边界：10 个 kind 全部通过枚举校验（NETWORK_IMAGE_KINDS 全集，无遗漏）', async () => {
    imageServiceMock.resolveReferenceImage.mockResolvedValue({
      path: null,
      status: 'unauthorized'
    })
    const handler = registerAndGetHandler(makeCtxWithSettings({}))
    const kinds = NETWORK_IMAGE_KINDS

    for (const kind of kinds) {
      const result = (await handler(null, kind, 1)) as { success: boolean }
      expect(result.success, kind).toBe(true)
    }
    expect(imageServiceMock.resolveReferenceImage).toHaveBeenCalledTimes(kinds.length)
  })

  it('边界：设置键缺省（getSetting 回落默认值）→ 转发空镜像', async () => {
    imageServiceMock.resolveReferenceImage.mockResolvedValue({ path: null, status: 'cached' })
    const ctx = makeCtx({})
    ;(ctx.dbManager.getSetting as ReturnType<typeof vi.fn>).mockImplementation(
      (_key: string, fallback: unknown) => fallback
    )
    const handler = registerAndGetHandler(ctx)

    await handler(null, 'light', 1)

    expect(imageServiceMock.resolveReferenceImage).toHaveBeenCalledWith('light', 1, {
      mirrorBaseUrl: ''
    })
  })
})

// ===== T4：外部图片总开关（gongeo #218「保持可回滚」）=====
describe('refdata:resolve-image 总开关短路', () => {
  /** 按精确值构造 ctx（不能用 makeCtxWithSettings：其 ?? 会把 false 回退成默认 true） */
  function ctxWithSwitch(value: unknown): ReturnType<typeof makeCtx> {
    const ctx = makeCtx({})
    ;(ctx.dbManager.getSetting as ReturnType<typeof vi.fn>).mockImplementation(
      (key: string, fallback?: unknown) =>
        key === 'referenceData.remoteImagesEnabled' ? value : (fallback ?? '')
    )
    return ctx
  }

  function handlerFor(ctx: ReturnType<typeof makeCtx>) {
    registerReferenceDataHandlers(ctx)
    return getHandler(handleMock, 'refdata:resolve-image')
  }

  it('开关为 false → 返回 disabled，零网络（不调用取图服务）', async () => {
    const result = (await handlerFor(ctxWithSwitch(false))(null, 'light', 1)) as {
      success: boolean
      data?: { path: string | null; status: string }
    }
    expect(result.success).toBe(true)
    expect(result.data?.path).toBeNull()
    expect(result.data?.status).toBe('disabled')
    expect(imageServiceMock.resolveReferenceImage).not.toHaveBeenCalled()
  })

  it('异常：开关值非 boolean（"false" 字符串）→ 按安全默认关闭', async () => {
    const result = (await handlerFor(ctxWithSwitch('false'))(null, 'light', 1)) as {
      data?: { path: string | null; status: string }
    }
    expect(result.data?.status).toBe('disabled')
    expect(imageServiceMock.resolveReferenceImage).not.toHaveBeenCalled()
  })

  it('边界：开关缺省（getSetting 回落默认 true）→ 保持既有取图行为', async () => {
    imageServiceMock.resolveReferenceImage.mockResolvedValue({ path: null, status: 'cached' })
    const ctx = makeCtx({})
    ;(ctx.dbManager.getSetting as ReturnType<typeof vi.fn>).mockImplementation(
      (_key: string, fallback: unknown) => fallback ?? ''
    )
    const result = (await handlerFor(ctx)(null, 'light', 1)) as { success: boolean }
    expect(result.success).toBe(true)
    expect(imageServiceMock.resolveReferenceImage).toHaveBeenCalledTimes(1)
  })
})
