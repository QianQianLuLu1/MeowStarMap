import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { MediaFile } from '../../stores/mediaStore'
import { toFileUrl } from '../../stores/mediaStore'
import { useToast } from '../../hooks/useToast'
import { Toast } from '../common/Toast'
import { useRefreshMedia } from '../../hooks/useRefreshMedia'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { IconPlay } from '../../icons'
import { SliderControl } from '../common/SliderControl'
import { TaskProgressOverlay } from '../common/TaskProgressOverlay'
import { WatermarkPanel } from './WatermarkPanel'
import {
  defaultFilterParams,
  type FilterParams,
  type WatermarkConfig
} from '../../utils/imageProcessor'
import type { TaskProgress } from '../../../shared/types/progress'

interface VideoEditorProps {
  media: MediaFile
  onExit: () => void
}

interface VideoMetadataInfo {
  duration: number
  width: number
  height: number
  codec: string
  frameRate: number
}

// F-S9：预设速度选项（0.25x - 4.0x）
const SPEED_PRESETS = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0, 4.0]

// P1-K：视频格式转换支持的目标格式（与后端 VIDEO_EXPORT_FORMATS 保持一致）
// F3：desc 走 i18n（video.exportFormats.<value>），此处仅保留 value/label
const EXPORT_FORMATS = [
  { value: 'mp4', label: 'MP4' },
  { value: 'webm', label: 'WebM' },
  { value: 'gif', label: 'GIF' },
  { value: 'avi', label: 'AVI' },
  { value: 'mov', label: 'MOV' }
] as const

// 时间格式化：秒 → mm:ss.s
function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '00:00.0'
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`
}

/**
 * F-S9：视频编辑器组件。
 * 支持视频裁剪（设定起止时间）和调速（0.25x - 4.0x）。
 * 裁剪与调速均输出为新文件，不修改原视频（安全可回退）。
 */
export const VideoEditor: React.FC<VideoEditorProps> = ({ media, onExit }) => {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [metadata, setMetadata] = useState<VideoMetadataInfo | null>(null)
  const [loadingMeta, setLoadingMeta] = useState(true)
  const [processing, setProcessing] = useState(false)
  // 裁剪区间（秒）
  const [trimStart, setTrimStart] = useState(0)
  const [trimEnd, setTrimEnd] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  // 调速倍率
  const [speed, setSpeed] = useState(1.0)
  // 当前激活的编辑模式（color/watermark 走 utilityProcess ffmpeg 滤镜渲染）
  const [activeMode, setActiveMode] = useState<'trim' | 'speed' | 'export' | 'color' | 'watermark'>(
    'trim'
  )
  // P1-K：格式转换目标格式
  const [exportFormat, setExportFormat] = useState('mp4')
  // 导出目录确认（P1-05：新增 'livephoto' 模式）
  const [exportConfirm, setExportConfirm] = useState<null | {
    mode: 'trim' | 'speed' | 'export' | 'livephoto'
  }>(null)
  // 视频调色参数：复用图片编辑器 FilterParams（仅基础 5 项由 UI 暴露，其余保持默认）
  const [colorParams, setColorParams] = useState<FilterParams>(() => ({
    ...defaultFilterParams
  }))
  // 视频水印配置：复用图片编辑器 WatermarkConfig
  const [watermark, setWatermark] = useState<WatermarkConfig | null>(null)
  // 任务进度（订阅 task:progress 通道，仅匹配 video-edit / watermark taskType）
  const [taskProgress, setTaskProgress] = useState<TaskProgress | null>(null)
  const { messages, showMessage, dismiss } = useToast()
  const refreshMedia = useRefreshMedia()
  const { t } = useTranslation()

  const videoUrl = useMemo(() => toFileUrl(media.file_path), [media.file_path])

  // 订阅统一 task:progress 通道：仅处理 video-edit / watermark 任务类型
  // 终态（done/cancelled/error）3 秒后自动清理浮窗，避免遮挡 UI
  useEffect(() => {
    if (!window.electronAPI?.task?.onProgress) return
    const unsubscribe = window.electronAPI.task.onProgress((p) => {
      if (p.taskType !== 'video-edit' && p.taskType !== 'watermark') return
      setTaskProgress(p)
      if (p.phase === 'done' || p.phase === 'cancelled' || p.phase === 'error') {
        window.setTimeout(() => setTaskProgress(null), 3000)
      }
    })
    return unsubscribe
  }, [])

  // 加载视频元数据
  useEffect(() => {
    if (!window.electronAPI?.video?.metadata) {
      // 预览环境无 IPC：使用视频元素的 loadedmetadata 事件兜底
      setLoadingMeta(false)
      return
    }
    let cancelled = false
    const api = window.electronAPI
    ;(async () => {
      try {
        const res = await api.video.metadata(media.file_path)
        if (cancelled) return
        if (res.success) {
          const info: VideoMetadataInfo = {
            duration: res.duration || 0,
            width: res.width || 0,
            height: res.height || 0,
            codec: res.codec || '',
            frameRate: res.frameRate || 0
          }
          setMetadata(info)
          setTrimEnd(info.duration)
        } else {
          showMessage(res.message || t('video.readMetadataFailed'), 'error')
        }
      } catch (err) {
        if (!cancelled) showMessage(String(err), 'error')
      } finally {
        if (!cancelled) setLoadingMeta(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [media.file_path, showMessage, t])

  // 视频元素 loadedmetadata 兜底（预览环境或 IPC 失败时）
  const handleLoadedMetadata = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (!metadata || metadata.duration === 0) {
      const info: VideoMetadataInfo = {
        duration: v.duration || 0,
        width: v.videoWidth || 0,
        height: v.videoHeight || 0,
        codec: '',
        frameRate: 0
      }
      setMetadata(info)
      setTrimEnd(info.duration)
    }
  }, [metadata])

  // 播放进度同步
  const handleTimeUpdate = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    setCurrentTime(v.currentTime)
  }, [])

  // 跳转到裁剪起点
  const jumpToStart = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = trimStart
    setCurrentTime(trimStart)
  }, [trimStart])

  // 跳转到裁剪终点
  const jumpToEnd = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = Math.max(0, trimEnd - 0.5)
    setCurrentTime(v.currentTime)
  }, [trimEnd])

  // 设置当前位置为起点
  const setStartToCurrent = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    const cur = v.currentTime
    if (cur >= trimEnd) {
      showMessage(t('video.startGtEnd'), 'error')
      return
    }
    setTrimStart(cur)
  }, [trimEnd, showMessage, t])

  // 设置当前位置为终点
  const setEndToCurrent = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    const cur = v.currentTime
    if (cur <= trimStart) {
      showMessage(t('video.endLtStart'), 'error')
      return
    }
    setTrimEnd(cur)
  }, [trimStart, showMessage, t])

  /**
   * 视频调色 + 水印导出（走 utilityProcess ffmpeg 滤镜渲染）。
   *
   * 输出路径：原视频同目录下 <basename>_edited.<ext>，避免用户选目录打断流程。
   * 水印 opacity 转换：渲染层 0-100 → 共享类型 0-1（与 imageProcessor.ts 内部一致）。
   * 进度通过 task:progress 通道推送到 TaskProgressOverlay。
   */
  const performVideoEdit = useCallback(async () => {
    if (!window.electronAPI?.video?.edit) {
      showMessage(t('video.editorUnsupported'), 'error')
      return
    }
    const inputPath = media.file_path
    const lastDot = inputPath.lastIndexOf('.')
    const ext = lastDot >= 0 ? inputPath.slice(lastDot + 1) : 'mp4'
    const base = lastDot >= 0 ? inputPath.slice(0, lastDot) : inputPath
    const outputPath = `${base}_edited.${ext}`

    // 水印 opacity 渲染层 0-100 → 共享类型 0-1（worker watermark-builder 期望 0-1）
    let convertedWatermark: WatermarkConfig | null = null
    if (watermark) {
      convertedWatermark = { ...watermark }
      if (convertedWatermark.text) {
        convertedWatermark.text = {
          ...convertedWatermark.text,
          opacity: convertedWatermark.text.opacity / 100
        }
      }
      if (convertedWatermark.image) {
        convertedWatermark.image = {
          ...convertedWatermark.image,
          opacity: convertedWatermark.image.opacity / 100
        }
      }
    }

    setProcessing(true)
    try {
      const result = await window.electronAPI.video.edit({
        task: {
          inputPath,
          outputPath,
          params: colorParams,
          watermark: convertedWatermark
        }
      })
      showMessage(
        result.message || (result.success ? t('video.editSuccess') : t('video.editFailed')),
        result.success ? 'success' : 'error'
      )
      if (result.success) await refreshMedia()
    } catch (err) {
      showMessage(String(err), 'error')
    } finally {
      setProcessing(false)
    }
  }, [media.file_path, colorParams, watermark, showMessage, refreshMedia, t])

  // 触发导出（先选目录，再调用对应 IPC）
  const handleExportClick = useCallback(
    (mode: 'trim' | 'speed' | 'export' | 'livephoto' | 'color' | 'watermark') => {
      if (mode === 'trim') {
        if (trimEnd - trimStart < 0.1) {
          showMessage(t('dialog.trimTooShort'), 'error')
          return
        }
      }
      if (mode === 'export') {
        // P1-K：格式转换无需特殊校验，exportFormat 始终有合法值
        const currentExt = media.file_name.split('.').pop()?.toLowerCase()
        if (currentExt === exportFormat) {
          showMessage(t('dialog.sameFormat'), 'error')
          return
        }
      }
      // color / watermark 模式：跳过 ConfirmDialog，直接调用 utilityProcess 渲染
      // 输出文件名固定为 <原名>_edited.<原扩展>，避免目录选择打断调色流程
      if (mode === 'color' || mode === 'watermark') {
        void performVideoEdit()
        return
      }
      setExportConfirm({ mode })
    },
    [trimEnd, trimStart, showMessage, media.file_name, exportFormat, t, performVideoEdit]
  )

  // 调色参数更新（基础 5 项）
  const updateColorParam = useCallback(
    (key: 'brightness' | 'contrast' | 'saturation' | 'temperature' | 'tint', value: number) => {
      setColorParams((prev) => ({ ...prev, [key]: value }))
    },
    []
  )

  // 调色参数重置
  const resetColorParams = useCallback(() => {
    setColorParams({ ...defaultFilterParams })
  }, [])

  // 确认导出
  const performExport = useCallback(async () => {
    if (!exportConfirm || !window.electronAPI?.video) return
    if (!window.electronAPI.dialog?.selectDirectory) {
      showMessage(t('dialog.selectDirUnsupported'), 'error')
      return
    }
    const targetDir = await window.electronAPI.dialog.selectDirectory()
    if (!targetDir) return

    setProcessing(true)
    try {
      let result: { success: boolean; message: string; filePath?: string }
      if (exportConfirm.mode === 'trim') {
        result = await window.electronAPI.video.trim(media.file_path, trimStart, trimEnd, targetDir)
      } else if (exportConfirm.mode === 'export') {
        // P1-K：格式转换调用 video.export（5 种目标格式）
        result = await window.electronAPI.video.export(media.file_path, targetDir, exportFormat)
      } else if (exportConfirm.mode === 'livephoto') {
        // P1-05：导出 Apple Live Photo（JPG + MOV 配对文件）
        const lpResult = await window.electronAPI.video.exportLivePhoto(media.file_path, targetDir)
        result = {
          success: lpResult.success,
          message: lpResult.message,
          filePath: lpResult.jpgPath
        }
      } else {
        result = await window.electronAPI.video.changeSpeed(media.file_path, speed, targetDir)
      }
      showMessage(result.message, result.success ? 'success' : 'error')
      if (result.success) {
        await refreshMedia()
      }
    } catch (err) {
      showMessage(String(err), 'error')
    } finally {
      setProcessing(false)
      setExportConfirm(null)
    }
  }, [
    exportConfirm,
    media.file_path,
    trimStart,
    trimEnd,
    speed,
    exportFormat,
    showMessage,
    refreshMedia,
    t
  ])

  // 当前预览速度应用
  const handlePreviewSpeedChange = useCallback((newSpeed: number) => {
    setSpeed(newSpeed)
    const v = videoRef.current
    if (v) {
      v.playbackRate = newSpeed
    }
  }, [])

  // 视频播放/暂停切换
  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      // 裁剪模式下循环播放裁剪区间
      if (activeMode === 'trim' && v.currentTime < trimStart) {
        v.currentTime = trimStart
      }
      v.play().catch(() => {})
    } else {
      v.pause()
    }
  }, [activeMode, trimStart])

  // 裁剪模式下超出区间自动回弹
  const handleTimeUpdateForTrim = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    setCurrentTime(v.currentTime)
    if (activeMode === 'trim' && v.currentTime >= trimEnd) {
      v.pause()
      v.currentTime = trimStart
    }
  }, [activeMode, trimEnd, trimStart])

  const trimDuration = Math.max(0, trimEnd - trimStart)
  // P1-K：export 模式不改变时长，保持原视频时长
  const estimatedDuration =
    activeMode === 'speed' && metadata
      ? metadata.duration / speed
      : activeMode === 'export' && metadata
        ? metadata.duration
        : trimDuration

  return (
    <div className="h-full flex flex-col gap-4 p-4" style={{ background: 'var(--bg-primary)' }}>
      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <button
            className="btn-secondary px-3 py-1.5 text-sm"
            onClick={onExit}
            title={t('video.backToDetail')}
          >
            ← {t('common.back')}
          </button>
          <div className="min-w-0">
            <h2
              className="text-base font-semibold truncate"
              style={{ color: 'var(--text-primary)' }}
            >
              {media.file_name}
            </h2>
            {metadata && (
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                {metadata.width}×{metadata.height} · {formatTime(metadata.duration)} ·{' '}
                {metadata.codec || t('video.unknownCodec')} ·{' '}
                {metadata.frameRate ? `${metadata.frameRate.toFixed(1)}fps` : ''}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="btn-primary px-4 py-1.5 text-sm disabled:opacity-50"
            disabled={processing || loadingMeta}
            onClick={() => handleExportClick(activeMode)}
          >
            {processing
              ? t('common.processing')
              : activeMode === 'color' || activeMode === 'watermark'
                ? t('video.applyEdit')
                : t('video.exportVideo')}
          </button>
        </div>
      </div>

      {/* 主体：左侧预览 + 右侧控制面板 */}
      <div className="flex-1 flex gap-4 min-h-0">
        {/* 左侧：视频预览 */}
        <div className="flex-1 flex flex-col gap-3 min-w-0">
          <div
            className="flex-1 flex items-center justify-center rounded-2xl overflow-hidden relative"
            style={{ background: 'var(--bg-tertiary)' }}
          >
            {loadingMeta && (
              <div
                className="absolute inset-0 flex items-center justify-center z-10"
                style={{ background: 'var(--bg-tertiary)' }}
              >
                <div
                  className="w-8 h-8 border-2 border-current border-t-transparent rounded-full animate-spin"
                  style={{ color: 'var(--accent)' }}
                />
              </div>
            )}
            <video
              ref={videoRef}
              src={videoUrl || undefined}
              className="max-w-full max-h-full object-contain"
              onLoadedMetadata={handleLoadedMetadata}
              onTimeUpdate={activeMode === 'trim' ? handleTimeUpdateForTrim : handleTimeUpdate}
              onClick={togglePlay}
              controls={false}
              playsInline
            />
          </div>

          {/* 播放控制条 */}
          <div
            className="flex items-center gap-3 px-3 py-2 rounded-xl"
            style={{ background: 'var(--bg-secondary)' }}
          >
            <button
              className="w-9 h-9 rounded-full flex items-center justify-center transition-colors hover:opacity-80"
              style={{ background: 'var(--accent)', color: 'white' }}
              onClick={togglePlay}
              title={t('video.playPause')}
            >
              <IconPlay size={14} />
            </button>
            <span
              className="text-xs font-mono tabular-nums"
              style={{ color: 'var(--text-secondary)' }}
            >
              {formatTime(currentTime)} / {formatTime(metadata?.duration || 0)}
            </span>
            <div className="flex-1" />
            {activeMode === 'trim' && (
              <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {t('video.selectedRange')}：{formatTime(trimStart)} → {formatTime(trimEnd)}（
                {formatTime(trimDuration)}）
              </span>
            )}
            {activeMode === 'speed' && (
              <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {t('video.previewSpeed')}：{speed}x · {t('video.estimatedDuration')}：
                {formatTime(estimatedDuration)}
              </span>
            )}
          </div>
        </div>

        {/* 右侧：编辑模式切换与参数 */}
        <div
          className="w-80 flex flex-col gap-3 p-4 rounded-2xl overflow-y-auto"
          style={{ background: 'var(--bg-secondary)', backdropFilter: 'var(--backdrop-blur)' }}
        >
          {/* 模式切换 */}
          <div className="flex gap-1 p-1 rounded-xl" style={{ background: 'var(--bg-tertiary)' }}>
            <button
              className={`flex-1 px-2 py-1.5 text-sm rounded-lg transition-all ${activeMode === 'trim' ? 'shadow-sm' : 'opacity-60'}`}
              style={
                activeMode === 'trim'
                  ? { background: 'var(--bg-primary)', color: 'var(--accent)' }
                  : { color: 'var(--text-secondary)' }
              }
              onClick={() => setActiveMode('trim')}
            >
              {t('video.trim')}
            </button>
            <button
              className={`flex-1 px-2 py-1.5 text-sm rounded-lg transition-all ${activeMode === 'speed' ? 'shadow-sm' : 'opacity-60'}`}
              style={
                activeMode === 'speed'
                  ? { background: 'var(--bg-primary)', color: 'var(--accent)' }
                  : { color: 'var(--text-secondary)' }
              }
              onClick={() => setActiveMode('speed')}
            >
              {t('video.speed')}
            </button>
            <button
              className={`flex-1 px-2 py-1.5 text-sm rounded-lg transition-all ${activeMode === 'export' ? 'shadow-sm' : 'opacity-60'}`}
              style={
                activeMode === 'export'
                  ? { background: 'var(--bg-primary)', color: 'var(--accent)' }
                  : { color: 'var(--text-secondary)' }
              }
              onClick={() => setActiveMode('export')}
              title={t('video.formatConvert')}
            >
              {t('video.formatConvert')}
            </button>
            <button
              className={`flex-1 px-2 py-1.5 text-sm rounded-lg transition-all ${activeMode === 'color' ? 'shadow-sm' : 'opacity-60'}`}
              style={
                activeMode === 'color'
                  ? { background: 'var(--bg-primary)', color: 'var(--accent)' }
                  : { color: 'var(--text-secondary)' }
              }
              onClick={() => setActiveMode('color')}
              title={t('video.colorDesc')}
            >
              {t('video.color')}
            </button>
            <button
              className={`flex-1 px-2 py-1.5 text-sm rounded-lg transition-all ${activeMode === 'watermark' ? 'shadow-sm' : 'opacity-60'}`}
              style={
                activeMode === 'watermark'
                  ? { background: 'var(--bg-primary)', color: 'var(--accent)' }
                  : { color: 'var(--text-secondary)' }
              }
              onClick={() => setActiveMode('watermark')}
              title={t('video.watermarkDesc')}
            >
              {t('video.watermark')}
            </button>
          </div>

          {/* 裁剪模式 */}
          {activeMode === 'trim' && (
            <div className="flex flex-col gap-3">
              <p className="text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
                {t('video.trimDesc')}
              </p>

              {/* 起点 */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                    {t('video.startLabel')}
                  </label>
                  <span
                    className="text-xs font-mono tabular-nums"
                    style={{ color: 'var(--accent)' }}
                  >
                    {formatTime(trimStart)}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={metadata?.duration || 0}
                  step={0.1}
                  value={trimStart}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    if (v >= trimEnd) return
                    setTrimStart(v)
                  }}
                  className="w-full"
                  style={{ accentColor: 'var(--accent)' }}
                />
                <div className="flex gap-2">
                  <button
                    className="flex-1 px-2 py-1 text-xs rounded-md transition-colors hover:opacity-80"
                    style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                    onClick={jumpToStart}
                  >
                    {t('video.jumpToStart')}
                  </button>
                  <button
                    className="flex-1 px-2 py-1 text-xs rounded-md transition-colors hover:opacity-80"
                    style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                    onClick={setStartToCurrent}
                  >
                    {t('video.setToCurrent')}
                  </button>
                </div>
              </div>

              {/* 终点 */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                    {t('video.endLabel')}
                  </label>
                  <span
                    className="text-xs font-mono tabular-nums"
                    style={{ color: 'var(--accent)' }}
                  >
                    {formatTime(trimEnd)}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={metadata?.duration || 0}
                  step={0.1}
                  value={trimEnd}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    if (v <= trimStart) return
                    setTrimEnd(v)
                  }}
                  className="w-full"
                  style={{ accentColor: 'var(--accent)' }}
                />
                <div className="flex gap-2">
                  <button
                    className="flex-1 px-2 py-1 text-xs rounded-md transition-colors hover:opacity-80"
                    style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                    onClick={jumpToEnd}
                  >
                    {t('video.jumpToEnd')}
                  </button>
                  <button
                    className="flex-1 px-2 py-1 text-xs rounded-md transition-colors hover:opacity-80"
                    style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                    onClick={setEndToCurrent}
                  >
                    {t('video.setToCurrent')}
                  </button>
                </div>
              </div>

              {/* 区间预览 */}
              <div className="mt-2 p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                <div className="flex items-center justify-between text-xs">
                  <span style={{ color: 'var(--text-tertiary)' }}>
                    {t('video.trimmedDuration')}
                  </span>
                  <span
                    className="font-mono font-semibold tabular-nums"
                    style={{ color: 'var(--accent)' }}
                  >
                    {formatTime(trimDuration)}
                  </span>
                </div>
                <div
                  className="mt-2 h-1.5 rounded-full overflow-hidden"
                  style={{ background: 'var(--bg-primary)' }}
                >
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${metadata?.duration ? (trimDuration / metadata.duration) * 100 : 0}%`,
                      background: 'var(--accent)'
                    }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* 调速模式 */}
          {activeMode === 'speed' && (
            <div className="flex flex-col gap-3">
              <p className="text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
                {t('video.speedDesc')}
              </p>

              {/* 预设速度网格 */}
              <div className="grid grid-cols-3 gap-2">
                {SPEED_PRESETS.map((s) => (
                  <button
                    key={s}
                    className={`px-2 py-2 text-sm rounded-lg transition-all ${speed === s ? 'shadow-sm font-semibold' : 'opacity-70'}`}
                    style={
                      speed === s
                        ? { background: 'var(--accent)', color: 'white' }
                        : { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }
                    }
                    onClick={() => handlePreviewSpeedChange(s)}
                  >
                    {s}x
                  </button>
                ))}
              </div>

              {/* 自定义速度滑块 */}
              <div className="flex flex-col gap-1.5 mt-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                    {t('video.customSpeed')}
                  </label>
                  <span
                    className="text-xs font-mono tabular-nums"
                    style={{ color: 'var(--accent)' }}
                  >
                    {speed.toFixed(2)}x
                  </span>
                </div>
                <input
                  type="range"
                  min={0.25}
                  max={4.0}
                  step={0.05}
                  value={speed}
                  onChange={(e) => handlePreviewSpeedChange(Number(e.target.value))}
                  className="w-full"
                  style={{ accentColor: 'var(--accent)' }}
                />
                <div
                  className="flex justify-between text-xs"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  <span>{t('video.slowMotionLabel')}</span>
                  <span>{t('video.originalSpeedLabel')}</span>
                  <span>{t('video.fastMotionLabel')}</span>
                </div>
              </div>

              {/* 输出预估 */}
              <div className="mt-2 p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                <div className="flex items-center justify-between text-xs">
                  <span style={{ color: 'var(--text-tertiary)' }}>{t('video.outputDuration')}</span>
                  <span
                    className="font-mono font-semibold tabular-nums"
                    style={{ color: 'var(--accent)' }}
                  >
                    {formatTime(estimatedDuration)}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between text-xs">
                  <span style={{ color: 'var(--text-tertiary)' }}>{t('video.speedChange')}</span>
                  <span
                    className="font-mono"
                    style={{
                      color:
                        speed > 1
                          ? 'var(--danger)'
                          : speed < 1
                            ? 'var(--success)'
                            : 'var(--text-secondary)'
                    }}
                  >
                    {speed > 1
                      ? t('video.speedFast', { n: speed })
                      : speed < 1
                        ? t('video.speedSlow', { n: (1 / speed).toFixed(2) })
                        : t('video.speedOriginal')}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* P1-K：格式转换模式 */}
          {activeMode === 'export' && (
            <div className="flex flex-col gap-3">
              <p className="text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
                {t('video.exportDesc')}
              </p>

              {/* 当前格式提示 */}
              <div
                className="p-2.5 rounded-lg text-xs flex items-center justify-between"
                style={{ background: 'var(--bg-tertiary)' }}
              >
                <span style={{ color: 'var(--text-tertiary)' }}>{t('video.originalFormat')}</span>
                <span
                  className="font-mono font-semibold uppercase"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  {media.file_name.split('.').pop() || t('video.unknown')}
                </span>
              </div>

              {/* 目标格式网格 */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                  {t('video.targetFormat')}
                </label>
                <div className="grid grid-cols-1 gap-1.5">
                  {EXPORT_FORMATS.map((fmt) => (
                    <button
                      key={fmt.value}
                      className={`px-3 py-2 rounded-lg transition-all text-left flex items-center justify-between ${exportFormat === fmt.value ? 'shadow-sm' : 'opacity-80'}`}
                      style={
                        exportFormat === fmt.value
                          ? { background: 'var(--accent)', color: 'white' }
                          : { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }
                      }
                      onClick={() => setExportFormat(fmt.value)}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-semibold text-sm">{fmt.label}</span>
                      </div>
                      <span
                        className={`text-xs ${exportFormat === fmt.value ? 'text-white/80' : ''}`}
                        style={
                          exportFormat === fmt.value ? undefined : { color: 'var(--text-tertiary)' }
                        }
                      >
                        {t(`video.exportFormats.${fmt.value}`)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* GIF 警告 */}
              {exportFormat === 'gif' && (
                <div
                  className="p-2.5 rounded-lg text-xs leading-relaxed"
                  style={{ background: 'rgba(255, 184, 0, 0.08)', color: 'var(--warning-text)' }}
                >
                  {t('video.gifWarning')}
                </div>
              )}

              {/* P1-05：Live Photo 导出（独立于普通格式转换，生成 JPG + MOV 配对文件） */}
              <div className="border-t pt-3" style={{ borderColor: 'var(--divider)' }}>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      {t('video.livePhoto.title')}
                    </p>
                    <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                      {t('video.livePhoto.desc')}
                    </p>
                  </div>
                  <button
                    className="btn-secondary text-xs px-3 py-1.5 flex-shrink-0"
                    onClick={() => handleExportClick('livephoto')}
                    disabled={processing || loadingMeta}
                    title={t('video.livePhoto.button')}
                  >
                    {t('video.livePhoto.button')}
                  </button>
                </div>
                <div
                  className="mt-2 p-2 rounded-lg text-xs leading-relaxed"
                  style={{ background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)' }}
                >
                  {t('video.livePhoto.limitation')}
                </div>
              </div>
            </div>
          )}

          {/* 调色模式：基础 5 项与图片编辑器完全对齐 */}
          {activeMode === 'color' && (
            <div className="flex flex-col gap-3">
              <p className="text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
                {t('video.colorDesc')}
              </p>
              <SliderControl
                label={t('editor.basic.brightness')}
                value={colorParams.brightness}
                min={-100}
                max={100}
                step={1}
                onChange={(v) => updateColorParam('brightness', v)}
              />
              <SliderControl
                label={t('editor.basic.contrast')}
                value={colorParams.contrast}
                min={-100}
                max={100}
                step={1}
                onChange={(v) => updateColorParam('contrast', v)}
              />
              <SliderControl
                label={t('editor.basic.saturation')}
                value={colorParams.saturation}
                min={-100}
                max={100}
                step={1}
                onChange={(v) => updateColorParam('saturation', v)}
              />
              <SliderControl
                label={t('editor.basic.temperature')}
                value={colorParams.temperature}
                min={-100}
                max={100}
                step={1}
                onChange={(v) => updateColorParam('temperature', v)}
              />
              <SliderControl
                label={t('editor.basic.tint')}
                value={colorParams.tint}
                min={-100}
                max={100}
                step={1}
                onChange={(v) => updateColorParam('tint', v)}
              />
              <button
                className="btn-secondary text-xs px-3 py-1.5"
                onClick={resetColorParams}
                disabled={processing}
              >
                {t('video.resetColor')}
              </button>
              <div
                className="p-2.5 rounded-lg text-xs leading-relaxed"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)' }}
              >
                {t('video.colorNoPreview')}
              </div>
            </div>
          )}

          {/* 水印模式：复用图片编辑器 WatermarkPanel */}
          {activeMode === 'watermark' && (
            <div className="flex flex-col gap-3">
              <p className="text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
                {t('video.watermarkDesc')}
              </p>
              <WatermarkPanel config={watermark} onChange={setWatermark} />
              <div
                className="p-2.5 rounded-lg text-xs leading-relaxed"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)' }}
              >
                {t('video.colorNoPreview')}
              </div>
            </div>
          )}

          {/* 提示 */}
          <div
            className="mt-auto p-3 rounded-lg text-xs leading-relaxed"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)' }}
          >
            <p className="font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
              {t('video.notesTitle')}
            </p>
            <ul className="space-y-1 list-disc pl-4">
              <li>{t('video.notes.noModifyOriginal')}</li>
              <li>{t('video.notes.streamCopy')}</li>
              <li>{t('video.notes.reencode')}</li>
              <li>{t('video.notes.supportedFormats')}</li>
            </ul>
          </div>
        </div>
      </div>

      {/* Toast */}
      <Toast messages={messages} onDismiss={dismiss} />

      {/* 导出确认 */}
      <ConfirmDialog
        open={exportConfirm !== null}
        title={
          exportConfirm?.mode === 'trim'
            ? t('dialog.exportTrim')
            : exportConfirm?.mode === 'export'
              ? t('dialog.exportFormat')
              : exportConfirm?.mode === 'livephoto'
                ? t('dialog.exportLivePhoto')
                : t('dialog.exportSpeed')
        }
        message={
          exportConfirm?.mode === 'trim'
            ? t('video.confirmTrim', {
                start: formatTime(trimStart),
                end: formatTime(trimEnd),
                duration: formatTime(trimDuration)
              })
            : exportConfirm?.mode === 'export'
              ? t('video.confirmExport', { format: exportFormat.toUpperCase() })
              : exportConfirm?.mode === 'livephoto'
                ? t('video.confirmLivePhoto')
                : t('video.confirmSpeed', { speed, duration: formatTime(estimatedDuration) })
        }
        confirmText={t('video.selectDirAndExport')}
        onConfirm={performExport}
        onCancel={() => setExportConfirm(null)}
      />

      {/* 视频编辑任务进度浮窗（订阅 task:progress，仅匹配 video-edit/watermark） */}
      <TaskProgressOverlay
        progress={taskProgress}
        onCancel={
          taskProgress ? () => window.electronAPI?.task?.cancel(taskProgress.taskId) : undefined
        }
      />
    </div>
  )
}
