/**
 * 路径语义守卫（防第三次栽同一个坑）
 *
 * 背景：本仓 CI 的 test / coverage job 在 ubuntu-latest 上跑单测，而产品只发布 Windows x64。
 * 凡是拿**宿主** `path` 绑定去解释 Windows 形态路径串的地方，两侧结论随宿主漂移。
 * 同一个根因已经栽过两次：黑名单侧 `utils/ipc-validate.ts` 早年钉了 win32，
 * 白名单侧 `ipc/validator.ts` 直到 2026-10-20 才补齐，而 `nikkisync/resource-allowlist.ts`
 * 里「按平台开关决定是否折叠大小写」是同一批漏项里的第三处。
 * 没有自动护栏，就会有第四次。取证与判据见
 * docs/plans/2026-10-20-fix-ci-linux-path-semantics-round2.md。
 *
 * 三档口径（本守卫把它机械化）：
 * 1. `PINNED`——串只当**键或比较**用 ⇒ 整模块钉 win32；
 * 2. `DIALECT`——同一函数两侧都会收到（库里的 `D:\Game` 与 `mkdtemp` 出来的 `/tmp/x`）
 *    ⇒ 必须走 `src/main/utils/path-dialect`；
 * 3. `HOST_IO`——串交给真实 fs / child_process ⇒ 保持宿主绑定，但必须写明理由。
 *
 * 铁律：只读。本文件不写任何文件，只 `readFileSync` 源码文本做判定，任何宿主都能跑。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 三档之外的例外：方言助手自己就是 win32/posix 的唯一引用点 */
const DIALECT_HELPER = 'src/main/utils/path-dialect.ts'

/** 档 1：比较层，整模块钉 win32 */
const PINNED: string[] = [
  'src/main/ipc/validator.ts',
  'src/main/ipc/handlers/_trash-utils.ts',
  'src/main/utils/ipc-validate.ts',
  'src/main/nikkisync/resource-allowlist.ts',
  'src/main/scanner/path-classifier.ts'
]

/** 档 2：混合输入，必须 import 方言助手 */
const DIALECT: string[] = [
  'src/main/scanner/uid-discovery.ts',
  'src/main/scanner/gameplayphotos-root.ts',
  'src/main/scanner/scan-channels.ts',
  'src/main/scanner/game-directory-discovery.ts',
  // media:// 的判定链：授权表与 DB 值都是 Windows 形态，归一必须跟着串的形态走
  'src/main/app/media-protocol.ts'
]

/** 档 3：保持宿主绑定的模块，逐条给理由（空理由或占位文案一律判红） */
const HOST_IO: Array<{ file: string; reason: string }> = [
  {
    file: 'src/main/scanner/worker-entry.ts',
    reason:
      '递归遍历与缩略图路径直接交给 readdir/stat 与 sharp，钉 win32 会在 Linux 上拼出反斜杠假路径'
  },
  {
    file: 'src/main/thumbnail/generator.ts',
    reason: '产出真实缓存文件路径并交给 sharp/fs 写入，属 IO 层'
  },
  {
    file: 'src/main/sync/identity-service.ts',
    reason: '含 it.skipIf(win32) 的真实文件系统用例，只在 Linux 侧执行，钉 win32 会当场打死'
  },
  {
    file: 'src/main/scanner/integrity-root-filter.ts',
    reason: 'SQL LIKE 侧已把两种分隔符归一再比，宿主绑定与判定两侧自洽'
  }
]

/**
 * 常驻 CI 复现桩的测试文件：把宿主 path 钉成 posix，使「撤掉生产侧 win32 钉」在
 * Windows 开发机上也会红（否则这类缺陷只有推到 CI 才看得见）。
 */
const HARNESS_TESTS: string[] = [
  'src/main/ipc/validator.test.ts',
  'src/main/nikkisync/resource-allowlist.test.ts',
  'src/main/scanner/game-directory-discovery.test.ts',
  'src/main/scanner/__tests__/resolve-gameplayphotos.test.ts',
  'src/main/scanner/__tests__/scan-channels.win32-root.test.ts'
]

/** 随宿主漂移即出错的语义调用；`extname` 两种方言结果相同，不在禁止之列 */
const HOST_SEMANTIC = /\bpath\.(join|resolve|dirname|basename|sep|isAbsolute|relative|normalize)\b/

/** 显式方言前缀（`path.win32.` / `path.posix.` / `nodePath.win32.`）先摘掉再判裸调用 */
const EXPLICIT_DIALECT = /\b(?:path|nodePath)\.(?:win32|posix)\./g

/** 整模块钉 win32 的别名写法：`const path = nodePath.win32` */
const ALIAS_PIN = /const\s+path\s*=\s*[\w.]*\bwin32\b/

const PLACEHOLDER_REASONS = [/^\s*$/, /待补/, /TBD/, /TODO/, /^原因$/, /批量占位/]

/**
 * 去掉注释行与块注释，避免把「解释为什么钉 win32」的说明文字当成违规调用。
 * 只做文本级剔除：本守卫不需要解析器，宁可漏判注释也不误判说明。
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
}

/** 找出一个文件里「裸宿主路径语义调用」所在的行 */
export function findBareHostPathCalls(source: string): string[] {
  const body = stripComments(source).replace(EXPLICIT_DIALECT, 'EXPLICIT_DIALECT.')
  if (ALIAS_PIN.test(body)) return []
  const hits: string[] = []
  for (const line of body.split('\n')) {
    if (HOST_SEMANTIC.test(line)) hits.push(line.trim())
  }
  return hits
}

/** 该文件是否显式引用了 win32（钉或方言助手引用） */
export function mentionsWin32Pin(source: string): boolean {
  const body = stripComments(source)
  return /\b(?:path|nodePath)\.win32\b/.test(body) || ALIAS_PIN.test(body)
}

export function importsDialectHelper(source: string): boolean {
  return stripComments(source).includes('utils/path-dialect')
}

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf-8')
}

describe('路径语义守卫（比较层钉 win32 / 混合输入走方言 / IO 层保宿主）', () => {
  it('登记表里的文件必须都存在（改名或删除要同步登记）', () => {
    for (const rel of [...PINNED, ...DIALECT, DIALECT_HELPER]) {
      expect(existsSync(path.join(repoRoot, rel)), `登记表文件不存在：${rel}`).toBe(true)
    }
    for (const entry of HOST_IO) {
      expect(existsSync(path.join(repoRoot, entry.file)), `HOST_IO 文件不存在：${entry.file}`).toBe(
        true
      )
    }
  })

  it('档 1：PINNED 每个文件都要有 win32 钉，且不得残留裸宿主路径语义调用', () => {
    for (const rel of PINNED) {
      const source = read(rel)
      expect(
        mentionsWin32Pin(source),
        `${rel} 丢了 win32 钉（path.win32 或 const path = *.win32）`
      ).toBe(true)
      expect(findBareHostPathCalls(source), `${rel} 残留裸宿主 path.* 调用`).toEqual([])
    }
  })

  it('档 2：DIALECT 每个文件都要 import 方言助手，且不得残留裸宿主路径语义调用', () => {
    for (const rel of DIALECT) {
      const source = read(rel)
      expect(importsDialectHelper(source), `${rel} 没有引用 ${DIALECT_HELPER}`).toBe(true)
      expect(findBareHostPathCalls(source), `${rel} 残留裸宿主 path.* 调用`).toEqual([])
    }
  })

  it('档 3：HOST_IO 每条理由必须真实存在（拒绝空理由与批量占位文案）', () => {
    for (const entry of HOST_IO) {
      expect(
        PLACEHOLDER_REASONS.some((re) => re.test(entry.reason)),
        `${entry.file} 的理由是占位文案`
      ).toBe(false)
      expect(entry.reason.length, `${entry.file} 的理由过短`).toBeGreaterThanOrEqual(12)
    }
  })

  it('覆盖面：src/main 下任何新钉 win32 或改用方言的文件都必须进登记表', () => {
    const registered = new Set<string>([...PINNED, ...DIALECT, DIALECT_HELPER])
    const drift: string[] = []
    for (const rel of listMainSourceFiles()) {
      if (registered.has(rel)) continue
      const source = read(rel)
      if (mentionsWin32Pin(source) || importsDialectHelper(source)) drift.push(rel)
    }
    expect(drift, '这些文件引入了 win32 钉/方言，却未登记到 PINNED/DIALECT').toEqual([])
  })

  it('CI 复现桩：登记的测试文件必须真的钉了 posix 宿主', () => {
    for (const rel of HARNESS_TESTS) {
      const source = read(rel)
      expect(source, `${rel} 必须引用 posix 宿主工厂`).toContain('posix-host-path')
      expect(source, `${rel} 必须同时 mock 'path'`).toContain("vi.mock('path'")
    }
  })

  it('装置与基座配置不得被悄悄拆掉', () => {
    expect(existsSync(path.join(repoRoot, 'vitest.ci-linux.config.ts'))).toBe(true)
    expect(existsSync(path.join(repoRoot, 'tests/ci-linux.setup.ts'))).toBe(true)
    const rig = read('vitest.ci-linux.config.ts')
    expect(rig).toContain('tests/ci-linux.setup.ts')
    const setup = read('tests/ci-linux.setup.ts')
    // 每一轴都要还在：拆掉任一轴，装置就不再是 CI 的替身，据它作的判据全部失效
    for (const token of [
      "vi.mock('path'",
      "process, 'platform'",
      "process, 'cwd'",
      'realOs.tmpdir = ',
      'realOs.homedir = ',
      "vi.mock('fs'",
      "vi.mock('url'"
    ]) {
      expect(setup, `装置缺少轴：${token}`).toContain(token)
    }
    const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> }
    expect(pkg.scripts?.['test:ci-linux']).toContain('vitest.ci-linux.config.ts')
  })

  it('electron 必须仍被基座别名到惰性替身（否则 CI 的 --ignore-scripts 会打死约 40 个文件）', () => {
    const config = read('vitest.config.ts')
    expect(config).toContain("electron: path.resolve(__dirname, './tests/mocks/electron-inert.ts')")
    expect(existsSync(path.join(repoRoot, 'tests/mocks/electron-inert.ts'))).toBe(true)
    // 单元里禁止再依赖真 electron 二进制：替身必须是「加载成功但 API 为 undefined」
    const inert = read('tests/mocks/electron-inert.ts')
    expect(inert).toContain('export const app: unknown = undefined')
  })

  // —— 自检：证明本守卫对目标缺陷有判别力（用合成源码，不把缺陷种进真文件）——
  describe('自检：判据对缺陷有判别力', () => {
    const clean =
      "import nodePath from 'path'\nconst path = nodePath.win32\nexport const a = path.resolve('x')\n"
    const explicit =
      "import path from 'path'\nexport const a = path.win32.dirname('D:\\\\a\\\\b')\n"

    it('正常：别名钉与显式 path.win32 都不判违规', () => {
      expect(findBareHostPathCalls(clean)).toEqual([])
      expect(findBareHostPathCalls(explicit)).toEqual([])
      expect(mentionsWin32Pin(clean)).toBe(true)
      expect(mentionsWin32Pin(explicit)).toBe(true)
    })

    it('红灯样本：把钉撤掉、留下裸宿主比较 ⇒ 必须报违规', () => {
      const regressed =
        "import path from 'path'\nexport function under(a: string, b: string) {\n  return path.resolve(a).startsWith(path.resolve(b) + path.sep)\n}\n"
      expect(mentionsWin32Pin(regressed)).toBe(false)
      expect(findBareHostPathCalls(regressed).length).toBeGreaterThan(0)
    })

    it('红灯样本：平台开关决定折叠大小写（resource-allowlist 那一类漏项）可被文本识别', () => {
      const gated =
        "import path from 'node:path'\nconst CASE = process.platform === 'win32'\nexport const k = (p: string) => (CASE ? path.resolve(p).toLowerCase() : path.resolve(p))\n"
      expect(importsDialectHelper(gated)).toBe(false)
      expect(mentionsWin32Pin(gated)).toBe(false)
    })

    it('边界：说明文字里的 path.join 例子不得判成违规（注释剔除）', () => {
      const commented =
        "import nodePath from 'path'\n// 反例：path.join('C:\\\\a','b') 在 Linux 上会拼出 C:\\a/b\nconst path = nodePath.win32\nexport const a = path.join('D:\\\\x', 'y')\n"
      expect(findBareHostPathCalls(commented)).toEqual([])
    })

    it('边界：extname 两种方言结果一致，不在禁止之列', () => {
      const source = "import path from 'path'\nexport const e = path.extname('a.jpg')\n"
      expect(findBareHostPathCalls(source)).toEqual([])
    })
  })
})

/** 递归列出 `src/main` 下的非测试 .ts 源文件（相对仓库根，斜杠分隔） */
function listMainSourceFiles(): string[] {
  const out: string[] = []
  const base = path.join(repoRoot, 'src', 'main')
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'types') continue
        walk(abs)
        continue
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue
      if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue
      out.push(path.relative(repoRoot, abs).split(path.sep).join('/'))
    }
  }
  walk(base)
  return out
}
