import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthService } from '../auth-service'
import type { SyncLogger } from '../identity-service'
import { createApiRequestHandler } from './api-router'
import type { SyncApiServices } from './types'

/**
 * export 扩展端点路由测试（阶段 6）：mock req/res + 真实 AuthService。
 * 契约对齐上游 LocalSyncServer.exportStill 与其 local-sync-server.test.ts 断言。
 */

const NOW = 1_700_000_000_000
const DEVICE_ID = 'android_export00000000000000000'

const deviceKeys = generateKeyPairSync('ed25519')
const DEVICE_PRIVATE_PEM = deviceKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const DEVICE_PUBLIC_B64URL = deviceKeys.publicKey
  .export({ type: 'spki', format: 'der' })
  .toString('base64url')

const logger: SyncLogger = { info: vi.fn(), warn: vi.fn() }

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 最小段结构合法的 JPEG（exportJpeg 不解码像素，段结构完整即可） */
function minimalJpeg(): Buffer {
  return Buffer.from(
    'ffd8ffe000104a46494600010100000100010000' +
      'ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432' +
      'ffc0000b080001000101011100' +
      'ffc4001f0000010501010101010100000000000000000102030405060708090a0b' +
      'ffda0008010100003f00' +
      'ffd9',
    'hex'
  )
}

function signedHeaders(
  method: string,
  requestPath: string,
  body: Buffer = Buffer.alloc(0),
  extra: Record<string, string> = {}
): Record<string, string> {
  const timestamp = String(NOW)
  const nonce = randomBytes(16).toString('base64url')
  const canonical = [
    method,
    requestPath,
    timestamp,
    nonce,
    createHash('sha256').update(body).digest('hex')
  ].join('\n')
  return {
    'x-nikkisync-device-id': DEVICE_ID,
    'x-nikkisync-timestamp': timestamp,
    'x-nikkisync-nonce': nonce,
    'x-nikkisync-signature': sign(
      null,
      Buffer.from(canonical, 'utf8'),
      DEVICE_PRIVATE_PEM
    ).toString('base64url'),
    ...extra
  }
}

function mockReq(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: Buffer
): IncomingMessage {
  const chunks = body ? [body] : []
  return {
    method,
    url,
    headers,
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) yield chunk
    }
  } as unknown as IncomingMessage
}

interface RecordedResponse {
  status: number
  headers: Record<string, unknown>
  text: string
  raw: Buffer
}

function mockRes(): { res: ServerResponse; state: RecordedResponse } {
  const state: RecordedResponse = { status: 0, headers: {}, text: '', raw: Buffer.alloc(0) }
  const res = {
    headersSent: false,
    destroyed: false,
    writeHead(status: number, headers?: Record<string, unknown>) {
      state.status = status
      state.headers = headers ?? {}
      ;(res as { headersSent: boolean }).headersSent = true
    },
    end(data?: Buffer | string, onEnd?: () => void) {
      if (data) {
        // 拷贝：handler 在 finally 中 fill(0) 清零导出缓冲（对齐上游），mock 不得共享引用
        state.raw = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data)
        state.text = state.raw.toString('utf8')
      }
      onEnd?.()
    },
    once() {
      /* mock：end 回调即完成 */
    },
    destroy() {
      ;(res as { destroyed: boolean }).destroyed = true
    }
  }
  return { res: res as unknown as ServerResponse, state }
}

function createServices(
  fixturePath: string,
  fixtureBytes: Buffer,
  overrides: Partial<SyncApiServices> = {}
): SyncApiServices {
  const auth = new AuthService(
    {
      getDevice: (deviceId) =>
        deviceId === DEVICE_ID
          ? {
              device_id: DEVICE_ID,
              device_name: 'Export Test Phone',
              platform: 'android',
              public_key: DEVICE_PUBLIC_B64URL,
              credential_hash: 'cred',
              app_version: '1.0.0',
              paired_at: new Date(NOW).toISOString(),
              last_seen_at: null,
              last_ack_revision: 0,
              revoked_at: null
            }
          : null
    },
    { now: () => NOW }
  )
  return {
    getServerInfo: async () => ({
      protocolVersion: 1,
      serverId: 'wxnn-export-test',
      name: 'WXNN XiangCe',
      libraryRevision: 1,
      capabilities: {
        websocketEvents: true,
        rangeRequests: true,
        metadataV1: true,
        motionAssets: true
      }
    }),
    getServerIdentity: async () => ({ serverId: 'wxnn-export-test', serverName: 'WXNN XiangCe' }),
    getCurrentRevision: () => 1,
    listAssets: () => ({ items: [], libraryRevision: 1 }),
    getAssetDetail: async (assetId) =>
      assetId === '1'
        ? ({
            asset: {
              schemaVersion: 1,
              assetId: '1',
              type: 'photo',
              state: 'ready',
              source: { game: 'infinity_nikki', discoveredAt: new Date(NOW).toISOString() },
              resources: [],
              metadata: {
                schemaVersion: 1,
                identity: { uid: '10001' },
                capture: { capturedAt: '2026-10-11T08:09:10.000Z' },
                camera: {},
                raw: { nativeParamPayload: 'PRIVATE' }
              },
              revision: 1
            }
          } as never)
        : null,
    getResourceLocation: async (assetId, resourceId) =>
      assetId === '1' && resourceId === 'res_1_primary'
        ? {
            resource: {
              resourceId,
              role: 'source_primary',
              fileName: 'photo.jpg',
              mimeType: 'image/jpeg',
              fileExt: 'jpg',
              sizeBytes: fixtureBytes.length,
              sha256: sha256(readFileSync(fixturePath))
            },
            absolutePath: fixturePath
          }
        : null,
    getChanges: async () => ({ changes: [], libraryRevision: 1, fullResyncRequired: false }),
    verifyRequest: (input) => auth.verifyRequest(input),
    redeemToken: async () => {
      throw new Error('not used')
    },
    ...overrides
  }
}

async function callExport(
  services: SyncApiServices,
  method: string,
  search: string,
  headers: Record<string, string>
): Promise<RecordedResponse> {
  const handler = createApiRequestHandler({
    services,
    config: { maxJsonBodyBytes: 1024 * 1024 },
    logger
  })
  const url = `/v1/assets/1/resources/res_1_primary/export${search}`
  const { res, state } = mockRes()
  await handler(mockReq(method, url, headers), res)
  return state
}

describe('export route（/v1/assets/{id}/resources/{rid}/export）', () => {
  let tempDir = ''
  let fixturePath = ''
  let jpeg = Buffer.alloc(0)

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'wxnn-export-route-'))
    fixturePath = path.join(tempDir, 'photo.jpg')
    jpeg = minimalJpeg()
    writeFileSync(fixturePath, jpeg)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('rejects unsigned export requests with 401', async () => {
    const state = await callExport(
      createServices(fixturePath, jpeg),
      'GET',
      '?exif=true&rotation=90',
      {}
    )
    expect(state.status).toBe(401)
    expect(JSON.parse(state.text)).toMatchObject({ error: { code: 'unauthorized' } })
  })

  it('returns 400 for invalid option combinations', async () => {
    const services = createServices(fixturePath, jpeg)
    for (const search of [
      '?exif=true&rotation=91',
      '?exif=true&rotation=90&path=x',
      '?exif=true&exif=false&rotation=0',
      '?exif=true',
      '?rotation=90',
      '?exif=yes&rotation=0'
    ]) {
      const state = await callExport(
        services,
        'GET',
        search,
        signedHeaders('GET', `/v1/assets/1/resources/res_1_primary/export${search}`)
      )
      expect(state.status, search).toBe(400)
      expect(JSON.parse(state.text)).toMatchObject({ error: { code: 'bad_request' } })
    }
  })

  it('returns 400 when a Range header is present', async () => {
    const search = '?exif=true&rotation=0'
    const state = await callExport(
      createServices(fixturePath, jpeg),
      'GET',
      search,
      signedHeaders(
        'GET',
        `/v1/assets/1/resources/res_1_primary/export${search}`,
        Buffer.alloc(0),
        {
          // node:http 会将头名统一小写；mock 直接透传对象，须用小写键
          range: 'bytes=0-3'
        }
      )
    )
    expect(state.status).toBe(400)
  })

  it('exports a lossless JPEG with the full contract header set', async () => {
    const search = '?exif=true&rotation=90'
    const state = await callExport(
      createServices(fixturePath, jpeg),
      'GET',
      search,
      signedHeaders('GET', `/v1/assets/1/resources/res_1_primary/export${search}`)
    )
    expect(state.status).toBe(200)
    expect(state.headers['Content-Type']).toBe('image/jpeg')
    expect(state.headers['X-NikkiSync-Export']).toBe('jpeg-exif-v1')
    expect(state.headers['X-NikkiSync-Rotation']).toBe('90')
    expect(state.headers['X-NikkiSync-Exif']).toBe('1')
    expect(state.headers['Cache-Control']).toBe('private, no-store')
    const output = state.raw
    expect(output).not.toEqual(jpeg)
    expect(state.headers['X-NikkiSync-SHA256']).toBe(sha256(output))
    expect(output.includes(Buffer.from('Momo Camera'))).toBe(true)
    // raw 敏感键绝不进入导出文件
    expect(output.includes(Buffer.from('PRIVATE'))).toBe(false)
    // 源文件不被修改
    expect(readFileSync(fixturePath)).toEqual(jpeg)
  })

  it('returns source-identical bytes for exif=false&rotation=0 and supports HEAD', async () => {
    const services = createServices(fixturePath, jpeg)
    const search = '?exif=false&rotation=0'
    const path_ = `/v1/assets/1/resources/res_1_primary/export${search}`
    const plain = await callExport(services, 'GET', search, signedHeaders('GET', path_))
    expect(plain.status).toBe(200)
    expect(plain.raw).toEqual(jpeg)
    expect(plain.headers['X-NikkiSync-Exif']).toBe('0')

    const head = await callExport(services, 'HEAD', search, signedHeaders('HEAD', path_))
    expect(head.status).toBe(200)
    expect(head.headers['X-NikkiSync-Export']).toBe('jpeg-exif-v1')
    expect(Number(head.headers['Content-Length'])).toBeGreaterThan(0)
    expect(head.raw.length).toBe(0)
  })

  it('returns 404 for motion assets, wrong roles, non-JPEG and missing resources', async () => {
    const services = createServices(fixturePath, jpeg, {
      getAssetDetail: async (assetId) =>
        assetId === '2'
          ? ({
              asset: {
                schemaVersion: 1,
                assetId: '2',
                type: 'motion_photo',
                state: 'ready',
                source: { game: 'infinity_nikki', discoveredAt: new Date(NOW).toISOString() },
                resources: [],
                revision: 1
              }
            } as never)
          : assetId === '1'
            ? ({
                asset: {
                  schemaVersion: 1,
                  assetId: '1',
                  type: 'photo',
                  state: 'deleted',
                  source: { game: 'infinity_nikki', discoveredAt: new Date(NOW).toISOString() },
                  resources: [],
                  revision: 1
                }
              } as never)
            : null,
      getResourceLocation: async (_assetId, resourceId) =>
        resourceId === 'res_motion'
          ? {
              resource: {
                resourceId,
                role: 'source_motion',
                fileName: 'motion.jpg',
                mimeType: 'image/jpeg',
                fileExt: 'jpg',
                sizeBytes: jpeg.length,
                sha256: sha256(jpeg)
              },
              absolutePath: fixturePath
            }
          : resourceId === 'res_png'
            ? {
                resource: {
                  resourceId,
                  role: 'source_primary',
                  fileName: 'pic.png',
                  mimeType: 'image/png',
                  fileExt: 'png',
                  sizeBytes: jpeg.length,
                  sha256: sha256(jpeg)
                },
                absolutePath: fixturePath
              }
            : null
    })
    const request = (
      search: string,
      assetId = '1',
      resourceId = 'res_1_primary'
    ): Promise<RecordedResponse> => {
      const handler = createApiRequestHandler({
        services,
        config: { maxJsonBodyBytes: 1024 * 1024 },
        logger
      })
      const { res, state } = mockRes()
      const url = `/v1/assets/${assetId}/resources/${resourceId}/export${search}`
      return handler(mockReq('GET', url, signedHeaders('GET', url)), res).then(() => state)
    }
    expect((await request('?exif=true&rotation=0', '2')).status).toBe(404) // motion_photo
    expect((await request('?exif=true&rotation=0', '1')).status).toBe(404) // state deleted
    expect((await request('?exif=true&rotation=0', '1', 'res_motion')).status).toBe(404) // role
    expect((await request('?exif=true&rotation=0', '1', 'res_png')).status).toBe(404) // mime
    expect((await request('?exif=true&rotation=0', '9')).status).toBe(404) // 不存在
    expect((await request('?exif=true&rotation=0', 'abc')).status).toBe(404) // 非数字 assetId
  })

  it('returns 409 when source bytes no longer match the recorded hash', async () => {
    const services = createServices(fixturePath, jpeg)
    writeFileSync(
      fixturePath,
      Buffer.concat([jpeg.subarray(0, jpeg.length - 1), Buffer.from([0x00])])
    )
    const search = '?exif=true&rotation=0'
    const state = await callExport(
      services,
      'GET',
      search,
      signedHeaders('GET', `/v1/assets/1/resources/res_1_primary/export${search}`)
    )
    expect(state.status).toBe(409)
    expect(JSON.parse(state.text)).toMatchObject({ error: { code: 'resource_not_ready' } })
  })

  it('rate-limits concurrent exports to a single flight (429)', async () => {
    // 单飞限流作用于 handler 实例闭包：必须复用同一 handler 并发请求（callExport 每次新建实例测不到）
    const handler = createApiRequestHandler({
      services: createServices(fixturePath, jpeg),
      config: { maxJsonBodyBytes: 1024 * 1024 },
      logger
    })
    const search = '?exif=true&rotation=0'
    const url = `/v1/assets/1/resources/res_1_primary/export${search}`
    const first = mockRes()
    const second = mockRes()
    await Promise.all([
      handler(mockReq('GET', url, signedHeaders('GET', url)), first.res),
      handler(mockReq('GET', url, signedHeaders('GET', url)), second.res)
    ])
    expect(first.state.status).toBe(200)
    expect(second.state.status).toBe(429)
    expect(JSON.parse(second.state.text)).toMatchObject({ error: { code: 'resource_not_ready' } })
  })

  it('logs a warning when the export fails instead of swallowing the error silently', async () => {
    const warn = vi.fn()
    // DB 侧保留损坏前的哈希 → 走「源字节哈希失配」409 支路（而非 exportJpeg 解析失败）
    const staleHash = sha256(jpeg)
    writeFileSync(
      fixturePath,
      Buffer.concat([jpeg.subarray(0, jpeg.length - 1), Buffer.from([0x00])])
    )
    const services = createServices(fixturePath, jpeg, {
      getResourceLocation: async (assetId, resourceId) =>
        assetId === '1' && resourceId === 'res_1_primary'
          ? {
              resource: {
                resourceId,
                role: 'source_primary',
                fileName: 'photo.jpg',
                mimeType: 'image/jpeg',
                fileExt: 'jpg',
                sizeBytes: jpeg.length,
                sha256: staleHash
              },
              absolutePath: fixturePath
            }
          : null
    })
    const handler = createApiRequestHandler({
      services,
      config: { maxJsonBodyBytes: 1024 * 1024 },
      logger: { info: vi.fn(), warn }
    })
    const search = '?exif=true&rotation=0'
    const url = `/v1/assets/1/resources/res_1_primary/export${search}`
    const { res, state } = mockRes()
    await handler(mockReq('GET', url, signedHeaders('GET', url)), res)
    expect(state.status).toBe(409)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('Source changed')
  })

  it('normalizes an uppercase recorded sha256 before source verification', async () => {
    const services = createServices(fixturePath, jpeg, {
      getResourceLocation: async (assetId, resourceId) =>
        assetId === '1' && resourceId === 'res_1_primary'
          ? {
              resource: {
                resourceId,
                role: 'source_primary',
                fileName: 'photo.jpg',
                mimeType: 'image/jpeg',
                fileExt: 'jpg',
                sizeBytes: jpeg.length,
                // 形状正则允许大写十六进制；比较侧（digest 恒小写）必须同样大小写不敏感
                sha256: sha256(jpeg).toUpperCase()
              },
              absolutePath: fixturePath
            }
          : null
    })
    const search = '?exif=true&rotation=0'
    const state = await callExport(
      services,
      'GET',
      search,
      signedHeaders('GET', `/v1/assets/1/resources/res_1_primary/export${search}`)
    )
    expect(state.status).toBe(200)
    expect(state.headers['X-NikkiSync-SHA256']).toBe(sha256(state.raw))
  })
})
