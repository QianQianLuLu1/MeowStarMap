import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * @layer L2
 * @module src/main/services/reference-image-service
 * @coverage 参考数据 CDN 图片的应用层缓存（命中/过期/损坏自愈）、按主机区分的请求标识、
 *           404 负缓存与失败冷却退避、并发去重、SSRF 镜像拒绝、fail-soft 语义
 * @dependencies logger（mock）；fetch / userDataDir / appVersion / now / templates 经 setter 注入，
 *               零真实网络，仅临时目录落盘
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
import { mkdtempSync, rmSync, readFileSync, writeFileSync, utimesSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  resolveReferenceImage,
  getReferenceImageCacheDir,
  setReferenceImageDeps,
  setReferenceImageConfig,
  disposeReferenceImageService
} from './reference-image-service'
import type { NetworkImageTemplateInfo } from '../../shared/types/electron-api'

// ============================================================
// Fixtures
// ============================================================

const NIKKI_BASE = 'https://cdn.nikkialbums.com/assets/{id}.webp'
const GONGEO_BASE = 'https://cdn.gongeo.us/nikki/cloth/{id}.png'
const APP_VERSION = '2.5.7-beta'

function sha256Of(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

const TEMPLATES: NetworkImageTemplateInfo[] = [
  { kind: 'light', baseUrl: NIKKI_BASE, replace: '{id}' },
  { kind: 'filter', baseUrl: NIKKI_BASE, replace: '{id}' },
  { kind: 'momoPose', baseUrl: NIKKI_BASE, replace: '{id}' },
  { kind: 'nikkiPose', baseUrl: NIKKI_BASE, replace: '{id}' },
  { kind: 'cloth', baseUrl: GONGEO_BASE, replace: '{id}' }
]

/** 最小合法 WEBP 字节（RIFF....WEBPVP8 ）——魔数校验判据 */
const WEBP_BYTES = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'ascii'),
  Buffer.from('VP8 ', 'ascii'),
  Buffer.from([0x0d, 0x00, 0x00, 0x00]),
  Buffer.alloc(13, 0x42)
])

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(24, 0x00)
])

/** HTML 错误页伪装成图片（CDN 403/门户拦截的典型形态）——必须被魔数校验拒收 */
const HTML_BYTES = Buffer.from('<html><body>403 Forbidden</body></html>', 'utf-8')

let root = ''
let nowMs = 0
let fetchMock: ReturnType<typeof vi.fn>

function jsonResponse(status: number, body: Buffer, contentType = 'image/webp'): Response {
  return new Response(new Uint8Array(body), {
    status,
    headers: { 'content-type': contentType, 'content-length': String(body.length) }
  })
}

/**
 * 装配注入依赖（单一入口）。
 * `setReferenceImageDeps` 是「与默认值合并」语义，分两次调用会让后一次把前一次注入的
 * fetcher/templates 冲回默认值，故 impl 与 templates 必须同批装配。
 */
function install(opts?: {
  impl?: (url: string, init?: RequestInit) => Response | Promise<Response>
  templates?: NetworkImageTemplateInfo[]
  fetcher?: typeof fetch
}): void {
  fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (opts?.impl) return opts.impl(url, init)
    return jsonResponse(200, WEBP_BYTES)
  })
  setReferenceImageDeps({
    fetcher: (opts?.fetcher ?? fetchMock) as unknown as typeof fetch,
    getUserDataDir: () => root,
    getAppVersion: () => APP_VERSION,
    now: () => nowMs,
    getTemplates: () => opts?.templates ?? TEMPLATES
  })
}

/** 取最近一次 fetch 的指定请求头 */
function lastHeader(name: string): string | null {
  const call = fetchMock.mock.calls.at(-1)
  if (!call) return null
  const init = call[1] as RequestInit | undefined
  const headers = init?.headers as Record<string, string> | undefined
  if (!headers) return null
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase())
  return key ? (headers[key] ?? null) : null
}

function cacheFilePath(cacheKey: string, ext = '.webp'): string {
  return path.join(getReferenceImageCacheDir() ?? '', `${cacheKey}${ext}`)
}

/** 把缓存文件的 mtime 回拨 days 天（模拟时间流逝，不依赖真实时钟） */
function ageCacheFile(file: string, days: number): void {
  const past = new Date(nowMs - days * 24 * 60 * 60 * 1000)
  utimesSync(file, past, past)
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'refimg-'))
  nowMs = Date.now()
  install()
})

afterEach(() => {
  disposeReferenceImageService()
  setReferenceImageConfig(null)
  if (root) {
    rmSync(root, { recursive: true, force: true })
    root = ''
  }
})

// ============================================================
// 正常路径
// ============================================================

describe('resolveReferenceImage — 正常', () => {
  it('首次请求：取图落盘并返回缓存路径', async () => {
    const result = await resolveReferenceImage('light', 100)
    expect(result.status).toBe('fetched')
    expect(result.path).not.toBeNull()
    expect(result.path).toBe(cacheFilePath(sha256Of('light:100')))
    expect(readFileSync(result.path!)).toEqual(WEBP_BYTES)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![0]).toBe('https://cdn.nikkialbums.com/assets/100.webp')
  })

  it('重复展示命中缓存：零网络（#20 条款 3 禁高频请求）', async () => {
    const first = await resolveReferenceImage('light', 100)
    const second = await resolveReferenceImage('light', 100)
    const third = await resolveReferenceImage('light', 100)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(second.status).toBe('cached')
    expect(third.status).toBe('cached')
    expect(second.path).toBe(first.path)
    expect(third.path).toBe(first.path)
  })

  it('请求标识为「应用名/版本」，版本取自应用真实版本（#20 条款 2）', async () => {
    await resolveReferenceImage('light', 1)
    expect(lastHeader('User-Agent')).toBe(`MeowStarMap/${APP_VERSION}`)
  })

  it('不同 kind / 不同 id 各自独立缓存', async () => {
    const a = await resolveReferenceImage('light', 1)
    const b = await resolveReferenceImage('filter', 1)
    const c = await resolveReferenceImage('light', 2)
    expect(new Set([a.path, b.path, c.path]).size).toBe(3)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('并发同 key 只发一次请求（in-flight 去重，防重复展示触发并发拉取）', async () => {
    const results = await Promise.all([
      resolveReferenceImage('light', 7),
      resolveReferenceImage('light', 7),
      resolveReferenceImage('light', 7)
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(results.every((r) => r.path === results[0]!.path)).toBe(true)
  })

  it('镜像入口生效：请求走镜像地址，缓存键与路径不变', async () => {
    const plain = await resolveReferenceImage('light', 5)
    expect(plain.status).toBe('fetched')
    // 清掉刚落盘的缓存，逼第二次真的走网络（否则命中缓存零请求，测不到镜像地址）
    rmSync(plain.path!, { force: true })
    disposeReferenceImageService()
    install()
    const mirrored = await resolveReferenceImage('light', 5, {
      mirrorBaseUrl: 'https://mirror.example.org'
    })
    expect(fetchMock.mock.calls[0]![0]).toBe('https://mirror.example.org/assets/5.webp')
    expect(mirrored.path).toBe(plain.path)
    expect(lastHeader('User-Agent')).toBe(`MeowStarMap/${APP_VERSION}`)
  })

  it('PNG 资源按 URL 扩展名落盘（media:// 据扩展名定 MIME）', async () => {
    install({
      impl: () => jsonResponse(200, PNG_BYTES, 'image/png'),
      templates: [
        ...TEMPLATES,
        {
          kind: 'diyPattern',
          baseUrl: 'https://cdn.nikkialbums.com/pat/{id}.png',
          replace: '{id}'
        }
      ]
    })
    const result = await resolveReferenceImage('diyPattern', 3)
    expect(result.path).toBe(cacheFilePath(sha256Of('diyPattern:3'), '.png'))
    expect(readFileSync(result.path!)).toEqual(PNG_BYTES)
  })
})

// ============================================================
// 过期与损坏恢复
// ============================================================

describe('resolveReferenceImage — 缓存过期与损坏恢复', () => {
  it('超过 7 天过期后重新取图并覆盖', async () => {
    const first = await resolveReferenceImage('light', 100)
    ageCacheFile(first.path!, 8)
    const second = await resolveReferenceImage('light', 100)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(second.status).toBe('fetched')
    expect(second.path).toBe(first.path)
  })

  it('边界：恰好 7 天内仍命中缓存（TTL 闭区间内不重取）', async () => {
    const first = await resolveReferenceImage('light', 100)
    ageCacheFile(first.path!, 6.9)
    const second = await resolveReferenceImage('light', 100)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(second.status).toBe('cached')
  })

  it('损坏（0 字节）→ 删除并重取一次', async () => {
    const first = await resolveReferenceImage('light', 100)
    writeFileSync(first.path!, Buffer.alloc(0))
    const second = await resolveReferenceImage('light', 100)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(second.status).toBe('fetched')
    expect(readFileSync(second.path!)).toEqual(WEBP_BYTES)
  })

  it('损坏（内容非图片魔数，如被写入 HTML）→ 删除并重取一次', async () => {
    const first = await resolveReferenceImage('light', 100)
    writeFileSync(first.path!, HTML_BYTES)
    const second = await resolveReferenceImage('light', 100)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(second.status).toBe('fetched')
    expect(readFileSync(second.path!)).toEqual(WEBP_BYTES)
  })

  it('损坏恢复只重取一次：重取仍失败时不进入无限重试', async () => {
    const first = await resolveReferenceImage('light', 100)
    writeFileSync(first.path!, HTML_BYTES)
    install({ impl: () => jsonResponse(500, Buffer.alloc(0)) })
    const second = await resolveReferenceImage('light', 100)
    expect(second.path).toBeNull()
    expect(second.status).toBe('error')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // 冷却期内的后续调用零网络
    const third = await resolveReferenceImage('light', 100)
    expect(third.status).toBe('cooldown')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

// ============================================================
// 授权边界
// ============================================================

describe('resolveReferenceImage — 授权核实', () => {
  it('未授权主机（gongeo 类别）零网络、返回 unauthorized', async () => {
    const result = await resolveReferenceImage('cloth', 9001)
    expect(result).toEqual({ path: null, status: 'unauthorized' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('模板缺失（索引未就绪）零网络、返回 unauthorized', async () => {
    setReferenceImageDeps({
      fetcher: fetchMock as unknown as typeof fetch,
      getUserDataDir: () => root,
      getAppVersion: () => APP_VERSION,
      now: () => nowMs,
      getTemplates: () => []
    })
    const result = await resolveReferenceImage('light', 1)
    expect(result).toEqual({ path: null, status: 'unauthorized' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('非法 kind / 非法 id 零网络', async () => {
    expect((await resolveReferenceImage('nope' as never, 1)).status).toBe('unauthorized')
    expect((await resolveReferenceImage('light', 0)).status).toBe('unauthorized')
    expect((await resolveReferenceImage('light', -3)).status).toBe('unauthorized')
    expect((await resolveReferenceImage('light', 1.5)).status).toBe('unauthorized')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('镜像指向环回地址 → 拒绝且零网络（SSRF 守卫）', async () => {
    const result = await resolveReferenceImage('light', 1, {
      mirrorBaseUrl: 'https://127.0.0.1/x'
    })
    expect(result).toEqual({ path: null, status: 'unauthorized' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ============================================================
// 失败语义与退避
// ============================================================

describe('resolveReferenceImage — 失败处理与退避', () => {
  it('404 → not-found 且写入负缓存，冷却期内零网络（不重试风暴）', async () => {
    install({ impl: () => jsonResponse(404, Buffer.alloc(0)) })
    const first = await resolveReferenceImage('light', 404)
    expect(first).toEqual({ path: null, status: 'not-found' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 20; i++) {
      const again = await resolveReferenceImage('light', 404)
      expect(again.status).toBe('not-found')
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('负缓存过期后允许再探一次（资源后续上线可被发现）', async () => {
    install({ impl: () => jsonResponse(404, Buffer.alloc(0)) })
    await resolveReferenceImage('light', 404)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    nowMs += 31 * 60 * 1000 // 越过 30 分钟负缓存 TTL
    await resolveReferenceImage('light', 404)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('5xx → error 并进入冷却，冷却期内零网络', async () => {
    install({ impl: () => jsonResponse(503, Buffer.alloc(0)) })
    const first = await resolveReferenceImage('light', 500)
    expect(first).toEqual({ path: null, status: 'error' })
    for (let i = 0; i < 10; i++) {
      expect((await resolveReferenceImage('light', 500)).status).toBe('cooldown')
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('冷却期满后允许重试（退避而非永久熔断）', async () => {
    install({ impl: () => jsonResponse(503, Buffer.alloc(0)) })
    await resolveReferenceImage('light', 500)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    nowMs += 6 * 60 * 1000 // 越过 5 分钟冷却
    const retry = await resolveReferenceImage('light', 500)
    expect(retry.status).toBe('error')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('网络异常（fetch reject）→ error 且冷却，不抛给调用方（fail-soft）', async () => {
    install({
      impl: () => {
        throw new Error('ECONNRESET')
      }
    })
    const first = await resolveReferenceImage('light', 1)
    expect(first).toEqual({ path: null, status: 'error' })
    expect((await resolveReferenceImage('light', 1)).status).toBe('cooldown')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('响应体为 HTML 错误页（200 但非图片）→ 校验失败，不落盘、进入冷却', async () => {
    install({ impl: () => jsonResponse(200, HTML_BYTES, 'text/html') })
    const result = await resolveReferenceImage('light', 1)
    expect(result).toEqual({ path: null, status: 'error' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((await resolveReferenceImage('light', 1)).status).toBe('cooldown')
  })

  it('空响应体（200 + 0 字节）→ 校验失败不落盘', async () => {
    install({ impl: () => jsonResponse(200, Buffer.alloc(0)) })
    const result = await resolveReferenceImage('light', 1)
    expect(result).toEqual({ path: null, status: 'error' })
    expect(getReferenceImageCacheDir()).not.toBeNull()
  })

  it('超时 → error 且冷却（AbortController 生效，不挂死）', async () => {
    setReferenceImageConfig({ fetchTimeoutMs: 20 })
    // fetcher 需感知 signal 才会真的中断；这里用带 signal 的实现模拟真实 fetch
    install({
      fetcher: ((_url: unknown, init?: RequestInit) => {
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(jsonResponse(200, WEBP_BYTES)), 500)
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(init.signal?.reason ?? new Error('aborted'))
          })
        })
      }) as unknown as typeof fetch
    })
    const result = await resolveReferenceImage('light', 1)
    expect(result).toEqual({ path: null, status: 'error' })
    expect((await resolveReferenceImage('light', 1)).status).toBe('cooldown')
  })

  it('userData 不可用 → disabled，零网络、不抛错', async () => {
    setReferenceImageDeps({
      fetcher: fetchMock as unknown as typeof fetch,
      getUserDataDir: () => '',
      getAppVersion: () => APP_VERSION,
      now: () => nowMs,
      getTemplates: () => TEMPLATES
    })
    expect(getReferenceImageCacheDir()).toBeNull()
    const result = await resolveReferenceImage('light', 1)
    expect(result).toEqual({ path: null, status: 'disabled' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('写盘失败（缓存目录被占位为文件）→ error 且不抛给调用方', async () => {
    const dir = getReferenceImageCacheDir()!
    mkdirSync(path.dirname(dir), { recursive: true })
    writeFileSync(dir, 'not a directory')
    const result = await resolveReferenceImage('light', 1)
    expect(result.path).toBeNull()
    expect(['error', 'disabled']).toContain(result.status)
  })
})

// ============================================================
// 边界
// ============================================================

describe('resolveReferenceImage — 边界', () => {
  it('缓存目录位于 <userData>/reference-data/reference-images', () => {
    expect(getReferenceImageCacheDir()).toBe(path.join(root, 'reference-data', 'reference-images'))
  })

  it('缓存文件名 = sha256("<kind>:<id>") + URL 扩展名，无路径穿越面', async () => {
    const result = await resolveReferenceImage('light', 1)
    expect(path.basename(result.path!)).toMatch(/^[0-9a-f]{64}\.webp$/)
    expect(path.dirname(result.path!)).toBe(getReferenceImageCacheDir())
  })

  it('URL 无扩展名时按 .png 落盘（media:// 需可识别扩展名定 MIME）', async () => {
    install({
      impl: () => jsonResponse(200, PNG_BYTES, 'image/png'),
      templates: [
        { kind: 'clothTag', baseUrl: 'https://cdn.nikkialbums.com/tag/{id}', replace: '{id}' }
      ]
    })
    const result = await resolveReferenceImage('clothTag', 8)
    expect(path.basename(result.path!)).toMatch(/^[0-9a-f]{64}\.png$/)
  })

  it('id = MAX_SAFE_INTEGER 可正常取图', async () => {
    const result = await resolveReferenceImage('light', Number.MAX_SAFE_INTEGER)
    expect(result.status).toBe('fetched')
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `https://cdn.nikkialbums.com/assets/${Number.MAX_SAFE_INTEGER}.webp`
    )
  })

  it('响应体超过上限 → 拒绝落盘（防异常响应撑爆内存/磁盘）', async () => {
    setReferenceImageConfig({ maxBytes: 16 })
    const result = await resolveReferenceImage('light', 1)
    expect(result).toEqual({ path: null, status: 'error' })
  })

  it('dispose 后内存闸门清空：冷却状态不跨会话残留', async () => {
    install({ impl: () => jsonResponse(503, Buffer.alloc(0)) })
    await resolveReferenceImage('light', 1)
    expect((await resolveReferenceImage('light', 1)).status).toBe('cooldown')
    disposeReferenceImageService()
    install()
    const afterDispose = await resolveReferenceImage('light', 1)
    expect(afterDispose.status).toBe('fetched')
  })

  // 打包态判据：electron-vite 把兄弟服务 bundling 进同一 chunk，dist 无兄弟文件，
  // 运行时 require('./reference-data-service') 落空 → 模板恒空 → 全 unauthorized
  // （构建版冒烟实测）。源码形态单测无法复现该失真，故以源码扫描钉住静态导入。
  it('模板默认源静态导入兄弟服务，不得用运行时 require（打包态落空回归锁）', () => {
    const src = readFileSync(new URL('./reference-image-service.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/require\(['"]\.\/reference-data-service['"]\)/)
  })
})
