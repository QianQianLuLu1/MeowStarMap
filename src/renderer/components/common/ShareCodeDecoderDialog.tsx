import React, { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { BaseDialog } from './BaseDialog'
import { IconClose } from '../../icons'

interface ShareCodeDecoderDialogProps {
  open: boolean
  onClose: () => void
}

type DecoderTab = 'clothDiy' | 'homeBuild' | 'mediaEncrypt'

interface DecodeResult {
  success: boolean
  data?: unknown
  message?: string
}

export const ShareCodeDecoderDialog: React.FC<ShareCodeDecoderDialogProps> = ({
  open,
  onClose
}) => {
  const { t } = useTranslation()
  const [tab, setTab] = useState<DecoderTab>('clothDiy')
  const [input, setInput] = useState('')
  const [result, setResult] = useState<DecodeResult | null>(null)
  const [loading, setLoading] = useState(false)

  const handleDecode = useCallback(async () => {
    if (!input.trim()) return
    setLoading(true)
    setResult(null)
    try {
      const api = window.electronAPI?.decrypt
      if (!api) {
        setResult({ success: false, message: t('common.shareCodeDecoder.apiUnavailable') })
        return
      }
      let res: DecodeResult
      if (tab === 'clothDiy') {
        res = await api.decodeClothDiy(input.trim())
      } else if (tab === 'homeBuild') {
        res = await api.decodeHomeBuild(input.trim())
      } else {
        res = await api.encodeCameraParams(input.trim())
      }
      setResult(res)
    } catch (err) {
      setResult({
        success: false,
        message: err instanceof Error ? err.message : t('common.shareCodeDecoder.unknownError')
      })
    } finally {
      setLoading(false)
    }
  }, [input, tab, t])

  const handleTabChange = (newTab: DecoderTab) => {
    setTab(newTab)
    setInput('')
    setResult(null)
  }

  const tabLabels: Record<DecoderTab, string> = {
    clothDiy: t('common.shareCodeDecoder.tabs.clothDiy'),
    homeBuild: t('common.shareCodeDecoder.tabs.homeBuild'),
    mediaEncrypt: t('common.shareCodeDecoder.tabs.mediaEncrypt')
  }

  const tabPlaceholders: Record<DecoderTab, string> = {
    clothDiy: t('common.shareCodeDecoder.placeholders.clothDiy'),
    homeBuild: t('common.shareCodeDecoder.placeholders.homeBuild'),
    mediaEncrypt: t('common.shareCodeDecoder.placeholders.mediaEncrypt')
  }

  return (
    <BaseDialog open={open} onClose={onClose} size="lg" ariaLabelledby="share-code-decoder-title">
      <div className="p-6">
        {/* 标题 */}
        <div className="flex items-center justify-between mb-4">
          <h2
            id="share-code-decoder-title"
            className="text-lg font-semibold"
            style={{ color: 'var(--text-primary)' }}
          >
            {t('common.shareCodeDecoder.title')}
          </h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors hover:bg-[var(--hover-bg)] dark:hover:bg-white/10"
            style={{ color: 'var(--text-tertiary)' }}
            aria-label={t('common.shareCodeDecoder.closeAriaLabel')}
          >
            <IconClose size={16} />
          </button>
        </div>

        {/* Tab 选择器 */}
        <div
          className="flex gap-1 mb-4 p-1 rounded-xl"
          style={{ background: 'var(--bg-secondary)' }}
        >
          {(Object.keys(tabLabels) as DecoderTab[]).map((key) => (
            <button
              key={key}
              onClick={() => handleTabChange(key)}
              className="flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all"
              style={{
                background: tab === key ? 'var(--bg-primary)' : 'transparent',
                color: tab === key ? 'var(--text-primary)' : 'var(--text-tertiary)',
                boxShadow: tab === key ? '0 2px 8px rgba(0,0,0,0.06)' : 'none'
              }}
            >
              {tabLabels[key]}
            </button>
          ))}
        </div>

        {/* 输入区 */}
        <div className="mb-4">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={tabPlaceholders[tab]}
            rows={4}
            className="w-full px-4 py-3 rounded-xl text-sm resize-none transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--accent-light)]"
            style={{
              background: 'var(--bg-secondary)',
              color: 'var(--text-primary)',
              border: '1px solid var(--divider)'
            }}
            spellCheck={false}
          />
        </div>

        {/* 解码按钮 */}
        <button
          onClick={handleDecode}
          disabled={!input.trim() || loading}
          className="w-full py-2.5 rounded-xl text-sm font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            background: 'var(--accent)',
            color: 'var(--text-on-accent)',
            boxShadow: '0 2px 8px color-mix(in srgb, var(--accent) 20%, transparent)'
          }}
        >
          {loading
            ? t('common.shareCodeDecoder.decoding')
            : tab === 'mediaEncrypt'
              ? t('common.shareCodeDecoder.encryptButton')
              : t('common.shareCodeDecoder.decodeButton')}
        </button>

        {/* 结果区 */}
        {result && (
          <div
            className="mt-4 p-4 rounded-xl text-sm"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--divider)' }}
          >
            {result.success ? (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <span className="w-2 h-2 rounded-full bg-green-500" />
                  <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                    {tab === 'mediaEncrypt'
                      ? t('common.shareCodeDecoder.encryptSuccess')
                      : t('common.shareCodeDecoder.decodeSuccess')}
                  </span>
                </div>
                <ResultDisplay tab={tab} data={result.data} />
              </div>
            ) : (
              <div className="flex items-start gap-2">
                <span className="w-2 h-2 rounded-full bg-red-500 mt-1.5 flex-shrink-0" />
                <div>
                  <div className="font-medium text-red-500 mb-1">
                    {t('common.shareCodeDecoder.operationFailed')}
                  </div>
                  <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {result.message || t('common.shareCodeDecoder.unknownError')}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 说明 */}
        <div className="mt-4 text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
          {tab === 'clothDiy' && t('common.shareCodeDecoder.descriptions.clothDiy')}
          {tab === 'homeBuild' && t('common.shareCodeDecoder.descriptions.homeBuild')}
          {tab === 'mediaEncrypt' && t('common.shareCodeDecoder.descriptions.mediaEncrypt')}
        </div>
      </div>
    </BaseDialog>
  )
}

/** 结果展示组件 */
const ResultDisplay: React.FC<{ tab: DecoderTab; data: unknown }> = ({ tab, data }) => {
  const { t } = useTranslation()
  const d = data as Record<string, unknown> | undefined
  if (!d) return null

  const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
    <div
      className="flex items-baseline gap-3 py-1.5 border-b last:border-b-0"
      style={{ borderColor: 'var(--border-color, rgba(0,0,0,0.04))' }}
    >
      <span className="flex-shrink-0 w-24 text-xs" style={{ color: 'var(--text-tertiary)' }}>
        {label}
      </span>
      <span className="flex-1 break-all font-mono text-xs" style={{ color: 'var(--text-primary)' }}>
        {value}
      </span>
    </div>
  )

  if (tab === 'clothDiy') {
    return (
      <div>
        {d.timestamp != null && (
          <Row label={t('common.shareCodeDecoder.result.timestamp')} value={String(d.timestamp)} />
        )}
        {d.uidBytes != null && <Row label="UID (Hex)" value={String(d.uidBytes)} />}
        {d.networkData != null ? (
          <Row
            label={t('common.shareCodeDecoder.result.networkData')}
            value={
              String(d.networkData).slice(0, 500) +
              (String(d.networkData).length > 500 ? '...' : '')
            }
          />
        ) : (
          <div className="text-xs py-2" style={{ color: 'var(--text-tertiary)' }}>
            {t('common.shareCodeDecoder.result.networkUnavailable')}
          </div>
        )}
      </div>
    )
  }

  if (tab === 'homeBuild') {
    return (
      <div>
        {d.server != null && (
          <Row label={t('common.shareCodeDecoder.result.serverId')} value={String(d.server)} />
        )}
        {d.networkData != null ? (
          <Row
            label={t('common.shareCodeDecoder.result.networkData')}
            value={
              String(d.networkData).slice(0, 500) +
              (String(d.networkData).length > 500 ? '...' : '')
            }
          />
        ) : (
          <div className="text-xs py-2" style={{ color: 'var(--text-tertiary)' }}>
            {t('common.shareCodeDecoder.result.networkUnavailable')}
          </div>
        )}
      </div>
    )
  }

  // mediaEncrypt — data is a base64 string
  const dataStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  return (
    <Row
      label={t('common.shareCodeDecoder.result.encryptedResult')}
      value={dataStr.slice(0, 500) + (dataStr.length > 500 ? '...' : '')}
    />
  )
}
