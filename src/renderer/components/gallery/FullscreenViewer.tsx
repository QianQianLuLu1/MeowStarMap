import React, { useEffect, useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useUIStore, type SlideshowConfig } from '../../stores/uiStore'
import { useMediaStore, toFileUrl, type MediaFile } from '../../stores/mediaStore'
import { needsAnonymousCors } from '../../utils/file'
import { getLastFullscreenSource, whenTransitionSettled } from '../../utils/view-transition'
import { useToast } from '../../hooks/useToast'
import { useFavoriteToggle } from '../../hooks/useFavoriteToggle'
// THUMBNAIL_OPTIMIZATION_PLAN 节点4：邻近项原图预热，翻页即点即显
import { useNeighborPrefetch } from '../../hooks/useNeighborPrefetch'
// DU3：幻灯片播放逻辑统一到 useSlideshow hook
import { useSlideshow, type UseSlideshowReturn } from '../../hooks/useSlideshow'
// 缺陷1：鼠标翻页——滚轮由 @use-gesture/react 封装的 useWheelPageNav 接管（阈值累加 + 惯性冷却）
import { useWheelPageNav } from '../../hooks/useWheelPageNav'
import { Toast } from '../common/Toast'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { ExifPanel } from '../common/ExifPanel'
import { VideoPlayer } from '../video/VideoPlayer'
import {
  IconFavorite,
  IconSaveAs,
  IconDelete,
  IconClose,
  IconChevronLeft,
  IconChevronRight,
  IconInfo,
  IconPause,
  IconPlay
} from '../../icons'
import { CameraInfoPanel } from '../common/CameraInfoPanel'
import { PhotographyPanel } from '../common/PhotographyPanel'
import { NikkiInfoPanel } from '../common/NikkiInfoPanel'
import { OutfitPanel } from '../common/OutfitPanel'
import { InteractionPanel } from '../common/InteractionPanel'

/** 缺陷1：左右边缘鼠标热区宽度——12% 视口宽、最大 120px（够宽好点，又不侵占媒体区） */
const HOTZONE_WIDTH = 'min(12%, 120px)'

interface FullscreenViewerProps {
  // C-O5：由父组件传入已计算的 filteredFiles，避免与 GalleryPage 各自调用 useFilteredMediaFiles 重复计算
  filteredFiles: MediaFile[]
}

export const FullscreenViewer: React.FC<FullscreenViewerProps> = ({ filteredFiles }) => {
  const { t } = useTranslation()
  const fullscreenOpen = useUIStore((s) => s.fullscreenOpen)
  const [imgError, setImgError] = useState(false)
  const fullscreenIndex = useUIStore((s) => s.fullscreenIndex)
  // FIX(dup-fullscreen)：非图库入口（如重复文件页）打开时显式携带的文件列表，优先于 props
  const fullscreenFiles = useUIStore((s) => s.fullscreenFiles)
  const closeFullscreen = useUIStore((s) => s.closeFullscreen)
  const deleteMediaFiles = useMediaStore((s) => s.deleteMediaFiles)
  const { messages, showMessage, dismiss } = useToast()
  // P1-C3：复用共享 hook，收藏/取消收藏接入撤销栈（与 useFileOperations 一致）
  // 修复 React error #310：此 hook 必须在下方 `if (!fullscreenOpen || !currentFile) return null` 之前调用，
  // 否则全屏打开/关闭两次渲染的 hooks 数量不一致会触发 "Rendered more hooks than during the previous render"
  const toggleFavorite = useFavoriteToggle(showMessage)
  const containerRef = useRef<HTMLDivElement>(null)
  const [confirm, setConfirm] = useState<{
    open: boolean
    title: string
    message: string
    onConfirm: () => void
  } | null>(null)
  const [showControls, setShowControls] = useState(true)
  const mouseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // P2-C13：原 playInterval 本地状态与 uiStore.slideshowConfig.interval 重复
  // 改为从 uiStore 读取 interval，通过 updateSlideshowConfig 持久化
  const playInterval = useUIStore((s) => s.slideshowConfig.interval)
  const setSlideshowConfig = useUIStore((s) => s.setSlideshowConfig)
  const setPlayInterval = useCallback(
    (ms: SlideshowConfig['interval']) => {
      setSlideshowConfig({ interval: ms })
    },
    [setSlideshowConfig]
  )
  const [showIntervalMenu, setShowIntervalMenu] = useState(false)
  // EXIF 信息浮层显示开关（独立于 showControls，避免读 EXIF 时面板自动隐藏）
  const [showInfoPanel, setShowInfoPanel] = useState(false)

  // FIX(dup-fullscreen)：显示、导航、幻灯片、删除回退、标题统一以 activeFiles 为源，
  // 避免重复文件页的下标错位到图库列表（fullscreenFiles 为 null 时维持图库语义）
  const activeFiles = fullscreenFiles ?? filteredFiles
  const currentFile = activeFiles[fullscreenIndex]
  const fileUrl = toFileUrl(currentFile?.file_path)
  useEffect(() => {
    setImgError(false)
  }, [fileUrl])

  // RC2：动画窗口内只渲染已被引擎缓存的缩略图，原图用离屏 Image 预解码就绪后再原子换源。
  // 直接以数 MB 的 4K 原图作 src 会带来三个问题：① 新快照拍摄时原图尚未加载、固有尺寸
  // 未知，共享元素 group 的起终点尺寸失真；② 加载完成触发重排，正在进行的放大动画被撕裂；
  // ③ 解码任务被摊进 ~250ms 的共享元素动画窗口，直接吃掉动画帧。
  // 占位图必须以原图同样的宽高比撑满同一个盒子，否则换源瞬间会「先小后跳」。
  // 原图 ratio 由 width/height 元数据提供；缺失时不具备占位条件，退回旧行为（直接用原图）。
  const hasBoxMetadata = Boolean(currentFile?.width && currentFile?.height)
  const thumbUrl =
    hasBoxMetadata && currentFile?.thumbnail ? toFileUrl(currentFile.thumbnail) : null
  const initialUrl = thumbUrl && thumbUrl !== fileUrl ? thumbUrl : fileUrl
  const [displayUrl, setDisplayUrl] = useState<string | null>(initialUrl)
  useEffect(() => {
    setDisplayUrl(initialUrl)
    // 无缩略图可先行时（已是原图）无需换源
    if (!fileUrl || initialUrl === fileUrl) return
    let cancelled = false
    const probe = new Image()
    probe.src = fileUrl
    // decode() 缺失时降级为「加载完成即换」；预解码失败同样换源，
    // 绝不因预解码失败把本可显示的图片判为加载失败
    const ready: Promise<unknown> =
      typeof probe.decode === 'function' ? probe.decode() : Promise.reject(new Error('no decode'))
    // G2：换源条件为「decode 完成 且 当前过渡已结束」。冷加载的 4K 图若在
    // ~220ms 共享元素动画窗口内完成解码并换源，解码+重绘会直接吃掉动画帧。
    // 无活动过渡（降级路径）时 whenTransitionSettled() 立即 resolve，行为不变。
    void Promise.all([ready.catch(() => undefined), whenTransitionSettled()]).then(() => {
      if (!cancelled) setDisplayUrl(fileUrl)
    })
    return () => {
      cancelled = true
    }
  }, [fileUrl, initialUrl])

  // THUMBNAIL_OPTIMIZATION_PLAN 节点4：邻近项原图预热——当前项变化时预热前后各一张，
  // 翻页时字节已入 HTTP 缓存（原图一年强缓存），基本即点即显。仅在打开状态预热。
  useNeighborPrefetch(activeFiles, fullscreenIndex, fullscreenOpen)

  const navigate = useCallback(
    (delta: number) => {
      // 缺陷2：必须读 store 最新值。原先读闭包里的 fullscreenIndex，而按键连发
      // （~30ms 重复间隔）快于一次提交，同帧内的第二次按键仍基于旧下标计算，
      // 结果是「按两张只走一张」后画面跟不上手感的跳变。
      const newIndex = useUIStore.getState().fullscreenIndex + delta
      if (newIndex >= 0 && newIndex < activeFiles.length) {
        useUIStore.setState({ fullscreenIndex: newIndex })
        // 切换图片时关闭 EXIF 浮层，避免显示上一张的参数
        setShowInfoPanel(false)
      }
    },
    [activeFiles.length]
  )

  // 缺陷1：鼠标翻页三条路径统一走 navigate（越界判据不复制第二份）
  const prevPage = useCallback(() => navigate(-1), [navigate])
  const nextPage = useCallback(() => navigate(1), [navigate])
  useWheelPageNav({
    enabled: fullscreenOpen,
    target: containerRef,
    onPrev: prevPage,
    onNext: nextPage,
    // 缺陷1 审查修复：EXIF 信息浮层声明滚轮归属自身（浮层可滚动、不误翻页），
    // 选择器与浮层上的 data-wheel-ignore 属性一一对应
    ignoreSelector: '[data-wheel-ignore]'
  })

  // DU3：幻灯片播放逻辑使用共享 hook（原 stopSlideshow/startSlideshow/toggleSlideshow 三函数合并）
  // slideshow 由下方 useSlideshow 返回，onTick 内经 slideshowRef 调用 stop（避免声明前使用的循环引用）
  const slideshowRef = useRef<UseSlideshowReturn | null>(null)
  const slideshow = useSlideshow({
    interval: playInterval,
    onTick: useCallback(() => {
      const idx = useUIStore.getState().fullscreenIndex
      if (idx >= activeFiles.length - 1) {
        // 播放到最后一张，停止（FullscreenViewer 不循环）
        slideshowRef.current?.stop()
      } else {
        useUIStore.setState({ fullscreenIndex: idx + 1 })
      }
    }, [activeFiles.length])
  })
  useEffect(() => {
    slideshowRef.current = slideshow
  }, [slideshow])

  // F-S10：开始幻灯片播放（包装 slideshow.start，增加最少 2 张校验）
  const startSlideshow = useCallback(() => {
    if (activeFiles.length <= 1) {
      showMessage(t('gallery.fullscreen.slideshowMinImages'), 'info')
      return
    }
    slideshow.start()
  }, [activeFiles.length, showMessage, slideshow, t])

  const toggleSlideshow = useCallback(() => {
    if (slideshow.isPlaying) {
      slideshow.stop()
    } else {
      startSlideshow()
    }
  }, [slideshow, startSlideshow])

  // C-S10：handleDelete 用 useCallback 稳定化，并作为键盘事件 effect 的依赖
  // 原实现 handleDelete 为普通函数，键盘事件 effect 依赖数组缺失 handleDelete，
  // 导致键盘 Delete 调用旧版本（currentFile 引用过期）。
  const handleDelete = useCallback(
    (file: MediaFile) => {
      setConfirm({
        open: true,
        title: t('detail.actions.deleteTitle'),
        message: t('gallery.fullscreen.deleteConfirmMessage', { fileName: file.file_name }),
        onConfirm: async () => {
          if (!window.electronAPI) return
          try {
            // 回收站语义修复：删除 = 软删除（纯 DB 标记，文件保留在原路径，可从回收站恢复）。
            // 不再 file.delete 搬文件 + mediaAction.delete 硬删记录（同 DetailPage）。
            const result = await window.electronAPI.mediaAction.softDelete([Number(file.id)])
            if (result.success) {
              deleteMediaFiles([file.id])
              // P1-C10：从 store 获取最新 index，避免闭包中 fullscreenIndex 过期
              // 同时基于当前 filteredFiles.length 计算剩余（props 可能未更新，但有 useEffect 兜底）
              const currentIndex = useUIStore.getState().fullscreenIndex
              const remaining = activeFiles.length - 1
              if (remaining <= 0) {
                closeFullscreen()
              } else {
                // 当前 index 超出剩余范围时回退到上一张
                const newIndex = Math.min(currentIndex, remaining - 1)
                useUIStore.setState({ fullscreenIndex: newIndex })
              }
            } else {
              showMessage(result.message || t('detail.actions.deleteFailed'), 'error')
            }
          } catch (error) {
            showMessage(
              error instanceof Error ? error.message : t('detail.actions.deleteFailed'),
              'error'
            )
          }
          setConfirm(null)
        }
      })
    },
    [activeFiles.length, deleteMediaFiles, closeFullscreen, showMessage, t]
  )

  // P3-1：关闭全屏时查找目标卡片 img，用于共享元素过渡（全屏图→缩略图缩小）
  const handleClose = useCallback(() => {
    if (currentFile) {
      // G3：优先复用打开路径登记的源元素（O(1)）。该决策发生在 closeFullscreen
      // 触发旧快照拍摄的临界窗口之前，原先的全文档 `img[data-media-id=…]` 属性
      // 选择器遍历（keep-alive 多页 + 虚拟网格，千级节点）是关闭动画起点的同步开销。
      // 登记元素已被虚拟列表回收、或已翻页导致 id 不符时，回落原查询保证目标正确。
      const cached = getLastFullscreenSource()
      const targetImg =
        cached?.dataset.mediaId === String(currentFile.id)
          ? cached
          : (document.querySelector(`img[data-media-id="${currentFile.id}"]`) as HTMLElement | null)
      useUIStore.setState({ fullscreenTargetImg: targetImg })
    }
    closeFullscreen()
  }, [currentFile, closeFullscreen])

  // 修复 U-S10：触摸滑动导航（触屏设备全屏浏览）
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
    }
  }, [])
  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const start = touchStartRef.current
      touchStartRef.current = null
      if (!start) return
      const endX = e.changedTouches[0]?.clientX ?? start.x
      const endY = e.changedTouches[0]?.clientY ?? start.y
      const deltaX = endX - start.x
      const deltaY = endY - start.y
      // 仅在水平滑动距离 > 50px 且大于垂直滑动时触发导航（避免误触）
      if (Math.abs(deltaX) > 50 && Math.abs(deltaX) > Math.abs(deltaY)) {
        navigate(deltaX > 0 ? -1 : 1)
      }
    },
    [navigate]
  )

  useEffect(() => {
    if (!fullscreenOpen) return
    const handleKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          // 缺陷2：已接管的按键必须阻止默认行为，否则方向键会滚动全屏背后的图库
          // （虚拟网格随之重算可见区 → 前景画面抖动），Esc/Delete 也可能触发默认行为
          e.preventDefault()
          slideshow.stop()
          handleClose()
          break
        case 'ArrowLeft':
          e.preventDefault()
          slideshow.stop()
          navigate(-1)
          break
        case 'ArrowRight':
          e.preventDefault()
          slideshow.stop()
          navigate(1)
          break
        case ' ':
          // F-S10：空格键切换幻灯片播放
          e.preventDefault()
          toggleSlideshow()
          break
        case 'Delete':
          e.preventDefault()
          if (currentFile) handleDelete(currentFile)
          break
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [fullscreenOpen, navigate, currentFile, handleDelete, handleClose, slideshow, toggleSlideshow])

  // F-S10：关闭全屏时停止幻灯片（DU3：卸载清理由 useSlideshow hook 内部处理）
  useEffect(() => {
    if (!fullscreenOpen && slideshow.isPlaying) {
      slideshow.stop()
    }
  }, [fullscreenOpen, slideshow])

  // 鼠标移动防抖：300ms 无移动后隐藏控制栏
  useEffect(() => {
    if (!fullscreenOpen) {
      setShowControls(true)
      return
    }
    const reset = () => {
      setShowControls(true)
      if (mouseTimerRef.current) clearTimeout(mouseTimerRef.current)
      mouseTimerRef.current = setTimeout(() => setShowControls(false), 3000)
    }
    reset()
    window.addEventListener('mousemove', reset)
    return () => {
      if (mouseTimerRef.current) clearTimeout(mouseTimerRef.current)
      window.removeEventListener('mousemove', reset)
    }
  }, [fullscreenOpen])

  // P1-C10：越界兜底——fullscreenIndex 超出 filteredFiles 范围时（currentFile 为 undefined）自动关闭全屏
  // 场景：连续快速删除时 filteredFiles props 未及时更新，fullscreenIndex 可能指向已不存在的位置
  useEffect(() => {
    if (fullscreenOpen && !currentFile) {
      closeFullscreen()
    }
  }, [fullscreenOpen, currentFile, closeFullscreen])

  // 缺陷2：依赖里原有的 fullscreenIndex 会让每翻一页都重新聚焦一次容器，
  // 而 HTMLElement.focus() 默认会把元素滚动进视口（scroll-into-view），是随
  // 键盘切换同步发生的布局副作用。键盘焦点只需要在「打开」时取一次。
  useEffect(() => {
    if (fullscreenOpen) {
      containerRef.current?.focus({ preventScroll: true })
    }
  }, [fullscreenOpen])

  if (!fullscreenOpen || !currentFile) return null

  const handleSaveAs = async (file: MediaFile) => {
    if (!window.electronAPI) return
    try {
      const targetDir = await window.electronAPI.dialog.selectDirectory()
      if (!targetDir) return
      const result = await window.electronAPI.file.saveAs(file.file_path, targetDir)
      showMessage(result.message, result.success ? 'success' : 'error')
    } catch (error) {
      showMessage(
        error instanceof Error ? error.message : t('gallery.fullscreen.saveAsFailed'),
        'error'
      )
    }
  }

  const title = t('gallery.fullscreen.title', {
    fileName: currentFile.file_name,
    current: fullscreenIndex + 1,
    total: activeFiles.length
  })
  const renderError = (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center text-[var(--text-on-overlay)]">
      <span className="text-sm opacity-80">{t('gallery.imageLoadFailed')}</span>
      <span className="max-w-md truncate text-xs opacity-50">{currentFile.file_name}</span>
    </div>
  )

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-[80] flex items-center justify-center outline-none"
      style={{ background: 'rgba(0,0,0,0.92)' }}
      onClick={handleClose}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      // 缺陷1：鼠标侧键翻页——3=后退（上一张）/ 4=前进（下一张）；
      // 必须 preventDefault，否则 Electron 可能把它当浏览器前进/后退手势处理
      onMouseDown={(e) => {
        if (e.button === 3) {
          e.preventDefault()
          prevPage()
        } else if (e.button === 4) {
          e.preventDefault()
          nextPage()
        }
      }}
      role="dialog"
      aria-modal="true"
      aria-label={t('gallery.fullscreen.ariaLabel', { fileName: currentFile.file_name })}
      tabIndex={-1}
    >
      <div
        className="relative w-full h-full flex items-center justify-center"
        onClick={(e) => e.stopPropagation()}
      >
        {!fileUrl ? (
          renderError
        ) : currentFile.file_type === 'video' ? (
          <VideoPlayer
            src={fileUrl}
            controls
            autoPlay
            className="max-w-full max-h-full"
            onCaptureFrame={(time) => {
              if (window.electronAPI) {
                window.electronAPI.video.captureFrame(currentFile.file_path, time)
              }
            }}
          />
        ) : imgError ? (
          renderError
        ) : (
          <img
            src={displayUrl ?? fileUrl ?? ''}
            // 占位阶段按原图宽高比撑满盒子，使「缩略图 → 原图」换源零布局变化
            width={displayUrl !== fileUrl ? currentFile.width : undefined}
            height={displayUrl !== fileUrl ? currentFile.height : undefined}
            alt={currentFile.file_name}
            className="max-w-full max-h-full object-contain"
            draggable={false}
            data-fullscreen-img
            crossOrigin={needsAnonymousCors(displayUrl ?? fileUrl ?? '') ? 'anonymous' : undefined}
            onError={() => {
              // 缩略图失败不等于图片不可用：先升级为原图，原图再失败才进错误占位
              if (displayUrl !== fileUrl) {
                setDisplayUrl(fileUrl)
              } else {
                setImgError(true)
              }
            }}
            style={{ viewTransitionName: 'fullscreen-media' }}
          />
        )}

        {/* 缺陷1：左右边缘鼠标热区。置于工具栏与左右导航按钮之前，
            使其不遮挡既有按钮（后续兄弟节点在同级层叠中位于上层）；
            纯鼠标命中区对辅助技术隐藏，键盘用户保留方向键路径 */}
        {fullscreenIndex > 0 && (
          <div
            aria-hidden="true"
            data-mouse-hotzone="prev"
            className="absolute left-0 top-0 h-full"
            style={{ width: HOTZONE_WIDTH, cursor: 'pointer' }}
            onClick={prevPage}
          />
        )}
        {fullscreenIndex < activeFiles.length - 1 && (
          <div
            aria-hidden="true"
            data-mouse-hotzone="next"
            className="absolute right-0 top-0 h-full"
            style={{ width: HOTZONE_WIDTH, cursor: 'pointer' }}
            onClick={nextPage}
          />
        )}

        {/* 顶部工具栏 */}
        <div
          className="absolute top-0 left-0 right-0 h-14 flex items-center justify-between px-4 transition-opacity"
          style={{
            background: 'linear-gradient(to bottom, rgba(0,0,0,0.6), transparent)',
            opacity: showControls ? 1 : 0,
            pointerEvents: showControls ? 'auto' : 'none'
          }}
        >
          {/* P2 修复：长标题（含文件名 + 序号）会挤压右侧按钮组，加 truncate + max-w 限制 */}
          <span className="text-[var(--text-on-overlay)] text-sm font-medium truncate max-w-[50%]">
            {title}
          </span>
          <div
            className="flex items-center gap-2"
            // WCO 避让：全屏查看器为非原生全屏，右上角按钮组需左移出
            // 原生窗口控制按钮区（Windows titleBarOverlay），env() 在
            // 非 WCO 环境取 fallback 归零，不影响浏览器预览布局
            style={{
              marginRight:
                'calc(100vw - env(titlebar-area-width, 100vw) - env(titlebar-area-x, 0px))'
            }}
          >
            {/* F-S10：幻灯片播放控制 */}
            <div className="relative">
              <button
                className="icon-btn text-[var(--text-on-overlay)]"
                onClick={toggleSlideshow}
                title={
                  slideshow.isPlaying
                    ? t('gallery.fullscreen.slideshowPauseTitle')
                    : t('gallery.fullscreen.slideshowPlayTitle')
                }
                aria-label={
                  slideshow.isPlaying
                    ? t('gallery.fullscreen.slideshowPauseAria')
                    : t('gallery.fullscreen.slideshowPlayAria')
                }
              >
                {slideshow.isPlaying ? <IconPause size={18} /> : <IconPlay size={18} />}
              </button>
              <button
                className="icon-btn text-[var(--text-on-overlay)] text-xs ml-1"
                onClick={() => setShowIntervalMenu((v) => !v)}
                title={t('gallery.fullscreen.intervalTitle')}
                aria-label={t('gallery.fullscreen.intervalTitle')}
                style={{ minWidth: 'auto', padding: '4px 8px' }}
              >
                {(playInterval / 1000).toString()}s
              </button>
              {showIntervalMenu && (
                <div
                  className="absolute top-full right-0 mt-1 py-1 rounded-lg z-50 min-w-[80px]"
                  style={{
                    background: 'rgba(30, 41, 59, 0.95)',
                    backdropFilter: 'var(--backdrop-blur)'
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  {([1000, 2000, 3000, 5000, 8000] as const).map((ms) => (
                    <button
                      key={ms}
                      className="w-full px-3 py-1.5 text-xs text-[var(--text-on-overlay)] text-left hover:bg-white/10 transition-colors"
                      onClick={() => {
                        setPlayInterval(ms)
                        setShowIntervalMenu(false)
                      }}
                      style={
                        playInterval === ms
                          ? { color: 'var(--accent)', fontWeight: 600 }
                          : undefined
                      }
                    >
                      {t('gallery.fullscreen.intervalOption', { n: ms / 1000 })}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="w-px h-5 bg-white/20" />
            <button
              className="icon-btn text-[var(--text-on-overlay)]"
              onClick={() => toggleFavorite(currentFile)}
              title={
                currentFile.is_favorite
                  ? t('gallery.fullscreen.unfavoriteTitle')
                  : t('gallery.fullscreen.favoriteTitle')
              }
              aria-label={
                currentFile.is_favorite
                  ? t('gallery.fullscreen.unfavoriteTitle')
                  : t('gallery.fullscreen.favoriteTitle')
              }
            >
              <IconFavorite
                size={18}
                filled={currentFile.is_favorite}
                color={currentFile.is_favorite ? 'var(--favorite)' : 'var(--text-on-overlay)'}
              />
            </button>
            {/* 图片相机参数浮层开关（视频文件不显示） */}
            {currentFile.file_type === 'image' && (
              <button
                className="icon-btn text-[var(--text-on-overlay)]"
                onClick={() => setShowInfoPanel((v) => !v)}
                title={
                  showInfoPanel
                    ? t('gallery.fullscreen.hideInfoTitle')
                    : t('gallery.fullscreen.showInfoTitle')
                }
                aria-label={
                  showInfoPanel
                    ? t('gallery.fullscreen.hideInfoTitle')
                    : t('gallery.fullscreen.showInfoTitle')
                }
                style={showInfoPanel ? { background: 'rgba(255,255,255,0.18)' } : undefined}
              >
                <IconInfo size={18} />
              </button>
            )}
            <button
              className="icon-btn text-[var(--text-on-overlay)]"
              onClick={() => handleSaveAs(currentFile)}
              title={t('gallery.fullscreen.saveAsTitle')}
              aria-label={t('gallery.fullscreen.saveAsTitle')}
            >
              <IconSaveAs size={18} />
            </button>
            <button
              className="icon-btn text-[var(--text-on-overlay)]"
              onClick={() => handleDelete(currentFile)}
              title={t('common.delete')}
              aria-label={t('common.delete')}
            >
              <IconDelete size={18} />
            </button>
            <button
              className="icon-btn text-[var(--text-on-overlay)]"
              onClick={handleClose}
              title={t('gallery.fullscreen.closeTitle')}
              aria-label={t('common.close')}
            >
              <IconClose size={18} />
            </button>
          </div>
        </div>

        {/* 左右导航 */}
        {fullscreenIndex > 0 && (
          <button
            className="absolute left-4 top-1/2 -translate-y-1/2 icon-btn text-[var(--text-on-overlay)]"
            onClick={() => navigate(-1)}
            style={{ background: 'rgba(0,0,0,0.4)' }}
            aria-label={t('gallery.fullscreen.prevAriaLabel')}
          >
            <IconChevronLeft size={24} />
          </button>
        )}
        {/* G6：显隐判据必须与 navigate 的边界一致——都以 activeFiles（当前生效列表）
            为准。重复文件页等显式携带 files 的入口，filteredFiles 只是图库兜底列表 */}
        {fullscreenIndex < activeFiles.length - 1 && (
          <button
            className="absolute right-4 top-1/2 -translate-y-1/2 icon-btn text-[var(--text-on-overlay)]"
            onClick={() => navigate(1)}
            style={{ background: 'rgba(0,0,0,0.4)' }}
            aria-label={t('gallery.fullscreen.nextAriaLabel')}
          >
            <IconChevronRight size={24} />
          </button>
        )}
      </div>

      <Toast messages={messages} onDismiss={dismiss} zIndex={90} />

      {/* EXIF 相机参数浮层（仅图片，点击信息按钮展开）。
          data-wheel-ignore：向全屏根部的 useWheelPageNav 声明滚轮归属本浮层
          （缺陷1 审查修复——浮轮不得被吞并误翻页，也不得被 preventDefault 掐死自身滚动）；
          data-fullscreen-info-panel：测试定位标记（对齐 data-fullscreen-img 约定） */}
      {showInfoPanel && currentFile.file_type === 'image' && (
        <div
          className="absolute top-16 right-4 w-80 max-h-[calc(100vh-8rem)] overflow-y-auto z-[85] rounded-xl p-4"
          data-wheel-ignore=""
          data-fullscreen-info-panel=""
          style={{
            background: 'rgba(20, 25, 35, 0.85)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            border: '1px solid rgba(255,255,255,0.1)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.4)'
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-[var(--text-on-overlay)] text-sm font-semibold flex items-center gap-1.5">
              <IconInfo size={14} />
              {t('gallery.fullscreen.infoPanelTitle')}
            </span>
            <button
              className="text-[var(--text-on-overlay-secondary)] hover:text-[var(--text-on-overlay)] transition-colors"
              onClick={() => setShowInfoPanel(false)}
              aria-label={t('gallery.fullscreen.infoPanelCloseAria')}
              title={t('common.close')}
            >
              <IconClose size={14} />
            </button>
          </div>
          <ExifPanel file={currentFile} variant="dark" showTitle={false} />
          <div
            className="pt-3 mt-3 space-y-3"
            style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}
          >
            <PhotographyPanel file={currentFile} variant="dark" showTitle={false} />
            <CameraInfoPanel file={currentFile} variant="dark" showTitle={false} />
            <NikkiInfoPanel file={currentFile} variant="dark" showTitle={false} />
            <OutfitPanel file={currentFile} variant="dark" showTitle={false} />
            <InteractionPanel file={currentFile} variant="dark" showTitle={false} />
          </div>
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          open={confirm.open}
          title={confirm.title}
          message={confirm.message}
          confirmVariant="danger"
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  )
}
