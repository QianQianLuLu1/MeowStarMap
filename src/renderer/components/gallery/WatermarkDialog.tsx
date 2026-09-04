import React from 'react'
import { useTranslation } from 'react-i18next'
import { BaseDialog } from '../common/BaseDialog'
import { WatermarkPanel } from '../editor/WatermarkPanel'
import { IconClose } from '../../icons'
import type { WatermarkConfig } from '../../utils/imageProcessor'
import { formatEta } from '../../utils/format'

// 性能重构 v3 改造项三：扩展进度类型，新增 ETA + taskId（用于取消）
export interface WatermarkProgressState {
  current: number
  total: number
  /** 剩余时间（毫秒），由主进程 EtaCalculator 估算 */
  etaMs?: number
  /** 吞吐量（条目/秒） */
  processedPerSec?: number
  /** 当前任务 ID（用于调用 task:cancel） */
  taskId?: string
}

interface WatermarkDialogProps {
  open: boolean
  config: WatermarkConfig | null
  onChange: (config: WatermarkConfig | null) => void
  progress: WatermarkProgressState | null
  processing: boolean
  onConfirm: () => void
  onCancel: () => void
  /** 性能重构 v3 改造项三：取消当前水印任务（仅在 processing 时可用） */
  onCancelTask?: () => void
}

/**
 * P1-U2：迁移到 BaseDialog，移除手写的 useFocusTrap / 遮罩 / modal-enter 模板
 * 保留 processing 时禁用焦点陷阱与遮罩关闭的原行为
 *
 * 性能重构 v3 改造项三：新增 ETA 显示 + 取消按钮
 */
export const WatermarkDialog: React.FC<WatermarkDialogProps> = ({
  open,
  config,
  onChange,
  progress,
  processing,
  onConfirm,
  onCancel,
  onCancelTask
}) => {
  const { t } = useTranslation()
  const percent =
    progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0

  return (
    <BaseDialog
      open={open}
      onClose={onCancel}
      ariaLabelledby="watermark-dialog-title"
      size="lg"
      cardClassName="max-h-[85vh] overflow-y-auto"
      overlayBackground="var(--overlay-bg-strong)"
      trapFocus={!processing}
      closeOnOverlayClick={!processing}
    >
      <div className="flex items-center justify-between">
        <h3
          id="watermark-dialog-title"
          className="text-lg font-semibold"
          style={{ color: 'var(--text-primary)' }}
        >
          {t('gallery.watermarkDialog.title')}
        </h3>
        <button
          className="icon-btn"
          onClick={onCancel}
          disabled={processing}
          aria-label={t('gallery.watermarkDialog.closeAria')}
        >
          <IconClose size={16} />
        </button>
      </div>
      <WatermarkPanel config={config} onChange={onChange} />
      {progress && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs" style={{ color: 'var(--text-secondary)' }}>
            <span>{t('gallery.watermarkDialog.processingHint')}</span>
            <span>
              {progress.current} / {progress.total}
              {progress.processedPerSec ? ` · ${progress.processedPerSec.toFixed(1)}/s` : ''}
            </span>
          </div>
          <div
            className="h-2 rounded-full overflow-hidden"
            style={{ background: 'var(--bg-tertiary)' }}
          >
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${percent}%`,
                background: 'var(--accent)'
              }}
            />
          </div>
          {/* 性能重构 v3 改造项三：剩余时间估算 */}
          <div className="flex justify-between text-xs" style={{ color: 'var(--text-tertiary)' }}>
            <span>{percent}%</span>
            <span>
              {progress.etaMs && progress.etaMs > 0
                ? t('gallery.watermarkDialog.remaining', { time: formatEta(progress.etaMs) })
                : processing
                  ? t('gallery.watermarkDialog.computing')
                  : ''}
            </span>
          </div>
        </div>
      )}
      <div className="flex justify-end gap-2 pt-2">
        <button className="btn-secondary" onClick={onCancel} disabled={processing}>
          {t('gallery.watermarkDialog.cancel')}
        </button>
        {/* 性能重构 v3 改造项三：处理中显示「取消任务」按钮（区别于关闭对话框的「取消」） */}
        {processing && onCancelTask && (
          <button
            className="btn-secondary"
            onClick={onCancelTask}
            style={{ color: 'var(--danger)' }}
          >
            {t('gallery.watermarkDialog.cancelTask')}
          </button>
        )}
        <button className="btn-primary" onClick={onConfirm} disabled={processing || !config}>
          {processing
            ? t('gallery.watermarkDialog.processing')
            : t('gallery.watermarkDialog.startAdd')}
        </button>
      </div>
    </BaseDialog>
  )
}
