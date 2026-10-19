/**
 * 阶段 6：同步元数据解析的驱动层（零依赖纯函数）。
 *
 * 本文件不 import Electron、不 import `@nikkisync/*`、不发任何网络请求：
 * 它只把「开关 → 配置片段」和「一次扫描后 → 有界解析轮次」两件事算清楚，
 * 真正的上游对象由 `runtime-facade.ts` 构造后以 `unknown` 注入，因此全部逻辑
 * 可在未建链的 CI 上单测（链接态那份会整件 skip，不能替代这里的覆盖面）。
 *
 * 三条不可让步的判据（各带上游证据）：
 *
 * 1. **关闭 ⇒ 键整个缺失**，不是传 `{ enabled: false }`。
 *    上游 `MetadataResolverService.runOnce()` 首行即
 *    `if (this.running || !this.config.enabled) return 0`，
 *    传 `false` 会连我们自己的手动驱动一起短路掉。
 * 2. **绝不下发 `intervalMs`**，尤其不能下发 0。
 *    上游构造期用 `config.intervalMs ?? 15_000` 取值，`0` 不会回落默认，
 *    而是直接造出 `setInterval(fn, 0)`；本层不启动上游自轮询（改由扫描后有界驱动），
 *    因此这个键根本不该出现在配置里，这里把它写成显式不可下发。
 * 3. **驱动永不 reject**。
 *    上游 `runOnce()` 外层只有 `try/finally` 没有 `catch`，候选 SELECT 与
 *    `updateMetadata` 的 DB 错误会直接上抛；若冒到扫描链就变成未捕获 rejection，
 *    而解析失败绝不能影响已经成功的扫描。
 */

/** 上游 `Nuan5CompatibleResolver` 的默认端点；本层显式下传，保证设置页披露文案与实际出口同源。 */
export const NUAN5_METADATA_ENDPOINT = 'https://nuan5.pro/api/decode-photo2'

/** 单轮远端解析上限：上游默认 12，这里收窄以摊薄 revision 抖动与单轮墙上时间。 */
export const DEFAULT_METADATA_BATCH_SIZE = 4
const MIN_METADATA_BATCH_SIZE = 1
const MAX_METADATA_BATCH_SIZE = 12

/**
 * 一次扫描后最多发起多少轮（每轮上限 = batchSize 次远端请求）。
 *
 * 取值理由：默认 50 × 4 = 200 条资产，够一个中型库一次扫完。
 * 上游 `runOnce()` 在候选耗尽或全部进入冷却时**返回 0**，循环随即收敛，
 * 因此这个上界只用来防「候选持续非零」的异常情形（例如每次扫都塞新照片），
 * 不是常规终止条件。上游自己就是因为「只取第一批 12 条、后续行饿死」在
 * `467b590 fix(pc): continue first-run metadata parsing beyond the first batch`
 * 修过一轮，本仓不能再把收敛压成 20 条。
 */
export const DEFAULT_METADATA_MAX_PASSES = 50
const MIN_METADATA_MAX_PASSES = 1
const MAX_METADATA_MAX_PASSES = 200

/** 失败行的重试冷却由上游默认值（10 分钟）承担：不在输入里就不下发，见下。 */

/** 开关判据：env 逃生阀优先，其余一律以「设置值恰好是布尔 true」为准。 */
export function resolveMetadataResolverEnabled(
  envValue: string | undefined,
  settingValue: unknown
): boolean {
  if (envValue === '1') return true
  if (envValue === '0') return false
  return settingValue === true
}

export function clampMetadataBatchSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_METADATA_BATCH_SIZE
  const floored = Math.floor(value)
  if (floored < MIN_METADATA_BATCH_SIZE) return DEFAULT_METADATA_BATCH_SIZE
  return Math.min(floored, MAX_METADATA_BATCH_SIZE)
}

export function clampMetadataMaxPasses(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_METADATA_MAX_PASSES
  const floored = Math.floor(value)
  if (floored < MIN_METADATA_MAX_PASSES) return DEFAULT_METADATA_MAX_PASSES
  return Math.min(floored, MAX_METADATA_MAX_PASSES)
}

/** 交给 `PcCompanionRuntime` 的配置片段（关闭时为 `{}`）。 */
export interface MetadataResolverConfigFragment {
  metadataResolver?: {
    resolver: unknown
    service: { enabled: boolean; batchSize: number; retryAfterMs?: number }
  }
}

export interface MetadataResolverConfigInput {
  enabled: boolean
  /** https 端点；非 https 在构造期即拒绝，不静默降级成明文出口。 */
  endpoint: string
  /** 惰性工厂：关闭时绝不调用，避免无谓装载上游模块。入参是已通过校验的端点。 */
  createResolver: (endpoint: string) => unknown
  batchSize?: number
  retryAfterMs?: number
}

/**
 * 折算成上游 `metadataResolver` 配置键。
 *
 * `retryAfterMs` 只在显式给出时下发：上游把它折进 `checked.retryAt`，
 * 传一个比默认更小的值会让失败行过早重试（等于反复打第三方端点）。
 */
export function buildMetadataResolverConfig(
  input: MetadataResolverConfigInput
): MetadataResolverConfigFragment {
  if (!input.enabled) return {}
  const endpoint = requireHttpsEndpoint(input.endpoint)
  return {
    metadataResolver: {
      // 校验过的端点在这里下传给工厂：调用方因此不可能拿到一个「校验的是 A、构造用的是 B」的对象
      resolver: input.createResolver(endpoint),
      service: {
        enabled: true,
        batchSize: clampMetadataBatchSize(input.batchSize),
        ...(input.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: Math.max(0, Math.floor(input.retryAfterMs)) })
      }
    }
  }
}

/** 端点校验：空值与非 https 各自给出可定位的原因（消息截断，不回显超长输入）。 */
function requireHttpsEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim()
  if (!trimmed) throw new Error('metadata resolver endpoint is required')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`metadata resolver endpoint is not a valid URL: ${trimmed.slice(0, 200)}`)
  }
  if (url.protocol !== 'https:') {
    throw new Error(`metadata resolver endpoint must be an https URL: ${url.protocol}`)
  }
  return trimmed
}

export interface MetadataResolutionDriveInput {
  /** 上游 `MetadataResolverService.runOnce()`。返回值 = 本轮解析成功的资产数。 */
  runOnce: () => Promise<number>
  maxPasses?: number
  /** 驱动启动时捕获的代次；与 `generation()` 不一致即停止发起下一轮。 */
  initialGeneration: number
  /** 当前代次（会话拆除时由编排层递增）。 */
  generation: () => number
  log: (level: 'info' | 'warn' | 'error', message: string) => void
}

export interface MetadataResolutionDriveResult {
  /** 实际发起并完成轮次；`aborted` / `failed` 终止的那一轮不计入。 */
  passes: number
  /** 各轮返回值之和 = 本次驱动解析掉的资产数。 */
  resolved: number
  /** 因代次失效提前收尾。 */
  aborted: boolean
  /** 某一轮抛错（DB / 上游内部故障）；错误只落日志，不外抛。 */
  failed: boolean
}

/**
 * 扫描结束后的有界解析驱动。
 *
 * 为什么用代次而不是超时：`runWithTimeout` 超时只是让 Promise resolve，
 * **并不中断**在跑的 `runOnce`，那会让会话拆除与 `updateMetadata` 事务重叠。
 * 所以只在「每轮开始前」检查代次来停止发起下一轮；已在飞的请求由上游自带的
 * 12s abort 看门狗收敛，其结果因代次失效被上层丢弃。
 *
 * 收敛判据取上游语义：`runOnce()` 返回 0 表示候选队列已空或已进冷却，
 * 上游自身也有「idle 时一个 SELECT 都不发」的短路，因此无需再加空闲探测轮次。
 */
export async function runBoundedMetadataResolution(
  input: MetadataResolutionDriveInput
): Promise<MetadataResolutionDriveResult> {
  const maxPasses = clampMetadataMaxPasses(input.maxPasses)
  let passes = 0
  let resolved = 0
  let aborted = false
  let failed = false

  for (let round = 0; round < maxPasses; round++) {
    if (input.generation() !== input.initialGeneration) {
      aborted = true
      break
    }
    let count: number
    try {
      count = await input.runOnce()
    } catch (error) {
      failed = true
      input.log('warn', `nikkisync metadata resolution stopped: ${errorText(error)}`)
      break
    }
    passes += 1
    resolved += Number.isFinite(count) && count > 0 ? count : 0
    if (!(count > 0)) break
  }

  return { passes, resolved, aborted, failed }
}

/** 日志文本只用错误消息，且截断：路径与原始信封不得进日志。 */
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 300)
}
