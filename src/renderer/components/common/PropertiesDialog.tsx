import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { MediaFile } from '../../stores/mediaStore'
import { ExifPanel } from './ExifPanel'
import { CameraInfoPanel, formatCameraForCopy } from './CameraInfoPanel'
import { PhotographyPanel, formatPhotographyForCopy } from './PhotographyPanel'
import { NikkiInfoPanel, formatNikkiForCopy } from './NikkiInfoPanel'
import { OutfitPanel, formatOutfitForCopy } from './OutfitPanel'
import { InteractionPanel, formatInteractionsForCopy } from './InteractionPanel'
import { IconFolderOpen, IconCopyText } from '../../icons'
import { formatSize } from '../../utils/format'
import { formatDateTime } from '../../utils/date'
import { BaseDialog } from './BaseDialog'
import { useGameParams } from '../../hooks/useGameParams'

interface PropertiesDialogProps {
  open: boolean
  file: MediaFile | null
  onClose: () => void
}

interface InfoRow {
  label: string
  value: string
}

function getBasicInfoRows(file: MediaFile, t: TFunction): InfoRow[] {
  return [
    { label: t('common.propertiesDialog.basic.name'), value: file.file_name },
    { label: t('common.propertiesDialog.basic.path'), value: file.file_path },
    {
      label: t('common.propertiesDialog.basic.type'),
      value:
        file.file_type === 'image'
          ? t('common.propertiesDialog.basic.typeImage')
          : t('common.propertiesDialog.basic.typeVideo')
    },
    { label: t('common.propertiesDialog.basic.size'), value: formatSize(file.file_size) },
    {
      label: t('common.propertiesDialog.basic.resolution'),
      value: file.width && file.height ? `${file.width} × ${file.height}` : '-'
    },
    { label: t('common.propertiesDialog.basic.createdAt'), value: formatDateTime(file.created_at) },
    {
      label: t('common.propertiesDialog.basic.modifiedAt'),
      value: formatDateTime(file.modified_at)
    }
  ]
}

export const PropertiesDialog: React.FC<PropertiesDialogProps> = ({ open, file, onClose }) => {
  // P1-U13：焦点陷阱由 BaseDialog 统一处理
  const { t } = useTranslation()
  const closeBtnRef = useRef<HTMLButtonElement>(null)
  const [copiedAll, setCopiedAll] = useState(false)
  // E 阶段审计修复：持有复制状态重置定时器，组件卸载或重新触发时清理
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const triggerCopiedAll = () => {
    setCopiedAll(true)
    if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current)
    copyResetTimerRef.current = setTimeout(() => setCopiedAll(false), 1500)
  }

  // 重置复制状态并清理定时器
  useEffect(() => {
    if (!open) {
      setCopiedAll(false)
      if (copyResetTimerRef.current) {
        clearTimeout(copyResetTimerRef.current)
        copyResetTimerRef.current = null
      }
    }
  }, [open])

  // 组件卸载时清理定时器
  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current)
    }
  }, [])

  const basicRows = file ? getBasicInfoRows(file, t) : []

  // 提升 useGameParams 到 Dialog 层级，避免 5 个面板各自调用导致 5 次冗余 IPC
  const gameParamsEnabled = !!file && file.file_type === 'image' && !!file.album_type
  const {
    data: gameParamsData,
    loading: gameParamsLoading,
    error: gameParamsError
  } = useGameParams(file?.file_path, file?.album_type, file?.account_uid, gameParamsEnabled)

  const handleOpenLocation = async () => {
    if (!file) return
    try {
      await window.electronAPI?.shell?.showItemInFolder(file.file_path)
    } catch {
      // 静默处理
    }
  }

  // 复制完整信息（基础信息 + EXIF）
  const handleCopyAll = async () => {
    if (!file) return
    const lines: string[] = []
    lines.push(t('common.propertiesDialog.copySection.fileInfo'))
    for (const row of basicRows) {
      lines.push(`${row.label}: ${row.value}`)
    }
    // 异步获取 EXIF 并拼接到剪贴板
    try {
      const exif = await window.electronAPI?.file?.getExif(file.file_path)
      if (exif) {
        const exifLines: string[] = []
        if (exif.camera)
          exifLines.push(`${t('common.propertiesDialog.copySection.cameraModel')}: ${exif.camera}`)
        if (exif.lens)
          exifLines.push(`${t('common.propertiesDialog.copySection.lens')}: ${exif.lens}`)
        if (exif.aperture)
          exifLines.push(`${t('common.propertiesDialog.copySection.aperture')}: ${exif.aperture}`)
        if (exif.shutter)
          exifLines.push(`${t('common.propertiesDialog.copySection.shutter')}: ${exif.shutter}`)
        if (exif.iso) exifLines.push(`ISO: ${exif.iso}`)
        if (exif.focalLength)
          exifLines.push(
            `${t('common.propertiesDialog.copySection.focalLength')}: ${exif.focalLength}`
          )
        if (exif.dateTaken) {
          const d = new Date(exif.dateTaken)
          if (!isNaN(d.getTime())) {
            exifLines.push(
              `${t('common.propertiesDialog.copySection.dateTaken')}: ${d.toLocaleString('zh-CN', { hour12: false })}`
            )
          }
        }
        if (exif.gps)
          exifLines.push(`GPS: ${exif.gps.latitude.toFixed(6)}, ${exif.gps.longitude.toFixed(6)}`)
        if (exif.width && exif.height)
          exifLines.push(
            `${t('common.propertiesDialog.copySection.originalSize')}: ${exif.width} × ${exif.height}`
          )
        if (exifLines.length > 0) {
          lines.push('')
          lines.push(t('common.propertiesDialog.copySection.shootingParams'))
          lines.push(...exifLines)
        }
      }
    } catch {
      // EXIF 获取失败，仅复制基础信息
    }
    // 游戏参数（复用各面板的共享格式化函数，确保输出一致）
    if (file.file_type === 'image' && file.album_type) {
      try {
        const result = await window.electronAPI?.decrypt?.decodeFile(
          file.file_path,
          file.album_type,
          file.account_uid
        )
        if (result?.ok && result.data?.hasParams) {
          const d = result.data
          const sections: string[] = []
          const photoText = formatPhotographyForCopy(d.photography as any, t)
          if (photoText) sections.push(photoText)
          const cameraText = formatCameraForCopy(d.camera as any, t)
          if (cameraText) sections.push(cameraText)
          const nikkiText = formatNikkiForCopy(d.nikki as any)
          if (nikkiText) sections.push(nikkiText)
          const outfitText = formatOutfitForCopy(d.dressing as any, t)
          if (outfitText) sections.push(outfitText)
          const interactionsText = formatInteractionsForCopy(d.interactions as any)
          if (interactionsText) sections.push(interactionsText)
          if (sections.length > 0) {
            lines.push('', sections.join('\n'))
          }
        }
      } catch {
        // 游戏参数获取失败，跳过
      }
    }
    const text = lines.join('\n')
    try {
      await navigator.clipboard.writeText(text)
      triggerCopiedAll()
    } catch {
      // 兜底
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      try {
        document.execCommand('copy')
        triggerCopiedAll()
      } catch {
        // 静默失败
      } finally {
        document.body.removeChild(textarea)
      }
    }
  }

  return (
    <BaseDialog
      open={open && !!file}
      onClose={onClose}
      size="lg"
      ariaLabelledby="props-title"
      initialFocusRef={closeBtnRef}
      cardClassName="max-h-[85vh] overflow-y-auto"
    >
      {/* 标题 + 操作按钮 */}
      <div className="flex items-center justify-between">
        <h3
          id="props-title"
          className="text-lg font-semibold"
          style={{ color: 'var(--text-primary)' }}
        >
          {t('common.propertiesDialog.title')}
        </h3>
        <div className="flex items-center gap-2">
          <button
            className="btn-secondary text-xs flex items-center gap-1"
            onClick={handleOpenLocation}
            title={t('common.propertiesDialog.openLocationTitle')}
          >
            <IconFolderOpen size={14} />
            <span>{t('common.propertiesDialog.openLocation')}</span>
          </button>
          <button
            className="btn-secondary text-xs flex items-center gap-1"
            onClick={handleCopyAll}
            title={t('common.propertiesDialog.copyAllTitle')}
          >
            <IconCopyText size={14} />
            <span>
              {copiedAll
                ? t('common.propertiesDialog.copied')
                : t('common.propertiesDialog.copyAll')}
            </span>
          </button>
        </div>
      </div>

      {/* 基础信息 */}
      <div className="space-y-1">
        {basicRows.map((row) => (
          <div
            key={row.label}
            className="flex items-baseline gap-3 text-sm py-1 border-b last:border-b-0"
            style={{ borderColor: 'var(--divider)' }}
          >
            <span className="flex-shrink-0 w-20 text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {row.label}
            </span>
            <span
              className="flex-1 break-all font-mono text-xs"
              style={{ color: 'var(--text-primary)' }}
              title={row.value}
            >
              {row.value}
            </span>
          </div>
        ))}
      </div>

      {/* EXIF 拍摄参数 */}
      <div className="pt-2 border-t" style={{ borderColor: 'var(--divider)' }}>
        <ExifPanel file={file!} variant="light" showTitle={true} />
      </div>

      {/* 拍摄信息 */}
      <div className="pt-2 border-t" style={{ borderColor: 'var(--divider)' }}>
        <PhotographyPanel
          file={file!}
          variant="light"
          showTitle={true}
          gameParams={gameParamsData}
          loading={gameParamsLoading}
          error={gameParamsError}
        />
      </div>

      {/* 相机信息 */}
      <div className="pt-2 border-t" style={{ borderColor: 'var(--divider)' }}>
        <CameraInfoPanel
          file={file!}
          variant="light"
          showTitle={true}
          gameParams={gameParamsData}
          loading={gameParamsLoading}
          error={gameParamsError}
        />
      </div>

      {/* 暖暖信息 */}
      <div className="pt-2 border-t" style={{ borderColor: 'var(--divider)' }}>
        <NikkiInfoPanel
          file={file!}
          variant="light"
          showTitle={true}
          gameParams={gameParamsData}
          loading={gameParamsLoading}
          error={gameParamsError}
        />
      </div>

      {/* 搭配 */}
      <div className="pt-2 border-t" style={{ borderColor: 'var(--divider)' }}>
        <OutfitPanel
          file={file!}
          variant="light"
          showTitle={true}
          gameParams={gameParamsData}
          loading={gameParamsLoading}
          error={gameParamsError}
        />
      </div>

      {/* 交互物 */}
      <div className="pt-2 border-t" style={{ borderColor: 'var(--divider)' }}>
        <InteractionPanel
          file={file!}
          variant="light"
          showTitle={true}
          gameParams={gameParamsData}
          loading={gameParamsLoading}
          error={gameParamsError}
        />
      </div>

      {/* 底部关闭按钮 */}
      <div className="flex justify-end pt-2">
        <button ref={closeBtnRef} className="btn-primary" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </BaseDialog>
  )
}
