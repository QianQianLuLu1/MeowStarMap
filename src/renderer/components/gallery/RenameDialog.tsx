import React, { useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { BaseDialog } from '../common/BaseDialog'
import type { MediaFile } from '../../stores/mediaStore'

interface RenameDialogProps {
  file: MediaFile | null
  newName: string
  onNewNameChange: (name: string) => void
  onConfirm: () => void
  onCancel: () => void
}

const INVALID_CHARS = /[\\/:*?"<>|]/

/**
 * P1-U2：迁移到 BaseDialog，移除手写的 useFocusTrap / 遮罩 / modal-enter 模板
 * 通过 initialFocusRef 保留原"打开即聚焦输入框"行为
 */
export const RenameDialog: React.FC<RenameDialogProps> = ({
  file,
  newName,
  onNewNameChange,
  onConfirm,
  onCancel
}) => {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const open = !!file

  const error = useMemo(() => {
    if (!newName.trim()) return t('gallery.renameDialog.emptyError')
    if (INVALID_CHARS.test(newName)) return t('gallery.renameDialog.invalidCharsError')
    return ''
  }, [newName, t])

  const handleConfirm = () => {
    if (error) return
    onConfirm()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !error) {
      handleConfirm()
    }
  }

  return (
    <BaseDialog
      open={open}
      onClose={onCancel}
      ariaLabelledby="rename-title"
      size="sm"
      initialFocusRef={inputRef}
    >
      <h3
        id="rename-title"
        className="text-lg font-semibold"
        style={{ color: 'var(--text-primary)' }}
      >
        {t('gallery.renameDialog.title')}
      </h3>
      <div className="space-y-2">
        <input
          ref={inputRef}
          type="text"
          value={newName}
          onChange={(e) => onNewNameChange(e.target.value)}
          className="w-full px-3 py-2 rounded-lg text-sm"
          style={{
            background: 'var(--bg-tertiary)',
            color: 'var(--text-primary)',
            border: `1px solid ${error ? 'var(--danger)' : 'var(--divider)'}`
          }}
          onKeyDown={handleKeyDown}
          aria-invalid={!!error}
          aria-describedby="rename-error"
        />
        {error && (
          <p id="rename-error" className="text-xs" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <button className="btn-secondary" onClick={onCancel}>
          {t('gallery.renameDialog.cancel')}
        </button>
        <button className="btn-primary" onClick={handleConfirm} disabled={!!error}>
          {t('gallery.renameDialog.confirm')}
        </button>
      </div>
    </BaseDialog>
  )
}
