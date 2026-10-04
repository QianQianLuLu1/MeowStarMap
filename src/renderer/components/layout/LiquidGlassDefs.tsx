import React from 'react'

/**
 * 液态玻璃折射滤镜（全局单例 defs，AppShell 挂载一次）。
 *
 * 技法来源（开源复用，避免重复造轮子）：
 * - kube.io "Liquid Glass in the Browser: Refraction with CSS and SVG"：
 *   backdrop-filter: url(#filter) 引用 SVG feDisplacementMap，对玻璃背后的
 *   内容做边缘折射；Chromium 108+ 支持，Safari/Firefox 不支持（本应用仅
 *   Electron Chromium 运行，preview.html 在外部浏览器打开时经特性检测降级）。
 * - rdev/liquid-glass-react（MIT）的位移贴图思路：R/G 通道分别编码水平/垂直
 *   采样偏移，中性灰(128)为不位移。此处拆成水平、垂直两张纯通道贴图链式
 *   位移，避免两轴贴图叠加时的混色误差。
 */

export const REFRACT_FILTER_ID = 'liquid-glass-refract'

/** Chromium 108+ 才支持 backdrop-filter 引用 SVG 滤镜；CSS API 缺失同样视为不支持 */
export function supportsBackdropSvgFilter(): boolean {
  return (
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    CSS.supports('backdrop-filter', `url('#${REFRACT_FILTER_ID}') blur(4px)`)
  )
}

/**
 * 位移贴图：两轴渐变均为「边缘满偏移 → 中心带平直」的台阶式 stops，
 * 让折射只发生在玻璃边缘（模拟玻璃厚度），中央区域保持不位移。
 * R 通道编码水平偏移：左缘 255（从右侧取样）、右缘 0（从左侧取样）。
 */
const MAP_X = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" preserveAspectRatio="none"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="rgb(255,128,128)"/><stop offset="0.22" stop-color="rgb(255,128,128)"/><stop offset="0.42" stop-color="rgb(128,128,128)"/><stop offset="0.58" stop-color="rgb(128,128,128)"/><stop offset="0.78" stop-color="rgb(0,128,128)"/><stop offset="1" stop-color="rgb(0,128,128)"/></linearGradient></defs><rect width="160" height="160" fill="url(#g)"/></svg>`
)}`

/** G 通道编码垂直偏移：上缘 255（从下方取样）、下缘 0（从上方取样）。 */
const MAP_Y = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" preserveAspectRatio="none"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgb(128,255,128)"/><stop offset="0.22" stop-color="rgb(128,255,128)"/><stop offset="0.42" stop-color="rgb(128,128,128)"/><stop offset="0.58" stop-color="rgb(128,128,128)"/><stop offset="0.78" stop-color="rgb(128,0,128)"/><stop offset="1" stop-color="rgb(128,0,128)"/></linearGradient></defs><rect width="160" height="160" fill="url(#g)"/></svg>`
)}`

export const LiquidGlassDefs: React.FC = () => {
  if (!supportsBackdropSvgFilter()) return null
  return (
    <svg aria-hidden="true" focusable="false" width="0" height="0" style={{ position: 'absolute' }}>
      <defs>
        {/* color-interpolation-filters="sRGB" 保证通道值按字节线性解释（默认 linearRGB 会误读灰度） */}
        <filter
          id={REFRACT_FILTER_ID}
          x="-20%"
          y="-20%"
          width="140%"
          height="140%"
          colorInterpolationFilters="sRGB"
        >
          <feImage
            href={MAP_X}
            x="0"
            y="0"
            width="100%"
            height="100%"
            preserveAspectRatio="none"
            result="mapX"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="mapX"
            scale="8"
            xChannelSelector="R"
            yChannelSelector="G"
            result="dispX"
          />
          <feImage
            href={MAP_Y}
            x="0"
            y="0"
            width="100%"
            height="100%"
            preserveAspectRatio="none"
            result="mapY"
          />
          <feDisplacementMap
            in="dispX"
            in2="mapY"
            scale="8"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </defs>
    </svg>
  )
}
