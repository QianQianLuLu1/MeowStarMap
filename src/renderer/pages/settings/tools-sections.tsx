import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SectionShell } from './shared'
import { ShareCodeDecoderDialog } from '../../components/common/ShareCodeDecoderDialog'

export const ToolsShareCodeSection: React.FC = () => {
  // U3：硬编码中文迁移至 i18n
  const { t } = useTranslation()
  const [decoderOpen, setDecoderOpen] = useState(false)

  return (
    <SectionShell title={t('settings.sections.shareCode')}>
      <div className="space-y-3 text-sm" style={{ color: 'var(--text-primary)' }}>
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <div className="font-medium mb-1">{t('settings.tools.shareCode.decoder')}</div>
            <div className="text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
              {t('settings.tools.shareCode.decoderDesc')}
            </div>
          </div>
          <button className="btn-primary flex-shrink-0" onClick={() => setDecoderOpen(true)}>
            {t('settings.tools.shareCode.openTool')}
          </button>
        </div>
      </div>

      <ShareCodeDecoderDialog open={decoderOpen} onClose={() => setDecoderOpen(false)} />
    </SectionShell>
  )
}
