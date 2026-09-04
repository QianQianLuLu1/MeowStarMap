import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { MediaFile } from '../../stores/mediaStore'
import { useGameParams } from '../../hooks/useGameParams'
import type { PhotographyInfo, GameParamsData } from '../../types/decryption'
import { getWeatherName, getPuzzleName, getInteractiveName } from '../../utils/enum-mappings'
import { getLocationName } from '../../utils/location-map'
import { IconInfo } from '../../icons'
import { InfoRowPanel, type InfoRow } from './InfoRowPanel'

type TFunc = (key: string, options?: Record<string, unknown>) => string

interface PhotographyPanelProps {
  file: MediaFile
  variant?: 'light' | 'dark'
  showTitle?: boolean
  gameParams?: GameParamsData | null
  loading?: boolean
  error?: string | null
}

function photographyToRows(p: PhotographyInfo | undefined | null, t: TFunc): InfoRow[] {
  if (!p) return []
  const rows: InfoRow[] = []

  // 是否编辑
  if (p.edit.enabled) {
    const details: string[] = []
    if (p.edit.hasSticker) details.push(t('detail.photography.edit.sticker'))
    if (p.edit.hasText) details.push(t('detail.photography.edit.text'))
    rows.push({
      label: t('detail.photography.edit.label'),
      value:
        details.length > 0
          ? t('detail.photography.edit.editedWithDetails', { details: details.join('、') })
          : t('detail.photography.edit.edited')
    })
  } else {
    rows.push({
      label: t('detail.photography.edit.label'),
      value: t('detail.photography.edit.notEdited')
    })
  }

  // 拍摄日期
  if (p.date)
    rows.push({
      label: t('detail.photography.date.label'),
      value: t('detail.photography.date.dayValue', { day: p.date.day })
    })

  // 拍摄时间
  if (p.time) {
    const h = String(p.time.hour).padStart(2, '0')
    const m = String(p.time.minute).padStart(2, '0')
    const s = String(Math.floor(p.time.second)).padStart(2, '0')
    rows.push({ label: t('detail.photography.time.label'), value: `${h}:${m}:${s}` })
  }

  // 拍摄地点（优先使用 name，其次查 location-map，最后回退到原始坐标）
  if (p.location) {
    if (p.location.name) {
      rows.push({ label: t('detail.photography.location.label'), value: p.location.name })
    } else {
      const { x, y, z } = p.location.pos
      const mappedName = getLocationName(x, y, z)
      rows.push({
        label: t('detail.photography.location.label'),
        value: mappedName ?? `(${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`
      })
    }
  }

  // 天气
  if (p.weather !== null && p.weather !== undefined) {
    const weatherName = getWeatherName(p.weather)
    rows.push({
      label: t('detail.photography.weather.label'),
      value: weatherName
        ? t(weatherName)
        : t('detail.photography.weather.typeValue', { type: p.weather })
    })
  }

  // 照片墙
  if (p.photoWall.length > 0) {
    rows.push({
      label: t('detail.photography.photoWall.label'),
      value: t('detail.photography.photoWall.joinedValue', { count: p.photoWall.length })
    })
  } else {
    rows.push({
      label: t('detail.photography.photoWall.label'),
      value: t('detail.photography.photoWall.notJoined')
    })
  }

  // 拍摄任务
  if (p.tasks.length > 0) {
    const taskNames = p.tasks.map((task) => {
      switch (task.type) {
        case 'puzzle': {
          const puzzleName = getPuzzleName(task.tag)
          return puzzleName
            ? t(puzzleName)
            : t('detail.photography.task.puzzleFallback', { tag: task.tag })
        }
        case 'risk':
          return t('detail.photography.task.risk')
        case 'interactive': {
          const interactiveName = getInteractiveName(task.tag)
          return interactiveName
            ? t(interactiveName)
            : t('detail.photography.task.interactiveFallback', { tag: task.tag })
        }
        default:
          return task.type
      }
    })
    rows.push({ label: t('detail.photography.task.label'), value: taskNames.join('、') })
  } else {
    rows.push({
      label: t('detail.photography.task.label'),
      value: t('detail.photography.task.none')
    })
  }

  return rows
}

/** 格式化拍摄信息为可复制文本（供 PhotographyPanel 和 handleCopyAll 共用） */
export function formatPhotographyForCopy(
  p: PhotographyInfo | null | undefined,
  t: TFunc = (k) => k
): string {
  const rows = photographyToRows(p, t)
  if (rows.length === 0) return ''
  const lines = [t('detail.photography.copyHeader')]
  for (const r of rows) {
    lines.push(`${r.label}: ${r.value}`)
  }
  return lines.join('\n')
}

export const PhotographyPanel: React.FC<PhotographyPanelProps> = ({
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

  const rows = useMemo(() => photographyToRows(data?.photography, t), [data?.photography, t])

  // 文件不包含该参数时走空态（与真实错误区分）
  const isNotContained = data?.notContained === true

  // 解密成功但无参数时，透传错误原因；notContained 时不展示误导性错误
  const effectiveError = isNotContained
    ? null
    : (error ?? (data && !data.hasParams && data.error ? data.error : null))

  if (!enabled) return null

  return (
    <InfoRowPanel
      icon={<IconInfo size={14} className="flex-shrink-0" />}
      title={t('detail.photography.title')}
      rows={rows}
      loading={loading}
      error={effectiveError}
      variant={variant}
      showTitle={showTitle}
      loadingText={t('detail.photography.loadingText')}
      emptyText={
        isNotContained ? t('infoPanel.paramNotContained') : t('detail.photography.emptyText')
      }
    />
  )
}
