/**
 * 把最近一次性能实测读数打成一行 GitHub Actions 注解（::notice title=perf-readings::）
 *
 * 为什么需要这一步：固化 ci 段基线要多次采样，但取数通道在本机是关的——
 * artifact 下载与 step 日志正文都需要鉴权（无 token ⇒ 401/404），而
 * `GET /repos/{owner}/{repo}/check-runs/{jobId}/annotations` 免鉴权可读。
 * 于是把读数压成一行 notice 注解，绿运行也能零 token 取回样本。
 *
 * 用法：
 *   npm run perf:readings            # 读 .cache/perf/latest.json 并打印注解行
 *
 * 铁律：本脚本只读，绝不写任何文件；输出必须是单行（workflow 命令按行解析）。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const LATEST_PATH = path.join(ROOT_DIR, '.cache', 'perf', 'latest.json')
const BASELINE_PATH = path.join(ROOT_DIR, 'e2e', 'perf-baseline.json')

export interface ReadingsSampleLike {
  id: string
  value: number
  unit: 'ms' | 'items/sec'
}

export interface ReadingsReportLike {
  timestamp: string
  platform: string
  /** 本次判定用的环境段；旧报告没有该字段时按 dev 处理 */
  perfEnv?: 'dev' | 'ci'
  datasetImages: number
  samples: ReadingsSampleLike[]
}

/** workflow 命令正文的转义口径：`%` → `%25`、CR → `%D`、LF → `%A`（否则会被按行截断） */
export function escapeWorkflowMessage(text: string): string {
  // 顺序不能换：先转 % 再转换行，否则 %25 会被二次转义成 %2525
  return text.replace(/%/g, '%25').replace(/\r/g, '%D').replace(/\n/g, '%A')
}

/** 生成单行注解：标题固定 perf-readings，正文是 `k=v` 空格分隔 + readings 分号列表 */
export function buildPerfReadingsAnnotation(
  report: ReadingsReportLike,
  section: { status: 'final' | 'provisional' | 'missing'; sampleCount: number }
): string {
  if (!report.samples || report.samples.length === 0) {
    throw new Error('报告中无采样数据，拒绝输出空的性能读数注解（恒空读数会被当成通过）')
  }
  const readings = report.samples
    .map((s) => `${s.id}=${s.unit === 'ms' ? Math.round(s.value) : s.value.toFixed(1)}`)
    .join(';')
  // 本轮之前的旧存档没有 perfEnv 字段：标 unknown 而不是冒充 dev，否则 CI 产物会被误读成开发机样本
  const envKey = report.perfEnv ?? 'unknown'
  return escapeWorkflowMessage(
    `::notice title=perf-readings::env=${envKey} status=${section.status} ` +
      `samples=${section.sampleCount} dataset=${report.datasetImages} readings=${readings}`
  )
}

async function main(): Promise<void> {
  let report: ReadingsReportLike
  try {
    report = JSON.parse(await fs.readFile(LATEST_PATH, 'utf-8')) as ReadingsReportLike
  } catch {
    console.error(`[perf-readings] 读不到最近一次运行结果: ${LATEST_PATH}`)
    console.error('请先执行: npm run e2e:perf')
    process.exit(1)
    return
  }

  let section: { status: 'final' | 'provisional' | 'missing'; sampleCount: number } = {
    status: 'missing',
    sampleCount: 0
  }
  try {
    const baseline = JSON.parse(await fs.readFile(BASELINE_PATH, 'utf-8')) as {
      environments?: Record<string, { status?: string; sampleCount?: number }>
    }
    const current = report.perfEnv ? baseline.environments?.[report.perfEnv] : undefined
    if (current?.status === 'final' || current?.status === 'provisional') {
      section = { status: current.status, sampleCount: current.sampleCount ?? 0 }
    }
  } catch {
    // 基线缺失或结构不合时仍要出读数：状态标 missing，由固化环节判读，不吞掉本次样本
  }

  try {
    process.stdout.write(buildPerfReadingsAnnotation(report, section) + '\n')
  } catch (err) {
    console.error(`[perf-readings] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  main().catch((err) => {
    console.error('[perf-readings] 输出失败:', err)
    process.exit(1)
  })
}
