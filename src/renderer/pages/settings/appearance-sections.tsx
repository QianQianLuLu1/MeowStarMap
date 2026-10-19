import React, { useEffect, useState, useContext } from 'react'
import { useTranslation } from 'react-i18next'
import { useThemeStore } from '../../stores/themeStore'
import { themes, type UITheme } from '../../styles/themes'
import { Select } from '../../components/common/Select'
import { SegmentedControl } from '../../components/common/SegmentedControl'
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
        <Select
          value={theme}
          onChange={(e) => saveTheme(e.target.value as UITheme)}
          className="min-w-[140px]"
          aria-label={t('settings.theme.label')}
        >
          {themes.map((th) => (
            <option key={th.id} value={th.id}>
              {t(th.nameKey)}
            </option>
          ))}
        </Select>
      </div>
      {/* 描述只经 SectionShell 的 description 渲染一次；此处原先又画了一遍同文 <p> */}
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

// 视觉体系 v3：氛围层细项开关（颗粒纹理 / 漂浮几何体，默认开启；关闭时挂根类隐藏）
const applyAmbientGrain = (enabled: boolean) => {
  document.documentElement.classList.toggle('grain-off', !enabled)
}

const applyAmbientShapes = (enabled: boolean) => {
  document.documentElement.classList.toggle('shapes-off', !enabled)
}

export const AppearanceDisplaySection: React.FC = () => {
  const { t } = useTranslation()
  const showMessage = useContext(GlobalToastContext)
  const [fontSize, setFontSize] = useState<FontSize>('normal')
  const [compactMode, setCompactMode] = useState(false)
  const [reduceMotion, setReduceMotion] = useState(false)
  const [glassEffect, setGlassEffect] = useState<GlassEffect>('rich')
  const [ambientGrain, setAmbientGrain] = useState(true)
  const [ambientShapes, setAmbientShapes] = useState(true)

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
      const grain = (await window.electronAPI.settings.get('display.ambientGrain', true)) as boolean
      setAmbientGrain(grain !== false)
      applyAmbientGrain(grain !== false)
      const shapes = (await window.electronAPI.settings.get(
        'display.ambientShapes',
        true
      )) as boolean
      setAmbientShapes(shapes !== false)
      applyAmbientShapes(shapes !== false)
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

  const handleAmbientGrain = async (enabled: boolean) => {
    setAmbientGrain(enabled)
    applyAmbientGrain(enabled)
    if (window.electronAPI) await window.electronAPI.settings.set('display.ambientGrain', enabled)
  }

  const handleAmbientShapes = async (enabled: boolean) => {
    setAmbientShapes(enabled)
    applyAmbientShapes(enabled)
    if (window.electronAPI) await window.electronAPI.settings.set('display.ambientShapes', enabled)
  }

  // SegmentedControl 的 option 只有 value/label 两个展示槽，
  // 原手写磁贴「按该字号自身渲染 + 12/14/16/18px 角标」的所见即所得预览随换控件而取消；
  // 小/标准/大/特大 四字面已足够自解释，故接受这一处信息缩减。
  const sizeOptions: { value: FontSize; label: string }[] = [
    { value: 'small', label: t('settings.display.fontSizeSmall') },
    { value: 'normal', label: t('settings.display.fontSizeNormal') },
    { value: 'large', label: t('settings.display.fontSizeLarge') },
    { value: 'xlarge', label: t('settings.display.fontSizeXLarge') }
  ]

  return (
    <SectionShell title={t('settings.sections.display')}>
      {/* 字号选择 */}
      <div className="space-y-2">
        <div style={{ color: 'var(--text-primary)' }}>{t('settings.display.fontSize')}</div>
        <SegmentedControl
          ariaLabel={t('settings.display.fontSize')}
          options={sizeOptions}
          value={fontSize}
          onChange={(size) => void handleFontSize(size)}
        />
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

      {/* 玻璃效果：明显流动感（默认，含环境光斑）/ 轻度增强（低饱和无光斑）
          option 的 value 必须逐字保持 'rich' / 'lite'——它直接决定 html.glass-lite 类，
          改名会静默打断氛围层的降级链（AppShell .ambient-* 整层隐藏）。 */}
      <div className="space-y-2">
        <div style={{ color: 'var(--text-primary)' }}>{t('settings.display.glassEffect')}</div>
        <SegmentedControl
          ariaLabel={t('settings.display.glassEffect')}
          options={[
            { value: 'rich' as GlassEffect, label: t('settings.display.glassEffectRich') },
            { value: 'lite' as GlassEffect, label: t('settings.display.glassEffectLite') }
          ]}
          value={glassEffect}
          onChange={(effect) => void handleGlassEffect(effect)}
        />
        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          {t('settings.display.glassEffectHint')}
        </p>
      </div>

      {/* 视觉体系 v3：氛围层细项（「玻璃效果：轻度增强」档下整层隐藏，此处开关为 rich 档细分控制） */}
      <SettingsToggle
        label={t('settings.display.ambientGrain')}
        description={t('settings.display.ambientGrainDesc')}
        checked={ambientGrain}
        onChange={handleAmbientGrain}
        disabled={glassEffect === 'lite'}
      />

      <SettingsToggle
        label={t('settings.display.ambientShapes')}
        description={t('settings.display.ambientShapesDesc')}
        checked={ambientShapes}
        onChange={handleAmbientShapes}
        disabled={glassEffect === 'lite'}
      />
    </SectionShell>
  )
}

/**
 * 「主题与显示」合并页：主题节原本只有一个下拉框（36 行），
 * 单独占一个导航项不值当，与同属界面偏好的显示节聚到一屏。
 * 两节各自保留 SectionShell，本组件只管纵向排布。
 */
export const AppearanceThemeDisplaySection: React.FC = () => (
  <div className="space-y-4">
    <AppearanceThemeSection />
    <AppearanceDisplaySection />
  </div>
)
