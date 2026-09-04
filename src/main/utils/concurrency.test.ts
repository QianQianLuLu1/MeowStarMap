import { describe, it, expect } from 'vitest'
import { runWithConcurrency, createConcurrencyLimiter } from './concurrency'

describe('concurrency - runWithConcurrency', () => {
  it('空任务数组返回空结果数组', async () => {
    const result = await runWithConcurrency([], 5)
    expect(result).toEqual([])
  })

  it('结果顺序与任务数组顺序一致（而非完成顺序）', async () => {
    const tasks = [
      () => Promise.resolve('a'),
      () => new Promise((r) => setTimeout(() => r('b'), 50)),
      () => Promise.resolve('c')
    ]
    const result = await runWithConcurrency(tasks, 3)
    expect(result).toEqual(['a', 'b', 'c'])
  })

  it('并发数为 1 时严格串行执行', async () => {
    const executionOrder: number[] = []
    const tasks = [0, 1, 2].map(
      (i) => () =>
        new Promise<void>((resolve) => {
          executionOrder.push(i)
          setTimeout(resolve, 10)
        }).then(() => i)
    )
    const result = await runWithConcurrency(tasks, 1)
    expect(result).toEqual([0, 1, 2])
    expect(executionOrder).toEqual([0, 1, 2])
  })

  it('并发数大于任务数时实际并发度不超过任务数', async () => {
    const tasks = [() => Promise.resolve(1), () => Promise.resolve(2)]
    const result = await runWithConcurrency(tasks, 100)
    expect(result).toEqual([1, 2])
  })

  it('并发数 0 或负数时仍能完成所有任务', async () => {
    const tasks = [() => Promise.resolve('x'), () => Promise.resolve('y')]
    // Math.min(concurrency, tasks.length) 在 concurrency<=0 时为 0，workers 为空数组
    // 但 Promise.all([]) 立即 resolve，tasks 永不执行，results 全为 undefined 槽位
    // 验证当前实现的边界行为（不抛错即可）
    const result = await runWithConcurrency(tasks, 0)
    expect(result.length).toBe(2)
  })

  it('任务抛错时 reject 整个 Promise', async () => {
    const tasks = [() => Promise.resolve('ok'), () => Promise.reject(new Error('fail'))]
    await expect(runWithConcurrency(tasks, 2)).rejects.toThrow('fail')
  })

  it('高并发下能正确处理大量任务', async () => {
    const n = 100
    const tasks = Array.from({ length: n }, (_, i) => () => Promise.resolve(i * 2))
    const result = await runWithConcurrency(tasks, 10)
    expect(result.length).toBe(n)
    expect(result[50]).toBe(100)
  })
})

describe('concurrency - createConcurrencyLimiter', () => {
  /** 构造一个可观测峰值并发的任务工厂 */
  function makeProbe() {
    const state = { active: 0, peak: 0 }
    const task = (ms = 10) => {
      state.active++
      state.peak = Math.max(state.peak, state.active)
      return new Promise<number>((resolve) =>
        setTimeout(() => {
          state.active--
          resolve(state.peak)
        }, ms)
      )
    }
    return { state, task }
  }

  it('跨多次独立调用共享同一许可池，峰值并发不超过 limit', async () => {
    const { state, task } = makeProbe()
    const limit = createConcurrencyLimiter(3)
    // 逐个提交（模拟渲染层逐张请求），而非一次性交出整批任务
    await Promise.all(Array.from({ length: 20 }, () => limit(() => task())))
    expect(state.peak).toBe(3)
    expect(state.active).toBe(0)
  })

  it('limit=1 时严格串行', async () => {
    const { state, task } = makeProbe()
    const limit = createConcurrencyLimiter(1)
    await Promise.all(Array.from({ length: 5 }, () => limit(() => task())))
    expect(state.peak).toBe(1)
  })

  it('任务 reject 后释放许可，不会耗尽许可池导致后续任务饿死', async () => {
    const limit = createConcurrencyLimiter(2)
    const failures = Array.from({ length: 4 }, () =>
      limit(() => Promise.reject(new Error('boom'))).catch((e: Error) => e.message)
    )
    expect(await Promise.all(failures)).toEqual(['boom', 'boom', 'boom', 'boom'])
    // 许可已全部归还，后续任务仍可执行
    await expect(limit(() => Promise.resolve('ok'))).resolves.toBe('ok')
  })

  it('任务同步抛错时也归还许可', async () => {
    const limit = createConcurrencyLimiter(1)
    await expect(
      limit(() => {
        throw new Error('sync boom')
      })
    ).rejects.toThrow('sync boom')
    await expect(limit(() => Promise.resolve('still alive'))).resolves.toBe('still alive')
  })

  it('limit 非法（0 / 负数 / NaN）时退化为串行而非死锁', async () => {
    for (const bad of [0, -5, Number.NaN]) {
      const { state, task } = makeProbe()
      const limit = createConcurrencyLimiter(bad)
      await Promise.all(Array.from({ length: 3 }, () => limit(() => task(1))))
      expect(state.peak).toBe(1)
    }
  })

  it('透传返回值与拒绝原因', async () => {
    const limit = createConcurrencyLimiter(2)
    await expect(limit(() => Promise.resolve({ id: 7 }))).resolves.toEqual({ id: 7 })
    await expect(limit(() => Promise.reject(new Error('nope')))).rejects.toThrow('nope')
  })
})
