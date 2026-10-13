/**
 * 协议契约快照与漂移比对（阶段 9 · 问题 4）。
 *
 * 决策：`src/shared/sync/protocol.ts`（含 `domain-types.ts` / `protocol-extension.ts`）是
 * XiangCe 侧协议契约的**唯一真相源**——HTTP/WS 服务与仓储层都在运行时值面消费它，
 * 而 `@nikkisync/protocol` 的 ESM 图含 top-level await，值面无法静态导入
 * （见 src/main/nikkisync/AGENTS.md 硬性约定 1）。上游包因此降级为**比对对象**：
 * 链接就绪时由 `protocol-drift.test.ts` 用本文件的纯函数做逐值比对，防止长期分叉。
 *
 * 零依赖：只用本仓源码；不 import Node 内置、不 import @nikkisync/*（类型与值都不引）。
 * 字符串字面量保持英文：src/** 的中文硬编码护栏为 error。
 */

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

/** 快照值形态：标量或字符串数组（协议里参与跨仓比对的值只有这两类）。 */
export type ContractValue = string | number | readonly string[]

/** 扁平快照：键 = 符号名（函数路由用采样后的调用形态作键）。 */
export type ContractSnapshot = Record<string, ContractValue>

/** 函数路由的固定采样输入——同一次编码两侧共用，漂移才可判。 */
export const CONTRACT_ROUTE_SAMPLES = {
  assetId: '7/1',
  resourceId: 'res 1',
  clothingId: 'c 1'
} as const

/** 函数路由在快照中的键名（与 collectVendoredContract 的写入键一致）。 */
export const CONTRACT_ROUTE_KEYS = {
  asset: 'API_ROUTES.asset(7/1)',
  metadata: 'API_ROUTES.metadata(7/1)',
  resource: 'API_ROUTES.resource(7/1|res 1)',
  clothingThumbnail: 'API_ROUTES.clothingThumbnail(7/1|c 1)'
} as const

/** API_ROUTES 中的字面量路由键（其余 4 个键是函数，走采样编码）。 */
const LITERAL_ROUTE_KEYS = [
  'serverInfo',
  'pair',
  'assets',
  'suitSearch',
  'clothingSearch',
  'profileStats',
  'changes',
  'websocket'
] as const

/**
 * 契约面清单（显式声明，刻意不从实现反推）：新增/删除任一可比符号都要同步本表，
 * 否则 protocol-contract.test.ts 的键集断言即失败。
 */
export const VENDORED_CONTRACT_SYMBOLS: readonly string[] = [
  'PROTOCOL_VERSION',
  'METADATA_SCHEMA_VERSION',
  'ASSET_TYPES',
  'ASSET_STATES',
  'RESOURCE_ROLES',
  'CHANGE_TYPES',
  'API_ERROR_CODES',
  ...LITERAL_ROUTE_KEYS.map((key) => `API_ROUTES.${key}`),
  CONTRACT_ROUTE_KEYS.asset,
  CONTRACT_ROUTE_KEYS.metadata,
  CONTRACT_ROUTE_KEYS.resource,
  CONTRACT_ROUTE_KEYS.clothingThumbnail
]

/** 取值形态序列化：数组按顺序 joined，对象记键名，其余 String()。 */
function stringifyValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => String(item)).join('|')}]`
  if (value === null) return 'null'
  if (typeof value === 'object') return `object(${Object.keys(value as object).join(',')})`
  return String(value)
}

/** 数组值比较：长度与逐项（含顺序）一致才算相等。 */
function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

/** 单个值是否属于可比较形态（标量或字符串数组）。 */
function isComparable(value: unknown): value is ContractValue {
  if (Array.isArray(value)) return value.every((item) => typeof item === 'string')
  return typeof value === 'string' || typeof value === 'number'
}

/**
 * 纯函数：收集 vendored 契约快照。
 * 输出键集恒等于 VENDORED_CONTRACT_SYMBOLS；函数路由按采样输入编码为字符串。
 */
export function collectVendoredContract(): ContractSnapshot {
  const snapshot: ContractSnapshot = {
    PROTOCOL_VERSION,
    METADATA_SCHEMA_VERSION,
    ASSET_TYPES: [...ASSET_TYPES],
    ASSET_STATES: [...ASSET_STATES],
    RESOURCE_ROLES: [...RESOURCE_ROLES],
    CHANGE_TYPES: [...CHANGE_TYPES],
    API_ERROR_CODES: [...API_ERROR_CODES]
  }
  for (const key of LITERAL_ROUTE_KEYS) {
    const value = API_ROUTES[key as (typeof LITERAL_ROUTE_KEYS)[number]]
    snapshot[`API_ROUTES.${key}`] = value
  }
  snapshot[CONTRACT_ROUTE_KEYS.asset] = API_ROUTES.asset(CONTRACT_ROUTE_SAMPLES.assetId)
  snapshot[CONTRACT_ROUTE_KEYS.metadata] = API_ROUTES.metadata(CONTRACT_ROUTE_SAMPLES.assetId)
  snapshot[CONTRACT_ROUTE_KEYS.resource] = API_ROUTES.resource(
    CONTRACT_ROUTE_SAMPLES.assetId,
    CONTRACT_ROUTE_SAMPLES.resourceId
  )
  snapshot[CONTRACT_ROUTE_KEYS.clothingThumbnail] = API_ROUTES.clothingThumbnail(
    CONTRACT_ROUTE_SAMPLES.assetId,
    CONTRACT_ROUTE_SAMPLES.clothingId
  )
  return snapshot
}

/** 从模块命名空间按符号名取值（protocol 优先，core 回落；非对象入参给 undefined）。 */
function pick(moduleNamespaces: unknown[], symbol: string): unknown {
  for (const namespace of moduleNamespaces) {
    if (namespace && typeof namespace === 'object' && symbol in namespace) {
      return (namespace as Record<string, unknown>)[symbol]
    }
  }
  return undefined
}

/**
 * 纯函数：由上游模块命名空间（@nikkisync/protocol 为主，@nikkisync/core 兜底）构造同形态快照。
 * 只在取值存在且形态可比较时写入键；函数路由要求上游同名键也是函数，否则该键保持缺失
 * （缺失会被 diff 记成 missing，而不是被静默跳过或伪造）。
 */
export function upstreamSnapshotFromModules(
  protocolModule: unknown,
  coreModule?: unknown
): Record<string, unknown> {
  const namespaces = [protocolModule, coreModule].filter(
    (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object'
  )
  if (namespaces.length === 0) return {}

  const snapshot: Record<string, unknown> = {}
  const scalars = ['PROTOCOL_VERSION', 'METADATA_SCHEMA_VERSION'] as const
  for (const symbol of scalars) {
    const value = pick(namespaces, symbol)
    // 只要上游供了值就写入（即便形态不可比），差异由 diff 报 drift 而不是静默报 missing
    if (value !== undefined) snapshot[symbol] = value
  }
  const lists = [
    'ASSET_TYPES',
    'ASSET_STATES',
    'RESOURCE_ROLES',
    'CHANGE_TYPES',
    'API_ERROR_CODES'
  ] as const
  for (const symbol of lists) {
    const value = pick(namespaces, symbol)
    if (value !== undefined) snapshot[symbol] = value
  }

  const routes = pick(namespaces, 'API_ROUTES')
  if (!routes || typeof routes !== 'object') return snapshot
  const routeRecord = routes as Record<string, unknown>
  for (const key of LITERAL_ROUTE_KEYS) {
    const value = routeRecord[key]
    if (typeof value === 'string') snapshot[`API_ROUTES.${key}`] = value
  }
  const fnRoutes: Array<{ key: string; route: string; args: string[] }> = [
    { key: CONTRACT_ROUTE_KEYS.asset, route: 'asset', args: [CONTRACT_ROUTE_SAMPLES.assetId] },
    {
      key: CONTRACT_ROUTE_KEYS.metadata,
      route: 'metadata',
      args: [CONTRACT_ROUTE_SAMPLES.assetId]
    },
    {
      key: CONTRACT_ROUTE_KEYS.resource,
      route: 'resource',
      args: [CONTRACT_ROUTE_SAMPLES.assetId, CONTRACT_ROUTE_SAMPLES.resourceId]
    },
    {
      key: CONTRACT_ROUTE_KEYS.clothingThumbnail,
      route: 'clothingThumbnail',
      args: [CONTRACT_ROUTE_SAMPLES.assetId, CONTRACT_ROUTE_SAMPLES.clothingId]
    }
  ]
  for (const item of fnRoutes) {
    const fn = routeRecord[item.route]
    if (typeof fn !== 'function') continue
    const value = (fn as (...callArgs: string[]) => unknown)(...item.args)
    if (typeof value === 'string') snapshot[item.key] = value
  }
  // 上游 API_ROUTES 里 vendored 未覆盖的键：原样带出，由 diff 记 extra（提示需评审补移植）
  for (const [key, value] of Object.entries(routeRecord)) {
    const snapshotKey = `API_ROUTES.${key}`
    if (snapshot[snapshotKey] === undefined && typeof value === 'string') {
      snapshot[snapshotKey] = value
    }
  }
  return snapshot
}

/**
 * 纯函数：比较 vendored 快照与上游快照，返回逐条差异（空数组 = 契约一致）。
 * missing = 上游缺该符号；drift = 两侧值不等；extra = 上游有而 vendored 未覆盖。
 */
export function diffProtocolContract(
  vendored: ContractSnapshot,
  upstream: Record<string, unknown>
): string[] {
  const differences: string[] = []
  for (const [symbol, expected] of Object.entries(vendored)) {
    if (!(symbol in upstream)) {
      differences.push(`missing: ${symbol} (vendored=${stringifyValue(expected)})`)
      continue
    }
    const actual = upstream[symbol]
    const equal = Array.isArray(expected)
      ? Array.isArray(actual) && sameList(expected, actual as readonly string[])
      : isComparable(actual) && actual === expected
    if (!equal) {
      differences.push(
        `drift: ${symbol} vendored=${stringifyValue(expected)} upstream=${stringifyValue(actual)}`
      )
    }
  }
  for (const symbol of Object.keys(upstream)) {
    if (!(symbol in vendored)) {
      differences.push(`extra: ${symbol} upstream=${stringifyValue(upstream[symbol])}`)
    }
  }
  return differences
}
