/**
 * @layer L3
 * @module src/renderer/hooks/useZoomable
 * @coverage 缩放/平移/拖拽/双击/滚轮交互
 * @dependencies react
 * @remarks jsdom 环境；wheel 用真实 dispatchEvent（hook 内部是原生 addEventListener），
 *           mouse 仍用 mock MouseEvent（合成事件处理器未改）。
 *           文件保持 .ts：用 React.createElement 避免 JSX（esbuild 按 .ts 不解析 JSX）。
 *           wheel 用 async act：React 19 下原生监听器里的 setScale 不会被 sync act 同步刷新。
 *           注意：renderWithRef 返回的 api 是 getter，必须用 r.api 访问（不能解构，
 *           解构会当场快照到初始对象，读不到重渲染后的新值）。
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { renderHook, render, screen, act } from '@testing-library/react'
import { useZoomable } from './useZoomable'

function makeMouseEvent(clientX: number, clientY: number): React.MouseEvent {
  return {
    clientX,
    clientY,
    preventDefault: vi.fn()
  } as unknown as React.MouseEvent
}

/**
 * 把 hook 挂到真实 DOM 元素上，用于触发原生 wheel 事件。
 * renderHook 不会把 containerRef 绑到真实节点，effect 里拿不到 el，监听器不会注册。
 */
function renderWithRef(options?: Parameters<typeof useZoomable>[0]) {
  let api!: ReturnType<typeof useZoomable>
  function Harness() {
    api = useZoomable(options)
    return React.createElement('div', { ref: api.containerRef, 'data-testid': 'zoom-target' })
  }
  render(React.createElement(Harness))
  // api 用 getter：每次 r.api 访问都取最新的 hook 返回值（重渲染后会被重新赋值）。
  return {
    get api() {
      return api
    },
    target: screen.getByTestId('zoom-target')
  }
}

async function fireWheel(target: HTMLElement, deltaY: number): Promise<WheelEvent> {
  const evt = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true })
  await act(async () => {
    target.dispatchEvent(evt)
  })
  return evt
}

describe('useZoomable', () => {
  describe('初始状态', () => {
    it('默认 scale=1, position={0,0}, dragging=false, dragMoved=false', () => {
      const { result } = renderHook(() => useZoomable())
      expect(result.current.scale).toBe(1)
      expect(result.current.position).toEqual({ x: 0, y: 0 })
      expect(result.current.dragging).toBe(false)
      expect(result.current.dragMoved).toBe(false)
    })

    it('支持自定义 maxZoom/zoomStep/doubleClickZoom', async () => {
      const r = renderWithRef({ maxZoom: 10, zoomStep: 0.5, doubleClickZoom: 3 })
      // 通过滚轮验证 zoomStep=0.5 生效
      await fireWheel(r.target, -100)
      expect(r.api.scale).toBe(1.5)
    })
  })

  describe('handleWheel', () => {
    it('deltaY<0 放大', async () => {
      const r = renderWithRef()
      await fireWheel(r.target, -100)
      expect(r.api.scale).toBeCloseTo(1.1, 5)
    })

    it('deltaY>0 缩小', async () => {
      const r = renderWithRef({ maxZoom: 5 })
      // 先放大到 1.5
      await fireWheel(r.target, -100)
      await fireWheel(r.target, -100)
      await fireWheel(r.target, -100)
      await fireWheel(r.target, -100)
      await fireWheel(r.target, -100)
      expect(r.api.scale).toBeCloseTo(1.5, 5)
      // 缩小
      await fireWheel(r.target, 100)
      expect(r.api.scale).toBeCloseTo(1.4, 5)
    })

    it('缩小不低于 1', async () => {
      const r = renderWithRef()
      await fireWheel(r.target, 100)
      await fireWheel(r.target, 100)
      expect(r.api.scale).toBe(1)
    })

    it('放大不超过 maxZoom', async () => {
      const r = renderWithRef({ maxZoom: 1.5 })
      // zoomStep 默认 0.1，3 次后达到 1.3（未到 1.5），再多滚一次仍被钳到 1.5
      await fireWheel(r.target, -100)
      await fireWheel(r.target, -100)
      await fireWheel(r.target, -100)
      await fireWheel(r.target, -100)
      await fireWheel(r.target, -100)
      expect(r.api.scale).toBe(1.5)
    })

    it('调用 preventDefault', async () => {
      const r = renderWithRef()
      const evt = await fireWheel(r.target, -100)
      expect(evt.defaultPrevented).toBe(true)
    })
  })

  describe('handleDoubleClick', () => {
    it('scale=1 时双击放大到 doubleClickZoom', () => {
      const { result } = renderHook(() => useZoomable({ doubleClickZoom: 2 }))
      act(() => {
        result.current.handlers.onDoubleClick()
      })
      expect(result.current.scale).toBe(2)
    })

    it('scale>1 时双击复位到 1', () => {
      const { result } = renderHook(() => useZoomable({ doubleClickZoom: 2 }))
      act(() => {
        result.current.handlers.onDoubleClick()
      })
      expect(result.current.scale).toBe(2)
      act(() => {
        result.current.handlers.onDoubleClick()
      })
      expect(result.current.scale).toBe(1)
      expect(result.current.position).toEqual({ x: 0, y: 0 })
    })
  })

  describe('handleMouseDown / Move / Up 拖拽', () => {
    it('scale<=1 时 mousedown 不启用拖拽', () => {
      const { result } = renderHook(() => useZoomable())
      const evt = makeMouseEvent(100, 100)
      act(() => {
        result.current.handlers.onMouseDown(evt)
      })
      expect(result.current.dragging).toBe(false)
    })

    it('scale>1 时 mousedown 启用拖拽', () => {
      const { result } = renderHook(() => useZoomable({ doubleClickZoom: 2 }))
      act(() => {
        result.current.handlers.onDoubleClick()
      })
      const evt = makeMouseEvent(100, 100)
      act(() => {
        result.current.handlers.onMouseDown(evt)
      })
      expect(result.current.dragging).toBe(true)
      expect(evt.preventDefault).toHaveBeenCalled()
    })

    it('dragging 中 mousemove 更新 position', () => {
      const { result } = renderHook(() => useZoomable({ doubleClickZoom: 2 }))
      act(() => {
        result.current.handlers.onDoubleClick()
      })
      act(() => {
        result.current.handlers.onMouseDown(makeMouseEvent(100, 100))
      })
      act(() => {
        result.current.handlers.onMouseMove(makeMouseEvent(150, 120))
      })
      expect(result.current.position).toEqual({ x: 50, y: 20 })
    })

    it('未 dragging 时 mousemove 不更新 position', () => {
      const { result } = renderHook(() => useZoomable())
      const initial = result.current.position
      act(() => {
        result.current.handlers.onMouseMove(makeMouseEvent(150, 120))
      })
      expect(result.current.position).toEqual(initial)
    })

    it('mousemove 移动超过 5px 设置 dragMoved=true', () => {
      const { result } = renderHook(() => useZoomable({ doubleClickZoom: 2 }))
      act(() => {
        result.current.handlers.onDoubleClick()
      })
      act(() => {
        result.current.handlers.onMouseDown(makeMouseEvent(100, 100))
      })
      act(() => {
        result.current.handlers.onMouseMove(makeMouseEvent(110, 100))
      })
      expect(result.current.dragMoved).toBe(true)
    })

    it('mousemove 移动不超过 5px 保持 dragMoved=false', () => {
      const { result } = renderHook(() => useZoomable({ doubleClickZoom: 2 }))
      act(() => {
        result.current.handlers.onDoubleClick()
        result.current.handlers.onMouseDown(makeMouseEvent(100, 100))
        result.current.handlers.onMouseMove(makeMouseEvent(103, 100))
      })
      expect(result.current.dragMoved).toBe(false)
    })

    it('mouseUp 停止拖拽', () => {
      const { result } = renderHook(() => useZoomable({ doubleClickZoom: 2 }))
      act(() => {
        result.current.handlers.onDoubleClick()
        result.current.handlers.onMouseDown(makeMouseEvent(100, 100))
        result.current.handlers.onMouseUp()
      })
      expect(result.current.dragging).toBe(false)
    })

    it('mouseLeave 等同于 mouseUp', () => {
      const { result } = renderHook(() => useZoomable({ doubleClickZoom: 2 }))
      act(() => {
        result.current.handlers.onDoubleClick()
        result.current.handlers.onMouseDown(makeMouseEvent(100, 100))
        result.current.handlers.onMouseLeave()
      })
      expect(result.current.dragging).toBe(false)
    })

    it('mousedown 记录 dragStartPos', () => {
      const { result } = renderHook(() => useZoomable())
      act(() => {
        result.current.handlers.onMouseDown(makeMouseEvent(123, 456))
      })
      expect(result.current.dragStartPos.current).toEqual({ x: 123, y: 456 })
    })
  })

  describe('reset', () => {
    it('重置 scale 与 position', () => {
      const { result } = renderHook(() => useZoomable({ doubleClickZoom: 2 }))
      act(() => {
        result.current.handlers.onDoubleClick()
        result.current.handlers.onMouseDown(makeMouseEvent(100, 100))
        result.current.handlers.onMouseMove(makeMouseEvent(150, 120))
        result.current.reset()
      })
      expect(result.current.scale).toBe(1)
      expect(result.current.position).toEqual({ x: 0, y: 0 })
    })
  })

  describe('setScale', () => {
    it('直接设置 scale 值', () => {
      const { result } = renderHook(() => useZoomable())
      act(() => {
        result.current.setScale(3.5)
      })
      expect(result.current.scale).toBe(3.5)
    })

    it('支持函数式更新', () => {
      const { result } = renderHook(() => useZoomable({ doubleClickZoom: 2 }))
      act(() => {
        result.current.handlers.onDoubleClick()
        result.current.setScale((prev) => prev + 1)
      })
      expect(result.current.scale).toBe(3)
    })
  })
})
