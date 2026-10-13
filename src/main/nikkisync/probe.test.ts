import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  NIKKISYNC_PACKAGE_NAMES,
  NIKKISYNC_REQUIRED_EXPORTS,
  hasNikkiSyncLink
} from './runtime-loader'
import {
  formatNikkiSyncLinkProbeReport,
  isNikkiSyncProbeErrorLine,
  runNikkiSyncLinkProbe,
  type NikkiSyncLinkProbeReport
} from './probe'

/**
 * 探针主体测试（整合阶段 1，计划 §11 用例 1-5 的探针形态）。
 *
 * 探针在本地 Node（>= 24，含 node:sqlite）下即可运行，因此这里直接跑真实装载路径，
 * 而不是 mock：与 Electron 宿主下的 `nikkisync-probe.js` 共用同一份实现，
 * 二者结论必须一致（Electron 侧由 `npm run build` + ELECTRON_RUN_AS_NODE 探针复验）。
 *
 * 链接缺失时整文件 skip：环境缺失不能被记成逻辑失败（门控用 hasNikkiSyncLink，
 * 悬空 junction 不算已链接）。
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const LINKED = hasNikkiSyncLink(projectRoot)

/** 构造一份最小报告暴面，用于纯函数断言（不依赖链接是否就绪）。 */
function sampleReport(overrides: Partial<NikkiSyncLinkProbeReport> = {}): NikkiSyncLinkProbeReport {
  return {
    ok: true,
    host: { node: '24.18.0', electron: '41.10.6' },
    packages: [{ packageName: 'core', specifier: '@nikkisync/core', ok: true, exportCount: 9 }],
    exports: [
      {
        packageName: 'core',
        exportName: 'AssetResolver',
        typeOf: 'function',
        detail: 'function AssetResolver'
      }
    ],
    database: { ok: true, tableCount: 13, objectCount: 38, tables: ['assets'] },
    companion: { ok: true, protocolVersion: 1 },
    failures: [],
    ...overrides
  }
}

describe('formatNikkiSyncLinkProbeReport / isNikkiSyncProbeErrorLine（纯函数）', () => {
  it('成功报告含宿主行、包行、导出行与 [result  ] OK', () => {
    const lines = formatNikkiSyncLinkProbeReport(sampleReport())
    expect(lines[0]).toBe('[nikkisync-probe] host node=24.18.0 electron=41.10.6')
    expect(lines).toContain('[package ] @nikkisync/core ok=true exports=9')
    expect(lines).toContain(
      '[export  ] core.AssetResolver typeof=function value=function AssetResolver'
    )
    expect(lines).toContain('[database] ok=true tables=13 objects=38 error=none')
    expect(lines).toContain('[companion] ok=true protocolVersion=1 error=none')
    expect(lines[lines.length - 1]).toBe('[result  ] OK')
    expect(lines.filter(isNikkiSyncProbeErrorLine)).toEqual([])
  })

  it('失败报告逐条输出 [fail] 并把错误行分流到 stderr 侧', () => {
    const lines = formatNikkiSyncLinkProbeReport(
      sampleReport({
        ok: false,
        failures: ['@nikkisync/protocol.PROTOCOL_VERSION: missing', 'database probe failed: boom'],
        database: { ok: false, error: 'boom' },
        companion: { ok: false, error: 'no module' }
      })
    )
    expect(lines).toContain('[fail    ] @nikkisync/protocol.PROTOCOL_VERSION: missing')
    expect(lines).toContain('[fail    ] database probe failed: boom')
    expect(lines[lines.length - 1]).toBe('[result  ] FAILED (2 issue(s))')
    const errorLines = lines.filter(isNikkiSyncProbeErrorLine)
    expect(errorLines).toHaveLength(3)
  })

  it('宿主与子步骤缺失时降级为 n/a 而不抛错', () => {
    const lines = formatNikkiSyncLinkProbeReport(
      sampleReport({
        host: { node: '26.3.0' },
        packages: [],
        exports: [],
        database: { ok: false },
        companion: { ok: false }
      })
    )
    expect(lines[0]).toBe('[nikkisync-probe] host node=26.3.0 electron=n/a')
    expect(lines).toContain('[database] ok=false tables=n/a objects=n/a error=none')
    expect(lines).toContain('[database] tableNames=')
    expect(lines).toContain('[companion] ok=false protocolVersion=n/a error=none')
  })

  it('schemaSource 行仅在报告供给了来源时出现（旧行集不变，打包态可判）', () => {
    const withoutSource = formatNikkiSyncLinkProbeReport(sampleReport())
    expect(withoutSource.some((line) => line.startsWith('[database] schemaSource='))).toBe(false)

    const packed = formatNikkiSyncLinkProbeReport(
      sampleReport({
        database: {
          ok: true,
          tableCount: 13,
          objectCount: 38,
          tables: ['assets'],
          schemaSource:
            'D:/inst/resources/app.asar.unpacked/node_modules/@nikkisync/database/migrations/0001_initial.sql'
        }
      })
    )
    expect(packed).toContain(
      '[database] schemaSource=D:/inst/resources/app.asar.unpacked/node_modules/@nikkisync/database/migrations/0001_initial.sql'
    )
  })
})

describe.skipIf(!LINKED)('runNikkiSyncLinkProbe', () => {
  it('四包全部装载成功且报告 ok=true、无 failures', async () => {
    const report = await runNikkiSyncLinkProbe()
    expect(report.failures).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.packages).toHaveLength(NIKKISYNC_PACKAGE_NAMES.length)
    for (const item of report.packages) {
      expect(item.ok, `${item.specifier} load`).toBe(true)
      expect(item.exportCount).toBeGreaterThan(0)
    }
  })

  it('导出记录覆盖必需导出表，且宿主版本被如实记录', async () => {
    const report = await runNikkiSyncLinkProbe()
    const expectedCount = NIKKISYNC_PACKAGE_NAMES.reduce(
      (sum, name) => sum + Object.keys(NIKKISYNC_REQUIRED_EXPORTS[name]).length,
      0
    )
    expect(report.exports).toHaveLength(expectedCount)
    for (const item of report.exports) {
      expect(item.typeOf).toBe(NIKKISYNC_REQUIRED_EXPORTS[item.packageName][item.exportName])
      expect(item.detail).not.toBe('undefined')
    }
    // 本地宿主：node 主版本 >= 24（node:sqlite 的同步 API 前置），非 Electron
    expect(Number(report.host.node.split('.')[0])).toBeGreaterThanOrEqual(24)
    expect(report.host.electron).toBeUndefined()
  })

  it('数据库与 pc-companion 子步骤通过，且未触发任何服务监听', async () => {
    const report = await runNikkiSyncLinkProbe()
    expect(report.database.ok).toBe(true)
    expect(report.database.tableCount).toBeGreaterThanOrEqual(12)
    expect(report.database.tables).toContain('assets')
    expect(report.database.tables).toContain('resources')
    expect(report.database.tables).toContain('change_journal')
    expect(report.database.objectCount).toBeGreaterThanOrEqual(report.database.tableCount ?? 0)
    expect(report.companion.ok).toBe(true)
    expect(report.companion.protocolVersion).toBe(1)
    // 探针只允许内存库：若误用文件库会在 NikkiSync 目录下留下 sqlite 边文件
    expect(existsSync(path.resolve(projectRoot, '../NikkiSync/nikkisync.sqlite'))).toBe(false)
  })
})
