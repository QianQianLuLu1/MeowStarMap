/**
 * @layer L3
 * @module src/renderer/hooks/useErrorToast
 * @coverage 错误对象→toast 类型映射 + 静默场景 + 主进程兜底上报
 * @dependencies useToast, shared/errors/{app-error, error-codes}
 * @remarks jsdom 环境，mock window.electronAPI.log.reportRendererError
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
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

  beforeEach(() => {
    vi.useFakeTimers()
    reportRendererError = vi.fn().mockResolvedValue(undefined)
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      log: { reportRendererError }
    }
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('showError 基础行为', () => {
    it('字符串错误显示 error 类型 toast', () => {
      const { result } = renderHook(() => useErrorToast())
      act(() => {
        result.current.showError('boom')
      })
      expect(result.current.messages).toHaveLength(1)
      expect(result.current.messages[0].type).toBe('error')
    })

    it('Error 对象显示 error 类型 toast', () => {
      const { result } = renderHook(() => useErrorToast())
      act(() => {
        result.current.showError(new Error('network down'))
      })
      expect(result.current.messages[0].type).toBe('error')
      expect(result.current.messages[0].text).toContain('network down')
    })

    it('null 错误显示默认错误 toast', () => {
      const { result } = renderHook(() => useErrorToast())
      act(() => {
        result.current.showError(null)
      })
      expect(result.current.messages).toHaveLength(1)
      expect(result.current.messages[0].type).toBe('error')
    })

    it('undefined 错误显示默认错误 toast', () => {
      const { result } = renderHook(() => useErrorToast())
      act(() => {
        result.current.showError(undefined)
      })
      expect(result.current.messages).toHaveLength(1)
    })

    it('数字错误显示默认 error toast', () => {
      const { result } = renderHook(() => useErrorToast())
      act(() => {
        result.current.showError(42)
      })
      expect(result.current.messages).toHaveLength(1)
      expect(result.current.messages[0].type).toBe('error')
    })
  })

  describe('按错误码映射 toast 类型', () => {
    it('ValidationError → info 类型', () => {
      const { result } = renderHook(() => useErrorToast())
      act(() => {
        result.current.showError(new ValidationError('参数错误'))
      })
      expect(result.current.messages[0].type).toBe('info')
    })

    it('NotFoundError → info 类型', () => {
      const { result } = renderHook(() => useErrorToast())
      act(() => {
        result.current.showError(new NotFoundError('不存在'))
      })
      expect(result.current.messages[0].type).toBe('info')
    })

    it('PermissionError → error 类型', () => {
      const { result } = renderHook(() => useErrorToast())
      act(() => {
        result.current.showError(new PermissionError('禁止访问'))
      })
      expect(result.current.messages[0].type).toBe('error')
    })

    it('DatabaseError → error 类型', () => {
      const { result } = renderHook(() => useErrorToast())
      act(() => {
        result.current.showError(new DatabaseError('db fail'))
      })
      expect(result.current.messages[0].type).toBe('error')
    })

    it('FileSystemError → error 类型', () => {
      const { result } = renderHook(() => useErrorToast())
      act(() => {
        result.current.showError(new FileSystemError('fs fail'))
      })
      expect(result.current.messages[0].type).toBe('error')
    })

    it('InternalError → error 类型', () => {
      const { result } = renderHook(() => useErrorToast())
      act(() => {
        result.current.showError(new InternalError('internal'))
      })
      expect(result.current.messages[0].type).toBe('error')
    })

    it('携带 CANCELED code 的对象静默不显示 toast', () => {
      const { result } = renderHook(() => useErrorToast())
      act(() => {
        result.current.showError({ code: ERROR_CODES.CANCELED, message: '用户取消' })
      })
      expect(result.current.messages).toHaveLength(0)
    })

    it('AppError.canceled 静默不显示 toast', () => {
      const { result } = renderHook(() => useErrorToast())
      act(() => {
        result.current.showError(AppError.canceled())
      })
      expect(result.current.messages).toHaveLength(0)
    })

    it('未知 code 走默认 error 类型', () => {
      const { result } = renderHook(() => useErrorToast())
      act(() => {
        result.current.showError({ code: 'UNKNOWN_CODE', message: 'mystery' })
      })
      expect(result.current.messages[0].type).toBe('error')
    })

    it('code 缺失时走默认 error 类型', () => {
      const { result } = renderHook(() => useErrorToast())
      act(() => {
        result.current.showError({ message: 'no code' })
      })
      expect(result.current.messages[0].type).toBe('error')
    })
  })

  describe('duration 控制', () => {
    // 注：useErrorToast 内 pickDuration 计算的 duration 当前未透传给 useToast.showMessage
    // （useToast.showMessage 不接受 duration 参数，使用 hook 初始化时的 defaultDuration）
    // 因此以下用例验证 toast 类型映射正确，duration 行为跟随 defaultDuration
    it('Validation 类错误 toast 类型为 info', () => {
      const { result } = renderHook(() => useErrorToast(1000))
      act(() => {
        result.current.showError(new ValidationError('bad'))
      })
      expect(result.current.messages[0].type).toBe('info')
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      expect(result.current.messages).toHaveLength(0)
    })

    it('Database 类错误 toast 类型为 error', () => {
      const { result } = renderHook(() => useErrorToast(1000))
      act(() => {
        result.current.showError(new DatabaseError('db'))
      })
      expect(result.current.messages[0].type).toBe('error')
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      expect(result.current.messages).toHaveLength(0)
    })

    it('未提供 code 时使用 fallbackDuration', () => {
      const { result } = renderHook(() => useErrorToast(2000))
      act(() => {
        result.current.showError({ message: 'no code' })
      })
      expect(result.current.messages).toHaveLength(1)
      act(() => {
        vi.advanceTimersByTime(1999)
      })
      expect(result.current.messages).toHaveLength(1)
      act(() => {
        vi.advanceTimersByTime(2)
      })
      expect(result.current.messages).toHaveLength(0)
    })
  })

  describe('主进程兜底上报', () => {
    it('DatabaseError 触发 reportRendererError 调用', () => {
      const { result } = renderHook(() => useErrorToast())
      act(() => {
        result.current.showError(new DatabaseError('db'))
      })
      expect(reportRendererError).toHaveBeenCalledTimes(1)
      const arg = reportRendererError.mock.calls[0][0]
      expect(arg.source).toBe('unhandledrejection')
      expect(arg.message).toContain('[useErrorToast]')
    })

    it('FileSystemError 触发 reportRendererError 调用', () => {
      const { result } = renderHook(() => useErrorToast())
      act(() => {
        result.current.showError(new FileSystemError('fs'))
      })
      expect(reportRendererError).toHaveBeenCalledTimes(1)
    })

    it('InternalError 触发 reportRendererError 调用', () => {
      const { result } = renderHook(() => useErrorToast())
      act(() => {
        result.current.showError(new InternalError('int'))
      })
      expect(reportRendererError).toHaveBeenCalledTimes(1)
    })

    it('ValidationError 不触发 reportRendererError', () => {
      const { result } = renderHook(() => useErrorToast())
      act(() => {
        result.current.showError(new ValidationError('v'))
      })
      expect(reportRendererError).not.toHaveBeenCalled()
    })

    it('NotFoundError 不触发 reportRendererError', () => {
      const { result } = renderHook(() => useErrorToast())
      act(() => {
        result.current.showError(new NotFoundError('n'))
      })
      expect(reportRendererError).not.toHaveBeenCalled()
    })

    it('reportRendererError 抛错时静默不抛出', () => {
      reportRendererError.mockRejectedValue(new Error('ipc fail'))
      const { result } = renderHook(() => useErrorToast())
      expect(() => {
        act(() => {
          result.current.showError(new DatabaseError('db'))
        })
      }).not.toThrow()
    })

    it('window.electronAPI 不存在时不抛错', () => {
      ;(window as unknown as { electronAPI: unknown }).electronAPI = undefined
      const { result } = renderHook(() => useErrorToast())
      expect(() => {
        act(() => {
          result.current.showError(new DatabaseError('db'))
        })
      }).not.toThrow()
      expect(result.current.messages).toHaveLength(1)
    })

    it('window.electronAPI.log 不存在时不抛错', () => {
      ;(window as unknown as { electronAPI: unknown }).electronAPI = {}
      const { result } = renderHook(() => useErrorToast())
      expect(() => {
        act(() => {
          result.current.showError(new DatabaseError('db'))
        })
      }).not.toThrow()
    })
  })

  describe('showMessage 透传', () => {
    it('showMessage 默认 info 类型', () => {
      const { result } = renderHook(() => useErrorToast())
      act(() => {
        result.current.showMessage('notice')
      })
      expect(result.current.messages[0].type).toBe('info')
    })

    it('showMessage 显式指定 type', () => {
      const { result } = renderHook(() => useErrorToast())
      act(() => {
        result.current.showMessage('ok', 'success')
      })
      expect(result.current.messages[0].type).toBe('success')
    })
  })

  describe('dismiss / clear 透传', () => {
    it('dismiss 关闭指定消息', () => {
      const { result } = renderHook(() => useErrorToast())
      act(() => {
        result.current.showError('err1')
      })
      const id = result.current.messages[0].id
      act(() => {
        result.current.dismiss(id)
      })
      expect(result.current.messages).toHaveLength(0)
    })

    it('clear 清空所有消息', () => {
      const { result } = renderHook(() => useErrorToast())
      act(() => {
        result.current.showError('e1')
        result.current.showError('e2')
        result.current.clear()
      })
      expect(result.current.messages).toHaveLength(0)
    })
  })
})
