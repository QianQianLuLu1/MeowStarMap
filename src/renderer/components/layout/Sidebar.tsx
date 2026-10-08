import React, { useMemo, useEffect, useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { useShallow } from 'zustand/react/shallow'
import { useUIStore, type ViewLevel } from '../../stores/uiStore'
import { useMediaStore, fetchMediaFromDatabase, loadProfiles } from '../../stores/mediaStore'
import { useFilteredMediaFiles } from '../../hooks/useFilteredMediaFiles'
// 流体滑块 Tab 指示器：导航切换的双边缘补间（前沿快 / 后沿慢）
import { useFluidTabIndicator } from '../../hooks/useFluidTabIndicator'
import { formatFileSize } from '../../utils/format'
import {
  IconGallery,
  IconList,
  IconSettings,
  IconDoubleChevronLeft,
  IconDoubleChevronRight,
  IconTrash,
  IconStar,
  IconDuplicate,
  IconChevronLeft,
  IconChevronDown,
  IconImage,
  IconCamera,
  IconMessage
} from '../../icons'
// P1-4：侧边栏动画预设
import { springSoft } from '../../utils/motionPresets'
// P2-U6：维度选项统一来自 shared/dimension，消除与 SmartGroupPanel 的重复定义
import { GROUP_DIMENSION_OPTIONS } from '../../../shared/dimension'

// P2-U6：Sidebar 不渲染 'none' 选项（'none' 由外层按钮单独呈现），故过滤掉
const SIDEBAR_GROUP_OPTIONS = GROUP_DIMENSION_OPTIONS.filter((opt) => opt.value !== 'none')

// P2-01：navItems label 改为 i18n key，渲染时通过 t() 翻译
const navItems: { id: ViewLevel; labelKey: string; icon: React.ReactNode }[] = [
  { id: 'gallery', labelKey: 'nav.gallery', icon: <IconGallery size={20} /> },
  { id: 'screenshots', labelKey: 'nav.screenshots', icon: <IconCamera size={20} /> },
  { id: 'favorites', labelKey: 'nav.favorites', icon: <IconStar size={20} /> },
  { id: 'resonance-records', labelKey: 'nav.resonanceRecords', icon: <IconMessage size={20} /> },
  { id: 'launcher-cache', labelKey: 'nav.launcherCache', icon: <IconImage size={20} /> },
  { id: 'categories', labelKey: 'nav.categories', icon: <IconList size={20} /> },
  { id: 'duplicates', labelKey: 'nav.duplicates', icon: <IconDuplicate size={20} /> },
  { id: 'recycle-bin', labelKey: 'nav.recycleBin', icon: <IconTrash size={20} /> },
  { id: 'settings', labelKey: 'nav.settings', icon: <IconSettings size={20} /> }
]

export const Sidebar: React.FC = () => {
  const { t } = useTranslation()
  const {
    currentView,
    sidebarCollapsed,
    navigateTo,
    toggleSidebar,
    goBack,
    viewStack,
    groupDimension,
    setGroupDimension
  } = useUIStore(
    useShallow((s) => ({
      currentView: s.currentView,
      sidebarCollapsed: s.sidebarCollapsed,
      navigateTo: s.navigateTo,
      toggleSidebar: s.toggleSidebar,
      goBack: s.goBack,
      viewStack: s.viewStack,
      groupDimension: s.groupDimension,
      setGroupDimension: s.setGroupDimension
    }))
  )
  const {
    mediaFiles,
    categories,
    currentProfileUid,
    profiles,
    setMediaFiles,
    setCurrentProfileUid
  } = useMediaStore(
    useShallow((s) => ({
      mediaFiles: s.mediaFiles,
      categories: s.categories,
      currentProfileUid: s.currentProfileUid,
      profiles: s.profiles,
      setMediaFiles: s.setMediaFiles,
      setCurrentProfileUid: s.setCurrentProfileUid
    }))
  )
  // P0-02：角色档案切换器状态
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
  const profileMenuRef = useRef<HTMLDivElement>(null)
  // P0-03：智能分组快捷面板展开状态
  const [groupPanelOpen, setGroupPanelOpen] = useState(false)

  // 流体滑块 Tab 指示器：currentView 不在导航项内（detail / editor）时自动隐藏
  const { containerRef, indicatorRef, registerItem } = useFluidTabIndicator(currentView)

  // P0-02：启动时加载角色档案列表
  useEffect(() => {
    void loadProfiles()
  }, [])

  // P0-02：点击外部关闭角色档案菜单
  useEffect(() => {
    if (!profileMenuOpen) return
    const handleClick = (e: MouseEvent) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target as Node)) {
        setProfileMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [profileMenuOpen])

  // P0-02：切换角色档案，重新加载媒体文件
  const handleProfileSwitch = async (uid: string) => {
    setProfileMenuOpen(false)
    if (uid === currentProfileUid) return
    setCurrentProfileUid(uid)
    // 持久化当前档案选择
    if (window.electronAPI?.settings) {
      try {
        await window.electronAPI.settings.set('currentProfileUid', uid)
      } catch {}
    }
    // 重新加载媒体文件
    const res = await fetchMediaFromDatabase()
    if (res) setMediaFiles(res.files)
  }

  // U-G12：viewStack 深度 > 1 时显示返回按钮（用户已进入子层级）
  const canGoBack = viewStack.length > 1

  const { imageCount, videoCount, totalSize } = useMemo(() => {
    let images = 0
    let videos = 0
    let size = 0
    for (const f of mediaFiles) {
      if (f.file_type === 'image') images++
      else if (f.file_type === 'video') videos++
      size += f.file_size
    }
    return { imageCount: images, videoCount: videos, totalSize: size }
  }, [mediaFiles])

  // 诊断：过滤后显示数量（用于显示"已加载 vs 已过滤"差异）
  const filteredFiles = useFilteredMediaFiles()
  const { filteredImageCount, filteredVideoCount } = useMemo(() => {
    let images = 0
    let videos = 0
    for (const f of filteredFiles) {
      if (f.file_type === 'image') images++
      else if (f.file_type === 'video') videos++
    }
    return { filteredImageCount: images, filteredVideoCount: videos }
  }, [filteredFiles])

  const loadedTotal = imageCount + videoCount
  const filteredTotal = filteredImageCount + filteredVideoCount
  const showFilteredHint = filteredTotal < loadedTotal

  // P0-02：当前档案显示名
  // P2-01：'全部档案' 改为 i18n key；默认档案（uid='default'）昵称留空，回退 t('profile.defaultProfile')
  const currentProfile = profiles.find((p) => p.uid === currentProfileUid)
  const currentProfileLabel =
    currentProfileUid === 'all'
      ? t('nav.allProfiles')
      : currentProfile?.nickname ||
        (currentProfileUid === 'default' ? t('profile.defaultProfile') : currentProfileUid)

  return (
    <motion.aside
      className="h-full flex flex-col glass-panel liquid-glass liquid-glass--sidebar overflow-hidden"
      animate={{ width: sidebarCollapsed ? 64 : 220 }}
      transition={springSoft}
    >
      <div className="flex items-center justify-between p-4 h-10">
        {!sidebarCollapsed && (
          <button
            className={`flex items-center gap-1 text-sm font-semibold transition-colors ${canGoBack ? 'cursor-pointer' : 'cursor-default'}`}
            style={{ color: canGoBack ? 'var(--accent)' : 'var(--glass-ink)' }}
            onClick={() => canGoBack && goBack()}
            disabled={!canGoBack}
            title={canGoBack ? t('nav.backToTop') : t('nav.alreadyAtTop')}
          >
            {canGoBack && <IconChevronLeft size={16} />}
            <span>{canGoBack ? t('common.back') : t('nav.menu')}</span>
          </button>
        )}
        <button
          className="icon-btn motion-hover-scale-lg"
          onClick={toggleSidebar}
          title={sidebarCollapsed ? t('nav.expand') : t('nav.collapse')}
        >
          {sidebarCollapsed ? (
            <IconDoubleChevronRight size={16} />
          ) : (
            <IconDoubleChevronLeft size={16} />
          )}
        </button>
      </div>

      {/* P0-02：角色档案切换器（未折叠时显示） */}
      {!sidebarCollapsed && (
        <div ref={profileMenuRef} className="px-2 relative">
          <button
            className="w-full flex items-center justify-between px-3 py-2 rounded-lg transition-colors hover:bg-[var(--hover-bg)]"
            style={{ background: 'var(--bg-tertiary)' }}
            onClick={() => setProfileMenuOpen((v) => !v)}
            title={t('nav.switchProfile')}
          >
            <div className="flex items-center gap-2 min-w-0">
              <div
                className="w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold"
                style={{ background: 'var(--accent)', color: 'white' }}
              >
                {currentProfileLabel.charAt(0)}
              </div>
              <span className="text-sm truncate" style={{ color: 'var(--glass-ink)' }}>
                {currentProfileLabel}
              </span>
            </div>
            <IconChevronDown size={14} />
          </button>
          {profileMenuOpen && (
            <div
              role="menu"
              data-glass-scroll-ignore=""
              className="absolute left-2 right-2 top-full mt-1 glass-panel py-1 z-50 max-h-60 overflow-y-auto"
              style={{ animation: 'scaleIn 150ms ease-out' }}
            >
              <button
                role="menuitem"
                className="w-full text-left px-3 py-2 text-sm transition-colors hover:bg-[var(--hover-bg)]"
                style={{
                  color: currentProfileUid === 'all' ? 'var(--accent)' : 'var(--glass-ink)'
                }}
                onClick={() => handleProfileSwitch('all')}
              >
                {t('nav.allProfiles')}
              </button>
              {profiles.map((p) => (
                <button
                  key={p.uid}
                  role="menuitem"
                  className="w-full text-left px-3 py-2 text-sm transition-colors hover:bg-[var(--hover-bg)]"
                  style={{
                    color: currentProfileUid === p.uid ? 'var(--accent)' : 'var(--glass-ink)'
                  }}
                  onClick={() => handleProfileSwitch(p.uid)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">
                      {p.nickname || (p.uid === 'default' ? t('profile.defaultProfile') : p.uid)}
                    </span>
                    <span className="text-xs" style={{ color: 'var(--glass-ink-3)' }}>
                      {p.uid}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* U-G12：折叠状态下显示返回图标按钮 */}
      {sidebarCollapsed && canGoBack && (
        <div className="px-2">
          <button
            className="nav-item w-full justify-center"
            onClick={() => goBack()}
            title={t('nav.backToTop')}
            aria-label={t('nav.backToTop')}
          >
            <IconChevronLeft size={20} />
          </button>
        </div>
      )}

      <nav ref={containerRef} className="nav-fluid flex-1 px-2 space-y-1 mt-2 relative">
        {/* 流体滑块：首个子节点，绘制在按钮之下（按钮 position:relative 且在 DOM 中靠后） */}
        <div ref={indicatorRef} className="fluid-tab-indicator" aria-hidden="true" />
        {navItems.map((item) => (
          <button
            key={item.id}
            ref={registerItem(item.id)}
            className={`nav-item w-full motion-hover-scale-sm ${currentView === item.id ? 'active' : ''}`}
            onClick={() => navigateTo(item.id)}
            title={t(item.labelKey)}
          >
            {item.icon}
            {!sidebarCollapsed && <span className="text-sm font-medium">{t(item.labelKey)}</span>}
          </button>
        ))}

        {/* P0-03：智能分组快捷区（仅在图库视图且侧边栏未折叠时显示） */}
        {!sidebarCollapsed && currentView === 'gallery' && (
          <div className="pt-3 mt-3" style={{ borderTop: '1px solid var(--divider)' }}>
            <button
              className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold transition-colors hover:bg-[var(--hover-bg)]"
              style={{ color: 'var(--glass-ink-2)' }}
              onClick={() => setGroupPanelOpen((v) => !v)}
              title={t('group.title')}
            >
              <span>{t('group.title')}</span>
              <IconChevronDown
                size={12}
                style={{
                  transform: groupPanelOpen ? 'rotate(180deg)' : 'none',
                  transition: 'transform 150ms'
                }}
              />
            </button>
            {groupPanelOpen && (
              <div className="px-2 py-1 space-y-0.5">
                <button
                  className="w-full text-left px-2 py-1 text-xs rounded transition-colors hover:bg-[var(--hover-bg)]"
                  style={{
                    color: groupDimension === 'none' ? 'var(--accent)' : 'var(--glass-ink-2)',
                    fontWeight: groupDimension === 'none' ? 600 : 400
                  }}
                  onClick={() => setGroupDimension('none')}
                >
                  {t('group.none')}
                </button>
                {SIDEBAR_GROUP_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    className="w-full text-left px-2 py-1 text-xs rounded transition-colors hover:bg-[var(--hover-bg)]"
                    style={{
                      color: groupDimension === opt.value ? 'var(--accent)' : 'var(--glass-ink-2)',
                      fontWeight: groupDimension === opt.value ? 600 : 400
                    }}
                    onClick={() => setGroupDimension(opt.value)}
                    title={t(opt.labelKey)}
                  >
                    {t(opt.labelKey)}
                  </button>
                ))}
                <div
                  className="pt-1 mt-1 text-xs"
                  style={{ color: 'var(--glass-ink-3)', borderTop: '1px solid var(--divider)' }}
                >
                  {t('group.title')}
                </div>
              </div>
            )}
          </div>
        )}
      </nav>

      {!sidebarCollapsed && (
        <div
          className="p-4 space-y-3 text-xs"
          style={{ color: 'var(--glass-ink-2)', borderTop: '1px solid var(--divider)' }}
        >
          <div className="flex justify-between">
            <span>{t('nav.images')}</span>
            <span
              className="font-medium"
              style={{ color: 'var(--glass-ink)' }}
              title={
                showFilteredHint
                  ? `已加载 ${imageCount}，过滤后显示 ${filteredImageCount}`
                  : undefined
              }
            >
              {imageCount}
              {showFilteredHint && (
                <span style={{ color: 'var(--text-tertiary)', fontSize: '0.85em' }}>
                  {' '}
                  / {filteredImageCount}
                </span>
              )}
            </span>
          </div>
          <div className="flex justify-between">
            <span>{t('nav.videos')}</span>
            <span
              className="font-medium"
              style={{ color: 'var(--glass-ink)' }}
              title={
                showFilteredHint
                  ? `已加载 ${videoCount}，过滤后显示 ${filteredVideoCount}`
                  : undefined
              }
            >
              {videoCount}
              {showFilteredHint && (
                <span style={{ color: 'var(--text-tertiary)', fontSize: '0.85em' }}>
                  {' '}
                  / {filteredVideoCount}
                </span>
              )}
            </span>
          </div>
          <div className="flex justify-between">
            <span>{t('nav.categories')}</span>
            <span className="font-medium" style={{ color: 'var(--glass-ink)' }}>
              {categories.length}
            </span>
          </div>
          <div className="flex justify-between">
            <span>{t('nav.storage')}</span>
            <span className="font-medium" style={{ color: 'var(--glass-ink)' }}>
              {formatFileSize(totalSize)}
            </span>
          </div>
        </div>
      )}
    </motion.aside>
  )
}
