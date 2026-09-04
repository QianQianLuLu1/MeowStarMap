/**
 * @layer L3
 * @module src/renderer/hooks/useIpcCall
 * @coverage IPC 调用包装：成功返回/失败捕获/loading 切换/错误 toast 策略/rethrow/silent/silentOnCancel/reset
 * @dependencies react, useErrorToast, ERROR_CODES, extractUserMessage
 * @remarks jsdom 环境，mock useErrorToast 隔离 toast 显示
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

// vi.hoisted 提升 mock 引用，便于测试中访问与重置
const { showErrorMock } = vi.hoisted(() => ({ showErrorMock: vi.fn() }))

vi.mock('./useErrorToast', () => ({
  useErrorToast: () => ({
    showError: showErrorMock,
    showMessage: vi.fn(),
    messages: [],
    dismiss: vi.fn(),
    clear: vi.fn()
  })
}))

import { useIpcCall, type IpcErrorLike } from './useIpcCall'
import { ERROR_CODES } from '../../shared/errors/error-codes'

describe('useIpcCall', () => {
  beforeEach(() => {
    showErrorMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('初始状态', () => {
    it('挂载时 loading=false, error=null', () => {
      const { result } = renderHook(() => useIpcCall())
      expect(result.current.loading).toBe(false)
      expect(result.current.error).toBeNull()
    })

    it('call 与 reset 为函数', () => {
      const { result } = renderHook(() => useIpcCall())
      expect(typeof result.current.call).toBe('function')
      expect(typeof result.current.reset).toBe('function')
    })
  })

  describe('成功路径', () => {
    it('成功返回 {success:true, data}', async () => {
      const fn = vi.fn().mockResolvedValue({ id: 1 })
      const { result } = renderHook(() => useIpcCall())
      let ret: { success: boolean; data?: { id: number } } | undefined
      await act(async () => {
        ret = await result.current.call(fn)
      })
      expect(ret!.success).toBe(true)
      expect(ret!.data).toEqual({ id: 1 })
      expect(result.current.loading).toBe(false)
      expect(result.current.error).toBeNull()
    })

    it('成功后 loading 经历 true→false', async () => {
      let resolveFn: (v: number) => void
      const fn = vi.fn().mockReturnValue(
        new Promise<number>((r) => {
          resolveFn = r
        })
      )
      const { result } = renderHook(() => useIpcCall())
      let p: Promise<unknown> | undefined
      act(() => {
        p = result.current.call(fn)
      })
      await waitFor(() => {
        expect(result.current.loading).toBe(true)
      })
      await act(async () => {
        resolveFn!(42)
        await p
      })
      expect(result.current.loading).toBe(false)
    })

    it('多参数透传给 fn', async () => {
      const fn = vi.fn().mockResolvedValue('ok')
      const { result } = renderHook(() => useIpcCall())
      await act(async () => {
        await result.current.call(fn, 'a', 1, { x: true })
      })
      expect(fn).toHaveBeenCalledWith('a', 1, { x: true })
    })
  })

  describe('失败路径 - IpcErrorLike', () => {
    it('IpcErrorLike 错误原样保留 code/message', async () => {
      const ipcErr: IpcErrorLike = {
        code: ERROR_CODES.NOT_FOUND,
        message: '文件不存在',
        userMessage: '文件不存在'
      }
      const fn = vi.fn().mockRejectedValue(ipcErr)
      const { result } = renderHook(() => useIpcCall())
      let ret: { success: boolean; error?: IpcErrorLike } | undefined
      await act(async () => {
        ret = await result.current.call(fn)
      })
      expect(ret!.success).toBe(false)
      expect(ret!.error).toEqual(ipcErr)
      expect(result.current.error).toEqual(ipcErr)
    })

    it('IpcErrorLike 默认显示 toast（showError 被调用）', async () => {
      const fn = vi.fn().mockRejectedValue({
        code: ERROR_CODES.INTERNAL_ERROR,
        message: '内部错误'
      })
      const { result } = renderHook(() => useIpcCall())
      await act(async () => {
        await result.current.call(fn)
      })
      expect(showErrorMock).toHaveBeenCalledTimes(1)
    })

    it('silent=true 时不显示 toast', async () => {
      const fn = vi.fn().mockRejectedValue({
        code: ERROR_CODES.INTERNAL_ERROR,
        message: '内部错误'
      })
      const { result } = renderHook(() => useIpcCall({ silent: true }))
      await act(async () => {
        await result.current.call(fn)
      })
      expect(showErrorMock).not.toHaveBeenCalled()
    })

    it('silentOnCancel=true 且 code=CANCELED 时不显示 toast', async () => {
      const fn = vi.fn().mockRejectedValue({
        code: ERROR_CODES.CANCELED,
        message: '用户取消'
      })
      const { result } = renderHook(() => useIpcCall({ silentOnCancel: true }))
      await act(async () => {
        await result.current.call(fn)
      })
      expect(showErrorMock).not.toHaveBeenCalled()
    })

    it('silentOnCancel=false 且 code=CANCELED 时仍显示 toast', async () => {
      const fn = vi.fn().mockRejectedValue({
        code: ERROR_CODES.CANCELED,
        message: '用户取消'
      })
      const { result } = renderHook(() => useIpcCall({ silentOnCancel: false }))
      await act(async () => {
        await result.current.call(fn)
      })
      expect(showErrorMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('失败路径 - 非 IpcErrorLike 错误', () => {
    it('普通 Error 被包装为 INTERNAL_ERROR', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('boom'))
      const { result } = renderHook(() => useIpcCall())
      let ret: { success: boolean; error?: IpcErrorLike } | undefined
      await act(async () => {
        ret = await result.current.call(fn)
      })
      expect(ret!.success).toBe(false)
      expect(ret!.error!.code).toBe(ERROR_CODES.INTERNAL_ERROR)
      expect(ret!.error!.message).toBe('boom')
    })

    it('字符串错误被包装为 INTERNAL_ERROR', async () => {
      const fn = vi.fn().mockRejectedValue('string err')
      const { result } = renderHook(() => useIpcCall())
      let ret: { success: boolean; error?: IpcErrorLike } | undefined
      await act(async () => {
        ret = await result.current.call(fn)
      })
      expect(ret!.error!.code).toBe(ERROR_CODES.INTERNAL_ERROR)
      expect(ret!.error!.message).toBe('string err')
    })

    it('null 错误被包装为 INTERNAL_ERROR 并使用兜底消息', async () => {
      const fn = vi.fn().mockRejectedValue(null)
      const { result } = renderHook(() => useIpcCall())
      let ret: { success: boolean; error?: IpcErrorLike } | undefined
      await act(async () => {
        ret = await result.current.call(fn)
      })
      expect(ret!.error!.code).toBe(ERROR_CODES.INTERNAL_ERROR)
      expect(typeof ret!.error!.message).toBe('string')
    })
  })

  describe('rethrow 选项', () => {
    it('rethrow=true 时向上抛出原错误', async () => {
      const original = new Error('origin')
      const fn = vi.fn().mockRejectedValue(original)
      const { result } = renderHook(() => useIpcCall({ rethrow: true }))
      let caught: unknown
      await act(async () => {
        try {
          await result.current.call(fn)
        } catch (e) {
          caught = e
        }
      })
      expect(caught).toBe(original)
    })

    it('rethrow=true 时仍先显示 toast', async () => {
      const fn = vi.fn().mockRejectedValue({
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'x'
      })
      const { result } = renderHook(() => useIpcCall({ rethrow: true }))
      await act(async () => {
        try {
          await result.current.call(fn)
        } catch {
          /* swallow */
        }
      })
      expect(showErrorMock).toHaveBeenCalledTimes(1)
    })

    it('rethrow=false 时不抛出', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('no rethrow'))
      const { result } = renderHook(() => useIpcCall({ rethrow: false }))
      await act(async () => {
        await result.current.call(fn)
      })
      // 不抛出即视为通过
      expect(result.current.error).not.toBeNull()
    })
  })

  describe('loading 状态切换', () => {
    it('失败后 loading 复位为 false', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'))
      const { result } = renderHook(() => useIpcCall())
      await act(async () => {
        await result.current.call(fn)
      })
      expect(result.current.loading).toBe(false)
    })
  })

  describe('reset', () => {
    it('reset 清空 error 与 loading', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('e'))
      const { result } = renderHook(() => useIpcCall())
      await act(async () => {
        await result.current.call(fn)
      })
      expect(result.current.error).not.toBeNull()
      act(() => {
        result.current.reset()
      })
      expect(result.current.error).toBeNull()
      expect(result.current.loading).toBe(false)
    })
  })

  describe('引用稳定性', () => {
    it('options 不变时 call 引用稳定', () => {
      const { result, rerender } = renderHook(() => useIpcCall())
      const first = result.current.call
      rerender()
      expect(result.current.call).toBe(first)
    })

    it('options 改变时 call 引用更新', () => {
      const { result, rerender } = renderHook(({ silent }) => useIpcCall({ silent }), {
        initialProps: { silent: false }
      })
      const first = result.current.call
      rerender({ silent: true })
      expect(result.current.call).not.toBe(first)
    })
  })
})
