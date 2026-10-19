import React from 'react'
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

/**
 * 阶段 5 · A3：同步图库的详情抽屉。
 *
 * 五个参数面板**原样复用**图库那套（它们只吃 `MediaFile`，而 `AssetMediaFile extends MediaFile`）：
 * 穿搭/拍摄参数的实际来源是本地解密链 `decrypt:decodeFile`——内嵌 Runtime 从不传
 * `metadataResolver`/字典，上游 `metadata_json` 的 `camera`/`capture` 恒为空对象（见
 * docs/plans/2026-10-15-sync-gallery-share-card-metadata.md §0.1），所以这里不需要第二套取数。
 * 抽屉能读到该路径的前提是阶段 5 · C1 把 media:// 第 4 条规则下沉进了 `isMediaPathAllowed`。
 */
export const SyncAssetDrawer: React.FC<SyncAssetDrawerProps> = ({
  open,
  file,
  onClose,
  onShare
}) => {
  const { t } = useTranslation()

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
  if (extra?.gameVersion) {
    rows.push({ label: t('syncGallery.drawer.fields.gameVersion'), value: extra.gameVersion })
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
      >
        <InfoRowPanel
          icon={<IconInfo size={16} />}
          title={t('syncGallery.drawer.basic')}
          rows={rows}
        />
        <PhotographyPanel file={file} />
        <CameraInfoPanel file={file} />
        <NikkiInfoPanel file={file} />
        <OutfitPanel file={file} />
        <InteractionPanel file={file} />
      </div>
    </Drawer>
  )
}
