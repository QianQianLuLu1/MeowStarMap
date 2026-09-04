import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IconClose } from '../../icons'
import { BaseDialog } from './BaseDialog'

/**
 * P2-5：错误反馈对话框
 * 用户可在此填写错误描述、选择是否附带日志/系统信息，并一键导出诊断包
 * 同时提供 QQ 群和 GitHub Issues 等联系方式
 */
interface FeedbackDialogProps {
  open: boolean
  onClose: () => void
}

export const FeedbackDialog: React.FC<FeedbackDialogProps> = ({ open, onClose }) => {
  const { t } = useTranslation()
  const [description, setDescription] = useState('')
  const [attachLogs, setAttachLogs] = useState(true)
  const [attachSystemInfo, setAttachSystemInfo] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [exportResult, setExportResult] = useState<{ success: boolean; message: string } | null>(
    null
  )

  // 导出诊断包
  const handleExportDiagnostic = async () => {
    setExporting(true)
    setExportResult(null)
    try {
      // 通过 IPC 调用主进程导出诊断包
      // 主进程会弹出保存对话框让用户选择保存位置
      const result = await window.electronAPI?.log?.exportZip?.()
      if (result?.success) {
        setExportResult({ success: true, message: t('common.feedbackDialog.exportSuccess') })
      } else if (result?.canceled) {
        // 用户取消保存对话框，不显示错误
        setExportResult(null)
      } else {
        setExportResult({
          success: false,
          message: result?.message || t('common.feedbackDialog.exportFailed')
        })
      }
    } catch (err) {
      setExportResult({ success: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setExporting(false)
    }
  }

  // 复制联系方式
  const handleCopyContact = (text: string, label: string) => {
    try {
      navigator.clipboard.writeText(text)
      setExportResult({ success: true, message: t('common.feedbackDialog.copySuccess', { label }) })
    } catch {
      setExportResult({ success: false, message: t('common.feedbackDialog.copyFailed') })
    }
  }

  return (
    <BaseDialog
      open={open}
      onClose={onClose}
      size="lg"
      ariaLabelledby="feedback-title"
      cardClassName="max-h-[85vh] overflow-y-auto"
    >
      <div className="flex items-center justify-between">
        <h3
          id="feedback-title"
          className="text-lg font-semibold"
          style={{ color: 'var(--text-primary)' }}
        >
          {t('common.feedbackDialog.title')}
        </h3>
        <button
          className="icon-btn"
          onClick={onClose}
          aria-label={t('common.feedbackDialog.closeAriaLabel')}
          style={{ color: 'var(--text-tertiary)' }}
        >
          <IconClose size={18} />
        </button>
      </div>

      {/* 错误描述输入框 */}
      <div className="space-y-2">
        <label className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          {t('common.feedbackDialog.descriptionLabel')}
        </label>
        <textarea
          className="w-full p-3 rounded-lg text-sm resize-none"
          style={{
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--divider)',
            color: 'var(--text-primary)',
            minHeight: '100px'
          }}
          placeholder={t('common.feedbackDialog.descriptionPlaceholder')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={500}
        />
        <div className="text-xs text-right" style={{ color: 'var(--text-tertiary)' }}>
          {description.length}/500
        </div>
      </div>

      {/* 附件选项 */}
      <div className="space-y-2">
        <label className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          {t('common.feedbackDialog.attachmentsLabel')}
        </label>
        <label
          className="flex items-center gap-2 text-sm cursor-pointer"
          style={{ color: 'var(--text-secondary)' }}
        >
          <input
            type="checkbox"
            checked={attachLogs}
            onChange={(e) => setAttachLogs(e.target.checked)}
            style={{ accentColor: 'var(--accent)' }}
          />
          {t('common.feedbackDialog.attachLogsLabel')}
        </label>
        <label
          className="flex items-center gap-2 text-sm cursor-pointer"
          style={{ color: 'var(--text-secondary)' }}
        >
          <input
            type="checkbox"
            checked={attachSystemInfo}
            onChange={(e) => setAttachSystemInfo(e.target.checked)}
            style={{ accentColor: 'var(--accent)' }}
          />
          {t('common.feedbackDialog.attachSystemInfoLabel')}
        </label>
      </div>

      {/* 导出诊断包按钮 */}
      <div className="space-y-2">
        <button
          className="w-full px-4 py-2.5 rounded-lg text-sm font-medium transition-all"
          style={{
            background: 'var(--accent)',
            color: 'var(--text-on-accent)',
            opacity: exporting ? 0.6 : 1,
            cursor: exporting ? 'not-allowed' : 'pointer'
          }}
          onClick={handleExportDiagnostic}
          disabled={exporting}
        >
          {exporting
            ? t('common.feedbackDialog.exporting')
            : t('common.feedbackDialog.exportButton')}
        </button>
        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          {t('common.feedbackDialog.exportHint')}
        </p>
        {exportResult && (
          <div
            className="text-xs p-2 rounded"
            style={{
              background: exportResult.success ? 'rgba(34, 197, 94, 0.1)' : 'var(--danger-bg)',
              color: exportResult.success ? 'var(--success-deep)' : 'var(--danger-hover)'
            }}
          >
            {exportResult.message}
          </div>
        )}
      </div>

      {/* 联系方式 */}
      <div className="space-y-2 pt-2" style={{ borderTop: '1px solid var(--divider)' }}>
        <label className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          {t('common.feedbackDialog.contactLabel')}
        </label>
        <div className="grid grid-cols-2 gap-2">
          <button
            className="p-3 rounded-lg text-left text-sm transition-all hover:scale-[1.02]"
            style={{
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--divider)'
            }}
            onClick={() =>
              handleCopyContact(
                t('common.feedbackDialog.qqGroupValue'),
                t('common.feedbackDialog.qqGroupName')
              )
            }
          >
            <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
              {t('common.feedbackDialog.qqGroupLabel')}
            </div>
            <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('common.feedbackDialog.qqGroupCopyHint')}
            </div>
          </button>
          <button
            className="p-3 rounded-lg text-left text-sm transition-all hover:scale-[1.02]"
            style={{
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--divider)'
            }}
            onClick={() =>
              handleCopyContact(
                t('common.feedbackDialog.githubValue'),
                t('common.feedbackDialog.githubName')
              )
            }
          >
            <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
              {t('common.feedbackDialog.githubLabel')}
            </div>
            <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('common.feedbackDialog.githubCopyHint')}
            </div>
          </button>
        </div>
      </div>
    </BaseDialog>
  )
}
