import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Drawer } from '../../components/common/Drawer'
import { Button } from '../../components/common/Button'
import { InfoRowPanel, type InfoRow } from '../../components/common/InfoRowPanel'
import { IconInfo } from '../../icons'
import { PhotographyPanel } from '../../components/common/PhotographyPanel'
import { CameraInfoPanel } from '../../components/common/CameraInfoPanel'
import { NikkiInfoPanel } from '../../components/common/NikkiInfoPanel'
import { OutfitPanel } from '../../components/common/OutfitPanel'
import { InteractionPanel } from '../../components/common/InteractionPanel'
import { formatFileSize } from '../../utils/format'
import type { AssetMediaFile } from '../../utils/assetViewModel'

interface SyncAssetDrawerProps {
  open: boolean
  file: AssetMediaFile | null
  onClose: () => void
  /** 打开分享图面板；缺省不渲染该入口 */
  onShare?: () => void
}

/** 上游 `getAssetDetail` 返回体里本抽屉要展示的字段（判空/类型校验后的窄投影）。 */
interface UpstreamMetadataView {
  focalLength?: number
  apertureSection?: number
  exposure?: number
  dressingParts?: number
}

/**
 * N5：把不可信的 IPC 返回体收敛成可渲染的窄投影。
 * `detail.asset.metadata` 的 camera/dressing 由上游 row-mappers 产出，但桥可能返回 null、
 * 畸形体或空对象——一律判空返回 null ⇒ 调用方回落本地解密链，绝不整块替换五个参数面板。
 */
function parseUpstreamMetadata(detail: unknown): UpstreamMetadataView | null {
  if (!detail || typeof detail !== 'object') return null
  const asset = (detail as { asset?: unknown }).asset
  if (!asset || typeof asset !== 'object') return null
  const metadata = (asset as { metadata?: unknown }).metadata
  if (!metadata || typeof metadata !== 'object') return null
  const camera = (metadata as { camera?: unknown }).camera
  const dressing = (metadata as { dressing?: unknown }).dressing
  const num = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined
  const cam = camera && typeof camera === 'object' ? (camera as Record<string, unknown>) : {}
  const view: UpstreamMetadataView = {
    focalLength: num(cam.focalLength),
    apertureSection: num(cam.apertureSection),
    exposure: num(cam.exposure)
  }
  if (dressing && typeof dressing === 'object') {
    const clothes = (dressing as { clothes?: unknown }).clothes
    if (Array.isArray(clothes)) view.dressingParts = clothes.length
  }
  return Object.values(view).some((value) => value !== undefined) ? view : null
}

/** 'legacy'=老桥面无通道；'loading'=请求在途；'upstream'=上游生效；'local'=回落本地解密链。 */
type MetadataSource = 'legacy' | 'loading' | 'upstream' | 'local'

/**
 * 阶段 5 · A3：同步图库的详情抽屉（N5 修订）。
 *
 * 五个参数面板**原样复用**图库那套（它们只吃 `MediaFile`，`AssetMediaFile extends MediaFile`），
 * 始终保留 = 本地 `decrypt:decodeFile` 回落链恒在，不整块替换。N2/N3 已把在线解析/字典接回，
 * `nikkisync:getAssetDetail` 通道与上游 row-mappers 的 `asset.metadata`（camera/dressing）齐备，
 * 故打开时优先取上游 metadata 单独渲染一段；通道缺失/抛错/返回畸形 ⇒ 保留五个本地面板并
 * 给一条内联提示，明确「已回落」，不静默失败、不弹全局 toast。
 * 抽屉能读到本地解密路径的前提是阶段 5 · C1 把 media:// 第 4 条规则下沉进 `isMediaPathAllowed`。
 */
export const SyncAssetDrawer: React.FC<SyncAssetDrawerProps> = ({
  open,
  file,
  onClose,
  onShare
}) => {
  const { t } = useTranslation()
  // K3：按拍摄时间推断的游戏版本（上游静态表，纯本地无出站）。
  // 失败/未装配/无法推断一律 null ⇒ 不渲染推断值（推断是展示增强，不报错打扰）。
  const [inferredGameVersion, setInferredGameVersion] = useState<string | null>(null)
  // N5：上游 metadata 的窄投影与当前生效的数据源（供回落链/内联提示/可观测状态共用）
  const [upstream, setUpstream] = useState<UpstreamMetadataView | null>(null)
  const [metadataSource, setMetadataSource] = useState<MetadataSource>('legacy')

  useEffect(() => {
    if (!open || !file?.created_at) {
      setInferredGameVersion(null)
      return
    }
    let alive = true
    // 函数存在性守卫：老桥面（或测试桩）没有该方法时静默不推断，不抛错
    const resolve = window.electronAPI?.nikkisync?.resolveGameVersion
    if (typeof resolve !== 'function') {
      setInferredGameVersion(null)
      return
    }
    void resolve({ capturedAt: file.created_at })
      .then((result) => {
        if (alive) setInferredGameVersion(result.version ?? null)
      })
      .catch(() => {
        if (alive) setInferredGameVersion(null)
      })
    return () => {
      alive = false
    }
  }, [open, file?.created_at])

  // N5：打开时优先取上游 metadata；通道缺失/失败/畸形一律回落本地解密链（五个面板保留）。
  useEffect(() => {
    const getAssetDetail = window.electronAPI?.nikkisync?.getAssetDetail
    const assetId = file?.nikkisync?.assetId ?? file?.id
    if (!open || !file || typeof getAssetDetail !== 'function' || !assetId) {
      setUpstream(null)
      setMetadataSource('legacy')
      return
    }
    let alive = true
    setMetadataSource('loading')
    void getAssetDetail(assetId)
      .then((detail) => {
        if (!alive) return
        const parsed = parseUpstreamMetadata(detail)
        setUpstream(parsed)
        setMetadataSource(parsed ? 'upstream' : 'local')
      })
      .catch(() => {
        if (!alive) return
        setUpstream(null)
        setMetadataSource('local')
      })
    return () => {
      alive = false
    }
  }, [open, file])

  if (!file) return null

  const extra = file.nikkisync
  const rows: InfoRow[] = []
  rows.push({ label: t('syncGallery.drawer.fields.assetId'), value: extra?.assetId ?? file.id })
  rows.push({ label: t('syncGallery.drawer.fields.type'), value: extra?.assetType ?? 'unknown' })
  rows.push({ label: t('syncGallery.drawer.fields.state'), value: extra?.state ?? 'unknown' })
  rows.push({
    label: t('syncGallery.drawer.fields.motion'),
    value: extra?.hasMotion ? t('camera.yes') : t('camera.no')
  })
  if (extra?.revision !== undefined) {
    rows.push({ label: t('syncGallery.drawer.fields.revision'), value: String(extra.revision) })
  }
  // K3：游戏版本行——metadata 自带值优先，推断值并列或补位（同值不重复展示）
  {
    const owned = extra?.gameVersion
    const inferred =
      inferredGameVersion && inferredGameVersion !== owned
        ? `${inferredGameVersion}${t('syncGallery.drawer.fields.gameVersionInferred')}`
        : undefined
    const value = owned ? (inferred ? `${owned} · ${inferred}` : owned) : inferred
    if (value) {
      rows.push({ label: t('syncGallery.drawer.fields.gameVersion'), value })
    }
  }
  if (file.width && file.height) {
    rows.push({
      label: t('syncGallery.drawer.fields.resolution'),
      value: `${file.width} × ${file.height}`
    })
  }
  if (file.file_size > 0) {
    rows.push({ label: t('syncGallery.drawer.fields.size'), value: formatFileSize(file.file_size) })
  }
  if (extra?.sha256) {
    rows.push({ label: t('syncGallery.drawer.fields.hash'), value: extra.sha256 })
  }
  rows.push({
    label: t('syncGallery.drawer.fields.metadata'),
    value: extra?.hasMetadata ? t('camera.yes') : t('camera.no')
  })

  // N5：上游在线参数段。文案一律走 i18n key，不在组件里硬编码中文。
  const upstreamRows: InfoRow[] = []
  if (upstream) {
    if (upstream.focalLength !== undefined) {
      upstreamRows.push({
        label: t('syncGallery.drawer.upstream.focalLength'),
        value: `${upstream.focalLength}mm`
      })
    }
    if (upstream.apertureSection !== undefined) {
      upstreamRows.push({
        label: t('syncGallery.drawer.upstream.aperture'),
        value: String(upstream.apertureSection)
      })
    }
    if (upstream.exposure !== undefined) {
      upstreamRows.push({
        label: t('syncGallery.drawer.upstream.exposure'),
        value: String(upstream.exposure)
      })
    }
    if (upstream.dressingParts !== undefined) {
      upstreamRows.push({
        label: t('syncGallery.drawer.upstream.dressingParts'),
        value: String(upstream.dressingParts)
      })
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={t('syncGallery.drawer.title')}
      width={520}
      footer={
        onShare ? (
          <Button variant="primary" size="sm" onClick={onShare}>
            {t('shareCard.generate')}
          </Button>
        ) : undefined
      }
    >
      <div
        className="flex flex-col gap-4 pb-6"
        data-testid="drawer-root"
        data-has-motion={extra?.hasMotion ? 'true' : 'false'}
        data-metadata-source={metadataSource}
      >
        <InfoRowPanel
          icon={<IconInfo size={16} />}
          title={t('syncGallery.drawer.basic')}
          rows={rows}
        />
        {upstream && upstreamRows.length > 0 ? (
          <div data-testid="drawer-upstream-panel">
            <InfoRowPanel
              icon={<IconInfo size={16} />}
              title={t('syncGallery.drawer.upstreamTitle')}
              rows={upstreamRows}
            />
          </div>
        ) : null}
        {metadataSource === 'local' ? (
          <p
            data-testid="drawer-metadata-fallback-notice"
            className="text-xs"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {t('syncGallery.drawer.upstreamFallback')}
          </p>
        ) : null}
        <PhotographyPanel file={file} />
        <CameraInfoPanel file={file} />
        <NikkiInfoPanel file={file} />
        <OutfitPanel file={file} />
        <InteractionPanel file={file} />
      </div>
    </Drawer>
  )
}
