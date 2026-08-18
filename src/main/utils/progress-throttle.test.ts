/**
 * @layer L1
 * @module src/main/utils/progress-throttle
 * @coverage ProgressThrottle 构造/intervalMs 钳制/push(终态与非终态)/dispose + 多窗口分发
 * @dependencies mock: electron.BrowserWindow.getAllWindows；fake timers: setTimeout / Date.now
 * @remarks 隔离 electron 后的纯逻辑测试，使用 fake timers 控制节流时序
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { TaskProgress } from '../../shared/types/progress'

const { sendMock, getAllWindowsMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  getAllWindowsMock: vi.fn(() => [])
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: getAllWindowsMock
  }
}))

import { ProgressThrottle } from './progress-throttle'

/** 默认 base 时间（确保 Date.now() - 0 始终大于 intervalMs，模拟真实场景） */
const BASE_TIME = new Date('2026-07-26T00:00:00Z').getTime()

/** 构造一个未销毁的 mock 窗口 */
function makeWindow(destroyed = false, sendFn: ReturnType<typeof vi.fn> = vi.fn()) {
  return {
    isDestroyed: () => destroyed,
    webContents: { send: sendFn }
  }
}

/** 构造一个基础 TaskProgress 对象 */
function makeProgress(overrides: Partial<TaskProgress> = {}): TaskProgress {
  return {
    taskId: 'task-1',
    taskType: 'scan',
    phase: 'processing',
    current: 10,
    total: 100,
    percent: 10,
    startedAt: BASE_TIME,
    canCancel: true,
    ...overrides
  }
}

describe('ProgressThrottle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
    sendMock.mockClear()
    getAllWindowsMock.mockReset()
    getAllWindowsMock.mockReturnValue([makeWindow(false, sendMock)])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('构造与节流间隔', () => {
    it('默认 intervalMs === 200', () => {
      const throttle = new ProgressThrottle()
      // 通过节流行为间接验证：首次推送立即 emit，第 2 次在 100ms 后缓存，200ms 时 emit
      const t = throttle
      t.push(makeProgress({ current: 1 }))
      expect(sendMock).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(100)
      t.push(makeProgress({ current: 2 }))
      expect(sendMock).toHaveBeenCalledTimes(1) // 节流中

      vi.advanceTimersByTime(100) // 累计 200ms 后 timer 触发
      expect(sendMock).toHaveBeenCalledTimes(2)
    })

    it('自定义 intervalMs < 100：被钳制为 100', () => {
      const throttle = new ProgressThrottle(50)
      throttle.push(makeProgress({ current: 1 }))
      expect(sendMock).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(50)
      throttle.push(makeProgress({ current: 2 }))
      // 50ms < 100（钳制后）→ 节流中
      expect(sendMock).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(50) // 累计 100ms
      expect(sendMock).toHaveBeenCalledTimes(2)
    })

    it('自定义 intervalMs > 1000：被钳制为 1000', () => {
      const throttle = new ProgressThrottle(2000)
      throttle.push(makeProgress({ current: 1 }))
      expect(sendMock).toHaveBeenCalledTimes(1)

      // 推进 1500ms（仍 < 2000，但已 >= 1000 钳制值）
      vi.advanceTimersByTime(1500)
      throttle.push(makeProgress({ current: 2 }))
      // 1500 >= 1000 → 立即 emit
      expect(sendMock).toHaveBeenCalledTimes(2)
    })

    it('自定义合法 intervalMs（150）：保留', () => {
      const throttle = new ProgressThrottle(150)
      throttle.push(makeProgress({ current: 1 }))
      expect(sendMock).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(100)
      throttle.push(makeProgress({ current: 2 }))
      expect(sendMock).toHaveBeenCalledTimes(1) // 100 < 150，节流中

      vi.advanceTimersByTime(50) // 累计 150ms
      expect(sendMock).toHaveBeenCalledTimes(2)
    })
  })

  describe('push - 非终态', () => {
    it('首次推送：立即 emit，lastEmit 更新', () => {
      const throttle = new ProgressThrottle(200)
      const p = makeProgress({ current: 5 })
      throttle.push(p)
      expect(sendMock).toHaveBeenCalledTimes(1)
      expect(sendMock).toHaveBeenCalledWith('task:progress', p)
    })

    it('节流期内：不立即 emit，缓存到 pendingProgress，设置尾部 timer', () => {
      const throttle = new ProgressThrottle(200)
      throttle.push(makeProgress({ current: 1 }))
      expect(sendMock).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(100)
      const p2 = makeProgress({ current: 2 })
      throttle.push(p2)
      expect(sendMock).toHaveBeenCalledTimes(1) // 仍 1 次

      // 推进到 timer 触发
      vi.advanceTimersByTime(100) // 累计 200ms
      expect(sendMock).toHaveBeenCalledTimes(2)
      expect(sendMock).toHaveBeenLastCalledWith('task:progress', p2)
    })

    it('节流窗口结束：timer 触发时 emit 缓存的 pending', () => {
      const throttle = new ProgressThrottle(200)
      throttle.push(makeProgress({ current: 1 }))
      vi.advanceTimersByTime(100)
      const p2 = makeProgress({ current: 2 })
      throttle.push(p2)
      // 此时 timer 已设置，delay = 200 - 100 = 100
      vi.advanceTimersByTime(100)
      expect(sendMock).toHaveBeenLastCalledWith('task:progress', p2)
    })

    it('节流期内多次推送：只保留最后一次 pending，timer 不重复设置', () => {
      const throttle = new ProgressThrottle(200)
      throttle.push(makeProgress({ current: 1 }))
      expect(sendMock).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(50)
      throttle.push(makeProgress({ current: 2 }))

      vi.advanceTimersByTime(50) // 累计 100ms
      const p3 = makeProgress({ current: 3 })
      throttle.push(p3)

      // 两次节流内推送都不应触发 emit，timer 只设置一次
      expect(sendMock).toHaveBeenCalledTimes(1)

      // 推进到首次 timer 触发（首次设置 timer 时 delay = 200 - 50 = 150）
      vi.advanceTimersByTime(150) // 累计 250ms
      expect(sendMock).toHaveBeenCalledTimes(2)
      // 应只 emit 最后一次 pending
      expect(sendMock).toHaveBeenLastCalledWith('task:progress', p3)
    })

    it('跨节流窗口：now - lastEmit >= intervalMs 时立即 emit', () => {
      const throttle = new ProgressThrottle(200)
      throttle.push(makeProgress({ current: 1 }))
      expect(sendMock).toHaveBeenCalledTimes(1)

      // 推进超过 intervalMs
      vi.advanceTimersByTime(300)
      const p2 = makeProgress({ current: 2 })
      throttle.push(p2)
      expect(sendMock).toHaveBeenCalledTimes(2)
      expect(sendMock).toHaveBeenLastCalledWith('task:progress', p2)
    })
  })

  describe('push - 终态', () => {
    it("phase === 'done'：立即 emit，清空 pendingProgress 与 timer", () => {
      const throttle = new ProgressThrottle(200)
      throttle.push(makeProgress({ current: 1 }))
      vi.advanceTimersByTime(100)
      // 缓存一个 pending
      throttle.push(makeProgress({ current: 2 }))
      expect(sendMock).toHaveBeenCalledTimes(1)

      // 推送终态
      const done = makeProgress({ phase: 'done', current: 100, percent: 100 })
      throttle.push(done)
      expect(sendMock).toHaveBeenCalledTimes(2)
      expect(sendMock).toHaveBeenLastCalledWith('task:progress', done)

      // 推进时间，timer 不应触发（已被清空）
      vi.advanceTimersByTime(1000)
      expect(sendMock).toHaveBeenCalledTimes(2)
    })

    it("phase === 'cancelled'：立即 emit", () => {
      const throttle = new ProgressThrottle(200)
      throttle.push(makeProgress({ current: 1 }))
      vi.advanceTimersByTime(100)
      throttle.push(makeProgress({ current: 2 })) // pending

      const cancelled = makeProgress({ phase: 'cancelled', current: 50 })
      throttle.push(cancelled)
      expect(sendMock).toHaveBeenLastCalledWith('task:progress', cancelled)

      vi.advanceTimersByTime(500)
      expect(sendMock).toHaveBeenCalledTimes(2) // pending 已被清空
    })

    it("phase === 'error'：立即 emit", () => {
      const throttle = new ProgressThrottle(200)
      throttle.push(makeProgress({ current: 1 }))
      vi.advanceTimersByTime(100)
      throttle.push(makeProgress({ current: 2 })) // pending

      const errored = makeProgress({ phase: 'error', current: 30 })
      throttle.push(errored)
      expect(sendMock).toHaveBeenLastCalledWith('task:progress', errored)

      vi.advanceTimersByTime(500)
      expect(sendMock).toHaveBeenCalledTimes(2)
    })

    it('终态推送后 pending 不会再被 emit', () => {
      const throttle = new ProgressThrottle(200)
      throttle.push(makeProgress({ current: 1 }))
      vi.advanceTimersByTime(100)
      throttle.push(makeProgress({ current: 2 })) // pending p2

      // 推送终态，p2 应被丢弃
      throttle.push(makeProgress({ phase: 'done', current: 100 }))

      // 推进所有 timer
      vi.advanceTimersByTime(1000)
      // 应只 emit 2 次：首次 + 终态
      expect(sendMock).toHaveBeenCalledTimes(2)
      // 不应有 current=2 的 emit
      const calls = sendMock.mock.calls.map((c) => c[1] as TaskProgress)
      expect(calls.find((p) => p.current === 2)).toBeUndefined()
    })
  })

  describe('多窗口推送', () => {
    it('getAllWindows 返回多个窗口：每个未销毁窗口都收到 webContents.send', () => {
      const w1Send = vi.fn()
      const w2Send = vi.fn()
      const w3Send = vi.fn()
      const w1 = makeWindow(false, w1Send)
      const w2 = makeWindow(false, w2Send)
      const w3 = makeWindow(false, w3Send)
      getAllWindowsMock.mockReturnValue([w1, w2, w3])

      const throttle = new ProgressThrottle(200)
      const p = makeProgress({ current: 1 })
      throttle.push(p)

      expect(w1Send).toHaveBeenCalledTimes(1)
      expect(w2Send).toHaveBeenCalledTimes(1)
      expect(w3Send).toHaveBeenCalledTimes(1)
      expect(w1Send).toHaveBeenCalledWith('task:progress', p)
    })

    it('已销毁窗口被跳过，不抛错', () => {
      const w1Send = vi.fn()
      const destroyedSend = vi.fn()
      const w1 = makeWindow(false, w1Send)
      const destroyed = makeWindow(true, destroyedSend)
      getAllWindowsMock.mockReturnValue([w1, destroyed])

      const throttle = new ProgressThrottle(200)
      throttle.push(makeProgress({ current: 1 }))

      expect(w1Send).toHaveBeenCalledTimes(1)
      expect(destroyedSend).not.toHaveBeenCalled()
    })

    it('空窗口列表：no-op', () => {
      getAllWindowsMock.mockReturnValue([])
      const throttle = new ProgressThrottle(200)
      expect(() => throttle.push(makeProgress({ current: 1 }))).not.toThrow()
      expect(sendMock).not.toHaveBeenCalled()
    })
  })

  describe('dispose', () => {
    it('调用后 pendingProgress 清空（推进时间不再 emit）', () => {
      const throttle = new ProgressThrottle(200)
      throttle.push(makeProgress({ current: 1 }))
      vi.advanceTimersByTime(100)
      throttle.push(makeProgress({ current: 2 })) // pending

      throttle.dispose()
      // 推进到原本 timer 应触发的时刻
      vi.advanceTimersByTime(200)
      // 仍只有首次 emit
      expect(sendMock).toHaveBeenCalledTimes(1)
    })

    it('已设置 timer 被 clearTimeout', () => {
      const throttle = new ProgressThrottle(200)
      throttle.push(makeProgress({ current: 1 }))
      vi.advanceTimersByTime(100)
      throttle.push(makeProgress({ current: 2 })) // 设置 timer

      throttle.dispose()
      // 推进 5 秒，timer 不应触发
      vi.advanceTimersByTime(5000)
      expect(sendMock).toHaveBeenCalledTimes(1)
    })

    it('lastEmit 重置为 0', () => {
      // 间接验证：dispose 后立即 push 应作为首次推送（立即 emit）
      const throttle = new ProgressThrottle(200)
      throttle.push(makeProgress({ current: 1 }))
      expect(sendMock).toHaveBeenCalledTimes(1)
      // 此时 lastEmit = BASE_TIME

      vi.advanceTimersByTime(50)
      throttle.dispose() // lastEmit -> 0

      // 立即 push：now - 0 = BASE_TIME + 50 >= 200 → 立即 emit
      const p2 = makeProgress({ current: 2 })
      throttle.push(p2)
      expect(sendMock).toHaveBeenCalledTimes(2)
      expect(sendMock).toHaveBeenLastCalledWith('task:progress', p2)
    })

    it('dispose 后再 push 非终态：按首次推送逻辑立即 emit', () => {
      const throttle = new ProgressThrottle(200)
      throttle.push(makeProgress({ current: 1 }))
      vi.advanceTimersByTime(50)
      throttle.dispose()

      // 推进极短时间后 push
      vi.advanceTimersByTime(10)
      const p = makeProgress({ current: 2 })
      throttle.push(p)
      expect(sendMock).toHaveBeenCalledTimes(2)
      expect(sendMock).toHaveBeenLastCalledWith('task:progress', p)
    })

    it('多次 dispose 不抛错', () => {
      const throttle = new ProgressThrottle(200)
      expect(() => {
        throttle.dispose()
        throttle.dispose()
        throttle.dispose()
      }).not.toThrow()
    })
  })

  describe('推送载荷完整性', () => {
    it('emit 时收到的 TaskProgress 与 push 入参字段一致', () => {
      const throttle = new ProgressThrottle(200)
      const full: TaskProgress = {
        taskId: 'task-full',
        taskType: 'watermark',
        phase: 'processing',
        current: 42,
        total: 100,
        percent: 42,
        processedPerSec: 5,
        etaMs: 12000,
        message: '处理水印中',
        startedAt: BASE_TIME,
        canCancel: true
      }
      throttle.push(full)
      expect(sendMock).toHaveBeenCalledWith('task:progress', full)
      // 验证字段完整保留
      const sent = sendMock.mock.calls[0][1] as TaskProgress
      expect(sent).toEqual(full)
    })

    it('终态推送字段完整保留', () => {
      const throttle = new ProgressThrottle(200)
      const terminal: TaskProgress = {
        taskId: 'task-term',
        taskType: 'video-edit',
        phase: 'done',
        current: 100,
        total: 100,
        percent: 100,
        etaMs: 0,
        message: '完成',
        startedAt: BASE_TIME,
        canCancel: false
      }
      throttle.push(terminal)
      expect(sendMock).toHaveBeenCalledWith('task:progress', terminal)
    })

    it('节流后 timer 触发 emit 的载荷为最后一次 pending', () => {
      const throttle = new ProgressThrottle(200)
      throttle.push(makeProgress({ current: 1 }))
      vi.advanceTimersByTime(100)

      const p2 = makeProgress({ current: 2, message: 'second' })
      throttle.push(p2)
      vi.advanceTimersByTime(50)

      const p3 = makeProgress({ current: 3, message: 'third' })
      throttle.push(p3)

      vi.advanceTimersByTime(150) // 触发 timer
      // timer 触发 emit 的应是 p3（最后 pending）
      const lastCall = sendMock.mock.calls[sendMock.mock.calls.length - 1]
      expect(lastCall[0]).toBe('task:progress')
      expect((lastCall[1] as TaskProgress).current).toBe(3)
      expect((lastCall[1] as TaskProgress).message).toBe('third')
    })
  })

  describe('连续场景', () => {
    it('完整的非终态→终态生命周期', () => {
      const throttle = new ProgressThrottle(200)
      // 0ms: 首次推送立即 emit
      throttle.push(makeProgress({ current: 0, percent: 0 }))
      expect(sendMock).toHaveBeenCalledTimes(1)

      // 100ms: 节流中，缓存 pending
      vi.advanceTimersByTime(100)
      throttle.push(makeProgress({ current: 50, percent: 50 }))
      expect(sendMock).toHaveBeenCalledTimes(1)

      // 200ms: timer 触发 emit pending
      vi.advanceTimersByTime(100)
      expect(sendMock).toHaveBeenCalledTimes(2)

      // 450ms: 跨节流窗口（距上次 emit 250ms >= 200）→ 立即 emit
      vi.advanceTimersByTime(250)
      throttle.push(makeProgress({ current: 90, percent: 90 }))
      expect(sendMock).toHaveBeenCalledTimes(3)

      // 500ms: 终态立即 emit
      vi.advanceTimersByTime(50)
      throttle.push(makeProgress({ phase: 'done', current: 100, percent: 100 }))
      expect(sendMock).toHaveBeenCalledTimes(4)

      // 推进时间，不应再有 emit
      vi.advanceTimersByTime(1000)
      expect(sendMock).toHaveBeenCalledTimes(4)
    })
  })
})
