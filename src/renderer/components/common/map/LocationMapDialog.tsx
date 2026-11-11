import React, { Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { BaseDialog } from '../BaseDialog'
import { EmptyState } from '../EmptyState'
import { ErrorBoundary } from '../ErrorBoundary'
import { ZoneErrorFallback } from '../ErrorFallback'
import { LazyMiralandMap } from './LazyMiralandMap'
import type { MiralandMapView } from './MiralandMap'

interface LocationMapDialogProps {
  open: boolean
  onClose: () => void
  view: MiralandMapView | null
}

/** 可单独打开的弹窗视图：与内嵌卡共用同一个 MiralandMap 与同一份 view 数据 */
export const LocationMapDialog: React.FC<LocationMapDialogProps> = ({ open, onClose, view }) => {
  const { t } = useTranslation()
  return (
    <BaseDialog
      open={open}
      onClose={onClose}
      size="xl"
      title={t('locationMap.title')}
      cardClassName="max-h-[90vh]"
    >
      <div style={{ height: 'min(70vh, 640px)' }}>
        {view ? (
          <ErrorBoundary fallback={ZoneErrorFallback}>
            <Suspense fallback={<EmptyState status="loading" title={t('locationMap.loading')} />}>
              <LazyMiralandMap view={view} scrollWheelZoom />
            </Suspense>
          </ErrorBoundary>
        ) : (
          <EmptyState title={t('locationMap.lackWorldMap')} />
        )}
      </div>
    </BaseDialog>
  )
}
