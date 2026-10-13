/**
 * NikkiSync 链接探针（整合阶段 1）：只读验证四包可装载、关键导出非 undefined、
 * 内存库可按 0001_initial.sql 建表。
 *
 * 硬性边界（见 docs/sync-integration/01-dependency-link-plan.md §10 末行 / §14 R7）：
 * - 绝不实例化 LocalSyncServer / ScannerService / MdnsAdvertiser，绝不调用
 *   PcCompanionRuntime.start()：不留端口、组播、TLS 私钥、扫描等副作用。
 * - 数据库只允许 ':memory:'，探针结束必须 close()。
 */

import {
  NIKKISYNC_PACKAGES,
  NIKKISYNC_PACKAGE_NAMES,
  NIKKISYNC_REQUIRED_EXPORTS,
  loadNikkiSyncPackage,
  nikkisyncExport,
  type NikkiSyncModule,
  type NikkiSyncPackageName
} from './runtime-loader'
import {
  readMigrationsSql,
  resolveMigrationsSqlPath,
  resolveModuleRoot,
  type PackagingContext
} from './embedding-paths'

export interface NikkiSyncPackageRecord {
  packageName: NikkiSyncPackageName
  specifier: string
  ok: boolean
  exportCount: number
  error?: string
}

export interface NikkiSyncExportRecord {
  packageName: NikkiSyncPackageName
  exportName: string
  typeOf: string
  detail: string
}

export interface NikkiSyncDatabaseRecord {
  ok: boolean
  /** sqlite_master 中 type='table' 的对象数（12 业务表 + 可能的 sqlite_sequence） */
  tableCount?: number
  /** sqlite_master 全部对象数（含索引/autoindex），仅用于日志对比 */
  objectCount?: number
  tables?: string[]
  error?: string
  /**
   * schema SQL 的来源：给出 PackagingContext 时为本侧解析的绝对路径（显式传参），
   * 缺省时为 'upstream import.meta.url default'（阶段 1 已验证的开发态行为）。
   */
  schemaSource?: string
}

export interface NikkiSyncCompanionRecord {
  ok: boolean
  protocolVersion?: number
  error?: string
}

export interface NikkiSyncLinkProbeReport {
  ok: boolean
  host: { node: string; electron?: string }
  packages: NikkiSyncPackageRecord[]
  exports: NikkiSyncExportRecord[]
  database: NikkiSyncDatabaseRecord
  companion: NikkiSyncCompanionRecord
  failures: string[]
}

/** 装载层不认识 DatabaseManager 的具体类型，这里只声明探针需要的最小结构面。 */
interface DatabaseManagerLike {
  connection: {
    exec(sql: string): void
    prepare(sql: string): { all(): unknown[]; get(): unknown }
  }
  initialize(schemaSql?: string): void
  close(): void
}

const BUSINESS_TABLE_MINIMUM = 12

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 生成可读的导出摘要（不含大对象转储，避免日志污染）。 */
function describeValue(value: unknown): string {
  if (typeof value === 'function') {
    const name = (value as { name?: string }).name
    return name ? `function ${name}` : 'function'
  }
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array(${value.length})`
  if (typeof value === 'object') return `object(${Object.keys(value).length} keys)`
  return `${typeof value} ${String(value).slice(0, 40)}`
}

async function probeDatabase(
  databaseModule: NikkiSyncModule | undefined,
  context?: PackagingContext
): Promise<NikkiSyncDatabaseRecord> {
  let schemaSource = context ? 'not resolved' : 'upstream import.meta.url default'
  if (!databaseModule) {
    return { ok: false, error: 'database module was not loaded', schemaSource }
  }
  try {
    const Ctor = nikkisyncExport(databaseModule, 'DatabaseManager') as new (
      file: string
    ) => DatabaseManagerLike
    const manager = new Ctor(':memory:')
    // 给出 context 时由本侧解析绝对路径并显式传入 schemaSql：打包态下上游
    // `import.meta.url` 相对定位 migrations 不可靠（docs/sync-integration/01-dependency-link-plan.md §10）。
    let schemaSql: string | undefined
    if (context) {
      const root = resolveModuleRoot('@nikkisync/database', context)
      const sqlPath = resolveMigrationsSqlPath(root.root)
      schemaSource = sqlPath
      schemaSql = readMigrationsSql(sqlPath)
    }
    try {
      manager.initialize(schemaSql)
      const rows = manager.connection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name?: unknown }>
      const allRows = manager.connection
        .prepare('SELECT name FROM sqlite_master ORDER BY name')
        .all() as Array<{ name?: unknown }>
      const tables = rows.map((row) => String(row.name))
      const ok = tables.length >= BUSINESS_TABLE_MINIMUM
      return {
        ok,
        tableCount: tables.length,
        objectCount: allRows.length,
        tables,
        schemaSource,
        error: ok
          ? undefined
          : `only ${tables.length} tables were created (expected >= ${BUSINESS_TABLE_MINIMUM})`
      }
    } finally {
      manager.close()
    }
  } catch (error) {
    return { ok: false, error: messageOf(error), schemaSource }
  }
}

async function probeCompanion(
  pcCompanionModule: NikkiSyncModule | undefined
): Promise<NikkiSyncCompanionRecord> {
  if (!pcCompanionModule) {
    return { ok: false, error: 'pc-companion module was not loaded' }
  }
  try {
    const createContext = nikkisyncExport(pcCompanionModule, 'createPcCompanionContext') as (
      file?: string
    ) => { database: { close(): void }; protocolVersion: number }
    const context = createContext(':memory:')
    try {
      return { ok: context.protocolVersion === 1, protocolVersion: context.protocolVersion }
    } finally {
      context.database.close()
    }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

/**
 * 把探针报告格式化成人读行序列（纯函数，无 I/O）。
 * 抽离目的：让输出形态可被单测固定（而不仅存在于入口壳里），同时保证入口壳 `probe-cli.ts`
 * 仅剩“跑报告 + 写 stdout/stderr + 定退出码”三件事。
 * 约定：以 `[fail    ]` / `[result  ] FAILED` 开头的行为错误输出（调用方写 stderr）。
 */
export function formatNikkiSyncLinkProbeReport(report: NikkiSyncLinkProbeReport): string[] {
  const electronVersion = report.host.electron ?? 'n/a'
  const header = `[nikkisync-probe] host node=${report.host.node} electron=${electronVersion}`
  const lines: string[] = [header]

  for (const item of report.packages) {
    const suffix = item.ok ? `exports=${item.exportCount}` : `error=${item.error}`
    lines.push(`[package ] ${item.specifier} ok=${item.ok} ${suffix}`)
  }

  for (const item of report.exports) {
    lines.push(
      `[export  ] ${item.packageName}.${item.exportName} typeof=${item.typeOf} value=${item.detail}`
    )
  }

  lines.push(
    `[database] ok=${report.database.ok} tables=${report.database.tableCount ?? 'n/a'} ` +
      `objects=${report.database.objectCount ?? 'n/a'} error=${report.database.error ?? 'none'}`
  )
  lines.push(`[database] tableNames=${report.database.tables?.join(',') ?? ''}`)
  // 仅在报告供给了 schema 来源时多打一行，保持旧报告行集不变（纯函数用例已固定）
  if (report.database.schemaSource) {
    lines.push(`[database] schemaSource=${report.database.schemaSource}`)
  }
  lines.push(
    `[companion] ok=${report.companion.ok} ` +
      `protocolVersion=${report.companion.protocolVersion ?? 'n/a'} ` +
      `error=${report.companion.error ?? 'none'}`
  )

  if (report.ok) {
    lines.push('[result  ] OK')
    return lines
  }
  for (const failure of report.failures) {
    lines.push(`[fail    ] ${failure}`)
  }
  lines.push(`[result  ] FAILED (${report.failures.length} issue(s))`)
  return lines
}

/** 报告行是否属于错误输出（调用方据此分流到 stderr）。 */
export function isNikkiSyncProbeErrorLine(line: string): boolean {
  return line.startsWith('[fail    ]') || line.startsWith('[result  ] FAILED')
}

/**
 * 执行探针，返回结构化报告（不抛错，一切失败体现在 failures 中）。
 * 打包态必须传入 PackagingContext：那才会走 unpacked 路径兜底装载与显式 schemaSql。
 */
export async function runNikkiSyncLinkProbe(
  context?: PackagingContext
): Promise<NikkiSyncLinkProbeReport> {
  const failures: string[] = []
  const packages: NikkiSyncPackageRecord[] = []
  const exportRecords: NikkiSyncExportRecord[] = []
  const loaded = {} as Partial<Record<NikkiSyncPackageName, NikkiSyncModule>>

  for (const packageName of NIKKISYNC_PACKAGE_NAMES) {
    const specifier = NIKKISYNC_PACKAGES[packageName]
    try {
      const module = await loadNikkiSyncPackage(packageName, context)
      loaded[packageName] = module
      packages.push({ packageName, specifier, ok: true, exportCount: Object.keys(module).length })
      const required = NIKKISYNC_REQUIRED_EXPORTS[packageName]
      for (const [exportName, expectedType] of Object.entries(required)) {
        try {
          const value = nikkisyncExport(module, exportName)
          const typeOf = typeof value
          exportRecords.push({ packageName, exportName, typeOf, detail: describeValue(value) })
          if (typeOf !== expectedType) {
            failures.push(`${specifier}.${exportName} typeof=${typeOf}, expected ${expectedType}`)
          }
        } catch (error) {
          failures.push(`${specifier}.${exportName}: ${messageOf(error)}`)
        }
      }
    } catch (error) {
      packages.push({ packageName, specifier, ok: false, exportCount: 0, error: messageOf(error) })
      failures.push(`${specifier}: ${messageOf(error)}`)
    }
  }

  const database = await probeDatabase(loaded.database, context)
  if (!database.ok) {
    failures.push(`database probe failed: ${database.error ?? 'unknown reason'}`)
  }

  const companion = await probeCompanion(loaded.pcCompanion)
  if (!companion.ok) {
    failures.push(`pc-companion context failed: ${companion.error ?? 'unknown reason'}`)
  }

  return {
    ok: failures.length === 0,
    host: {
      node: process.versions.node,
      electron: process.versions.electron
    },
    packages,
    exports: exportRecords,
    database,
    companion,
    failures
  }
}
