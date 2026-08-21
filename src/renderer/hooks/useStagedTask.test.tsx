import { describe, it, expect } from 'vitest'
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
