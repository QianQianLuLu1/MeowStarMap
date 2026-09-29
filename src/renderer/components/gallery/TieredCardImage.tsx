import React, { useEffect, useState } from 'react'

interface TieredCardImageProps {
  /** 低清档 URL（64px 快速出图）；null 表示无低清档（游戏原生缩略图/无缓存路径） */
  lowUrl: string | null
  /** standard 档 URL（320px）；空字符串表示无图可显示（组件渲染 null，占位由父组件负责） */
  standardUrl: string
  /** 是否以 standard 为主显源（false 时仅渲染低清，onError 走 onLowError） */
  showStandard: boolean
  alt: string
  /** 低清为主显源时加载失败（升级 standard 的回退链交由父组件处理） */
  onLowError: () => void
  /** standard 为主显源时加载失败（回退低清的回退链交由父组件处理） */
  onStandardError: () => void
  /** 虚拟列表调试/测试定位用，透传到两张 img 上 */
  dataMediaId?: string
}

/**
 * 网格卡片分层图片（THUMBNAIL_OPTIMIZATION_PLAN 节点3）：
 * - 仅低清：单图渲染（P1-03 既有行为不变）。
 * - standard 主显且有低清底图：底图垫底，standard onLoad 后 200ms 淡入并卸载底图，
 *   消除换 src 硬切造成的闪跳；底图纯装饰不挂 onError——升级后低清的在途请求失败
 *   不应误触 standard 的回退链（单图时代 src 切换会取消该请求，双图时代必须显式豁免）。
 * - 无低清档（游戏原生缩略图等）：standard 直接完整显示，不做无意义的淡入。
 * onError 均透传父组件，档位回退链状态机保持不变。
 */
export const TieredCardImage: React.FC<TieredCardImageProps> = ({
  lowUrl,
  standardUrl,
  showStandard,
  alt,
  onLowError,
  onStandardError,
  dataMediaId
}) => {
  const [standardLoaded, setStandardLoaded] = useState(false)

  // 换源（不同文件的卡片被复用/回退重试）时重置淡入状态
  useEffect(() => {
    setStandardLoaded(false)
  }, [standardUrl])

  if (!standardUrl) return null

  const imgClass = 'absolute inset-0 w-full h-full object-cover'
  const dataProps = dataMediaId === undefined ? {} : { 'data-media-id': dataMediaId }

  if (!showStandard) {
    return (
      <img
        src={lowUrl ?? ''}
        alt={alt}
        className={imgClass}
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={onLowError}
        {...dataProps}
      />
    )
  }

  const crossfade = !!lowUrl && !standardLoaded
  return (
    <>
      {crossfade && (
        <img
          src={lowUrl}
          alt=""
          aria-hidden="true"
          className={imgClass}
          loading="lazy"
          decoding="async"
          draggable={false}
          {...dataProps}
        />
      )}
      <img
        src={standardUrl}
        alt={alt}
        className={`${imgClass} transition-opacity duration-200 ${
          standardLoaded || !lowUrl ? 'opacity-100' : 'opacity-0'
        }`}
        loading="lazy"
        decoding="async"
        draggable={false}
        onLoad={() => setStandardLoaded(true)}
        onError={onStandardError}
        {...dataProps}
      />
    </>
  )
}
