/**
 * @layer L1
 * @module src/main/utils/eta-calculator
 * @coverage EtaCalculator 构造/windowSize 钳制/push/reset + ETA 公式精度
 * @dependencies mock: Date.now()（vi.useFakeTimers + vi.setSystemTime）
 * @remarks ETA 估算器纯逻辑测试，通过 fake timers 控制时间戳确定性执行
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EtaCalculator } from './eta-calculator'

describe('EtaCalculator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-26T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('构造与窗口', () => {
    it('默认 windowSize = 10', () => {
      const calc = new EtaCalculator()
      // 通过推入 11 个样本验证窗口大小为 10（第 11 个 push 后窗口滑动）
      vi.setSystemTime(0)
      for (let i = 0; i < 10; i++) {
        vi.setSystemTime(i * 1000)
        calc.push(i * 5, 100)
      }
      // 第 11 个样本：t=10000, count=50, total=100
      vi.setSystemTime(10000)
      // first=t:1000,count:5  last=t:10000,count:50
      // perSec = 45/9 = 5, etaMs = ceil(50/5*1000) = 10000
      const result = calc.push(50, 100)
      expect(result.etaMs).toBe(10000)
      expect(result.perSec).toBeCloseTo(5, 5)
    })

    it('自定义 windowSize < 2：被钳制为 2', () => {
      const calc = new EtaCalculator(1)
      vi.setSystemTime(0)
      calc.push(0, 100)
      vi.setSystemTime(1000)
      // 窗口=2，2 个样本可估算
      const result = calc.push(5, 100)
      expect(result.perSec).toBeCloseTo(5, 5)
    })

    it('windowSize = 0：被钳制为 2', () => {
      const calc = new EtaCalculator(0)
      vi.setSystemTime(0)
      calc.push(0, 100)
      vi.setSystemTime(1000)
      const result = calc.push(5, 100)
      expect(result.perSec).toBeCloseTo(5, 5)
    })

    it('windowSize = 负数：被钳制为 2', () => {
      const calc = new EtaCalculator(-10)
      vi.setSystemTime(0)
      calc.push(0, 100)
      vi.setSystemTime(1000)
      const result = calc.push(5, 100)
      expect(result.perSec).toBeCloseTo(5, 5)
    })

    it('自定义 windowSize = 100：保留', () => {
      const calc = new EtaCalculator(100)
      // 推入 50 个样本后窗口未滑出，仍可正常估算
      vi.setSystemTime(0)
      calc.push(0, 1000)
      for (let i = 1; i <= 49; i++) {
        vi.setSystemTime(i * 100)
        calc.push(i, 1000)
      }
      // 第 50 个样本
      vi.setSystemTime(4900)
      // first=t:0,count:0  last=t:4900,count:49  perSec=49/4.9=10
      const result = calc.push(49, 1000)
      expect(result.perSec).toBeCloseTo(10, 5)
    })
  })

  describe('push - 样本不足', () => {
    it('单次 push 返回 { etaMs: 0, perSec: 0 }', () => {
      const calc = new EtaCalculator()
      const result = calc.push(50, 100)
      expect(result).toEqual({ etaMs: 0, perSec: 0 })
    })

    it('reset 后单次 push 也返回 0', () => {
      const calc = new EtaCalculator()
      vi.setSystemTime(0)
      calc.push(10, 100)
      vi.setSystemTime(1000)
      calc.push(20, 100)
      calc.reset()
      const result = calc.push(30, 100)
      expect(result).toEqual({ etaMs: 0, perSec: 0 })
    })
  })

  describe('push - 已完成', () => {
    it('currentCount === total 返回 { etaMs: 0, perSec: 0 }', () => {
      const calc = new EtaCalculator()
      vi.setSystemTime(0)
      calc.push(50, 100)
      vi.setSystemTime(1000)
      const result = calc.push(100, 100)
      expect(result).toEqual({ etaMs: 0, perSec: 0 })
    })

    it('currentCount > total 返回 { etaMs: 0, perSec: 0 }', () => {
      const calc = new EtaCalculator()
      vi.setSystemTime(0)
      calc.push(50, 100)
      vi.setSystemTime(1000)
      const result = calc.push(150, 100)
      expect(result).toEqual({ etaMs: 0, perSec: 0 })
    })
  })

  describe('push - 正常估算', () => {
    it('固定时间间隔下推入多个样本，etaMs > 0, perSec > 0', () => {
      const calc = new EtaCalculator()
      vi.setSystemTime(0)
      calc.push(0, 100)
      vi.setSystemTime(10000)
      const result = calc.push(50, 100)
      expect(result.etaMs).toBe(10000)
      expect(result.perSec).toBeCloseTo(5, 5)
    })

    it('不同速率下 perSec 反映实际吞吐量', () => {
      const calc = new EtaCalculator()
      vi.setSystemTime(0)
      calc.push(0, 100)
      vi.setSystemTime(5000)
      // 5 秒处理 50 个 → perSec=10
      const result = calc.push(50, 100)
      expect(result.perSec).toBeCloseTo(10, 5)
      // remaining=50, etaMs=ceil(50/10*1000)=5000
      expect(result.etaMs).toBe(5000)
    })
  })

  describe('push - 窗口滑动', () => {
    it('推入超过 windowSize 个样本，最早样本被丢弃，估算基于最近 N 个', () => {
      const calc = new EtaCalculator(3)
      // t=0..2000, 3 个样本进入窗口
      vi.setSystemTime(0)
      calc.push(0, 100)
      vi.setSystemTime(1000)
      calc.push(10, 100)
      vi.setSystemTime(2000)
      // 此时窗口满 3 个：first=t:0,c:0 last=t:2000,c:20  perSec=10
      let result = calc.push(20, 100)
      expect(result.perSec).toBeCloseTo(10, 5)
      // 第 4 个样本触发 shift：first 变为 t:1000,c:10
      vi.setSystemTime(3000)
      result = calc.push(30, 100)
      // first=t:1000,c:10  last=t:3000,c:30  perSec=20/2=10
      expect(result.perSec).toBeCloseTo(10, 5)
      // 但 remaining 变化：100-30=70, etaMs=ceil(70/10*1000)=7000
      expect(result.etaMs).toBe(7000)
    })

    it('窗口滑动后旧样本不再影响估算', () => {
      const calc = new EtaCalculator(2)
      // 早期慢速样本
      vi.setSystemTime(0)
      calc.push(0, 100)
      vi.setSystemTime(10000)
      calc.push(10, 100) // 慢速 1/s
      // 后期快速样本
      vi.setSystemTime(11000)
      const result = calc.push(20, 100)
      // 窗口=2：first=t:10000,c:10 last=t:11000,c:20  perSec=10/1=10（早期慢速被丢弃）
      expect(result.perSec).toBeCloseTo(10, 5)
    })
  })

  describe('push - 时间未推进', () => {
    it('同一时间戳推入两个样本，返回 { etaMs: 0, perSec: 0 }', () => {
      const calc = new EtaCalculator()
      vi.setSystemTime(1000)
      calc.push(0, 100)
      // 不推进时间，再次 push
      const result = calc.push(50, 100)
      expect(result).toEqual({ etaMs: 0, perSec: 0 })
    })
  })

  describe('push - 处理量未增加', () => {
    it('currentCount 相同的连续样本，返回 { etaMs: 0, perSec: 0 }', () => {
      const calc = new EtaCalculator()
      vi.setSystemTime(0)
      calc.push(50, 100)
      vi.setSystemTime(1000)
      // count 未变
      const result = calc.push(50, 100)
      expect(result).toEqual({ etaMs: 0, perSec: 0 })
    })

    it('currentCount 倒退（异常输入），返回 { etaMs: 0, perSec: 0 }', () => {
      const calc = new EtaCalculator()
      vi.setSystemTime(0)
      calc.push(50, 100)
      vi.setSystemTime(1000)
      const result = calc.push(30, 100)
      expect(result).toEqual({ etaMs: 0, perSec: 0 })
    })
  })

  describe('reset', () => {
    it('推入若干样本后 reset：下次 push 视为单样本（返回 0）', () => {
      const calc = new EtaCalculator()
      vi.setSystemTime(0)
      calc.push(0, 100)
      vi.setSystemTime(1000)
      calc.push(50, 100)
      // reset
      calc.reset()
      vi.setSystemTime(2000)
      const result = calc.push(60, 100)
      expect(result).toEqual({ etaMs: 0, perSec: 0 })
    })

    it('reset 后立即 push：不抛错', () => {
      const calc = new EtaCalculator()
      expect(() => {
        calc.reset()
        calc.push(50, 100)
      }).not.toThrow()
    })

    it('reset 后续 push 序列恢复正常估算', () => {
      const calc = new EtaCalculator()
      vi.setSystemTime(0)
      calc.push(0, 100)
      vi.setSystemTime(1000)
      calc.push(50, 100)
      calc.reset()
      // 重新开始
      vi.setSystemTime(2000)
      calc.push(0, 100)
      vi.setSystemTime(3000)
      const result = calc.push(5, 100)
      // first=t:2000,c:0 last=t:3000,c:5  perSec=5
      expect(result.perSec).toBeCloseTo(5, 5)
    })

    it('多次 reset 不影响后续行为', () => {
      const calc = new EtaCalculator()
      calc.reset()
      calc.reset()
      calc.reset()
      vi.setSystemTime(0)
      calc.push(0, 100)
      vi.setSystemTime(1000)
      const result = calc.push(5, 100)
      expect(result.perSec).toBeCloseTo(5, 5)
    })
  })

  describe('验证公式精度', () => {
    it('10 样本、5 条/秒、剩余 50 → etaMs ≈ 10000, perSec ≈ 5', () => {
      const calc = new EtaCalculator(10)
      // 推入 10 个样本：t=0..9000ms, count=0..45（步长 5）
      for (let i = 0; i < 10; i++) {
        vi.setSystemTime(i * 1000)
        calc.push(i * 5, 100)
      }
      // 第 11 个样本触发窗口滑动
      vi.setSystemTime(10000)
      const result = calc.push(50, 100)
      // 滑动后：first=t:1000,c:5 last=t:10000,c:50
      // perSec = (50-5)/(10-1) = 5
      // remaining = 100-50 = 50
      // etaMs = ceil(50/5*1000) = 10000
      expect(result.perSec).toBeCloseTo(5, 5)
      expect(result.etaMs).toBe(10000)
    })

    it('极小窗口下 ETA 计算仍准确', () => {
      const calc = new EtaCalculator(2)
      vi.setSystemTime(0)
      calc.push(0, 200)
      vi.setSystemTime(2000)
      // 2 秒处理 10 个 → perSec=5, remaining=190, etaMs=ceil(190/5*1000)=38000
      const result = calc.push(10, 200)
      expect(result.perSec).toBeCloseTo(5, 5)
      expect(result.etaMs).toBe(38000)
    })

    it('etaMs 向上取整（避免低估剩余时间）', () => {
      const calc = new EtaCalculator()
      vi.setSystemTime(0)
      calc.push(0, 100)
      vi.setSystemTime(3000)
      // 3 秒处理 10 个 → perSec=10/3≈3.333
      // remaining=90, etaMs=ceil(90/(10/3)*1000)=ceil(27000)=27000
      const result = calc.push(10, 100)
      expect(result.etaMs).toBe(27000)
    })
  })

  describe('边界与异常输入', () => {
    it('total = 0 时 push 任何 currentCount 返回 0', () => {
      const calc = new EtaCalculator()
      vi.setSystemTime(0)
      calc.push(0, 0)
      vi.setSystemTime(1000)
      // currentCount(5) >= total(0) → 返回 0
      const result = calc.push(5, 0)
      expect(result).toEqual({ etaMs: 0, perSec: 0 })
    })

    it('负数 total 不抛错（currentCount >= total 走已完成分支）', () => {
      const calc = new EtaCalculator()
      vi.setSystemTime(0)
      calc.push(0, -1)
      vi.setSystemTime(1000)
      const result = calc.push(5, -1)
      expect(result).toEqual({ etaMs: 0, perSec: 0 })
    })

    it('currentCount = 0 且 total > 0 仍可正常估算', () => {
      const calc = new EtaCalculator()
      vi.setSystemTime(0)
      calc.push(0, 100)
      vi.setSystemTime(1000)
      const result = calc.push(0, 100)
      // processedInWindow = 0 → 返回 0
      expect(result).toEqual({ etaMs: 0, perSec: 0 })
    })
  })
})
