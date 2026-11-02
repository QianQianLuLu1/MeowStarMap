import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  collectVendoredContract,
  diffInterfaceMembers,
  diffProtocolContract,
  extractInterfaceMembers,
  extractNestedObjectMembers,
  upstreamSnapshotFromModules
} from './protocol-contract'
import { hasNikkiSyncLink, loadNikkiSyncPackage, type NikkiSyncModule } from './runtime-loader'

/**
 * 链接态协议漂移守护（阶段 9 · 问题 4）。
 *
 * 口径：vendored `src/shared/sync/protocol.ts` 是唯一真相源；上游 `@nikkisync/protocol`
 * 只作为比对对象。本文件把"两侧不再分叉"变成机械断言：一旦上游改了路由/错误码/枚举，
 * 或本仓移植面漏带新增符号，这里就会给出逐值差异，而不是靠人工 diff 发现。
 *
 * 未链接（CI 与默认开发机）时整件 skip：环境缺失不能被记成逻辑失败；
 * 纯函数行为由 protocol-contract.test.ts 在无链接态下长期覆盖。
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const LINKED = hasNikkiSyncLink(projectRoot)

/** 上游 `.d.ts`（interface 无运行时值，声明文本是唯一可比形态）。 */
function upstreamDeclarationSource(): string {
  const upstreamRoot = fs.realpathSync(
    path.join(projectRoot, 'node_modules', '@nikkisync', 'protocol')
  )
  const declaration = path.join(upstreamRoot, 'dist', 'src', 'index.d.ts')
  expect(fs.existsSync(declaration), `missing upstream declaration: ${declaration}`).toBe(true)
  return fs.readFileSync(declaration, 'utf8')
}

/** 本仓 vendored 契约源码。 */
function vendoredProtocolSource(): string {
  return fs.readFileSync(path.join(projectRoot, 'src', 'shared', 'sync', 'protocol.ts'), 'utf8')
}

/** 两侧同接口成员集比对（顺序不参与判定）。 */
function expectSameMembers(interfaceName: string): void {
  const vendored = extractInterfaceMembers(vendoredProtocolSource(), interfaceName)
  const upstream = extractInterfaceMembers(upstreamDeclarationSource(), interfaceName)
  expect(vendored, `vendored interface missing: ${interfaceName}`).toBeDefined()
  expect(upstream, `upstream interface missing: ${interfaceName}`).toBeDefined()
  expect(diffInterfaceMembers(vendored ?? [], upstream ?? [])).toEqual({ missing: [], extra: [] })
}

describe.skipIf(!LINKED)('协议契约与上游逐值比对', () => {
  it('AssetSummary DTO 字段集与上游声明一致（interface 无运行时值，只能比对声明）', () => {
    expectSameMembers('AssetSummary')
  })

  it('ServerInfoResponse 顶层成员集与上游一致', () => {
    expectSameMembers('ServerInfoResponse')
  })

  it('ServerInfoResponse.capabilities 深度 1 能力位与上游一致（新增位不得静默漏带）', () => {
    const vendored = extractNestedObjectMembers(
      vendoredProtocolSource(),
      'ServerInfoResponse',
      'capabilities'
    )
    const upstream = extractNestedObjectMembers(
      upstreamDeclarationSource(),
      'ServerInfoResponse',
      'capabilities'
    )
    expect(vendored, 'vendored capabilities block unreadable').toBeDefined()
    expect(upstream, 'upstream capabilities block unreadable').toBeDefined()
    expect(diffInterfaceMembers(vendored ?? [], upstream ?? [])).toEqual({ missing: [], extra: [] })
  })

  it('上游 @nikkisync/protocol（+ core 兜底）与 vendored 快照零差异', async () => {
    const protocol = (await loadNikkiSyncPackage('protocol')) as NikkiSyncModule
    const core = (await loadNikkiSyncPackage('core')) as NikkiSyncModule
    const upstream = upstreamSnapshotFromModules(protocol, core)
    expect(diffProtocolContract(collectVendoredContract(), upstream)).toEqual([])
  })

  it('上游 API_ROUTES 键数与 vendored 覆盖的路由面一致（12 个）', async () => {
    const protocol = (await loadNikkiSyncPackage('protocol')) as NikkiSyncModule
    const routes = protocol['API_ROUTES'] as Record<string, unknown>
    expect(Object.keys(routes)).toHaveLength(12)
  })
})
