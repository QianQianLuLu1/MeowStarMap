import { describe, expect, it } from 'vitest'

import {
  CONTRACT_PAIRING_KEYS,
  CONTRACT_ROUTE_KEYS,
  VENDORED_CONTRACT_SYMBOLS,
  collectVendoredContract,
  diffInterfaceMembers,
  diffProtocolContract,
  extractInterfaceMembers,
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
  RESOURCE_ROLES,
  buildPairingUri
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
    API_ROUTES,
    buildPairingUri
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

  it('兼容层：配对 URI 采样进入快照，多 host 采样值必须落在新 URI 方案上（漂移可判）', () => {
    const snapshot = collectVendoredContract()
    // 采样键存在的价值：上游改多 host 编码（键序/截断/URI 方案）时，这里先红再谈
    expect(snapshot[CONTRACT_PAIRING_KEYS.multiHost]).toMatch(/^nikki-sync:\/\/pair\?/)
    expect(snapshot[CONTRACT_PAIRING_KEYS.dedupHosts]).toMatch(/^nikki-sync:\/\/pair\?/)
    expect(snapshot[CONTRACT_PAIRING_KEYS.overLimit]).toMatch(/^nikki-sync:\/\/pair\?/)
    // 三组采样输入喂同一实现，快照值即实现输出（与 buildPairingUri 直接调用一致）
    const multiHostQuery = new URLSearchParams(
      String(snapshot[CONTRACT_PAIRING_KEYS.multiHost]).slice('nikki-sync://pair?'.length)
    )
    expect(multiHostQuery.get('hosts')).toBe('192.168.1.5,192.168.1.6,10.0.0.3')
    const dedupQuery = new URLSearchParams(
      String(snapshot[CONTRACT_PAIRING_KEYS.dedupHosts]).slice('nikki-sync://pair?'.length)
    )
    expect(dedupQuery.get('hosts')).toBe('192.168.1.5,192.168.1.6')
    const overLimitQuery = new URLSearchParams(
      String(snapshot[CONTRACT_PAIRING_KEYS.overLimit]).slice('nikki-sync://pair?'.length)
    )
    expect(overLimitQuery.get('hosts')).toBe(
      '192.168.1.5,10.0.0.2,10.0.0.3,10.0.0.4,10.0.0.5,10.0.0.6,10.0.0.7,10.0.0.8'
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

describe('extractInterfaceMembers', () => {
  it('正常：只取一层成员，可选与 readonly 归一，嵌套对象成员不计入', () => {
    const source = `
export interface Sample {
  /** doc with braces { } */
  readonly id: string
  name?: string
  nested?: {
    inner: string
    deeper?: { leaf: number }
  }
  count: number
  run?(): void
}
`
    expect(extractInterfaceMembers(source, 'Sample')).toEqual([
      'id',
      'name',
      'nested',
      'count',
      'run'
    ])
  })

  it('异常：接口不存在或接口体未闭合时返回 undefined', () => {
    expect(extractInterfaceMembers('interface Other { a: string }', 'Sample')).toBeUndefined()
    expect(extractInterfaceMembers('interface Sample { a: string', 'Sample')).toBeUndefined()
  })

  it('边界：注释与字符串里的花括号不破坏接口体边界', () => {
    const source = `interface Sample {
  /** { } */
  a: string
  // }
  b: '{ not a brace }'
  c: "tpl { }"
  d: \`raw { }\`
}`
    expect(extractInterfaceMembers(source, 'Sample')).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('diffInterfaceMembers', () => {
  it('正常：成员集合一致时无差异', () => {
    expect(diffInterfaceMembers(['a', 'b'], ['b', 'a'])).toEqual({ missing: [], extra: [] })
  })

  it('异常：缺字段与多余字段分别按各自源码顺序列出', () => {
    expect(diffInterfaceMembers(['a', 'stale'], ['a', 'b', 'c'])).toEqual({
      missing: ['b', 'c'],
      extra: ['stale']
    })
  })

  it('边界：重复成员名与不同顺序都不产生差异', () => {
    expect(diffInterfaceMembers(['a', 'a', 'b'], ['b', 'a'])).toEqual({ missing: [], extra: [] })
  })
})
