/**
 * @layer L3
 * @module src/renderer/hooks/useEditHistory
 * @coverage 编辑历史栈 push/undo/redo + 上限淘汰 + 同步 ref
 * @dependencies react
 * @remarks jsdom 环境
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useEditHistory, type AdjustmentState } from './useEditHistory'

function makeState(id: string, value: number = 0): AdjustmentState {
  return {
    params: { id, value } as unknown as AdjustmentState['params'],
    filter: null,
    filterIntensity: 100,
    watermark: null
  }
}

describe('useEditHistory', () => {
  describe('初始化', () => {
    it('挂载时 useState 初始值为空数组与 -1（useEffect 后会被覆盖）', () => {
      const applyState = vi.fn()
      const { result } = renderHook(() => useEditHistory(makeState('init'), applyState))
      // renderHook 会 flush useEffect，所以挂载后 history 已被初始化为 [initialState]
      // 此处验证挂载后状态：history 非空，historyIndex=0
      expect(result.current.history.length).toBeGreaterThanOrEqual(1)
      expect(result.current.historyIndex).toBe(0)
    })

    it('挂载后初始化 history 包含 initial state', async () => {
      const applyState = vi.fn()
      const initial = makeState('init')
      const { result } = renderHook(() => useEditHistory(initial, applyState))
      // 等待 useEffect 执行
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(result.current.history).toHaveLength(1)
      expect(result.current.historyIndex).toBe(0)
      // deep copy 验证
      expect(result.current.history[0]).toEqual(initial)
    })

    it('initializedRef 防止重复初始化', async () => {
      const applyState = vi.fn()
      const initial = makeState('init')
      const { result, rerender } = renderHook(({ init }) => useEditHistory(init, applyState), {
        initialProps: { init: initial }
      })
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
      const firstHistory = result.current.history
      rerender({ init: makeState('changed') })
      expect(result.current.history).toBe(firstHistory)
    })
  })

  describe('pushHistory', () => {
    it('push 后 history 长度 +1，index +1', async () => {
      const applyState = vi.fn()
      const { result } = renderHook(() => useEditHistory(makeState('init'), applyState))
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
      act(() => {
        result.current.pushHistory(makeState('s1'))
      })
      expect(result.current.history).toHaveLength(2)
      expect(result.current.historyIndex).toBe(1)
      expect(result.current.history[1]).toEqual(makeState('s1'))
    })

    it('push 时深拷贝 state，后续修改原 state 不影响 history', async () => {
      const applyState = vi.fn()
      const initial = makeState('init')
      const { result } = renderHook(() => useEditHistory(initial, applyState))
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
      const pushed = makeState('s1')
      act(() => {
        result.current.pushHistory(pushed)
      })
      // 修改原 pushed 对象
      ;(pushed.params as unknown as { value: number }).value = 999
      expect((result.current.history[1].params as unknown as { value: number }).value).not.toBe(999)
    })

    it('undo 后再 push 截断后续 redo 历史', async () => {
      const applyState = vi.fn()
      const { result } = renderHook(() => useEditHistory(makeState('init'), applyState))
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
      act(() => {
        result.current.pushHistory(makeState('s1'))
        result.current.pushHistory(makeState('s2'))
      })
      expect(result.current.history).toHaveLength(3)
      act(() => {
        result.current.undo()
      })
      expect(result.current.historyIndex).toBe(1)
      act(() => {
        result.current.pushHistory(makeState('s3'))
      })
      expect(result.current.history).toHaveLength(3)
      expect(result.current.historyIndex).toBe(2)
      expect(result.current.history[2]).toEqual(makeState('s3'))
    })

    it('history 超过 50 条时丢弃最旧记录', async () => {
      const applyState = vi.fn()
      const { result } = renderHook(() => useEditHistory(makeState('init'), applyState))
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
      act(() => {
        for (let i = 0; i < 55; i++) {
          result.current.pushHistory(makeState(`s${i}`))
        }
      })
      expect(result.current.history).toHaveLength(50)
      expect(result.current.historyIndex).toBe(49)
    })
  })

  describe('undo', () => {
    it('undo 调用 applyState(history[index-1]) 并 index-1', async () => {
      const applyState = vi.fn()
      const { result } = renderHook(() => useEditHistory(makeState('init'), applyState))
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
      const s1 = makeState('s1')
      act(() => {
        result.current.pushHistory(s1)
      })
      act(() => {
        result.current.undo()
      })
      expect(applyState).toHaveBeenCalledWith(result.current.history[0])
      expect(result.current.historyIndex).toBe(0)
    })

    it('historyIndex=0 时 undo 不操作', async () => {
      const applyState = vi.fn()
      const { result } = renderHook(() => useEditHistory(makeState('init'), applyState))
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
      act(() => {
        result.current.undo()
      })
      expect(applyState).not.toHaveBeenCalled()
      expect(result.current.historyIndex).toBe(0)
    })
  })

  describe('redo', () => {
    it('redo 调用 applyState(history[index+1]) 并 index+1', async () => {
      const applyState = vi.fn()
      const { result } = renderHook(() => useEditHistory(makeState('init'), applyState))
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
      act(() => {
        result.current.pushHistory(makeState('s1'))
        result.current.undo()
      })
      act(() => {
        result.current.redo()
      })
      expect(applyState).toHaveBeenCalledWith(result.current.history[1])
      expect(result.current.historyIndex).toBe(1)
    })

    it('historyIndex 已在末尾时 redo 不操作', async () => {
      const applyState = vi.fn()
      const { result } = renderHook(() => useEditHistory(makeState('init'), applyState))
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
      act(() => {
        result.current.pushHistory(makeState('s1'))
        result.current.redo()
      })
      expect(applyState).not.toHaveBeenCalled()
      expect(result.current.historyIndex).toBe(1)
    })
  })

  describe('canUndo / canRedo', () => {
    it('初始 canUndo=false, canRedo=false', async () => {
      const applyState = vi.fn()
      const { result } = renderHook(() => useEditHistory(makeState('init'), applyState))
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(result.current.canUndo).toBe(false)
      expect(result.current.canRedo).toBe(false)
    })

    it('push 后 canUndo=true, canRedo=false', async () => {
      const applyState = vi.fn()
      const { result } = renderHook(() => useEditHistory(makeState('init'), applyState))
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
      act(() => {
        result.current.pushHistory(makeState('s1'))
      })
      expect(result.current.canUndo).toBe(true)
      expect(result.current.canRedo).toBe(false)
    })

    it('undo 后 canUndo=false, canRedo=true', async () => {
      const applyState = vi.fn()
      const { result } = renderHook(() => useEditHistory(makeState('init'), applyState))
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
      act(() => {
        result.current.pushHistory(makeState('s1'))
        result.current.undo()
      })
      expect(result.current.canUndo).toBe(false)
      expect(result.current.canRedo).toBe(true)
    })
  })

  describe('连续 pushHistory 同步 ref', () => {
    it('同一 render 周期内多次 pushHistory 不丢失记录', async () => {
      const applyState = vi.fn()
      const { result } = renderHook(() => useEditHistory(makeState('init'), applyState))
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
      act(() => {
        result.current.pushHistory(makeState('s1'))
        result.current.pushHistory(makeState('s2'))
        result.current.pushHistory(makeState('s3'))
      })
      expect(result.current.history).toHaveLength(4)
      expect(result.current.historyIndex).toBe(3)
    })
  })
})
