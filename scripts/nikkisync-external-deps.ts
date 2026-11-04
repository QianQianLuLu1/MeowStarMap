/**
 * @nikkisync 装载面的外部依赖守护（纯函数层：零 I/O、零上游引用）。
 *
 * 背景（2026-11-04 装机日志实锤）：打包产物把 @nikkisync 经 asarUnpack 解到
 * `app.asar.unpacked/node_modules/@nikkisync` 分支，而其外部纯 JS 依赖（qrcode，
 * 经桶导出闭包 `server/index.js → LocalSyncServer.js → ../wechat/GalleryRuntime.mjs`
 * 静态 import）只进了 asar 内部的 node_modules。Node 的模块解析从 unpacked 文件
 * 向上走**真实目录树**，`app.asar` 是旁支文件，永远解析不到其中的 node_modules ⇒
 * `Cannot find package 'qrcode'` ⇒ 内嵌 Runtime 装配必败（同步图库扫描 / 照片目录
 * 保存全瘫）。既有闸门 `closureLoadChain` 只跟随**相对** import 边，bare import 不可见。
 *
 * 本模块补上这条缝，供两侧共用同一真相源：
 * - 开发态：`scripts/__tests__/nikkisync-unpacked-external-deps.test.ts` 断言
 *   package.json `build.asarUnpack` 覆盖每个外部依赖（防配置回归）；
 * - 打包态：`scripts/pre-dist-check.ts --verify-asar` 断言解包树里每个外部依赖
 *   目录真实存在（防上游新增 import 边而未 unpack 就出厂）。
 *
 * 判据刻意与 pre-dist-check 既有 `unpackedCovers` 同款（`pattern.includes(name)`）：
 * 本仓 asarUnpack 条目全部是「双星斜杠 + 包名或 scope + 双星斜杠」形态，包名包含
 * 判定即可覆盖，不引入 minimatch 依赖；形态若漂移，单测会随之转红提醒。
 *
 * 提取口径的三层过滤（每层都有实测依据，见 2026-11-04 排障记录）：
 * 1. 相对路径 / `node:`、`bun:` 内建 / `@nikkisync/*` 内部引用跳过；
 * 2. bare 形式的 Node 内建（`fs`、`stream`…）按 `node:module` 的 builtinModules
 *    跳过（qrcode/lib 大量 `require('fs')`）；
 * 3. 包名形态校验（无空白/括号/换行）：esbuild/browserify 打包产物里 `from ", "`
 *    这类正则误命中（GalleryRuntime.mjs 实测）一律拒绝。
 */

import { builtinModules } from 'node:module'

/** 被扫描的源文件（磁盘读取由调用方完成，本层保持可单测的纯函数）。 */
export interface NikkiSyncSourceFile {
  path: string
  content: string
}

/** ESM 形态：`import ... from '<spec>'` 与 `export ... from '<spec>'`。 */
const FROM_SPEC_RE = /\bfrom\s*['"]([^'"]+)['"]/g
/** CJS 形态：`require('<spec>')`。 */
const REQUIRE_SPEC_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
/** 动态字面量形态：`import('<spec>')`。 */
const DYNAMIC_SPEC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

const EXTRACT_RES = [FROM_SPEC_RE, REQUIRE_SPEC_RE, DYNAMIC_SPEC_RE] as const

/** 包名形态：字母或 @ 开头，后续仅允许包名字符集（拒绝空白、括号、换行等正则误命中）。 */
const PACKAGE_NAME_SHAPE_RE = /^[@A-Za-z][@A-Za-z0-9/._-]*$/

function isNodeBuiltin(specifier: string): boolean {
  const normalized = specifier.replace(/\/+$/, '')
  return (
    normalized.startsWith('node:') ||
    normalized.startsWith('bun:') ||
    builtinModules.includes(normalized)
  )
}

/**
 * 由任意 specifier 取其**包根名**：`@scope/name` 取前两段，普通包取首段
 * （`pako/lib/zlib/deflate.js` → `pako`——只要代码引用了子路径，包根就得可解析）。
 * 非包形态（相对路径、内建、空串）返回 undefined。
 */
export function packageRootOf(specifier: string): string | undefined {
  if (!specifier || specifier.startsWith('.') || isNodeBuiltin(specifier)) return undefined
  if (specifier.startsWith('@nikkisync/')) return undefined
  const segments = specifier.split('/')
  const root = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
  if (!root || !PACKAGE_NAME_SHAPE_RE.test(root)) return undefined
  return root
}

/** 提取一组文件里的全部模块 specifier（不做过滤，供闭包 BFS 跟随相对边复用）。 */
export function extractModuleSpecifiers(content: string): string[] {
  const found: string[] = []
  if (typeof content !== 'string') return found
  for (const re of EXTRACT_RES) {
    re.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = re.exec(content)) !== null) {
      const specifier = match[1]
      if (specifier) found.push(specifier)
    }
  }
  return found
}

/**
 * 提取一组文件里的外部 bare 依赖（包根名去重、排序，断言稳定）。
 * 误报方向安全：误命中的包只会让闸门更严（多 unpack 一个包），不会漏放；
 * 漏报仅见于变量式动态 import（如 @nikkisync/database 的 `node:sqlite` 判定，
 * 以内建落地，不在守护范围）。
 */
export function collectNikkiSyncExternalDeps(files: readonly NikkiSyncSourceFile[]): string[] {
  const found = new Set<string>()
  for (const file of files) {
    for (const specifier of extractModuleSpecifiers(file.content)) {
      const root = packageRootOf(specifier)
      if (root) found.add(root)
    }
  }
  return [...found].sort()
}

/**
 * 判定哪些外部依赖没被 asarUnpack 覆盖。
 * fail-safe：asarUnpack 不是数组、或条目不是非空字符串时，一律判「未覆盖」——
 * 闸门宁误拦不放过（缺判据不能当成全命中）。
 */
export function missingUnpackCoverage(
  externalDeps: readonly string[],
  asarUnpack: readonly unknown[]
): string[] {
  if (!Array.isArray(asarUnpack)) return [...externalDeps]
  const patterns = asarUnpack.filter(
    (pattern): pattern is string => typeof pattern === 'string' && pattern.length > 0
  )
  return externalDeps.filter((dep) => !patterns.some((pattern) => pattern.includes(dep)))
}

/** 递归扫描包产物时跳过的目录名：测试/示例目录不构成运行时解析面。 */
const SCAN_SKIP_DIRS = new Set(['node_modules', 'test', 'tests', '__tests__'])

/** 供调用方复用的目录过滤口径（与包扫描的跳过规则同源）。 */
export function isRuntimeScanSkippedDir(dirName: string): boolean {
  return SCAN_SKIP_DIRS.has(dirName)
}

/**
 * 运行期依赖闭包的读包端口（磁盘/解包树适配由调用方注入，本层零 I/O）：
 * `pkg` 为包根名；`relative` 为包内相对路径（POSIX 分隔）；不存在返回 undefined。
 * 返回的 `file.path` 必须等于传入的 `relative`（闭包 BFS 以它作为包内坐标跟随相对边）。
 */
export interface RuntimePackagePort {
  readPackageFile(pkg: string, relative: string): NikkiSyncSourceFile | undefined
}

function resolveMainEntry(packageJsonContent: string): string {
  try {
    const main = (JSON.parse(packageJsonContent) as { main?: unknown }).main
    if (typeof main === 'string' && main.trim() !== '') {
      return main.trim().replace(/^\.\//, '').replace(/\\/g, '/')
    }
  } catch {
    // 坏 JSON / 非 JSON：回落 index.js，闭包只少扫入口、不误报
  }
  return 'index.js'
}

/**
 * 解析 `from`（包内相对路径）文件里的相对 specifier 到候选包内相对路径
 * （CommonJS 扩展解析顺序：原样 → .js → .mjs → .cjs → 目录 index.js）。
 * 纯字符串运算，候选依次由调用方尝试读取。
 */
export function relativeCandidates(from: string, specifier: string): string[] {
  const base = posixDirname(from)
  const joined = normalizePosix(`${base}/${specifier}`)
  const candidates = [
    joined,
    `${joined}.js`,
    `${joined}.mjs`,
    `${joined}.cjs`,
    `${joined}/index.js`
  ]
  return [...new Set(candidates)]
}

function posixDirname(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx <= 0 ? '' : p.slice(0, idx)
}

function normalizePosix(p: string): string {
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

/**
 * 求外部依赖的**运行时传递闭包**：从种子出发，逐包从其 package.json `main` 入口
 * 沿相对 import/require 边 BFS（CommonJS 扩展解析），把途中出现的 bare import 并入，
 * 直到收敛。
 *
 * 为什么用主入口可达图而不是整包扫描：browserify 产物（pngjs/browser.js、
 * dijkstrajs）与 esbuild 打包文本里的正则误命中会把整个 node_modules 拖进闭包
 * （2026-11-04 实测）；而 Node 运行时真实加载的恰是「入口可达」的文件集。
 * bin/CLI 专用依赖（qrcode 的 yargs 只被 bin/qrcode.js 引用）不在可达图内，
 * 因此不需要 unpack——与人工 grep 的运行时依赖结论（dijkstrajs/pngjs/fs）一致。
 */
export function collectRuntimeDepClosure(
  seedDeps: readonly string[],
  port: RuntimePackagePort
): string[] {
  const closure = new Set<string>()
  const queue = [...seedDeps]
  while (queue.length > 0) {
    const pkg = queue.pop()
    if (pkg === undefined || closure.has(pkg)) continue
    closure.add(pkg)
    const packageJson = port.readPackageFile(pkg, 'package.json')
    if (!packageJson) continue
    const entry = resolveMainEntry(packageJson.content)
    const visited = new Set<string>()
    const stack: NikkiSyncSourceFile[] = []
    const entryFile = port.readPackageFile(pkg, entry)
    if (entryFile) stack.push(entryFile)
    while (stack.length > 0) {
      const file = stack.pop() as NikkiSyncSourceFile
      const relPath = normalizePosix(file.path)
      if (visited.has(relPath)) continue
      visited.add(relPath)
      for (const specifier of extractModuleSpecifiers(file.content)) {
        if (specifier.startsWith('.')) {
          for (const candidate of relativeCandidates(relPath, specifier)) {
            const next = port.readPackageFile(pkg, candidate)
            if (next) {
              stack.push(next)
              break
            }
          }
        } else {
          const root = packageRootOf(specifier)
          if (root && !closure.has(root)) queue.push(root)
        }
      }
    }
  }
  return [...closure].sort()
}
