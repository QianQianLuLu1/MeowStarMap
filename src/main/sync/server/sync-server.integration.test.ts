import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuthService } from '../auth-service'
import { PairingService } from '../pairing-service'
import { SyncIdentityService } from '../identity-service'
import { SyncServer, SYNC_SERVER_DEFAULT_PORT } from './sync-server'
import type { SyncApiServices } from './types'
import type { WsEvent } from '../../../shared/sync/protocol'

/**
 * 端到端集成测试：真实 https 服务器（127.0.0.1 随机端口、自签证书）+
 * Ed25519 现场签名 + node:https 客户端 + 原始 socket WebSocket 客户端。
 * 仓储层以内存 fake 注入（SyncApiServices 端口），原生 better-sqlite3 不可在
 * vitest/Node 下加载（Electron ABI），数据库行为由仓储自身单测覆盖。
 *
 * TLS 客户端策略对齐真实 Android 客户端（PinnedTls）：证书链校验开启，
 * 测试证书经 ca 钉扎为唯一信任锚；主机名比对跳过（客户端 hostnameVerifier
 * 同款语义，信任根是钉扎的叶子证书而非主机名）。
 */

const NOW = 1_700_000_000_000
const DEVICE_ID = 'android_integration00000000000000'

const deviceKeys = generateKeyPairSync('ed25519')
const DEVICE_PRIVATE_PEM = deviceKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const DEVICE_PUBLIC_B64URL = deviceKeys.publicKey
  .export({ type: 'spki', format: 'der' })
  .toString('base64url')

const RESOURCE_BYTES = Buffer.from('0123456789abcdefghij', 'utf8') // 20 bytes
const RESOURCE_SHA256 = createHash('sha256').update(RESOURCE_BYTES).digest('hex')

const state = { revision: 3 }

/** 已配对设备注册表：createServices 的 AuthService 与 pairing 测试共写共读 */
const pairedDeviceRegistry = new Map<string, { public_key: string; revoked_at: string | null }>()

/** 测试专用信任锚（beforeAll 中钉扎为被测服务器证书）；证书链校验始终开启 */
let pinnedCaCertPem = ''

function pinnedTlsOptions(): tls.ConnectionOptions {
  return {
    ca: pinnedCaCertPem,
    // 真实客户端的信任根是钉扎证书本身而非主机名（PairingUri 携带指纹），故跳过主机名比对
    checkServerIdentity: () => undefined
  }
}

function deviceRow(publicKeyB64Url: string) {
  return {
    device_id: DEVICE_ID,
    device_name: 'Integration Phone',
    platform: 'android',
    public_key: publicKeyB64Url,
    credential_hash: 'cred',
    app_version: '1.0.0',
    paired_at: new Date(NOW).toISOString(),
    last_seen_at: null,
    last_ack_revision: 0,
    revoked_at: null
  }
}

const resourceLocation = {
  resource: {
    resourceId: 'res_1_primary',
    role: 'source_primary' as const,
    fileName: 'photo.jpg',
    mimeType: 'image/jpeg',
    fileExt: 'jpg',
    sizeBytes: RESOURCE_BYTES.length,
    sha256: RESOURCE_SHA256
  },
  absolutePath: '' // filled in beforeAll with the temp fixture file
}

function createServices(): SyncApiServices {
  const auth = new AuthService(
    {
      getDevice: (deviceId) => {
        const registered = pairedDeviceRegistry.get(deviceId)
        if (registered) {
          return {
            device_id: deviceId,
            device_name: 'Paired Phone',
            platform: 'android',
            public_key: registered.public_key,
            credential_hash: 'cred',
            app_version: '1.0.0',
            paired_at: new Date(NOW).toISOString(),
            last_seen_at: null,
            last_ack_revision: 0,
            revoked_at: registered.revoked_at
          }
        }
        return deviceId === DEVICE_ID ? deviceRow(DEVICE_PUBLIC_B64URL) : null
      },
      touchDevice: () => undefined
    },
    { now: () => NOW }
  )
  return {
    getServerInfo: async () => ({
      protocolVersion: 1,
      serverId: 'wxnn-integration',
      name: 'WXNN XiangCe',
      libraryRevision: state.revision,
      capabilities: {
        websocketEvents: true,
        rangeRequests: true,
        metadataV1: true,
        motionAssets: true
      }
    }),
    getServerIdentity: async () => ({ serverId: 'wxnn-integration', serverName: 'WXNN XiangCe' }),
    getCurrentRevision: () => state.revision,
    listAssets: () => ({
      items: [
        {
          assetId: '1',
          type: 'photo' as const,
          state: 'ready' as const,
          revision: 2,
          hasMotion: false,
          hasMetadata: false
        }
      ],
      libraryRevision: state.revision
    }),
    getAssetDetail: async (assetId) =>
      assetId === '42'
        ? {
            asset: {
              schemaVersion: 1 as const,
              assetId: '42',
              type: 'photo' as const,
              state: 'ready' as const,
              source: {
                game: 'infinity_nikki' as const,
                discoveredAt: new Date(NOW).toISOString()
              },
              resources: [],
              revision: 2
            }
          }
        : null,
    getResourceLocation: async (assetId, resourceId) =>
      assetId === '1' && resourceId === 'res_1_primary' ? resourceLocation : null,
    getChanges: async (after) => ({
      changes:
        after < 2
          ? [
              {
                revision: 2,
                type: 'asset.created' as const,
                assetId: '1',
                occurredAt: new Date(NOW).toISOString()
              }
            ]
          : [],
      libraryRevision: state.revision,
      fullResyncRequired: false
    }),
    verifyRequest: (input) => auth.verifyRequest(input),
    redeemToken: async () => {
      throw new Error('redeemToken is replaced per-test')
    }
  }
}

function signedHeaders(
  privateKeyPem: string,
  deviceId: string,
  method: string,
  requestPath: string,
  body: Buffer = Buffer.alloc(0)
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
    'x-nikkisync-device-id': deviceId,
    'x-nikkisync-timestamp': timestamp,
    'x-nikkisync-nonce': nonce,
    'x-nikkisync-signature': sign(null, Buffer.from(canonical, 'utf8'), privateKeyPem).toString(
      'base64url'
    )
  }
}

interface HttpResponse {
  status: number
  headers: IncomingHttpHeaders
  raw: Buffer
  text: string
}

function httpsRequest(
  port: number,
  method: string,
  requestPath: string,
  headers: Record<string, string> = {},
  body?: Buffer
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: requestPath,
        headers,
        ...pinnedTlsOptions()
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const raw = Buffer.concat(chunks)
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            raw,
            text: raw.toString('utf8')
          })
        })
      }
    )
    req.on('error', reject)
    if (body && body.length > 0) req.write(body)
    req.end()
  })
}

// ============ 最小 WebSocket 测试客户端（原始 tls socket，照上游测试模式） ============

interface ParsedFrame {
  opcode: number
  payload: Buffer
  totalLength: number
}

function tryParseFrame(buf: Buffer): ParsedFrame | null {
  if (buf.length < 2) return null
  const opcode = buf[0]! & 0x0f
  const masked = (buf[1]! & 0x80) !== 0
  let length = buf[1]! & 0x7f
  let offset = 2
  if (length === 126) {
    if (buf.length < 4) return null
    length = buf.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buf.length < 10) return null
    length = Number(buf.readBigUInt64BE(2))
    offset = 10
  }
  const maskBytes = masked ? 4 : 0
  if (buf.length < offset + maskBytes + length) return null
  let payload = buf.subarray(offset + maskBytes, offset + maskBytes + length)
  if (masked) {
    const mask = buf.subarray(offset, offset + 4)
    const unmasked = Buffer.from(payload)
    for (let i = 0; i < unmasked.length; i++) unmasked[i] = unmasked[i]! ^ mask[i % 4]!
    payload = unmasked
  }
  return { opcode, payload, totalLength: offset + maskBytes + length }
}

class WsClient {
  readonly socket: tls.TLSSocket
  private buffer = Buffer.alloc(0)
  private notify: (() => void) | undefined
  private closed = false
  private closedWaiter: (() => void) | undefined

  constructor(port: number) {
    this.socket = tls.connect({ host: '127.0.0.1', port, ...pinnedTlsOptions() })
    this.socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.notify?.()
      this.notify = undefined
    })
    this.socket.on('close', () => {
      this.closed = true
      this.closedWaiter?.()
      this.notify?.()
    })
    this.socket.on('error', () => {
      this.closed = true
      this.closedWaiter?.()
      this.notify?.()
    })
  }

  writeUpgrade(headers: Record<string, string>, port: number): void {
    const key = randomBytes(16).toString('base64')
    const lines = [
      'GET /ws/v1 HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      '\r\n'
    ]
    this.socket.write(lines.join('\r\n'))
  }

  sendMaskedFrame(opcode: number, payload: Buffer): void {
    const mask = randomBytes(4)
    const masked = Buffer.from(payload)
    for (let i = 0; i < masked.length; i++) masked[i] = masked[i]! ^ mask[i % 4]!
    this.socket.write(
      Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, masked])
    )
  }

  private waitForData(): Promise<void> {
    if (this.buffer.length > 0 || this.closed) return Promise.resolve()
    return new Promise((resolve) => {
      this.notify = resolve
    })
  }

  async readFrame(timeoutMs = 5000): Promise<ParsedFrame> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (this.closed && tryParseFrame(this.buffer) === null) {
        throw new Error('websocket closed before a complete frame arrived')
      }
      const frame = tryParseFrame(this.buffer)
      if (frame) {
        this.buffer = this.buffer.subarray(frame.totalLength)
        return frame
      }
      if (Date.now() > deadline) throw new Error('timed out waiting for a websocket frame')
      await Promise.race([this.waitForData(), new Promise((r) => setTimeout(r, 50))])
    }
  }

  async readTextEvent(timeoutMs = 5000): Promise<Record<string, unknown>> {
    for (;;) {
      const frame = await this.readFrame(timeoutMs)
      if (frame.opcode === 0x1)
        return JSON.parse(frame.payload.toString('utf8')) as Record<string, unknown>
    }
  }

  async readUpgradeResponse(): Promise<string> {
    const deadline = Date.now() + 5000
    for (;;) {
      const index = this.buffer.indexOf('\r\n\r\n')
      if (index >= 0) {
        const head = this.buffer.subarray(0, index).toString('utf8')
        this.buffer = this.buffer.subarray(index + 4)
        return head
      }
      if (Date.now() > deadline) throw new Error('timed out waiting for the upgrade response')
      await Promise.race([this.waitForData(), new Promise((r) => setTimeout(r, 50))])
    }
  }

  async waitUntilClosed(timeoutMs = 5000): Promise<void> {
    if (this.closed) return
    await Promise.race([
      new Promise<void>((resolve) => {
        this.closedWaiter = resolve
      }),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('websocket did not close in time')), timeoutMs)
      )
    ])
  }

  destroy(): void {
    this.socket.destroy()
  }
}

// ============ 测试主体 ============

let server: SyncServer
let services: SyncApiServices
let port = 0
let tempDir = ''

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxnn-sync-server-test-'))
  const fixturePath = path.join(tempDir, 'photo.jpg')
  fs.writeFileSync(fixturePath, RESOURCE_BYTES)
  resourceLocation.absolutePath = fixturePath

  const identity = new SyncIdentityService({ directory: path.join(tempDir, 'identity') })
  const tlsIdentity = identity.getOrCreateTlsIdentity()
  pinnedCaCertPem = tlsIdentity.certPem
  services = createServices()
  server = new SyncServer(services, {
    host: '127.0.0.1',
    port: 0,
    tls: { key: tlsIdentity.keyPem, cert: tlsIdentity.certPem }
  })
  const address = await server.start()
  port = address.port
})

afterAll(async () => {
  await server.stop()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('sync server (integration)', () => {
  it('binds the requested port, defaulting to 27124 when unset', () => {
    expect(SYNC_SERVER_DEFAULT_PORT).toBe(27124)
    expect(port).toBeGreaterThan(0)
    expect(server.getStatus()).toMatchObject({ running: true, port })
  })

  it('serves GET /v1/server without authentication over TLS', async () => {
    const response = await httpsRequest(port, 'GET', '/v1/server')
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(response.text)).toMatchObject({
      protocolVersion: 1,
      serverId: 'wxnn-integration',
      libraryRevision: 3
    })
  })

  it('rejects unauthenticated API requests with 401 ApiErrorBody', async () => {
    const response = await httpsRequest(port, 'GET', '/v1/assets')
    expect(response.status).toBe(401)
    expect(JSON.parse(response.text)).toMatchObject({ error: { code: 'unauthorized' } })
  })

  it('serves authenticated endpoints with a valid signature', async () => {
    const response = await httpsRequest(
      port,
      'GET',
      '/v1/assets?limit=1',
      signedHeaders(DEVICE_PRIVATE_PEM, DEVICE_ID, 'GET', '/v1/assets?limit=1')
    )
    expect(response.status).toBe(200)
    const body = JSON.parse(response.text) as { items: unknown[]; libraryRevision: number }
    expect(body.items).toHaveLength(1)
    expect(body.libraryRevision).toBe(3)
  })

  it('rejects replayed signatures (nonce reuse) with 401', async () => {
    const headers = signedHeaders(DEVICE_PRIVATE_PEM, DEVICE_ID, 'GET', '/v1/changes?after=0')
    const first = await httpsRequest(port, 'GET', '/v1/changes?after=0', headers)
    expect(first.status).toBe(200)
    const second = await httpsRequest(port, 'GET', '/v1/changes?after=0', headers)
    expect(second.status).toBe(401)
  })

  it('serves asset detail and 404 for missing assets', async () => {
    const ok = await httpsRequest(
      port,
      'GET',
      '/v1/assets/42',
      signedHeaders(DEVICE_PRIVATE_PEM, DEVICE_ID, 'GET', '/v1/assets/42')
    )
    expect(ok.status).toBe(200)
    expect(JSON.parse(ok.text)).toMatchObject({ asset: { assetId: '42', revision: 2 } })

    const missing = await httpsRequest(
      port,
      'GET',
      '/v1/assets/999',
      signedHeaders(DEVICE_PRIVATE_PEM, DEVICE_ID, 'GET', '/v1/assets/999')
    )
    expect(missing.status).toBe(404)
    expect(JSON.parse(missing.text)).toMatchObject({
      error: { code: 'not_found', message: 'Asset not found' }
    })
  })

  it('streams the full resource with immutable cache headers', async () => {
    const target = '/v1/assets/1/resources/res_1_primary'
    const response = await httpsRequest(
      port,
      'GET',
      target,
      signedHeaders(DEVICE_PRIVATE_PEM, DEVICE_ID, 'GET', target)
    )
    expect(response.status).toBe(200)
    expect(response.raw.equals(RESOURCE_BYTES)).toBe(true)
    expect(response.headers['accept-ranges']).toBe('bytes')
    expect(response.headers['content-length']).toBe(String(RESOURCE_BYTES.length))
    expect(response.headers['etag']).toBe(`"sha256:${RESOURCE_SHA256}"`)
    expect(response.headers['x-nikkisync-sha256']).toBe(RESOURCE_SHA256)
  })

  it('answers a single-range request with 206 and Content-Range', async () => {
    const target = '/v1/assets/1/resources/res_1_primary'
    const response = await httpsRequest(port, 'GET', target, {
      Range: 'bytes=2-5',
      ...signedHeaders(DEVICE_PRIVATE_PEM, DEVICE_ID, 'GET', target)
    })
    expect(response.status).toBe(206)
    expect(response.raw.toString('utf8')).toBe('2345')
    expect(response.headers['content-range']).toBe(`bytes 2-5/${RESOURCE_BYTES.length}`)
    expect(response.headers['content-length']).toBe('4')
    expect(response.headers['accept-ranges']).toBe('bytes')
  })

  it('supports suffix and open-ended ranges', async () => {
    const target = '/v1/assets/1/resources/res_1_primary'
    const suffix = await httpsRequest(port, 'GET', target, {
      Range: 'bytes=-5',
      ...signedHeaders(DEVICE_PRIVATE_PEM, DEVICE_ID, 'GET', target)
    })
    expect(suffix.status).toBe(206)
    expect(suffix.raw.toString('utf8')).toBe('fghij')

    const open = await httpsRequest(port, 'GET', target, {
      Range: 'bytes=18-',
      ...signedHeaders(DEVICE_PRIVATE_PEM, DEVICE_ID, 'GET', target)
    })
    expect(open.status).toBe(206)
    expect(open.raw.toString('utf8')).toBe('ij')
  })

  it('rejects unsatisfiable and multi-range requests with 416', async () => {
    const target = '/v1/assets/1/resources/res_1_primary'
    const unsatisfiable = await httpsRequest(port, 'GET', target, {
      Range: 'bytes=999999-',
      ...signedHeaders(DEVICE_PRIVATE_PEM, DEVICE_ID, 'GET', target)
    })
    expect(unsatisfiable.status).toBe(416)
    expect(unsatisfiable.headers['content-range']).toBe(`bytes */${RESOURCE_BYTES.length}`)

    const multi = await httpsRequest(port, 'GET', target, {
      Range: 'bytes=0-1,3-4',
      ...signedHeaders(DEVICE_PRIVATE_PEM, DEVICE_ID, 'GET', target)
    })
    expect(multi.status).toBe(416)
  })

  it('answers HEAD resource requests with headers only', async () => {
    const target = '/v1/assets/1/resources/res_1_primary'
    const response = await httpsRequest(
      port,
      'HEAD',
      target,
      signedHeaders(DEVICE_PRIVATE_PEM, DEVICE_ID, 'HEAD', target)
    )
    expect(response.status).toBe(200)
    expect(response.raw.length).toBe(0)
    expect(response.headers['content-length']).toBe(String(RESOURCE_BYTES.length))
  })

  it('returns 404 resource_not_ready for unknown resources', async () => {
    const target = '/v1/assets/1/resources/res_9_primary'
    const response = await httpsRequest(
      port,
      'GET',
      target,
      signedHeaders(DEVICE_PRIVATE_PEM, DEVICE_ID, 'GET', target)
    )
    expect(response.status).toBe(404)
    expect(JSON.parse(response.text)).toMatchObject({ error: { code: 'resource_not_ready' } })
  })

  it('validates the changes query and serves the journal', async () => {
    const missing = await httpsRequest(
      port,
      'GET',
      '/v1/changes',
      signedHeaders(DEVICE_PRIVATE_PEM, DEVICE_ID, 'GET', '/v1/changes')
    )
    expect(missing.status).toBe(400)

    const ok = await httpsRequest(
      port,
      'GET',
      '/v1/changes?after=0',
      signedHeaders(DEVICE_PRIVATE_PEM, DEVICE_ID, 'GET', '/v1/changes?after=0')
    )
    expect(ok.status).toBe(200)
    const body = JSON.parse(ok.text) as { changes: unknown[]; fullResyncRequired: boolean }
    expect(body.changes).toHaveLength(1)
    expect(body.fullResyncRequired).toBe(false)
  })

  it('maps PairingError codes to 410/401 and completes a full pairing handshake', async () => {
    // 一次性会话存储（真实 SyncPairingRepository 行为的内存替身）
    const sessions = new Map<string, { expiresAt: string; used: boolean }>()
    const pairing = new PairingService({
      sessions: {
        createSession: async (input) => {
          sessions.set(input.tokenHash, { expiresAt: input.expiresAt, used: false })
        },
        consumeSession: async (tokenHash, nowIso) => {
          const session = sessions.get(tokenHash)
          if (!session) return 'missing'
          if (session.used) return 'used'
          if (session.expiresAt <= nowIso) return 'expired'
          session.used = true
          return 'ok'
        }
      },
      devices: {
        upsertPairDevice: async (input) => {
          pairedDeviceRegistry.set(input.deviceId, {
            public_key: input.publicKey,
            revoked_at: null
          })
        },
        ensureServerIdentity: async () => ({
          serverId: 'wxnn-integration',
          serverName: 'WXNN XiangCe'
        })
      },
      identity: {
        getOrCreateTlsIdentity: () => ({
          keyPem: 'unused',
          certPem: 'unused',
          fingerprintSha256: 'a'.repeat(64),
          createdAt: new Date(NOW).toISOString()
        }),
        getOrCreateServerIdentity: () => ({
          publicKeyPem: '-----BEGIN PUBLIC KEY-----\nunused\n-----END PUBLIC KEY-----',
          privateKeyPem: 'unused'
        })
      },
      now: () => NOW
    })
    // 将真实 PairingService 接入服务器（其余用例不触发 redeemToken）
    services.redeemToken = (request) => pairing.redeemToken(request)

    const pairPath = '/v1/pair'
    const secondDevice = generateKeyPairSync('ed25519')
    const secondPublicB64 = secondDevice.publicKey
      .export({ type: 'spki', format: 'der' })
      .toString('base64url')

    const expiredOffer = await pairing.createPairingToken({ ttlMs: -1000 })
    const expired = await httpsRequest(
      port,
      'POST',
      pairPath,
      {},
      Buffer.from(
        JSON.stringify({
          pairingToken: expiredOffer.token,
          device: {
            deviceId: 'android_second0000000000000000',
            deviceName: 'Second Phone',
            platform: 'android',
            publicKey: secondPublicB64,
            appVersion: '1.0.0'
          }
        })
      )
    )
    expect(expired.status).toBe(410)
    expect(JSON.parse(expired.text)).toMatchObject({ error: { code: 'pairing_expired' } })

    const offer = await pairing.createPairingToken()
    const pairBody = JSON.stringify({
      pairingToken: offer.token,
      device: {
        deviceId: 'android_second0000000000000000',
        deviceName: 'Second Phone',
        platform: 'android',
        publicKey: secondPublicB64,
        appVersion: '1.0.0'
      }
    })
    const paired = await httpsRequest(port, 'POST', pairPath, {}, Buffer.from(pairBody))
    expect(paired.status).toBe(200)
    const pairResponse = JSON.parse(paired.text) as Record<string, unknown>
    expect(pairResponse).toMatchObject({ serverId: 'wxnn-integration', protocolVersion: 1 })
    expect(typeof pairResponse.deviceCredential).toBe('string')

    const replay = await httpsRequest(port, 'POST', pairPath, {}, Buffer.from(pairBody))
    expect(replay.status).toBe(401)
    expect(JSON.parse(replay.text)).toMatchObject({ error: { code: 'pairing_invalid' } })

    // 配对后的新设备即可通过签名认证（覆盖真实认证链路）
    const secondPrivateKey = secondDevice.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString()
    const target = '/v1/assets?limit=1'
    const authed = await httpsRequest(
      port,
      'GET',
      target,
      signedHeaders(secondPrivateKey, 'android_second0000000000000000', 'GET', target)
    )
    expect(authed.status).toBe(200)
    expect(pairedDeviceRegistry.size).toBe(1)
  })

  it('stubs search and stats endpoints with protocol-shaped empty results', async () => {
    const suits = await httpsRequest(
      port,
      'GET',
      '/v1/search/suits?q=blue',
      signedHeaders(DEVICE_PRIVATE_PEM, DEVICE_ID, 'GET', '/v1/search/suits?q=blue')
    )
    expect(suits.status).toBe(200)
    expect(JSON.parse(suits.text)).toEqual({ query: 'blue', items: [] })

    const stats = await httpsRequest(
      port,
      'GET',
      '/v1/profile/stats',
      signedHeaders(DEVICE_PRIVATE_PEM, DEVICE_ID, 'GET', '/v1/profile/stats')
    )
    expect(stats.status).toBe(200)
    expect(JSON.parse(stats.text)).toEqual({ libraryRevision: 3, topSuits: [], topClothing: [] })
  })

  describe('websocket', () => {
    it('completes the signed upgrade, sends server.hello and answers pings', async () => {
      const client = new WsClient(port)
      client.writeUpgrade(signedHeaders(DEVICE_PRIVATE_PEM, DEVICE_ID, 'GET', '/ws/v1'), port)
      const head = await client.readUpgradeResponse()
      expect(head).toContain('101')

      const hello = await client.readTextEvent()
      expect(hello).toMatchObject({
        event: 'server.hello',
        protocolVersion: 1,
        serverId: 'wxnn-integration',
        libraryRevision: 3
      })

      client.sendMaskedFrame(0x9, Buffer.from('ping-payload'))
      const pong = await client.readFrame()
      // 解析器已将首字节掩码为低 4 位：0x8a（FIN|PONG）→ 0x0a
      expect(pong.opcode).toBe(0x0a)
      expect(pong.payload.toString('utf8')).toBe('ping-payload')

      client.destroy()
    })

    it('broadcasts change events to connected clients', async () => {
      const client = new WsClient(port)
      client.writeUpgrade(signedHeaders(DEVICE_PRIVATE_PEM, DEVICE_ID, 'GET', '/ws/v1'), port)
      await client.readUpgradeResponse()
      await client.readTextEvent() // server.hello

      const event: WsEvent = {
        event: 'asset.created',
        revision: 4,
        assetId: '42',
        occurredAt: new Date(NOW).toISOString()
      }
      server.broadcastEvent(event)
      const received = await client.readTextEvent()
      expect(received).toEqual(event as unknown as Record<string, unknown>)

      client.destroy()
    })

    it('destroys the socket when the upgrade is not signed', async () => {
      const client = new WsClient(port)
      client.writeUpgrade({}, port)
      await client.waitUntilClosed()
      client.destroy()
    })
  })

  it('stops gracefully and releases the port', async () => {
    const address = server.getStatus()
    await server.stop()
    expect(server.getStatus()).toMatchObject({ running: false, connections: 0 })

    // 同端口可立即复用（close 回调完成后释放）
    const identity = new SyncIdentityService({ directory: path.join(tempDir, 'identity') })
    const tlsIdentity = identity.getOrCreateTlsIdentity()
    const restarted = new SyncServer(createServices(), {
      host: '127.0.0.1',
      port: address.port,
      tls: { key: tlsIdentity.keyPem, cert: tlsIdentity.certPem }
    })
    const rebound = await restarted.start()
    expect(rebound.port).toBe(address.port)
    await restarted.stop()
  })

  it('retries the next port when the configured port is busy', async () => {
    const blocker = net.createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const busyPort = (blocker.address() as net.AddressInfo).port
    try {
      const identity = new SyncIdentityService({ directory: path.join(tempDir, 'identity') })
      const tlsIdentity = identity.getOrCreateTlsIdentity()
      const blocked = new SyncServer(createServices(), {
        host: '127.0.0.1',
        port: busyPort,
        portRetryLimit: 2,
        tls: { key: tlsIdentity.keyPem, cert: tlsIdentity.certPem }
      })
      const address = await blocked.start()
      expect(address.port).toBe(busyPort + 1)
      await blocked.stop()
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })
})
