import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  type WatermarkConfig,
  type WatermarkText,
  type WatermarkImage,
  type WatermarkStyle
} from '../../utils/imageProcessor'
import { toFileUrl } from '../../utils/file'
import { SliderControl } from '../common/SliderControl'
import { getPluginWatermarkTemplates } from '../../plugins/plugin-runtime'
import type { PluginWatermarkTemplate } from '../../../shared/types/plugin'

interface WatermarkPanelProps {
  config: WatermarkConfig | null
  onChange: (config: WatermarkConfig | null) => void
  // 修复 U-S7：滑块释放时入历史栈，支持 Ctrl+Z 撤销水印调整
  onCommit?: () => void
}

interface WatermarkTemplate {
  id: number
  name: string
  config: string
}

const blendModes: { id: WatermarkImage['blendMode']; labelKey: string }[] = [
  { id: 'normal', labelKey: 'watermark.blendMode.normal' },
  { id: 'multiply', labelKey: 'watermark.blendMode.multiply' },
  { id: 'screen', labelKey: 'watermark.blendMode.screen' },
  { id: 'overlay', labelKey: 'watermark.blendMode.overlay' },
  { id: 'soft-light', labelKey: 'watermark.blendMode.softLight' }
]

const positions: { id: WatermarkConfig['position']; labelKey: string }[] = [
  { id: 'topLeft', labelKey: 'watermark.positionTopLeft' },
  { id: 'topCenter', labelKey: 'watermark.positionTopCenter' },
  { id: 'topRight', labelKey: 'watermark.positionTopRight' },
  { id: 'centerLeft', labelKey: 'watermark.positionCenterLeft' },
  { id: 'center', labelKey: 'watermark.positionCenter' },
  { id: 'centerRight', labelKey: 'watermark.positionCenterRight' },
  { id: 'bottomLeft', labelKey: 'watermark.positionBottomLeft' },
  { id: 'bottomCenter', labelKey: 'watermark.positionBottomCenter' },
  { id: 'bottomRight', labelKey: 'watermark.positionBottomRight' }
]

const defaultText: WatermarkText = {
  content: 'WXNN Photo',
  font: 'sans-serif',
  size: 24,
  color: '#ffffff',
  opacity: 80,
  bold: false,
  italic: false,
  underline: false
}

const defaultImage: WatermarkImage = {
  path: '',
  width: 120,
  height: 120,
  opacity: 80,
  blendMode: 'normal'
}

const defaultConfig: WatermarkConfig = {
  text: { ...defaultText },
  position: 'bottomRight',
  customX: 0,
  customY: 0,
  rotation: 0,
  margin: 20,
  tile: false,
  tileSpacingX: 50,
  tileSpacingY: 50,
  style: 'normal'
}

interface StylePreset {
  id: WatermarkStyle
  nameKey: string
  descKey: string
  config: Partial<WatermarkConfig>
}

const stylePresets: StylePreset[] = [
  {
    id: 'polaroid',
    nameKey: 'watermark.stylePresetPolaroid',
    descKey: 'watermark.stylePresetPolaroidDesc',
    config: {
      text: {
        content: 'Polaroid',
        font: 'Microsoft YaHei',
        size: 28,
        color: '#333333',
        opacity: 90,
        bold: false,
        italic: false,
        underline: false
      },
      position: 'bottomCenter',
      rotation: 0,
      margin: 0,
      tile: false,
      style: 'polaroid'
    }
  },
  {
    id: 'date-label',
    nameKey: 'watermark.stylePresetDateLabel',
    descKey: 'watermark.stylePresetDateLabelDesc',
    config: {
      text: {
        content: '{date}',
        font: 'Microsoft YaHei',
        size: 18,
        color: '#ffffff',
        opacity: 95,
        bold: false,
        italic: false,
        underline: false
      },
      position: 'topRight',
      rotation: 0,
      margin: 20,
      tile: false,
      style: 'date-label'
    }
  },
  {
    id: 'signature',
    nameKey: 'watermark.stylePresetSignature',
    descKey: 'watermark.stylePresetSignatureDesc',
    config: {
      text: {
        content: 'Signature',
        font: 'serif',
        size: 32,
        color: '#ffffff',
        opacity: 75,
        bold: false,
        italic: true,
        underline: false
      },
      position: 'bottomRight',
      rotation: -8,
      margin: 24,
      tile: false,
      style: 'signature'
    }
  },
  {
    id: 'copyright',
    nameKey: 'watermark.stylePresetCopyright',
    descKey: 'watermark.stylePresetCopyrightDesc',
    config: {
      text: {
        content: '© All Rights Reserved',
        font: 'Microsoft YaHei',
        size: 36,
        color: '#ffffff',
        opacity: 45,
        bold: true,
        italic: false,
        underline: false
      },
      position: 'center',
      rotation: 0,
      margin: 0,
      tile: true,
      tileSpacingX: 360,
      tileSpacingY: 260,
      style: 'copyright'
    }
  }
]

export const WatermarkPanel: React.FC<WatermarkPanelProps> = ({ config, onChange, onCommit }) => {
  const { t } = useTranslation()
  const current = config || { ...defaultConfig, text: { ...defaultText } }
  const [mode, setMode] = useState<'text' | 'image'>(current.image ? 'image' : 'text')
  const [templates, setTemplates] = useState<WatermarkTemplate[]>([])
  const [templateName, setTemplateName] = useState('')
  const [loading, setLoading] = useState(false)
  // 插件提供的水印模板（由 watermark.template 扩展点注入）
  const [pluginTemplates, setPluginTemplates] = useState<PluginWatermarkTemplate[]>([])

  useEffect(() => {
    if (!window.electronAPI?.watermark?.loadTemplates) return
    window.electronAPI.watermark.loadTemplates().then((rows) => {
      setTemplates((rows as WatermarkTemplate[]).map((r) => ({ ...r, config: String(r.config) })))
    })
  }, [])

  // 加载插件提供的水印模板（失败静默，不影响主功能）
  useEffect(() => {
    void getPluginWatermarkTemplates()
      .then((list) => setPluginTemplates(list))
      .catch(() => {
        // 插件系统未就绪或扩展点无响应，忽略
      })
  }, [])

  const updateConfig = (updates: Partial<WatermarkConfig>) => {
    onChange({ ...current, ...updates })
  }

  const updateText = (updates: Partial<WatermarkText>) => {
    updateConfig({ text: { ...(current.text || defaultText), ...updates } })
  }

  const updateImage = (updates: Partial<WatermarkImage>) => {
    updateConfig({ image: { ...(current.image || defaultImage), ...updates } })
  }

  const handleSelectImage = async () => {
    if (!window.electronAPI?.dialog?.openFile) return
    const filePath = await window.electronAPI.dialog.openFile({
      filters: [
        { name: t('categories.iconLabel.image'), extensions: ['png', 'jpg', 'jpeg', 'webp'] }
      ]
    })
    if (!filePath) return
    updateImage({ path: filePath })
  }

  const handleSaveTemplate = async () => {
    if (!templateName.trim() || !window.electronAPI?.watermark?.saveTemplate) return
    setLoading(true)
    try {
      const result = await window.electronAPI.watermark.saveTemplate(
        templateName.trim(),
        JSON.stringify(current)
      )
      if (result.success) {
        setTemplateName('')
        const rows = await window.electronAPI.watermark.loadTemplates()
        setTemplates((rows as WatermarkTemplate[]).map((r) => ({ ...r, config: String(r.config) })))
      }
    } catch (error) {
      console.error('保存水印模板失败:', error) // TODO: i18n
    } finally {
      setLoading(false)
    }
  }

  const handleApplyTemplate = (tpl: WatermarkTemplate) => {
    try {
      const parsed = JSON.parse(tpl.config) as WatermarkConfig
      onChange(parsed)
      setMode(parsed.image ? 'image' : 'text')
    } catch {
      // ignore
    }
  }

  const handleDeleteTemplate = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!window.electronAPI?.watermark?.deleteTemplate) return
    try {
      await window.electronAPI.watermark.deleteTemplate(id)
      setTemplates((prev) => prev.filter((tpl) => tpl.id !== id))
    } catch (error) {
      console.error('删除水印模板失败:', error) // TODO: i18n
    }
  }

  const applyStylePreset = (preset: StylePreset) => {
    const merged: WatermarkConfig = {
      ...defaultConfig,
      text: { ...defaultText },
      ...preset.config
    }
    onChange(merged)
    setMode('text')
  }

  /**
   * 应用插件提供的水印模板
   *
   * 将 PluginWatermarkTemplate 转换为 WatermarkConfig：
   * - type=text：填充 text 字段
   * - type=image：填充 image 字段
   * - 公共字段：position / opacity / rotation
   */
  const handleApplyPluginTemplate = (tpl: PluginWatermarkTemplate) => {
    const base: WatermarkConfig = {
      ...defaultConfig,
      text: { ...defaultText }
    }
    if (tpl.type === 'text') {
      base.text = {
        ...defaultText,
        content: tpl.text ?? 'Plugin Watermark',
        font: tpl.font ?? 'sans-serif',
        size: tpl.fontSize ?? 24,
        color: tpl.color ?? '#ffffff',
        opacity: Math.round((tpl.opacity ?? 0.8) * 100)
      }
      setMode('text')
    } else if (tpl.type === 'image' && tpl.imagePath) {
      base.image = {
        ...defaultImage,
        path: tpl.imagePath,
        opacity: Math.round((tpl.opacity ?? 0.8) * 100)
      }
      // 图片水印的 scale 转换为 width/height（默认 120，按比例缩放）
      const scale = tpl.scale ?? 1
      if (scale !== 1) {
        base.image.width = Math.round(120 * scale)
        base.image.height = Math.round(120 * scale)
      }
      setMode('image')
    }
    if (tpl.position) base.position = tpl.position
    onChange(base)
  }

  return (
    <div className="space-y-5">
      {/* 模式切换 */}
      <div className="flex gap-1 p-1 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
        <button
          className="flex-1 py-1.5 rounded-md text-xs font-medium transition-all"
          style={{
            background: mode === 'text' ? 'var(--accent)' : 'transparent',
            color: mode === 'text' ? 'white' : 'var(--text-secondary)'
          }}
          onClick={() => setMode('text')}
          aria-label={t('watermark.textMode')}
        >
          {t('watermark.textMode')}
        </button>
        <button
          className="flex-1 py-1.5 rounded-md text-xs font-medium transition-all"
          style={{
            background: mode === 'image' ? 'var(--accent)' : 'transparent',
            color: mode === 'image' ? 'white' : 'var(--text-secondary)'
          }}
          onClick={() => setMode('image')}
          aria-label={t('watermark.imageMode')}
        >
          {t('watermark.imageMode')}
        </button>
      </div>

      {/* 样式预设 */}
      <div className="space-y-3">
        <label className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
          {t('watermark.presets')}
        </label>
        <div className="grid grid-cols-2 gap-2">
          {stylePresets.map((preset) => (
            <button
              key={preset.id}
              className="p-2 rounded-lg text-left text-xs transition-all hover:scale-[1.02]"
              style={{
                background: current.style === preset.id ? 'var(--accent)' : 'var(--bg-tertiary)',
                color: current.style === preset.id ? 'white' : 'var(--text-secondary)',
                border:
                  current.style === preset.id
                    ? '1px solid var(--accent)'
                    : '1px solid var(--divider)'
              }}
              onClick={() => applyStylePreset(preset)}
              title={t(preset.descKey)}
              aria-label={t('watermark.presetAria', { name: t(preset.nameKey) })}
            >
              <span
                className="block font-medium"
                style={{ color: current.style === preset.id ? 'white' : 'var(--text-primary)' }}
              >
                {t(preset.nameKey)}
              </span>
              <span className="block mt-0.5 opacity-80">{t(preset.descKey)}</span>
            </button>
          ))}
        </div>
      </div>

      {mode === 'text' ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
              {t('watermark.text')}
            </label>
            <input
              type="text"
              value={current.text?.content || ''}
              onChange={(e) => updateText({ content: e.target.value })}
              className="input-field"
              placeholder={t('watermark.textPlaceholder')}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <label className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                {t('watermark.font')}
              </label>
              <select
                value={current.text?.font || 'sans-serif'}
                onChange={(e) => updateText({ font: e.target.value })}
                className="input-field"
              >
                <option value="sans-serif">{t('watermark.fontSansSerif')}</option>
                <option value="serif">{t('watermark.fontSerif')}</option>
                <option value="monospace">{t('watermark.fontMonospace')}</option>
                <option value="Microsoft YaHei">{t('watermark.fontMicrosoftYaHei')}</option>
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                {t('watermark.color')}
              </label>
              <input
                type="color"
                value={current.text?.color || '#ffffff'}
                onChange={(e) => updateText({ color: e.target.value })}
                className="w-full h-10 rounded cursor-pointer"
              />
            </div>
          </div>

          <SliderControl
            label={t('watermark.size')}
            value={current.text?.size || 24}
            min={8}
            max={120}
            onChange={(v) => updateText({ size: v })}
            onCommit={onCommit}
          />
          <SliderControl
            label={t('watermark.opacity')}
            value={current.text?.opacity || 80}
            min={0}
            max={100}
            onChange={(v) => updateText({ opacity: v })}
            onCommit={onCommit}
          />
          <SliderControl
            label={t('watermark.rotation')}
            value={current.rotation}
            min={-180}
            max={180}
            onChange={(v) => updateConfig({ rotation: v })}
            onCommit={onCommit}
          />

          <div className="flex gap-2">
            <button
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${current.text?.bold ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => updateText({ bold: !current.text?.bold })}
              aria-label={current.text?.bold ? t('watermark.boldOff') : t('watermark.bold')}
            >
              {current.text?.bold ? t('watermark.boldOff') : t('watermark.bold')}
            </button>
            <button
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${current.text?.italic ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => updateText({ italic: !current.text?.italic })}
              aria-label={current.text?.italic ? t('watermark.italicOff') : t('watermark.italic')}
            >
              {current.text?.italic ? t('watermark.italicOff') : t('watermark.italic')}
            </button>
            <button
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${current.text?.underline ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => updateText({ underline: !current.text?.underline })}
              aria-label={
                current.text?.underline ? t('watermark.underlineOff') : t('watermark.underline')
              }
            >
              {current.text?.underline ? t('watermark.underlineOff') : t('watermark.underline')}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
              {t('watermark.imageWatermark')}
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={current.image?.path || ''}
                readOnly
                placeholder={t('watermark.imageSelectPlaceholder')}
                className="input-field flex-1 text-xs"
              />
              <button
                className="btn-secondary text-sm whitespace-nowrap"
                onClick={handleSelectImage}
              >
                {t('watermark.imageSelectButton')}
              </button>
            </div>
          </div>

          {current.image?.path && (
            <div
              className="rounded-lg overflow-hidden h-24 flex items-center justify-center"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              <img
                src={toFileUrl(current.image.path) || undefined}
                alt={t('watermark.imagePreviewAlt')}
                className="max-w-full max-h-full object-contain"
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <SliderControl
              label={t('watermark.width')}
              value={current.image?.width || 120}
              min={20}
              max={800}
              onChange={(v) => updateImage({ width: v })}
              onCommit={onCommit}
            />
            <SliderControl
              label={t('watermark.height')}
              value={current.image?.height || 120}
              min={20}
              max={800}
              onChange={(v) => updateImage({ height: v })}
              onCommit={onCommit}
            />
          </div>

          <SliderControl
            label={t('watermark.opacity')}
            value={current.image?.opacity || 80}
            min={0}
            max={100}
            onChange={(v) => updateImage({ opacity: v })}
            onCommit={onCommit}
          />
          <SliderControl
            label={t('watermark.rotation')}
            value={current.rotation}
            min={-180}
            max={180}
            onChange={(v) => updateConfig({ rotation: v })}
            onCommit={onCommit}
          />

          <div className="space-y-2">
            <label className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
              {t('watermark.blendMode')}
            </label>
            <select
              value={current.image?.blendMode || 'normal'}
              onChange={(e) =>
                updateImage({ blendMode: e.target.value as WatermarkImage['blendMode'] })
              }
              className="input-field"
            >
              {blendModes.map((m) => (
                <option key={m.id} value={m.id}>
                  {t(m.labelKey)}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* 位置九宫格 */}
      <div className="space-y-2">
        <label className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
          {t('watermark.position')}
        </label>
        <div className="grid grid-cols-3 gap-1">
          {positions.map((pos) => (
            <button
              key={pos.id}
              className="py-2 rounded-md text-xs transition-all"
              style={{
                background: current.position === pos.id ? 'var(--accent)' : 'var(--bg-tertiary)',
                color: current.position === pos.id ? 'white' : 'var(--text-secondary)'
              }}
              onClick={() => updateConfig({ position: pos.id })}
              aria-label={t(pos.labelKey)}
            >
              {t(pos.labelKey)}
            </button>
          ))}
        </div>
      </div>

      <SliderControl
        label={t('watermark.margin')}
        value={current.margin}
        min={0}
        max={200}
        onChange={(v) => updateConfig({ margin: v })}
        onCommit={onCommit}
      />

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="tile"
          checked={current.tile}
          onChange={(e) => updateConfig({ tile: e.target.checked })}
        />
        <label htmlFor="tile" className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          {t('watermark.tileMode')}
        </label>
      </div>

      {current.tile && (
        <div className="grid grid-cols-2 gap-3">
          <SliderControl
            label={t('watermark.horizontalSpacing')}
            value={current.tileSpacingX}
            min={10}
            max={500}
            onChange={(v) => updateConfig({ tileSpacingX: v })}
            onCommit={onCommit}
          />
          <SliderControl
            label={t('watermark.verticalSpacing')}
            value={current.tileSpacingY}
            min={10}
            max={500}
            onChange={(v) => updateConfig({ tileSpacingY: v })}
            onCommit={onCommit}
          />
        </div>
      )}

      {/* 模板 */}
      <div className="space-y-3 pt-4" style={{ borderTop: '1px solid var(--divider)' }}>
        <label className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
          {t('watermark.templates')}
        </label>
        {templates.length > 0 && (
          <div className="space-y-1 max-h-32 overflow-y-auto">
            {templates.map((tpl) => (
              <div
                key={tpl.id}
                className="flex items-center justify-between px-3 py-2 rounded-lg text-sm cursor-pointer hover:bg-[var(--hover-bg)]"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
                onClick={() => handleApplyTemplate(tpl)}
              >
                <span>{tpl.name}</span>
                <button
                  className="text-xs"
                  style={{ color: 'var(--danger)' }}
                  onClick={(e) => handleDeleteTemplate(tpl.id, e)}
                  aria-label={t('watermark.deleteTemplateAria', { name: tpl.name })}
                >
                  {t('watermark.deleteText')}
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 插件提供的水印模板 */}
        {pluginTemplates.length > 0 && (
          <div className="space-y-1 max-h-32 overflow-y-auto">
            <div className="text-xs px-1 py-0.5" style={{ color: 'var(--text-tertiary)' }}>
              {t('watermark.pluginTemplates')}
            </div>
            {pluginTemplates.map((tpl) => (
              <div
                key={tpl.id}
                className="flex items-center justify-between px-3 py-2 rounded-lg text-sm cursor-pointer hover:bg-[var(--hover-bg)]"
                style={{
                  background: 'var(--bg-tertiary)',
                  color: 'var(--text-primary)',
                  border: '1px dashed var(--divider)'
                }}
                onClick={() => handleApplyPluginTemplate(tpl)}
                title={tpl.type === 'image' ? t('watermark.imageMode') : t('watermark.textMode')}
              >
                <span>{tpl.name}</span>
                <span
                  className="text-xs px-1.5 py-0.5 rounded"
                  style={{ background: 'var(--bg-quaternary)', color: 'var(--text-tertiary)' }}
                >
                  {tpl.type === 'image'
                    ? t('watermark.pluginTemplateImage')
                    : t('watermark.pluginTemplateText')}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          <input
            type="text"
            value={templateName}
            onChange={(e) => setTemplateName(e.target.value)}
            placeholder={t('watermark.templateNamePlaceholder')}
            className="input-field flex-1 text-sm"
          />
          <button
            className="btn-secondary text-sm whitespace-nowrap"
            onClick={handleSaveTemplate}
            disabled={loading || !templateName.trim()}
            aria-label={t('watermark.saveTemplateAria')}
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
