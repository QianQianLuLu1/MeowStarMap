import React, { useEffect, useRef, useState } from 'react'

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

/**
 * 缩略图骨架门控直显组件（plan: 2026-09-30-fix-thumbnail-skeleton-reveal N3）。
 *
 * 彻底消灭"白屏 → 模糊 → 清晰"渐进中间态：
 * - 清晰图 onLoad 完成前：img 保持 opacity-0（负责发起加载但不显示内容），
 *   仅渲染 .skeleton 骨架动画层（复用 globals.css 既有动画，颜色走主题变量）；
 * - onLoad 后：骨架卸载，img 经 200ms opacity 过渡淡入，"骨架 → 清晰直显"；
 * - src 变化（虚拟列表复用卡片换源/回退重试）：渲染期重置回未加载态，img 以 key={src}
 *   重挂载（旧源元素的迟到 load/error 事件不会命中新源）；
 * - onError 仅透传父级，不擅自进入错误终态。
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
  const [loaded, setLoaded] = useState(false)
  const imgRef = useRef<HTMLImageElement>(null)

  // 换源重置（审查修复 T2）：必须在渲染期完成——若走 useEffect，重置发生在浏览器
  // 绘制之后，换源那一帧会以旧的 loaded=true 渲染新 src（旧图/空白闪现一帧）；
  // React 官方 "adjusting state during render" 模式保证首个渲染帧即未加载骨架态。
  const [prevSrc, setPrevSrc] = useState(src)
  if (prevSrc !== src) {
    setPrevSrc(src)
    setLoaded(false)
  }

  // 缓存命中兜底：图片在 HTTP 缓存中时 load 事件可能早于 React 事件绑定，
  // 挂载后自检 complete，避免已就绪的图卡在骨架态（naturalWidth>0 才算真正解码成功）
  useEffect(() => {
    const img = imgRef.current
    if (img?.complete && img.naturalWidth > 0) {
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
        onLoad={() => setLoaded(true)}
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
