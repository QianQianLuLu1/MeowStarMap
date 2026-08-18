import React, { useEffect, useState, useContext } from 'react'
import { useTranslation } from 'react-i18next'
import { useThemeStore } from '../../stores/themeStore'
import { themes, type UITheme } from '../../styles/themes'
import { SectionShell, GlobalToastContext } from './shared'

// ============ 外观 ============

export const AppearanceThemeSection: React.FC = () => {
  const { t } = useTranslation()
  const { theme, setTheme } = useThemeStore()
  const showMessage = useContext(GlobalToastContext)

  const saveTheme = async (nextTheme: UITheme) => {
    setTheme(nextTheme)
    if (window.electronAPI) {
      await window.electronAPI.settings.set('uiTheme', nextTheme)
      if (window.electronAPI.uiTheme?.set) await window.electronAPI.uiTheme.set(nextTheme)
    }
    showMessage(t('logAction.themeChanged'))
  }

  return (
    <SectionShell title={t('settings.sections.theme')} description={t('settings.theme.desc')}>
      <div className="flex items-center justify-between gap-4">
        <span style={{ color: 'var(--text-primary)' }}>{t('settings.theme.label')}</span>
        <select
          value={theme}
          onChange={(e) => saveTheme(e.target.value as UITheme)}
          className="px-3 py-2 text-sm rounded-lg min-w-[140px]"
          style={{
            background: 'var(--bg-tertiary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--divider)'
          }}
          aria-label={t('settings.theme.label')}
        >
          {themes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
        {t('settings.theme.desc')}
      </p>
    </SectionShell>
  )
}

export const AppearanceDisplaySection: React.FC = () => {
  const { t } = useTranslation()
  const showMessage = useContext(GlobalToastContext)
  type FontSize = 'small' | 'normal' | 'large' | 'xlarge'
  const [fontSize, setFontSize] = useState<FontSize>('normal')
  const [compactMode, setCompactMode] = useState(false)
  const [reduceMotion, setReduceMotion] = useState(false)

  useEffect(() => {
    const load = async () => {
      if (!window.electronAPI) return
      const size = (await window.electronAPI.settings.get('display.fontSize', 'normal')) as FontSize
      setFontSize(size)
      applyFontSize(size)
      const compact = (await window.electronAPI.settings.get(
        'display.compactMode',
        false
      )) as boolean
      setCompactMode(compact)
      applyCompactMode(compact)
      const motion = (await window.electronAPI.settings.get(
        'display.reduceMotion',
        false
      )) as boolean
      setReduceMotion(motion)
      applyReduceMotion(motion)
    }
    load()
  }, [])

  const applyFontSize = (size: FontSize) => {
    const html = document.documentElement
    html.classList.remove(
      'font-size-small',
      'font-size-normal',
      'font-size-large',
      'font-size-xlarge'
    )
    html.classList.add(`font-size-${size}`)
  }

  const applyCompactMode = (enabled: boolean) => {
    document.documentElement.classList.toggle('compact-mode', enabled)
  }

  const applyReduceMotion = (enabled: boolean) => {
    document.documentElement.classList.toggle('reduce-motion', enabled)
  }

  const handleFontSize = async (size: FontSize) => {
    setFontSize(size)
    applyFontSize(size)
    if (window.electronAPI) await window.electronAPI.settings.set('display.fontSize', size)
    const labels: Record<FontSize, string> = {
      small: t('settings.display.fontSizeSmall'),
      normal: t('settings.display.fontSizeNormal'),
      large: t('settings.display.fontSizeLarge'),
      xlarge: t('settings.display.fontSizeXLarge')
    }
    showMessage(t('logAction.fontSizeSet', { label: labels[size] }))
  }

  const handleCompactMode = async (enabled: boolean) => {
    setCompactMode(enabled)
    applyCompactMode(enabled)
    if (window.electronAPI) await window.electronAPI.settings.set('display.compactMode', enabled)
    showMessage(enabled ? t('logAction.compactModeOn') : t('logAction.compactModeOff'))
  }

  const handleReduceMotion = async (enabled: boolean) => {
    setReduceMotion(enabled)
    applyReduceMotion(enabled)
    if (window.electronAPI) await window.electronAPI.settings.set('display.reduceMotion', enabled)
    showMessage(enabled ? t('logAction.reduceMotionOn') : t('logAction.reduceMotionOff'))
  }

  const sizeOptions: { value: FontSize; label: string; sample: string }[] = [
    { value: 'small', label: t('settings.display.fontSizeSmall'), sample: '12px' },
    { value: 'normal', label: t('settings.display.fontSizeNormal'), sample: '14px' },
    { value: 'large', label: t('settings.display.fontSizeLarge'), sample: '16px' },
    { value: 'xlarge', label: t('settings.display.fontSizeXLarge'), sample: '18px' }
  ]

  return (
    <SectionShell title={t('settings.sections.display')}>
      {/* 字号选择 */}
      <div className="space-y-2">
        <div style={{ color: 'var(--text-primary)' }}>{t('settings.display.fontSize')}</div>
        <div className="grid grid-cols-4 gap-2">
          {sizeOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => handleFontSize(opt.value)}
              className="p-3 rounded-lg text-center transition-all"
              style={{
                background: fontSize === opt.value ? 'var(--accent)' : 'var(--bg-tertiary)',
                color: fontSize === opt.value ? '#fff' : 'var(--text-primary)',
                border: fontSize === opt.value ? '1px solid var(--accent)' : '1px solid transparent'
              }}
            >
              <div className="font-medium" style={{ fontSize: opt.sample }}>
                {opt.label}
              </div>
              <div className="text-xs mt-1 opacity-70">{opt.sample}</div>
            </button>
          ))}
        </div>
        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          {t('settings.display.fontSizeHint')}
        </p>
      </div>

      {/* 紧凑模式 */}
      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <div style={{ color: 'var(--text-primary)' }}>{t('settings.display.compactMode')}</div>
          <div className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
            {t('settings.display.compactModeDesc')}
          </div>
        </div>
        <input
          type="checkbox"
          checked={compactMode}
          onChange={(e) => handleCompactMode(e.target.checked)}
          className="w-5 h-5"
        />
      </label>

      {/* 动效减弱 */}
      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <div style={{ color: 'var(--text-primary)' }}>{t('settings.display.reduceMotion')}</div>
          <div className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
            {t('settings.display.reduceMotionDesc')}
          </div>
        </div>
        <input
          type="checkbox"
          checked={reduceMotion}
          onChange={(e) => handleReduceMotion(e.target.checked)}
          className="w-5 h-5"
        />
      </label>
    </SectionShell>
  )
}
