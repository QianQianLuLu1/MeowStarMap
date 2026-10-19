import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 类型检查产物落点契约测试：`tsc -b` 的 emit 不得写进 dist/main。
 *
 * 背景（docs/plans/2026-10-19-fix-e2e-smoke-dist-pollution.md）：
 * electron-vite 把 main 产物写到 dist/main/main/app/*、preload 写到 dist/main/main/preload.js，
 * 而 src/main/tsconfig.json 的 outDir 曾是同一个 dist/main。一次 `tsc -b`（npm run typecheck、
 * npm run verify、.husky/pre-commit Step 3 都会跑）就把 rollup bundle 覆写成 per-file CJS：
 * sandbox:true 的 preload 无法 require 兄弟文件 → window.electronAPI 整体为空；
 * 变量式 `import(specifier)` 被 TS 折叠成 `require()` → @nikkisync ESM 图装载即失败。
 * 于是 e2e:smoke 里走 launchBuiltApp() 的 NikkiSync N1 报 "Expected: function / Received: undefined"。
 *
 * 为什么不用 `tsc -b --noEmit`：被引用的 composite 项目不能禁 emit，
 * 根 tsconfig.json 会直接报 TS6310（实测），typecheck 与 CI 一起红。
 * 所以正确形态是「照常 emit，但把 outDir 迁出产物树」。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const mainTsconfigPath = path.join(repoRoot, 'src', 'main', 'tsconfig.json')

/** electron-vite 的产物树（posix，相对仓库根） */
const VITE_ARTIFACT_TREE = 'dist/main'
/** 本仓约定的类型检查 emit 隔离目录 */
const SANCTIONED_EMIT_ROOT = '.cache/tsmain'

/**
 * 纯函数：按 rootDir→outDir 映射算出源文件在 tsc 下的产物落点（posix、相对仓库根、取 .d.ts）。
 * 三个路径入参同以 configDir 为基准（与 tsconfig 自身的解析规则一致），sourceFile 须写成
 * 'preload.ts' 这类相对 configDir 的路径——按仓库根传 'src/main/preload.ts' 会二次拼接。
 */
function emitTargetFor(
  configDir: string,
  rootDir: string,
  outDir: string,
  sourceFile: string
): string {
  const absRoot = path.resolve(configDir, rootDir)
  const absOut = path.resolve(configDir, outDir)
  const absSource = path.resolve(configDir, sourceFile)
  const rel = path.relative(absRoot, absSource).replace(/\\/g, '/')
  const withoutExt = rel.replace(/\.ts$/, '')
  return path
    .join(absOut, `${withoutExt}.d.ts`)
    .replace(/\\/g, '/')
    .slice(repoRoot.length + 1)
}

/** 纯函数：target 是否落在 dir 这棵树内（dir 为 posix 相对路径） */
function isInsideTree(target: string, dir: string): boolean {
  const prefix = dir.replace(/\/+$/, '') + '/'
  return target.replace(/\\/g, '/').startsWith(prefix)
}

function readMainTsconfig(): { rootDir: string; outDir: string; composite: boolean } {
  // 严格 JSON.parse，不做 JSONC 兼容：scripts/__tests__/pre-dist-check.test.ts 也是这样读它的，
  // 一旦本文件出现 // 注释，那条既有用例会以 SyntaxError 红掉（本轮实测踩过）。
  const parsed = JSON.parse(readFileSync(mainTsconfigPath, 'utf-8')) as {
    compilerOptions: { rootDir?: string; outDir?: string; composite?: boolean }
  }
  const { rootDir = '', outDir = '', composite = false } = parsed.compilerOptions
  return { rootDir, outDir, composite }
}

describe('tsc -b 的 emit 必须与 electron-vite 产物树隔离', () => {
  it('自检：落点判定对两种形态的判别力', () => {
    // 旧形态（覆写产物树）必须被判定为「在里面」，否则本文件的守卫是恒真的假绿
    expect(isInsideTree('dist/main/main/preload.d.ts', VITE_ARTIFACT_TREE)).toBe(true)
    // 隔离形态必须被判定为「不在里面」
    expect(isInsideTree('.cache/tsmain/main/preload.d.ts', VITE_ARTIFACT_TREE)).toBe(false)
    // 边界：目录名相似但不是子树、带尾斜杠、空串
    expect(isInsideTree('dist/mainx/main/preload.d.ts', VITE_ARTIFACT_TREE)).toBe(false)
    expect(isInsideTree('dist/main/main/preload.d.ts', 'dist/main/')).toBe(true)
    expect(isInsideTree('', VITE_ARTIFACT_TREE)).toBe(false)
  })

  it('正常：preload 入口的类型检查产物不得落进 dist/main', () => {
    const { rootDir, outDir } = readMainTsconfig()
    expect(outDir).not.toBe('')
    const target = emitTargetFor(path.join(repoRoot, 'src', 'main'), rootDir, outDir, 'preload.ts')
    // 期望值由常量拼装，绝不用 emitTargetFor 的返回值反推（那会退化成恒真比较）
    expect(target).toBe(path.posix.join(SANCTIONED_EMIT_ROOT, 'main', 'preload.d.ts'))
    expect(isInsideTree(target, VITE_ARTIFACT_TREE)).toBe(false)
  })

  it('异常：outDir 回到 dist/main 时必须精确命中被覆写的那一个文件', () => {
    // 覆写态下 tsc 的声明产物正落在 electron-vite 写 preload.js 的同一路径上；
    // 断言只判「在 dist/main 里」会放过 rootDir 漂移等部分回归，故钉到完整落点。
    expect(
      emitTargetFor(path.join(repoRoot, 'src', 'main'), '../', '../../dist/main', 'preload.ts')
    ).toBe(`${VITE_ARTIFACT_TREE}/main/preload.d.ts`)
  })

  it('异常：emit 隔离目录必须是约定的 .cache/tsmain（不在 dist/ 与 build.files 之下）', () => {
    const { outDir, composite } = readMainTsconfig()
    const absOut = path.resolve(path.join(repoRoot, 'src', 'main'), outDir)
    const relOut = path.relative(repoRoot, absOut).replace(/\\/g, '/')
    // composite 是 project references 的硬要求，去掉会让根项目解析不到声明
    expect(composite).toBe(true)
    expect(relOut).toBe(SANCTIONED_EMIT_ROOT)
    expect(isInsideTree(relOut, 'dist')).toBe(false)
  })

  it('异常：不得改用 tsc -b --noEmit（被引用 composite 项目禁 emit 会触发 TS6310）', () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>
    }
    // 本机 core.autocrlf=true 时工作区为 CRLF，行尾断言前先归一（与 verify 的 --end-of-line auto 同口径）
    const hook = readFileSync(path.join(repoRoot, '.husky', 'pre-commit'), 'utf-8').replace(
      /\r\n/g,
      '\n'
    )
    const verifySrc = readFileSync(path.join(repoRoot, 'scripts', 'verify-changes.ts'), 'utf-8')
    // 三处调用点仍必须真的跑 build 模式类型检查（不许用「删掉检查」来消除污染）
    expect(pkg.scripts.typecheck).toContain('tsc -b')
    expect(hook).toContain('npx --no-install tsc -b\n')
    expect(verifySrc).toContain("'tsc', '-b'")
    // 且都不许带 --noEmit：加了它 typecheck 会以 TS6310 直接失败
    expect(pkg.scripts.typecheck).not.toContain('--noEmit')
    expect(hook).not.toContain('tsc -b --noEmit')
    expect(verifySrc).not.toMatch(/'tsc',\s*'-b',\s*'--noEmit'/)
  })

  it('闸门覆盖面：CI 必须对 e2e 层单独跑类型检查', () => {
    // 既有空档：npm run typecheck = tsc -b && tsc -p tsconfig.scripts.json，两者都收不到 e2e/
    // ——根 tsconfig 只 include src/renderer 与 src/common 并 reference src/main，
    // tsconfig.scripts.json 只收 scripts/。于是 e2e/** 的守卫与用例源码在 CI 上没有类型闸门，
    // 只能靠本机手动 npm run typecheck:e2e 兜住。
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>
    }
    const workflow = readFileSync(path.join(repoRoot, '.github', 'workflows', 'build.yml'), 'utf-8')
    // 闸门必须复用仓内既有脚本，不得在 workflow 里裸写一条 tsc 命令（两套口径会漂移）
    expect(pkg.scripts['typecheck:e2e']).toContain('-p e2e')
    expect(workflow).toContain('npm run typecheck:e2e')
    // 也不得为省事把 e2e 折进 typecheck：那要么给被引用的 composite 项目塞 --noEmit（TS6310），
    // 要么改掉本地 verify / pre-commit 的 tsc -b 覆盖面口径
    expect(pkg.scripts.typecheck).not.toContain('--noEmit')
  })

  it('边界：src/main/tsconfig.json 必须保持严格 JSON 可解析（不得加 // 注释）', () => {
    // 该文件被 scripts/__tests__/pre-dist-check.test.ts 用 JSON.parse 直读；
    // 加注释会让那条既有用例以 SyntaxError 红掉（本轮实测命中）。
    const raw = readFileSync(mainTsconfigPath, 'utf-8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  it('边界：dist/main 存在时，其中不得残留任何 .d.ts', () => {
    const distMain = path.join(repoRoot, 'dist', 'main')
    // 未 build 的环境（如某些 CI job）跳过，不把「没有产物」误判成「产物被污染」
    if (!existsSync(distMain)) {
      expect(existsSync(distMain)).toBe(false)
      return
    }
    const entries = readdirSync(distMain, { recursive: true, encoding: 'utf-8' })
    const found = entries.filter((name) => String(name).endsWith('.d.ts'))
    expect(found).toEqual([])
  })
})
