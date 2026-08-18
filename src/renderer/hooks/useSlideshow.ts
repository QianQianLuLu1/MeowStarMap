import { useState, useCallback, useRef, useEffect } from 'react'

/**
 * DU3：幻灯片播放共享逻辑（从 FullscreenViewer 和 SlideshowPlayer 中提取）。
 *
 * 负责：isPlaying 状态、interval 计时器生命周期、卸载清理。
 * 调用方负责：onTick 内的"下一张"逻辑、是否循环或停止（调用 stop()）。
 */
export interface UseSlideshowOptions {
  /** 播放间隔（毫秒） */
  interval: number
  /** 每次间隔触发的回调（通常为"切换到下一张"） */
  onTick: () => void
}

export interface UseSlideshowReturn {
  isPlaying: boolean
  /** 开始播放（会先停止已有计时器） */
  start: () => void
  /** 停止播放并清理计时器 */
  stop: () => void
  /** 切换播放/暂停 */
  toggle: () => void
}

export function useSlideshow({ interval, onTick }: UseSlideshowOptions): UseSlideshowReturn {
  const [isPlaying, setIsPlaying] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // 用 ref 持有最新的 onTick，避免 effect 频繁重建 interval
  const onTickRef = useRef(onTick)
  useEffect(() => {
    onTickRef.current = onTick
  }, [onTick])

  const stop = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    setIsPlaying(false)
  }, [])

  const start = useCallback(() => {
    // 先清理已有计时器，避免叠加
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    setIsPlaying(true)
    timerRef.current = setInterval(() => onTickRef.current(), interval)
  }, [interval])

  const toggle = useCallback(() => {
    if (isPlaying) {
      stop()
    } else {
      start()
    }
  }, [isPlaying, start, stop])

  // interval 变化时，如正在播放则重启计时器
  useEffect(() => {
    if (isPlaying && timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = setInterval(() => onTickRef.current(), interval)
    }
  }, [interval, isPlaying])

  // 卸载时清理计时器
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  return { isPlaying, start, stop, toggle }
}
