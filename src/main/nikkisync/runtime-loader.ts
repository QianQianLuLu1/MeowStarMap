/**
 * NikkiSync 包装载缝（整合阶段 1）——主进程消费 @nikkisync/* 的唯一入口。
 *
 * 为什么必须这样写（依据 docs/sync-integration/01-dependency-link-plan.md §3/§4/§10）：
 * - NikkiSync 的 ESM 图含 top-level await（packages/database/src/database-manager.ts 顶层
 *   `await import(sqliteModuleName)`），宿主对其 `require()` 会抛 ERR_REQUIRE_ASYNC_MODULE。
 *   XiangCe 主进程产物是 Vite lib 的 CJS，因此值面只能走「变量式动态 import」，
 *   并确保 specifier 不被打包器静态折叠成 require（构建后有专门校验步骤）。
 * - 类型面不再 `import type` 上游包（阶段 9 自包含方案）：`@nikkisync/*` 已移出
 *   package.json 依赖声明，改由 `npm run link:nikkisync` 在开发机建 junction；
 *   本模块因此不引用任何 NikkiSync 类型，CI（无同级仓库）下 `tsc -b` 仍能通过。
 *   “四包 .d.ts 可解析”的守卫改由三层承担：scripts/verify-nikkisync-link.ts 的文件级
 *   双存在检查 + 下方 NIKKISYNC_REQUIRED_EXPORTS 运行时探针 + protocol-drift 契约比对。
 * - 字符串字面量保持英文：src/** 的中文硬编码护栏（no-restricted-syntax）为 error。
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { resolveEntryUrl, resolveModuleRoot, type PackagingContext } from './embedding-paths'

/** 四包的 specifier 单一真相源（键名用于报告展示，值用于装载）。 */
export const NIKKISYNC_PACKAGES = {
  core: '@nikkisync/core',
  database: '@nikkisync/database',
  pcCompanion: '@nikkisync/pc-companion',
  protocol: '@nikkisync/protocol'
} as const

export type NikkiSyncPackageName = keyof typeof NIKKISYNC_PACKAGES

/** ESM 模块命名空间的最小可操作形态（不用 any：no-explicit-any 为 error）。 */
export type NikkiSyncModule = Record<string, unknown>

export const NIKKISYNC_PACKAGE_NAMES = [
  'core',
  'database',
  'pcCompanion',
  'protocol'
] as const satisfies readonly NikkiSyncPackageName[]

/**
 * 四包必须存在的运行时导出（导出名 → 期望 typeof）。
 * 测试与探针共用此表，避免“两套期望名单”漂移。
 * 注：`NikkiAsset` / `MediaResource` 等是 interface（无运行时值），对本表里
 * 同包的常量导出（`ASSET_TYPES` / `RESOURCE_ROLES` 等）做运行时等价断言。
 */
export const NIKKISYNC_REQUIRED_EXPORTS: Record<NikkiSyncPackageName, Record<string, string>> = {
  core: {
    ASSET_RESOLVER_VERSION: 'number',
    ASSET_STATES: 'object',
    ASSET_TYPES: 'object',
    AssetResolver: 'function',
    RESOURCE_ROLES: 'object',
    toPathKey: 'function'
  },
  database: {
    DatabaseManager: 'function',
    // 阶段 3：设备管理与查询面依赖的两个仓储（桶导出内，见 packages/database/src/index.ts）
    PairingRepository: 'function',
    SyncReadRepository: 'function'
  },
  pcCompanion: {
    PcCompanionRuntime: 'function',
    createPcCompanionContext: 'function',
    // 阶段 3：同步服务器与自签 TLS 身份（server/index.js 桶导出）
    LocalSyncServer: 'function',
    LocalTlsIdentityService: 'function'
  },
  protocol: {
    API_ROUTES: 'object',
    PROTOCOL_VERSION: 'number',
    buildPairingUri: 'function'
  }
}

/** 装载失败时抛出的可诊断错误：携带包名、原始信息与修复提示。 */
export class NikkiSyncLoadError extends Error {
  readonly packageName: NikkiSyncPackageName
  readonly specifier: string
  readonly hint: string

  constructor(packageName: NikkiSyncPackageName, specifier: string, cause: unknown, hint: string) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    super(`Failed to load ${specifier} as ${packageName}: ${reason} | hint: ${hint}`)
    this.name = 'NikkiSyncLoadError'
    this.packageName = packageName
    this.specifier = specifier
    this.hint = hint
  }
}

/**
 * 依据底层错误推断最可能的缺失环节，给出可直接执行的修复指令。
 * 只做字符串分类，不猜测路径，避免把环境缺失伪装成逻辑失败。
 */
export function resolveLoadHint(originalMessage: string): string {
  if (originalMessage.includes('ERR_REQUIRE_ASYNC_MODULE')) {
    return (
      'the dynamic import was folded into require() by the bundler; ' +
      'keep the specifier in a variable (see plan section 10)'
    )
  }
  const notFound =
    originalMessage.includes('Cannot find package') ||
    originalMessage.includes('ERR_MODULE_NOT_FOUND')
  if (notFound) {
    return (
      'the @nikkisync/* link is missing or NikkiSync has no compiled dist; ' +
      'run `npm install` in WXNN XiangCe and `npm run build` in NikkiSync, ' +
      'then `npm run verify:nikkisync` for the full diagnosis'
    )
  }
  return 'inspect the original error; the link exists but the package graph failed to initialize'
}

/**
 * 把包名映射为 specifier。未知包名在装载之前即抛错（不留半初始化的模块图），
 * 使拼写错误与真实装载失败在诊断上可区分。
 */
export function specifierFor(packageName: string): string {
  const specifier = (NIKKISYNC_PACKAGES as Record<string, string>)[packageName]
  if (!specifier) {
    throw new Error(
      `Unknown NikkiSync package key "${packageName}"; known keys: ` +
        `${NIKKISYNC_PACKAGE_NAMES.join(', ')}`
    )
  }
  return specifier
}

/**
 * 装载单个包。specifier 取自变量而非字面量，这是刻意设计：
 * 字面量会被 Rollup 的 CJS 输出折叠为 require()，进而在运行时抛 ERR_REQUIRE_ASYNC_MODULE。
 *
 * 传入 PackagingContext 且为打包态时多一级兜底：把 bare specifier 换成
 * `app.asar.unpacked` 下解析出的 `file://` 入口 URL 再装载一次（仍是变量式 import）。
 * 不传 context 时与阶段 1 已验证的开发态行为完全一致。
 */
export async function loadNikkiSyncPackage(
  packageName: NikkiSyncPackageName,
  context?: PackagingContext
): Promise<NikkiSyncModule> {
  const specifier: string = specifierFor(packageName)
  try {
    // specifier 是变量而非字面量：见上方注释与本节标题
    const loaded = await import(/* @vite-ignore */ specifier)
    return loaded as NikkiSyncModule
  } catch (error) {
    if (!context?.isPackaged) {
      const message = error instanceof Error ? error.message : String(error)
      throw new NikkiSyncLoadError(packageName, specifier, error, resolveLoadHint(message))
    }
    let attemptedUrl = ''
    try {
      const root = resolveModuleRoot(specifier, context)
      attemptedUrl = resolveEntryUrl(root.root)
      const loaded = await import(/* @vite-ignore */ attemptedUrl)
      return loaded as NikkiSyncModule
    } catch (fallbackError) {
      const reason = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      const hint = `${resolveLoadHint(reason)}; packaged fallback attempted: ${attemptedUrl}`
      throw new NikkiSyncLoadError(packageName, specifier, fallbackError, hint)
    }
  }
}

/** 装载全部四包，返回按包名索引的模块表（装载顺序固定，便于日志比对）。 */
export async function loadAllNikkiSyncPackages(
  context?: PackagingContext
): Promise<Record<NikkiSyncPackageName, NikkiSyncModule>> {
  const modules = {} as Record<NikkiSyncPackageName, NikkiSyncModule>
  for (const packageName of NIKKISYNC_PACKAGE_NAMES) {
    modules[packageName] = await loadNikkiSyncPackage(packageName, context)
  }
  return modules
}

/**
 * 取出一个必须存在的运行时导出。缺失即抛错（而不是返回 undefined），
 * 使「包能装载但产物过期/导出改名」这类静默劣化也能被抓到。
 */
export function nikkisyncExport(module: NikkiSyncModule, exportName: string): unknown {
  const value = module[exportName]
  if (value === undefined) {
    throw new Error(
      `Expected export "${exportName}" is undefined; the loaded NikkiSync artifact is ` +
        `missing or stale (run \`npm run build\` in NikkiSync)`
    )
  }
  return value
}

/**
 * 链接是否真的存在（规则单一真相源，**仅供测试 skip 门控**）。
 * 不能只看 `node_modules/@nikkisync` 本身：目录在而 junction 悬空时（NikkiSync 未就位）
 * 它仍存在，linked 套件会误跳进装载并报假失败——因此按包内
 * `package.json` 可解析来判定。链接由 `npm run link:nikkisync` 建立。
 * projectRoot 由调用方传入（测试文件形态下才能用 import.meta 取自身目录）；
 * 打包态的路径解析不在本函数职责内，见 embedding-paths.ts。
 */
export function hasNikkiSyncLink(projectRoot: string): boolean {
  return NIKKISYNC_PACKAGE_NAMES.every((name) =>
    existsSync(path.join(projectRoot, 'node_modules', NIKKISYNC_PACKAGES[name], 'package.json'))
  )
}

/** 链接是否就绪（供测试门控与诊断脚本使用，不抛错；会真实尝试装载）。 */
export async function isNikkiSyncLinked(): Promise<boolean> {
  try {
    await loadNikkiSyncPackage('core')
    return true
  } catch {
    return false
  }
}
