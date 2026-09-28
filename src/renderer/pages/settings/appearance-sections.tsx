import React, { useEffect, useState, useContext } from 'react'
import { useTranslation } from 'react-i18next'
import { useThemeStore } from '../../stores/themeStore'
import { themes, type UITheme } from '../../styles/themes'
import { SectionShell, GlobalToastContext, SettingsToggle } from './shared'

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
          {themes.map((th) => (
            <option key={th.id} value={th.id}>
              {t(th.nameKey)}
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

// 纯 DOM 样式应用工具：放模块作用域（无组件状态依赖，也不参与 effect 依赖计算）
type FontSize = 'small' | 'normal' | 'large' | 'xlarge'

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

// 玻璃效果档位：rich（明显流动感，默认）| lite（轻度增强）；非法值按 rich 处理
export type GlassEffect = 'rich' | 'lite'

export const normalizeGlassEffect = (value: unknown): GlassEffect =>
  value === 'lite' ? 'lite' : 'rich'

const applyGlassEffect = (effect: GlassEffect) => {
  document.documentElement.classList.toggle('glass-lite', effect === 'lite')
}

export const AppearanceDisplaySection: React.FC = () => {
  const { t } = useTranslation()
  const showMessage = useContext(GlobalToastContext)
  const [fontSize, setFontSize] = useState<FontSize>('normal')
  const [compactMode, setCompactMode] = useState(false)
  const [reduceMotion, setReduceMotion] = useState(false)
  const [glassEffect, setGlassEffect] = useState<GlassEffect>('rich')

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
      const glass = normalizeGlassEffect(
        await window.electronAPI.settings.get('display.glassEffect', 'rich')
      )
      setGlassEffect(glass)
      applyGlassEffect(glass)
    }
    load()
  }, [])

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

  const handleGlassEffect = async (effect: GlassEffect) => {
    setGlassEffect(effect)
    applyGlassEffect(effect)
    if (window.electronAPI) await window.electronAPI.settings.set('display.glassEffect', effect)
    showMessage(
      t('logAction.glassEffectSet', {
        label: t(
          effect === 'lite'
            ? 'settings.display.glassEffectLite'
            : 'settings.display.glassEffectRich'
        )
      })
    )
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
      <SettingsToggle
        label={t('settings.display.compactMode')}
        description={t('settings.display.compactModeDesc')}
        checked={compactMode}
        onChange={handleCompactMode}
      />

      {/* 动效减弱 */}
      <SettingsToggle
        label={t('settings.display.reduceMotion')}
        description={t('settings.display.reduceMotionDesc')}
        checked={reduceMotion}
        onChange={handleReduceMotion}
      />

      {/* 玻璃效果：明显流动感（默认，含环境光斑）/ 轻度增强（低饱和无光斑） */}
      <div className="space-y-2">
        <div style={{ color: 'var(--text-primary)' }}>{t('settings.display.glassEffect')}</div>
        <div className="grid grid-cols-2 gap-2">
          {(['rich', 'lite'] as const).map((opt) => {
            const active = glassEffect === opt
            return (
              <button
                key={opt}
                type="button"
                onClick={() => handleGlassEffect(opt)}
                className="p-3 rounded-lg text-center transition-all"
                style={{
                  background: active ? 'var(--accent)' : 'var(--bg-tertiary)',
                  color: active ? 'var(--text-on-accent)' : 'var(--text-primary)',
                  border: active ? '1px solid var(--accent)' : '1px solid transparent'
                }}
                aria-pressed={active}
              >
                <div className="font-medium text-sm">
                  {t(
                    opt === 'rich'
                      ? 'settings.display.glassEffectRich'
                      : 'settings.display.glassEffectLite'
                  )}
                </div>
              </button>
            )
          })}
        </div>
        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          {t('settings.display.glassEffectHint')}
        </p>
      </div>
    </SectionShell>
  )
}
