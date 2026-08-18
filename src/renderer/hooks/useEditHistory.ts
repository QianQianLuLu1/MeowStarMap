import { useState, useRef, useCallback, useEffect } from 'react'
import type { FilterParams, FilterPreset, WatermarkConfig } from '../utils/imageProcessor'

// P1-C1：历史栈上限常量化，消除 pushHistory 中的魔法数字 50/49
const HISTORY_MAX_SIZE = 50

export interface AdjustmentState {
  params: FilterParams
  filter: FilterPreset | null
  filterIntensity: number
  watermark: WatermarkConfig | null
}

export function useEditHistory(
  initialState: AdjustmentState,
  applyState: (state: AdjustmentState) => void
) {
  const [history, setHistory] = useState<AdjustmentState[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const historyIndexRef = useRef(historyIndex)
  const initializedRef = useRef(false)

  // 修复 U-S6：historyIndexRef 改为同步更新，不再依赖 useEffect（render 后执行）。
  // 原实现在同一 render 周期内连续调用多次 pushHistory 时，ref 还是旧值，
  // 导致 slice(0, historyIndexRef.current + 1) 错误截断历史栈。
  // 现在在每次 setHistoryIndex 调用处同步更新 ref。

  // 初始化历史记录
  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true
      setHistory([JSON.parse(JSON.stringify(initialState))])
      setHistoryIndex(0)
      historyIndexRef.current = 0
    }
  }, [initialState])

  const pushHistory = useCallback((state: AdjustmentState) => {
    const currentIndex = historyIndexRef.current
    // P1-C1：预计算 shift 场景，明确处理索引前移
    // push 后 trimmed.length = currentIndex + 2；若超过上限则 shift，新 state 索引固定为 HISTORY_MAX_SIZE - 1
    // 否则新 state 索引为 currentIndex + 1
    // 原实现 Math.min(currentIndex + 1, 49) 依赖魔法数字 49，且未明确表达 shift 语义
    const willShift = currentIndex + 2 > HISTORY_MAX_SIZE
    const nextIndex = willShift ? HISTORY_MAX_SIZE - 1 : currentIndex + 1
    setHistory((prev) => {
      const trimmed = prev.slice(0, currentIndex + 1)
      trimmed.push(JSON.parse(JSON.stringify(state)))
      // 限制历史记录上限
      if (trimmed.length > HISTORY_MAX_SIZE) {
        trimmed.shift()
      }
      return trimmed
    })
    // 同步更新 ref，避免同一 render 周期内连续 pushHistory 读取到旧值
    historyIndexRef.current = nextIndex
    setHistoryIndex(nextIndex)
  }, [])

  const undo = useCallback(() => {
    const currentIndex = historyIndexRef.current
    if (currentIndex > 0) {
      applyState(history[currentIndex - 1])
      const nextIndex = currentIndex - 1
      historyIndexRef.current = nextIndex
      setHistoryIndex(nextIndex)
    }
  }, [history, applyState])

  const redo = useCallback(() => {
    const currentIndex = historyIndexRef.current
    if (currentIndex < history.length - 1) {
      applyState(history[currentIndex + 1])
      const nextIndex = currentIndex + 1
      historyIndexRef.current = nextIndex
      setHistoryIndex(nextIndex)
    }
  }, [history, applyState])

  return {
    history,
    historyIndex,
    pushHistory,
    undo,
    redo,
    canUndo: historyIndex > 0,
    canRedo: historyIndex < history.length - 1
  }
}
