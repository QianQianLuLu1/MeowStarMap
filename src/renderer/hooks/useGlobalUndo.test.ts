/**
 * @layer L3
 * @module src/renderer/hooks/useGlobalUndo
 * @coverage 全局 Ctrl+Z 监听 + 编辑器/输入框跳过 + canUndo 分支 + undo 成功/失败提示
 * @dependencies react, useUIStore, useToast, useOperationHistoryStore
 * @remarks jsdom 环境，mock useUIStore/useToast + spy useOperationHistoryStore.getState
 */
import { describe, it, expect, beforeEach, vi, afterEach, type MockInstance } from 'vitest'
import { renderHook } from '@testing-library/react'

const { showMessageMock } = vi.hoisted(() => ({ showMessageMock: vi.fn() }))
const { currentViewMock } = vi.hoisted(() => ({
  currentViewMock: { currentView: 'gallery' as string }
}))

vi.mock('../stores/uiStore', () => ({
  useUIStore: (selector: (s: { currentView: string }) => unknown) =>
    selector({ currentView: currentViewMock.currentView })
}))

vi.mock('./useToast', () => ({
  useToast: () => ({
    showMessage: showMessageMock,
    messages: [],
    dismiss: vi.fn(),
    clear: vi.fn()
  })
}))

import { useGlobalUndo } from './useGlobalUndo'
import { useOperationHistoryStore } from '../stores/operationHistoryStore'

function dispatchKey(
  key: string,
  opts: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}
): void {
  const ev = new KeyboardEvent('keydown', {
    key,
    ctrlKey: opts.ctrl ?? false,
    metaKey: opts.meta ?? false,
    shiftKey: opts.shift ?? false,
    bubbles: true,
    cancelable: true
  })
  // 派发到 body 而非 window，使 e.target 为 HTMLElement（避免 window.tagName undefined）
  document.body.dispatchEvent(ev)
}

describe('useGlobalUndo', () => {
  let getStateSpy: MockInstance
  let undoMock: MockInstance
  let canUndoMock: MockInstance

  beforeEach(() => {
    showMessageMock.mockReset()
    currentViewMock.currentView = 'gallery'
    undoMock = vi.fn()
    canUndoMock = vi.fn()
    getStateSpy = vi.spyOn(useOperationHistoryStore, 'getState').mockReturnValue({
      stack: [],
      canUndo: canUndoMock,
      undo: undoMock
    } as unknown as ReturnType<typeof useOperationHistoryStore.getState>)
  })

  afterEach(() => {
    getStateSpy.mockRestore()
    vi.restoreAllMocks()
  })

  describe('快捷键触发', () => {
    it('Ctrl+Z 触发 undo 调用', async () => {
      canUndoMock.mockReturnValue(true)
      undoMock.mockResolvedValue({ success: true })
      // 源码 undo 成功后访问 top.description，需提供非空 stack 避免未处理 reject
      getStateSpy.mockReturnValue({
        stack: [
          { localId: '1', type: 'favorite_toggle', description: 'x', payload: {}, createdAt: 0 }
        ],
        canUndo: canUndoMock,
        undo: undoMock
      } as unknown as ReturnType<typeof useOperationHistoryStore.getState>)
      renderHook(() => useGlobalUndo())
      dispatchKey('z', { ctrl: true })
      await new Promise((r) => setTimeout(r, 0))
      expect(undoMock).toHaveBeenCalledTimes(1)
    })

    it('Cmd+Z（meta）触发 undo 调用', async () => {
      canUndoMock.mockReturnValue(true)
      undoMock.mockResolvedValue({ success: true })
      getStateSpy.mockReturnValue({
        stack: [
          { localId: '1', type: 'favorite_toggle', description: 'x', payload: {}, createdAt: 0 }
        ],
        canUndo: canUndoMock,
        undo: undoMock
      } as unknown as ReturnType<typeof useOperationHistoryStore.getState>)
      renderHook(() => useGlobalUndo())
      dispatchKey('z', { meta: true })
      await new Promise((r) => setTimeout(r, 0))
      expect(undoMock).toHaveBeenCalledTimes(1)
    })

    it('大写 Z 也触发（key 小写比对）', async () => {
      canUndoMock.mockReturnValue(true)
      undoMock.mockResolvedValue({ success: true })
      getStateSpy.mockReturnValue({
        stack: [
          { localId: '1', type: 'favorite_toggle', description: 'x', payload: {}, createdAt: 0 }
        ],
        canUndo: canUndoMock,
        undo: undoMock
      } as unknown as ReturnType<typeof useOperationHistoryStore.getState>)
      renderHook(() => useGlobalUndo())
      dispatchKey('Z', { ctrl: true })
      await new Promise((r) => setTimeout(r, 0))
      expect(undoMock).toHaveBeenCalledTimes(1)
    })

    it('其他键不触发 undo', async () => {
      canUndoMock.mockReturnValue(true)
      undoMock.mockResolvedValue({ success: true })
      renderHook(() => useGlobalUndo())
      dispatchKey('a', { ctrl: true })
      await new Promise((r) => setTimeout(r, 0))
      expect(undoMock).not.toHaveBeenCalled()
    })

    it('Ctrl+Shift+Z（重做）不触发撤销', async () => {
      canUndoMock.mockReturnValue(true)
      undoMock.mockResolvedValue({ success: true })
      renderHook(() => useGlobalUndo())
      dispatchKey('z', { ctrl: true, shift: true })
      await new Promise((r) => setTimeout(r, 0))
      expect(undoMock).not.toHaveBeenCalled()
    })
  })

  describe('编辑器视图跳过', () => {
    it('currentView=editor 时不触发 undo', async () => {
      currentViewMock.currentView = 'editor'
      canUndoMock.mockReturnValue(true)
      undoMock.mockResolvedValue({ success: true })
      renderHook(() => useGlobalUndo())
      dispatchKey('z', { ctrl: true })
      await new Promise((r) => setTimeout(r, 0))
      expect(undoMock).not.toHaveBeenCalled()
    })
  })

  describe('输入框聚焦跳过', () => {
    it('input 聚焦时不触发 undo', async () => {
      canUndoMock.mockReturnValue(true)
      undoMock.mockResolvedValue({ success: true })
      renderHook(() => useGlobalUndo())
      const input = document.createElement('input')
      document.body.appendChild(input)
      input.focus()
      const ev = new KeyboardEvent('keydown', {
        key: 'z',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      })
      input.dispatchEvent(ev)
      await new Promise((r) => setTimeout(r, 0))
      expect(undoMock).not.toHaveBeenCalled()
      document.body.removeChild(input)
    })

    it('textarea 聚焦时不触发 undo', async () => {
      canUndoMock.mockReturnValue(true)
      undoMock.mockResolvedValue({ success: true })
      renderHook(() => useGlobalUndo())
      const ta = document.createElement('textarea')
      document.body.appendChild(ta)
      ta.focus()
      const ev = new KeyboardEvent('keydown', {
        key: 'z',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      })
      ta.dispatchEvent(ev)
      await new Promise((r) => setTimeout(r, 0))
      expect(undoMock).not.toHaveBeenCalled()
      document.body.removeChild(ta)
    })

    it('isContentEditable 元素聚焦时不触发 undo', async () => {
      canUndoMock.mockReturnValue(true)
      undoMock.mockResolvedValue({ success: true })
      renderHook(() => useGlobalUndo())
      const div = document.createElement('div')
      div.contentEditable = 'true'
      // jsdom 中 isContentEditable 的 getter 可能不随 contentEditable 属性同步更新，显式 stub
      Object.defineProperty(div, 'isContentEditable', { value: true, configurable: true })
      document.body.appendChild(div)
      div.focus()
      const ev = new KeyboardEvent('keydown', {
        key: 'z',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      })
      div.dispatchEvent(ev)
      await new Promise((r) => setTimeout(r, 0))
      expect(undoMock).not.toHaveBeenCalled()
      document.body.removeChild(div)
    })
  })

  describe('canUndo 分支', () => {
    it('canUndo=false 时显示"没有可撤销的操作"', async () => {
      canUndoMock.mockReturnValue(false)
      renderHook(() => useGlobalUndo())
      dispatchKey('z', { ctrl: true })
      await new Promise((r) => setTimeout(r, 0))
      expect(undoMock).not.toHaveBeenCalled()
      expect(showMessageMock).toHaveBeenCalledWith('没有可撤销的操作', 'info')
    })
  })

  describe('撤销结果', () => {
    it('undo 成功时显示"已撤销：xxx"', async () => {
      canUndoMock.mockReturnValue(true)
      undoMock.mockResolvedValue({ success: true })
      getStateSpy.mockReturnValue({
        stack: [
          {
            localId: '1',
            type: 'favorite_toggle',
            description: '收藏 "img.jpg"',
            payload: {},
            createdAt: Date.now()
          }
        ],
        canUndo: canUndoMock,
        undo: undoMock
      } as unknown as ReturnType<typeof useOperationHistoryStore.getState>)
      renderHook(() => useGlobalUndo())
      dispatchKey('z', { ctrl: true })
      await new Promise((r) => setTimeout(r, 10))
      expect(showMessageMock).toHaveBeenCalledWith('已撤销：收藏 "img.jpg"', 'success')
    })

    it('undo 失败时显示错误消息', async () => {
      canUndoMock.mockReturnValue(true)
      undoMock.mockResolvedValue({ success: false, message: '回滚失败' })
      getStateSpy.mockReturnValue({
        stack: [
          { localId: '1', type: 'favorite_toggle', description: 'x', payload: {}, createdAt: 0 }
        ],
        canUndo: canUndoMock,
        undo: undoMock
      } as unknown as ReturnType<typeof useOperationHistoryStore.getState>)
      renderHook(() => useGlobalUndo())
      dispatchKey('z', { ctrl: true })
      await new Promise((r) => setTimeout(r, 10))
      expect(showMessageMock).toHaveBeenCalledWith('回滚失败', 'error')
    })

    it('undo 失败且 message 缺失时显示兜底文案', async () => {
      canUndoMock.mockReturnValue(true)
      undoMock.mockResolvedValue({ success: false })
      getStateSpy.mockReturnValue({
        stack: [
          { localId: '1', type: 'favorite_toggle', description: 'x', payload: {}, createdAt: 0 }
        ],
        canUndo: canUndoMock,
        undo: undoMock
      } as unknown as ReturnType<typeof useOperationHistoryStore.getState>)
      renderHook(() => useGlobalUndo())
      dispatchKey('z', { ctrl: true })
      await new Promise((r) => setTimeout(r, 10))
      expect(showMessageMock).toHaveBeenCalledWith('撤销失败', 'error')
    })
  })

  describe('卸载清理', () => {
    it('卸载后不再监听 keydown', async () => {
      canUndoMock.mockReturnValue(true)
      undoMock.mockResolvedValue({ success: true })
      const { unmount } = renderHook(() => useGlobalUndo())
      unmount()
      dispatchKey('z', { ctrl: true })
      await new Promise((r) => setTimeout(r, 0))
      expect(undoMock).not.toHaveBeenCalled()
    })
  })
})
