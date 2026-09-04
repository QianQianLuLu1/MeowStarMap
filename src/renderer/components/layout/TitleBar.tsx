import React from 'react'
import { useTranslation } from 'react-i18next'
import { IconImage } from '../../icons'

export const TitleBar: React.FC = () => {
  // U2：标题文本 i18n 化，避免硬编码中文
  const { t } = useTranslation()
  return (
    <div className="h-10 flex items-center justify-between px-4 fixed top-0 left-0 right-0 z-50 app-drag title-bar">
      <div
        className="flex items-center gap-2 text-sm font-medium"
        style={{ color: 'var(--text-secondary)' }}
      >
        <IconImage size={18} />
        {t('titleBar.appTitle')}
      </div>
    </div>
  )
}
