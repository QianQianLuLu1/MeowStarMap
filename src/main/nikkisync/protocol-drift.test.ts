import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  collectVendoredContract,
  diffProtocolContract,
  upstreamSnapshotFromModules
} from './protocol-contract'
import { hasNikkiSyncLink, loadNikkiSyncPackage, type NikkiSyncModule } from './runtime-loader'

/**
 * 链接态协议漂移守护（阶段 9 · 问题 4）。
 *
 * 口径：vendored `src/shared/sync/protocol.ts` 是唯一真相源；上游 `@nikkisync/protocol`
 * 只作为比对对象。本文件把"两侧不再分叉"变成机械断言：一旦上游改了路由/错误码/枚举，
 * 或本仓移植面漏带新增符号，这里就会给出逐条差异，而不是靠人工 diff 发现。
 *
 * 未链接（CI 与默认开发机）时整件 skip：环境缺失不能被记成逻辑失败；
 * 纯函数行为由 protocol-contract.test.ts 在无链接态下长期覆盖。
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const LINKED = hasNikkiSyncLink(projectRoot)

describe.skipIf(!LINKED)('协议契约与上游逐值比对', () => {
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
