/**
 * 被跟踪 Markdown 的引用完整性守护脚本
 *
 * 扫描 `git ls-files "*.md"` 得到的每个被跟踪文档，抽取两类引用并判定能否解析：
 *   ① Markdown 链接 `[文本](目标)` 与引用定义 `[标识]: 目标`
 *   ② 行内反引号里的路径 `` `src/...` ``
 *
 * 判定口径（唯一真相源，改动须同步 `__tests__/check-md-links.test.ts`）：
 *   - ok             目标命中 tracked 集合（文件或目录前缀）
 *   - ignored-local  目标落在被 `.gitignore` 排除的本机留存区（`docs/archive/**`、AI 工具目录等）。
 *                    引用它们是本仓既定约定，但对新克隆不可用 ⇒ 提醒
 *   - annotated-gone 目标不存在，但**同一行**已写明「已删除 / 已移除 / 拟新增 / 不入仓」等
 *                    既有注解 ⇒ 属正确的历史叙述，提醒而非失败（本仓约定：写路径就要在同行交代去向）
 *   - artifact       目标是构建产物/运行时目录（`dist/`、`coverage/`、`release/` 等），不是仓库资产
 *   - upstream-scope 文档前 12 行内做了「路径作用域」声明（阶段计划/上游审计报告），
 *                    文中不可解析路径属上游 NikkiSync 仓或当时的设计 ⇒ 提醒
 *   - external       网络/自定义协议（http、media:// 等）与页内锚点
 *   - dead           既不被跟踪、也不属于以上任何一类 ⇒ 对新克隆就是死引用，硬失败
 *
 * 为什么需要它：`scripts/check-doc-versions.ts` 只用正则核对 README 的 Electron 版本。
 * 2026-10-10 那轮文档盘点登记了遗留风险「没有任何工具校验 README / ARCHITECTURE /
 * DEVELOPMENT / docs/** 里的 `[x](path)`」，导致 `docs/PLUGIN_SYSTEM_PLAN.md`、
 * `./07-bidirectional-sync-plan.md` 这类死引用长期存活。本脚本把该判定机械化。
 *
 * 关键取舍一：判定「存在」用 `git ls-files` 的 tracked 集合，**不用 `fs.existsSync`**。
 * 被 `.gitignore` 排除但本机仍在的文件对全新克隆不可用，用 existsSync 会把这类失真全部吞掉。
 *
 * 关键取舍二：行内反引号只认「从仓库根锚点开头 + 带已知扩展名或以 `/` 结尾」。
 * 本仓文档里大量反引号 token 是以所在模块目录为基准的简写（`` `app/` ``、
 * `` `preload/ipc.ts` ``、`` `__tests__/` ``），按仓库根解析必然成片误报；
 * 闸门一旦噪声过大就会被整体关掉，那比没有闸门更糟。
 *
 * 铁律：本脚本只读，绝不写任何文件。
 *
 * 用法：npm run docs:links （等价 npx tsx scripts/check-md-links.ts）
 */
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')

export type RefKind = 'markdown-link' | 'reference-definition' | 'inline-path'

export type RefVerdict =
  'ok' | 'ignored-local' | 'annotated-gone' | 'upstream-scope' | 'artifact' | 'external' | 'dead'

export interface MdRef {
  /** 文档中出现的原始文本 */
  raw: string
  kind: RefKind
  line: number
  /** 引用所在整行原文，用于识别「已删除/拟新增」类注解 */
  context: string
}

export interface RefCheckResult extends MdRef {
  verdict: RefVerdict
  /** 相对仓库根的规范化猜测，非 ok 判定用于定位 */
  resolved: string
}

export interface FileFindings {
  file: string
  dead: RefCheckResult[]
  advisory: RefCheckResult[]
}

/** 本机留存区前缀：与仓库 `.gitignore` 保持一致，新增 AI 工具目录时同步这里 */
const IGNORED_LOCAL_PREFIXES = [
  'docs/archive',
  '.qoder',
  '.zcode',
  '.codebuddy',
  '.trae',
  '.mimosa',
  '.workbuddy',
  '.review',
  '_plans'
]

/** 构建产物与运行时目录：不是仓库资产，出现即跳过 */
const ARTIFACT_PREFIXES = ['dist', 'out', 'build', 'coverage', 'node_modules', 'release', '.cache']

/** 网络与自定义协议：不属于文件引用 */
const EXTERNAL_PROTOCOLS = [
  'http://',
  'https://',
  'mailto:',
  'media://',
  'app://',
  'file://',
  'ws://',
  'wss://'
]

/** 只有这些根目录开头的行内 token 才视为仓库引用 */
const PATH_LIKE_ROOTS = [
  'docs/',
  'src/',
  'scripts/',
  'e2e/',
  'plugins-samples/',
  '.github/',
  'tests/'
]

/** 行内 token 需以这些扩展名结尾，或以 `/` 结尾表示目录，才当作路径引用 */
const KNOWN_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.cjs',
  '.mjs',
  '.json',
  '.md',
  '.mdx',
  '.css',
  '.html',
  '.png',
  '.jpg',
  '.py',
  '.yml',
  '.yaml',
  '.ps1',
  '.sh',
  '.db',
  '.dll',
  '.exe',
  '.txt',
  '.tgz'
]

/**
 * 「已删除/拟新增/未入仓」类同行注解。
 *
 * 文档会如实叙述某路径已被移除（`CHANGELOG.md`「移除 Python 扫描器原型：`src/path_resolver.py`」）、
 * 某路径是计划新增（`docs/plans/2026-08-24-…` 通篇是未实施的集成测试设计），或某脚本至今
 * 未纳入版本控制（`docs/技术债清单.md` 对 `scripts/fix-harness-memory-path.ps1` 的记载）。
 * 这些都不是失真，命中注解即降级为提醒——等价于把「写路径就要在同行交代去向」这条
 * 文档约定本身编码进闸门。
 */
const GONE_MARKERS =
  /(已删除|已移除|移除|整体移除|原文件|原目录|不存在|从未|拟新增|计划新增|拟创建|待创建|尚未实施|未实施|已归档|不入仓|未入仓|归档至|已出仓|未纳入版本控制|untracked|former|removed|deleted)/

/**
 * 文档级作用域声明（`docs/sync-integration/` 的阶段计划与审计报告、未实施的设计稿用）。
 *
 * 这些文档大量引用**上游 NikkiSync 仓**的 `src/index.ts`、`src/server/LocalSyncServer.ts`
 * 这类路径，以及当时规划、后来落地成不同文件名的本仓路径。它们不是失真，而是
 * 「描述的对象不在本仓 / 是历史设计」。约定：在文档前 12 行内写一行含
 * `路径作用域` 与 `不在本仓`（或 `上游`）的声明，本脚本即把该文档内无法解析的
 * 路径降级为提醒——同时这行声明本身也让读者知道该去哪个仓找。
 */
const SCOPE_DECLARATION = /路径作用域.*(不在本仓|上游|本仓与上游|未落地)/

/** 判断文档是否在前 12 行内做了路径作用域声明 */
export function hasScopeDeclaration(mdText: string): boolean {
  return mdText.split(/\r?\n/, 12).some((l) => SCOPE_DECLARATION.test(l))
}

/**
 * 判定一个反引号 token 是否「像路径」。见文件头「关键取舍二」。
 */
export function isPathLike(token: string): boolean {
  if (!token) return false
  if (/[\s*?<>|{}$'"`\\]/.test(token)) return false
  if (token.includes('...') || token.includes('://')) return false
  if (token.startsWith('#') || token.startsWith('/') || /^[A-Za-z]:/.test(token)) return false
  // `domain:action` 形式的 IPC 通道名
  if (/^[\w./-]+:/.test(token)) return false
  if (!PATH_LIKE_ROOTS.some((r) => token.startsWith(r))) return false
  if (token.endsWith('/')) return true
  return KNOWN_EXTENSIONS.some((ext) => token.endsWith(ext))
}

/** Markdown 链接目标是否只是代码/正则片段而非路径（如 `[\\/](\d{6,12})[\\/]`） */
function isCodeFragment(target: string): boolean {
  return /[[\]{}|?*^$+\\]/.test(target) && !KNOWN_EXTENSIONS.some((ext) => target.endsWith(ext))
}

/**
 * 把行内代码段替换成等长空白。
 *
 * 文档里会**讨论**链接语法本身（`` `[x](path)` ``、`` `[Releases 页面](../../releases)` ``），
 * 这些在反引号内、不是真引用。不先屏蔽就会出现「解释死链的句子本身被报成死链」的荒谬结果。
 * 用等长空白替换以保持列号与其余 token 的位置关系。
 */
function blankInlineCode(line: string): string {
  return line.replace(/`[^`\n]*`/g, (s) => ' '.repeat(s.length))
}

/** 抽取文档中的引用目标；跳过围栏代码块（其中路径是示例而非引用） */
export function extractRefs(mdText: string): MdRef[] {
  const refs: MdRef[] = []
  const lines = mdText.split(/\r?\n/)
  let inFence = false

  lines.forEach((rawLine, idx) => {
    if (/^\s*(```|~~~)/.test(rawLine)) {
      inFence = !inFence
      return
    }
    if (inFence) return

    const lineNo = idx + 1
    const prose = blankInlineCode(rawLine)
    let m: RegExpExecArray | null

    // ① Markdown 链接：只在屏蔽行内代码后的文本上匹配
    const linkRe = /\[[^\]]*\]\(\s*([^)\s]+)\s*(?:\s+"[^"]*")?\)/g
    while ((m = linkRe.exec(prose)) !== null) {
      const target = m[1]
      if (target.startsWith('<') || isCodeFragment(target)) continue
      refs.push({ raw: target, kind: 'markdown-link', line: lineNo, context: rawLine })
    }

    // ② 引用定义
    const def = /^\s*\[[^\]]+\]:\s*(\S+)/.exec(prose)
    if (def)
      refs.push({ raw: def[1], kind: 'reference-definition', line: lineNo, context: rawLine })

    // ③ 行内反引号路径：在未改写的原始行上匹配，保证 token 完整
    const codeRe = /`([^`\n]+)`/g
    while ((m = codeRe.exec(rawLine)) !== null) {
      const token = m[1].trim()
      if (isPathLike(token))
        refs.push({ raw: token, kind: 'inline-path', line: lineNo, context: rawLine })
    }
  })

  return refs
}

/** 去掉锚点、查询串与结尾斜杠 */
function stripTargetNoise(target: string): string {
  return target.split('?')[0].split('#')[0].replace(/\/+$/, '')
}

/**
 * 生成仓库相对路径的候选序列。
 *
 * 三级写法在本仓并存：仓库根相对（`docs/plans/x.md`）、源文件相对（`./01-plan.md`、
 * `../app/AGENTS.md`）、以及相对所在目录的简写（`archive/x.md` 出现在
 * `docs/packaged-scan-crash-report.md` 里）。只有 `./` 与 `../` 才算相对，
 * `.github/` 这类点开头目录属于仓库根。
 */
export function candidatePaths(rawTarget: string, sourceFile: string): string[] {
  const clean = stripTargetNoise(rawTarget).replace(/\\/g, '/')
  if (!clean) return []
  const sourceDir = path.posix.dirname(sourceFile)

  if (clean.startsWith('/')) return [clean.slice(1)]
  if (clean.startsWith('./') || clean.startsWith('../')) {
    return [path.posix.normalize(path.posix.join(sourceDir, clean))]
  }
  const fromDir = path.posix.normalize(path.posix.join(sourceDir, clean))
  return fromDir === clean ? [clean] : [clean, fromDir]
}

/** 命中 tracked 文件，或命中某个 tracked 文件的目录前缀（写作 `dir/` 的目录引用） */
function hitsTracked(
  candidate: string,
  tracked: ReadonlySet<string>,
  prefixes: readonly string[]
): boolean {
  if (!candidate || candidate.startsWith('../')) return false
  if (tracked.has(candidate)) return true
  return prefixes.some((p) => p.startsWith(`${candidate}/`))
}

/** 目录前缀匹配：`docs/archive` 与 `docs/archive/plans/x.md` 都算落在本机留存区 */
function underPrefix(candidate: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => candidate === p || candidate.startsWith(`${p}/`))
}

/**
 * 解析并判定单个引用。
 *
 * 优先级：被跟踪 → ok；同行交代去向 → annotated-gone；落在忽略区 → ignored-local；
 * 产物目录 → artifact；否则 dead。
 * 用「任一候选」而非首个候选是必要的：`archive/x.md` 的仓库根候选落空，
 * 但源目录候选命中 `docs/archive/`，判 dead 就是误报。
 */
export function classifyRef(
  ref: MdRef,
  sourceFile: string,
  tracked: ReadonlySet<string>,
  prefixes: readonly string[],
  declaredScope = false
): RefCheckResult {
  if (EXTERNAL_PROTOCOLS.some((p) => ref.raw.startsWith(p)) || ref.raw.startsWith('#')) {
    return { ...ref, verdict: 'external', resolved: '' }
  }

  const cands = candidatePaths(ref.raw, sourceFile)
  if (cands.length === 0) return { ...ref, verdict: 'external', resolved: '' }

  if (cands.some((c) => hitsTracked(c, tracked, prefixes))) {
    return { ...ref, verdict: 'ok', resolved: cands[0] }
  }
  if (GONE_MARKERS.test(ref.context)) {
    return { ...ref, verdict: 'annotated-gone', resolved: cands[0] }
  }
  const inIgnored = cands.find((c) => underPrefix(c, IGNORED_LOCAL_PREFIXES))
  if (inIgnored) return { ...ref, verdict: 'ignored-local', resolved: inIgnored }

  const inArtifact = cands.find((c) => underPrefix(c, ARTIFACT_PREFIXES))
  if (inArtifact) return { ...ref, verdict: 'artifact', resolved: inArtifact }

  // ⑤ 文档已声明路径作用域 ⇒ 剩余不可解析项属上游仓或历史设计，降级为提醒
  if (declaredScope) return { ...ref, verdict: 'upstream-scope', resolved: cands[0] }

  return { ...ref, verdict: 'dead', resolved: cands[0] }
}

/** 单文档判定：供单测直接注入 tracked 集合，不触 git */
export function checkDocument(
  file: string,
  mdText: string,
  tracked: ReadonlySet<string>,
  prefixes: readonly string[]
): FileFindings {
  const declaredScope = hasScopeDeclaration(mdText)
  const results = extractRefs(mdText).map((ref) =>
    classifyRef(ref, file, tracked, prefixes, declaredScope)
  )
  const advisory = results.filter(
    (r) =>
      r.verdict === 'ignored-local' ||
      r.verdict === 'annotated-gone' ||
      r.verdict === 'upstream-scope'
  )
  return { file, dead: results.filter((r) => r.verdict === 'dead'), advisory }
}

/** 读 tracked markdown 清单（关 quotepath，保证中文路径不被转义成八进制） */
export function listTrackedMarkdown(): string[] {
  return gitLines(['ls-files', '-z', '*.md'])
}

/** 读全仓 tracked 路径，作为「是否存在」的判定真相源 */
export function listTrackedPaths(): Set<string> {
  return new Set(gitLines(['ls-files', '-z']))
}

function gitLines(args: string[]): string[] {
  const out = execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  })
  return out.split('\0').filter(Boolean)
}

export interface CheckTotals {
  docs: number
  dead: number
  advisory: number
}

export function runCheck(): { files: FileFindings[]; totals: CheckTotals } {
  const tracked = listTrackedPaths()
  const prefixes = [...tracked]
  const files: FileFindings[] = []

  for (const file of listTrackedMarkdown()) {
    let text: string
    try {
      text = readFileSync(path.join(ROOT, file), 'utf8')
    } catch {
      continue
    }
    const findings = checkDocument(file, text, tracked, prefixes)
    if (findings.dead.length > 0 || findings.advisory.length > 0) files.push(findings)
  }

  return {
    files,
    totals: {
      docs: listTrackedMarkdown().length,
      dead: files.reduce((n, f) => n + f.dead.length, 0),
      advisory: files.reduce((n, f) => n + f.advisory.length, 0)
    }
  }
}

const VERDICT_LABEL: Record<string, string> = {
  'ignored-local': '指向本机留存区',
  'annotated-gone': '同行已交代去向',
  'upstream-scope': '文档已声明路径作用域'
}

function main(): void {
  const { files, totals } = runCheck()

  console.log(`\n[check-md-links] 扫描 ${totals.docs} 个被跟踪 markdown 文件\n`)

  for (const f of files) {
    for (const d of f.dead) {
      console.log(
        `[check-md-links] ✖ ${f.file}:${d.line} 死引用(${d.kind}) \`${d.raw}\` → ${d.resolved}，仓库中不存在`
      )
    }
    for (const a of f.advisory) {
      console.log(
        `[check-md-links] ⚠ ${f.file}:${a.line} ${VERDICT_LABEL[a.verdict]}(${a.kind}) \`${a.raw}\` → ${a.resolved}`
      )
    }
  }

  if (totals.dead > 0) {
    console.error(
      `\n[check-md-links] ❌ ${totals.dead} 处死引用。请改正路径，或按仓库约定归档并在同行写明「已归档，不入仓」。\n`
    )
    process.exit(1)
  }

  console.log(
    `[check-md-links] ✅ 无死引用（另有 ${totals.advisory} 处提醒：本机留存区引用与已交代去向的历史路径）。\n`
  )
  process.exit(0)
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('check-md-links.ts')) {
  main()
}
