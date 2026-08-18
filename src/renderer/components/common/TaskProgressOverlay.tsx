import React from 'react'
import { useTranslation } from 'react-i18next'
import { Spinner } from './Spinner'
import { formatEta } from '../../utils/format'
import type { TaskProgress } from '../../../shared/types/progress'

/**
 * 通用任务进度浮窗
 *
 * 性能重构 v3 改造项三 §4.6：
 *   - 复用现有 .progress-bar / .progress-bar-fill CSS 类
 *   - 复用 Spinner 组件
 *   - 复用 glass-card 毛玻璃样式
 *   - 与 ScanProgress/DuplicatesPage/WatermarkDialog/BatchApplyDialog 共享 UI 规范
 *
 * 设计原则：
 *   - 纯展示组件，不订阅任何 IPC 通道；父组件负责传入 progress 与 onCancel
 *   - progress=null 时直接返回 null，便于父组件无脑渲染
 *   - 取消按钮仅在 canCancel=true 且 onCancel 提供时显示
 *   - 终态（done/cancelled/error）隐藏 Spinner，避免动画结束后仍在旋转
 *
 * 使用示例：
 *   <TaskProgressOverlay
 *     progress={taskProgress}
 *     onCancel={() => window.electronAPI.task.cancel(taskProgress.taskId)}
 *   >
 *     <p className="text-xs">{currentPath}</p>  // 可选子内容
 *   </TaskProgressOverlay>
 */
interface TaskProgressOverlayProps {
  /** 任务进度，null 时浮窗不渲染 */
  progress: TaskProgress | null
  /** 取消回调；不提供则不显示取消按钮（即便 canCancel=true） */
  onCancel?: () => void
  /** 自定义标题，默认使用 progress.message */
  title?: string
  /** 浮窗位置，默认右下角 */
  position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'
  /** 额外内容（如当前扫描路径），渲染在进度条下方 */
  children?: React.ReactNode
}

const POSITION_CLASS: Record<NonNullable<TaskProgressOverlayProps['position']>, string> = {
  'bottom-right': 'right-6',
  'bottom-left': 'left-6',
  'top-right': 'right-6 top-6',
  'top-left': 'left-6 top-6'
}

const PHASE_KEY: Record<TaskProgress['phase'], string> = {
  preparing: 'taskProgress.phase.preparing',
  processing: 'taskProgress.phase.processing',
  finalizing: 'taskProgress.phase.finalizing',
  done: 'taskProgress.phase.done',
  cancelled: 'taskProgress.phase.cancelled',
  error: 'taskProgress.phase.error'
}

const TERMINAL_PHASES: ReadonlySet<TaskProgress['phase']> = new Set(['done', 'cancelled', 'error'])

export const TaskProgressOverlay: React.FC<TaskProgressOverlayProps> = ({
  progress,
  onCancel,
  title,
  position = 'bottom-right',
  children
}) => {
  const { t } = useTranslation()
  if (!progress) return null

  const isTerminal = TERMINAL_PHASES.has(progress.phase)
  const showSpinner = !isTerminal
  const showCancel = progress.canCancel && Boolean(onCancel) && !isTerminal
  const showEta = !isTerminal && progress.total > 0
  const headline = title ?? progress.message ?? t(PHASE_KEY[progress.phase])
  const percent = Math.min(100, Math.max(0, progress.percent))

  return (
    <div
      className={`fixed glass-card p-4 w-80 z-50 ${POSITION_CLASS[position]}`}
      style={{
        bottom: position.startsWith('bottom') ? '44px' : undefined,
        animation: 'slideInBottom 300ms ease-out'
      }}
      role="status"
      aria-live="polite"
    >
      {/* 标题行：Spinner + 文案 + 取消按钮 */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {showSpinner && <Spinner size="sm" color="var(--accent)" />}
          <span
            className="text-sm font-medium truncate"
            style={{ color: 'var(--text-primary)' }}
            title={headline}
          >
            {headline}
          </span>
        </div>
        {showCancel && (
          <button
            className="p-1 rounded hover:bg-black/10 transition-colors flex-shrink-0"
            onClick={onCancel}
            title={t('taskProgress.cancel')}
            aria-label={t('taskProgress.cancel')}
            style={{ color: 'var(--text-tertiary)' }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path
                d="M2 2L12 12M12 2L2 12"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
      </div>

      {/* 进度条 */}
      <div className="progress-bar mb-2">
        <div
          className="progress-bar-fill"
          style={{
            width: `${percent}%`,
            transition: 'width 300ms ease-out'
          }}
        />
      </div>

      {/* 底部行：current/total + ETA */}
      <div className="flex justify-between text-xs" style={{ color: 'var(--text-tertiary)' }}>
        <span>
          {progress.current} / {progress.total}
        </span>
        <span>
          {showEta
            ? progress.etaMs && progress.etaMs > 0
              ? t('taskProgress.remaining', { time: formatEta(progress.etaMs) })
              : t('taskProgress.calculating')
            : isTerminal
              ? t(PHASE_KEY[progress.phase])
              : ''}
        </span>
      </div>

      {/* 父组件可注入额外内容（如当前扫描路径） */}
      {children}
    </div>
  )
}
