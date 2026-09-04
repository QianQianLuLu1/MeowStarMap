import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { MediaFile } from '../../stores/mediaStore'
import { useGameParams } from '../../hooks/useGameParams'
import type { DressingParams, GameParamsData } from '../../types/decryption'
import {
  getClothTypeName,
  getClothStateName,
  getEurekaAttachmentPointName,
  getEurekaColorName
} from '../../utils/enum-mappings'
import { getClothName, getOutfitName } from '../../utils/cloth-name-lookup'
import { IconOutfit } from '../../icons'
import { InfoRowPanel, type InfoRow } from './InfoRowPanel'

type TFunc = (key: string, options?: Record<string, unknown>) => string

interface OutfitPanelProps {
  file: MediaFile
  variant?: 'light' | 'dark'
  showTitle?: boolean
  gameParams?: GameParamsData | null
  loading?: boolean
  error?: string | null
}

function dressingToRows(d: DressingParams | undefined | null, t: TFunc): InfoRow[] {
  if (!d) return []
  const rows: InfoRow[] = []

  // state 为"无"的 i18n key（对应 CLOTH_STATE_MAP 中值为"无"的 0/1/9）
  const noneStateKeys = new Set(['enums.clothState.0', 'enums.clothState.1', 'enums.clothState.9'])

  // 服装列表（含名称和状态标记）
  if (d.clothes.length > 0) {
    for (const c of d.clothes) {
      const typeName = getClothTypeName(c.clothType)
      const clothName = getClothName(c.id) ?? c.clothTypeName
      // state 非"无"时追加状态标记（焕新/进化）
      const stateName = getClothStateName(c.state)
      const statePart = stateName && !noneStateKeys.has(stateName) ? ` [${t(stateName)}]` : ''
      // 有名称时显示"名称 #ID"，无名称时仅显示"#ID"
      const value = clothName ? `${clothName} #${c.id}${statePart}` : `#${c.id}${statePart}`
      rows.push({ label: t(typeName), value })
    }
  }

  // 祝福闪光（含套装名、颜色和挂载点）
  if (d.eureka.length > 0) {
    const eurekaStr = d.eureka
      .map((e) => {
        const pointName = getEurekaAttachmentPointName(e.attachmentPoint)
        const pointPart = pointName && e.attachmentPoint !== 0 ? `[${t(pointName)}]` : ''
        const colorName = getEurekaColorName(e.color)
        const colorPart = colorName && e.color !== 0 ? `[${t(colorName)}]` : ''
        const outfitName = getOutfitName(e.outfit)
        const namePart = outfitName ? `${outfitName} ` : ''
        return `${namePart}#${e.id}${colorPart}${pointPart} (Lv.${e.level})`
      })
      .join('、')
    rows.push({ label: t('detail.dressing.eureka.label'), value: eurekaStr })
  }

  return rows
}

/** 格式化搭配信息为可复制文本（供 OutfitPanel 和 handleCopyAll 共用） */
export function formatOutfitForCopy(
  d: DressingParams | null | undefined,
  t: TFunc = (k) => k
): string {
  const rows = dressingToRows(d, t)
  if (rows.length === 0) return ''
  const lines = [t('detail.dressing.copyHeader')]
  for (const r of rows) {
    lines.push(`${r.label}: ${r.value}`)
  }
  return lines.join('\n')
}

export const OutfitPanel: React.FC<OutfitPanelProps> = ({
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

  const rows = useMemo(() => dressingToRows(data?.dressing, t), [data?.dressing, t])

  // 文件不包含该参数时走空态（与真实错误区分）
  const isNotContained = data?.notContained === true

  // 解密成功但无参数时，透传错误原因；notContained 时不展示误导性错误
  const effectiveError = isNotContained
    ? null
    : (error ?? (data && !data.hasParams && data.error ? data.error : null))

  if (!enabled) return null

  return (
    <InfoRowPanel
      icon={<IconOutfit size={14} className="flex-shrink-0" />}
      title={t('detail.dressing.title')}
      rows={rows}
      loading={loading}
      error={effectiveError}
      variant={variant}
      showTitle={showTitle}
      loadingText={t('detail.dressing.loadingText')}
      emptyText={isNotContained ? t('infoPanel.paramNotContained') : t('detail.dressing.emptyText')}
    />
  )
}
