/**
 * 流体滑块 Tab 指示器 Hook
 *
 * 职责：测量激活项几何 → 两条边独立补间（前沿快 / 后沿慢）→ 只写 transform。
 * 供 `Sidebar` 的导航区使用：容器挂 `containerRef`，每个导航项挂 `registerItem(id)`，
 * 导航区首个子节点渲染 `indicatorRef` 指向的滑块元素。
 *
 * 生命周期与兜底：
 * - 首次测量与布局变化（ResizeObserver）均为瞬时吸附，不做动画
 * - 切换时先停掉上一段动画，并以「当前视觉边值」为新起点，快速连点不回跳、不叠加
 * - 卸载时停止全部在飞动画并断开 ResizeObserver
 * - 测量失败 / 矩形非法 / activeId 未注册 → 隐藏滑块并告警，不阻断渲染
 * - `prefers-reduced-motion` 或应用内 `html.reduce-motion` → 瞬时落位
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { animate, useReducedMotion } from 'motion/react'
import type { AnimationPlaybackControls } from 'motion/react'
import {
  composeFluidFrame,
  rectToEdges,
  resolveFluidGeometry,
  sanitizeFluidConfig,
  type FluidEase,
  type FluidEdges,
  type FluidFrame,
  type FluidRect
} from '../utils/fluid-tab'

/** 圆角解析失败时的兜底值（px）：jsdom 与自定义主题下 getComputedStyle 可能取不到令牌 */
const FALLBACK_RADIUS = 6

export interface UseFluidTabIndicatorResult<T extends HTMLElement> {
  /** 导航容器（滑块的定位基准） */
  containerRef: RefObject<T | null>
  /** 滑块元素 */
  indicatorRef: RefObject<HTMLDivElement | null>
  /** 生成稳定的导航项 ref 回调；传 null 时注销该项 */
  registerItem: (id: string) => (el: HTMLElement | null) => void
}

type AnimateFn = (
  from: number,
  to: number,
  options: {
    duration: number
    ease: FluidEase
    onUpdate: (value: number) => void
    onComplete: () => void
  }
) => AnimationPlaybackControls

/** 读取主题圆角令牌，用于抵消 scaleY 对圆角的纵向拉伸 */
function readRadius(el: HTMLElement): number {
  const parsed = Number.parseFloat(getComputedStyle(el).getPropertyValue('--radius-sm'))
  return Number.isFinite(parsed) ? parsed : FALLBACK_RADIUS
}

export function useFluidTabIndicator<T extends HTMLElement = HTMLElement>(
  activeId: string | null
): UseFluidTabIndicatorResult<T> {
  const containerRef = useRef<T | null>(null)
  const indicatorRef = useRef<HTMLDivElement | null>(null)
  const itemsRef = useRef<Map<string, HTMLElement>>(new Map())
  const refCallbacksRef = useRef<Map<string, (el: HTMLElement | null) => void>>(new Map())
  /** 当前视觉边值（含形变中），中断时作为新起点 */
  const edgesRef = useRef<FluidEdges | null>(null)
  const radiusRef = useRef<number>(FALLBACK_RADIUS)
  const runningRef = useRef<AnimationPlaybackControls[]>([])
  const activeIdRef = useRef<string | null>(activeId)
  /** 布局订阅器：容器与各导航项共用，registerItem 增删项时同步 observe/unobserve */
  const observerRef = useRef<ResizeObserver | null>(null)
  activeIdRef.current = activeId

  const reduceMotion = useReducedMotion()
  const prefersReduce =
    reduceMotion ||
    (typeof document !== 'undefined' &&
      document.documentElement.classList.contains('reduce-motion'))
  const config = useMemo(() => sanitizeFluidConfig(), [])

  const stopAll = useCallback(() => {
    for (const controls of runningRef.current) {
      try {
        controls.stop()
      } catch (err) {
        console.warn('[fluid-tab-indicator] stop failed:', err)
      }
    }
    runningRef.current = []
  }, [])

  const applyFrame = useCallback((frame: FluidFrame) => {
    const el = indicatorRef.current
    if (!el) return
    el.style.transform = `translateY(${frame.top}px) scaleY(${frame.scaleY})`
    // 纵向 scale 会拉伸圆角，用双半径语法反向补偿（水平半径不变、垂直半径除以 scaleY）
    const radius = radiusRef.current
    el.style.borderRadius = `${radius}px / ${(radius / (frame.scaleY || 1)).toFixed(2)}px`
  }, [])

  /** 测量激活项相对容器的矩形；失败或非法返回 null（已告警） */
  const measure = useCallback((id: string | null): FluidRect | null => {
    const container = containerRef.current
    const el = id ? itemsRef.current.get(id) : undefined
    if (!container || !el) return null
    try {
      const top = el.getBoundingClientRect().top - container.getBoundingClientRect().top
      const height = el.getBoundingClientRect().height
      // 高度为 0 属于「尚未布局」（jsdom / 隐藏态），静默按未测量处理
      if (height <= 0) return null
      if (!Number.isFinite(top) || !Number.isFinite(height)) {
        console.warn('[fluid-tab-indicator] invalid rect:', { id, top, height })
        return null
      }
      return { top, height }
    } catch (err) {
      console.warn('[fluid-tab-indicator] measure failed:', err)
      return null
    }
  }, [])

  const hide = useCallback(() => {
    const el = indicatorRef.current
    if (el) el.style.opacity = '0'
  }, [])

  /** 落位：animated=false 时瞬时吸附；否则两条边各自补间 */
  const moveTo = useCallback(
    (rect: FluidRect, animated: boolean) => {
      const el = indicatorRef.current
      if (!el) return
      const to = rectToEdges(rect)
      const from = edgesRef.current
      radiusRef.current = readRadius(el)
      el.style.height = `${rect.height}px`
      el.style.opacity = '1'

      if (!animated || !from) {
        stopAll()
        edgesRef.current = to
        applyFrame({ top: to.top, scaleY: 1, gap: to.bottom - to.top })
        return
      }

      const geo = resolveFluidGeometry(from, to)
      stopAll()
      const edge = { lead: geo.leadFrom, trail: geo.trailFrom }
      const write = () => {
        const frame = composeFluidFrame({
          lead: edge.lead,
          trail: edge.trail,
          direction: geo.direction,
          baseHeight: rect.height,
          maxStretch: config.maxStretch
        })
        edgesRef.current = { top: frame.top, bottom: frame.top + frame.gap }
        applyFrame(frame)
      }
      const finish = () => {
        edgesRef.current = to
        applyFrame({ top: to.top, scaleY: 1, gap: to.bottom - to.top })
      }
      const start = (
        ease: FluidEase,
        key: 'lead' | 'trail',
        fromValue: number,
        toValue: number
      ): AnimationPlaybackControls =>
        (animate as unknown as AnimateFn)(fromValue, toValue, {
          duration: config.duration,
          ease,
          onUpdate: (value: number) => {
            edge[key] = value
            write()
          },
          onComplete: finish
        })

      runningRef.current = [
        start(config.leadEase, 'lead', geo.leadFrom, geo.leadTo),
        start(config.trailEase, 'trail', geo.trailFrom, geo.trailTo)
      ]
    },
    [applyFrame, config, stopAll]
  )

  // 激活项变化：测量并（在非减弱动效下）动画落位
  useLayoutEffect(() => {
    const rect = measure(activeId)
    if (!rect) {
      hide()
      return
    }
    moveTo(rect, !prefersReduce)
  }, [activeId, hide, measure, moveTo, prefersReduce])

  // 布局变化（窗口缩放 / 侧边栏折叠 / 紧凑模式）：复测并瞬时吸附，避免错位
  useEffect(() => {
    const container = containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const rect = measure(activeIdRef.current)
      if (rect) moveTo(rect, false)
    })
    observer.observe(container)
    // 条目自身也需订阅：nav 是 flex 容器，单项高度/内边距变化（如紧凑模式改 nav-item padding）
    // 时容器盒子尺寸可能完全不变，只订阅容器会漏掉这类重排，滑块停在旧几何上错位。
    for (const el of itemsRef.current.values()) observer.observe(el)
    observerRef.current = observer
    return () => {
      observer.disconnect()
      observerRef.current = null
    }
  }, [measure, moveTo])

  // 卸载：停掉在飞的动画，避免对已卸载节点继续写样式
  useEffect(() => stopAll, [stopAll])

  const registerItem = useCallback((id: string) => {
    const cached = refCallbacksRef.current.get(id)
    if (cached) return cached
    const callback = (el: HTMLElement | null) => {
      if (el) {
        itemsRef.current.set(id, el)
        observerRef.current?.observe(el)
        return
      }
      const prev = itemsRef.current.get(id)
      if (prev) observerRef.current?.unobserve(prev)
      itemsRef.current.delete(id)
    }
    refCallbacksRef.current.set(id, callback)
    return callback
  }, [])

  return { containerRef, indicatorRef, registerItem }
}
