import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BaseDialog } from '../common/BaseDialog'
import { useGlobalToast } from '../../pages/settings/shared'
import { addManualRecord } from '../../stores/resonanceStore'
import { BANNER_DATA, OUTFIT_ITEMS } from '../../utils/resonance/staticData'
import { normalizeImportTimestamp } from '../../utils/resonance/importParse'
import type { NamePack } from '../../utils/resonance/staticData'
import { resonanceAddManualRecordArgs } from '../../../shared/types/resonance'

/**
 * 手动补录对话框：卡池 / 获得物品（按所选卡池的套装部件分组）/ 获得时间。
 * 提交前用共享 schema 二次校验；非法输入拒绝执行且零副作用。
 */

interface AddRecordDialogProps {
  open: boolean
  onClose: () => void
  /** 打开时默认选中的卡池（通常为当前浏览卡池） */
  defaultBannerId: number
  names: NamePack | null
}

function nowLocalInput(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export const AddRecordDialog: React.FC<AddRecordDialogProps> = ({
  open,
  onClose,
  defaultBannerId,
  names
}) => {
  const { t } = useTranslation()
  const showMessage = useGlobalToast()
  const [bannerId, setBannerId] = useState(defaultBannerId)
  const [itemId, setItemId] = useState('')
  const [timeValue, setTimeValue] = useState(nowLocalInput)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (open) {
      setBannerId(defaultBannerId)
      setItemId('')
      setTimeValue(nowLocalInput())
      setSubmitting(false)
    }
  }, [open, defaultBannerId])

  /** 所选卡池的套装部件，按 5★/4★ 分组（label = 名称包名称，回退 itemId） */
  const itemGroups = useMemo(() => {
    const banner = BANNER_DATA[String(bannerId)]
    const itemName = (id: string): string => names?.item[id] ?? id
    const groupOf = (
      outfitIds: string[]
    ): Array<{ id: string; label: string; outfitLabel: string }> => {
      const out: Array<{ id: string; label: string; outfitLabel: string }> = []
      for (const outfitId of outfitIds) {
        const items = OUTFIT_ITEMS[outfitId] ?? []
        for (const id of items) {
          out.push({ id, label: itemName(id), outfitLabel: names?.outfit[outfitId] ?? outfitId })
        }
      }
      return out
    }
    if (!banner) return { five: [], four: [] }
    return {
      five: groupOf(banner.outfit5StarId),
      four: groupOf(banner.outfit4StarId)
    }
  }, [bannerId, names])

  const canSubmit = bannerId > 0 && itemId !== '' && !submitting

  const handleSubmit = async (): Promise<void> => {
    const obtainedAt = normalizeImportTimestamp(timeValue.replace('T', ' '))
    if (!obtainedAt) {
      showMessage(t('resonance.records.invalidTime'), 'error')
      return
    }
    const parsed = resonanceAddManualRecordArgs.safeParse([String(bannerId), itemId, obtainedAt])
    if (!parsed.success) {
      showMessage(t('resonance.records.invalidInput'), 'error')
      return
    }
    setSubmitting(true)
    try {
      await addManualRecord(String(bannerId), itemId, obtainedAt)
      showMessage(t('resonance.toast.added', { name: names?.item[itemId] ?? itemId }), 'success')
      onClose()
    } catch (error) {
      showMessage(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const bannerName = (id: number): string => names?.banner[String(id)] ?? `#${id}`

  return (
    <BaseDialog open={open} onClose={onClose} size="sm" title={t('resonance.records.addTitle')}>
      <div className="space-y-4 p-5">
        <label className="block">
          <span className="text-sm mb-1 block" style={{ color: 'var(--text-secondary)' }}>
            {t('resonance.records.bannerLabel')}
          </span>
          <select
            className="w-full px-2 py-1.5 text-sm rounded-lg"
            style={{
              background: 'var(--bg-tertiary)',
              color: 'var(--text-primary)',
              border: '1px solid var(--divider)'
            }}
            value={bannerId}
            onChange={(e) => {
              setBannerId(Number(e.target.value))
              setItemId('')
            }}
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
        </label>

        <label className="block">
          <span className="text-sm mb-1 block" style={{ color: 'var(--text-secondary)' }}>
            {t('resonance.records.itemLabel')}
          </span>
          <select
            className="w-full px-2 py-1.5 text-sm rounded-lg"
            style={{
              background: 'var(--bg-tertiary)',
              color: 'var(--text-primary)',
              border: '1px solid var(--divider)'
            }}
            value={itemId}
            onChange={(e) => setItemId(e.target.value)}
          >
            <option value="">{t('resonance.records.selectItem')}</option>
            {itemGroups.five.length > 0 && (
              <optgroup label={t('resonance.records.fiveStarItems')}>
                {itemGroups.five.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label} · {entry.outfitLabel}
                  </option>
                ))}
              </optgroup>
            )}
            {itemGroups.four.length > 0 && (
              <optgroup label={t('resonance.records.fourStarItems')}>
                {itemGroups.four.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label} · {entry.outfitLabel}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>

        <label className="block">
          <span className="text-sm mb-1 block" style={{ color: 'var(--text-secondary)' }}>
            {t('resonance.records.timeLabel')}
          </span>
          <input
            type="datetime-local"
            step={1}
            className="w-full px-2 py-1.5 text-sm rounded-lg"
            style={{
              background: 'var(--bg-tertiary)',
              color: 'var(--text-primary)',
              border: '1px solid var(--divider)'
            }}
            value={timeValue}
            onChange={(e) => setTimeValue(e.target.value)}
          />
        </label>

        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn-primary" disabled={!canSubmit} onClick={() => void handleSubmit()}>
            {t('common.save')}
          </button>
        </div>
      </div>
    </BaseDialog>
  )
}
