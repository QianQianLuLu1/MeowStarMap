import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useStagedTask } from './useStagedTask'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('useStagedTask 编排器', () => {
  it('正常完成：阶段全 done、percent=100', async () => {
    const { result } = renderHook(() => useStagedTask())
    await act(async () => {
      await result.current.run({
        taskType: 'batch',
        title: '删除',
        stageLabels: ['准备', '处理', '收尾'],
        canCancel: true,
        total: 3,
        execute: async ({ setStage, tick }) => {
          setStage(0)
          setStage(0, 'done')
          setStage(1)
          for (let i = 1; i <= 3; i++) {
            tick(i, 3)
          }
          setStage(1, 'done')
          setStage(2)
          setStage(2, 'done')
        }
      })
    })
    expect(result.current.progress?.phase).toBe('done')
    expect(result.current.progress?.percent).toBe(100)
    expect(result.current.progress?.stages?.every((s) => s.status === 'done')).toBe(true)
  })

  it('percent 钳制在 [0,100]', async () => {
    const { result } = renderHook(() => useStagedTask())
    await act(async () => {
      await result.current.run({
        taskType: 'batch',
        title: '删除',
        stageLabels: ['a', 'b'],
        total: 2,
        execute: async ({ tick }) => {
          tick(999, 2)
        }
      })
    })
    expect(result.current.progress?.percent).toBe(100)
  })

  it('执行抛错 → phase=error，当前阶段 failed', async () => {
    const { result } = renderHook(() => useStagedTask())
    await act(async () => {
      await result.current.run({
        taskType: 'batch',
        title: '删除',
        stageLabels: ['准备', '处理'],
        execute: async ({ setStage }) => {
          setStage(0, 'done')
          setStage(1)
          throw new Error('磁盘写满')
        }
      })
    })
    expect(result.current.progress?.phase).toBe('error')
    expect(result.current.progress?.stages?.[1].status).toBe('failed')
    expect(result.current.progress?.stages?.[1].detail).toBe('磁盘写满')
  })

  it('取消 → phase=cancelled，active 阶段回退 pending', async () => {
    const { result } = renderHook(() => useStagedTask())
    let captured: { signal: AbortSignal } | null = null
    await act(async () => {
      const p = result.current.run({
        taskType: 'batch',
        title: '删除',
        stageLabels: ['准备', '处理'],
        canCancel: true,
        total: 100,
        execute: async (api) => {
          captured = { signal: api.signal }
          api.setStage(0, 'done')
          api.setStage(1)
          for (let i = 0; i < 100; i++) {
            if (api.signal.aborted) {
              const e = new Error('aborted')
              e.name = 'AbortError'
              throw e
            }
            await sleep(5)
            api.tick(i, 100)
          }
        }
      })
      // 在单一 act 内启动后立刻取消，避免嵌套 act
      result.current.cancel()
      await p
    })
    expect(result.current.progress?.phase).toBe('cancelled')
    expect(captured).not.toBeNull()
    expect((captured as { signal: AbortSignal } | null)?.signal?.aborted).toBe(true)
    expect(result.current.progress?.stages?.[1].status).toBe('pending')
  })

  it('stageLabels 为空 → 参数校验抛错，progress 保持 null', async () => {
    const { result } = renderHook(() => useStagedTask())
    await expect(
      result.current.run({
        taskType: 'batch',
        title: '删除',
        stageLabels: [],
        execute: async () => {}
      })
    ).rejects.toThrow()
    expect(result.current.progress).toBeNull()
  })

  it('reset 清空 progress', async () => {
    const { result } = renderHook(() => useStagedTask())
    act(() => {
      result.current.reset()
    })
    expect(result.current.progress).toBeNull()
  })
})

describe('useStagedTask 终态自动关闭', () => {
  it('done 终态 3 秒后自动复位（progress 置 null）', async () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useStagedTask())
      await act(async () => {
        await result.current.run({
          taskType: 'batch',
          title: '删除',
          stageLabels: ['准备'],
          execute: async () => {}
        })
      })
      expect(result.current.progress?.phase).toBe('done')
      act(() => {
        vi.advanceTimersByTime(3000)
      })
      expect(result.current.progress).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('error 终态 3 秒后自动复位', async () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useStagedTask())
      await act(async () => {
        await result.current.run({
          taskType: 'batch',
          title: '删除',
          stageLabels: ['准备'],
          execute: async () => {
            throw new Error('磁盘写满')
          }
        })
      })
      expect(result.current.progress?.phase).toBe('error')
      act(() => {
        vi.advanceTimersByTime(3000)
      })
      expect(result.current.progress).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancelled 终态 3 秒后自动复位', async () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useStagedTask())
      await act(async () => {
        await result.current.run({
          taskType: 'batch',
          title: '删除',
          stageLabels: ['准备'],
          canCancel: true,
          execute: async () => {
            const e = new Error('aborted')
            e.name = 'AbortError'
            throw e
          }
        })
      })
      expect(result.current.progress?.phase).toBe('cancelled')
      act(() => {
        vi.advanceTimersByTime(3000)
      })
      expect(result.current.progress).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('边界：自动复位窗口内启动新任务，旧定时器不得清掉新进度', async () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useStagedTask())
      await act(async () => {
        await result.current.run({
          taskType: 'batch',
          title: '任务A',
          stageLabels: ['a'],
          execute: async () => {}
        })
      })
      act(() => {
        vi.advanceTimersByTime(2000)
      })
      await act(async () => {
        await result.current.run({
          taskType: 'batch',
          title: '任务B',
          stageLabels: ['b'],
          execute: async () => {}
        })
      })
      // 距任务 A 终态已过 4 秒（旧定时器若未清除应已触发），任务 B 须仍在
      act(() => {
        vi.advanceTimersByTime(2000)
      })
      expect(result.current.progress).not.toBeNull()
      expect(result.current.progress?.message).toBe('任务B')
      // 任务 B 自身 3 秒窗口（2s + 剩余 1s）计满后关闭
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      expect(result.current.progress).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('边界：任务进行中推进 3 秒不被误关，终态后才计入窗口', async () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useStagedTask())
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let runPromise!: Promise<unknown>
      await act(async () => {
        runPromise = result.current.run({
          taskType: 'batch',
          title: '删除',
          stageLabels: ['准备'],
          execute: async () => {
            await gate
          }
        })
      })
      act(() => {
        vi.advanceTimersByTime(3000)
      })
      expect(result.current.progress).not.toBeNull()
      expect(result.current.progress?.phase).toBe('preparing')
      await act(async () => {
        release()
        await runPromise
      })
      act(() => {
        vi.advanceTimersByTime(3000)
      })
      expect(result.current.progress).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('边界：窗口内手动 reset 后定时器清除，卸载后推进时间无异常', async () => {
    vi.useFakeTimers()
    try {
      const { result, unmount } = renderHook(() => useStagedTask())
      await act(async () => {
        await result.current.run({
          taskType: 'batch',
          title: '删除',
          stageLabels: ['a'],
          execute: async () => {}
        })
      })
      act(() => {
        result.current.reset()
      })
      act(() => {
        vi.advanceTimersByTime(3000)
      })
      expect(result.current.progress).toBeNull()
      unmount()
      expect(() => vi.advanceTimersByTime(3000)).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })
})
