import React, { useEffect, useState, useContext } from 'react'
import { useTranslation } from 'react-i18next'
import { useMediaStore, fetchMediaFromDatabase } from '../../stores/mediaStore'
import { SectionShell, SettingsCard, GlobalToastContext, SettingsToggle } from './shared'
import { BaseDialog } from '../../components/common/BaseDialog'
import { IconClose } from '../../icons'

// ============ 扫描与路径 ============

// 自定义游戏目录路径数量上限，与 scanner-handler.ts 的 schema max(64) 一致
const MAX_CUSTOM_PATHS = 64

/**
 * 游戏目录配置区：手动添加/删除自定义游戏目录路径，扫描时优先搜索这些路径。
 *
 * 数据流：
 * - 添加：dialog.selectDirectory() → 去重 → settings.set('customScanPaths', [...]) → 刷新
 * - 删除：从数组移除 → settings.set → 刷新
 * - 持久化由 settings:set 经 dbManager.setSetting 写入 app_settings 表
 */
export const ScanPathsSection: React.FC = () => {
  const { t } = useTranslation()
  const showMessage = useContext(GlobalToastContext)
  const [paths, setPaths] = useState<string[]>([])
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    const load = async () => {
      if (!window.electronAPI) return
      const saved = (await window.electronAPI.settings.get('customScanPaths', [])) as unknown
      setPaths(Array.isArray(saved) ? (saved as string[]) : [])
    }
    load()
  }, [])

  const persist = async (next: string[]) => {
    setPaths(next)
    if (window.electronAPI) {
      await window.electronAPI.settings.set('customScanPaths', next)
    }
  }

  const handleAdd = async () => {
    if (!window.electronAPI?.dialog?.selectDirectory || adding) return
    setAdding(true)
    try {
      const picked = await window.electronAPI.dialog.selectDirectory()
      if (!picked) return // 用户取消
      if (paths.includes(picked)) {
        showMessage(t('settings.scan.pathExists'), 'info')
        return
      }
      if (paths.length >= MAX_CUSTOM_PATHS) {
        showMessage(t('settings.scan.pathLimit', { max: MAX_CUSTOM_PATHS }), 'info')
        return
      }
      await persist([...paths, picked])
      showMessage(t('settings.scan.pathAdded'), 'success')
    } finally {
      setAdding(false)
    }
  }

  const handleRemove = async (index: number) => {
    const next = paths.filter((_, i) => i !== index)
    await persist(next)
    showMessage(t('settings.scan.pathRemoved'), 'success')
  }

  return (
    <SectionShell
      title={t('settings.sections.scanPaths')}
      description={t('settings.scan.pathsDescription')}
    >
      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
        {t('settings.scan.importRootsManageHint')}
      </p>

      {paths.length === 0 ? (
        <SettingsCard>
          <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
            {t('settings.scan.emptyPaths')}
          </p>
        </SettingsCard>
      ) : (
        <div className="space-y-2">
          {paths.map((p, i) => (
            <SettingsCard key={`${p}-${i}`}>
              <div className="flex items-center gap-3">
                <span
                  className="flex-1 min-w-0 truncate text-sm"
                  style={{ color: 'var(--text-primary)' }}
                  title={p}
                >
                  {p}
                </span>
                <button
                  className="icon-btn flex-shrink-0"
                  onClick={() => handleRemove(i)}
                  title={t('settings.scan.pathRemove')}
                  aria-label={t('settings.scan.pathRemove')}
                  style={{ width: 28, height: 28 }}
                >
                  <IconClose size={14} />
                </button>
              </div>
            </SettingsCard>
          ))}
        </div>
      )}
      <div>
        <button className="btn-primary text-sm" onClick={handleAdd} disabled={adding}>
          {adding ? t('settings.scan.adding') : t('settings.scan.addPath')}
        </button>
      </div>
    </SectionShell>
  )
}

export const ScanOptionsSection: React.FC = () => {
  const { t } = useTranslation()
  const [incremental, setIncremental] = useState(true)
  const [analyzing, setAnalyzing] = useState(false)
  const setMediaFiles = useMediaStore((s) => s.setMediaFiles)
  const showMessage = useContext(GlobalToastContext)

  useEffect(() => {
    const load = async () => {
      if (!window.electronAPI) return
      const i = (await window.electronAPI.settings.get('incrementalScan', true)) as boolean
      setIncremental(i)
    }
    load()
  }, [])

  const saveIncremental = async (value: boolean) => {
    setIncremental(value)
    if (window.electronAPI) await window.electronAPI.settings.set('incrementalScan', value)
    showMessage(value ? t('logAction.incrementalOn') : t('logAction.incrementalOff'))
  }

  const handleAnalyzeSceneTime = async () => {
    if (!window.electronAPI?.mediaAction?.analyzeSceneTime || analyzing) return
    setAnalyzing(true)
    try {
      const result = await window.electronAPI.mediaAction.analyzeSceneTime()
      if (result.success) {
        showMessage(
          result.message || t('logAction.sceneAnalyzed', { count: result.analyzed ?? 0 }),
          'success'
        )
        const res = await fetchMediaFromDatabase()
        if (res) setMediaFiles(res.files)
      } else {
        showMessage(result.message || t('logAction.sceneAnalyzeFailed'), 'error')
      }
    } catch (error) {
      showMessage(
        error instanceof Error ? error.message : t('logAction.sceneAnalyzeFailed'),
        'error'
      )
    } finally {
      setAnalyzing(false)
    }
  }

  return (
    <SectionShell title={t('settings.sections.scanOptions')}>
      <SettingsToggle
        label={t('settings.scan.incremental')}
        checked={incremental}
        onChange={(value) => void saveIncremental(value)}
      />
      <div className="pt-3 space-y-2" style={{ borderTop: '1px solid var(--divider)' }}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
              {t('settings.scan.sceneTimeTitle')}
            </p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
              {t('settings.scan.sceneTimeDesc')}
            </p>
          </div>
          <button
            className="btn-primary text-sm"
            onClick={handleAnalyzeSceneTime}
            disabled={analyzing}
          >
            {analyzing ? t('settings.scan.analyzing') : t('settings.scan.analyzeNow')}
          </button>
        </div>
      </div>
    </SectionShell>
  )
}

// ============ 指定目录（import_roots）管理 ============

/**
 * 指定目录管理区：列出所有经"指定目录扫描"登记的目录，并支持逐项移除。
 *
 * 背景：用户经"指定目录扫描"（scanner:start({ path })）导入后，目录会被登记进 import_roots，
 * 但此前没有任何可视化入口查看或移除，导致"只增不减"。本区块补齐这一缺口。
 *
 * 数据流：
 * - 列表：importRoot.list() → import_roots 全量路径
 * - 移除：importRoot.removeRoot(path, clearRecords)
 *     - clearRecords=false：仅删 import_roots 行（移出管理）
 *     - clearRecords=true：同时软删该目录下 media_files 记录（进回收站，可恢复）
 */
export const ImportRootsSection: React.FC = () => {
  const { t } = useTranslation()
  const showMessage = useContext(GlobalToastContext)
  const [roots, setRoots] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [pendingPath, setPendingPath] = useState<string | null>(null)
  const [clearRecords, setClearRecords] = useState(true)
  const [removing, setRemoving] = useState(false)

  useEffect(() => {
    const load = async () => {
      if (!window.electronAPI?.importRoot) return
      try {
        const list = await window.electronAPI.importRoot.list()
        setRoots(Array.isArray(list) ? list : [])
      } catch (error) {
        showMessage(
          error instanceof Error ? error.message : t('settings.scan.importRootsLoadFailed'),
          'error'
        )
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [showMessage, t])

  const handleConfirmRemove = async () => {
    if (!pendingPath || !window.electronAPI?.importRoot) return
    setRemoving(true)
    try {
      const result = await window.electronAPI.importRoot.removeRoot(pendingPath, clearRecords)
      if (result?.removed) {
        setRoots((prev) => prev.filter((p) => p !== pendingPath))
        if (result.clearFailed) {
          // FIX(组1-2): 软删失败与"该目录无媒体记录"区分提示——登记已移除，
          // 但媒体索引未清除（未进回收站），用户需知晓数据仍留在库中
          showMessage(
            `${t('settings.scan.importRootsClearFailed')}${result.clearErrorMessage ? `（${result.clearErrorMessage}）` : ''}`,
            'error'
          )
        } else {
          showMessage(
            result.cleared > 0
              ? t('settings.scan.importRootsRemovedWithCleared', { count: result.cleared })
              : t('settings.scan.importRootsRemovedOnly'),
            'success'
          )
        }
      } else {
        showMessage(t('settings.scan.importRootsRemoveFailed'), 'error')
      }
    } catch (error) {
      showMessage(
        error instanceof Error ? error.message : t('settings.scan.importRootsRemoveFailed'),
        'error'
      )
    } finally {
      setRemoving(false)
      setPendingPath(null)
    }
  }

  return (
    <SectionShell
      title={t('settings.scan.importRootsTitle')}
      description={t('settings.scan.importRootsDescription')}
    >
      {loading ? (
        <SettingsCard>
          <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
            {t('settings.scan.importRootsLoading')}
          </p>
        </SettingsCard>
      ) : roots.length === 0 ? (
        <SettingsCard>
          <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
            {t('settings.scan.importRootsEmpty')}
          </p>
        </SettingsCard>
      ) : (
        <div className="space-y-2">
          {roots.map((p) => (
            <SettingsCard key={p}>
              <div className="flex items-center gap-3">
                <span
                  className="flex-1 min-w-0 truncate text-sm"
                  style={{ color: 'var(--text-primary)' }}
                  title={p}
                >
                  {p}
                </span>
                <button
                  className="icon-btn flex-shrink-0"
                  onClick={() => setPendingPath(p)}
                  title={t('settings.scan.importRootsRemove')}
                  aria-label={t('settings.scan.importRootsRemove')}
                  style={{ width: 28, height: 28 }}
                >
                  <IconClose size={14} />
                </button>
              </div>
            </SettingsCard>
          ))}
        </div>
      )}

      <BaseDialog
        open={pendingPath !== null}
        onClose={() => !removing && setPendingPath(null)}
        title={t('settings.scan.importRootsConfirmTitle')}
        size="md"
        footer={
          <>
            <button
              className="btn-secondary text-sm"
              onClick={() => setPendingPath(null)}
              disabled={removing}
            >
              {t('settings.scan.importRootsConfirmCancel')}
            </button>
            <button
              className="btn-danger text-sm"
              onClick={handleConfirmRemove}
              disabled={removing}
            >
              {removing
                ? t('settings.scan.importRootsRemoving')
                : t('settings.scan.importRootsConfirmRemove')}
            </button>
          </>
        }
      >
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          {t('settings.scan.importRootsConfirmBody', { path: pendingPath ?? '' })}
        </p>
        <label className="flex items-center gap-2 mt-3 cursor-pointer">
          <input
            type="checkbox"
            checked={clearRecords}
            onChange={(e) => setClearRecords(e.target.checked)}
            className="w-4 h-4"
          />
          <span className="text-sm" style={{ color: 'var(--text-primary)' }}>
            {t('settings.scan.importRootsConfirmClearRecords')}
          </span>
        </label>
        <p className="text-xs mt-1.5" style={{ color: 'var(--text-tertiary)' }}>
          {t('settings.scan.importRootsClearRecordsHint')}
        </p>
      </BaseDialog>
    </SectionShell>
  )
}
