import React, { useEffect, useState, useContext, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { SectionShell, GlobalToastContext } from './shared'
import { useMediaStore, loadProfiles, fetchMediaFromDatabase } from '../../stores/mediaStore'
import { formatFileSize } from '../../utils/format'
import { IconEdit, IconCheck, IconDelete } from '../../icons'

// ============ P0-02：角色档案管理 ============
// 与对标项目"多账号"的差异：本项目的角色档案是综合档案
// 含拍摄统计、套装偏好、场景偏好、时段偏好，不仅是 UID 切换

interface ProfileStats {
  totalCount: number
  imageCount: number
  videoCount: number
  totalSize: number
  earliestTime: string | null
  latestTime: string | null
  topOutfits: Array<{ outfit: string; cnt: number }>
  topScenes: Array<{ scene_category: string; cnt: number }>
  timeDistribution: Array<{ scene_time: string; cnt: number }>
}

export const ProfileManageSection: React.FC = () => {
  const { t } = useTranslation()
  const showMessage = useContext(GlobalToastContext)
  const profiles = useMediaStore((s) => s.profiles)
  const setMediaFiles = useMediaStore((s) => s.setMediaFiles)
  const setCurrentProfileUid = useMediaStore((s) => s.setCurrentProfileUid)
  const [selectedUid, setSelectedUid] = useState<string>('default')
  const [stats, setStats] = useState<ProfileStats | null>(null)
  const [loadingStats, setLoadingStats] = useState(false)
  // 新增档案表单
  const [newUid, setNewUid] = useState('')
  const [newNickname, setNewNickname] = useState('')
  // 编辑昵称
  const [editingUid, setEditingUid] = useState<string | null>(null)
  const [editNickname, setEditNickname] = useState('')

  // 加载档案列表
  const refreshProfiles = useCallback(async () => {
    const list = await loadProfiles()
    if (list && list.length > 0 && !list.find((p) => p.uid === selectedUid)) {
      setSelectedUid(list[0].uid)
    }
  }, [selectedUid])

  useEffect(() => {
    void refreshProfiles()
  }, [refreshProfiles])

  // 加载选中档案的统计
  useEffect(() => {
    if (!window.electronAPI?.profile?.getStats) return
    setLoadingStats(true)
    window.electronAPI.profile
      .getStats(selectedUid)
      .then((res) => {
        if (res.success && res.stats) setStats(res.stats)
        else setStats(null)
      })
      .catch(() => setStats(null))
      .finally(() => setLoadingStats(false))
  }, [selectedUid])

  const handleAddProfile = async () => {
    if (!window.electronAPI?.profile?.add) {
      showMessage(t('profileAction.unsupported'), 'error')
      return
    }
    if (!newUid.trim()) {
      showMessage(t('profileAction.uidRequired'), 'error')
      return
    }
    if (!/^[A-Za-z0-9]+$/.test(newUid.trim())) {
      showMessage(t('profileAction.uidInvalid'), 'error')
      return
    }
    if (profiles.find((p) => p.uid === newUid.trim())) {
      showMessage(t('profileAction.uidExists'), 'error')
      return
    }
    const res = await window.electronAPI.profile.add(
      newUid.trim(),
      newNickname.trim() || newUid.trim()
    )
    if (res.success) {
      showMessage(t('profileAction.created'))
      setNewUid('')
      setNewNickname('')
      await refreshProfiles()
    } else {
      showMessage(res.message || t('profileAction.createFailed'), 'error')
    }
  }

  const handleUpdateNickname = async (uid: string) => {
    if (!window.electronAPI?.profile?.update) {
      showMessage(t('profileAction.unsupported'), 'error')
      return
    }
    if (!editNickname.trim()) {
      showMessage(t('profileAction.nicknameRequired'), 'error')
      return
    }
    const res = await window.electronAPI.profile.update(uid, editNickname.trim())
    if (res.success) {
      showMessage(t('profileAction.nicknameUpdated'))
      setEditingUid(null)
      await refreshProfiles()
    } else {
      showMessage(res.message || t('profileAction.updateFailed'), 'error')
    }
  }

  const handleDeleteProfile = async (uid: string) => {
    if (!window.electronAPI?.profile?.delete) {
      showMessage(t('profileAction.unsupported'), 'error')
      return
    }
    if (uid === 'default') {
      showMessage(t('profileAction.defaultCannotDelete'), 'error')
      return
    }
    if (!confirm(t('profileAction.deleteConfirm', { uid }))) return
    // preload call() 在 IPC 失败时抛出 IpcError，成功时返回业务 data（{deleted:true}）而非 {success,...}。
    // 故此处须用 try/catch 捕获真实错误，而非判断 res.success（该字段在此契约下恒为假，会导致所有删除都被误报为"删除失败"）。
    try {
      await window.electronAPI.profile.delete(uid)
      showMessage(t('profileAction.deleted'))
      if (selectedUid === uid) setSelectedUid('default')
      await refreshProfiles()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      showMessage(msg || t('profileAction.deleteFailed'), 'error')
    }
  }

  const handleSwitchProfile = async (uid: string) => {
    if (!window.electronAPI?.profile?.setCurrent) {
      showMessage(t('profileAction.unsupported'), 'error')
      return
    }
    const res = await window.electronAPI.profile.setCurrent(uid)
    if (res.success) {
      setCurrentProfileUid(uid)
      setSelectedUid(uid)
      const mediaRes = await fetchMediaFromDatabase()
      if (mediaRes) setMediaFiles(mediaRes.files)
      showMessage(t('profileAction.switched'))
    } else {
      showMessage(res.message || t('profileAction.switchFailed'), 'error')
    }
  }

  const getSceneLabel = (key: string): string => t(`sceneLabel.${key}`, { defaultValue: key })
  const getTimeLabel = (key: string): string => t(`timeLabel.${key}`, { defaultValue: key })

  // 虚拟档案：扫描自动注册但 media_files 中无对应真实文件的残留 UID（hasMedia=false 且非 default）
  const virtualProfiles = profiles.filter((p) => p.hasMedia === false && p.uid !== 'default')

  // 一键清理所有虚拟档案：逐个调用删除（后端对无媒体 UID 同样可幂等删除），最后统一刷新
  const handleCleanupVirtual = async () => {
    if (virtualProfiles.length === 0) {
      showMessage(t('settings.profile.noVirtual'))
      return
    }
    if (!window.electronAPI?.profile?.delete) {
      showMessage(t('profileAction.unsupported'), 'error')
      return
    }
    if (!confirm(t('settings.profile.cleanupVirtualConfirm', { count: virtualProfiles.length }))) {
      return
    }
    let failed = 0
    for (const p of virtualProfiles) {
      try {
        await window.electronAPI.profile.delete(p.uid)
      } catch {
        failed += 1
      }
    }
    await refreshProfiles()
    if (failed === 0) {
      showMessage(t('settings.profile.cleanupDone', { count: virtualProfiles.length }))
    } else {
      showMessage(t('settings.profile.cleanupPartial', { failed }), 'error')
    }
  }

  const totalTimeCount = stats?.timeDistribution.reduce((sum, t) => sum + t.cnt, 0) ?? 0

  return (
    <SectionShell title={t('settings.sections.profileManage')}>
      {/* 新增档案 */}
      <div className="space-y-2 p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
        <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          {t('settings.profile.addProfile')}
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder={t('settings.profile.uidPlaceholder')}
            value={newUid}
            onChange={(e) => setNewUid(e.target.value)}
            className="input-field flex-1 text-sm"
            maxLength={32}
          />
          <input
            type="text"
            placeholder={t('settings.profile.nicknamePlaceholder')}
            value={newNickname}
            onChange={(e) => setNewNickname(e.target.value)}
            className="input-field flex-1 text-sm"
            maxLength={64}
          />
          <button className="btn-primary text-sm px-4" onClick={handleAddProfile}>
            {t('settings.profile.add')}
          </button>
        </div>
      </div>

      {/* 档案列表 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2 mb-2">
          <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            {t('settings.profile.list')}
          </p>
          {virtualProfiles.length > 0 && (
            <button
              type="button"
              className="text-xs px-2 py-1 rounded transition-colors"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)' }}
              onClick={handleCleanupVirtual}
            >
              {t('settings.profile.cleanupVirtual')}
            </button>
          )}
        </div>
        {profiles.length === 0 ? (
          <p className="text-sm text-center py-3" style={{ color: 'var(--text-tertiary)' }}>
            {t('settings.profile.empty')}
          </p>
        ) : (
          profiles.map((p) => (
            <div
              key={p.uid}
              className={`p-3 rounded-lg cursor-pointer transition-colors ${selectedUid === p.uid ? 'ring-1' : ''}`}
              style={
                {
                  background: 'var(--bg-tertiary)',
                  // U9：用类型断言替代 @ts-expect-error，明确告知 TS 这是 CSS 变量属性
                  ['--tw-ring-color' as string]: 'var(--accent)'
                } as React.CSSProperties
              }
              onClick={() => setSelectedUid(p.uid)}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <div
                    className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-sm font-bold"
                    style={{ background: 'var(--accent)', color: 'var(--text-on-accent)' }}
                  >
                    {(
                      p.nickname || (p.uid === 'default' ? t('profile.defaultProfile') : p.uid)
                    ).charAt(0)}
                  </div>
                  <div className="min-w-0">
                    {editingUid === p.uid ? (
                      <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="text"
                          value={editNickname}
                          onChange={(e) => setEditNickname(e.target.value)}
                          className="input-field text-sm py-1 px-2"
                          maxLength={64}
                          autoFocus
                        />
                        <button
                          className="btn-primary text-xs px-2 py-1"
                          onClick={() => handleUpdateNickname(p.uid)}
                        >
                          {t('settings.profile.save')}
                        </button>
                        <button
                          className="btn-secondary text-xs px-2 py-1"
                          onClick={() => setEditingUid(null)}
                        >
                          {t('settings.profile.cancel')}
                        </button>
                      </div>
                    ) : (
                      <>
                        <p
                          className="text-sm font-medium truncate"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          {p.nickname ||
                            (p.uid === 'default' ? t('profile.defaultProfile') : p.uid)}
                        </p>
                        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                          UID: {p.uid}
                          {!p.hasMedia && p.uid !== 'default' && (
                            <span
                              className="ml-2 px-1.5 py-0.5 rounded text-[10px]"
                              style={{
                                background: 'var(--bg-tertiary)',
                                color: 'var(--text-tertiary)'
                              }}
                            >
                              {t('settings.profile.virtualBadge')}
                            </span>
                          )}
                        </p>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                  {editingUid !== p.uid && (
                    <button
                      className="icon-btn text-xs"
                      title={t('settings.profile.editNickname')}
                      onClick={() => {
                        setEditingUid(p.uid)
                        setEditNickname(p.nickname)
                      }}
                    >
                      <IconEdit size={14} />
                    </button>
                  )}
                  <button
                    className="icon-btn text-xs"
                    title={t('settings.profile.switchTo')}
                    onClick={() => handleSwitchProfile(p.uid)}
                  >
                    <IconCheck size={14} />
                  </button>
                  {p.uid !== 'default' && (
                    <button
                      className="icon-btn text-xs"
                      style={{ color: 'var(--danger)' }}
                      title={t('settings.profile.deleteProfile')}
                      onClick={() => handleDeleteProfile(p.uid)}
                    >
                      <IconDelete size={14} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* 拍摄统计 */}
      {selectedUid && (
        <div className="pt-3 space-y-3" style={{ borderTop: '1px solid var(--divider)' }}>
          <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            {t('settings.profile.stats', {
              name: profiles.find((p) => p.uid === selectedUid)?.nickname || selectedUid
            })}
          </p>
          {loadingStats ? (
            <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
              {t('settings.profile.loading')}
            </p>
          ) : !stats ? (
            <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
              {t('settings.profile.noData')}
            </p>
          ) : (
            <>
              {/* 基础统计网格 */}
              <div className="grid grid-cols-2 gap-2">
                <div className="p-2 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                  <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {t('settings.profile.totalFiles')}
                  </p>
                  <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                    {stats.totalCount}
                  </p>
                </div>
                <div className="p-2 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                  <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {t('settings.profile.storageUsage')}
                  </p>
                  <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                    {formatFileSize(stats.totalSize)}
                  </p>
                </div>
                <div className="p-2 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                  <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {t('settings.profile.images')}
                  </p>
                  <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                    {stats.imageCount}
                  </p>
                </div>
                <div className="p-2 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                  <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {t('settings.profile.videos')}
                  </p>
                  <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                    {stats.videoCount}
                  </p>
                </div>
              </div>

              {/* 拍摄时间范围 */}
              {stats.earliestTime && stats.latestTime && (
                <div
                  className="p-2 rounded-lg text-xs"
                  style={{ background: 'var(--bg-tertiary)' }}
                >
                  <span style={{ color: 'var(--text-tertiary)' }}>
                    {t('settings.profile.shotRange')}
                  </span>
                  <span style={{ color: 'var(--text-primary)' }}>
                    {stats.earliestTime.slice(0, 10)} ~ {stats.latestTime.slice(0, 10)}
                  </span>
                </div>
              )}

              {/* 套装偏好 Top 5 */}
              {stats.topOutfits.length > 0 && (
                <div>
                  <p className="text-xs mb-1" style={{ color: 'var(--text-tertiary)' }}>
                    {t('settings.profile.outfitTop')}
                  </p>
                  <div className="space-y-1">
                    {stats.topOutfits.map((item, idx) => (
                      <div
                        key={item.outfit}
                        className="flex items-center justify-between text-xs p-1.5 rounded"
                        style={{ background: 'var(--bg-tertiary)' }}
                      >
                        <span style={{ color: 'var(--text-primary)' }}>
                          {idx + 1}. {item.outfit}
                        </span>
                        <span style={{ color: 'var(--text-tertiary)' }}>
                          {t('settings.profile.photos', { count: item.cnt })}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 场景偏好 Top 5 */}
              {stats.topScenes.length > 0 && (
                <div>
                  <p className="text-xs mb-1" style={{ color: 'var(--text-tertiary)' }}>
                    {t('settings.profile.sceneTop')}
                  </p>
                  <div className="space-y-1">
                    {stats.topScenes.map((item, idx) => (
                      <div
                        key={item.scene_category}
                        className="flex items-center justify-between text-xs p-1.5 rounded"
                        style={{ background: 'var(--bg-tertiary)' }}
                      >
                        <span style={{ color: 'var(--text-primary)' }}>
                          {idx + 1}. {getSceneLabel(item.scene_category)}
                        </span>
                        <span style={{ color: 'var(--text-tertiary)' }}>
                          {t('settings.profile.photos', { count: item.cnt })}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 时段偏好 */}
              {stats.timeDistribution.length > 0 && totalTimeCount > 0 && (
                <div>
                  <p className="text-xs mb-1" style={{ color: 'var(--text-tertiary)' }}>
                    {t('settings.profile.timeTop')}
                  </p>
                  <div className="space-y-1">
                    {stats.timeDistribution.map((item) => {
                      const percent =
                        totalTimeCount > 0 ? Math.round((item.cnt / totalTimeCount) * 100) : 0
                      return (
                        <div key={item.scene_time} className="text-xs">
                          <div className="flex items-center justify-between mb-0.5">
                            <span style={{ color: 'var(--text-primary)' }}>
                              {getTimeLabel(item.scene_time)}
                            </span>
                            <span style={{ color: 'var(--text-tertiary)' }}>
                              {t('settings.profile.photosWithPercent', {
                                count: item.cnt,
                                percent
                              })}
                            </span>
                          </div>
                          <div
                            className="h-1.5 rounded-full overflow-hidden"
                            style={{ background: 'var(--bg-tertiary)' }}
                          >
                            <div
                              className="h-full rounded-full transition-all"
                              style={{ width: `${percent}%`, background: 'var(--accent)' }}
                            />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </SectionShell>
  )
}
