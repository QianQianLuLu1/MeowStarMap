import { describe, expect, it } from 'vitest'

import {
  CONTRACT_ROUTE_KEYS,
  VENDORED_CONTRACT_SYMBOLS,
  collectVendoredContract,
  diffProtocolContract,
  upstreamSnapshotFromModules
} from './protocol-contract'
import {
  API_ERROR_CODES,
  API_ROUTES,
  ASSET_STATES,
  ASSET_TYPES,
  CHANGE_TYPES,
  METADATA_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  RESOURCE_ROLES
} from '../../shared/sync/protocol'

/**
 * 协议契约漂移守护的纯函数单测（阶段 9 · 问题 4）。
 *
 * 决策口径：`src/shared/sync/protocol.ts` 是 XiangCe 侧协议契约的唯一真相源，
 * `@nikkisync/protocol` 不再是契约来源，只作为"链接态漂移比对对象"。
 * 本文件在 CI（未链接）下同样必跑，因此只用夹具上游；真实上游由
 * `protocol-drift.test.ts` 在链接就绪时喂入同一套纯函数。
 *
 *   正常 — 上游快照与 vendored 全等 → 无差异；vendored 快照逐项符合冻结值
 *   异常 — 路由值漂移 / 错误码数组不等 / 上游整体缺失 → 精确差异条目
 *   边界 — 上游多出导出记为 extra、数组顺序参与比较、函数路由按同一采样键编码
 */

/** 与 vendored 完全一致的"上游"模块面（上游 protocol 会 re-export core 常量）。 */
function makeAlignedUpstreamModules(): Record<string, unknown> {
  return {
    PROTOCOL_VERSION,
    METADATA_SCHEMA_VERSION,
    ASSET_TYPES,
    ASSET_STATES,
    RESOURCE_ROLES,
    CHANGE_TYPES,
    API_ERROR_CODES,
    API_ROUTES
  }
}

describe('collectVendoredContract', () => {
  it('正常：快照键集与符号清单一致，冻结标量与数组逐项可判', () => {
    const snapshot = collectVendoredContract()
    expect(Object.keys(snapshot).sort()).toEqual([...VENDORED_CONTRACT_SYMBOLS].sort())
    expect(snapshot.PROTOCOL_VERSION).toBe(PROTOCOL_VERSION)
    expect(snapshot.METADATA_SCHEMA_VERSION).toBe(METADATA_SCHEMA_VERSION)
    expect(snapshot.CHANGE_TYPES).toEqual([...CHANGE_TYPES])
    expect(snapshot.API_ERROR_CODES).toEqual([...API_ERROR_CODES])
    expect(snapshot.ASSET_TYPES).toEqual([...ASSET_TYPES])
    expect(snapshot.ASSET_STATES).toEqual([...ASSET_STATES])
    expect(snapshot.RESOURCE_ROLES).toEqual([...RESOURCE_ROLES])
  })

  it('正常：API_ROUTES 全部 12 个键都进入快照（字面量键取原值）', () => {
    const snapshot = collectVendoredContract()
    expect(Object.keys(API_ROUTES)).toHaveLength(12)
    expect(snapshot['API_ROUTES.serverInfo']).toBe('/v1/server')
    expect(snapshot['API_ROUTES.pair']).toBe('/v1/pair')
    expect(snapshot['API_ROUTES.assets']).toBe('/v1/assets')
    expect(snapshot['API_ROUTES.suitSearch']).toBe('/v1/search/suits')
    expect(snapshot['API_ROUTES.clothingSearch']).toBe('/v1/search/clothing')
    expect(snapshot['API_ROUTES.profileStats']).toBe('/v1/profile/stats')
    expect(snapshot['API_ROUTES.changes']).toBe('/v1/changes')
    expect(snapshot['API_ROUTES.websocket']).toBe('/ws/v1')
  })

  it('边界：函数路由按固定采样键编码后进入快照（漂移可判而非跳过）', () => {
    const snapshot = collectVendoredContract()
    expect(snapshot[CONTRACT_ROUTE_KEYS.asset]).toBe(API_ROUTES.asset('7/1'))
    expect(snapshot[CONTRACT_ROUTE_KEYS.asset]).toBe('/v1/assets/7%2F1')
    expect(snapshot[CONTRACT_ROUTE_KEYS.metadata]).toBe(API_ROUTES.metadata('7/1'))
    expect(snapshot[CONTRACT_ROUTE_KEYS.resource]).toBe(API_ROUTES.resource('7/1', 'res 1'))
    expect(snapshot[CONTRACT_ROUTE_KEYS.clothingThumbnail]).toBe(
      API_ROUTES.clothingThumbnail('7/1', 'c 1')
    )
  })
})

describe('upstreamSnapshotFromModules', () => {
  it('正常：与 vendored 全等的上游 → 差异为空', () => {
    const upstream = upstreamSnapshotFromModules(makeAlignedUpstreamModules())
    expect(diffProtocolContract(collectVendoredContract(), upstream)).toEqual([])
  })

  it('边界：protocol 优先、core 回落；protocol 缺的键不得由 core 伪造', () => {
    const upstream = upstreamSnapshotFromModules(
      { PROTOCOL_VERSION: 1, API_ROUTES: { serverInfo: '/v1/server' } },
      { ASSET_TYPES: ['photo', 'motion_photo', 'video', 'unknown'] }
    )
    expect(upstream.PROTOCOL_VERSION).toBe(1)
    expect(upstream.ASSET_TYPES).toEqual(['photo', 'motion_photo', 'video', 'unknown'])
    expect('API_ROUTES.pair' in upstream).toBe(false)
    expect(upstream['API_ROUTES.serverInfo']).toBe('/v1/server')
  })

  it('异常：入参非对象（null/undefined）时给出空快照，交由 diff 逐键报 missing', () => {
    expect(upstreamSnapshotFromModules(null)).toEqual({})
    expect(upstreamSnapshotFromModules(undefined)).toEqual({})
  })
})

describe('diffProtocolContract', () => {
  it('异常：单个路由值漂移时给出两侧值的精确条目', () => {
    const upstream = upstreamSnapshotFromModules({
      ...makeAlignedUpstreamModules(),
      API_ROUTES: { ...API_ROUTES, pair: '/v2/pair' }
    })
    expect(diffProtocolContract(collectVendoredContract(), upstream)).toEqual([
      'drift: API_ROUTES.pair vendored=/v1/pair upstream=/v2/pair'
    ])
  })

  it('异常：错误码数组少一项时给出序列化差异', () => {
    const upstream = upstreamSnapshotFromModules({
      ...makeAlignedUpstreamModules(),
      API_ERROR_CODES: API_ERROR_CODES.slice(0, API_ERROR_CODES.length - 1)
    })
    const differences = diffProtocolContract(collectVendoredContract(), upstream)
    expect(differences).toHaveLength(1)
    expect(differences[0]).toMatch(/^drift: API_ERROR_CODES vendored=\[.*\] upstream=\[.*\]$/)
  })

  it('异常：错误码顺序漂移同样判差异（顺序也是契约的一部分）', () => {
    const upstream = upstreamSnapshotFromModules({
      ...makeAlignedUpstreamModules(),
      API_ERROR_CODES: [...API_ERROR_CODES].reverse()
    })
    const differences = diffProtocolContract(collectVendoredContract(), upstream)
    expect(differences).toHaveLength(1)
    expect(differences[0]?.startsWith('drift: API_ERROR_CODES ')).toBe(true)
  })

  it('异常：上游快照为空时每个 vendored 键都记 missing', () => {
    const vendored = collectVendoredContract()
    const differences = diffProtocolContract(vendored, {})
    expect(differences).toHaveLength(Object.keys(vendored).length)
    expect(differences.every((line) => line.startsWith('missing: '))).toBe(true)
    expect(differences.some((line) => line.includes('PROTOCOL_VERSION'))).toBe(true)
  })

  it('边界：上游多出的导出记为 extra（提示需评审是否补移植）', () => {
    const upstream = upstreamSnapshotFromModules({
      ...makeAlignedUpstreamModules(),
      API_ROUTES: { ...API_ROUTES, health: '/v1/health' }
    })
    expect(diffProtocolContract(collectVendoredContract(), upstream)).toEqual([
      'extra: API_ROUTES.health upstream=/v1/health'
    ])
  })

  it('边界：不可比的取值（对象等非标量/非数组）序列化为类型名后判漂移', () => {
    const upstream = upstreamSnapshotFromModules({ PROTOCOL_VERSION: { nested: 1 } })
    const differences = diffProtocolContract(collectVendoredContract(), upstream)
    expect(differences[0]).toContain('drift: PROTOCOL_VERSION')
    expect(differences[0]).toContain('upstream=object(nested)')
  })
})
