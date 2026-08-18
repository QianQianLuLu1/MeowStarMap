import React, { useEffect, useState, useContext } from 'react'
import { useTranslation } from 'react-i18next'
import { SectionShell, GlobalToastContext } from './shared'

// ============ 通用 ============

export const GeneralStartupSection: React.FC = () => {
  const { t } = useTranslation()
  const [autoScan, setAutoScan] = useState(true)
  const showMessage = useContext(GlobalToastContext)

  useEffect(() => {
    const load = async () => {
      if (!window.electronAPI) return
      const a = (await window.electronAPI.settings.get('autoScanOnStartup', true)) as boolean
      setAutoScan(a)
    }
    load()
  }, [])

  const saveAutoScan = async (value: boolean) => {
    setAutoScan(value)
    if (window.electronAPI) await window.electronAPI.settings.set('autoScanOnStartup', value)
    showMessage(value ? t('toast.autoScanOn') : t('toast.autoScanOff'))
  }

  return (
    <SectionShell
      title={t('settings.sections.startup')}
      description={t('settings.startup.description')}
    >
      <label className="flex items-center justify-between cursor-pointer">
        <span style={{ color: 'var(--text-primary)' }}>{t('settings.startup.autoScan')}</span>
        <input
          type="checkbox"
          checked={autoScan}
          onChange={(e) => saveAutoScan(e.target.checked)}
          className="w-5 h-5"
        />
      </label>
      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
        {t('settings.startup.autoScanDesc')}
      </p>
    </SectionShell>
  )
}

export const GeneralFileOpsSection: React.FC = () => {
  const { t } = useTranslation()
  const showMessage = useContext(GlobalToastContext)
  // 删除前确认（单文件）
  const [deleteConfirm, setDeleteConfirm] = useState(true)
  // 永久删除二次确认（即便已确认过软删除）
  const [permanentDeleteDoubleConfirm, setPermanentDeleteDoubleConfirm] = useState(true)
  // 批量操作阈值：超过此数量时弹出二次确认
  const [batchThreshold, setBatchThreshold] = useState(10)
  // 批量操作阈值是否启用
  const [batchThresholdEnabled, setBatchThresholdEnabled] = useState(true)
  // 删除时优先使用软删除（移入回收站）而非永久删除
  const [preferSoftDelete, setPreferSoftDelete] = useState(true)

  useEffect(() => {
    const load = async () => {
      if (!window.electronAPI) return
      setDeleteConfirm(
        (await window.electronAPI.settings.get('fileOps.deleteConfirm', true)) as boolean
      )
      setPermanentDeleteDoubleConfirm(
        (await window.electronAPI.settings.get('fileOps.permanentDoubleConfirm', true)) as boolean
      )
      setBatchThreshold(
        (await window.electronAPI.settings.get('fileOps.batchThreshold', 10)) as number
      )
      setBatchThresholdEnabled(
        (await window.electronAPI.settings.get('fileOps.batchThresholdEnabled', true)) as boolean
      )
      setPreferSoftDelete(
        (await window.electronAPI.settings.get('fileOps.preferSoftDelete', true)) as boolean
      )
    }
    load()
  }, [])

  const updateSetting = async (key: string, value: boolean | number, msg: string) => {
    if (window.electronAPI) await window.electronAPI.settings.set(key, value)
    showMessage(msg)
  }

  return (
    <SectionShell
      title={t('settings.sections.fileops')}
      description={t('settings.fileops.description')}
    >
      {/* 删除前确认 */}
      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <div style={{ color: 'var(--text-primary)' }}>{t('settings.fileops.deleteConfirm')}</div>
          <div className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
            {t('settings.fileops.deleteConfirmDesc')}
          </div>
        </div>
        <input
          type="checkbox"
          checked={deleteConfirm}
          onChange={async (e) => {
            setDeleteConfirm(e.target.checked)
            await updateSetting(
              'fileOps.deleteConfirm',
              e.target.checked,
              e.target.checked ? t('toast.deleteConfirmOn') : t('toast.deleteConfirmOff')
            )
          }}
          className="w-5 h-5"
        />
      </label>

      {/* 永久删除二次确认 */}
      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <div style={{ color: 'var(--text-primary)' }}>
            {t('settings.fileops.permanentDoubleConfirm')}
          </div>
          <div className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
            {t('settings.fileops.permanentDoubleConfirmDesc')}
          </div>
        </div>
        <input
          type="checkbox"
          checked={permanentDeleteDoubleConfirm}
          onChange={async (e) => {
            setPermanentDeleteDoubleConfirm(e.target.checked)
            await updateSetting(
              'fileOps.permanentDoubleConfirm',
              e.target.checked,
              e.target.checked
                ? t('toast.permanentDoubleConfirmOn')
                : t('toast.permanentDoubleConfirmOff')
            )
          }}
          className="w-5 h-5"
        />
      </label>

      {/* 优先软删除 */}
      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <div style={{ color: 'var(--text-primary)' }}>
            {t('settings.fileops.preferSoftDelete')}
          </div>
          <div className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
            {t('settings.fileops.preferSoftDeleteDesc')}
          </div>
        </div>
        <input
          type="checkbox"
          checked={preferSoftDelete}
          onChange={async (e) => {
            setPreferSoftDelete(e.target.checked)
            await updateSetting(
              'fileOps.preferSoftDelete',
              e.target.checked,
              e.target.checked ? t('toast.preferSoftDeleteOn') : t('toast.preferSoftDeleteOff')
            )
          }}
          className="w-5 h-5"
        />
      </label>

      {/* 批量操作阈值 */}
      <div className="space-y-2">
        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <div style={{ color: 'var(--text-primary)' }}>
              {t('settings.fileops.batchThreshold')}
            </div>
            <div className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
              {t('settings.fileops.batchThresholdDesc')}
            </div>
          </div>
          <input
            type="checkbox"
            checked={batchThresholdEnabled}
            onChange={async (e) => {
              setBatchThresholdEnabled(e.target.checked)
              await updateSetting(
                'fileOps.batchThresholdEnabled',
                e.target.checked,
                e.target.checked ? t('toast.batchThresholdOn') : t('toast.batchThresholdOff')
              )
            }}
            className="w-5 h-5"
          />
        </label>
        {batchThresholdEnabled && (
          <div
            className="flex items-center gap-3 p-3 rounded-lg"
            style={{ background: 'var(--bg-tertiary)' }}
          >
            <span className="text-sm flex-shrink-0" style={{ color: 'var(--text-secondary)' }}>
              {t('settings.fileops.thresholdCount')}
            </span>
            <input
              type="range"
              min={3}
              max={100}
              step={1}
              value={batchThreshold}
              onChange={(e) => setBatchThreshold(Number(e.target.value))}
              onMouseUp={async () => {
                await updateSetting(
                  'fileOps.batchThreshold',
                  batchThreshold,
                  t('toast.batchThresholdSet', { count: batchThreshold })
                )
              }}
              className="flex-1 accent-[var(--accent)]"
            />
            <span
              className="text-sm font-mono w-12 text-right"
              style={{ color: 'var(--text-primary)' }}
            >
              {batchThreshold}
            </span>
          </div>
        )}
      </div>
    </SectionShell>
  )
}

// P1-02：导出工作流优化——默认导出路径 + 智能命名规则
export const GeneralExportSection: React.FC = () => {
  const { t } = useTranslation()
  const showMessage = useContext(GlobalToastContext)
  const [defaultDir, setDefaultDir] = useState('')
  const [namingPattern, setNamingPattern] = useState('')

  useEffect(() => {
    const load = async () => {
      if (!window.electronAPI) return
      const dir = (await window.electronAPI.settings.get('export.defaultDir', '')) as string
      const pattern = (await window.electronAPI.settings.get('export.namingPattern', '')) as string
      setDefaultDir(dir || '')
      setNamingPattern(pattern || '')
    }
    load()
  }, [])

  const pickDir = async () => {
    if (!window.electronAPI?.dialog?.selectDirectory) return
    const picked = await window.electronAPI.dialog.selectDirectory()
    if (!picked) return
    setDefaultDir(picked)
    await window.electronAPI.export.setDefaultDir(picked)
    showMessage(t('toast.defaultDirSet', { dir: picked }))
  }

  const clearDir = async () => {
    setDefaultDir('')
    if (window.electronAPI) await window.electronAPI.export.setDefaultDir('')
    showMessage(t('toast.defaultDirCleared'))
  }

  const savePattern = async (value: string) => {
    setNamingPattern(value)
    if (window.electronAPI) await window.electronAPI.export.setNamingPattern(value)
  }

  // 预览命名规则效果（固定用占位数据）
  const previewName = (() => {
    if (!namingPattern.trim()) return t('settings.export.previewEmpty')
    const date = new Date()
    const dateStr = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
    return (
      namingPattern
        .replace(/\{date\}/g, dateStr)
        .replace(/\{album_type\}/g, '拍摄截图')
        .replace(/\{uid\}/g, '100123456')
        .replace(/\{original_name\}/g, 'photo_001')
        .replace(/\{sequence\}/g, '001') + '.扩展名'
    )
  })()

  return (
    <SectionShell
      title={t('settings.sections.exportWorkflow')}
      description={t('settings.export.description')}
    >
      {/* 默认导出路径 */}
      <div className="space-y-2">
        <div style={{ color: 'var(--text-primary)' }}>{t('settings.export.defaultDir')}</div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={defaultDir}
            readOnly
            placeholder={t('settings.export.defaultDirPlaceholder')}
            className="flex-1 px-3 py-2 text-sm rounded-lg"
            style={{
              background: 'var(--bg-tertiary)',
              color: defaultDir ? 'var(--text-primary)' : 'var(--text-tertiary)',
              border: '1px solid var(--divider)'
            }}
          />
          <button className="btn-secondary text-sm px-3 py-2" onClick={pickDir}>
            {t('settings.export.selectDir')}
          </button>
          {defaultDir && (
            <button
              className="btn-secondary text-sm px-3 py-2"
              onClick={clearDir}
              title={t('settings.export.clearDir')}
            >
              {t('settings.export.clearDir')}
            </button>
          )}
        </div>
        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          {t('settings.export.defaultDirHint')}
        </p>
      </div>

      {/* 命名规则 */}
      <div className="space-y-2">
        <div style={{ color: 'var(--text-primary)' }}>{t('settings.export.namingPattern')}</div>
        <input
          type="text"
          value={namingPattern}
          onChange={(e) => setNamingPattern(e.target.value)}
          onBlur={() => savePattern(namingPattern)}
          placeholder={t('settings.export.namingPatternPlaceholder')}
          className="w-full px-3 py-2 text-sm rounded-lg font-mono"
          style={{
            background: 'var(--bg-tertiary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--divider)'
          }}
        />
        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          {t('settings.export.namingPatternHint')}
        </p>
        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          {t('settings.export.namingPatternEmpty')}
        </p>
        {namingPattern.trim() && (
          <div className="p-2 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
            <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('settings.export.preview')}
            </span>
            <span className="text-xs font-mono" style={{ color: 'var(--accent)' }}>
              {previewName}
            </span>
          </div>
        )}
      </div>
    </SectionShell>
  )
}
