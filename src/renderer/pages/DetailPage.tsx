import React, { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useUIStore, selectFocusedMediaId } from '../stores/uiStore'
import {
  useMediaStore,
  toFileUrl,
  updateMediaFileAndPersist,
  OUTFIT_PRESETS,
  getSceneTimeLabel
} from '../stores/mediaStore'
import { useFilteredMediaFiles } from '../hooks/useFilteredMediaFiles'
import { ConfirmDialog } from '../components/common/ConfirmDialog'
import { TagManager } from '../components/gallery/TagManager'
import { VideoPlayer } from '../components/video/VideoPlayer'
import { useGlobalToast } from './settings/sections'
import { InternalError } from '../../shared/errors/app-error'
import { useExif } from '../hooks/useExif'
import { EmptyState } from '../components/common/EmptyState'
import { SkeletonDetail } from '../components/common/Skeleton'
import { ZoomableContainer } from '../components/common/ZoomableContainer'
// THUMBNAIL_OPTIMIZATION_PLAN 节点4：主图渐进加载——低清底图先行、原图 onLoad 淡入
import { toLowQualityUrl } from '../components/gallery/VirtualImageGrid'
import { formatFileSize } from '../utils/format'
import { formatDateTime } from '../utils/date'
import { IconChevronLeft, IconChevronRight, IconStar, IconTag, IconWarning } from '../icons'
import { CameraInfoPanel } from '../components/common/CameraInfoPanel'
import { PhotographyPanel } from '../components/common/PhotographyPanel'
import { NikkiInfoPanel } from '../components/common/NikkiInfoPanel'
import { OutfitPanel } from '../components/common/OutfitPanel'
import { InteractionPanel } from '../components/common/InteractionPanel'

export const DetailPage: React.FC = () => {
  const { t } = useTranslation()
  const selectedMediaId = useUIStore(selectFocusedMediaId)
  const navigateTo = useUIStore((s) => s.navigateTo)
  const openFullscreen = useUIStore((s) => s.openFullscreen)
  const setPendingEditorMetadata = useUIStore((s) => s.setPendingEditorMetadata)
  const mediaFiles = useMediaStore((s) => s.mediaFiles)
  const mediaLoading = useMediaStore((s) => s.loading)
  const deleteMediaFiles = useMediaStore((s) => s.deleteMediaFiles)
  const filteredFiles = useFilteredMediaFiles()
  const media = mediaFiles.find((f) => f.id === selectedMediaId)
  // U-S6：使用 useExif hook 替代手写 EXIF 加载（删除重复的 ExifData interface 与 useEffect）
  const { exif } = useExif(media?.file_path, !!media)
  // F-G7：视频元数据状态（时长/分辨率/编码/帧率）
  const [videoMeta, setVideoMeta] = useState<{
    duration?: number
    width?: number
    height?: number
    codec?: string
    frameRate?: number
  } | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [showTagManager, setShowTagManager] = useState(false)
  // F-O1：套装标注编辑状态
  const [editingOutfit, setEditingOutfit] = useState(false)
  const [outfitInput, setOutfitInput] = useState('')
  // XMP 元数据：从图片读取的编辑参数（用于一键恢复到编辑器）
  const [editorMetadata, setEditorMetadata] = useState<{
    filterName: string | null
    filterCategory: string | null
    filterIntensity: number | null
    lutName: string | null
    hasWatermark: boolean
    exportTimestamp: string | null
    raw: unknown
  } | null>(null)
  const [metadataLoading, setMetadataLoading] = useState(false)

  const showMessage = useGlobalToast()

  const currentIndex = media ? filteredFiles.findIndex((f) => f.id === media.id) : -1

  const navigateToIndex = useCallback(
    (index: number) => {
      const file = filteredFiles[index]
      if (file) useUIStore.getState().selectMedia(file.id)
    },
    [filteredFiles]
  )

  // F-G7：视频文件加载元数据（时长/分辨率/编码/帧率），图片不加载
  useEffect(() => {
    if (!media || media.file_type !== 'video' || !window.electronAPI?.video?.metadata) {
      setVideoMeta(null)
      return
    }
    const token = { cancelled: false }
    window.electronAPI.video
      .metadata(media.file_path)
      .then((data) => {
        if (!token.cancelled && data?.success) {
          setVideoMeta({
            duration: data.duration,
            width: data.width,
            height: data.height,
            codec: data.codec,
            frameRate: data.frameRate
          })
        }
      })
      .catch(() => {
        if (!token.cancelled) setVideoMeta(null)
      })
    return () => {
      token.cancelled = true
    }
  }, [media])

  // XMP 元数据：仅对图片读取已写入的编辑参数（视频不支持）
  // 读取失败或无元数据时静默置空，不影响详情页正常展示
  useEffect(() => {
    if (!media || media.file_type !== 'image' || !window.electronAPI?.editor?.readMetadata) {
      setEditorMetadata(null)
      return
    }
    const token = { cancelled: false }
    setMetadataLoading(true)
    window.electronAPI.editor
      .readMetadata(media.file_path)
      .then((data) => {
        if (token.cancelled) return
        if (!data) {
          setEditorMetadata(null)
          return
        }
        const params = (data.params ?? {}) as Record<string, unknown>
        setEditorMetadata({
          filterName: data.filter?.name ?? null,
          filterCategory: data.filter?.category ?? null,
          filterIntensity: typeof data.filterIntensity === 'number' ? data.filterIntensity : null,
          lutName: typeof params.lut === 'string' && params.lut ? params.lut : null,
          hasWatermark: !!data.watermark,
          exportTimestamp: data.exportTimestamp || null,
          raw: data
        })
      })
      .catch(() => {
        if (!token.cancelled) setEditorMetadata(null)
      })
      .finally(() => {
        if (!token.cancelled) setMetadataLoading(false)
      })
    return () => {
      token.cancelled = true
    }
  }, [media])

  // 键盘导航：左右切换、Esc 返回、T 打开标签管理
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (showTagManager) {
        if (e.key === 'Escape') setShowTagManager(false)
        return
      }
      switch (e.key) {
        case 'ArrowLeft':
          if (currentIndex > 0) navigateToIndex(currentIndex - 1)
          break
        case 'ArrowRight':
          if (currentIndex < filteredFiles.length - 1) navigateToIndex(currentIndex + 1)
          break
        case 'Escape':
          navigateTo('gallery')
          break
        case 't':
        case 'T':
          if (media) setShowTagManager(true)
          break
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [showTagManager, media, filteredFiles, currentIndex, navigateToIndex, navigateTo])

  if (!media && mediaLoading) {
    // 加载中：详情页布局骨架（与最终布局同形，避免跳变）
    return <SkeletonDetail />
  }

  if (!media) {
    // U-S6：使用 EmptyState 统一空态
    return (
      <EmptyState
        title={t('detail.emptyTitle')}
        ctaLabel={t('detail.actions.backToGallery')}
        onCta={() => navigateTo('gallery')}
      />
    )
  }

  const fileUrl = toFileUrl(media.file_path)
  // 节点4：由 thumbnail 推导低清底图（64px）；游戏原生缩略图路径推导为 null → 行为与现状一致
  const thumbPlaceholderUrl = (() => {
    const low = toLowQualityUrl(media.thumbnail)
    return low ? toFileUrl(low) : null
  })()

  const handleDelete = async () => {
    if (!window.electronAPI) return
    try {
      const result = await window.electronAPI.file.delete([media.file_path])
      if (result.success) {
        await window.electronAPI.mediaAction.delete(Number(media.id))
        deleteMediaFiles([media.id])
        navigateTo('gallery')
      } else {
        showMessage(result.message || t('detail.actions.deleteFailed'), 'error')
      }
    } catch (error) {
      showMessage(
        error instanceof Error ? error.message : t('detail.actions.deleteFailed'),
        'error'
      )
    }
    setConfirm(false)
  }

  const handleSaveAs = async () => {
    if (!window.electronAPI) return
    try {
      const targetDir = await window.electronAPI.dialog.selectDirectory()
      if (!targetDir) return
      const result = await window.electronAPI.file.saveAs(media.file_path, targetDir)
      if (!result.success) {
        showMessage(result.message || t('detail.actions.saveAsFailed'), 'error')
      } else {
        showMessage(t('detail.actions.saveAsSuccess'), 'success')
      }
    } catch (error) {
      showMessage(
        error instanceof Error ? error.message : t('detail.actions.saveAsFailed'),
        'error'
      )
    }
  }

  const toggleFavorite = async () => {
    if (!window.electronAPI) return
    const next = !media.is_favorite
    // 乐观更新
    useMediaStore.getState().updateMediaFile(media.id, { is_favorite: next })
    try {
      const result = await updateMediaFileAndPersist(media.id, { is_favorite: next })
      if (!result.success)
        throw new InternalError(result.message ?? t('detail.actions.operationFailed'))
    } catch (error) {
      // 失败回滚
      useMediaStore.getState().updateMediaFile(media.id, { is_favorite: media.is_favorite })
      showMessage(
        error instanceof Error ? error.message : t('detail.actions.operationFailed'),
        'error'
      )
    }
  }

  const updateRating = async (rating: number) => {
    if (!window.electronAPI) return
    const prevRating = media.rating
    // 乐观更新
    useMediaStore.getState().updateMediaFile(media.id, { rating })
    try {
      const result = await updateMediaFileAndPersist(media.id, { rating })
      if (!result.success)
        throw new InternalError(result.message ?? t('detail.actions.ratingFailed'))
    } catch (error) {
      // 失败回滚
      useMediaStore.getState().updateMediaFile(media.id, { rating: prevRating })
      showMessage(
        error instanceof Error ? error.message : t('detail.actions.ratingFailed'),
        'error'
      )
    }
  }

  // F-O1：开始编辑套装标注
  const startEditOutfit = () => {
    setOutfitInput(media.outfit || '')
    setEditingOutfit(true)
  }

  // F-O1：保存套装标注
  const handleSaveOutfit = async () => {
    if (!window.electronAPI || !media) return
    const trimmed = outfitInput.trim()
    if (trimmed.length > 100) {
      showMessage(t('detail.outfit.maxLengthError'), 'error')
      return
    }
    const prevOutfit = media.outfit || ''
    useMediaStore.getState().updateMediaFile(media.id, { outfit: trimmed })
    setEditingOutfit(false)
    try {
      const result = await updateMediaFileAndPersist(media.id, { outfit: trimmed })
      if (!result.success) throw new InternalError(result.message ?? t('detail.outfit.saveFailed'))
    } catch (error) {
      // 失败回滚
      useMediaStore.getState().updateMediaFile(media.id, { outfit: prevOutfit })
      showMessage(error instanceof Error ? error.message : t('detail.outfit.saveFailed'), 'error')
    }
  }

  // F-O1：清除套装标注
  const handleClearOutfit = async () => {
    if (!window.electronAPI || !media) return
    const prevOutfit = media.outfit || ''
    useMediaStore.getState().updateMediaFile(media.id, { outfit: '' })
    setEditingOutfit(false)
    setOutfitInput('')
    try {
      const result = await updateMediaFileAndPersist(media.id, { outfit: '' })
      if (!result.success) throw new InternalError(result.message ?? t('detail.outfit.clearFailed'))
    } catch (error) {
      useMediaStore.getState().updateMediaFile(media.id, { outfit: prevOutfit })
      showMessage(error instanceof Error ? error.message : t('detail.outfit.clearFailed'), 'error')
    }
  }

  // T02：从库中移除丢失记录（不调用系统回收站，因为物理文件已不存在）
  const handleRemoveFromLibrary = async () => {
    if (!window.electronAPI || !media) return
    try {
      const result = await window.electronAPI.mediaAction.removeMissing(Number(media.id))
      if (!result.success) {
        showMessage(result.message || t('detail.missing.removeFailed'), 'error')
        return
      }
      deleteMediaFiles([media.id])
      showMessage(t('detail.missing.removeSuccess'), 'success')
      navigateTo('gallery')
    } catch (error) {
      showMessage(
        error instanceof Error ? error.message : t('detail.missing.removeFailed'),
        'error'
      )
    }
  }

  // XMP 元数据：一键恢复编辑参数到编辑器
  // 将读取到的元数据通过 uiStore.pendingEditorMetadata 传递给编辑器，编辑器挂载时消费并清空
  const handleRestoreToEditor = () => {
    if (!media || !editorMetadata?.raw) return
    const raw = editorMetadata.raw as {
      params: Record<string, unknown>
      filter: { name: string; category: string; params: unknown } | null
      filterIntensity: number
      watermark: Record<string, unknown> | null
      exportTimestamp: string
    }
    setPendingEditorMetadata({
      params: raw.params,
      filter: raw.filter,
      filterIntensity: raw.filterIntensity,
      watermark: raw.watermark,
      exportTimestamp: raw.exportTimestamp,
      sourceFileName: media.file_name
    })
    navigateTo('editor')
  }

  return (
    <div className="h-full flex gap-5">
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center justify-between mb-4">
          <button className="btn-secondary" onClick={() => navigateTo('gallery')}>
            {t('detail.actions.backToGallery')}
          </button>
          <div className="flex items-center gap-2">
            {media.file_type === 'image' && (
              <button className="btn-secondary" onClick={() => navigateTo('editor')}>
                {t('detail.actions.edit')}
              </button>
            )}
            <button className="btn-secondary" onClick={() => setShowTagManager(true)}>
              <IconTag size={16} />
              {t('detail.actions.tags')}
            </button>
            <button className="btn-secondary" onClick={handleSaveAs}>
              {t('detail.actions.saveAs')}
            </button>
            <button className="btn-danger" onClick={() => setConfirm(true)}>
              {t('common.delete')}
            </button>
          </div>
        </div>

        {/* T02：丢失文件提示条 */}
        {media.is_missing === true && (
          <div
            className="mb-4 p-3 rounded-xl flex items-center justify-between gap-3"
            style={{
              background: 'var(--danger-bg)',
              border: '1px solid color-mix(in srgb, var(--danger) 30%, transparent)'
            }}
          >
            <div
              className="flex items-center gap-2 text-sm"
              style={{ color: 'var(--danger-hover)' }}
            >
              <IconWarning size={16} />
              <span>{t('detail.missing.warningText')}</span>
            </div>
            <button
              className="btn-secondary text-xs flex-shrink-0"
              style={{
                background: 'var(--danger-hover)',
                color: 'var(--text-on-accent)',
                borderColor: 'var(--danger-hover)'
              }}
              onClick={handleRemoveFromLibrary}
            >
              {t('detail.missing.removeFromLibrary')}
            </button>
          </div>
        )}

        <ZoomableImage
          src={fileUrl || ''}
          alt={media.file_name}
          isVideo={media.file_type === 'video'}
          placeholderSrc={thumbPlaceholderUrl}
          onClick={() => {
            if (currentIndex >= 0) openFullscreen(currentIndex)
          }}
        />

        <div className="flex items-center justify-center gap-4 mt-4">
          <button
            className="icon-btn"
            disabled={currentIndex <= 0}
            onClick={() => navigateToIndex(currentIndex - 1)}
            aria-label={t('gallery.fullscreen.prevAriaLabel')}
          >
            <IconChevronLeft size={20} />
          </button>
          <div className="flex items-center gap-1">
            {Array.from({ length: 5 }).map((_, i) => (
              <button
                key={i}
                className="motion-hover-scale-sm"
                onClick={() => updateRating(i + 1)}
                aria-label={t('detail.actions.ratingAria', { n: i + 1 })}
              >
                <IconStar size={20} filled={i < media.rating} />
              </button>
            ))}
          </div>
          <button
            className="icon-btn"
            disabled={currentIndex >= filteredFiles.length - 1}
            onClick={() => navigateToIndex(currentIndex + 1)}
            aria-label={t('gallery.fullscreen.nextAriaLabel')}
          >
            <IconChevronRight size={20} />
          </button>
        </div>
      </div>

      <div className="w-72 glass-card p-5 space-y-5 overflow-y-auto flex-shrink-0">
        <div>
          <h3 className="text-lg font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
            {media.file_name}
          </h3>
          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            {media.file_path}
          </p>
        </div>

        <div className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span style={{ color: 'var(--text-secondary)' }}>{t('detail.fields.type')}</span>
            <span style={{ color: 'var(--text-primary)' }}>
              {media.file_type === 'image'
                ? t('gallery.toolbar.filterType.image')
                : t('gallery.toolbar.filterType.video')}{' '}
              {media.file_ext.toUpperCase()}
            </span>
          </div>
          <div className="flex justify-between">
            <span style={{ color: 'var(--text-secondary)' }}>
              {t('common.propertiesDialog.basic.size')}
            </span>
            <span style={{ color: 'var(--text-primary)' }}>{formatFileSize(media.file_size)}</span>
          </div>
          <div className="flex justify-between">
            <span style={{ color: 'var(--text-secondary)' }}>
              {t('common.propertiesDialog.basic.resolution')}
            </span>
            <span style={{ color: 'var(--text-primary)' }}>
              {media.width && media.height ? `${media.width}x${media.height}` : '-'}
            </span>
          </div>
          <div className="flex justify-between">
            <span style={{ color: 'var(--text-secondary)' }}>
              {t('common.propertiesDialog.basic.createdAt')}
            </span>
            <span style={{ color: 'var(--text-primary)' }}>{formatDateTime(media.created_at)}</span>
          </div>
          <div className="flex justify-between">
            <span style={{ color: 'var(--text-secondary)' }}>{t('detail.fields.favorite')}</span>
            <button
              onClick={toggleFavorite}
              style={{ color: media.is_favorite ? 'var(--favorite)' : 'var(--text-primary)' }}
            >
              {media.is_favorite ? t('detail.fields.favorited') : t('detail.fields.notFavorited')}
            </button>
          </div>
          {media.scene_time && media.scene_time !== 'unknown' && (
            <div className="flex justify-between">
              <span style={{ color: 'var(--text-secondary)' }}>{t('detail.fields.sceneTime')}</span>
              <span style={{ color: 'var(--text-primary)' }}>
                {t(getSceneTimeLabel(media.scene_time))}
              </span>
            </div>
          )}
          {media.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {media.tags.map((tag) => (
                <span
                  key={tag}
                  className="px-2 py-0.5 rounded-full text-xs"
                  style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* F-O1：套装标注编辑 */}
        <div className="space-y-3 text-sm pt-4" style={{ borderTop: '1px solid var(--divider)' }}>
          <div className="flex items-center justify-between">
            <h4 className="font-medium" style={{ color: 'var(--text-secondary)' }}>
              {t('detail.outfit.title')}
            </h4>
            {!editingOutfit && (
              <button
                className="text-xs px-2 py-1 rounded-md transition-colors hover:opacity-80"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--accent)' }}
                onClick={startEditOutfit}
              >
                {media.outfit ? t('detail.outfit.edit') : t('detail.outfit.add')}
              </button>
            )}
          </div>
          {editingOutfit ? (
            <div className="space-y-2">
              <input
                type="text"
                value={outfitInput}
                onChange={(e) => setOutfitInput(e.target.value)}
                placeholder={t('detail.outfit.inputPlaceholder')}
                className="input-field w-full"
                autoFocus
                maxLength={100}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveOutfit()
                  if (e.key === 'Escape') setEditingOutfit(false)
                }}
              />
              <select
                value=""
                onChange={(e) => e.target.value && setOutfitInput(e.target.value)}
                className="input-field w-full text-sm"
              >
                <option value="">{t('detail.outfit.selectPresetPlaceholder')}</option>
                {OUTFIT_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {t(preset.nameKey)}
                  </option>
                ))}
              </select>
              <div className="flex items-center gap-2">
                <button className="btn-primary text-xs flex-1" onClick={handleSaveOutfit}>
                  {t('common.save')}
                </button>
                {media.outfit && (
                  <button
                    className="btn-secondary text-xs"
                    style={{ color: 'var(--danger)' }}
                    onClick={handleClearOutfit}
                  >
                    {t('common.clear')}
                  </button>
                )}
                <button className="btn-secondary text-xs" onClick={() => setEditingOutfit(false)}>
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          ) : (
            <p
              className="text-sm"
              style={{ color: media.outfit ? 'var(--text-primary)' : 'var(--text-tertiary)' }}
            >
              {media.outfit || t('detail.outfit.emptyValue')}
            </p>
          )}
        </div>

        {exif && (
          <div className="space-y-3 text-sm pt-4" style={{ borderTop: '1px solid var(--divider)' }}>
            <h4 className="font-medium" style={{ color: 'var(--text-secondary)' }}>
              {t('detail.exif.title')}
            </h4>
            {exif.camera && (
              <div className="flex justify-between">
                <span style={{ color: 'var(--text-secondary)' }}>
                  {t('common.propertiesDialog.copySection.cameraModel')}
                </span>
                <span style={{ color: 'var(--text-primary)' }}>{exif.camera}</span>
              </div>
            )}
            {exif.lens && (
              <div className="flex justify-between">
                <span style={{ color: 'var(--text-secondary)' }}>
                  {t('common.propertiesDialog.copySection.lens')}
                </span>
                <span style={{ color: 'var(--text-primary)' }}>{exif.lens}</span>
              </div>
            )}
            {exif.aperture && (
              <div className="flex justify-between">
                <span style={{ color: 'var(--text-secondary)' }}>
                  {t('common.propertiesDialog.copySection.aperture')}
                </span>
                <span style={{ color: 'var(--text-primary)' }}>{exif.aperture}</span>
              </div>
            )}
            {exif.shutter && (
              <div className="flex justify-between">
                <span style={{ color: 'var(--text-secondary)' }}>
                  {t('common.propertiesDialog.copySection.shutter')}
                </span>
                <span style={{ color: 'var(--text-primary)' }}>{exif.shutter}</span>
              </div>
            )}
            {exif.iso && (
              <div className="flex justify-between">
                <span style={{ color: 'var(--text-secondary)' }}>ISO</span>
                <span style={{ color: 'var(--text-primary)' }}>{exif.iso}</span>
              </div>
            )}
            {exif.focalLength && (
              <div className="flex justify-between">
                <span style={{ color: 'var(--text-secondary)' }}>
                  {t('common.propertiesDialog.copySection.focalLength')}
                </span>
                <span style={{ color: 'var(--text-primary)' }}>{exif.focalLength}</span>
              </div>
            )}
            {exif.dateTaken && (
              <div className="flex justify-between">
                <span style={{ color: 'var(--text-secondary)' }}>
                  {t('common.propertiesDialog.copySection.dateTaken')}
                </span>
                <span style={{ color: 'var(--text-primary)' }}>
                  {formatDateTime(exif.dateTaken)}
                </span>
              </div>
            )}
            {exif.gps && (
              <div className="flex justify-between items-center">
                <span style={{ color: 'var(--text-secondary)' }}>{t('detail.exif.gps')}</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs" style={{ color: 'var(--text-primary)' }}>
                    {exif.gps.latitude.toFixed(6)}, {exif.gps.longitude.toFixed(6)}
                  </span>
                  <button
                    className="px-2 py-0.5 text-xs rounded-md transition-colors hover:opacity-80"
                    style={{ background: 'var(--bg-tertiary)', color: 'var(--accent)' }}
                    onClick={() => {
                      // F-S10：在系统默认浏览器中打开地图查看拍摄位置
                      const url = `https://www.openstreetmap.org/?mlat=${exif.gps!.latitude}&mlon=${exif.gps!.longitude}#map=15/${exif.gps!.latitude}/${exif.gps!.longitude}`
                      if (window.electronAPI?.shell?.openExternal) {
                        void window.electronAPI.shell.openExternal(url)
                      } else {
                        window.open(url, '_blank', 'noopener')
                      }
                    }}
                    title={t('detail.exif.viewOnMap')}
                  >
                    {t('detail.exif.viewOnMap')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* F-G7：视频元数据展示（时长/分辨率/编码/帧率） */}
        {videoMeta && (
          <div className="space-y-3 text-sm pt-4" style={{ borderTop: '1px solid var(--divider)' }}>
            <h4 className="font-medium" style={{ color: 'var(--text-secondary)' }}>
              {t('detail.video.title')}
            </h4>
            {videoMeta.duration ? (
              <div className="flex justify-between">
                <span style={{ color: 'var(--text-secondary)' }}>{t('detail.video.duration')}</span>
                <span style={{ color: 'var(--text-primary)' }}>
                  {Math.floor(videoMeta.duration / 60)}:
                  {String(Math.round(videoMeta.duration % 60)).padStart(2, '0')}
                </span>
              </div>
            ) : null}
            {videoMeta.width && videoMeta.height ? (
              <div className="flex justify-between">
                <span style={{ color: 'var(--text-secondary)' }}>
                  {t('common.propertiesDialog.basic.resolution')}
                </span>
                <span style={{ color: 'var(--text-primary)' }}>
                  {videoMeta.width} × {videoMeta.height}
                </span>
              </div>
            ) : null}
            {videoMeta.codec ? (
              <div className="flex justify-between">
                <span style={{ color: 'var(--text-secondary)' }}>{t('detail.video.codec')}</span>
                <span style={{ color: 'var(--text-primary)' }}>{videoMeta.codec}</span>
              </div>
            ) : null}
            {videoMeta.frameRate ? (
              <div className="flex justify-between">
                <span style={{ color: 'var(--text-secondary)' }}>
                  {t('detail.video.frameRate')}
                </span>
                <span style={{ color: 'var(--text-primary)' }}>
                  {Math.round(videoMeta.frameRate)} fps
                </span>
              </div>
            ) : null}
          </div>
        )}

        {/* XMP 编辑参数元数据面板：仅图片显示，含一键恢复到编辑器 */}
        {media.file_type === 'image' && (metadataLoading || editorMetadata) && (
          <div className="space-y-3 text-sm pt-4" style={{ borderTop: '1px solid var(--divider)' }}>
            <h4 className="font-medium" style={{ color: 'var(--text-secondary)' }}>
              {t('detail.editorMetadata.title')}
            </h4>
            {metadataLoading ? (
              <p style={{ color: 'var(--text-tertiary)' }}>{t('detail.editorMetadata.loading')}</p>
            ) : editorMetadata ? (
              <>
                {editorMetadata.filterName && (
                  <div className="flex justify-between">
                    <span style={{ color: 'var(--text-secondary)' }}>
                      {t('detail.editorMetadata.filter')}
                    </span>
                    <span style={{ color: 'var(--text-primary)' }}>
                      {editorMetadata.filterName}
                      {editorMetadata.filterCategory ? ` · ${editorMetadata.filterCategory}` : ''}
                    </span>
                  </div>
                )}
                {editorMetadata.filterIntensity !== null && (
                  <div className="flex justify-between">
                    <span style={{ color: 'var(--text-secondary)' }}>
                      {t('detail.editorMetadata.intensity')}
                    </span>
                    <span style={{ color: 'var(--text-primary)' }}>
                      {editorMetadata.filterIntensity}%
                    </span>
                  </div>
                )}
                {editorMetadata.lutName && (
                  <div className="flex justify-between">
                    <span style={{ color: 'var(--text-secondary)' }}>
                      {t('detail.editorMetadata.lut')}
                    </span>
                    <span style={{ color: 'var(--text-primary)' }}>{editorMetadata.lutName}</span>
                  </div>
                )}
                {editorMetadata.hasWatermark && (
                  <div className="flex justify-between">
                    <span style={{ color: 'var(--text-secondary)' }}>
                      {t('detail.editorMetadata.watermark')}
                    </span>
                    <span style={{ color: 'var(--text-primary)' }}>
                      {t('detail.editorMetadata.yes')}
                    </span>
                  </div>
                )}
                {editorMetadata.exportTimestamp && (
                  <div className="flex justify-between">
                    <span style={{ color: 'var(--text-secondary)' }}>
                      {t('detail.editorMetadata.exportedAt')}
                    </span>
                    <span style={{ color: 'var(--text-primary)' }}>
                      {formatDateTime(editorMetadata.exportTimestamp)}
                    </span>
                  </div>
                )}
                <button
                  className="btn-primary w-full text-xs"
                  onClick={handleRestoreToEditor}
                  title={t('detail.editorMetadata.restoreTooltip')}
                >
                  {t('detail.editorMetadata.restore')}
                </button>
              </>
            ) : null}
          </div>
        )}

        {/* 游戏图片信息面板 */}
        <div className="space-y-3 text-sm pt-4" style={{ borderTop: '1px solid var(--divider)' }}>
          <PhotographyPanel file={media} />
          <CameraInfoPanel file={media} />
          <NikkiInfoPanel file={media} />
          <OutfitPanel file={media} />
          <InteractionPanel file={media} />
        </div>
      </div>

      <ConfirmDialog
        open={confirm}
        title={t('detail.actions.deleteTitle')}
        message={t('detail.actions.deleteConfirmMessage', { fileName: media.file_name })}
        confirmVariant="danger"
        onConfirm={handleDelete}
        onCancel={() => setConfirm(false)}
      />

      {showTagManager && <TagManager mediaId={media.id} onClose={() => setShowTagManager(false)} />}
    </div>
  )
}

interface ZoomableImageProps {
  src: string
  alt: string
  isVideo: boolean
  onClick: () => void
  /**
   * 可选：低清缩略图底图 URL（THUMBNAIL_OPTIMIZATION_PLAN 节点4）。
   * 传入时原图 onLoad 前先显示底图，onLoad 后 200ms 淡入并卸载底图，
   * 消除详情页打开/切换时数 MB 原图的空白等待；缺省（无缩略图/视频）行为与现状一致。
   */
  placeholderSrc?: string | null
}

// P1-U12：复用 ZoomableContainer 共享组件，仅保留内容渲染差异（图片/视频）
export const ZoomableImage: React.FC<ZoomableImageProps> = ({
  src,
  alt,
  isVideo,
  onClick,
  placeholderSrc
}) => {
  const { t } = useTranslation()
  const [originalLoaded, setOriginalLoaded] = useState(false)
  // 换图时重置淡入状态
  useEffect(() => {
    setOriginalLoaded(false)
  }, [src])
  return (
    <ZoomableContainer
      maxZoom={5}
      resetVariant="icon"
      onClick={onClick}
      containerClassName="flex-1 flex items-center justify-center rounded-2xl overflow-hidden relative"
      containerStyle={{ background: 'var(--bg-tertiary)' }}
      ariaLabel={t('detail.zoomable.ariaLabel')}
    >
      {isVideo ? (
        <VideoPlayer src={src} controls className="max-w-full max-h-full" />
      ) : (
        <>
          {placeholderSrc && !originalLoaded && (
            <img
              src={placeholderSrc}
              alt=""
              aria-hidden="true"
              className="absolute inset-0 w-full h-full object-contain"
              draggable={false}
              decoding="async"
            />
          )}
          <img
            src={src || undefined}
            alt={alt}
            className={`max-w-full max-h-full object-contain transition-opacity duration-200 ${
              originalLoaded || !placeholderSrc ? 'opacity-100' : 'opacity-0'
            }`}
            draggable={false}
            decoding="async"
            onLoad={() => setOriginalLoaded(true)}
          />
        </>
      )}
    </ZoomableContainer>
  )
}
