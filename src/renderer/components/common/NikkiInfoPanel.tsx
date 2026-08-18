import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { MediaFile } from '../../stores/mediaStore'
import { useGameParams } from '../../hooks/useGameParams'
import type { NikkiParams, GameParamsData } from '../../types/decryption'
import { IconStar } from '../../icons'
import { InfoRowPanel, type InfoRow } from './InfoRowPanel'

type TFunc = (key: string, options?: Record<string, unknown>) => string

interface NikkiInfoPanelProps {
  file: MediaFile
  variant?: 'light' | 'dark'
  showTitle?: boolean
  gameParams?: GameParamsData | null
  loading?: boolean
  error?: string | null
}

function nikkiToRows(n: NikkiParams | undefined | null, t: TFunc): InfoRow[] {
  if (!n) return []
  const rows: InfoRow[] = []

  // 巨大化
  rows.push({
    label: t('detail.nikki.giantState.label'),
    value: n.giantState ? t('detail.nikki.giantState.on') : t('detail.nikki.giantState.off')
  })

  // 隐藏暖暖
  rows.push({
    label: t('detail.nikki.hidden.label'),
    value: n.hidden ? t('detail.nikki.hidden.on') : t('detail.nikki.hidden.off')
  })

  // 位置
  if (n.loc) {
    rows.push({
      label: t('detail.nikki.location.label'),
      value: `(${n.loc.x.toFixed(1)}, ${n.loc.y.toFixed(1)}, ${n.loc.z.toFixed(1)})`
    })
  }

  // 旋转
  if (n.rot) {
    rows.push({
      label: t('detail.nikki.rotation.label'),
      value: `Yaw ${n.rot.yaw.toFixed(1)}°, Pitch ${n.rot.pitch.toFixed(1)}°, Roll ${n.rot.roll.toFixed(1)}°`
    })
  }

  // 缩放
  if (n.scale) {
    rows.push({
      label: t('detail.nikki.scale.label'),
      value: `(${n.scale.x.toFixed(2)}, ${n.scale.y.toFixed(2)}, ${n.scale.z.toFixed(2)})`
    })
  }

  return rows
}

/** 格式化暖暖信息为可复制文本（供 NikkiInfoPanel 和 handleCopyAll 共用） */
export function formatNikkiForCopy(n: NikkiParams | null | undefined, t: TFunc = (k) => k): string {
  const rows = nikkiToRows(n, t)
  if (rows.length === 0) return ''
  const lines = [t('detail.nikki.copyHeader')]
  for (const r of rows) {
    lines.push(`${r.label}: ${r.value}`)
  }
  return lines.join('\n')
}

export const NikkiInfoPanel: React.FC<NikkiInfoPanelProps> = ({
  file,
  variant = 'light',
  showTitle = true,
  gameParams: injectedParams,
  loading: injectedLoading,
  error: injectedError
}) => {
  const { t } = useTranslation()
  const enabled = file.file_type === 'image' && !!file.album_type
  const {
    data: internalData,
    loading: internalLoading,
    error: internalError
  } = useGameParams(file.file_path, file.album_type, file.account_uid, enabled)

  // 优先使用外部注入的数据（PropertiesDialog 传入时复用，避免重复调用）
  const data = injectedParams ?? internalData
  const loading = injectedLoading ?? internalLoading
  const error = injectedError ?? internalError

  const rows = useMemo(() => nikkiToRows(data?.nikki, t), [data?.nikki, t])

  // 解密成功但无参数时，透传错误原因
  const effectiveError = error ?? (data && !data.hasParams && data.error ? data.error : null)

  if (!enabled) return null

  return (
    <InfoRowPanel
      icon={<IconStar size={14} className="flex-shrink-0" />}
      title={t('detail.nikki.title')}
      rows={rows}
      loading={loading}
      error={effectiveError}
      variant={variant}
      showTitle={showTitle}
      loadingText={t('detail.nikki.loadingText')}
      emptyText={t('detail.nikki.emptyText')}
    />
  )
}
