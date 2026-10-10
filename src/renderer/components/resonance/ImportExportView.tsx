import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { useGlobalToast } from '../../pages/settings/shared'
import {
  clearAllResonanceData,
  commitPendingImport,
  exportResonanceData,
  previewImport,
  useResonanceStore,
  type ResonancePreviewSummary
} from '../../stores/resonanceStore'
import { ImportStructureError } from '../../utils/resonance/importParse'
import { getResonanceExportFileName } from '../../utils/resonance/exportPayload'
import { loadSnapshotMeta, type SnapshotMeta } from '../../utils/resonance/staticData'

/**
 * 导入数据子页：本地 JSON 文件导入（解析预览 → 确认提交，分批进度 + 可取消）
 * + 数据导出（内容勾选 + 系统保存对话框）+ 危险区（清空全部）。
 * 全程本地文件与本地 SQLite，零联网。
 */

interface ExportOptions {
  includePulls: boolean
  includeEdits: boolean
  includePearpal: boolean
  includeEvo: boolean
  includeWardrobe: boolean
  includeWishlist: boolean
}

const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  includePulls: true,
  includeEdits: true,
  includePearpal: true,
  includeEvo: true,
  includeWardrobe: true,
  includeWishlist: true
}

const SECTION_KEYS = [
  { key: 'pulls', labelKey: 'resonance.import.sectionPulls' },
  { key: 'edits', labelKey: 'resonance.import.sectionEdits' },
  { key: 'pearpal', labelKey: 'resonance.import.sectionPearpal' },
  { key: 'evo', labelKey: 'resonance.import.sectionEvo' },
  { key: 'wardrobe', labelKey: 'resonance.import.sectionWardrobe' }
] as const

function formatError(error: unknown, t: (key: string) => string): string {
  if (error instanceof ImportStructureError) return t(error.message)
  return error instanceof Error ? error.message : String(error)
}

export const ImportExportView: React.FC = () => {
  const { t } = useTranslation()
  const showMessage = useGlobalToast()
  const importRunning = useResonanceStore((s) => s.importRunning)
  const importProgress = useResonanceStore((s) => s.importProgress)

  const [summary, setSummary] = useState<ResonancePreviewSummary | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [includeWardrobe, setIncludeWardrobe] = useState(true)
  const [includeWishlist, setIncludeWishlist] = useState(true)
  const [exportOptions, setExportOptions] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS)
  const [exporting, setExporting] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  const [snapshotMeta, setSnapshotMeta] = useState<SnapshotMeta | null>(null)
  const cancelRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    void loadSnapshotMeta().then((meta) => {
      if (!cancelled) setSnapshotMeta(meta)
    })
    // 离开导入页时丢弃未提交的预览（提交时消费；重新进入需重新选文件）
    return () => {
      cancelled = true
      useResonanceStore.getState().setPendingImport(null)
    }
  }, [])

  const clearPreview = (): void => {
    setSummary(null)
    useResonanceStore.getState().setPendingImport(null)
  }

  // ============ 导入 ============

  const handlePickFile = async (): Promise<void> => {
    if (previewing || importRunning) return
    let filePath: string | null = null
    try {
      filePath =
        (await window.electronAPI?.dialog?.openFile({
          properties: ['openFile'],
          filters: [{ name: 'JSON', extensions: ['json'] }]
        })) ?? null
    } catch (error) {
      showMessage(formatError(error, t), 'error')
      return
    }
    if (!filePath) return
    clearPreview()
    setPreviewing(true)
    try {
      setSummary(await previewImport(filePath))
    } catch (error) {
      showMessage(formatError(error, t), 'error')
    } finally {
      setPreviewing(false)
    }
  }

  const handleCommit = async (): Promise<void> => {
    if (importRunning) return
    cancelRef.current = false
    try {
      const imported = await commitPendingImport({
        includeWardrobe,
        includeWishlist,
        isCancelled: () => cancelRef.current
      })
      if (cancelRef.current) {
        showMessage(t('resonance.import.cancelled'), 'success')
      } else {
        showMessage(t('resonance.import.commitDone', { count: imported }), 'success')
      }
      clearPreview()
    } catch (error) {
      showMessage(formatError(error, t), 'error')
    } finally {
      cancelRef.current = false
    }
  }

  // ============ 导出 ============

  const handleExport = async (): Promise<void> => {
    if (exporting) return
    const anySelected = Object.values(exportOptions).some(Boolean)
    if (!anySelected) {
      showMessage(t('resonance.import.exportNothing'), 'error')
      return
    }
    setExporting(true)
    try {
      const filePath = await window.electronAPI?.dialog?.saveFile({
        defaultPath: getResonanceExportFileName(),
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
      if (!filePath) return
      const result = await exportResonanceData({ filePath, ...exportOptions })
      if (result) {
        showMessage(t('resonance.import.exportDone', { count: result.recordCount }), 'success')
      } else {
        showMessage(t('resonance.import.exportNothing'), 'error')
      }
    } catch (error) {
      showMessage(formatError(error, t), 'error')
    } finally {
      setExporting(false)
    }
  }

  // ============ 清空 ============

  const handleClearAll = async (): Promise<void> => {
    try {
      await clearAllResonanceData()
      setSummary(null)
      showMessage(t('resonance.import.clearDone'), 'success')
    } catch (error) {
      showMessage(formatError(error, t), 'error')
    }
  }

  const progressPercent =
    importProgress && importProgress.total > 0
      ? Math.min(Math.round((importProgress.current / importProgress.total) * 100), 100)
      : 0

  const exportCheckboxes: Array<{ key: keyof ExportOptions; labelKey: string }> = [
    { key: 'includePulls', labelKey: 'resonance.import.exportPulls' },
    { key: 'includeEdits', labelKey: 'resonance.import.exportEdits' },
    { key: 'includePearpal', labelKey: 'resonance.import.exportPearpal' },
    { key: 'includeEvo', labelKey: 'resonance.import.exportEvo' },
    { key: 'includeWardrobe', labelKey: 'resonance.import.exportWardrobe' },
    { key: 'includeWishlist', labelKey: 'resonance.import.exportWishlist' }
  ]

  return (
    <div className="h-full flex flex-col gap-4 min-h-0 overflow-y-auto pr-1">
      {/* 导入区 */}
      <section className="rounded-xl p-4 space-y-3" style={{ background: 'var(--bg-tertiary)' }}>
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            {t('resonance.import.importSection')}
          </h3>
          <div className="flex-1" />
          <button
            type="button"
            className="btn-primary"
            onClick={() => void handlePickFile()}
            disabled={previewing || importRunning}
          >
            {t('resonance.import.pickFile')}
          </button>
        </div>

        {previewing && (
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {t('resonance.import.previewing')}
          </p>
        )}

        {summary && (
          <div className="space-y-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className="px-1.5 py-0.5 rounded text-xs"
                style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
              >
                {summary.format === 'legacy'
                  ? t('resonance.import.formatLegacy')
                  : t('resonance.import.formatCurrent')}
              </span>
              <span className="text-xs">
                {summary.version !== null
                  ? t('resonance.import.versionLabel', { version: summary.version })
                  : t('resonance.import.versionUnknown')}
              </span>
            </div>

            {summary.versionMismatch && (
              <p
                className="text-xs rounded-lg px-2 py-1.5"
                style={{
                  background: 'var(--warning-bg, var(--bg-secondary))',
                  color: 'var(--warning, var(--text-primary))'
                }}
              >
                {t('resonance.import.versionMismatchWarn')}
              </p>
            )}

            <div className="flex items-center gap-2 flex-wrap">
              {SECTION_KEYS.filter((section) => summary.sections[section.key]).map((section) => (
                <span
                  key={section.key}
                  className="px-1.5 py-0.5 rounded text-xs"
                  style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                >
                  {t(section.labelKey)}
                </span>
              ))}
            </div>

            <div className="flex items-center gap-2 flex-wrap text-xs">
              <span style={{ color: 'var(--success, var(--text-primary))' }}>
                {t('resonance.import.countsAdded', { count: summary.counts.added })}
              </span>
              <span style={{ color: 'var(--text-tertiary)' }}>
                {t('resonance.import.countsDuplicate', { count: summary.counts.duplicate })}
              </span>
              {summary.counts.invalid > 0 && (
                <span style={{ color: 'var(--warning, var(--text-primary))' }}>
                  {t('resonance.import.countsInvalid', { count: summary.counts.invalid })}
                </span>
              )}
            </div>

            {summary.invalidSamples.length > 0 && (
              <div
                className="text-xs rounded-lg px-2 py-1.5 space-y-0.5"
                style={{ background: 'var(--bg-secondary)' }}
              >
                <p style={{ color: 'var(--text-primary)' }}>
                  {t('resonance.import.invalidSamplesTitle')}
                </p>
                {summary.invalidSamples.map((sample, index) => (
                  <p key={`${sample.location}-${index}`} style={{ color: 'var(--text-tertiary)' }}>
                    {sample.location} · {t(`resonance.error.invalidReason.${sample.reason}`)}
                  </p>
                ))}
                {summary.counts.invalid > summary.invalidSamples.length && (
                  <p style={{ color: 'var(--text-tertiary)' }}>
                    {t('resonance.import.invalidMore', {
                      count: summary.counts.invalid - summary.invalidSamples.length
                    })}
                  </p>
                )}
              </div>
            )}

            {summary.sections.wardrobe && (
              <label
                className="flex items-center gap-2 cursor-pointer"
                style={{ color: 'var(--text-primary)' }}
              >
                <input
                  type="checkbox"
                  className="w-4 h-4"
                  style={{ accentColor: 'var(--accent)' }}
                  checked={includeWardrobe}
                  onChange={(e) => setIncludeWardrobe(e.target.checked)}
                />
                {t('resonance.import.includeWardrobeLabel')}
              </label>
            )}

            {summary.sections.wishlist && (
              <label
                className="flex items-center gap-2 cursor-pointer"
                style={{ color: 'var(--text-primary)' }}
              >
                <input
                  type="checkbox"
                  className="w-4 h-4"
                  style={{ accentColor: 'var(--accent)' }}
                  checked={includeWishlist}
                  onChange={(e) => setIncludeWishlist(e.target.checked)}
                />
                {t('resonance.import.includeWishlistLabel')}
              </label>
            )}

            {summary.versionMismatch ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => void handleCommit()}
                  disabled={importRunning}
                >
                  {t('resonance.import.compatImport')}
                </button>
                <button type="button" className="btn-secondary" onClick={clearPreview}>
                  {t('resonance.import.abandon')}
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => void handleCommit()}
                  disabled={importRunning}
                >
                  {t('resonance.import.commit')}
                </button>
                <button type="button" className="btn-secondary" onClick={clearPreview}>
                  {t('common.cancel')}
                </button>
              </div>
            )}
          </div>
        )}

        {/* 提交进度（分批写入） */}
        {importRunning && importProgress && (
          <div className="space-y-1.5">
            <div
              className="h-2 rounded-full overflow-hidden"
              style={{ background: 'var(--bg-secondary)' }}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progressPercent}
            >
              <div
                className="h-full rounded-full"
                style={{ width: `${progressPercent}%`, background: 'var(--accent)' }}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                {t('resonance.import.progressLabel', {
                  current: importProgress.current,
                  total: importProgress.total
                })}
              </span>
              <button
                type="button"
                className="btn-secondary text-xs px-2 py-1"
                onClick={() => {
                  cancelRef.current = true
                }}
              >
                {t('resonance.import.cancelCommit')}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* 导出区 */}
      <section className="rounded-xl p-4 space-y-3" style={{ background: 'var(--bg-tertiary)' }}>
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          {t('resonance.import.exportSection')}
        </h3>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {exportCheckboxes.map((option) => (
            <label
              key={option.key}
              className="flex items-center gap-2 text-sm cursor-pointer"
              style={{ color: 'var(--text-secondary)' }}
            >
              <input
                type="checkbox"
                className="w-4 h-4"
                style={{ accentColor: 'var(--accent)' }}
                checked={exportOptions[option.key]}
                onChange={(e) =>
                  setExportOptions((prev) => ({ ...prev, [option.key]: e.target.checked }))
                }
              />
              {t(option.labelKey)}
            </label>
          ))}
        </div>
        <button
          type="button"
          className="btn-primary"
          onClick={() => void handleExport()}
          disabled={exporting}
        >
          {t('resonance.import.exportButton')}
        </button>
      </section>

      {/* 危险区 */}
      <section className="rounded-xl p-4 space-y-3" style={{ background: 'var(--bg-tertiary)' }}>
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          {t('resonance.import.dangerSection')}
        </h3>
        <button type="button" className="btn-danger" onClick={() => setClearOpen(true)}>
          {t('resonance.import.clearButton')}
        </button>
      </section>

      {/* 快照标注 */}
      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
        {snapshotMeta
          ? t('resonance.import.snapshotMeta', {
              version: snapshotMeta.gameVersion ?? '—',
              catalogDate: snapshotMeta.catalogGeneratedAt ?? '—',
              percentileDate: snapshotMeta.percentileGeneratedAt ?? '—'
            })
          : t('resonance.import.snapshotNote')}
      </p>

      <ConfirmDialog
        open={clearOpen}
        title={t('resonance.import.clearTitle')}
        message={t('resonance.import.clearMessage')}
        confirmVariant="danger"
        onConfirm={() => void handleClearAll()}
        onCancel={() => setClearOpen(false)}
      />
    </div>
  )
}
