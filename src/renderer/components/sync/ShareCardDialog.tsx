import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n'
import { Drawer } from '../common/Drawer'
import { Button } from '../common/Button'
import { EmptyState } from '../common/EmptyState'
import { useGameParams } from '../../hooks/useGameParams'
import { buildShareCardInput } from '../../utils/share-card/shareCardInput'
import { generateShareCardPages } from '../../utils/share-card/shareCardJob'
import type { ShareCardCopy } from '../../utils/share-card/shareCardRender'
import { toFileUrl } from '../../utils/file'
import { extractUserMessage, InternalError } from '../../../shared/errors/app-error'
import { ERROR_CODES } from '../../../shared/errors/error-codes'
import type { MediaFile } from '../../stores/mediaStore'
import type { AssetMediaFile } from '../../utils/assetViewModel'

/**
 * 出图目标：本地图库的 `MediaFile` 与同步图库的 `AssetMediaFile` 都要能分享，
 * 所以取「MediaFile + 可选 nikkisync 附加信息」的交集类型，而不是把两个源强行统一。
 */
export type ShareCardFile = MediaFile & { nikkisync?: AssetMediaFile['nikkisync'] }

interface ShareCardDialogProps {
  open: boolean
  file: ShareCardFile | null
  onClose: () => void
}

/**
 * 图上文案的取法：**钉死 zh-CN**。
 * 分享图是一份独立的位图产物，图里的「穿搭 / 拍摄参数 / 图标暂缺 / 分类示意」等字样是
 * NikkiSync 三端共用的版式元素，不随 App 界面语言变化（上游 Android 与小程序同样是硬编码中文）。
 * 因此这里用 `i18n.t(key, { lng: 'zh-CN' })` 读取，语言包只在 zh-CN 落真实值，其余语言留空串。
 */
function buildCardCopy(): ShareCardCopy {
  const at = (key: string): string => String(i18n.t(`shareCard.card.${key}`, { lng: 'zh-CN' }))
  return {
    brand: at('brand'),
    fallbackTitle: at('fallbackTitle'),
    outfitHeading: at('outfitHeading'),
    parameterHeading: at('parameterHeading'),
    iconMissing: at('iconMissing'),
    categoryBadge: at('categoryBadge'),
    noOutfit: at('noOutfit'),
    footer: at('footer'),
    parameterLabels: {
      focalLength: at('labelFocalLength'),
      aperture: at('labelAperture'),
      vignette: at('labelVignette'),
      bloom: at('labelBloom'),
      bloomRange: at('labelBloomRange'),
      brightness: at('labelBrightness'),
      exposure: at('labelExposure'),
      contrast: at('labelContrast'),
      saturation: at('labelSaturation'),
      naturalSaturation: at('labelNaturalSaturation'),
      highlights: at('labelHighlights'),
      shadows: at('labelShadows'),
      rotation: at('labelRotation'),
      depthOfField: at('labelDepthOfField'),
      action: at('labelAction'),
      lighting: at('labelLighting'),
      filter: at('labelFilter'),
      location: at('labelLocation')
    },
    effectLabels: {
      action: at('labelAction'),
      lighting: at('labelLighting'),
      filter: at('labelFilter'),
      location: at('labelLocation')
    }
  }
}

/** 用真实 DOM canvas 出图；`loadImage` 走 media://，与编辑器同款 `crossOrigin` 链路。 */
function loadImage(url: string, userMessage: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    // 业务错误必须走 AppError 家族：不带 userMessage 的话英文内部串会原样透给用户
    img.onerror = () => reject(new InternalError('image load failed', undefined, { userMessage }))
    img.src = url
  })
}

/**
 * 阶段 5 · B4：分享图面板。
 *
 * 容器复用 `Drawer` 而不是新造一个模态：焦点陷阱、遮罩、动效与 `SyncAssetDrawer` 保持同源，
 * 避免出现两套对话框实现。出图链路的编排（布局 → 绘制 → 导出）在 `shareCardJob` 里，
 * 本文件只负责真 canvas、进度、保存与取消。
 */
export const ShareCardDialog: React.FC<ShareCardDialogProps> = ({ open, file, onClose }) => {
  const { t } = useTranslation()
  const isImage = file?.file_type === 'image'
  // 与 assetViewModel 的实况口径对齐：type === 'motion_photo' 或 hasMotion 均视为实况
  const isMotion =
    file?.nikkisync?.assetType === 'motion_photo' || file?.nikkisync?.hasMotion === true
  const enabled = open && !!file && isImage && !isMotion && !!file.album_type

  const { data, loading } = useGameParams(
    file?.file_path,
    file?.album_type,
    file?.account_uid,
    enabled
  )
  const payload = useMemo(
    () =>
      file
        ? buildShareCardInput(data, {
            date: (file.created_at ?? '').slice(0, 10),
            gameVersion: file.nikkisync?.gameVersion
          })
        : null,
    [data, file]
  )
  const copy = useMemo(() => buildCardCopy(), [])

  const [images, setImages] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const cancelledRef = useRef(false)
  /** 生成轮次号：面板关闭 / 新一轮生成都会让它自增，旧轮据此在检查点后静默丢弃 */
  const runSeqRef = useRef(0)
  /** 与 busy 同步的 ref：handleSave 的重入保护不能依赖 state（闭包里读到的是旧值） */
  const busyRef = useRef(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    if (!open) {
      // 关闭即取消在途生成：旧轮结果一律静默丢弃，绝不能在重开后回填上一资产的预览
      cancelledRef.current = true
      runSeqRef.current += 1
      busyRef.current = false
      setImages([])
      setProgress(null)
      setNotice(null)
      setError(null)
      setBusy(false)
    }
  }, [open])

  const handleGenerate = useCallback(async () => {
    if (!file || !payload || busy || busyRef.current) return
    const run = ++runSeqRef.current
    cancelledRef.current = false
    busyRef.current = true
    setBusy(true)
    setError(null)
    setNotice(null)
    setImages([])
    const url = toFileUrl(file.file_path)
    if (!url) {
      busyRef.current = false
      setBusy(false)
      setError(t('shareCard.errorGenerate'))
      return
    }
    // 复用同一块 canvas：离开面板时把尺寸收回 1×1，释放像素缓冲（对齐上游 dispose 语义）
    const canvas = canvasRef.current ?? document.createElement('canvas')
    canvasRef.current = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      busyRef.current = false
      setBusy(false)
      setError(t('shareCard.errorGenerate'))
      return
    }
    try {
      const image = await loadImage(url, t('shareCard.errorGenerate'))
      let soft: HTMLCanvasElement | null = null
      try {
        const scale = Math.min(360 / image.width, 900 / image.height)
        soft = document.createElement('canvas')
        soft.width = Math.max(1, Math.round(image.width * scale))
        soft.height = Math.max(1, Math.round(image.height * scale))
        soft.getContext('2d')?.drawImage(image, 0, 0, soft.width, soft.height)
      } catch {
        soft = null
      }
      const result = await generateShareCardPages({
        canvas,
        ctx,
        payload,
        copy,
        image,
        soft,
        rotation: 0,
        exportPage: (target) => target.toDataURL('image/png'),
        isCancelled: () => cancelledRef.current || run !== runSeqRef.current,
        onProgress: (current, total) => setProgress(t('shareCard.progress', { current, total }))
      })
      // 本轮已被关闭/新一轮取代：结果一律丢弃（含 cancelled 分支），不回填任何 state
      if (run !== runSeqRef.current) return
      if (result.cancelled) {
        setError(t('shareCard.errorCancelled'))
        return
      }
      if (result.missingIcons > 0) {
        setNotice(t('shareCard.missingIcons', { count: result.missingIcons }))
      }
      setImages(result.pages)
    } catch (e) {
      if (run !== runSeqRef.current) return
      setError(extractUserMessage(e) || t('shareCard.errorGenerate'))
    } finally {
      if (run === runSeqRef.current) {
        canvas.width = 1
        canvas.height = 1
        busyRef.current = false
        setBusy(false)
        setProgress(null)
      }
    }
  }, [file, payload, busy, copy, t])

  const handleSave = useCallback(async () => {
    const api = window.electronAPI?.editor
    if (busyRef.current || !api?.saveAs || images.length === 0) return
    busyRef.current = true
    const base = (file?.file_name ?? 'share-card').replace(/\.[^.]+$/, '')
    setBusy(true)
    try {
      for (let index = 0; index < images.length; index += 1) {
        const suffix = images.length > 1 ? `-${index + 1}` : ''
        const result = await api.saveAs(images[index], {
          format: 'png',
          fileName: `${base}-share${suffix}.png`
        })
        if (!result?.success) {
          setError(result?.message ?? t('shareCard.errorSave'))
          return
        }
      }
      setNotice(t('shareCard.savedCount', { count: images.length }))
    } catch (e) {
      // 用户在系统目录框里取消不是错误，不该弹失败提示。按 IpcError.code 判定
      // （IPC_CANCELED），不能靠 message 正则——主进程取消的译文是中文「未选择输出目录」
      const code = (e as { code?: unknown }).code
      const message = extractUserMessage(e)
      if (code !== ERROR_CODES.CANCELED && !/cancel/i.test(message)) {
        setError(message || t('shareCard.errorSave'))
      }
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [images, file, t])

  return (
    <Drawer open={open} onClose={onClose} title={t('shareCard.title')} width={560}>
      <div className="flex flex-col gap-3 pb-6" data-testid="share-card-panel">
        {isMotion ? (
          <EmptyState title={t('shareCard.motionUnsupported')} />
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={handleGenerate}
                loading={busy && images.length === 0}
              >
                {t('shareCard.generate')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleSave}
                disabled={busy || images.length === 0}
              >
                {t('shareCard.save')}
              </Button>
            </div>
            {loading ? <p className="text-sm text-secondary">{t('syncGallery.loading')}</p> : null}
            {payload && payload.camera.length === 0 ? (
              <p className="text-sm text-[var(--warning)]">{t('shareCard.noParams')}</p>
            ) : null}
            {progress ? (
              <p role="status" className="text-sm text-secondary">
                {progress}
              </p>
            ) : null}
            {notice ? (
              <p role="status" className="text-sm text-[var(--warning)]">
                {notice}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-[var(--danger)]">
                {error}
              </p>
            ) : null}
            {images.map((dataUrl, index) => (
              <img
                key={`${index}-${dataUrl.slice(-24)}`}
                src={dataUrl}
                alt={`${t('shareCard.title')} ${index + 1}`}
                className="w-full rounded-lg border border-[var(--border-subtle)]"
              />
            ))}
          </>
        )}
      </div>
    </Drawer>
  )
}
