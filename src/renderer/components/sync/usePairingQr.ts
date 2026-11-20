import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import QRCode from 'qrcode'
import { useErrorToast } from '../../hooks/useErrorToast'
import { useGlobalToast } from '../common/ToastProvider'
import type { NikkiSyncPairingCodeInfo } from '../../../shared/types/electron-api'

export interface PairingQrState {
  offer: NikkiSyncPairingCodeInfo | null
  svg: string | null
  failed: boolean
  /** 距过期剩余秒数（无 offer 时 null） */
  expiresInSeconds: number | null
  generate: () => Promise<void>
  copyContent: () => Promise<void>
  copyAddress: () => Promise<void>
}

/**
 * T3：配对二维码生成/倒计时逻辑，从 PairingQrDialog 原样抽出，
 * 供对话框与 Connect 视图的首次运行内嵌二维码共享（同一 5 分钟过期判据）。
 *
 * 行为契约（与抽出前逐字一致，PairingQrDialog.test.tsx (a)–(g) 钉住）：
 * - 二维码内容来自上游配对 URI（`pairingUri()` 转发），渲染层本地 qrcode → SVG，
 *   参数与上游 pc-companion src/qr.ts 一致（type svg / ECC M / margin 4 / width 512），无网络请求
 * - 生成计数防竞态：慢响应返回时若已有更新的生成发起，丢弃本次结果（上游同款）
 * - active=true 时生成 + 1s tick 倒计时；过期自动重新生成；
 *   重新生成失败即**同步**作废 offerRef（否则过期判据每秒重发请求、每秒弹错误 toast）
 * - active=false 时作废在途生成并清空展示，不发起请求、不留定时器
 */
export function usePairingQr(active: boolean): PairingQrState {
  const { t } = useTranslation()
  const { showError } = useErrorToast()
  const showMessage = useGlobalToast()
  const [offer, setOffer] = useState<NikkiSyncPairingCodeInfo | null>(null)
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  // 生成计数防竞态：慢响应返回时若已有更新的生成发起，丢弃本次结果（上游 DesktopPageScript 同款）
  const generationRef = useRef(0)
  // 过期判据由 1s tick 直接读这个 ref（渲染回流的 effect 总慢一拍，见下方 catch 里的同步作废）
  const offerRef = useRef<NikkiSyncPairingCodeInfo | null>(null)
  useEffect(() => {
    offerRef.current = offer
  }, [offer])

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
      const info = await api.nikkisync.getPairingCode()
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
      // offer 必须一并作废：过期重生成由 1s tick 按 `offerRef.current.expiresAt <= now` 驱动，
      // 留着已过期的 offer 会让每个 tick 再发一次请求、每秒弹一次错误 toast（入口开着就停不下）。
      // ref 同步写：等 [offer] 的 effect 回流要慢一拍，那一秒的多几次重试是真实发生的。
      offerRef.current = null
      setOffer(null)
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
    if (active) {
      void generateRef.current()
    } else {
      // 关闭时作废在途生成并清空展示
      generationRef.current++
      setOffer(null)
      setSvg(null)
      setFailed(false)
    }
  }, [active])

  // 每秒 tick 驱动倒计时；过期自动重新生成（入口仍激活时，经 ref 读最新 offer，无渲染期 setState）
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => {
      const current = Date.now()
      setNow(current)
      const expiresAt = offerRef.current ? Date.parse(offerRef.current.expiresAt) : null
      if (expiresAt !== null && expiresAt <= current) void generateRef.current()
    }, 1000)
    return () => clearInterval(timer)
  }, [active])

  // expiresAt 来自 IPC（外部输入）：不可解析时给 null 而不是 NaN——NaN 既不是 null 也不是
  // undefined，`?? 0` 兜不住，会直通 UI 渲染成 `NaN:NaN` 且让过期判据恒 false（永不自刷）。
  const expiresAtMs = offer !== null ? Date.parse(offer.expiresAt) : Number.NaN
  const expiresInSeconds = Number.isFinite(expiresAtMs)
    ? Math.max(0, Math.floor((expiresAtMs - now) / 1000))
    : null

  const copyContent = useCallback(async (): Promise<void> => {
    if (!offer) return
    try {
      await navigator.clipboard.writeText(offer.content)
      showMessage(t('syncService.status.copied'))
    } catch (err) {
      showError(err)
    }
  }, [offer, showMessage, showError, t])

  const copyAddress = useCallback(async (): Promise<void> => {
    if (!offer) return
    try {
      await navigator.clipboard.writeText(`${offer.host}:${offer.port}`)
      showMessage(t('syncService.status.copied'))
    } catch (err) {
      showError(err)
    }
  }, [offer, showMessage, showError, t])

  return { offer, svg, failed, expiresInSeconds, generate, copyContent, copyAddress }
}
