/**
 * ETA 估算器（性能重构 v3 改造项三）
 * 文档：docs/PERFORMANCE_REFACTOR_PLAN.md §4.3
 *
 * 算法：滑动窗口平均吞吐量（最近 10 个样本）。
 * - 样本数 < 2 或吞吐量 ≤ 0 时返回 0（无法估算）
 * - 吞吐量 = (末样本.count - 首样本.count) / (末样本.t - 首样本.t)
 * - 剩余时间 = (total - current) / 吞吐量
 *
 * 不引入第三方依赖，约 60 行，符合「极简健壮」原则。
 */

interface EtaSample {
  /** 时间戳（Date.now()） */
  t: number
  /** 当前已处理数量 */
  count: number
}

export class EtaCalculator {
  /** 滑动窗口样本（按时间顺序，最早在前） */
  private samples: EtaSample[] = []
  /** 窗口大小，控制最近 N 个样本参与估算 */
  private readonly windowSize: number

  constructor(windowSize = 10) {
    this.windowSize = Math.max(2, windowSize)
  }

  /**
   * 推入新样本并计算 ETA。
   * @param currentCount 当前已处理数量
   * @param total 总数量
   * @returns etaMs 剩余毫秒；perSec 吞吐量条目/秒
   */
  push(currentCount: number, total: number): { etaMs: number; perSec: number } {
    const now = Date.now()
    this.samples.push({ t: now, count: currentCount })
    // 维持窗口大小：超出则丢弃最早样本
    if (this.samples.length > this.windowSize) {
      this.samples.shift()
    }

    // 样本不足 / 已完成 → 无法估算
    if (this.samples.length < 2 || currentCount >= total) {
      return { etaMs: 0, perSec: 0 }
    }

    const first = this.samples[0]
    const last = this.samples[this.samples.length - 1]
    const elapsedSec = (last.t - first.t) / 1000
    const processedInWindow = last.count - first.count

    // 时间未推进 / 处理量未增加 → 无法估算
    if (elapsedSec <= 0 || processedInWindow <= 0) {
      return { etaMs: 0, perSec: 0 }
    }

    const perSec = processedInWindow / elapsedSec
    const remaining = total - currentCount
    // 吞吐量为 0 时避免除零
    if (perSec <= 0) {
      return { etaMs: 0, perSec: 0 }
    }
    const etaMs = Math.ceil((remaining / perSec) * 1000)

    return { etaMs, perSec }
  }

  /** 任务开始 / 重新开始时清空样本 */
  reset(): void {
    this.samples = []
  }
}
