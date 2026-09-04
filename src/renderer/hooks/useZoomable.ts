import { useState, useCallback, useRef, useEffect } from 'react'

/**
 * P1-G：可缩放/平移交互的统一 hook
 * 抽取自 DetailPage ZoomableImage 和 EditorPage ZoomablePreview 的公共逻辑
 * 提供：缩放状态、平移状态、滚轮缩放、拖拽平移、双击复位、拖拽距离检测
 *
 * 使用示例：
 *   const { scale, position, dragging, dragMoved, containerRef, handlers, reset } = useZoomable({ maxZoom: 5 })
 *   <div ref={containerRef} {...handlers} style={{ transform: `translate(${position.x}px, ${position.y}px) scale(${scale})` }}>
 *     <img src={src} />
 *   </div>
 *
 * 为什么 wheel 用原生监听而非合成 onWheel：
 * React 17+ 把 wheel/touchstart/touchmove 挂在根容器上且 passive:true，
 * 合成事件里的 preventDefault 会被忽略并打印 "Unable to preventDefault inside passive event listener"。
 * 故改为对 containerRef 指向的元素 addEventListener('wheel', handler, { passive: false })。
 */
interface UseZoomableOptions {
  /** 最大缩放倍数，默认 5 */
  maxZoom?: number
  /** 滚轮缩放步长，默认 0.1 */
  zoomStep?: number
  /** 双击放大倍数，默认 2 */
  doubleClickZoom?: number
}

interface ZoomableHandlers {
  onMouseDown: (e: React.MouseEvent) => void
  onMouseMove: (e: React.MouseEvent) => void
  onMouseUp: () => void
  onMouseLeave: () => void
  onDoubleClick: () => void
}

export interface UseZoomableResult {
  scale: number
  position: { x: number; y: number }
  dragging: boolean
  /** 拖拽距离检测：mousedown 起始坐标，用于 click 中判断是否为拖拽（移动超过阈值则忽略 click） */
  dragStartPos: React.MutableRefObject<{ x: number; y: number } | null>
  /** 是否在本次 mousedown 后发生过拖拽（移动距离 > 5px） */
  dragMoved: boolean
  /** 绑定到可缩放容器根元素：hook 内部以此为目标注册原生 wheel 监听（passive:false 才能 preventDefault） */
  containerRef: React.RefObject<HTMLDivElement | null>
  handlers: ZoomableHandlers
  reset: () => void
  setScale: React.Dispatch<React.SetStateAction<number>>
}

export function useZoomable(options: UseZoomableOptions = {}): UseZoomableResult {
  const { maxZoom = 5, zoomStep = 0.1, doubleClickZoom = 2 } = options

  const [scale, setScale] = useState(1)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const dragStartRef = useRef({ x: 0, y: 0, px: 0, py: 0 })
  // U-G1：记录 mousedown 起始坐标，用于在 click 中判断是否为拖拽
  const dragStartPos = useRef<{ x: number; y: number } | null>(null)
  const dragMovedRef = useRef(false)
  const [dragMoved, setDragMoved] = useState(false)

  // 原生 wheel 监听目标（替代合成 onWheel，见文件头说明）
  const containerRef = useRef<HTMLDivElement>(null)

  const reset = useCallback(() => {
    setScale(1)
    setPosition({ x: 0, y: 0 })
  }, [])

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault()
      setScale((prev) => {
        const delta = e.deltaY > 0 ? -zoomStep : zoomStep
        return Math.max(1, Math.min(prev + delta, maxZoom))
      })
    },
    [maxZoom, zoomStep]
  )

  // 依赖 handleWheel：仅当 maxZoom/zoomStep 变化导致 handleWheel 引用变化时重新绑定，避免每次渲染重绑。
  // 清理函数的 removeEventListener 第三参必须与 add 时一致（相同 type/callback/options），否则移除不掉会泄漏。
  // AddEventListenerOptions 含 passive；DOM lib 的具名事件 overload 只认 EventListenerOptions，故显式标注类型。
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const opts: AddEventListenerOptions = { passive: false }
    el.addEventListener('wheel', handleWheel, opts)
    return () => {
      el.removeEventListener('wheel', handleWheel, opts)
    }
  }, [handleWheel])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      dragStartPos.current = { x: e.clientX, y: e.clientY }
      dragMovedRef.current = false
      setDragMoved(false)
      // 仅在已缩放（scale > 1）时启用拖拽平移
      if (scale <= 1) return
      e.preventDefault()
      setDragging(true)
      dragStartRef.current = { x: e.clientX, y: e.clientY, px: position.x, py: position.y }
    },
    [scale, position]
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragging) return
      const dx = e.clientX - dragStartRef.current.x
      const dy = e.clientY - dragStartRef.current.y
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        dragMovedRef.current = true
        setDragMoved(true)
      }
      setPosition({ x: dragStartRef.current.px + dx, y: dragStartRef.current.py + dy })
    },
    [dragging]
  )

  const handleMouseUp = useCallback(() => {
    setDragging(false)
  }, [])

  const handleDoubleClick = useCallback(() => {
    setScale((prev) => {
      if (prev > 1) {
        reset()
        return 1
      }
      return doubleClickZoom
    })
  }, [reset, doubleClickZoom])

  return {
    scale,
    position,
    dragging,
    dragStartPos,
    dragMoved,
    containerRef,
    handlers: {
      onMouseDown: handleMouseDown,
      onMouseMove: handleMouseMove,
      onMouseUp: handleMouseUp,
      onMouseLeave: handleMouseUp,
      onDoubleClick: handleDoubleClick
    },
    reset,
    setScale
  }
}
