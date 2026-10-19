import React, { useLayoutEffect, useRef, useState } from 'react'

interface ThumbRevealProps {
  /** 缩略图 URL（media:// 等）；空串时不渲染任何内容（无图/错误态由父级占位组件负责） */
  src: string
  alt: string
  /** 加载失败透传父级（回退链/就地重建/占位图标均由父级决定），骨架层不吞错误 */
  onError: () => void
  /** img 类名，默认 absolute inset-0 全覆盖 object-cover */
  className?: string
  /** 虚拟列表调试/测试定位用，透传到 img */
  dataMediaId?: string
  /** 可选 img 定位标识（瀑布流等既有测试以 data-testid 定位 img 元素） */
  dataTestId?: string
}

// 修复网格滚动闪烁 N1：本会话内「已完整加载成功」的 src 记忆。
// 机制：虚拟列表（VirtuosoGrid / masonic）卸载视口外的行，滚回即整棵卡片重挂载，而 loaded
// 是实例 state——每次重挂载都从 false 起步，必然先绘制一帧 shimmer 骨架再走 200ms 淡入。
// 网格视口外只扩 100px（VirtualImageGrid.tsx VIEWPORT_INCREASE），这次重放因此总落在可见区，
// 表现为「向下滚动时逐格闪一下」；软件渲染设备上 CPU 光栅让这一帧更显眼（见问题设备日志
// [GPU] …禁用硬件加速（软件渲染）），故仅部分设备复现。
// key 用完整 src 字符串：网格侧就地重建会 bump `&r=N` 换 URL（全仓唯一生成点在 VirtualImageGrid），
// 新 URL 天然不被旧证据命中；其余 6 个调用方传裸 URL，而缩略图按源图内容哈希命名，
// 因此两张重复照片本就共用同一 src——共用的是同一份字节，不影响显示正确性。
const LOADED_SRC_CAP = 512
const loadedSrcs = new Set<string>()

/** 记录已加载完的 src；达上限按 FIFO 淘汰最早一项（最坏退化为「再闪一帧骨架」，不会白屏） */
const rememberLoadedSrc = (src: string): void => {
  if (!src) return
  if (!loadedSrcs.has(src) && loadedSrcs.size >= LOADED_SRC_CAP) {
    const oldest = loadedSrcs.values().next().value
    if (oldest !== undefined) loadedSrcs.delete(oldest)
  }
  loadedSrcs.add(src)
}

/**
 * 缩略图骨架门控直显组件（plan: 2026-09-30-fix-thumbnail-skeleton-reveal N3）。
 *
 * 彻底消灭"白屏 → 模糊 → 清晰"渐进中间态：
 * - 清晰图 onLoad 完成前：img 保持 opacity-0（负责发起加载但不显示内容），
 *   仅渲染 .skeleton 骨架动画层（复用 globals.css 既有动画，颜色走主题变量）；
 * - onLoad 后：骨架卸载，img 经 200ms opacity 过渡淡入，"骨架 → 清晰直显"；
 * - 换新 src（虚拟列表复用卡片换源/回退重试）：渲染期按「该 src 是否已加载完」复位——
 *   未加载过回到骨架，已加载过（滚出视区又滚回的同一张）首帧即直显，不再重放骨架；
 *   img 以 key={src} 重挂载（旧源元素的迟到 load/error 事件不会命中新源）；
 * - onError 仅透传父级，不擅自进入错误终态，且失败项永不写入已加载记忆。
 *
 * 与 TieredCardImage 的区别：不再有 64px 低清垫底图与交叉淡入（模糊中间态已废除）。
 */
export const ThumbReveal: React.FC<ThumbRevealProps> = ({
  src,
  alt,
  onError,
  className = 'absolute inset-0 w-full h-full object-cover',
  dataMediaId,
  dataTestId
}) => {
  // 挂载初值即查记忆：滚回视区的同一张卡不再从「未加载」起步（N1）
  const [loaded, setLoaded] = useState(() => loadedSrcs.has(src))
  const imgRef = useRef<HTMLImageElement>(null)

  // 换源重置（审查修复 T2）：必须在渲染期完成——若走 useEffect，重置发生在浏览器
  // 绘制之后，换源那一帧会以旧的 loaded=true 渲染新 src（旧图/空白闪现一帧）；
  // React 官方 "adjusting state during render" 模式保证首个渲染帧即未加载骨架态。
  // N1：复位值由恒 false 改为「该 src 是否已加载完」——复用/滚回不再重放骨架，
  // 换新 src（含 &r=N 重试代次）仍回到骨架。
  const [prevSrc, setPrevSrc] = useState(src)
  if (prevSrc !== src) {
    setPrevSrc(src)
    setLoaded(loadedSrcs.has(src))
  }

  // 缓存命中兜底：图片在 HTTP 缓存中时 load 事件可能早于 React 事件绑定，
  // 挂载后自检 complete，避免已就绪的图卡在骨架态（naturalWidth>0 才算真正解码成功）。
  // N1：useEffect → useLayoutEffect——passive effect 在浏览器绘制之后才跑，兜底会先露出
  // 一帧骨架；layout effect 在绘制前生效，首次命中缓存也不闪。
  useLayoutEffect(() => {
    const img = imgRef.current
    if (img?.complete && img.naturalWidth > 0) {
      rememberLoadedSrc(src)
      setLoaded(true)
    }
  }, [src])

  if (!src) return null

  const dataProps = {
    ...(dataMediaId === undefined ? {} : { 'data-media-id': dataMediaId }),
    ...(dataTestId === undefined ? {} : { 'data-testid': dataTestId })
  }
  return (
    <>
      <img
        key={src}
        ref={imgRef}
        src={src}
        alt={alt}
        className={`${className} transition-opacity duration-200 ${loaded ? 'opacity-100' : 'opacity-0'}`}
        loading="lazy"
        decoding="async"
        draggable={false}
        onLoad={() => {
          // load 事件是位图就绪的权威信号：记入记忆，供同一 src 后续重挂载直接跳过骨架。
          // 失败只走 onError 透传父级，永不写入（坏图不被掩盖）。
          rememberLoadedSrc(src)
          setLoaded(true)
        }}
        onError={onError}
        {...dataProps}
      />
      {!loaded && (
        <div
          data-testid="thumb-reveal-skeleton"
          className="skeleton absolute inset-0"
          aria-hidden="true"
        />
      )}
    </>
  )
}
