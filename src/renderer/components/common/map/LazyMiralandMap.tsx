import React from 'react'

/**
 * Leaflet 只落在这个懒加载 chunk，不进首屏包体。
 * 内嵌卡与独立弹窗共用同一入口，保证两种形态拿到的是同一个地图实现。
 */
export const LazyMiralandMap = React.lazy(() =>
  import('./MiralandMap').then((module) => ({ default: module.MiralandMap }))
)
