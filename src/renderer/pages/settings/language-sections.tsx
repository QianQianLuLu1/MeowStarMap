// P2-01 + P3：语言设置区块
// 支持跟随系统（auto）+ 12 种语言手动切换
// P3 优化：切换非 zh-CN 语言时显示 loading（首次加载本地 chunk，约 100-300ms）
// 切换后立即生效（react-i18next 自动重渲染），并持久化到 localStorage
import React, { useState, useEffect, useContext } from 'react'
import { useTranslation } from 'react-i18next'
import { SectionShell, GlobalToastContext } from './shared'
import { SUPPORTED_LANGUAGES, changeLanguage, getCurrentLanguage } from '../../i18n'

export const LanguageSection: React.FC = () => {
  const { t } = useTranslation()
  const showMessage = useContext(GlobalToastContext)
  // P2-01：当前语言选择（含 'auto'）
  // 初始读取 localStorage，未配置时默认 'auto'
  const [selected, setSelected] = useState<string>(() => {
    try {
      return localStorage.getItem('app-language') || 'auto'
    } catch {
      return 'auto'
    }
  })
  const [currentLang, setCurrentLang] = useState<string>(getCurrentLanguage())
  // P3：切换语言加载中标志（仅首次加载非 zh-CN 语言 chunk 时为 true）
  const [switching, setSwitching] = useState<boolean>(false)

  useEffect(() => {
    setCurrentLang(getCurrentLanguage())
  }, [selected])

  const handleSelect = async (code: string) => {
    if (switching) return
    setSelected(code)
    setSwitching(true)
    try {
      const resolved = await changeLanguage(code)
      setCurrentLang(resolved)
      // 找到目标语言的标签用于提示
      const target = SUPPORTED_LANGUAGES.find((l) => l.code === code)
      const label = target?.label ?? code
      showMessage(t('toast.languageChanged', { lang: label }))
    } finally {
      setSwitching(false)
    }
  }

  return (
    <SectionShell
      title={t('settings.language.title')}
      description={t('settings.language.description')}
    >
      <div className="space-y-2">
        {/* 语言下拉选择器 */}
        <select
          value={selected}
          onChange={(e) => handleSelect(e.target.value)}
          disabled={switching}
          className="w-full px-3 py-2 text-sm rounded-lg disabled:opacity-60"
          style={{
            background: 'var(--bg-tertiary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--divider)'
          }}
        >
          {SUPPORTED_LANGUAGES.map((lang) => (
            <option key={lang.code} value={lang.code}>
              {lang.label} {lang.englishName !== lang.label ? `(${lang.englishName})` : ''}
            </option>
          ))}
        </select>

        {/* P3：加载中提示 */}
        {switching && (
          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            {t('settings.language.loading', { defaultValue: '加载语言包...' })}
          </p>
        )}

        {/* 当前生效语言显示 */}
        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          {t('settings.language.restartHint')}
        </p>
        {selected === 'auto' && (
          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            {t('settings.language.auto')}:{' '}
            {SUPPORTED_LANGUAGES.find((l) => l.code === currentLang)?.label ?? currentLang}
          </p>
        )}
      </div>
    </SectionShell>
  )
}
