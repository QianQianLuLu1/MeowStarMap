import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { MediaFile } from '../../stores/mediaStore'
import { useGameParams } from '../../hooks/useGameParams'
import type { MultiPlayerInfo, GameParamsData } from '../../types/decryption'
import { getPoseName } from '../../utils/enum-mappings'
import { IconInfo } from '../../icons'
import { InfoRowPanel, type InfoRow } from './InfoRowPanel'

type TFunc = (key: string, options?: Record<string, unknown>) => string

interface MultiPlayerPanelProps {
  file: MediaFile
  variant?: 'light' | 'dark'
  showTitle?: boolean
  gameParams?: GameParamsData | null
  loading?: boolean
  error?: string | null
}

function multiPlayerToRows(mp: MultiPlayerInfo | null | undefined, t: TFunc): InfoRow[] {
  if (!mp) return []
  const rows: InfoRow[] = []

  // 另一位玩家的动作（poseId 空串语义 → null → 不渲染该行；映射未命中回退原始 ID，对齐上游）
  if (mp.poseId !== null && mp.poseId !== undefined) {
    rows.push({
      label: t('detail.multiPlayer.anotherPose'),
      value: t(getPoseName(mp.poseId) ?? `#${mp.poseId}`)
    })
  }

  // 动作进度（仅在有值时渲染；上游公式 (p * 100).ceil()%）
  if (mp.posePlayingPercent !== null && mp.posePlayingPercent !== undefined) {
    rows.push({
      label: t('detail.multiPlayer.poseTime'),
      value: `${Math.ceil(mp.posePlayingPercent * 100)} %`
    })
  }

  return rows
}

/** 格式化联机信息为可复制文本（供 MultiPlayerPanel 和 handleCopyAll 共用） */
export function formatMultiPlayerForCopy(
  mp: MultiPlayerInfo | null | undefined,
  t: TFunc = (k) => k
): string {
  const rows = multiPlayerToRows(mp, t)
  if (rows.length === 0) return ''
  const lines = [t('detail.multiPlayer.copyHeader')]
  for (const r of rows) {
    lines.push(`${r.label}: ${r.value}`)
  }
  return lines.join('\n')
}

export const MultiPlayerPanel: React.FC<MultiPlayerPanelProps> = ({
  file,
  variant = 'light',
  showTitle = true,
  gameParams: injectedParams,
  loading,
  error
}) => {
  const { t } = useTranslation()
  const isGameImage = file.file_type === 'image' && !!file.album_type
  // 注入数据时禁用内部解密 hook，避免与 PropertiesDialog 共享解密重复 decodeFile
  // （审查修复 2026-11-11）
  const { data: internalData } = useGameParams(
    file.file_path,
    file.album_type,
    file.account_uid,
    isGameImage && !injectedParams
  )

  // 优先使用外部注入的数据（PropertiesDialog 传入时复用，避免重复调用）
  const data = injectedParams ?? internalData

  const rows = useMemo(() => multiPlayerToRows(data?.multiPlayer, t), [data?.multiPlayer, t])

  // 联机信息仅在有可展示行时渲染：单人照/旧照片（无 MultiPlayerHandler）不出现空面板；
  // 共享解密在途（loading）或失败（error）时隐藏，不渲染陈旧/误导行
  if (!isGameImage || loading || error || rows.length === 0) return null

  return (
    <InfoRowPanel
      icon={<IconInfo size={14} className="flex-shrink-0" />}
      title={t('detail.multiPlayer.title')}
      rows={rows}
      variant={variant}
      showTitle={showTitle}
    />
  )
}
