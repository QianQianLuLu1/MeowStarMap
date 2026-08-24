/**
 * e2e 性能基准回归：共享工具（数据集生成 / 基线对比 / 结果落盘）
 *
 * 设计要点：
 * - 数据集生成在 launchApp() 的临时 userData 目录内（pathGuard 对 userData 始终放行，
 *   无需任何白名单注册即可被 scanner:start({ path }) 扫描，见 src/main/ipc/validator.ts）
 * - 占位 JPEG 与 scripts/perf-test/generate-dataset.ts 的 MINIMAL_JPEG 保持一致
 *   （该脚本顶层含 CLI 入口无法直接 import，故在此内联同构常量）
 * - 判定规则分两层：
 *   1) 绝对阈值（maxMs / minThroughput）—— 任何环境都必须满足的硬护栏
 *   2) 基线回归（baselineValue × regressionFactor）—— 相对历史基线的劣化判定，
 *      仅在数据集规模与基线记录一致时生效（避免数据集变化导致假阳性）
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 工程根目录（e2e/ 的上一级；项目 type=module，用 import.meta.url 定位） */
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 性能结果输出目录（.cache/ 已整体 gitignore） */
export const PERF_CACHE_DIR = path.join(ROOT_DIR, '.cache', 'perf')
/** 最新一次运行结果（供 perf:save-baseline 提升为基线） */
export const PERF_LATEST_PATH = path.join(PERF_CACHE_DIR, 'latest.json')
/** 提交入库的基线文件 */
export const PERF_BASELINE_PATH = path.join(ROOT_DIR, 'e2e', 'perf-baseline.json')

/** 数据集规模（占位图片数），可用环境变量 PERF_DATASET_IMAGES 覆盖 */
export const DATASET_SIZE = Number(process.env.PERF_DATASET_IMAGES ?? 1500)

// 最小有效 JPEG（1x1 像素，与 scripts/perf-test/generate-dataset.ts 同构）
const MINIMAL_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
  0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
  0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20,
  0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27,
  0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
  0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01,
  0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04,
  0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0xff, 0xc4, 0x00, 0xb5, 0x10, 0x00, 0x02, 0x01, 0x03,
  0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7d, 0x01, 0x02, 0x03, 0x00,
  0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32,
  0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72,
  0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35,
  0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55,
  0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
  0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94,
  0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2,
  0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9,
  0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6,
  0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xff, 0xda,
  0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x7b, 0x40, 0x1b, 0xff, 0xd9
])

/**
 * 在目标目录生成 count 个占位 JPEG（文件名含日期戳/套装/场景，贴近真实数据形态）。
 * 返回生成耗时供留档（数据集生成是环境 IO，不作为回归门禁指标）。
 */
export async function generatePerfDataset(
  targetDir: string,
  count: number
): Promise<{ generated: number; elapsedMs: number }> {
  const start = Date.now()
  await fs.mkdir(targetDir, { recursive: true })
  let generated = 0
  for (let i = 0; i < count; i++) {
    // 固定日期前缀即可：扫描按 mtime 取日期，文件名仅用于分类与排序多样性
    const fileName = `20260101_120000_perf_scene_${String(i).padStart(5, '0')}.jpg`
    await fs.writeFile(path.join(targetDir, fileName), MINIMAL_JPEG)
    generated++
  }
  return { generated, elapsedMs: Date.now() - start }
}

// ============ 指标 / 基线 / 结果类型 ============

/** 单个指标的判定规则 */
export interface PerfMetricRule {
  /** 绝对耗时上限（ms），超过即判定失败 */
  maxMs?: number
  /** 绝对吞吐量下限（项/秒），低于即判定失败 */
  minThroughput?: number
  /** 基线值（历史实测，用于相对劣化判定） */
  baselineValue?: number
  /** 相对基线的劣化倍数上限（默认 2.0：超过基线 2 倍判定为回归） */
  regressionFactor?: number
}

/** 提交入库的基线文件结构 */
export interface PerfBaseline {
  version: 1
  recordedAt: string
  environment: string
  datasetImages: number
  metrics: Record<string, PerfMetricRule>
}

/** 单次指标采样 */
export interface PerfSample {
  id: string
  scenario: string
  value: number
  unit: 'ms' | 'items/sec'
  /** 处理量（文件数/条数），用于报告与吞吐量换算 */
  itemsProcessed?: number
  /** 多次采样的原始值（如列表查询的 5 次采样） */
  rawSamples?: number[]
  detail?: string
}

/** 判定违规项 */
export interface PerfViolation {
  metricId: string
  kind: 'threshold' | 'throughput' | 'regression'
  message: string
}

/** 一次完整运行的结果存档 */
export interface PerfRunReport {
  timestamp: string
  platform: string
  nodeVersion: string
  datasetImages: number
  samples: PerfSample[]
  violations: PerfViolation[]
  passed: boolean
}

/** 无基线文件时也生效的绝对护栏（与基线文件中的 maxMs/minThroughput 语义一致） */
export const DEFAULT_HARD_RULES: Record<string, PerfMetricRule> = {
  'cold-start-first-paint': { maxMs: 25_000 },
  'scan-ingest': { maxMs: 120_000 },
  'scan-throughput': { minThroughput: 30 },
  'media-list-page100': { maxMs: 1_000 },
  'media-list-page500': { maxMs: 3_000 },
  'find-duplicates': { maxMs: 180_000 },
  'find-duplicates-throughput': { minThroughput: 25 },
  'cache-get-stats': { maxMs: 1_000 }
}

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * 按规则逐指标判定。
 * 回归判定（相对基线）仅在数据集规模与基线一致时启用，规模不一致时仅执行绝对阈值判定。
 */
export function evaluateSamples(
  samples: PerfSample[],
  baseline: PerfBaseline | null
): PerfViolation[] {
  const violations: PerfViolation[] = []
  const datasetMatches = baseline !== null && baseline.datasetImages === DATASET_SIZE

  for (const sample of samples) {
    // 基线规则覆盖默认护栏：基线文件存在且含该指标时以基线规则为准
    const rule: PerfMetricRule = baseline?.metrics[sample.id] ?? DEFAULT_HARD_RULES[sample.id] ?? {}

    if (rule.maxMs !== undefined && sample.unit === 'ms' && sample.value > rule.maxMs) {
      violations.push({
        metricId: sample.id,
        kind: 'threshold',
        message: `${sample.scenario} 耗时 ${Math.round(sample.value)}ms 超过绝对阈值 ${rule.maxMs}ms`
      })
    }
    if (
      rule.minThroughput !== undefined &&
      sample.unit === 'items/sec' &&
      sample.value < rule.minThroughput
    ) {
      violations.push({
        metricId: sample.id,
        kind: 'throughput',
        message: `${sample.scenario} 吞吐量 ${sample.value.toFixed(1)} 项/秒 低于下限 ${rule.minThroughput} 项/秒`
      })
    }
    if (datasetMatches && rule.baselineValue !== undefined && rule.baselineValue > 0) {
      const factor = rule.regressionFactor ?? 2.0
      if (sample.unit === 'ms') {
        // 耗时类：实测超过 基线 × factor 判定为回归
        const limit = rule.baselineValue * factor
        if (sample.value > limit) {
          violations.push({
            metricId: sample.id,
            kind: 'regression',
            message:
              `${sample.scenario} 实测 ${Math.round(sample.value)}ms 超出基线容忍区间` +
              `（基线 ${Math.round(rule.baselineValue)}ms × ${factor} = ${Math.round(limit)}ms）`
          })
        }
      } else {
        // 吞吐量类：实测低于 基线 ÷ factor 判定为回归（劣化方向为数值变小）
        const floor = rule.baselineValue / factor
        if (sample.value < floor) {
          violations.push({
            metricId: sample.id,
            kind: 'regression',
            message:
              `${sample.scenario} 实测 ${sample.value.toFixed(1)} 项/秒 低于基线容忍区间` +
              `（基线 ${rule.baselineValue.toFixed(1)} ÷ ${factor} = ${floor.toFixed(1)}）`
          })
        }
      }
    }
  }
  return violations
}

export async function loadBaseline(): Promise<PerfBaseline | null> {
  try {
    // strip BOM：防止外部工具写回基线时带入 BOM 导致 JSON.parse 失败后静默降级
    const raw = (await fs.readFile(PERF_BASELINE_PATH, 'utf-8')).replace(/^\uFEFF/, '')
    return JSON.parse(raw) as PerfBaseline
  } catch (err) {
    // 基线文件存在但解析失败 ≠ 无基线：显式告警，避免回归判定被静默跳过
    try {
      await fs.access(PERF_BASELINE_PATH)
      process.stdout.write(`[perf] 警告：基线文件解析失败，本次仅执行绝对阈值判定：${err}\n`)
    } catch {
      // 文件不存在：首次运行属正常情况，无需告警
    }
    return null
  }
}

/** 落盘运行结果：带时间戳存档 + latest.json（供基线提升脚本读取） */
export async function savePerfReport(report: PerfRunReport): Promise<string> {
  await fs.mkdir(PERF_CACHE_DIR, { recursive: true })
  const stamp = report.timestamp.replace(/[:.]/g, '-')
  const archivePath = path.join(PERF_CACHE_DIR, `perf-run-${stamp}.json`)
  await fs.writeFile(archivePath, JSON.stringify(report, null, 2), 'utf-8')
  await fs.writeFile(PERF_LATEST_PATH, JSON.stringify(report, null, 2), 'utf-8')
  return archivePath
}

/** 控制台汇总报告（测试末尾输出，便于 CI 日志直接阅读） */
export function printPerfSummary(report: PerfRunReport): void {
  const lines: string[] = []
  lines.push('')
  lines.push('========== 性能基准回归报告 ==========')
  lines.push(`数据集: ${report.datasetImages} 张占位图片 | 平台: ${report.platform}`)
  for (const s of report.samples) {
    const text = s.unit === 'ms' ? `${Math.round(s.value)}ms` : `${s.value.toFixed(1)} 项/秒`
    lines.push(`  - ${s.scenario}: ${text}${s.detail ? ` (${s.detail})` : ''}`)
  }
  if (report.violations.length === 0) {
    lines.push('判定: ✓ 全部通过（无阈值超限 / 无基线回归）')
  } else {
    lines.push(`判定: ✗ 发现 ${report.violations.length} 项性能回归`)
    for (const v of report.violations) lines.push(`  ✗ [${v.kind}] ${v.message}`)
  }
  lines.push('======================================')
  process.stdout.write(lines.join('\n') + '\n')
}
