/**
 * 测试侧「资源收尾」闸门（防回归：把「获取了资源却没无条件收尾」钉成可判定的红）。
 *
 * 为什么要有这个文件：本轮审查抓出两处**只在失败路径上才漏**的收尾缺陷，二者都不是断言写错，
 * 而是「收尾语句排在了可能中断它的位置」——
 *  - `src/main/nikkisync/runtime-facade.linked.test.ts` 的 K3 会话面用例把
 *    `await createRuntimeSession(...)` 写在 `try` **之外**，清理只在 `finally`。建库之后任一步抛错
 *    就把 180KB 的 `.db` 留在 `os.tmpdir()`，而该提交（`8c87ac3`）的立身目的正是「不再每轮留 180KB」。
 *  - `src/main/utils/fluent-ffmpeg-shim.test.ts` 的「幂等」用例把 `origSpy.mockRestore()` 放在末行，
 *    而该文件的 `afterEach` 只摘 `uncaughtException` 监听器、不还原 spy；`beforeEach` 的
 *    `vi.resetModules()` 注释自陈「外部化 fluent-ffmpeg 实例不受影响」⇒ 原型上强制抛 EFTYPE 的
 *    补丁跨用例存活，一条断言失败就会把串扰播给同文件后续用例（RC-9 那一类）。
 * 两类缺陷的共性是**happy path 全绿**，所以普通跑测永远看不见；只有把「收尾必须无条件执行」
 * 钉成结构判据才算真防线。
 *
 * 与同目录守卫的分工：`logger-escape-ledger.test.ts` 管「测试套件的 logger 落盘卫生」，
 * `path-semantics-guard.test.ts` 管「路径语义三档登记」，`typecheck-emit-isolation.test.ts` 管
 * 「emit 落点与闸门三面」；本文件管「获取—收尾的位置关系」，输入同样是被扫文件的源码文本，
 * 判据互不重叠。刻意不复用 JSON 台账：这张表只有两行且与代码同演进，内联更不容易与代码脱节
 * （同 `logger-escape-ledger.test.ts` 的取舍）。
 *
 * 本闸门能抓到什么、抓不到什么（勿夸大）：
 * - 抓到：表内站点的获取动作被移出 `try`、`finally` 里的收尾片段被删或改名、作用域标记丢失
 *   （判据失去锚点即判违规，绝不静默跳过）、表被悄悄扩容。
 * - 抓不到：表外新出现的「获取了资源却没无条件收尾」站点。这是封闭集的固有边界，补偿手段是
 *   §`MAX_TEARDOWN_ROWS` 的规模上限（超出即红、逼迫评审）与 `docs/manual-smoke-checklist.md`
 *   的跑测后临时目录核对；不要指望本文件自动发现同类新站点。
 *
 * 判定的实现边界（诚实交代）：作用域切分靠**花括号配平**，配平时会跳过字符串字面量与注释
 * （行注释与块注释两种形态），但不解析正则字面量与模板串插值。因此本表只收括号平衡的作用域；
 * 新站点入表前必须先用 §异常/§边界 的合成源码用例验证判定核不误判，再登记。
 *
 * 平台语义（项目约定 §6）：只做「文本结构判定」，路径一律以 URL 形态交给 fs 读取，相对键用
 * 正斜杠拼造，不读宿主分隔符语义、不引用户言引用 ⇒ Windows 开发机与 ubuntu-latest CI 跑同一
 * 判据，无须在 `path-semantics-guard.test.ts` 登记。行尾与 BOM 按 `/\r?\n/` 切行并剥首字符 BOM。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'

/** 仓库根：本文件在 scripts/__tests__/ 下，向上两级。全程以 URL 形态交给 fs，见文件头平台语义段 */
const REPO_BASE = new URL('../../', import.meta.url)

/** 表规模上限：防这张表长成第二份豁免清单，超出即红、逼迫评审 */
const MAX_TEARDOWN_ROWS = 4

interface TeardownRow {
  /** 相对仓库根、正斜杠；文件不存在即判违规，绝不静默跳过 */
  file: string
  /** 作用域锚点：`it(...)` 描述里的固定前缀，用于切出该用例体 */
  scopeMarker: string
  /** 获取动作的字面量（与 `git grep -F` 同义）：必须被包裹在带收尾的 try/finally 之内 */
  acquire: string
  /** 收尾片段：**全部**必须出现在 finally 段里（不是「任一」） */
  releaseAllOf: readonly string[]
  /**
   * 全文件级的合法替代形态（正则源串）：命中时即便位置判据不成立也放行。
   * 用来容纳「由 `afterEach` 统一还原桩」这种同样无条件的收尾写法，避免把实现细节钉成唯一形态。
   */
  altRelease?: string
  /** 中文真实理由：为什么这一处值得钉住 */
  reason: string
}

/**
 * 封闭登记表：只收「获取了真实资源（建库文件 / 覆写共享原型）且失败路径可能漏收尾」的站点。
 * 不碰 `fixtureRoot` 那类由文件级 `beforeAll`/`afterAll` 成对管理的资源——`afterAll` 本身就无条件。
 */
export const TEARDOWN_LEDGER: readonly TeardownRow[] = [
  {
    file: 'src/main/nikkisync/runtime-facade.linked.test.ts',
    scopeMarker: "it('会话面 resolveGameVersion",
    acquire: 'await createRuntimeSession(',
    releaseAllOf: ['dispose()', 'rmSync('],
    reason:
      '库文件落在 os.tmpdir() 而不是 fixtureRoot 里，文件级 afterAll 的 rmSync 扫不到它 ⇒ 只有本用例自己无条件收尾才不漏 180KB'
  },
  {
    file: 'src/main/utils/fluent-ffmpeg-shim.test.ts',
    scopeMarker: "it('幂等：重复调用 installFfmpegSpawnGuard",
    acquire: "vi.spyOn(proto, '_spawnFfmpeg')",
    releaseAllOf: ['mockRestore()'],
    altRelease: 'afterEach\\([\\s\\S]{0,200}?(mockRestore|restoreAllMocks)',
    reason:
      'fluent-ffmpeg 被外部化，原型补丁跨用例存活；桩不无条件还原就会把强制抛 EFTYPE 的形态带给后续用例'
  }
]

/** 读被跟踪文件的源码文本；文件缺失直接抛给调用侧判红，不返回空串伪装成「没有违规」 */
function readSource(relPath: string): string {
  const raw = fs.readFileSync(new URL(relPath, REPO_BASE), 'utf-8')
  // 约定 §5：源码必须 UTF-8 无 BOM；这里防御性剥掉，避免 BOM 混进判定文本影响锚点匹配
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
}

/**
 * 从 `openBraceIdx`（指向 `{`）配平到该块的闭括号，返回块的**结束下标**（闭括号之后一位）。
 * 跳过字符串字面量与注释，避免把 `'{未闭合` 这类文本里的括号算进深度。
 * 配平失败（语法本就残缺）返回 -1，调用侧按违规处理。
 */
function matchBlockEnd(source: string, openBraceIdx: number): number {
  let depth = 0
  let i = openBraceIdx
  while (i < source.length) {
    const ch = source[i]
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i)
      if (nl === -1) return -1
      i = nl + 1
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2)
      if (close === -1) return -1
      i = close + 2
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      i += 1
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2
          continue
        }
        if (source[i] === ch) break
        i += 1
      }
      i += 1
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i + 1
    }
    i += 1
  }
  return -1
}

/** 找到 `fromIdx` 之后第一个非空白字符的起始下标；越界返回 -1 */
function nextNonSpace(source: string, fromIdx: number): number {
  let i = fromIdx
  while (i < source.length && /\s/.test(source[i])) i += 1
  return i < source.length ? i : -1
}

/** 切出 scopeMarker 所在的 `it(...)` 用例体（含首尾花括号）；锚点丢失或配平失败返回 null */
function scopeBlock(source: string, scopeMarker: string): { text: string; offset: number } | null {
  const markerIdx = source.indexOf(scopeMarker)
  if (markerIdx === -1) return null
  const open = source.indexOf('{', markerIdx)
  if (open === -1) return null
  const end = matchBlockEnd(source, open)
  if (end === -1) return null
  return { text: source.slice(open, end), offset: open }
}

/** 单站点的收尾判定：返回违规描述清单，空数组即该站点合规 */
export function findTeardownViolations(source: string, row: TeardownRow): string[] {
  const violations: string[] = []
  const scope = scopeBlock(source, row.scopeMarker)
  if (!scope) {
    return [`缺少作用域锚点 ${row.scopeMarker}（判据失去锚点即违规，不得静默跳过）`]
  }
  const acquireIdx = scope.text.indexOf(row.acquire)
  if (acquireIdx === -1) {
    return [`作用域内找不到获取动作 ${row.acquire}（要么被改名、要么收尾判据已过时）`]
  }
  // 逐个候选 try：取「包住 acquire 的那个」——try 块必须同时满足起点在 acquire 之前、终点在 acquire 之后
  let enclosing: { tryIdx: number; finallySeg: string } | null = null
  let cursor = 0
  while (true) {
    const tryIdx = scope.text.indexOf('try', cursor)
    if (tryIdx === -1 || tryIdx > acquireIdx) break
    const open = scope.text.indexOf('{', tryIdx + 3)
    if (open === -1) break
    const tryEnd = matchBlockEnd(scope.text, open)
    cursor = open + 1
    if (tryEnd === -1 || tryEnd <= acquireIdx) continue
    const finallyKw = nextNonSpace(scope.text, tryEnd)
    if (finallyKw === -1 || !scope.text.startsWith('finally', finallyKw)) {
      enclosing = { tryIdx, finallySeg: '' }
      break
    }
    const finallyOpen = scope.text.indexOf('{', finallyKw + 'finally'.length)
    const finallyEnd = finallyOpen === -1 ? -1 : matchBlockEnd(scope.text, finallyOpen)
    enclosing = {
      tryIdx,
      finallySeg: finallyEnd === -1 ? '' : scope.text.slice(finallyOpen, finallyEnd)
    }
    break
  }
  if (!enclosing) {
    if (row.altRelease && new RegExp(row.altRelease).test(source)) return violations
    violations.push(`获取动作 ${row.acquire} 未被任何 try 包裹 ⇒ 失败路径上收尾语句不会执行`)
    return violations
  }
  for (const fragment of row.releaseAllOf) {
    if (!enclosing.finallySeg.includes(fragment)) {
      violations.push(`finally 段缺少无条件收尾 ${fragment}`)
    }
  }
  return violations
}

describe('测试侧收尾闸门（TEARDOWN_LEDGER）', () => {
  it('正常：表内每个真实站点都必须无条件收尾', () => {
    const offenders: string[] = []
    for (const row of TEARDOWN_LEDGER) {
      for (const violation of findTeardownViolations(readSource(row.file), row)) {
        offenders.push(`${row.file}：${violation}`)
      }
    }
    expect(offenders.join('\n'), offenders.join('\n')).toBe('')
  })

  it('正常：合成源码「建库在 try 内 + finally 里 dispose 且 rmSync」判绿', () => {
    const src = [
      "it('会话面 resolveGameVersion 合成形', async () => {",
      '  const f = join(tmpdir(), "a.db")',
      '  let s: Session | undefined',
      '  try {',
      '    s = await createRuntimeSession({ databaseFile: f }, surface)',
      "    expect(s.resolve('x')).toBe(1)",
      '  } finally {',
      '    s?.dispose()',
      '    rmSync(f, { force: true })',
      '  }',
      '})'
    ].join('\n')
    expect(findTeardownViolations(src, TEARDOWN_LEDGER[0]!)).toEqual([])
  })

  it('正常：合成源码「桩由 afterEach 统一还原」是同一种无条件收尾，判绿不误伤', () => {
    const src = [
      "describe('x', () => {",
      '  afterEach(() => {',
      '    vi.restoreAllMocks()',
      '  })',
      "  it('幂等：重复调用 installFfmpegSpawnGuard 只包裹一次原始方法', async () => {",
      "    const origSpy = vi.spyOn(proto, '_spawnFfmpeg').mockImplementation(() => {",
      '      throw new Error("EFTYPE")',
      '    })',
      '    expect(origSpy).toHaveBeenCalledTimes(1)',
      '  })',
      '})'
    ].join('\n')
    expect(findTeardownViolations(src, TEARDOWN_LEDGER[1]!)).toEqual([])
  })

  it('异常：获取动作写在 try 之外 ⇒ 必须点名（F1 的真实形状）', () => {
    const src = [
      "it('会话面 resolveGameVersion 合成形', async () => {",
      '  const f = join(tmpdir(), "a.db")',
      '  const s = await createRuntimeSession({ databaseFile: f }, surface)',
      '  try {',
      "    expect(s.resolve('x')).toBe(1)",
      '  } finally {',
      '    s.dispose()',
      '    rmSync(f, { force: true })',
      '  }',
      '})'
    ].join('\n')
    expect(findTeardownViolations(src, TEARDOWN_LEDGER[0]!).join('\n')).toContain(
      '未被任何 try 包裹'
    )
  })

  it('异常：try/finally 在位但 finally 丢了 rmSync ⇒ 必须点名缺的那一段（F2 的真实形状同族）', () => {
    const src = [
      "it('会话面 resolveGameVersion 合成形', async () => {",
      '  const f = join(tmpdir(), "a.db")',
      '  try {',
      '    const s = await createRuntimeSession({ databaseFile: f }, surface)',
      '    s.dispose()',
      '  } finally {',
      "    console.log('收尾被删了一半')",
      '  }',
      '})'
    ].join('\n')
    const violations = findTeardownViolations(src, TEARDOWN_LEDGER[0]!)
    expect(violations).toHaveLength(2)
    expect(violations.join('\n')).toContain('rmSync(')
    expect(violations.join('\n')).toContain('dispose()')
  })

  it('异常：try 后面根本没有 finally ⇒ 判违规，不许当成「已包裹就安全」', () => {
    const src = [
      "it('幂等：重复调用 installFfmpegSpawnGuard 只包裹一次原始方法', async () => {",
      '  try {',
      "    const origSpy = vi.spyOn(proto, '_spawnFfmpeg').mockImplementation(() => {",
      '      throw new Error("EFTYPE")',
      '    })',
      '    expect(1).toBe(1)',
      '  }',
      '})'
    ].join('\n')
    expect(findTeardownViolations(src, TEARDOWN_LEDGER[1]!).join('\n')).toContain(
      'finally 段缺少无条件收尾'
    )
  })

  it('边界：作用域锚点丢失（用例被改名或删掉）⇒ 判违规，不得静默跳过', () => {
    const src = "it('改了名字', async () => {\n  const s = await createRuntimeSession({}, x)\n})"
    expect(findTeardownViolations(src, TEARDOWN_LEDGER[0]!).join('\n')).toContain('缺少作用域锚点')
  })

  it('边界：字符串字面量里的花括号不参与配平（判定核不被文本内容骗到）', () => {
    const src = [
      "it('会话面 resolveGameVersion 合成形', async () => {",
      '  const weird = "{ 三个未闭合的花括号 {{{"',
      '  try {',
      '    const s = await createRuntimeSession({ databaseFile: f }, surface)',
      "    expect(weird).toContain('{')",
      '  } finally {',
      '    s?.dispose()',
      '    rmSync(f, { force: true })',
      '  }',
      '})'
    ].join('\n')
    expect(findTeardownViolations(src, TEARDOWN_LEDGER[0]!)).toEqual([])
  })

  it('边界：表规模不得超过上限（防这张表长成第二份豁免清单）', () => {
    expect(TEARDOWN_LEDGER.length).toBeLessThanOrEqual(MAX_TEARDOWN_ROWS)
    // 封闭集：同一文件不得出现两行同锚点，否则后一行会被前一条 indexOf 命中而静默失效
    const keys = TEARDOWN_LEDGER.map((row) => `${row.file}#${row.scopeMarker}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
