/**
 * @layer L1
 * @module src/main/utils/worker-restart-policy
 * @coverage WorkerRestartPolicy 构造/canRestart/scheduleRestart/dispose/getRestartCount + 滑动窗口
 * @dependencies mock: ./logger；fake timers: setTimeout / Date.now
 * @remarks 隔离 logger 后的纯逻辑测试，使用 fake timers 控制调度时序
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { loggerInfoMock, loggerWarnMock, loggerErrorMock, loggerDebugMock, loggerFaultMock } =
  vi.hoisted(() => ({
    loggerInfoMock: vi.fn(),
    loggerWarnMock: vi.fn(),
    loggerErrorMock: vi.fn(),
    loggerDebugMock: vi.fn(),
    loggerFaultMock: vi.fn().mockResolvedValue('fake-fault-id')
  }))

vi.mock('./logger', () => ({
  logger: {
    info: loggerInfoMock,
    warn: loggerWarnMock,
    error: loggerErrorMock,
    debug: loggerDebugMock,
    fault: loggerFaultMock
  }
}))

import { WorkerRestartPolicy } from './worker-restart-policy'

describe('WorkerRestartPolicy', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-26T00:00:00Z'))
    loggerInfoMock.mockClear()
    loggerWarnMock.mockClear()
    loggerErrorMock.mockClear()
    loggerDebugMock.mockClear()
    loggerFaultMock.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('构造与默认值', () => {
    it('仅传 workerName：使用默认配置', () => {
      const policy = new WorkerRestartPolicy({ workerName: 'scanner' })
      expect(policy.workerName).toBe('scanner')
      expect(policy.maxRestartCount).toBe(3)
      expect(policy.restartWindowMs).toBe(10 * 60 * 1000)
      expect(policy.restartDelayMs).toBe(2000)
    })

    it('自定义配置全部生效', () => {
      const policy = new WorkerRestartPolicy({
        workerName: 'media',
        maxRestartCount: 5,
        restartWindowMs: 300000,
        restartDelayMs: 1000
      })
      expect(policy.workerName).toBe('media')
      expect(policy.maxRestartCount).toBe(5)
      expect(policy.restartWindowMs).toBe(300000)
      expect(policy.restartDelayMs).toBe(1000)
    })
  })

  describe('canRestart', () => {
    it('初始状态：allowed=true, currentCount=0, exhausted=false', () => {
      const policy = new WorkerRestartPolicy({ workerName: 'w' })
      const status = policy.canRestart()
      expect(status).toEqual({ allowed: true, currentCount: 0, exhausted: false })
    })

    it('dispose 后：allowed=false', () => {
      const policy = new WorkerRestartPolicy({ workerName: 'w' })
      policy.dispose()
      const status = policy.canRestart()
      expect(status.allowed).toBe(false)
    })

    it('达到 maxRestartCount 后：exhausted=true, allowed=false', () => {
      const policy = new WorkerRestartPolicy({
        workerName: 'w',
        maxRestartCount: 2,
        restartDelayMs: 1000
      })
      const performRestart = vi.fn()
      // 调度 2 次（达上限）
      policy.scheduleRestart(performRestart)
      vi.advanceTimersByTime(1000)
      policy.scheduleRestart(performRestart)
      vi.advanceTimersByTime(1000)

      const status = policy.canRestart()
      expect(status.currentCount).toBe(2)
      expect(status.exhausted).toBe(true)
      expect(status.allowed).toBe(false)
    })

    it('canRestart 不修改内部状态（多次调用结果一致）', () => {
      const policy = new WorkerRestartPolicy({
        workerName: 'w',
        maxRestartCount: 2,
        restartDelayMs: 1000
      })
      const performRestart = vi.fn()
      policy.scheduleRestart(performRestart)
      vi.advanceTimersByTime(1000)

      const s1 = policy.canRestart()
      const s2 = policy.canRestart()
      expect(s1).toEqual(s2)
    })
  })

  describe('scheduleRestart - 首次调度', () => {
    it('首次调度返回 true，performRestart 在 restartDelayMs 后被调用，getRestartCount === 1', () => {
      const policy = new WorkerRestartPolicy({
        workerName: 'w',
        restartDelayMs: 2000
      })
      const performRestart = vi.fn()
      const result = policy.scheduleRestart(performRestart)
      expect(result).toBe(true)
      expect(performRestart).not.toHaveBeenCalled()
      expect(policy.getRestartCount()).toBe(1)
      expect(loggerInfoMock).toHaveBeenCalledTimes(1)
      expect(loggerInfoMock.mock.calls[0][0]).toContain('将在 2000ms 后自动重启')

      // 推进时间触发回调
      vi.advanceTimersByTime(2000)
      expect(performRestart).toHaveBeenCalledTimes(1)
      expect(policy.getRestartCount()).toBe(1) // 计数不因回调执行而变化
    })
  })

  describe('scheduleRestart - 连续调度', () => {
    it('未达上限连续调度：每次返回 true，getRestartCount 递增', () => {
      const policy = new WorkerRestartPolicy({
        workerName: 'w',
        maxRestartCount: 3,
        restartDelayMs: 1000
      })
      const performRestart = vi.fn()

      // 第一次
      expect(policy.scheduleRestart(performRestart)).toBe(true)
      expect(policy.getRestartCount()).toBe(1)
      vi.advanceTimersByTime(1000)
      expect(performRestart).toHaveBeenCalledTimes(1)

      // 第二次
      expect(policy.scheduleRestart(performRestart)).toBe(true)
      expect(policy.getRestartCount()).toBe(2)
      vi.advanceTimersByTime(1000)
      expect(performRestart).toHaveBeenCalledTimes(2)

      // 第三次
      expect(policy.scheduleRestart(performRestart)).toBe(true)
      expect(policy.getRestartCount()).toBe(3)
      vi.advanceTimersByTime(1000)
      expect(performRestart).toHaveBeenCalledTimes(3)
    })
  })

  describe('scheduleRestart - 达到上限', () => {
    it('达到 maxRestartCount 后返回 false，performRestart 不被调用，logger.error 被触发', () => {
      const policy = new WorkerRestartPolicy({
        workerName: 'w',
        maxRestartCount: 2,
        restartDelayMs: 1000
      })
      const performRestart = vi.fn()

      // 调度 2 次达上限
      policy.scheduleRestart(performRestart)
      vi.advanceTimersByTime(1000)
      policy.scheduleRestart(performRestart)
      vi.advanceTimersByTime(1000)

      // 第 3 次应被拒绝
      const result = policy.scheduleRestart(performRestart)
      expect(result).toBe(false)
      expect(performRestart).toHaveBeenCalledTimes(2) // 没有新增调用
      expect(loggerErrorMock).toHaveBeenCalledTimes(1)
      expect(loggerErrorMock.mock.calls[0][0]).toContain('重启次数已达上限')
    })
  })

  describe('scheduleRestart - dispose 后调度', () => {
    it('dispose 后 scheduleRestart 返回 false，performRestart 不被调用', () => {
      const policy = new WorkerRestartPolicy({
        workerName: 'w',
        restartDelayMs: 1000
      })
      const performRestart = vi.fn()

      policy.dispose()
      const result = policy.scheduleRestart(performRestart)
      expect(result).toBe(false)
      expect(performRestart).not.toHaveBeenCalled()
    })

    it('dispose 时已调度的 timer 被 clearTimeout，performRestart 不再触发', () => {
      const policy = new WorkerRestartPolicy({
        workerName: 'w',
        restartDelayMs: 2000
      })
      const performRestart = vi.fn()

      policy.scheduleRestart(performRestart)
      policy.dispose()
      // 推进时间，timer 应已被清理，回调不执行
      vi.advanceTimersByTime(5000)
      expect(performRestart).not.toHaveBeenCalled()
    })
  })

  describe('scheduleRestart - 回调抛错', () => {
    it('performRestart 抛错被捕获，logger.error 记录错误，不向上抛', () => {
      const policy = new WorkerRestartPolicy({
        workerName: 'w',
        restartDelayMs: 1000
      })
      const performRestart = vi.fn(() => {
        throw new Error('restart boom')
      })

      policy.scheduleRestart(performRestart)
      // 推进时间触发回调，应捕获错误而非向上抛
      expect(() => vi.advanceTimersByTime(1000)).not.toThrow()
      expect(performRestart).toHaveBeenCalledTimes(1)
      expect(loggerErrorMock).toHaveBeenCalledTimes(1)
      expect(loggerErrorMock.mock.calls[0][0]).toContain('重启回调执行失败')
      expect(loggerErrorMock.mock.calls[0][1]).toBeInstanceOf(Error)
    })
  })

  describe('scheduleRestart - 冷却期内重复调度', () => {
    it('冷却期内调用 canRestart 反映当前 currentCount', () => {
      const policy = new WorkerRestartPolicy({
        workerName: 'w',
        restartDelayMs: 2000,
        maxRestartCount: 3
      })
      const performRestart = vi.fn()

      policy.scheduleRestart(performRestart)
      // 未推进时间，timer 未触发，但 currentCount 已 +1
      expect(policy.canRestart().currentCount).toBe(1)
      // 此时仍可继续调度（未达上限）
      expect(policy.scheduleRestart(performRestart)).toBe(true)
      expect(policy.canRestart().currentCount).toBe(2)
    })
  })

  describe('滑动窗口', () => {
    it('跨过 restartWindowMs 后旧时间戳被清理，getRestartCount 下降', () => {
      const policy = new WorkerRestartPolicy({
        workerName: 'w',
        maxRestartCount: 5,
        restartWindowMs: 10000, // 10s
        restartDelayMs: 1000
      })
      const performRestart = vi.fn()

      // 在 t=0 调度一次（timestamps=[0]）
      policy.scheduleRestart(performRestart)
      expect(policy.getRestartCount()).toBe(1)

      // 推进到 11 秒后，超出 10s 窗口
      vi.setSystemTime(new Date('2026-07-26T00:00:11Z'))
      // getRestartCount 内部会调用 pruneOldTimestamps
      expect(policy.getRestartCount()).toBe(0)

      // 此后可以Restart 返回 allowed=true
      const status = policy.canRestart()
      expect(status.allowed).toBe(true)
      expect(status.exhausted).toBe(false)
    })

    it('窗口内的时间戳被保留', () => {
      const policy = new WorkerRestartPolicy({
        workerName: 'w',
        maxRestartCount: 5,
        restartWindowMs: 10000,
        restartDelayMs: 1000
      })
      const performRestart = vi.fn()

      // 在 t=0 和 t=2000 各调度一次
      policy.scheduleRestart(performRestart)
      vi.advanceTimersByTime(1000)
      policy.scheduleRestart(performRestart)
      vi.advanceTimersByTime(1000)

      // 当前 t=2000，两个时间戳 (t=0, t=2000) 都在 10s 窗口内
      expect(policy.getRestartCount()).toBe(2)

      // 推进到 t=5000，仍在窗口内
      vi.setSystemTime(new Date('2026-07-26T00:00:05Z'))
      expect(policy.getRestartCount()).toBe(2)
    })

    it('部分时间戳超出窗口被清理，剩余保留', () => {
      const policy = new WorkerRestartPolicy({
        workerName: 'w',
        maxRestartCount: 5,
        restartWindowMs: 5000,
        restartDelayMs: 500
      })
      const performRestart = vi.fn()

      // t=0 调度
      policy.scheduleRestart(performRestart)
      vi.advanceTimersByTime(500)
      // t=2000 调度（先推进到 2000）
      vi.advanceTimersByTime(1500)
      policy.scheduleRestart(performRestart)
      vi.advanceTimersByTime(500)

      // 现在 timestamps=[0, 2000]，count=2
      expect(policy.getRestartCount()).toBe(2)

      // 推进到 t=6001，threshold=1001，t=0 被清理，t=2000 保留
      vi.setSystemTime(new Date('2026-07-26T00:00:06.001Z'))
      expect(policy.getRestartCount()).toBe(1)
    })
  })

  describe('dispose', () => {
    it('调用后 canRestart().allowed === false', () => {
      const policy = new WorkerRestartPolicy({ workerName: 'w' })
      policy.dispose()
      expect(policy.canRestart().allowed).toBe(false)
    })

    it('dispose 时已调度的 timer 被 clearTimeout，performRestart 不再触发', () => {
      const policy = new WorkerRestartPolicy({
        workerName: 'w',
        restartDelayMs: 2000
      })
      const performRestart = vi.fn()
      policy.scheduleRestart(performRestart)
      policy.dispose()
      vi.advanceTimersByTime(10000)
      expect(performRestart).not.toHaveBeenCalled()
    })

    it('dispose 后再次 dispose：no-op，不抛错', () => {
      const policy = new WorkerRestartPolicy({ workerName: 'w' })
      policy.dispose()
      expect(() => policy.dispose()).not.toThrow()
    })

    it('dispose 后再调度仍返回 false', () => {
      const policy = new WorkerRestartPolicy({ workerName: 'w' })
      const performRestart = vi.fn()
      policy.dispose()
      expect(policy.scheduleRestart(performRestart)).toBe(false)
    })
  })

  describe('getRestartCount', () => {
    it('初始为 0', () => {
      const policy = new WorkerRestartPolicy({ workerName: 'w' })
      expect(policy.getRestartCount()).toBe(0)
    })

    it('调度后递增', () => {
      const policy = new WorkerRestartPolicy({
        workerName: 'w',
        restartDelayMs: 1000
      })
      const performRestart = vi.fn()
      policy.scheduleRestart(performRestart)
      expect(policy.getRestartCount()).toBe(1)
      vi.advanceTimersByTime(1000)
      policy.scheduleRestart(performRestart)
      expect(policy.getRestartCount()).toBe(2)
    })

    it('超出窗口后被 pruneOldTimestamps 清理', () => {
      const policy = new WorkerRestartPolicy({
        workerName: 'w',
        maxRestartCount: 5,
        restartWindowMs: 1000,
        restartDelayMs: 100
      })
      const performRestart = vi.fn()
      policy.scheduleRestart(performRestart)
      expect(policy.getRestartCount()).toBe(1)

      // 推进到窗口外
      vi.setSystemTime(new Date('2026-07-26T00:00:02Z'))
      expect(policy.getRestartCount()).toBe(0)
    })
  })
})
