import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useUIStore, type SlideshowOrder, type SlideshowTransition } from '../../stores/uiStore'
import { toFileUrl, type MediaFile } from '../../stores/mediaStore'
// DU3：幻灯片播放逻辑统一到 useSlideshow hook
import { useSlideshow } from '../../hooks/useSlideshow'
import {
  IconClose,
  IconChevronLeft,
  IconChevronRight,
  IconSlideshow,
  IconShuffle,
  IconSettings,
  IconPause,
  IconPlay
} from '../../icons'

interface SlideshowPlayerProps {
  // C-O5：由父组件传入已计算的 filteredFiles，避免与 GalleryPage 重复计算
  filteredFiles: MediaFile[]
}

// T11：Fisher-Yates 洗牌生成随机顺序索引数组
function buildShuffledIndices(length: number, startIndex: number): number[] {
  const indices = Array.from({ length }, (_, i) => i)
  for (let i = length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[indices[i], indices[j]] = [indices[j], indices[i]]
  }
  // 将起始索引放到首位，保证用户从当前图片开始观看
  const startPos = indices.indexOf(startIndex)
  if (startPos > 0) {
    ;[indices[0], indices[startPos]] = [indices[startPos], indices[0]]
  }
  return indices
}

const INTERVAL_PRESETS = [
  { value: 1000, labelKey: 'gallery.slideshow.intervalPreset.1s' },
  { value: 3000, labelKey: 'gallery.slideshow.intervalPreset.3s' },
  { value: 5000, labelKey: 'gallery.slideshow.intervalPreset.5s' },
  { value: 10000, labelKey: 'gallery.slideshow.intervalPreset.10s' }
] as const

const TRANSITION_PRESETS = [
  { value: 'fade', labelKey: 'gallery.slideshow.transitionPreset.fade' },
  { value: 'slide', labelKey: 'gallery.slideshow.transitionPreset.slide' },
  { value: 'none', labelKey: 'gallery.slideshow.transitionPreset.none' }
] as const

const ORDER_PRESETS = [
  { id: 'sequence', labelKey: 'gallery.slideshow.orderPreset.sequence' },
  { id: 'shuffle', labelKey: 'gallery.slideshow.orderPreset.shuffle' }
] as const

export const SlideshowPlayer: React.FC<SlideshowPlayerProps> = ({ filteredFiles }) => {
  const { t } = useTranslation()
  const slideshowOpen = useUIStore((s) => s.slideshowOpen)
  const startIndex = useUIStore((s) => s.slideshowStartIndex)
  const config = useUIStore((s) => s.slideshowConfig)
  const closeSlideshow = useUIStore((s) => s.closeSlideshow)
  const setSlideshowConfig = useUIStore((s) => s.setSlideshowConfig)

  const [currentPos, setCurrentPos] = useState(0)
  const [showControls, setShowControls] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [transitionKey, setTransitionKey] = useState(0)

  const mouseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const videoEndedRef = useRef(false)

  // T11：跳过视频时仅播放图片；不跳过时视频播完自动切换下一张
  const playableFiles = useMemo(() => {
    if (!config.skipVideo) return filteredFiles
    return filteredFiles.filter((f) => f.file_type !== 'video')
  }, [filteredFiles, config.skipVideo])

  // T11：随机模式生成洗牌索引数组；顺序模式直接用 0..n
  const playOrder = useMemo(() => {
    if (config.order === 'shuffle') {
      return buildShuffledIndices(
        playableFiles.length,
        Math.min(startIndex, playableFiles.length - 1)
      )
    }
    return Array.from({ length: playableFiles.length }, (_, i) => i)
  }, [config.order, playableFiles.length, startIndex])

  // 重置播放位置：每次打开或 playableFiles/order 变化时定位到起始
  useEffect(() => {
    if (!slideshowOpen) return
    if (config.order === 'shuffle') {
      // 洗牌模式起始位置为 0（playOrder[0] 已是 startIndex）
      setCurrentPos(0)
    } else {
      const safeStart = Math.min(startIndex, playableFiles.length - 1)
      setCurrentPos(safeStart >= 0 ? safeStart : 0)
    }
    videoEndedRef.current = false
  }, [slideshowOpen, config.order, startIndex, playableFiles.length])

  const currentFile = playableFiles[playOrder[currentPos]]

  // DU3：用 ref 持有 stop 函数，避免 goToNext 与 slideshow 的循环依赖
  const stopRef = useRef<() => void>(() => {})

  const goToNext = useCallback(() => {
    setCurrentPos((prev) => {
      const next = prev + 1
      if (next < playableFiles.length) return next
      // 到末尾：循环则回到 0，否则停止播放
      if (config.loop) return 0
      stopRef.current()
      return prev
    })
    setTransitionKey((k) => k + 1)
  }, [playableFiles.length, config.loop])

  const goToPrev = useCallback(() => {
    setCurrentPos((prev) => {
      if (prev > 0) return prev - 1
      // 到首位：循环则跳到末尾
      return config.loop ? playableFiles.length - 1 : 0
    })
    setTransitionKey((k) => k + 1)
  }, [playableFiles.length, config.loop])

  // DU3：使用共享 hook 管理播放状态和计时器（原 isPlaying state + timerRef + interval effect 合并）
  const slideshow = useSlideshow({
    interval: config.interval,
    onTick: goToNext
  })
  // 同步 stop 到 ref（slideshow.stop 是稳定引用，安全赋值）
  stopRef.current = slideshow.stop

  // 重置播放位置时自动开始播放
  useEffect(() => {
    if (!slideshowOpen) return
    slideshow.start()
  }, [slideshowOpen, slideshow])

  const togglePlay = useCallback(() => {
    slideshow.toggle()
  }, [slideshow])

  // T11：视频文件且未跳过时，等待视频播完再切换，暂停 interval
  useEffect(() => {
    if (!slideshow.isPlaying || !currentFile) return
    if (currentFile.file_type === 'video' && !config.skipVideo) {
      videoEndedRef.current = false
      slideshow.stop()
    }
  }, [slideshow, currentFile, config.skipVideo])

  // T11：鼠标移动 3 秒后隐藏控制条
  useEffect(() => {
    if (!slideshowOpen) return
    const reset = () => {
      setShowControls(true)
      if (mouseTimerRef.current) clearTimeout(mouseTimerRef.current)
      mouseTimerRef.current = setTimeout(() => {
        if (!showSettings) setShowControls(false)
      }, 3000)
    }
    reset()
    window.addEventListener('mousemove', reset)
    return () => {
      if (mouseTimerRef.current) clearTimeout(mouseTimerRef.current)
      window.removeEventListener('mousemove', reset)
    }
  }, [slideshowOpen, showSettings])

  // T11：键盘控制——ESC 退出、空格暂停、左右导航、S 设置
  useEffect(() => {
    if (!slideshowOpen) return
    const handleKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          if (showSettings) {
            setShowSettings(false)
          } else {
            closeSlideshow()
          }
          break
        case ' ':
          e.preventDefault()
          togglePlay()
          break
        case 'ArrowLeft':
          goToPrev()
          break
        case 'ArrowRight':
          goToNext()
          break
        case 's':
        case 'S':
          setShowSettings((v) => !v)
          break
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [slideshowOpen, showSettings, closeSlideshow, togglePlay, goToPrev, goToNext])

  // 组件卸载时清理鼠标计时器（DU3：播放计时器清理由 useSlideshow hook 内部处理）
  useEffect(() => {
    return () => {
      if (mouseTimerRef.current) clearTimeout(mouseTimerRef.current)
    }
  }, [])

  // 关闭时停止播放
  useEffect(() => {
    if (!slideshowOpen && slideshow.isPlaying) {
      slideshow.stop()
    }
  }, [slideshowOpen, slideshow])

  if (!slideshowOpen || playableFiles.length === 0 || !currentFile) return null

  const fileUrl = toFileUrl(currentFile.file_path)
  const progressLabel = t('gallery.slideshow.progress', {
    current: currentPos + 1,
    total: playableFiles.length
  })

  // T11：过渡动画 class
  const transitionClass =
    config.transition === 'fade'
      ? 'slideshow-fade'
      : config.transition === 'slide'
        ? 'slideshow-slide'
        : ''

  const handleVideoEnded = () => {
    if (!config.loop && currentPos >= playableFiles.length - 1) {
      slideshow.stop()
      return
    }
    goToNext()
  }

  return (
    <div
      className="fixed inset-0 z-[85] flex items-center justify-center outline-none"
      style={{ background: 'rgba(0,0,0,0.96)' }}
      role="dialog"
      aria-modal="true"
      aria-label={t('gallery.slideshow.ariaLabel')}
      tabIndex={-1}
    >
      <div className="relative w-full h-full flex items-center justify-center">
        <div
          key={transitionKey}
          className={`w-full h-full flex items-center justify-center ${transitionClass}`}
        >
          {currentFile.file_type === 'video' ? (
            <video
              src={fileUrl || undefined}
              className="max-w-full max-h-full"
              autoPlay
              controls={false}
              onEnded={handleVideoEnded}
              style={{ objectFit: 'contain' as const }}
            />
          ) : (
            <img
              src={fileUrl || undefined}
              alt={currentFile.file_name}
              className="max-w-full max-h-full"
              style={{ objectFit: 'contain' }}
              draggable={false}
            />
          )}
        </div>

        {/* 顶部信息栏 */}
        <div
          className="absolute top-0 left-0 right-0 h-12 flex items-center justify-between px-4 transition-opacity"
          style={{
            background: 'linear-gradient(to bottom, rgba(0,0,0,0.6), transparent)',
            opacity: showControls ? 1 : 0,
            pointerEvents: showControls ? 'auto' : 'none'
          }}
        >
          <div className="flex items-center gap-2 text-white text-sm">
            <IconSlideshow size={16} />
            <span>{t('gallery.slideshow.title')}</span>
            <span className="text-white/60">·</span>
            <span className="text-white/80">{progressLabel}</span>
            {config.order === 'shuffle' && (
              <span className="flex items-center gap-1 text-white/60 text-xs ml-2">
                <IconShuffle size={12} /> {t('gallery.slideshow.shuffleBadge')}
              </span>
            )}
          </div>
          <button
            className="icon-btn text-white"
            // WCO 避让：幻灯片播放器为非原生全屏，右上角退出按钮需左移出
            // 原生窗口控制按钮区（Windows titleBarOverlay），env() 在
            // 非 WCO 环境取 fallback 归零，不影响浏览器预览布局
            style={{
              marginRight:
                'calc(100vw - env(titlebar-area-width, 100vw) - env(titlebar-area-x, 0px))'
            }}
            onClick={closeSlideshow}
            title={t('gallery.slideshow.exitTitle')}
            aria-label={t('gallery.slideshow.exitAriaLabel')}
          >
            <IconClose size={18} />
          </button>
        </div>

        {/* 左右导航 */}
        <button
          className="absolute left-4 top-1/2 -translate-y-1/2 icon-btn text-white"
          onClick={goToPrev}
          style={{
            background: 'rgba(0,0,0,0.4)',
            opacity: showControls ? 1 : 0,
            pointerEvents: showControls ? 'auto' : 'none'
          }}
          aria-label={t('gallery.fullscreen.prevAriaLabel')}
        >
          <IconChevronLeft size={24} />
        </button>
        <button
          className="absolute right-4 top-1/2 -translate-y-1/2 icon-btn text-white"
          onClick={goToNext}
          style={{
            background: 'rgba(0,0,0,0.4)',
            opacity: showControls ? 1 : 0,
            pointerEvents: showControls ? 'auto' : 'none'
          }}
          aria-label={t('gallery.fullscreen.nextAriaLabel')}
        >
          <IconChevronRight size={24} />
        </button>

        {/* 底部控制条 */}
        <div
          className="absolute bottom-0 left-0 right-0 px-6 py-4 flex items-center justify-center gap-4 transition-opacity"
          style={{
            background: 'linear-gradient(to top, rgba(0,0,0,0.6), transparent)',
            opacity: showControls ? 1 : 0,
            pointerEvents: showControls ? 'auto' : 'none'
          }}
        >
          <button
            className="icon-btn text-white"
            onClick={goToPrev}
            aria-label={t('gallery.fullscreen.prevAriaLabel')}
            title={t('gallery.slideshow.prevTitle')}
          >
            <IconChevronLeft size={20} />
          </button>
          <button
            className="icon-btn text-white"
            onClick={togglePlay}
            aria-label={
              slideshow.isPlaying
                ? t('gallery.slideshow.pauseAriaLabel')
                : t('gallery.slideshow.playAriaLabel')
            }
            title={
              slideshow.isPlaying
                ? t('gallery.slideshow.pauseTitle')
                : t('gallery.slideshow.playTitle')
            }
            style={{
              background: 'rgba(255,255,255,0.15)',
              borderRadius: '50%',
              width: '48px',
              height: '48px'
            }}
          >
            {slideshow.isPlaying ? <IconPause size={20} /> : <IconPlay size={20} />}
          </button>
          <button
            className="icon-btn text-white"
            onClick={goToNext}
            aria-label={t('gallery.fullscreen.nextAriaLabel')}
            title={t('gallery.slideshow.nextTitle')}
          >
            <IconChevronRight size={20} />
          </button>
          <div className="w-px h-6 bg-white/20 mx-2" />
          <button
            className={`icon-btn text-white ${showSettings ? 'active' : ''}`}
            onClick={() => setShowSettings((v) => !v)}
            aria-label={t('gallery.slideshow.settingsAriaLabel')}
            title={t('gallery.slideshow.settingsTitle')}
            aria-expanded={showSettings}
          >
            <IconSettings size={18} />
          </button>
        </div>

        {/* 设置抽屉 */}
        {showSettings && (
          <div
            className="absolute right-6 top-1/2 -translate-y-1/2 w-72 rounded-2xl p-5 space-y-4 z-10"
            style={{
              background: 'rgba(30, 30, 30, 0.92)',
              backdropFilter: 'blur(20px)',
              border: '1px solid rgba(255,255,255,0.1)',
              color: '#fff'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">{t('gallery.slideshow.settingsPanelTitle')}</h3>
              <button
                className="icon-btn text-white/70 hover:text-white"
                onClick={() => setShowSettings(false)}
                aria-label={t('gallery.slideshow.settingsCloseAriaLabel')}
              >
                <IconClose size={16} />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs text-white/60 mb-1.5 block">
                  {t('gallery.slideshow.orderLabel')}
                </label>
                <div className="flex gap-1">
                  {ORDER_PRESETS.map((opt) => (
                    <button
                      key={opt.id}
                      onClick={() => setSlideshowConfig({ order: opt.id as SlideshowOrder })}
                      className="flex-1 px-3 py-1.5 rounded-lg text-xs transition-colors"
                      style={{
                        background:
                          config.order === opt.id
                            ? 'rgba(255,255,255,0.2)'
                            : 'rgba(255,255,255,0.05)',
                        color: config.order === opt.id ? '#fff' : 'rgba(255,255,255,0.6)',
                        fontWeight: config.order === opt.id ? 600 : 400
                      }}
                    >
                      {t(opt.labelKey)}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs text-white/60 mb-1.5 block">
                  {t('gallery.slideshow.intervalLabel')}
                </label>
                <div className="grid grid-cols-4 gap-1">
                  {INTERVAL_PRESETS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => setSlideshowConfig({ interval: opt.value })}
                      className="px-2 py-1.5 rounded-lg text-xs transition-colors"
                      style={{
                        background:
                          config.interval === opt.value
                            ? 'rgba(255,255,255,0.2)'
                            : 'rgba(255,255,255,0.05)',
                        color: config.interval === opt.value ? '#fff' : 'rgba(255,255,255,0.6)',
                        fontWeight: config.interval === opt.value ? 600 : 400
                      }}
                    >
                      {t(opt.labelKey)}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs text-white/60 mb-1.5 block">
                  {t('gallery.slideshow.transitionLabel')}
                </label>
                <div className="flex gap-1">
                  {TRANSITION_PRESETS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() =>
                        setSlideshowConfig({ transition: opt.value as SlideshowTransition })
                      }
                      className="flex-1 px-3 py-1.5 rounded-lg text-xs transition-colors"
                      style={{
                        background:
                          config.transition === opt.value
                            ? 'rgba(255,255,255,0.2)'
                            : 'rgba(255,255,255,0.05)',
                        color: config.transition === opt.value ? '#fff' : 'rgba(255,255,255,0.6)',
                        fontWeight: config.transition === opt.value ? 600 : 400
                      }}
                    >
                      {t(opt.labelKey)}
                    </button>
                  ))}
                </div>
              </div>

              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-xs text-white/80">{t('gallery.slideshow.loopLabel')}</span>
                <input
                  type="checkbox"
                  checked={config.loop}
                  onChange={(e) => setSlideshowConfig({ loop: e.target.checked })}
                  className="w-4 h-4"
                />
              </label>

              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-xs text-white/80">
                  {t('gallery.slideshow.skipVideoLabel')}
                </span>
                <input
                  type="checkbox"
                  checked={config.skipVideo}
                  onChange={(e) => setSlideshowConfig({ skipVideo: e.target.checked })}
                  className="w-4 h-4"
                />
              </label>
            </div>

            <p className="text-xs text-white/40 pt-2 border-t border-white/10">
              {t('gallery.slideshow.shortcutsHint')}
            </p>
          </div>
        )}
      </div>

      <style>{`
        @keyframes slideshowFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slideshowSlideIn {
          from { opacity: 0; transform: translateX(40px); }
          to { opacity: 1; transform: translateX(0); }
        }
        .slideshow-fade {
          animation: slideshowFadeIn 400ms ease-out;
        }
        .slideshow-slide {
          animation: slideshowSlideIn 400ms ease-out;
        }
      `}</style>
    </div>
  )
}
