/**
 * @layer L3
 * @module src/renderer/hooks/useEditorShortcuts
 * @coverage 编辑器快捷键 Esc/F11/?/Ctrl+S/Shift+S/Z/Y/C/V
 * @dependencies react, window.addEventListener
 * @remarks jsdom 环境，派发 KeyboardEvent 验证回调触发
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useEditorShortcuts } from './useEditorShortcuts'

function dispatchKey(opts: {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
}): void {
  document.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: opts.key,
      ctrlKey: opts.ctrlKey ?? false,
      metaKey: opts.metaKey ?? false,
      shiftKey: opts.shiftKey ?? false,
      altKey: opts.altKey ?? false,
      bubbles: true,
      cancelable: true
    })
  )
}

describe('useEditorShortcuts', () => {
  let callbacks: {
    onUndo: ReturnType<typeof vi.fn>
    onRedo: ReturnType<typeof vi.fn>
    onSave: ReturnType<typeof vi.fn>
    onSaveAs: ReturnType<typeof vi.fn>
    onReset: ReturnType<typeof vi.fn>
    onCopyParams: ReturnType<typeof vi.fn>
    onPasteParams: ReturnType<typeof vi.fn>
    onToggleFullscreen: ReturnType<typeof vi.fn>
    onToggleShortcuts: ReturnType<typeof vi.fn>
    onExit: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    callbacks = {
      onUndo: vi.fn(),
      onRedo: vi.fn(),
      onSave: vi.fn(),
      onSaveAs: vi.fn(),
      onReset: vi.fn(),
      onCopyParams: vi.fn(),
      onPasteParams: vi.fn(),
      onToggleFullscreen: vi.fn(),
      onToggleShortcuts: vi.fn(),
      onExit: vi.fn()
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function renderHookWith(
    options: {
      isFullscreen?: boolean
      showShortcuts?: boolean
      onCopyParams?: () => void
      onPasteParams?: () => void
    } = {}
  ) {
    return renderHook(
      ({ isFullscreen, showShortcuts }) =>
        useEditorShortcuts({
          ...callbacks,
          isFullscreen,
          showShortcuts,
          onCopyParams: options.onCopyParams ?? callbacks.onCopyParams,
          onPasteParams: options.onPasteParams ?? callbacks.onPasteParams
        }),
      {
        initialProps: {
          isFullscreen: options.isFullscreen ?? false,
          showShortcuts: options.showShortcuts ?? false
        }
      }
    )
  }

  describe('Esc 键分支', () => {
    it('showShortcuts=true 时 Esc 触发 onToggleShortcuts', () => {
      renderHookWith({ showShortcuts: true })
      dispatchKey({ key: 'Escape' })
      expect(callbacks.onToggleShortcuts).toHaveBeenCalledTimes(1)
      expect(callbacks.onToggleFullscreen).not.toHaveBeenCalled()
      expect(callbacks.onExit).not.toHaveBeenCalled()
    })

    it('showShortcuts=false, isFullscreen=true 时 Esc 触发 onToggleFullscreen', () => {
      renderHookWith({ isFullscreen: true })
      dispatchKey({ key: 'Escape' })
      expect(callbacks.onToggleFullscreen).toHaveBeenCalledTimes(1)
      expect(callbacks.onExit).not.toHaveBeenCalled()
    })

    it('showShortcuts=false, isFullscreen=false 时 Esc 触发 onExit', () => {
      renderHookWith({})
      dispatchKey({ key: 'Escape' })
      expect(callbacks.onExit).toHaveBeenCalledTimes(1)
    })
  })

  describe('F11 键', () => {
    it('F11 触发 onToggleFullscreen', () => {
      renderHookWith({})
      dispatchKey({ key: 'F11' })
      expect(callbacks.onToggleFullscreen).toHaveBeenCalledTimes(1)
    })
  })

  describe('? 键', () => {
    it('单按 ? 触发 onToggleShortcuts', () => {
      renderHookWith({})
      dispatchKey({ key: '?' })
      expect(callbacks.onToggleShortcuts).toHaveBeenCalledTimes(1)
    })

    it('Ctrl+? 不触发 onToggleShortcuts', () => {
      renderHookWith({})
      dispatchKey({ key: '?', ctrlKey: true })
      expect(callbacks.onToggleShortcuts).not.toHaveBeenCalled()
    })

    it('Alt+? 不触发 onToggleShortcuts', () => {
      renderHookWith({})
      dispatchKey({ key: '?', altKey: true })
      expect(callbacks.onToggleShortcuts).not.toHaveBeenCalled()
    })

    it('Meta+? 不触发 onToggleShortcuts', () => {
      renderHookWith({})
      dispatchKey({ key: '?', metaKey: true })
      expect(callbacks.onToggleShortcuts).not.toHaveBeenCalled()
    })
  })

  describe('Ctrl/Cmd+S 保存', () => {
    it('Ctrl+S 触发 onSave', () => {
      renderHookWith({})
      dispatchKey({ key: 's', ctrlKey: true })
      expect(callbacks.onSave).toHaveBeenCalledTimes(1)
      expect(callbacks.onSaveAs).not.toHaveBeenCalled()
    })

    it('Cmd+S 触发 onSave', () => {
      renderHookWith({})
      dispatchKey({ key: 's', metaKey: true })
      expect(callbacks.onSave).toHaveBeenCalledTimes(1)
    })

    it('Ctrl+Shift+S 触发 onSaveAs', () => {
      renderHookWith({})
      dispatchKey({ key: 's', ctrlKey: true, shiftKey: true })
      expect(callbacks.onSaveAs).toHaveBeenCalledTimes(1)
      expect(callbacks.onSave).not.toHaveBeenCalled()
    })
  })

  describe('Ctrl/Cmd+Z 撤销', () => {
    it('Ctrl+Z 触发 onUndo', () => {
      renderHookWith({})
      dispatchKey({ key: 'z', ctrlKey: true })
      expect(callbacks.onUndo).toHaveBeenCalledTimes(1)
    })

    it('Ctrl+Shift+Z 触发 onRedo', () => {
      renderHookWith({})
      dispatchKey({ key: 'z', ctrlKey: true, shiftKey: true })
      expect(callbacks.onRedo).toHaveBeenCalledTimes(1)
      expect(callbacks.onUndo).not.toHaveBeenCalled()
    })

    it('Cmd+Z 触发 onUndo', () => {
      renderHookWith({})
      dispatchKey({ key: 'z', metaKey: true })
      expect(callbacks.onUndo).toHaveBeenCalledTimes(1)
    })
  })

  describe('Ctrl+Y 重做', () => {
    it('Ctrl+Y 触发 onRedo', () => {
      renderHookWith({})
      dispatchKey({ key: 'y', ctrlKey: true })
      expect(callbacks.onRedo).toHaveBeenCalledTimes(1)
    })
  })

  describe('Ctrl+Shift+C / V 复制/粘贴参数', () => {
    it('Ctrl+Shift+C 触发 onCopyParams', () => {
      renderHookWith({})
      dispatchKey({ key: 'c', ctrlKey: true, shiftKey: true })
      expect(callbacks.onCopyParams).toHaveBeenCalledTimes(1)
    })

    it('Ctrl+Shift+V 触发 onPasteParams', () => {
      renderHookWith({})
      dispatchKey({ key: 'v', ctrlKey: true, shiftKey: true })
      expect(callbacks.onPasteParams).toHaveBeenCalledTimes(1)
    })

    it('Ctrl+C (无 Shift) 不触发 onCopyParams', () => {
      renderHookWith({})
      dispatchKey({ key: 'c', ctrlKey: true })
      expect(callbacks.onCopyParams).not.toHaveBeenCalled()
    })

    it('onCopyParams 未传时不抛错', () => {
      // 不传 onCopyParams/onPasteParams（undefined），源码条件判断 `opts.onCopyParams` 为 falsy 时跳过
      renderHook(() =>
        useEditorShortcuts({
          onUndo: vi.fn(),
          onRedo: vi.fn(),
          onSave: vi.fn(),
          onSaveAs: vi.fn(),
          onReset: vi.fn(),
          onToggleFullscreen: vi.fn(),
          onToggleShortcuts: vi.fn(),
          onExit: vi.fn(),
          isFullscreen: false,
          showShortcuts: false
        })
      )
      expect(() => {
        dispatchKey({ key: 'c', ctrlKey: true, shiftKey: true })
      }).not.toThrow()
    })
  })

  describe('未注册键不触发回调', () => {
    it('Enter 不触发任何回调', () => {
      renderHookWith({})
      dispatchKey({ key: 'Enter' })
      expect(callbacks.onUndo).not.toHaveBeenCalled()
      expect(callbacks.onSave).not.toHaveBeenCalled()
      expect(callbacks.onExit).not.toHaveBeenCalled()
    })

    it('单按 s 不触发 onSave（无 Ctrl）', () => {
      renderHookWith({})
      dispatchKey({ key: 's' })
      expect(callbacks.onSave).not.toHaveBeenCalled()
    })
  })

  describe('options 变更响应', () => {
    it('isFullscreen 变化时 Esc 行为切换', () => {
      const { rerender } = renderHook(
        ({ isFullscreen, showShortcuts }) =>
          useEditorShortcuts({
            ...callbacks,
            isFullscreen,
            showShortcuts
          }),
        { initialProps: { isFullscreen: false, showShortcuts: false } }
      )
      dispatchKey({ key: 'Escape' })
      expect(callbacks.onExit).toHaveBeenCalledTimes(1)
      rerender({ isFullscreen: true, showShortcuts: false })
      dispatchKey({ key: 'Escape' })
      expect(callbacks.onToggleFullscreen).toHaveBeenCalledTimes(1)
    })

    it('showShortcuts 变化时 Esc 行为切换', () => {
      const { rerender } = renderHook(
        ({ isFullscreen, showShortcuts }) =>
          useEditorShortcuts({
            ...callbacks,
            isFullscreen,
            showShortcuts
          }),
        { initialProps: { isFullscreen: false, showShortcuts: false } }
      )
      rerender({ isFullscreen: false, showShortcuts: true })
      dispatchKey({ key: 'Escape' })
      expect(callbacks.onToggleShortcuts).toHaveBeenCalledTimes(1)
    })
  })

  describe('卸载清理', () => {
    it('unmount 后移除 keydown 监听', () => {
      const { unmount } = renderHookWith({})
      unmount()
      // 卸载后按键不应触发任何回调
      dispatchKey({ key: 'Escape' })
      dispatchKey({ key: 's', ctrlKey: true })
      expect(callbacks.onExit).not.toHaveBeenCalled()
      expect(callbacks.onSave).not.toHaveBeenCalled()
    })
  })
})
