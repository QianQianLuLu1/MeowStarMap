import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { MediaFile } from '../../stores/mediaStore'
import { useGameParams } from '../../hooks/useGameParams'
import type { InteractionParams, ObjectParams, GameParamsData } from '../../types/decryption'
import { IconCategory } from '../../icons'
import { InfoRowPanel, type InfoRow } from './InfoRowPanel'

type TFunc = (key: string, options?: Record<string, unknown>) => string

interface InteractionPanelProps {
  file: MediaFile
  variant?: 'light' | 'dark'
  showTitle?: boolean
  gameParams?: GameParamsData | null
  loading?: boolean
  error?: string | null
}

function formatObj(o: ObjectParams, t: TFunc): string {
  const loc = `${t('detail.interaction.format.location')}(${o.loc.x.toFixed(1)}, ${o.loc.y.toFixed(1)}, ${o.loc.z.toFixed(1)})`
  const rot = `${t('detail.interaction.format.rotation')}(${o.rot.yaw.toFixed(1)}°, ${o.rot.pitch.toFixed(1)}°, ${o.rot.roll.toFixed(1)}°)`
  const scale = `${t('detail.interaction.format.scale')}(${o.scale.x.toFixed(2)}, ${o.scale.y.toFixed(2)}, ${o.scale.z.toFixed(2)})`
  return `${loc} ${rot} ${scale}`
}

function interactionsToRows(d: InteractionParams | undefined | null, t: TFunc): InfoRow[] {
  if (!d) return []
  const rows: InfoRow[] = []

  // 坐骑
  if (d.mount) {
    rows.push({
      label: t('detail.interaction.mount.label'),
      value: `#${d.mount.id} ${formatObj(d.mount, t)}`
    })
  } else {
    rows.push({ label: t('detail.interaction.mount.label'), value: t('detail.interaction.none') })
  }

  // 载具
  if (d.carrier) {
    rows.push({
      label: t('detail.interaction.carrier.label'),
      value: `#${d.carrier.id} ${formatObj(d.carrier, t)}`
    })
  } else {
    rows.push({ label: t('detail.interaction.carrier.label'), value: t('detail.interaction.none') })
  }

  // 交互物列表
  if (d.interactions.length > 0) {
    for (let i = 0; i < d.interactions.length; i++) {
      const obj = d.interactions[i]
      rows.push({
        label: t('detail.interaction.object.label', { n: i + 1 }),
        value: `#${obj.id} ${formatObj(obj, t)}`
      })
    }
  }

  return rows
}

/** 格式化交互物信息为可复制文本（供 InteractionPanel 和 handleCopyAll 共用） */
export function formatInteractionsForCopy(
  d: InteractionParams | null | undefined,
  t: TFunc = (k) => k
): string {
  const rows = interactionsToRows(d, t)
  if (rows.length === 0) return ''
  const lines = [t('detail.interaction.copyHeader')]
  for (const r of rows) {
    lines.push(`${r.label}: ${r.value}`)
  }
  return lines.join('\n')
}

export const InteractionPanel: React.FC<InteractionPanelProps> = ({
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

  const rows = useMemo(() => interactionsToRows(data?.interactions, t), [data?.interactions, t])

  // 解密成功但无参数时，透传错误原因
  const effectiveError = error ?? (data && !data.hasParams && data.error ? data.error : null)

  if (!enabled) return null

  return (
    <InfoRowPanel
      icon={<IconCategory size={14} className="flex-shrink-0" />}
      title={t('detail.interaction.title')}
      rows={rows}
      loading={loading}
      error={effectiveError}
      variant={variant}
      showTitle={showTitle}
      loadingText={t('detail.interaction.loadingText')}
      emptyText={t('detail.interaction.emptyText')}
    />
  )
}
