/**
 * e2e 性能基准回归：共享工具（数据集生成 / 基线对比 / 结果落盘）
 *
 * 设计要点：
 * - 数据集生成在 launchApp() 的临时 userData 目录内（pathGuard 对 userData 始终放行，
 *   无需任何白名单注册即可被 scanner:start({ path }) 扫描，见 src/main/ipc/validator.ts）
 * - 占位 JPEG 与 scripts/perf-test/generate-dataset.ts 的 MINIMAL_JPEG 保持一致
 *   （该脚本顶层含 CLI 入口无法直接 import，故在此内联同构常量）
 * - 判定规则分两层：
 *   1) 绝对阈值（maxMs / minThroughput）—— 任何环境都必须满足的硬护栏，全局共享一份
 *   2) 基线回归（baselineValue × regressionFactor）—— 相对历史基线的劣化判定，
 *      仅在数据集规模与基线记录一致时生效（避免数据集变化导致假阳性）
 * - 相对基线按**运行环境分段**（v2 基线的 environments.dev / environments.ci）：
 *   基线是「机器 + 数据集」的快照，拿开发机读数去比 CI 硬件会让比较对象与被测环境不一致
 *   （run 39623462678 的 step 10 即因此以 3 条相对回归判红，而同一份产物在开发机全绿）。
 *   两段的 regressionFactor 必须逐项相同——分段只换比较对象，不换容忍系数。
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

/** 基线分段的环境键：开发机本机 vs GitHub Actions 托管 runner */
export type PerfEnvKey = 'dev' | 'ci'

/** 单个指标的绝对护栏（任何环境都必须满足） */
export interface PerfMetricRule {
  /** 绝对耗时上限（ms），超过即判定失败 */
  maxMs?: number
  /** 绝对吞吐量下限（项/秒），低于即判定失败 */
  minThroughput?: number
}

/** 单个指标在某环境段上的相对回归规则 */
export interface PerfRelativeRule {
  /** 该环境实测的基线值，用于相对劣化判定 */
  baselineValue: number
  /** 相对基线的劣化倍数上限（各环境段必须同值，分段不换系数） */
  regressionFactor: number
}

/** 一个环境段：同一类硬件上录到的一组相对基线 */
export interface PerfEnvironmentSection {
  /** 最后一次固化时间（多样本时为中位数样本的时间戳） */
  recordedAt: string
  /** 人类可读的硬件/宿主描述（不参与判定，仅供复核） */
  environment: string
  /** final=多次采样固化；provisional=样本不足播种，相对判定照常生效，待补样转正 */
  status: 'final' | 'provisional'
  /** 参与聚合的实测报告份数 */
  sampleCount: number
  /** 读数来源（运行号 / 存档名），保证基线可追溯到真实运行 */
  sourceRuns: string[]
  metrics: Record<string, PerfRelativeRule>
}

/** 提交入库的基线文件结构（v2：绝对护栏全局共享，相对基线按环境分段） */
export interface PerfBaseline {
  version: 2
  datasetImages: number
  hardRules: Record<string, PerfMetricRule>
  environments: Partial<Record<PerfEnvKey, PerfEnvironmentSection>>
}

/**
 * 判定本次运行属于哪个环境段。
 *
 * 只认 PERF_ENV 显式覆盖与 GitHub Actions 的宿主身份信号，**不认裸 CI**：
 * 开发机的 shell / IDE 也可能带 CI=true，选错段等于悄悄把比较口径换成另一台机器。
 */
export function resolvePerfEnv(env: NodeJS.ProcessEnv = process.env): PerfEnvKey {
  if (env.PERF_ENV === 'ci' || env.PERF_ENV === 'CI') return 'ci'
  if (env.PERF_ENV === 'dev' || env.PERF_ENV === 'DEV') return 'dev'
  return env.GITHUB_ACTIONS === 'true' || env.RUNNER_ENVIRONMENT === 'github-hosted' ? 'ci' : 'dev'
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
  /** missing_section = 所选环境段尚未入库：显式判红，不静默退化为「只跑绝对阈值」 */
  kind: 'threshold' | 'throughput' | 'regression' | 'missing_section'
  message: string
}

/** 一次完整运行的结果存档 */
export interface PerfRunReport {
  timestamp: string
  platform: string
  nodeVersion: string
  /** 本次运行按哪个环境段判定（platform 串在开发机与 CI 上字面相同，无法区分环境） */
  perfEnv: PerfEnvKey
  datasetImages: number
  samples: PerfSample[]
  violations: PerfViolation[]
  passed: boolean
}

/** 无基线文件时也生效的绝对护栏（与基线文件 hardRules 语义一致，按指标 id 回退） */
export const DEFAULT_HARD_RULES: Record<string, PerfMetricRule> = {
  'cold-start-first-paint': { maxMs: 25_000 },
  'scan-ingest': { maxMs: 120_000 },
  'scan-throughput': { minThroughput: 30 },
  'media-list-page100': { maxMs: 1_000 },
  'media-list-page500': { maxMs: 3_000 },
  'find-duplicates': { maxMs: 180_000 },
  'find-duplicates-throughput': { minThroughput: 25 },
  'cache-get-stats': { maxMs: 1_000 },
  // 缩略图链路（fix-thumbnail-loading-performance-round2 节点0）：
  // 阈值先取宽松硬护栏，实测稳定后用 npm run perf:save-baseline 固化为相对基线判定
  'thumbnail-generate-p95': { maxMs: 8_000 },
  'first-thumbnail-visible': { maxMs: 15_000 }
}

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * 按规则逐指标判定。
 *
 * - 绝对护栏取全局 `hardRules`，缺条目时回退 `DEFAULT_HARD_RULES`（整对象替换，与 v1 语义一致）；
 * - 相对基线只从**所选环境段**取，段缺失判一条 `missing_section`（宁可显式红，也不静默丢掉回归能力）；
 * - 回归判定仅在数据集规模与基线记录一致时启用，规模不一致时只执行绝对阈值判定。
 */
export function evaluateSamples(
  samples: PerfSample[],
  baseline: PerfBaseline | null,
  envKey: PerfEnvKey
): PerfViolation[] {
  const violations: PerfViolation[] = []
  const datasetMatches = baseline !== null && baseline.datasetImages === DATASET_SIZE
  const section = baseline?.environments?.[envKey]

  // 基线存在但所选环境段没入库：与「数据集规模不一致」区分开，单独报一条
  if (baseline !== null && datasetMatches && !section) {
    violations.push({
      metricId: '(env-section)',
      kind: 'missing_section',
      message:
        `基线缺少环境段 '${envKey}'，相对回归判定无法执行（本次仅绝对阈值生效）；` +
        `请先采集该环境的实测报告，再用 npm run perf:save-baseline -- --env ${envKey} --samples <报告...> 固化`
    })
  }

  for (const sample of samples) {
    const hardRule: PerfMetricRule =
      baseline?.hardRules?.[sample.id] ?? DEFAULT_HARD_RULES[sample.id] ?? {}
    const relativeRule = datasetMatches ? (section?.metrics[sample.id] ?? null) : null

    if (hardRule.maxMs !== undefined && sample.unit === 'ms' && sample.value > hardRule.maxMs) {
      violations.push({
        metricId: sample.id,
        kind: 'threshold',
        message: `${sample.scenario} 耗时 ${Math.round(sample.value)}ms 超过绝对阈值 ${hardRule.maxMs}ms`
      })
    }
    if (
      hardRule.minThroughput !== undefined &&
      sample.unit === 'items/sec' &&
      sample.value < hardRule.minThroughput
    ) {
      violations.push({
        metricId: sample.id,
        kind: 'throughput',
        message: `${sample.scenario} 吞吐量 ${sample.value.toFixed(1)} 项/秒 低于下限 ${hardRule.minThroughput} 项/秒`
      })
    }
    if (relativeRule !== null && relativeRule.baselineValue > 0) {
      const factor = relativeRule.regressionFactor
      if (sample.unit === 'ms') {
        // 耗时类：实测超过 基线 × factor 判定为回归
        const limit = relativeRule.baselineValue * factor
        if (sample.value > limit) {
          violations.push({
            metricId: sample.id,
            kind: 'regression',
            message:
              `${sample.scenario} 实测 ${Math.round(sample.value)}ms 超出基线容忍区间` +
              `（基线 ${Math.round(relativeRule.baselineValue)}ms × ${factor} = ${Math.round(limit)}ms）`
          })
        }
      } else {
        // 吞吐量类：实测低于 基线 ÷ factor 判定为回归（劣化方向为数值变小）
        const floor = relativeRule.baselineValue / factor
        if (sample.value < floor) {
          violations.push({
            metricId: sample.id,
            kind: 'regression',
            message:
              `${sample.scenario} 实测 ${sample.value.toFixed(1)} 项/秒 低于基线容忍区间` +
              `（基线 ${relativeRule.baselineValue.toFixed(1)} ÷ ${factor} = ${floor.toFixed(1)}）`
          })
        }
      }
    }
  }
  return violations
}

/**
 * 校验并解析基线正文（纯函数，供 loadBaseline 与单测共用）。
 * 结构不合一律抛错——**不做 v1→v2 迁移**：v1 的相对基线是开发机单次读数，
 * 静默迁移等于把「比较对象与被测环境不一致」这个缺陷原样带进新格式。
 */
export function parseBaseline(raw: string): PerfBaseline {
  // strip BOM：外部工具写回基线时可能带 BOM，不剥掉会让 JSON.parse 抛错后静默降级
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as Partial<PerfBaseline> & {
    version?: number
  }
  if (parsed.version !== 2) {
    throw new Error(`基线 version 必须为 2（实际 ${String(parsed.version)}）`)
  }
  if (typeof parsed.datasetImages !== 'number' || parsed.datasetImages <= 0) {
    throw new Error(`基线 datasetImages 必须为正数（实际 ${String(parsed.datasetImages)}）`)
  }
  if (typeof parsed.hardRules !== 'object' || parsed.hardRules === null) {
    throw new Error('基线缺少 hardRules 对象（绝对护栏）')
  }
  if (typeof parsed.environments !== 'object' || parsed.environments === null) {
    throw new Error('基线缺少 environments 对象（按环境分段的相对基线）')
  }
  for (const [key, section] of Object.entries(parsed.environments)) {
    if (typeof section !== 'object' || section === null) {
      throw new Error(`基线环境段 ${key} 不是对象`)
    }
    if (section.status !== 'final' && section.status !== 'provisional') {
      throw new Error(`基线环境段 ${key} 的 status 非法（实际 ${String(section.status)}）`)
    }
    if (!Number.isInteger(section.sampleCount) || (section.sampleCount ?? 0) < 0) {
      throw new Error(`基线环境段 ${key} 的 sampleCount 必须为非负整数`)
    }
    if (!Array.isArray(section.sourceRuns) || section.sourceRuns.length === 0) {
      throw new Error(`基线环境段 ${key} 的 sourceRuns 必须是非空数组（基线须可追溯到真实运行）`)
    }
    if (typeof section.metrics !== 'object' || section.metrics === null) {
      throw new Error(`基线环境段 ${key} 缺少 metrics 对象`)
    }
    for (const [id, rule] of Object.entries(section.metrics)) {
      if (!rule || !(rule.baselineValue > 0) || !(rule.regressionFactor > 0)) {
        throw new Error(`基线环境段 ${key} 的 ${id} 必须带正的 baselineValue 与 regressionFactor`)
      }
    }
  }
  return parsed as PerfBaseline
}

export async function loadBaseline(): Promise<PerfBaseline | null> {
  try {
    const raw = await fs.readFile(PERF_BASELINE_PATH, 'utf-8')
    return parseBaseline(raw)
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

/**
 * 日志行去重键：electron-log 会把同一事件同时写进 `main.log` 与 `main-<日期>.log`，
 * 两份的时间戳格式还不一样（ISO UTC 与本地空格分隔），按行直接计数会把一次事件数成两次
 * （本机实测：`[Thumbnail Cleanup] 清理 144 个孤儿缩略图` 被数成 2 条）。
 *
 * 键 = 「秒级 epoch」+ 去掉级别前缀后的正文。用秒而非毫秒：两份写入时刻实测差 1ms
 * （`.094Z` vs `.095`），按毫秒分桶去不掉重。
 * 无法识别的行原样返回（不参与合并）。
 */
export function logLineKey(line: string): string {
  const m = /^\s*\[([^\]]+)\]\s*\[(?:info|warn|error|debug|trace)\]\s*(.*)$/i.exec(line)
  if (!m) return line.trim()
  const raw = m[1].trim()
  const isoish = raw.includes('T') ? raw : raw.replace(' ', 'T')
  const ms = Date.parse(isoish)
  return `${Number.isNaN(ms) ? raw : Math.floor(ms / 1000)}|${m[2].trim()}`
}

/**
 * 统计应用日志中匹配某条正则的行数，并回传最多 3 条原文样本。
 * 用途：缩略图链路的「回写数据库失败」等告警属于副作用型缺陷，单靠耗时指标看不出来，
 * 必须从 {userData}/logs 里数出来才能判定「这次到底有没有踩到」。日志缺失返回 0，不抛错。
 */
export async function countLogPattern(
  userDataDir: string,
  pattern: RegExp
): Promise<{ count: number; samples: string[] }> {
  const logDir = path.join(userDataDir, 'logs')
  let entries: string[] = []
  try {
    entries = await fs.readdir(logDir)
  } catch {
    return { count: 0, samples: [] }
  }
  const seen = new Set<string>()
  const samples: string[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.log')) continue
    let raw = ''
    try {
      raw = await fs.readFile(path.join(logDir, entry), 'utf-8')
    } catch {
      continue
    }
    for (const line of raw.split(/\r?\n/)) {
      if (!pattern.test(line)) continue
      const key = logLineKey(line)
      if (seen.has(key)) continue
      seen.add(key)
      if (samples.length < 3) samples.push(line.slice(0, 240))
    }
  }
  return { count: seen.size, samples }
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

/** 控制台汇总报告（测试末尾输出，便于 CI 日志直接阅读；环境段必须自证用的是哪一段） */
export function printPerfSummary(report: PerfRunReport, baseline?: PerfBaseline | null): void {
  const lines: string[] = []
  lines.push('')
  lines.push('========== 性能基准回归报告 ==========')
  lines.push(`数据集: ${report.datasetImages} 张占位图片 | 平台: ${report.platform}`)
  const section = baseline?.environments?.[report.perfEnv]
  lines.push(
    `环境段: ${report.perfEnv}` +
      (section
        ? `（${section.status}, ${section.sampleCount} 样, 记录于 ${section.recordedAt}）`
        : '（缺失：相对回归判定未生效，见下方 missing_section）')
  )
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
