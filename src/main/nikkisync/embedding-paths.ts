/**
 * 打包态资源路径解析（阶段 9 · 问题 3）。
 *
 * 解决两件在 asar 里会静默翻车的事：
 * 1. **模块入口**：`@nikkisync/*` 被 `build.asarUnpack` 解出后真实落点在
 *    `resources/app.asar.unpacked/node_modules/@nikkisync/<name>`，而 bare specifier
 *    在打包态解析到的仍是 `app.asar` 内的虚拟路径。装载缝因此在显式给出的
 *    PackagingContext 下改走 `pathToFileURL(...).href`（仍是变量式 import，不会被折叠成 require）。
 * 2. **migrations SQL**：上游 `DatabaseManager.initialize()` 用
 *    `new URL('../../migrations/0001_initial.sql', import.meta.url)` 定位 schema，
 *    该相对路径在打包态不可靠（见 docs/sync-integration/01-dependency-link-plan.md §10 预定处置），
 *    改由本模块解析绝对路径读入文本后显式传参，不改 NikkiSync 源码。
 *
 * 全部函数为纯函数（ctx / existsSync / readFile 注入），CI 与单测不触磁盘；
 * 字符串字面量保持英文（src/** 的中文硬编码护栏为 error）。
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** 运行位置上下文：打包态以 resourcesPath 为基准，开发态以 projectRoot 为基准。 */
export interface PackagingContext {
  isPackaged: boolean
  /** Electron `process.resourcesPath`；开发态为空串。 */
  resourcesPath: string
  /** XiangCe 项目根（开发态的 node_modules 所在目录）。 */
  projectRoot: string
}

export interface ModuleRootResolution {
  root: string
  /** 打包态下 unpacked 目录不存在、回落到 asar 内路径时为 true（可观测，不静默）。 */
  fellBackToAsar: boolean
}

/** 打包态资源布局常量（与 electron-builder 的 asar + asarUnpack 行为一一对应）。 */
export const ASAR_FILE_NAME = 'app.asar'
export const ASAR_UNPACKED_DIR_NAME = 'app.asar.unpacked'
const PACKAGE_SCOPE_PREFIX = '@nikkisync/'
const SPECIFIER_PATTERN = /^@nikkisync\/[a-z][a-z-]*$/
const MIGRATIONS_REL = ['migrations', '0001_initial.sql'] as const
const ENTRY_REL = ['dist', 'src', 'index.js'] as const
/**
 * 深入口（阶段 2）：上游只暴露 `dist/src/**` 为可装载 ESM 产物，且桶导出覆盖不到
 * `server/row-mappers.js` 这类协议 DTO 映射（见 docs/sync-integration/02-runtime-embed-plan.md §0.1），
 * 因此段清单永远锚在 `dist/src` 之下，并只接受 `.js` / `.mjs`。
 */
const DEEP_ENTRY_REL = ['dist', 'src'] as const
const DEEP_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/
const DEEP_ENTRY_EXTENSIONS = ['.js', '.mjs'] as const

/** 资源解析失败：携带实际路径与可执行修复指令，避免晦涩的 ENOENT 栈。 */
export class NikkiSyncAssetError extends Error {
  readonly path: string

  constructor(message: string, failedPath: string) {
    super(message)
    this.name = 'NikkiSyncAssetError'
    this.path = failedPath
  }
}

function requireNonBlank(value: string, label: string): string {
  const trimmed = value.trim()
  if (trimmed === '') {
    throw new NikkiSyncAssetError(`Expected non-empty ${label}, got "${value}"`, value)
  }
  return trimmed
}

/**
 * 入参校验 + 归一：打包态必须给 resourcesPath（不静默回落开发态），
 * projectRoot 恒为必填（所有解析都以它为兜底）。
 */
export function buildPackagingContext(input: {
  isPackaged: boolean
  resourcesPath?: string
  projectRoot: string
}): PackagingContext {
  const projectRoot = requireNonBlank(input.projectRoot, 'projectRoot')
  if (!input.isPackaged) {
    return { isPackaged: false, resourcesPath: '', projectRoot }
  }
  const resourcesPath = requireNonBlank(input.resourcesPath ?? '', 'resourcesPath')
  return { isPackaged: true, resourcesPath, projectRoot }
}

/** 取 specifier 的包目录名（非法形态直接拒绝，不进入任何文件系统调用）。 */
function packageNameOf(specifier: string): string {
  const value = requireNonBlank(specifier, 'specifier')
  if (!SPECIFIER_PATTERN.test(value)) {
    throw new NikkiSyncAssetError(
      `Illegal NikkiSync specifier "${specifier}"; expected ${PACKAGE_SCOPE_PREFIX}<lowercase-hyphen-name> ` +
        '(no path separators, no traversal, no scope-external package names)',
      specifier
    )
  }
  return value.slice(PACKAGE_SCOPE_PREFIX.length)
}

/**
 * 解析包根目录。
 * 开发态：`<projectRoot>/node_modules/@nikkisync/<name>`（链接由 npm run link:nikkisync 建立）。
 * 打包态：优先 `<resourcesPath>/app.asar.unpacked/node_modules/...`（真实文件），
 * 不存在时回落 `<resourcesPath>/app.asar/node_modules/...` 并标记 fellBackToAsar。
 */
export function resolveModuleRoot(
  specifier: string,
  context: PackagingContext,
  exists: (candidate: string) => boolean = existsSync
): ModuleRootResolution {
  const packageName = packageNameOf(specifier)
  if (!context.isPackaged) {
    return {
      root: path.join(context.projectRoot, 'node_modules', PACKAGE_SCOPE_PREFIX + packageName),
      fellBackToAsar: false
    }
  }
  const unpacked = path.join(
    context.resourcesPath,
    ASAR_UNPACKED_DIR_NAME,
    'node_modules',
    PACKAGE_SCOPE_PREFIX + packageName
  )
  if (exists(unpacked)) return { root: unpacked, fellBackToAsar: false }
  return {
    root: path.join(
      context.resourcesPath,
      ASAR_FILE_NAME,
      'node_modules',
      PACKAGE_SCOPE_PREFIX + packageName
    ),
    fellBackToAsar: true
  }
}

/** 由包根推出可被 `import()` 的 file:// URL（打包态兜底装载用）。 */
export function resolveEntryUrl(root: string): string {
  const value = requireNonBlank(root, 'module root')
  return pathToFileURL(path.resolve(value, ...ENTRY_REL)).href
}

/**
 * 由包根推出**深入口**的 file:// URL（阶段 2：`server/row-mappers.js` 不在上游桶导出内）。
 *
 * 为什么只走 URL 而不是 bare 子路径：`@nikkisync/{core,database,protocol}` 的 `exports`
 * 只暴露 `"."`，deep 子路径会撞 ERR_PACKAGE_PATH_NOT_EXPORTED；打包态还需要 `app.asar.unpacked`
 * 真实落点。两处都由调用方以变量式 `await import(url)` 装载，保持「不被折叠成 require」的护栏。
 *
 * 段清单校验（全部为纯字符串判定，不触磁盘）：非空、无点段、无分隔符、无通配/非 ASCII，
 * 末段必须是 `.js` / `.mjs` —— 避免把 migrations SQL 或任意文件包成可装载 URL。
 */
export function resolveDeepEntryUrl(root: string, segments: readonly string[]): string {
  const value = requireNonBlank(root, 'module root')
  if (segments.length === 0) {
    throw new NikkiSyncAssetError(
      'resolveDeepEntryUrl: empty segment list; expected at least one path segment under dist/src',
      ''
    )
  }
  const checked: string[] = []
  for (const segment of segments) {
    const trimmed = segment.trim()
    if (
      trimmed === '' ||
      trimmed === '.' ||
      trimmed === '..' ||
      !DEEP_SEGMENT_PATTERN.test(trimmed)
    ) {
      throw new NikkiSyncAssetError(
        `resolveDeepEntryUrl: illegal segment "${segment}"; segments must be plain relative names ` +
          '(no ".", "..", separators, wildcards or non-ASCII characters)',
        segment
      )
    }
    checked.push(trimmed)
  }
  const leaf = checked[checked.length - 1]!.toLowerCase()
  if (!DEEP_ENTRY_EXTENSIONS.some((extension) => leaf.endsWith(extension))) {
    throw new NikkiSyncAssetError(
      `resolveDeepEntryUrl: leaf "${checked[checked.length - 1]}" is not a .js or .mjs artifact; ` +
        'only compiled ESM entries under dist/src can be loaded',
      checked.join('/')
    )
  }
  return pathToFileURL(path.resolve(value, ...DEEP_ENTRY_REL, ...checked)).href
}

/** 由包根推出 migrations SQL 的绝对路径（显式传给 DatabaseManager.initialize）。 */
export function resolveMigrationsSqlPath(root: string): string {
  const value = requireNonBlank(root, 'module root')
  return path.resolve(value, ...MIGRATIONS_REL)
}

/**
 * 读取 schema SQL 文本。空文本与读取失败都归一为 NikkiSyncAssetError，
 * 消息里同时给出链接侧与 NikkiSync 侧的修复命令，以及实际尝试过的绝对路径。
 */
export function readMigrationsSql(
  sqlPath: string,
  readFile: (target: string) => string = (target) => readFileSync(target, 'utf8')
): string {
  const value = requireNonBlank(sqlPath, 'migrations sql path')
  let text: string
  try {
    text = readFile(value)
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new NikkiSyncAssetError(
      `Failed to read NikkiSync schema SQL at ${value}: ${reason} | ` +
        'fix: run `npm run link:nikkisync` in WXNN XiangCe and `npm run build` in NikkiSync',
      value
    )
  }
  if (text.trim() === '') {
    throw new NikkiSyncAssetError(
      `NikkiSync schema SQL at ${value} is empty; NikkiSync has not been built ` +
        '(run `npm run build` in NikkiSync, then `npm run link:nikkisync` in WXNN XiangCe)',
      value
    )
  }
  return text
}
