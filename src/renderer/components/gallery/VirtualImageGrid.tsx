import React, { forwardRef, useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  VirtuosoGrid,
  type VirtuosoGridHandle,
  type ListRange,
  type GridListProps
} from 'react-virtuoso'
import { toFileUrl } from '../../stores/mediaStore'
import { formatFileSize } from '../../utils/format'
import { IconEdit, IconFavorite, IconDelete } from '../../icons'
import { MissingBadge } from '../common/MissingBadge'
import { CorruptedBadge } from '../common/CorruptedBadge'
import { MediaThumbPlaceholder } from './MediaThumbPlaceholder'
import { MediaCheckbox } from './MediaCheckbox'
import { ThumbReveal } from '../common/ThumbReveal'
import { useFailedImages } from '../../hooks/useFailedImages'
import { getResponsiveColumns, DEFAULT_COLUMNS_BREAKPOINTS } from '../../utils/responsive'
import type { MediaFile } from '../../stores/mediaStore'

// 前置守卫：后端会把游戏原生缩略图路径直接填入 thumbnail（形如
// .../GamePlayPhotos/{uid}/NikkiPhotos_LowQuality|HighQuality/xxx.jpg），
// 这类路径不适用缓存命名规则（_low/_high）改写，否则会推导出不存在的路径导致 404。
// 路径分隔符可能是反斜杠或正斜杠，且目录名大小写不保证，统一小写归一化后匹配。
const isNativeGameThumbnail = (thumbnail: string): boolean => {
  const lower = thumbnail.toLowerCase()
  return lower.includes('nikkiphotos_lowquality') || lower.includes('nikkiphotos_highquality')
}

// P1-03：从标准缩略图路径推导低质量路径（缓存命名规则：${hash}.jpg → ${hash}_low.jpg）
// 原生游戏缩略图路径返回 null，组件直接使用原 thumbnail 路径显示。
// fix-thumbnail-skeleton-reveal N4：网格显示已废除低清档（模糊中间态移除），
// 本导出保留供 DetailPage 占位底图与 DuplicatesPage 失败回退（fallbackSrc）使用。
export const toLowQualityUrl = (thumbnail: string | undefined): string | null => {
  if (!thumbnail) return null
  if (isNativeGameThumbnail(thumbnail)) return null
  if (thumbnail.endsWith('.jpg')) {
    return thumbnail.slice(0, -4) + '_low.jpg'
  }
  return null
}

// 高清档位路径推导：${hash}.jpg → ${hash}_high.jpg（命名契约函数，_high 投机档已移除）
export const toHighQualityUrl = (thumbnail: string | undefined): string | null => {
  if (!thumbnail) return null
  if (isNativeGameThumbnail(thumbnail)) return null
  if (
    thumbnail.endsWith('.jpg') &&
    !thumbnail.endsWith('_low.jpg') &&
    !thumbnail.endsWith('_high.jpg')
  ) {
    return thumbnail.slice(0, -4) + '_high.jpg'
  }
  return null
}

// fix-thumbnail-skeleton-reveal N4：低清→standard 档位状态机（pickThumbnailUrl 等）
// 已整体移除——模糊中间态废除后，卡片唯一显示源就是 standard（清晰图），
// 由 ThumbReveal 做"骨架 → onLoad 后 200ms 淡入"门控直显。

// 按需生成单次守卫：file_path → 生成 Promise（含失败结果），虚拟列表复挂载/重复进入
// 可视区不重复触发 IPC。与 useVideoThumbGenerate 的 videoThumbGenerateCache 同语义，
// 覆盖图片与视频两类（THUMBNAIL_OPTIMIZATION_PLAN 节点2）。
const onDemandThumbPromises = new Map<string, Promise<string | null>>()

// 视口外扩展范围：提到模块级常量，避免每次渲染产生新对象引用导致第三方系统反复重订阅
const VIEWPORT_INCREASE = { top: 100, bottom: 100 } as const

/**
 * 网格卡片缩略图源判定（THUMBNAIL_OPTIMIZATION_PLAN 节点2）。
 *
 * 优先级：DB thumbnail > 按需生成结果 >（仅图片且生成失败时）原文件兜底 > null（占位）。
 * - thumbnail=NULL 且生成中/未触发：返回 null → 占位图标。不再直载数 MB 原图拉伸当缩略图
 *   （原图直载与后台批量任务争抢磁盘 IO，是「模糊数秒~数十秒才清晰」的放大器）。
 * - 图片生成失败（文件损坏/不可读）时回退原文件，保留旧行为兜底；视频绝不返回原视频路径
 *   （<img> 无法解码视频，回退必裂图，对齐 useVideoThumbGenerate 不变量）。
 */
export const resolveEffectiveThumbnail = (params: {
  fileType: 'image' | 'video'
  thumbnail: string | null | undefined
  generatedPath: string | undefined
  generateFailed: boolean
  filePath: string
}): string | null => {
  if (params.thumbnail) return params.thumbnail
  if (params.generatedPath) return params.generatedPath
  if (params.fileType === 'image' && params.generateFailed && params.filePath) {
    return params.filePath
  }
  return null
}

interface VirtualImageGridProps {
  items: MediaFile[]
  selectedIds: string[]
  onSelect: (id: string, index: number, event: React.MouseEvent | React.KeyboardEvent) => void
  onHover: (id: string | null) => void
  onContextMenu: (event: React.MouseEvent, file: MediaFile) => void
  onEdit?: (file: MediaFile) => void
  onFavorite?: (file: MediaFile) => void
  onDelete?: (file: MediaFile) => void
  // 无限滚动：传入即启用触底加载与状态页脚，不传则完全保持原有行为
  onEndReached?: () => void
  loadingMore?: boolean
  hasMore?: boolean
  /** 可选；true 时卡片渲染可见勾选框（默认 false，保证既有调用点行为不变） */
  multiSelectMode?: boolean
  /** 可选；勾选框点击回调（点击不冒泡到卡片，不会触发打开全屏） */
  onToggleSelection?: (id: string) => void
}

// P1-U11：抽取 MediaCardActions 消除 hover/touch 两套按钮组重复
// variant='hover' 用于桌面 hover 态（var(--overlay-bg-medium)），variant='touch' 用于触屏常驻态（var(--overlay-bg)）
const MediaCardActions: React.FC<{
  file: MediaFile
  onEdit?: (file: MediaFile) => void
  onFavorite?: (file: MediaFile) => void
  onDelete?: (file: MediaFile) => void
  variant: 'hover' | 'touch'
}> = ({ file, onEdit, onFavorite, onDelete, variant }) => {
  const { t } = useTranslation()
  const bgClass = variant === 'hover' ? 'bg-[var(--overlay-bg-medium)]' : 'bg-[var(--overlay-bg)]'
  return (
    <div className="absolute top-2 right-2 flex gap-1">
      {onEdit && file.file_type === 'image' && (
        <button
          className={`w-7 h-7 rounded-md flex items-center justify-center ${bgClass} text-[var(--text-on-overlay)] hover:bg-[var(--overlay-bg-hover)] transition-colors`}
          onClick={(e) => {
            e.stopPropagation()
            onEdit(file)
          }}
          title={t('gallery.virtualGrid.editTitle')}
          aria-label={t('gallery.virtualGrid.editAria')}
        >
          <IconEdit size={14} />
        </button>
      )}
      {onFavorite && (
        <button
          className={`w-7 h-7 rounded-md flex items-center justify-center ${bgClass} text-[var(--text-on-overlay)] hover:bg-[var(--overlay-bg-hover)] transition-colors`}
          onClick={(e) => {
            e.stopPropagation()
            onFavorite(file)
          }}
          title={
            file.is_favorite
              ? t('gallery.virtualGrid.unfavoriteTitle')
              : t('gallery.virtualGrid.favoriteTitle')
          }
          aria-label={
            file.is_favorite
              ? t('gallery.virtualGrid.unfavoriteAria')
              : t('gallery.virtualGrid.favoriteAria')
          }
        >
          <IconFavorite size={14} filled={file.is_favorite} />
        </button>
      )}
      {onDelete && (
        <button
          className={`w-7 h-7 rounded-md flex items-center justify-center ${bgClass} text-[var(--text-on-overlay)] hover:bg-[var(--danger)] transition-colors`}
          onClick={(e) => {
            e.stopPropagation()
            onDelete(file)
          }}
          title={t('gallery.virtualGrid.deleteTitle')}
          aria-label={t('gallery.virtualGrid.deleteAria')}
        >
          <IconDelete size={14} />
        </button>
      )}
    </div>
  )
}

// 性能重构 v3 改造项一：VirtualImageGrid 迁移至 react-virtuoso VirtuosoGrid
// - 用 VirtuosoGrid 替换自研 useVirtualGrid，万级文件滚动帧率 ≥ 55 FPS
// - 保留：多选（Ctrl/Cmd/Shift）、键盘 ↑↓←→/Home/End/Enter/Space、可视区按需生成
// - fix-thumbnail-skeleton-reveal N4：低清/standard 分级加载改为 ThumbReveal 骨架门控
//   直显（模糊中间态废除）；触屏常驻操作按钮、收藏徽标、视频时长徽标不变
const VirtualImageGridComponent = forwardRef<VirtuosoGridHandle, VirtualImageGridProps>(
  (props, ref) => {
    const {
      items: rawItems,
      selectedIds,
      onSelect,
      onHover,
      onContextMenu,
      onEdit,
      onFavorite,
      onDelete,
      onEndReached,
      loadingMore = false,
      hasMore = false,
      multiSelectMode = false,
      onToggleSelection
    } = props
    // 参数校验：items 必须为数组，非数组降级为空，杜绝脏数据进入 VirtuosoGrid
    // 用 useMemo 包裹，避免每次渲染重建引用导致下游 useCallback/useEffect 依赖抖动
    const items = useMemo(() => (Array.isArray(rawItems) ? rawItems : []), [rawItems])
    const { t } = useTranslation()
    const wrapperRef = useRef<HTMLDivElement>(null)
    const [columns, setColumns] = useState(4)
    const [hoveredId, setHoveredId] = useState<string | null>(null)
    const [focusedIndex, setFocusedIndex] = useState<number>(-1)
    // P1-U10：failedImages 状态管理 + items 变化时自动清空
    const { failedImages, markFailed, clearFailed } = useFailedImages(items)
    // THUMBNAIL_OPTIMIZATION_PLAN 节点2：可视区按需生成结果（图片+视频统一）。
    // onDemandThumbs: file_path → 生成成功的缩略图路径；onDemandFailed: 生成失败集合
    // （失败不重试，防请求风暴；图片失败时经 resolveEffectiveThumbnail 回退原图）。
    const [onDemandThumbs, setOnDemandThumbs] = useState<Map<string, string>>(() => new Map())
    const [onDemandFailed, setOnDemandFailed] = useState<Set<string>>(() => new Set())
    // fix-thumbnail-skeleton-reveal N4：standard 重试代次（file_path → nonce）。
    // media:// 缩略图路径由内容 hash 决定，LRU 驱逐/重建后路径不变；<img> 对同一 src
    // 失败后不会自动重试，重建成功时 +1 并在 src 追加 &r=N 强制重新加载。
    const [thumbRetryNonce, setThumbRetryNonce] = useState<Map<string, number>>(() => new Map())
    // 审查修复 T1：本会话已触发过就地重建的卡片（file.id）。单次语义与 onDemandFailed
    // 一致（失败不重试，防请求风暴）；重建后仍无法加载即终止为占位警告图标：
    // - 重建失败：URL 不变 → 不会有第二次 onError，由 applyResult(null) 直接 markFailed；
    // - 重建成功但 &r=N 重载仍失败：第二次 onError 命中本集合 → markFailed。
    const [standardRebuildTried, setStandardRebuildTried] = useState<Set<string>>(() => new Set())
    // U-G16：触屏设备无 hover 事件，需始终显示快捷操作按钮
    const [isTouchDevice, setIsTouchDevice] = useState(false)
    const gap = 16

    // 可视区按需生成调度（N4：原"停滚 300ms 升级 standard"中的档位升级已废除，
    // 防抖仅用于缺缩略图项的按需生成触发，避免快速滚动期间的 IPC 风暴）
    const scrollTimerRef = useRef<number | null>(null)
    // 通过 rangeChanged 跟踪当前可视区间
    const visibleRangeRef = useRef<ListRange>({ startIndex: 0, endIndex: 0 })

    // P1-03 / 高清档位路径推导抽为模块级纯函数 toLowQualityUrl / toHighQualityUrl
    //（含游戏原生缩略图路径守卫），推导返回 null 时直接使用原 thumbnail 路径显示。

    // U-G16：挂载时检测触屏能力（matchMedia 优先，回退到 ontouchstart）
    useEffect(() => {
      const hoverNone = window.matchMedia?.('(hover: none)').matches
      const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0
      setIsTouchDevice(hoverNone || hasTouch)
    }, [])

    // 选中态 Set：O(1) 查找
    const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])

    // 响应式列数：监听 wrapper 尺寸变化
    useEffect(() => {
      const update = () => {
        const width = wrapperRef.current?.clientWidth || window.innerWidth
        setColumns(getResponsiveColumns(width, DEFAULT_COLUMNS_BREAKPOINTS))
      }
      update()
      window.addEventListener('resize', update)
      const observer = new ResizeObserver(update)
      if (wrapperRef.current) observer.observe(wrapperRef.current)
      return () => {
        window.removeEventListener('resize', update)
        observer.disconnect()
      }
    }, [])

    // 可视区按需生成（THUMBNAIL_OPTIMIZATION_PLAN 节点2）：
    // - thumbnail=NULL 的项（图片+视频统一）就地生成 standard 缩略图，生成是磁盘缓存优先：
    //   批量/上一会话已生成的项立即返回，批量未达的项就地补齐，不再等待整批完成后的
    //   media:updated 全量刷新；
    // - standard 404（LRU 驱逐等）的项同样触发重建，成功后 bump 重试代次让原路径
    //   以 &r=N 强制重载（N4：路径由内容 hash 决定，重建不改路径，必须换 URL 才能重试）；
    // - 缓存命中（fix-thumbnail-persist-and-ondemand N1）：卡片滚出视区时组件卸载会丢
    //   onDemandThumbs state，滚回时 Map 命中的既有 promise 必须把已 resolved 的结果
    //   回填新实例（applyResult 幂等），否则显示占位直到下一次 media:updated 全量刷新。
    const ensureOnDemandThumbnail = useCallback(
      (file: MediaFile, onRebuildFailMarkId?: string) => {
        const filePath = file.file_path
        if (typeof filePath !== 'string' || filePath.length === 0) return
        // bumpRetry：仅真正新发起 IPC 生成的成功路径才递增重试代次。Map 命中（复用
        // 既有 promise）时递增会造成"失败 → 原样重试 → 再失败 → 再递增"的无限重载循环
        const applyResult = (result: string | null, bumpRetry: boolean) => {
          if (!result) {
            setOnDemandFailed((prev) => new Set(prev).add(filePath))
            // 审查修复 T1：img 错误链触发的重建失败时 URL 不变，不会再有第二次
            // onError，必须就地 markFailed 终止为占位警告图标（否则卡片永久卡骨架）
            if (onRebuildFailMarkId) {
              markFailed(onRebuildFailMarkId)
            }
            return
          }
          setOnDemandThumbs((prev) => {
            if (prev.has(filePath)) return prev
            const next = new Map(prev)
            next.set(filePath, result)
            return next
          })
          setOnDemandFailed((prev) => {
            if (!prev.has(filePath)) return prev
            const next = new Set(prev)
            next.delete(filePath)
            return next
          })
          if (bumpRetry) {
            // N4：重建成功 → 重试代次 +1。若该卡片此前因 standard 404 挂在骨架态，
            // nonce 变化会生成新的 &r=N src 强制重载；首次生成的卡片仅多了无效参数，无副作用
            setThumbRetryNonce((prev) => {
              const next = new Map(prev)
              next.set(filePath, (prev.get(filePath) ?? 0) + 1)
              return next
            })
          }
          // 重建成功：清除该卡片失败标记，使 standard URL 立即重试
          clearFailed(file.id)
        }
        // Map 命中：复用既有 promise 去重（同一 file_path 只发起一次生成），
        // 同时回填结果——直接 return 会让新挂载的实例拿不到已生成的缩略图
        const existing = onDemandThumbPromises.get(filePath)
        if (existing) {
          void existing.then((r) => applyResult(r, false))
          return
        }
        const generate = window.electronAPI?.thumbnail?.generate
        if (typeof generate !== 'function') return
        const promise = (async () => {
          try {
            return await generate(filePath)
          } catch {
            return null
          }
        })()
        onDemandThumbPromises.set(filePath, promise)
        void promise.then((r) => applyResult(r, true))
      },
      [clearFailed, markFailed]
    )

    // 可视区调度（停滚 300ms 防抖）：对可视区内缺缩略图的项触发按需生成。
    // N4：原"切换到标准质量"的档位升级已废除（standard 即唯一显示源，挂载即加载）
    const scheduleOnDemandGeneration = useCallback(() => {
      if (scrollTimerRef.current !== null) {
        window.clearTimeout(scrollTimerRef.current)
      }
      scrollTimerRef.current = window.setTimeout(() => {
        const { startIndex, endIndex } = visibleRangeRef.current
        if (endIndex <= startIndex) return
        // 节点2：可视区缺缩略图的项按需生成一次（磁盘缓存优先，单次守卫防风暴）
        for (let i = startIndex; i <= endIndex; i++) {
          const file = items[i]
          if (file && !file.thumbnail) {
            ensureOnDemandThumbnail(file)
          }
        }
      }, 300)
    }, [items, ensureOnDemandThumbnail])

    // 清理滚动定时器
    useEffect(() => {
      return () => {
        if (scrollTimerRef.current !== null) {
          window.clearTimeout(scrollTimerRef.current)
        }
      }
    }, [])

    // 分页页脚：仅在启用无限滚动（传入 onEndReached）且已有内容时展示
    // 加载中优先于"没有更多"，避免翻页途中先闪一下结束文案
    const footerText =
      !onEndReached || items.length === 0
        ? null
        : loadingMore
          ? t('gallery.virtualGrid.loadingMore')
          : hasMore
            ? null
            : t('gallery.virtualGrid.noMore')

    // 修复 Maximum call stack size exceeded（取证见
    // docs/plans/2026-09-29-fix-gallery-stack-overflow.md）：
    // react-virtuoso 的 components 一旦变更引用，其内部 List / Footer 的组件类型随之改变，
    // React 会卸载并重建整个列表子树，使 itemDimensions / gap / viewport 测量重新发布；
    // 而网格维度计算又以「已渲染可见区间」为输入，由此形成「测量 → 重渲染 → 再测量」
    // 的回路（堆栈表现为 U() 发布 → at() 输入处理器 → M() 再发布 → gridDimensions）。
    // 响应式列数 / 页脚文案是高频变化源，故改为经 ref 读取，令 components 引用恒定不变；
    // List 自身每次重渲染仍会取到最新 columns，布局行为不变。
    const latestRef = useRef({ columns, footerText })
    latestRef.current = { columns, footerText }

    // 自定义 List 组件：响应式 grid 布局
    // React 19 允许 ref 作为普通 prop，无需 forwardRef
    const gridComponents = useMemo(
      () => ({
        List: ({ children, className, style, ref, ...rest }: GridListProps) => (
          <div
            ref={ref}
            className={className}
            style={{
              ...style,
              display: 'grid',
              gridTemplateColumns: `repeat(${latestRef.current.columns}, minmax(0, 1fr))`,
              gap: `${gap}px`
            }}
            {...rest}
          >
            {children}
          </div>
        ),
        Footer: () =>
          latestRef.current.footerText === null ? null : (
            <div
              className="py-4 text-center text-xs"
              style={{ color: 'var(--text-secondary)' }}
              role="status"
              aria-live="polite"
            >
              {latestRef.current.footerText}
            </div>
          )
      }),
      [gap]
    )

    // 键盘导航：保留 ↑↓←→/Home/End/Enter/Space
    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (items.length === 0) return
        let nextIndex: number
        switch (e.key) {
          case 'ArrowRight':
            nextIndex = Math.min(items.length - 1, focusedIndex + 1)
            break
          case 'ArrowLeft':
            nextIndex = Math.max(0, focusedIndex - 1)
            break
          case 'ArrowDown':
            nextIndex = Math.min(items.length - 1, focusedIndex + columns)
            break
          case 'ArrowUp':
            nextIndex = Math.max(0, focusedIndex - columns)
            break
          case 'Home':
            nextIndex = 0
            break
          case 'End':
            nextIndex = items.length - 1
            break
          default:
            if (e.key === 'Enter' || e.key === ' ') {
              if (focusedIndex >= 0 && focusedIndex < items.length) {
                onSelect(items[focusedIndex].id, focusedIndex, e)
              }
            }
            return
        }
        e.preventDefault()
        setFocusedIndex(nextIndex)
        const virtuoso = ref as React.MutableRefObject<VirtuosoGridHandle | null>
        virtuoso.current?.scrollToIndex(nextIndex)
      },
      [focusedIndex, items, columns, onSelect, ref]
    )

    useEffect(() => {
      if (focusedIndex >= items.length) setFocusedIndex(-1)
    }, [items.length, focusedIndex])

    return (
      <div
        ref={wrapperRef}
        className="flex-1 min-h-0 overflow-hidden"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        role="grid"
        aria-label={t('gallery.virtualGrid.ariaLabel')}
      >
        <VirtuosoGrid
          ref={ref}
          data={items}
          computeItemKey={(_, file) => file.id}
          components={gridComponents}
          // 不再叠加 overscan：increaseViewportBy 已提供视口外扩展，两者并用会让网格
          // 维度计算的可见区间远超需求，放大上述测量回路的不收敛窗口
          increaseViewportBy={VIEWPORT_INCREASE}
          endReached={onEndReached}
          rangeChanged={(range) => {
            visibleRangeRef.current = range
            scheduleOnDemandGeneration()
          }}
          itemContent={(index, file) => {
            const isSelected = selectedSet.has(file.id)
            // THUMBNAIL_OPTIMIZATION_PLAN 节点2：缩略图源统一由 resolveEffectiveThumbnail 判定
            // （DB thumbnail > 可视区按需生成结果 > 图片生成失败时原文件兜底 > null 占位）。
            // 视频文件无缩略图时不得使用原视频文件作为 <img> 源（加载视频进 img 必触发
            // onError 显示警告图标）。
            // fix-thumbnail-skeleton-reveal N4：standard（清晰图）即唯一显示源，
            // 未 onLoad 前由 ThumbReveal 显示骨架动画，不再有低清垫底/模糊中间态；
            // thumbnail=NULL 且生成中时同样显示骨架动画（而非静态图标干等）。
            const generatedThumb = onDemandThumbs.get(file.file_path)
            const generateFailed = onDemandFailed.has(file.file_path)
            const effectiveThumbnail = resolveEffectiveThumbnail({
              fileType: file.file_type,
              thumbnail: file.thumbnail,
              generatedPath: generatedThumb,
              generateFailed,
              filePath: file.file_path
            })
            // 重试代次：standard 404 后就地重建成功时 +1，src 追加 &r=N 强制重载
            // （media:// 缩略图路径由内容 hash 决定，重建不改路径）
            const retryNonce = thumbRetryNonce.get(file.file_path) ?? 0
            const standardUrl = effectiveThumbnail
              ? toFileUrl(effectiveThumbnail) + (retryNonce > 0 ? `&r=${retryNonce}` : '')
              : ''
            const isFocused = index === focusedIndex
            const hasError = failedImages.has(file.id)
            const isMissing = file.is_missing === true
            // 损坏文件容错：损坏文件不显示缩略图，仅显示占位图 + 损坏角标
            const isCorrupted = file.is_corrupted === true
            const showThumb = !isCorrupted && !!standardUrl && !hasError
            // 生成中待显骨架：无可用缩略图 URL 且尚未进入失败终态的项（thumbnail=NULL
            // 生成排队中/在途）显示骨架动画——"加载中"与"失败"是两种状态，后者才显示图标
            const showSkeleton =
              !showThumb && !hasError && !isCorrupted && !generateFailed && !!file.file_path
            return (
              <div
                className={`media-card aspect-square ${multiSelectMode ? 'relative ' : ''}${
                  isSelected ? 'ring-2 ring-offset-2' : ''
                }`}
                style={{
                  background: 'var(--bg-tertiary)',
                  ...(isSelected
                    ? ({ '--tw-ring-color': 'var(--accent)' } as React.CSSProperties)
                    : {}),
                  outline: isFocused ? '2px solid var(--accent)' : 'none',
                  outlineOffset: '2px',
                  opacity: isMissing ? 0.45 : 1
                }}
                onClick={(e) => onSelect(file.id, index, e)}
                onMouseEnter={() => {
                  setHoveredId(file.id)
                  onHover(file.id)
                }}
                onMouseLeave={() => {
                  setHoveredId(null)
                  onHover(null)
                }}
                onContextMenu={(e) => onContextMenu(e, file)}
                onFocus={() => setFocusedIndex(index)}
                tabIndex={isFocused ? 0 : -1}
                role="gridcell"
                aria-selected={isSelected}
              >
                {multiSelectMode && (
                  <MediaCheckbox
                    checked={isSelected}
                    onChange={() => onToggleSelection?.(file.id)}
                    label={file.file_name}
                    className="absolute top-2 left-2 z-10"
                  />
                )}
                <div
                  className="w-full h-full flex items-center justify-center relative overflow-hidden rounded-xl"
                  style={{ background: 'var(--bg-tertiary)' }}
                >
                  {isMissing && <MissingBadge />}
                  {isCorrupted && <CorruptedBadge reason={file.corrupted_reason} />}
                  {showThumb ? (
                    <ThumbReveal
                      src={standardUrl}
                      alt={file.file_name}
                      dataMediaId={file.id}
                      onError={() => {
                        // standard 失败（后台批量未生成 404 / LRU 驱逐）：保持骨架态并就地
                        // 按需重建（节点2）。重建成功 → applyResult bump 重试代次，以 &r=N
                        // 强制重载。终止条件（审查修复 T1）：生成已失败过（generateFailed），
                        // 或本会话已对该卡触发过重建（重载再失败说明源本身不可用）→
                        // markFailed 终止为占位警告图标，等 media:updated 刷新（损坏标记/
                        // 新缩略图）后经 items 变化自动重试。
                        if (generateFailed || standardRebuildTried.has(file.id)) {
                          markFailed(file.id)
                          return
                        }
                        setStandardRebuildTried((prev) => new Set(prev).add(file.id))
                        ensureOnDemandThumbnail(file, file.id)
                      }}
                    />
                  ) : showSkeleton ? (
                    // 生成中/加载中骨架动画（复用 globals.css .skeleton，颜色走主题变量）
                    <div
                      data-testid="thumb-reveal-skeleton"
                      className="skeleton absolute inset-0"
                      aria-hidden="true"
                    />
                  ) : null}
                  <MediaThumbPlaceholder
                    fileType={file.file_type}
                    hasError={hasError || isCorrupted}
                    visible={!showThumb && !showSkeleton}
                  />

                  {hoveredId === file.id && (
                    <>
                      <div
                        className="absolute inset-0 flex flex-col justify-end p-3"
                        style={{
                          background: 'linear-gradient(transparent 50%, var(--overlay-bg-strong))'
                        }}
                      >
                        <p className="text-[var(--text-on-overlay)] text-xs font-medium ellipsis-2">
                          {file.file_name}
                        </p>
                        <p className="text-[var(--text-on-overlay-secondary)] text-xs">
                          {formatFileSize(file.file_size)}
                        </p>
                      </div>
                      <MediaCardActions
                        file={file}
                        onEdit={onEdit}
                        onFavorite={onFavorite}
                        onDelete={onDelete}
                        variant="hover"
                      />
                    </>
                  )}

                  {isTouchDevice && hoveredId !== file.id && (
                    <MediaCardActions
                      file={file}
                      onEdit={onEdit}
                      onFavorite={onFavorite}
                      onDelete={onDelete}
                      variant="touch"
                    />
                  )}

                  {isTouchDevice && hoveredId !== file.id && (
                    <div
                      className="absolute inset-x-0 bottom-0 left-0 right-8 p-2"
                      style={{ background: 'var(--overlay-gradient-bottom)' }}
                    >
                      <p className="text-[var(--text-on-overlay)] text-xs font-medium truncate">
                        {file.file_name}
                      </p>
                    </div>
                  )}

                  {file.is_favorite && hoveredId !== file.id && !isTouchDevice && (
                    <div className="absolute top-2 right-2">
                      <IconFavorite size={16} filled />
                    </div>
                  )}

                  {file.duration && (
                    <div
                      className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded text-xs font-medium text-[var(--text-on-overlay)]"
                      style={{ background: 'var(--overlay-bg-strong)' }}
                    >
                      {Math.floor(file.duration / 60)}:{String(file.duration % 60).padStart(2, '0')}
                    </div>
                  )}
                </div>
              </div>
            )
          }}
        />
      </div>
    )
  }
)

VirtualImageGridComponent.displayName = 'VirtualImageGrid'

export const VirtualImageGrid = React.memo(VirtualImageGridComponent)
