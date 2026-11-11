import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../Button'
import { EmptyState } from '../EmptyState'
import { useGameParams } from '../../../hooks/useGameParams'
import { useWorldMapTiles } from '../../../hooks/useWorldMapTiles'
import type { MediaFile } from '../../../stores/mediaStore'
import type { GameParamsData, LocationInfo } from '../../../types/decryption'
import type { WorldMapParams } from '../../../utils/miraland-coords'
import { gameCoordsToMapPixel } from '../../../utils/miraland-coords'
import { isAuthorizedTileTemplate } from '../../../utils/world-map-tile-host'
import { LocationMapCard } from './LocationMapCard'
import { LocationMapDialog } from './LocationMapDialog'
import type { MiralandMapView } from './MiralandMap'

/**
 * 阶段 4：拍摄地点地图的唯一三态决策点 + 两种形态的组合。
 * 只消费既有解密链（useGameParams）与 refdata 查询通道（useWorldMapTiles），不改任何契约。
 *
 * 空态语义对齐上游 nikki_albums main @ dc1b30b：
 *   旧照片无 WorldID → outdatedVersion；参考数据不可用 → lackData；
 *   无匹配世界/无授权瓦片/参数非法 → lackWorldMap。
 * 上游内嵌态是空白 block0，此处改为可见 EmptyState（用户要求「明确空态」）。
 */
export interface LocationMapFixture {
  location: LocationInfo | null
  tiles: WorldMapParams[]
  serviceAvailable: boolean
  loading?: boolean
}

interface LocationMapSectionProps {
  file?: MediaFile | null
  /** PropertiesDialog 会复用已解密的数据，避免重复调用 */
  gameParams?: GameParamsData | null
  /** 仅测试 / Storybook 注入固定数据，绕过 hook 与 IPC */
  fixture?: LocationMapFixture
}

interface MapStateInput {
  location: LocationInfo | null
  tiles: WorldMapParams[]
  serviceAvailable: boolean
  loading: boolean
}

type MapState =
  | { kind: 'loading' }
  | { kind: 'empty'; titleKey: string; subtitleKey: string | null }
  | { kind: 'ready'; view: MiralandMapView }

function empty(titleKey: string, subtitleKey: string | null = null): MapState {
  return { kind: 'empty', titleKey, subtitleKey }
}

function resolveMapState(input: MapStateInput): MapState {
  if (input.loading) return { kind: 'loading' }

  const { location } = input
  const worldId = location?.worldId
  // 旧照片（2.9 及之前）没有 TrackInfo.WorldID；0/负数/小数/非整数一律按旧数据，绝不折叠成 0
  if (!location || !Number.isSafeInteger(worldId) || (worldId ?? 0) <= 0) {
    return empty('locationMap.outdatedVersion')
  }
  if (!location.pos || !Number.isFinite(location.pos.x) || !Number.isFinite(location.pos.y)) {
    return empty('locationMap.lackData', 'locationMap.noTiles')
  }
  // 参考数据整体未就绪（未下载/损坏/离线）与「有管道但没有瓦片数据」区分副标题
  if (!input.serviceAvailable) return empty('locationMap.lackData', 'locationMap.notReady')
  if (input.tiles.length === 0) return empty('locationMap.lackData', 'locationMap.noTiles')

  const tile = input.tiles.find((item) => item.worldId === worldId)
  if (!tile) return empty('locationMap.lackWorldMap')

  // 官方瓦片按现有方式直连；作者自有 CDN / 未登记主机 fail-closed，不发出任何瓦片请求
  const authorized = isAuthorizedTileTemplate(tile.urlTemplate)
  if (!authorized.ok) {
    console.error('[world-map] rejected tile template:', authorized.reason)
    return empty('locationMap.lackWorldMap')
  }

  const converted = gameCoordsToMapPixel({ x: location.pos.x, y: location.pos.y }, tile)
  if (!converted.ok) {
    console.error('[world-map] invalid map params:', converted.reason)
    return empty('locationMap.lackWorldMap')
  }

  return {
    kind: 'ready',
    view: {
      tile,
      pixel: converted.pixel,
      bounds: converted.bounds,
      crsZoom: converted.crsZoom,
      outside: converted.outside
    }
  }
}

export const LocationMapSection: React.FC<LocationMapSectionProps> = ({
  file,
  gameParams,
  fixture
}) => {
  const { t } = useTranslation()
  const [dialogOpen, setDialogOpen] = useState(false)
  // 文件守卫对齐 PhotographyPanel：视频与非游戏相册文件不渲染地图节，
  // 也不发起解密与 refdata 查询（审查修复 2026-11-11）
  const isGameImage = !!file && file.file_type === 'image' && !!file.album_type
  const internalParams = useGameParams(
    file?.file_path,
    file?.album_type,
    file?.account_uid,
    isGameImage && !fixture && !gameParams
  )
  const tilesResult = useWorldMapTiles(isGameImage && !fixture)

  const location = fixture
    ? fixture.location
    : ((gameParams ?? internalParams.data)?.photography?.location ?? null)
  const tiles = fixture ? fixture.tiles : tilesResult.tiles
  const serviceAvailable = fixture ? fixture.serviceAvailable : tilesResult.serviceAvailable
  const loading = fixture
    ? (fixture.loading ?? false)
    : tilesResult.loading || (gameParams ? false : internalParams.loading)

  // view 必须稳定，否则 MiralandMap 的 useEffect 会在每次 render 重建实例；
  // useMemo 必须先于任何提前返回（rules-of-hooks）
  const state = useMemo(
    () => resolveMapState({ location, tiles, serviceAvailable, loading }),
    [location, tiles, serviceAvailable, loading]
  )

  // 文件守卫的提前返回放在全部 hooks 之后
  if (!fixture && !isGameImage) return null

  if (state.kind === 'loading') {
    return <EmptyState status="loading" title={t('locationMap.loading')} />
  }

  if (state.kind === 'empty') {
    return (
      <div className="space-y-2">
        <EmptyState
          title={t(state.titleKey)}
          subtitle={state.subtitleKey ? t(state.subtitleKey) : undefined}
        />
        <Button variant="secondary" size="sm" disabled>
          {t('locationMap.clickToView')}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <LocationMapCard view={state.view} />
      {state.view.outside && (
        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          {t('locationMap.outsideBounds')}
        </p>
      )}
      <Button variant="secondary" size="sm" onClick={() => setDialogOpen(true)}>
        {t('locationMap.clickToView')}
      </Button>
      <LocationMapDialog open={dialogOpen} onClose={() => setDialogOpen(false)} view={state.view} />
    </div>
  )
}
