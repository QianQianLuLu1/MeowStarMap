import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { AuthService } from '../auth-service'
import { PairingError } from '../pairing-service'
import type { SyncLogger } from '../identity-service'
import {
  createApiRequestHandler,
  METADATA_ALLOWED_KEYS,
  SEARCH_QUERY_MAX_LENGTH
} from './api-router'
import type { SyncApiServices } from './types'

/**
 * API 路由层单元测试：mock req/res + 真实 AuthService（Ed25519 现场签名）。
 * 端到端（真 TLS/WS/流式）覆盖见 sync-server.integration.test.ts。
 */

const NOW = 1_700_000_000_000
const DEVICE_ID = 'android_router000000000000000000'

const deviceKeys = generateKeyPairSync('ed25519')
const DEVICE_PRIVATE_PEM = deviceKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const DEVICE_PUBLIC_B64URL = deviceKeys.publicKey
  .export({ type: 'spki', format: 'der' })
  .toString('base64url')

function signedHeaders(
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
    'x-nikkisync-device-id': DEVICE_ID,
    'x-nikkisync-timestamp': timestamp,
    'x-nikkisync-nonce': nonce,
    'x-nikkisync-signature': sign(
      null,
      Buffer.from(canonical, 'utf8'),
      DEVICE_PRIVATE_PEM
    ).toString('base64url')
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
}

function mockRes(): { res: ServerResponse; state: RecordedResponse } {
  const state: RecordedResponse = { status: 0, headers: {}, text: '' }
  const res = {
    headersSent: false,
    destroyed: false,
    writeHead(status: number, headers?: Record<string, unknown>) {
      state.status = status
      state.headers = headers ?? {}
      ;(res as { headersSent: boolean }).headersSent = true
    },
    end(data?: Buffer | string) {
      if (data) state.text = typeof data === 'string' ? data : data.toString('utf8')
    }
  }
  return { res: res as unknown as ServerResponse, state }
}

const logger: SyncLogger = { info: vi.fn(), warn: vi.fn() }

function createServices(overrides: Partial<SyncApiServices> = {}): SyncApiServices {
  const auth = new AuthService(
    {
      getDevice: (deviceId) =>
        deviceId === DEVICE_ID
          ? {
              device_id: DEVICE_ID,
              device_name: 'Router Test Phone',
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
      serverId: 'wxnn-test',
      name: 'WXNN XiangCe',
      libraryRevision: 7,
      capabilities: {
        websocketEvents: true,
        rangeRequests: true,
        metadataV1: true,
        motionAssets: true
      }
    }),
    getServerIdentity: async () => ({ serverId: 'wxnn-test', serverName: 'WXNN XiangCe' }),
    getCurrentRevision: () => 7,
    listAssets: () => ({ items: [], libraryRevision: 7 }),
    getAssetDetail: async () => null,
    getResourceLocation: async () => null,
    getChanges: async () => ({ changes: [], libraryRevision: 7, fullResyncRequired: false }),
    verifyRequest: (input) => auth.verifyRequest(input),
    redeemToken: async () => {
      throw new PairingError('pairing_invalid')
    },
    ...overrides
  }
}

async function call(
  services: SyncApiServices,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const handler = createApiRequestHandler({
    services,
    config: { maxJsonBodyBytes: 1024 * 1024 },
    logger
  })
  await handler(req, res)
}

function parseJson(state: RecordedResponse): unknown {
  return JSON.parse(state.text) as unknown
}

describe('api-router', () => {
  it('serves GET /v1/server without authentication', async () => {
    const { res, state } = mockRes()
    await call(createServices(), mockReq('GET', '/v1/server'), res)
    expect(state.status).toBe(200)
    expect(state.headers['Content-Type']).toBe('application/json; charset=utf-8')
    expect(state.headers['Cache-Control']).toBe('no-store')
    expect(parseJson(state)).toMatchObject({ protocolVersion: 1, serverId: 'wxnn-test' })
  })

  it('returns 401 with ApiErrorBody for unsigned authenticated routes', async () => {
    const { res, state } = mockRes()
    await call(createServices(), mockReq('GET', '/v1/assets'), res)
    expect(state.status).toBe(401)
    expect(parseJson(state)).toMatchObject({ error: { code: 'unauthorized' } })
  })

  it('accepts a valid signature on GET /v1/assets', async () => {
    const { res, state } = mockRes()
    await call(
      createServices(),
      mockReq('GET', '/v1/assets', signedHeaders('GET', '/v1/assets')),
      res
    )
    expect(state.status).toBe(200)
    expect(parseJson(state)).toMatchObject({ items: [], libraryRevision: 7 })
  })

  it('validates the assets query after authentication', async () => {
    const services = createServices()
    const cases: Array<[string, string]> = [
      ['/v1/assets?limit=0', 'limit must be 1..500'],
      ['/v1/assets?limit=501', 'limit must be 1..500'],
      ['/v1/assets?limit=abc', 'limit must be 1..500'],
      ['/v1/assets?cursor=!!!', 'cursor is invalid'],
      ['/v1/assets?type=dll', 'type is invalid'],
      ['/v1/assets?afterRevision=-1', 'afterRevision is invalid'],
      ['/v1/assets?afterRevision=x', 'afterRevision is invalid']
    ]
    for (const [target, message] of cases) {
      const { res, state } = mockRes()
      await call(services, mockReq('GET', target, signedHeaders('GET', target)), res)
      expect(state.status, target).toBe(400)
      expect(parseJson(state), target).toMatchObject({ error: { code: 'bad_request', message } })
    }
  })

  it('accepts a well-formed cursor', async () => {
    const { res, state } = mockRes()
    const cursor = Buffer.from(JSON.stringify({ t: '2026-01-01T00:00:00.000Z', id: 3 })).toString(
      'base64url'
    )
    const target = `/v1/assets?cursor=${cursor}&limit=10`
    await call(createServices(), mockReq('GET', target, signedHeaders('GET', target)), res)
    expect(state.status).toBe(200)
  })

  it('serves GET /v1/changes and validates the after parameter', async () => {
    const { res, state } = mockRes()
    await call(
      createServices(),
      mockReq('GET', '/v1/changes', signedHeaders('GET', '/v1/changes')),
      res
    )
    expect(state.status).toBe(400)
    expect(parseJson(state)).toMatchObject({ error: { message: 'after revision is required' } })

    const ok = mockRes()
    await call(
      createServices(),
      mockReq('GET', '/v1/changes?after=0', signedHeaders('GET', '/v1/changes?after=0')),
      ok.res
    )
    expect(ok.state.status).toBe(200)
  })

  it('returns 404 for unknown routes and wrong methods', async () => {
    const services = createServices()
    const { res, state } = mockRes()
    await call(services, mockReq('GET', '/v1/unknown', signedHeaders('GET', '/v1/unknown')), res)
    expect(state.status).toBe(404)
    expect(parseJson(state)).toMatchObject({
      error: { code: 'not_found', message: 'Route not found' }
    })

    const post = mockRes()
    await call(
      services,
      mockReq('POST', '/v1/assets', signedHeaders('POST', '/v1/assets')),
      post.res
    )
    expect(post.state.status).toBe(404)
  })

  it('defers the export extension endpoint with 404', async () => {
    const { res, state } = mockRes()
    const target = '/v1/assets/1/resources/res_1_primary/export?exif=true&rotation=0'
    await call(createServices(), mockReq('GET', target, signedHeaders('GET', target)), res)
    expect(state.status).toBe(404)
    expect(parseJson(state)).toMatchObject({ error: { code: 'not_found' } })
  })

  it('stubs clothing thumbnails with 404 resource_not_ready', async () => {
    const { res, state } = mockRes()
    const target = '/v1/assets/1/clothing/cl_01/thumbnail'
    await call(createServices(), mockReq('GET', target, signedHeaders('GET', target)), res)
    expect(state.status).toBe(404)
    expect(parseJson(state)).toMatchObject({
      error: { code: 'resource_not_ready', message: 'Clothing thumbnail is unavailable' }
    })
  })

  it('stubs search endpoints with protocol-shaped empty results and validates q', async () => {
    const services = createServices()
    const missing = mockRes()
    await call(
      services,
      mockReq('GET', '/v1/search/suits', signedHeaders('GET', '/v1/search/suits')),
      missing.res
    )
    expect(missing.state.status).toBe(400)
    expect(parseJson(missing.state)).toMatchObject({ error: { message: 'q is required' } })

    const tooLong = mockRes()
    const longQuery = 'a'.repeat(SEARCH_QUERY_MAX_LENGTH + 1)
    const longTarget = `/v1/search/clothing?q=${longQuery}`
    await call(services, mockReq('GET', longTarget, signedHeaders('GET', longTarget)), tooLong.res)
    expect(tooLong.state.status).toBe(400)
    expect(parseJson(tooLong.state)).toMatchObject({ error: { message: 'q is too long' } })

    const suits = mockRes()
    const suitsTarget = '/v1/search/suits?q=blue'
    await call(services, mockReq('GET', suitsTarget, signedHeaders('GET', suitsTarget)), suits.res)
    expect(suits.state.status).toBe(200)
    expect(parseJson(suits.state)).toEqual({ query: 'blue', items: [] })

    const stats = mockRes()
    await call(
      services,
      mockReq('GET', '/v1/profile/stats', signedHeaders('GET', '/v1/profile/stats')),
      stats.res
    )
    expect(stats.state.status).toBe(200)
    expect(parseJson(stats.state)).toEqual({ libraryRevision: 7, topSuits: [], topClothing: [] })
  })

  it('handles POST /v1/pair body validation and PairingError mapping', async () => {
    const services = createServices()
    const notJson = mockRes()
    await call(
      services,
      mockReq('POST', '/v1/pair', {}, Buffer.from('not-json', 'utf8')),
      notJson.res
    )
    expect(notJson.state.status).toBe(400)
    expect(parseJson(notJson.state)).toMatchObject({
      error: { code: 'bad_request', message: 'Pair request must be valid JSON' }
    })

    const missingFields = mockRes()
    await call(
      services,
      mockReq('POST', '/v1/pair', {}, Buffer.from('{"pairingToken":"t"}', 'utf8')),
      missingFields.res
    )
    expect(missingFields.state.status).toBe(400)
    expect(parseJson(missingFields.state)).toMatchObject({
      error: { message: 'Pair request is missing required fields' }
    })

    const invalid = mockRes()
    const invalidBody = JSON.stringify({
      pairingToken: 't',
      device: {
        deviceId: 'd',
        deviceName: 'n',
        platform: 'android',
        publicKey: 'k',
        appVersion: '1'
      }
    })
    await call(
      services,
      mockReq('POST', '/v1/pair', {}, Buffer.from(invalidBody, 'utf8')),
      invalid.res
    )
    expect(invalid.state.status).toBe(401)
    expect(parseJson(invalid.state)).toMatchObject({ error: { code: 'pairing_invalid' } })

    const expired = mockRes()
    await call(
      createServices({
        redeemToken: async () => {
          throw new PairingError('pairing_expired')
        }
      }),
      mockReq('POST', '/v1/pair', {}, Buffer.from(invalidBody, 'utf8')),
      expired.res
    )
    expect(expired.state.status).toBe(410)
    expect(parseJson(expired.state)).toMatchObject({ error: { code: 'pairing_expired' } })

    const badRequest = mockRes()
    await call(
      createServices({
        redeemToken: async () => {
          throw new PairingError('bad_request')
        }
      }),
      mockReq('POST', '/v1/pair', {}, Buffer.from(invalidBody, 'utf8')),
      badRequest.res
    )
    expect(badRequest.state.status).toBe(400)
    expect(parseJson(badRequest.state)).toMatchObject({ error: { code: 'bad_request' } })
  })

  it('rejects oversized request bodies with 400', async () => {
    const { res, state } = mockRes()
    const handler = createApiRequestHandler({
      services: createServices(),
      config: { maxJsonBodyBytes: 8 }
    })
    await handler(mockReq('POST', '/v1/pair', {}, Buffer.alloc(32)), res)
    expect(state.status).toBe(400)
    expect(parseJson(state)).toMatchObject({ error: { message: 'request body too large' } })
  })

  describe('PATCH /v1/assets/{id}/metadata', () => {
    const path = '/v1/assets/42/metadata'

    it('requires the signature to cover the body', async () => {
      const { res, state } = mockRes()
      const services = createServices({
        getAssetDetail: async () => ({ asset: minimalAsset() })
      })
      await call(
        services,
        mockReq('PATCH', path, signedHeaders('PATCH', path, Buffer.from('{}')), Buffer.from('{}')),
        res
      )
      expect(state.status).toBe(200)

      const unsigned = mockRes()
      await call(services, mockReq('PATCH', path, {}, Buffer.from('{}')), unsigned.res)
      expect(unsigned.state.status).toBe(401)
    })

    it('returns 404 for unknown or malformed asset ids', async () => {
      const services = createServices()
      const missing = mockRes()
      await call(
        services,
        mockReq('PATCH', path, signedHeaders('PATCH', path, Buffer.from('{}')), Buffer.from('{}')),
        missing.res
      )
      expect(missing.state.status).toBe(404)
      expect(parseJson(missing.state)).toMatchObject({
        error: { code: 'not_found', message: 'Asset not found' }
      })

      const malformed = mockRes()
      const badPath = '/v1/assets/abc/metadata'
      await call(
        services,
        mockReq(
          'PATCH',
          badPath,
          signedHeaders('PATCH', badPath, Buffer.from('{}')),
          Buffer.from('{}')
        ),
        malformed.res
      )
      expect(malformed.state.status).toBe(404)
    })

    it('rejects non-JSON and non-object bodies', async () => {
      const services = createServices({
        getAssetDetail: async () => ({ asset: minimalAsset() })
      })
      const notJson = mockRes()
      await call(
        services,
        mockReq(
          'PATCH',
          path,
          signedHeaders('PATCH', path, Buffer.from('nope')),
          Buffer.from('nope')
        ),
        notJson.res
      )
      expect(notJson.state.status).toBe(400)
      expect(parseJson(notJson.state)).toMatchObject({
        error: { message: 'Metadata patch must be valid JSON' }
      })

      const notObject = mockRes()
      const arrayBody = '[]'
      await call(
        services,
        mockReq(
          'PATCH',
          path,
          signedHeaders('PATCH', path, Buffer.from(arrayBody)),
          Buffer.from(arrayBody)
        ),
        notObject.res
      )
      expect(notObject.state.status).toBe(400)
      expect(parseJson(notObject.state)).toMatchObject({
        error: { message: 'Metadata patch must be a JSON object' }
      })
    })

    it('treats every metadata field as read-only in WXNN v1', async () => {
      const services = createServices({
        getAssetDetail: async () => ({ asset: minimalAsset() })
      })
      for (const key of ['capture', 'camera', 'unknownField']) {
        const { res, state } = mockRes()
        const body = JSON.stringify({ [key]: {} })
        await call(
          services,
          mockReq(
            'PATCH',
            path,
            signedHeaders('PATCH', path, Buffer.from(body)),
            Buffer.from(body)
          ),
          res
        )
        expect(state.status, key).toBe(400)
        expect(parseJson(state), key).toMatchObject({
          error: {
            code: 'bad_request',
            message: `Metadata field is read-only or unsupported: ${key}`
          }
        })
      }
      expect(METADATA_ALLOWED_KEYS.has('capture')).toBe(true)
      expect(METADATA_ALLOWED_KEYS.has('location')).toBe(true)
    })

    it('returns the detail with the current revision for an empty patch', async () => {
      const { res, state } = mockRes()
      const services = createServices({
        getAssetDetail: async () => ({ asset: minimalAsset() })
      })
      await call(
        services,
        mockReq('PATCH', path, signedHeaders('PATCH', path, Buffer.from('{}')), Buffer.from('{}')),
        res
      )
      expect(state.status).toBe(200)
      const body = parseJson(state) as { revision: number; asset: { assetId: string } }
      expect(body.revision).toBe(7)
      expect(body.asset.assetId).toBe('42')
    })
  })
})

function minimalAsset() {
  return {
    schemaVersion: 1 as const,
    assetId: '42',
    type: 'photo' as const,
    state: 'ready' as const,
    source: { game: 'infinity_nikki' as const, discoveredAt: new Date(NOW).toISOString() },
    resources: [],
    revision: 7
  }
}
