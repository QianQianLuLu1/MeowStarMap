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
  RESOURCE_ROLES,
  buildPairingUri,
  type PairingQrPayload
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
 * 配对 URI 的固定采样输入（兼容层：对齐上游 b422193）——覆盖 `buildPairingUri` 的
 * 多 host 分支。上游在本轮新增 hosts 去重 / 截断(8) / `nikki-sync://pair?` 新 URI 方案，
 * 此前不在采样面，vendored 与上游的分叉会被漂移守护静默放过（02 计划 R4）；
 * 三组输入分别钉住「多 host / 重复折叠 / 超 8 截断」。
 */
const PAIRING_SAMPLE_BASE: PairingQrPayload = {
  scheme: 'nikki-sync',
  action: 'pair',
  serverId: 'server_1',
  host: '192.168.1.5',
  port: 4242,
  pairingToken: 'abc-_123',
  protocolVersion: PROTOCOL_VERSION,
  expiresAt: '2026-09-02T14:30:00.000Z',
  tlsFingerprintSha256: '00'.repeat(32)
}

export const CONTRACT_PAIRING_SAMPLES = {
  multiHost: { ...PAIRING_SAMPLE_BASE, hosts: ['192.168.1.6', '10.0.0.3'] },
  dedupHosts: { ...PAIRING_SAMPLE_BASE, hosts: ['192.168.1.5', '192.168.1.6', '192.168.1.6'] },
  overLimit: {
    ...PAIRING_SAMPLE_BASE,
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
  }
} as const

/** 配对 URI 采样在快照中的键名（与 collectVendoredContract 的写入键一致）。 */
export const CONTRACT_PAIRING_KEYS = {
  multiHost: 'buildPairingUri(multiHost)',
  dedupHosts: 'buildPairingUri(dedupHosts)',
  overLimit: 'buildPairingUri(overLimit)'
} as const

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
  CONTRACT_ROUTE_KEYS.clothingThumbnail,
  CONTRACT_PAIRING_KEYS.multiHost,
  CONTRACT_PAIRING_KEYS.dedupHosts,
  CONTRACT_PAIRING_KEYS.overLimit
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
  snapshot[CONTRACT_PAIRING_KEYS.multiHost] = buildPairingUri(CONTRACT_PAIRING_SAMPLES.multiHost)
  snapshot[CONTRACT_PAIRING_KEYS.dedupHosts] = buildPairingUri(CONTRACT_PAIRING_SAMPLES.dedupHosts)
  snapshot[CONTRACT_PAIRING_KEYS.overLimit] = buildPairingUri(CONTRACT_PAIRING_SAMPLES.overLimit)
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

  // 配对 URI 采样（兼容层 b422193）：与 vendored 同一组采样输入喂给上游 buildPairingUri，
  // 多 host 分支（新 URI 方案 / hosts 去重 / 截断）由此进入漂移比对面。
  const pairingFn = pick(namespaces, 'buildPairingUri')
  if (typeof pairingFn === 'function') {
    for (const key of ['multiHost', 'dedupHosts', 'overLimit'] as const) {
      const value = (pairingFn as (payload: unknown) => unknown)(CONTRACT_PAIRING_SAMPLES[key])
      if (typeof value === 'string') snapshot[CONTRACT_PAIRING_KEYS[key]] = value
    }
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

/** 接口成员差异：missing = 上游有而 vendored 未登记；extra = vendored 有而上游已移除。 */
export interface InterfaceMemberDiff {
  missing: string[]
  extra: string[]
}

/**
 * 纯函数：先把注释与字符串内容替换为空格（保留换行），再交给结构扫描。
 * 目的：注释/字符串里的花括号不得干扰接口体边界与成员识别。
 */
function maskCommentsAndStrings(source: string): string {
  const chars = source.split('')
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to; index += 1) {
      if (chars[index] !== '\n') chars[index] = ' '
    }
  }
  let index = 0
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end === -1 ? source.length : end + 2
      blank(index, stop)
      index = stop
      continue
    }
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index + 2)
      const stop = end === -1 ? source.length : end
      blank(index, stop)
      index = stop
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      let cursor = index + 1
      while (cursor < source.length) {
        if (source[cursor] === '\\') {
          cursor += 2
          continue
        }
        if (source[cursor] === char) {
          cursor += 1
          break
        }
        cursor += 1
      }
      blank(index + 1, Math.max(index + 1, cursor - 1))
      index = cursor
      continue
    }
    index += 1
  }
  return chars.join('')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 纯函数：从 TypeScript 源码文本提取接口的一层成员名（保持源码顺序、去重）。
 *
 * 只认深度 0 的 `name:` / `name?:` / `readonly name:` 与 `name(`（方法签名）；
 * 嵌套对象类型内部的成员不进入结果。接口不存在或未闭合时返回 `undefined`——
 * 调用方必须把「读不到」与「读到了但为空」分开处理。
 */
export function extractInterfaceMembers(
  source: string,
  interfaceName: string
): string[] | undefined {
  const masked = maskCommentsAndStrings(source)
  const declaration = new RegExp(`\\binterface\\s+${escapeRegExp(interfaceName)}\\b`).exec(masked)
  if (!declaration) return undefined
  const open = masked.indexOf('{', declaration.index + declaration[0].length)
  if (open === -1) return undefined
  let depth = 0
  let close = -1
  for (let index = open; index < masked.length; index += 1) {
    if (masked[index] === '{') depth += 1
    else if (masked[index] === '}') {
      depth -= 1
      if (depth === 0) {
        close = index
        break
      }
    }
  }
  if (close === -1) return undefined

  const members: string[] = []
  let bodyDepth = 0
  for (const line of masked.slice(open + 1, close).split('\n')) {
    if (bodyDepth === 0) {
      const match =
        /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:/.exec(line) ??
        /^\s*([A-Za-z_$][\w$]*)\s*\??\s*\(/.exec(line)
      const name = match?.[1]
      if (name && !members.includes(name)) members.push(name)
    }
    for (const char of line) {
      if (char === '{') bodyDepth += 1
      else if (char === '}') bodyDepth = Math.max(0, bodyDepth - 1)
    }
  }
  return members
}

/** 纯函数：按成员名集合比较两个接口（顺序不参与判定），返回 missing / extra 明细。 */
export function diffInterfaceMembers(
  vendored: readonly string[],
  upstream: readonly string[]
): InterfaceMemberDiff {
  const vendoredSet = new Set(vendored)
  const upstreamSet = new Set(upstream)
  return {
    missing: upstream.filter((name) => !vendoredSet.has(name)),
    extra: vendored.filter((name) => !upstreamSet.has(name))
  }
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
