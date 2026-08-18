import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Lut3D, builtInLuts, parseCube } from '../../utils/lut'
import { IconLut, IconClose } from '../../icons'

// U-O11：自定义 LUT 持久化存储键
const CUSTOM_LUTS_STORAGE_KEY = 'wxnn-custom-luts'

interface StoredLut {
  id: string
  name: string
  content: string
}

function loadStoredLuts(): Lut3D[] {
  try {
    const raw = localStorage.getItem(CUSTOM_LUTS_STORAGE_KEY)
    if (!raw) return []
    const stored = JSON.parse(raw) as StoredLut[]
    return stored
      .map((s) => parseCube(s.content, s.id, s.name))
      .filter((lut): lut is Lut3D => lut !== null)
  } catch {
    return []
  }
}

function saveStoredLuts(luts: Lut3D[]): void {
  try {
    const stored: StoredLut[] = luts.map((lut) => ({
      id: lut.id,
      name: lut.name,
      content: lut.__rawContent || ''
    }))
    localStorage.setItem(CUSTOM_LUTS_STORAGE_KEY, JSON.stringify(stored))
  } catch (err) {
    // P1-U11：存储失败（如配额超限）需记录原因，便于用户排查
    console.warn('[LutPanel] 自定义 LUT 持久化失败:', err)
  }
}

interface LutPanelProps {
  selectedLutId: string | null
  onSelect: (id: string | null) => void
  onImport?: (lut: Lut3D) => void
  className?: string
}

export const LutPanel: React.FC<LutPanelProps> = ({
  selectedLutId,
  onSelect,
  onImport,
  className = ''
}) => {
  const { t } = useTranslation()
  // U-O11：初始化时从 localStorage 加载已保存的自定义 LUT
  const [customLuts, setCustomLuts] = useState<Lut3D[]>(() => loadStoredLuts())
  const fileInputRef = useRef<HTMLInputElement>(null)

  // U-O11：customLuts 变更时持久化到 localStorage
  useEffect(() => {
    saveStoredLuts(customLuts)
  }, [customLuts])

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        const content = String(reader.result)
        const lutId = `custom-${Date.now()}`
        const lut = parseCube(content, lutId, file.name.replace(/\.cube$/i, ''))
        if (lut) {
          // U-O11：附加原始内容用于持久化
          const lutWithRaw = Object.assign(lut, { __rawContent: content })
          setCustomLuts((prev) => [...prev, lutWithRaw])
          onSelect?.(lut.id)
          onImport?.(lut)
        }
      }
      reader.readAsText(file)
      if (fileInputRef.current) fileInputRef.current.value = ''
    },
    [onSelect, onImport]
  )

  // U-O11：删除自定义 LUT
  const handleDeleteCustom = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.stopPropagation()
      setCustomLuts((prev) => prev.filter((l) => l.id !== id))
      if (selectedLutId === id) onSelect(null)
    },
    [selectedLutId, onSelect]
  )

  const allLuts = [...builtInLuts, ...customLuts]
  const customIds = new Set(customLuts.map((l) => l.id))
  // 内置 LUT 走 i18n key，自定义 LUT 回退用 name（用户导入的文件名）
  const getLutDisplayName = (lut: Lut3D): string => (lut.nameKey ? t(lut.nameKey) : lut.name)

  return (
    <div className={`space-y-4 ${className}`}>
      <div className="flex gap-2">
        <button
          className="btn-secondary text-xs flex-1"
          onClick={() => fileInputRef.current?.click()}
        >
          {t('editor.lut.import')}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".cube"
          className="hidden"
          onChange={handleFileChange}
        />
        <button
          className="btn-secondary text-xs flex-1"
          onClick={() => onSelect(null)}
          disabled={!selectedLutId}
        >
          {t('editor.lut.clear')}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {allLuts.map((lut) => (
          <button
            key={lut.id}
            className="aspect-square rounded-xl flex flex-col items-center justify-center gap-2 transition-all hover:scale-105 relative group"
            style={{
              background: 'var(--bg-tertiary)',
              border: selectedLutId === lut.id ? '2px solid var(--accent)' : '2px solid transparent'
            }}
            onClick={() => onSelect(lut.id)}
          >
            <div
              className="w-12 h-12 rounded-lg flex items-center justify-center"
              style={{ background: 'var(--bg-secondary)', color: 'var(--text-tertiary)' }}
            >
              <IconLut size={20} />
            </div>
            <span
              className="text-xs font-medium px-1 truncate w-full text-center"
              style={{ color: 'var(--text-secondary)' }}
            >
              {getLutDisplayName(lut)}
            </span>
            {/* U-O11：自定义 LUT 显示删除按钮 */}
            {customIds.has(lut.id) && (
              <span
                className="absolute top-1 right-1 w-5 h-5 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                style={{
                  background: 'color-mix(in srgb, var(--danger) 90%, transparent)',
                  color: 'var(--text-on-accent)'
                }}
                onClick={(e) => handleDeleteCustom(lut.id, e)}
                title={t('editor.lut.deleteTitle')}
                role="button"
                aria-label={t('editor.lut.deleteAria', { name: getLutDisplayName(lut) })}
              >
                <IconClose size={10} />
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
