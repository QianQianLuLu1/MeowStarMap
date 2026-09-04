import React from 'react'
import { useTranslation } from 'react-i18next'
import {
  IconUndo,
  IconRedo,
  IconReset,
  IconCompare,
  IconSplitCompare,
  IconHelp,
  IconFullscreen,
  IconFullscreenExit,
  IconCopy,
  IconPaste,
  IconImage
} from '../../icons'

interface EditorToolbarProps {
  canUndo: boolean
  canRedo: boolean
  compareMode: boolean
  splitCompareMode: boolean
  isFullscreen: boolean
  saving: boolean
  loading: boolean
  canPaste: boolean
  // F-S7 批量编辑：选中图片数量（不含当前编辑的图片）。>0 时显示"应用到选中"按钮
  applyToSelectedCount: number
  batchApplying: boolean
  // XMP 元数据导出中标志（避免重复点击）
  exportingWithMetadata: boolean
  onUndo: () => void
  onRedo: () => void
  onReset: () => void
  onCompareStart: () => void
  onCompareEnd: () => void
  onToggleSplitCompare: () => void
  onToggleShortcuts: () => void
  onToggleFullscreen: () => void
  onExit: () => void
  onSaveAs: () => void
  onSave: () => void
  onCopyParams: () => void
  onPasteParams: () => void
  onApplyToSelected: () => void
  // XMP 元数据：导出含编辑参数的副本（不修改原图）
  onExportWithMetadata: () => void
}

export const EditorToolbar: React.FC<EditorToolbarProps> = ({
  canUndo,
  canRedo,
  compareMode,
  splitCompareMode,
  isFullscreen,
  saving,
  loading,
  canPaste,
  applyToSelectedCount,
  batchApplying,
  exportingWithMetadata,
  onUndo,
  onRedo,
  onReset,
  onCompareStart,
  onCompareEnd,
  onToggleSplitCompare,
  onToggleShortcuts,
  onToggleFullscreen,
  onExit,
  onSaveAs,
  onSave,
  onCopyParams,
  onPasteParams,
  onApplyToSelected,
  onExportWithMetadata
}) => {
  const { t } = useTranslation()
  return (
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-2">
        <button
          className="icon-btn"
          onClick={onUndo}
          disabled={!canUndo}
          title={t('editor.toolbar.undo')}
          aria-label={t('editor.toolbar.undo')}
        >
          <IconUndo size={18} />
        </button>
        <button
          className="icon-btn"
          onClick={onRedo}
          disabled={!canRedo}
          title={t('editor.toolbar.redo')}
          aria-label={t('editor.toolbar.redo')}
        >
          <IconRedo size={18} />
        </button>
        <button
          className="icon-btn"
          onClick={onReset}
          title={t('editor.toolbar.reset')}
          aria-label={t('editor.toolbar.reset')}
        >
          <IconReset size={18} />
        </button>
        <div className="w-px h-5 mx-1" style={{ background: 'var(--divider)' }} />
        <button
          className={`icon-btn ${compareMode ? 'active' : ''}`}
          onMouseDown={onCompareStart}
          onMouseUp={onCompareEnd}
          onMouseLeave={onCompareEnd}
          title={t('editor.toolbar.compareHold')}
          aria-label={t('editor.toolbar.compareHold')}
        >
          <IconCompare size={18} />
          {t('editor.toolbar.compare')}
        </button>
        <button
          className={`icon-btn ${splitCompareMode ? 'active' : ''}`}
          onClick={onToggleSplitCompare}
          title={t('editor.toolbar.splitCompareTooltip')}
          aria-label={t('editor.toolbar.splitCompareAria')}
          aria-pressed={splitCompareMode}
        >
          <IconSplitCompare size={18} />
          {t('editor.toolbar.splitCompare')}
        </button>
        <div className="w-px h-5 mx-1" style={{ background: 'var(--divider)' }} />
        <button
          className="icon-btn"
          onClick={onCopyParams}
          title={t('editor.toolbar.copyParams')}
          aria-label={t('editor.toolbar.copyParams')}
        >
          <IconCopy size={18} />
        </button>
        <button
          className="icon-btn"
          onClick={onPasteParams}
          disabled={!canPaste}
          title={t('editor.toolbar.pasteParams')}
          aria-label={t('editor.toolbar.pasteParams')}
        >
          <IconPaste size={18} />
        </button>
        {applyToSelectedCount > 0 && (
          <>
            <div className="w-px h-5 mx-1" style={{ background: 'var(--divider)' }} />
            <button
              className="icon-btn"
              onClick={onApplyToSelected}
              disabled={batchApplying || saving || loading}
              title={t('editor.toolbar.applyToSelectedTooltip', { count: applyToSelectedCount })}
              aria-label={t('editor.toolbar.applyToSelectedAria', { count: applyToSelectedCount })}
            >
              <IconImage size={18} />
              {batchApplying
                ? t('editor.toolbar.applying')
                : t('editor.toolbar.applyToSelected', { count: applyToSelectedCount })}
            </button>
          </>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          className="icon-btn"
          onClick={onToggleShortcuts}
          title={t('editor.toolbar.shortcuts')}
          aria-label={t('editor.toolbar.shortcuts')}
        >
          <IconHelp size={18} />
        </button>
        <button
          className="icon-btn"
          onClick={onToggleFullscreen}
          title={
            isFullscreen ? t('editor.toolbar.fullscreenExit') : t('editor.toolbar.fullscreenEnter')
          }
          aria-label={
            isFullscreen
              ? t('editor.toolbar.fullscreenExitAria')
              : t('editor.toolbar.fullscreenEnterAria')
          }
        >
          {isFullscreen ? <IconFullscreenExit size={18} /> : <IconFullscreen size={18} />}
        </button>
        <button className="btn-secondary" onClick={onExit}>
          {t('editor.toolbar.back')}
        </button>
        <button className="btn-secondary" onClick={onSaveAs} disabled={saving}>
          {t('editor.toolbar.saveAs')}
        </button>
        <button
          className="btn-secondary"
          onClick={onExportWithMetadata}
          disabled={saving || loading || exportingWithMetadata || batchApplying}
          title={t('editor.toolbar.exportWithMetadataTooltip')}
          aria-label={t('editor.toolbar.exportWithMetadata')}
        >
          {exportingWithMetadata
            ? t('editor.toolbar.exportingWithMetadata')
            : t('editor.toolbar.exportWithMetadata')}
        </button>
        <button className="btn-primary" onClick={onSave} disabled={saving || loading}>
          {saving ? t('editor.toolbar.saving') : t('editor.toolbar.save')}
        </button>
      </div>
    </div>
  )
}
