import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Sidebar } from './Sidebar'
import { TitleBar } from './TitleBar'
import { useUIStore, selectFocusedMediaId, type ViewLevel } from '../../stores/uiStore'
import { useMediaStore } from '../../stores/mediaStore'
import { formatSize } from '../../utils/format'
// P2-5：常驻反馈按钮 + FeedbackDialog
import { FeedbackDialog } from '../common/FeedbackDialog'
import { IconMessage } from '../../icons'

// U-G11：各视图对应的状态文案（i18n 改造：模块级常量改为函数，接收 t 参数）
function getViewStatusLabel(view: ViewLevel, t: TFunction): string {
  switch (view) {
    case 'gallery':
      return t('appShell.viewStatus.gallery')
    case 'detail':
      return t('appShell.viewStatus.detail')
    case 'editor':
      return t('appShell.viewStatus.editor')
    case 'categories':
      return t('appShell.viewStatus.categories')
    case 'settings':
      return t('appShell.viewStatus.settings')
    case 'recycle-bin':
      return t('appShell.viewStatus.recycleBin')
    case 'favorites':
      return t('appShell.viewStatus.favorites')
    case 'duplicates':
      return t('appShell.viewStatus.duplicates')
    case 'launcher-cache':
      return t('appShell.viewStatus.launcherCache')
    default:
      return ''
  }
}

export const AppShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { t } = useTranslation()
  const currentView = useUIStore((s) => s.currentView)
  const selectedMediaIds = useUIStore((s) => s.selectedMediaIds)
  const selectedMediaId = useUIStore(selectFocusedMediaId)
  const mediaFiles = useMediaStore((s) => s.mediaFiles)
  const recycleBinFiles = useMediaStore((s) => s.recycleBinFiles)
  const categories = useMediaStore((s) => s.categories)
  // P2-5：反馈对话框状态
  const [feedbackOpen, setFeedbackOpen] = useState(false)

  const stats = useMemo(() => {
    let images = 0
    let videos = 0
    let size = 0
    let favorites = 0
    for (const f of mediaFiles) {
      if (f.file_type === 'image') images++
      else if (f.file_type === 'video') videos++
      size += f.file_size
      if (f.is_favorite) favorites++
    }
    return { images, videos, size, favorites }
  }, [mediaFiles])

  // 根据视图生成左右两侧状态文案（i18n 改造：模板字符串改为 t() 插值）
  const status = useMemo(() => {
    let leftText = getViewStatusLabel(currentView, t)
    let rightText = ''

    switch (currentView) {
      case 'gallery':
        leftText = t('appShell.gallerySummary', {
          total: mediaFiles.length,
          images: stats.images,
          videos: stats.videos
        })
        rightText =
          selectedMediaIds.length > 0
            ? t('appShell.selectedCount', { count: selectedMediaIds.length })
            : t('appShell.storageUsage', { size: formatSize(stats.size) })
        break
      case 'detail': {
        // U-G7：detail 视图显示当前文件索引 / 总数（如 "3 / 128"），而非"已选择 N 项"
        const idx = selectedMediaId ? mediaFiles.findIndex((f) => f.id === selectedMediaId) : -1
        rightText =
          idx >= 0
            ? t('appShell.detailPosition', { current: idx + 1, total: mediaFiles.length })
            : t('appShell.ready')
        break
      }
      case 'editor':
        rightText = t('appShell.editorMode')
        break
      case 'categories':
        leftText = t('appShell.categoriesSummary', { count: categories.length })
        rightText = t('appShell.imagesVideosSummary', {
          images: stats.images,
          videos: stats.videos
        })
        break
      case 'settings':
        rightText = t('appShell.settingsHint')
        break
      case 'recycle-bin':
        leftText = t('appShell.recycleBinSummary', { count: recycleBinFiles.length })
        rightText = t('appShell.recycleBinHint')
        break
      case 'favorites':
        leftText = t('appShell.favoritesSummary', { count: stats.favorites })
        rightText = t('appShell.storageUsage', { size: formatSize(stats.size) })
        break
      case 'duplicates':
        rightText = t('appShell.duplicatesHint')
        break
    }
    return { leftText, rightText }
  }, [
    currentView,
    mediaFiles,
    recycleBinFiles.length,
    categories.length,
    selectedMediaIds.length,
    selectedMediaId,
    stats,
    t
  ])

  return (
    <div
      className="h-screen w-screen flex flex-col overflow-hidden"
      style={{ background: 'var(--bg-primary)' }}
    >
      <TitleBar />
      <div className="flex-1 flex pt-10 overflow-hidden sidebar-gradient">
        <Sidebar />
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden p-5">{children}</div>
          <div
            className="h-8 flex items-center justify-between px-4 text-xs status-bar"
            style={{ color: 'var(--text-secondary)', borderTop: '1px solid var(--divider)' }}
          >
            <span>{status.leftText}</span>
            <div className="flex items-center gap-3">
              <span>{status.rightText}</span>
              {/* P2-5：常驻反馈按钮，点击弹出 FeedbackDialog */}
              <button
                type="button"
                className="flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-all hover:scale-105"
                style={{
                  color: 'var(--text-tertiary)',
                  background: 'transparent'
                }}
                onClick={() => setFeedbackOpen(true)}
                title={t('common.feedbackDialog.title')}
                aria-label={t('common.feedbackDialog.title')}
              >
                <IconMessage size={12} />
                <span>{t('appShell.feedbackButton')}</span>
              </button>
            </div>
          </div>
        </main>
      </div>
      {/* P2-5：全局反馈对话框 */}
      <FeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </div>
  )
}

// P1-I：formatBytes 已统一到 utils/format.ts 的 formatSize
