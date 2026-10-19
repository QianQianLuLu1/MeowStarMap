import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

/**
 * 滚动状态信号（只写 ref，不触发渲染）。
 *
 * 用途：虚拟列表在内容滚过**静止光标**时，Blink 会持续重算 hover 命中节点，于是每一次换行
 * 都会打一次卡片的 mouseEnter/mouseLeave。若该状态被存成组件 state（如网格的 hoveredId），
 * 等价于「滚动每帧整屏重渲染 + 遮罩子树整体装卸」，即图库网格向下滚动时逐格闪现的重绘来源。
 * 滚动进行中忽略 hover 变化即可消除。
 *
 * 手法对齐 `useGlassScrollSignal.ts`：document 捕获阶段 + passive 监听。区别是本 Hook 不写
 * DOM 样式，只置一个布尔 ref，因此不需要 rAF 合帧（每事件一次 ref 赋值，零成本）。
 * 采用「拖尾沿」判定：每个 scroll 事件都重置空闲定时器，连续滚动期间恒为 true。
 */
const SCROLL_IDLE_MS = 150

export function useIsScrolling(onIdle?: () => void): RefObject<boolean> {
  const scrolling = useRef(false)
  // 回调存 ref：调用方传内联函数也不会导致监听反复解绑/重绑
  const idleRef = useRef(onIdle)
  idleRef.current = onIdle

  useEffect(() => {
    if (typeof document === 'undefined') return
    let idleTimer: number | null = null

    const markIdle = () => {
      idleTimer = null
      scrolling.current = false
      idleRef.current?.()
    }

    const onScroll = () => {
      scrolling.current = true
      if (idleTimer !== null) window.clearTimeout(idleTimer)
      idleTimer = window.setTimeout(markIdle, SCROLL_IDLE_MS)
    }

    // 捕获阶段：元素级 scroll 事件不冒泡，但传播路径必经 document；window 滚动时
    // 事件目标即 document，两条路径都能命中
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true })
      if (idleTimer !== null) window.clearTimeout(idleTimer)
    }
  }, [])

  return scrolling
}
