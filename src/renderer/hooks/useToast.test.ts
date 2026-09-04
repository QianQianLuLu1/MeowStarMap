/**
 * @layer L3
 * @module src/renderer/hooks/useToast
 * @coverage Toast 状态管理 + 自动消失 + FIFO 淘汰 + 手动 dismiss
 * @dependencies react (useCallback/useEffect/useRef/useState)
 * @remarks jsdom 环境 + @testing-library/react renderHook
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useToast } from './useToast'

describe('useToast', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('messages 初始状态', () => {
    it('挂载时 messages 为空数组', () => {
      const { result } = renderHook(() => useToast())
      expect(result.current.messages).toEqual([])
    })
  })

  describe('showMessage', () => {
    it('调用后 messages 新增一条带 id 的记录', () => {
      const { result } = renderHook(() => useToast())
      act(() => {
        result.current.showMessage('hello', 'success')
      })
      expect(result.current.messages).toHaveLength(1)
      expect(result.current.messages[0].text).toBe('hello')
      expect(result.current.messages[0].type).toBe('success')
      expect(result.current.messages[0].id).toBeTruthy()
    })

    it('未传 type 时默认为 success', () => {
      const { result } = renderHook(() => useToast())
      act(() => {
        result.current.showMessage('fallback')
      })
      expect(result.current.messages[0].type).toBe('success')
    })

    it('带 action 的消息携带 action 字段', () => {
      const { result } = renderHook(() => useToast())
      const action = { label: '撤销', onClick: vi.fn() }
      act(() => {
        result.current.showMessage('提示', 'info', action)
      })
      expect(result.current.messages[0].action).toEqual(action)
    })

    it('超过 MAX_VISIBLE (3) 条时 FIFO 淘汰最旧的', () => {
      const { result } = renderHook(() => useToast())
      act(() => {
        result.current.showMessage('m1')
        result.current.showMessage('m2')
        result.current.showMessage('m3')
        result.current.showMessage('m4')
      })
      expect(result.current.messages).toHaveLength(3)
      expect(result.current.messages.map((m) => m.text)).toEqual(['m2', 'm3', 'm4'])
    })

    it('duration 后自动移除消息', async () => {
      const { result } = renderHook(() => useToast(1000))
      act(() => {
        result.current.showMessage('temp')
      })
      expect(result.current.messages).toHaveLength(1)
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      expect(result.current.messages).toHaveLength(0)
    })

    it('带 action 的消息 duration 至少 6000ms', () => {
      const { result } = renderHook(() => useToast(1000))
      act(() => {
        result.current.showMessage('action', 'info', { label: 'btn', onClick: vi.fn() })
      })
      // 1000ms 后不应消失（实际为 6000ms）
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      expect(result.current.messages).toHaveLength(1)
      // 6000ms 后消失
      act(() => {
        vi.advanceTimersByTime(5000)
      })
      expect(result.current.messages).toHaveLength(0)
    })
  })

  describe('showMessageWithAction', () => {
    it('便捷方法默认 info 类型并附带 action', () => {
      const { result } = renderHook(() => useToast())
      const onAction = vi.fn()
      act(() => {
        result.current.showMessageWithAction('undo me', '撤销', onAction)
      })
      expect(result.current.messages).toHaveLength(1)
      expect(result.current.messages[0].type).toBe('info')
      expect(result.current.messages[0].action?.label).toBe('撤销')
      expect(result.current.messages[0].action?.onClick).toBe(onAction)
    })

    it('支持显式传入 type', () => {
      const { result } = renderHook(() => useToast())
      act(() => {
        result.current.showMessageWithAction('oops', '重试', vi.fn(), 'error')
      })
      expect(result.current.messages[0].type).toBe('error')
    })
  })

  describe('dismiss', () => {
    it('按 id 移除指定消息', () => {
      const { result } = renderHook(() => useToast())
      act(() => {
        result.current.showMessage('a')
        result.current.showMessage('b')
      })
      const firstId = result.current.messages[0].id
      act(() => {
        result.current.dismiss(firstId)
      })
      expect(result.current.messages).toHaveLength(1)
      expect(result.current.messages[0].text).toBe('b')
    })

    it('id 不存在时无副作用', () => {
      const { result } = renderHook(() => useToast())
      act(() => {
        result.current.showMessage('a')
        result.current.dismiss('nonexistent')
      })
      expect(result.current.messages).toHaveLength(1)
    })

    it('dismiss 后该消息的定时器被取消（不会再触发 setMessages）', () => {
      const { result } = renderHook(() => useToast(1000))
      act(() => {
        result.current.showMessage('temp')
      })
      const dismissedId = result.current.messages[0].id
      act(() => {
        result.current.dismiss(dismissedId)
      })
      // 推进定时器，不应抛错也不应改 messages
      act(() => {
        vi.advanceTimersByTime(2000)
      })
      expect(result.current.messages).toHaveLength(0)
    })
  })

  describe('clear', () => {
    it('清空所有消息', () => {
      const { result } = renderHook(() => useToast())
      act(() => {
        result.current.showMessage('a')
        result.current.showMessage('b')
        result.current.clear()
      })
      expect(result.current.messages).toHaveLength(0)
    })

    it('清空后所有定时器被取消', () => {
      const { result } = renderHook(() => useToast(1000))
      act(() => {
        result.current.showMessage('a')
        result.current.showMessage('b')
        result.current.clear()
      })
      act(() => {
        vi.advanceTimersByTime(2000)
      })
      expect(result.current.messages).toHaveLength(0)
    })
  })

  describe('卸载清理', () => {
    it('卸载后定时器被清理，不触发 setState 警告', () => {
      const { result, unmount } = renderHook(() => useToast(1000))
      act(() => {
        result.current.showMessage('a')
      })
      unmount()
      // 推进定时器，不应抛错
      act(() => {
        vi.advanceTimersByTime(2000)
      })
    })
  })

  describe('crypto.randomUUID 降级', () => {
    it('crypto.randomUUID 不可用时回退到 Date.now+random 生成 id', () => {
      const original = global.crypto
      // @ts-expect-error 强制覆盖
      delete global.crypto
      try {
        const { result } = renderHook(() => useToast())
        act(() => {
          result.current.showMessage('fallback')
        })
        expect(result.current.messages[0].id).toMatch(/^toast-/)
      } finally {
        global.crypto = original
      }
    })
  })

  describe('duration 自定义', () => {
    it('显式传入 duration 影响自动消失时间', () => {
      const { result } = renderHook(() => useToast(5000))
      act(() => {
        result.current.showMessage('x')
      })
      act(() => {
        vi.advanceTimersByTime(4999)
      })
      expect(result.current.messages).toHaveLength(1)
      act(() => {
        vi.advanceTimersByTime(2)
      })
      expect(result.current.messages).toHaveLength(0)
    })
  })
})
