import { useRef } from 'react'
import type { RefObject } from 'react'
import { useWheel } from '@use-gesture/react'

/**
 * 全屏预览「滚轮翻页」钩子。
 *
 * 存在理由（缺陷1：鼠标翻页失效）：全屏查看器原先只接了触摸滑动与左右导航按钮，
 * 滚轮这条最直觉的鼠标翻页路径从未接线。此处基于 @use-gesture/react 的 useWheel
 * 封一层薄的政策层，避免自行实现原生监听时出现两个既有坑：
 *   - React 合成 wheel 是 passive 监听，preventDefault 会被忽略并打印告警
 *     （见 src/renderer/hooks/useZoomable.ts 文件头注释），必须走原生绑定；
 *   - 触控板/惯性滚轮一次甩动会连发十几个 delta 量程的事件，按事件计数翻页会
 *     直接跳过十几张，必须做「阈值累加 + 冷却窗口」。
 *
 * 政策：
 *   1. 单轴优先：|deltaX| > |deltaY| 时取 deltaX（触控板横向双指），否则取 deltaY；
 *   2. 累加到 |threshold| 才触发一次翻页，随即清零并进入冷却；
 *   3. 冷却窗口内的位移全部丢弃，用于吸收惯性；冷却结束后视为一次全新滚动段落；
 *   4. 放行选择器（ignoreSelector）：事件目标命中其后代时整条放行——不阻止默认
 *      滚动、不翻页，供 EXIF 信息浮层等「自有滚动区」声明滚轮归属。
 *
 * 失败策略：非破坏性失败一律静默（renderer 侧 eslint 禁 console 与 throw new Error），
 * 最坏结果是「滚轮不翻页」，与接线前一致，不影响关闭/删除/幻灯片等既有能力。
 */

/** 触发一次翻页所需的默认累计位移（px） */
export const DEFAULT_WHEEL_THRESHOLD = 60
/** 默认冷却窗口（ms）：吸收触控板惯性，一次甩动只翻一张 */
export const DEFAULT_WHEEL_COOLDOWN_MS = 220

export interface UseWheelPageNavOptions {
  /** 是否启用（全屏打开时为 true）。false 时不绑定、不响应 */
  enabled: boolean
  /** 绑定原生 wheel 监听的目标元素引用；current 为空时静默不绑定 */
  target: RefObject<HTMLElement | null>
  /** 向上/向左滚动越阈值时触发 */
  onPrev: () => void
  /** 向下/向右滚动越阈值时触发 */
  onNext: () => void
  /** 触发阈值，非法值（非有限数 / ≤ 0）回落 {@link DEFAULT_WHEEL_THRESHOLD} */
  threshold?: number
  /** 冷却窗口，非法值（非有限数 / < 0）回落 {@link DEFAULT_WHEEL_COOLDOWN_MS} */
  cooldownMs?: number
  /**
   * 放行选择器（缺陷1 审查修复）：事件目标为该选择器所命中元素的后代时，整条手势
   * 放行——不 preventDefault、不累计位移、不翻页，使该区域按浏览器默认行为自行
   * 处理滚轮（如 EXIF 信息浮层的自身滚动）。判定无状态、每次事件即时求值，
   * 目标元素重挂载后依然成立。仅非空字符串启用；缺省时行为与本政策引入前一致。
   */
  ignoreSelector?: string
}

/** 数值归一化：仅接受合法正数，其余回落默认，避免 NaN/0/负数让阈值形同虚设 */
function normalizePositive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** 数值归一化：仅接受非负有限数 */
function normalizeNonNegative(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

export function useWheelPageNav({
  enabled,
  target,
  onPrev,
  onNext,
  threshold,
  cooldownMs,
  ignoreSelector
}: UseWheelPageNavOptions): void {
  /** 累计位移（同一滚动段落内累加） */
  const accumulatedRef = useRef(0)
  /** 上一次 wheel 事件的时间戳，用于判定「是否开始了一个新段落」 */
  const lastEventRef = useRef(0)
  /** 上一次触发翻页的时间戳，用于冷却判定。
   *  F2 审查修复：初值必须是「从未触发」（-Infinity）。若为 0，语义上等于
   *  「在 t=0 已触发过一次」，timeStamp 小于冷却窗口的首事件会被误吞。 */
  const lastTriggerRef = useRef(Number.NEGATIVE_INFINITY)

  const thresholdValue = normalizePositive(threshold, DEFAULT_WHEEL_THRESHOLD)
  const cooldownValue = normalizeNonNegative(cooldownMs, DEFAULT_WHEEL_COOLDOWN_MS)

  useWheel(
    (state) => {
      if (!enabled) return
      const event = state.event
      try {
        // 缺陷1 审查修复：放行判定须早于 ctrlKey 分支与 preventDefault——命中放行
        // 选择器的区域（如 EXIF 信息浮层）按浏览器默认行为自行处理滚轮。选择器
        // 非法时 closest 抛错被下方 catch 吞掉，同样不会误阻止默认滚动。
        if (ignoreSelector) {
          const origin = event.target
          if (origin instanceof Element && origin.closest(ignoreSelector)) return
        }
        // 触控板捏合缩放（ctrlKey）必须交还系统，不得劫持也不得翻页
        if (event.ctrlKey) return
        // passive:false 已由 eventOptions 保证，此处阻止背景滚动
        event.preventDefault()

        const now = event.timeStamp
        // 距上一次事件已超过冷却窗口 → 视为一次全新的滚动段落，复位累加器
        if (now - lastEventRef.current > cooldownValue) {
          accumulatedRef.current = 0
        }
        lastEventRef.current = now
        // 仍在冷却窗口内：丢弃本次位移（吸收惯性）
        if (now - lastTriggerRef.current < cooldownValue) {
          accumulatedRef.current = 0
          return
        }

        const deltaX = event.deltaX ?? 0
        const deltaY = event.deltaY ?? 0
        const delta = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY
        accumulatedRef.current += delta
        if (Math.abs(accumulatedRef.current) < thresholdValue) return

        const forward = accumulatedRef.current > 0
        accumulatedRef.current = 0
        lastTriggerRef.current = now
        if (forward) {
          if (typeof onNext === 'function') onNext()
        } else if (typeof onPrev === 'function') {
          onPrev()
        }
      } catch {
        // 静默降级：手势解析异常不得冒泡到 React 渲染树
      }
    },
    { target, eventOptions: { passive: false }, enabled }
  )
}
