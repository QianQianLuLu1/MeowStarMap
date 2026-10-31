import React, { useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { BaseDialog } from './BaseDialog'
import { IconClose } from '../../icons'
import { getClothStateName, getClothTypeName } from '../../utils/enum-mappings'
import type { ClothDataInfo, DecodeClothDiyResponse } from '../../../shared/types/electron-api'

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

/** clothDiy tab 结果数据（主进程 decodeClothDiy data + 渲染层补查的 clothData） */
type ClothDiyData = NonNullable<DecodeClothDiyResponse['data']> & {
  /** 渲染层批量查询补充的服饰可读信息（键为 ID 十进制字符串；查不到/失败按无数据处理） */
  clothData?: Record<string, ClothDataInfo>
}

type ClothDiyStructured = NonNullable<ClothDiyData['structured']>
type ClothDiyCloth = ClothDiyStructured['clothes'][number]

/** decrypt 命名空间类型（取自渲染层 window.electronAPI 全局声明） */
type DecryptNamespace = NonNullable<Window['electronAPI']>['decrypt']

/** 单批查询上限：与 decrypt:lookupCloth 的 zod 校验（max 50）对齐 */
const LOOKUP_BATCH_SIZE = 50

/**
 * 批量补齐服饰名称/图标。入参过滤正整数并去重、按 LOOKUP_BATCH_SIZE 分块、
 * 各块 allSettled——单块失败不阻塞其它块；整体失败（理论仅入参校验会走到）降级为空映射，
 * 由调用方以 #id 兜底展示，数据不全不报错。
 */
async function lookupClothSafe(
  api: DecryptNamespace,
  clothes: ClothDiyCloth[]
): Promise<Record<string, ClothDataInfo>> {
  const list = Array.isArray(clothes) ? clothes : []
  const ids = Array.from(
    new Set(list.map((c) => c.id).filter((id) => Number.isInteger(id) && id > 0))
  )
  if (ids.length === 0) return {}
  const chunks: number[][] = []
  for (let i = 0; i < ids.length; i += LOOKUP_BATCH_SIZE) {
    chunks.push(ids.slice(i, i + LOOKUP_BATCH_SIZE))
  }
  const merged: Record<string, ClothDataInfo> = {}
  // async 包裹：lookupCloth 同步抛错时也变成 rejected promise，由 allSettled 统一降级
  const settled = await Promise.allSettled(chunks.map(async (chunk) => api.lookupCloth(chunk)))
  for (const item of settled) {
    if (item.status === 'fulfilled' && item.value.ok && item.value.data) {
      Object.assign(merged, item.value.data)
    }
  }
  return merged
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
  // 请求序号守卫：解码 + 服饰补查共两次 await，期间切 tab / 重复发起时丢弃过期 setState
  const decodeSeqRef = useRef(0)

  const handleDecode = useCallback(async () => {
    if (!input.trim()) return
    const seq = ++decodeSeqRef.current
    setLoading(true)
    setResult(null)
    try {
      const api = window.electronAPI?.decrypt
      if (!api) {
        setResult({ success: false, message: t('common.shareCodeDecoder.apiUnavailable') })
        return
      }
      // 主进程 decrypt:* 通道运行时返回 { ok, data, message }（decrypt-handler.ts），
      // 与组件内部 DecodeResult.success 命名解耦，这里统一映射
      let res: { ok: boolean; data?: unknown; message?: string }
      if (tab === 'clothDiy') {
        const raw = await api.decodeClothDiy(input.trim())
        // 解码成功且带结构化结果时批量补名称/图标（失败降级为空映射，不阻塞列表）
        const structured = raw.data?.structured
        const clothData =
          raw.ok && structured ? await lookupClothSafe(api, structured.clothes) : undefined
        res = {
          ok: raw.ok,
          data: clothData === undefined ? raw.data : { ...raw.data, clothData },
          message: raw.message
        }
      } else if (tab === 'homeBuild') {
        res = await api.decodeHomeBuild(input.trim())
      } else {
        res = await api.encodeCameraParams(input.trim())
      }
      if (seq !== decodeSeqRef.current) return
      setResult({ success: res.ok, data: res.data, message: res.message })
    } catch (err) {
      if (seq !== decodeSeqRef.current) return
      setResult({
        success: false,
        message: err instanceof Error ? err.message : t('common.shareCodeDecoder.unknownError')
      })
    } finally {
      if (seq === decodeSeqRef.current) setLoading(false)
    }
  }, [input, tab, t])

  const handleTabChange = (newTab: DecoderTab) => {
    decodeSeqRef.current++ // 使进行中的解码/补查结果失效，避免旧结果闪回
    setTab(newTab)
    setInput('')
    setResult(null)
    setLoading(false)
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
  if (!data) return null

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
    const d = data as ClothDiyData
    const structured = d.structured
    return (
      <div>
        {d.timestamp != null && (
          <Row label={t('common.shareCodeDecoder.result.timestamp')} value={String(d.timestamp)} />
        )}
        {d.uidBytes != null && (
          <Row label={t('common.shareCodeDecoder.result.uidHex')} value={String(d.uidBytes)} />
        )}
        {structured?.poseId != null && (
          <Row
            label={t('common.shareCodeDecoder.result.poseId')}
            value={String(structured.poseId)}
          />
        )}
        {structured == null ? (
          // structured: undefined = 离线未取到网络数据（不报错）；null = 网络数据解析失败
          <div className="text-xs py-2" style={{ color: 'var(--text-tertiary)' }}>
            {structured === null
              ? t('common.shareCodeDecoder.result.parseFailed')
              : t('common.shareCodeDecoder.result.networkUnavailable')}
          </div>
        ) : structured.clothes.length === 0 ? (
          <div className="text-xs py-2" style={{ color: 'var(--text-tertiary)' }}>
            {t('common.shareCodeDecoder.result.clothesEmpty')}
          </div>
        ) : (
          <ClothList clothes={structured.clothes} clothData={d.clothData ?? {}} />
        )}
        {typeof d.networkData === 'string' && d.networkData !== '' && (
          <details className="mt-2">
            <summary
              className="text-xs cursor-pointer select-none"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {t('common.shareCodeDecoder.result.rawDataSummary')}
            </summary>
            <div
              className="mt-1 break-all font-mono text-xs"
              style={{ color: 'var(--text-primary)' }}
            >
              {d.networkData}
            </div>
          </details>
        )}
      </div>
    )
  }

  if (tab === 'homeBuild') {
    const h = data as { server?: number | string; networkData?: string }
    return (
      <div>
        {h.server != null && (
          <Row label={t('common.shareCodeDecoder.result.serverId')} value={String(h.server)} />
        )}
        {h.networkData != null ? (
          <Row
            label={t('common.shareCodeDecoder.result.networkData')}
            value={
              String(h.networkData).slice(0, 500) +
              (String(h.networkData).length > 500 ? '...' : '')
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

/**
 * clothDiy 结构化服饰列表：保持 wearingClothes 投影原顺序平铺。
 * 名称/图标来自批量查询（clothData），缺失回退 #id；图标加载失败仅隐藏本条图标。
 */
const ClothList: React.FC<{
  clothes: ClothDiyCloth[]
  clothData: Record<string, ClothDataInfo>
}> = ({ clothes, clothData }) => {
  const { t } = useTranslation()
  const [failedIcons, setFailedIcons] = useState<ReadonlySet<number>>(() => new Set())

  const markIconFailed = useCallback((id: number) => {
    setFailedIcons((prev) => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }, [])

  return (
    <div className="mt-2">
      <div className="text-xs font-medium mb-1" style={{ color: 'var(--text-tertiary)' }}>
        {t('common.shareCodeDecoder.result.outfitTitle')}
      </div>
      <ul>
        {clothes.map((cloth, index) => {
          const info = clothData[String(cloth.id)]
          const name = typeof info?.name === 'string' && info.name !== '' ? info.name : null
          const iconUrl =
            typeof info?.iconUrl === 'string' && info.iconUrl !== '' ? info.iconUrl : null
          const showIcon = iconUrl !== null && !failedIcons.has(cloth.id)
          const stateName = getClothStateName(cloth.state)
          return (
            <li
              key={`${cloth.id}-${index}`}
              className="flex items-center gap-2 py-1.5 border-b last:border-b-0"
              style={{ borderColor: 'var(--border-color, rgba(0,0,0,0.04))' }}
            >
              {showIcon ? (
                <img
                  src={iconUrl}
                  alt={name ?? `#${cloth.id}`}
                  className="w-10 h-10 rounded-lg flex-shrink-0 object-cover"
                  style={{ background: 'var(--bg-primary)' }}
                  onError={() => markIconFailed(cloth.id)}
                  loading="lazy"
                />
              ) : (
                <span
                  className="w-10 h-10 rounded-lg flex-shrink-0"
                  style={{ background: 'var(--bg-primary)' }}
                />
              )}
              <div className="flex-1 min-w-0">
                {name !== null && (
                  <div
                    className="text-xs font-medium break-all"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {name}
                  </div>
                )}
                <div
                  className="text-xs font-mono break-all"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  #{cloth.id}
                </div>
                <div
                  className="text-xs mt-0.5 flex flex-wrap gap-x-2"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  <span>{t(getClothTypeName(cloth.clothType))}</span>
                  <span>
                    {stateName
                      ? t(stateName)
                      : t('common.shareCodeDecoder.result.stateRaw', { value: cloth.state })}
                  </span>
                  <span>
                    {t('common.shareCodeDecoder.result.speciesRaw', { value: cloth.species })}
                  </span>
                  <span>
                    {t('common.shareCodeDecoder.result.featureRaw', { value: cloth.outfitFeature })}
                  </span>
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
