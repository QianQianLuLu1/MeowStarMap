/**
 * 打包前产物时序与修复点校验脚本
 *
 * 防止"dist/main 过时导致打包基于旧代码"问题再次发生。
 * 在 npm run dist:win 前自动执行，任一校验失败则退出码 1 阻止打包。
 *
 * 用法：npx tsx scripts/pre-dist-check.ts
 */
import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')

const DIST_MAIN = path.join(ROOT, 'dist', 'main', 'main')
const DIST_RENDERER = path.join(ROOT, 'dist', 'renderer')
const SRC_MAIN = path.join(ROOT, 'src', 'main')
const SRC_SHARED = path.join(ROOT, 'src', 'shared')
const SRC_RENDERER = path.join(ROOT, 'src', 'renderer')

let failed = false

function fail(msg: string): void {
  console.error(`  ✖ ${msg}`)
  failed = true
}

function pass(msg: string): void {
  console.log(`  ✔ ${msg}`)
}

/** 跳过行：不影响退出码，用于“当前环境不适用”的断言（不把未建链伪装成已验证）。 */
function skip(msg: string): void {
  console.log(`  ⊘ ${msg}`)
}

function getMtime(filePath: string): Date | null {
  try {
    const stat = fs.statSync(filePath)
    return stat.mtime
  } catch {
    return null
  }
}

function getLatestSourceMtime(dirs: string[], extensions: string[]): Date | null {
  let latest: Date | null = null
  const walk = (d: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue
        if (!extensions.some((ext) => entry.name.endsWith(ext))) continue
        const m = getMtime(full)
        if (m && (!latest || m.getTime() > latest.getTime())) latest = m
      }
    }
  }
  for (const dir of dirs) walk(dir)
  return latest
}

function fileContains(filePath: string, pattern: string): boolean {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    return content.includes(pattern)
  } catch {
    return false
  }
}

// 在目录内递归检索所有 .js 文件是否含 pattern（electron-vite main 为 rollup 多 chunk 打包，
// 标记字符串可能落在 application.js / scanner-worker.js 等任一 chunk，不能再只 grep index.js）
function dirContains(dir: string, pattern: string): boolean {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (dirContains(full, pattern)) return true
    } else if (e.isFile() && e.name.endsWith('.js') && fileContains(full, pattern)) {
      return true
    }
  }
  return false
}

// 6/7. renderer 入口 chunk：从 dist/renderer/index.html 的 <script type=module src> 解析，
// 不再硬编码 main-*.js（electron-vite renderer 块产出 index-*.js，旧 root vite.config.ts 产出 main-*.js）。
function findRendererMainJs(): string | null {
  try {
    const html = fs.readFileSync(path.join(DIST_RENDERER, 'index.html'), 'utf-8')
    const moduleScript =
      html.match(/<script[^>]*type=["']module["'][^>]*\ssrc=["']([^"']+\.js)["']/i) ||
      html.match(/<script[^>]*\ssrc=["']([^"']+\.js)["'][^>]*type=["']module["']/i)
    const src = moduleScript ? moduleScript[1] : null
    if (!src) return null
    return path.join(DIST_RENDERER, src.replace(/^\.?\//, ''))
  } catch {
    return null
  }
}

// 9. renderer 产物 index.html 不含 crossorigin（含则该 script 标签会被 CORS 拦截，打包后白屏）
function checkNoCrossoriginInRendererHtml(): void {
  const rendererHtml = path.join(DIST_RENDERER, 'index.html')
  if (!getMtime(rendererHtml)) {
    fail('dist/renderer/index.html 不存在，无法校验 crossorigin，请先执行 npm run build')
    return
  }
  if (fileContains(rendererHtml, 'crossorigin')) {
    fail(
      'renderer 产物 index.html 含 crossorigin，将导致打包后白屏，请先修复 electron.vite.config.ts 并重新 npm run build'
    )
  } else {
    pass('renderer 产物 index.html 不含 crossorigin')
  }
}

// 10. 主进程窗口路径回退层数正确（指向 ../../../renderer，层数不对则加载不到 renderer 白屏）
//     与第 4/5 项一致：main 为多 chunk 打包，字面量可能落在 app/ 下任一 chunk，需递归检索
function checkWindowManagerPathBacktrack(): void {
  if (!getMtime(path.join(DIST_MAIN, 'app'))) {
    fail('dist/main/main/app 目录不存在，请先执行 npm run build')
    return
  }
  if (dirContains(path.join(DIST_MAIN, 'app'), '../../../renderer')) {
    pass('主进程窗口路径回退层数正确')
  } else {
    fail('主进程窗口路径回退层数错误，白屏风险')
  }
}

// 11. pluggable-electron 仅允许动态 import()，静态 import 会导致打包后白屏
function checkPluggableElectronDynamicOnly(): void {
  const assetsDir = path.join(DIST_RENDERER, 'assets')
  let staticImportedFile: string | null = null
  try {
    const files = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js'))
    for (const f of files) {
      const content = fs.readFileSync(path.join(assetsDir, f), 'utf-8')
      const staticImported =
        content.includes("from'pluggable-electron/renderer'") ||
        content.includes('from "pluggable-electron/renderer"')
      if (staticImported) {
        staticImportedFile = f
        break
      }
    }
  } catch {
    fail('读取 dist/renderer/assets 失败，请先执行 npm run build')
    return
  }
  if (staticImportedFile) {
    fail('pluggable-electron 被静态 import，白屏风险')
  } else {
    pass('pluggable-electron 仅动态 import（无静态 import）')
  }
}

/**
 * 11.6 app:// 协议处理器使用 fs.readFile + Response，且显式设置 Content-Length
 *
 * 防止回归（两版历史缺陷都要防）：
 * - 旧实现 1：fs.readFile + new Response(Buffer) 缺 Content-Length → ERR_FAILED (-2)；
 * - 旧实现 2：net.fetch(pathToFileURL(filePath)) 走 Chromium 网络栈，主进程读
 *   app.asar 内文件无官方背书 → 线上实测 ERR_FAILED (-2) 白屏。
 * 当前实现：fs.readFile（fs 是官方明确支持 asar 的 Node API）+ Response，显式
 * Content-Type/Content-Length，两版缺陷均免疫。
 *
 * 校验方法：renderer-protocol 静态打入 dist/main/main/app/index.js。
 * 判据：index.js 含 'readFile'（fs 读取路径）且不含 'pathToFileURL'（net.fetch 方案
 * 标记，全库仅 renderer-protocol.ts 使用，其消失即 net.fetch 方案移除）。
 */
function checkRendererProtocolUsesFileResponse(): void {
  const mainIndexJs = path.join(DIST_MAIN, 'app', 'index.js')
  if (!getMtime(mainIndexJs)) {
    fail('dist/main/main/app/index.js 不存在，无法校验 app:// 协议实现，请先执行 npm run build')
    return
  }

  let content: string
  try {
    content = fs.readFileSync(mainIndexJs, 'utf-8')
  } catch {
    fail('读取 dist/main/main/app/index.js 失败，无法校验 app:// 协议实现')
    return
  }

  if (content.includes('readFile') && !content.includes('pathToFileURL')) {
    pass('app:// 协议处理器使用 fs.readFile + Response（显式 Content-Type/Content-Length）')
  } else {
    fail(
      'app:// 协议处理器未使用 fs.readFile 方案（index.js 无 readFile 或仍含 pathToFileURL），' +
        '可能存在 net.fetch 读 asar 失败或无 Content-Length 的 ERR_FAILED (-2) 白屏，' +
        '请检查 src/main/app/renderer-protocol.ts 并重新 npm run build'
    )
  }
}

// 11.5 主进程 index 产物：registerRendererProtocol() 调用必须位于 whenReady 回调内。
//     若它在模块顶层（whenReady 之前）被调用，protocol.handle 会访问 session.defaultSession
//     并同步抛 "Session can only be received when app is ready"，Electron 弹阻塞式模态框
//     导致打包产物启动挂起（本次修复的核心回归点）。按调用作用域断言，勿依赖精确行号。
function checkMainIndexProtocolInsideWhenReady(): void {
  const mainIndexJs = path.join(DIST_MAIN, 'app', 'index.js')
  let content: string
  try {
    content = fs.readFileSync(mainIndexJs, 'utf-8')
  } catch {
    fail('dist/main/main/app/index.js 不存在，无法校验 renderer 协议时序，请先执行 npm run build')
    return
  }
  // 定位 whenReady 回调起点（rollup 产物中 app.whenReady().then(...) 的 then 位置）
  const thenIdx = content.indexOf('.whenReady().then')
  if (thenIdx === -1) {
    fail('main 产物未找到 whenReady().then，renderer 协议时序无法确认，请先执行 npm run build')
    return
  }
  // 逐个排查 registerRendererProtocol() 调用：排除函数定义（function registerRendererProtocol()）
  const callRe = /registerRendererProtocol\(\)/g
  let m: RegExpExecArray | null
  let callInsideWhenReady = false
  while ((m = callRe.exec(content)) !== null) {
    const before = content.slice(Math.max(0, m.index - 12), m.index)
    if (/function\s*$/.test(before)) continue // 函数定义，非调用
    // 回调内的调用必然位于 whenReady().then 之后；顶层（whenReady 前）调用在其前
    if (m.index > thenIdx) callInsideWhenReady = true
  }
  if (callInsideWhenReady) {
    pass('registerRendererProtocol() 调用位于 whenReady 回调内')
  } else {
    fail(
      'main 产物中 registerRendererProtocol() 在模块顶层调用（whenReady 之前），启动会挂起，请检查 src/main/index.ts 并重新 npm run build'
    )
  }
}

function findGit(): string | null {
  // 优先使用 PATH 中的 git
  try {
    execSync('git --version', { stdio: 'pipe' })
    return 'git'
  } catch {
    // 回退到常见安装路径
    const candidates = [
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files\\Git\\bin\\git.exe',
      `${process.env.LOCALAPPDATA}\\Programs\\Git\\cmd\\git.exe`
    ]
    for (const p of candidates) {
      if (p && fs.existsSync(p)) return p
    }
    return null
  }
}

function checkGitClean(): boolean {
  const git = findGit()
  if (!git) {
    console.warn('  ⚠ 未找到 git，跳过 git clean 检查')
    return true
  }
  try {
    const output = execSync(`"${git}" status --porcelain`, {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    return output.trim().length === 0
  } catch {
    return false
  }
}

// ===== 新增：解包后原生二进制存在性校验 =====
// 在 electron-builder 产出 release 后执行，确认三大原生模块的运行时二进制
// 确实被解包进安装产物。仅做"存在性 + 路径"校验（R5：不在 Node 里 require，
// 否则 better-sqlite3 会因 ABI 差异误报失败）。
// 用法：tsx scripts/pre-dist-check.ts --verify-asar

/** 递归查找 release 下的 app.asar.unpacked 目录 */
function findAsarUnpacked(releaseDir: string): string | null {
  let found: string | null = null
  const walk = (d: string, depth: number): void => {
    if (found || depth > 6) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) {
        if (e.name === 'app.asar.unpacked') {
          found = full
          return
        }
        walk(full, depth + 1)
      }
    }
  }
  walk(releaseDir, 0)
  return found
}

/** 在 base 下的固定子路径中递归匹配文件名正则，返回首个命中（含 relative 路径用于日志） */
function findFirstFile(base: string, subDirs: string[], nameRe: RegExp): string | null {
  const dir = path.join(base, ...subDirs)
  let found: string | null = null
  const walk = (d: string): void => {
    if (found) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) {
        walk(full)
      } else if (nameRe.test(e.name)) {
        found = full
        return
      }
    }
  }
  walk(dir)
  return found
}

/** 解包后原生二进制存在性校验（发布前硬性闸门） */
function checkUnpackedNativeBinaries(): void {
  const releaseDir = path.join(ROOT, 'release')
  const unpackedRoot = findAsarUnpacked(releaseDir)
  if (!unpackedRoot) {
    fail('未找到 release/**/resources/app.asar.unpacked，请先执行 electron-builder 打包')
    return
  }
  const nm = path.join(unpackedRoot, 'node_modules')

  // 1) better-sqlite3：node-gyp 重建产物（由 npmRebuild 编译）
  const sqlite3 = path.join(nm, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
  if (fs.existsSync(sqlite3)) pass('better-sqlite3 二进制存在: ' + path.relative(ROOT, sqlite3))
  else fail('better-sqlite3 二进制缺失（npmRebuild 未重建？）: ' + path.relative(ROOT, sqlite3))

  // 2) sharp 运行时（N-API 预编译，平台包 @img/sharp-win32-x64）
  const sharpRuntime = findFirstFile(nm, ['@img', 'sharp-win32-x64', 'lib'], /\.node$/)
  if (sharpRuntime) pass('sharp 运行时二进制存在: ' + path.relative(ROOT, sharpRuntime))
  else fail('sharp 运行时二进制缺失（@img/sharp-win32-x64 未安装或被 asar 吞掉）')

  // 3) sharp libvips（sharp 运行时依赖，缺失则 sharp 加载失败）
  //    注意：libvips 提供的是原生 DLL（libvips-42.dll），不是 N-API 的 .node 文件
  const libvips = findFirstFile(
    nm,
    ['@img', 'sharp-libvips-win32-x64', 'lib'],
    /libvips.*\.(dll|so|dylib)$/
  )
  if (libvips) pass('sharp libvips 二进制存在: ' + path.relative(ROOT, libvips))
  else fail('sharp libvips 二进制缺失（@img/sharp-libvips-win32-x64 未安装）')

  // 4) koffi 预编译二进制（平台包 @koromix/koffi-win32-x64）
  const koffi = findFirstFile(nm, ['@koromix', 'koffi-win32-x64'], /koffi\.node$/)
  if (koffi) pass('koffi 二进制存在: ' + path.relative(ROOT, koffi))
  else fail('koffi 二进制缺失（@koromix/koffi-win32-x64 未安装，检查 npm 是否带 --no-optional）')

  // 5) VC++ 2015-2022 运行库 DLL（better-sqlite3/koffi/sharp/libvips 动态链接，干净 Windows 缺之即静默崩溃）
  //    afterPack 钩子已将这 4 个 DLL 复制到与 electron.exe 同级的 appOutDir 根。
  //    appOutDir = <app.asar.unpacked 的上两级目录>（.../resources/app.asar.unpacked → .../appName-x64）。
  const appOutDir = path.dirname(path.dirname(unpackedRoot))
  const vcDlls = ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'concrt140.dll']
  for (const dll of vcDlls) {
    const p = path.join(appOutDir, dll)
    if (fs.existsSync(p)) pass('VC++ 运行库随包: ' + dll)
    else fail('VC++ 运行库缺失（afterPack 未复制？）: ' + path.relative(ROOT, p))
  }

  // 6) @nikkisync（阶段 9 · 问题 3）：自包含方案后它不是声明依赖，只能靠
  //    build.files 的 `node_modules/@nikkisync/**/*` 显式入包，再经 asarUnpack 解出。
  //    未建链的开发机不会命中本项，此时输出 SKIP 而不是假通过。
  const nikkisyncRoot = path.join(nm, '@nikkisync')
  if (!fs.existsSync(nikkisyncRoot)) {
    skip('@nikkisync 未随包（开发机未 `npm run link:nikkisync` 时属预期）')
    skip(
      '要复验打包态 ESM/migrations：先 npm run link:nikkisync + NikkiSync npm run build，再 npx electron-builder --dir'
    )
    return
  }
  const nikkiSchema = path.join(nikkisyncRoot, 'database', 'migrations', '0001_initial.sql')
  if (fs.existsSync(nikkiSchema)) {
    pass('@nikkisync 迁移 SQL 已解包: ' + path.relative(ROOT, nikkiSchema))
  } else {
    fail(
      '@nikkisync 已入包但缺 migrations/0001_initial.sql（asarUnpack 未覆盖或 NikkiSync 未 build）: ' +
        path.relative(ROOT, nikkiSchema)
    )
  }
  for (const pkgName of ['core', 'database', 'protocol', 'pc-companion']) {
    const entry = path.join(nikkisyncRoot, pkgName, 'dist', 'src', 'index.js')
    if (fs.existsSync(entry)) pass(`@nikkisync/${pkgName} 入口已解包`)
    else
      fail(
        `@nikkisync/${pkgName} 缺 dist/src/index.js（装载缝会在此抛 ERR_MODULE_NOT_FOUND）: ` +
          path.relative(ROOT, entry)
      )
  }
  // 阶段 2 深入口：内嵌层的协议 DTO 映射不在上游桶导出内，靠 file:// URL 直接装载，
  // 打包态必须确认该产物真的随包解出（缺它则 nikkisync:get-assets 等查询全部不可用）。
  const rowMappers = path.join(
    nikkisyncRoot,
    'pc-companion',
    'dist',
    'src',
    'server',
    'row-mappers.js'
  )
  if (fs.existsSync(rowMappers)) pass('@nikkisync/pc-companion 深入口 row-mappers.js 已解包')
  else
    fail(
      '@nikkisync/pc-companion 缺 dist/src/server/row-mappers.js（内嵌查询面无法产出协议 DTO）: ' +
        path.relative(ROOT, rowMappers)
    )

  // 阶段 3：同步服务器（nikkisync:start-server）依赖的两个产物。
  // 其中 wechat/GalleryRuntime.mjs 由 esbuild 步骤生成、被上游 gitignore，
  // `tsc` 单跑不会产出它 —— 缺它则 LocalSyncServer 装载即失败，只有产物级断言能拦住。
  const syncArtifacts: Array<[string, string]> = [
    ['dist/src/server/LocalSyncServer.js', '同步服务器本体'],
    ['dist/src/wechat/GalleryRuntime.mjs', 'LocalSyncServer 的静态依赖（esbuild 产物）']
  ]
  for (const [relative, purpose] of syncArtifacts) {
    const target = path.join(nikkisyncRoot, 'pc-companion', ...relative.split('/'))
    if (fs.existsSync(target)) pass(`@nikkisync/pc-companion ${relative} 已解包（${purpose}）`)
    else
      fail(
        `@nikkisync/pc-companion 缺 ${relative}（${purpose}；局域网同步服务将无法启动，` +
          `修复：在 NikkiSync 跑完整 npm run build 后重新打包）: ` +
          path.relative(ROOT, target)
      )
  }
}

// ===== 原生模块 ABI 一致性闸门（防 NODE_MODULE_VERSION 错位）=====
// 原生模块的 NODE_MODULE_VERSION(ABI) 是 Electron 版本的确定函数（1:1 映射）。
// 因此"构建产物 ABI == 运行时 Electron ABI"等价于"打包所用 Electron == package.json 声明的精确版本"。
// 本闸门在打包前（Node 环境）校验：声明版本与已安装版本恒等、npmRebuild 开启、asarUnpack 覆盖关键原生模块。
// 注：pre-dist-check 以 tsx(Node) 运行，此时 process.versions.modules 是构建 Node 的 ABI，并非 Electron ABI，
// 故不能在此直接比较 process.versions.modules 与 Electron ABI（否则必误报）；改用 Electron 版本恒等作为等价断言。
// 运行时真正的 ABI 一致性由 electron-builder 按该精确 Electron 重建原生模块 + asarUnpack 解包共同保证。
function unpackedCovers(unpack: unknown, mod: string): boolean {
  if (!Array.isArray(unpack)) return false
  return (unpack as string[]).some((p) => typeof p === 'string' && p.includes(mod))
}

function checkNativeAbiConsistency(): void {
  const pkgPath = path.join(ROOT, 'package.json')
  let pkg: {
    devDependencies?: Record<string, string>
    dependencies?: Record<string, string>
    build?: { npmRebuild?: boolean; asarUnpack?: unknown[] }
  }
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
  } catch {
    fail('无法读取 package.json，ABI 闸门跳过')
    return
  }
  const declared: string | undefined = pkg.devDependencies?.electron ?? pkg.dependencies?.electron
  if (!declared) {
    fail('package.json 未声明 electron 版本，原生模块 ABI 无法锁定')
    return
  }
  // 精确版本：禁止 ^ ~ > < 范围 / x 通配，否则安装到的 electron 可能与运行时不一致 → ABI 错位
  if (declared !== declared.replace(/[\^~><=*x\s]/g, '')) {
    fail(
      `electron 必须为精确版本（禁止 ^ ~ > < 范围/x），当前 "${declared}"。否则原生模块 ABI 可能错位，请改为如 "40.10.6" 的精确值`
    )
    return
  }

  const installedPkgPath = path.join(ROOT, 'node_modules', 'electron', 'package.json')
  let installed: string | null = null
  try {
    installed = JSON.parse(fs.readFileSync(installedPkgPath, 'utf-8')).version
  } catch {
    installed = null
  }
  if (!installed) {
    fail('node_modules/electron/package.json 不存在，请先执行 npm install 再打包')
    return
  }
  if (installed !== declared) {
    fail(
      `electron 版本不一致导致 ABI 错位风险：package.json 声明 "${declared}"，node_modules 实际 "${installed}"。请先 npm install 或统一版本后再打包`
    )
    return
  }

  if (pkg.build?.npmRebuild !== true) {
    fail('build.npmRebuild 不为 true，原生模块不会被按 Electron ABI 重建，ABI 错位风险')
    return
  }

  const need = ['better-sqlite3', 'koffi', 'sharp', '@img']
  const unpack = pkg.build?.asarUnpack ?? []
  const missing = need.filter((m) => !unpackedCovers(unpack, m))
  if (missing.length) {
    fail(
      `build.asarUnpack 未覆盖原生模块 ${missing.join(', ')}：asar 会吞掉 .node 二进制，运行时加载报 NODE_MODULE_VERSION 错`
    )
    return
  }

  pass(
    `原生模块 ABI 闸门通过：electron=${declared}，npmRebuild=true，asarUnpack 已覆盖 ${need.join('/')}`
  )
}

// ===== VC++ 运行库随包配置闸门（防“漏带运行库被发版”）=====
// afterPack 钩子把 VC++ 2015-2022 x64 运行库 DLL 复制到与 electron.exe 同级；
// 此处校验配置已接线且钩子脚本存在，把“干净 Windows 双击无响应”的前置条件在打包前卡住。
function checkVcRuntimeAfterPackConfigured(): void {
  const pkgPath = path.join(ROOT, 'package.json')
  let pkg: { build?: { afterPack?: string } }
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
  } catch {
    fail('无法读取 package.json，VC++ 随包配置闸门跳过')
    return
  }
  const afterPack = pkg.build?.afterPack
  if (typeof afterPack !== 'string' || afterPack.length === 0) {
    fail(
      'build.afterPack 未配置，VC++ 运行库不会随包，干净 Windows 将静默崩溃，请配置 scripts/after-pack-vc-runtime.cjs'
    )
    return
  }
  const hookPath = path.join(ROOT, afterPack)
  if (!fs.existsSync(hookPath)) {
    fail(`build.afterPack 指向的钩子脚本不存在: ${afterPack}`)
    return
  }
  pass(`VC++ 运行库随包钩子已接线: ${afterPack}`)
}

// ===== 管理员清单闸门（降杀软误杀 + 去 UAC 摩擦）=====
// requireAdministrator 清单是杀软强力启发式特征，且强制每次启动弹 UAC，
// 既增加误杀概率又造成"权限不足"错觉。本闸门在打包前 / 解包后均拦截该回归，
// 确保产物以 asInvoker 运行（默认当前用户身份，userData 属其可写位置）。
function checkNoAdminManifest(): void {
  const pkgPath = path.join(ROOT, 'package.json')
  let pkg: { build?: { win?: { requestedExecutionLevel?: string } } }
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
  } catch {
    fail('无法读取 package.json，管理员清单闸门跳过')
    return
  }
  const level = pkg.build?.win?.requestedExecutionLevel
  if (level === 'requireAdministrator') {
    fail(
      'build.win.requestedExecutionLevel 为 requireAdministrator：该清单是杀软强力启发式特征且强制 UAC，' +
        '请改为 "asInvoker"（默认当前用户身份运行，兼容多用户权限体系）。'
    )
    return
  }
  pass(`管理员清单闸门通过：requestedExecutionLevel=${level ?? '(缺省 asInvoker)'}`)
}

function main(): void {
  // 解包后校验模式：仅执行原生二进制存在性检查，不跑打包前 11 项
  if (process.argv.includes('--verify-asar')) {
    console.log('\n[pre-dist-check] 解包后原生二进制校验\n')
    checkUnpackedNativeBinaries()
    checkNoAdminManifest()
    console.log('')
    if (failed) {
      console.error('[pre-dist-check] ❌ 解包二进制校验失败，禁止发布。\n')
      process.exit(1)
    }
    console.log('[pre-dist-check] ✅ 解包二进制校验通过。\n')
    process.exit(0)
  }

  console.log('\n[pre-dist-check] 打包前产物校验\n')

  // 1. dist/main/main/app/index.js 存在（electron-vite main 单 bundle，原 per-file 布局已消失）
  const mainIndexJs = path.join(DIST_MAIN, 'app', 'index.js')
  const mainMtime = getMtime(mainIndexJs)
  if (!mainMtime) {
    fail(`dist/main/main/app/index.js 不存在，请先执行 npm run build`)
  } else {
    pass(`dist/main/main/app/index.js 存在 (mtime: ${mainMtime.toISOString()})`)
  }

  // 1.5 dist/main/main/preload.js 存在（electron-vite preload 块产出，window-manager.ts 硬编码引用）
  const preloadJs = path.join(DIST_MAIN, 'preload.js')
  const preloadMtime = getMtime(preloadJs)
  if (!preloadMtime) {
    fail(
      `dist/main/main/preload.js 不存在，请先执行 npm run build（preload 现由 electron-vite 产出）`
    )
  } else {
    pass(`dist/main/main/preload.js 存在 (mtime: ${preloadMtime.toISOString()})`)
  }

  // 1.6 各 utilityProcess worker 入口存在（打包后由 electron-vite 单独产出到 dist/main/main/app/，
  //     6 个 bridge 均用区分性文件名 fork；任一缺失 → worker 无法启动，扫描/缩略图/视频/解码等功能失效）
  const workerEntries = [
    'scanner-worker.js',
    'media-worker.js',
    'thumbnail-worker.js',
    'video-worker.js',
    'database-worker.js',
    'decryption-worker.js'
  ]
  for (const w of workerEntries) {
    const wp = path.join(DIST_MAIN, 'app', w)
    if (getMtime(wp)) {
      pass(`dist/main/main/app/${w} 存在`)
    } else {
      fail(
        `dist/main/main/app/${w} 不存在，worker 将无法 fork，请检查 electron.vite.config.ts 的 main entry 配置`
      )
    }
  }

  // 2. dist/renderer/index.html 存在
  const rendererHtml = path.join(DIST_RENDERER, 'index.html')
  const rendererMtime = getMtime(rendererHtml)
  if (!rendererMtime) {
    fail(`dist/renderer/index.html 不存在，请先执行 npm run build`)
  } else {
    pass(`dist/renderer/index.html 存在 (mtime: ${rendererMtime.toISOString()})`)
  }

  // 3. 产物比源码新（确保不是过时产物，替代旧的 main vs renderer 时间戳比较）
  if (mainMtime) {
    const mainSrcMtime = getLatestSourceMtime([SRC_MAIN, SRC_SHARED], ['.ts'])
    if (mainSrcMtime && mainMtime.getTime() >= mainSrcMtime.getTime()) {
      pass(`main 产物比源码新 (src latest: ${mainSrcMtime.toISOString()})`)
    } else if (mainSrcMtime) {
      fail(
        `main 产物比源码旧，需重新执行 npm run build (src: ${mainSrcMtime.toISOString()}, dist: ${mainMtime.toISOString()})`
      )
    }
  }
  if (rendererMtime) {
    const rendererSrcMtime = getLatestSourceMtime([SRC_RENDERER], ['.ts', '.tsx'])
    if (rendererSrcMtime && rendererMtime.getTime() >= rendererSrcMtime.getTime()) {
      pass(`renderer 产物比源码新 (src latest: ${rendererSrcMtime.toISOString()})`)
    } else if (rendererSrcMtime) {
      fail(
        `renderer 产物比源码旧，需重新执行 npm run build (src: ${rendererSrcMtime.toISOString()}, dist: ${rendererMtime.toISOString()})`
      )
    }
  }

  // 4. main 产物含 page min(0) 修复（media-handler 已被打包进 app/ 下某 chunk）
  if (dirContains(path.join(DIST_MAIN, 'app'), '.min(0)')) {
    pass('main 产物含 page min(0) 修复')
  } else {
    fail('main 产物不含 page min(0) 修复，需重新执行 npm run build')
  }

  // 5. main 产物含 repairLegacyDataV2 修复（scanner/worker-entry 现为独立入口 scanner-worker.js）
  if (dirContains(path.join(DIST_MAIN, 'app'), 'repairLegacyDataV2')) {
    pass('main 产物含 repairLegacyDataV2 修复')
  } else {
    fail('main 产物不含 repairLegacyDataV2 修复，需重新执行 npm run build')
  }

  // 6. renderer 产物 main-*.js 存在
  const rendererMainJs = findRendererMainJs()
  if (!rendererMainJs) {
    fail('dist/renderer/assets/main-*.js 不存在，需重新执行 npm run build')
  } else {
    pass(`renderer 产物存在: ${path.basename(rendererMainJs)}`)

    // 7. renderer 产物比 search-index.ts 源码新（确保含 recreateSearchIndex 修复）
    const searchIndexTs = path.join(SRC_RENDERER, 'search', 'search-index.ts')
    const srcMtime = getMtime(searchIndexTs)
    const distMtime = getMtime(rendererMainJs)
    if (srcMtime && distMtime && distMtime.getTime() >= srcMtime.getTime()) {
      pass('renderer 产物比 search-index.ts 源码新（含 recreateSearchIndex 修复）')
    } else if (srcMtime && distMtime) {
      fail(
        `renderer 产物比 search-index.ts 源码旧，需重新执行 npm run build (src: ${srcMtime.toISOString()}, dist: ${distMtime.toISOString()})`
      )
    }
  }

  // 8. git status clean（非阻断：仅警告，不调用 fail()）
  if (checkGitClean()) {
    pass('git status clean')
  } else {
    console.warn(
      '[pre-dist-check] ⚠️ git 工作区存在未提交改动，建议先提交再打包（仅警告，不阻断）。'
    )
  }

  // 9. renderer 产物 index.html 不含 crossorigin（白屏回归防护）
  checkNoCrossoriginInRendererHtml()

  // 10. 主进程窗口路径回退层数正确（白屏风险）
  checkWindowManagerPathBacktrack()

  // 11. pluggable-electron 仅动态 import（白屏风险）
  checkPluggableElectronDynamicOnly()

  // 11.5. renderer 协议注册必须在 whenReady 回调内（启动挂起回归防护）
  checkMainIndexProtocolInsideWhenReady()

  // 11.6. app:// 协议处理器使用 fs.readFile + Response（防 ERR_FAILED (-2) 回归）
  checkRendererProtocolUsesFileResponse()

  // 12. 原生模块 ABI 一致性闸门（防 NODE_MODULE_VERSION 错位）
  checkNativeAbiConsistency()

  // 12.5 VC++ 运行库随包钩子接线闸门（防“漏带运行库被发版”）
  checkVcRuntimeAfterPackConfigured()

  // 12.7 管理员清单闸门（降杀软误杀 + 去 UAC 摩擦，防 requireAdministrator 回归）
  checkNoAdminManifest()

  // 结果
  console.log('')
  if (failed) {
    console.error('[pre-dist-check] ❌ 校验失败，禁止打包。请修复上述问题后重试。\n')
    process.exit(1)
  } else {
    console.log('[pre-dist-check] ✅ 全部校验通过，可以执行打包。\n')
    process.exit(0)
  }
}

main()
