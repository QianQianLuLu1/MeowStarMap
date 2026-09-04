import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Virtuoso } from 'react-virtuoso'
import { EmptyState } from '../common/EmptyState'
import { BaseDialog } from '../common/BaseDialog'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { IconButton } from '../common/IconButton'
import { IconDelete, IconEdit, IconMessage } from '../../icons'
import { useGlobalToast } from '../../pages/settings/shared'
import {
  deleteResonanceRecord,
  updateManualRecord,
  useResonanceStore
} from '../../stores/resonanceStore'
import {
  BANNER_DATA,
  getBannerById,
  getBannerThumbnailUrl,
  getStaticProcessDeps,
  loadNames,
  type NamePack
} from '../../utils/resonance/staticData'
import { getOutfitIdFromItemId, processBannerPullData } from '../../utils/resonance/process'
import { normalizeImportTimestamp } from '../../utils/resonance/importParse'
import {
  resonanceDeleteRecordArgs,
  resonanceUpdateManualRecordArgs
} from '../../../shared/types/resonance'
import { AddRecordDialog } from './AddRecordDialog'

/**
 * 共鸣记录子页：卡池筛选（含本地缩略图）+ 垫抽提示 + 记录长列表（Virtuoso）
 * + 手动补录 / 修改补录时间 / 删除。全部数据来自本地 SQLite，零联网。
 */

interface RecordRow {
  key: string
  kind: 'pull' | 'edit'
  id: number
  itemId: string
  obtainedAt: string
  quality: number
  /** 该抽跨度（仅真实抽取；补录为 null） */
  pullsToObtain: number | null
}

function qualityColor(quality: number): string {
  if (quality === 5) return 'var(--warning)'
  if (quality === 4) return 'var(--accent)'
  return 'var(--text-tertiary)'
}

export const RecordsView: React.FC = () => {
  const { t, i18n } = useTranslation()
  const showMessage = useGlobalToast()
  const pulls = useResonanceStore((s) => s.pulls)
  const edits = useResonanceStore((s) => s.edits)

  const [names, setNames] = useState<NamePack | null>(null)
  const [selectedBannerId, setSelectedBannerId] = useState<number>(() => {
    // 默认定位到有记录的最新卡池，否则为最新卡池
    const withData = [...pulls, ...edits].map((r) => Number(r.banner_id))
    if (withData.length > 0) return Math.max(...withData)
    return Math.max(...Object.keys(BANNER_DATA).map(Number))
  })
  const [addOpen, setAddOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<RecordRow | null>(null)
  const [editTimeValue, setEditTimeValue] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<RecordRow | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadNames(i18n.language).then((pack) => {
      if (!cancelled) setNames(pack)
    })
    return () => {
      cancelled = true
    }
  }, [i18n.language])

  const banner = getBannerById(selectedBannerId)

  /** 卡池数据（processBannerPullData 期望 newest-first 数组，与 DB 排序一致） */
  const processed = useMemo(() => {
    const bannerPulls = pulls
      .filter((r) => Number(r.banner_id) === selectedBannerId)
      .map((r) => [r.obtained_at, r.item_id] as [string, string])
    const bannerEdits = edits
      .filter((r) => Number(r.banner_id) === selectedBannerId)
      .map((r) => [r.obtained_at, r.item_id] as [string, string])
    return processBannerPullData(
      { [selectedBannerId]: bannerPulls },
      { [selectedBannerId]: bannerEdits },
      getStaticProcessDeps()
    )
  }, [pulls, edits, selectedBannerId])

  const bannerStats = processed[String(selectedBannerId)]?.stats

  /** 该抽跨度索引（同秒同物品取首条，重复记录回退 null） */
  const pullsToObtainIndex = useMemo(() => {
    const map = new Map<string, number>()
    for (const pull of processed[String(selectedBannerId)]?.pulls ?? []) {
      if (pull.pullIndex > 0 && !map.has(`${pull.obtainedAt}|${pull.itemId}`)) {
        map.set(`${pull.obtainedAt}|${pull.itemId}`, pull.pullsToObtain)
      }
    }
    return map
  }, [processed, selectedBannerId])

  const rows = useMemo<RecordRow[]>(() => {
    const qualityByItem = new Map<string, number>()
    for (const pull of processed[String(selectedBannerId)]?.pulls ?? []) {
      if (!qualityByItem.has(pull.itemId)) qualityByItem.set(pull.itemId, pull.quality)
    }
    const bannerPulls = pulls
      .filter((r) => Number(r.banner_id) === selectedBannerId)
      .map<RecordRow>((r) => ({
        key: `pull-${r.id}`,
        kind: 'pull',
        id: r.id,
        itemId: r.item_id,
        obtainedAt: r.obtained_at,
        quality: qualityByItem.get(r.item_id) ?? 0,
        pullsToObtain: pullsToObtainIndex.get(`${r.obtained_at}|${r.item_id}`) ?? null
      }))
    const bannerEdits = edits
      .filter((r) => Number(r.banner_id) === selectedBannerId)
      .map<RecordRow>((r) => {
        const outfitId = getOutfitIdFromItemId(r.item_id)
        const isFive = banner?.outfit5StarId.includes(outfitId) ?? false
        const isFour = banner?.outfit4StarId.includes(outfitId) ?? false
        return {
          key: `edit-${r.id}`,
          kind: 'edit',
          id: r.id,
          itemId: r.item_id,
          obtainedAt: r.obtained_at,
          quality: isFive ? 5 : isFour ? 4 : 0,
          pullsToObtain: null
        }
      })
    return [...bannerPulls, ...bannerEdits].sort((a, b) => {
      if (a.obtainedAt !== b.obtainedAt) return a.obtainedAt < b.obtainedAt ? 1 : -1
      return a.id - b.id
    })
  }, [pulls, edits, processed, selectedBannerId, banner, pullsToObtainIndex])

  const itemName = (id: string): string => names?.item[id] ?? id
  const bannerName = (id: number): string => names?.banner[String(id)] ?? `#${id}`

  const handleEditTime = async (): Promise<void> => {
    if (!editTarget) return
    const obtainedAt = normalizeImportTimestamp(editTimeValue.replace('T', ' '))
    if (!obtainedAt) {
      showMessage(t('resonance.records.invalidTime'), 'error')
      return
    }
    const parsed = resonanceUpdateManualRecordArgs.safeParse([editTarget.id, obtainedAt])
    if (!parsed.success) {
      showMessage(t('resonance.records.invalidInput'), 'error')
      return
    }
    try {
      await updateManualRecord(editTarget.id, obtainedAt)
      showMessage(t('resonance.toast.updated'), 'success')
      setEditTarget(null)
    } catch (error) {
      showMessage(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!deleteTarget) return
    const parsed = resonanceDeleteRecordArgs.safeParse({
      kind: deleteTarget.kind,
      id: deleteTarget.id
    })
    if (!parsed.success) {
      showMessage(t('resonance.records.invalidInput'), 'error')
      return
    }
    try {
      await deleteResonanceRecord(deleteTarget.kind, deleteTarget.id)
      showMessage(t('resonance.toast.deleted'), 'success')
      setDeleteTarget(null)
    } catch (error) {
      showMessage(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  const latestVersion = banner?.runs[banner.runs.length - 1]?.version

  return (
    <div className="h-full flex flex-col gap-3 min-h-0">
      {/* 工具条：卡池选择 + 信息 + 补录 */}
      <div className="flex items-center gap-3 flex-shrink-0 flex-wrap">
        <select
          aria-label={t('resonance.records.bannerLabel')}
          className="px-2 py-1.5 text-sm rounded-lg max-w-56"
          style={{
            background: 'var(--bg-tertiary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--divider)'
          }}
          value={selectedBannerId}
          onChange={(e) => setSelectedBannerId(Number(e.target.value))}
        >
          {Object.keys(BANNER_DATA)
            .map(Number)
            .sort((a, b) => b - a)
            .map((id) => (
              <option key={id} value={id}>
                {bannerName(id)}
              </option>
            ))}
        </select>

        {banner && (
          <div className="flex items-center gap-2 min-w-0">
            {getBannerThumbnailUrl(selectedBannerId) ? (
              <img
                src={getBannerThumbnailUrl(selectedBannerId) ?? undefined}
                alt=""
                className="w-10 h-10 rounded-md object-cover flex-shrink-0"
                style={{ border: '1px solid var(--divider)' }}
              />
            ) : (
              <div
                className="w-10 h-10 rounded-md flex-shrink-0"
                style={{ background: 'var(--bg-tertiary)' }}
              />
            )}
            <div className="min-w-0">
              <p className="text-sm truncate" style={{ color: 'var(--text-primary)' }}>
                {bannerName(selectedBannerId)}
              </p>
              <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {t(`resonance.records.bannerType${banner.bannerType}`)}
                {latestVersion ? ` · v${latestVersion}` : ''}
              </p>
            </div>
          </div>
        )}

        <div className="flex-1" />

        {bannerStats && bannerStats.totalPulls > 0 && (
          <div className="flex items-center gap-2 text-xs flex-wrap">
            <span
              className="px-2 py-1 rounded-md"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
            >
              {t('resonance.records.totalPulls', { count: bannerStats.totalPulls })}
            </span>
            <span
              className="px-2 py-1 rounded-md"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
            >
              {t('resonance.records.pity5Star', { count: bannerStats.pity5Star })}
            </span>
            {banner?.bannerType !== 3 && (
              <span
                className="px-2 py-1 rounded-md"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
              >
                {t('resonance.records.pity4Star', { count: bannerStats.pity4Star })}
              </span>
            )}
          </div>
        )}

        <button className="btn-primary flex-shrink-0" onClick={() => setAddOpen(true)}>
          {t('resonance.records.addRecord')}
        </button>
      </div>

      {/* 记录列表 */}
      {rows.length === 0 ? (
        <EmptyState
          icon={<IconMessage size={48} />}
          title={t('resonance.records.listEmpty')}
          subtitle={t('resonance.records.listEmptyHint')}
        />
      ) : (
        <div className="flex-1 min-h-0">
          <Virtuoso
            data={rows}
            className="h-full"
            itemContent={(_, row) => (
              <div
                className="flex items-center gap-3 px-3 py-2 rounded-lg"
                style={{ color: 'var(--text-primary)' }}
              >
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ background: qualityColor(row.quality) }}
                  aria-hidden
                />
                <span className="text-sm flex-1 min-w-0 truncate">{itemName(row.itemId)}</span>
                {row.pullsToObtain !== null ? (
                  <span className="text-xs flex-shrink-0" style={{ color: 'var(--text-tertiary)' }}>
                    {t('resonance.records.pullNo', { n: row.pullsToObtain })}
                  </span>
                ) : (
                  <span
                    className="text-xs px-1.5 py-0.5 rounded flex-shrink-0"
                    style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                  >
                    {t('resonance.records.editBadge')}
                  </span>
                )}
                <span
                  className="text-xs flex-shrink-0 tabular-nums"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  {row.obtainedAt}
                </span>
                {row.kind === 'edit' && (
                  <IconButton
                    aria-label={t('resonance.records.editTimeTitle')}
                    title={t('resonance.records.editTimeTitle')}
                    onClick={() => {
                      setEditTarget(row)
                      setEditTimeValue(row.obtainedAt.replace(' ', 'T'))
                    }}
                  >
                    <IconEdit size={16} />
                  </IconButton>
                )}
                <IconButton
                  aria-label={t('common.delete')}
                  title={t('common.delete')}
                  onClick={() => setDeleteTarget(row)}
                >
                  <IconDelete size={16} />
                </IconButton>
              </div>
            )}
          />
        </div>
      )}

      <AddRecordDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        defaultBannerId={selectedBannerId}
        names={names}
      />

      {/* 修改补录时间 */}
      <BaseDialog
        open={editTarget !== null}
        onClose={() => setEditTarget(null)}
        size="sm"
        title={t('resonance.records.editTimeTitle')}
      >
        <div className="space-y-4 p-5">
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {editTarget ? itemName(editTarget.itemId) : ''}
          </p>
          <input
            type="datetime-local"
            step={1}
            className="w-full px-2 py-1.5 text-sm rounded-lg"
            style={{
              background: 'var(--bg-tertiary)',
              color: 'var(--text-primary)',
              border: '1px solid var(--divider)'
            }}
            value={editTimeValue}
            onChange={(e) => setEditTimeValue(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setEditTarget(null)}>
              {t('common.cancel')}
            </button>
            <button className="btn-primary" onClick={() => void handleEditTime()}>
              {t('common.save')}
            </button>
          </div>
        </div>
      </BaseDialog>

      {/* 删除确认 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('resonance.records.deleteTitle')}
        message={
          deleteTarget
            ? `${itemName(deleteTarget.itemId)} · ${deleteTarget.obtainedAt}\n${t('resonance.records.deleteMessage')}`
            : ''
        }
        confirmVariant="danger"
        onConfirm={() => void handleDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
