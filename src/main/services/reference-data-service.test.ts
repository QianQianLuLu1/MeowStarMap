import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * @layer L2
 * @module src/main/services/reference-data-service
 * @coverage 参考数据管道：manifest 校验 / 版本判定（标记文件）/ sha256 校验与重下 /
 *           aes-gcm-filebox 解密 / protobuf 索引 / 查询面 / 缓存损坏自愈 / SSRF / 冷却 / 并发串行
 * @dependencies logger（mock）；fetch 与 userDataDir 经 setter 注入，零真实网络、仅临时目录落盘
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
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createCipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import {
  checkForUpdate,
  getStatus,
  getWorldMapTiles,
  getNetworkImageTemplates,
  setReferenceDataDeps,
  setReferenceDataConfig,
  disposeReferenceDataService
} from './reference-data-service'
import { getNuan5ConfigType } from './reference-data/nuan5-config-proto'

// ============================================================
// Fixtures
// ============================================================

const MANIFEST_PATH_URL = 'https://nikki.ranaxro.com/app_api/hot_update.json'
const DB_URL = 'https://file-nikki.ranaxro.com/hot_update/nuan5_database/v1.db'
const BIN_URL = 'https://file-nikki.ranaxro.com/hot_update/infinity_nikki/zh-CN.bin'

const DB_VERSION_V1 = '5db41b98-8a05-4ff8-a6fd-bed301c2a2d1'
const DB_VERSION_V2 = '11111111-2222-4333-8444-555555555555'
const BIN_VERSION = '20831175-11d7-4c1a-8e81-b11391317cbc'

const TILE_V1 = 'https://tiles.example.test/v1/{z}/{x}/{y}.png'
const TILE_V2 = 'https://tiles.example.test/v2/{z}/{x}/{y}.png'
const CLOTH_URL = 'https://cdn.example.test/img/{id}.png'

/** 上游 nuan5_database.rs 逐字常量（独立实现加密侧，golden 差分判据） */
const UPSTREAM_IKM = Buffer.from('9C46C6BF431F5AFFF97A2002AEDFA8B7', 'utf8')

function encryptFileboxForTest(plaintext: Buffer): Buffer {
  const salt = randomBytes(16)
  const nonce = randomBytes(12)
  const key = Buffer.from(
    hkdfSync('sha256', UPSTREAM_IKM, salt, Buffer.from('aes-gcm-filebox', 'utf8'), 32)
  )
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([salt, nonce, ct, cipher.getAuthTag()])
}

/** 构造一份最小 Nuan5Config 明文（经测试专用加密侧得到合法 v1.db 密文） */
function buildDbBytes(opts?: { tileUrl?: string }): Buffer {
  const obj = {
    world: {
      '1': {
        mapTileInfo: {
          urlTemplate: opts?.tileUrl ?? TILE_V1,
          maxZoom: 5,
          minZoom: 2,
          mapWidthOfMaxZoom: 4096,
          mapHeightOfMaxZoom: 4096,
          originalPointX: 1024.5,
          originalPointY: 512.25,
          pxPreUnit: 3.5
        }
      }
    },
    networkImage: { cloth: { baseUrl: CLOTH_URL, replace: '{id}' } }
  }
  const type = getNuan5ConfigType()
  return Buffer.from(type.encode(type.fromObject(obj)).finish())
}

interface FixturePackage {
  id: string
  versionId: string
  files: Array<{ path: string; downloadLink: string; sha256?: string }>
}

function manifestBody(packages: FixturePackage[]): Buffer {
  return Buffer.from(JSON.stringify(packages), 'utf-8')
}

function defaultManifest(
  dbBytes: Buffer,
  opts?: { dbSha256?: string; dbVersionId?: string }
): FixturePackage[] {
  return [
    {
      id: 'infinity_nikki',
      versionId: BIN_VERSION,
      files: [{ path: 'zh-CN.bin', downloadLink: BIN_URL }]
    },
    {
      id: 'nuan5_database',
      versionId: opts?.dbVersionId ?? DB_VERSION_V1,
      files: [
        {
          path: 'v1.db',
          downloadLink: DB_URL,
          ...(opts?.dbSha256 ? { sha256: opts.dbSha256 } : {})
        }
      ]
    }
  ]
}

// ============================================================
// Helpers
// ============================================================

interface RecordedCall {
  url: string
  init?: RequestInit
}

let root = ''
let nowMs = 1_000_000_000_000
let calls: RecordedCall[] = []

/** 注入 mock fetch（userDataDir 指向当前测试的临时根目录）；同一测试内可重复注入（模拟重启） */
function installDeps(responder: (url: string) => Response | Promise<Response>): RecordedCall[] {
  calls = []
  const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return Promise.resolve(responder(String(url)))
  })
  setReferenceDataDeps({
    fetcher: fetchMock as unknown as typeof fetch,
    getUserDataDir: () => root,
    getAppVersion: () => '2.5.7-test',
    now: () => nowMs
  })
  return calls
}

function jsonResponse(body: Buffer | string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

function callCount(url: string): number {
  return calls.filter((c) => c.url === url).length
}

/** packages 目录下的残留 staging/backup 目录（提交失败必须清理干净） */
function leftoverScratchDirs(): string[] {
  const dir = path.join(root, 'reference-data', 'packages')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(
    (name) => name.startsWith('.staging-') || name.startsWith('.backup-')
  )
}

beforeEach(() => {
  nowMs = 1_000_000_000_000
  root = mkdtempSync(path.join(tmpdir(), 'refdata-'))
  setReferenceDataConfig({ retryBackoffMs: 0 })
})

afterEach(() => {
  disposeReferenceDataService()
  setReferenceDataConfig(null)
  if (root) {
    rmSync(root, { recursive: true, force: true })
    root = ''
  }
})

// ============================================================
// 正常场景
// ============================================================

describe('reference-data-service 正常场景', () => {
  it('全新安装：两包下载落盘 + 索引建立 + 查询面与 fixture 一致 + UA 携带版本', async () => {
    const dbBytes = encryptFileboxForTest(buildDbBytes())
    installDeps((url) => {
      if (url === MANIFEST_PATH_URL) return jsonResponse(manifestBody(defaultManifest(dbBytes)))
      if (url === DB_URL) return jsonResponse(dbBytes)
      if (url === BIN_URL) return jsonResponse(Buffer.from('fake-msgpack-bin'))
      throw new Error(`unexpected url: ${url}`)
    })

    const status = await checkForUpdate()

    expect(status.available).toBe(true)
    expect(status.updating).toBe(false)
    expect(status.lastError).toBeNull()
    expect(status.packages).toEqual(
      expect.arrayContaining([
        { id: 'nuan5_database', versionId: DB_VERSION_V1 },
        { id: 'infinity_nikki', versionId: BIN_VERSION }
      ])
    )

    const pkgDir = path.join(root, 'reference-data', 'packages')
    expect(existsSync(path.join(pkgDir, 'nuan5_database', 'v1.db'))).toBe(true)
    expect(existsSync(path.join(pkgDir, 'nuan5_database', DB_VERSION_V1))).toBe(true)
    expect(existsSync(path.join(pkgDir, 'infinity_nikki', 'zh-CN.bin'))).toBe(true)
    expect(existsSync(path.join(pkgDir, 'infinity_nikki', BIN_VERSION))).toBe(true)
    expect(existsSync(path.join(root, 'reference-data', 'meta.json'))).toBe(true)

    expect(getWorldMapTiles()).toEqual([
      {
        worldId: 1,
        urlTemplate: TILE_V1,
        minZoom: 2,
        maxZoom: 5,
        mapWidthOfMaxZoom: 4096,
        mapHeightOfMaxZoom: 4096,
        originalPointX: 1024.5,
        originalPointY: 512.25,
        pxPreUnit: 3.5
      }
    ])
    expect(getNetworkImageTemplates()).toEqual([
      { kind: 'cloth', baseUrl: CLOTH_URL, replace: '{id}' }
    ])

    // #20 条款 2：请求头携带 MeowStarMap/<版本>
    expect(calls[0].init?.headers).toMatchObject({ 'User-Agent': 'MeowStarMap/2.5.7-test' })
  })

  it('版本未变 → 仅请求 manifest，零文件下载（命中缓存）', async () => {
    const dbBytes = encryptFileboxForTest(buildDbBytes())
    installDeps((url) => {
      if (url === MANIFEST_PATH_URL) return jsonResponse(manifestBody(defaultManifest(dbBytes)))
      if (url === DB_URL) return jsonResponse(dbBytes)
      if (url === BIN_URL) return jsonResponse(Buffer.from('bin'))
      throw new Error(`unexpected url: ${url}`)
    })
    await checkForUpdate()
    expect(calls.length).toBe(3)

    await checkForUpdate()
    expect(callCount(MANIFEST_PATH_URL)).toBe(2)
    expect(callCount(DB_URL)).toBe(1)
    expect(callCount(BIN_URL)).toBe(1)
  })

  it('manifest 带合法 sha256 → 校验通过落盘', async () => {
    const dbBytes = encryptFileboxForTest(buildDbBytes())
    const sha256 = createHash('sha256').update(dbBytes).digest('hex')
    installDeps((url) => {
      if (url === MANIFEST_PATH_URL) {
        return jsonResponse(manifestBody(defaultManifest(dbBytes, { dbSha256: sha256 })))
      }
      if (url === DB_URL) return jsonResponse(dbBytes)
      if (url === BIN_URL) return jsonResponse(Buffer.from('bin'))
      throw new Error(`unexpected url: ${url}`)
    })

    const status = await checkForUpdate()
    expect(status.available).toBe(true)
    expect(status.lastError).toBeNull()
  })

  it('versionId 变化 → 重新下载并重建索引为新内容（旧标记被替换）', async () => {
    let dbBytes = encryptFileboxForTest(buildDbBytes({ tileUrl: TILE_V1 }))
    let manifestVersionId = DB_VERSION_V1
    installDeps((url) => {
      if (url === MANIFEST_PATH_URL) {
        return jsonResponse(
          manifestBody(defaultManifest(dbBytes, { dbVersionId: manifestVersionId }))
        )
      }
      if (url === DB_URL) return jsonResponse(dbBytes)
      if (url === BIN_URL) return jsonResponse(Buffer.from('bin'))
      throw new Error(`unexpected url: ${url}`)
    })
    await checkForUpdate()
    expect(getWorldMapTiles()[0]?.urlTemplate).toBe(TILE_V1)

    // 上游发布新版本
    dbBytes = encryptFileboxForTest(buildDbBytes({ tileUrl: TILE_V2 }))
    manifestVersionId = DB_VERSION_V2
    calls = []
    const status = await checkForUpdate()
    expect(status.available).toBe(true)
    expect(callCount(DB_URL)).toBe(1)
    expect(getWorldMapTiles()[0]?.urlTemplate).toBe(TILE_V2)
    expect(
      existsSync(path.join(root, 'reference-data', 'packages', 'nuan5_database', DB_VERSION_V2))
    ).toBe(true)
    expect(
      existsSync(path.join(root, 'reference-data', 'packages', 'nuan5_database', DB_VERSION_V1))
    ).toBe(false)
  })
})

// ============================================================
// 异常场景
// ============================================================

describe('reference-data-service 异常场景', () => {
  it('manifest 404 / 网络失败 → 降级旧缓存，lastError 含阶段与原因', async () => {
    const dbBytes = encryptFileboxForTest(buildDbBytes())
    let manifestStatus = 200
    installDeps((url) => {
      if (url === MANIFEST_PATH_URL)
        return jsonResponse(manifestBody(defaultManifest(dbBytes)), manifestStatus)
      if (url === DB_URL) return jsonResponse(dbBytes)
      if (url === BIN_URL) return jsonResponse(Buffer.from('bin'))
      throw new Error(`unexpected url: ${url}`)
    })
    await checkForUpdate()
    expect(getWorldMapTiles()).toHaveLength(1)

    manifestStatus = 404
    const status = await checkForUpdate()
    expect(status.lastError).toContain('manifest')
    expect(status.lastError).toContain('404')
    expect(status.available).toBe(true)
    expect(getWorldMapTiles()).toHaveLength(1)
  })

  it('manifest 结构非法（非数组）→ 明确错误，零文件下载', async () => {
    installDeps((url) => {
      if (url === MANIFEST_PATH_URL) return jsonResponse(Buffer.from('{}'))
      throw new Error(`unexpected url: ${url}`)
    })
    const status = await checkForUpdate()
    expect(status.lastError).toContain('manifest 顶层不是数组')
    expect(callCount(DB_URL)).toBe(0)
    expect(status.available).toBe(false)
  })

  it('SSRF：manifest 指向环回地址 → 请求前拒绝（零网络调用）', async () => {
    installDeps(() => {
      throw new Error('SSRF 守卫不应放行该请求')
    })
    const status = await checkForUpdate({ manifestBaseUrl: 'http://127.0.0.1:9' })
    expect(status.lastError).toContain('127.0.0.1')
    expect(calls.length).toBe(0)
  })

  it('SSRF：manifest 内 downloadLink 指向 localhost → manifest 可取，文件请求为零', async () => {
    const evilManifest: FixturePackage[] = [
      {
        id: 'nuan5_database',
        versionId: DB_VERSION_V1,
        files: [{ path: 'v1.db', downloadLink: 'http://localhost/evil/v1.db' }]
      }
    ]
    installDeps((url) => {
      if (url === MANIFEST_PATH_URL) return jsonResponse(manifestBody(evilManifest))
      throw new Error('SSRF 守卫不应放行文件下载')
    })
    const status = await checkForUpdate()
    expect(callCount(MANIFEST_PATH_URL)).toBe(1)
    expect(calls.some((c) => c.url.includes('localhost'))).toBe(false)
    expect(status.lastError).toContain('localhost')
    expect(status.available).toBe(false)
  })

  it('sha256 不符 → 恰好重下一次，仍败则整包失败且零残留', async () => {
    const dbBytes = encryptFileboxForTest(buildDbBytes())
    installDeps((url) => {
      if (url === MANIFEST_PATH_URL) {
        return jsonResponse(manifestBody(defaultManifest(dbBytes, { dbSha256: 'f'.repeat(64) })))
      }
      if (url === DB_URL) return jsonResponse(dbBytes)
      if (url === BIN_URL) return jsonResponse(Buffer.from('bin'))
      throw new Error(`unexpected url: ${url}`)
    })

    const status = await checkForUpdate()
    expect(callCount(DB_URL)).toBe(2) // 校验不符恰好重下一次
    expect(status.lastError).toContain('sha256')
    expect(status.available).toBe(false)
    expect(existsSync(path.join(root, 'reference-data', 'packages', 'nuan5_database'))).toBe(false)
    expect(leftoverScratchDirs()).toEqual([])
  })

  it('下载的密文被篡改（无 sha256 可验）→ 解密失败删包自愈', async () => {
    const dbBytes = encryptFileboxForTest(buildDbBytes())
    dbBytes[dbBytes.length - 20] ^= 0xff // 篡改密文字节
    installDeps((url) => {
      if (url === MANIFEST_PATH_URL) return jsonResponse(manifestBody(defaultManifest(dbBytes)))
      if (url === DB_URL) return jsonResponse(dbBytes)
      if (url === BIN_URL) return jsonResponse(Buffer.from('bin'))
      throw new Error(`unexpected url: ${url}`)
    })

    const status = await checkForUpdate()
    expect(status.lastError).toContain('解密失败')
    expect(status.available).toBe(false)
    // 删包自愈在同步索引函数里 fire-and-forget（loadIndexFromDiskSync 的 void removeQuietly），
    // 观测点须等终态而非抢跑同步断言——并行负载下 rm 可能尚未落地（CI-Linux 装置曾偶发红）
    await vi.waitFor(() =>
      expect(existsSync(path.join(root, 'reference-data', 'packages', 'nuan5_database'))).toBe(
        false
      )
    )
  })

  it('新版本损坏但旧索引可用 → 查询面继续服务旧数据（fail-soft）', async () => {
    let dbBytes = encryptFileboxForTest(buildDbBytes({ tileUrl: TILE_V1 }))
    let manifestVersionId = DB_VERSION_V1
    let tamper = false
    installDeps((url) => {
      if (url === MANIFEST_PATH_URL) {
        return jsonResponse(
          manifestBody(defaultManifest(dbBytes, { dbVersionId: manifestVersionId }))
        )
      }
      if (url === DB_URL) {
        if (!tamper) return jsonResponse(dbBytes)
        const b = Buffer.from(dbBytes)
        b[b.length - 20] ^= 0xff
        return jsonResponse(b)
      }
      if (url === BIN_URL) return jsonResponse(Buffer.from('bin'))
      throw new Error(`unexpected url: ${url}`)
    })
    await checkForUpdate()
    expect(getWorldMapTiles()[0]?.urlTemplate).toBe(TILE_V1)

    // 上游发布新版本，但下载内容被篡改（无 sha256，落盘后才在解密侧暴露）
    dbBytes = encryptFileboxForTest(buildDbBytes({ tileUrl: TILE_V2 }))
    manifestVersionId = DB_VERSION_V2
    tamper = true
    calls = []
    const status = await checkForUpdate()
    expect(status.lastError).toContain('解密失败')
    expect(status.available).toBe(true) // 旧索引保留
    expect(getWorldMapTiles()[0]?.urlTemplate).toBe(TILE_V1)
    expect(status.packages.find((p) => p.id === 'nuan5_database')?.versionId).toBeNull()
  })

  it('v1.db 文件过短（<44B）→ 解密失败删包', async () => {
    installDeps((url) => {
      if (url === MANIFEST_PATH_URL)
        return jsonResponse(manifestBody(defaultManifest(Buffer.alloc(0))))
      if (url === DB_URL) return jsonResponse(Buffer.alloc(10))
      if (url === BIN_URL) return jsonResponse(Buffer.from('bin'))
      throw new Error(`unexpected url: ${url}`)
    })
    const status = await checkForUpdate()
    expect(status.lastError).toContain('解密失败')
    expect(status.available).toBe(false)
    // 删包自愈在同步索引函数里 fire-and-forget（loadIndexFromDiskSync 的 void removeQuietly），
    // 观测点须等终态而非抢跑同步断言——并行负载下 rm 可能尚未落地（CI-Linux 装置曾偶发红）
    await vi.waitFor(() =>
      expect(existsSync(path.join(root, 'reference-data', 'packages', 'nuan5_database'))).toBe(
        false
      )
    )
  })

  it('manifest path 逃逸包目录 → 结构校验拒绝，零文件下载', async () => {
    installDeps((url) => {
      if (url === MANIFEST_PATH_URL) {
        return jsonResponse(
          manifestBody([
            {
              id: 'nuan5_database',
              versionId: DB_VERSION_V1,
              files: [{ path: '../evil.db', downloadLink: DB_URL }]
            }
          ])
        )
      }
      throw new Error('path 逃逸不应触发任何下载')
    })
    const status = await checkForUpdate()
    expect(status.lastError).toContain('逃逸')
    expect(callCount(DB_URL)).toBe(0)
  })

  it('响应体超大小上限 → 协议错误', async () => {
    setReferenceDataConfig({ manifestMaxBytes: 10 })
    installDeps((url) => {
      if (url === MANIFEST_PATH_URL)
        return jsonResponse(manifestBody(defaultManifest(Buffer.alloc(0))))
      throw new Error(`unexpected url: ${url}`)
    })
    const status = await checkForUpdate()
    expect(status.lastError).toContain('大小上限')
  })
})

// ============================================================
// 边界场景
// ============================================================

describe('reference-data-service 边界场景', () => {
  it('manifest 不含 nuan5_database → .bin 照常落盘，查询面空态且无错误', async () => {
    installDeps((url) => {
      if (url === MANIFEST_PATH_URL) {
        return jsonResponse(
          manifestBody([
            {
              id: 'infinity_nikki',
              versionId: BIN_VERSION,
              files: [{ path: 'zh-CN.bin', downloadLink: BIN_URL }]
            }
          ])
        )
      }
      if (url === BIN_URL) return jsonResponse(Buffer.from('bin'))
      throw new Error(`unexpected url: ${url}`)
    })
    const status = await checkForUpdate()
    expect(status.available).toBe(false)
    expect(status.lastError).toBeNull()
    expect(getWorldMapTiles()).toEqual([])
    expect(getNetworkImageTemplates()).toEqual([])
    expect(
      existsSync(path.join(root, 'reference-data', 'packages', 'infinity_nikki', 'zh-CN.bin'))
    ).toBe(true)
  })

  it('meta.json 损坏 → 重建，不影响版本判定与查询', async () => {
    const dbBytes = encryptFileboxForTest(buildDbBytes())
    const responder = (url: string): Response => {
      if (url === MANIFEST_PATH_URL) return jsonResponse(manifestBody(defaultManifest(dbBytes)))
      if (url === DB_URL) return jsonResponse(dbBytes)
      if (url === BIN_URL) return jsonResponse(Buffer.from('bin'))
      throw new Error(`unexpected url: ${url}`)
    }
    installDeps(responder)
    await checkForUpdate()

    const { writeFileSync } = await import('node:fs')
    writeFileSync(path.join(root, 'reference-data', 'meta.json'), '{broken json!', 'utf-8')

    // 模拟重启（dispose 重置内存态与注入，需重新注入同一临时目录）
    disposeReferenceDataService()
    installDeps(responder)
    expect(getStatus().available).toBe(true)
    expect(getWorldMapTiles()).toHaveLength(1)

    await checkForUpdate()
    expect(existsSync(path.join(root, 'reference-data', 'meta.json'))).toBe(true)
  })

  it('缓存完好时重启（dispose 后重查）→ 命中缓存，不重新下载', async () => {
    const dbBytes = encryptFileboxForTest(buildDbBytes())
    const responder = (url: string): Response => {
      if (url === MANIFEST_PATH_URL) return jsonResponse(manifestBody(defaultManifest(dbBytes)))
      if (url === DB_URL) return jsonResponse(dbBytes)
      if (url === BIN_URL) return jsonResponse(Buffer.from('bin'))
      throw new Error(`unexpected url: ${url}`)
    }
    installDeps(responder)
    await checkForUpdate()
    expect(getWorldMapTiles()).toHaveLength(1)

    // 模拟重启：清空内存态（缓存文件保留），重新注入同一目录
    disposeReferenceDataService()
    installDeps(responder)
    expect(getWorldMapTiles()).toHaveLength(1) // 懒加载从磁盘重建索引
    expect(callCount(DB_URL)).toBe(0)

    await checkForUpdate()
    expect(callCount(DB_URL)).toBe(0) // 版本未变，零下载
    expect(callCount(MANIFEST_PATH_URL)).toBe(1)
  })

  it('并发 checkForUpdate 串行执行（下载不并发写同一包目录）', async () => {
    const dbBytes = encryptFileboxForTest(buildDbBytes())
    let inFlight = 0
    let maxInFlight = 0
    installDeps(async (url) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 15))
      inFlight--
      if (url === MANIFEST_PATH_URL) return jsonResponse(manifestBody(defaultManifest(dbBytes)))
      if (url === DB_URL) return jsonResponse(dbBytes)
      if (url === BIN_URL) return jsonResponse(Buffer.from('bin'))
      throw new Error(`unexpected url: ${url}`)
    })

    await Promise.all([checkForUpdate(), checkForUpdate()])
    expect(maxInFlight).toBe(1)
    expect(callCount(DB_URL)).toBe(1)
  })

  it('失败冷却：冷却期内零请求；force 绕过；冷却过后恢复', async () => {
    const manifestStatus = 404
    installDeps((url) => {
      if (url === MANIFEST_PATH_URL) return jsonResponse('not json', manifestStatus)
      throw new Error(`unexpected url: ${url}`)
    })
    setReferenceDataConfig({ retryCooldownMs: 5000 })

    await checkForUpdate()
    expect(callCount(MANIFEST_PATH_URL)).toBe(1)

    // 冷却期内：跳过
    nowMs += 1000
    await checkForUpdate()
    expect(callCount(MANIFEST_PATH_URL)).toBe(1)

    // force 绕过冷却
    await checkForUpdate({ force: true })
    expect(callCount(MANIFEST_PATH_URL)).toBe(2)

    // 冷却过后：恢复请求
    nowMs += 6000
    await checkForUpdate()
    expect(callCount(MANIFEST_PATH_URL)).toBe(3)
    void manifestStatus
  })

  it('staging 中断（文件下载失败）→ 包目录保持旧版本不变，恢复后重装成功', async () => {
    const dbBytes = encryptFileboxForTest(buildDbBytes())
    let binFails = false
    let binVersionId = BIN_VERSION
    installDeps((url) => {
      if (url === MANIFEST_PATH_URL) {
        return jsonResponse(
          manifestBody([
            {
              id: 'infinity_nikki',
              versionId: binVersionId,
              files: [{ path: 'zh-CN.bin', downloadLink: BIN_URL }]
            },
            {
              id: 'nuan5_database',
              versionId: DB_VERSION_V1,
              files: [{ path: 'v1.db', downloadLink: DB_URL }]
            }
          ])
        )
      }
      if (url === DB_URL) return jsonResponse(dbBytes)
      if (url === BIN_URL) {
        if (binFails) throw new Error('network down')
        return jsonResponse(Buffer.from('bin'))
      }
      throw new Error(`unexpected url: ${url}`)
    })
    await checkForUpdate()
    expect(getWorldMapTiles()).toHaveLength(1)

    // infinity_nikki 发布新版本，但下载失败 → 整包提交回滚，旧版本完好
    binVersionId = '33333333-4444-4555-8666-777777777777'
    binFails = true
    calls = []
    const status = await checkForUpdate({ force: true })
    expect(status.lastError).toContain('network down')
    expect(
      existsSync(path.join(root, 'reference-data', 'packages', 'infinity_nikki', BIN_VERSION))
    ).toBe(true)
    expect(status.packages.find((p) => p.id === 'infinity_nikki')?.versionId).toBe(BIN_VERSION)
    expect(leftoverScratchDirs()).toEqual([])

    // 网络恢复后重装成功（manifest 已指向新版本）
    binFails = false
    calls = []
    await checkForUpdate({ force: true })
    expect(callCount(BIN_URL)).toBe(1)
    expect(
      existsSync(path.join(root, 'reference-data', 'packages', 'infinity_nikki', binVersionId))
    ).toBe(true)
    expect(leftoverScratchDirs()).toEqual([])
  })

  it('userData 目录不可得（空串）→ 拒绝写出相对路径，检查失败记入 lastError', async () => {
    const dbBytes = encryptFileboxForTest(buildDbBytes())
    installDeps((url) => {
      if (url === MANIFEST_PATH_URL) return jsonResponse(manifestBody(defaultManifest(dbBytes)))
      if (url === DB_URL) return jsonResponse(dbBytes)
      if (url === BIN_URL) return jsonResponse(Buffer.from('bin'))
      throw new Error(`unexpected url: ${url}`)
    })
    setReferenceDataDeps({ getUserDataDir: () => '' })

    const status = await checkForUpdate()
    expect(status.lastError).toContain('userData 目录不可用')
    expect(status.available).toBe(false)
    // 查询面空态、不抛错
    expect(getWorldMapTiles()).toEqual([])
    // 进程 CWD 未被写出缓存目录
    expect(existsSync('reference-data')).toBe(false)
  })
})
