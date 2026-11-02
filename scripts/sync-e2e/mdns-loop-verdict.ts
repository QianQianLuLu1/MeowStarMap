/**
 * mDNS 自激复测的判据层（零依赖纯函数，02 计划 N5）。
 *
 * 本仓 `SYNC_SERVER_DEFAULT_MDNS` 长期为 `false`，依据是 2026-10-14 在 `NikkiSync@d4ca7d7`
 * 上的一次实测（公告包经组播回环送回自己并被立即重发，45s 收到 1,568,807 条）。上游后来
 * 加了「只响应带查询计数的包」闸门并改成每网卡独立 socket，那份证据是否还成立必须能用
 * 同一把尺子复量，而不是靠注释里的一句「上游应该修了」。
 *
 * 阈值取 5 包/秒：健康态是「每个 LAN IPv4 每 15s 一次公告」，单机两块网卡 60s 也才个位数；
 * 一旦回到自激量级就是每秒数千至上万条，5 包/秒处在两个实测形态之间，不误伤也不放过。
 *
 * 约定：`scripts/**` 与 `src/**` 同受中文硬编码护栏约束，用户可读文案留给 i18n 消费方，
 * 本层只出英文短码与数字。
 */

export type MdnsLoopVerdict = 'no_loop' | 'feedback_loop' | 'inconclusive'

/** 一次 A/B 复测的原始读数（包数按「载荷含本次 serverId」过滤后计）。 */
export interface MdnsLoopReadings {
  readonly onPackets: number
  readonly offPackets: number
  readonly seconds: number
}

export interface MdnsLoopJudgement {
  readonly verdict: MdnsLoopVerdict
  readonly packetsPerSecond: number
  readonly thresholdPerSecond: number
  readonly reason: string
}

/** 判定「无自激」的速率上限（包/秒，严格小于才算过）。 */
export const MDNS_LOOP_RATE_PER_SECOND_LIMIT = 5

/** 非负安全整数判据（NaN / 小数 / 负数 / Infinity 一律拒）。 */
function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

/**
 * 纯函数：把 A/B 读数折算成结论。
 *
 * 三条不可让步的判据：
 * 1. 读数不完整（秒数 < 1、包数非法）⇒ 抛错，绝不给「看起来没事」的默认结论；
 * 2. 对照组（`mdns:false` 同窗口）非 0 ⇒ `inconclusive`：观测面被第三方 mDNS 流量污染，
 *    此时实验组的数不可归因，不得据此翻默认位；
 * 3. 速率**恰好等于**阈值判 `feedback_loop`——自激的判据是「不超过」，不是「不小于」。
 */
export function classifyMdnsLoopReadings(input: MdnsLoopReadings): MdnsLoopJudgement {
  if (!isCount(input.onPackets) || !isCount(input.offPackets) || !isCount(input.seconds)) {
    throw new Error(
      `invalid_readings: on=${input.onPackets} off=${input.offPackets} seconds=${input.seconds}`
    )
  }
  if (input.seconds < 1) {
    throw new Error(`invalid_readings: seconds must be >= 1, got ${input.seconds}`)
  }
  const packetsPerSecond = input.onPackets / input.seconds
  if (input.offPackets > 0) {
    return {
      verdict: 'inconclusive',
      packetsPerSecond,
      thresholdPerSecond: MDNS_LOOP_RATE_PER_SECOND_LIMIT,
      reason: `control window is not quiet: off-window packets=${input.offPackets}`
    }
  }
  if (packetsPerSecond < MDNS_LOOP_RATE_PER_SECOND_LIMIT) {
    return {
      verdict: 'no_loop',
      packetsPerSecond,
      thresholdPerSecond: MDNS_LOOP_RATE_PER_SECOND_LIMIT,
      reason: 'announcement rate stays at the periodic-advertise level'
    }
  }
  return {
    verdict: 'feedback_loop',
    packetsPerSecond,
    thresholdPerSecond: MDNS_LOOP_RATE_PER_SECOND_LIMIT,
    reason: 'announcement rate exceeds the periodic-advertise ceiling'
  }
}

/** 输出层：一行可读读数（壳直接用，不在壳里拼判据）。 */
export function formatMdnsLoopReadings(input: MdnsLoopReadings, exitCode = 0): string {
  const judgement = classifyMdnsLoopReadings(input)
  const rate = `${judgement.packetsPerSecond.toFixed(1)}/s`
  return (
    `[mdns-loop-probe] on=${input.onPackets} off=${input.offPackets} ` +
    `seconds=${input.seconds} rate=${rate} limit=${MDNS_LOOP_RATE_PER_SECOND_LIMIT}/s ` +
    `verdict=${judgement.verdict} reason=${judgement.reason} exit=${exitCode}`
  )
}

/** 探针窗口秒数：缺省、下限、上限（闭区间）。 */
export const MDNS_PROBE_SECONDS_DEFAULT = 60
export const MDNS_PROBE_SECONDS_MIN = 10
export const MDNS_PROBE_SECONDS_MAX = 300

/**
 * 纯函数：解析探针参数。
 *
 * 刻意**不接受** `--mdns` 这类单边开关：探针总是成对跑「开组播 / 关组播」两个窗口，
 * 只测一边等于没有对照——对照组非 0 或压根没测时，判据只能给 `inconclusive`。
 * 下限 10s 短于上游 15s 的刷新周期，够抓自激（量级是每秒数千条）但不足以评判慢速泄漏，
 * 因此默认走 60s（覆盖 4 个刷新周期）。
 */
export function parseMdnsProbeArgs(argv: readonly string[]): { seconds: number } {
  let seconds = MDNS_PROBE_SECONDS_DEFAULT
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag !== '--seconds') {
      throw new Error(`invalid_args: unknown argument ${String(flag)}`)
    }
    const raw = argv[index + 1]
    if (raw === undefined) {
      throw new Error('invalid_args: --seconds requires a value')
    }
    index += 1
    const value = Number(raw)
    if (
      !Number.isSafeInteger(value) ||
      value < MDNS_PROBE_SECONDS_MIN ||
      value > MDNS_PROBE_SECONDS_MAX
    ) {
      throw new Error(
        `invalid_args: --seconds=${raw} expects an integer in ` +
          `${MDNS_PROBE_SECONDS_MIN}..${MDNS_PROBE_SECONDS_MAX}`
      )
    }
    seconds = value
  }
  return { seconds }
}
