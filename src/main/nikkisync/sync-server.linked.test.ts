import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { X509Certificate, createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'

import { buildPackagingContext } from './embedding-paths'
import {
  createManagerDependencies,
  createRuntimeSession,
  loadLanAddressLister
} from './runtime-facade'
import { createRuntimeManager } from './runtime-manager'
import { hasNikkiSyncLink, loadNikkiSyncPackage, nikkisyncExport } from './runtime-loader'
import type { NikkiSyncRuntimeSession, NikkiSyncSessionOptions } from './runtime-types'

/**
 * NikkiSync LocalSyncServer 链接态集成用例（整合阶段 3 · T-A）。
 *
 * 本件是阶段 3 的**红灯载体**。它断言的不是本仓编排细节，而是「NikkiSync 自带的
 * LocalSyncServer 在嵌入态里真能把 Protocol v1 全套跑起来」：HTTPS + 自签 TLS 身份、
 * Ed25519 逐请求鉴权、一次性配对、Range/206/416、change_journal 驱动的 WebSocket 事件、
 * 停止后可重启。服务器本体全部来自上游，本仓只提供启停与配对面。
 *
 * 依据（以 `NikkiSync@d4ca7d7` 源码为准，不凭记忆）：
 * - 路由/状态码：`apps/pc-companion/src/server/LocalSyncServer.ts:222-264`
 * - 签名头与规范串：`src/server/AuthService.ts:27-62`
 * - 一次性 token 与错误映射：`src/server/PairingService.ts:66-85`（used/missing → 401，expired → 410）
 * - `NS1|` 七段：`packages/protocol/src/index.ts:326-329`
 * - `signedHeaders` / `readWsText` 取自 `apps/pc-companion/test/local-sync-server.test.ts:53-82`
 *
 * TLS 客户端一律用库内自签证书作 `ca` + SAN `nikkisync.local` 做**真校验**（等价手机侧
 * pin 指纹的口径），不关验证。
 *
 * 测试构造口径 `host:'127.0.0.1' / port:0 / mdns:false`（避开防火墙与端口争用）；
 * 生产默认为 `0.0.0.0 / 28080`，**mDNS 默认关**（上游组播自激回环缺陷，见
 * `sync-server-view.ts` 的 `SYNC_SERVER_DEFAULT_MDNS` 与计划 §15）。未建链时整件 skip。
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const LINKED = hasNikkiSyncLink(projectRoot)
const suite = LINKED ? describe : describe.skip

/** 端口冲突用例专用（避开常用段）。 */
const OCCUPIED_PORT = 38137

let tempRoot = ''
const media = Buffer.from('0123456789abcdef')

/** 设备侧 Ed25519 身份（模拟手机私钥，仅在测试内）。 */
const deviceKeys = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
})

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 与上游 `AuthService` 规范串逐字一致：METHOD \n req.url \n TS \n NONCE \n sha256(body)hex。 */
function signedHeaders(
  privateKey: string,
  deviceId: string,
  method: string,
  requestPath: string,
  body = Buffer.alloc(0)
): Record<string, string> {
  const timestamp = String(Date.now())
  const nonce = randomBytes(16).toString('base64url')
  const canonical = [method, requestPath, timestamp, nonce, sha256(body)].join('\n')
  return {
    'X-NikkiSync-Device-Id': deviceId,
    'X-NikkiSync-Timestamp': timestamp,
    'X-NikkiSync-Nonce': nonce,
    'X-NikkiSync-Signature': sign(null, Buffer.from(canonical), privateKey).toString('base64url')
  }
}

interface HttpResult {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

const jsonOf = <T>(result: HttpResult): T => JSON.parse(result.body.toString('utf8')) as T

/**
 * 绑定端口与自签 CA 的最小 HTTPS 客户端：`servername` 用证书唯一 SAN，
 * 验证保持开启（关掉它这条用例就证明不了任何东西）。
 */
interface SyncClient {
  port: number
  request(
    requestPath: string,
    options?: { method?: string; headers?: Record<string, string>; body?: Buffer }
  ): Promise<HttpResult>
  /** 已配对设备视角的签名 GET。 */
  signedGet(deviceId: string, requestPath: string): Promise<HttpResult>
  /** 真实 `POST /v1/pair`。 */
  pair(deviceId: string, token: string): Promise<HttpResult>
}

function createClient(port: number, ca: string): SyncClient {
  const request = (
    requestPath: string,
    options: { method?: string; headers?: Record<string, string>; body?: Buffer } = {}
  ): Promise<HttpResult> =>
    new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: '127.0.0.1',
          port,
          path: requestPath,
          method: options.method ?? 'GET',
          servername: 'nikkisync.local',
          ca,
          headers: options.headers
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers as Record<string, string | string[] | undefined>,
              body: Buffer.concat(chunks)
            })
          )
        }
      )
      req.on('error', reject)
      if (options.body) req.write(options.body)
      req.end()
    })
  return {
    port,
    request,
    signedGet: (deviceId, requestPath) =>
      request(requestPath, {
        headers: signedHeaders(deviceKeys.privateKey, deviceId, 'GET', requestPath)
      }),
    pair: (deviceId, token) => {
      const body = Buffer.from(
        JSON.stringify({
          pairingToken: token,
          device: {
            deviceId,
            deviceName: 'Test Phone',
            platform: 'android',
            publicKey: deviceKeys.publicKey,
            appVersion: '0.0.1'
          }
        })
      )
      return request('/v1/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      })
    }
  }
}

/** `NS1|serverId|host|port|token|expiresSeconds|tlsFingerprint`（`buildPairingUri` 口径）。 */
function parsePairingUri(uri: string): {
  scheme: string
  serverId: string
  host: string
  port: number
  token: string
  expiresAtSeconds: number
  tlsFingerprintSha256: string
} {
  const parts = uri.split('|')
  expect(parts).toHaveLength(7)
  return {
    scheme: String(parts[0]),
    serverId: String(parts[1]),
    host: String(parts[2]),
    port: Number(parts[3]),
    token: String(parts[4]),
    expiresAtSeconds: Number(parts[5]),
    tlsFingerprintSha256: String(parts[6])
  }
}

/** 只读解上游 WebSocketHub 的第一条文本帧（握手头之后）。 */
async function readWsText(socket: net.Socket, timeoutMs = 8000): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('websocket frame timeout')), timeoutMs)
    const chunks: Buffer[] = []
    const onData = (incoming: Buffer): void => {
      chunks.push(incoming)
      const buffer = Buffer.concat(chunks)
      const marker = buffer.indexOf(Buffer.from('\r\n\r\n'))
      const frame = marker >= 0 ? buffer.subarray(marker + 4) : buffer
      if (!frame.length) return
      let offset = 2
      let length = frame[1]! & 0x7f
      if (length === 126) {
        length = frame.readUInt16BE(2)
        offset = 4
      }
      if (length === 127) {
        clearTimeout(timeout)
        socket.off('data', onData)
        reject(new Error('large frame unsupported in test'))
        return
      }
      if (frame.length < offset + length) return
      clearTimeout(timeout)
      socket.off('data', onData)
      resolve(frame.subarray(offset, offset + length).toString('utf8'))
    }
    socket.on('data', onData)
  })
}

/** 连上服务端并等 `server.hello`；签名头来自已配对设备。 */
async function openSocket(
  session: NikkiSyncRuntimeSession,
  port: number,
  deviceId: string
): Promise<net.Socket> {
  const socket = tls.connect({
    host: '127.0.0.1',
    port,
    servername: 'nikkisync.local',
    ca: session.tlsIdentity().certPem
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('secureConnect', () => resolve())
    socket.once('error', reject)
  })
  socket.write(
    [
      'GET /ws/v1 HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
      'Sec-WebSocket-Version: 13',
      ...Object.entries(signedHeaders(deviceKeys.privateKey, deviceId, 'GET', '/ws/v1')).map(
        ([key, value]) => `${key}: ${value}`
      ),
      '',
      ''
    ].join('\r\n')
  )
  return socket
}

beforeAll(() => {
  if (!LINKED) return
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nikkisync-sync-'))
})

afterAll(() => {
  // Windows：SQLite/监听句柄释放有延迟，EPERM 时用重试而不是把环境抖动记成失败
  if (tempRoot)
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

function databaseIn(name: string): string {
  const file = path.join(tempRoot, name, 'nikkisync.db')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  return file
}

/** 会话级选项：只监听回环、系统分配端口、不组播、journal 轮询加速。 */
function testOptions(overrides?: Partial<NikkiSyncSessionOptions>): NikkiSyncSessionOptions {
  return {
    databaseFile: databaseIn('default'),
    watcher: false,
    projectRoot,
    syncServer: {
      host: '127.0.0.1',
      port: 0,
      mdns: false,
      name: 'XiangCe sync test',
      journalPollMs: 20
    },
    ...overrides
  }
}

/** 用上游 `AssetRepository` 写夹具（走上游写路径，`change_journal` 与真实扫描同构）。 */
async function seedAsset(session: NikkiSyncRuntimeSession, assetId: string): Promise<void> {
  const database = await loadNikkiSyncPackage(
    'database',
    buildPackagingContext({ isPackaged: false, projectRoot })
  )
  const AssetRepository = nikkisyncExport(database, 'AssetRepository') as new (db: unknown) => {
    reconcile(input: Record<string, unknown>): unknown
  }
  const target = path.join(tempRoot, `${assetId}.jpeg`)
  fs.writeFileSync(target, media)
  new AssetRepository(session.runtime.database).reconcile({
    assetId,
    assetType: 'photo',
    assetState: 'ready',
    uid: '10001',
    discoveredAt: '2026-09-02T00:00:00.000Z',
    metadataSchemaVersion: 1,
    metadata: {
      schemaVersion: 1,
      dressing: {
        clothes: [
          {
            id: 'cloth_swan_dress',
            name: '天鹅之梦',
            category: 'dresses',
            suitId: 'suit_swan',
            suitName: '天鹅童话'
          }
        ]
      },
      raw: {
        nativeParamToken: 'token-visible',
        nativeParamPayload: 'pc-only-secret-payload',
        nativeParamNuan5Md5: '0123456789abcdef0123456789abcdef'
      }
    },
    resources: [
      {
        resourceId: `resource_${assetId}`,
        assetId,
        role: 'source_high_quality',
        fileName: `${assetId}.jpeg`,
        sourcePath: target,
        pathKey: target.replaceAll('\\', '/').toLowerCase(),
        mimeType: 'image/jpeg',
        fileExt: '.jpeg',
        sizeBytes: media.length,
        sha256: sha256(media),
        width: 16,
        height: 9,
        stableState: 'stable',
        isDerived: false
      }
    ]
  })
}

suite('LocalSyncServer 端到端（协议 v1 全端点，真起 TLS 服务）', () => {
  it('start() 起 HTTPS 监听、回显实际端口与 secure=true，且幂等', async () => {
    const session = await createRuntimeSession(testOptions({ databaseFile: databaseIn('start') }))
    expect(typeof session.server.start).toBe('function')
    const address = await session.server.start()
    const client = createClient(address.port, session.tlsIdentity().certPem)
    try {
      expect(address.secure).toBe(true)
      expect(address.port).toBeGreaterThan(0)
      expect(address.host).toBe('127.0.0.1')
      // 上游 `LocalSyncServer.ts:175`：重复 start 返回同一地址（不产生第二个监听）
      expect(await session.server.start()).toEqual(address)
      expect((await client.request('/v1/assets')).status).toBe(401)
    } finally {
      await session.server.stop()
      session.dispose()
    }
  }, 30000)

  it('TLS 自签身份生成并持久化（同库重开指纹不变，证书可解析且 SAN 为 nikkisync.local）', async () => {
    const options = testOptions({ databaseFile: databaseIn('tls') })
    const first = await createRuntimeSession(options)
    const identity = first.tlsIdentity()
    expect(identity.fingerprintSha256).toHaveLength(64)
    expect(identity.fingerprintSha256).toBe(identity.fingerprintSha256.toLowerCase())
    expect(identity.certPem).toMatch(/BEGIN CERTIFICATE/)
    const cert = new X509Certificate(identity.certPem)
    expect(cert.fingerprint256.replaceAll(':', '').toLowerCase()).toBe(identity.fingerprintSha256)
    expect(cert.subject).toContain('NikkiSync Local')
    expect(cert.subjectAltName).toContain('nikkisync.local')
    first.dispose()

    const again = await createRuntimeSession(options)
    try {
      expect(again.tlsIdentity().fingerprintSha256).toBe(identity.fingerprintSha256)
    } finally {
      again.dispose()
    }
  }, 30000)

  it('GET /v1/server 免鉴权 200；签名路由未签名一律 401 unauthorized', async () => {
    const session = await createRuntimeSession(testOptions({ databaseFile: databaseIn('server') }))
    const address = await session.server.start()
    const client = createClient(address.port, session.tlsIdentity().certPem)
    try {
      const info = await client.request('/v1/server')
      expect(info.status).toBe(200)
      const infoJson = jsonOf<{
        serverId: string
        libraryRevision: number
        capabilities: Record<string, unknown>
      }>(info)
      expect(infoJson.serverId).toBe(session.server.serverId)
      expect(typeof infoJson.libraryRevision).toBe('number')
      expect(infoJson.capabilities.profileStats).toBe(true)

      const unsigned = await client.request('/v1/assets')
      expect(unsigned.status).toBe(401)
      const errorBody = jsonOf<{ error: { code: string; message: string } }>(unsigned)
      expect(errorBody.error.code).toBe('unauthorized')
      expect(errorBody.error.message).toBe('Request signature is missing or invalid')
      // 鉴权闸门在任何路由匹配之前生效（含清单里那条不存在的 GET metadata）
      expect((await client.request('/v1/assets/asset_test/metadata')).status).toBe(401)
      expect((await client.request('/v1/changes?after=0')).status).toBe(401)
    } finally {
      await session.server.stop()
      session.dispose()
    }
  }, 30000)

  it('配对闭环：二维码 → POST /v1/pair 200 → 设备入库 → 重放 401 / 过期 410 → 撤销后签名请求 401', async () => {
    const session = await createRuntimeSession(testOptions({ databaseFile: databaseIn('pairing') }))
    const address = await session.server.start()
    const client = createClient(address.port, session.tlsIdentity().certPem)
    try {
      const qr = parsePairingUri(session.pairingUri('127.0.0.1'))
      expect(qr.scheme).toBe('NS1')
      expect(qr.serverId).toBe(session.server.serverId)
      expect(qr.host).toBe('127.0.0.1')
      expect(qr.port).toBe(address.port)
      expect(qr.token.length).toBeGreaterThanOrEqual(32)
      // 上游默认 TTL 5 分钟
      const ttl = qr.expiresAtSeconds * 1000 - Date.now()
      expect(ttl).toBeGreaterThan(4 * 60_000)
      expect(ttl).toBeLessThanOrEqual(5 * 60_000 + 1000)
      // 手机侧 pin 的就是这把指纹：与库内 TLS 身份一致
      expect(qr.tlsFingerprintSha256).toBe(session.tlsIdentity().fingerprintSha256)

      expect(session.listPairedDevices()).toEqual([])
      const paired = await client.pair('phone_test', qr.token)
      expect(paired.status).toBe(200)
      const pairJson = jsonOf<{
        serverId: string
        serverName: string
        serverPublicKey: string
        deviceCredential: string
        protocolVersion: number
      }>(paired)
      expect(pairJson.serverId).toBe(session.server.serverId)
      expect(pairJson.serverName).toBe('XiangCe sync test')
      expect(pairJson.protocolVersion).toBe(1)
      expect(pairJson.serverPublicKey).toMatch(/BEGIN PUBLIC KEY/)
      expect(pairJson.deviceCredential.length).toBeGreaterThan(32)

      const devices = session.listPairedDevices()
      expect(devices).toHaveLength(1)
      expect(devices[0]?.deviceId).toBe('phone_test')
      expect(devices[0]?.platform).toBe('android')
      expect(devices[0]?.deviceName).toBe('Test Phone')
      // 管理视图不得外泄敏感列
      expect(JSON.stringify(devices)).not.toMatch(/public_key|publicKey|credential/i)

      // 同一 token 重放：consumeSession → 'used' → pairing_invalid → 401
      expect((await client.pair('phone_replay', qr.token)).status).toBe(401)
      // 不存在的 token：'missing' → 401
      expect((await client.pair('phone_missing', 'not-a-real-token')).status).toBe(401)
      // 真过期：ttlMs 负数 ⇒ expires_at 落在过去 ⇒ 'expired' → 410
      const expiredToken = parsePairingUri(session.pairingUri('127.0.0.1', -1000)).token
      const expired = await client.pair('phone_expired', expiredToken)
      expect(expired.status).toBe(410)
      expect(jsonOf<{ error: { code: string } }>(expired).error.code).toBe('pairing_expired')
      // 缺必填字段 → 400
      const bad = await client.request('/v1/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ pairingToken: '' }))
      })
      expect(bad.status).toBe(400)

      expect(session.revokePairedDevice('phone_test')).toBe(true)
      expect(session.listPairedDevices()).toEqual([])
      // 上游 `revoke()` 是无条件 UPDATE ⇒ 本仓必须先验存在与未撤销，重复撤销给 false
      expect(session.revokePairedDevice('phone_test')).toBe(false)
      expect(session.revokePairedDevice('never_paired')).toBe(false)
      expect((await client.signedGet('phone_test', '/v1/assets')).status).toBe(401)
    } finally {
      await session.server.stop()
      session.dispose()
    }
  }, 60000)

  it('签名后的资产/详情/元数据/变更/搜索/统计端点全部可用', async () => {
    const session = await createRuntimeSession(testOptions({ databaseFile: databaseIn('routes') }))
    const address = await session.server.start()
    const client = createClient(address.port, session.tlsIdentity().certPem)
    try {
      await seedAsset(session, 'asset_test')
      const qr = parsePairingUri(session.pairingUri('127.0.0.1'))
      expect((await client.pair('phone_test', qr.token)).status).toBe(200)

      const list = await client.signedGet('phone_test', '/v1/assets?limit=10')
      expect(list.status).toBe(200)
      const listJson = jsonOf<{
        items: Array<{ assetId: string; type: string }>
        libraryRevision: number
      }>(list)
      expect(listJson.items.map((item) => item.assetId)).toContain('asset_test')
      expect(listJson.libraryRevision).toBeGreaterThan(0)
      // 边界：limit 由上游限定 1..500
      expect((await client.signedGet('phone_test', '/v1/assets?limit=0')).status).toBe(400)
      expect((await client.signedGet('phone_test', '/v1/assets?limit=501')).status).toBe(400)

      const detail = await client.signedGet('phone_test', '/v1/assets/asset_test')
      expect(detail.status).toBe(200)
      const detailJson = jsonOf<{
        asset: { resources: unknown[]; metadata?: { raw?: Record<string, unknown> } }
      }>(detail)
      expect(detailJson.asset.resources).toHaveLength(1)
      expect(detailJson.asset.metadata?.raw?.nativeParamToken).toBe('token-visible')
      // 上游脱敏：PC-only 字段不得下发
      expect('nativeParamPayload' in (detailJson.asset.metadata?.raw ?? {})).toBe(false)
      expect('nativeParamNuan5Md5' in (detailJson.asset.metadata?.raw ?? {})).toBe(false)
      expect((await client.signedGet('phone_test', '/v1/assets/missing_asset')).status).toBe(404)

      // 真值修正：`GET …/metadata` 不存在（`LocalSyncServer.ts:231-236` 只注册了签名 PATCH）
      expect((await client.signedGet('phone_test', '/v1/assets/asset_test/metadata')).status).toBe(
        404
      )

      const metadataPath = '/v1/assets/asset_test/metadata'
      const patchBody = Buffer.from(
        JSON.stringify({
          camera: { exposure: 0.75 },
          dressing: {
            clothes: [
              {
                id: 'cloth_star_hair',
                name: '星夜长发',
                category: 'hair',
                suitId: 'suit_star',
                suitName: '星夜回响'
              }
            ]
          }
        })
      )
      const patch = await client.request(metadataPath, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...signedHeaders(deviceKeys.privateKey, 'phone_test', 'PATCH', metadataPath, patchBody)
        },
        body: patchBody
      })
      expect(patch.status).toBe(200)
      expect(
        jsonOf<{ asset: { metadata?: { camera?: { exposure?: number } } } }>(patch).asset.metadata
          ?.camera?.exposure
      ).toBe(0.75)

      const changes = await client.signedGet('phone_test', '/v1/changes?after=0')
      expect(changes.status).toBe(200)
      expect(jsonOf<{ changes: unknown[] }>(changes).changes.length).toBeGreaterThanOrEqual(2)
      expect((await client.signedGet('phone_test', '/v1/changes')).status).toBe(400)

      const suits = await client.signedGet(
        'phone_test',
        `/v1/search/suits?q=${encodeURIComponent('星夜回响')}`
      )
      expect(suits.status).toBe(200)
      expect(
        jsonOf<{ items: Array<{ suitName: string; photoCount: number }> }>(suits).items[0]?.suitName
      ).toBe('星夜回响')
      expect((await client.signedGet('phone_test', '/v1/search/suits')).status).toBe(400)

      const clothing = await client.signedGet(
        'phone_test',
        `/v1/search/clothing?q=${encodeURIComponent('星夜长发')}`
      )
      expect(clothing.status).toBe(200)
      expect(jsonOf<{ items: Array<{ clothingId: string }> }>(clothing).items[0]?.clothingId).toBe(
        'cloth_star_hair'
      )

      const stats = await client.signedGet('phone_test', '/v1/profile/stats')
      expect(stats.status).toBe(200)
      expect(
        jsonOf<{ topSuits: unknown[]; topClothing: unknown[] }>(stats).topSuits.length
      ).toBeGreaterThanOrEqual(1)

      // 服装缩略图：嵌入态刻意**不注入** `metadataThumbnailCache` ⇒ 上游按 404 resource_not_ready 处理
      expect(
        (
          await client.signedGet(
            'phone_test',
            '/v1/assets/asset_test/clothing/cloth_star_hair/thumbnail'
          )
        ).status
      ).toBe(404)
    } finally {
      await session.server.stop()
      session.dispose()
    }
  }, 60000)

  it('资源下载支持 Range：200/206 + Content-Range + Accept-Ranges + ETag；越界 416', async () => {
    const session = await createRuntimeSession(testOptions({ databaseFile: databaseIn('range') }))
    const address = await session.server.start()
    const client = createClient(address.port, session.tlsIdentity().certPem)
    try {
      await seedAsset(session, 'asset_range')
      const qr = parsePairingUri(session.pairingUri('127.0.0.1'))
      await client.pair('phone_range', qr.token)
      const resourcePath = '/v1/assets/asset_range/resources/resource_asset_range'
      const headers = () => signedHeaders(deviceKeys.privateKey, 'phone_range', 'GET', resourcePath)

      const full = await client.request(resourcePath, { headers: headers() })
      expect(full.status).toBe(200)
      expect(full.body).toEqual(media)
      expect(full.headers['accept-ranges']).toBe('bytes')
      expect(full.headers['x-nikkisync-sha256']).toBe(sha256(media))
      expect(full.headers.etag).toBe(`"sha256:${sha256(media)}"`)

      const ranged = await client.request(resourcePath, {
        headers: { ...headers(), Range: 'bytes=2-5' }
      })
      expect(ranged.status).toBe(206)
      expect(ranged.body.toString('utf8')).toBe('2345')
      expect(ranged.headers['content-range']).toBe(`bytes 2-5/${media.length}`)

      const suffix = await client.request(resourcePath, {
        headers: { ...headers(), Range: 'bytes=-4' }
      })
      expect(suffix.status).toBe(206)
      expect(suffix.body.toString('utf8')).toBe('cdef')

      const unsatisfiable = await client.request(resourcePath, {
        headers: { ...headers(), Range: 'bytes=999999-' }
      })
      expect(unsatisfiable.status).toBe(416)
      expect(unsatisfiable.headers['content-range']).toBe(`bytes */${media.length}`)
    } finally {
      await session.server.stop()
      session.dispose()
    }
  }, 60000)

  it('WebSocket /ws/v1：签名握手收 server.hello；写 change_journal 后收 asset.created', async () => {
    const session = await createRuntimeSession(testOptions({ databaseFile: databaseIn('ws') }))
    const address = await session.server.start()
    const client = createClient(address.port, session.tlsIdentity().certPem)
    try {
      const qr = parsePairingUri(session.pairingUri('127.0.0.1'))
      await client.pair('phone_ws', qr.token)

      // 未签名的 upgrade 必须被直接掐断（上游 `LocalSyncServer.ts:567-579`）
      const refused = net.connect({ host: '127.0.0.1', port: address.port })
      await new Promise<void>((resolve) => refused.once('connect', () => resolve()))
      refused.write(
        [
          'GET /ws/v1 HTTP/1.1',
          'Host: 127.0.0.1',
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Version: 13',
          '',
          ''
        ].join('\r\n')
      )
      const closed = await new Promise<boolean>((resolve) => {
        refused.once('close', () => resolve(true))
        refused.once('data', () => resolve(false))
        setTimeout(() => resolve(false), 1500)
      })
      expect(closed).toBe(true)
      refused.destroy()

      const socket = await openSocket(session, address.port, 'phone_ws')
      const hello = JSON.parse(await readWsText(socket)) as {
        event: string
        protocolVersion: number
        serverId: string
        libraryRevision: number
      }
      expect(hello.event).toBe('server.hello')
      expect(hello.protocolVersion).toBe(1)
      expect(hello.serverId).toBe(session.server.serverId)
      expect(typeof hello.libraryRevision).toBe('number')

      // 事件只来自 change_journal 轮询（上游无公开 emit API）：写一条资产，等 20ms 轮询
      const next = readWsText(socket)
      await seedAsset(session, 'asset_ws_event')
      const event = JSON.parse(await next) as { event: string; assetId: string; revision: number }
      expect(event.event).toBe('asset.created')
      expect(event.assetId).toBe('asset_ws_event')
      expect(event.revision).toBeGreaterThan(0)
      socket.destroy()
    } finally {
      await session.server.stop()
      session.dispose()
    }
  }, 60000)

  it('stop() 后端口拒绝连接，start() 可恢复监听（重启）', async () => {
    const session = await createRuntimeSession(testOptions({ databaseFile: databaseIn('restart') }))
    const address = await session.server.start()
    const port = address.port
    await session.server.stop()
    const outcome = await new Promise<string>((resolve) => {
      const probe = net.connect({ host: '127.0.0.1', port })
      probe.once('connect', () => {
        probe.destroy()
        resolve('connected')
      })
      probe.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message))
    })
    expect(outcome).not.toBe('connected')
    const reopened = await session.server.start()
    try {
      expect(reopened.secure).toBe(true)
      expect(
        (await createClient(reopened.port, session.tlsIdentity().certPem).request('/v1/server'))
          .status
      ).toBe(200)
    } finally {
      await session.server.stop()
      session.dispose()
    }
  }, 30000)
})

suite('RuntimeManager 同步服务编排', () => {
  it('syncStatus 初始未运行；startSyncServer 惰性建会话、幂等、状态字段齐备', async () => {
    const options = testOptions({ databaseFile: databaseIn('mgr-start') })
    const manager = createRuntimeManager({
      ...createManagerDependencies(options, () => {}),
      resolvePairingHost: () => '127.0.0.1'
    })
    expect(manager.syncStatus().running).toBe(false)
    const status = await manager.startSyncServer()
    try {
      expect(status.running).toBe(true)
      expect(status.secure).toBe(true)
      expect(status.port).toBeGreaterThan(0)
      expect(status.host).toBe('127.0.0.1')
      expect(status.serverId).toBeTruthy()
      expect(status.tlsFingerprintSha256).toHaveLength(64)
      expect(status.mdnsEnabled).toBe(false)
      expect(status.pairedDeviceCount).toBe(0)
      expect(status.error).toBeUndefined()

      const again = await manager.startSyncServer()
      expect(again.port).toBe(status.port)
      expect(manager.syncStatus().running).toBe(true)

      const code = await manager.pairingCode()
      expect(code.host).toBe('127.0.0.1')
      expect(parsePairingUri(code.content).port).toBe(status.port)
      expect(code.tlsFingerprintSha256).toBe(status.tlsFingerprintSha256)
      expect(code.expiresAt).toBeTruthy()
    } finally {
      const stopped = await manager.stopSyncServer()
      expect(stopped.running).toBe(false)
      await manager.stop()
    }
    expect(manager.syncStatus().running).toBe(false)
  }, 60000)

  it('K5：默认态 NS1 逐字节不变（回归锚）；注入多 host ⇒ nikki-sync://pair? 新格式且 hosts ≤8', async () => {
    // ① 默认态：content 以 NS1| 开头、恰 6 个竖线、hosts 缺省（第三方旧客户端回归锚）
    const defaults = testOptions({ databaseFile: databaseIn('k5-default') })
    const defaultManager = createRuntimeManager({
      ...createManagerDependencies(defaults, () => {}),
      resolvePairingHost: () => '127.0.0.1'
    })
    await defaultManager.startSyncServer()
    try {
      const code = await defaultManager.pairingCode()
      expect(code.content.startsWith('NS1|')).toBe(true)
      expect(code.content.split('|').length - 1).toBe(6)
      expect(code.hosts).toBeUndefined()
    } finally {
      await defaultManager.stopSyncServer()
      await defaultManager.stop()
    }

    // ② 开启态（注入 resolvePairingHosts）：三参形态 ⇒ 新格式串，hosts 回填且 ≤8
    const multiOptions = testOptions({ databaseFile: databaseIn('k5-multi') })
    const multiManager = createRuntimeManager({
      ...createManagerDependencies(multiOptions, () => {}),
      resolvePairingHost: () => '127.0.0.1',
      resolvePairingHosts: () => ['127.0.0.1', '127.0.0.2']
    })
    await multiManager.startSyncServer()
    try {
      const code = await multiManager.pairingCode()
      expect(code.content.startsWith('nikki-sync://pair?')).toBe(true)
      expect(code.hosts).toEqual(['127.0.0.1', '127.0.0.2'])
      expect((code.hosts ?? []).length).toBeLessThanOrEqual(8)
    } finally {
      await multiManager.stopSyncServer()
      await multiManager.stop()
    }

    // ③ 深入口装载器实跑：listLanIpv4 只枚举本机地址（无子网扫描），≤8
    const lister = await loadLanAddressLister(defaults)
    const listed = lister()
    expect(Array.isArray(listed)).toBe(true)
    expect(listed.length).toBeLessThanOrEqual(8)
  }, 60000)

  it('端口被占用 ⇒ 不外抛、状态分类 PORT_IN_USE，只读查询面不受影响', async () => {
    const blocker = http.createServer()
    await new Promise<void>((resolve) =>
      blocker.listen(OCCUPIED_PORT, '127.0.0.1', () => resolve())
    )
    const options = testOptions({
      databaseFile: databaseIn('mgr-busy'),
      syncServer: {
        host: '127.0.0.1',
        port: OCCUPIED_PORT,
        mdns: false,
        name: 'XiangCe sync test',
        journalPollMs: 20
      }
    })
    const manager = createRuntimeManager(createManagerDependencies(options, () => {}))
    try {
      const status = await manager.startSyncServer()
      expect(status.running).toBe(false)
      expect(status.error).toBe('PORT_IN_USE')
      expect(status.port).toBe(OCCUPIED_PORT)
      const page = (await manager.listAssets({ limit: 10 })) as { items: unknown[] }
      expect(Array.isArray(page.items)).toBe(true)
      expect((await manager.stopSyncServer()).running).toBe(false)
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
      await manager.stop()
    }
  }, 60000)

  it('停止后配对码不可得；未启动时设备列表/撤销按前置条件失败', async () => {
    const options = testOptions({ databaseFile: databaseIn('mgr-code') })
    const manager = createRuntimeManager({
      ...createManagerDependencies(options, () => {}),
      resolvePairingHost: () => '127.0.0.1'
    })
    await manager.startSyncServer()
    await manager.stopSyncServer()
    await expect(manager.pairingCode()).rejects.toThrow(/started/i)
    await manager.stop()

    const fresh = createRuntimeManager(
      createManagerDependencies(testOptions({ databaseFile: databaseIn('mgr-none') }), () => {})
    )
    await expect(fresh.listPairedDevices()).rejects.toThrow(/not ready/i)
    await expect(fresh.revokeDevice('x')).rejects.toThrow(/not ready/i)
  }, 60000)

  it('设备列表与撤销经管理面可见（真实配对 + 上游 revoke）', async () => {
    const options = testOptions({ databaseFile: databaseIn('mgr-devices') })
    const manager = createRuntimeManager({
      ...createManagerDependencies(options, () => {}),
      resolvePairingHost: () => '127.0.0.1'
    })
    const status = await manager.startSyncServer()
    try {
      expect(status.serverCertificatePem).toMatch(/BEGIN CERTIFICATE/)
      const client = createClient(status.port!, status.serverCertificatePem!)
      const qr = parsePairingUri((await manager.pairingCode()).content)
      expect((await client.pair('phone_mgr', qr.token)).status).toBe(200)
      expect((await manager.listPairedDevices()).map((device) => device.deviceId)).toContain(
        'phone_mgr'
      )
      expect(
        (await manager.revokeDevice('phone_mgr')).map((device) => device.deviceId)
      ).not.toContain('phone_mgr')
      expect(manager.syncStatus().pairedDeviceCount).toBe(0)
      await expect(manager.revokeDevice('never_paired')).rejects.toThrow(/not found/i)
    } finally {
      await manager.stopSyncServer()
      await manager.stop()
    }
  }, 60000)
})
