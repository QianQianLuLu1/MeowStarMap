import React from 'react'
import { useTranslation } from 'react-i18next'
import { ReactCompareSlider, ReactCompareSliderImage } from 'react-compare-slider'

interface CompareViewProps {
  originalSrc: string | null
  editedSrc: string | null
  className?: string
}

export const CompareView: React.FC<CompareViewProps> = ({
  originalSrc,
  editedSrc,
  className = ''
}) => {
  const { t } = useTranslation()

  if (!originalSrc || !editedSrc) {
    return (
      <div
        className={`flex items-center justify-center ${className}`}
        style={{ background: 'var(--bg-tertiary)' }}
      >
        <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
          {t('editor.compare.loading')}
        </span>
      </div>
    )
  }

  return (
    <div className={`relative ${className}`}>
      <ReactCompareSlider
        defaultPosition={50}
        itemOne={<ReactCompareSliderImage src={originalSrc} alt={t('editor.compare.original')} />}
        itemTwo={<ReactCompareSliderImage src={editedSrc} alt={t('editor.compare.edited')} />}
        style={{ width: '100%', height: '100%' }}
      />
      <div
        className="absolute top-3 left-3 px-2.5 py-1 rounded-md text-xs font-medium pointer-events-none z-10"
        style={{ background: 'var(--overlay-bg)', color: 'var(--text-on-overlay)' }}
      >
        {t('editor.compare.original')}
      </div>
      <div
        className="absolute top-3 right-3 px-2.5 py-1 rounded-md text-xs font-medium pointer-events-none z-10"
        style={{ background: 'var(--overlay-bg)', color: 'var(--text-on-overlay)' }}
      >
        {t('editor.compare.edited')}
      </div>
    </div>
  )
}
