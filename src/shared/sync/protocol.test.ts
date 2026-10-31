import { describe, it, expect } from 'vitest'
import {
  PROTOCOL_VERSION,
  API_ROUTES,
  API_ERROR_CODES,
  CHANGE_TYPES,
  ASSET_TYPES,
  ASSET_STATES,
  RESOURCE_ROLES,
  METADATA_SCHEMA_VERSION,
  buildAssetsRoute,
  buildChangesRoute,
  buildPairingUri,
  buildSuitSearchRoute,
  buildClothingSearchRoute,
  isProtocolVersionSupported,
  isAssetType,
  isResourceRole,
  type AssetSummary,
  type NikkiAsset
} from './protocol'
import {
  ASSET_TYPES as CORE_ASSET_TYPES,
  RESOURCE_ROLES as CORE_RESOURCE_ROLES,
  ASSET_STATES as CORE_ASSET_STATES,
  METADATA_SCHEMA_VERSION as CORE_METADATA_SCHEMA_VERSION
} from './domain-types'

/**
 * NikkiSync Protocol v1 移植验收测试
 *
 * 硬约束：协议字段名、路由常量、错误码与上游 NikkiSync 逐字一致（客户端兼容性）。
 * 上游来源：NikkiSync/packages/protocol/src/index.ts、packages/core/src/types.ts（commit 284d4a6）。
 */
describe('sync/protocol（NikkiSync Protocol v1 移植）', () => {
  describe('协议版本', () => {
    it('T1 版本冻结在 v1', () => {
      expect(PROTOCOL_VERSION).toBe(1)
      expect(isProtocolVersionSupported(1)).toBe(true)
    })

    it('T7 版本守卫拒绝非 1 值', () => {
      expect(isProtocolVersionSupported(2)).toBe(false)
      expect(isProtocolVersionSupported('1')).toBe(false)
      expect(isProtocolVersionSupported(null)).toBe(false)
      expect(isProtocolVersionSupported(undefined)).toBe(false)
    })
  })

  describe('常量表逐字一致', () => {
    it('T2 ASSET_TYPES 与上游逐字一致', () => {
      expect([...ASSET_TYPES]).toEqual(['photo', 'motion_photo', 'video', 'unknown'])
    })

    it('T2 RESOURCE_ROLES 与上游逐字一致', () => {
      expect([...RESOURCE_ROLES]).toEqual([
        'source_primary',
        'source_high_quality',
        'source_low_quality',
        'source_motion',
        'derived_thumbnail',
        'derived_preview'
      ])
    })

    it('T2 ASSET_STATES 与上游逐字一致', () => {
      expect([...ASSET_STATES]).toEqual(['ready', 'resolving', 'missing', 'deleted'])
    })

    it('T2 CHANGE_TYPES 与上游逐字一致', () => {
      expect([...CHANGE_TYPES]).toEqual(['asset.created', 'asset.updated', 'asset.deleted'])
    })

    it('T2 API_ERROR_CODES 与上游逐字一致（9 个错误码）', () => {
      expect([...API_ERROR_CODES]).toEqual([
        'bad_request',
        'unauthorized',
        'pairing_expired',
        'pairing_invalid',
        'not_found',
        'revision_too_old',
        'protocol_mismatch',
        'resource_not_ready',
        'internal_error'
      ])
    })

    it('T2 METADATA_SCHEMA_VERSION 为 1', () => {
      expect(METADATA_SCHEMA_VERSION).toBe(1)
    })

    it('协议常量与 domain-types 为同一引用（re-export 契约）', () => {
      expect(ASSET_TYPES).toBe(CORE_ASSET_TYPES)
      expect(RESOURCE_ROLES).toBe(CORE_RESOURCE_ROLES)
      expect(ASSET_STATES).toBe(CORE_ASSET_STATES)
      expect(METADATA_SCHEMA_VERSION).toBe(CORE_METADATA_SCHEMA_VERSION)
    })
  })

  describe('API_ROUTES 路由常量', () => {
    it('T3 静态路由与上游逐字一致', () => {
      expect(API_ROUTES.serverInfo).toBe('/v1/server')
      expect(API_ROUTES.pair).toBe('/v1/pair')
      expect(API_ROUTES.assets).toBe('/v1/assets')
      expect(API_ROUTES.suitSearch).toBe('/v1/search/suits')
      expect(API_ROUTES.clothingSearch).toBe('/v1/search/clothing')
      expect(API_ROUTES.profileStats).toBe('/v1/profile/stats')
      expect(API_ROUTES.changes).toBe('/v1/changes')
      expect(API_ROUTES.websocket).toBe('/ws/v1')
    })

    it('T3 函数路由正常值', () => {
      expect(API_ROUTES.asset('asset_1')).toBe('/v1/assets/asset_1')
      expect(API_ROUTES.metadata('asset_1')).toBe('/v1/assets/asset_1/metadata')
      expect(API_ROUTES.resource('asset_1', 'res_1')).toBe('/v1/assets/asset_1/resources/res_1')
      expect(API_ROUTES.clothingThumbnail('asset_1', '1020810145')).toBe(
        '/v1/assets/asset_1/clothing/1020810145/thumbnail'
      )
    })
  })

  describe('路由构建函数', () => {
    it('T9 函数路由对特殊字符做 URL 编码（上游用例移植）', () => {
      expect(API_ROUTES.asset('asset/a')).toBe('/v1/assets/asset%2Fa')
      expect(API_ROUTES.resource('asset/a', 'resource b')).toBe(
        '/v1/assets/asset%2Fa/resources/resource%20b'
      )
      expect(API_ROUTES.metadata('asset?1')).toBe('/v1/assets/asset%3F1/metadata')
      expect(API_ROUTES.clothingThumbnail('asset/a', 'c d')).toBe(
        '/v1/assets/asset%2Fa/clothing/c%20d/thumbnail'
      )
    })

    it('T4 buildAssetsRoute 全参', () => {
      expect(
        buildAssetsRoute({ cursor: 'a/b', limit: 25, type: 'motion_photo', includeDeleted: true })
      ).toBe('/v1/assets?cursor=a%2Fb&limit=25&type=motion_photo&includeDeleted=true')
    })

    it('T10 buildAssetsRoute 无参与空对象等价', () => {
      expect(buildAssetsRoute()).toBe('/v1/assets')
      expect(buildAssetsRoute({})).toBe('/v1/assets')
    })

    it('T10 buildAssetsRoute 部分参数', () => {
      expect(buildAssetsRoute({ limit: 0 })).toBe('/v1/assets?limit=0')
      expect(buildAssetsRoute({ afterRevision: 7 })).toBe('/v1/assets?afterRevision=7')
      expect(buildAssetsRoute({ cursor: 'c1' })).toBe('/v1/assets?cursor=c1')
      expect(buildAssetsRoute({ includeDeleted: false })).toBe('/v1/assets?includeDeleted=false')
    })

    it('T4 buildChangesRoute', () => {
      expect(buildChangesRoute(42)).toBe('/v1/changes?after=42')
    })

    it('T4 搜索路由 q 参数编码', () => {
      expect(buildSuitSearchRoute('white dress')).toBe('/v1/search/suits?q=white%20dress')
      expect(buildClothingSearchRoute('a&b=c')).toBe('/v1/search/clothing?q=a%26b%3Dc')
    })
  })

  describe('buildPairingUri', () => {
    const basePayload = {
      scheme: 'nikki-sync' as const,
      action: 'pair' as const,
      serverId: 'server_1',
      host: '192.168.1.5',
      port: 4242,
      pairingToken: 'abc-_123',
      protocolVersion: 1 as const,
      expiresAt: '2026-09-02T14:30:00.000Z',
      tlsFingerprintSha256: '00'.repeat(32)
    }

    it('T5 紧凑、稳定、自包含（上游用例移植）', () => {
      const uri = buildPairingUri(basePayload)
      expect(uri.startsWith('NS1|server_1|192.168.1.5|4242|abc-_123|')).toBe(true)
      expect(uri.endsWith(`|${'00'.repeat(32)}`)).toBe(true)
      expect(uri.split('|').length).toBe(7)
    })

    it('T10 expiresAt 转换为 epoch 秒且不含 scheme/action/protocolVersion 字段', () => {
      const uri = buildPairingUri(basePayload)
      const segments = uri.split('|')
      expect(segments[5]).toBe(String(Math.floor(Date.parse('2026-09-02T14:30:00.000Z') / 1000)))
      expect(segments).not.toContain('pair')
      expect(segments).not.toContain('nikki-sync')
    })

    it('T9 特殊字符 token 原样透传（不做 URL 编码）', () => {
      const uri = buildPairingUri({ ...basePayload, pairingToken: 'a|b&c=d e' })
      // URI 以 | 分段，token 中的 | 会改变段数——与上游行为一致，原样透传
      expect(uri).toContain('|a|b&c=d e|')
    })
  })

  describe('buildPairingUri 多 host 分支（兼容层：对齐上游 b422193）', () => {
    const base = {
      scheme: 'nikki-sync' as const,
      action: 'pair' as const,
      serverId: 'server_1',
      host: '192.168.1.5',
      port: 4242,
      pairingToken: 'abc-_123',
      protocolVersion: 1 as const,
      expiresAt: '2026-09-02T14:30:00.000Z',
      tlsFingerprintSha256: '00'.repeat(32)
    }

    it('双 host：输出 nikkisync://pair? 查询串，hosts 为去重后含 host 的逗号串', () => {
      const uri = buildPairingUri({ ...base, hosts: ['192.168.1.6', '10.0.0.3'] })
      expect(uri.startsWith('nikki-sync://pair?')).toBe(true)
      const query = new URLSearchParams(uri.slice('nikki-sync://pair?'.length))
      expect(query.get('hosts')).toBe('192.168.1.5,192.168.1.6,10.0.0.3')
    })

    it('query 携带 serverId/host/port/token/protocol/expiresAt/tls，protocolVersion 为数值串', () => {
      const uri = buildPairingUri({ ...base, hosts: ['192.168.1.6'] })
      const query = new URLSearchParams(uri.slice('nikki-sync://pair?'.length))
      expect(query.get('serverId')).toBe('server_1')
      expect(query.get('host')).toBe('192.168.1.5')
      expect(query.get('port')).toBe('4242')
      expect(query.get('token')).toBe('abc-_123')
      expect(query.get('protocol')).toBe('1')
      expect(query.get('expiresAt')).toBe('2026-09-02T14:30:00.000Z')
      expect(query.get('tls')).toBe('00'.repeat(32))
    })

    it('hosts 去重：重复项（含与 host 相同的项）折叠', () => {
      const uri = buildPairingUri({
        ...base,
        hosts: ['192.168.1.5', '192.168.1.6', '192.168.1.6']
      })
      const query = new URLSearchParams(uri.slice('nikki-sync://pair?'.length))
      expect(query.get('hosts')).toBe('192.168.1.5,192.168.1.6')
    })

    it('hosts 超上限：去重后截断至 8 项（host 占首位）', () => {
      const uri = buildPairingUri({
        ...base,
        hosts: [
          '10.0.0.2',
          '10.0.0.3',
          '10.0.0.4',
          '10.0.0.5',
          '10.0.0.6',
          '10.0.0.7',
          '10.0.0.8',
          '10.0.0.9',
          '10.0.0.10'
        ]
      })
      const query = new URLSearchParams(uri.slice('nikki-sync://pair?'.length))
      expect(query.get('hosts')).toBe(
        '192.168.1.5,10.0.0.2,10.0.0.3,10.0.0.4,10.0.0.5,10.0.0.6,10.0.0.7,10.0.0.8'
      )
    })

    it('边界：hosts 去重后仅剩 host 自身 → 逐字节保留 NS1 七段（单 host 回归锚）', () => {
      const uri = buildPairingUri({ ...base, hosts: ['192.168.1.5'] })
      expect(uri.startsWith('NS1|server_1|192.168.1.5|4242|abc-_123|')).toBe(true)
      expect(uri.split('|').length).toBe(7)
      expect(uri).not.toContain('nikki-sync://')
    })
  })

  describe('type guard', () => {
    it('T8 isAssetType 拒绝非法值', () => {
      expect(isAssetType('photo')).toBe(true)
      expect(isAssetType('motion_photo')).toBe(true)
      expect(isAssetType('movie')).toBe(false)
      expect(isAssetType(1)).toBe(false)
      expect(isAssetType(null)).toBe(false)
    })

    it('T8 isResourceRole 拒绝非法值', () => {
      expect(isResourceRole('source_primary')).toBe(true)
      expect(isResourceRole('derived_thumbnail')).toBe(true)
      expect(isResourceRole('source')).toBe(false)
      expect(isResourceRole(undefined)).toBe(false)
    })
  })

  describe('协议对象形状', () => {
    it('T6 AssetSummary 支持游戏版本附加字段（上游用例移植）', () => {
      const summary: AssetSummary = {
        assetId: 'asset_29',
        type: 'photo',
        state: 'ready',
        revision: 1,
        hasMotion: false,
        hasMetadata: true,
        gameVersion: '2.9',
        gameVersionSource: 'explicit',
        thumbnailSha256: 'a'.repeat(64),
        previewSha256: 'b'.repeat(64),
        fullPreviewResourceId: '7/100',
        fullPreviewSha256: 'c'.repeat(64),
        mediaFingerprint: 'd'.repeat(64),
        sourcePath: 'D:/Game/X6Game/Saved/GamePlayPhotos/10001/Photo_1.jpg',
        sourceFolder: 'D:/Game/X6Game/Saved/GamePlayPhotos/10001',
        sizeBytes: 1024
      }
      expect(summary.gameVersion).toBe('2.9')
      expect(summary.gameVersionSource).toBe('explicit')
      expect(summary.sourceFolder).toBe('D:/Game/X6Game/Saved/GamePlayPhotos/10001')
      expect(summary.sizeBytes).toBe(1024)
    })

    it('T6 NikkiAsset 最小合法对象可构造', () => {
      const asset: NikkiAsset = {
        schemaVersion: 1,
        assetId: 'asset_1',
        type: 'photo',
        state: 'ready',
        source: {
          game: 'infinity_nikki',
          discoveredAt: '2026-10-11T00:00:00.000Z'
        },
        resources: [],
        revision: 1
      }
      expect(asset.source.game).toBe('infinity_nikki')
      expect(asset.resources).toEqual([])
    })
  })
})
