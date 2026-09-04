import React from 'react'
import { useTranslation } from 'react-i18next'
import { BaseDialog } from '../common/BaseDialog'

interface ShortcutsModalProps {
  onClose: () => void
}

// 按键名称不翻译，仅描述走 i18n
const shortcuts: { key: string; descKey: string }[] = [
  { key: 'F11', descKey: 'editor.shortcuts.desc.fullscreenToggle' },
  { key: 'Ctrl + S', descKey: 'editor.shortcuts.desc.save' },
  { key: 'Ctrl + Shift + S', descKey: 'editor.shortcuts.desc.saveAs' },
  { key: 'Ctrl + Shift + C', descKey: 'editor.shortcuts.desc.copyParams' },
  { key: 'Ctrl + Shift + V', descKey: 'editor.shortcuts.desc.pasteParams' },
  { key: 'Ctrl + Z', descKey: 'editor.shortcuts.desc.undo' },
  { key: 'Ctrl + Shift + Z / Ctrl + Y', descKey: 'editor.shortcuts.desc.redo' },
  { key: '?', descKey: 'editor.shortcuts.desc.togglePanel' },
  { key: 'Space / Mouse Hold', descKey: 'editor.shortcuts.desc.compareOriginal' }
]

export const ShortcutsModal: React.FC<ShortcutsModalProps> = ({ onClose }) => {
  const { t } = useTranslation()
  return (
    <BaseDialog
      open={true}
      onClose={onClose}
      title={t('editor.shortcuts.title')}
      size="md"
      overlayClassName="p-4"
    >
      <div className="space-y-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
        {shortcuts.map((item) => (
          <div
            key={item.key}
            className="flex justify-between items-center py-1.5 border-b"
            style={{ borderColor: 'var(--divider)' }}
          >
            <span>{t(item.descKey)}</span>
            <kbd
              className="px-2 py-0.5 rounded text-xs font-mono"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
            >
              {item.key}
            </kbd>
          </div>
        ))}
      </div>
    </BaseDialog>
  )
}
