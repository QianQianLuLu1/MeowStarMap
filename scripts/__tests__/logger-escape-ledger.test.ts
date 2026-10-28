/**
 * logger 落盘逃逸台账闸门（防回归：把「测试套件会不会留下无人持有的真实写盘 reject」钉成可判定的红）。
 *
 * 为什么要有这个文件：`src/main/utils/logger.ts:222` 的 `writeLog()` 用
 * `fs.promises.appendFile(...).catch(err => console.error('[Logger] 写入失败:', err))` 兜底，
 * 这条 Promise 无人持有。凡是把 `app.getPath` 指到假路径、或把日志目录建在临时目录里又被删掉的套件，
 * 都会留下一批 `console.error`；若它排到环境拆解之后送达，worker 的 RPC 已关，Vitest 抛
 * `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending` 并**按未处理错误退出 1**。
 * 2026-10-28 CI 的 run 23 就是这么红的：`Test (shard 5/10)` 里 45 个文件全通过、1073 例通过 + 1 跳过、
 * **没有一条断言失败**，仍因 2 条这样的 rejection 退出 1。下一轮 `489ffbf` 只静默了 CI 点名的
 * `connection.test.ts`，把同类隐患登记成 DEBT-039 留给后一轮——本文件就是那一轮的回填：
 * 把「哪些套件静默了、静默了几处、哪一处是故意的」全部钉成封闭集，逃逸点增一处或静默点少一处都判红。
 *
 * 与同目录守卫的分工：`lock-advisory-floor.test.ts` 管「离线可判的依赖版本下限」，输入是 lock 数据；
 * `path-semantics-guard.test.ts` 管「路径语义三档登记」，输入是 `src/main` 的路径用法；本文件管
 * 「测试侧的 logger 落盘卫生」，输入是 `logger.ts` 与测试文件的源码文本。三者判据互不重叠。
 * 刻意不复用 `old-name-ledger.test.ts` 的 JSON 台账文件：那张表要逐文件记旧名命中数、体量会随更名收敛，
 * 本表只有十余行且与代码同演进，内联更不容易与代码脱节（同 `lock-advisory-floor.test.ts` 的取舍）。
 *
 * 反遮蔽锁的用意（与 `lock-advisory-floor.test.ts` 的互斥断言同源）：本类缺陷最省事的"修法"是删掉
 * `logger.ts` 的 `console.error` 或给 `tests/setup.ts` 装一条全局静默——前者会把磁盘满/权限错误的
 * 唯一告警渠道抹掉，后者会打死 `logger.test.ts` / `logger.enforce.test.ts` 对真实写盘语义的断言。
 * 因此 §1 钉住 logger.ts 的告警与 fire-and-forget 计数，§3 钉住 `tests/setup.ts` 恒为 0、
 * 真写盘名单不得被删短，且「同一文件不得同时躺在静默表与真写盘表」。
 *
 * 本闸门能抓到什么、抓不到什么（勿夸大）：
 * - 抓到：`logger.ts` 告警被删/被改词、`logger.ts` 新增第二条无人持有的 `appendFile().catch()`、
 *   已登记套件丢失静默或补装次数变化、`src/**` 出现台账外的 appendFile 静默、
 *   `logger.enforce.test.ts` 的夹具退回「目录只建一次」、环境卫生探针被删、`tests/setup.ts` 被加全局静默。
 * - 抓不到：某个套件**不改动 fs/appendFile 文本**却新产生真实写盘 reject（例如只把 `app.getPath`
 *   指向一个后续被删除的 mkdtemp）。这是 DEBT-039 真正开放式的形状，任何文本扫描都看不见它。
 *   补偿手段是运行时两层：各套件内的环境卫生探针用例（逐套件锁）+ 全量 `npm test` 输出的锚定计数
 *   （逐仓库锁，命令见 `docs/debt-registry.json` 的 DEBT-039）。慢宿主上的 `EnvironmentTeardownError`
 *   本身只有 CI 能观测，本机全绿不构成「已验证不出现」。
 *
 * 平台语义（项目约定 §6）：只做「键/计数」用途，路径一律以 URL 形态交给 fs 读取、相对键用正斜杠拼造，
 * 不读宿主分隔符语义，也不引用户言引用 ⇒ Windows 开发机与 ubuntu-latest CI 跑同一判据，
 * 无须在 `path-semantics-guard.test.ts` 登记。行尾与 BOM 按 `/\r?\n/` 切行并剥首字符 BOM。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'

/** 仓库根：本文件在 scripts/__tests__/ 下，向上两级。全程以 URL 形态交给 fs，见文件头平台语义段 */
const REPO_BASE = new URL('../../', import.meta.url)

/** 被扫描的测试文件扩展名（与本仓 vitest include 的测试侧口径一致） */
const TEST_EXTS = ['.test.ts', '.test.tsx']

/** 静默机制的两种写法：spy 覆写、整体 fs 命名空间工厂里的桩位 */
const SPY_SILENCE = "vi.spyOn(fs.promises, 'appendFile')"
const FACTORY_SILENCE = 'appendFile: vi.fn'

/** enforceMaxSize 的真实目录扫描（connection 套件漏项的锁） */
const SPY_READDIR = "vi.spyOn(fs.promises, 'readdir')"

/** 环境卫生探针的固定标记，出现次数即被逐套件锁住的站点数 */
const PROBE_MARKER = '@hygiene-probe'

/** 表规模上限：防这张表长成第二份豁免清单，超出即红、逼迫评审 */
const MAX_SILENCED_ROWS = 14

/** 环境卫生探针的期望总数：connection / dir-manager / logger.enforce 三处 */
const EXPECTED_PROBE_COUNT = 3

interface LedgerRow {
  /** 相对仓库根、正斜杠；不存在即判违规，绝不静默跳过 */
  file: string
  /** 行内字面量，与 `git grep -F` 同义（区分大小写的字面量包含） */
  pattern: string
  /** 期望出现次数——相等，不是 ≤：多一处少一处都说明现场变了 */
  count: number
  /** 中文真实理由：为什么这一处值得钉住 */
  reason: string
}

/**
 * 表 1：让 logger 落盘写在套件内不可用的站点。
 * 只收「异步 appendFile」这一种机制——`fs.appendFileSync` 是同步写，reject 不可能逃逸到拆解之后，
 * 故 `startup-diagnostic.test.ts` / `early-crash-guard.test.ts` 那两处 appendFileSync 桩**不在表内**，
 * 收进来只会模糊本表语义。整模块 mock logger 的文件（如 `media-protocol.test.ts`）同样不入表：
 * 它连 `writeLog` 都不会被调用，与本表的「调用发生但不落盘」不是同一件事。
 */
export const SILENCED: readonly LedgerRow[] = [
  {
    file: 'src/main/database/connection.test.ts',
    pattern: SPY_SILENCE,
    count: 1,
    reason: 'app.getPath 指向 /mock/userdata/*，writeLog 的真异步写必然 reject，本套件不验写盘语义'
  },
  {
    file: 'src/main/database/connection.test.ts',
    pattern: 'silenceLoggerDiskWrite()',
    count: 2,
    reason:
      'beforeEach 装一次、afterEach 的 restoreAllMocks 之后必须补装——锁重试与 close() 在其之后才写日志'
  },
  {
    file: 'src/main/database/connection.test.ts',
    pattern: SPY_READDIR,
    count: 1,
    reason:
      '本套件 mkdirSync 被 mock，logFault 走通后首条即触发 enforceMaxSize 的真实 readdir，ENOENT 告警是同族延迟 console.error'
  },
  {
    file: 'src/main/utils/dir-manager.test.ts',
    pattern: SPY_SILENCE,
    count: 1,
    reason:
      'logDir 是 logger.ts 的模块态且按文件隔离，被首个触发用例冻结到其已删除的 tmpBase，后续用例的写必然 reject'
  },
  {
    file: 'src/main/ipc/handlers/resonance-handler.test.ts',
    pattern: FACTORY_SILENCE,
    count: 2,
    reason: '整体 fs 与 fs/promises 命名空间桩各一条，logger 的异步落盘不可用'
  },
  {
    file: 'src/main/services/decryption-service.integration.test.ts',
    pattern: FACTORY_SILENCE,
    count: 2,
    reason: '解密集成套件对 fs 与 fs/promises 各造一份桩，两处 appendFile 桩位都是它'
  },
  {
    file: 'src/main/services/share-clipboard-service.test.ts',
    pattern: FACTORY_SILENCE,
    count: 1,
    reason: '剪贴板单测整体 mock fs，注释已写明该桩位是为 logger 落盘而留'
  },
  {
    file: 'src/main/services/share-clipboard-service.integration.test.ts',
    pattern: FACTORY_SILENCE,
    count: 1,
    reason: '剪贴板集成套件的 fs/promises 桩位；异步写若不被桩住会把 reject 排到套件之外'
  },
  {
    file: 'src/main/services/share-wifi-service.test.ts',
    pattern: FACTORY_SILENCE,
    count: 1,
    reason: 'Wi-Fi 分享套件把 app.getPath 指向 C:\\mock/*，真写盘必然失败，靠命名空间桩位挡住'
  }
]

/**
 * 表 2：必须保持真实异步写盘的站点。count 为 0 的行是反向锁——
 * 这些套件的意义就在于「真的写了盘」，一旦出现桩位，它的断言就变成自证。
 */
export const REAL_WRITE: readonly LedgerRow[] = [
  {
    file: 'src/main/utils/logger.test.ts',
    pattern: "mockRejectedValueOnce(new Error('disk full'))",
    count: 1,
    reason: 'DEBT-039 订正判据后唯一合法站点：只有这里能验「写盘失败只告警、不抛错」的语义'
  },
  {
    file: 'src/main/utils/logger.test.ts',
    pattern: SPY_SILENCE,
    count: 0,
    reason: '本套件的断言要读回真实日志文件，全局或本文件静默 appendFile 会让用例自证'
  },
  {
    file: 'src/main/utils/logger.enforce.test.ts',
    pattern: 'beforeAll(',
    count: 0,
    reason: '目录只建一次 + afterEach rmSync 就是本轮缺陷成因：第二个用例全程对着已删除的目录跑'
  },
  {
    file: 'src/main/utils/logger.enforce.test.ts',
    pattern: 'mkdtempSync(',
    count: 1,
    reason: '按用例唯一重建日志目录，才能让节流计数落在真实扫描上'
  },
  {
    file: 'src/main/utils/logger.enforce.test.ts',
    pattern: SPY_SILENCE,
    count: 0,
    reason:
      '本套件验的是 enforceMaxSize 的真实 readdir/stat/unlink，静默掉 appendFile 等于放弃被测对象'
  }
]

/** 表 3：`logger.ts` 的形状锁——告警与 fire-and-forget 站点的期望计数 */
export const LOGGER_SHAPE: readonly LedgerRow[] = [
  {
    file: 'src/main/utils/logger.ts',
    pattern: 'fs.promises.appendFile(',
    count: 2,
    reason: '一处无人持有的主日志异步写 + 一处被 await 持有的故障日志写；多一处即多一条逃逸通道'
  },
  {
    file: 'src/main/utils/logger.ts',
    pattern: 'await fs.promises.appendFile(',
    count: 1,
    reason: '与上一行相减得到「未被 await 持有」的站点数，必须恰为 1'
  },
  {
    file: 'src/main/utils/logger.ts',
    pattern: '[Logger] 写入失败:',
    count: 1,
    reason: '磁盘满/权限错误的唯一用户可见告警，删它等于遮蔽信号'
  },
  {
    file: 'src/main/utils/logger.ts',
    pattern: "console.error('[Logger]",
    count: 4,
    reason: '主日志 / 故障日志（异步与同步各一）/ 大小检查四条告警，任一条被改词或删掉都要评审'
  },
  {
    file: 'src/main/utils/logger.ts',
    pattern: 'fs.promises.readdir(logDir)',
    count: 1,
    reason: 'enforceMaxSize 的真实目录扫描；计数变化说明节流或扫描面被动过'
  },
  {
    file: 'src/main/utils/logger.ts',
    pattern: 'if (!logDir) initLogger()',
    count: 4,
    reason: 'logDir 惰性初始化门：它同时是 dir-manager 套件跨用例泄漏的成因，动它必须连带复核该套件'
  }
]

/** 读仓库内文本：URL 形态交给 fs，剥首字符 BOM（core.autocrlf 与编辑器差异不影响判定） */
function readRepoText(rel: string): string {
  const raw = fs.readFileSync(new URL(encodeURI(rel), REPO_BASE), 'utf8')
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
}

/** 逐模式计数：与 `git grep -F` 同义（区分大小写的字面量包含，跨行累计出现次数） */
function countLiteral(text: string, pattern: string): number {
  let hits = 0
  for (const line of text.split(/\r?\n/)) hits += line.split(pattern).length - 1
  return hits
}

/**
 * 求值一组「文件 + 字面量 + 期望次数」：返回违规描述列表（空数组即全部满足）。
 * 文件读不到就记违规并继续下一行，绝不退化成静默跳过——否则删文件能让本闸门恒真。
 */
export function collectLedgerViolations(
  rows: readonly LedgerRow[],
  read: (rel: string) => string
): string[] {
  const violations: string[] = []
  for (const row of rows) {
    let text: string
    try {
      text = read(row.file)
    } catch {
      violations.push(`${row.file} 读不到（台账期望 ${row.pattern} 出现 ${row.count} 次）`)
      continue
    }
    const actual = countLiteral(text, row.pattern)
    if (actual !== row.count) {
      violations.push(
        `${row.file} 的「${row.pattern}」实际 ${actual} 次，台账期望 ${row.count} 次（${row.reason}）`
      )
    }
  }
  return violations
}

/** 互斥求值：同一文件不得既在静默表又被声明为真写盘，返回并存的文件列表 */
export function collectMutexViolations(
  silenced: readonly LedgerRow[],
  realWrite: readonly LedgerRow[]
): string[] {
  const silencedFiles = new Set(silenced.map((row) => row.file))
  return [...new Set(realWrite.map((row) => row.file))].filter((file) => silencedFiles.has(file))
}

/**
 * 求值 `logger.ts` 的形状：告警被删、或新增第二条无人持有的 appendFile().catch()，都判违规。
 * 与 collectLedgerViolations 分开，是因为这里要的是「未被 await 持有」的派生计数，
 * 单靠字面量相等表达不了「谁持有这条 Promise」。
 */
export function collectLoggerShapeViolations(source: string): string[] {
  const violations: string[] = []
  const appendable = countLiteral(source, 'fs.promises.appendFile(')
  const owned = countLiteral(source, 'await fs.promises.appendFile(')
  const unowned = appendable - owned
  if (unowned !== 1) {
    violations.push(
      `无人持有的 fs.promises.appendFile 站点数 = ${unowned}（期望 1）；` +
        '每条这样的 Promise 的 reject 都可能排到环境拆解之外'
    )
  }
  if (countLiteral(source, '[Logger] 写入失败:') < 1) {
    violations.push('主日志写盘失败的 console.error 告警缺失：这是磁盘满/权限错误的唯一可见渠道')
  }
  for (const row of LOGGER_SHAPE) {
    const actual = countLiteral(source, row.pattern)
    if (actual !== row.count) {
      violations.push(`${row.pattern} 实际 ${actual} 次，期望 ${row.count} 次`)
    }
  }
  return violations
}

/** 递归收集扫描域内的测试文件（正斜杠相对路径，已排序以保证跨宿主可比） */
export function collectTestFiles(root = 'src'): string[] {
  const files: string[] = []
  const visit = (relDir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(new URL(encodeURI(relDir) + '/', REPO_BASE), {
        withFileTypes: true
      })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = `${relDir}/${entry.name}`
      if (entry.isDirectory()) visit(rel)
      else if (entry.isFile() && TEST_EXTS.some((ext) => rel.endsWith(ext))) files.push(rel)
    }
  }
  visit(root)
  return files.sort()
}

/** 扫描域内的静默站点：返回「含 appendFile 静默字面量的文件 → 该文件两类静默的合计次数」 */
export function collectSilenceSites(
  files: readonly string[],
  read: (rel: string) => string
): Map<string, number> {
  const sites = new Map<string, number>()
  for (const rel of files) {
    const text = read(rel)
    const total = countLiteral(text, SPY_SILENCE) + countLiteral(text, FACTORY_SILENCE)
    if (total > 0) sites.set(rel, total)
  }
  return sites
}

/** 台账里被声明过的静默站点文件集合 */
export function silencedFiles(rows: readonly LedgerRow[]): Set<string> {
  return new Set(
    rows
      .filter((row) => row.pattern === SPY_SILENCE || row.pattern === FACTORY_SILENCE)
      .map((row) => row.file)
  )
}

/** 扫描域内环境卫生探针的分布：文件 → 标记出现次数 */
export function collectProbeSites(
  files: readonly string[],
  read: (rel: string) => string
): Map<string, number> {
  const sites = new Map<string, number>()
  for (const rel of files) {
    const n = countLiteral(read(rel), PROBE_MARKER)
    if (n > 0) sites.set(rel, n)
  }
  return sites
}

describe('logger.ts 的 fire-and-forget 形状（反遮蔽锁）', () => {
  const source = readRepoText('src/main/utils/logger.ts')

  it('正常：真实 logger.ts 的六个形状计数与台账相等', () => {
    expect(collectLoggerShapeViolations(source)).toEqual([])
  })

  it('异常：删掉 [Logger] 写入失败 告警必须判违规', () => {
    const suppressed = source.replace(
      "    console.error('[Logger] 写入失败:', err)\n",
      '    // 写盘失败静默吞掉\n'
    )
    expect(suppressed, '合成样本没生效：真实 logger.ts 的该行文本已变，请同步本用例').not.toBe(
      source
    )
    const violations = collectLoggerShapeViolations(suppressed)
    expect(violations.some((v) => v.includes('唯一可见渠道'))).toBe(true)
  })

  it('异常：新增第二条无人持有的 fs.promises.appendFile().catch() 必须判违规', () => {
    const extra = source.replace(
      '  // 同步输出到控制台（开发调试）',
      '  fs.promises.appendFile(getFaultLogPath(), line, "utf-8").catch(() => {})\n' +
        '  // 同步输出到控制台（开发调试）'
    )
    expect(extra, '合成样本没生效：插入锚点已变，请同步本用例').not.toBe(source)
    const violations = collectLoggerShapeViolations(extra)
    expect(violations.some((v) => v.includes('无人持有的 fs.promises.appendFile 站点数 = 2'))).toBe(
      true
    )
  })

  it('边界：完整源码原样送入时零违规（合成判据不误伤正常样本）', () => {
    expect(collectLoggerShapeViolations(source)).toHaveLength(0)
  })
})

describe('静默与真写盘两张表（封闭集，多一处少一处都红）', () => {
  it('正常：逐文件逐模式的计数与台账相等', () => {
    expect(collectLedgerViolations(SILENCED, readRepoText)).toEqual([])
    expect(collectLedgerViolations(REAL_WRITE, readRepoText)).toEqual([])
  })

  it('异常：台账指向的文件不存在时记违规而不是跳过', () => {
    const rows: readonly LedgerRow[] = [
      { file: 'src/没有这个文件.ts', pattern: 'x', count: 1, reason: '合成用例' }
    ]
    const violations = collectLedgerViolations(rows, () => {
      throw new Error('ENOENT')
    })
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('读不到')
  })

  it('边界：同一文件不得同时躺在静默表与真写盘表', () => {
    expect(collectMutexViolations(SILENCED, REAL_WRITE)).toEqual([])
    const overlapped: readonly LedgerRow[] = [
      { file: 'src/main/utils/logger.test.ts', pattern: SPY_SILENCE, count: 1, reason: '合成用例' }
    ]
    expect(collectMutexViolations(overlapped, REAL_WRITE)).toContain(
      'src/main/utils/logger.test.ts'
    )
  })

  it('边界：每条台账行都写了互不相同的真实理由（空、过短、复制粘贴即红）', () => {
    const rows = [...SILENCED, ...REAL_WRITE, ...LOGGER_SHAPE]
    for (const row of rows) {
      expect(
        row.reason.trim().length,
        `${row.file} 的 ${row.pattern} 理由过短`
      ).toBeGreaterThanOrEqual(12)
    }
    const reasons = rows.map((row) => row.reason)
    expect(new Set(reasons).size, '存在复制粘贴的台账理由').toBe(reasons.length)
  })

  it('边界：真写盘名单不得被顺手删短', () => {
    const realFiles = new Set(REAL_WRITE.map((row) => row.file))
    expect(realFiles.has('src/main/utils/logger.test.ts')).toBe(true)
    expect(realFiles.has('src/main/utils/logger.enforce.test.ts')).toBe(true)
    expect(REAL_WRITE.length).toBeGreaterThanOrEqual(5)
  })

  it('边界：tests/setup.ts 不得出现全局 appendFile / readdir 静默', () => {
    const setup = readRepoText('tests/setup.ts')
    expect(countLiteral(setup, 'appendFile'), '全局静默会打死真写盘套件').toBe(0)
    expect(countLiteral(setup, 'readdir'), '全局静默会打死真写盘套件').toBe(0)
  })

  it('边界：静默台账行数在上限内，防止长成第二份豁免清单', () => {
    expect(SILENCED.length).toBeGreaterThan(0)
    expect(SILENCED.length).toBeLessThanOrEqual(MAX_SILENCED_ROWS)
  })
})

describe('扫描域与夹具形状（本轮修复的反向锁）', () => {
  const files = collectTestFiles()

  it('正常：扫描域非空（防止目录写错导致守卫空转常绿）', () => {
    expect(files.length).toBeGreaterThan(400)
  })

  it('正常：src 下每一处 appendFile 静默都在台账内（新增遮蔽必须先登记）', () => {
    const registered = silencedFiles(SILENCED)
    const unregistered = [...collectSilenceSites(files, readRepoText).keys()].filter(
      (file) => !registered.has(file)
    )
    expect(unregistered, `台账外的 appendFile 静默：${unregistered.join(', ')}`).toEqual([])
  })

  it('正常：logger.enforce 套件不得退回「目录只建一次」的夹具', () => {
    expect(collectLedgerViolations(REAL_WRITE, readRepoText)).toEqual([])
  })

  it('边界：环境卫生探针标记恰好三处（少一处说明某个修复站点失去运行时锁）', () => {
    const sites = collectProbeSites(files, readRepoText)
    let total = 0
    for (const n of sites.values()) total += n
    expect(total, `探针分布：${[...sites].map(([f, n]) => `${f}(${n})`).join(', ') || '无'}`).toBe(
      EXPECTED_PROBE_COUNT
    )
  })
})
