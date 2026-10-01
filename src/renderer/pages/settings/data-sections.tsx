import React, { useEffect, useState, useCallback, useContext, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  useMediaStore,
  fetchMediaFromDatabase,
  type CharacterProfile
} from '../../stores/mediaStore'
import { ConfirmDialog } from '../../components/common/ConfirmDialog'
import { Select } from '../../components/common/Select'
import {
  SectionShell,
  GlobalToastContext,
  formatTimestamp,
  formatSize,
  type BackupRecord
} from './shared'
import { IconDelete, IconInfo } from '../../icons'

// ============ 数据管理 ============

// P1-04：从备份文件名解析档案 UID 后缀
// 文件名规范：wxnn_photo_manager_YYYYMMDD_HHMMSS[_uid].db
function parseUidFromBackupFilename(filename: string): string | null {
  const match = filename.match(/^wxnn_photo_manager_\d{8}_\d{6}_([a-zA-Z0-9]+)\.db$/)
  return match ? match[1] : null
}

export const DataBackupSection: React.FC = () => {
  const { t } = useTranslation()
  const showMessage = useContext(GlobalToastContext)
  const [backups, setBackups] = useState<BackupRecord[]>([])
  const [backupDir, setBackupDir] = useState('')
  const [creating, setCreating] = useState(false)
  const [loading, setLoading] = useState(false)
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null)
  // P1-04：按档案备份——选中档案 UID（'' 表示整库备份）
  const [selectedProfileUid, setSelectedProfileUid] = useState<string>('')
  const profiles = useMediaStore((s) => s.profiles)

  // P1-04：UID → 昵称映射（备份列表展示档案名而非裸 UID）
  const profileMap = useMemo(() => {
    const m = new Map<string, CharacterProfile>()
    for (const p of profiles) m.set(p.uid, p)
    return m
  }, [profiles])

  const loadBackups = useCallback(async () => {
    if (!window.electronAPI?.backup) return
    setLoading(true)
    try {
      const res = await window.electronAPI.backup.list()
      if (res?.success) {
        setBackups(res.backups)
        setBackupDir(res.backupDir)
      }
    } catch (err) {
      console.error(t('settings.backup.log.loadBackupsFailed'), err)
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    loadBackups()
  }, [loadBackups])

  const handleCreate = async () => {
    if (!window.electronAPI?.backup || creating) return
    setCreating(true)
    try {
      // P1-04：按档案备份时文件名加入 _{uid} 后缀以便识别（实际内容仍是整库，还原不丢数据）
      const options = selectedProfileUid ? { accountUid: selectedProfileUid } : undefined
      const res = await window.electronAPI.backup.create(options)
      if (res?.success) {
        const msg = selectedProfileUid
          ? t('logAction.backupSuccessWithProfile', {
              name: profileMap.get(selectedProfileUid)?.nickname ?? selectedProfileUid
            })
          : t('logAction.backupSuccess')
        showMessage(msg, 'success')
        await loadBackups()
      } else {
        showMessage(res?.message || t('logAction.backupFailed'), 'error')
      }
    } catch (err) {
      showMessage(err instanceof Error ? err.message : t('logAction.backupFailed'), 'error')
    } finally {
      setCreating(false)
    }
  }

  const handleRestore = async (filename: string) => {
    if (!window.electronAPI?.backup) return
    try {
      const res = await window.electronAPI.backup.restore(filename)
      if (res?.success) {
        showMessage(res.message || t('logAction.restoreSuccess'), 'success')
      } else {
        showMessage(res?.message || t('logAction.restoreFailed'), 'error')
      }
    } catch (err) {
      showMessage(err instanceof Error ? err.message : t('logAction.restoreFailed'), 'error')
    } finally {
      setRestoreTarget(null)
    }
  }

  const handleDelete = async (filename: string) => {
    if (!window.electronAPI?.backup) return
    try {
      const res = await window.electronAPI.backup.delete(filename)
      if (res?.success) {
        showMessage(t('logAction.backupDeleted'), 'info')
        await loadBackups()
      } else {
        showMessage(res?.message || t('logAction.deleteFailed'), 'error')
      }
    } catch (err) {
      showMessage(err instanceof Error ? err.message : t('logAction.deleteFailed'), 'error')
    }
  }

  return (
    <>
      <SectionShell title={t('settings.sections.dataBackup')}>
        <div className="flex items-center gap-2 flex-wrap">
          <button className="btn-primary text-sm" onClick={handleCreate} disabled={creating}>
            {creating ? t('settings.backup.creating') : t('settings.backup.create')}
          </button>
          <button className="btn-secondary text-sm" onClick={loadBackups} disabled={loading}>
            {loading ? t('settings.backup.loading') : t('settings.backup.refresh')}
          </button>
          {/* P1-04：按档案备份——选择档案后备份文件名加入 _{uid} 后缀（视觉体系 v3：统一 Select） */}
          <Select
            className="min-w-[160px]"
            value={selectedProfileUid}
            onChange={(e) => setSelectedProfileUid(e.target.value)}
            title={t('settings.backup.wholeDb')}
          >
            <option value="">{t('settings.backup.wholeDb')}</option>
            {profiles.map((p) => (
              <option key={p.uid} value={p.uid}>
                {p.nickname}（{p.uid}）
              </option>
            ))}
          </Select>
        </div>

        {/* 备份目录 */}
        {backupDir && (
          <div
            className="flex items-center justify-between gap-3 p-3 rounded-lg"
            style={{ background: 'var(--bg-tertiary)' }}
          >
            <div className="flex-1 min-w-0">
              <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {t('settings.backup.storageLocation')}
              </div>
              <div
                className="text-xs font-mono mt-1 truncate"
                style={{ color: 'var(--text-primary)' }}
                title={backupDir}
              >
                {backupDir}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                className="btn-secondary text-xs px-3 py-1.5"
                onClick={async () => {
                  const dir = await window.electronAPI?.dialog?.selectDirectory()
                  if (!dir) return
                  const res = await window.electronAPI?.backup?.setDir(dir)
                  if (res?.success && res.needRestart) {
                    const confirmed = await window.electronAPI?.dialog?.showMessageBox({
                      type: 'question',
                      title: t('settings.backup.restartTitle'),
                      message: res.message,
                      buttons: [t('settings.backup.restartNow'), t('settings.backup.restartLater')]
                    })
                    if (confirmed === 0) {
                      await window.electronAPI?.app?.relaunch()
                    }
                  } else if (!res?.success) {
                    showMessage(res?.message || t('logAction.settingFailed'), 'error')
                  }
                }}
                title={t('settings.backup.modifyDir')}
              >
                {t('settings.backup.modifyDir')}
              </button>
              <button
                className="btn-secondary text-xs px-3 py-1.5"
                onClick={() => window.electronAPI?.shell?.openPath?.(backupDir)}
                title={t('settings.backup.openDir')}
              >
                {t('settings.backup.openDir')}
              </button>
            </div>
          </div>
        )}

        {/* 备份列表 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
              {t('settings.backup.records')}
            </span>
            {backups.length > 0 && (
              <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {t('settings.backup.total', { count: backups.length })}
              </span>
            )}
          </div>

          {backups.length === 0 ? (
            <div
              className="py-6 text-center rounded-lg"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                {loading ? t('settings.backup.loading') : t('settings.backup.empty')}
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                {t('settings.backup.emptyHint')}
              </p>
            </div>
          ) : (
            <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
              {backups.map((backup) => {
                // P1-04：解析档案标识，展示档案名（而非裸 UID）
                const uid = parseUidFromBackupFilename(backup.filename)
                const profileLabel = uid ? (profileMap.get(uid)?.nickname ?? uid) : null
                return (
                  <div
                    key={backup.filename}
                    className="flex items-center justify-between gap-3 p-3 rounded-lg"
                    style={{ background: 'var(--bg-tertiary)' }}
                  >
                    <div className="flex-1 min-w-0">
                      <div
                        className="text-sm truncate"
                        style={{ color: 'var(--text-primary)' }}
                        title={backup.filename}
                      >
                        {backup.filename}
                      </div>
                      <div
                        className="text-xs mt-0.5 flex items-center gap-2 flex-wrap"
                        style={{ color: 'var(--text-tertiary)' }}
                      >
                        <span>
                          {formatTimestamp(backup.createdAt)} · {formatSize(backup.size)}
                        </span>
                        {/* P1-04：档案备份标记 */}
                        {profileLabel && (
                          <span
                            className="px-1.5 py-0.5 rounded text-xs"
                            style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                            title={t('settings.backup.archiveTag', { name: profileLabel })}
                          >
                            {t('settings.backup.archiveTag', { name: profileLabel })}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        className="btn-secondary text-xs px-2 py-1"
                        onClick={() => setRestoreTarget(backup.filename)}
                        title={t('settings.backup.restore')}
                      >
                        {t('settings.backup.restore')}
                      </button>
                      <button
                        className="icon-btn"
                        style={{ color: 'var(--danger)' }}
                        onClick={() => handleDelete(backup.filename)}
                        title={t('settings.backup.delete')}
                        aria-label={t('settings.backup.delete')}
                      >
                        <IconDelete size={14} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          {t('settings.backup.hint')}
        </p>
      </SectionShell>

      <ConfirmDialog
        open={restoreTarget !== null}
        title={t('settings.backup.restoreTitle')}
        message={t('settings.backup.restoreConfirm')}
        confirmVariant="danger"
        onConfirm={() => {
          if (restoreTarget) handleRestore(restoreTarget)
        }}
        onCancel={() => setRestoreTarget(null)}
      />
    </>
  )
}

export const DataCacheSection: React.FC = () => {
  const { t } = useTranslation()
  const showMessage = useContext(GlobalToastContext)
  const [stats, setStats] = useState<{
    totalSize: number
    fileCount: number
    limit: number
    cacheDir: string
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [enforcing, setEnforcing] = useState(false)
  const [showCleanConfirm, setShowCleanConfirm] = useState(false)
  // 缓存上限预设（GB），下拉选项
  const [limitGB, setLimitGB] = useState<number>(2)

  const loadStats = useCallback(async () => {
    if (!window.electronAPI?.cache) return
    setLoading(true)
    try {
      const res = await window.electronAPI.cache.getStats()
      // call 解包后 res 为 { totalSize, fileCount, limit, cacheDir }，失败时已抛异常
      setStats({
        totalSize: res.totalSize ?? 0,
        fileCount: res.fileCount ?? 0,
        limit: res.limit ?? 0,
        cacheDir: res.cacheDir ?? ''
      })
      setLimitGB(
        Math.max(0.1, Math.round((res.limit ?? 2 * 1024 * 1024 * 1024) / 1024 / 1024 / 1024))
      )
    } catch (err) {
      showMessage(err instanceof Error ? err.message : t('logAction.loadStatsFailed'), 'error')
    } finally {
      setLoading(false)
    }
  }, [showMessage, t])

  useEffect(() => {
    loadStats()
  }, [loadStats])

  const handleClean = async () => {
    if (!window.electronAPI?.cache || cleaning) return
    setCleaning(true)
    try {
      const res = await window.electronAPI.cache.clean()
      // call 解包后 res 为 { clearedSize, clearedCount }，失败时已抛异常
      const sizeText = formatSize(res.clearedSize ?? 0)
      showMessage(
        t('logAction.cleanSuccess', { count: res.clearedCount ?? 0, size: sizeText }),
        'success'
      )
      await loadStats()
    } catch (err) {
      showMessage(err instanceof Error ? err.message : t('logAction.cleanFailed'), 'error')
    } finally {
      setCleaning(false)
      setShowCleanConfirm(false)
    }
  }

  const handleEnforceLimit = async () => {
    if (!window.electronAPI?.cache || enforcing) return
    setEnforcing(true)
    try {
      const res = await window.electronAPI.cache.enforceLimit()
      // call 解包后 res 为 { evicted, totalSize, fileCount }，失败时已抛异常
      if ((res.evicted ?? 0) > 0) {
        showMessage(t('logAction.enforceEvicted', { count: res.evicted }), 'info')
      } else {
        showMessage(t('logAction.enforceNoop'), 'info')
      }
      await loadStats()
    } catch (err) {
      showMessage(err instanceof Error ? err.message : t('logAction.enforceFailed'), 'error')
    } finally {
      setEnforcing(false)
    }
  }

  const handleSetLimit = async (gb: number) => {
    if (!window.electronAPI?.cache) return
    const bytes = gb * 1024 * 1024 * 1024
    try {
      const res = await window.electronAPI.cache.setLimit(bytes)
      // call 解包后 res 为 { applied, evicted }，失败时已抛异常
      if (res.applied) {
        setLimitGB(gb)
        if (res.evicted > 0) {
          showMessage(t('logAction.limitSetEvicted', { gb, count: res.evicted }), 'success')
        } else {
          showMessage(t('logAction.limitSet', { gb }), 'success')
        }
        await loadStats()
      } else {
        // applied:false 表示上限低于最小值（100MB），非异常但需提示
        showMessage(t('logAction.limitSetFailed'), 'error')
      }
    } catch (err) {
      showMessage(err instanceof Error ? err.message : t('logAction.limitSetFailed'), 'error')
    }
  }

  const limitPresets = [1, 2, 3, 5, 10]
  const usagePercent =
    stats && stats.limit > 0 ? Math.min(100, (stats.totalSize / stats.limit) * 100) : 0
  const usageColor =
    usagePercent > 90 ? 'var(--danger)' : usagePercent > 70 ? '#f59e0b' : 'var(--accent)'

  return (
    <SectionShell title={t('settings.sections.dataCache')}>
      {/* 缓存统计卡片 */}
      {stats ? (
        <div className="grid grid-cols-2 gap-3">
          <div className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
            <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('settings.cache.currentUsage')}
            </div>
            <div className="text-lg font-semibold mt-1" style={{ color: 'var(--text-primary)' }}>
              {formatSize(stats.totalSize)}
            </div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
              {t('settings.cache.fileCount', { count: stats.fileCount })}
            </div>
          </div>
          <div className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
            <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('settings.cache.limit')}
            </div>
            <div className="text-lg font-semibold mt-1" style={{ color: 'var(--text-primary)' }}>
              {formatSize(stats.limit)}
            </div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
              {t('settings.cache.lruHint')}
            </div>
          </div>
        </div>
      ) : (
        <div
          className="p-3 rounded-lg text-sm"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)' }}
        >
          {loading ? t('settings.backup.loading') : t('settings.cache.noData')}
        </div>
      )}

      {/* 使用率进度条 */}
      {stats && stats.limit > 0 && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs" style={{ color: 'var(--text-tertiary)' }}>
            <span>{t('settings.cache.usage')}</span>
            <span>{usagePercent.toFixed(1)}%</span>
          </div>
          <div
            className="h-2 rounded-full overflow-hidden"
            style={{ background: 'var(--bg-tertiary)' }}
          >
            <div
              className="h-full transition-all"
              style={{ width: `${usagePercent}%`, background: usageColor }}
            />
          </div>
        </div>
      )}

      {/* 淘汰策略说明卡片 */}
      <div
        className="p-3 rounded-lg flex items-start gap-2"
        style={{ background: 'var(--bg-tertiary)' }}
      >
        <span className="text-xs flex-shrink-0" style={{ color: 'var(--text-tertiary)' }}>
          <IconInfo size={14} />
        </span>
        <div className="flex-1">
          <div className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
            {t('settings.cache.strategyTitle')}
          </div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
            {t('settings.cache.strategyDesc')}
          </div>
        </div>
      </div>

      {/* 上限调整 */}
      <div className="space-y-2">
        <div className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
          {t('settings.cache.cacheLimit')}
        </div>
        <div className="flex gap-2 flex-wrap">
          {limitPresets.map((gb) => (
            <button
              key={gb}
              className={`category-tag ${limitGB === gb ? 'active' : ''}`}
              onClick={() => handleSetLimit(gb)}
              disabled={loading}
            >
              {gb} GB
            </button>
          ))}
        </div>
        {/* 自定义上限输入框：补足预设之外的自定义值（0.1~100 GB） */}
        <div className="flex items-center gap-2 mt-2">
          <input
            type="number"
            min={0.1}
            max={100}
            step={0.5}
            className="text-sm px-3 py-1.5 rounded-lg border w-24"
            style={{
              background: 'var(--bg-tertiary)',
              color: 'var(--text-primary)',
              borderColor: 'var(--divider)'
            }}
            placeholder={String(limitGB)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const val = parseFloat((e.target as HTMLInputElement).value)
                if (Number.isFinite(val) && val >= 0.1 && val <= 100) {
                  handleSetLimit(val)
                  ;(e.target as HTMLInputElement).value = ''
                } else {
                  showMessage(t('settings.cache.invalidLimit'), 'error')
                }
              }
            }}
          />
          <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            {t('settings.cache.customLimitHint')}
          </span>
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="flex items-center gap-2 flex-wrap">
        <button className="btn-secondary text-sm" onClick={loadStats} disabled={loading}>
          {loading ? t('settings.backup.loading') : t('settings.cache.refreshStats')}
        </button>
        <button
          className="btn-secondary text-sm"
          onClick={handleEnforceLimit}
          disabled={enforcing || !stats}
        >
          {enforcing ? t('settings.scan.analyzing') : t('settings.cache.enforceLru')}
        </button>
        <button
          className="btn-danger text-sm"
          onClick={() => setShowCleanConfirm(true)}
          disabled={cleaning || !stats || stats.fileCount === 0}
        >
          {cleaning ? t('settings.clear.cleaning') : t('settings.cache.cleanAll')}
        </button>
      </div>

      {/* 缓存目录 */}
      {stats?.cacheDir && (
        <div
          className="flex items-center justify-between gap-3 p-3 rounded-lg"
          style={{ background: 'var(--bg-tertiary)' }}
        >
          <div className="flex-1 min-w-0">
            <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('settings.cache.cacheLocation')}
            </div>
            <div
              className="text-xs font-mono mt-1 truncate"
              style={{ color: 'var(--text-primary)' }}
              title={stats.cacheDir}
            >
              {stats.cacheDir}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              className="btn-secondary text-xs px-3 py-1.5"
              onClick={async () => {
                const dir = await window.electronAPI?.dialog?.selectDirectory()
                if (!dir) return
                const res = await window.electronAPI?.cache?.setDir(dir)
                if (res?.success && res.needRestart) {
                  const confirmed = await window.electronAPI?.dialog?.showMessageBox({
                    type: 'question',
                    title: t('settings.backup.restartTitle'),
                    message: res.message,
                    buttons: [t('settings.backup.restartNow'), t('settings.backup.restartLater')]
                  })
                  if (confirmed === 0) {
                    await window.electronAPI?.app?.relaunch()
                  }
                } else if (!res?.success) {
                  showMessage(res?.message || t('logAction.settingFailed'), 'error')
                }
              }}
              title={t('settings.cache.modifyDir')}
            >
              {t('settings.cache.modifyDir')}
            </button>
            <button
              className="btn-secondary text-xs px-3 py-1.5"
              onClick={() => window.electronAPI?.shell?.openPath?.(stats.cacheDir)}
              title={t('settings.cache.openDir')}
            >
              {t('settings.cache.openDir')}
            </button>
          </div>
        </div>
      )}

      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
        {t('settings.cache.hint')}
      </p>

      <ConfirmDialog
        open={showCleanConfirm}
        title={t('settings.cache.cleanTitle')}
        message={t('settings.cache.cleanConfirm', {
          count: stats?.fileCount ?? 0,
          size: formatSize(stats?.totalSize ?? 0)
        })}
        confirmText={t('settings.cache.confirmClean')}
        cancelText={t('common.cancel')}
        confirmVariant="danger"
        onConfirm={handleClean}
        onCancel={() => setShowCleanConfirm(false)}
      />
    </SectionShell>
  )
}

export const DataClearSection: React.FC = () => {
  const { t } = useTranslation()
  const [showConfirm, setShowConfirm] = useState(false)
  // T02：清理丢失记录状态
  const [showMissingConfirm, setShowMissingConfirm] = useState(false)
  const [missingCleaning, setMissingCleaning] = useState(false)
  const setMediaFiles = useMediaStore((s) => s.setMediaFiles)
  const showMessage = useContext(GlobalToastContext)

  const clearData = async () => {
    if (!window.electronAPI) return
    try {
      await window.electronAPI.data.clear()
      const res = await fetchMediaFromDatabase()
      if (res) setMediaFiles(res.files)
      showMessage(t('logAction.clearData'), 'info')
    } catch (error) {
      showMessage(error instanceof Error ? error.message : t('logAction.clearDataFailed'), 'error')
    }
  }

  // T02：清理所有 is_missing=1 的数据库记录（物理文件已不存在，无需调用回收站）
  const cleanupMissing = async () => {
    if (!window.electronAPI) return
    setMissingCleaning(true)
    try {
      const result = await window.electronAPI.mediaAction.cleanupMissing()
      if (result.success) {
        const res = await fetchMediaFromDatabase()
        if (res) setMediaFiles(res.files)
        showMessage(
          result.message || t('logAction.cleanMissingSuccess', { count: result.cleared ?? 0 }),
          'success'
        )
      } else {
        showMessage(result.message || t('logAction.cleanMissingFailed'), 'error')
      }
    } catch (error) {
      showMessage(
        error instanceof Error ? error.message : t('logAction.cleanMissingError'),
        'error'
      )
    } finally {
      setMissingCleaning(false)
    }
  }

  return (
    <>
      <SectionShell title={t('settings.sections.dataClear')}>
        {/* T02：清理丢失记录（文件已被外部删除的库记录） */}
        <div className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                {t('settings.clear.missingTitle')}
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                {t('settings.clear.missingDesc')}
              </p>
            </div>
            <button
              className="btn-secondary text-xs flex-shrink-0"
              disabled={missingCleaning}
              onClick={() => setShowMissingConfirm(true)}
            >
              {missingCleaning ? t('settings.clear.cleaning') : t('settings.clear.cleanMissing')}
            </button>
          </div>
        </div>

        <button className="btn-danger w-full" onClick={() => setShowConfirm(true)}>
          {t('settings.clear.clearLocal')}
        </button>
      </SectionShell>
      <ConfirmDialog
        open={showConfirm}
        title={t('settings.clear.clearTitle')}
        message={t('settings.clear.clearConfirm')}
        confirmVariant="danger"
        onConfirm={() => {
          setShowConfirm(false)
          clearData()
        }}
        onCancel={() => setShowConfirm(false)}
      />
      <ConfirmDialog
        open={showMissingConfirm}
        title={t('settings.clear.missingConfirmTitle')}
        message={t('settings.clear.missingConfirm')}
        confirmVariant="danger"
        onConfirm={() => {
          setShowMissingConfirm(false)
          cleanupMissing()
        }}
        onCancel={() => setShowMissingConfirm(false)}
      />
    </>
  )
}
