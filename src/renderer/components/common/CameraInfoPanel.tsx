import React, { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { MediaFile } from '../../stores/mediaStore'
import { useGameParams } from '../../hooks/useGameParams'
import type { RichCameraParams, GameParamsData } from '../../types/decryption'
import {
  getPoseName,
  getApertureName,
  getLightName,
  getFilterName
} from '../../utils/enum-mappings'
import { IconCamera, IconInfo } from '../../icons'
import { InfoRowPanel, type ParamGroup } from './InfoRowPanel'

type TFunc = (key: string) => string

interface CameraInfoPanelProps {
  file: MediaFile
  variant?: 'light' | 'dark'
  showTitle?: boolean
  gameParams?: GameParamsData | null
  loading?: boolean
  error?: string | null
}

type CameraData = NonNullable<ReturnType<typeof useGameParams>['data']>['camera']

function cameraToGroups(camera: CameraData, t: TFunc): ParamGroup[] {
  if (!camera) return []

  const c = camera as RichCameraParams
  const groups: ParamGroup[] = []

  // 镜头与构图
  const lensRows = []
  lensRows.push({
    label: t('camera.portraitMode'),
    value: c.portraitMode ? t('camera.yes') : t('camera.no')
  })
  if (c.zoom !== undefined)
    lensRows.push({ label: t('camera.zoom'), value: `${c.zoom.toFixed(2)}x` })
  if (c.focalLength !== undefined)
    lensRows.push({ label: t('camera.focalLength'), value: `${c.focalLength.toFixed(1)}mm` })
  if (c.rotation !== undefined)
    lensRows.push({ label: t('camera.lensRotation'), value: `${c.rotation.toFixed(1)}°` })
  if (c.cameraYaw !== undefined && c.cameraYaw !== 0)
    lensRows.push({ label: t('camera.cameraYaw'), value: `${c.cameraYaw.toFixed(1)}°` })
  if (c.cameraPitch !== undefined && c.cameraPitch !== 0)
    lensRows.push({ label: t('camera.cameraPitch'), value: `${c.cameraPitch.toFixed(1)}°` })
  if (c.cameraLoc)
    lensRows.push({
      label: t('camera.cameraLoc'),
      value: `(${c.cameraLoc.x.toFixed(1)}, ${c.cameraLoc.y.toFixed(1)}, ${c.cameraLoc.z.toFixed(1)})`
    })
  if (lensRows.length > 0) groups.push({ title: t('camera.comparison'), rows: lensRows })

  // 光学与光效
  const opticRows = []
  if (c.apertureSection !== undefined)
    opticRows.push({
      label: t('camera.aperture'),
      value: t(getApertureName(c.apertureSection) ?? `F${c.apertureSection}`)
    })
  if (c.bloomIntensity !== undefined)
    opticRows.push({
      label: t('camera.bloomIntensity'),
      value: `${(c.bloomIntensity * 100).toFixed(0)}%`
    })
  if (c.vignetteIntensity !== undefined)
    opticRows.push({
      label: t('camera.softIntensity'),
      value: `${(c.vignetteIntensity * 100).toFixed(0)}%`
    })
  if (c.bloomThreshold !== undefined)
    opticRows.push({
      label: t('camera.bloomThreshold'),
      value: `${(c.bloomThreshold * 100).toFixed(0)}%`
    })
  if (opticRows.length > 0) groups.push({ title: t('camera.optic'), rows: opticRows })

  // 画面调节
  const adjustRows = []
  if (c.brightness !== undefined)
    adjustRows.push({ label: t('camera.brightness'), value: `${(c.brightness * 100).toFixed(0)}%` })
  if (c.exposure !== undefined)
    adjustRows.push({ label: t('camera.exposure'), value: `${(c.exposure * 100).toFixed(0)}%` })
  if (c.contrast !== undefined)
    adjustRows.push({ label: t('camera.contrast'), value: `${(c.contrast * 100).toFixed(0)}%` })
  if (c.saturation !== undefined)
    adjustRows.push({ label: t('camera.saturation'), value: `${(c.saturation * 100).toFixed(0)}%` })
  if (c.vibrance !== undefined)
    adjustRows.push({ label: t('camera.vibrance'), value: `${(c.vibrance * 100).toFixed(0)}%` })
  if (c.highlights !== undefined)
    adjustRows.push({ label: t('camera.highlights'), value: `${(c.highlights * 100).toFixed(0)}%` })
  if (c.shadows !== undefined)
    adjustRows.push({ label: t('camera.shadows'), value: `${(c.shadows * 100).toFixed(0)}%` })
  if (adjustRows.length > 0) groups.push({ title: t('camera.sectionAdjust'), rows: adjustRows })

  // 场景与特效
  const sceneRows = []
  if (c.light)
    sceneRows.push({
      label: t('camera.light'),
      value: `${t(getLightName(c.light.id))} (${(c.light.strength * 100).toFixed(0)}%)`
    })
  if (c.filter)
    sceneRows.push({
      label: t('camera.filter'),
      value: `${t(getFilterName(c.filter.id))} (${(c.filter.strength * 100).toFixed(0)}%)`
    })
  if (c.pose !== undefined && c.pose !== 0)
    sceneRows.push({ label: t('camera.pose'), value: t(getPoseName(c.pose) ?? `#${c.pose}`) })
  if (c.framedMoment !== undefined && c.framedMoment !== 0)
    sceneRows.push({ label: t('camera.framedMoment'), value: `#${c.framedMoment}` })
  if (c.momoHidden !== undefined && c.momoHidden !== null) {
    sceneRows.push({
      label: t('camera.momoHidden'),
      value: c.momoHidden === 'enabled' ? t('camera.hidden') : t('camera.notHidden')
    })
  }
  if (sceneRows.length > 0) groups.push({ title: t('camera.scene'), rows: sceneRows })

  return groups
}

/** 格式化相机参数为可复制文本（供 CameraInfoPanel 和 handleCopyAll 共用） */
export function formatCameraForCopy(camera: CameraData, t: TFunc = (k) => k): string {
  const groups = cameraToGroups(camera, t)
  const lines: string[] = [t('camera.copyHeader')]
  for (const g of groups) {
    lines.push(`\n[${g.title}]`)
    for (const r of g.rows) {
      lines.push(`${r.label}: ${r.value}`)
    }
  }
  const raw = (camera as RichCameraParams)?.rawParams
  if (raw) {
    lines.push(`\n${t('camera.rawParams')}`)
    lines.push(raw)
  }
  return lines.join('\n')
}

export const CameraInfoPanel: React.FC<CameraInfoPanelProps> = ({
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
  const [copied, setCopied] = useState(false)

  // 优先使用外部注入的数据（PropertiesDialog 传入时复用，避免重复调用）
  const data = injectedParams ?? internalData
  const loading = injectedLoading ?? internalLoading
  const error = injectedError ?? internalError

  const groups = useMemo(() => cameraToGroups(data?.camera, t), [data?.camera, t])

  // 解密成功但无参数时，透传错误原因
  const effectiveError = error ?? (data && !data.hasParams && data.error ? data.error : null)

  const handleCopy = async () => {
    if (!data?.camera) return
    const text = formatCameraForCopy(data.camera, t)
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      try {
        document.execCommand('copy')
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      } catch {
        /* ignore */
      } finally {
        document.body.removeChild(textarea)
      }
    }
  }

  if (!enabled) return null

  return (
    <InfoRowPanel
      icon={<IconCamera size={14} className="flex-shrink-0" />}
      title={t('camera.cameraInfo')}
      groups={groups}
      loading={loading}
      error={effectiveError}
      variant={variant}
      showTitle={showTitle}
      loadingText={t('camera.loading')}
      emptyText={
        <>
          <IconInfo size={12} className="flex-shrink-0" />
          {t('camera.empty')}
        </>
      }
      errorPrefix={t('camera.errorPrefix')}
      onCopy={handleCopy}
      copied={copied}
      copyLabel={t('camera.copyCode')}
    />
  )
}
