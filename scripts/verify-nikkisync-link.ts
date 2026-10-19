/**
 * NikkiSync 依赖链接只读诊断（整合阶段 1，阶段 9 起按自包含口径重写）。
 *
 * 铁律：本脚本只读，绝不 writeFile 改源码，也绝不装载 @nikkisync/*（那是主进程
 * runtime-loader 的职责）——这里只做"链接应该成立的事实"核查，用于在 import 失败时
 * 第一时间区分"依赖图逃逸仓库 / 没建链 / NikkiSync 没编译 / 宿主缺 node:sqlite"几类原因。
 *
 * 自包含口径（docs/sync-integration/09-legacy-debt-remediation-plan.md §1）：
 * - @nikkisync/* 不得再出现在 package.json 的依赖声明里（CI 只 checkout 本仓），
 *   出现即 blocking fail；
 * - 未建链是**受支持的默认态**（warn），装载缝与相关测试按 skip 处理；
 * - 已建链但产物不完整（缺 dist 编译产物 / 缺 migrations SQL）是 blocking fail。
 *
 * 用法：npm run verify:nikkisync [--json]
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { NIKKISYNC_PACKAGE_DIRS, resolveNikkiSyncRoot, toRootCandidates } from './link-nikkisync'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 四个包名（顺序与 NIKKISYNC_PACKAGE_DIRS 声明一致，供报告与测试固定）。 */
export const NIKKISYNC_PACKAGE_NAMES: readonly string[] = Object.keys(NIKKISYNC_PACKAGE_DIRS)

/** 主进程产物目录（折叠校验的作用域）。 */
const DIST_MAIN_APP_DIR = 'dist/main/main/app'

/** 打包产物里 NikkiSync 迁移 SQL 的期望位置（相对 app.asar.unpacked）。 */
const PACKED_MIGRATION_REL = path.join(
  'node_modules',
  '@nikkisync',
  'database',
  'migrations',
  '0001_initial.sql'
)

/**
 * 阶段 3：同步服务器额外依赖的 pc-companion 产物（相对包根）。
 * `server/LocalSyncServer.js` 由 `tsc` 产出；`wechat/GalleryRuntime.mjs` 由 esbuild 步骤
 * （`build:pc` 的前半段）产出且被上游 gitignore —— 后者缺失时 `LocalSyncServer` 一装载就
 * 抛 ERR_MODULE_NOT_FOUND，而 `dist/src/index.js` 存在与否看不出来。
 */
export const SYNC_SERVER_REQUIRED_ARTIFACTS: readonly string[] = [
  path.join('dist', 'src', 'server', 'LocalSyncServer.js'),
  path.join('dist', 'src', 'wechat', 'GalleryRuntime.mjs')
]

/**
 * 阶段 6：元数据解析依赖的两个 pc-companion 深入口产物（相对包根）。
 *
 * 为什么单独成一组而不并进 `SYNC_SERVER_REQUIRED_ARTIFACTS`：二者缺失的**修复动作与影响面
 * 不同**（缺 `GalleryRuntime.mjs` 是整条 `LocalSyncServer` 装载失败；缺本组只让元数据解析
 * 不可用），且本组符号**不在上游桶导出内** —— 正因为不在桶里，
 * `NIKKISYNC_REQUIRED_EXPORTS` 探针管不到它们（把桶外符号写进那张表会让探针在正确构建产物上
 * 误报红），产物存在性只能由这里承担。缺任一件 ⇒ `resolveDeepEntryUrl` 组出的 URL 404，
 * 运行期表现为 `ERR_MODULE_NOT_FOUND`。
 */
export const METADATA_REQUIRED_ARTIFACTS: readonly string[] = [
  path.join('dist', 'src', 'metadata', 'Nuan5CompatibleResolver.js'),
  path.join('dist', 'src', 'metadata', 'MetadataResolutionDiagnostics.js')
]

export interface NikkiSyncLinkFacts {
  /** 依赖图中指向仓库外的本地 spec（`file:../…` / `workspace:…`），必须为空。 */
  externalFileSpecs: string[]
  /** node_modules/@nikkisync/<name> 是否可解析（目录真实存在）。 */
  installedLinks: string[]
  /** 已链接包是否具备 dist/src/index.js + index.d.ts。 */
  builtArtifacts: string[]
  /** @nikkisync/database 的 migrations/0001_initial.sql 是否可读。 */
  migrationSqlPresent: boolean
  /** 链接目标目录列表（供日志展示实际指向）。 */
  linkTargets: string[]
  /** 当前进程 Node 主版本（node:sqlite 需 >= 24 才有稳定同步 API）。 */
  nodeMajor: number
  /** node:sqlite 是否可被当前进程 import。 */
  sqliteImportable: boolean
  /** 已安装 electron 的版本字符串（读不到为 undefined）。 */
  electronVersion?: string
  /** 主进程产物中 `require("@nikkisync` 命中数；null = 尚未构建产物（跳过判定）。 */
  buildFoldHits: number | null
  /** 打包产物内迁移 SQL 是否可读；null = 尚未打包（跳过判定）。 */
  packedMigrationsReadable: boolean | null
  /** 未建链时本地可解析出的 NikkiSync 检出根（复用 link-nikkisync 的候选链，避免两套真相源）。 */
  candidateRoot?: string
  /**
   * 阶段 3：`@nikkisync/pc-companion` 内同步服务器依赖、但不在 `tsc` 产物保证范围内的
   * 关键文件缺失清单（相对包根的路径）。缺 `wechat/GalleryRuntime.mjs` 时 `LocalSyncServer`
   * 整条链加载即失败（`LocalSyncServer.ts:7` 静态依赖它），而它由 esbuild 步骤生成、
   * 被上游 gitignore，因此必须单独点名，不能靠 `dist/src/index.js` 存在来推断。
   */
  syncServerArtifactsMissing?: string[]
  /**
   * 阶段 6：`@nikkisync/pc-companion` 内元数据解析依赖的深入口产物缺失清单（相对包根）。
   * 缺件 ⇒ 装载期 `ERR_MODULE_NOT_FOUND`；与 `syncServerArtifactsMissing` 分列，
   * 因为两者缺失时的修复语义不同（见 `METADATA_REQUIRED_ARTIFACTS` 注释）。
   */
  metadataArtifactsMissing?: string[]
}

export interface CheckResult {
  name: string
  ok: boolean
  detail: string
  /** warn 级条目不计入失败（未链接是受支持默认态；本机 Node 与 Electron 宿主版本面差异同此）。 */
  level?: 'fail' | 'warn'
}

/**
 * 纯函数：收集依赖图中逃逸仓库的本地 spec。
 * 入参形状宽松（只读三个声明面），便于真实 package.json 与夹具共用同一口径。
 */
export function collectOutOfRepoSpecs(pkg: Record<string, unknown>): string[] {
  const sections = ['dependencies', 'devDependencies', 'optionalDependencies'] as const
  const merged: Record<string, string> = {}
  for (const section of sections) {
    const block = pkg[section]
    if (block && typeof block === 'object') {
      Object.assign(merged, block as Record<string, string>)
    }
  }
  return Object.entries(merged)
    .filter(
      ([, spec]) =>
        typeof spec === 'string' && (spec.startsWith('file:../') || spec.startsWith('workspace:'))
    )
    .map(([name, spec]) => `${name}@${spec}`)
}

/** 纯函数：由事实表推导诊断结论（可单测，不触磁盘）。 */
export function evaluateNikkiSyncLink(facts: NikkiSyncLinkFacts): CheckResult[] {
  const checks: CheckResult[] = []
  const packageNames = NIKKISYNC_PACKAGE_NAMES
  const linked = facts.installedLinks.length > 0

  checks.push({
    name: 'dependency graph is self-contained (no out-of-repo file: specs)',
    ok: facts.externalFileSpecs.length === 0,
    detail: facts.externalFileSpecs.length
      ? `out-of-repo specs: ${facts.externalFileSpecs.join(', ')} — CI checks out this repo only, ` +
        'move them to `npm run link:nikkisync` (see docs/sync-integration/09-legacy-debt-remediation-plan.md)'
      : 'no file:../ or workspace: spec in any dependency section'
  })

  if (!linked) {
    checks.push({
      name: 'node_modules/@nikkisync/* links are installed',
      ok: true,
      level: 'warn',
      detail:
        'embedding lane inactive (no @nikkisync links); run `npm run link:nikkisync` to enable — ' +
        'this is a supported default state, tests and probe skip accordingly'
    })
  } else {
    const missingLinks = packageNames.filter((name) => !facts.installedLinks.includes(name))
    checks.push({
      name: 'node_modules/@nikkisync/* links are installed',
      ok: missingLinks.length === 0,
      // 半链接通常是手工删除或 npm 剪枝的结果：先告警，交由产物/SQL 两项做硬阻断
      level: 'warn',
      detail: missingLinks.length
        ? `missing links: ${missingLinks.join(', ')} (re-run \`npm run link:nikkisync\`)`
        : `installed: ${facts.installedLinks.join(', ')}`
    })
  }

  const missingArtifacts = packageNames.filter((name) => !facts.builtArtifacts.includes(name))
  checks.push({
    name: 'each linked package ships compiled dist/src/index.js + index.d.ts',
    ok: !linked || missingArtifacts.length === 0,
    detail: !linked
      ? 'skipped (no links present)'
      : missingArtifacts.length
        ? `not built: ${missingArtifacts.join(', ')} (run \`npm run build\` in NikkiSync)`
        : `all four packages are built; targets: ${facts.linkTargets.join(', ')}`
  })

  checks.push({
    name: '@nikkisync/database migrations/0001_initial.sql is readable',
    ok: !linked || facts.migrationSqlPresent,
    detail: !linked
      ? 'skipped (no links present)'
      : facts.migrationSqlPresent
        ? 'schema file reachable (DatabaseManager.initialize depends on it)'
        : 'schema file missing (run `npm run build` is not enough — check the linked directory layout)'
  })

  // 阶段 3：同步服务器的两个额外产物（GalleryRuntime.mjs 由 esbuild 生成且被上游 gitignore）。
  // 缺任一都会让 `server.start()` 那条链在装载期就抛 ERR_MODULE_NOT_FOUND，而 index.js 检查发现不了。
  if (facts.syncServerArtifactsMissing !== undefined) {
    checks.push({
      name: '@nikkisync/pc-companion ships the local sync server artifacts',
      ok: !linked || facts.syncServerArtifactsMissing.length === 0,
      detail: !linked
        ? 'skipped (no links present)'
        : facts.syncServerArtifactsMissing.length === 0
          ? `present: ${SYNC_SERVER_REQUIRED_ARTIFACTS.join(', ')}`
          : `missing: ${facts.syncServerArtifactsMissing.join(', ')} — run the full \`npm run build\` in NikkiSync (build:pc runs scripts/build-wechat-runtime.mjs before tsc; tsc alone does not emit GalleryRuntime.mjs)`
    })
  }

  // 阶段 6：元数据解析的两个深入口产物。两者都不在上游桶导出内，`NIKKISYNC_REQUIRED_EXPORTS`
  // 探针与 index.js 存在性判定都覆盖不到，只能在此点名；缺件时表现是装载期 ERR_MODULE_NOT_FOUND。
  if (facts.metadataArtifactsMissing !== undefined) {
    checks.push({
      name: '@nikkisync/pc-companion ships the metadata resolver artifacts',
      ok: !linked || facts.metadataArtifactsMissing.length === 0,
      detail: !linked
        ? 'skipped (no links present)'
        : facts.metadataArtifactsMissing.length === 0
          ? `present: ${METADATA_REQUIRED_ARTIFACTS.join(', ')}`
          : `missing: ${facts.metadataArtifactsMissing.join(', ')} — run \`npm run build\` in NikkiSync (tsc emits dist/src/metadata/*; a src-only checkout has none, and these two are deep entries outside the barrel)`
    })
  }

  checks.push({
    name: 'main-process bundles do not fold @nikkisync into require()',
    ok: facts.buildFoldHits === null || facts.buildFoldHits === 0,
    detail:
      facts.buildFoldHits === null
        ? `skipped (${DIST_MAIN_APP_DIR} not built yet; run \`npm run build\`)`
        : facts.buildFoldHits === 0
          ? `zero require("@nikkisync hits across ${DIST_MAIN_APP_DIR}/*.js`
          : `${facts.buildFoldHits} require("@nikkisync hit(s) in ${DIST_MAIN_APP_DIR}: the bundler folded the ESM graph into require(), which throws ERR_REQUIRE_ASYNC_MODULE at runtime`
  })

  const packedSkipReason = !linked
    ? 'skipped (embedding lane inactive; an existing release may predate linking — re-run this check after `npm run link:nikkisync` + a fresh build)'
    : 'skipped (no release/**/app.asar.unpacked; run `npx electron-builder --dir`)'
  checks.push({
    name: 'packed app.asar.unpacked ships @nikkisync/database migrations',
    // 只有“当前已链接 + 确实有打包产物 + 产物内缺 SQL”才是硬缺陷；
    // 未链接时残留的旧 release（如 2.5.5）不应被误判为失败。
    ok: facts.packedMigrationsReadable !== false || !linked,
    level: facts.packedMigrationsReadable === null || !linked ? 'warn' : 'fail',
    detail:
      facts.packedMigrationsReadable === null
        ? packedSkipReason
        : facts.packedMigrationsReadable
          ? `found ${PACKED_MIGRATION_REL} in the unpacked tree`
          : linked
            ? 'app.asar.unpacked exists but the @nikkisync schema file is missing (check build.files / asarUnpack)'
            : packedSkipReason
  })

  checks.push({
    name: 'a NikkiSync checkout is discoverable for linking',
    // 已建链时候选根无关（跳过）；未建链时只告诉用户一命令之隔还是需要先 clone——两种都不阻断。
    ok: linked || Boolean(facts.candidateRoot),
    level: 'warn',
    detail: linked
      ? 'skipped (links already in place; candidate root is irrelevant)'
      : facts.candidateRoot
        ? `found a usable checkout at ${facts.candidateRoot} — run \`npm run link:nikkisync\` to enable the embedding lane`
        : 'no NikkiSync checkout found in the candidate roots (NIKKISYNC_ROOT / ../NikkiSync / vendor/NikkiSync); ' +
          'clone it locally or export NIKKISYNC_ROOT, then run `npm run link:nikkisync`'
  })

  checks.push({
    name: 'diagnostic host can import node:sqlite',
    ok: facts.sqliteImportable,
    // 始终 warn：本脚本跑在本地 Node，而真正的应用宿主是 Electron（内置 Node 24）；
    // 此题只用于提醒"当前 shell 的 Node 偏旧"，不代表主进程装载会失败。
    level: 'warn',
    detail: facts.sqliteImportable
      ? `node:sqlite importable on node ${facts.nodeMajor}.x`
      : `node:sqlite NOT importable on node ${facts.nodeMajor}.x; the app host (Electron) must stay >= 24 — plain-Node scripts here are only diagnostic`
  })

  checks.push({
    name: 'installed electron version (the real runtime host)',
    ok: Boolean(facts.electronVersion),
    level: 'warn',
    detail: facts.electronVersion
      ? `electron ${facts.electronVersion}`
      : 'electron version unreadable'
  })

  return checks
}

/** 统计主进程产物中被折叠成 require 的 @nikkisync 引用数（产物不存在返回 null）。 */
export function countBuildFoldHits(rootDir: string): number | null {
  const dir = path.join(rootDir, DIST_MAIN_APP_DIR)
  if (!fs.existsSync(dir)) return null
  const pattern = /require\(["'`]@nikkisync\//g
  let hits = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue
    const text = fs.readFileSync(path.join(dir, entry.name), 'utf8')
    hits += text.match(pattern)?.length ?? 0
  }
  return hits
}

/** 在 release 下有限深度查找 app.asar.unpacked 目录（找不到返回 null）。 */
function findAsarUnpacked(releaseDir: string, maxDepth = 6): string | null {
  let found: string | null = null
  const walk = (dir: string, depth: number): void => {
    if (found || depth > maxDepth) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = path.join(dir, entry.name)
      if (entry.name === 'app.asar.unpacked') {
        found = full
        return
      }
      walk(full, depth + 1)
    }
  }
  walk(releaseDir, 0)
  return found
}

/** 打包产物内迁移 SQL 可读性：未打包返回 null。 */
export function packedMigrationsReadable(rootDir: string): boolean | null {
  const unpacked = findAsarUnpacked(path.join(rootDir, 'release'))
  if (!unpacked) return null
  return fs.existsSync(path.join(unpacked, PACKED_MIGRATION_REL))
}

/** 采集事实表（唯一的 I/O 面）。 */
export async function collectNikkiSyncLinkFacts(): Promise<NikkiSyncLinkFacts> {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >
  const externalFileSpecs = collectOutOfRepoSpecs(pkg)

  const installedLinks: string[] = []
  const builtArtifacts: string[] = []
  const linkTargets: string[] = []
  const databaseTargets: string[] = []
  const syncArtifactsMissing: string[] = []
  const metadataArtifactsMissing: string[] = []
  for (const [name, subpath] of Object.entries(NIKKISYNC_PACKAGE_DIRS)) {
    const linkDir = path.join(projectRoot, 'node_modules', name)
    if (!fs.existsSync(linkDir)) continue
    let targetDir: string
    try {
      // 以链接 realpath 为准（悬空 junction 已被上面的 existsSync 挡掉）
      targetDir = fs.realpathSync(linkDir)
    } catch {
      continue
    }
    installedLinks.push(name)
    linkTargets.push(`${name} -> ${targetDir}`)
    const jsEntry = path.join(targetDir, 'dist/src/index.js')
    const dtsEntry = path.join(targetDir, 'dist/src/index.d.ts')
    if (fs.existsSync(jsEntry) && fs.existsSync(dtsEntry)) builtArtifacts.push(name)
    if (name === '@nikkisync/database') databaseTargets.push(targetDir)
    if (name === '@nikkisync/pc-companion') {
      for (const artifact of SYNC_SERVER_REQUIRED_ARTIFACTS) {
        if (!fs.existsSync(path.join(targetDir, artifact))) syncArtifactsMissing.push(artifact)
      }
      for (const artifact of METADATA_REQUIRED_ARTIFACTS) {
        if (!fs.existsSync(path.join(targetDir, artifact))) metadataArtifactsMissing.push(artifact)
      }
    }
    void subpath
  }

  const migrationSqlPresent = databaseTargets.some((target) =>
    fs.existsSync(path.join(target, 'migrations/0001_initial.sql'))
  )

  // 候选根解析复用 link-nikkisync（同一优先级与同一必需子目录判定），避免两套真相源。
  const isDirectory = (candidate: string): boolean => {
    try {
      return fs.statSync(candidate).isDirectory()
    } catch {
      return false
    }
  }
  const candidateRoot =
    installedLinks.length === 0
      ? resolveNikkiSyncRoot(
          toRootCandidates({ projectRoot, envRoot: process.env.NIKKISYNC_ROOT }),
          isDirectory
        ).root
      : undefined

  let sqliteImportable = false
  try {
    await import('node:sqlite')
    sqliteImportable = true
  } catch {
    sqliteImportable = false
  }

  let electronVersion: string | undefined
  try {
    const electronPkg = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'node_modules/electron/package.json'), 'utf8')
    ) as Record<string, unknown>
    electronVersion = typeof electronPkg.version === 'string' ? electronPkg.version : undefined
  } catch {
    electronVersion = undefined
  }

  return {
    externalFileSpecs,
    installedLinks,
    builtArtifacts,
    migrationSqlPresent,
    linkTargets,
    nodeMajor: Number(process.versions.node.split('.')[0]),
    sqliteImportable,
    electronVersion,
    buildFoldHits: countBuildFoldHits(projectRoot),
    packedMigrationsReadable: packedMigrationsReadable(projectRoot),
    candidateRoot,
    syncServerArtifactsMissing: syncArtifactsMissing,
    metadataArtifactsMissing: metadataArtifactsMissing
  }
}

async function main(): Promise<void> {
  const asJson = process.argv.includes('--json')
  const checks = evaluateNikkiSyncLink(await collectNikkiSyncLinkFacts())
  const blocking = checks.filter(
    (check) => check.ok === false && (check.level ?? 'fail') === 'fail'
  )

  if (asJson) {
    console.log(JSON.stringify({ checks, ok: blocking.length === 0 }, null, 2))
  } else {
    console.log('[verify:nikkisync] NikkiSync dependency link diagnosis')
    for (const check of checks) {
      const mark = check.ok ? '✓' : check.level === 'warn' ? '⚠' : '✖'
      console.log(`  ${mark} ${check.name} — ${check.detail}`)
    }
    console.log(
      blocking.length === 0
        ? '[verify:nikkisync] OK (blocking failures: 0)'
        : `[verify:nikkisync] FAILED (${blocking.length} blocking failure(s))`
    )
  }

  process.exit(blocking.length === 0 ? 0 : 1)
}

const invokedDirectly = (): boolean => {
  const self = path.resolve(fileURLToPath(import.meta.url))
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : ''
  // Windows 盘符大写在两种入口下可能不一致，按小写比较
  return self.toLowerCase() === entry.toLowerCase()
}

if (invokedDirectly()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[verify:nikkisync] ✖ diagnosis crashed: ${message}`)
    process.exit(1)
  })
}
