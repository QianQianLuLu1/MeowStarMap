import React, { useEffect, useState, useContext } from 'react'
import { useTranslation } from 'react-i18next'
import { SectionShell, GlobalToastContext, SettingsToggle, SettingsCard } from './shared'
import { SliderControl } from '../../components/common/SliderControl'

// ============ 通用 ============

export const GeneralStartupSection: React.FC = () => {
  const { t } = useTranslation()
  const [autoScan, setAutoScan] = useState(true)
  const [hardwareAccel, setHardwareAccel] = useState(true)
  const showMessage = useContext(GlobalToastContext)

  useEffect(() => {
    const load = async () => {
      if (!window.electronAPI) return
      const a = (await window.electronAPI.settings.get('autoScanOnStartup', true)) as boolean
      setAutoScan(a)
      const h = (await window.electronAPI.settings.get('hardwareAcceleration', true)) as boolean
      setHardwareAccel(h)
    }
    load()
  }, [])

  const saveAutoScan = async (value: boolean) => {
    setAutoScan(value)
    if (window.electronAPI) await window.electronAPI.settings.set('autoScanOnStartup', value)
    showMessage(value ? t('toast.autoScanOn') : t('toast.autoScanOff'))
  }

  const saveHardwareAccel = async (value: boolean) => {
    setHardwareAccel(value)
    if (window.electronAPI) await window.electronAPI.settings.set('hardwareAcceleration', value)
    showMessage(value ? t('toast.gpuOn') : t('toast.gpuOff'))
    // 修改需重启生效：询问是否立即重启（按钮 0 = 立即重启）
    if (window.electronAPI?.dialog?.showMessageBox && window.electronAPI?.app?.relaunch) {
      const response = await window.electronAPI.dialog.showMessageBox({
        type: 'info',
        title: t('settings.startup.hardwareAcceleration'),
        message: t('settings.startup.hardwareAccelerationRestartHint'),
        buttons: [t('settings.startup.restartNow'), t('settings.startup.restartLater')]
      })
      if (response === 0) await window.electronAPI.app.relaunch()
    }
  }

  return (
    <SectionShell
      title={t('settings.sections.startup')}
      description={t('settings.startup.description')}
    >
      <SettingsToggle
        label={t('settings.startup.autoScan')}
        description={t('settings.startup.autoScanDesc')}
        checked={autoScan}
        onChange={(value) => void saveAutoScan(value)}
      />

      {/* GPU 硬件加速开关（关闭后改用软件渲染，规避部分显卡导致的启动崩溃） */}
      <SettingsToggle
        label={t('settings.startup.hardwareAcceleration')}
        description={t('settings.startup.hardwareAccelerationDesc')}
        checked={hardwareAccel}
        onChange={(value) => void saveHardwareAccel(value)}
      />
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
      <SettingsToggle
        label={t('settings.fileops.deleteConfirm')}
        description={t('settings.fileops.deleteConfirmDesc')}
        checked={deleteConfirm}
        onChange={(value) => {
          setDeleteConfirm(value)
          void updateSetting(
            'fileOps.deleteConfirm',
            value,
            value ? t('toast.deleteConfirmOn') : t('toast.deleteConfirmOff')
          )
        }}
      />

      {/* 永久删除二次确认 */}
      <SettingsToggle
        label={t('settings.fileops.permanentDoubleConfirm')}
        description={t('settings.fileops.permanentDoubleConfirmDesc')}
        checked={permanentDeleteDoubleConfirm}
        onChange={(value) => {
          setPermanentDeleteDoubleConfirm(value)
          void updateSetting(
            'fileOps.permanentDoubleConfirm',
            value,
            value ? t('toast.permanentDoubleConfirmOn') : t('toast.permanentDoubleConfirmOff')
          )
        }}
      />

      {/* 优先软删除 */}
      <SettingsToggle
        label={t('settings.fileops.preferSoftDelete')}
        description={t('settings.fileops.preferSoftDeleteDesc')}
        checked={preferSoftDelete}
        onChange={(value) => {
          setPreferSoftDelete(value)
          void updateSetting(
            'fileOps.preferSoftDelete',
            value,
            value ? t('toast.preferSoftDeleteOn') : t('toast.preferSoftDeleteOff')
          )
        }}
      />

      {/* 批量操作阈值 */}
      <div className="space-y-2">
        <SettingsToggle
          label={t('settings.fileops.batchThreshold')}
          description={t('settings.fileops.batchThresholdDesc')}
          checked={batchThresholdEnabled}
          onChange={(value) => {
            setBatchThresholdEnabled(value)
            void updateSetting(
              'fileOps.batchThresholdEnabled',
              value,
              value ? t('toast.batchThresholdOn') : t('toast.batchThresholdOff')
            )
          }}
        />
        {batchThresholdEnabled && (
          <SettingsCard>
            <SliderControl
              label={t('settings.fileops.thresholdCount')}
              value={batchThreshold}
              min={3}
              max={100}
              step={1}
              // defaultValue 传当前值：SliderControl 双击复位优先取 defaultValue，
              // 缺省会退到 min=3，误双击就把用户的阈值静默改掉了。
              defaultValue={batchThreshold}
              onChange={setBatchThreshold}
              // SliderControl 的提交同时挂在 onPointerUp 与 onKeyUp 上，
              // 键盘方向键调值因此也会落库（原裸 range 只有 mouseUp，键盘值被静默丢弃）
              onCommit={() =>
                void updateSetting(
                  'fileOps.batchThreshold',
                  batchThreshold,
                  t('toast.batchThresholdSet', { count: batchThreshold })
                )
              }
            />
          </SettingsCard>
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
        .replace(/\{album_type\}/g, t('settings.export.previewAlbumType'))
        .replace(/\{uid\}/g, '100123456')
        .replace(/\{original_name\}/g, 'photo_001')
        .replace(/\{sequence\}/g, '001') + t('settings.export.previewExtension')
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
