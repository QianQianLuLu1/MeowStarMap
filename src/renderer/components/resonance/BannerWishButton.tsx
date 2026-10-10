import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useGlobalToast } from '../../pages/settings/shared'
import { extractUserMessage } from '../../../shared/errors/app-error'
import { toggleBannerWish, useResonanceStore } from '../../stores/resonanceStore'

/**
 * 卡池心愿单切换按钮（对应上游 gongeo.us-nikki-tracker 的 BannerWishButton，
 * MIT, dastrokes；源实现按档案槽位隔离，本仓库单档案持久化到 SQLite，故无 slot 概念）。
 */

export interface BannerWishButtonProps {
  bannerId: number
}

export const BannerWishButton: React.FC<BannerWishButtonProps> = ({ bannerId }) => {
  const { t } = useTranslation()
  const showMessage = useGlobalToast()
  const saved = useResonanceStore((state) =>
    state.wishlist.entries.some((entry) => entry.bannerId === bannerId)
  )
  const [saving, setSaving] = useState(false)
  const label = saved ? t('resonance.wishlist.remove') : t('resonance.wishlist.add')

  const handleClick = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    try {
      await toggleBannerWish(bannerId)
    } catch (error) {
      showMessage(extractUserMessage(error), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={saved}
      title={label}
      disabled={saving}
      onClick={() => void handleClick()}
      className="flex items-center justify-center w-9 h-9 rounded-lg flex-shrink-0 transition-opacity disabled:opacity-50"
      style={{
        background: 'var(--bg-tertiary)',
        border: '1px solid var(--divider)',
        color: saved ? 'var(--accent)' : 'var(--text-tertiary)'
      }}
    >
      <svg
        viewBox="0 0 24 24"
        width="18"
        height="18"
        aria-hidden="true"
        fill={saved ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      >
        <path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.2 9.7l5.8-.8z" />
      </svg>
    </button>
  )
}
