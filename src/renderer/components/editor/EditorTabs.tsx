import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  FilterParams,
  FilterPreset,
  WatermarkConfig,
  HSLColorKey
} from '../../utils/imageProcessor'
import { hslColorKeys } from '../../utils/imageProcessor'
import { SliderControl } from '../common/SliderControl'
import { ToneCurve } from './ToneCurve'
import { WatermarkPanel } from './WatermarkPanel'
import { FilterPanel } from './FilterPanel'
import { LutPanel } from './LutPanel'
import { IconChevronLeft, IconChevronRight } from '../../icons'

// P1-U15：hslLabels key 改为 i18n key，渲染时通过 t() 翻译
const hslLabelKeys: Record<HSLColorKey, string> = {
  red: 'editor.hsl.red',
  orange: 'editor.hsl.orange',
  yellow: 'editor.hsl.yellow',
  yellowGreen: 'editor.hsl.yellowGreen',
  green: 'editor.hsl.green',
  cyan: 'editor.hsl.cyan',
  blue: 'editor.hsl.blue',
  purple: 'editor.hsl.purple',
  magenta: 'editor.hsl.magenta',
  skin: 'editor.hsl.skin',
  bluePurple: 'editor.hsl.bluePurple',
  warm: 'editor.hsl.warm'
}

// P1-U15：tabs label 改为 i18n key
const tabs = [
  { id: 'basic', labelKey: 'editor.tabs.basic' },
  { id: 'hsl', labelKey: 'editor.tabs.hsl' },
  { id: 'curves', labelKey: 'editor.tabs.curves' },
  { id: 'split', labelKey: 'editor.tabs.split' },
  { id: 'filters', labelKey: 'editor.tabs.filters' },
  { id: 'lut', labelKey: 'editor.tabs.lut' },
  { id: 'watermark', labelKey: 'editor.tabs.watermark' }
] as const

export type EditorTabId = (typeof tabs)[number]['id']

interface EditorTabsProps {
  activeTab: EditorTabId
  onTabChange: (tab: EditorTabId) => void
  params: FilterParams
  updateParam: <K extends keyof FilterParams>(key: K, value: FilterParams[K]) => void
  updateCurve: (channel: 'rgb' | 'r' | 'g' | 'b', points: { x: number; y: number }[]) => void
  updateHSL: (
    key: HSLColorKey,
    field: keyof FilterParams['hsl'][HSLColorKey],
    value: number
  ) => void
  pushHistory: () => void
  filter: FilterPreset | null
  filterIntensity: number
  applyFilterPreset: (preset: FilterPreset) => void
  setFilterIntensity: (v: number) => void
  watermark: WatermarkConfig | null
  setWatermark: (w: WatermarkConfig | null) => void
  presetName: string
  setPresetName: (name: string) => void
  sourceUrl: string | null
  onExportPreset: () => void
  onImportPreset: () => void
  onSavePreset: () => Promise<void>
}

export const EditorTabs: React.FC<EditorTabsProps> = ({
  activeTab,
  onTabChange,
  params,
  updateParam,
  updateCurve,
  updateHSL,
  pushHistory,
  filter,
  filterIntensity,
  applyFilterPreset,
  setFilterIntensity,
  watermark,
  setWatermark,
  presetName,
  setPresetName,
  sourceUrl,
  onExportPreset,
  onImportPreset,
  onSavePreset
}) => {
  const { t } = useTranslation()
  // 基础调整 14 个滑块使用 useCallback 避免重复创建函数
  const onBrightnessChange = useCallback((v: number) => updateParam('brightness', v), [updateParam])
  const onContrastChange = useCallback((v: number) => updateParam('contrast', v), [updateParam])
  const onSaturationChange = useCallback((v: number) => updateParam('saturation', v), [updateParam])
  const onVibranceChange = useCallback((v: number) => updateParam('vibrance', v), [updateParam])
  const onTemperatureChange = useCallback(
    (v: number) => updateParam('temperature', v),
    [updateParam]
  )
  const onTintChange = useCallback((v: number) => updateParam('tint', v), [updateParam])
  const onHighlightsChange = useCallback((v: number) => updateParam('highlights', v), [updateParam])
  const onShadowsChange = useCallback((v: number) => updateParam('shadows', v), [updateParam])
  const onWhitesChange = useCallback((v: number) => updateParam('whites', v), [updateParam])
  const onBlacksChange = useCallback((v: number) => updateParam('blacks', v), [updateParam])
  const onClarityChange = useCallback((v: number) => updateParam('clarity', v), [updateParam])
  const onDehazeChange = useCallback((v: number) => updateParam('dehaze', v), [updateParam])
  const onSharpenChange = useCallback((v: number) => updateParam('sharpen', v), [updateParam])
  const onDenoiseChange = useCallback((v: number) => updateParam('denoise', v), [updateParam])

  const onHighlightHueChange = useCallback(
    (v: number) => updateParam('highlightHue', v),
    [updateParam]
  )
  const onHighlightSaturationChange = useCallback(
    (v: number) => updateParam('highlightSaturation', v),
    [updateParam]
  )
  const onShadowHueChange = useCallback((v: number) => updateParam('shadowHue', v), [updateParam])
  const onShadowSaturationChange = useCallback(
    (v: number) => updateParam('shadowSaturation', v),
    [updateParam]
  )
  const onSplitBalanceChange = useCallback(
    (v: number) => updateParam('splitBalance', v),
    [updateParam]
  )

  // U-O5：面板折叠状态——窄屏时可收起面板获得更大预览区
  const [collapsed, setCollapsed] = useState(false)

  if (collapsed) {
    return (
      <div className="glass-card flex-shrink-0 w-12 flex flex-col items-center gap-2 p-2 overflow-y-auto">
        <button
          className="icon-btn flex-shrink-0"
          onClick={() => setCollapsed(false)}
          title={t('editor.tabs.expandPanel')}
          aria-label={t('editor.tabs.expandPanel')}
        >
          <IconChevronLeft size={16} />
        </button>
        {tabs.map((tab) => {
          const label = t(tab.labelKey)
          return (
            <button
              key={tab.id}
              className={`w-9 h-9 rounded-md text-xs font-medium transition-all flex items-center justify-center ${activeTab === tab.id ? 'active' : ''}`}
              style={{
                background: activeTab === tab.id ? 'var(--accent)' : 'transparent',
                color: activeTab === tab.id ? 'white' : 'var(--text-secondary)'
              }}
              onClick={() => {
                onTabChange(tab.id)
                setCollapsed(false)
              }}
              title={label}
              aria-label={label}
            >
              {label.charAt(0)}
            </button>
          )
        })}
      </div>
    )
  }

  return (
    <div className="w-80 glass-card editor-tabs p-5 space-y-5 overflow-y-auto flex-shrink-0">
      {/* 标签页切换 + 折叠按钮 */}
      <div className="flex items-center gap-2">
        <div
          className="flex gap-1 p-1 rounded-lg flex-1"
          style={{ background: 'var(--bg-tertiary)' }}
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`flex-1 py-2 px-1 rounded-md text-xs font-medium transition-all ${activeTab === tab.id ? 'active' : ''}`}
              style={{
                background: activeTab === tab.id ? 'var(--accent)' : 'transparent',
                color: activeTab === tab.id ? 'white' : 'var(--text-secondary)'
              }}
              onClick={() => onTabChange(tab.id)}
            >
              {t(tab.labelKey)}
            </button>
          ))}
        </div>
        <button
          className="icon-btn flex-shrink-0"
          onClick={() => setCollapsed(true)}
          title={t('editor.tabs.collapsePanel')}
          aria-label={t('editor.tabs.collapsePanel')}
        >
          <IconChevronRight size={16} />
        </button>
      </div>

      {/* 基础调整 */}
      {activeTab === 'basic' && (
        <div className="space-y-5">
          <SliderControl
            label={t('editor.basic.brightness')}
            value={params.brightness}
            onChange={onBrightnessChange}
            onCommit={pushHistory}
          />
          <SliderControl
            label={t('editor.basic.contrast')}
            value={params.contrast}
            onChange={onContrastChange}
            onCommit={pushHistory}
          />
          <SliderControl
            label={t('editor.basic.saturation')}
            value={params.saturation}
            onChange={onSaturationChange}
            onCommit={pushHistory}
          />
          <SliderControl
            label={t('editor.basic.vibrance')}
            value={params.vibrance}
            onChange={onVibranceChange}
            onCommit={pushHistory}
          />
          <SliderControl
            label={t('editor.basic.temperature')}
            value={params.temperature}
            onChange={onTemperatureChange}
            onCommit={pushHistory}
            unit="K"
          />
          <SliderControl
            label={t('editor.basic.tint')}
            value={params.tint}
            onChange={onTintChange}
            onCommit={pushHistory}
          />
          <SliderControl
            label={t('editor.basic.highlights')}
            value={params.highlights}
            onChange={onHighlightsChange}
            onCommit={pushHistory}
          />
          <SliderControl
            label={t('editor.basic.shadows')}
            value={params.shadows}
            onChange={onShadowsChange}
            onCommit={pushHistory}
          />
          <SliderControl
            label={t('editor.basic.whites')}
            value={params.whites}
            onChange={onWhitesChange}
            onCommit={pushHistory}
          />
          <SliderControl
            label={t('editor.basic.blacks')}
            value={params.blacks}
            onChange={onBlacksChange}
            onCommit={pushHistory}
          />
          <SliderControl
            label={t('editor.basic.clarity')}
            value={params.clarity}
            onChange={onClarityChange}
            onCommit={pushHistory}
          />
          <SliderControl
            label={t('editor.basic.dehaze')}
            value={params.dehaze}
            onChange={onDehazeChange}
            onCommit={pushHistory}
          />
          <SliderControl
            label={t('editor.basic.sharpen')}
            value={params.sharpen}
            min={0}
            max={100}
            onChange={onSharpenChange}
            onCommit={pushHistory}
          />
          <SliderControl
            label={t('editor.basic.denoise')}
            value={params.denoise}
            min={0}
            max={100}
            onChange={onDenoiseChange}
            onCommit={pushHistory}
          />
        </div>
      )}

      {/* HSL 调色 */}
      {activeTab === 'hsl' && (
        <div className="space-y-3">
          {hslColorKeys.map((colorKey) => {
            const label = t(hslLabelKeys[colorKey])
            const hsl = params.hsl[colorKey]
            return (
              <div
                key={colorKey}
                className="p-3 rounded-lg"
                style={{ background: 'var(--bg-tertiary)' }}
              >
                <div className="text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                  {label}
                </div>
                <div className="space-y-2">
                  <SliderControl
                    label={t('editor.hsl.hue')}
                    value={hsl.hue}
                    min={-180}
                    max={180}
                    onChange={(v) => updateHSL(colorKey, 'hue', v)}
                    onCommit={pushHistory}
                  />
                  <SliderControl
                    label={t('editor.hsl.saturation')}
                    value={hsl.saturation}
                    onChange={(v) => updateHSL(colorKey, 'saturation', v)}
                    onCommit={pushHistory}
                  />
                  <SliderControl
                    label={t('editor.hsl.lightness')}
                    value={hsl.lightness}
                    onChange={(v) => updateHSL(colorKey, 'lightness', v)}
                    onCommit={pushHistory}
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 色调曲线 */}
      {activeTab === 'curves' && (
        <div className="space-y-4">
          <ToneCurve
            channel="rgb"
            value={params.curves.rgb}
            onChange={(points) => updateCurve('rgb', points)}
          />
          <ToneCurve
            channel="r"
            value={params.curves.r}
            onChange={(points) => updateCurve('r', points)}
          />
          <ToneCurve
            channel="g"
            value={params.curves.g}
            onChange={(points) => updateCurve('g', points)}
          />
          <ToneCurve
            channel="b"
            value={params.curves.b}
            onChange={(points) => updateCurve('b', points)}
          />
        </div>
      )}

      {/* 色调分离 */}
      {activeTab === 'split' && (
        <div className="space-y-4">
          <div className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
            <div className="text-sm font-medium mb-3" style={{ color: 'var(--text-primary)' }}>
              {t('editor.hsl.highlights')}
            </div>
            <SliderControl
              label={t('editor.hsl.hue')}
              value={params.highlightHue}
              min={0}
              max={360}
              onChange={onHighlightHueChange}
              onCommit={pushHistory}
            />
            <SliderControl
              label={t('editor.hsl.saturation')}
              value={params.highlightSaturation}
              onChange={onHighlightSaturationChange}
              onCommit={pushHistory}
            />
          </div>
          <div className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
            <div className="text-sm font-medium mb-3" style={{ color: 'var(--text-primary)' }}>
              {t('editor.hsl.shadows')}
            </div>
            <SliderControl
              label={t('editor.hsl.hue')}
              value={params.shadowHue}
              min={0}
              max={360}
              onChange={onShadowHueChange}
              onCommit={pushHistory}
            />
            <SliderControl
              label={t('editor.hsl.saturation')}
              value={params.shadowSaturation}
              onChange={onShadowSaturationChange}
              onCommit={pushHistory}
            />
          </div>
          <SliderControl
            label={t('editor.hsl.balance')}
            value={params.splitBalance}
            onChange={onSplitBalanceChange}
            onCommit={pushHistory}
          />
        </div>
      )}

      {/* 滤镜预设 */}
      {activeTab === 'filters' && (
        <FilterPanel
          filter={filter}
          filterIntensity={filterIntensity}
          presetName={presetName}
          sourceUrl={sourceUrl}
          onApplyPreset={(preset) => {
            applyFilterPreset(preset)
            pushHistory()
          }}
          onIntensityChange={(v) => setFilterIntensity(v)}
          onIntensityCommit={pushHistory}
          onExportPreset={onExportPreset}
          onImportPreset={onImportPreset}
          onSavePreset={onSavePreset}
          onPresetNameChange={setPresetName}
        />
      )}

      {/* LUT 色彩查找表 */}
      {activeTab === 'lut' && (
        <LutPanel
          selectedLutId={params.lut}
          onSelect={(id) => {
            updateParam('lut', id)
            pushHistory()
          }}
        />
      )}

      {/* 水印 */}
      {activeTab === 'watermark' && (
        <WatermarkPanel config={watermark} onChange={setWatermark} onCommit={pushHistory} />
      )}
    </div>
  )
}
