import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import QRCode from 'qrcode'
import { BaseDialog } from '../common/BaseDialog'
import { Button } from '../common/Button'
import { IconCopyText, IconRefresh } from '../../icons'
import { useErrorToast } from '../../hooks/useErrorToast'
import { useGlobalToast } from '../common/ToastProvider'
import type { PairingQrInfo } from '../../../shared/types/electron-api'

interface PairingQrDialogProps {
  open: boolean
  onClose: () => void
}

/**
 * 配对二维码对话框（sync-integration 阶段5）。
 *
 * - 二维码在渲染层本地生成（qrcode → SVG，参数与上游 pc-companion src/qr.ts 一致），无网络请求
 * - 一次性配对令牌默认 5 分钟过期：显示倒计时，过期自动重新生成（生成计数防竞态，上游同款）
 * - 服务器未运行时 createPairingQr 抛错 → 错误态 + 重试（入口按钮已按运行状态禁用，此处兜底）
 */
export const PairingQrDialog: React.FC<PairingQrDialogProps> = ({ open, onClose }) => {
  const { t } = useTranslation()
  const { showError } = useErrorToast()
  const showMessage = useGlobalToast()
  const [offer, setOffer] = useState<PairingQrInfo | null>(null)
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  // 生成计数防竞态：慢响应返回时若已有更新的生成发起，丢弃本次结果（上游 DesktopPageScript 同款）
  const generationRef = useRef(0)

  const generate = useCallback(async (): Promise<void> => {
    const api = window.electronAPI
    if (!api) {
      setFailed(true)
      return
    }
    const generation = ++generationRef.current
    setFailed(false)
    setSvg(null)
    try {
      const info = await api.sync.createPairingQr()
      if (generation !== generationRef.current) return
      const svgText = await QRCode.toString(info.content, {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: 4,
        width: 512
      })
      if (generation !== generationRef.current) return
      setOffer(info)
      setSvg(svgText)
      setNow(Date.now())
    } catch (err) {
      if (generation !== generationRef.current) return
      setFailed(true)
      showError(err)
    }
  }, [showError])

  // generate 经 ref 供 effect 调用：其身份可能随 showError 变化，
  // 直接入 deps 会造成"渲染 → effect 重跑 → setState → 渲染"风暴
  const generateRef = useRef(generate)
  useEffect(() => {
    generateRef.current = generate
  })

  useEffect(() => {
    if (open) {
      void generateRef.current()
    } else {
      // 关闭时作废在途生成并清空展示
      generationRef.current++
      setOffer(null)
      setSvg(null)
      setFailed(false)
    }
  }, [open])

  // 每秒 tick 驱动倒计时；过期自动重新生成（对话框仍打开时，经 ref 读最新 offer，无渲染期 setState）
  const offerRef = useRef<PairingQrInfo | null>(null)
  useEffect(() => {
    offerRef.current = offer
  }, [offer])

  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => {
      const current = Date.now()
      setNow(current)
      const expiresAt = offerRef.current ? Date.parse(offerRef.current.expiresAt) : null
      if (expiresAt !== null && expiresAt <= current) void generateRef.current()
    }, 1000)
    return () => clearInterval(timer)
  }, [open])

  const expiresInSeconds =
    offer !== null ? Math.max(0, Math.floor((Date.parse(offer.expiresAt) - now) / 1000)) : null

  const copyContent = async (): Promise<void> => {
    if (!offer) return
    try {
      await navigator.clipboard.writeText(offer.content)
      showMessage(t('settings.sync.status.copied'))
    } catch (err) {
      showError(err)
    }
  }

  const copyAddress = async (): Promise<void> => {
    if (!offer) return
    try {
      await navigator.clipboard.writeText(`${offer.host}:${offer.port}`)
      showMessage(t('settings.sync.status.copied'))
    } catch (err) {
      showError(err)
    }
  }

  return (
    <BaseDialog open={open} onClose={onClose} size="md" title={t('settings.sync.pairing.title')}>
      <div className="space-y-4">
        {failed ? (
          <div className="flex flex-col items-center gap-3 py-6">
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {t('settings.sync.pairing.loadFailed')}
            </p>
            <Button variant="secondary" onClick={() => void generate()}>
              {t('settings.sync.pairing.retry')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            {svg !== null ? (
              // qrcode 库输出的是受控 SVG（无外部内容）；白底承载面见 globals.css .sync-qr-surface
              <div
                className="sync-qr-surface w-64 h-64 [&>svg]:w-full [&>svg]:h-full"
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            ) : (
              <div
                className="w-64 h-64 rounded-lg animate-pulse"
                style={{ background: 'var(--bg-tertiary)' }}
              />
            )}
            {offer && (
              <>
                <button
                  type="button"
                  onClick={() => void copyAddress()}
                  className="icon-btn text-sm font-mono"
                  title={t('settings.sync.status.copied')}
                >
                  {offer.host}:{offer.port}
                  <IconCopyText />
                </button>
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  {t('settings.sync.pairing.expiresIn')}：{Math.floor((expiresInSeconds ?? 0) / 60)}
                  :{String((expiresInSeconds ?? 0) % 60).padStart(2, '0')}
                </p>
              </>
            )}
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="ghost"
            icon={<IconCopyText />}
            disabled={!offer}
            onClick={() => void copyContent()}
          >
            {t('settings.sync.pairing.copyContent')}
          </Button>
          <Button
            variant="secondary"
            icon={<IconRefresh />}
            loading={offer === null && !failed}
            onClick={() => void generate()}
          >
            {t('settings.sync.pairing.refresh')}
          </Button>
        </div>
      </div>
    </BaseDialog>
  )
}
