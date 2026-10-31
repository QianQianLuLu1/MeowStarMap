import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * @layer L2
 * @module src/main/services/cloth-data-service
 * @coverage gongeo.us 第三方服饰数据查询：正常映射 / 超时 / 404 负缓存 / 网络错误不缓存 /
 *           批量去重 / 非法 ID 过滤 / LRU 淘汰 / URL 安全守卫 / 5 位套装路由 / name map 失败冷却
 * @dependencies logger（mock）；fetch 与数据源配置经 setter 注入，零真实网络、不写死第三方 URL
 */

vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}))

// ============================================================
// Import after mock
// ============================================================
import {
  lookupClothData,
  setClothDataConfig,
  setClothDataFetcher,
  disposeClothDataService
} from './cloth-data-service'
import type { ClothDataConfig } from './cloth-data-config'

// ============================================================
// Fixtures（数据形状逐字对齐契约 §6.1 接入口 2 的响应示例）
// ============================================================

const ITEM_ID = 1020100001
const ITEM_ID_2 = 1020100002
const ITEM_ID_3 = 1020100003
const OUTFIT_ID = 20013

const DATA_API_ITEM = {
  id: ITEM_ID,
  props: [71, 544],
  description: 'sample description',
  item_attributes: {
    category: 'twin_tails',
    subcategory: 'high_twin_tails',
    metadata: { bangs: 'blunt_bangs' }
  }
}

const DATA_API_ITEM_2 = { ...DATA_API_ITEM, id: ITEM_ID_2 }
const DATA_API_ITEM_3 = { ...DATA_API_ITEM, id: ITEM_ID_3 }

const DATA_API_OUTFIT = {
  id: OUTFIT_ID,
  props: [59],
  description: 'outfit description',
  item_attributes: { category: 'outfit', subcategory: 'dress' }
}

// ============================================================
// Helpers
// ============================================================

interface RecordedCall {
  url: string
  init?: RequestInit
}

/** 注入 mock fetch 并记录调用；impl 抛错/返回 rejected promise 均由 service 兜底 */
function installFetch(
  impl: (url: string, init?: RequestInit) => Promise<Response> | Response
): RecordedCall[] {
  const calls: RecordedCall[] = []
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return impl(url, init)
  })
  setClothDataFetcher(fetchMock as unknown as typeof fetch)
  return calls
}

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body)
  } as unknown as Response
}

/** 注入测试数据源配置（URL 全部走注入，不写死第三方域名；未覆盖字段取默认值） */
function installTestConfig(overrides: Partial<ClothDataConfig> = {}): void {
  setClothDataConfig({
    dataApiBase: 'https://data.example.test/v1',
    cdnBase: 'https://cdn.example.test/images',
    nameIndexBase: 'https://raw.example.test/locales',
    allowedHosts: ['data.example.test', 'cdn.example.test', 'raw.example.test'],
    timeoutMs: 1000,
    ...overrides
  })
}

function countCalls(calls: RecordedCall[], pattern: RegExp): number {
  return calls.filter((c) => pattern.test(c.url)).length
}

beforeEach(() => {
  vi.clearAllMocks()
  setClothDataConfig(null)
  setClothDataFetcher(null)
})

afterEach(() => {
  setClothDataConfig(null)
  setClothDataFetcher(null)
  // 缓存与 name map 是 service 模块级状态，必须逐用例重置，避免跨用例泄漏
  disposeClothDataService()
  vi.useRealTimers()
})

// ============================================================
// lookupClothData
// ============================================================

describe('lookupClothData', () => {
  it('正常返回：name/iconUrl/tags/raw 合并，styleScore 恒缺省', async () => {
    installTestConfig()
    const calls = installFetch((url) => {
      if (url.includes('/locales/zh/item.json')) {
        return jsonRes({ item: { [String(ITEM_ID)]: { name: '时光讯号' } } })
      }
      if (url.endsWith(`/items/${ITEM_ID}`)) return jsonRes(DATA_API_ITEM)
      throw new Error(`unexpected url: ${url}`)
    })

    const map = await lookupClothData([ITEM_ID])
    const info = map.get(ITEM_ID)
    expect(info?.name).toBe('时光讯号')
    expect(info?.iconUrl).toBe(`https://cdn.example.test/images/items/icons/${ITEM_ID}.png`)
    expect(info?.tags).toEqual(['twin_tails', 'high_twin_tails', 'blunt_bangs'])
    expect(info?.raw).toEqual(DATA_API_ITEM)
    expect(info?.styleScore).toBeUndefined()
    // name map（1 次）+ data API（1 次）
    expect(calls.length).toBe(2)
  })

  it('data API 超时 → 空对象且不缓存（第二次查询重新发起请求）', async () => {
    installTestConfig()
    vi.useFakeTimers()
    const calls = installFetch((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    })

    const first = lookupClothData([ITEM_ID])
    await vi.advanceTimersByTimeAsync(1500)
    const m1 = await first
    expect(m1.get(ITEM_ID)).toEqual({})

    const callsBefore = calls.length
    const second = lookupClothData([ITEM_ID])
    await vi.advanceTimersByTimeAsync(1500)
    await second
    expect(calls.length).toBe(callsBefore + 1)
  })

  it('ID 不在库中（404）→ 空对象且负缓存（第二次查询 0 网络调用）', async () => {
    installTestConfig()
    const calls = installFetch((url) => {
      if (url.includes('/locales/zh/item.json')) return jsonRes({ item: {} })
      return jsonRes({ error: 'INVALID_ID' }, 404)
    })

    const m1 = await lookupClothData([ITEM_ID])
    expect(m1.get(ITEM_ID)).toEqual({})
    expect(countCalls(calls, /\/items\//)).toBe(1)

    const m2 = await lookupClothData([ITEM_ID])
    expect(m2.get(ITEM_ID)).toEqual({})
    expect(countCalls(calls, /\/items\//)).toBe(1)
  })

  it('数据源不可达（fetch reject）→ resolve 空对象而非 reject，且不缓存', async () => {
    installTestConfig()
    const calls = installFetch(() => Promise.reject(new Error('ECONNREFUSED')))

    const m1 = await lookupClothData([ITEM_ID])
    expect(m1.get(ITEM_ID)).toEqual({})

    await lookupClothData([ITEM_ID])
    expect(calls.length).toBe(2)
  })

  it('批量含重复 ID → 去重后每个唯一 ID 仅请求一次，name map 仅加载一次', async () => {
    installTestConfig()
    const calls = installFetch((url) => {
      if (url.includes('/locales/zh/item.json')) {
        return jsonRes({ item: { [String(ITEM_ID)]: { name: '时光讯号' } } })
      }
      if (url.endsWith(`/items/${ITEM_ID}`)) return jsonRes(DATA_API_ITEM)
      if (url.endsWith(`/items/${ITEM_ID_2}`)) return jsonRes(DATA_API_ITEM_2)
      throw new Error(`unexpected url: ${url}`)
    })

    const map = await lookupClothData([ITEM_ID, ITEM_ID, ITEM_ID_2])
    expect(map.size).toBe(2)
    expect(countCalls(calls, /\/items\//)).toBe(2)
    expect(countCalls(calls, /\/locales\/zh\/item\.json/)).toBe(1)
    expect(map.get(ITEM_ID)?.name).toBe('时光讯号')
  })

  it('非法 ID（0、负数、小数、字符串、NaN）→ 全部空对象且 0 网络调用', async () => {
    installTestConfig()
    const calls = installFetch(() => {
      throw new Error('非法 ID 不应发起网络请求')
    })

    const invalidIds = [0, -1, 1.5, 'x' as unknown as number, Number.NaN]
    const map = await lookupClothData(invalidIds)
    for (const id of invalidIds) {
      expect(map.get(id)).toEqual({})
    }
    expect(calls.length).toBe(0)
  })

  it('LRU：同 ID 二次查询 0 请求；超出 cacheMaxEntries 后最旧条目被淘汰并重新请求', async () => {
    installTestConfig({ cacheMaxEntries: 2 })
    const calls = installFetch((url) => {
      if (url.includes('/locales/zh/item.json')) return jsonRes({ item: {} })
      return jsonRes({ error: 'INVALID_ID' }, 404)
    })

    await lookupClothData([ITEM_ID, ITEM_ID_2, ITEM_ID_3])
    expect(countCalls(calls, /\/items\//)).toBe(3)

    // cacheMaxEntries=2：…001 已被淘汰，重新查询应再次发请求；…003 仍在缓存
    await lookupClothData([ITEM_ID])
    expect(countCalls(calls, /\/items\//)).toBe(4)
    await lookupClothData([ITEM_ID_3])
    expect(countCalls(calls, /\/items\//)).toBe(4)
  })

  it('URL 安全守卫：localhost / 环回 / 私网 / 非 http(s) 一律请求前拒绝（0 网络调用）', async () => {
    const cases: Array<Partial<ClothDataConfig>> = [
      // (a) host 不在白名单
      { dataApiBase: 'https://evil.example.test/v1', allowedHosts: ['data.example.test'] },
      // (b) 白名单误填环回地址（显式环回/私网拒绝兜底）
      { dataApiBase: 'http://127.0.0.1:9/v1', allowedHosts: ['127.0.0.1'] },
      { dataApiBase: 'http://localhost:9/v1', allowedHosts: ['localhost'] },
      // (c) 私网 IP 字面量
      { dataApiBase: 'http://192.168.1.1/v1', allowedHosts: ['192.168.1.1'] },
      // (d) 非 http/https 协议
      { dataApiBase: 'ftp://data.example.test/v1', allowedHosts: ['data.example.test'] }
    ]

    for (const overrides of cases) {
      installTestConfig(overrides)
      const calls = installFetch(() => {
        throw new Error('URL 安全守卫不应放行该请求')
      })
      const map = await lookupClothData([ITEM_ID])
      expect(map.get(ITEM_ID)).toEqual({})
      expect(calls.length).toBe(0)
    }
  })

  it('5 位套装 ID 路由：outfits 端点 + outfit.json 名称 + 套装图标路径', async () => {
    installTestConfig()
    const calls = installFetch((url) => {
      if (url.includes('/locales/zh/outfit.json')) {
        return jsonRes({ outfit: { [String(OUTFIT_ID)]: { name: '套装名' } } })
      }
      if (url.endsWith(`/outfits/${OUTFIT_ID}`)) return jsonRes(DATA_API_OUTFIT)
      throw new Error(`unexpected url: ${url}`)
    })

    const map = await lookupClothData([OUTFIT_ID])
    const info = map.get(OUTFIT_ID)
    expect(info?.name).toBe('套装名')
    expect(info?.iconUrl).toBe(`https://cdn.example.test/images/outfits/${OUTFIT_ID}.png`)
    expect(info?.tags).toEqual(['outfit', 'dress'])
    expect(countCalls(calls, /\/outfits\//)).toBe(1)
  })

  it('name map 拉取失败 → name 缺省但 tags/iconUrl 照常；冷却期内不重试、冷却后重试', async () => {
    installTestConfig({ nameMapRetryCooldownMs: 60_000 })
    vi.useFakeTimers()
    const calls = installFetch((url) => {
      if (url.includes('/locales/zh/item.json')) return jsonRes({}, 500)
      if (url.endsWith(`/items/${ITEM_ID}`)) return jsonRes(DATA_API_ITEM)
      if (url.endsWith(`/items/${ITEM_ID_2}`)) return jsonRes(DATA_API_ITEM_2)
      if (url.endsWith(`/items/${ITEM_ID_3}`)) return jsonRes(DATA_API_ITEM_3)
      throw new Error(`unexpected url: ${url}`)
    })

    const m1 = await lookupClothData([ITEM_ID])
    expect(m1.get(ITEM_ID)?.name).toBeUndefined()
    expect(m1.get(ITEM_ID)?.iconUrl).toBe(
      `https://cdn.example.test/images/items/icons/${ITEM_ID}.png`
    )
    expect(countCalls(calls, /\/locales\/zh\/item\.json/)).toBe(1)

    // 冷却期内：换一个 ID 也不重试 name map
    const m2 = await lookupClothData([ITEM_ID_2])
    expect(m2.get(ITEM_ID_2)?.name).toBeUndefined()
    expect(countCalls(calls, /\/locales\/zh\/item\.json/)).toBe(1)

    // 冷却结束后：重新尝试加载 name map
    await vi.advanceTimersByTimeAsync(60_001)
    await lookupClothData([ITEM_ID_3])
    expect(countCalls(calls, /\/locales\/zh\/item\.json/)).toBe(2)
  })

  it('name map 恢复后，已缓存的同名 ID 也会补上名称（不重查 data API）', async () => {
    installTestConfig({ nameMapRetryCooldownMs: 1000 })
    vi.useFakeTimers()
    let nameMapOk = false
    const calls = installFetch((url) => {
      if (url.includes('/locales/zh/item.json')) {
        return nameMapOk
          ? jsonRes({ item: { [String(ITEM_ID)]: { name: '时光讯号' } } })
          : jsonRes({}, 500)
      }
      if (url.endsWith(`/items/${ITEM_ID}`)) return jsonRes(DATA_API_ITEM)
      throw new Error(`unexpected url: ${url}`)
    })

    const m1 = await lookupClothData([ITEM_ID])
    expect(m1.get(ITEM_ID)?.name).toBeUndefined()
    expect(countCalls(calls, /\/items\//)).toBe(1)

    // 冷却结束后 name map 恢复：命中缓存的同名 ID 必须补名，且不重查 data API
    nameMapOk = true
    await vi.advanceTimersByTimeAsync(1001)
    const m2 = await lookupClothData([ITEM_ID])
    expect(m2.get(ITEM_ID)?.name).toBe('时光讯号')
    expect(countCalls(calls, /\/items\//)).toBe(1)
    expect(countCalls(calls, /\/locales\/zh\/item\.json/)).toBe(2)
  })
})
