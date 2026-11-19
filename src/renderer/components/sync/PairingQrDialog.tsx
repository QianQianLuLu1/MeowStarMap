import React from 'react'
import { useTranslation } from 'react-i18next'
import { BaseDialog } from '../common/BaseDialog'
import { Button } from '../common/Button'
import { IconCopyText, IconRefresh } from '../../icons'
import { usePairingQr } from './usePairingQr'

interface PairingQrDialogProps {
  open: boolean
  onClose: () => void
}

/**
 * 配对二维码对话框（sync-integration 阶段5 落地，阶段3 改接真实 NikkiSync 服务）。
 *
 * T3 起生成/倒计时/防竞态逻辑抽至 `usePairingQr`（与 Connect 视图首次运行内嵌二维码共享），
 * 本组件只保留对话框展示面；行为契约由 PairingQrDialog.test.tsx (a)–(g) 钉住：
 * - 二维码内容来自上游配对 URI 构造（`buildPairingUri`，经会话 `pairingUri()` 转发）：
 *   单 host 为 NS1 七段串，K5 注入多 host 时为 `nikki-sync://pair?...&hosts=` 新格式，
 *   图形在渲染层本地生成（qrcode → SVG，参数与上游 pc-companion src/qr.ts 一致），无网络请求
 * - 一次性配对令牌默认 5 分钟过期：显示倒计时，过期自动重新生成（生成计数防竞态，上游同款）；
 *   重新生成失败即作废当前提案，否则过期判据每秒重发一次请求并每秒弹一次错误 toast
 * - 服务未运行时 getPairingCode 抛 PRECONDITION_FAILED → 错误态 + 重试
 *   （入口按钮已按运行状态禁用，此处兜底）
 */
export const PairingQrDialog: React.FC<PairingQrDialogProps> = ({ open, onClose }) => {
  const { t } = useTranslation()
  const { offer, svg, failed, expiresInSeconds, generate, copyContent, copyAddress } =
    usePairingQr(open)

  return (
    <BaseDialog open={open} onClose={onClose} size="md" title={t('syncService.pairing.title')}>
      <div className="space-y-4">
        {failed ? (
          <div className="flex flex-col items-center gap-3 py-6">
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {t('syncService.pairing.loadFailed')}
            </p>
            <Button variant="secondary" onClick={() => void generate()}>
              {t('syncService.pairing.retry')}
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
                  title={t('syncService.status.copied')}
                >
                  {offer.host}:{offer.port}
                  <IconCopyText />
                </button>
                {/* K5：多 host 配对时列出备选地址（手机在主地址不可达时按清单换连）；
                    单 host（NS1 形态）无 hosts 字段，界面与升级前完全一致 */}
                {offer.hosts && offer.hosts.length > 1 && (
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      {t('syncService.pairing.altHosts')}
                    </span>
                    <span className="font-mono text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      {offer.hosts.filter((item) => item !== offer.host).join(' · ')}
                    </span>
                  </div>
                )}
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  {t('syncService.pairing.expiresIn')}：{Math.floor((expiresInSeconds ?? 0) / 60)}:
                  {String((expiresInSeconds ?? 0) % 60).padStart(2, '0')}
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
            {t('syncService.pairing.copyContent')}
          </Button>
          <Button
            variant="secondary"
            icon={<IconRefresh />}
            loading={offer === null && !failed}
            onClick={() => void generate()}
          >
            {t('syncService.pairing.refresh')}
          </Button>
        </div>
      </div>
    </BaseDialog>
  )
}
