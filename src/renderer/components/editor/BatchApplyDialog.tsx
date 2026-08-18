import React, { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { formatEta } from '../../utils/format'
import { BaseDialog } from '../common/BaseDialog'

export interface BatchApplyProgress {
  current: number
  total: number
  currentFileName: string
  failedCount: number
  /** 性能重构 v3 改造项三：剩余时间（毫秒），由渲染进程本地 EtaCalculator 估算 */
  etaMs?: number
  /** 性能重构 v3 改造项三：吞吐量（条目/秒） */
  processedPerSec?: number
}

interface BatchApplyDialogProps {
  open: boolean
  progress: BatchApplyProgress | null
  done: boolean
  message: string
  onClose: () => void
  /** 性能重构 v3 改造项三：取消当前批量应用任务（仅在 !done 时可用） */
  onCancel?: () => void
}

export const BatchApplyDialog: React.FC<BatchApplyDialogProps> = ({
  open,
  progress,
  done,
  message,
  onClose,
  onCancel
}) => {
  const { t } = useTranslation()
  const closeBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (done) {
      // 完成后自动聚焦关闭按钮，便于键盘用户操作
      closeBtnRef.current?.focus()
    }
  }, [done])

  const current = progress?.current ?? 0
  const total = progress?.total ?? 0
  const percent = total > 0 ? Math.round((current / total) * 100) : 0
  const failedCount = progress?.failedCount ?? 0

  return (
    <BaseDialog
      open={open}
      onClose={onClose}
      ariaLabelledby="batch-apply-title"
      closeOnOverlayClick={false}
      size="md"
    >
      <div className="flex items-center justify-between">
        <h3
          id="batch-apply-title"
          className="text-lg font-semibold"
          style={{ color: 'var(--text-primary)' }}
        >
          {t('editor.batchApply.title')}
        </h3>
        {/* 性能重构 v3 改造项三：处理中显示取消按钮 */}
        {!done && onCancel && (
          <button
            className="icon-btn"
            onClick={onCancel}
            aria-label={t('editor.batchApply.cancelAria')}
            title={t('editor.batchApply.cancelAria')}
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

      {!done && (
        <>
          <div className="space-y-2">
            <div
              className="flex items-center justify-between text-sm"
              style={{ color: 'var(--text-secondary)' }}
            >
              <span>
                {t('editor.batchApply.processingLabel', { current, total })}
                {progress?.processedPerSec
                  ? t('editor.batchApply.throughputSuffix', {
                      n: progress.processedPerSec.toFixed(1)
                    })
                  : ''}
              </span>
              <span style={{ color: 'var(--accent)' }}>{percent}%</span>
            </div>
            <div
              className="w-full h-2 rounded-full overflow-hidden"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              <div
                className="h-full transition-all duration-200"
                style={{ width: `${percent}%`, background: 'var(--accent)' }}
              />
            </div>
            <p
              className="text-xs truncate"
              style={{ color: 'var(--text-tertiary)' }}
              title={progress?.currentFileName}
            >
              {progress?.currentFileName || t('editor.batchApply.preparing')}
            </p>
            {/* 性能重构 v3 改造项三：剩余时间估算 */}
            <div className="flex justify-between text-xs" style={{ color: 'var(--text-tertiary)' }}>
              <span />
              <span>
                {progress?.etaMs && progress.etaMs > 0
                  ? t('editor.batchApply.remainingLabel', {
                      time: formatEta(progress.etaMs)
                    })
                  : t('editor.batchApply.calculating')}
              </span>
            </div>
            {failedCount > 0 && (
              <p className="text-xs" style={{ color: 'var(--danger)' }}>
                {t('editor.batchApply.failedCount', { count: failedCount })}
              </p>
            )}
          </div>
          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            {t('editor.batchApply.processingHint')}
          </p>
          {/* 性能重构 v3 改造项三：取消按钮（底部，与关闭按钮区分） */}
          {!done && onCancel && (
            <div className="flex justify-end pt-1">
              <button
                className="btn-secondary"
                onClick={onCancel}
                style={{ color: 'var(--danger)' }}
              >
                {t('editor.batchApply.cancelAria')}
              </button>
            </div>
          )}
        </>
      )}

      {done && (
        <>
          <p className="text-sm whitespace-pre-line" style={{ color: 'var(--text-secondary)' }}>
            {message}
          </p>
          <div className="flex justify-end pt-2">
            <button ref={closeBtnRef} className="btn-primary" onClick={onClose}>
              {t('common.close')}
            </button>
          </div>
        </>
      )}
    </BaseDialog>
  )
}
