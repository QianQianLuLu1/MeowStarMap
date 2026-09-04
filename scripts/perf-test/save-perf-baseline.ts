/**
 * 性能基线固化脚本：把最近一次性能运行结果（.cache/perf/latest.json）提升为入库基线
 *
 * 用法：
 *   npx tsx scripts/perf-test/save-perf-baseline.ts            # 固化基线
 *   npx tsx scripts/perf-test/save-perf-baseline.ts --dry-run  # 仅预览，不写入
 *
 * 规则：
 * - baselineValue 取本次实测值
 * - 绝对阈值（maxMs / minThroughput）优先沿用现有基线中的配置；
 *   新指标按实测值派生：耗时类取 3 倍向上取整，吞吐量类取 1/3 向下取整
 * - regressionFactor 默认 2.0（超过基线 2 倍判定为回归）
 *
 * 基线维护流程（人工复核步骤）见 docs/perf-regression.md §基线维护。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const LATEST_PATH = path.join(ROOT_DIR, '.cache', 'perf', 'latest.json')
const BASELINE_PATH = path.join(ROOT_DIR, 'e2e', 'perf-baseline.json')

interface PerfSampleLike {
  id: string
  scenario: string
  value: number
  unit: 'ms' | 'items/sec'
}

interface MetricRuleLike {
  maxMs?: number
  minThroughput?: number
  baselineValue?: number
  regressionFactor?: number
}

interface RunReportLike {
  timestamp: string
  platform: string
  datasetImages: number
  samples: PerfSampleLike[]
  passed?: boolean
}

interface BaselineLike {
  version: 1
  recordedAt: string
  environment: string
  datasetImages: number
  metrics: Record<string, MetricRuleLike>
}

const dryRun = process.argv.includes('--dry-run')

async function main(): Promise<void> {
  let latest: RunReportLike
  try {
    latest = JSON.parse(await fs.readFile(LATEST_PATH, 'utf-8')) as RunReportLike
  } catch {
    console.error(`[perf-baseline] 未找到最近运行结果: ${LATEST_PATH}`)
    console.error('请先执行: npm run e2e:perf')
    process.exit(1)
  }

  if (!latest.samples || latest.samples.length === 0) {
    console.error('[perf-baseline] latest.json 中无采样数据，无法固化基线')
    process.exit(1)
  }
  if (latest.passed === false) {
    console.warn('[perf-baseline] 警告：最近一次运行未通过判定，请确认数据有效后再固化')
  }

  let existing: BaselineLike | null = null
  try {
    existing = JSON.parse(await fs.readFile(BASELINE_PATH, 'utf-8')) as BaselineLike
  } catch {
    // 首次固化：无旧基线
  }

  const metrics: Record<string, MetricRuleLike> = {}
  for (const s of latest.samples) {
    const prev = existing?.metrics[s.id]
    const rule: MetricRuleLike = { baselineValue: Math.round(s.value * 100) / 100 }
    if (s.unit === 'ms') {
      rule.maxMs = prev?.maxMs ?? Math.ceil((s.value * 3) / 1000) * 1000
    } else {
      rule.minThroughput = prev?.minThroughput ?? Math.max(1, Math.floor(s.value / 3))
    }
    rule.regressionFactor = prev?.regressionFactor ?? 2.0
    metrics[s.id] = rule
  }

  const baseline: BaselineLike = {
    version: 1,
    recordedAt: new Date().toISOString(),
    environment: latest.platform,
    datasetImages: latest.datasetImages,
    metrics
  }

  console.log('[perf-baseline] 基线指标预览：')
  for (const [id, rule] of Object.entries(metrics)) {
    const prevValue = existing?.metrics[id]?.baselineValue
    const delta =
      prevValue !== undefined ? `（旧基线 ${prevValue} → ${rule.baselineValue}）` : '（新增）'
    const gate =
      rule.maxMs !== undefined ? `maxMs=${rule.maxMs}` : `minThroughput=${rule.minThroughput}`
    console.log(`  - ${id}: baseline=${rule.baselineValue} ${delta}, ${gate}`)
    // 防抖提醒：基线大幅收紧（>30%）可能是单次运行的幸运值，
    // 固化后容忍区间随之收窄，易在常态波动下误报；建议多跑几轮确认后再提交
    if (prevValue !== undefined) {
      const tightened =
        rule.baselineValue !== undefined &&
        ((rule.maxMs !== undefined && rule.baselineValue < prevValue * 0.7) ||
          (rule.minThroughput !== undefined && rule.baselineValue > prevValue * 1.3))
      if (tightened) {
        console.warn(`    ⚠ 基线将大幅收紧，请确认非单次幸运值（建议重复运行 2~3 轮）`)
      }
    }
  }

  if (dryRun) {
    console.log('[perf-baseline] --dry-run：未写入文件')
    return
  }
  await fs.writeFile(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n', 'utf-8')
  console.log(`[perf-baseline] 已写入基线: ${BASELINE_PATH}`)
  console.log('请人工复核阈值合理性后随代码一并提交（流程见 docs/perf-regression.md）。')
}

main().catch((err) => {
  console.error('[perf-baseline] 固化失败:', err)
  process.exit(1)
})
