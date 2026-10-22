/**
 * 性能基线固化脚本：把实测报告（.cache/perf/*.json）提升为入库基线的**某一个环境段**
 *
 * 用法：
 *   npx tsx scripts/perf-test/save-perf-baseline.ts                      # 用 latest.json 固化当前环境段
 *   npx tsx scripts/perf-test/save-perf-baseline.ts --dry-run            # 仅预览，不写入
 *   npx tsx scripts/perf-test/save-perf-baseline.ts --env dev --dry-run  # 指定要改写的段
 *   npx tsx scripts/perf-test/save-perf-baseline.ts --env ci --samples a.json b.json c.json
 *
 * 规则（v2 基线，见 docs/perf-regression.md §4）：
 * - 只改写所选段（environments.dev / environments.ci），hardRules 与另一段原样保留；
 * - baselineValue 取所选报告的**中位数**（多样本压单次噪声），保留两位小数；
 * - regressionFactor 沿用该段旧值，缺省 2.0；两段的系数必须逐项相同——分段只换比较对象，不换容忍系数；
 * - ci 段样本数 < MIN_CI_SAMPLES 时写 status=provisional（相对判定照常生效，但明确标注未固化）；
 *   加 --final 而样本不足时直接报错退出，不静默降级。
 * - 绝对护栏（maxMs / minThroughput）只在**首次建段**时按实测派生（耗时 ×3 向上取整到秒、
 *   吞吐量 ÷3 向下取整），此后由人工在 hardRules 里维护。
 *
 * 基线维护流程（人工复核步骤）见 docs/perf-regression.md §基线维护。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const LATEST_PATH = path.join(ROOT_DIR, '.cache', 'perf', 'latest.json')
const BASELINE_PATH = path.join(ROOT_DIR, 'e2e', 'perf-baseline.json')

/** ci 段允许固化为 final 所需的最少样本份数（单次读数不得当基线） */
export const MIN_CI_SAMPLES = 3

export interface PerfSampleLike {
  id: string
  scenario: string
  value: number
  unit: 'ms' | 'items/sec'
}

export interface RunReportLike {
  timestamp: string
  platform: string
  nodeVersion?: string
  perfEnv?: 'dev' | 'ci'
  datasetImages: number
  samples: PerfSampleLike[]
  passed?: boolean
  /** 那次运行的判定结果；本脚本不读它，仅保持与 e2e/perf-helpers.ts 的 PerfRunReport 同形 */
  violations?: unknown[]
}

export interface RelativeRuleLike {
  baselineValue: number
  regressionFactor: number
}

export interface HardRuleLike {
  maxMs?: number
  minThroughput?: number
}

export interface EnvSectionLike {
  recordedAt: string
  environment: string
  status: 'final' | 'provisional'
  sampleCount: number
  sourceRuns: string[]
  metrics: Record<string, RelativeRuleLike>
}

export interface PerfBaselineLike {
  version: number
  datasetImages: number
  hardRules: Record<string, HardRuleLike>
  environments: Partial<Record<'dev' | 'ci', EnvSectionLike>>
}

export interface AggregateEntry {
  value: number
  count: number
  unit: 'ms' | 'items/sec'
  lastTimestamp: string
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** 解析 --env：显式值优先，其次 PERF_ENV，最后按 GitHub Actions 宿主信号（不认裸 CI） */
export function resolveEnvKey(argv: string[], env: NodeJS.ProcessEnv = process.env): 'dev' | 'ci' {
  const eq = argv.find((a) => a.startsWith('--env='))?.slice('--env='.length)
  const hasSpaceForm = argv.includes('--env')
  const flag = eq ?? (hasSpaceForm ? argv[argv.indexOf('--env') + 1] : undefined)
  if (hasSpaceForm && (flag === undefined || flag.startsWith('--'))) {
    throw new Error('--env 必须跟一个值（dev | ci）')
  }
  if (flag !== undefined) {
    if (flag !== 'dev' && flag !== 'ci') {
      throw new Error(`--env 只接受 dev | ci（实际 ${flag}）`)
    }
    return flag
  }
  if (env.PERF_ENV === 'dev') return 'dev'
  if (env.PERF_ENV === 'ci') return 'ci'
  return env.GITHUB_ACTIONS === 'true' || env.RUNNER_ENVIRONMENT === 'github-hosted' ? 'ci' : 'dev'
}

/** 解析 --samples：收集其后直到下一个选项为止的全部路径 */
export function parseSamplesArg(argv: string[]): string[] {
  const i = argv.indexOf('--samples')
  if (i < 0) return []
  const out: string[] = []
  for (let j = i + 1; j < argv.length; j++) {
    if (argv[j].startsWith('--')) break
    out.push(argv[j])
  }
  if (out.length === 0) {
    throw new Error('--samples 后面至少要跟一个实测报告文件路径（.cache/perf/perf-run-*.json）')
  }
  return out
}

/** 按指标跨报告聚合：取中位数，并如实记录每个指标实际参与了几份 */
export function aggregateSamples(reports: RunReportLike[]): Map<string, AggregateEntry> {
  if (reports.length === 0) {
    throw new Error('没有可用的实测报告，无法聚合基线')
  }
  const byId = new Map<string, { values: number[]; unit: 'ms' | 'items/sec'; last: string }>()
  for (const report of reports) {
    for (const sample of report.samples ?? []) {
      const entry = byId.get(sample.id) ?? { values: [], unit: sample.unit, last: '' }
      entry.values.push(sample.value)
      // ISO 时间戳按字典序即时间序；报告里的 timestamp 来自同一时钟
      if (report.timestamp > entry.last) entry.last = report.timestamp
      byId.set(sample.id, entry)
    }
  }
  const out = new Map<string, AggregateEntry>()
  for (const [id, entry] of byId) {
    out.set(id, {
      value: median(entry.values),
      count: entry.values.length,
      unit: entry.unit,
      lastTimestamp: entry.last
    })
  }
  return out
}

/** 首次建段（基线文件还不存在）时，按实测派生绝对护栏 */
export function deriveInitialHardRules(
  aggregate: Map<string, AggregateEntry>
): Record<string, HardRuleLike> {
  const hardRules: Record<string, HardRuleLike> = {}
  for (const [id, entry] of aggregate) {
    hardRules[id] =
      entry.unit === 'ms'
        ? { maxMs: Math.ceil((entry.value * 3) / 1000) * 1000 }
        : { minThroughput: Math.max(1, Math.floor(entry.value / 3)) }
  }
  return hardRules
}

/** 生成所选段的固化计划：状态、指标、以及需要人工注意的告警 */
export function planSection(input: {
  envKey: 'dev' | 'ci'
  aggregate: Map<string, AggregateEntry>
  existing: PerfBaselineLike | null
  sourceRuns: string[]
  requireFinal: boolean
  /** 新建段时用作 environment 描述；已有段沿用旧描述（人工写的硬件说明不被 platform 串覆盖） */
  platform?: string
}): { section: EnvSectionLike; warnings: string[] } {
  const { envKey, aggregate, existing, sourceRuns, requireFinal } = input
  const prev = existing?.environments?.[envKey] ?? null
  const devMetrics = existing?.environments?.dev?.metrics ?? {}
  const minCount = Math.min(...[...aggregate.values()].map((v) => v.count))
  const warnings: string[] = []

  let status: EnvSectionLike['status'] = 'final'
  if (envKey === 'ci' && minCount < MIN_CI_SAMPLES) {
    status = 'provisional'
    warnings.push(
      `ci 段样本数 ${minCount} < ${MIN_CI_SAMPLES}，标记 provisional，待补样后重跑本脚本转 final`
    )
  }
  if (requireFinal && status !== 'final') {
    throw new Error(
      `样本数 ${minCount} 不足 ${MIN_CI_SAMPLES}，拒绝把 ${envKey} 段固化为 final（请补样后重试）`
    )
  }

  const metrics: Record<string, RelativeRuleLike> = {}
  // 受门禁指标集 = 既有各段已定义的指标 id 并集；基线不存在时为 null（首次固化按实测全量建段）。
  // 不照单全收的原因：报告里还有观察项（thumbnail-generate-p50/p95、first-thumbnail-visible），
  // 它们没有既有系数可继承，凭空按缺省 factor 2 建门禁必然假红
  // （实测同一 job 两次 P95 读数为 5.4ms 与 27.1ms）。把观察项升成门禁是人工的显式决策。
  const gated = new Set<string>()
  for (const section of Object.values(existing?.environments ?? {})) {
    for (const id of Object.keys(section?.metrics ?? {})) gated.add(id)
  }
  const gatedSet = gated.size > 0 ? gated : null
  for (const [id, entry] of aggregate) {
    if (gatedSet && !gatedSet.has(id)) {
      warnings.push(
        `${id} 不在受门禁指标集内（观察项），本次不为它建相对规则；要纳入门禁需人工同时补 dev 与 ci 段`
      )
      continue
    }
    metrics[id] = {
      baselineValue: Math.round(entry.value * 100) / 100,
      // 系数只沿用旧值：分段的意义是换比较对象，不是换容忍系数
      regressionFactor:
        prev?.metrics[id]?.regressionFactor ?? devMetrics[id]?.regressionFactor ?? 2.0
    }
    if (entry.count !== sourceRuns.length) {
      // 只有「该指标在部分报告里缺失」才逐条提示：份数本身已由上面的汇总告警说明
      warnings.push(
        `${id} 只有 ${entry.count} 份样本（共 ${sourceRuns.length} 份报告），中位数受缺项影响`
      )
    }
  }

  const recordedAt = [...aggregate.values()].reduce(
    (acc, e) => (e.lastTimestamp > acc ? e.lastTimestamp : acc),
    ''
  )
  return {
    warnings,
    section: {
      recordedAt: recordedAt || new Date().toISOString(),
      environment: prev?.environment ?? input.platform ?? '',
      status,
      sampleCount: sourceRuns.length,
      sourceRuns,
      metrics
    }
  }
}

/** 只替换所选段，其余（hardRules / 另一段 / version / datasetImages）逐字保留 */
export function mergeBaselineSection(
  existing: PerfBaselineLike,
  envKey: 'dev' | 'ci',
  section: EnvSectionLike
): PerfBaselineLike {
  if (existing.version !== 2) {
    throw new Error(
      `基线 version 必须为 2（实际 ${String(existing.version)}）：本脚本不做 v1→v2 迁移，请先人工改造基线文件`
    )
  }
  return {
    version: 2,
    datasetImages: existing.datasetImages,
    hardRules: existing.hardRules,
    environments: { ...existing.environments, [envKey]: section }
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as T
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const requireFinal = argv.includes('--final')

  let envKey: 'dev' | 'ci'
  let sampleArg: string[]
  try {
    envKey = resolveEnvKey(argv)
    sampleArg = parseSamplesArg(argv)
  } catch (err) {
    console.error(`[perf-baseline] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
    return
  }
  const sampleFiles = sampleArg.length > 0 ? sampleArg : [LATEST_PATH]

  const reports: RunReportLike[] = []
  for (const file of sampleFiles) {
    const abs = path.isAbsolute(file) ? file : path.join(ROOT_DIR, file)
    const report = await readJson<RunReportLike>(abs)
    if (!report) {
      console.error(`[perf-baseline] 读不到或解析失败: ${abs}`)
      console.error(
        '请先执行: npm run e2e:perf（或显式用 --samples 指定 .cache/perf/perf-run-*.json）'
      )
      process.exit(1)
      return
    }
    if (!report.samples || report.samples.length === 0) {
      console.error(`[perf-baseline] 报告中无采样数据，无法固化基线: ${abs}`)
      process.exit(1)
      return
    }
    if (report.passed === false) {
      console.warn(
        `[perf-baseline] 警告：${path.basename(abs)} 那次运行未通过判定，请确认数据有效后再固化`
      )
    }
    reports.push(report)
  }

  const aggregate = aggregateSamples(reports)
  const sourceRuns = sampleFiles.map((f) => path.basename(f).replace(/\.json$/, ''))

  const existing = await readJson<PerfBaselineLike>(BASELINE_PATH)
  if (existing && existing.version !== 2) {
    console.error(
      `[perf-baseline] 基线 version=${String(existing.version)}，本脚本不做迁移，拒绝写入`
    )
    process.exit(1)
    return
  }
  const base: PerfBaselineLike = existing ?? {
    version: 2,
    datasetImages: reports[reports.length - 1].datasetImages,
    hardRules: deriveInitialHardRules(aggregate),
    environments: {}
  }

  let planned: ReturnType<typeof planSection>
  try {
    planned = planSection({
      envKey,
      aggregate,
      existing: base,
      sourceRuns,
      requireFinal,
      platform: reports[reports.length - 1].platform
    })
  } catch (err) {
    console.error(`[perf-baseline] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
    return
  }
  const { section, warnings } = planned
  const next = mergeBaselineSection(base, envKey, section)
  const prevMetrics = base.environments[envKey]?.metrics ?? {}

  console.log(
    `[perf-baseline] 环境段 ${envKey}：status=${section.status}, 样本=${section.sampleCount} 份`
  )
  for (const w of warnings) console.warn(`  ⚠ ${w}`)
  console.log('[perf-baseline] 基线指标预览：')
  for (const [id, rule] of Object.entries(section.metrics)) {
    const prevValue = prevMetrics[id]?.baselineValue
    const delta =
      prevValue !== undefined ? `（旧 ${prevValue} → ${rule.baselineValue}）` : '（新增）'
    const hard = next.hardRules[id] ?? {}
    const gate =
      hard.maxMs !== undefined
        ? `maxMs=${hard.maxMs}`
        : `minThroughput=${hard.minThroughput ?? '-'}`
    console.log(
      `  - ${id}: baseline=${rule.baselineValue} ${delta}, ${gate}, factor=${rule.regressionFactor}`
    )
    // 防抖提醒：基线大幅收紧（>30%）可能是单次运行的幸运值，固化后容忍区间随之收窄
    if (prevValue !== undefined) {
      const tightened =
        (hard.maxMs !== undefined && rule.baselineValue < prevValue * 0.7) ||
        (hard.minThroughput !== undefined && rule.baselineValue > prevValue * 1.3)
      if (tightened) {
        console.warn('    ⚠ 基线将大幅收紧，请确认非单次幸运值（建议重复运行 2~3 轮）')
      }
    }
  }

  if (dryRun) {
    console.log('[perf-baseline] --dry-run：未写入文件')
    return
  }
  await fs.writeFile(BASELINE_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8')
  console.log(`[perf-baseline] 已写入基线: ${BASELINE_PATH}（只改写 ${envKey} 段）`)
  console.log('请人工复核阈值合理性后随代码一并提交（流程见 docs/perf-regression.md）。')
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  main().catch((err) => {
    console.error('[perf-baseline] 固化失败:', err)
    process.exit(1)
  })
}
