import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { IconImport, IconImage, IconVideo, IconClose } from '../../icons'
import { formatSize } from '../../utils/format'
import { formatTimestamp } from '../../utils/date'
import { BaseDialog } from '../common/BaseDialog'

// T14：本地类型声明（与主进程接口保持一致）
interface ImportFilePreview {
  sourcePath: string
  fileName: string
  size: number
  mtime: string
  ext: string
  isVideo: boolean
}
type ImportNamingRule = 'keep' | 'date' | 'seq'
type ImportCategorize = 'flat' | 'byDate' | 'byMonth'
type ImportConflictStrategy = 'skip' | 'rename' | 'overwrite'

interface ImportWizardProps {
  open: boolean
  onClose: () => void
}

type Step = 1 | 2 | 3

const NAMING_OPTIONS: { id: ImportNamingRule; labelKey: string; descKey: string }[] = [
  {
    id: 'keep',
    labelKey: 'gallery.import.naming.keep.label',
    descKey: 'gallery.import.naming.keep.desc'
  },
  {
    id: 'date',
    labelKey: 'gallery.import.naming.date.label',
    descKey: 'gallery.import.naming.date.desc'
  },
  {
    id: 'seq',
    labelKey: 'gallery.import.naming.seq.label',
    descKey: 'gallery.import.naming.seq.desc'
  }
]

const CATEGORIZE_OPTIONS: { id: ImportCategorize; labelKey: string; descKey: string }[] = [
  {
    id: 'flat',
    labelKey: 'gallery.import.categorize.flat.label',
    descKey: 'gallery.import.categorize.flat.desc'
  },
  {
    id: 'byDate',
    labelKey: 'gallery.import.categorize.byDate.label',
    descKey: 'gallery.import.categorize.byDate.desc'
  },
  {
    id: 'byMonth',
    labelKey: 'gallery.import.categorize.byMonth.label',
    descKey: 'gallery.import.categorize.byMonth.desc'
  }
]

const CONFLICT_OPTIONS: { id: ImportConflictStrategy; labelKey: string; descKey: string }[] = [
  {
    id: 'skip',
    labelKey: 'gallery.import.conflict.skip.label',
    descKey: 'gallery.import.conflict.skip.desc'
  },
  {
    id: 'rename',
    labelKey: 'gallery.import.conflict.rename.label',
    descKey: 'gallery.import.conflict.rename.desc'
  },
  {
    id: 'overwrite',
    labelKey: 'gallery.import.conflict.overwrite.label',
    descKey: 'gallery.import.conflict.overwrite.desc'
  }
]

// P1-I：formatSize 和 formatTimestamp 已统一到 utils/format.ts 和 utils/date.ts

export const ImportWizard: React.FC<ImportWizardProps> = ({ open, onClose }) => {
  const { t } = useTranslation()
  const [step, setStep] = useState<Step>(1)
  const [sourceDir, setSourceDir] = useState('')
  const [targetDir, setTargetDir] = useState('')
  const [previewFiles, setPreviewFiles] = useState<ImportFilePreview[]>([])
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [namingRule, setNamingRule] = useState<ImportNamingRule>('keep')
  const [categorize, setCategorize] = useState<ImportCategorize>('flat')
  const [conflictStrategy, setConflictStrategy] = useState<ImportConflictStrategy>('rename')
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState<{ current: number; total: number }>({
    current: 0,
    total: 0
  })
  const [result, setResult] = useState<{
    imported: Array<{ sourcePath: string; targetPath: string }>
    failed: Array<{ sourcePath: string; message: string }>
    skipped: Array<{ sourcePath: string; reason: string }>
  } | null>(null)
  const [error, setError] = useState('')

  // 进度回调
  useEffect(() => {
    if (!open || !window.electronAPI?.import?.onProgress) return
    const off = window.electronAPI.import.onProgress((p) => {
      setProgress(p)
    })
    return off
  }, [open])

  // 重置状态
  useEffect(() => {
    if (open) {
      setStep(1)
      setSourceDir('')
      setTargetDir('')
      setPreviewFiles([])
      setSelectedPaths(new Set())
      setNamingRule('keep')
      setCategorize('flat')
      setConflictStrategy('rename')
      setLoading(false)
      setImporting(false)
      setProgress({ current: 0, total: 0 })
      setResult(null)
      setError('')
    }
  }, [open])

  const handleSelectSource = async () => {
    const dir = await window.electronAPI?.dialog?.selectDirectory()
    if (!dir) return
    setSourceDir(dir)
    await loadPreview(dir)
  }

  const handleSelectTarget = async () => {
    const dir = await window.electronAPI?.dialog?.selectDirectory()
    if (dir) setTargetDir(dir)
  }

  const loadPreview = useCallback(
    async (dir: string) => {
      if (!window.electronAPI?.import?.preview) return
      setLoading(true)
      setError('')
      try {
        const res = await window.electronAPI.import.preview(dir)
        if (res?.success && Array.isArray(res.files)) {
          setPreviewFiles(res.files)
          // 默认全选
          setSelectedPaths(new Set(res.files.map((f) => f.sourcePath)))
        } else {
          setPreviewFiles([])
          // 预览失败时清空选中集，避免旧选中残留造成状态不一致
          setSelectedPaths(new Set())
          setError(res?.message || t('gallery.import.errors.readSourceFailed'))
        }
      } catch (err) {
        setPreviewFiles([])
        setSelectedPaths(new Set())
        setError(err instanceof Error ? err.message : t('gallery.import.errors.loadFailed'))
      } finally {
        setLoading(false)
      }
    },
    [t]
  )

  const toggleSelect = (path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selectedPaths.size === previewFiles.length) {
      setSelectedPaths(new Set())
    } else {
      setSelectedPaths(new Set(previewFiles.map((f) => f.sourcePath)))
    }
  }

  const totalSize = useMemo(() => {
    return previewFiles
      .filter((f) => selectedPaths.has(f.sourcePath))
      .reduce((sum, f) => sum + f.size, 0)
  }, [previewFiles, selectedPaths])

  const handleStartImport = async () => {
    if (!window.electronAPI?.import?.run || !targetDir || selectedPaths.size === 0) return
    setImporting(true)
    setError('')
    setResult(null)
    setProgress({ current: 0, total: selectedPaths.size })
    try {
      const res = await window.electronAPI.import.run(Array.from(selectedPaths), targetDir, {
        namingRule,
        categorize,
        conflictStrategy
      })
      if (res) {
        setResult({
          imported: res.imported || [],
          failed: res.failed || [],
          skipped: res.skipped || []
        })
        if (res.warnings && res.warnings.length > 0) {
          setError(res.warnings.join('; '))
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('gallery.import.errors.importFailed'))
    } finally {
      setImporting(false)
    }
  }

  const canProceedToStep2 = sourceDir && previewFiles.length > 0 && !loading
  // 步骤 2 → 3 仅要求已选中文件（目标目录在步骤 3 才选择，不能作为本步放行条件）
  const canProceedFromStep2 = selectedPaths.size > 0 && !loading
  const canProceedToStep3 = targetDir && selectedPaths.size > 0

  return (
    <BaseDialog
      open={open}
      onClose={onClose}
      ariaLabelledby="import-wizard-title"
      cardClassName="!w-[680px] !max-w-[90vw] max-h-[90vh] overflow-y-auto"
    >
      {/* 标题与步骤指示 */}
      <div className="flex items-center justify-between">
        <div>
          <h3
            id="import-wizard-title"
            className="text-lg font-semibold"
            style={{ color: 'var(--text-primary)' }}
          >
            {t('gallery.import.title')}
          </h3>
          <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
            {step === 1 && t('gallery.import.step1')}
            {step === 2 && t('gallery.import.step2')}
            {step === 3 && t('gallery.import.step3')}
          </p>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label={t('common.close')}>
          <IconClose size={18} />
        </button>
      </div>

      {/* 步骤进度条 */}
      <div className="flex items-center gap-2">
        {[1, 2, 3].map((s) => (
          <div
            key={s}
            className="flex-1 h-1 rounded-full transition-colors"
            style={{
              background: s <= step ? 'var(--accent)' : 'var(--bg-tertiary)'
            }}
          />
        ))}
      </div>

      {error && (
        <div
          className="p-3 rounded-lg text-xs"
          style={{
            background: 'var(--danger-bg)',
            color: 'var(--danger-hover)'
          }}
        >
          {error}
        </div>
      )}

      {/* 步骤 1：选择源目录 */}
      {step === 1 && (
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
              {t('gallery.import.sourceDirLabel')}
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={sourceDir}
                onChange={(e) => {
                  setSourceDir(e.target.value)
                  // 手动改路径后旧预览立即失效：清空文件列表与选中集，避免按钮状态脱节
                  setPreviewFiles([])
                  setSelectedPaths(new Set())
                }}
                placeholder={t('gallery.import.sourceDirPlaceholder')}
                className="input-field flex-1"
                style={{
                  padding: '8px 12px',
                  borderRadius: '8px',
                  border: '1px solid var(--divider)',
                  background: 'var(--bg-tertiary)',
                  color: 'var(--text-primary)'
                }}
              />
              <button className="btn-secondary text-xs px-3 py-1.5" onClick={handleSelectSource}>
                {t('gallery.import.browse')}
              </button>
            </div>
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('gallery.import.scanHint')}
            </p>
          </div>

          {loading && (
            <div className="py-8 text-center">
              <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                {t('gallery.import.scanning')}
              </div>
            </div>
          )}

          {previewFiles.length > 0 && (
            <div className="p-3 rounded-lg space-y-2" style={{ background: 'var(--bg-tertiary)' }}>
              <div className="flex items-center justify-between text-xs">
                <span style={{ color: 'var(--text-secondary)' }}>
                  {t('gallery.import.scanResult')}
                </span>
                <span style={{ color: 'var(--text-tertiary)' }}>
                  {t('gallery.import.scanSummary', {
                    count: previewFiles.length,
                    size: formatSize(previewFiles.reduce((s, f) => s + f.size, 0))
                  })}
                </span>
              </div>
              <div className="flex gap-3 text-xs">
                <span className="flex items-center gap-1" style={{ color: 'var(--text-primary)' }}>
                  <IconImage size={14} />
                  {t('gallery.import.imagesCount', {
                    count: previewFiles.filter((f) => !f.isVideo).length
                  })}
                </span>
                <span className="flex items-center gap-1" style={{ color: 'var(--text-primary)' }}>
                  <IconVideo size={14} />
                  {t('gallery.import.videosCount', {
                    count: previewFiles.filter((f) => f.isVideo).length
                  })}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 步骤 2：预览并选择文件 */}
      {step === 2 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {t('gallery.import.selectionSummary', {
                selected: selectedPaths.size,
                total: previewFiles.length,
                size: formatSize(totalSize)
              })}
            </span>
            <button className="btn-secondary text-xs px-2 py-1" onClick={toggleSelectAll}>
              {selectedPaths.size === previewFiles.length
                ? t('gallery.import.deselectAll')
                : t('common.selectAll')}
            </button>
          </div>
          <div
            className="border rounded-lg max-h-[300px] overflow-y-auto"
            style={{ borderColor: 'var(--divider)' }}
          >
            {previewFiles.map((file) => {
              const checked = selectedPaths.has(file.sourcePath)
              return (
                <label
                  key={file.sourcePath}
                  className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-opacity-50 transition-colors"
                  style={{
                    borderBottom: '1px solid var(--divider)',
                    background: checked ? 'rgba(255, 184, 0, 0.06)' : 'transparent'
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleSelect(file.sourcePath)}
                    className="flex-shrink-0"
                  />
                  <div className="flex-shrink-0">
                    {file.isVideo ? <IconVideo size={16} /> : <IconImage size={16} />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div
                      className="text-xs font-mono truncate"
                      style={{ color: 'var(--text-primary)' }}
                      title={file.fileName}
                    >
                      {file.fileName}
                    </div>
                    <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      {formatTimestamp(file.mtime)} · {formatSize(file.size)}
                    </div>
                  </div>
                </label>
              )
            })}
          </div>
        </div>
      )}

      {/* 步骤 3：配置规则并导入 */}
      {step === 3 && (
        <div className="space-y-4">
          {/* 导入进度 */}
          {importing && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span style={{ color: 'var(--text-secondary)' }}>
                  {t('gallery.import.importing')}
                </span>
                <span style={{ color: 'var(--text-tertiary)' }}>
                  {t('gallery.import.progressLabel', {
                    current: progress.current,
                    total: progress.total
                  })}
                </span>
              </div>
              <div
                className="h-2 rounded-full overflow-hidden"
                style={{ background: 'var(--bg-tertiary)' }}
              >
                <div
                  className="h-full transition-all"
                  style={{
                    width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%`,
                    background: 'var(--accent)'
                  }}
                />
              </div>
            </div>
          )}

          {/* 导入结果 */}
          {result && (
            <div className="grid grid-cols-3 gap-2">
              <div
                className="p-3 rounded-lg text-center"
                style={{ background: 'rgba(34, 197, 94, 0.12)' }}
              >
                <div className="text-lg font-semibold" style={{ color: 'var(--success-deep)' }}>
                  {result.imported.length}
                </div>
                <div className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                  {t('gallery.import.resultImported')}
                </div>
              </div>
              <div
                className="p-3 rounded-lg text-center"
                style={{ background: 'rgba(234, 88, 12, 0.12)' }}
              >
                <div className="text-lg font-semibold" style={{ color: 'var(--warning-text)' }}>
                  {result.skipped.length}
                </div>
                <div className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                  {t('gallery.import.resultSkipped')}
                </div>
              </div>
              <div
                className="p-3 rounded-lg text-center"
                style={{ background: 'var(--danger-bg)' }}
              >
                <div className="text-lg font-semibold" style={{ color: 'var(--danger-hover)' }}>
                  {result.failed.length}
                </div>
                <div className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                  {t('common.failed')}
                </div>
              </div>
            </div>
          )}

          {result && result.imported.length > 0 && (
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('gallery.import.indexingHint')}
            </p>
          )}

          {!importing && !result && (
            <>
              {/* 目标目录 */}
              <div className="space-y-2">
                <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                  {t('gallery.import.targetDirLabel')}
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={targetDir}
                    onChange={(e) => setTargetDir(e.target.value)}
                    placeholder={t('gallery.import.targetDirPlaceholder')}
                    className="input-field flex-1"
                    style={{
                      padding: '8px 12px',
                      borderRadius: '8px',
                      border: '1px solid var(--divider)',
                      background: 'var(--bg-tertiary)',
                      color: 'var(--text-primary)'
                    }}
                  />
                  <button
                    className="btn-secondary text-xs px-3 py-1.5"
                    onClick={handleSelectTarget}
                  >
                    {t('gallery.import.browse')}
                  </button>
                </div>
              </div>

              {/* 命名规则 */}
              <div className="space-y-2">
                <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                  {t('gallery.import.namingRuleLabel')}
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {NAMING_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      onClick={() => setNamingRule(opt.id)}
                      className="p-2 rounded-lg text-left transition-all"
                      style={{
                        border: `1px solid ${namingRule === opt.id ? 'var(--accent)' : 'var(--divider)'}`,
                        background:
                          namingRule === opt.id ? 'rgba(255, 184, 0, 0.08)' : 'var(--bg-tertiary)'
                      }}
                    >
                      <div className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                        {t(opt.labelKey)}
                      </div>
                      <div className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                        {t(opt.descKey)}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* 分类策略 */}
              <div className="space-y-2">
                <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                  {t('gallery.import.categorizeLabel')}
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {CATEGORIZE_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      onClick={() => setCategorize(opt.id)}
                      className="p-2 rounded-lg text-left transition-all"
                      style={{
                        border: `1px solid ${categorize === opt.id ? 'var(--accent)' : 'var(--divider)'}`,
                        background:
                          categorize === opt.id ? 'rgba(255, 184, 0, 0.08)' : 'var(--bg-tertiary)'
                      }}
                    >
                      <div className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                        {t(opt.labelKey)}
                      </div>
                      <div className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                        {t(opt.descKey)}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* 冲突处理 */}
              <div className="space-y-2">
                <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                  {t('gallery.import.conflictLabel')}
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {CONFLICT_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      onClick={() => setConflictStrategy(opt.id)}
                      className="p-2 rounded-lg text-left transition-all"
                      style={{
                        border: `1px solid ${conflictStrategy === opt.id ? 'var(--accent)' : 'var(--divider)'}`,
                        background:
                          conflictStrategy === opt.id
                            ? 'rgba(255, 184, 0, 0.08)'
                            : 'var(--bg-tertiary)'
                      }}
                    >
                      <div className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                        {t(opt.labelKey)}
                      </div>
                      <div className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                        {t(opt.descKey)}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* 摘要 */}
              <div
                className="p-3 rounded-lg text-xs space-y-1"
                style={{ background: 'var(--bg-tertiary)' }}
              >
                <div className="flex justify-between">
                  <span style={{ color: 'var(--text-tertiary)' }}>
                    {t('gallery.import.summaryFiles')}
                  </span>
                  <span style={{ color: 'var(--text-primary)' }}>
                    {t('gallery.import.summaryFilesValue', {
                      count: selectedPaths.size,
                      size: formatSize(totalSize)
                    })}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span style={{ color: 'var(--text-tertiary)' }}>
                    {t('gallery.import.summaryDiskSpace')}
                  </span>
                  <span style={{ color: 'var(--text-primary)' }}>{formatSize(totalSize)}</span>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* 底部按钮 */}
      <div
        className="flex items-center justify-between pt-2"
        style={{ borderTop: '1px solid var(--divider)' }}
      >
        <div className="flex gap-2">
          {step > 1 && !importing && !result && (
            <button
              className="btn-secondary text-sm px-4 py-1.5"
              onClick={() => setStep((step - 1) as Step)}
            >
              {t('gallery.import.prevStep')}
            </button>
          )}
        </div>
        <div className="flex gap-2">
          <button className="btn-secondary text-sm px-4 py-1.5" onClick={onClose}>
            {result ? t('common.close') : t('common.cancel')}
          </button>
          {step === 1 && (
            <button
              className="btn-primary text-sm px-4 py-1.5"
              disabled={!canProceedToStep2}
              onClick={() => setStep(2)}
            >
              {t('gallery.import.nextStep')}
            </button>
          )}
          {step === 2 && (
            <button
              className="btn-primary text-sm px-4 py-1.5"
              disabled={!canProceedFromStep2}
              onClick={() => setStep(3)}
            >
              {t('gallery.import.nextStep')}
            </button>
          )}
          {step === 3 && !importing && !result && (
            <button
              className="btn-primary text-sm px-4 py-1.5 flex items-center gap-1.5"
              disabled={!canProceedToStep3}
              onClick={handleStartImport}
            >
              <IconImport size={16} />
              {t('gallery.import.startImport')}
            </button>
          )}
          {result && (
            <button
              className="btn-primary text-sm px-4 py-1.5"
              onClick={() => {
                onClose()
              }}
            >
              {t('gallery.import.finish')}
            </button>
          )}
        </div>
      </div>
    </BaseDialog>
  )
}
