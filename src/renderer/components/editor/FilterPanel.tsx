import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  FilterPreset,
  FilterParams,
  defaultFilterParams,
  processImageData,
  imageToDataUrl
} from '../../utils/imageProcessor'
import { getFilterCategories, getPresetsByCategory } from '../../utils/filterPresets'
import { formatCategoryName } from '../../utils/category-name'
import { SliderControl } from '../common/SliderControl'
import { IconFilterPreset } from '../../icons'
import { runWithConcurrency } from '../../../main/utils/concurrency'
import { needsAnonymousCors } from '../../utils/file'

const THUMBNAIL_CONCURRENCY = 4

interface FilterPanelProps {
  filter: FilterPreset | null
  filterIntensity: number
  presetName: string
  sourceUrl?: string | null
  onApplyPreset: (preset: FilterPreset) => void
  onIntensityChange: (value: number) => void
  onIntensityCommit?: () => void
  onExportPreset: () => void
  onImportPreset: () => void
  onSavePreset?: () => Promise<void>
  onPresetNameChange: (name: string) => void
  className?: string
}

export const FilterPanel: React.FC<FilterPanelProps> = ({
  filter,
  filterIntensity,
  presetName,
  sourceUrl,
  onApplyPreset,
  onIntensityChange,
  onIntensityCommit,
  onExportPreset,
  onImportPreset,
  onSavePreset,
  onPresetNameChange,
  className = ''
}) => {
  const [filterCategory, setFilterCategory] = useState('all')
  const [customPresets, setCustomPresets] = useState<FilterPreset[]>([])
  const [loading, setLoading] = useState(false)
  const [thumbnails, setThumbnails] = useState<Map<string, string>>(new Map())
  const [generating, setGenerating] = useState(false)
  const { t } = useTranslation()
  // useMemo 稳定引用：作为 generateThumbnails 的依赖，避免每次渲染生成新回调
  const filteredPresets = useMemo(() => getPresetsByCategory(filterCategory), [filterCategory])
  const categories = getFilterCategories()
  const imageRef = useRef<HTMLImageElement | null>(null)
  const abortRef = useRef(false)
  // 始终调用最新的 generateThumbnails：图片 onload 时使用最新预设，
  // 同时避免 [sourceUrl] effect 因预设变化重新触发图片加载
  const generateThumbnailsRef = useRef<() => Promise<void>>(async () => {})

  const loadCustomPresets = async () => {
    if (!window.electronAPI?.editor?.loadPresets) return
    try {
      const result = await window.electronAPI.editor.loadPresets()
      if (result.success && Array.isArray(result.presets)) {
        setCustomPresets(
          (
            result.presets as Array<{
              id: string
              name: string
              category: string
              params: Partial<FilterParams>
            }>
          ).map((p) => ({
            id: p.id,
            name: p.name,
            category: p.category,
            params: p.params
          }))
        )
      }
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    loadCustomPresets()
  }, [])

  useEffect(() => {
    if (!sourceUrl) {
      setThumbnails(new Map())
      imageRef.current = null
      return
    }

    abortRef.current = false
    const img = new Image()
    // media:// 注册为 standard scheme 具有独立 origin，绘制进 canvas 前需以 anonymous CORS 模式加载
    if (needsAnonymousCors(sourceUrl)) {
      img.crossOrigin = 'anonymous'
    }
    img.onload = () => {
      imageRef.current = img
      generateThumbnailsRef.current()
    }
    img.onerror = () => {
      imageRef.current = null
      setThumbnails(new Map())
    }
    img.src = sourceUrl

    return () => {
      abortRef.current = true
      img.onload = null
      img.onerror = null
      img.src = ''
    }
  }, [sourceUrl])

  const generateThumbnails = useCallback(async () => {
    const img = imageRef.current
    if (!img) return

    setGenerating(true)

    const presetsToRender = [...filteredPresets, ...customPresets]

    const tasks = presetsToRender.map((preset) => async () => {
      if (abortRef.current) return
      try {
        const merged: FilterParams = JSON.parse(JSON.stringify(defaultFilterParams))
        const presetParams = preset.params
        for (const [key, value] of Object.entries(presetParams)) {
          const k = key as keyof FilterParams | 'hsl'
          if (k === 'hsl' && typeof value === 'object' && value) {
            for (const [colorKey, adj] of Object.entries(
              value as Partial<
                Record<string, { hue?: number; saturation?: number; lightness?: number }>
              >
            )) {
              if (!merged.hsl[colorKey as keyof typeof merged.hsl]) continue
              if (adj?.hue !== undefined)
                merged.hsl[colorKey as keyof typeof merged.hsl].hue = adj.hue
              if (adj?.saturation !== undefined)
                merged.hsl[colorKey as keyof typeof merged.hsl].saturation = adj.saturation
              if (adj?.lightness !== undefined)
                merged.hsl[colorKey as keyof typeof merged.hsl].lightness = adj.lightness
            }
          } else if (typeof value === 'number' && k !== 'hsl') {
            ;(merged[k as keyof FilterParams] as number) = value as number
          }
        }

        const imageData = await processImageData(img, merged, { maxSize: 120 })
        const dataUrl = await imageToDataUrl(imageData, 'image/jpeg', 0.85)
        setThumbnails((prev) => new Map(prev).set(preset.id, dataUrl))
      } catch {
        // ignore
      }
    })
    await runWithConcurrency(tasks, THUMBNAIL_CONCURRENCY)

    if (!abortRef.current) {
      setGenerating(false)
    }
  }, [filteredPresets, customPresets])

  useEffect(() => {
    generateThumbnailsRef.current = generateThumbnails
  }, [generateThumbnails])

  useEffect(() => {
    if (!imageRef.current) return
    generateThumbnails()
  }, [generateThumbnails])

  const handleSavePreset = async () => {
    if (!onSavePreset) return
    setLoading(true)
    try {
      await onSavePreset()
      await loadCustomPresets()
    } finally {
      setLoading(false)
    }
  }

  const handleDeletePreset = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!window.electronAPI?.editor?.deletePreset) return
    await window.electronAPI.editor.deletePreset(id)
    await loadCustomPresets()
  }

  const displayPresets =
    filterCategory === 'custom'
      ? customPresets
      : filterCategory === 'all'
        ? [...filteredPresets, ...customPresets]
        : filteredPresets

  return (
    <div className={`space-y-4 ${className}`}>
      <div className="flex gap-2">
        <input
          type="text"
          className="input-field flex-1 text-sm"
          placeholder={t('filter.namePlaceholder')}
          value={presetName}
          onChange={(e) => onPresetNameChange(e.target.value)}
        />
        <button
          className="btn-secondary text-xs px-3 whitespace-nowrap"
          onClick={handleSavePreset}
          disabled={loading || !presetName.trim() || !onSavePreset}
          title={t('filter.saveCurrentAria')}
          aria-label={t('filter.saveCurrentAria')}
        >
          {loading ? t('filter.saving') : t('filter.save')}
        </button>
      </div>

      <div className="flex gap-1">
        <button
          className="btn-secondary text-xs px-3 flex-1"
          onClick={onExportPreset}
          title={t('filter.exportAria')}
          aria-label={t('filter.exportAria')}
        >
          {t('filter.exportJson')}
        </button>
        <button
          className="btn-secondary text-xs px-3 flex-1"
          onClick={onImportPreset}
          title={t('filter.importAria')}
          aria-label={t('filter.importAria')}
        >
          {t('filter.importJson')}
        </button>
      </div>

      <div className="flex gap-1 p-1 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
        {categories.map((cat) => (
          <button
            key={cat.id}
            className="flex-1 py-1 px-1 rounded text-xs transition-all"
            style={{
              background: filterCategory === cat.id ? 'var(--accent)' : 'transparent',
              color: filterCategory === cat.id ? 'white' : 'var(--text-secondary)'
            }}
            onClick={() => setFilterCategory(cat.id)}
            aria-label={formatCategoryName(cat)}
          >
            {formatCategoryName(cat)}
          </button>
        ))}
      </div>

      <SliderControl
        label={t('filter.intensity')}
        value={filterIntensity}
        min={0}
        max={100}
        onChange={onIntensityChange}
        onCommit={onIntensityCommit}
      />

      {generating && thumbnails.size === 0 && sourceUrl && (
        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
          <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
          {t('filter.generatingPreview')}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        {displayPresets.map((preset) => {
          const isCustom = customPresets.some((p) => p.id === preset.id)
          const thumb = thumbnails.get(preset.id)
          return (
            <button
              key={preset.id}
              className="aspect-square rounded-xl flex flex-col items-center justify-center gap-2 transition-all hover:scale-105 relative overflow-hidden"
              style={{
                background: 'var(--bg-tertiary)',
                border:
                  filter?.id === preset.id ? '2px solid var(--accent)' : '2px solid transparent'
              }}
              onClick={() => onApplyPreset(preset)}
              title={t(preset.name)}
              aria-label={t('filter.applyPresetAria', { name: t(preset.name) })}
            >
              {thumb ? (
                <img
                  src={thumb}
                  alt={t(preset.name)}
                  className="absolute inset-0 w-full h-full object-cover"
                  draggable={false}
                />
              ) : (
                <div
                  className="w-12 h-12 rounded-lg flex items-center justify-center"
                  style={{ background: 'var(--bg-secondary)', color: 'var(--text-tertiary)' }}
                >
                  <IconFilterPreset size={20} />
                </div>
              )}
              <span
                className={`text-xs font-medium z-10 px-2 py-0.5 rounded-md ${thumb ? 'bg-black/50 text-white' : ''}`}
                style={thumb ? undefined : { color: 'var(--text-secondary)' }}
              >
                {t(preset.name)}
              </span>
              {isCustom && (
                <span
                  className="absolute top-1 right-1 text-[10px] px-1.5 py-0.5 rounded z-10"
                  style={{ background: 'var(--accent)', color: 'white' }}
                  onClick={(e) => handleDeletePreset(preset.id, e)}
                  title={t('filter.deleteCustomAria')}
                  aria-label={t('filter.deleteCustomAria')}
                >
                  ×
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
