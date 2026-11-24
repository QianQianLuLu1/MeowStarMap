import React from 'react'
import { useTranslation } from 'react-i18next'
import { BaseDialog } from '../common/BaseDialog'
import { Button } from '../common/Button'
import { useErrorToast } from '../../hooks/useErrorToast'
import { GONGEO_SITE_URL } from '../../utils/external-links'

interface ResonanceGateDialogProps {
  /** 弹窗是否开启 */
  open: boolean
  /** 点击「仍要继续」（含 Esc）时的回调：关闭弹窗进入共鸣录 */
  onContinue: () => void
}

/**
 * 共鸣录身份门：板块暂停更新告知弹窗。
 * 局部遮罩：absolute 定位覆盖共鸣录页面容器（祖先需 relative），不拦截侧边栏/标题栏；
 * 遮罩点击不可关闭，仅有「仍要继续」「跳转网页」两个出口；
 * 视觉复用 BaseDialog 玻璃卡片与 CSS 变量主题，文案全部走 i18n。
 */
export const ResonanceGateDialog: React.FC<ResonanceGateDialogProps> = ({ open, onContinue }) => {
  const { t } = useTranslation()
  const { showError } = useErrorToast()

  const handleVisit = (): void => {
    const openExternal = window.electronAPI?.shell?.openExternal
    if (typeof openExternal !== 'function') return
    openExternal(GONGEO_SITE_URL).catch(showError)
  }

  return (
    <BaseDialog
      open={open}
      onClose={onContinue}
      closeOnOverlayClick={false}
      overlayBackground="var(--overlay-bg-strong)"
      overlayPosition="absolute"
      ariaLabelledby="resonance-gate-title"
    >
      <h2
        id="resonance-gate-title"
        className="text-lg font-semibold"
        style={{ color: 'var(--text-primary)' }}
      >
        {t('resonance.gate.title')}
      </h2>
      <p className="text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
        {t('resonance.gate.notice')}
      </p>
      <div className="flex gap-3 pt-2">
        <Button variant="secondary" className="flex-1" onClick={onContinue}>
          {t('resonance.gate.continue')}
        </Button>
        <Button variant="primary" className="flex-1" onClick={handleVisit}>
          {t('resonance.gate.visit')}
        </Button>
      </div>
    </BaseDialog>
  )
}
