// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  MDNS_LOOP_RATE_PER_SECOND_LIMIT,
  classifyMdnsLoopReadings,
  formatMdnsLoopReadings,
  parseMdnsProbeArgs
} from '../sync-e2e/mdns-loop-verdict'

/**
 * mDNS 自激判据（02 计划 N5）。
 *
 * 背景：本仓把 `SYNC_SERVER_DEFAULT_MDNS` 摁在 `false`，理由是一份 2026-10-14 在
 * `NikkiSync@d4ca7d7` 上的实测（1,568,807 包 / 45s 的组播自激）。防自环闸门在采纳锚点
 * `b397e0e` 已存在、`a5a43f9` 又把公告器改成每网卡独立 socket ⇒ 那个默认值的证据已过期。
 * 判据必须是可复跑的数，不能靠注释里的一句「上游修了就开」。
 *
 * 覆盖三类：
 *   正常 — 对照组为 0 且实验组低于阈值 ⇒ no_loop；等于/超过阈值 ⇒ feedback_loop
 *   异常 — 非整数/负数/秒数 0 ⇒ 抛错（读数不完整时绝不给结论）
 *   边界 — 阈值恰等归 feedback_loop；对照组非 0 ⇒ inconclusive（观测面被污染，判不得）
 */

describe('classifyMdnsLoopReadings', () => {
  it('正常：对照组 0、实验组远低于阈值 ⇒ no_loop，并给出速率供回写', () => {
    const result = classifyMdnsLoopReadings({ onPackets: 8, offPackets: 0, seconds: 60 })
    expect(result.verdict).toBe('no_loop')
    expect(result.packetsPerSecond).toBeCloseTo(8 / 60, 6)
    expect(result.thresholdPerSecond).toBe(MDNS_LOOP_RATE_PER_SECOND_LIMIT)
  })

  it('正常：实验组达到量级 ⇒ feedback_loop（默认位必须保持关闭）', () => {
    expect(
      classifyMdnsLoopReadings({ onPackets: 1_568_807, offPackets: 0, seconds: 45 }).verdict
    ).toBe('feedback_loop')
  })

  it('异常：秒数为 0 / 负数 / 非整数，或包数为负 / 非整数 ⇒ 抛错而不是给结论', () => {
    expect(() => classifyMdnsLoopReadings({ onPackets: 1, offPackets: 0, seconds: 0 })).toThrow(
      /invalid_readings/
    )
    expect(() => classifyMdnsLoopReadings({ onPackets: -1, offPackets: 0, seconds: 60 })).toThrow(
      /invalid_readings/
    )
    expect(() => classifyMdnsLoopReadings({ onPackets: 1.5, offPackets: 0, seconds: 60 })).toThrow(
      /invalid_readings/
    )
    expect(() =>
      classifyMdnsLoopReadings({ onPackets: 1, offPackets: Number.NaN, seconds: 60 })
    ).toThrow(/invalid_readings/)
  })

  it('边界：恰好等于阈值判 feedback_loop（「不超过」不算安全）', () => {
    const atLimit = MDNS_LOOP_RATE_PER_SECOND_LIMIT * 60
    expect(
      classifyMdnsLoopReadings({ onPackets: atLimit, offPackets: 0, seconds: 60 }).verdict
    ).toBe('feedback_loop')
    expect(
      classifyMdnsLoopReadings({ onPackets: atLimit - 1, offPackets: 0, seconds: 60 }).verdict
    ).toBe('no_loop')
  })

  it('边界：对照组非 0 ⇒ inconclusive（观测面被别的 mDNS 流量污染，不得据此翻默认位）', () => {
    const result = classifyMdnsLoopReadings({ onPackets: 3, offPackets: 2, seconds: 60 })
    expect(result.verdict).toBe('inconclusive')
    expect(result.reason).toContain('off-window')
  })

  it('输出层：报告文本点名两个读数与结论，壳不必自带判据', () => {
    const line = formatMdnsLoopReadings({ onPackets: 12, offPackets: 0, seconds: 30 }, 0)
    expect(line).toContain('on=12')
    expect(line).toContain('off=0')
    expect(line).toContain('no_loop')
    expect(line).toContain('0.4/s')
  })
})

describe('parseMdnsProbeArgs', () => {
  it('正常：缺省走 60s；显式 --seconds 生效', () => {
    expect(parseMdnsProbeArgs([])).toEqual({ seconds: 60 })
    expect(parseMdnsProbeArgs(['--seconds', '90'])).toEqual({ seconds: 90 })
  })

  it('异常：非数字 / 越界 / 未知参数一律拒绝（不接受 --mdns——探针总是成对跑 A/B，单边读数没有意义）', () => {
    expect(() => parseMdnsProbeArgs(['--seconds', 'abc'])).toThrow(/invalid_args/)
    expect(() => parseMdnsProbeArgs(['--seconds'])).toThrow(/invalid_args/)
    expect(() => parseMdnsProbeArgs(['--seconds', '5'])).toThrow(/invalid_args/)
    expect(() => parseMdnsProbeArgs(['--seconds', '301'])).toThrow(/invalid_args/)
    expect(() => parseMdnsProbeArgs(['--mdns', 'true'])).toThrow(/invalid_args/)
    expect(() => parseMdnsProbeArgs(['--verbose'])).toThrow(/invalid_args/)
  })

  it('边界：10 与 300 是闭区间端点', () => {
    expect(parseMdnsProbeArgs(['--seconds', '10'])).toEqual({ seconds: 10 })
    expect(parseMdnsProbeArgs(['--seconds', '300'])).toEqual({ seconds: 300 })
  })
})
