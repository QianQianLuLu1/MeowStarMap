import React, { Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '../EmptyState'
import { ErrorBoundary } from '../ErrorBoundary'
import { ZoneErrorFallback } from '../ErrorFallback'
import { LazyMiralandMap } from './LazyMiralandMap'
import type { MiralandMapView } from './MiralandMap'

interface LocationMapCardProps {
  view: MiralandMapView
}

/**
 * 属性/详情区域内的内嵌视图。仍可拖拽平移、用缩放按钮/双击缩放、受边界约束；
 * 仅关闭滚轮缩放，避免劫持详情侧栏的滚动。
 * 懒加载 chunk 失败由局部 ErrorBoundary 兜底（审查修复 2026-11-11），
 * 只降级地图区域，不升级到路由级边界整页降级。
 */
export const LocationMapCard: React.FC<LocationMapCardProps> = ({ view }) => {
  const { t } = useTranslation()
  return (
    <div style={{ height: 160 }}>
      <ErrorBoundary fallback={ZoneErrorFallback}>
        <Suspense fallback={<EmptyState status="loading" title={t('locationMap.loading')} />}>
          <LazyMiralandMap view={view} scrollWheelZoom={false} />
        </Suspense>
      </ErrorBoundary>
    </div>
  )
}
