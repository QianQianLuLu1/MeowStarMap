import { useEffect, useState } from 'react'

interface ContainerSize {
  width: number
  height: number
}

/**
 * P1-U10：监听容器尺寸变化（ResizeObserver + window resize 双保险）
 *
 * VirtualImageGrid / TimelineView / EventTimelineView 三者原各自实现 16 行
 * 几乎相同的 update + ResizeObserver + addEventListener 逻辑，抽取后各减约 15 行。
 *
 * @param ref 容器元素 ref（由调用方持有，用于 scrollTop 等其它用途）
 * @returns `{ width, height }`，初始 `{ 0, 0 }`，挂载后立即测量
 *
 * 注：ref 类型用 `RefObject<T | null>` 兼容 React 19 中 `useRef<T>(null)` 与
 * `createRef<T>()` 的返回类型（current 可能为 null）。
 */
export function useContainerSize<T extends HTMLElement>(
  ref: React.RefObject<T | null>
): ContainerSize {
  const [size, setSize] = useState<ContainerSize>({ width: 0, height: 0 })

  useEffect(() => {
    const update = () => {
      const el = ref.current
      if (!el) return
      setSize({ width: el.clientWidth, height: el.clientHeight })
    }
    update()
    const observer = new ResizeObserver(update)
    if (ref.current) observer.observe(ref.current)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [ref])

  return size
}
