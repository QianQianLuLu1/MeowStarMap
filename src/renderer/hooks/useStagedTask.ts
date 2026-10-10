import { useCallback, useEffect, useRef, useState } from 'react'
import type { TaskProgress, TaskStageStatus, TaskType } from '../../shared/types/progress'
import { clampPercent, createStages, setStageStatus } from '../../shared/utils/taskStages'

/** 执行期可调用接口：驱动阶段状态与条目进度，并携带取消信号 */
export interface StageApi {
  /** 将第 index 个阶段置为指定状态（默认 active），可附带 detail */
  setStage: (index: number, status?: TaskStageStatus, detail?: string) => void
  /** 上报已处理条目数（可选 total / message），内部节流推送 */
  tick: (current: number, total?: number, message?: string) => void
  /** 取消信号；execute 应定期检查并在中止时抛出 AbortError 以优雅中断 */
  signal: AbortSignal
}

export interface RunStagedOptions {
  taskType: TaskType
  title: string
  /** 阶段文案（非空；空数组会抛错以进行参数校验） */
  stageLabels: string[]
  canCancel?: boolean
  /** 总条目数（未知可省略，进度条按 tick 的 total 动态更新） */
  total?: number
  execute: (api: StageApi) => Promise<void>
}

const THROTTLE_MS = 80

/** 终态（done/cancelled/error）卡片保留时长，超时自动复位关闭浮窗；对齐 useToast 默认 3s */
const AUTO_RESET_DELAY_MS = 3000

function completeStages(prev: TaskProgress): TaskProgress {
  return {
    ...prev,
    phase: 'done',
    percent: 100,
    current: prev.total,
    stages: prev.stages?.map((s) => ({ ...s, status: 'done' as const }))
  }
}

function terminateStages(prev: TaskProgress, aborted: boolean, message?: string): TaskProgress {
  return {
    ...prev,
    phase: aborted ? 'cancelled' : 'error',
    canCancel: false,
    message: aborted ? prev.message : (message ?? prev.message),
    stages: prev.stages?.map((s) =>
      s.status === 'active'
        ? {
            ...s,
            status: (aborted ? 'pending' : 'failed') as TaskStageStatus,
            detail: aborted ? s.detail : (message ?? s.detail)
          }
        : s
    )
  }
}

/**
 * 删除 / 批量任务的「阶段步骤」进度编排器（渲染端）。
 *
 * 复用 TaskProgress 协议与 stages 字段，将任意异步删除操作包装为带阶段步骤、
 * 可取消、节流推送的进度状态。纯渲染端逻辑，不依赖主进程 IPC（取消走本地 AbortController）。
 * run() 返回终态 progress，便于调用方据 phase 弹 toast。
 * 进入终态后延时 AUTO_RESET_DELAY_MS 自动复位（progress 置 null），驱动
 * TaskProgressOverlay 播放退场动画并关闭浮窗。
 */
export function useStagedTask() {
  const [progress, setProgress] = useState<TaskProgress | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const latestRef = useRef<TaskProgress | null>(null)
  const lastTickRef = useRef(0)
  const totalRef = useRef(0)
  const autoResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const commit = useCallback((updater: (prev: TaskProgress | null) => TaskProgress | null) => {
    // 同步计算 next 并维护 latestRef，避免 React 延迟执行 updater 导致终态读取到旧值
    const next = updater(latestRef.current)
    latestRef.current = next
    setProgress(next)
  }, [])

  const clearAutoReset = useCallback(() => {
    if (autoResetRef.current !== null) {
      clearTimeout(autoResetRef.current)
      autoResetRef.current = null
    }
  }, [])

  const reset = useCallback(() => {
    clearAutoReset()
    abortRef.current = null
    latestRef.current = null
    setProgress(null)
  }, [clearAutoReset])

  const scheduleAutoReset = useCallback(() => {
    autoResetRef.current = setTimeout(reset, AUTO_RESET_DELAY_MS)
  }, [reset])

  // 卸载时清除待触发的自动复位定时器，避免卸载后 setState
  useEffect(() => clearAutoReset, [clearAutoReset])

  const run = useCallback(
    async (opts: RunStagedOptions): Promise<TaskProgress | null> => {
      const controller = new AbortController()
      abortRef.current = controller
      // 新任务开始前清除上一任务的自动复位定时器，防止误清新进度
      clearAutoReset()
      const taskId = `${opts.taskType}-${Date.now()}`
      // 参数校验：阶段文案必须非空
      const stages = createStages(opts.stageLabels)
      totalRef.current = opts.total ?? 0
      lastTickRef.current = 0
      commit(() => ({
        taskId,
        taskType: opts.taskType,
        phase: 'preparing',
        current: 0,
        total: totalRef.current,
        percent: 0,
        startedAt: Date.now(),
        canCancel: Boolean(opts.canCancel),
        stages,
        message: opts.title
      }))

      const setStage: StageApi['setStage'] = (index, status = 'active', detail) => {
        commit((prev) =>
          prev && prev.stages
            ? { ...prev, stages: setStageStatus(prev.stages, index, status, detail) }
            : prev
        )
      }
      const tick: StageApi['tick'] = (current, total, message) => {
        const now = Date.now()
        const target = total ?? totalRef.current
        const isFinal = target > 0 && current >= target
        if (!isFinal && now - lastTickRef.current < THROTTLE_MS) return
        lastTickRef.current = now
        if (total !== undefined) totalRef.current = total
        commit((prev) =>
          prev
            ? {
                ...prev,
                current,
                total: target,
                percent:
                  target > 0 ? clampPercent(Math.round((current / target) * 100)) : prev.percent,
                message: message ?? prev.message
              }
            : prev
        )
      }

      try {
        await opts.execute({ setStage, tick, signal: controller.signal })
        const final = completeStages(latestRef.current!)
        commit(() => final)
        scheduleAutoReset()
        return final
      } catch (err) {
        const aborted =
          controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')
        const message = err instanceof Error ? err.message : String(err)
        const final = terminateStages(latestRef.current!, aborted, message)
        commit(() => final)
        scheduleAutoReset()
        return final
      }
    },
    [commit, clearAutoReset, scheduleAutoReset]
  )

  const cancel = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  return { progress, run, cancel, reset }
}
