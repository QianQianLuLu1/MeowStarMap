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
    reason: '真实 chmod/stat 私钥文件，配套用例按 POSIX mode 位能力门控，钉 win32 会当场打死'
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

/**
 * 自带 `vi.mock('os')` 的测试文件：mock 遮蔽会让装置轴 3b 在这些文件里失效
 * （`importOriginal()` 给回的是未 mock 的原形），必须显式组合 `ciLinuxOsOverrides()`。
 * 不登记就会变成静默假信号——轴装着，这些文件却仍读真宿主 tmpdir。
 */
const RIG_COMPOSING_OS_TESTS: string[] = ['src/main/thumbnail/generator.limiter.test.ts']

/**
 * 自带 `vi.mock('fs')` / `vi.mock('fs/promises')` 且需要装置翻译层的测试文件：
 * 这类 mock 顶掉轴 4，工厂里若直接用 `importOriginal()` 拿到的是未翻译的真 fs，
 * 装置形态的 `/tmp/…` 于是变成盘相对路径（实测：readdir 落空、扫描零入库的静默假信号）。
 * 必须经 `ciLinuxFsLayer` 取回翻译层。
 */
const RIG_COMPOSING_FS_TESTS: string[] = [
  'src/main/scanner/__tests__/scan-traverse-timeout.test.ts'
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
      "vi.mock('os'",
      "vi.mock('node:os'",
      "vi.mock('fs'",
      "vi.mock('url'",
      "vi.mock('child_process'",
      "vi.mock('node:child_process'",
      // 轴 7：sqlite 的文件句柄不经轴 4 的 fs 翻译层，库路径必须由这一轴自己翻译，
      // 否则 linked 套件里的库会落到盘根（Windows 上目录不存在 ⇒ unable to open database file）
      "vi.mock('node:sqlite'",
      // 轴 6：sharp 的原生运行时 id 在首次装载时按 process.platform 算，
      // 预载必须排在轴 2 改写之前，否则装置里凡 import sharp 的文件整片收集失败
      "await import('sharp')"
    ]) {
      expect(setup, `装置缺少轴：${token}`).toContain(token)
    }
    const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> }
    expect(pkg.scripts?.['test:ci-linux']).toContain('vitest.ci-linux.config.ts')
    // POSIX 宿主（**不带装置**）复现装置：CI 红灯组合「装置未激活 + 宿主是 posix」的等价替身。
    // 它让「哨兵把宿主平台当常量」这一宿主漂移类缺陷在 Windows 开发机上也能判红；
    // 拆掉它，本仓就只剩「推到 CI 才看得见」这一条路。
    expect(existsSync(path.join(repoRoot, 'vitest.posix-host.config.ts'))).toBe(true)
    expect(existsSync(path.join(repoRoot, 'tests/posix-host.setup.ts'))).toBe(true)
    const posixHostRig = read('vitest.posix-host.config.ts')
    expect(posixHostRig, '复现配置必须叠上 posix 宿主 setup').toContain('tests/posix-host.setup.ts')
    expect(pkg.scripts?.['test:posix-host']).toContain('vitest.posix-host.config.ts')
  })

  it('装置轴 3b：自带 vi.mock(os) 的测试必须组合装置形态，不得把轴遮蔽掉', () => {
    for (const rel of RIG_COMPOSING_OS_TESTS) {
      const source = read(rel)
      expect(source, `${rel} 必须 mock 'os'`).toContain("vi.mock('os'")
      expect(source, `${rel} 必须组合 ciLinuxOsOverrides，否则 os.tmpdir() 仍是真宿主值`).toContain(
        'ciLinuxOsOverrides'
      )
    }
  })

  it('装置轴 4：自带 vi.mock(fs) 的测试必须经 ciLinuxFsLayer 取回翻译层', () => {
    for (const rel of RIG_COMPOSING_FS_TESTS) {
      const source = read(rel)
      expect(source, `${rel} 必须自带 fs mock`).toContain("vi.mock('fs")
      expect(source, `${rel} 必须组合 ciLinuxFsLayer，否则拿到的是未翻译的真 fs`).toContain(
        'ciLinuxFsLayer'
      )
    }
  })

  it('同绑定期望值：经 createRequire 装载的 .cjs，期望值不得用顶层 import 的 path 拼', () => {
    // 第 4 轮 RC-5：`.cjs` 走 createRequire ⇒ 拿宿主 path，而测试顶层 `import path` 会被
    // 装置轴 1 换成 posix，两侧各拼一种方言必然假红。钉 win32 也不是解（真 CI 上脚本用 posix）。
    // 判据落在源码形态上：必须有 require_('node:path') 的同绑定别名，且不得残留裸 path.join。
    const rel = 'scripts/__tests__/build-recycle-helper.test.ts'
    const source = read(rel)
    expect(source, `${rel} 必须从 require 图里取 path 作期望值绑定`).toContain(
      "require_('node:path')"
    )
    expect(stripComments(source), `${rel} 残留裸 path.join 期望值`).not.toMatch(/\bpath\.join\(/)
  })

  it('装置自检文件：哨兵不得拿 win32 形态常量当期望值，且自身不得被闸门挡住', () => {
    const rel = 'src/main/utils/ci-linux-emulation.test.ts'
    const source = read(rel)
    // run 39440507242 的红灯：哨兵用 `nodePath.sep === nodePath.win32.sep` 证明「真宿主」，
    // 该式只在 Windows 宿主成立，CI（ubuntu-latest）上恒红。真 Node 下
    // `path.posix.win32 === path.win32` 恒真、装置又会把 platform 改成 'linux'
    // ⇒「真宿主 vs 装置态」无法用任何环境取值区分，判据只能结构化。
    // 轴 1 里的 `nodePath.win32` / `nodePath.posix.win32` 是**引用**（且被 skipIf 闸门挡住），
    // 只有 `.win32.sep` 这类「宿主值 vs win32 形态常量」的比较才判违规。
    // 与本守卫其它判据同口径：注释里的反例说明不判违规（`stripComments` 的文本级剔除）
    expect(stripComments(source), `${rel} 出现宿主值 vs win32 形态常量的比较`).not.toContain(
      '.win32.sep'
    )
    // 反向钉住：装置轴仍靠 skipIf(!ACTIVE) 整件跳过；哨兵自身必须在两种 profile 下都跑
    expect(source).toContain('it.skipIf(!ACTIVE)')
    const sentinel = '装置未激活时本文件必须整件跳过'
    expect(source, `${rel} 少了哨兵用例`).toContain(sentinel)
    expect(source, `${rel} 的哨兵被闸门挡住了（那样它在 CI 上就成了空转）`).not.toContain(
      `it.skipIf(!ACTIVE)('${sentinel}`
    )
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
