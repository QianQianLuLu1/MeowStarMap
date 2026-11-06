/**
 * @layer L3
 * @module src/renderer/hooks/useErrorToast
 * @coverage 错误对象→toast 类型映射 + 静默场景 + 全局通道委托（F25）+ 主进程兜底上报
 * @dependencies components/common/ToastProvider（GlobalToastContext）、shared/errors/{app-error, error-codes}
 * @remarks jsdom 环境，mock window.electronAPI.log.reportRendererError。
 *   F25 起 showError 委托根节点 GlobalToastProvider 渲染的全局 Toast——观测面即
 *   context 的 showMessage mock；自持 useToast 实例的 messages/showMessage/dismiss/clear
 *   透传面随 F25 移除（无调用方使用，duration 控制移交 GlobalToastProvider 的 useToast）。
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { GlobalToastContext } from '../components/common/ToastProvider'
import { useErrorToast } from './useErrorToast'
import { ERROR_CODES } from '../../shared/errors/error-codes'
import {
  ValidationError,
  NotFoundError,
  PermissionError,
  DatabaseError,
  FileSystemError,
  InternalError,
  AppError
} from '../../shared/errors/app-error'

describe('useErrorToast', () => {
  let reportRendererError: ReturnType<typeof vi.fn>
  let globalShowMessage: ReturnType<typeof vi.fn<(text: string, type?: string) => void>>

  /** renderHook 包一层全局 Toast 通道 mock（生产由 App 根的 GlobalToastProvider 提供） */
  function renderUseErrorToast() {
    return renderHook(() => useErrorToast(), {
      wrapper: ({ children }: { children?: ReactNode }) =>
        createElement(GlobalToastContext.Provider, { value: globalShowMessage }, children)
    })
  }

  beforeEach(() => {
    reportRendererError = vi.fn().mockResolvedValue(undefined)
    globalShowMessage = vi.fn()
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      log: { reportRendererError }
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('showError → 全局通道委托（F25）', () => {
    it('字符串错误显示 error 类型 toast', () => {
      const { result } = renderUseErrorToast()
      act(() => {
        result.current.showError('boom')
      })
      expect(globalShowMessage).toHaveBeenCalledWith('boom', 'error')
    })

    it('Error 对象提取 message 并以 error 类型显示', () => {
      const { result } = renderUseErrorToast()
      act(() => {
        result.current.showError(new Error('network down'))
      })
      expect(globalShowMessage).toHaveBeenCalledWith('network down', 'error')
    })

    it('null / undefined / 数字错误 → 一条默认 error toast（文案走 AppError fallback）', () => {
      const { result } = renderUseErrorToast()
      act(() => {
        result.current.showError(null)
        result.current.showError(undefined)
        result.current.showError(42)
      })
      expect(globalShowMessage).toHaveBeenCalledTimes(3)
      for (const call of globalShowMessage.mock.calls) {
        expect(call[1]).toBe('error')
      }
    })
  })

  describe('按错误码映射 toast 类型', () => {
    it('ValidationError → info 类型', () => {
      const { result } = renderUseErrorToast()
      act(() => {
        result.current.showError(new ValidationError('参数错误'))
      })
      expect(globalShowMessage).toHaveBeenCalledWith('参数错误', 'info')
    })

    it('NotFoundError → info 类型', () => {
      const { result } = renderUseErrorToast()
      act(() => {
        result.current.showError(new NotFoundError('不存在'))
      })
      expect(globalShowMessage).toHaveBeenCalledWith('不存在', 'info')
    })

    it('PermissionError → error 类型', () => {
      const { result } = renderUseErrorToast()
      act(() => {
        result.current.showError(new PermissionError('禁止访问'))
      })
      expect(globalShowMessage).toHaveBeenCalledWith('禁止访问', 'error')
    })

    it('DatabaseError → error 类型（文案取 userMessage 本地化回退）', () => {
      const { result } = renderUseErrorToast()
      act(() => {
        result.current.showError(new DatabaseError('db fail'))
      })
      expect(globalShowMessage).toHaveBeenCalledWith(expect.any(String), 'error')
    })

    it('FileSystemError → error 类型（文案取 userMessage 本地化回退）', () => {
      const { result } = renderUseErrorToast()
      act(() => {
        result.current.showError(new FileSystemError('fs fail'))
      })
      expect(globalShowMessage).toHaveBeenCalledWith(expect.any(String), 'error')
    })

    it('InternalError → error 类型（文案取 userMessage 本地化回退）', () => {
      const { result } = renderUseErrorToast()
      act(() => {
        result.current.showError(new InternalError('internal'))
      })
      expect(globalShowMessage).toHaveBeenCalledWith(expect.any(String), 'error')
    })

    it('携带 CANCELED code 的对象静默不显示 toast', () => {
      const { result } = renderUseErrorToast()
      act(() => {
        result.current.showError({ code: ERROR_CODES.CANCELED, message: '用户取消' })
      })
      expect(globalShowMessage).not.toHaveBeenCalled()
    })

    it('AppError.canceled 静默不显示 toast', () => {
      const { result } = renderUseErrorToast()
      act(() => {
        result.current.showError(AppError.canceled())
      })
      expect(globalShowMessage).not.toHaveBeenCalled()
    })

    it('未知 code 走默认 error 类型（普通对象文案走 AppError fallback）', () => {
      const { result } = renderUseErrorToast()
      act(() => {
        result.current.showError({ code: 'UNKNOWN_CODE', message: 'mystery' })
      })
      expect(globalShowMessage).toHaveBeenCalledWith(expect.any(String), 'error')
    })

    it('code 缺失时走默认 error 类型（普通对象文案走 AppError fallback）', () => {
      const { result } = renderUseErrorToast()
      act(() => {
        result.current.showError({ message: 'no code' })
      })
      expect(globalShowMessage).toHaveBeenCalledWith(expect.any(String), 'error')
    })
  })

  describe('主进程兜底上报', () => {
    it('DatabaseError 触发 reportRendererError 调用', () => {
      const { result } = renderUseErrorToast()
      act(() => {
        result.current.showError(new DatabaseError('db'))
      })
      expect(reportRendererError).toHaveBeenCalledTimes(1)
      const arg = reportRendererError.mock.calls[0][0]
      expect(arg.source).toBe('unhandledrejection')
      expect(arg.message).toContain('[useErrorToast]')
    })

    it('FileSystemError 触发 reportRendererError 调用', () => {
      const { result } = renderUseErrorToast()
      act(() => {
        result.current.showError(new FileSystemError('fs'))
      })
      expect(reportRendererError).toHaveBeenCalledTimes(1)
    })

    it('InternalError 触发 reportRendererError 调用', () => {
      const { result } = renderUseErrorToast()
      act(() => {
        result.current.showError(new InternalError('int'))
      })
      expect(reportRendererError).toHaveBeenCalledTimes(1)
    })

    it('ValidationError 不触发 reportRendererError', () => {
      const { result } = renderUseErrorToast()
      act(() => {
        result.current.showError(new ValidationError('v'))
      })
      expect(reportRendererError).not.toHaveBeenCalled()
    })

    it('NotFoundError 不触发 reportRendererError', () => {
      const { result } = renderUseErrorToast()
      act(() => {
        result.current.showError(new NotFoundError('n'))
      })
      expect(reportRendererError).not.toHaveBeenCalled()
    })

    it('reportRendererError 抛错时静默不抛出', () => {
      reportRendererError.mockRejectedValue(new Error('ipc fail'))
      const { result } = renderUseErrorToast()
      expect(() => {
        act(() => {
          result.current.showError(new DatabaseError('db'))
        })
      }).not.toThrow()
    })

    it('window.electronAPI 不存在时不抛错', () => {
      ;(window as unknown as { electronAPI: unknown }).electronAPI = undefined
      const { result } = renderUseErrorToast()
      expect(() => {
        act(() => {
          result.current.showError(new DatabaseError('db'))
        })
      }).not.toThrow()
      expect(globalShowMessage).toHaveBeenCalledTimes(1)
    })

    it('window.electronAPI.log 不存在时不抛错', () => {
      ;(window as unknown as { electronAPI: unknown }).electronAPI = {}
      const { result } = renderUseErrorToast()
      expect(() => {
        act(() => {
          result.current.showError(new DatabaseError('db'))
        })
      }).not.toThrow()
    })
  })
})
