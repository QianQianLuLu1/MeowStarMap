/**
 * U6（fix-startup-autoscan-packaged）：TaskScheduler.resume() 幂等性。
 *
 * window-manager 的 D1 修复引入了 ready-to-show / did-finish-load / 15s 保险丝
 * 三条 resume 路径，可能对同一调度器先后触发多次 resume：
 * 重复 resume 不得导致队列任务重复执行，也不得破坏 paused 状态。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// task-scheduler 依赖 logger（logger 顶层 import electron），测试环境桩掉
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

import { TaskScheduler } from './task-scheduler'
import { logger } from '../utils/logger'

describe('TaskScheduler resume 幂等性（U6）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('pause→enqueue→resume→resume：任务只执行一次，isPaused=false，且 resume 记录诊断日志', async () => {
    const scheduler = new TaskScheduler()
    scheduler.pause()
    expect(scheduler.isPaused()).toBe(true)

    let executions = 0
    const done = scheduler.enqueueLow(async () => {
      executions++
    })

    // 暂停期间低优先级任务不得执行
    await new Promise((r) => setTimeout(r, 20))
    expect(executions).toBe(0)

    scheduler.resume()
    scheduler.resume()
    await done

    expect(executions).toBe(1)
    expect(scheduler.isPaused()).toBe(false)
    // D4 埋点：resume 状态转换可诊断（触发链路现场取证）
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('[Scheduler] resume'))
  })
})
